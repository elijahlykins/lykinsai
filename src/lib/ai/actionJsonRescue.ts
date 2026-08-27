// Action-JSON rescue machinery for the chat send pipeline. The model
// occasionally leaks canvas/grid action JSON (or whole `{"assistant": ...}`
// envelopes) into visible chat text instead of the actions channel; this
// module recovers those actions and strips the raw JSON from what the user
// sees — both in the live streaming buffer (stripStreamingActionJson) and in
// the final reply (rescueInlineBlockMarkup). Extracted verbatim from
// src/lib/ai/chatSendOrchestrator.ts (chat engine decomposition Wave 1, see
// docs/REFACTOR_LOG.md). Algorithms, regexes, and fallback ordering are
// unchanged.
import type { CreateAction } from "@/lib/lyknChat/chatTurnTypes";

/**
 * The model occasionally drops raw action JSON into the visible chat instead of
 * routing through the actions array (especially when a request hits the
 * streaming endpoint, which has no actions channel). Without this rescue the
 * user sees blobs like `{"type":"create_text","content":"hello"}` in the chat
 * and nothing actually appears on the grid. We forgive several shapes:
 *   - `[CREATE_BLOCK:{...}]` markup
 *   - bare `{"type":"create_*", ...}` JSON objects
 *   - arrays of those objects
 *   - ```json fenced blocks containing either of the above
 *   - `{"actions":[...]}` envelope objects
 * Recovered actions are applied to the grid and stripped from the chat text.
 */
const ACTION_TYPE_RE = /^(create_|update_|delete_|move_|resize_|color_|connect_|disconnect_|remove_connection|add_wire|edit_block|update_block|update_text_block|update_list|update_spreadsheet|update_code_block|append_notes|update_notes|organize_grid|auto_organize|auto_layout|create_database_relation)/i;

function isActionLike(obj: any): boolean {
  if (!obj || typeof obj !== "object") return false;
  const t = typeof obj.type === "string" ? obj.type : "";
  return ACTION_TYPE_RE.test(t);
}

export function normalizeRescuedAction(obj: any): CreateAction | null {
  if (!isActionLike(obj)) return null;
  const t = String(obj.type).toLowerCase();
  // Map shorthand block-create types from `[CREATE_BLOCK:{...}]` (where `type`
  // is just `heading`, `quote`, `list`, etc.) to the canonical action names.
  // Real action shapes (already starting with `create_`) pass through.
  let actionType = t;
  if (!t.startsWith("create_") && !t.startsWith("update_") && !t.startsWith("delete_") && !t.startsWith("move_") && !t.startsWith("resize_") && !t.startsWith("color_") && !t.startsWith("connect_") && !t.startsWith("disconnect_") && !t.startsWith("organize") && !t.startsWith("auto_") && !t.startsWith("append_") && !t.startsWith("add_") && !t.startsWith("edit_") && !t.startsWith("remove_")) {
    actionType = t === "heading" || t === "h1" ? "create_heading"
      : t === "h2" ? "create_h2"
      : t === "h3" ? "create_h3"
      : t === "quote" || t === "callout" ? "create_quote"
      : t === "list" || t === "todo" ? "create_list"
      : t === "code" ? "create_code_block"
      : t === "sheet" || t === "paper" || t === "document" ? "create_sheet"
      : t === "spreadsheet" ? "create_spreadsheet"
      : t === "table" ? "create_table"
      : t === "brick" || t === "card" || t === "sticky" || t === "text" ? "create_text"
      : "";
    if (!actionType) return null;
  }
  const action: any = { ...obj, type: actionType };
  // Pull positions out of nested `position` objects the model sometimes uses.
  if (obj.position && typeof obj.position === "object") {
    if (action.x == null && obj.position.x != null) action.x = Number(obj.position.x);
    if (action.y == null && obj.position.y != null) action.y = Number(obj.position.y);
    delete action.position;
  }
  if (actionType === "create_heading") {
    if (action.level == null) {
      if (t === "h2") action.level = 2;
      else if (t === "h3") action.level = 3;
      else action.level = 1;
    }
  }
  return action as CreateAction;
}

