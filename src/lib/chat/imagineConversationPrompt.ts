/**
 * Imagine's 4-up canvas sends the typed bar text straight to the image model.
 * After a Chat brainstorm that already planned the picture, a send like
 * "generate it" has no scene of its own — fold the prior thread in so the
 * model draws the planned image instead of inventing a random one.
 */
import { buildImaginePrompt, type ImagineAttachment } from "@/lib/chat/imagineAttachments";

const MAX_BRIEF_CHARS = 2400;
const MAX_USER_TURN = 500;
const MAX_ASSISTANT_TURN = 1400;
const MAX_TURNS = 10;

const BARE_ACTION_RE =
  /^(?:(?:ok|okay|sure|yes|yeah|yep|please|now|so|alright|all right|cool|great)[,.\s!]*)*(?:please\s+|just\s+|now\s+)?(?:go(?:\s+ahead)?|do\s+it|make\s+it(?:\s+happen)?|create\s+it|draw\s+it|generate(?:\s+it)?|let'?s\s+(?:go|do\s+it|make\s+it)|ship\s+it|proceed|continue|do\s+this|make\s+this|create\s+this|generate\s+this|make\s+one|do\s+one)[.!?…]*$/i;

const BARE_IMAGE_COMMISSION_RE =
  /^(?:(?:please|just)\s+)?(?:make|create|generate|draw|paint|render)\s+(?:(?:me|us)\s+)?(?:(?:an?|the)\s+)?(?:image|picture|photo|pic|one)(?:\s+please)?[.!?…]*$/i;

const DEIXIS_RE =
  /\b(?:we|you)\s+(?:just\s+)?(?:discussed|planned|described|talked about|came up with|sketched|outlined|designed)\b|\b(?:as|like)\s+(?:we|you)\s+(?:said|planned|described|discussed)\b|\b(?:this conversation|from earlier|the (?:one|idea|concept|plan|brief|design) we)\b|\b(?:that|this)\s+(?:but|except|only|just)\b|^(?:make|create|generate|do|draw|paint|render)\s+(?:it|this|that|them)\b|\bsame\s+(?:idea|plan|concept|one|thing)\b/i;

const DEFINITE_SHORT_RE =
  /^(?:(?:please|just)\s+)?(?:(?:make|create|generate|draw|do)\s+(?:me\s+)?)?(?:the|our|my|this|that)\s+\S+/i;

const SELF_CONTAINED_SCENE_RE =
  /^(?:an?\s+).{8,}/i;

const SCENE_PREP_RE = /\b(?:of|with|in|on|at|from|showing|depicting)\b/i;

const IMAGINE_STATUS_RE =
  /^(?:Generating images\.|(?:Generated|Refined|Varied) \d+ images?\.)\s*$/;

const IMAGINE_SWITCH_RE =
  /Image generation lives in Imagine|Switch to \*\*Imagine\*\*|looks like an image request/i;

export type ImagineConversationTurn = {
  content?: string;
  aiResponse?: string;
  kind?: string;
  imagine?: unknown;
  aiImages?: unknown[];
};

function normalize(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  if (max < 24) return s.slice(0, max);
  return `${s.slice(0, max - 1)}…`;
}

const BARE_CONFIRM_RE =
  /^(?:ok|okay|sure|yes|yeah|yep|please|now|alright|all right|cool|great)[.!?…]*$/i;

/** Go / generate it / make an image — no scene of its own. */
export function isBareImagineAction(text: string): boolean {
  const t = normalize(text);
  if (!t) return true;
  return BARE_ACTION_RE.test(t) || BARE_IMAGE_COMMISSION_RE.test(t) || BARE_CONFIRM_RE.test(t);
}

/** True when the typed Imagine send cannot stand alone as an image prompt. */
export function needsImagineConversation(text: string): boolean {
  const t = normalize(text);
  if (!t) return true;
  if (isBareImagineAction(t)) return true;
  if (DEIXIS_RE.test(t)) return true;
  if (t.length < 80 && DEFINITE_SHORT_RE.test(t)) return true;
  if (t.length < 72 && !(SELF_CONTAINED_SCENE_RE.test(t) && SCENE_PREP_RE.test(t))) {
    return true;
  }
  return false;
}

function isImagineStatusNote(text: string): boolean {
  return IMAGINE_STATUS_RE.test(String(text || "").trim());
}

function isSkippedTurn(msg: ImagineConversationTurn): boolean {
  if (!msg) return true;
  if (msg.kind === "load-in-greeting") return true;
  if (msg.imagine) return true;
  if (Array.isArray(msg.aiImages) && msg.aiImages.length > 0) return true;
  return false;
}

/**
 * Visual plan from prior Chat turns. Imagine batches and mode-switch
 * notices are skipped so a later "generate it" still sees the brainstorm.
 */
export function extractImagineConversationBrief(
  messages: ImagineConversationTurn[] | null | undefined,
): string {
  const rows: string[] = [];
  for (const msg of messages || []) {
    if (isSkippedTurn(msg)) continue;
    const user = clip(String(msg.content || ""), MAX_USER_TURN);
    const rawAssistant = String(msg.aiResponse || "").trim();
    if (IMAGINE_SWITCH_RE.test(rawAssistant)) continue;
    let assistant = "";
    if (rawAssistant && !isImagineStatusNote(rawAssistant)) {
      assistant = clip(rawAssistant, MAX_ASSISTANT_TURN);
    }
    if (!user && !assistant) continue;
    if (user) rows.push(`User: ${user}`);
    if (assistant) rows.push(`LYKN: ${assistant}`);
  }
  if (!rows.length) return "";

  const kept: string[] = [];
  let used = 0;
  const start = Math.max(0, rows.length - MAX_TURNS * 2);
  for (let i = rows.length - 1; i >= start; i -= 1) {
    const line = rows[i];
    if (used + line.length + 1 > MAX_BRIEF_CHARS) break;
    kept.push(line);
    used += line.length + 1;
  }
  kept.reverse();
  return kept.join("\n");
}

/** Brief to fold into this Imagine send, or "" when the typed prompt is enough. */
export function imagineConversationBriefForPrompt(
  text: string,
  messages: ImagineConversationTurn[] | null | undefined,
): string {
  if (!needsImagineConversation(text)) return "";
  return extractImagineConversationBrief(messages);
}

function imaginePromptLeadsWithBrief(text: string): boolean {
  const t = normalize(text);
  if (!t) return true;
  if (isBareImagineAction(t)) return true;
  if (t.length < 48 && /^(?:the|our|my|this|that)\s+\S+$/i.test(t)) return true;
  return false;
}

/**
 * Prompt the image model actually receives. The chat bubble still shows
 * the user's typed words; this is the expanded brief behind them.
 */
export function resolveImagineGenerationPrompt(opts: {
  text: string;
  conversationBrief?: string;
  attachments?: ImagineAttachment[];
}): string {
  const text = String(opts.text || "").trim();
  const brief = String(opts.conversationBrief || "").trim();
  const atts = opts.attachments || [];

  let lead = text;
  if (brief) {
    if (imaginePromptLeadsWithBrief(text)) {
      const direction = text && !isBareImagineAction(text) ? `\n\nUser direction: ${text}` : "";
      lead = `${brief}\n\nGenerate the image described above.${direction}`;
    } else {
      lead = `${text}\n\nPlanned image from this conversation:\n${brief}`;
    }
  }
  if (!lead) lead = "Generate an image from the reference.";
  return buildImaginePrompt(lead, atts);
}
