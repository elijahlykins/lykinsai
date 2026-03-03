import type { UniversalBlockRuntime, UniversalBlockType } from "@/canvas/blockSystem/types";

export type BlockId = string;

export type Camera = {
  x: number; // world px
  y: number; // world px
  zoom: number; // 0.1..5
};

// Live AI answer memory (ported from old BrickEditor).
// Stores answers keyed by the exact triggering line (q).
export type AiAnswerEntry = {
  q: string; // exact line that triggered the answer (e.g. "How do I...?" or "summarize: ...")
  a: string; // full answer text
  ts: number; // unix ms
  panel?: { left: number; top: number }; // last-known bubble position (client px)
};

export type BlockType = "text" | "create";

export type CreateMode =
  | "empty"
  | "shape"
  | "image"
  | "generated"
  | "design"
  | "video"
  | "embed"
  | "taskboard";

export interface BaseBlock {
  id: BlockId;
  type: BlockType;
  x: number; // world px
  y: number; // world px
  width: number; // world px
  height: number; // world px
  // Maintain ordering consistency without changing existing visuals.
  zIndex?: number;
  createdAt?: string;
  updatedAt?: string;
  aiAnswers?: AiAnswerEntry[];
  collapsed?: boolean;
  locked?: boolean;
  containerId?: BlockId | null;
  data?: Record<string, unknown>;
  universal?: UniversalBlockRuntime;
  universalType?: UniversalBlockType;
}

export type TextFormat =
  | "plain"
  | "markdown"
  | "rich"
  | "todo"
  | "list-ordered"
  | "list-unordered"
  | "table"
  | "code"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "calendar"
  | "button"
  | "media";

export interface TextBlock extends BaseBlock {
  type: "text";
  content: string;
  format: TextFormat;
  language?: string;
}

export interface CreateBlock extends BaseBlock {
  type: "create";
  mode?: CreateMode;
  framePreset?: string;
  data?: Record<string, any>;
}

export type Block = TextBlock | CreateBlock;

// Legacy types (kept for migration compatibility).
export type LegacyBlockType =
  | "text"
  | "image"
  | "list"
  | "spreadsheet"
  | "sheet"
  | "file"
  | "link"
  | "youtube"
  | "code"
  | "design";

export interface LegacyBaseBlock {
  id: BlockId;
  type: LegacyBlockType;
  x: number;
  y: number;
  width: number;
  height: number;
  aiAnswers?: AiAnswerEntry[];
}

export type LegacyTextFormat = "p" | "h1" | "h2" | "h3";

export interface LegacyTextBlock extends LegacyBaseBlock {
  type: "text";
  content: string;
  fontSize?: number;
  format?: LegacyTextFormat;
}

export type LegacyListType = "todo" | "bulleted" | "numbered";

export type LegacyListItem = {
  id: string;
  text: string;
  checked?: boolean;
};

export interface LegacyListBlock extends LegacyBaseBlock {
  type: "list";
  listType: LegacyListType;
  items: LegacyListItem[];
  fontSize?: number;
}

export type LegacySpreadsheetSheet = {
  version: 1;
  rows: number;
  cols: number;
  colWidths: number[];
  cells: Record<string, string>;
};

export interface LegacySpreadsheetBlock extends LegacyBaseBlock {
  type: "spreadsheet";
  sheet: LegacySpreadsheetSheet;
}

export interface LegacySheetBlock extends LegacyBaseBlock {
  type: "sheet";
  content: string;
  groupId: string;
  paginate?: boolean;
}

export interface LegacyFileBlock extends LegacyBaseBlock {
  type: "file";
  name: string;
  mime: string;
  dataUrl: string;
}

export interface LegacyImageBlock extends LegacyBaseBlock {
  type: "image";
  src: string;
}

export interface LegacyLinkBlock extends LegacyBaseBlock {
  type: "link";
  url: string;
}

export interface LegacyYouTubeBlock extends LegacyBaseBlock {
  type: "youtube";
  url: string;
  videoId: string;
}

export type DesignTool = "pen" | "shape" | "text" | "select";
export type DesignShape = "rect" | "circle" | "line";
export type DesignElement = any;

export type DesignBoard = {
  version: 1;
  elements: DesignElement[];
  tool?: DesignTool;
  color?: string;
  shape?: DesignShape;
  fill?: boolean;
  strokeWidth?: number;
  opacity?: number;
  fineGrid?: boolean;
  width?: number;
  height?: number;
};

export interface LegacyDesignBlock extends LegacyBaseBlock {
  type: "design";
  board: DesignBoard;
}

export type CodeLanguage =
  | "plaintext"
  | "javascript"
  | "typescript"
  | "python"
  | "java"
  | "html"
  | "css"
  | "json"
  | "sql"
  | "bash"
  | "markdown";

export interface LegacyCodeBlock extends LegacyBaseBlock {
  type: "code";
  content: string;
  language: CodeLanguage;
}

export type LegacyBlock =
  | LegacyTextBlock
  | LegacyImageBlock
  | LegacyListBlock
  | LegacySpreadsheetBlock
  | LegacySheetBlock
  | LegacyFileBlock
  | LegacyLinkBlock
  | LegacyYouTubeBlock
  | LegacyDesignBlock
  | LegacyCodeBlock;