/**
 * Models routinely emit JSON where string values contain unescaped double
 * quotes — e.g. `"content":"Text overlay: *"Think clearly."*"`. Strict
 * `JSON.parse` aborts at the first stray quote and we lose the whole envelope
 * (and every action it contained). This walks the raw text byte-by-byte and
 * heuristically escapes any `"` that appears inside a string literal but is
 * NOT followed by a closing-context character (`,`, `}`, `]`, `:`, EOF). The
 * heuristic is wrong only for pathological inputs, and even then the parse
 * still fails closed (returns null) rather than silently mis-extracting.
 */
export function repairUnescapedQuotes(jsonStr: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < jsonStr.length) {
    const c = jsonStr[i];
    if (escape) { result += c; escape = false; i++; continue; }
    if (c === "\\") { result += c; escape = true; i++; continue; }
    if (c === '"') {
      if (!inString) { inString = true; result += c; i++; continue; }
      let j = i + 1;
      while (j < jsonStr.length && /\s/.test(jsonStr[j])) j++;
      const next = jsonStr[j];
      if (next === undefined || next === "," || next === "}" || next === "]" || next === ":") {
        inString = false;
        result += c;
        i++;
        continue;
      }
      result += '\\"';
      i++;
      continue;
    }
    result += c;
    i++;
  }
  return result;
}

export function tryParseJsonLoose(raw: string): any {
  try { return JSON.parse(raw); } catch {}
  // Repair unescaped inner quotes (the most common malformation we see from
  // models when they put markdown like `*"foo"*` inside a JSON string value).
  try { return JSON.parse(repairUnescapedQuotes(raw)); } catch {}
  // Some models emit single-quoted JSON. One quick recovery: swap simple
  // single quotes for doubles when there are no embedded double quotes.
  if (!raw.includes('"') && raw.includes("'")) {
    try { return JSON.parse(raw.replace(/'/g, '"')); } catch {}
  }
  return null;
}

/**
 * Walk through `text`, finding every balanced `{...}` or `[...]` JSON literal
 * (respecting strings and escapes) and yielding [start, end, parsed] tuples
 * for the ones that look like actions. Used to strip them from chat output.
 */
export function findActionJsonSpans(text: string): Array<{ start: number; end: number; actions: CreateAction[] }> {
  const spans: Array<{ start: number; end: number; actions: CreateAction[] }> = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    // Walk forward tracking depth to find the matching close.
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end < 0) break;
    const slice = text.slice(i, end + 1);
    const parsed = tryParseJsonLoose(slice);
    let actions: CreateAction[] = [];
    if (Array.isArray(parsed)) {
      actions = parsed.map(normalizeRescuedAction).filter(Boolean) as CreateAction[];
    } else if (parsed && Array.isArray(parsed.actions)) {
      actions = parsed.actions.map(normalizeRescuedAction).filter(Boolean) as CreateAction[];
    } else if (isActionLike(parsed)) {
      const a = normalizeRescuedAction(parsed);
      if (a) actions = [a];
    }
    if (actions.length) {
      spans.push({ start: i, end: end + 1, actions });
      i = end; // skip past this literal
    }
  }
  return spans;
}

/**
 * Try to extract actions from an envelope-shaped JSON object even when the
 * outer parse failed. We greedily slice from the first `{` to the last `}` /
 * first `[` to last `]` and run it through the unescaped-quote repair before
 * parsing. If that yields a recognizable shape (`{actions:[]}`, an action
 * array, or a single action object), we return its assistant text and actions.
 *
 * We ALSO recognize "assistant-only envelopes" — objects shaped like
 * `{ "assistant": "...", "follow_up_questions": [...] }` (or with `response`
 * in place of `assistant`) that have no actions or an empty actions array.
 * The streaming chat persona forbids JSON envelopes, but models occasionally
 * leak one anyway and the user must NEVER see raw `{ "assistant": "..." }`
 * in the chat bubble. Returning `consumed` for these lets callers strip the
 * wrapper and surface only the inner assistant text.
 */
export function tryExtractEnvelope(text: string): {
  actions: CreateAction[];
  assistant: string;
  consumed: { start: number; end: number } | null;
  isEnvelope: boolean;
} {
  const result = {
    actions: [] as CreateAction[],
    assistant: "",
    consumed: null as { start: number; end: number } | null,
    isEnvelope: false,
  };
  const tryShape = (candidate: any): CreateAction[] => {
    if (!candidate) return [];
    if (Array.isArray(candidate)) {
      return candidate.map(normalizeRescuedAction).filter(Boolean) as CreateAction[];
    }
    if (typeof candidate === "object" && Array.isArray(candidate.actions)) {
      return candidate.actions.map(normalizeRescuedAction).filter(Boolean) as CreateAction[];
    }
    if (isActionLike(candidate)) {
      const a = normalizeRescuedAction(candidate);
      return a ? [a] : [];
    }
    return [];
  };
  // An object that looks like the documented LYKN envelope even when actions
  // is missing or empty: at minimum it must have an `assistant` or `response`
  // string field, optionally alongside `follow_up_questions` / `actions`.
  const looksLikeAssistantEnvelope = (candidate: any): boolean => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const hasAssistantText =
      typeof candidate.assistant === "string" || typeof candidate.response === "string";
    if (!hasAssistantText) return false;
    // Reject objects whose ONLY string field happens to be named `assistant`
    // but that are actually action-shaped (have a `type` like `create_*`).
    // `isActionLike` already filtered those into `tryShape`, so any object
    // landing here is genuinely an envelope.
    return true;
  };
  for (const [openCh, closeCh] of [["{", "}"], ["[", "]"]] as const) {
    const start = text.indexOf(openCh);
    const end = text.lastIndexOf(closeCh);
    if (start < 0 || end <= start) continue;
    const slice = text.slice(start, end + 1);
    const parsed = tryParseJsonLoose(slice);
    const actions = tryShape(parsed);
    if (actions.length) {
      result.actions = actions;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        result.assistant = String(parsed.assistant || parsed.response || "").trim();
      }
      result.consumed = { start, end: end + 1 };
      result.isEnvelope = true;
      return result;
    }
    if (looksLikeAssistantEnvelope(parsed)) {
      result.assistant = String(parsed.assistant || parsed.response || "").trim();
      result.consumed = { start, end: end + 1 };
      result.isEnvelope = true;
      return result;
    }
  }
  return result;
}

