import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import SlashCommandMenu from "./SlashCommandMenu";
import YouTubeEmbed from "./YouTubeEmbed";
import { extractYouTubeVideoId, isYouTubeUrl } from "@/lib/youtubeUtils";
import SpreadsheetBlock from "./SpreadsheetBlock";
import DesignBoardBlock from "./DesignBoardBlock";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Copy, Check } from "lucide-react";
import { normalizeValueToV2, serializeV2Payload } from "./blockModel";

// eslint / TS tooling can infer overly-strict props for JS components; cast for JSX usage here.
const YouTubeEmbedAny = /** @type {any} */ (YouTubeEmbed);
const SelectAny = /** @type {any} */ (Select);
const SelectContentAny = /** @type {any} */ (SelectContent);
const SelectItemAny = /** @type {any} */ (SelectItem);
const SelectTriggerAny = /** @type {any} */ (SelectTrigger);
const SelectValueAny = /** @type {any} */ (SelectValue);

function normalizeNewlines(s) {
  return (s ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function extractFirstJsonObject(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  // ```json ... ```
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fence ? String(fence[1] || "").trim() : raw;

  // Direct JSON object
  if (candidate.startsWith("{") && candidate.endsWith("}")) {
    const parsed = safeJsonParse(candidate, null);
    if (parsed && typeof parsed === "object") return parsed;
  }

  // Best-effort: first { ... last }
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const slice = candidate.slice(first, last + 1);
    const parsed = safeJsonParse(slice, null);
    if (parsed && typeof parsed === "object") return parsed;
  }
  return null;
}

function wrapAfterCharsFinishWord(text, limit = 40) {
  const s = String(text ?? "").replace(/\r/g, "");
  const lim = Math.max(1, Math.floor(limit || 40));
  let out = "";
  let lineLen = 0;

  const isWs = (ch) => ch === " " || ch === "\t";

  for (let i = 0; i < s.length; i += 1) {
    const ch0 = s[i];

    if (ch0 === "\n") {
      out += "\n";
      lineLen = 0;
      continue;
    }

    // Normalize tabs to spaces.
    const ch = ch0 === "\t" ? " " : ch0;

    // Skip leading spaces on a fresh line (prevents weird indentation after forced wrap).
    if (ch === " " && lineLen === 0) continue;

    // If we've hit/exceeded the limit, wait until we reach whitespace (end of the current word),
    // then start a new line. This prevents splitting mid-word.
    if (lineLen >= lim && ch === " ") {
      out += "\n";
      lineLen = 0;
      continue;
    }

    // Collapse multiple spaces when we're past the limit (avoid huge gaps before wrapping).
    if (lineLen >= lim && isWs(ch) && out.endsWith(" ")) continue;

    out += ch;
    lineLen += 1;
  }

  return out;
}

function normalizeAiPromptLine(line) {
  const s = String(line ?? "").trim();
  const lower = s.toLowerCase();
  if (lower.startsWith("ai:")) return s.slice(3).trim();
  if (lower.startsWith("/ai")) return s.replace(/^\/ai\s*/i, "").trim();
  return s;
}

function dedupeAiAssistantText(text) {
  let s = String(text ?? "");
  if (!s) return "";
  // Normalize newlines and trim trailing whitespace (keep leading whitespace intact).
  s = normalizeNewlines(s).replace(/[ \t]+\n/g, "\n").trimEnd();
  const norm = (x) =>
    normalizeNewlines(String(x ?? ""))
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  // If the entire message is duplicated (common LLM glitch): A\n\nA -> A
  const m = s.match(/^([\s\S]+?)\s*\n{2,}\1\s*$/);
  if (m && m[1]) s = String(m[1]).trimEnd();

  // Remove consecutive duplicate paragraphs.
  const paras = s.split(/\n{2,}/g);
  const outParas = [];
  for (const p0 of paras) {
    const p = String(p0 ?? "").trim();
    if (!p) continue;
    const last = outParas.length ? outParas[outParas.length - 1] : null;
    if (last && norm(last) === norm(p)) continue;
    outParas.push(p);
  }
  s = outParas.join("\n\n");

  // Also remove consecutive duplicate lines (extra safety).
  const lines = s.split("\n");
  const outLines = [];
  let lastNonEmptyNorm = "";
  for (const l0 of lines) {
    const l = String(l0 ?? "");
    const ln = norm(l);
    if (ln) {
      if (lastNonEmptyNorm && lastNonEmptyNorm === ln) continue;
      lastNonEmptyNorm = ln;
    }
    outLines.push(l);
  }
  return outLines.join("\n").trimEnd();
}

function extractFocusFromUserLine(line) {
  const s = String(line ?? "").trim();
  if (!s) return "";
  // If the user typed multiple clauses/questions on one line, focus the LAST clause.
  // Examples:
  // - "Are you working? I was just checking" -> "I was just checking"
  // - "Are you working? Are you there?" -> "Are you there"
  const parts = s
    .split(/[?!\.]+/g)
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    // Avoid focusing an extremely short tail like "ok".
    if (last.length >= 2) return last;
  }
  return s.trim();
}

function stripQuestionRestatement(answerText) {
  let a = String(answerText ?? "");
  if (!a) return "";
  let s = normalizeNewlines(a).trimStart();

  // Remove leading "It seems like you're asking..." / "Sounds like you're asking..." boilerplate.
  // We remove either:
  // - the first paragraph (up to blank line), OR
  // - if there is no blank line, up to the first line break, OR
  // - up to ~220 chars as a safety cap.
  const lead = s.slice(0, 260);
  const isRestate =
    /^\s*(it\s+(seems|sounds)\s+like|sounds\s+like|looks\s+like)\b/i.test(lead) &&
    /\b(you|you're)\s+(are\s+)?asking\b/i.test(lead);
  if (isRestate) {
    const paraIdx = s.search(/\n{2,}/);
    if (paraIdx >= 0) {
      s = s.slice(paraIdx).replace(/^\n+/, "");
    } else {
      const lineIdx = s.indexOf("\n");
      if (lineIdx >= 0) {
        s = s.slice(lineIdx + 1);
      } else {
        s = s.slice(220);
      }
    }
  }

  return String(s).trimStart();
}

function stripEchoedQuestionPrefix(answerText, questionText) {
  let a = String(answerText ?? "");
  const q = String(questionText ?? "").trim();
  if (!a || !q) return a;

  const norm = (s) =>
    normalizeNewlines(String(s ?? ""))
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const aNorm = norm(a);
  const qNorm = norm(q);

  // Patterns like:
  // - "<question>\n\n<answer>"
  // - "You asked: <question> ..."
  // - "<question> - <answer>"
  const prefixes = [
    qNorm,
    `you asked: ${qNorm}`,
    `question: ${qNorm}`,
    `q: ${qNorm}`,
  ];

  // If the answer starts with any of these, remove the corresponding original-text prefix.
  for (const p of prefixes) {
    if (!p) continue;
    if (aNorm.startsWith(p)) {
      // Try to strip using the original (case-sensitive) question too, to preserve formatting.
      const idx = a.toLowerCase().indexOf(q.toLowerCase());
      if (idx === 0) {
        a = a.slice(q.length);
      } else {
        // Fallback: strip first line if it matches the question loosely.
        const lines = normalizeNewlines(a).split("\n");
        if (lines.length && norm(lines[0]) === qNorm) {
          a = lines.slice(1).join("\n");
        } else if (lines.length >= 2 && norm(`${lines[0]} ${lines[1]}`) === qNorm) {
          a = lines.slice(2).join("\n");
        }
      }
      break;
    }
  }

  // Also strip "You asked:" style lead-ins even if the question isn't an exact match.
  a = a.replace(/^\s*(you asked|question|q)\s*:\s*/i, "");

  // Clean up leftover separators and whitespace.
  a = a.replace(/^\s*[-–—:]+\s*/g, "").trimStart();
  return a;
}

function isAiIntentLine(line) {
  const s = String(line ?? "").trim();
  if (!s) return false;
  // Avoid triggering on every normal sentence: require an action verb + a canvas target keyword.
  const hasVerb = /\b(make|create|generate|build|open|add|insert|start|setup|set up|pull up|bring up|fill|populate|include|put|set|update|analyze|analyse|summarize|transcribe|extract)\b/i.test(s);
  const hasTarget = /\b(spreadsheet|table|sheet|doc|document|design board|whiteboard|board|todo|checklist|to-?do|bulleted list|numbered list|list|code block|code|youtube|video|pdf|image|audio)\b/i.test(s);
  // Keep it "command-like": must be more than one token unless explicitly prefixed with ai:/ai.
  const multiWord = /\s/.test(s);
  const isExplicit = /^(\s*ai:|\s*\/ai\b)/i.test(s);
  return Boolean(hasVerb && hasTarget && (multiWord || isExplicit));
}

function isAiPromptLine(line) {
  const s = String(line ?? "").trim();
  const lower = s.toLowerCase();
  return s.endsWith("?") || lower.startsWith("ai:") || lower.startsWith("/ai") || isAiIntentLine(s);
}

function summarizeBlocksForAI(blocks, { brickWidth = 1, brickHeight = 1, limit = 24 } = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const out = [];
  const max = Math.max(0, Math.min(list.length, Math.floor(limit)));

  const pos = (b) => {
    const xb = Math.round((Number(b?.x) || 0) / Math.max(1, brickWidth));
    const yb = Math.round((Number(b?.y) || 0) / Math.max(1, brickHeight));
    const w = Number.isFinite(b?.widthBricks) ? Math.max(1, Math.floor(b.widthBricks)) : 1;
    const h = Number.isFinite(b?.heightBricks) ? Math.max(1, Math.floor(b.heightBricks)) : 1;
    return `@(${xb},${yb}) ${w}x${h}`;
  };

  for (let i = 0; i < max; i += 1) {
    const b = list[i];
    const kind = b?.kind || "text";
    const id = b?.id ? String(b.id) : `idx-${i}`;

    if (kind === "text") {
      const fmt = b?.format || "p";
      const t = String(b?.text ?? "").trim().replace(/\s+/g, " ").slice(0, 240);
      out.push(`[${id}] text(${fmt}) ${pos(b)}: ${t || "(empty)"}`);
      continue;
    }
    if (kind === "list") {
      const listType = b?.listType || "bulleted";
      const items = Array.isArray(b?.items) ? b.items : [];
      const preview = items
        .slice(0, 5)
        .map((it, idx) => {
          const body = String(it?.text ?? "").trim().slice(0, 60);
          if (listType === "todo") return `${idx + 1}. [${it?.checked ? "x" : " "}] ${body}`;
          return `${idx + 1}. ${body}`;
        })
        .join(" | ");
      out.push(`[${id}] list(${listType}) ${pos(b)}: items=${items.length}${preview ? `, ${preview}` : ""}`);
      continue;
    }
    if (kind === "sheet") {
      const t = String(b?.text ?? "").trim().replace(/\s+/g, " ").slice(0, 220);
      out.push(`[${id}] sheet ${pos(b)}: ${t || "(empty)"}`);
      continue;
    }
    if (kind === "spreadsheet") {
      const sheet = b?.sheet || {};
      const rows = Number(sheet?.rows) || 0;
      const cols = Number(sheet?.cols) || 0;
      const cells = sheet?.cells && typeof sheet.cells === "object" ? sheet.cells : {};
      const nonEmpty = Object.keys(cells).filter((k) => String(cells[k] ?? "").trim().length > 0);
      const preview = nonEmpty.slice(0, 6).map((k) => `${k}="${String(cells[k]).slice(0, 40)}"`).join(", ");
      out.push(`[${id}] spreadsheet ${pos(b)}: ${rows}x${cols}, filled=${nonEmpty.length}${preview ? `, ${preview}` : ""}`);
      continue;
    }
    if (kind === "design") {
      const board = b?.board;
      const nodes = Array.isArray(board?.nodes) ? board.nodes.length : Array.isArray(board?.items) ? board.items.length : null;
      out.push(`[${id}] design ${pos(b)}: ${nodes != null ? `${nodes} items` : "(board)"}`);
      continue;
    }
    if (kind === "divider") {
      out.push(`[${id}] divider ${pos(b)}`);
      continue;
    }

    // Media + others
    const mediaType = b?.mediaType || kind;
    const label = (b?.media?.title || b?.media?.name || b?.media?.url || "").toString().slice(0, 80);
    out.push(`[${id}] ${mediaType} ${pos(b)}${label ? `: ${label}` : ""}`);
  }

  return out.join("\n");
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeListItem(listType, text) {
  const base = { id: makeId(), text: text ?? "" };
  if (listType === "todo") return { ...base, checked: false };
  return base;
}

function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function setNodeTextOnce(node, text) {
  if (!node) return;
  if (node.dataset.brickInitialized === "true") return;
  node.textContent = text ?? "";
  node.dataset.brickInitialized = "true";
}

function deleteTextRangeInElement(el, startOffset, endOffset) {
  try {
    const root = el;
    if (!root) return false;
    const start = Math.max(0, Math.floor(startOffset ?? 0));
    const end = Math.max(start, Math.floor(endOffset ?? start));

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let pos = 0;

    const locate = (target) => {
      let n = node;
      let p = pos;
      while (n) {
        const len = n.textContent?.length ?? 0;
        if (p + len >= target) {
          return { n, o: Math.max(0, Math.min(len, target - p)) };
        }
        p += len;
        n = walker.nextNode();
      }
      return null;
    };

    // Reset walker by recreating (TreeWalker is stateful).
    const walker2 = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    node = walker2.nextNode();
    pos = 0;
    const startLoc = (() => {
      let n = node;
      let p = pos;
      while (n) {
        const len = n.textContent?.length ?? 0;
        if (p + len >= start) return { n, o: Math.max(0, Math.min(len, start - p)) };
        p += len;
        n = walker2.nextNode();
      }
      return null;
    })();

    // Need a fresh walker again for end locate (since walker2 has advanced).
    const walker3 = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const endLoc = (() => {
      let n = walker3.nextNode();
      let p = 0;
      while (n) {
        const len = n.textContent?.length ?? 0;
        if (p + len >= end) return { n, o: Math.max(0, Math.min(len, end - p)) };
        p += len;
        n = walker3.nextNode();
      }
      return null;
    })();

    if (!startLoc || !endLoc) return false;
    const range = document.createRange();
    range.setStart(startLoc.n, startLoc.o);
    range.setEnd(endLoc.n, endLoc.o);
    range.deleteContents();
    return true;
  } catch {
    return false;
  }
}

// When contentEditable contains block elements (<div>, <p>) produced by Enter,
// `textContent` will drop visual line breaks. This helper preserves them as "\n"
// and can map offsets from the raw `textContent` space to the "\n"-inclusive space.
function getEditableTextWithNewlinesAndMapOffsets(rootEl, rawOffsets, opts) {
  const options = opts || {};
  const stripTrailingNewline = options.stripTrailingNewline !== false;
  const el = rootEl;
  const offsets = Array.isArray(rawOffsets) ? rawOffsets.slice() : [];
  const sorted = offsets
    .map((n) => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0))
    .sort((a, b) => a - b);

  /** @type {Map<number, number>} */
  const mapped = new Map();
  let rawPos = 0; // counts characters in concatenated text nodes (aka textContent space)
  let outPos = 0; // counts characters including inserted "\n"
  const parts = [];

  const mapAtCurrentBoundary = () => {
    // Any raw offsets that land "between" nodes map to the current outPos.
    while (sorted.length && sorted[0] === rawPos) {
      const k = sorted.shift();
      mapped.set(k, outPos);
    }
  };

  const appendText = (t) => {
    const text = t ?? "";
    // Map offsets that fall inside this text node.
    while (sorted.length && sorted[0] >= rawPos && sorted[0] <= rawPos + text.length) {
      const k = sorted.shift();
      mapped.set(k, outPos + (k - rawPos));
    }
    parts.push(text);
    rawPos += text.length;
    outPos += text.length;
  };

  const appendBreak = () => {
    mapAtCurrentBoundary();
    parts.push("\n");
    outPos += 1;
  };

  const isBlockTag = (tag) => tag === "DIV" || tag === "P" || tag === "LI";

  const walk = (node) => {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    // eslint-disable-next-line no-undef
    const tag = node.tagName;
    if (tag === "BR") {
      appendBreak();
      return;
    }

    // Before children, map boundaries at this point.
    mapAtCurrentBoundary();
    const children = Array.from(node.childNodes || []);
    for (const child of children) walk(child);
    if (isBlockTag(tag)) appendBreak();
  };

  walk(el);
  mapAtCurrentBoundary();

  let text = normalizeNewlines(parts.join(""));
  // Strip one trailing newline commonly produced by contentEditable's final empty line.
  // Code blocks should preserve trailing newlines (Enter-at-end should always create a new line).
  if (stripTrailingNewline && text.endsWith("\n")) text = text.slice(0, -1);

  const max = text.length;
  // Clamp any mapped offsets that ended up beyond the trimmed end.
  for (const [k, v] of mapped.entries()) {
    if (v > max) mapped.set(k, max);
  }
  for (const k of offsets) {
    if (!mapped.has(k)) mapped.set(k, Math.min(max, k));
  }

  return {
    text,
    mapOffset: (rawOffset) => mapped.get(rawOffset) ?? Math.min(text.length, Math.max(0, Math.floor(rawOffset || 0))),
  };
}

function measureSheetTextFits({ text, widthPx, heightPx, sampleEl }) {
  const measurer = document.createElement("div");
  measurer.style.position = "fixed";
  measurer.style.left = "-100000px";
  measurer.style.top = "-100000px";
  measurer.style.visibility = "hidden";
  measurer.style.pointerEvents = "none";
  measurer.style.whiteSpace = "pre-wrap";
  measurer.style.wordBreak = "break-word";
  measurer.style.overflow = "hidden";
  measurer.style.width = `${Math.max(0, widthPx)}px`;
  measurer.style.height = `${Math.max(0, heightPx)}px`;
  measurer.style.boxSizing = "border-box";

  try {
    if (sampleEl) {
      const cs = window.getComputedStyle(sampleEl);
      measurer.style.fontFamily = cs.fontFamily;
      measurer.style.fontSize = cs.fontSize;
      measurer.style.fontWeight = cs.fontWeight;
      measurer.style.lineHeight = cs.lineHeight;
      measurer.style.letterSpacing = cs.letterSpacing;
      measurer.style.padding = cs.padding;
    }
  } catch {
    // ignore
  }

  measurer.textContent = text ?? "";
  document.body.appendChild(measurer);
  const fits = measurer.scrollHeight <= measurer.clientHeight + 1;
  document.body.removeChild(measurer);
  return fits;
}

function placeCaretAtStart(el) {
  if (!el) return;
  try {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // ignore
  }
}

function estimateTextWidthPx(text, fontFamily, fontSize) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return 200;
  ctx.font = `${fontSize}px ${fontFamily}`;
  const lines = normalizeNewlines(text ?? "").split("\n");
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  // Measure a representative string to get average glyph width.
  const sample = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const sampleWidth = ctx.measureText(sample).width || 8 * sample.length;
  const avg = sampleWidth / sample.length;
  return Math.ceil(longest * avg);
}

function normalizeListText(text, format) {
  return text ?? "";
}

function getTextBlockStyle(format, baseFontSize, brickHeight) {
  if (format === "h1") return { fontSize: Math.min(20, baseFontSize + 6), fontWeight: 650, lineHeight: `${brickHeight * 2}px` };
  if (format === "h2") return { fontSize: Math.min(18, baseFontSize + 4), fontWeight: 650, lineHeight: `${brickHeight * 2}px` };
  if (format === "h3") return { fontSize: Math.min(16, baseFontSize + 2), fontWeight: 650, lineHeight: `${brickHeight}px` };
  if (format === "quote") return { borderLeft: "3px solid rgba(255,255,255,0.35)", paddingLeft: "10px" };
  if (format === "code")
    return {
      fontFamily: `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`,
      // Let the outer glass surface provide the "card" look; keep code readable.
    };
  return {};
}

// -----------------------------
// v2 Universal Block model helpers (internal state keeps legacy aliases to avoid UI refactors)
// -----------------------------

const V1_MEDIA_KINDS = new Set(["youtube", "image", "video", "audio", "pdf", "file", "link"]);

function clampInt(n, min) {
  const v = Number.isFinite(n) ? Math.floor(n) : min;
  return Math.max(min, v);
}

function deriveV2TypeFromLegacyLike(b) {
  const kind = b?.kind || "text";
  const format = b?.format || "p";
  if (kind === "text") {
    if (format === "code") return "CodeBlock";
    return "TextBlock";
  }
  if (kind === "list") return "ListBlock";
  if (kind === "divider") return "DividerBlock";
  if (kind === "sheet") return "SheetBlock";
  if (kind === "spreadsheet") return "SpreadsheetBlock";
  if (kind === "design") return "DesignBlock";
  if (V1_MEDIA_KINDS.has(kind)) return "MediaBlock";
  return "TextBlock";
}

function toV2CoreBlockShape(block, defaultBlockWidthBricks) {
  const id = block?.id || makeId();
  const x = Number.isFinite(block?.x) ? Math.round(block.x) : 0;
  const y = Number.isFinite(block?.y) ? Math.round(block.y) : 0;
  const type = block?.type || deriveV2TypeFromLegacyLike(block);
  const groupId = block?.groupId || null;
  const width = clampInt(block?.width ?? block?.widthBricks ?? defaultBlockWidthBricks ?? 14, 1);
  const height = clampInt(block?.height ?? block?.heightBricks ?? 1, 1);

  // If caller already provided v2 content/style, keep them.
  let content = block?.content || {};
  let style = block?.style || {};

  // If caller only has legacy fields, derive v2 content/style.
  if ((!block?.content || Object.keys(block.content).length === 0) && block) {
    const kind = block.kind || "text";
    const format = block.format || "p";
    if (type === "TextBlock") {
      content = { text: block.text ?? "" };
      style = { format };
    } else if (type === "ListBlock") {
      content = { listType: block.listType || "bulleted", items: block.items || [] };
      style = {};
    } else if (type === "SheetBlock") {
      content = { text: block.text ?? "" };
      style = { format: "sheet" };
    } else if (type === "CodeBlock") {
      content = { text: block.text ?? "", language: block.language || "plaintext" };
      style = { format: "code" };
    } else if (type === "SpreadsheetBlock") {
      content = { sheet: block.sheet };
      style = {};
    } else if (type === "DesignBlock") {
      content = { board: block.board };
      style = {};
    } else if (type === "MediaBlock") {
      content = { mediaType: kind, media: block.media || {} };
      style = {};
    } else if (type === "DividerBlock") {
      content = {};
      style = {};
    }
  }

  return {
    id,
    type,
    groupId,
    x,
    y,
    width,
    height,
    content,
    style,
    children: Array.isArray(block?.children) ? block.children : undefined,
  };
}

function v2ToInternalBlock(blockV2Core, defaultBlockWidthBricks) {
  const b = toV2CoreBlockShape(blockV2Core, defaultBlockWidthBricks);
  const { id, type, groupId, x, y, width, height, content, style, children } = b;

  // Legacy aliases (keeps existing UI logic intact while we migrate behavior).
  let kind = "text";
  let format = "p";
  let text = "";
  let language = undefined;
  let media = undefined;
  let sheet = undefined;
  let board = undefined;
  let listType = undefined;
  let items = undefined;

  if (type === "TextBlock") {
    kind = "text";
    format = style?.format || "p";
    text = content?.text ?? "";
  } else if (type === "SheetBlock") {
    kind = "sheet";
    format = "sheet";
    text = content?.text ?? "";
  } else if (type === "ListBlock") {
    kind = "list";
    listType = content?.listType || "bulleted";
    items = Array.isArray(content?.items) ? content.items : [];
  } else if (type === "CodeBlock") {
    kind = "text";
    format = "code";
    text = content?.text ?? "";
    language = content?.language || "plaintext";
  } else if (type === "SpreadsheetBlock") {
    kind = "spreadsheet";
    sheet = content?.sheet;
  } else if (type === "DesignBlock") {
    kind = "design";
    board = content?.board;
  } else if (type === "MediaBlock") {
    kind = content?.mediaType || "file";
    media = content?.media || {};
  } else if (type === "DividerBlock") {
    kind = "divider";
  }

  return {
    id,
    type,
    groupId,
    x,
    y,
    width,
    height,
    content,
    style,
    children,
    // legacy fields:
    kind,
    format,
    widthBricks: width,
    heightBricks: height,
    text,
    language,
    media,
    sheet,
    board,
    listType,
    items,
  };
}

function stripInternalToV2(blockInternal) {
  const b = blockInternal || {};
  return {
    id: b.id,
    type: b.type,
    groupId: b.groupId ?? null,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    content: b.content,
    style: b.style,
    children: b.children,
  };
}

function applyInternalPatch(blockInternal, patch, defaultBlockWidthBricks) {
  const b = blockInternal || {};
  const p = patch || {};

  // Start from the existing *v2* core so patching stays consistent.
  let nextCore = toV2CoreBlockShape(b, defaultBlockWidthBricks);

  // Common positional/size aliases used throughout BrickEditor today.
  if ("x" in p) nextCore.x = p.x;
  if ("y" in p) nextCore.y = p.y;
  if ("width" in p) nextCore.width = p.width;
  if ("height" in p) nextCore.height = p.height;
  if ("widthBricks" in p) nextCore.width = p.widthBricks;
  if ("heightBricks" in p) nextCore.height = p.heightBricks;

  // Legacy fields that affect v2 core.
  if ("kind" in p) {
    // Keep v2.type stable unless the caller explicitly changes it via type/format.
    // MediaBlock kind is stored in content.mediaType.
    if (nextCore.type === "MediaBlock") {
      nextCore.content = { ...(nextCore.content || {}), mediaType: p.kind };
    }
  }
  if ("format" in p) {
    // Transform between text-like block types when format indicates it.
    if (p.format === "code") nextCore.type = "CodeBlock";
    else if (nextCore.type === "CodeBlock") nextCore.type = "TextBlock";
    nextCore.style = { ...(nextCore.style || {}), format: p.format };
  }
  if ("type" in p) {
    nextCore.type = p.type;
  }
  if ("groupId" in p) {
    nextCore.groupId = p.groupId ?? null;
  }

  if ("text" in p) {
    nextCore.content = { ...(nextCore.content || {}), text: p.text ?? "" };
  }
  if ("listType" in p) {
    nextCore.content = { ...(nextCore.content || {}), listType: p.listType };
  }
  if ("items" in p) {
    nextCore.content = { ...(nextCore.content || {}), items: Array.isArray(p.items) ? p.items : [] };
  }
  if ("language" in p) {
    nextCore.content = { ...(nextCore.content || {}), language: p.language || "plaintext" };
  }
  if ("media" in p) {
    nextCore.content = { ...(nextCore.content || {}), media: p.media || {} };
  }
  if ("sheet" in p) {
    nextCore.content = { ...(nextCore.content || {}), sheet: p.sheet };
  }
  if ("board" in p) {
    nextCore.content = { ...(nextCore.content || {}), board: p.board };
  }

  // Merge any direct content/style updates.
  if ("content" in p) {
    nextCore.content = { ...(nextCore.content || {}), ...(p.content || {}) };
  }
  if ("style" in p) {
    nextCore.style = { ...(nextCore.style || {}), ...(p.style || {}) };
  }
  if ("children" in p) {
    nextCore.children = p.children;
  }

  return v2ToInternalBlock(nextCore, defaultBlockWidthBricks);
}

function getCaretOffsetInElement(el) {
  try {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return 0;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return 0;
    const pre = document.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().length;
  } catch {
    return 0;
  }
}

function setCaretOffsetInElement(el, offset) {
  try {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();

    let remaining = Math.max(0, offset);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let node = walker.nextNode();
    while (node) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) {
        range.setStart(node, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= len;
      node = walker.nextNode();
    }

    // Fallback: end of element
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    // ignore
  }
}

