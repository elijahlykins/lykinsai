// Universal Block model (v2) + migration from legacy v1 payloads.
// Intentionally UI-agnostic: used by BrickEditor to keep visuals unchanged while evolving data/logic.
//
// v2 Block shape:
// {
//   id: string,
//   type: 'TextBlock' | 'ListBlock' | 'CodeBlock' | 'SheetBlock' | 'SpreadsheetBlock' | 'DesignBlock' | 'MediaBlock' | 'DividerBlock',
//   x: number, y: number,               // px, snapped to brick grid
//   width: number, height: number,      // bricks, snapped
//   content: object,                    // type-specific
//   style: object,                      // minimal now; grows later (rich text, etc.)
//   children?: V2Block[]
// }
//
// v2 Payload shape:
// { version: 2, brickWidth, brickHeight, blocks: V2Block[] }

export const BRICK_PAYLOAD_VERSION = 2;

const MEDIA_KINDS_V1 = new Set(["youtube", "image", "video", "audio", "pdf", "file", "link"]);

function stripHtmlToText(html) {
  const s = String(html ?? "");
  // Very small sanitizer for plain-text extraction.
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trimEnd();
}

function makeListItemId() {
  return `li-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Migration helper: if any legacy/experimental payload stored todos[] trees, collapse to "- [ ]" lines.
function todosToLegacyCheckText(todos, depth = 0) {
  const out = [];
  const list = Array.isArray(todos) ? todos : [];
  for (const t of list) {
    const indent = "  ".repeat(Math.max(0, depth));
    const checked = t?.checked ? "x" : " ";
    const body = stripHtmlToText(t?.text ?? "");
    out.push(`${indent}- [${checked}] ${body}`);
    if (Array.isArray(t?.subTodos) && t.subTodos.length) {
      out.push(todosToLegacyCheckText(t.subTodos, depth + 1));
    }
  }
  return out.join("\n");
}

function legacyBulletTextToItems(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  return lines
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const m = line.match(/^\s*-\s+(.*)$/);
      const body = m ? (m[1] ?? "") : line.trimStart();
      return { id: makeListItemId(), text: body };
    });
}

function legacyOrderedTextToItems(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  return lines
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const m = line.match(/^\s*\d+\.\s+(.*)$/);
      const body = m ? (m[1] ?? "") : line.trimStart();
      return { id: makeListItemId(), text: body };
    });
}

function legacyTodoTextToItems(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  return lines
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
      if (!m) return { id: makeListItemId(), text: line.trimStart(), checked: false };
      const checked = String(m[1] || "").toLowerCase() === "x";
      const body = m[2] ?? "";
      return { id: makeListItemId(), text: body, checked };
    });
}

function listBlockToPlainText(block) {
  const listType = block?.content?.listType;
  const items = Array.isArray(block?.content?.items) ? block.content.items : [];
  if (listType === "todo") {
    return items.map((it) => `- [${it?.checked ? "x" : " "}] ${String(it?.text ?? "")}`).join("\n");
  }
  if (listType === "numbered") {
    return items.map((it, idx) => `${idx + 1}. ${String(it?.text ?? "")}`).join("\n");
  }
  // bulleted default
  return items.map((it) => `- ${String(it?.text ?? "")}`).join("\n");
}

export function isV2Payload(parsed) {
  return Boolean(parsed && parsed.version === 2 && Array.isArray(parsed.blocks));
}

export function isV1Payload(parsed) {
  return Boolean(parsed && parsed.version === 1 && Array.isArray(parsed.blocks));
}

function clampInt(n, min, max) {
  const v = Number.isFinite(n) ? Math.trunc(n) : min;
  return Math.max(min, Math.min(max ?? v, v));
}

function makeBlockId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createTextBlockV2({ id, x, y, width = 1, height = 1, text = "" } = {}) {
  return {
    id: id || makeBlockId(),
    type: "TextBlock",
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    width: clampInt(width, 1),
    height: clampInt(height, 1),
    content: { text: text ?? "" },
    style: { format: "p" },
  };
}

export function getBlockPlainText(block) {
  if (!block) return "";
  if (block.type === "TextBlock" || block.type === "CodeBlock" || block.type === "SheetBlock") {
    return block.content?.text ?? "";
  }
  if (block.type === "ListBlock") {
    return listBlockToPlainText(block);
  }
  return "";
}

export function setBlockPlainText(block, text) {
  if (!block) return block;
  if (block.type === "TextBlock" || block.type === "CodeBlock" || block.type === "SheetBlock") {
    return { ...block, content: { ...(block.content || {}), text: text ?? "" } };
  }
  return block;
}

export function v1BlockToV2(b, { defaultBlockWidthBricks = 14 } = {}) {
  const id = b?.id || makeBlockId();
  const x = Number.isFinite(b?.x) ? Math.round(b.x) : 0;
  const y = Number.isFinite(b?.y) ? Math.round(b.y) : 0;
  const width = clampInt(b?.widthBricks ?? defaultBlockWidthBricks, 1);
  const height = clampInt(b?.heightBricks ?? 1, 1);
  const kind = b?.kind || "text";
  const format = b?.format || "p";
  const text = b?.text ?? "";

  // Text-like blocks in v1 are represented as kind:"text" + format.
  if (kind === "text") {
    if (format === "code") {
      return {
        id,
        type: "CodeBlock",
        x,
        y,
        width,
        height: clampInt(b?.heightBricks ?? 4, 1),
        content: { text, language: b?.language || "plaintext" },
        style: { format: "code" },
      };
    }
    if (format === "bullet") {
      return {
        id,
        type: "ListBlock",
        x,
        y,
        width,
        height,
        content: { listType: "bulleted", items: legacyBulletTextToItems(text) },
        style: {},
      };
    }
    if (format === "ordered") {
      return {
        id,
        type: "ListBlock",
        x,
        y,
        width,
        height,
        content: { listType: "numbered", items: legacyOrderedTextToItems(text) },
        style: {},
      };
    }
    if (format === "check") {
      return {
        id,
        type: "ListBlock",
        x,
        y,
        width,
        height,
        content: { listType: "todo", items: legacyTodoTextToItems(text) },
        style: {},
      };
    }
    return {
      id,
      type: "TextBlock",
      x,
      y,
      width,
      height,
      content: { text },
      style: { format },
    };
  }

  if (kind === "divider") {
    return {
      id,
      type: "DividerBlock",
      x,
      y,
      width,
      height: 1,
      content: {},
      style: {},
    };
  }

  if (kind === "spreadsheet") {
    return {
      id,
      type: "SpreadsheetBlock",
      x,
      y,
      width,
      height: clampInt(b?.heightBricks ?? 8, 1),
      content: { sheet: b?.sheet },
      style: {},
    };
  }

  if (kind === "design") {
    return {
      id,
      type: "DesignBlock",
      x,
      y,
      width,
      height: clampInt(b?.heightBricks ?? 8, 1),
      content: { board: b?.board },
      style: {},
    };
  }

  if (MEDIA_KINDS_V1.has(kind)) {
    return {
      id,
      type: "MediaBlock",
      x,
      y,
      width,
      height: clampInt(b?.heightBricks ?? 4, 1),
      content: { mediaType: kind, media: b?.media || {} },
      style: {},
    };
  }

  // Unknown legacy kind → degrade to TextBlock with plain text.
  return {
    id,
    type: "TextBlock",
    x,
    y,
    width,
    height,
    content: { text },
    style: { format: "p", legacyKind: kind },
  };
}

export function v1PayloadToV2(parsedV1, { defaultBlockWidthBricks = 14 } = {}) {
  const brickWidth = parsedV1?.brickWidth;
  const brickHeight = parsedV1?.brickHeight;
  const blocks = (parsedV1?.blocks || []).map((b) => v1BlockToV2(b, { defaultBlockWidthBricks }));
  return {
    version: BRICK_PAYLOAD_VERSION,
    brickWidth,
    brickHeight,
    blocks,
  };
}

export function plainTextToV2(text, { defaultBlockWidthBricks = 14 } = {}) {
  const t = String(text ?? "");
  if (t.trim().length === 0) return { version: BRICK_PAYLOAD_VERSION, blocks: [] };
  return {
    version: BRICK_PAYLOAD_VERSION,
    blocks: [createTextBlockV2({ x: 0, y: 0, width: defaultBlockWidthBricks, height: 1, text: t })],
  };
}

export function normalizeValueToV2(value, { defaultBlockWidthBricks = 14 } = {}) {
  // value is a string (stored as <pre data-brick-grid>text</pre>) that may be JSON payload.
  const raw = value ?? "";
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  if (isV2Payload(parsed)) {
    // Migrate any older/experimental block types into the canonical set.
    const blocks = (parsed.blocks || []).map((b) => {
      if (!b || typeof b !== "object") return b;
      if (b.type === "TodoBlock") {
        const legacyText =
          Array.isArray(b.content?.todos) ? todosToLegacyCheckText(b.content.todos) : (b.content?.text ?? "");
        return {
          ...b,
          type: "ListBlock",
          content: { listType: "todo", items: legacyTodoTextToItems(legacyText) },
          style: {},
        };
      }
      // If a TextBlock still contains list markers from older versions, keep it as text (user can convert),
      // but if it explicitly had a legacyFormat flag, migrate to ListBlock.
      if (b.type === "TextBlock" && b.style?.legacyFormat === "check") {
        const t = b.content?.text ?? "";
        return { ...b, type: "ListBlock", content: { listType: "todo", items: legacyTodoTextToItems(t) }, style: {} };
      }
      return b;
    });
    return { ...parsed, blocks };
  }
  if (isV1Payload(parsed)) return v1PayloadToV2(parsed, { defaultBlockWidthBricks });

  return plainTextToV2(raw, { defaultBlockWidthBricks });
}

export function serializeV2Payload({ blocks, brickWidth, brickHeight }) {
  return JSON.stringify({
    version: BRICK_PAYLOAD_VERSION,
    brickWidth,
    brickHeight,
    blocks: Array.isArray(blocks) ? blocks : [],
  });
}