/**
 * Convert an AI-invented `<add_blocks>` JSON block (with fields like
 * `id`, `type:"text"`, `variant:"h2"`, `w`, `h`, `format`, `content`) into a
 * canonical `create_*` action with a `placeholderId` that downstream actions
 * (e.g. `<add_wires>`) can reference. Returns null if the block can't be
 * mapped to a real action type.
 */
export function convertAddBlockToAction(blk: any): CreateAction | null {
  if (!blk || typeof blk !== "object") return null;
  const rawType = String(blk.type || blk.kind || blk.blockType || "").toLowerCase();
  const variant = String(blk.variant || blk.textVariant || "").toLowerCase();
  const placeholderId = blk.id || blk.placeholderId || blk.refId;
  const content = blk.content != null ? String(blk.content) : (blk.text != null ? String(blk.text) : "");
  const x = Number.isFinite(blk.x) ? Number(blk.x) : undefined;
  const y = Number.isFinite(blk.y) ? Number(blk.y) : undefined;
  const width = Number.isFinite(blk.w) ? Number(blk.w) : Number.isFinite(blk.width) ? Number(blk.width) : undefined;
  const height = Number.isFinite(blk.h) ? Number(blk.h) : Number.isFinite(blk.height) ? Number(blk.height) : undefined;
  const base: any = { placeholderId, content, x, y, width, height };

  if (rawType === "heading" || rawType === "h1") return { ...base, type: "create_heading", level: 1 };
  if (rawType === "h2") return { ...base, type: "create_h2", level: 2 };
  if (rawType === "h3") return { ...base, type: "create_h3", level: 3 };
  if (rawType === "quote" || rawType === "callout") return { ...base, type: "create_quote" };
  if (rawType === "code") return { ...base, type: "create_code_block", language: blk.language || "plaintext" };
  if (rawType === "sheet" || rawType === "paper" || rawType === "document") {
    return { ...base, type: "create_sheet", title: blk.title };
  }
  if (rawType === "spreadsheet") return { ...base, type: "create_spreadsheet", rows: blk.rows, cols: blk.cols };
  if (rawType === "table") return { ...base, type: "create_table", headers: blk.headers, rows: blk.rows };
  if (rawType === "list" || rawType === "todo" || rawType === "todolist" || rawType === "checklist") {
    return { ...base, type: "create_list", listType: blk.listType || "todo", items: blk.items };
  }
  if (rawType === "toggle") return { ...base, type: "create_toggle", items: blk.items };
  if (rawType === "kanban" || rawType === "task_board" || rawType === "taskboard") {
    return { ...base, type: "create_task_board", title: blk.title, columns: blk.columns };
  }
  if (rawType === "design_board" || rawType === "designboard") return { ...base, type: "create_design_board", title: blk.title };
  if (rawType === "youtube" || rawType === "video") {
    return blk.url ? { ...base, type: "create_youtube_block", url: blk.url } : { ...base, type: "create_video_block", url: blk.url };
  }
  if (rawType === "image") return { ...base, type: "create_image_block", url: blk.url || blk.src };
  if (rawType === "embed" || rawType === "website" || rawType === "site" || rawType === "iframe") {
    return { ...base, type: "create_embed", url: blk.url || blk.src, mode: blk.mode || "embed", name: blk.name || blk.title };
  }
  if (rawType === "link" || rawType === "bookmark" || rawType === "url") {
    return { ...base, type: "create_link", url: blk.url || blk.src, mode: blk.mode || "link", name: blk.name || blk.title };
  }
  if (rawType === "media") return { ...base, type: "create_media", url: blk.url || blk.src, mode: blk.mode };
  // Default: text-shaped block. Differentiate headings via `variant`.
  if (rawType === "text" || rawType === "brick" || rawType === "card" || rawType === "sticky" || !rawType) {
    if (variant === "h1") return { ...base, type: "create_heading", level: 1 };
    if (variant === "h2") return { ...base, type: "create_h2", level: 2 };
    if (variant === "h3") return { ...base, type: "create_h3", level: 3 };
    return { ...base, type: "create_text" };
  }
  return null;
}