function getClientRectAtCharOffset(el, offset) {
  try {
    let remaining = Math.max(0, offset);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let node = walker.nextNode();
    while (node) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) {
        const range = document.createRange();
        // Prefer a 1-character range so the rect is non-zero (collapsed ranges can return 0,0,0,0).
        const start = Math.max(0, Math.min(len, remaining));
        const end = Math.max(0, Math.min(len, remaining + 1));
        if (start === end && start > 0) {
          range.setStart(node, start - 1);
          range.setEnd(node, start);
        } else {
          range.setStart(node, start);
          range.setEnd(node, end);
        }
        const rect = range.getBoundingClientRect?.();
        if (rect && rect.width + rect.height > 0) return rect;
        const cr = range.getClientRects?.();
        if (cr && cr.length) return cr[0];
        return null;
      }
      remaining -= len;
      node = walker.nextNode();
    }
    // Fallback: end of element
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const rect = range.getBoundingClientRect?.();
    if (rect && rect.width + rect.height > 0) return rect;
    return null;
  } catch {
    return null;
  }
}

function getLineStart(text, caret) {
  const i = (text ?? "").lastIndexOf("\n", Math.max(0, caret - 1));
  return i === -1 ? 0 : i + 1;
}

function getLineEnd(text, caret) {
  const i = (text ?? "").indexOf("\n", Math.max(0, caret));
  return i === -1 ? (text ?? "").length : i;
}

function insertTextAtOffset(text, offset, insert) {
  const s = text ?? "";
  const o = Math.max(0, Math.min(s.length, offset));
  return s.slice(0, o) + insert + s.slice(o);
}

