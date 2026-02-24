import type { Block, BlockId, CreateMode, LegacyListType, TextFormat } from "@/canvas/types";
import type { LucideIcon } from "lucide-react";
import { Square } from "lucide-react";

export type SlashCommandId = string;

export type SlashCommandContext = {
  clientX: number;
  clientY: number;
  worldX: number;
  worldY: number;
  gridSize: number;
  addBlock: (block: Block) => void;
  createCreateBlock: (x: number, y: number, mode?: CreateMode, initialData?: any) => Block;
  updateBlock: (id: BlockId, patch: Partial<Block>) => void;
  sourceBlockId?: BlockId | null;
  addTextBlockAt: (
    pos: { x: number; y: number },
    opts?: { width?: number; height?: number; content?: string; format?: TextFormat }
  ) => BlockId;
  addListBlockAt: (pos: { x: number; y: number }, opts: { listType: LegacyListType; width?: number }) => BlockId;
  addSpreadsheetBlockAt: (pos: { x: number; y: number }, opts?: { rows?: number; cols?: number }) => BlockId;
  addSheetBlockAt: (pos: { x: number; y: number }, opts?: { width?: number; height?: number; content?: string; groupId?: string }) => BlockId;
  addCodeBlockAt: (pos: { x: number; y: number }, opts?: { width?: number; height?: number; content?: string; language?: any }) => BlockId;
  addDesignBlockAt: (pos: { x: number; y: number }, opts?: { width?: number; height?: number; board?: any }) => BlockId;
  getBlockById: (id: BlockId) => Block | undefined;
  focusTextBlockById: (id: BlockId) => void;
  focusListItemByKey: (key: string) => void;
  pickImageDataUrl: () => Promise<string | null>;
};

export type SlashCommand = {
  id: SlashCommandId;
  label: string;
  description: string;
  keyword: string;
  icon?: LucideIcon;
  action: (ctx: SlashCommandContext) => void | Promise<void>;
};

function createTextBrick(ctx: SlashCommandContext) {
  const id = ctx.addTextBlockAt(
    { x: ctx.worldX, y: ctx.worldY },
    { width: ctx.gridSize * 8, height: ctx.gridSize * 4, content: "", format: "plain" }
  );
  const source: any = ctx.getBlockById(id);
  ctx.updateBlock(id, {
    universalType: "brick" as any,
    data: {
      ...(source?.data || {}),
      kind: "brick",
      trait: "text",
      content: "",
      body: "",
      state: {},
    } as any,
  } as any);
  ctx.focusTextBlockById(id);
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "brick",
    label: "/brick",
    keyword: "brick text",
    description: "Create a plain text brick",
    icon: Square,
    action: (ctx) => createTextBrick(ctx),
  },
];

export const CORE_BASE_SLASH_COMMANDS = SLASH_COMMANDS;