/**
 * Convert an AI-invented `<add_wires>` entry like
 * `{from:"text-foo", to:"text-bar", fromAnchor:"bottom", toAnchor:"top"}`
 * into a canonical `connect_blocks` action. The placeholder IDs are resolved
 * to real block IDs by `applyProjectActions` at apply time via the
 * `recordPlaceholder` map populated during this same batch.
 */
export function convertAddWireToAction(wire: any): CreateAction | null {
  if (!wire || typeof wire !== "object") return null;
  const fromId = String(wire.from || wire.fromId || wire.fromPlaceholder || "").trim();
  const toId = String(wire.to || wire.toId || wire.toPlaceholder || "").trim();
  if (!fromId || !toId) return null;
  const fromSide = String(wire.fromAnchor || wire.fromSide || "").trim() || undefined;
  const toSide = String(wire.toAnchor || wire.toSide || "").trim() || undefined;
  return { type: "connect_blocks", fromId, toId, fromSide, toSide } as CreateAction;
}

/**
 * Find every `<add_blocks>...</add_blocks>` and `<add_wires>...</add_wires>`
 * tag in `text`, parse the JSON inside (with the same loose / quote-repair
 * parser used for other shapes), convert to canonical actions, and return
 * BOTH the recovered actions AND the cleaned text with all those tag spans
 * removed. The AI invented this shape but it's now common enough in
 * the wild that we accept it and translate.
 */
