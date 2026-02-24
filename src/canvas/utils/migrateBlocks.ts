import type {
  Block,
  CreateBlock,
  CreateMode,
  LegacyBlock,
  LegacyListBlock,
  LegacyListItem,
  LegacySpreadsheetBlock,
  LegacyTextBlock,
  TextBlock,
  TextFormat,
} from "@/canvas/types";

const nowIso = () => new Date().toISOString();

const normalizeTextFormat = (format?: string): TextFormat => {
  if (format === "h1") return "heading-1";
  if (format === "h2") return "heading-2";
  if (format === "h3") return "heading-3";
  return "rich";
};

const listItemsToText = (list: LegacyListItem[], type: LegacyListBlock["listType"]) => {
  const items = Array.isArray(list) ? list : [];
  if (type === "todo") {
    return items.map((it) => `- [${it.checked ? "x" : " "}] ${it.text || ""}`).join("\n");
  }
  if (type === "numbered") {
    return items.map((it, idx) => `${idx + 1}. ${it.text || ""}`).join("\n");
  }
  return items.map((it) => `- ${it.text || ""}`).join("\n");
};

const spreadsheetToText = (sheet: LegacySpreadsheetBlock["sheet"]) => {
  try {
    return JSON.stringify(sheet || {});
  } catch {
    return "";
  }
};

const baseFields = (block: LegacyBlock) => ({
  id: block.id,
  x: Number(block.x || 0),
  y: Number(block.y || 0),
  width: Number(block.width || 0),
  height: Number(block.height || 0),
  aiAnswers: block.aiAnswers,
  createdAt: nowIso(),
  updatedAt: nowIso(),
});

const toTextBlock = (block: LegacyBlock, args: { content: string; format: TextFormat; language?: string }) => {
  const next: TextBlock = {
    ...baseFields(block),
    type: "text",
    content: String(args.content ?? ""),
    format: args.format,
    language: args.language,
  };
  return next;
};

const toCreateBlock = (
  block: LegacyBlock,
  args: { mode: CreateMode; data?: any; framePreset?: string }
) => {
  const next: CreateBlock = {
    ...baseFields(block),
    type: "create",
    mode: args.mode,
    data: args.data ?? {},
    framePreset: args.framePreset,
  };
  return next;
};

export const migrateLegacyBlocks = (blocks: LegacyBlock[]): Block[] => {
  const list = Array.isArray(blocks) ? blocks : [];
  const out: Block[] = [];
  for (const block of list) {
    if (!block || !block.type) continue;
    switch (block.type) {
      case "text": {
        const b = block as LegacyTextBlock;
        out.push(
          toTextBlock(block, {
            content: b.content || "",
            format: normalizeTextFormat(b.format),
          })
        );
        break;
      }
      case "list": {
        const b = block as LegacyListBlock;
        const format: TextFormat =
          b.listType === "todo"
            ? "todo"
            : b.listType === "numbered"
            ? "list-ordered"
            : "list-unordered";
        out.push(
          toTextBlock(block, {
            content: listItemsToText(b.items, b.listType),
            format,
          })
        );
        break;
      }
      case "sheet": {
        out.push(
          toTextBlock(block, {
            content: String((block as any).content || ""),
            format: "rich",
          })
        );
        break;
      }
      case "code": {
        const b = block as any;
        out.push(
          toTextBlock(block, {
            content: String(b.content || ""),
            format: "code",
            language: b.language,
          })
        );
        break;
      }
      case "spreadsheet": {
        const b = block as LegacySpreadsheetBlock;
        out.push(
          toTextBlock(block, {
            content: spreadsheetToText(b.sheet),
            format: "table",
          })
        );
        break;
      }
      case "image": {
        out.push(toCreateBlock(block, { mode: "image", data: { src: (block as any).src } }));
        break;
      }
      case "design": {
        out.push(toCreateBlock(block, { mode: "design", data: { board: (block as any).board } }));
        break;
      }
      case "youtube": {
        out.push(
          toCreateBlock(block, {
            mode: "embed",
            data: { url: (block as any).url, videoId: (block as any).videoId },
          })
        );
        break;
      }
      case "link": {
        out.push(toCreateBlock(block, { mode: "embed", data: { url: (block as any).url } }));
        break;
      }
      case "file": {
        const b = block as any;
        out.push(
          toCreateBlock(block, {
            mode: "embed",
            data: { name: b.name, mime: b.mime, dataUrl: b.dataUrl },
          })
        );
        break;
      }
      default: {
        console.warn("migrateLegacyBlocks: unmapped block type", block.type, block.id);
        break;
      }
    }
  }
  return out;
};
