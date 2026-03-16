import { supabase } from "@/lib/supabase";
import type { Block } from "@/canvas/types";

type LocalFolderEntry = {
  id: string;
  name: string;
  parentId: string | null;
};

type LocalFileEntry = {
  id: string;
  name: string;
  path: string;
  folderId: string | null;
  kind: "image" | "video" | "pdf" | "doc" | "link" | "file";
  url: string;
};

export type KnowledgeBaseFile = {
  id: string;
  name: string;
  kind: string;
  folderId: string | null;
  summary: string;
};

export type KnowledgeBaseFolder = {
  id: string;
  name: string;
  parentId: string | null;
};

export type KnowledgeBaseBlock = {
  id: string;
  type: string;
  summary: string;
  position: { x: number; y: number; width: number; height: number };
};

export type KnowledgeBaseBoard = {
  id: string;
  title: string;
  blocks: KnowledgeBaseBlock[];
};

export type ProjectKnowledgeBase = {
  projectId: string;
  projectName: string | null;
  files: KnowledgeBaseFile[];
  folders: KnowledgeBaseFolder[];
  boards: KnowledgeBaseBoard[];
};

const truncateText = (value: string, max = 500) => {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max)}…`;
};

const summarizeBlock = (block: Block) => {
  if (!block) return "";
  switch (block.type) {
    case "text": {
      const universalType = String((block as any)?.universalType || (block as any)?.universal?.blockType || "");
      if (universalType) {
        const title = String((block as any)?.data?.title || universalType);
        return truncateText(`Universal ${universalType}: ${title}`);
      }
      const format = String((block as any).format || "plain");
      const content = String((block as any).content || "");
      if (format === "table") {
        try {
          const sheet = JSON.parse(content || "{}");
          const rows = Number(sheet.rows || 0);
          const cols = Number(sheet.cols || 0);
          const cells = sheet.cells || {};
          const sampleKeys = Object.keys(cells).slice(0, 8);
          const sample = sampleKeys.map((k) => `${k}:${cells[k]}`).join(" • ");
          return truncateText(`Spreadsheet ${rows}x${cols}${sample ? ` (${sample})` : ""}`);
        } catch {
          return truncateText(content);
        }
      }
      return truncateText(content);
    }
    case "create": {
      const universalType = String((block as any)?.universalType || (block as any)?.universal?.blockType || "");
      if (universalType) {
        const title = String((block as any)?.data?.title || universalType);
        return truncateText(`Universal ${universalType}: ${title}`);
      }
      const mode = String((block as any).mode || "");
      const data = (block as any).data || {};
      if (mode === "image" || mode === "generated") return "Image block";
      if (mode === "design") return "Design board";
      if (mode === "taskboard") return "Task board";
      if (mode === "video") return truncateText(String(data.url || data.videoId || "Video"));
      if (mode === "embed") {
        if (data.url) return truncateText(String(data.url));
        if (data.name) return truncateText(String(data.name));
      }
      return mode || "Create block";
    }
    default:
      return block.type;
  }
};

const normalizeBlocks = (snapshot: any): KnowledgeBaseBlock[] => {
  if (!snapshot) return [];
  const blocksRecord = snapshot.blocks || {};
  const order = Array.isArray(snapshot.blockOrder) ? snapshot.blockOrder : Object.keys(blocksRecord);
  return order
    .map((id: string) => blocksRecord[id])
    .filter(Boolean)
    .map((block: Block) => ({
      id: block.id,
      type: block.type,
      summary: summarizeBlock(block),
      position: {
        x: Number(block.x || 0),
        y: Number(block.y || 0),
        width: Number(block.width || 0),
        height: Number(block.height || 0),
      },
    }));
};

const loadLocalProjectFiles = (projectId: string) => {
  if (typeof window === "undefined") return { folders: [], files: [] };
  try {
    const raw = localStorage.getItem(`project:${projectId}`);
    if (!raw) return { folders: [], files: [] };
    const parsed = JSON.parse(raw);
    const folders = Array.isArray(parsed?.folders) ? parsed.folders : [];
    const files = Array.isArray(parsed?.files) ? parsed.files : [];
    return { folders, files };
  } catch {
    return { folders: [], files: [] };
  }
};

export const getProjectKnowledgeBase = async (projectId: string): Promise<ProjectKnowledgeBase> => {
  const { data: project } = await supabase
    .from("omnia_projects")
    .select("id, name")
    .eq("id", projectId)
    .maybeSingle();

  const { data: boards = [] } = await supabase
    .from("omnia_boards")
    .select("id, title, created_at, updated_at")
    .eq("project_id", projectId)
    .order("updated_at", { ascending: false })
    .limit(50);

  const boardIds = boards.map((b: any) => b.id);
  let latestSnapshots: Record<string, any> = {};
  if (boardIds.length) {
    // Single batch query — each board has at most 1 row after migration 016.
    const { data: stateRows } = await supabase
      .from("omnia_board_states")
      .select("board_id, state")
      .in("board_id", boardIds.slice(0, 20));
    for (const row of stateRows || []) {
      if (row.board_id && row.state) {
        latestSnapshots[row.board_id] = row.state;
      }
    }
  }

  const boardsOut: KnowledgeBaseBoard[] = boards.map((board: any) => ({
    id: board.id,
    title: board.title || "Untitled board",
    blocks: normalizeBlocks(latestSnapshots[board.id]),
  }));

  const { folders: localFolders, files: localFiles } = loadLocalProjectFiles(projectId);
  const foldersOut: KnowledgeBaseFolder[] = (localFolders as LocalFolderEntry[]).map((f) => ({
    id: f.id,
    name: f.name,
    parentId: f.parentId ?? null,
  }));
  const filesOut: KnowledgeBaseFile[] = (localFiles as LocalFileEntry[]).map((f) => ({
    id: f.id,
    name: f.name,
    kind: f.kind || "file",
    folderId: f.folderId ?? null,
    summary: truncateText(f.path || f.name),
  }));

  return {
    projectId,
    projectName: project?.name || null,
    files: filesOut,
    folders: foldersOut,
    boards: boardsOut,
  };
};

export const projectKnowledgeBaseToText = (kb: ProjectKnowledgeBase, maxChars = 12000) => {
  const parts: string[] = [];
  parts.push(`Project: ${kb.projectName || kb.projectId}`);

  if (kb.folders.length) {
    parts.push(
      `Folders: ${kb.folders.map((f) => f.name).slice(0, 30).join(", ")}`
    );
  }
  if (kb.files.length) {
    const fileLines = kb.files
      .slice(0, 50)
      .map((f) => `- ${f.name} (${f.kind}) ${truncateText(f.summary, 120)}`);
    parts.push(`Files:\n${fileLines.join("\n")}`);
  }
  if (kb.boards.length) {
    const boardLines = kb.boards.map((b) => {
      const blocks = b.blocks
        .slice(0, 30)
        .map((blk) => `  - [${blk.type}] ${truncateText(blk.summary, 160)}`)
        .join("\n");
      return `Board: ${b.title}\n${blocks}`;
    });
    parts.push(boardLines.join("\n\n"));
  }
  const full = parts.filter(Boolean).join("\n\n");
  if (full.length <= maxChars) return full;
  return `${full.slice(0, maxChars)}…`;
};

/**
 * Lightweight project summary for AI context.
 * Returns only board titles with block counts, folder names, and file names.
 * No block-level content is serialized — eliminates duplication with canvas context.
 */
export const projectSummaryForAI = (
  kb: ProjectKnowledgeBase,
  opts?: { maxChars?: number; excludeBoardId?: string },
): string => {
  const maxChars = opts?.maxChars ?? 2000;
  const parts: string[] = [];
  parts.push(`Project: ${kb.projectName || kb.projectId}`);

  const boards = opts?.excludeBoardId
    ? kb.boards.filter((b) => b.id !== opts.excludeBoardId)
    : kb.boards;

  if (boards.length) {
    const boardLines = boards
      .slice(0, 20)
      .map((b) => `- ${b.title} (${b.blocks.length} blocks)`);
    parts.push(`Boards (${boards.length}):\n${boardLines.join("\n")}`);
  }

  if (kb.folders.length) {
    parts.push(
      `Folders (${kb.folders.length}): ${kb.folders.map((f) => f.name).slice(0, 20).join(", ")}`,
    );
  }

  if (kb.files.length) {
    const fileNames = kb.files
      .slice(0, 20)
      .map((f) => `${f.name} (${f.kind})`)
      .join(", ");
    parts.push(`Files (${kb.files.length}): ${fileNames}`);
  }

  const full = parts.filter(Boolean).join("\n\n");
  return full.length <= maxChars ? full : `${full.slice(0, maxChars)}…`;
};