export function rescueXmlTagActions(text: string): { actions: CreateAction[]; cleaned: string } {
  let cleaned = text;
  const actions: CreateAction[] = [];

  // Tag pairs we recognize and how to convert their inner JSON into actions.
  const tagHandlers: Array<{ open: RegExp; convert: (entry: any) => CreateAction | null }> = [
    { open: /<\s*add[_-]?blocks?\s*>([\s\S]*?)<\s*\/\s*add[_-]?blocks?\s*>/gi, convert: convertAddBlockToAction },
    { open: /<\s*create[_-]?blocks?\s*>([\s\S]*?)<\s*\/\s*create[_-]?blocks?\s*>/gi, convert: convertAddBlockToAction },
    { open: /<\s*blocks?\s*>([\s\S]*?)<\s*\/\s*blocks?\s*>/gi, convert: convertAddBlockToAction },
    { open: /<\s*add[_-]?wires?\s*>([\s\S]*?)<\s*\/\s*add[_-]?wires?\s*>/gi, convert: convertAddWireToAction },
    { open: /<\s*wires?\s*>([\s\S]*?)<\s*\/\s*wires?\s*>/gi, convert: convertAddWireToAction },
    { open: /<\s*connect[_-]?blocks?\s*>([\s\S]*?)<\s*\/\s*connect[_-]?blocks?\s*>/gi, convert: convertAddWireToAction },
  ];

  for (const handler of tagHandlers) {
    cleaned = cleaned.replace(handler.open, (_full, innerRaw) => {
      const inner = String(innerRaw || "").trim();
      if (!inner) return "";
      const parsed = tryParseJsonLoose(inner);
      const entries: any[] = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray(parsed.items)
          ? parsed.items
          : parsed && typeof parsed === "object"
            ? [parsed]
            : [];
      for (const e of entries) {
        const a = handler.convert(e);
        if (a) actions.push(a);
      }
      return "";
    });
  }

  return { actions, cleaned };
}

/**
 * Strip leaked action markup from the FINAL reply text. `applyActions` is
 * optional compatibility plumbing: the canvas that once executed rescued
 * actions is gone, so production callers omit it and this is sanitation
 * only. Tests (and any future grid revival) may still pass a handler to
 * receive the recovered actions.
 */