// Simple syntax highlighting function
function applySyntaxHighlighting(node, language, getCaretOffsetInElement, setCaretOffsetInElement) {
  if (!node || language === "plaintext") {
    node.style.color = '#d4d4d4';
    return;
  }

  const text = node.textContent || "";
  if (!text.trim()) {
    node.style.color = '#d4d4d4';
    return;
  }

  // Save cursor position
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const offset = range && node.contains(range.startContainer) ? getCaretOffsetInElement(node) : null;

  // Language-specific keywords and patterns
  const patterns = {
    javascript: {
      keywords: /\b(const|let|var|function|if|else|for|while|return|class|extends|import|export|from|default|async|await|try|catch|finally|throw|new|this|super|typeof|instanceof|in|of|true|false|null|undefined|break|continue|switch|case|do|with|yield|static|public|private|protected|abstract|interface|enum|namespace|module|require|console|log|debugger)\b/g,
      strings: /(["'`])(?:(?=(\\?))\2.)*?\1/g,
      numbers: /\b\d+\.?\d*\b/g,
      comments: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
      functions: /\b\w+(?=\s*\()/g,
    },
    typescript: {
      keywords: /\b(const|let|var|function|if|else|for|while|return|class|extends|import|export|from|default|async|await|try|catch|finally|throw|new|this|super|typeof|instanceof|in|of|true|false|null|undefined|break|continue|switch|case|do|with|yield|static|public|private|protected|abstract|interface|enum|namespace|module|type|interface|implements|readonly|declare|namespace|module|require|console|log|debugger)\b/g,
      strings: /(["'`])(?:(?=(\\?))\2.)*?\1/g,
      numbers: /\b\d+\.?\d*\b/g,
      comments: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
      functions: /\b\w+(?=\s*\()/g,
      types: /\b(string|number|boolean|any|void|object|Array|Promise|Date|RegExp)\b/g,
    },
    python: {
      keywords: /\b(def|class|if|elif|else|for|while|return|import|from|as|try|except|finally|raise|with|lambda|yield|pass|break|continue|and|or|not|in|is|True|False|None|print)\b/g,
      strings: /(["'`])(?:(?=(\\?))\2.)*?\1/g,
      numbers: /\b\d+\.?\d*\b/g,
      comments: /#.*$/gm,
      functions: /\b\w+(?=\s*\()/g,
    },
    java: {
      keywords: /\b(public|private|protected|static|final|abstract|class|interface|extends|implements|if|else|for|while|do|switch|case|break|continue|return|try|catch|finally|throw|new|this|super|import|package|void|int|long|float|double|boolean|char|String|true|false|null)\b/g,
      strings: /(["'])(?:(?=(\\?))\2.)*?\1/g,
      numbers: /\b\d+\.?\d*\b/g,
      comments: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
      functions: /\b\w+(?=\s*\()/g,
    },
    html: {
      tags: /<\/?[\w\s="/.':;#-\/]+>/g,
      attributes: /\s+[\w-]+(?=\s*=\s*["'])/g,
      strings: /(["'])(?:(?=(\\?))\2.)*?\1/g,
      comments: /<!--[\s\S]*?-->/g,
    },
    css: {
      properties: /[\w-]+(?=\s*:)/g,
      values: /:\s*[^;]+/g,
      selectors: /[.#]?[\w-]+(?=\s*\{)/g,
      comments: /\/\*[\s\S]*?\*\//g,
    },
  };

  const langPatterns = patterns[language] || patterns.javascript;
  if (!langPatterns) {
    node.style.color = '#d4d4d4';
    return;
  }

  // Create highlighted HTML
  let html = escapeHtmlForCode(text);
  
  // Apply highlighting in order (comments first, then strings, then keywords, etc.)
  if (langPatterns.comments) {
    html = html.replace(langPatterns.comments, (match) => `<span style="color: #6a9955;">${match}</span>`);
  }
  if (langPatterns.strings) {
    html = html.replace(langPatterns.strings, (match) => `<span style="color: #ce9178;">${match}</span>`);
  }
  if (langPatterns.numbers) {
    html = html.replace(langPatterns.numbers, (match) => `<span style="color: #b5cea8;">${match}</span>`);
  }
  if (langPatterns.keywords) {
    html = html.replace(langPatterns.keywords, (match) => `<span style="color: #569cd6;">${match}</span>`);
  }
  if (langPatterns.functions) {
    html = html.replace(langPatterns.functions, (match) => `<span style="color: #dcdcaa;">${match}</span>`);
  }
  if (langPatterns.types) {
    html = html.replace(langPatterns.types, (match) => `<span style="color: #4ec9b0;">${match}</span>`);
  }
  if (langPatterns.tags) {
    html = html.replace(langPatterns.tags, (match) => `<span style="color: #569cd6;">${match}</span>`);
  }
  if (langPatterns.attributes) {
    html = html.replace(langPatterns.attributes, (match) => `<span style="color: #92c5f7;">${match}</span>`);
  }

  // Only update if different to avoid cursor jumping
  if (node.innerHTML !== html) {
    node.innerHTML = html;
    // Restore cursor position
    if (offset !== null) {
      setCaretOffsetInElement(node, offset);
    }
  }
}

function escapeHtmlForCode(text) {
  return (text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// CodeBlock Component - Notion-style code editor
function CodeBlock({
  block,
  brickHeight,
  brickWidth,
  fontSize,
  blocksRef,
  updateBlock,
  updateBlockText,
  removeBlock,
  setActiveId,
  closeSlash,
  setIsTyping,
  markTyping,
  slash,
  setSlash,
  openSlashMenuAt,
  containerRef,
  containerSize,
  getCaretOffsetInElement,
  setCaretOffsetInElement,
  fmtStyle,
  letterSpacing,
}) {
  const [copied, setCopied] = React.useState(false);
  const codeNodeRef = React.useRef(null);

  const handleCopy = useCallback(() => {
    const node = blocksRef.current.get(block.id);
    if (node) {
      const text = node.textContent || "";
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  }, [block.id, blocksRef]);

  const handleLanguageChange = useCallback((value) => {
    updateBlock(block.id, { language: value });
    // Re-apply syntax highlighting with new language
    const node = blocksRef.current.get(block.id);
    if (node) {
      requestAnimationFrame(() => {
        applySyntaxHighlighting(node, value, getCaretOffsetInElement, setCaretOffsetInElement);
      });
    }
  }, [block.id, updateBlock, blocksRef, getCaretOffsetInElement]);

  // Don't apply syntax highlighting automatically - only on blur or language change
  // This prevents vertical typing issues

  const defaultHeight = (block.heightBricks || 4) * brickHeight;

  return (
    <div 
      className="relative rounded-lg overflow-hidden w-full h-full"
      style={{ 
        height: `${defaultHeight}px`,
        width: '100%',
        backgroundColor: 'rgba(15, 15, 15, 0.6)', // Notion-style tinted background
        border: '1px solid rgba(255, 255, 255, 0.1)',
        borderRadius: '6px',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.05)'
      }}
    >
      {/* Top-right controls: Language selector and Copy button */}
      <div className="absolute top-2 right-2 z-10 flex items-center gap-2">
        <SelectAny
          value={block.language || "plaintext"}
          onValueChange={handleLanguageChange}
        >
          <SelectTriggerAny 
            className="h-7 px-2 text-xs bg-black/30 hover:bg-black/50 border-white/10 text-white/90 hover:text-white backdrop-blur-sm rounded"
            onClick={(e) => e.stopPropagation()}
          >
            <SelectValueAny />
          </SelectTriggerAny>
          <SelectContentAny className="bg-[#252526] border-white/10 text-white">
            <SelectItemAny value="plaintext">Plain Text</SelectItemAny>
            <SelectItemAny value="javascript">JavaScript</SelectItemAny>
            <SelectItemAny value="typescript">TypeScript</SelectItemAny>
            <SelectItemAny value="python">Python</SelectItemAny>
            <SelectItemAny value="java">Java</SelectItemAny>
            <SelectItemAny value="cpp">C++</SelectItemAny>
            <SelectItemAny value="c">C</SelectItemAny>
            <SelectItemAny value="csharp">C#</SelectItemAny>
            <SelectItemAny value="go">Go</SelectItemAny>
            <SelectItemAny value="rust">Rust</SelectItemAny>
            <SelectItemAny value="php">PHP</SelectItemAny>
            <SelectItemAny value="ruby">Ruby</SelectItemAny>
            <SelectItemAny value="swift">Swift</SelectItemAny>
            <SelectItemAny value="kotlin">Kotlin</SelectItemAny>
            <SelectItemAny value="html">HTML</SelectItemAny>
            <SelectItemAny value="css">CSS</SelectItemAny>
            <SelectItemAny value="json">JSON</SelectItemAny>
            <SelectItemAny value="xml">XML</SelectItemAny>
            <SelectItemAny value="sql">SQL</SelectItemAny>
            <SelectItemAny value="bash">Bash</SelectItemAny>
            <SelectItemAny value="yaml">YAML</SelectItemAny>
            <SelectItemAny value="markdown">Markdown</SelectItemAny>
          </SelectContentAny>
        </SelectAny>
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleCopy();
          }}
          className="h-7 px-2 text-xs bg-black/30 hover:bg-black/50 border border-white/10 text-white/90 hover:text-white backdrop-blur-sm rounded flex items-center gap-1.5 transition-colors"
          title={copied ? "Copied!" : "Copy code"}
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <div
        ref={(node) => {
          if (node) {
            blocksRef.current.set(block.id, node);
            codeNodeRef.current = node;
            // Use the same logic as text blocks - setNodeTextOnce
            // This ensures text is set as plain text, not HTML
            if (node.dataset.brickInitialized !== "true") {
              node.textContent = block.text || "";
              node.dataset.brickInitialized = "true";
            }
          } else {
            blocksRef.current.delete(block.id);
            codeNodeRef.current = null;
          }
        }}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        className={cn("outline-none whitespace-pre", "text-foreground")}
        style={{
          fontFamily: `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`,
          fontSize: fontSize,
          color: '#d4d4d4',
          backgroundColor: 'transparent',
          padding: '12px 100px 12px 12px', // Extra right padding for controls
          paddingTop: '44px', // Top padding for controls
          height: '100%',
          width: '100%',
          outline: 'none',
          lineHeight: fmtStyle.lineHeight || `${brickHeight}px`, // Match text block line height
          letterSpacing,
          margin: "0px",
          minHeight: `${brickHeight}px`,
        }}
        onFocus={() => {
          setActiveId(block.id);
          closeSlash();
          setIsTyping(false);
          // CRITICAL: Always convert HTML back to plain text when focusing
          // This prevents syntax highlighting from interfering with typing
          const node = blocksRef.current.get(block.id);
          if (node) {
            // Convert highlighted HTML (<span>, <br>, <div>) back to plain text with real "\n" line breaks.
            const mapped = getEditableTextWithNewlinesAndMapOffsets(node, [], { stripTrailingNewline: false });
            const text = mapped.text;
            if ((node.textContent ?? "") !== text || (node.innerHTML ?? "").includes("<span")) {
              node.textContent = text;
            }
            node.dataset.brickInitialized = "true";
          }
        }}
        onBlur={() => {
          setIsTyping(false);
          // Convert HTML back to text format (same as text blocks)
          const node = blocksRef.current.get(block.id);
          if (node) {
            const text = getEditableTextWithNewlinesAndMapOffsets(node, [], { stripTrailingNewline: false }).text;
            updateBlockText(block.id, text);
            // Apply syntax highlighting when focus is lost (only if not plaintext)
            if (block.language && block.language !== "plaintext" && text.trim()) {
              requestAnimationFrame(() => {
                applySyntaxHighlighting(node, block.language, getCaretOffsetInElement, setCaretOffsetInElement);
              });
            }
          }
          // Remove empty text blocks so they don't leave invisible "dead zones" on the canvas.
          // Only remove after blur (so user can still click in and start typing).
          requestAnimationFrame(() => {
            const node = blocksRef.current.get(block.id);
            const text = (node?.textContent ?? "").trim();
            if (text.length === 0) {
              removeBlock(block.id);
            }
          });
        }}
        onInput={(e) => {
          // Exact same logic as text blocks - no syntax highlighting during typing
          const node = blocksRef.current.get(block.id);
          if (node) {
            // Preserve Enter-created line breaks (contentEditable often inserts <div>/<br>).
            // Normalize to real "\n" in a plain-text node and keep caret stable.
            const caretRaw = getCaretOffsetInElement(node);
            const mapped = getEditableTextWithNewlinesAndMapOffsets(node, [caretRaw], { stripTrailingNewline: false });
            const text = mapped.text;
            const caret = mapped.mapOffset(caretRaw);
            if ((node.textContent ?? "") !== text || (node.innerHTML ?? "").includes("<span") || (node.innerHTML ?? "").includes("<div") || (node.innerHTML ?? "").includes("<br") || (node.innerHTML ?? "").includes("<p")) {
              node.textContent = text;
              setCaretOffsetInElement(node, caret);
            }
            
            // Update block text (same as text blocks)
            updateBlockText(block.id, text);
            markTyping();

            // Auto-grow text card width by whole bricks based on content width.
            // We grow only (no shrinking) to avoid jitter while editing.
            const currentBricks = Number.isFinite(block.widthBricks) ? Math.max(1, Math.floor(block.widthBricks)) : 1;
            // Border thickness on .glass-text-card (~1px each side).
            const extraPx = 2;
            const desiredPx = (node.scrollWidth || 0) + extraPx;
            let desiredBricks = Math.max(1, Math.ceil(desiredPx / brickWidth));

            if (containerSize.width) {
              const maxBricksRight = Math.max(1, Math.floor((containerSize.width - (block.x ?? 0)) / brickWidth));
              desiredBricks = Math.min(desiredBricks, maxBricksRight);
            }

            if (desiredBricks > currentBricks) {
              updateBlock(block.id, { widthBricks: desiredBricks });
            }
          }

          if (slash.open && slash.blockId === block.id && slash.anchorOffset != null) {
            const node = blocksRef.current.get(block.id);
            if (node) {
              const caret = getCaretOffsetInElement(node);
              const text = node.textContent ?? "";
              const raw = text.slice(slash.anchorOffset + 1, Math.max(slash.anchorOffset + 1, caret));
              const filter = raw.match(/^[^\s]*/)?.[0] ?? "";
              setSlash((s) => ({ ...s, filter, selectedIndex: 0 }));
            }
          }
        }}
        onKeyDown={(e) => {
          // Tab key: insert indentation (2 spaces)
          if (e.key === "Tab") {
            e.preventDefault();
            const node = blocksRef.current.get(block.id);
            if (node) {
              const selection = window.getSelection();
              if (selection && selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                const textNode = range.startContainer;
                const offset = range.startOffset;
                
                if (textNode.nodeType === Node.TEXT_NODE) {
                  const text = textNode.textContent || "";
                  const before = text.slice(0, offset);
                  const after = text.slice(offset);
                  const newText = before + "  " + after;
                  
                  textNode.textContent = newText;
                  // Set cursor after inserted spaces
                  const newRange = document.createRange();
                  newRange.setStart(textNode, offset + 2);
                  newRange.collapse(true);
                  selection.removeAllRanges();
                  selection.addRange(newRange);
                  
                  // Update block text and re-apply highlighting
                  updateBlockText(block.id, node.textContent ?? "");
                  if (block.language && block.language !== "plaintext") {
                    requestAnimationFrame(() => {
                      applySyntaxHighlighting(node, block.language, getCaretOffsetInElement, setCaretOffsetInElement);
                    });
                  }
                }
              }
            }
            return;
          }

          // Enter: always insert a real newline (like a normal text editor).
          // Relying on contentEditable's <div>/<br> behavior is inconsistent across browsers and can get
          // normalized away during syntax-highlight/plaintext syncing.
          if (e.key === "Enter" && !(slash.open && slash.blockId === block.id)) {
            e.preventDefault();
            const node = blocksRef.current.get(block.id);
            if (node) {
              const caret = getCaretOffsetInElement(node);
              const next = insertTextAtOffset(node.textContent ?? "", caret, "\n");
              node.textContent = next;
              updateBlockText(block.id, next);
              requestAnimationFrame(() => setCaretOffsetInElement(node, caret + 1));
            }
            markTyping();
            return;
          }

          if (e.key.length === 1 || e.key === "Backspace" || e.key === "Enter" || e.key.startsWith("Arrow")) {
            markTyping();
          }
          if (e.key === "/" && !slash.open) {
            requestAnimationFrame(() => {
              const node = blocksRef.current.get(block.id);
              if (!node) return;
              const caret = getCaretOffsetInElement(node);
              const anchorOffset = Math.max(0, caret - 1);
              setSlash((s) => ({
                ...s,
                open: true,
                filter: "",
                selectedIndex: 0,
                mode: "insert",
                blockId: block.id,
                anchorOffset,
              }));
              const sel = window.getSelection();
              const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
              const rect = range?.getBoundingClientRect?.();
              if (rect) {
                openSlashMenuAt(e.currentTarget, rect);
              } else {
                const containerRect = containerRef.current?.getBoundingClientRect();
                const top = (containerRect?.top ?? 0) + (block.y - (containerRef.current?.scrollTop ?? 0));
                const left = (containerRect?.left ?? 0) + block.x;
                openSlashMenuAt(e.currentTarget, { top, left });
              }
            });
            return;
          }
          if (slash.open && slash.blockId === block.id) {
            if (e.key === "Escape") {
              e.preventDefault();
              closeSlash();
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSlash((s) => ({ ...s, selectedIndex: Math.max(0, s.selectedIndex - 1) }));
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSlash((s) => ({ ...s, selectedIndex: s.selectedIndex + 1 }));
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              document.dispatchEvent(new Event("slash-enter"));
              return;
            }
            if (e.key.length === 1 && /\s/.test(e.key)) {
              closeSlash();
              return;
            }
            if (e.key.length === 1 || e.key === "Backspace") {
              requestAnimationFrame(() => {
                const node = blocksRef.current.get(block.id);
                if (!node) return;
                const caret = getCaretOffsetInElement(node);
                const text = node.textContent ?? "";
                const anchor = slash.anchorOffset ?? 0;
                const raw = text.slice(anchor + 1, Math.max(anchor + 1, caret));
                const filter = raw.match(/^[^\s]*/)?.[0] ?? "";
                setSlash((s) => ({ ...s, filter, selectedIndex: 0 }));
              });
            }
          }
        }}
      />
    </div>
  );
}

/**
 * BrickEditor (anchor-only grid):
 * - The grid is used ONLY to pick anchor positions for blocks.
 * - Click anywhere: snap to nearest brick cell -> create/focus a positioned text block at (x,y).
 * - Text inside a block is normal continuous text (no per-character snapping).
 * - Vertical rhythm: line-height === brickHeight so lines align to grid rows.
 */
const BrickEditor = React.forwardRef(function BrickEditor(/** @type {any} */ props, ref) {
  const {
    value,
    onChange,
    brickWidth = 24,
    brickHeight = 24,
    defaultBlockWidthBricks = 14,
    minHeight = "70vh",
    debugGrid = false,
    className,
    fontSize = 14,
    fontFamily = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"`,
    letterSpacing = "-0.01em",
  } = props || {};
  const containerRef = useRef(null);
  const blocksRef = useRef(new Map()); // id -> element
  const listItemRefs = useRef(new Map()); // `${blockId}:${itemId}` -> element
  const lastEmittedValueRef = useRef(null);
  const typingIdleTimeoutRef = useRef(null);
  const fileInputRef = useRef(null);
  const dragRef = useRef(null); // { id, startClientX, startClientY, originX, originY, widthPx }
  const resizeRef = useRef(null); // { id, mode: 'aspect'|'free', startClientX, startClientY?, originWidthPx, originHeightPx?, aspect? }
  const lastPointerRef = useRef({ x: 0, y: 0 }); // canvas coords (y includes scrollTop)
  const sheetPaginatingRef = useRef(false);
  const aiAnswerPanelRef = useRef(null);
  const aiPanelSizeRef = useRef({ w: 360, h: 140 });
  const aiAnswerTextRef = useRef(null);
  const aiAnswerMeasureRef = useRef(null);
  const lastAiSpreadsheetIdRef = useRef(null);
  const aiThreadByBlockRef = useRef(new Map()); // blockId -> { key: string, messages: [{ role, content }] }
  const aiLastUserLineRef = useRef(new Map()); // blockId -> last processed user line
  const aiAnswerTimersRef = useRef(new Map()); // blockId -> timeout id (debounce)
  const aiInFlightRef = useRef(new Set()); // blockId currently requesting
  const aiQueuedPromptRef = useRef(new Map()); // blockId -> latest pending prompt while in-flight
  const aiBackoffUntilRef = useRef(0); // timestamp (ms) until which we don't schedule new AI calls
  const aiPanelDragRef = useRef(null); // { startX, startY, originLeft, originTop }

  // Multi-select + marquee selection
  const [selectedIds, setSelectedIds] = useState(() => new Set()); // Set<string>
  const selectedIdsRef = useRef(selectedIds);
  useEffect(() => {
    selectedIdsRef.current = selectedIds;
  }, [selectedIds]);
  const [marquee, setMarquee] = useState(null); // { active, pointerId, startX, startY, left, top, width, height } | null
  const marqueeRef = useRef(marquee);
  useEffect(() => {
    marqueeRef.current = marquee;
  }, [marquee]);

  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [blocks, setBlocks] = useState(() => {
    const payloadV2 = normalizeValueToV2(value ?? "", { defaultBlockWidthBricks });
    const list = Array.isArray(payloadV2?.blocks) ? payloadV2.blocks : [];
    return list.map((b) => v2ToInternalBlock(b, defaultBlockWidthBricks));
  });
  const blocksStateRef = useRef(blocks);
  useEffect(() => {
    blocksStateRef.current = blocks;
  }, [blocks]);
  const [activeId, setActiveId] = useState(null);
  const [slash, setSlash] = useState({
    open: false,
    filter: "",
    selectedIndex: 0,
    position: { top: 0, left: 0 },
    blockId: null,
    anchorOffset: null, // character offset where '/' starts
    mode: "insert", // 'insert' | 'transform'
  });
  const [hoverCell, setHoverCell] = useState(null); // { x, y, col, row }
  const [isTyping, setIsTyping] = useState(false);
  const [spreadsheetAutoFocusId, setSpreadsheetAutoFocusId] = useState(null);
  const [trashHover, setTrashHover] = useState(false);
  const [showTrashZone, setShowTrashZone] = useState(false);

  const lineHeight = useMemo(() => `${brickHeight}px`, [brickHeight]);

  const toggleSelectedId = useCallback((id) => {
    const sid = String(id || "");
    if (!sid) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds((prev) => (prev && prev.size ? new Set() : prev));
  }, []);

  const computeBlockRectPx = useCallback((b) => {
    const x = Number.isFinite(b?.x) ? Number(b.x) : 0;
    const y = Number.isFinite(b?.y) ? Number(b.y) : 0;
    const wBricks = Number.isFinite(b?.widthBricks) ? Math.max(1, Math.floor(b.widthBricks)) : (Number.isFinite(b?.width) ? Math.max(1, Math.floor(b.width)) : 1);
    const hBricks = Number.isFinite(b?.heightBricks) ? Math.max(1, Math.floor(b.heightBricks)) : (Number.isFinite(b?.height) ? Math.max(1, Math.floor(b.height)) : 1);
    const w = wBricks * Math.max(1, brickWidth);
    const h = hBricks * Math.max(1, brickHeight);
    return { left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
  }, [brickWidth, brickHeight]);

  const rectsIntersect = useCallback((a, b) => {
    if (!a || !b) return false;
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }, []);

  const selectionBoundsPx = useCallback((ids, list) => {
    const set = ids instanceof Set ? ids : new Set(Array.isArray(ids) ? ids : []);
    const blocksList = Array.isArray(list) ? list : [];
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    let count = 0;
    for (const b of blocksList) {
      if (!b?.id) continue;
      if (!set.has(String(b.id))) continue;
      const r = computeBlockRectPx(b);
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
      count += 1;
    }
    if (!count || !Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }, [computeBlockRectPx]);

  const onBlockPointerDownCapture = useCallback((e, id) => {
    const bid = String(id || "");
    if (!bid) return;
    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      toggleSelectedId(bid);
      return;
    }
    // If there is an existing selection and user clicks a NON-selected block without shift, clear it.
    const sel = selectedIdsRef.current;
    if (sel && sel.size && !sel.has(bid)) {
      clearSelection();
    }
  }, [clearSelection, toggleSelectedId]);

  // Measure container.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setContainerSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Sync external value -> blocks.
  useEffect(() => {
    // If the parent is just echoing back what we emitted, don't re-sync (it resets caret).
    if (value != null && value === lastEmittedValueRef.current) return;
    const payloadV2 = normalizeValueToV2(value ?? "", { defaultBlockWidthBricks });
    const list = Array.isArray(payloadV2?.blocks) ? payloadV2.blocks : [];
    setBlocks(list.map((b) => v2ToInternalBlock(b, defaultBlockWidthBricks)));
  }, [value]);

  const emit = useCallback((nextBlocks) => {
    const out = serializeV2Payload({
      blocks: (nextBlocks || []).map((b) => stripInternalToV2(b)),
      brickWidth,
      brickHeight,
    });
    lastEmittedValueRef.current = out;
    onChange?.(out);
  }, [onChange, brickWidth, brickHeight]);

  // Debounced persistence so typing stays smooth.
  const pendingEmitRef = useRef({ timer: null, latest: null });
  const emitSoon = useCallback((nextBlocks) => {
    pendingEmitRef.current.latest = nextBlocks;
    if (pendingEmitRef.current.timer) clearTimeout(pendingEmitRef.current.timer);
    pendingEmitRef.current.timer = setTimeout(() => {
      const latest = pendingEmitRef.current.latest;
      pendingEmitRef.current.latest = null;
      pendingEmitRef.current.timer = null;
      if (latest) emit(latest);
    }, 250);
  }, [emit]);
  useEffect(() => {
    return () => {
      if (pendingEmitRef.current.timer) clearTimeout(pendingEmitRef.current.timer);
    };
  }, []);

  const groupSelection = useCallback(() => {
    const sel = selectedIdsRef.current;
    if (!sel || sel.size < 2) return;
    const nextGroupId = `group-${makeId()}`;
    setBlocks((prev) => {
      const next = prev.map((b) => (sel.has(String(b.id)) ? applyInternalPatch(b, { groupId: nextGroupId }, defaultBlockWidthBricks) : b));
      emit(next);
      return next;
    });
  }, [defaultBlockWidthBricks, emit]);

  // Ctrl/Cmd+G to group selected blocks.
  useEffect(() => {
    const onKeyDown = (e) => {
      const key = String(e.key || "").toLowerCase();
      const isMod = Boolean(e.ctrlKey || e.metaKey);
      if (!isMod || key !== "g") return;

      // Don't interfere with normal typing / editing.
      const t = e.target;
      if (t instanceof Element) {
        if (t.closest("[contenteditable='true']")) return;
        if (t.closest("input, textarea, select")) return;
        if (t.closest("[data-spreadsheet-root]")) return;
      }

      const sel = selectedIdsRef.current;
      if (!sel || sel.size < 2) return;
      e.preventDefault();
      groupSelection();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [groupSelection]);

  const callAI = useCallback(async (prompt) => {
    let aiModel = "gemini-flash-latest";
    try {
      const settings = JSON.parse(localStorage.getItem("lykinsai_settings") || "{}");
      aiModel = settings.aiModel || "gemini-flash-latest";
    } catch {
      // ignore
    }
    const { API_BASE_URL } = await import("@/lib/api-config");
    const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: aiModel, prompt }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.statusText || "AI request failed");
    }
    const data = await res.json();
    return String(data.response || "").trim();
  }, []);

  const [aiAnswerPanel, setAiAnswerPanel] = useState({
    open: false,
    blockId: null,
    question: "",
    answer: "",
    fullAnswer: "",
    isLoading: false,
    isTyping: false,
    widthBricks: 2,
    maxWidthPx: 520,
    top: 120,
    left: 24,
  });

  const getSavedAnswerEntryFor = useCallback((blockId, questionLine) => {
    const b = blocksStateRef.current.find((bb) => bb.id === blockId) || null;
    const list = Array.isArray(b?.content?.aiAnswers) ? b.content.aiAnswers : [];
    const q = String(questionLine ?? "").trim();
    if (!q) return null;
    const found = list.find((x) => String(x?.q ?? "").trim() === q) || null;
    if (!found) return null;
    return {
      a: String(found?.a ?? ""),
      panel: found?.panel || null,
    };
  }, []);

  const saveAnswerToBlock = useCallback((blockId, questionLine, answerText, panelPos) => {
    const b = blocksStateRef.current.find((bb) => bb.id === blockId) || null;
    if (!b) return;
    const q = String(questionLine ?? "").trim();
    const a = String(answerText ?? "").trim();
    if (!q || !a) return;
    const prev = Array.isArray(b.content?.aiAnswers) ? b.content.aiAnswers : [];
    const panel = panelPos && Number.isFinite(panelPos.left) && Number.isFinite(panelPos.top)
      ? { left: Math.max(0, Math.floor(panelPos.left)), top: Math.max(0, Math.floor(panelPos.top)) }
      : undefined;
    const next = prev
      .filter((x) => String(x?.q ?? "").trim() !== q)
      .concat([{ q, a, ts: Date.now(), panel }]);
    setBlocks((prevBlocks) => {
      const nextBlocks = prevBlocks.map((bb) =>
        bb.id === blockId ? applyInternalPatch(bb, { content: { ...(bb.content || {}), aiAnswers: next } }, defaultBlockWidthBricks) : bb
      );
      emit(nextBlocks);
      return nextBlocks;
    });
  }, [defaultBlockWidthBricks, emit]);

  const openAnswerPanelFor = useCallback((blockId, questionLine, { answer = "", isLoading = false, anchorRect = null, blockRect = null, savedPanel = null } = {}) => {
    // Auto-sized bubble; we use these only as an initial positioning estimate.
    const APPROX_W = 360;
    const APPROX_H = 140;
    const rect = anchorRect;

    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;

    const gap = 12;
    const br = blockRect;

    // Always dock to the RIGHT of the user's text block (smartly clamped to viewport).
    const anchorRight = br?.right != null ? Number(br.right) : (rect?.right != null ? Number(rect.right) : null);
    const anchorTop = br?.top != null ? Number(br.top) : (rect?.top != null ? Number(rect.top) : 120);

    let left = anchorRight != null ? Math.floor(anchorRight + gap) : Math.max(18, Math.floor((vw || 0) - APPROX_W - 18));
    let top = Math.max(40, Math.min(vh - (APPROX_H + 18), Math.floor(anchorTop)));

    // Keep on-screen even when the user is near the right edge.
    const minW = 220;
    if (vw) {
      const maxLeft = Math.max(18, vw - minW - 18);
      left = Math.max(18, Math.min(maxLeft, left));
    }

    const maxWidthPx = Math.max(minW, (vw ? (vw - left - 18) : Math.floor((vw || 0) * 0.85)) || (minW + 160));

    const a = String(answer ?? "");
    const loading = Boolean(isLoading);
    // Start compact; we'll grow/shrink to the rendered text width.
    const widthBricks = 3;
    setAiAnswerPanel({
      open: true,
      blockId,
      question: String(questionLine ?? "").trim(),
      answer: loading ? "" : a,
      fullAnswer: loading ? "" : a,
      isLoading: loading,
      isTyping: false,
      widthBricks,
      maxWidthPx,
      top,
      left,
    });
  }, [brickWidth]);

  const closeAndPersistAnswerPanel = useCallback(() => {
    const toSave = String(aiAnswerPanel?.fullAnswer || aiAnswerPanel?.answer || "").trim();
    if (aiAnswerPanel?.open && aiAnswerPanel.blockId && aiAnswerPanel.question && toSave && !aiAnswerPanel.isLoading) {
      saveAnswerToBlock(aiAnswerPanel.blockId, aiAnswerPanel.question, toSave, { left: aiAnswerPanel.left, top: aiAnswerPanel.top });
    }
    setAiAnswerPanel({ open: false, blockId: null, question: "", answer: "", fullAnswer: "", isLoading: false, isTyping: false, widthBricks: 3, maxWidthPx: 520, top: 120, left: 24 });
  }, [aiAnswerPanel, saveAnswerToBlock]);

  useEffect(() => {
    if (!aiAnswerPanel.open) return;
    const onDown = (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest?.("[data-ai-answer-panel]")) return;
      closeAndPersistAnswerPanel();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [aiAnswerPanel.open, closeAndPersistAnswerPanel]);

  // Measure bubble size for drag clamping + keep it within the viewport while it grows/shrinks.
  useEffect(() => {
    if (!aiAnswerPanel.open) return;
    const measureAndClamp = () => {
      const el = aiAnswerPanelRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const w = Math.max(1, Math.floor(r.width));
      const h = Math.max(1, Math.floor(r.height));
      aiPanelSizeRef.current = { w, h };

      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      const clampedLeft = Math.max(18, Math.min(vw - w - 18, aiAnswerPanel.left));
      const clampedTop = Math.max(40, Math.min(vh - h - 18, aiAnswerPanel.top));
      if (clampedLeft !== aiAnswerPanel.left || clampedTop !== aiAnswerPanel.top) {
        setAiAnswerPanel((s) => (s.open ? { ...s, left: clampedLeft, top: clampedTop } : s));
      }
    };
    const raf = requestAnimationFrame(measureAndClamp);
    window.addEventListener("resize", measureAndClamp);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measureAndClamp);
    };
  }, [aiAnswerPanel.open, aiAnswerPanel.answer, aiAnswerPanel.isLoading, aiAnswerPanel.left, aiAnswerPanel.top]);

  // Sync AI bubble width to *measured* rendered text (grow + shrink).
  useEffect(() => {
    if (!aiAnswerPanel.open) return;
    const el = aiAnswerMeasureRef.current;
    if (!el) return;

    const extraPx = 2; // approximate borders
    // Match the visible bubble padding (left 8px, right 28px for close button clearance).
    const paddingPx = 36;
    const toShow = wrapAfterCharsFinishWord(aiAnswerPanel.isLoading ? "Thinking…" : (aiAnswerPanel.answer || ""), 40);
    el.textContent = toShow;
    const measuredW = Math.max(0, Math.ceil(el.getBoundingClientRect().width || 0));
    const desiredPx = measuredW + paddingPx + extraPx;
    let desiredBricks = Math.max(2, Math.ceil(desiredPx / Math.max(1, brickWidth)));
    const maxWidthPx = Number.isFinite(aiAnswerPanel.maxWidthPx) ? Math.max(220, Math.floor(aiAnswerPanel.maxWidthPx)) : Math.floor((window.innerWidth || 0) * 0.85);
    const maxBricks = Math.max(3, Math.floor(maxWidthPx / Math.max(1, brickWidth)));
    desiredBricks = Math.min(desiredBricks, maxBricks);

    setAiAnswerPanel((s) => {
      if (!s.open) return s;
      const cur = Number.isFinite(s.widthBricks) ? Math.max(1, Math.floor(s.widthBricks)) : 1;
      if (desiredBricks !== cur) return { ...s, widthBricks: desiredBricks };
      return s;
    });
  }, [aiAnswerPanel.open, aiAnswerPanel.isLoading, aiAnswerPanel.answer, aiAnswerPanel.maxWidthPx, brickWidth]);

  // Typewriter effect for AI answers (so they don't pop in instantly).
  useEffect(() => {
    if (!aiAnswerPanel.open) return;
    if (aiAnswerPanel.isLoading) return;
    if (!aiAnswerPanel.isTyping) return;

    const full = String(aiAnswerPanel.fullAnswer || "");
    const cur = String(aiAnswerPanel.answer || "");
    if (!full) {
      setAiAnswerPanel((s) => (s.open ? { ...s, isTyping: false } : s));
      return;
    }
    if (cur.length >= full.length) {
      setAiAnswerPanel((s) => (s.open ? { ...s, answer: s.fullAnswer || s.answer, isTyping: false } : s));
      return;
    }

    const nextChar = full.charAt(cur.length);
    const step = nextChar === "\n" ? 4 : 2;
    const delay = nextChar === "\n" ? 24 : /[.,!?]/.test(nextChar) ? 28 : 16;

    const t = setTimeout(() => {
      setAiAnswerPanel((s) => {
        if (!s.open || s.isLoading || !s.isTyping) return s;
        const full = String(s.fullAnswer || "");
        const cur = String(s.answer || "");
        const nextLen = Math.min(full.length, cur.length + step);
        const next = full.slice(0, nextLen);
        const done = nextLen >= full.length;
        return done ? { ...s, answer: full, isTyping: false } : { ...s, answer: next };
      });
    }, delay);

    return () => clearTimeout(t);
  }, [aiAnswerPanel.open, aiAnswerPanel.isLoading, aiAnswerPanel.isTyping, aiAnswerPanel.answer, aiAnswerPanel.fullAnswer]);

  useEffect(() => {
    const onMove = (e) => {
      const d = aiPanelDragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const nextLeft = d.originLeft + dx;
      const nextTop = d.originTop + dy;
      const w = aiPanelSizeRef.current?.w ?? 360;
      const h = aiPanelSizeRef.current?.h ?? 140;
      const clampedLeft = Math.max(18, Math.min((window.innerWidth || 0) - w - 18, nextLeft));
      const clampedTop = Math.max(40, Math.min((window.innerHeight || 0) - h - 18, nextTop));
      setAiAnswerPanel((s) => (s.open ? { ...s, left: clampedLeft, top: clampedTop } : s));
    };
    const onUp = () => {
      aiPanelDragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const snapX = useCallback((clientX) => {
    const el = containerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    const col = Math.max(0, Math.floor(x / Math.max(1, brickWidth)));
    return col * brickWidth;
  }, [brickWidth]);

  const snapY = useCallback((clientY) => {
    const el = containerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const y = clientY - rect.top + el.scrollTop;
    const row = Math.max(0, Math.floor(y / Math.max(1, brickHeight)));
    return row * brickHeight;
  }, [brickHeight]);

  const colFromClientX = useCallback((clientX) => {
    const el = containerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    return Math.max(0, Math.floor(x / Math.max(1, brickWidth)));
  }, [brickWidth]);

  const rowFromClientY = useCallback((clientY) => {
    const el = containerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const y = clientY - rect.top + el.scrollTop;
    return Math.max(0, Math.floor(y / Math.max(1, brickHeight)));
  }, [brickHeight]);

  const focusListItem = useCallback((blockId, itemId, { caretToStart = false, caretToEnd = false } = {}) => {
    requestAnimationFrame(() => {
      const el = listItemRefs.current.get(`${blockId}:${itemId}`);
      if (!el) return;
      el.focus?.({ preventScroll: true });
      if (caretToStart) placeCaretAtStart(el);
      if (caretToEnd) setCaretOffsetInElement(el, (el.textContent ?? "").length);
    });
  }, []);

  const focusBlock = useCallback((id, { caretToStart = false, caretToEnd = false } = {}) => {
    setActiveId(id);
    requestAnimationFrame(() => {
      const block = blocksStateRef.current.find((b) => b.id === id) || null;
      if (block?.kind === "list") {
        const first = Array.isArray(block.items) && block.items.length ? block.items[0] : null;
        if (first?.id) {
          focusListItem(id, first.id, { caretToStart: true });
          return;
        }
      }
      const node = blocksRef.current.get(id);
      // Don't force selection/caret placement here; let the browser keep it stable.
      node?.focus?.({ preventScroll: true });
      if (caretToStart) placeCaretAtStart(node);
      if (caretToEnd) setCaretOffsetInElement(node, (node?.textContent ?? "").length);
    });
  }, [focusListItem]);

  const createBlockAt = useCallback((x, y) => {
    const id = makeId();
    // Start as a single brick; the block grows by whole bricks as the user types.
    const widthBricks = 1;
    setBlocks((prev) => {
      const next = [
        ...prev,
        v2ToInternalBlock(
          {
            id,
            type: "TextBlock",
            x,
            y,
            width: widthBricks,
            height: 1,
            content: { text: "" },
            style: { format: "p" },
          },
          defaultBlockWidthBricks
        ),
      ];
      emit(next);
      return next;
    });
    focusBlock(id, { caretToStart: true });
  }, [defaultBlockWidthBricks, emit, focusBlock]);

  const updateBlockText = useCallback((id, text) => {
    setBlocks((prev) => {
      const next = prev.map((b) => (b.id === id ? applyInternalPatch(b, { text }, defaultBlockWidthBricks) : b));
      emitSoon(next);
      return next;
    });
  }, [defaultBlockWidthBricks, emitSoon]);

  const updateBlock = useCallback((id, patch) => {
    setBlocks((prev) => {
      const next = prev.map((b) => (b.id === id ? applyInternalPatch(b, patch, defaultBlockWidthBricks) : b));
      emitSoon(next);
      return next;
    });
  }, [defaultBlockWidthBricks, emitSoon]);

  const computeListHeightBricks = useCallback((items) => {
    const list = Array.isArray(items) ? items : [];
    // Each item is at least one row; multi-line items expand by their line count.
    const rows = list.reduce((sum, it) => {
      const t = String(it?.text ?? "");
      const lines = t.split("\n").length || 1;
      return sum + Math.max(1, lines);
    }, 0);
    // Add a tiny top/bottom padding row.
    return Math.max(1, rows + 1);
  }, []);

  const updateListBlock = useCallback((id, updater) => {
    setBlocks((prev) => {
      const next = prev.map((b) => {
        if (b.id !== id) return b;
        if ((b.kind || "text") !== "list") return b;
        const currentItems = Array.isArray(b.items) ? b.items : [];
        const updatedItems = updater(currentItems, b.listType || "bulleted");
        const heightBricks = computeListHeightBricks(updatedItems);
        return applyInternalPatch(
          b,
          { type: "ListBlock", listType: b.listType || "bulleted", items: updatedItems, heightBricks },
          defaultBlockWidthBricks
        );
      });
      emitSoon(next);
      return next;
    });
  }, [computeListHeightBricks, defaultBlockWidthBricks, emitSoon]);

  const snapPos = useCallback((x, y) => {
    return {
      x: Math.max(0, Math.floor(x / brickWidth) * brickWidth),
      y: Math.max(0, Math.floor(y / brickHeight) * brickHeight),
    };
  }, [brickWidth, brickHeight]);

  const removeBlock = useCallback((id) => {
    setBlocks((prev) => {
      const next = prev.filter((b) => b.id !== id);
      emit(next);
      return next;
    });
    if (activeId === id) setActiveId(null);
  }, [activeId, emit]);

  const readFileAsDataUrl = useCallback((file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });
  }, []);

  const getDefaultInsertPoint = useCallback(() => {
    const el = containerRef.current;
    const scrollTop = el?.scrollTop ?? 0;
    const anchor = blocks.find((b) => b.id === activeId) || null;
    const x = anchor?.x ?? lastPointerRef.current.x ?? 0;
    const y = (anchor?.y ?? scrollTop) + brickHeight;
    return snapPos(x, y);
  }, [activeId, blocks, brickHeight, snapPos]);

  // Extract text and images from PDF using PDF.js
  const extractTextFromPDF = useCallback(async (file) => {
    try {
      console.log('📄 Starting PDF text extraction for:', file.name);
      
      // Dynamically import pdfjs-dist
      let pdfjsLib;
      try {
        pdfjsLib = await import('pdfjs-dist');
        console.log('✅ PDF.js library loaded successfully');
      } catch (importError) {
        console.error('❌ Failed to import pdfjs-dist:', importError);
        throw new Error(`PDF.js library not available: ${importError.message}`);
      }
      
      // Set worker source - use the installed version
      if (typeof window !== 'undefined') {
        try {
          // Get the actual version from the imported library
          const version = pdfjsLib.version || '5.4.449';
          console.log(`📄 PDF.js version detected: ${version}`);
          
          // Try multiple CDN options in order of preference
          const workerUrls = [
            `https://unpkg.com/pdfjs-dist@${version}/build/pdf.worker.min.mjs`,
            `https://unpkg.com/pdfjs-dist@${version}/build/pdf.worker.min.js`,
            `https://cdn.jsdelivr.net/npm/pdfjs-dist@${version}/build/pdf.worker.min.js`,
            `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${version}/pdf.worker.min.js`
          ];
          
          // Set worker source - use first available
          pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrls[0];
          console.log(`📄 PDF.js worker source set to: ${workerUrls[0]}`);
        } catch (workerError) {
          console.warn('⚠️ Could not set PDF.js worker source:', workerError);
          // Try a generic fallback
          pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@5.4.449/build/pdf.worker.min.mjs';
          console.log('📄 Using fallback worker URL');
        }
      }
      
      const arrayBuffer = await file.arrayBuffer();
      console.log(`📄 PDF file loaded: ${arrayBuffer.byteLength} bytes`);
      
      // Load PDF document with error handling
      let pdf;
      try {
        const loadingTask = pdfjsLib.getDocument({ 
          data: arrayBuffer,
          verbosity: 0,
          // Add error recovery options
          stopAtErrors: false,
          maxImageSize: 1024 * 1024 * 10, // 10MB max image size
        });
        pdf = await loadingTask.promise;
      } catch (loadError) {
        console.error('❌ Failed to load PDF document:', loadError);
        throw new Error(`Failed to load PDF: ${loadError.message}`);
      }
      
      console.log(`📄 PDF loaded successfully: ${pdf.numPages} pages`);
      
      let fullText = '';
      const extractedImages = [];
      const maxPages = Math.min(pdf.numPages, 100); // Extract up to 100 pages
      
      // Extract text and images from each page
      for (let i = 1; i <= maxPages; i++) {
        try {
          const page = await pdf.getPage(i);
          
          // Extract text content with positioning to preserve layout
          try {
            const textContent = await page.getTextContent();
            const viewport = page.getViewport({ scale: 1.0 });
            
            // Improved text extraction - preserve layout using coordinates
            let pageText = '';
            
            if (textContent && textContent.items && Array.isArray(textContent.items)) {
              // Extract text items with their positions
              const textItems = [];
              
              textContent.items.forEach((item) => {
                if (!item) return;
                
                let itemText = '';
                
                // Check for 'str' property (TextItem) - this is the standard PDF.js structure
                if (item && typeof item === 'object') {
                  // Use bracket notation to safely access properties
                  if ('str' in item) {
                    const strValue = item['str'];
                    if (strValue !== undefined && strValue !== null) {
                      itemText = String(strValue);
                    }
                  }
                  
                  // Try other possible property names (fallback for different PDF structures)
                  if (!itemText && 'text' in item) {
                    const textValue = item['text'];
                    if (textValue !== undefined && textValue !== null) {
                      itemText = String(textValue);
                    }
                  }
                  
                  if (!itemText && 'textContent' in item) {
                    const textContentValue = item['textContent'];
                    if (textContentValue !== undefined && textContentValue !== null) {
                      itemText = String(textContentValue);
                    }
                  }
                  
                  // Get position from transform matrix if available
                  if (itemText && 'transform' in item && Array.isArray(item['transform']) && item['transform'].length >= 6) {
                    const transform = item['transform'];
                    // Transform matrix: [a, b, c, d, e, f] where e=x, f=y
                    const x = transform[4] || 0;
                    const y = transform[5] || 0;
                    const width = item['width'] || 0;
                    const height = item['height'] || 0;
                    
                    textItems.push({
                      text: itemText,
                      x: x,
                      y: y,
                      width: width,
                      height: height,
                      fontSize: item['fontSize'] || 12
                    });
                  } else if (itemText) {
                    // Fallback: no position info, just add text
                    textItems.push({
                      text: itemText,
                      x: 0,
                      y: 0,
                      width: 0,
                      height: 0,
                      fontSize: 12
                    });
                  }
                } else if (typeof item === 'string') {
                  textItems.push({
                    text: item,
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                    fontSize: 12
                  });
                }
              });
              
              // Get viewport to understand coordinate system
              const viewportHeight = viewport.height;
              
              // Sort items by Y coordinate (top to bottom), then by X (left to right)
              // PDF coordinates are bottom-up, so we need to invert Y
              textItems.forEach(item => {
                // Convert PDF coordinates (bottom-up) to top-down
                item.yNormalized = viewportHeight - item.y;
              });
              
              textItems.sort((a, b) => {
                // Group items that are on the same line (within 3px tolerance for font size differences)
                const yDiff = Math.abs(a.yNormalized - b.yNormalized);
                if (yDiff < 3) {
                  // Same line, sort by X (left to right)
                  return a.x - b.x;
                }
                // Different lines, sort by Y (top to bottom - higher Y = higher on page)
                return b.yNormalized - a.yNormalized;
              });
              
              // Build text with proper line breaks and spacing
              let currentLine = [];
              let currentY = null;
              let lastX = 0;
              const lineTolerance = 3; // Pixels - accounts for slight font size differences
              
              textItems.forEach((item) => {
                // Check if this is a new line
                if (currentY === null || Math.abs(item.yNormalized - currentY) > lineTolerance) {
                  // Start a new line
                  if (currentLine.length > 0) {
                    // Join current line
                    pageText += currentLine.join('') + '\n';
                    currentLine = [];
                  }
                  currentY = item.yNormalized;
                  lastX = 0;
                }
                
                // Calculate spacing based on X position
                // If there's a gap, add spaces proportional to the gap
                if (item.x > lastX + 2) {
                  // Calculate approximate number of spaces needed
                  // Assume average character width is about 6-8px
                  const gap = item.x - lastX;
                  const spacesNeeded = Math.max(1, Math.floor(gap / 6));
                  if (spacesNeeded > 1) {
                    currentLine.push(' '.repeat(Math.min(spacesNeeded, 10))); // Cap at 10 spaces
                  } else {
                    currentLine.push(' ');
                  }
                } else if (currentLine.length > 0 && item.x < lastX) {
                  // Overlapping or very close - just add a space
                  currentLine.push(' ');
                }
                
                // Add text to current line
                currentLine.push(item.text);
                lastX = item.x + (item.width || 0);
              });
              
              // Add the last line
              if (currentLine.length > 0) {
                pageText += currentLine.join('');
              }
              
              // If we got text, log it for debugging
              if (pageText.trim() && textContent.items.length > 0) {
                console.log(`   Extracted ${textItems.length} positioned text items from ${textContent.items.length} total items`);
              }
            }
            
            // Log what we found for debugging
            if (pageText.trim()) {
              fullText += `\n\n--- Page ${i} ---\n\n${pageText.trim()}`;
              console.log(`📄 Page ${i}: Extracted ${pageText.length} characters`);
            } else {
              console.warn(`⚠️ Page ${i}: No text found (might be image-only or empty)`);
              // Log the structure for debugging
              if (textContent && textContent.items) {
                console.log(`   Items array length: ${textContent.items.length}`);
                if (textContent.items.length > 0) {
                  console.log(`   First item type:`, typeof textContent.items[0]);
                  console.log(`   First item keys:`, Object.keys(textContent.items[0] || {}));
                  // Try to log the actual structure
                  console.log(`   First item sample:`, JSON.stringify(textContent.items[0]).substring(0, 200));
                }
              }
            }
          } catch (textError) {
            console.warn(`⚠️ Error extracting text from page ${i}:`, textError);
            console.warn('Error details:', {
              message: textError.message,
              name: textError.name,
              stack: textError.stack
            });
          }
          
          // Extract images from page (optional - more complex, may not work for all PDFs)
          // Note: Image extraction from PDFs is complex and may not work for all PDF types
          // For now, we focus on text extraction which is more reliable
          // Images can be extracted later if needed using canvas rendering
          
          // Log progress for large PDFs
          if (i % 10 === 0) {
            console.log(`📄 Extracted text from ${i}/${maxPages} pages...`);
          }
        } catch (pageError) {
          console.warn(`⚠️ Error processing page ${i}:`, pageError);
          // Continue with other pages even if one fails
        }
      }
      
      if (pdf.numPages > maxPages) {
        fullText += `\n\n[Note: Document has ${pdf.numPages} total pages. Text from first ${maxPages} pages extracted.]`;
        console.log(`📄 PDF has ${pdf.numPages} pages, extracted first ${maxPages}`);
      }
      
      const extractedLength = fullText.trim().length;
      console.log(`✅ PDF extraction complete: ${extractedLength} characters of text from ${maxPages} pages`);
      
      if (extractedLength === 0) {
        console.warn('⚠️ No text found in PDF. This might be a scanned/image-only PDF.');
        console.warn('💡 Tip: For scanned PDFs, consider using OCR tools to extract text first.');
        // Return null to indicate extraction failed
        return null;
      }
      
      // Return text result - always return an object with text property
      const result = {
        text: fullText.trim(),
        images: [] // Image extraction can be implemented later if needed
      };
      
      console.log(`📄 Returning extracted text: ${result.text.length} characters`);
      return result;
    } catch (error) {
      console.error('❌ Error extracting PDF:', error);
      console.error('Error details:', {
        message: error.message,
        stack: error.stack,
        fileName: file.name,
        fileSize: file.size
      });
      return null;
    }
  }, []);

  const insertFiles = useCallback(async (files, atPoint) => {
    const list = Array.from(files || []).filter(Boolean);
    if (list.length === 0) return;

    const base = atPoint ? snapPos(atPoint.x ?? 0, atPoint.y ?? 0) : getDefaultInsertPoint();
    let cursorY = base.y;
    const created = [];

    for (const file of list) {
      const name = file.name || "file";
      const mime = file.type || "";
      const lower = name.toLowerCase();
      const ext = lower.includes(".") ? lower.split(".").pop() : "";

      // Handle PDFs specially - convert to editable text blocks
      if (mime === "application/pdf" || ext === "pdf") {
        console.log(`📄 Processing PDF: ${name} (${(file.size / 1024).toFixed(2)} KB)`);
        
        let extractionResult = null;
        try {
          extractionResult = await extractTextFromPDF(file);
          console.log(`📄 Extraction result:`, extractionResult ? `Success (${extractionResult.text?.length || 0} chars)` : 'Failed/No text');
        } catch (error) {
          console.error('❌ Error extracting PDF:', error);
          console.error('Error stack:', error.stack);
          extractionResult = null;
        }
        
        // Only create text block if we successfully extracted text
        if (extractionResult && extractionResult.text && extractionResult.text.trim().length > 0) {
          console.log(`✅ PDF text extracted successfully: ${extractionResult.text.length} characters. Creating editable text block.`);
          
          // Create a text block with the PDF content
          const id = makeId();
          const pdfHeader = `# ${name}\n\n`;
          let fullText = pdfHeader + extractionResult.text.trim();
          
          // Add image placeholders if images were extracted
          if (extractionResult.images && extractionResult.images.length > 0) {
            fullText += `\n\n**Images from PDF (${extractionResult.images.length} found):**\n`;
            extractionResult.images.forEach((img, idx) => {
              fullText += `\n![Image from page ${img.page}](image-${idx})\n`;
            });
          }
          
          // Estimate width based on text content
          const estimatedWidth = Math.min(Math.max(estimateTextWidthPx(fullText, "system-ui", 16), brickWidth * 8), brickWidth * 28);
          const widthBricks = Math.max(8, Math.round(estimatedWidth / brickWidth));
          
          // Estimate height based on text length (rough approximation)
          const lines = fullText.split('\n').length;
          const estimatedHeight = Math.max(brickHeight * 4, lines * brickHeight);
          const heightBricks = Math.max(4, Math.round(estimatedHeight / brickHeight));
          
          created.push(
            v2ToInternalBlock(
              {
                id,
                type: "TextBlock",
                x: base.x,
                y: cursorY,
                width: widthBricks,
                height: heightBricks,
                content: { text: fullText },
                style: { format: "p" },
              },
              defaultBlockWidthBricks
            )
          );
          
          // If images were extracted, create image blocks for them
          if (extractionResult.images && extractionResult.images.length > 0) {
            for (let imgIdx = 0; imgIdx < extractionResult.images.length; imgIdx++) {
              const img = extractionResult.images[imgIdx];
              const imgId = makeId();
              const imgWidthBricks = Math.max(6, Math.min(20, Math.round((img.width || 400) / brickWidth)));
              const imgHeightBricks = Math.max(4, Math.round((img.height || 300) / brickHeight));
              
              cursorY += heightBricks * brickHeight + brickHeight;
              
              created.push(
                v2ToInternalBlock(
                  {
                    id: imgId,
                    type: "MediaBlock",
                    x: base.x,
                    y: cursorY,
                    width: imgWidthBricks,
                    height: imgHeightBricks,
                    content: {
                      mediaType: "image",
                      media: {
                        src: img.dataUrl,
                        name: `Image from ${name} (Page ${img.page})`,
                        mime: "image/png",
                        aspect: (img.width || 400) / (img.height || 300),
                      },
                    },
                    style: {},
                  },
                  defaultBlockWidthBricks
                )
              );
              
              cursorY += imgHeightBricks * brickHeight + brickHeight;
            }
          } else {
            cursorY += heightBricks * brickHeight + brickHeight;
          }
          
          console.log(`✅ Created editable text block for PDF: ${name}`);
          continue; // Skip to next file - don't create PDF viewer block
        } else {
          console.warn(`⚠️ PDF text extraction failed or returned no text. This PDF might be image-only, scanned, or corrupted.`);
          console.warn(`   Will create PDF viewer block instead so user can still view the PDF.`);
          // Fall through to create PDF viewer block if extraction failed
        }
      }

      // Handle non-PDF files or PDFs that couldn't be extracted
      let kind = "file";
      if (mime.startsWith("image/")) kind = "image";
      else if (mime.startsWith("video/")) kind = "video";
      else if (mime.startsWith("audio/")) kind = "audio";
      else if (mime === "application/pdf" || ext === "pdf") kind = "pdf";

      // Persistable data URL (stored in the brick JSON, survives reloads).
      // eslint-disable-next-line no-await-in-loop
      const dataUrl = await readFileAsDataUrl(file);

      const id = makeId();
      const widthBricks = Math.max(6, Math.min(28, defaultBlockWidthBricks));
      const wPx = widthBricks * brickWidth;
      const aspect = kind === "pdf" ? 1.0 : kind === "audio" ? 4.0 : 16 / 9;
      const hPx = Math.max(brickHeight * 4, Math.round((wPx / aspect) / brickHeight) * brickHeight);
      const heightBricks = Math.max(3, Math.round(hPx / brickHeight));

      created.push(
        v2ToInternalBlock(
          {
            id,
            type: "MediaBlock",
            x: base.x,
            y: cursorY,
            width: widthBricks,
            height: heightBricks,
            content: { mediaType: kind, media: { src: dataUrl, name, mime, aspect, zoom: kind === "pdf" ? 125 : undefined } },
            style: {},
          },
          defaultBlockWidthBricks
        )
      );

      cursorY += heightBricks * brickHeight + brickHeight;
    }

    // Log what we're creating
    if (created.length > 0) {
      console.log(`✅ Creating ${created.length} block(s):`, created.map(b => ({ kind: b.kind, id: b.id, hasText: !!b.text })));
    }
    
    setBlocks((prev) => {
      const next = [...prev, ...created];
      emit(next);
      return next;
    });
  }, [brickHeight, brickWidth, defaultBlockWidthBricks, emit, extractTextFromPDF, getDefaultInsertPoint, readFileAsDataUrl, snapPos]);

  const insertUrl = useCallback((url, atPoint) => {
    const u = (url || "").trim();
    if (!u) return;
    const base = atPoint ? snapPos(atPoint.x ?? 0, atPoint.y ?? 0) : getDefaultInsertPoint();
    if (isYouTubeUrl(u)) {
      const videoId = extractYouTubeVideoId(u);
      if (!videoId) return;
      const id = makeId();
      const widthBricks = Math.max(10, Math.min(28, defaultBlockWidthBricks));
      const wPx = widthBricks * brickWidth;
      const hPx = (wPx * 9) / 16;
      const heightBricks = Math.max(4, Math.round(hPx / brickHeight));
      setBlocks((prev) => {
        const next = [
          ...prev,
          v2ToInternalBlock(
            {
              id,
              type: "MediaBlock",
              x: base.x,
              y: base.y,
              width: widthBricks,
              height: heightBricks,
              content: { mediaType: "youtube", media: { url: u, videoId, aspect: 16 / 9 } },
              style: {},
            },
            defaultBlockWidthBricks
          ),
        ];
        emit(next);
        return next;
      });
      return;
    }
    const id = makeId();
    const widthBricks = Math.max(8, Math.min(28, defaultBlockWidthBricks));
    const heightBricks = 4;
    setBlocks((prev) => {
      const next = [
        ...prev,
        v2ToInternalBlock(
          {
            id,
            type: "MediaBlock",
            x: base.x,
            y: base.y,
            width: widthBricks,
            height: heightBricks,
            content: { mediaType: "link", media: { url: u, name: u } },
            style: {},
          },
          defaultBlockWidthBricks
        ),
      ];
      emit(next);
      return next;
    });
  }, [brickHeight, brickWidth, defaultBlockWidthBricks, emit, getDefaultInsertPoint, snapPos]);

  useImperativeHandle(ref, () => ({ insertFiles, insertUrl }), [insertFiles, insertUrl]);

  const setBlockFormat = useCallback((id, format) => {
    setBlocks((prev) => {
      const next = prev.map((b) => {
        if (b.id !== id) return b;
        if ((b.kind || "text") !== "text") return b;
        const normalized = normalizeListText(b.text ?? "", format);
        return applyInternalPatch(b, { format, text: normalized }, defaultBlockWidthBricks);
      });
      emit(next);
      return next;
    });
  }, [defaultBlockWidthBricks, emit]);

  const addDividerBelow = useCallback((anchorBlock) => {
    const id = makeId();
    const x = anchorBlock?.x ?? 0;
    const y = (anchorBlock?.y ?? 0) + brickHeight;
    const next = [
      ...blocks,
      v2ToInternalBlock(
        {
          id,
          type: "DividerBlock",
          x,
          y,
          width: anchorBlock?.widthBricks ?? defaultBlockWidthBricks,
          height: 1,
          content: {},
          style: {},
        },
        defaultBlockWidthBricks
      ),
    ];
    setBlocks(next);
    emit(next);
  }, [blocks, brickHeight, defaultBlockWidthBricks, emit]);

  const startImageInsert = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleMediaSelected = useCallback((e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    insertFiles(files);
    e.target.value = "";
  }, [insertFiles]);

  const handleDrop = useCallback(async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top + el.scrollTop;
    const snapped = snapPos(x, y);

    // Snapshot dataTransfer now (React events may be pooled in older versions)
    const dt = e.dataTransfer;

    const uri = dt?.getData?.("text/uri-list") || "";
    const text = dt?.getData?.("text/plain") || "";
    const candidate = (uri || text || "").trim();

    // Folder support (webkitGetAsEntry), plus normal file drops
    const getFilesFromDirectory = async (directoryEntry) => {
      const files = [];
      const reader = directoryEntry.createReader();
      const readEntries = async () => {
        return new Promise((resolve, reject) => {
          reader.readEntries(async (entries) => {
            if (!entries || entries.length === 0) {
              resolve(files);
              return;
            }
            for (const entry of entries) {
              if (entry.isFile) {
                const file = await new Promise((res, rej) => entry.file(res, rej));
                files.push(file);
              } else if (entry.isDirectory) {
                const subFiles = await getFilesFromDirectory(entry);
                files.push(...subFiles);
              }
            }
            const more = await readEntries();
            resolve([...files, ...more]);
          }, reject);
        });
      };
      return readEntries();
    };

    const getAllFilesFromDataTransfer = async (dataTransfer) => {
      const out = [];
      const items = Array.from(dataTransfer?.items || []);
      for (const item of items) {
        if (item.kind !== "file") continue;
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry && entry.isDirectory) {
          const folderFiles = await getFilesFromDirectory(entry);
          out.push(...folderFiles);
        } else {
          const file = item.getAsFile();
          if (file) out.push(file);
        }
      }
      if (out.length === 0 && dataTransfer?.files?.length) return Array.from(dataTransfer.files);
      return out;
    };

    const files = dt ? await getAllFilesFromDataTransfer(dt) : [];
    if (files.length > 0) {
      await insertFiles(files, snapped);
      return;
    }

    if (candidate) {
      insertUrl(candidate, snapped);
    }
  }, [insertFiles, insertUrl, snapPos]);

  useEffect(() => {
    const onMove = (e) => {
      if (dragRef.current) {
        const d = dragRef.current;
        const { id, startClientX, startClientY } = d;
        const dx = e.clientX - startClientX;
        const dy = e.clientY - startClientY;
        const originX = d.originX ?? 0;
        const originY = d.originY ?? 0;
        const snappedDragged = snapPos(originX + dx, originY + dy);

        // Right-edge "trash" zone (delete on drop).
        const containerRect = containerRef.current?.getBoundingClientRect?.();
        if (containerRect) {
          const zoneW = 56;
          const inTrash =
            e.clientX >= containerRect.right - zoneW &&
            e.clientX <= containerRect.right &&
            e.clientY >= containerRect.top &&
            e.clientY <= containerRect.bottom;
          setTrashHover(inTrash);
          dragRef.current.lastClient = { x: e.clientX, y: e.clientY };
          dragRef.current.inTrash = inTrash;
        }

        // Clamp to the visible editor width so moving to the far right doesn't push past the edge.
        // Keep snapping to bricks.
        let nextX = snappedDragged.x;
        const widthPxDragged = d.widthPx;
        if (containerSize.width && widthPxDragged) {
          const maxX = Math.max(0, containerSize.width - widthPxDragged);
          // Use ceil here so we don't artificially create a "wall" up to (brickWidth - 1) px inside the viewport.
          // This still keeps X aligned to bricks, but lets the right edge get as close as possible.
          const maxXSnapped = Math.max(0, Math.ceil(maxX / brickWidth) * brickWidth);
          const clamped = Math.min(nextX, maxXSnapped);
          // Show the right-edge delete zone only when the user "hits the wall" while dragging right.
          const hitRightWall = dx > 0 && (nextX > maxXSnapped || clamped === maxXSnapped);
          setShowTrashZone(hitRightWall);
          nextX = clamped;
        } else {
          setShowTrashZone(false);
        }

        // Grouped drag: if this block has a groupId, move all blocks in that group together.
        if (!d.groupSnapshot) {
          const dragged = blocksStateRef.current.find((b) => b.id === id) || null;
          const groupId = dragged?.groupId || null;
          if (!d.groupSnapshot && groupId) {
            const members = blocksStateRef.current.filter((b) => b.groupId === groupId);
            d.groupSnapshot = members.map((m) => ({
              id: m.id,
              originX: m.x ?? 0,
              originY: m.y ?? 0,
              widthPx: (Number.isFinite(m.widthBricks) ? Math.max(1, Math.floor(m.widthBricks)) : 1) * brickWidth,
            }));
          } else if (!d.groupSnapshot) {
            d.groupSnapshot = [{ id, originX, originY, widthPx: widthPxDragged }];
          }
        }

        const group = d.groupSnapshot || [{ id, originX, originY, widthPx: widthPxDragged }];
        setBlocks((prev) => {
          const byId = new Map(group.map((g) => [g.id, g]));
          return prev.map((b) => {
            const g = byId.get(b.id);
            if (!g) return b;
            const snapped = snapPos(g.originX + dx, g.originY + dy);
            let gx = snapped.x;
            if (containerSize.width && g.widthPx) {
              const maxX = Math.max(0, containerSize.width - g.widthPx);
              const maxXSnapped = Math.max(0, Math.ceil(maxX / brickWidth) * brickWidth);
              gx = Math.min(gx, maxXSnapped);
            }
            return applyInternalPatch(b, { x: gx, y: snapped.y }, defaultBlockWidthBricks);
          });
        });
        return;
      }
      if (resizeRef.current) {
        const r = resizeRef.current;
        const dx = e.clientX - (r.startClientX ?? 0);
        const dy = e.clientY - (r.startClientY ?? 0);

        const maxViewport = Math.max(brickWidth * 6, containerSize.width || 0);
        const newWidthPx = Math.min(maxViewport || Number.MAX_SAFE_INTEGER, Math.max(brickWidth * 6, (r.originWidthPx ?? 0) + dx));
        const widthBricks = Math.max(2, Math.round(newWidthPx / brickWidth));

        const current = blocksStateRef.current.find((b) => b.id === r.id) || null;
        const isSpreadsheet = (current?.kind || "text") === "spreadsheet";
        const isSheet = (current?.kind || "text") === "sheet";
        if (isSheet) return;

        if ((r.mode || "aspect") === "height") {
          const newHeightPx = Math.max(brickHeight * 6, (r.originHeightPx ?? brickHeight * 6) + dy);
          const heightBricks = Math.max(2, Math.round(newHeightPx / brickHeight));
          if (isSpreadsheet) {
            const nextRows = Math.max(1, heightBricks - 1);
            updateBlock(r.id, { heightBricks, sheet: { ...(current?.sheet || {}), rows: nextRows } });
          } else {
            updateBlock(r.id, { heightBricks });
          }
          return;
        }

        if ((r.mode || "aspect") === "free") {
          const newHeightPx = Math.max(brickHeight * 6, (r.originHeightPx ?? brickHeight * 6) + dy);
          const heightBricks = Math.max(2, Math.round(newHeightPx / brickHeight));
          if (isSpreadsheet) {
            const nextRows = Math.max(1, heightBricks - 1);
            updateBlock(r.id, { widthBricks, heightBricks, sheet: { ...(current?.sheet || {}), rows: nextRows } });
          } else {
            updateBlock(r.id, { widthBricks, heightBricks });
          }
          return;
        }

        const aspect = r.aspect || 16 / 9;
        const wPx = widthBricks * brickWidth;
        const hPx = wPx / aspect;
        const heightBricks = Math.max(2, Math.round(hPx / brickHeight));
        updateBlock(r.id, { widthBricks, heightBricks });
      }
    };
    const onUp = () => {
      // If dropped in trash zone, delete the block.
      if (dragRef.current?.inTrash && dragRef.current?.id) {
        const d = dragRef.current;
        const id = d.id;
        const ids = Array.isArray(d.groupSnapshot) ? d.groupSnapshot.map((g) => g.id) : [id];
        dragRef.current = null;
        setTrashHover(false);
        setShowTrashZone(false);
        setBlocks((prev) => {
          const next = prev.filter((b) => !ids.includes(b.id));
          emit(next);
          return next;
        });
        return;
      }
      dragRef.current = null;
      resizeRef.current = null;
      setTrashHover(false);
      setShowTrashZone(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [brickHeight, brickWidth, snapPos, containerSize.width, removeBlock, emit, setBlocks, defaultBlockWidthBricks]);

  // Persist changes on a small debounce (avoids caret issues and reduces churn).
  useEffect(() => {
    const t = setTimeout(() => emit(blocks), 250);
    return () => clearTimeout(t);
  }, [blocks, emit]);

  // Lists are now first-class ListBlocks (no inline marker rendering inside TextBlock).
  // Ensure list blocks always have at least one item.
  useEffect(() => {
    setBlocks((prev) => {
      let changed = false;
      const next = prev.map((b) => {
        if ((b.kind || "text") !== "list") return b;
        const items = Array.isArray(b.items) ? b.items : [];
        if (items.length > 0) return b;
        changed = true;
        const listType = b.listType || "bulleted";
        const first = makeListItem(listType, "");
        const heightBricks = computeListHeightBricks([first]);
        return applyInternalPatch(b, { type: "ListBlock", listType, items: [first], heightBricks }, defaultBlockWidthBricks);
      });
      return changed ? next : prev;
    });
  }, [computeListHeightBricks, defaultBlockWidthBricks]);

  const getBlockWidth = useCallback((block) => {
    const x = block.x ?? 0;
    // Use as much of the viewport width as possible (minimize invisible side "walls").
    const remaining = Math.max(brickWidth, containerSize.width - x);
    const kind = block.kind || "text";

    // Text & list blocks: width is explicitly controlled in bricks (auto-grows as you type / user resizes).
    if (kind === "text" || kind === "list") {
      const bricks = Number.isFinite(block.widthBricks) ? Math.max(1, Math.floor(block.widthBricks)) : 1;
      return Math.min(remaining, bricks * brickWidth);
    }

    const bricks =
      (Number.isFinite(block.widthBricks) ? Math.max(1, Math.floor(block.widthBricks)) : defaultBlockWidthBricks);
    // Sheet blocks: behave like a "page" (fixed width independent of X), but cap to viewport.
    if (kind === "sheet") {
      const maxViewport = Math.max(brickWidth, containerSize.width || bricks * brickWidth);
      return Math.min(maxViewport, bricks * brickWidth);
    }
    // Media blocks should NEVER shrink just because they are moved to the right.
    // They keep a fixed width independent of X. Also cap to the visible viewport width so drag clamping
    // doesn't force X=0 when a block is wider than the screen.
    if (kind === "youtube" || kind === "image" || kind === "video" || kind === "audio" || kind === "pdf" || kind === "file" || kind === "link" || kind === "spreadsheet" || kind === "design") {
      // Media blocks can use the full viewport width (no extra right padding),
      // otherwise dragging feels like it hits an invisible "wall".
      const maxViewport = Math.max(brickWidth, containerSize.width || bricks * brickWidth);
      return Math.min(maxViewport, bricks * brickWidth);
    }
    return Math.min(remaining, bricks * brickWidth);
  }, [brickWidth, containerSize.width, defaultBlockWidthBricks]);

  const getBlockHeight = useCallback((block) => {
    const kind = block.kind || "text";
    if (kind === "youtube" || kind === "image" || kind === "video" || kind === "audio" || kind === "pdf" || kind === "file" || kind === "link" || kind === "spreadsheet" || kind === "design") {
      const hBricks = Number.isFinite(block.heightBricks) ? Math.max(2, Math.floor(block.heightBricks)) : null;
      if (hBricks) return hBricks * brickHeight;
      // Fallback based on width + aspect
      const w = getBlockWidth(block);
      const aspect = block.media?.aspect || (kind === "audio" ? 4 : 16 / 9);
      return Math.max(brickHeight * 4, Math.round((w / aspect) / brickHeight) * brickHeight);
    }
    if (kind === "list") {
      const hBricks = Number.isFinite(block.heightBricks) ? Math.max(1, Math.floor(block.heightBricks)) : 1;
      return hBricks * brickHeight;
    }
    if (kind === "sheet") {
      // Google Docs page height is ~11in @96dpi = 1056px; snap to bricks.
      const defaultPageHeightPx = 1056;
      const defaultBricks = Math.max(12, Math.round(defaultPageHeightPx / brickHeight));
      const hBricks = Number.isFinite(block.heightBricks) ? Math.max(6, Math.floor(block.heightBricks)) : defaultBricks;
      return hBricks * brickHeight;
    }
    return brickHeight;
  }, [brickHeight, getBlockWidth]);

  // (removed) pending width selection mode

  const openSlashMenuAt = useCallback((_targetEl, caretClientRect) => {
    if (!caretClientRect) return;
    // Slash menu is rendered with `position: fixed`, so we should use viewport (client) coords directly.
    setSlash((s) => ({
      ...s,
      open: true,
      filter: "",
      selectedIndex: 0,
      mode: "insert",
      position: { top: caretClientRect.top, left: caretClientRect.left },
    }));
  }, []);

  const closeSlash = useCallback(
    () => setSlash((s) => ({ ...s, open: false, filter: "", selectedIndex: 0, blockId: null, anchorOffset: null, mode: "insert" })),
    []
  );

  // Context menu: reuse the existing slash menu (no new UI).
  const openBlockContextMenu = useCallback((e, blockId) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveId(blockId);
    setSlash((s) => ({
      ...s,
      open: true,
      filter: "",
      selectedIndex: 0,
      mode: "transform",
      blockId,
      anchorOffset: null,
      position: { top: e.clientY, left: e.clientX },
    }));
  }, []);

  const applySlashCommand = useCallback((cmd) => {
    const id = slash.blockId || activeId;
    if (!id) return;
    const mode = slash.mode || "insert";
    const currentBlock = blocks.find((b) => b.id === id) || null;
    const node = blocksRef.current.get(id) || null;

    // IMPORTANT: for list insertion, we must NOT rewrite the TextBlock DOM (it can collapse rows).
    // We'll only delete the "/command" span from the DOM and leave everything else untouched.
    const rawText = node ? (node.textContent ?? "") : (currentBlock?.text ?? "");
    const currentText = rawText;

    let anchor = 0;
    let anchorRect = null;
    let before = "";
    let cleanedText = currentText;

    if (node) {
      anchor = slash.anchorOffset ?? Math.max(0, getCaretOffsetInElement(node) - 1);
      // If focus leaves the contentEditable (clicking the menu), caret-based offsets can be wrong.
      // Remove exactly the typed "/filter" span so we don't accidentally delete punctuation/letters after it.
      const tokenEnd = (() => {
        const start = Math.max(0, Math.min(rawText.length, anchor + 1));
        const filterLen = typeof slash.filter === "string" ? slash.filter.length : 0;
        const end = Math.max(start, Math.min(rawText.length, start + filterLen));
        // Fallback: if we somehow have no filter but user typed more, scan to whitespace.
        if (filterLen === 0) return start;
        return end;
      })();
      // Capture the screen-space rect of the slash anchor BEFORE we mutate the text.
      anchorRect = getClientRectAtCharOffset(node, anchor);

      // Keep "before" for caret placement in other commands (e.g., /code).
      before = rawText.slice(0, Math.max(0, Math.min(rawText.length, anchor)));

      // Delete only the "/filter" span from the DOM; do NOT rewrite the whole node text.
      const deleted = deleteTextRangeInElement(node, anchor, tokenEnd);
      if (!deleted) {
        // Fallback: safest possible behavior.
        const fallbackBefore = rawText.slice(0, anchor);
        const fallbackAfter = rawText.slice(tokenEnd);
        node.textContent = fallbackBefore + fallbackAfter;
      }

      // Persist the updated text. Use innerText to preserve visible line breaks without touching typing behavior.
      cleanedText = normalizeNewlines(node.innerText ?? node.textContent ?? "").replace(/\n$/, "");
      updateBlockText(id, cleanedText);
    } else {
      // Non-text blocks: anchor slash menu at block top-left.
      const containerRect = containerRef.current?.getBoundingClientRect();
      if (containerRect && currentBlock) {
        anchorRect = {
          top: containerRect.top + (currentBlock.y - (containerRef.current?.scrollTop ?? 0)),
          left: containerRect.left + (currentBlock.x - (containerRef.current?.scrollLeft ?? 0)),
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
        };
      }
      before = cleanedText;
    }

    let insertedNonTextBlock = false;

    // List commands:
    // - If current TextBlock is empty: convert it to a ListBlock in-place.
    // - If it has text: insert a new ListBlock below, leaving this TextBlock intact.
    if (cmd.id === "todo" || cmd.id === "bulleted" || cmd.id === "numbered") {
      if (!node) return;
      const rest = (cleanedText ?? "").trim();

      const listType = cmd.id === "todo" ? "todo" : cmd.id === "numbered" ? "numbered" : "bulleted";
      if (rest.length === 0) {
        const item = makeListItem(listType, "");
        const heightBricks = computeListHeightBricks([item]);
        updateBlock(id, { type: "ListBlock", listType, items: [item], heightBricks, style: {}, groupId: currentBlock?.groupId ?? null });
        focusListItem(id, item.id, { caretToStart: true });
        closeSlash();
      return;
    }

      // Insert a list block below (like Notion) and keep this text block.
      const groupId = currentBlock?.groupId || `group-${makeId()}`;
      // IMPORTANT: align to the parent TextBlock's left edge (NOT caret x),
      // so list is directly under and lined up like "text after list".
      const baseX = currentBlock?.x ?? 0;
      const baseY = currentBlock?.y ?? 0;
      // Add a 1-brick vertical gap between the bottom of the text card and the list.
      // Use the DOM's rendered height (multi-line text) when possible; fallback to block heightBricks.
      const insertY = (() => {
        const gap = brickHeight; // 1 brick gap
          const containerEl = containerRef.current;
          const containerRect = containerEl?.getBoundingClientRect();
        const cardEl = node?.closest?.(".glass-text-card") || node?.parentElement;
        const cardRect = cardEl?.getBoundingClientRect?.();
        if (containerEl && containerRect && cardRect && cardRect.height) {
          const scrollTop = containerEl.scrollTop ?? 0;
          return cardRect.bottom - containerRect.top + scrollTop + gap;
        }
        const textHeightBricks = Number.isFinite(currentBlock?.heightBricks) ? Math.max(1, Math.floor(currentBlock.heightBricks)) : 1;
        return baseY + (textHeightBricks + 1) * brickHeight;
      })();
      const snapped = snapPos(baseX, insertY);

          const idNew = makeId();
      // New list starts empty; user types after the marker.
      const item = makeListItem(listType, "");
      const heightBricks = computeListHeightBricks([item]);
      const widthBricks = Math.max(
        1,
        Math.floor(Number.isFinite(currentBlock?.widthBricks) ? currentBlock.widthBricks : defaultBlockWidthBricks)
      );

          setBlocks((prev) => {
            const next = [
          ...prev.map((b) => (b.id === id ? applyInternalPatch(b, { groupId }, defaultBlockWidthBricks) : b)),
              v2ToInternalBlock(
                {
                  id: idNew,
              type: "ListBlock",
              groupId,
                  x: snapped.x,
                  y: snapped.y,
                  width: widthBricks,
                  height: heightBricks,
              content: { listType, items: [item] },
              style: {},
                },
                defaultBlockWidthBricks
              ),
            ];
            emit(next);
            return next;
          });
      setActiveId(idNew);
      requestAnimationFrame(() => focusListItem(idNew, item.id, { caretToStart: true }));
          closeSlash();
          return;
        }

    if (cmd.id === "text") {
          closeSlash();
      return;
        }

    if (cmd.id === "code") {
      if (!node) {
        return;
      }

      if (mode === "insert" && (cleanedText ?? "").trim().length > 0) {
        // Insert a new CodeBlock at caret location, keep current block as text.
        const containerEl = containerRef.current;
        const containerRect = containerEl?.getBoundingClientRect();
        const canvasX =
          anchorRect && containerRect
            ? anchorRect.left - containerRect.left + (containerEl?.scrollLeft ?? 0)
            : (currentBlock?.x ?? lastPointerRef.current.x ?? 0);
        const canvasY =
          anchorRect && containerRect
            ? anchorRect.top - containerRect.top + (containerEl?.scrollTop ?? 0)
            : (currentBlock?.y ?? lastPointerRef.current.y ?? 0);
        const snapped = snapPos(canvasX, canvasY);

        const idNew = makeId();
        // Spawn code blocks about 3/4 a sheet (snapped to bricks), but keep fully visible in viewport.
        const desiredCodeWidthPx = 306;  // half of 612
        const desiredCodeHeightPx = 198; // half of 396
        const maxViewportBricks = Math.max(8, Math.floor(((containerSize.width || desiredCodeWidthPx) - brickWidth) / brickWidth));
        const widthBricks = Math.max(8, Math.min(Math.round(desiredCodeWidthPx / brickWidth), maxViewportBricks));
        const heightBricks = Math.max(6, Math.round(desiredCodeHeightPx / brickHeight));

        setBlocks((prev) => {
          const next = [
            ...prev,
            v2ToInternalBlock(
              {
                id: idNew,
                type: "CodeBlock",
                x: snapped.x,
                y: snapped.y,
                width: widthBricks,
                height: heightBricks,
                content: { text: "", language: "plaintext" },
                style: { format: "code" },
              },
              defaultBlockWidthBricks
            ),
          ];
          emit(next);
          return next;
        });

        closeSlash();
        focusBlock(idNew);
        return;
      }

      setCaretOffsetInElement(node, before.length);
      setBlockFormat(id, "code");
      // Initialize with default language and size
      if (currentBlock) {
        const updates = {};
        if (!currentBlock.language) {
          updates.language = "plaintext"; // Default to Plain Text as per requirements
        }
        // Set default size: about 3/4 a sheet.
        const desiredCodeWidthPx = 306;
        const desiredCodeHeightPx = 198;
        const maxViewportBricks = Math.max(8, Math.floor(((containerSize.width || desiredCodeWidthPx) - brickWidth) / brickWidth));
        const codeWidthBricks = Math.max(8, Math.min(Math.round(desiredCodeWidthPx / brickWidth), maxViewportBricks));
        const codeHeightBricks = Math.max(6, Math.round(desiredCodeHeightPx / brickHeight));
        updates.widthBricks = codeWidthBricks;
        updates.heightBricks = codeHeightBricks;
        if (Object.keys(updates).length > 0) {
          updateBlock(id, updates);
        }
      }
    } else if (cmd.id === "image") {
      startImageInsert();
      insertedNonTextBlock = true;
      if (cleanedText.trim().length === 0) removeBlock(id);
    } else if (cmd.id === "video") {
      // Same file picker; inserted file determines mediaType by mime.
      startImageInsert();
      insertedNonTextBlock = true;
      if (cleanedText.trim().length === 0) removeBlock(id);
    } else if (cmd.id === "design") {
      const anchorBlock = blocks.find((b) => b.id === id) || null;
      const containerEl = containerRef.current;
      const containerRect = containerEl?.getBoundingClientRect();
      const canvasX =
        anchorRect && containerRect
          ? anchorRect.left - containerRect.left + (containerEl?.scrollLeft ?? 0)
          : (anchorBlock?.x ?? lastPointerRef.current.x ?? 0);
      const canvasY =
        anchorRect && containerRect
          ? anchorRect.top - containerRect.top + (containerEl?.scrollTop ?? 0)
          : (anchorBlock?.y ?? lastPointerRef.current.y ?? 0);
      const snapped = snapPos(canvasX, canvasY);

      const idNew = makeId();
      const widthPx = 600;
      const heightPx = 400;
      const widthBricks = Math.max(8, Math.round(widthPx / brickWidth));
      const heightBricks = Math.max(8, Math.round(heightPx / brickHeight));
      const board = { version: 1, elements: [], tool: "pen", color: "#111827", shape: "rect" };

      setBlocks((prev) => {
        const withoutCurrent = cleanedText.trim().length === 0 ? prev.filter((b) => b.id !== id) : prev;
        const next = [
          ...withoutCurrent,
          v2ToInternalBlock(
            {
              id: idNew,
              type: "DesignBlock",
              x: snapped.x,
              y: snapped.y,
              width: widthBricks,
              height: heightBricks,
              content: { board },
              style: {},
            },
            defaultBlockWidthBricks
          ),
        ];
        emit(next);
        return next;
      });
      setActiveId(idNew);
      insertedNonTextBlock = true;
      requestAnimationFrame(() => {
        try {
          containerRef.current?.scrollTo?.({
            top: Math.max(0, snapped.y - brickHeight * 2),
            left: Math.max(0, snapped.x - brickWidth * 2),
          });
        } catch {
          // ignore
        }
      });
    } else if (cmd.id === "sheet") {
      // Doc-style sheet (Google-Docs-like): a big text surface, separate from TextBlock.
      const anchorBlock = blocks.find((b) => b.id === id) || null;
      const containerEl = containerRef.current;
      const containerRect = containerEl?.getBoundingClientRect();

      const insertBelowText = Boolean(node && cleanedText.trim().length > 0);
      const baseX = anchorBlock?.x ?? lastPointerRef.current.x ?? 0;
      // Aim for a Google-Docs-like page width (~8.5in @96dpi = 816px).
      const desiredPageWidthPx = 816;
      // And Google-Docs-like page height (~11in @96dpi = 1056px).
      const desiredPageHeightPx = 1056;
      const maxViewportBricks = Math.max(8, Math.floor(((containerSize.width || desiredPageWidthPx) - brickWidth) / brickWidth));
      const widthBricks = Math.max(10, Math.min(Math.round(desiredPageWidthPx / brickWidth), maxViewportBricks));
      // Fixed height by default (typing should NOT auto-grow height).
      const heightBricks = Math.max(12, Math.round(desiredPageHeightPx / brickHeight));
      const groupId = anchorBlock?.groupId || `group-${makeId()}`;

      const snapped = (() => {
        if (insertBelowText && node && containerEl && containerRect) {
          const gap = brickHeight; // 1 brick gap
          const cardEl = node?.closest?.(".glass-text-card") || node?.parentElement;
          const cardRect = cardEl?.getBoundingClientRect?.();
          if (cardRect && cardRect.height) {
            const scrollTop = containerEl.scrollTop ?? 0;
            const y = cardRect.bottom - containerRect.top + scrollTop + gap;
            // Keep the sheet fully visible horizontally when inserting under a text block.
            const desiredWpx = widthBricks * brickWidth;
            const scrollLeft = containerEl.scrollLeft ?? 0;
            const viewportW = containerSize.width || desiredWpx;
            const maxX = Math.max(0, scrollLeft + viewportW - desiredWpx);
            const x = clamp(baseX, 0, maxX);
            return snapPos(x, y);
          }
          return snapPos(baseX, (anchorBlock?.y ?? 0) + brickHeight * 2);
        }

        // Default: center the page in the current viewport (like a doc).
        const scrollLeft = containerEl?.scrollLeft ?? 0;
        const scrollTop = containerEl?.scrollTop ?? 0;
        const viewportW = containerSize.width || desiredPageWidthPx;
        const desiredWpx = widthBricks * brickWidth;
        const x = Math.max(0, scrollLeft + Math.max(0, Math.floor((viewportW - desiredWpx) / 2)));
        const y =
          anchorRect && containerRect
            ? anchorRect.top - containerRect.top + scrollTop
            : (anchorBlock?.y ?? lastPointerRef.current.y ?? scrollTop);
        return snapPos(x, y);
      })();

      const idNew = makeId();
      setBlocks((prev) => {
        // If the user typed only "/sheet" in an otherwise-empty block, replace it.
        const withoutCurrent = cleanedText.trim().length === 0 ? prev.filter((b) => b.id !== id) : prev;
        const next = [
          ...withoutCurrent,
          v2ToInternalBlock(
            {
              id: idNew,
              type: "SheetBlock",
              groupId,
              x: snapped.x,
              y: snapped.y,
              width: widthBricks,
              height: heightBricks,
              content: { text: "" },
              style: { format: "sheet", paginate: true },
            },
            defaultBlockWidthBricks
          ),
        ];
        emit(next);
        return next;
      });
      setActiveId(idNew);
      insertedNonTextBlock = true;
      requestAnimationFrame(() => focusBlock(idNew, { caretToStart: true }));
    } else if (cmd.id === "table" || cmd.id === "spreadsheet") {
      // Place top-left at the caret location (snapped to brick grid).
      const containerEl = containerRef.current;
      const containerRect = containerEl?.getBoundingClientRect();
      const anchorBlock = blocks.find((b) => b.id === id) || null;

      // Compute canvas coords from the "/" anchor rect (robust across scrolling),
      // with fallback to the current block position so we never spawn offscreen.
      const canvasX =
        anchorRect && containerRect
          ? anchorRect.left - containerRect.left + (containerEl?.scrollLeft ?? 0)
          : (anchorBlock?.x ?? lastPointerRef.current.x ?? 0);
      const canvasY =
        anchorRect && containerRect
          ? anchorRect.top - containerRect.top + (containerEl?.scrollTop ?? 0)
          : (anchorBlock?.y ?? lastPointerRef.current.y ?? 0);

      const snapped = snapPos(canvasX, canvasY);

      const rows = 30;
      const cols = 20;
      const defaultColW = 96;
      const sheet = {
        version: 1,
        rows,
        cols,
        colWidths: Array.from({ length: cols }, () => defaultColW),
        cells: {},
      };

      const idNew = makeId();
      const remainingPx = Math.max(brickWidth * 8, (containerSize.width || brickWidth * 16) - snapped.x);
      const widthBricks = Math.max(8, Math.round(remainingPx / brickWidth));
      const heightBricks = rows + 1; // header row + 30 rows, each row = brickHeight

      setBlocks((prev) => {
        const withoutCurrent = cleanedText.trim().length === 0 ? prev.filter((b) => b.id !== id) : prev;
        const next = [
          ...withoutCurrent,
          v2ToInternalBlock(
            {
              id: idNew,
              type: "SpreadsheetBlock",
              x: snapped.x,
              y: snapped.y,
              width: widthBricks,
              height: heightBricks,
              content: { sheet },
              style: {},
            },
            defaultBlockWidthBricks
          ),
        ];
        emit(next);
        return next;
      });
      setActiveId(idNew);
      setSpreadsheetAutoFocusId(idNew);
      // Ensure the new spreadsheet is visible even if the caret rect couldn't be measured perfectly.
      requestAnimationFrame(() => {
        try {
          containerRef.current?.scrollTo?.({
            top: Math.max(0, snapped.y - brickHeight * 2),
            left: Math.max(0, snapped.x - brickWidth * 2),
          });
        } catch {
          // ignore
        }
      });
      insertedNonTextBlock = true;
    }

    closeSlash();
    if (!insertedNonTextBlock) focusBlock(id);
  }, [activeId, addDividerBelow, blocks, brickWidth, closeSlash, containerSize.width, focusBlock, setBlockFormat, slash.anchorOffset, slash.blockId, snapPos, startImageInsert, updateBlockText, emit]);

  // Allow "/" to open the slash menu even when a non-text block is focused.
  // (Text-like blocks handle this in their own key handlers; this is the fallback for others.)
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== "/") return;
      const id = activeId;
      if (!id) return;
      const b = blocks.find((x) => x.id === id) || null;
      if (!b) return;
      if ((b.kind || "text") === "text") return;

      e.preventDefault();
      e.stopPropagation();

      const containerEl = containerRef.current;
      const containerRect = containerEl?.getBoundingClientRect?.();
      if (!containerRect) return;

      const top = containerRect.top + (b.y - (containerEl?.scrollTop ?? 0));
      const left = containerRect.left + (b.x - (containerEl?.scrollLeft ?? 0));

      setSlash((s) => ({
        ...s,
        open: true,
        filter: "",
        selectedIndex: 0,
        mode: "insert",
        blockId: id,
        anchorOffset: null,
        position: { top, left },
      }));
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeId, blocks]);

  const markTyping = useCallback(() => {
    setIsTyping(true);
    setHoverCell(null);
    if (typingIdleTimeoutRef.current) clearTimeout(typingIdleTimeoutRef.current);
    typingIdleTimeoutRef.current = setTimeout(() => {
      setIsTyping(false);
    }, 650);
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== "Backspace" && e.key !== "Delete") return;
      const active = activeId;
      if (!active) return;

      // Don't interfere with normal typing / editing.
      const t = e.target;
      if (t instanceof Element) {
        if (t.closest("[contenteditable='true']")) return;
        if (t.closest("input, textarea, select")) return;
        // If inside spreadsheet, let SpreadsheetBlock handle clearing cells.
        if (t.closest("[data-spreadsheet-root]")) return;
      }

      const b = blocksStateRef.current.find((x) => x.id === active) || null;
      if (!b) return;
      const kind = b.kind || "text";
      if (kind === "text") return;

      e.preventDefault();
      removeBlock(active);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [activeId, removeBlock]);

  useEffect(() => {
    return () => {
      if (typingIdleTimeoutRef.current) clearTimeout(typingIdleTimeoutRef.current);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full overflow-auto bg-transparent", className)}
      style={{
        minHeight,
        // keep scrolling region tall enough for placed blocks
        height: "100%",
        backgroundImage: debugGrid
          ? `repeating-linear-gradient(0deg, rgba(0,0,0,0.06) 0, rgba(0,0,0,0.06) 1px, transparent 1px, transparent ${brickHeight}px),
             repeating-linear-gradient(90deg, rgba(0,0,0,0.06) 0, rgba(0,0,0,0.06) 1px, transparent 1px, transparent ${brickWidth}px)`
          : undefined,
      }}
      onPointerMove={(e) => {
        // Marquee selection drag
        if (marqueeRef.current?.active) {
          const el = containerRef.current;
          const rect = el?.getBoundingClientRect?.();
          if (!el || !rect) return;
          const x = e.clientX - rect.left + (el.scrollLeft || 0);
          const y = e.clientY - rect.top + (el.scrollTop || 0);
          const startX = marqueeRef.current.startX ?? 0;
          const startY = marqueeRef.current.startY ?? 0;
          const left = Math.min(startX, x);
          const top = Math.min(startY, y);
          const width = Math.abs(x - startX);
          const height = Math.abs(y - startY);
          setMarquee((m) => (m && m.active ? { ...m, left, top, width, height } : m));
          return;
        }

        // Track last pointer for "Add Media" insert location, etc.
        const el = containerRef.current;
        const rect = el?.getBoundingClientRect?.();
        if (el && rect) {
          lastPointerRef.current = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top + el.scrollTop,
          };
        }

        // If pointer is over an existing block (text/media), don't show the grid hover highlight
        // and don't update pending width hover. This prevents "bricks behind media" from lighting up
        // and avoids hover fighting with drag/resize.
        const target = e.target;
        const overBlock = target instanceof Element ? !!target.closest("[data-brick-block]") : false;
        if (overBlock || dragRef.current || resizeRef.current) {
          if (hoverCell) setHoverCell(null);
          return;
        }

        const col = colFromClientX(e.clientX);
        const row = rowFromClientY(e.clientY);
        if (!isTyping) {
          setHoverCell({ col, row, x: col * brickWidth, y: row * brickHeight });
        }
      }}
      onPointerLeave={() => setHoverCell(null)}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={handleDrop}
      onPointerDown={(e) => {
        // Always remember the click location (even if it's on an existing block).
        const el = containerRef.current;
        const rect = el?.getBoundingClientRect?.();
        if (el && rect) {
          lastPointerRef.current = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top + el.scrollTop,
          };
        }

        // Don't create a new block if user clicked an existing block.
        const target = e.target;
        const inBlock = target instanceof Element ? target.closest("[data-brick-block]") : null;
        if (inBlock) return;
        if (e.shiftKey) {
          // Shift+drag marquee selection
          e.preventDefault();
          try {
            e.currentTarget.setPointerCapture?.(e.pointerId);
          } catch {
            // ignore
          }
          const x = e.clientX - rect.left + (el.scrollLeft || 0);
          const y = e.clientY - rect.top + (el.scrollTop || 0);
          setMarquee({ active: true, pointerId: e.pointerId, startX: x, startY: y, left: x, top: y, width: 0, height: 0 });
          return;
        }
        // Normal click: clear selection and create block
        clearSelection();
        const x = snapX(e.clientX);
        const y = snapY(e.clientY);
        createBlockAt(x, y);
      }}
      onPointerUp={(e) => {
        const m = marqueeRef.current;
        if (!m?.active) return;
        if (m.pointerId != null && e.pointerId !== m.pointerId) return;
        const el = containerRef.current;
        try {
          el?.releasePointerCapture?.(e.pointerId);
        } catch {
          // ignore
        }

        const box = { left: m.left ?? 0, top: m.top ?? 0, right: (m.left ?? 0) + (m.width ?? 0), bottom: (m.top ?? 0) + (m.height ?? 0) };
        const add = [];
        for (const b of (blocksStateRef.current || [])) {
          if (!b?.id) continue;
          if ((b.kind || "text") === "divider") continue;
          const r = computeBlockRectPx(b);
          if (rectsIntersect(r, box)) add.push(String(b.id));
        }
        if (add.length) {
          setSelectedIds((prev) => {
            const next = new Set(prev);
            for (const id of add) next.add(id);
            return next;
          });
        }
        setMarquee(null);
      }}
      onPointerCancel={(e) => {
        const m = marqueeRef.current;
        if (!m?.active) return;
        if (m.pointerId != null && e.pointerId !== m.pointerId) return;
        setMarquee(null);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="*/*,.pdf,application/pdf"
        multiple
        className="hidden"
        onChange={handleMediaSelected}
      />
      {/* Drag-to-delete zone (only visible while dragging) - pinned to visible right edge */}
      {(dragRef.current && showTrashZone) && (
        <div
          className="absolute top-0 right-0 bottom-0 z-50 pointer-events-none"
          style={{
            width: "56px",
            background: trashHover ? "rgba(239, 68, 68, 0.14)" : "rgba(239, 68, 68, 0.06)",
            borderLeft: trashHover ? "2px solid rgba(239, 68, 68, 0.45)" : "1px solid rgba(239, 68, 68, 0.20)",
          }}
        />
      )}

      <div
        className="relative w-full"
        style={{
          // Absolute-positioned blocks don't affect layout height; expand the inner canvas based on lowest block
          // so the user can keep scrolling down as content grows.
          minHeight: `max(calc(${minHeight} + 200px), ${Math.ceil(
            (blocks || []).reduce((m, bb) => Math.max(m, (bb?.y ?? 0) + getBlockHeight(bb) + 240), 0)
          )}px)`,
        }}
      >
        {/* Marquee selection box */}
        {marquee?.active && (
          <div
            className="absolute pointer-events-none z-40"
            style={{
              left: `${marquee.left}px`,
              top: `${marquee.top}px`,
              width: `${marquee.width}px`,
              height: `${marquee.height}px`,
              background: "rgba(59, 130, 246, 0.10)",
              border: "1px solid rgba(59, 130, 246, 0.35)",
              borderRadius: "8px",
            }}
          />
        )}

        {/* Group button (appears when 2+ blocks are selected) */}
        {selectedIds.size >= 2 && (() => {
          const bounds = selectionBoundsPx(selectedIds, blocks);
          if (!bounds) return null;
          const left = Math.max(8, bounds.right - 84);
          const top = Math.max(8, bounds.top - 34);
          return (
            <button
              key="group-selection"
              type="button"
              className="absolute z-50 px-3 h-8 rounded-lg text-sm text-gray-900 bg-white/60 hover:bg-white/75 dark:text-white dark:bg-white/10 dark:hover:bg-white/16 backdrop-blur-xl border border-white/25 dark:border-white/10 shadow-sm shadow-black/5"
              style={{ left: `${left}px`, top: `${top}px` }}
              onPointerDown={(e) => {
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                groupSelection();
              }}
              title="Group (Ctrl/Cmd+G)"
            >
              Group
            </button>
          );
        })()}

        {/* Always-on hover highlight (single brick under cursor) */}
        {hoverCell && !isTyping && (
          <div
            className="absolute pointer-events-none z-30"
            style={{
              left: `${hoverCell.x}px`,
              top: `${hoverCell.y}px`,
              width: `${brickWidth}px`,
              height: `${brickHeight}px`,
              background: "rgba(59, 130, 246, 0.10)",
              outline: "1px solid rgba(59, 130, 246, 0.22)",
              borderRadius: "4px",
            }}
          />
        )}

        {blocks.map((b) => {
          const kind = b.kind || "text";
          const isMultiSelected = selectedIds.has(String(b.id));
          const multiSelectedStyle = isMultiSelected
            ? { outline: "2px solid rgba(59, 130, 246, 0.55)", outlineOffset: "2px" }
            : null;
          if (kind === "divider") {
            return (
              <div
                key={b.id}
                data-brick-block
                className="absolute pointer-events-none"
                style={{
                  left: `${b.x}px`,
                  top: `${b.y}px`,
                  width: `${getBlockWidth(b)}px`,
                  height: `${brickHeight}px`,
                }}
              >
                <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.28)", margin: `${brickHeight / 2}px 0 0 0` }} />
              </div>
            );
          }
          if (kind === "image") {
            const w = getBlockWidth(b);
            const h = getBlockHeight(b);
            return (
              <div
                key={b.id}
                data-brick-block
                className="absolute group"
                style={{
                  left: `${b.x}px`,
                  top: `${b.y}px`,
                  width: `${w}px`,
                  height: `${h}px`,
                  ...(multiSelectedStyle || {}),
                }}
                onPointerDownCapture={(e) => onBlockPointerDownCapture(e, b.id)}
                onPointerDown={(e) => {
                  e.stopPropagation();
                }}
                onContextMenu={(e) => openBlockContextMenu(e, b.id)}
              >
                <div
                  className="absolute inset-x-0 top-0 h-10 z-20 bg-white/22 dark:bg-white/8 backdrop-blur-xl border-b border-white/18 dark:border-white/10 cursor-grab active:cursor-grabbing rounded-t-[6px]"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    try {
                      e.currentTarget.setPointerCapture?.(e.pointerId);
                    } catch {
                      // ignore
                    }
                    dragRef.current = { id: b.id, startClientX: e.clientX, startClientY: e.clientY, originX: b.x, originY: b.y, widthPx: w };
                  }}
                  title="Drag to move"
                />
                <button
                  type="button"
                  className="absolute top-0 right-0 z-40 w-9 h-9 m-0.5 flex items-center justify-center text-gray-800 hover:text-gray-950 dark:text-gray-100 dark:hover:text-white opacity-0 group-hover:opacity-100 transition-opacity text-2xl leading-none rounded-lg bg-white/35 hover:bg-white/55 dark:bg-white/10 dark:hover:bg-white/16 backdrop-blur-xl border border-white/25 dark:border-white/10 shadow-sm shadow-black/5"
                  title="Remove image"
                  aria-label="Remove image"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeBlock(b.id);
                  }}
                >
                  ×
                </button>
                <div className="absolute inset-0 pt-10">
                  <div className="w-full h-full overflow-hidden glass-block">
                    <img
                      src={b.media?.src}
                      alt={b.media?.name || "image"}
                      style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
                      onLoad={(e) => {
                        const img = e.currentTarget;
                        const nw = img.naturalWidth || 0;
                        const nh = img.naturalHeight || 0;
                        if (!nw || !nh) return;
                        const aspect = nw / nh;
                        const nextHpx = Math.max(brickHeight * 4, Math.round((w / aspect) / brickHeight) * brickHeight);
                        const heightBricks = Math.max(3, Math.round(nextHpx / brickHeight));
                        updateBlock(b.id, { heightBricks, media: { ...(b.media || {}), aspect } });
                      }}
                    />
                  </div>
                </div>
                <div
                  data-resize-handle
                  className="absolute bottom-1 right-1 z-30 w-4 h-4 bg-black/20 dark:bg-white/20 rounded cursor-nwse-resize opacity-0 group-hover:opacity-100 transition-opacity"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const aspect = b.media?.aspect || 1;
                    resizeRef.current = { id: b.id, startClientX: e.clientX, originWidthPx: w, aspect };
                  }}
                  title="Drag to resize"
                />
              </div>
            );
          }
          if (kind === "video") {
            const w = getBlockWidth(b);
            const h = getBlockHeight(b);
            return (
              <div
                key={b.id}
                data-brick-block
                className="absolute group"
                style={{ left: `${b.x}px`, top: `${b.y}px`, width: `${w}px`, height: `${h}px`, ...(multiSelectedStyle || {}) }}
                onPointerDownCapture={(e) => onBlockPointerDownCapture(e, b.id)}
                onPointerDown={(e) => e.stopPropagation()}
                onContextMenu={(e) => openBlockContextMenu(e, b.id)}
              >
                <div
                  className="absolute inset-x-0 top-0 h-10 z-20 bg-white/22 dark:bg-white/8 backdrop-blur-xl border-b border-white/18 dark:border-white/10 cursor-grab active:cursor-grabbing rounded-t-[6px]"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    try {
                      e.currentTarget.setPointerCapture?.(e.pointerId);
                    } catch {
                      // ignore
                    }
                    dragRef.current = { id: b.id, startClientX: e.clientX, startClientY: e.clientY, originX: b.x, originY: b.y, widthPx: w };
                  }}
                  title="Drag to move"
                />
                <button
                  type="button"
                  className="absolute top-0 right-0 z-40 w-9 h-9 m-0.5 flex items-center justify-center text-gray-800 hover:text-gray-950 dark:text-gray-100 dark:hover:text-white opacity-0 group-hover:opacity-100 transition-opacity text-2xl leading-none rounded-lg bg-white/35 hover:bg-white/55 dark:bg-white/10 dark:hover:bg-white/16 backdrop-blur-xl border border-white/25 dark:border-white/10 shadow-sm shadow-black/5"
                  title="Remove video"
                  aria-label="Remove video"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeBlock(b.id);
                  }}
                >
                  ×
                </button>
                <div className="absolute inset-0 pt-10">
                  <div className="w-full h-full overflow-hidden glass-block">
                    <video
                      src={b.media?.src}
                      controls
                      className="w-full h-full"
                      style={{ objectFit: "contain" }}
                      onLoadedMetadata={(e) => {
                        const v = e.currentTarget;
                        const vw = v.videoWidth || 0;
                        const vh = v.videoHeight || 0;
                        if (!vw || !vh) return;
                        const aspect = vw / vh;
                        const nextHpx = Math.max(brickHeight * 4, Math.round((w / aspect) / brickHeight) * brickHeight);
                        const heightBricks = Math.max(3, Math.round(nextHpx / brickHeight));
                        updateBlock(b.id, { heightBricks, media: { ...(b.media || {}), aspect } });
                      }}
                    />
                  </div>
                </div>
                <div
                  data-resize-handle
                  className="absolute bottom-1 right-1 z-30 w-4 h-4 bg-black/20 dark:bg-white/20 rounded cursor-nwse-resize opacity-0 group-hover:opacity-100 transition-opacity"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const aspect = b.media?.aspect || 16 / 9;
                    resizeRef.current = { id: b.id, startClientX: e.clientX, originWidthPx: w, aspect };
                  }}
                  title="Drag to resize"
                />
              </div>
            );
          }
          if (kind === "pdf") {
            const w = getBlockWidth(b);
            const h = getBlockHeight(b);
            const zoom = Number.isFinite(b.media?.zoom) ? clamp(b.media.zoom, 50, 300) : 125;
            return (
              <div
                key={b.id}
                data-brick-block
                className="absolute group"
                style={{ left: `${b.x}px`, top: `${b.y}px`, width: `${w}px`, height: `${h}px`, ...(multiSelectedStyle || {}) }}
                onPointerDownCapture={(e) => onBlockPointerDownCapture(e, b.id)}
                onPointerDown={(e) => e.stopPropagation()}
                onContextMenu={(e) => openBlockContextMenu(e, b.id)}
              >
                <div
                  className="absolute inset-x-0 top-0 h-10 z-20 bg-white/22 dark:bg-white/8 backdrop-blur-xl border-b border-white/18 dark:border-white/10 cursor-grab active:cursor-grabbing rounded-t-[6px]"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    try {
                      e.currentTarget.setPointerCapture?.(e.pointerId);
                    } catch {
                      // ignore
                    }
                    dragRef.current = { id: b.id, startClientX: e.clientX, startClientY: e.clientY, originX: b.x, originY: b.y, widthPx: w };
                  }}
                  title="Drag to move"
                />
                {/* PDF zoom controls (scale pages, not just the container) */}
                <div
                  className="absolute top-0 left-0 z-40 h-10 px-2 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                  }}
                >
                  <button
                    type="button"
                    className="w-7 h-7 flex items-center justify-center text-gray-800 hover:text-gray-950 dark:text-gray-100 dark:hover:text-white text-lg leading-none rounded-lg bg-white/35 hover:bg-white/55 dark:bg-white/10 dark:hover:bg-white/16 backdrop-blur-xl border border-white/25 dark:border-white/10 shadow-sm shadow-black/5"
                    title="Zoom out"
                    aria-label="Zoom out"
                    onClick={(e) => {
                      e.stopPropagation();
                      const nextZoom = clamp(zoom - 15, 50, 300);
                      updateBlock(b.id, { media: { ...(b.media || {}), zoom: nextZoom } });
                    }}
                  >
                    −
                  </button>
                  <div className="text-xs text-gray-700 dark:text-gray-200 select-none tabular-nums">
                    {zoom}%
                  </div>
                  <button
                    type="button"
                    className="w-7 h-7 flex items-center justify-center text-gray-800 hover:text-gray-950 dark:text-gray-100 dark:hover:text-white text-lg leading-none rounded-lg bg-white/35 hover:bg-white/55 dark:bg-white/10 dark:hover:bg-white/16 backdrop-blur-xl border border-white/25 dark:border-white/10 shadow-sm shadow-black/5"
                    title="Zoom in"
                    aria-label="Zoom in"
                    onClick={(e) => {
                      e.stopPropagation();
                      const nextZoom = clamp(zoom + 15, 50, 300);
                      updateBlock(b.id, { media: { ...(b.media || {}), zoom: nextZoom } });
                    }}
                  >
                    +
                  </button>
                </div>
                <button
                  type="button"
                  className="absolute top-0 right-0 z-40 w-9 h-9 m-0.5 flex items-center justify-center text-gray-800 hover:text-gray-950 dark:text-gray-100 dark:hover:text-white opacity-0 group-hover:opacity-100 transition-opacity text-2xl leading-none rounded-lg bg-white/35 hover:bg-white/55 dark:bg-white/10 dark:hover:bg-white/16 backdrop-blur-xl border border-white/25 dark:border-white/10 shadow-sm shadow-black/5"
                  title="Remove PDF"
                  aria-label="Remove PDF"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeBlock(b.id);
                  }}
                >
                  ×
                </button>
                <div className="absolute inset-0 pt-10">
                  <div className="w-full h-full overflow-hidden glass-block">
                    <iframe
                      key={`${b.id}-pdf-${zoom}`}
                      src={b.media?.src ? `${b.media.src}#zoom=${zoom}` : undefined}
                      title={b.media?.name || "PDF"}
                      className="w-full h-full"
                      style={{ border: "none" }}
                    />
                  </div>
                </div>
                <div
                  data-resize-handle
                  className="absolute bottom-1 right-1 z-30 w-4 h-4 bg-black/20 dark:bg-white/20 rounded cursor-nwse-resize opacity-0 group-hover:opacity-100 transition-opacity"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const aspect = b.media?.aspect || 1;
                    resizeRef.current = { id: b.id, startClientX: e.clientX, originWidthPx: w, aspect };
                  }}
                  title="Drag to resize"
                />
              </div>
            );
          }
          if (kind === "audio") {
            const w = getBlockWidth(b);
            const h = getBlockHeight(b);
            return (
              <div
                key={b.id}
                data-brick-block
                className="absolute group"
                style={{ left: `${b.x}px`, top: `${b.y}px`, width: `${w}px`, height: `${h}px`, ...(multiSelectedStyle || {}) }}
                onPointerDownCapture={(e) => onBlockPointerDownCapture(e, b.id)}
                onPointerDown={(e) => e.stopPropagation()}
                onContextMenu={(e) => openBlockContextMenu(e, b.id)}
              >
                <div
                  className="absolute inset-x-0 top-0 h-10 z-20 bg-white/22 dark:bg-white/8 backdrop-blur-xl border-b border-white/18 dark:border-white/10 cursor-grab active:cursor-grabbing rounded-t-[6px]"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    try {
                      e.currentTarget.setPointerCapture?.(e.pointerId);
                    } catch {
                      // ignore
                    }
                    dragRef.current = { id: b.id, startClientX: e.clientX, startClientY: e.clientY, originX: b.x, originY: b.y, widthPx: w };
                  }}
                  title="Drag to move"
                />
                <button
                  type="button"
                  className="absolute top-0 right-0 z-40 w-9 h-9 m-0.5 flex items-center justify-center text-gray-800 hover:text-gray-950 dark:text-gray-100 dark:hover:text-white opacity-0 group-hover:opacity-100 transition-opacity text-2xl leading-none rounded-lg bg-white/35 hover:bg-white/55 dark:bg-white/10 dark:hover:bg-white/16 backdrop-blur-xl border border-white/25 dark:border-white/10 shadow-sm shadow-black/5"
                  title="Remove audio"
                  aria-label="Remove audio"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeBlock(b.id);
                  }}
                >
                  ×
                </button>
                <div className="absolute inset-0 pt-10">
                  <div className="w-full h-full overflow-hidden glass-block flex items-center px-3">
                    <audio src={b.media?.src} controls className="w-full" />
                  </div>
                </div>
                <div
                  data-resize-handle
                  className="absolute bottom-1 right-1 z-30 w-4 h-4 bg-black/20 dark:bg-white/20 rounded cursor-nwse-resize opacity-0 group-hover:opacity-100 transition-opacity"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const aspect = b.media?.aspect || 4;
                    resizeRef.current = { id: b.id, startClientX: e.clientX, originWidthPx: w, aspect };
                  }}
                  title="Drag to resize"
                />
              </div>
            );
          }
          if (kind === "file" || kind === "link") {
            const w = getBlockWidth(b);
            const h = getBlockHeight(b);
            const label = kind === "link" ? (b.media?.name || b.media?.url || "Link") : (b.media?.name || "File");
            const href = kind === "link" ? b.media?.url : b.media?.src;
            return (
              <div
                key={b.id}
                data-brick-block
                className="absolute group"
                style={{ left: `${b.x}px`, top: `${b.y}px`, width: `${w}px`, height: `${h}px`, ...(multiSelectedStyle || {}) }}
                onPointerDownCapture={(e) => onBlockPointerDownCapture(e, b.id)}
                onPointerDown={(e) => e.stopPropagation()}
                onContextMenu={(e) => openBlockContextMenu(e, b.id)}
              >
                <div
                  className="absolute inset-x-0 top-0 h-10 z-20 bg-white/22 dark:bg-white/8 backdrop-blur-xl border-b border-white/18 dark:border-white/10 cursor-grab active:cursor-grabbing rounded-t-[6px]"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    try {
                      e.currentTarget.setPointerCapture?.(e.pointerId);
                    } catch {
                      // ignore
                    }
                    dragRef.current = { id: b.id, startClientX: e.clientX, startClientY: e.clientY, originX: b.x, originY: b.y, widthPx: w };
                  }}
                  title="Drag to move"
                />
                <button
                  type="button"
                  className="absolute top-0 right-0 z-40 w-10 h-10 flex items-center justify-center text-gray-700 hover:text-gray-900 dark:text-gray-200 dark:hover:text-white opacity-0 group-hover:opacity-100 transition-opacity text-2xl leading-none"
                  title="Remove"
                  aria-label="Remove"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeBlock(b.id);
                  }}
                >
                  ×
                </button>
                <div className="absolute inset-0 pt-10">
                  <div
                    className="w-full h-full overflow-hidden glass-block flex items-center px-3 text-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (href) window.open(href, "_blank");
                    }}
                    style={{ cursor: href ? "pointer" : "default" }}
                    title={href || ""}
                  >
                    <div className="truncate">{label}</div>
                  </div>
                </div>
              </div>
            );
          }
          if (kind === "sheet") {
            const w = getBlockWidth(b);
            const h = getBlockHeight(b);
            const isSelected = activeId === b.id;
            const currentBricksH = Number.isFinite(b.heightBricks) ? Math.max(6, Math.floor(b.heightBricks)) : Math.max(12, Math.round(1056 / brickHeight));

            return (
              <div
                key={b.id}
                data-brick-block
                className="absolute group"
                style={{ left: `${b.x}px`, top: `${b.y}px`, width: `${w}px`, height: `${h}px`, ...(multiSelectedStyle || {}) }}
                onPointerDownCapture={(e) => onBlockPointerDownCapture(e, b.id)}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setActiveId(b.id);
                }}
                onContextMenu={(e) => openBlockContextMenu(e, b.id)}
              >
                <div className="w-full h-full glass-block overflow-hidden relative">
                  {/* tiny drag strip (no permanent toolbar) */}
                  <div
                    className={`w-full ${isSelected ? "cursor-grab active:cursor-grabbing" : "cursor-default"}`}
                    style={{ height: "8px" }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setActiveId(b.id);
                      dragRef.current = { id: b.id, startClientX: e.clientX, startClientY: e.clientY, originX: b.x, originY: b.y, widthPx: w };
                    }}
                    title={isSelected ? "Drag to move" : undefined}
                  />

                  <div className="w-full" style={{ height: `calc(100% - 8px)` }}>
                    <div
                      ref={(node) => {
                        if (node) {
                          blocksRef.current.set(b.id, node);
                          setNodeTextOnce(node, b.text);
                        } else {
                          blocksRef.current.delete(b.id);
                        }
                      }}
                      contentEditable
                      suppressContentEditableWarning
                      spellCheck
                      className={cn("outline-none whitespace-pre-wrap break-words text-foreground")}
                      style={{
                        fontFamily,
                        fontSize,
                        lineHeight,
                        letterSpacing,
                        padding: "18px 18px",
                        height: "100%",
                        width: "100%",
                        overflowY: b.style?.paginate === false ? "auto" : "hidden",
                        overflowX: "hidden",
                      }}
                      onFocus={() => {
                        setActiveId(b.id);
                        closeSlash();
                        setIsTyping(false);
                      }}
                      onBlur={() => {
                        setIsTyping(false);
                        const node = blocksRef.current.get(b.id);
                        if (node) updateBlockText(b.id, node.textContent ?? "");
                      }}
                      onInput={() => {
                        const node = blocksRef.current.get(b.id);
                        if (!node) return;
                        if (sheetPaginatingRef.current) return;

                        const fullText = node.textContent ?? "";
                        updateBlockText(b.id, fullText);
                        markTyping();

                        // Auto-pagination: when the page is "full", create a new one below and move overflow text.
                        // Only trigger when typing at the end to avoid surprising reflows while editing earlier content.
                        const caret = getCaretOffsetInElement(node);
                        const atEnd = caret >= Math.max(0, (fullText.length || 0) - 1);
                        const groupId = b.groupId || `group-${makeId()}`;
                        const pages = (blocksStateRef.current || []).filter(
                          (bb) => (bb.kind || "text") === "sheet" && (bb.groupId || null) === groupId
                        );
                        const maxY = pages.reduce((m, bb) => Math.max(m, bb?.y ?? 0), -Infinity);
                        const isLastPage = (b.y ?? 0) >= (Number.isFinite(maxY) ? maxY : (b.y ?? 0));

                        // Only paginate while typing at end, and only on the last page in the doc.
                        if (atEnd && isLastPage && (b.style?.paginate ?? true)) {
                          const widthPx = node.clientWidth;
                          const heightPx = node.clientHeight;
                          const fitsPage = measureSheetTextFits({ text: fullText, widthPx, heightPx, sampleEl: node });
                          if (!fitsPage) {
                            const existingPages = pages.length;
                            if (existingPages >= 300) {
                              // Page limit reached: stop paginating and allow internal scroll on this last page.
                              updateBlock(b.id, { groupId, style: { ...(b.style || {}), paginate: false } });
                              return;
                            }

                            sheetPaginatingRef.current = true;
                            try {
                              const wBricks = Number.isFinite(b.widthBricks) ? Math.max(8, Math.floor(b.widthBricks)) : defaultBlockWidthBricks;
                              const hBricks = Number.isFinite(b.heightBricks) ? Math.max(6, Math.floor(b.heightBricks)) : Math.max(12, Math.round(1056 / brickHeight));
                              const gap = brickHeight; // 1-brick gap
                              const maxNewPages = 300 - existingPages;

                              // Split into as many fixed pages as needed (handles big paste).
                              const chunks = [];
                              let remaining = fullText;
                              for (let i = 0; i < maxNewPages + 1; i += 1) {
                                const fits = measureSheetTextFits({ text: remaining, widthPx, heightPx, sampleEl: node });
                                if (fits) {
                                  chunks.push(remaining);
                                  remaining = "";
                                  break;
                                }

                                // Find largest prefix that fits.
                                let lo = 0;
                                let hi = remaining.length;
                                while (lo < hi) {
                                  const mid = Math.ceil((lo + hi) / 2);
                                  const ok = measureSheetTextFits({ text: remaining.slice(0, mid), widthPx, heightPx, sampleEl: node });
                                  if (ok) lo = mid;
                                  else hi = mid - 1;
                                }
                                let split = Math.max(0, Math.min(remaining.length, lo));
                                if (split >= remaining.length) split = Math.max(0, remaining.length - 1);
                                const nl = remaining.lastIndexOf("\n", Math.max(0, split - 1));
                                if (nl >= 0 && nl + 1 > 0 && nl + 1 < remaining.length) split = nl + 1;
                                if (split <= 0 && remaining.length > 0) split = 1;

                                chunks.push(remaining.slice(0, split));
                                remaining = remaining.slice(split);

                                if (remaining.length === 0) break;
                                // If we've reached the last allowed page, stop paginating further.
                                if (i >= maxNewPages - 1) break;
                              }

                              // If we still have remaining overflow beyond page limit, make the last page scroll.
                              const hitLimitWithOverflow = remaining.length > 0 && existingPages + chunks.length >= 300;
                              if (hitLimitWithOverflow) {
                                // Keep everything in current page and allow scroll (no infinite loop).
                                updateBlock(b.id, { groupId, style: { ...(b.style || {}), paginate: false } });
                                return;
                              }

                              const first = chunks[0] ?? "";
                              const rest = chunks.slice(1);

                              // Update current page to the first chunk.
                              node.textContent = first;
                              updateBlockText(b.id, first);

                              // Create additional pages underneath for remaining chunks.
                              if (rest.length) {
                                const startY = b.y ?? 0;
                                const baseX = b.x ?? 0;
                                const newBlocks = rest.map((textChunk, idx) => {
                                  const idNew = makeId();
                                  const y = startY + (hBricks * brickHeight + gap) * (idx + 1);
                                  const snapped = snapPos(baseX, y);
                                  return v2ToInternalBlock(
                                    {
                                      id: idNew,
                                      type: "SheetBlock",
                                      groupId,
                                      x: snapped.x,
                                      y: snapped.y,
                                      width: wBricks,
                                      height: hBricks,
                                      content: { text: textChunk },
                                      style: { format: "sheet", paginate: true },
                                    },
                                    defaultBlockWidthBricks
                                  );
                                });

                                const last = newBlocks[newBlocks.length - 1];
                                setBlocks((prev) => {
                                  const next = [
                                    ...prev.map((bb) => (bb.id === b.id ? applyInternalPatch(bb, { groupId }, defaultBlockWidthBricks) : bb)),
                                    ...newBlocks,
                                  ];
                                  emit(next);
                                  return next;
                                });
                                setActiveId(last.id);
                                requestAnimationFrame(() => {
                                  focusBlock(last.id, { caretToEnd: true });
                                  try {
                                    containerRef.current?.scrollTo?.({
                                      top: Math.max(0, (last.y ?? 0) - brickHeight * 2),
                                      left: Math.max(0, (last.x ?? 0) - brickWidth * 2),
                                    });
                                  } catch {
                                    // ignore
                                  }
                                });
                              }
                            } finally {
                              setTimeout(() => {
                                sheetPaginatingRef.current = false;
                              }, 0);
                            }
                          }
                        }

                        if (slash.open && slash.blockId === b.id && slash.anchorOffset != null) {
                          const caret = getCaretOffsetInElement(node);
                          const text = node.textContent ?? "";
                          const raw = text.slice(slash.anchorOffset + 1, Math.max(slash.anchorOffset + 1, caret));
                          const filter = raw.match(/^[^\s]*/)?.[0] ?? "";
                          setSlash((s) => ({ ...s, filter, selectedIndex: 0 }));
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key.length === 1 || e.key === "Backspace" || e.key === "Enter" || e.key.startsWith("Arrow")) {
                          markTyping();
                        }

                        const node = blocksRef.current.get(b.id);
                        if (!node) return;

                        if (e.key === "/" && !slash.open) {
                          requestAnimationFrame(() => {
                            const node = blocksRef.current.get(b.id);
                            if (!node) return;
                            const caret = getCaretOffsetInElement(node);
                            const anchorOffset = Math.max(0, caret - 1);
                            setSlash((s) => ({
                              ...s,
                              open: true,
                              filter: "",
                              selectedIndex: 0,
                              mode: "insert",
                              blockId: b.id,
                              anchorOffset,
                            }));
                            const sel = window.getSelection();
                            const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
                            const rect = range?.getBoundingClientRect?.();
                            if (rect) {
                              openSlashMenuAt(e.currentTarget, rect);
                            } else {
                              const containerRect = containerRef.current?.getBoundingClientRect();
                              const top = (containerRect?.top ?? 0) + (b.y - (containerRef.current?.scrollTop ?? 0));
                              const left = (containerRect?.left ?? 0) + b.x;
                              openSlashMenuAt(e.currentTarget, { top, left });
                            }
                          });
                          return;
                        }

                        if (slash.open && slash.blockId === b.id) {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            closeSlash();
                            return;
                          }
                          if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setSlash((s) => ({ ...s, selectedIndex: Math.max(0, s.selectedIndex - 1) }));
                            return;
                          }
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setSlash((s) => ({ ...s, selectedIndex: s.selectedIndex + 1 }));
                            return;
                          }
                          if (e.key === "Enter") {
                            e.preventDefault();
                            document.dispatchEvent(new Event("slash-enter"));
                            return;
                          }
                          if (e.key.length === 1 && /\s/.test(e.key)) {
                            closeSlash();
                            return;
                          }
                          if (e.key.length === 1 || e.key === "Backspace") {
                            requestAnimationFrame(() => {
                              const node = blocksRef.current.get(b.id);
                              if (!node) return;
                              const caret = getCaretOffsetInElement(node);
                              const text = node.textContent ?? "";
                              const anchor = slash.anchorOffset ?? 0;
                              const raw = text.slice(anchor + 1, Math.max(anchor + 1, caret));
                              const filter = raw.match(/^[^\s]*/)?.[0] ?? "";
                              setSlash((s) => ({ ...s, filter, selectedIndex: 0 }));
                            });
                          }
                        }
                      }}
                    />
                  </div>
                </div>
              </div>
            );
          }
          if (kind === "spreadsheet") {
            const w = getBlockWidth(b);
            const h = getBlockHeight(b);
            const isSelected = activeId === b.id;
            const sheet = b.sheet || { version: 1, rows: 30, cols: 20, colWidths: Array.from({ length: 20 }, () => 96), cells: {} };

            return (
              <div
                key={b.id}
                data-brick-block
                className="absolute"
                style={{ left: `${b.x}px`, top: `${b.y}px`, width: `${w}px`, height: `${h}px`, ...(multiSelectedStyle || {}) }}
                onPointerDownCapture={(e) => onBlockPointerDownCapture(e, b.id)}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setActiveId(b.id);
                }}
                onContextMenu={(e) => openBlockContextMenu(e, b.id)}
              >
                <div className="w-full h-full glass-block overflow-hidden relative">
                  {/* tiny drag strip (no permanent toolbar) */}
                  <div
                    className={`w-full ${isSelected ? "cursor-grab active:cursor-grabbing" : "cursor-default"}`}
                    style={{ height: "8px" }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setActiveId(b.id);
                      dragRef.current = { id: b.id, startClientX: e.clientX, startClientY: e.clientY, originX: b.x, originY: b.y, widthPx: w };
                    }}
                    title={isSelected ? "Drag to move" : undefined}
                  />

                  <div className="w-full" style={{ height: `calc(100% - 8px)` }}>
                    <SpreadsheetBlock
                      sheet={sheet}
                      rows={sheet.rows || 30}
                      cols={sheet.cols || 20}
                      rowHeight={brickHeight}
                      isSelected={isSelected}
                      onRequestFocus={() => setActiveId(b.id)}
                      onSheetChange={(nextSheet) => updateBlock(b.id, { sheet: nextSheet })}
                      autoFocus={spreadsheetAutoFocusId === b.id}
                      onDidAutoFocus={() => {
                        if (spreadsheetAutoFocusId === b.id) setSpreadsheetAutoFocusId(null);
                      }}
                    />
                  </div>

                  {/* resize handle (only when selected) */}
                  {isSelected && (
                    <>
                      {/* bottom edge handle: add/remove rows */}
                      <div
                        className="absolute bottom-0 left-1/2 -translate-x-1/2 z-30 w-16 h-3 cursor-ns-resize"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          resizeRef.current = {
                            id: b.id,
                            mode: "height",
                            startClientX: e.clientX,
                            startClientY: e.clientY,
                            originWidthPx: w,
                            originHeightPx: h,
                          };
                        }}
                        title="Drag to add rows"
                      />
                    <div
                      data-resize-handle
                      className="absolute bottom-1 right-1 z-30 w-4 h-4 bg-black/20 dark:bg-white/20 rounded cursor-nwse-resize"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        resizeRef.current = {
                          id: b.id,
                          mode: "free",
                          startClientX: e.clientX,
                          startClientY: e.clientY,
                          originWidthPx: w,
                          originHeightPx: h,
                        };
                      }}
                      title="Drag to resize"
                    />
                    </>
                  )}
                </div>
              </div>
            );
          }
          if (kind === "design") {
            const w = getBlockWidth(b);
            const h = getBlockHeight(b);
            const isSelected = activeId === b.id;
            const board = b.board || { version: 1, elements: [], tool: "pen", color: "#111827", shape: "rect" };

            return (
              <div
                key={b.id}
                data-brick-block
                className="absolute"
                style={{ left: `${b.x}px`, top: `${b.y}px`, width: `${w}px`, height: `${h}px`, ...(multiSelectedStyle || {}) }}
                onPointerDownCapture={(e) => onBlockPointerDownCapture(e, b.id)}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setActiveId(b.id);
                }}
                onContextMenu={(e) => openBlockContextMenu(e, b.id)}
              >
                <div className={`w-full h-full overflow-hidden rounded-lg ${isSelected ? "border border-black/20 dark:border-white/20" : ""} relative`}>
                  {/* tiny drag strip */}
                  <div
                    className={`w-full ${isSelected ? "cursor-grab active:cursor-grabbing" : "cursor-default"}`}
                    style={{ height: "8px" }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setActiveId(b.id);
                      dragRef.current = { id: b.id, startClientX: e.clientX, startClientY: e.clientY, originX: b.x, originY: b.y, widthPx: w };
                    }}
                    title={isSelected ? "Drag to move" : undefined}
                  />
                  <div className="w-full" style={{ height: `calc(100% - 8px)` }}>
                    <DesignBoardBlock
                      board={board}
                      width={w}
                      height={h - 8}
                      isSelected={isSelected}
                      onRequestFocus={() => setActiveId(b.id)}
                      onExitFocus={() => setActiveId(null)}
                      onBoardChange={(nextBoard) => updateBlock(b.id, { board: nextBoard })}
                    />
                  </div>
                  {isSelected && (
                    <div
                      data-resize-handle
                      className="absolute bottom-1 right-1 z-30 w-4 h-4 bg-black/20 dark:bg-white/20 rounded cursor-nwse-resize"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        resizeRef.current = {
                          id: b.id,
                          mode: "free",
                          startClientX: e.clientX,
                          startClientY: e.clientY,
                          originWidthPx: w,
                          originHeightPx: h,
                        };
                      }}
                      title="Drag to resize"
                    />
                  )}
                </div>
              </div>
            );
          }
          if (kind === "youtube") {
            const w = getBlockWidth(b);
            const h = getBlockHeight(b);
            return (
              <div
                key={b.id}
                data-brick-block
                className="absolute group"
                style={{
                  left: `${b.x}px`,
                  top: `${b.y}px`,
                  width: `${w}px`,
                  height: `${h}px`,
                  ...(multiSelectedStyle || {}),
                }}
                onPointerDownCapture={(e) => onBlockPointerDownCapture(e, b.id)}
                onPointerDown={(e) => {
                  // Prevent canvas click handlers from firing
                  e.stopPropagation();
                }}
                onContextMenu={(e) => openBlockContextMenu(e, b.id)}
              >
                {/* Simple delete button */}
                {/* Drag bar so iframe doesn't steal pointer events */}
                <div
                  className="absolute inset-x-0 top-0 h-10 z-20 bg-white/22 dark:bg-white/8 backdrop-blur-xl border-b border-white/18 dark:border-white/10 cursor-grab active:cursor-grabbing rounded-t-[6px]"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    try {
                      e.currentTarget.setPointerCapture?.(e.pointerId);
                    } catch {
                      // ignore
                    }
                    dragRef.current = { id: b.id, startClientX: e.clientX, startClientY: e.clientY, originX: b.x, originY: b.y, widthPx: w };
                  }}
                  title="Drag to move"
                />
                {/* Simple delete button (centered in the top-right of the header bar) */}
                <button
                  type="button"
                  className="absolute top-0 right-0 z-40 w-9 h-9 m-0.5 flex items-center justify-center text-gray-800 hover:text-gray-950 dark:text-gray-100 dark:hover:text-white opacity-0 group-hover:opacity-100 transition-opacity text-2xl leading-none rounded-lg bg-white/35 hover:bg-white/55 dark:bg-white/10 dark:hover:bg-white/16 backdrop-blur-xl border border-white/25 dark:border-white/10 shadow-sm shadow-black/5"
                  title="Remove video"
                  aria-label="Remove video"
                  onPointerDown={(e) => {
                    // Don't start drag/resize when clicking the button
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeBlock(b.id);
                  }}
                >
                  ×
                </button>
                <div className="absolute inset-0 pt-10">
                  <div className="w-full h-full overflow-hidden glass-block">
                    <YouTubeEmbedAny url={b.media?.url} videoId={b.media?.videoId} className="w-full h-full" />
                  </div>
                </div>
                <div
                  data-resize-handle
                  className="absolute bottom-1 right-1 z-30 w-4 h-4 bg-black/20 dark:bg-white/20 rounded cursor-nwse-resize opacity-0 group-hover:opacity-100 transition-opacity"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    resizeRef.current = { id: b.id, startClientX: e.clientX, originWidthPx: w, aspect: 16 / 9 };
                  }}
                  title="Drag to resize"
                />
              </div>
            );
          }

          if (kind === "list") {
            const w = getBlockWidth(b);
            const h = getBlockHeight(b);
            const listType = b.listType || b.content?.listType || "bulleted";
            const items = Array.isArray(b.items) ? b.items : (Array.isArray(b.content?.items) ? b.content.items : []);
            const listTextStyle = {
              fontFamily,
              fontSize,
              lineHeight,
              letterSpacing,
              paddingLeft: "8px",
              paddingRight: "8px",
              paddingTop: "6px",
              paddingBottom: "6px",
            };

            return (
              <div
                key={b.id}
                data-brick-block
                className="absolute group"
                style={{ left: `${b.x}px`, top: `${b.y}px`, width: `${w}px`, height: `${h}px`, ...(multiSelectedStyle || {}) }}
                onPointerDownCapture={(e) => onBlockPointerDownCapture(e, b.id)}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setActiveId(b.id);
                  // If click is on the block chrome (not a row), focus first item.
                  const target = e.target;
                  const isRowEditor = target instanceof HTMLElement && target.closest?.("[data-list-item-editor]");
                  const isCheckbox = target instanceof HTMLInputElement && target.type === "checkbox";
                  if (!isRowEditor && !isCheckbox) {
                    const first = items[0];
                    if (first?.id) focusListItem(b.id, first.id, { caretToStart: true });
                  }
                }}
                onContextMenu={(e) => openBlockContextMenu(e, b.id)}
              >
                {/* Drag handle strip */}
                <div
                  className="absolute inset-x-0 top-0 h-3 z-30 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    setActiveId(b.id);
                    try {
                      e.currentTarget.setPointerCapture?.(e.pointerId);
                    } catch {
                      // ignore
                    }
                    dragRef.current = {
                      id: b.id,
                      startClientX: e.clientX,
                      startClientY: e.clientY,
                      originX: b.x,
                      originY: b.y,
                      widthPx: w,
                    };
                  }}
                  title="Drag to move"
                />

                <div className="glass-text-card w-full text-foreground" style={{ minHeight: `${brickHeight}px` }}>
                  <div className="brick-list-scroll w-full" style={listTextStyle}>
                    {items.map((it, idx) => {
                      const key = `${b.id}:${it.id}`;
                      return (
                        <div key={it.id} className="brick-list-row flex items-start gap-2" style={{ minHeight: lineHeight }}>
                          <div className="brick-list-marker shrink-0" aria-hidden style={{ minHeight: lineHeight }}>
                            {listType === "todo" ? (
                              <input
                                type="checkbox"
                                className="brick-todo-checkbox"
                                checked={Boolean(it.checked)}
                                onChange={(e) => {
                                  const checked = e.currentTarget.checked;
                                  updateListBlock(b.id, (prev) =>
                                    prev.map((p) => (p.id === it.id ? { ...p, checked } : p))
                                  );
                                }}
                                onPointerDown={(e) => e.stopPropagation()}
                              />
                            ) : listType === "numbered" ? (
                              <span className="brick-number-label select-none">{idx + 1}.</span>
                            ) : (
                              <span className="brick-bullet-label select-none">•</span>
                            )}
                          </div>

                          <div
                            data-list-item-editor
                            ref={(node) => {
                              if (node) {
                                listItemRefs.current.set(key, node);
                                // Keep DOM text synced from state when not focused (avoids "messed up" splits/merges).
                                if (document.activeElement !== node) {
                                  const next = it.text ?? "";
                                  if ((node.textContent ?? "") !== next) node.textContent = next;
                                }
                              } else {
                                listItemRefs.current.delete(key);
                              }
                            }}
                            contentEditable
                            suppressContentEditableWarning
                            spellCheck={false}
                            className={cn(
                              "brick-list-item outline-none whitespace-pre text-foreground flex-1 min-w-0",
                              listType === "todo" && it.checked ? "brick-todo-done" : ""
                            )}
                            style={{
                              fontFamily: "inherit",
                              fontSize: "inherit",
                              lineHeight: "inherit",
                              letterSpacing: "inherit",
                              minHeight: lineHeight,
                            }}
                            onFocus={() => {
                              setActiveId(b.id);
                              closeSlash();
                            }}
                            onInput={(e) => {
                              const el = e.currentTarget;
                              const nextText = normalizeNewlines(el.textContent ?? "").replace(/\n$/, "");
                              updateListBlock(b.id, (prev) => prev.map((p) => (p.id === it.id ? { ...p, text: nextText } : p)));

                              // Auto-grow width like TextBlock (based on current row).
                              const currentBricks = Number.isFinite(b.widthBricks) ? Math.max(1, Math.floor(b.widthBricks)) : 1;
                              const extraPx = 2; // borders
                              const markerPx = 22 + 8; // marker column + gap
                              const desiredPx = (el.scrollWidth || 0) + markerPx + extraPx + 16; // padding
                              let desiredBricks = Math.max(1, Math.ceil(desiredPx / brickWidth));
                              if (containerSize.width) {
                                const maxBricksRight = Math.max(1, Math.floor((containerSize.width - (b.x ?? 0)) / brickWidth));
                                desiredBricks = Math.min(desiredBricks, maxBricksRight);
                              }
                              if (desiredBricks > currentBricks) updateBlock(b.id, { widthBricks: desiredBricks });
                            }}
                            onKeyDown={(e) => {
                              const el = e.currentTarget;
                              const caret = getCaretOffsetInElement(el);
                              const currentText = normalizeNewlines(el.textContent ?? "").replace(/\n$/, "");

                              // Enter: split item or exit list if empty.
                              if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                const isEmpty = currentText.length === 0;

                                if (isEmpty) {
                                  const remaining = items.filter((p) => p.id !== it.id);
                                  const groupId = b.groupId || `group-${makeId()}`;
                                  const idNew = makeId();

                                  setBlocks((prev) => {
                                    const next = [];
                                    for (const bb of prev) {
                                      if (bb.id !== b.id) {
                                        next.push(bb);
                                        continue;
                                      }

                                      // If this was the last item: replace the list with a TextBlock (still "linked" via groupId).
                                      if (items.length <= 1) {
                                        const snapped = snapPos(bb.x ?? 0, bb.y ?? 0);
                                        next.push(
                                          v2ToInternalBlock(
                                            {
                                              id: idNew,
                                              type: "TextBlock",
                                              groupId,
                                              x: snapped.x,
                                              y: snapped.y,
                                              width: Math.max(1, Math.floor(b.widthBricks || 8)),
                                              height: 1,
                                              content: { text: "" },
                                              style: { format: "p" },
                                            },
                                            defaultBlockWidthBricks
                                          )
                                        );
                                        continue;
                                      }

                                      // Keep list (minus empty row) and create a new TextBlock below it.
                                      const heightBricks = computeListHeightBricks(remaining);
                                      const updatedList = applyInternalPatch(
                                        bb,
                                        { type: "ListBlock", listType, items: remaining, heightBricks, groupId },
                                        defaultBlockWidthBricks
                                      );
                                      next.push(updatedList);

                                      const belowY = (bb.y ?? 0) + heightBricks * brickHeight;
                                      const snapped = snapPos(bb.x ?? 0, belowY);
                                      next.push(
                                        v2ToInternalBlock(
                                          {
                                            id: idNew,
                                            type: "TextBlock",
                                            groupId,
                                            x: snapped.x,
                                            y: snapped.y,
                                            width: Math.max(1, Math.floor(b.widthBricks || 8)),
                                            height: 1,
                                            content: { text: "" },
                                            style: { format: "p" },
                                          },
                                          defaultBlockWidthBricks
                                        )
                                      );
                                    }
                                    emit(next);
                                    return next;
                                  });

                                  focusBlock(idNew, { caretToStart: true });
                                  return;
                                }

                                const left = currentText.slice(0, caret);
                                const right = currentText.slice(caret);
                                // Immediately reflect left part in the current editor (state update + rerender comes after).
                                el.textContent = left;

                                const idNext = makeId();
                                updateListBlock(b.id, (prev) => {
                                  const next = [];
                                  for (let i = 0; i < prev.length; i++) {
                                    const p = prev[i];
                                    if (p.id === it.id) {
                                      next.push({ ...p, text: left });
                                      next.push(listType === "todo" ? { id: idNext, text: right, checked: false } : { id: idNext, text: right });
                                    } else {
                                      next.push(p);
                                    }
                                  }
                                  return next;
                                });

                                focusListItem(b.id, idNext, { caretToStart: true });
                                return;
                              }

                              // Shift+Enter: line break inside item.
                              if (e.key === "Enter" && e.shiftKey) {
                                e.preventDefault();
                                const nextText = insertTextAtOffset(currentText, caret, "\n");
                                updateListBlock(b.id, (prev) => prev.map((p) => (p.id === it.id ? { ...p, text: nextText } : p)));
                                requestAnimationFrame(() => {
                                  // Keep caret after the inserted newline.
                                  setCaretOffsetInElement(el, caret + 1);
                                });
                                return;
                              }

                              // Backspace at start: merge into previous or exit if only empty item.
                              if (e.key === "Backspace") {
                                const sel = window.getSelection();
                                const isCollapsed = !sel || sel.isCollapsed;
                                if (isCollapsed && caret === 0) {
                                  e.preventDefault();
                                  const prevItem = items[idx - 1] || null;

                                  // Only one empty item → replace list with TextBlock.
                                  if (!prevItem && items.length === 1 && currentText.length === 0) {
                                    const idNew = makeId();
                                    const x = b.x ?? 0;
                                    const y = b.y ?? 0;
                                    setBlocks((prev) => {
                                      const next = prev
                                        .filter((bb) => bb.id !== b.id)
                                        .concat(
                                          v2ToInternalBlock(
                                            {
                                              id: idNew,
                                              type: "TextBlock",
                                              x,
                                              y,
                                              width: Math.max(1, Math.floor(b.widthBricks || 8)),
                                              height: 1,
                                              content: { text: "" },
                                              style: { format: "p" },
                                            },
                                            defaultBlockWidthBricks
                                          )
                                        );
                                      emit(next);
                                      return next;
                                    });
                                    focusBlock(idNew, { caretToStart: true });
                                    return;
                                  }

                                  if (prevItem?.id) {
                                    const mergePoint = String(prevItem.text ?? "").length;
                                    const merged = `${String(prevItem.text ?? "")}${currentText}`;
                                    // Immediately reflect merged text in the previous editor before focusing it.
                                    const prevEl = listItemRefs.current.get(`${b.id}:${prevItem.id}`);
                                    if (prevEl && document.activeElement !== prevEl) prevEl.textContent = merged;
                                    updateListBlock(b.id, (prev) => {
                                      const next = prev
                                        .map((p) => (p.id === prevItem.id ? { ...p, text: merged } : p))
                                        .filter((p) => p.id !== it.id);
                                      return next;
                                    });
                                    focusListItem(b.id, prevItem.id, { caretToEnd: true });
                                    requestAnimationFrame(() => setCaretOffsetInElement(listItemRefs.current.get(`${b.id}:${prevItem.id}`), mergePoint));
                                  }
                                  return;
                                }
                              }

                              // ArrowUp/ArrowDown basic navigation between items.
                              if (e.key === "ArrowUp" && caret === 0 && idx > 0) {
                                e.preventDefault();
                                focusListItem(b.id, items[idx - 1].id, { caretToEnd: true });
                                return;
                              }
                              if (e.key === "ArrowDown" && caret === currentText.length && idx < items.length - 1) {
                                e.preventDefault();
                                focusListItem(b.id, items[idx + 1].id, { caretToStart: true });
                                return;
                              }
                            }}
                          />
                        </div>
                      );
                    })}

                  </div>
                </div>
              </div>
            );
          }

          const format = b.format || "p";
          const fmtStyle = getTextBlockStyle(format, fontSize, brickHeight);

          return (
            <div
              key={b.id}
              data-brick-block
              className="absolute group"
              style={{
                left: `${b.x}px`,
                top: `${b.y}px`,
                width: `${getBlockWidth(b)}px`,
                minHeight: format === "code" ? `${(b.heightBricks || 4) * brickHeight}px` : `${brickHeight}px`,
                height: format === "code" ? `${(b.heightBricks || 4) * brickHeight}px` : undefined,
                ...(multiSelectedStyle || {}),
              }}
              onPointerDownCapture={(e) => onBlockPointerDownCapture(e, b.id)}
              onContextMenu={(e) => openBlockContextMenu(e, b.id)}
            >
              {/* Drag handle strip (so text selection doesn't accidentally start dragging) */}
              <div
                className="absolute inset-x-0 top-0 h-3 z-30 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setActiveId(b.id);
                  try {
                    e.currentTarget.setPointerCapture?.(e.pointerId);
                  } catch {
                    // ignore
                  }
                  dragRef.current = {
                    id: b.id,
                    startClientX: e.clientX,
                    startClientY: e.clientY,
                    originX: b.x,
                    originY: b.y,
                    widthPx: getBlockWidth(b),
                  };
                }}
                title="Drag to move"
              />

              {/* Code blocks: Notion-style code editor */}
              {format === "code" ? (
                <CodeBlock
                  block={b}
                  brickHeight={brickHeight}
                  brickWidth={brickWidth}
                  fontSize={fontSize}
                  blocksRef={blocksRef}
                  updateBlock={updateBlock}
                  updateBlockText={updateBlockText}
                  removeBlock={removeBlock}
                  setActiveId={setActiveId}
                  closeSlash={closeSlash}
                  setIsTyping={setIsTyping}
                  markTyping={markTyping}
                  slash={slash}
                  setSlash={setSlash}
                  openSlashMenuAt={openSlashMenuAt}
                  containerRef={containerRef}
                  containerSize={containerSize}
                  getCaretOffsetInElement={getCaretOffsetInElement}
                  setCaretOffsetInElement={setCaretOffsetInElement}
                  fmtStyle={fmtStyle}
                  letterSpacing={letterSpacing}
                />
              ) : (
                /* Text blocks: exactly brick-shaped (no extra padding; same corner feel as bricks) */
                <div className="glass-text-card" style={{ minHeight: `${brickHeight}px` }}>
                  <div
                    ref={(node) => {
                      if (node) {
                        blocksRef.current.set(b.id, node);
                        // TextBlocks are plain rich-text later; for now keep plain text only.
                        // Lists are rendered as ListBlocks (marker is not part of editable text).
                          setNodeTextOnce(node, b.text);
                      } else {
                        blocksRef.current.delete(b.id);
                      }
                    }}
                    contentEditable
                    suppressContentEditableWarning
                    spellCheck={false}
                  onFocus={() => {
                    setActiveId(b.id);
                    closeSlash();
                    setIsTyping(false);
                  }}
                  onPointerUp={() => {
                    // Clicking a question line should reopen its saved AI answer (if any).
                    const node = blocksRef.current.get(b.id);
                    if (!node) return;
                    const caretRaw = getCaretOffsetInElement(node);
                    const mapped = getEditableTextWithNewlinesAndMapOffsets(node, [caretRaw]);
                    const text = mapped.text ?? "";
                    const caret = mapped.mapOffset(caretRaw);
                    const ls = getLineStart(text, caret);
                    const le = getLineEnd(text, caret);
                    const line = String(text.slice(ls, le)).trim();
                    const saved = getSavedAnswerEntryFor(b.id, line);
                    if (!saved?.a) return;
                    const rect = getClientRectAtCharOffset(node, caretRaw);
                    const blockRect = node.closest?.(".glass-text-card")?.getBoundingClientRect?.() || null;
                    openAnswerPanelFor(b.id, line, { answer: saved.a, isLoading: false, anchorRect: rect, blockRect, savedPanel: saved.panel });
                  }}
                  onBlur={() => {
                    setIsTyping(false);
                    const node = blocksRef.current.get(b.id);
                    if (node) {
                      const mapped = getEditableTextWithNewlinesAndMapOffsets(node, []);
                      updateBlockText(b.id, mapped.text ?? "");
                    }
                    // Remove empty text blocks so they don't leave invisible "dead zones" on the canvas.
                    // Only remove after blur (so user can still click in and start typing).
                    requestAnimationFrame(() => {
                      const node = blocksRef.current.get(b.id);
                      const mapped = node ? getEditableTextWithNewlinesAndMapOffsets(node, []) : { text: "" };
                      const text = String(mapped.text ?? "").trim();
                      if (text.length === 0) {
                        removeBlock(b.id);
                      }
                    });
                  }}
                  onInput={(e) => {
                        const node = blocksRef.current.get(b.id);
                    if (!node) return;

                    const caretRaw = getCaretOffsetInElement(node);
                    const mapped = getEditableTextWithNewlinesAndMapOffsets(node, [caretRaw]);
                    const text = mapped.text ?? "";
                    const caret = mapped.mapOffset(caretRaw);
                          updateBlockText(b.id, text);

                    // Creation rules (Notion-like): typing "- " or "1. " at the start converts to a ListBlock.
                    // We trigger exactly when the user finishes the marker (caret right after the space).
                    const singleLine = !text.includes("\n");
                    if (singleLine && caretRaw === 2 && text.startsWith("- ")) {
                      const itemText = text.slice(2);
                      const item = makeListItem("bulleted", itemText);
                      const heightBricks = computeListHeightBricks([item]);
                      updateBlock(b.id, { type: "ListBlock", listType: "bulleted", items: [item], heightBricks, style: {} });
                      focusListItem(b.id, item.id, { caretToStart: true });
                      return;
                    }
                    if (singleLine && caretRaw === 3 && text.startsWith("1. ")) {
                      const itemText = text.slice(3);
                      const item = makeListItem("numbered", itemText);
                      const heightBricks = computeListHeightBricks([item]);
                      updateBlock(b.id, { type: "ListBlock", listType: "numbered", items: [item], heightBricks, style: {} });
                      focusListItem(b.id, item.id, { caretToStart: true });
                      return;
                    }
                    markTyping();

                    // AI autopilot: after the user stops typing, read what they wrote and either answer or perform actions.
                    // No keywords required; the model decides whether it should respond/do something.
                    if (!slash.open) {
                      if (Date.now() < (aiBackoffUntilRef.current || 0)) {
                        // Temporarily backing off (rate limit / quota); don't schedule new AI calls.
                      } else {
                      const caretLine = (() => {
                        const ls = getLineStart(text, caret);
                        const le = getLineEnd(text, caret);
                        return String(text.slice(ls, le)).trim();
                      })();

                      // IMPORTANT: respond to the latest non-empty line in the block (most users type "one message per line").
                      // This avoids getting "stuck" responding to an earlier line if the caret mapping is off or the user clicked elsewhere.
                      const latestNonEmptyLine = (() => {
                        const lines = normalizeNewlines(text ?? "").split("\n");
                        for (let i = lines.length - 1; i >= 0; i -= 1) {
                          const t = String(lines[i] ?? "").trim();
                          if (t) return t;
                        }
                        return "";
                      })();

                      const canonicalMsg = (line) => normalizeAiPromptLine(extractFocusFromUserLine(line)).trim();
                      const caretMsg = canonicalMsg(caretLine);
                      const latestMsg = canonicalMsg(latestNonEmptyLine);

                      // Cancel any pending timer on ANY input, so we don't answer an older message
                      // after the user has continued typing.
                      const prevTimer = aiAnswerTimersRef.current.get(b.id);
                      if (prevTimer) clearTimeout(prevTimer);
                      aiAnswerTimersRef.current.delete(b.id);

                      // Prefer the line the user is actively editing; fall back to the latest non-empty line.
                      // Also avoid getting "stuck" re-answering the same already-sent message.
                      const lastSent = String(aiLastUserLineRef.current.get(b.id) || "");
                      let promptText = caretMsg;
                      if (!promptText) promptText = latestMsg;
                      if (promptText === lastSent && latestMsg && latestMsg !== lastSent) promptText = latestMsg;
                      if (promptText === lastSent && caretMsg && caretMsg !== lastSent) promptText = caretMsg;

                      const baseLineRaw = promptText ? (promptText === caretMsg ? caretLine : latestNonEmptyLine) : (latestNonEmptyLine || caretLine);
                      const baseLine = extractFocusFromUserLine(baseLineRaw);
                      const userLine = normalizeAiPromptLine(baseLine);
                      promptText = String(promptText || userLine || "").trim();
                      const existingThread = aiThreadByBlockRef.current.get(b.id) || null;
                      const existingThreadKey = existingThread?.key != null ? String(existingThread.key) : null;
                      const promptKey = promptText || baseLine || baseLineRaw || caretLine || userLine;
                      const anchorRect = getClientRectAtCharOffset(node, caretRaw);

                      if (promptText.length > 0) {
                        // If we're already asking the AI, just remember the latest prompt and we'll run again after.
                        if (aiInFlightRef.current.has(b.id)) {
                          aiQueuedPromptRef.current.set(b.id, promptText);
                        } else {
                          // Avoid re-sending the same exact prompt we already sent.
                          if (String(aiLastUserLineRef.current.get(b.id) || "") === promptText) {
                            // No-op
                          } else {
                            const t = setTimeout(async () => {
                              try {
                                aiInFlightRef.current.add(b.id);
                                // Mark as "sent" when the request actually starts.
                                aiLastUserLineRef.current.set(b.id, promptText);

                            // Thread per text block: keep context across follow-ups.
                            const threadKey = existingThreadKey || `thread:${b.id}`;
                            const thread = aiThreadByBlockRef.current.get(b.id) || { key: threadKey, messages: [] };
                            if (!thread.key) thread.key = threadKey;
                            if (!Array.isArray(thread.messages)) thread.messages = [];

                            // If the user is continuing in the same block, keep the thread key stable.
                            if (existingThreadKey) thread.key = existingThreadKey;

                            // Treat edits/continuations on the same line as updating the last USER message,
                            // not creating a new message (prevents "double answers" while composing).
                            const lastMsg = thread.messages.length ? thread.messages[thread.messages.length - 1] : null;
                            if (lastMsg && lastMsg.role === "user") {
                              lastMsg.content = promptText;
                            } else {
                              thread.messages.push({ role: "user", content: promptText });
                            }
                            // Keep thread bounded.
                            if (thread.messages.length > 20) thread.messages = thread.messages.slice(-20);
                            aiThreadByBlockRef.current.set(b.id, thread);

                            const canvas = summarizeBlocksForAI(blocksStateRef.current || [], { brickWidth, brickHeight, limit: 36 });
                            const blockBody = String((blocksStateRef.current || []).find((bb) => bb.id === b.id)?.text ?? text ?? "")
                              .trim()
                              .slice(0, 1600);

                            const convo = thread.messages
                              .slice(-10)
                              .map((m) => `${String(m?.role || "user").toUpperCase()}: ${String(m?.content || "").trim()}`)
                              .join("\n");

                            const prompt = [
                              "You are an assistant embedded in a block-based note canvas.",
                              "You can read ALL blocks on screen and you may create/update blocks using the allowed actions below.",
                              "",
                              "Return ONLY a JSON object (no markdown, no extra text) shaped like:",
                              '{ "shouldRespond": true|false, "assistant": "string", "actions": [ ... ] }',
                              "",
                              "Rules:",
                              '- Default to helping: if the user is asking anything, requesting anything, or writing something that could benefit from an explanation/next step, set "shouldRespond": true.',
                              '- Only set "shouldRespond": false when it is clearly just personal note-taking or an incomplete fragment and a response would be annoying.',
                              '- If you are unsure, set "shouldRespond": true with a short helpful clarification question.',
                              '- IMPORTANT: respond ONLY to the LATEST user message (the last USER line in the conversation). Do NOT re-answer older questions unless the latest user message explicitly asks you to.',
                              '- IMPORTANT: do NOT repeat or restate the user question/prompt. Answer directly (no "You asked...", no quoting the question).',
                              "",
                              "Supported actions (allowlist):",
                              '- { "type": "create_spreadsheet", "rows": 30, "cols": 20, "cells2d": [["Header A","Header B"],["A2","B2"]] }',
                              '- { "type": "create_spreadsheet", "rows": 30, "cols": 20, "cells": { "0,0": "Header" } }',
                              '- { "type": "update_spreadsheet", "target": "active", "cells2d": [["Name","Amount"],["Rent","1200"]], "startRow": 0, "startCol": 0 }',
                              '- { "type": "update_spreadsheet", "target": "last", "cells": { "0,0": "Header" } }',
                              '- { "type": "create_sheet" }',
                              '- { "type": "create_design_board" }',
                              '- { "type": "create_list", "listType": "todo", "items": [{ "text": "Task", "checked": false }] }',
                              '- { "type": "create_list", "listType": "bulleted", "items": ["One","Two"] }',
                              '- { "type": "create_list", "listType": "numbered", "items": ["First","Second"] }',
                              "",
                              "Canvas blocks:",
                              canvas || "(none)",
                              "",
                              "User's current text block:",
                              blockBody || "(empty)",
                              "",
                              "Conversation so far (most relevant, newest last):",
                              convo || "(none)",
                              "",
                              "Latest user message to answer (highest priority):",
                              promptText || "(empty)",
                            ].join("\n");

                            const raw = await callAI(prompt);
                            if (!raw) return;

                            const parsedObj = extractFirstJsonObject(raw);
                            const parsed = parsedObj || {};
                            const actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
                            const assistant = parsedObj ? String(parsed?.assistant ?? parsed?.answer ?? "").trim() : String(raw ?? "").trim();
                            const shouldRespond = Boolean(parsed?.shouldRespond) || actions.length > 0 || assistant.length > 0;

                            if (!shouldRespond || (actions.length === 0 && assistant.length === 0)) {
                              return;
                            }

                            // Append assistant message into the thread (so follow-ups can reference it).
                            const assistantText = dedupeAiAssistantText(
                              stripQuestionRestatement(stripEchoedQuestionPrefix(assistant || "Done.", promptText))
                            );
                            if (assistantText.trim().length) {
                              const lastMsg = thread.messages.length ? thread.messages[thread.messages.length - 1] : null;
                              if (lastMsg && lastMsg.role === "assistant") {
                                lastMsg.content = assistantText;
                              } else {
                                thread.messages.push({ role: "assistant", content: assistantText });
                              }
                              if (thread.messages.length > 20) thread.messages = thread.messages.slice(-20);
                              aiThreadByBlockRef.current.set(b.id, thread);
                            }

                            // Ensure the bubble is open; if it's already open for this block, reuse it (no new bubble).
                            const blockRect = node.closest?.(".glass-text-card")?.getBoundingClientRect?.() || null;
                            if (!aiAnswerPanel.open || aiAnswerPanel.blockId !== b.id) {
                              openAnswerPanelFor(b.id, promptKey || promptText, { answer: "", isLoading: false, anchorRect, blockRect });
                            }

                            // Apply actions to the canvas safely.
                            if (actions.length) {
                              const containerEl = containerRef.current;
                              const containerRect = containerEl?.getBoundingClientRect?.();
                              const anchorBlock = (blocksStateRef.current || []).find((bb) => bb.id === b.id) || b;
                              const cardEl = node?.closest?.(".glass-text-card");
                              const cardRect = cardEl?.getBoundingClientRect?.();
                              const scrollTop = containerEl?.scrollTop ?? 0;
                              const scrollLeft = containerEl?.scrollLeft ?? 0;

                              // Default insertion: directly under the current text block with a 1-brick gap.
                              const baseX = Number.isFinite(anchorBlock?.x) ? anchorBlock.x : (lastPointerRef.current.x ?? 0);
                              const baseY = (cardRect && containerRect && cardRect.bottom)
                                ? (cardRect.bottom - containerRect.top + scrollTop + brickHeight)
                                : ((Number.isFinite(anchorBlock?.y) ? anchorBlock.y : (lastPointerRef.current.y ?? 0)) + brickHeight * 2);

                              let cursor = snapPos(baseX, baseY);
                              const created = []; // { id, type, firstItemId? }

                              setBlocks((prev) => {
                                let next = prev.slice();
                                for (const act of actions) {
                                  const t = String(act?.type || "").toLowerCase();

                                      if (t === "update_spreadsheet") {
                                        const resolveTargetId = () => {
                                          const explicit = act?.blockId != null ? String(act.blockId) : null;
                                          if (explicit) return explicit;
                                          const target = String(act?.target || "").toLowerCase();
                                          if (target === "active" && activeId) {
                                            const bb = next.find((x) => x.id === activeId) || null;
                                            if (bb && (bb.kind || "text") === "spreadsheet") return bb.id;
                                          }
                                          if ((target === "last" || target === "latest") && lastAiSpreadsheetIdRef.current) return lastAiSpreadsheetIdRef.current;
                                          if (activeId) {
                                            const bb = next.find((x) => x.id === activeId) || null;
                                            if (bb && (bb.kind || "text") === "spreadsheet") return bb.id;
                                          }
                                          if (lastAiSpreadsheetIdRef.current) return lastAiSpreadsheetIdRef.current;
                                          const any = next.find((x) => (x.kind || "text") === "spreadsheet") || null;
                                          return any?.id || null;
                                        };

                                        const targetId = resolveTargetId();
                                        if (!targetId) continue;
                                        const idx = next.findIndex((x) => x.id === targetId);
                                        if (idx < 0) continue;
                                        const cur = next[idx];
                                        const curSheet = cur?.sheet || cur?.content?.sheet || { version: 1, rows: 30, cols: 20, colWidths: Array.from({ length: 20 }, () => 96), cells: {} };
                                        const curRows = clamp(Number(curSheet?.rows) || 30, 1, 60);
                                        const curCols = clamp(Number(curSheet?.cols) || 20, 1, 30);

                                        const nextRows = clamp(Number(act?.rows) || curRows, 1, 60);
                                        const nextCols = clamp(Number(act?.cols) || curCols, 1, 30);
                                        const startRow = clamp(Number(act?.startRow) || 0, 0, 59);
                                        const startCol = clamp(Number(act?.startCol) || 0, 0, 29);

                                        const nextCells = { ...(curSheet?.cells || {}) };

                                        // cells2d -> map (row-major from startRow/startCol)
                                        if (Array.isArray(act?.cells2d)) {
                                          for (let r = 0; r < Math.min(nextRows - startRow, act.cells2d.length); r += 1) {
                                            const rowArr = Array.isArray(act.cells2d[r]) ? act.cells2d[r] : [];
                                            for (let c = 0; c < Math.min(nextCols - startCol, rowArr.length); c += 1) {
                                              const v = rowArr[c];
                                              if (v == null) continue;
                                              const s = String(v);
                                              if (!s.trim().length) continue;
                                              nextCells[`${startRow + r},${startCol + c}`] = s;
                                            }
                                          }
                                        }

                                        // cells map -> copy (expects "r,c" keys)
                                        if (act?.cells && typeof act.cells === "object") {
                                          for (const k of Object.keys(act.cells)) {
                                            const v = act.cells[k];
                                            if (v == null) continue;
                                            const s = String(v);
                                            if (!s.trim().length) continue;
                                            nextCells[String(k)] = s;
                                          }
                                        }

                                        const defaultColW = 96;
                                        const colWidths = Array.isArray(curSheet?.colWidths)
                                          ? curSheet.colWidths.slice(0, nextCols).concat(Array.from({ length: Math.max(0, nextCols - curSheet.colWidths.length) }, () => defaultColW))
                                          : Array.from({ length: nextCols }, () => defaultColW);

                                        const mergedSheet = {
                                          version: 1,
                                          rows: nextRows,
                                          cols: nextCols,
                                          colWidths,
                                          cells: nextCells,
                                        };

                                        // Grow container height if rows increased (each row is 1 brick, plus header row).
                                        const heightBricks = nextRows + 1;
                                        next[idx] = applyInternalPatch(cur, { sheet: mergedSheet, heightBricks }, defaultBlockWidthBricks);
                                        created.push({ id: targetId, type: "SpreadsheetBlock" });
                                        lastAiSpreadsheetIdRef.current = targetId;
                                        continue;
                                      }

                                      if (t === "create_spreadsheet") {
                                        const rows = clamp(Number(act?.rows) || 30, 1, 60);
                                        const cols = clamp(Number(act?.cols) || 20, 1, 30);
                                        const defaultColW = 96;
                                        const cells = {};

                                        // cells2d -> map
                                        if (Array.isArray(act?.cells2d)) {
                                          for (let r = 0; r < Math.min(rows, act.cells2d.length); r += 1) {
                                            const rowArr = Array.isArray(act.cells2d[r]) ? act.cells2d[r] : [];
                                            for (let c = 0; c < Math.min(cols, rowArr.length); c += 1) {
                                              const v = rowArr[c];
                                              if (v == null) continue;
                                              const s = String(v);
                                              if (!s.trim().length) continue;
                                              cells[`${r},${c}`] = s;
                                            }
                                          }
                                        }
                                        // cells map -> copy
                                        if (act?.cells && typeof act.cells === "object") {
                                          for (const k of Object.keys(act.cells)) {
                                            const v = act.cells[k];
                                            if (v == null) continue;
                                            const s = String(v);
                                            if (!s.trim().length) continue;
                                            cells[String(k)] = s;
                                          }
                                        }

                                        const sheet = {
                                          version: 1,
                                          rows,
                                          cols,
                                          colWidths: Array.from({ length: cols }, () => defaultColW),
                                          cells,
                                        };

                                        const idNew = makeId();
                                        const snapped = cursor;
                                        const remainingPx = Math.max(brickWidth * 8, (containerSize.width || brickWidth * 16) - snapped.x);
                                        const widthBricks = Math.max(8, Math.round(remainingPx / brickWidth));
                                        const heightBricks = rows + 1;

                                        next = next.concat([
                                          v2ToInternalBlock(
                                            {
                                              id: idNew,
                                              type: "SpreadsheetBlock",
                                              x: snapped.x,
                                              y: snapped.y,
                                              width: widthBricks,
                                              height: heightBricks,
                                              content: { sheet },
                                              style: {},
                                            },
                                            defaultBlockWidthBricks
                                          ),
                                        ]);

                                        created.push({ id: idNew, type: "SpreadsheetBlock" });
                                        lastAiSpreadsheetIdRef.current = idNew;
                                        cursor = snapPos(snapped.x, snapped.y + heightBricks * brickHeight + brickHeight);
                                        continue;
                                      }

                                      if (t === "create_sheet") {
                                        const desiredPageWidthPx = 816;
                                        const desiredPageHeightPx = 1056;
                                        const maxViewportBricks = Math.max(8, Math.floor(((containerSize.width || desiredPageWidthPx) - brickWidth) / brickWidth));
                                        const widthBricks = Math.max(10, Math.min(Math.round(desiredPageWidthPx / brickWidth), maxViewportBricks));
                                        const heightBricks = Math.max(12, Math.round(desiredPageHeightPx / brickHeight));
                                        const groupId = anchorBlock?.groupId || `group-${makeId()}`;

                                        // Clamp x so the page fits in viewport when possible.
                                        const desiredWpx = widthBricks * brickWidth;
                                        const viewportW = containerSize.width || desiredWpx;
                                        const maxX = Math.max(0, scrollLeft + viewportW - desiredWpx);
                                        const x = clamp(cursor.x, 0, maxX);
                                        const snapped = snapPos(x, cursor.y);

                                        const idNew = makeId();
                                        next = next.concat([
                                          v2ToInternalBlock(
                                            {
                                              id: idNew,
                                              type: "SheetBlock",
                                              groupId,
                                              x: snapped.x,
                                              y: snapped.y,
                                              width: widthBricks,
                                              height: heightBricks,
                                              content: { text: "" },
                                              style: { format: "sheet", paginate: true },
                                            },
                                            defaultBlockWidthBricks
                                          ),
                                        ]);
                                        created.push({ id: idNew, type: "SheetBlock" });
                                        cursor = snapPos(snapped.x, snapped.y + heightBricks * brickHeight + brickHeight);
                                        continue;
                                      }

                                      if (t === "create_design_board") {
                                        const idNew = makeId();
                                        const widthPx = 600;
                                        const heightPx = 400;
                                        const widthBricks = Math.max(8, Math.round(widthPx / brickWidth));
                                        const heightBricks = Math.max(8, Math.round(heightPx / brickHeight));
                                        const board = { version: 1, elements: [], tool: "pen", color: "#111827", shape: "rect" };

                                        const snapped = cursor;
                                        next = next.concat([
                                          v2ToInternalBlock(
                                            {
                                              id: idNew,
                                              type: "DesignBlock",
                                              x: snapped.x,
                                              y: snapped.y,
                                              width: widthBricks,
                                              height: heightBricks,
                                              content: { board },
                                              style: {},
                                            },
                                            defaultBlockWidthBricks
                                          ),
                                        ]);
                                        created.push({ id: idNew, type: "DesignBlock" });
                                        cursor = snapPos(snapped.x, snapped.y + heightBricks * brickHeight + brickHeight);
                                        continue;
                                      }

                                      if (t === "create_list") {
                                        const listTypeRaw = String(act?.listType || "bulleted").toLowerCase();
                                        const listType = listTypeRaw === "todo" ? "todo" : listTypeRaw === "numbered" ? "numbered" : "bulleted";

                                        const widthBricks = Math.max(
                                          1,
                                          Math.floor(Number.isFinite(anchorBlock?.widthBricks) ? anchorBlock.widthBricks : defaultBlockWidthBricks)
                                        );
                                        const groupId = anchorBlock?.groupId || `group-${makeId()}`;

                                        const itemsIn = Array.isArray(act?.items) ? act.items : [];
                                        const items = itemsIn.length
                                          ? itemsIn.map((it) => {
                                            if (typeof it === "string") return makeListItem(listType, it);
                                            const t = String(it?.text ?? "");
                                            const base = makeListItem(listType, t);
                                            if (listType === "todo") return { ...base, checked: Boolean(it?.checked) };
                                            return base;
                                          })
                                          : [makeListItem(listType, "")];

                                        const heightBricks = computeListHeightBricks(items);
                                        const snapped = cursor;

                                        next = next
                                          .map((bb) => (bb.id === anchorBlock?.id ? applyInternalPatch(bb, { groupId }, defaultBlockWidthBricks) : bb))
                                          .concat([
                                            v2ToInternalBlock(
                                              {
                                                id: makeId(),
                                                type: "ListBlock",
                                                groupId,
                                                x: snapped.x,
                                                y: snapped.y,
                                                width: widthBricks,
                                                height: heightBricks,
                                                content: { listType, items },
                                                style: {},
                                              },
                                              defaultBlockWidthBricks
                                            ),
                                          ]);

                                        // Focus the newly created list block (last added).
                                        const last = next[next.length - 1];
                                        if (last?.id) created.push({ id: last.id, type: "ListBlock", firstItemId: items?.[0]?.id || null });
                                        cursor = snapPos(snapped.x, snapped.y + heightBricks * brickHeight + brickHeight);
                                        continue;
                                      }
                                    }

                                if (created.length) emit(next);
                                return next;
                              });

                              if (created.length) {
                                const last = created[created.length - 1];
                                const lastId = last?.id;
                                if (lastId) setActiveId(lastId);
                                if (last?.type === "SpreadsheetBlock" && lastId) {
                                  setSpreadsheetAutoFocusId(lastId);
                                } else if (last?.type === "ListBlock" && lastId) {
                                  const firstItemId = last?.firstItemId;
                                  if (firstItemId) requestAnimationFrame(() => focusListItem(lastId, firstItemId, { caretToStart: true }));
                                } else if (last?.type === "SheetBlock" && lastId) {
                                  requestAnimationFrame(() => focusBlock(lastId, { caretToStart: true }));
                                }
                              }
                            }

                            setAiAnswerPanel((s) => {
                              if (!s.open || s.blockId !== b.id) return s;
                              const nextQuestion = String(promptKey || promptText || "").trim();
                              const nextFull = String(assistantText || "").trim();
                              // If we're already showing this exact answer, no-op.
                              if (String(s.fullAnswer || "") === nextFull && String(s.answer || "") === nextFull && String(s.question || "") === nextQuestion) return s;
                              return { ...s, question: nextQuestion, answer: "", fullAnswer: nextFull, isLoading: false, isTyping: true };
                            });
                          } catch (err) {
                            const msg = String(err?.message || err || "");
                            if (/429|quota|rate/i.test(msg)) {
                              aiBackoffUntilRef.current = Date.now() + 60_000;
                            }
                            const blockRect = node.closest?.(".glass-text-card")?.getBoundingClientRect?.() || null;
                            openAnswerPanelFor(b.id, promptKey || promptText, { answer: "", isLoading: false, anchorRect, blockRect });
                            setAiAnswerPanel((s) => {
                              if (!s.open || s.blockId !== b.id || s.question !== (promptKey || promptText)) return s;
                              const msg = "Sorry — I couldn't reach the AI right now.";
                              return { ...s, answer: "", fullAnswer: msg, isLoading: false, isTyping: true };
                            });
                          } finally {
                            aiInFlightRef.current.delete(b.id);
                            // If the user typed something new while we were in-flight, run it next automatically.
                            const queued = aiQueuedPromptRef.current.get(b.id);
                            aiQueuedPromptRef.current.delete(b.id);
                            const queuedPromptText = String(queued ?? "").trim();
                            if (queuedPromptText && queuedPromptText !== String(aiLastUserLineRef.current.get(b.id) || "")) {
                              // Debounce a bit (so rapid follow-ups still collapse).
                              const follow = setTimeout(async () => {
                                // If another call started meanwhile, skip (it will handle the newest queued prompt).
                                if (aiInFlightRef.current.has(b.id)) return;
                                try {
                                  aiInFlightRef.current.add(b.id);
                                  aiLastUserLineRef.current.set(b.id, queuedPromptText);

                                  const threadKey = existingThreadKey || `thread:${b.id}`;
                                  const thread = aiThreadByBlockRef.current.get(b.id) || { key: threadKey, messages: [] };
                                  if (!thread.key) thread.key = threadKey;
                                  if (!Array.isArray(thread.messages)) thread.messages = [];
                                  if (existingThreadKey) thread.key = existingThreadKey;

                                  const lastMsg = thread.messages.length ? thread.messages[thread.messages.length - 1] : null;
                                  if (lastMsg && lastMsg.role === "user") {
                                    lastMsg.content = queuedPromptText;
                    } else {
                                    thread.messages.push({ role: "user", content: queuedPromptText });
                                  }
                                  if (thread.messages.length > 20) thread.messages = thread.messages.slice(-20);
                                  aiThreadByBlockRef.current.set(b.id, thread);

                                  const canvas = summarizeBlocksForAI(blocksStateRef.current || [], { brickWidth, brickHeight, limit: 36 });
                                  const blockBody = String((blocksStateRef.current || []).find((bb) => bb.id === b.id)?.text ?? "")
                                    .trim()
                                    .slice(0, 1600);
                                  const convo = thread.messages
                                    .slice(-10)
                                    .map((m) => `${String(m?.role || "user").toUpperCase()}: ${String(m?.content || "").trim()}`)
                                    .join("\n");

                                  const prompt = [
                                    "You are an assistant embedded in a block-based note canvas.",
                                    "You can read ALL blocks on screen and you may create/update blocks using the allowed actions below.",
                                    "",
                                    "Return ONLY a JSON object (no markdown, no extra text) shaped like:",
                                    '{ "shouldRespond": true|false, "assistant": "string", "actions": [ ... ] }',
                                    "",
                                    "Rules:",
                                    '- Default to helping: if the user is asking anything, requesting anything, or writing something that could benefit from an explanation/next step, set "shouldRespond": true.',
                                    '- Only set "shouldRespond": false when it is clearly just personal note-taking or an incomplete fragment and a response would be annoying.',
                                    '- If you are unsure, set "shouldRespond": true with a short helpful clarification question.',
                                    '- IMPORTANT: respond ONLY to the LATEST user message (the last USER line in the conversation). Do NOT re-answer older questions unless the latest user message explicitly asks you to.',
                                    '- IMPORTANT: do NOT repeat or restate the user question/prompt. Answer directly (no "You asked...", no quoting the question).',
                                    "",
                                    "Supported actions (allowlist):",
                                    '- { "type": "create_spreadsheet", "rows": 30, "cols": 20, "cells2d": [["Header A","Header B"],["A2","B2"]] }',
                                    '- { "type": "create_spreadsheet", "rows": 30, "cols": 20, "cells": { "0,0": "Header" } }',
                                    '- { "type": "update_spreadsheet", "target": "active", "cells2d": [["Name","Amount"],["Rent","1200"]], "startRow": 0, "startCol": 0 }',
                                    '- { "type": "update_spreadsheet", "target": "last", "cells": { "0,0": "Header" } }',
                                    '- { "type": "create_sheet" }',
                                    '- { "type": "create_design_board" }',
                                    '- { "type": "create_list", "listType": "todo", "items": [{ "text": "Task", "checked": false }] }',
                                    '- { "type": "create_list", "listType": "bulleted", "items": ["One","Two"] }',
                                    '- { "type": "create_list", "listType": "numbered", "items": ["First","Second"] }',
                                    "",
                                    "Canvas blocks:",
                                    canvas || "(none)",
                                    "",
                                    "User's current text block:",
                                    blockBody || "(empty)",
                                    "",
                                    "Conversation so far (most relevant, newest last):",
                                    convo || "(none)",
                                    "",
                                    "Latest user message to answer (highest priority):",
                                    queuedPromptText || "(empty)",
                                  ].join("\n");

                                  const raw = await callAI(prompt);
                                  if (!raw) return;
                                  const parsedObj = extractFirstJsonObject(raw);
                                  const parsed = parsedObj || {};
                                  const actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
                                  const assistant = parsedObj ? String(parsed?.assistant ?? parsed?.answer ?? "").trim() : String(raw ?? "").trim();
                                  const shouldRespond = Boolean(parsed?.shouldRespond) || actions.length > 0 || assistant.length > 0;
                                  if (!shouldRespond || (actions.length === 0 && assistant.length === 0)) return;

                                  const assistantText = dedupeAiAssistantText(
                                    stripQuestionRestatement(stripEchoedQuestionPrefix(assistant || "Done.", queuedPromptText))
                                  );
                                  if (assistantText.trim().length) {
                                    const lastA = thread.messages.length ? thread.messages[thread.messages.length - 1] : null;
                                    if (lastA && lastA.role === "assistant") lastA.content = assistantText;
                                    else thread.messages.push({ role: "assistant", content: assistantText });
                                    if (thread.messages.length > 20) thread.messages = thread.messages.slice(-20);
                                    aiThreadByBlockRef.current.set(b.id, thread);
                                  }

                                  const node2 = blocksRef.current.get(b.id);
                                  const blockRect2 = node2?.closest?.(".glass-text-card")?.getBoundingClientRect?.() || null;
                                  if (!aiAnswerPanel.open || aiAnswerPanel.blockId !== b.id) {
                                    openAnswerPanelFor(b.id, queuedPromptText, { answer: "", isLoading: false, anchorRect: null, blockRect: blockRect2 });
                                  }
                                  setAiAnswerPanel((s) => {
                                    if (!s.open || s.blockId !== b.id) return s;
                                    const nextFull = String(assistantText || "").trim();
                                    return { ...s, question: String(queuedPromptText || "").trim(), answer: "", fullAnswer: nextFull, isLoading: false, isTyping: true };
                                  });
                                  // Note: actions from queued prompts are intentionally ignored here to keep this patch minimal.
                                } catch (err2) {
                                  const msg2 = String(err2?.message || err2 || "");
                                  if (/429|quota|rate/i.test(msg2)) {
                                    aiBackoffUntilRef.current = Date.now() + 60_000;
                                  }
                                } finally {
                                  aiInFlightRef.current.delete(b.id);
                                }
                              }, 650);
                              aiAnswerTimersRef.current.set(b.id, follow);
                            }
                          }
                          }, 4500);
                            aiAnswerTimersRef.current.set(b.id, t);
                          }
                        }
                      }
                      }
                    }

                    // Auto-grow text card width by whole bricks based on content width.
                    // We grow only (no shrinking) to avoid jitter while editing.
                    const el = blocksRef.current.get(b.id);
                    if (el) {
                      const currentBricks = Number.isFinite(b.widthBricks) ? Math.max(1, Math.floor(b.widthBricks)) : 1;
                      // Border thickness on .glass-text-card (~1px each side).
                      const extraPx = 2;
                      const desiredPx = (el.scrollWidth || 0) + extraPx;
                      let desiredBricks = Math.max(1, Math.ceil(desiredPx / brickWidth));

                      if (containerSize.width) {
                        const maxBricksRight = Math.max(1, Math.floor((containerSize.width - (b.x ?? 0)) / brickWidth));
                        desiredBricks = Math.min(desiredBricks, maxBricksRight);
                      }

                      if (desiredBricks > currentBricks) {
                        updateBlock(b.id, { widthBricks: desiredBricks });
                      }
                    }

                    if (slash.open && slash.blockId === b.id && slash.anchorOffset != null) {
                      if (node) {
                        const caret = getCaretOffsetInElement(node);
                        const text = node.textContent ?? "";
                        const raw = text.slice(slash.anchorOffset + 1, Math.max(slash.anchorOffset + 1, caret));
                        const filter = raw.match(/^[^\s]*/)?.[0] ?? "";
                        setSlash((s) => ({ ...s, filter, selectedIndex: 0 }));
                      }
                    }
                  }}
                  onKeyDown={(e) => {
                if (e.key.length === 1 || e.key === "Backspace" || e.key === "Enter" || e.key.startsWith("Arrow")) {
                  markTyping();
                }

                  const node = blocksRef.current.get(b.id);
                  if (!node) return;

                if (e.key === "/" && !slash.open) {
                  requestAnimationFrame(() => {
                    const node = blocksRef.current.get(b.id);
                    if (!node) return;
                    const caret = getCaretOffsetInElement(node);
                    const anchorOffset = Math.max(0, caret - 1);
                    setSlash((s) => ({
                      ...s,
                      open: true,
                      filter: "",
                      selectedIndex: 0,
                      mode: "insert",
                      blockId: b.id,
                      anchorOffset,
                    }));
                    const sel = window.getSelection();
                    const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
                    const rect = range?.getBoundingClientRect?.();
                    if (rect) {
                      openSlashMenuAt(e.currentTarget, rect);
                    } else {
                      const containerRect = containerRef.current?.getBoundingClientRect();
                      const top = (containerRect?.top ?? 0) + (b.y - (containerRef.current?.scrollTop ?? 0));
                      const left = (containerRect?.left ?? 0) + b.x;
                      openSlashMenuAt(e.currentTarget, { top, left });
                    }
                  });
                  return;
                }
                if (slash.open && slash.blockId === b.id) {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    closeSlash();
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlash((s) => ({ ...s, selectedIndex: Math.max(0, s.selectedIndex - 1) }));
                    return;
                  }
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlash((s) => ({ ...s, selectedIndex: s.selectedIndex + 1 }));
                    return;
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    document.dispatchEvent(new Event("slash-enter"));
                    return;
                  }
                  if (e.key.length === 1 && /\s/.test(e.key)) {
                    closeSlash();
                    return;
                  }
                  if (e.key.length === 1 || e.key === "Backspace") {
                    requestAnimationFrame(() => {
                      const node = blocksRef.current.get(b.id);
                      if (!node) return;
                      const caret = getCaretOffsetInElement(node);
                      const text = node.textContent ?? "";
                      const anchor = slash.anchorOffset ?? 0;
                      const raw = text.slice(anchor + 1, Math.max(anchor + 1, caret));
                      const filter = raw.match(/^[^\s]*/)?.[0] ?? "";
                      setSlash((s) => ({ ...s, filter, selectedIndex: 0 }));
                    });
                  }
                }
                  }}
                  className={cn("outline-none whitespace-pre", "text-foreground")}
                  style={{
                    fontFamily: fmtStyle.fontFamily || fontFamily,
                    fontSize: fmtStyle.fontSize || fontSize,
                    fontWeight: fmtStyle.fontWeight,
                    lineHeight: fmtStyle.lineHeight || lineHeight,
                    letterSpacing,
                    borderLeft: fmtStyle.borderLeft,
                    paddingLeft: fmtStyle.paddingLeft || "8px", // Use format-specific padding or default 8px
                    paddingRight: "8px",
                    paddingTop: "6px",
                    paddingBottom: "6px",
                    color: fmtStyle.color,
                    margin: "0px",
                    minHeight: `${brickHeight}px`,
                  }}
                />
              </div>
              )}
            </div>
          );
        })}

        {slash.open && (
          <SlashCommandMenu
            position={slash.position}
            filter={slash.filter}
            selectedIndex={slash.selectedIndex}
            onClose={closeSlash}
            onSelect={applySlashCommand}
          />
        )}

        {aiAnswerPanel.open && (
          <div
            data-ai-answer-panel
            ref={aiAnswerPanelRef}
            className="fixed z-[10000]"
            style={{
              top: `${aiAnswerPanel.top}px`,
              left: `${aiAnswerPanel.left}px`,
              width: `${Math.max(3, Math.floor(aiAnswerPanel.widthBricks || 6)) * brickWidth}px`,
              maxWidth: `${Math.max(220, Math.floor(aiAnswerPanel.maxWidthPx || 520))}px`,
            }}
          >
            <div
              // Same brick shape as TextBlocks.
              className="glass-text-card relative overflow-hidden group"
              onPointerDown={(e) => e.stopPropagation()}
            >
              {/* slight darkening so it's a touch darker than normal bricks */}
              <div className="pointer-events-none absolute inset-0" style={{ background: "rgba(0,0,0,0.035)" }} />

              {/* Drag strip (brick-style) */}
              <div
                className="absolute inset-x-0 top-0 h-3 z-30 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  aiPanelDragRef.current = {
                    startX: e.clientX,
                    startY: e.clientY,
                    originLeft: aiAnswerPanel.left,
                    originTop: aiAnswerPanel.top,
                  };
                }}
                title="Drag to move"
              />

              <button
                type="button"
                className="absolute top-1 right-1 z-40 h-6 w-6 rounded-full hover:bg-black/5 text-black/70 leading-none"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={closeAndPersistAnswerPanel}
                title="Close"
              >
                ×
              </button>

              <div
                ref={aiAnswerTextRef}
                className="text-sm text-black/90 whitespace-pre leading-relaxed"
                style={{
                  paddingLeft: "8px",
                  // Leave room for the close button so short answers don't feel padded out.
                  paddingRight: "28px",
                  paddingTop: "6px",
                  paddingBottom: "6px",
                  minHeight: `${brickHeight}px`,
                }}
              >
                {wrapAfterCharsFinishWord(aiAnswerPanel.isLoading ? "Thinking…" : (aiAnswerPanel.answer || ""), 40)}
              </div>

              {/* offscreen measure node: keeps bubble width tight to text */}
              <div
                ref={aiAnswerMeasureRef}
                className="text-sm whitespace-pre leading-relaxed"
                style={{
                  position: "fixed",
                  left: "-99999px",
                  top: "-99999px",
                  visibility: "hidden",
                  pointerEvents: "none",
                  // ensure the measurement matches the bubble text (no wrapping beyond our injected newlines)
                  whiteSpace: "pre",
                  padding: "0px",
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default BrickEditor;