export function rescueInlineBlockMarkup(text: string, applyActions?: (actions: CreateAction[]) => any): string {
  let working = text;
  const rescued: CreateAction[] = [];

  // 0. AI-invented XML-style tag wrappers (`<add_blocks>`, `<add_wires>`,
  // and a few aliases). Translate them to canonical actions and strip the
  // tags so they never surface in the user-visible chat.
  {
    const xmlResult = rescueXmlTagActions(working);
    if (xmlResult.actions.length) {
      for (const a of xmlResult.actions) rescued.push(a);
      working = xmlResult.cleaned;
    }
  }

  // 1. Legacy `[CREATE_BLOCK:{...}]` markup
  const markupRe = /\[CREATE_BLOCK:\s*(\{[^]*?\})\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = markupRe.exec(working)) !== null) {
    const parsed = tryParseJsonLoose(m[1]);
    const action = parsed && normalizeRescuedAction({ ...parsed, type: parsed.type || "text" });
    if (action) rescued.push(action);
  }
  working = working.replace(/\[CREATE_BLOCK:\s*\{[^]*?\}\s*\]/g, "");

  // 2. ```json ... ``` (or plain ```) code fences that wrap action JSON or a
  // full envelope. We replace the fence span with the envelope's assistant
  // text (or empty) so the user sees a clean chat message instead of the
  // raw JSON the model tried to emit.
  const fenceRe = /```(?:json|JSON|js|javascript)?\s*([\s\S]*?)```/g;
  const fenceSpansToRemove: Array<{ start: number; end: number }> = [];
  let f: RegExpExecArray | null;
  while ((f = fenceRe.exec(working)) !== null) {
    const inner = f[1].trim();
    if (!inner) continue;
    let fenceActions: CreateAction[] = [];
    let fenceAssistant = "";
    let envelopeFound = false;
    const env = tryExtractEnvelope(inner);
    if (env.isEnvelope) {
      fenceActions = env.actions;
      fenceAssistant = env.assistant;
      envelopeFound = true;
    } else {
      const innerSpans = findActionJsonSpans(inner);
      for (const s of innerSpans) fenceActions.push(...s.actions);
    }
    if (!fenceActions.length && !envelopeFound) continue;
    for (const a of fenceActions) rescued.push(a);
    fenceSpansToRemove.push({
      start: f.index,
      end: f.index + f[0].length,
      replacement: fenceAssistant,
    } as any);
  }
  // Remove fences from end to start so indexes stay valid.
  for (let i = fenceSpansToRemove.length - 1; i >= 0; i--) {
    const span = fenceSpansToRemove[i] as any;
    working = working.slice(0, span.start) + (span.replacement || "") + working.slice(span.end);
  }

  // 3. Whole-text envelope rescue. Models often emit a single
  // `{"assistant":"...","actions":[...]}` blob as the entire reply (especially
  // when a request hits the streaming endpoint that has no actions channel).
  // Strict JSON.parse usually fails because string values include unescaped
  // quotes, so we need the repair-aware path here, NOT the brace walker.
  //
  // We unwrap BOTH envelopes-with-actions AND assistant-only envelopes so the
  // user never sees raw `{ "assistant": "..." }` in the chat bubble even if
  // the model decided to wrap a chat-only reply in JSON.
  const trimmed = working.trim();
  if (trimmed.length > 0) {
    const env = tryExtractEnvelope(trimmed);
    if (env.isEnvelope && env.consumed) {
      for (const a of env.actions) rescued.push(a);
      const head = working.slice(0, working.indexOf(trimmed));
      const tail = working.slice(working.indexOf(trimmed) + env.consumed.end);
      working = head + (env.assistant || "") + tail;
    }
  }

  // 4. Bare JSON action objects / arrays / `{"actions":[...]}` envelopes left
  // floating in the chat text alongside other prose.
  const bareSpans = findActionJsonSpans(working);
  if (bareSpans.length) {
    for (const s of bareSpans) rescued.push(...s.actions);
    let out = "";
    let cursor = 0;
    for (const s of bareSpans) {
      out += working.slice(cursor, s.start);
      cursor = s.end;
    }
    out += working.slice(cursor);
    working = out;
  }

  if (rescued.length && applyActions) {
    try { applyActions(rescued); } catch { /* apply failures are non-fatal */ }
  }

  return working
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strip in-progress action JSON from a streaming chat buffer so the user never
 * sees raw `{"type":"create_text",...}` blobs (or `{"assistant":"...","actions":[...]}`
 * envelopes) flickering into the chat as tokens arrive. Complete spans are
 * removed entirely (rescue happens after the stream finishes); incomplete
 * trailing spans are truncated at their start.
 */
const ENVELOPE_KEY_RE = /"(?:assistant|response|actions|follow_up_questions|followUpQuestions|type)"\s*:/;
const ACTION_KEY_HINT_RE = /"type"\s*:\s*"(?:create_|update_|delete_|move_|resize_|color_|connect_|disconnect_|organize_|append_notes|update_notes|edit_block)/;

export function stripStreamingActionJson(text: string): string {
  let working = text;

  // Strip complete `[PULL_MEDIA:noteId|index]` markers from the streamed
  // chat bubble so users don't see internal "hidden from user" tokens
  // flash by while the response is still streaming. The post-stream
  // pipeline does the same strip, so the final text is consistent.
  working = working.replace(/\s*\[PULL_MEDIA:[^\]]*\]/g, "");
  // Also drop a partial trailing marker the stream may have just begun
  // (e.g. "...end. [PULL_MEDIA:abc" with no closing bracket yet) so it
  // doesn't appear briefly before the next chunk completes it.
  working = working.replace(/\s*\[PULL_MEDIA:[^\]]*$/, "");

  // Remove complete `[CREATE_BLOCK:{...}]`, ```json``` fences, and the
  // `<add_blocks>...</add_blocks>` / `<add_wires>...</add_wires>` tag wrappers
  // some models invent.
  working = working.replace(/\[CREATE_BLOCK:\s*\{[^]*?\}\s*\]/g, "");
  working = working.replace(/```(?:json|JSON|js|javascript)?\s*([\s\S]*?)```/g, (full, inner) => {
    return findActionJsonSpans(String(inner)).length ? "" : full;
  });
  working = working.replace(/<\s*(?:add|create)[_-]?(?:blocks?|wires?)\s*>[\s\S]*?<\s*\/\s*(?:add|create)[_-]?(?:blocks?|wires?)\s*>/gi, "");
  working = working.replace(/<\s*(?:blocks?|wires?|connect[_-]?blocks?)\s*>[\s\S]*?<\s*\/\s*(?:blocks?|wires?|connect[_-]?blocks?)\s*>/gi, "");

  // Whole-buffer envelope: if the trimmed text already parses as an envelope
  // (or repairs into one), hide it entirely — the post-stream rescue will
  // apply the actions and surface the assistant text.
  //
  // We strip BOTH envelopes-with-actions AND assistant-only envelopes
  // (`{ "assistant": "...", "actions": [] }`). The streaming chat persona
  // forbids JSON envelopes outright, so any complete envelope reaching this
  // path is a model leak that must never render as raw JSON in the bubble.
  const trimmed = working.trim();
  if (trimmed.length > 0 && (trimmed[0] === "{" || trimmed[0] === "[")) {
    const env = tryExtractEnvelope(trimmed);
    if (env.isEnvelope && env.consumed) {
      const offset = working.indexOf(trimmed);
      const head = working.slice(0, offset);
      const tail = working.slice(offset + env.consumed.end);
      return (head + (env.assistant || "") + tail).replace(/\n{3,}/g, "\n\n");
    }
  }

  // Remove complete bare action JSON spans (best-effort with brace walker).
  const spans = findActionJsonSpans(working);
  if (spans.length) {
    let out = "";
    let cursor = 0;
    for (const s of spans) {
      out += working.slice(cursor, s.start);
      cursor = s.end;
    }
    out += working.slice(cursor);
    working = out;
  }

  // Trim a trailing partial that looks like the START of an action span. We
  // also handle `{"assistant":"...` envelopes where the FIRST key isn't `type`
  // by checking for any envelope-shaped key after a leading brace, and any
  // unclosed `<add_blocks>` / `<add_wires>` style tag the model may invent.
  const candidatePositions: number[] = [];
  candidatePositions.push(working.lastIndexOf("[CREATE_BLOCK:"));

  // Unclosed XML-ish wrapper tag.
  {
    const re = /<\s*(?:add|create)?[_-]?(?:blocks?|wires?|connect[_-]?blocks?)\s*>/gi;
    let last = -1;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(working)) !== null) {
      const closeRe = new RegExp(`<\\s*/\\s*${mm[0].replace(/[<>\s]/g, "").replace(/_/g, "[_-]?")}\\s*>`, "i");
      const after = working.slice(mm.index + mm[0].length);
      if (!closeRe.test(after)) last = mm.index;
    }
    candidatePositions.push(last);
  }

  // Any unclosed `{` at the start of a line that already contains an
  // envelope-y key like `"assistant"`, `"actions"`, or a `type:create_*` hint.
  {
    let lastBrace = -1;
    for (let i = 0; i < working.length; i++) {
      const ch = working[i];
      if (ch !== "{") continue;
      const tail = working.slice(i, i + 200); // peek a chunk
      if (ENVELOPE_KEY_RE.test(tail) || ACTION_KEY_HINT_RE.test(tail)) {
        lastBrace = i;
      }
    }
    candidatePositions.push(lastBrace);
  }

  // Unclosed code fence.
  {
    const idx = working.lastIndexOf("```");
    if (idx >= 0) {
      const after = working.slice(idx + 3);
      candidatePositions.push(after.includes("```") ? -1 : idx);
    } else {
      candidatePositions.push(-1);
    }
  }

  const cut = Math.max(...candidatePositions);
  if (cut >= 0) {
    const tail = working.slice(cut);
    const opens = (tail.match(/\{/g) || []).length + (tail.match(/\[/g) || []).length;
    const closes = (tail.match(/\}/g) || []).length + (tail.match(/\]/g) || []).length;
    const looksLikeFence = tail.startsWith("```");
    if (looksLikeFence || opens > closes) {
      working = working.slice(0, cut);
    }
  }

  return working.replace(/\n{3,}/g, "\n\n");
}
