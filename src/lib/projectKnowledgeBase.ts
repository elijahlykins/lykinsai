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

export type KnowledgeBaseMindmap = {
  id: string;
  rootNodeId: string | null;
  nodes: Array<{
    id: string;
    parentId: string | null;
    title: string;
    description: string | null;
    type: string;
  }>;
  links: Array<{ id: string; fromId: string; toId: string }>;
};

export type ProjectKnowledgeBase = {
  projectId: string;
  projectName: string | null;
  files: KnowledgeBaseFile[];
  folders: KnowledgeBaseFolder[];
  boards: KnowledgeBaseBoard[];
  mindmap: KnowledgeBaseMindmap | null;
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
    .order("updated_at", { ascending: false });

  const boardIds = boards.map((b: any) => b.id);
  let latestSnapshots: Record<string, any> = {};
  if (boardIds.length) {
    const { data: states = [] } = await supabase
      .from("omnia_board_states")
      .select("board_id, state, created_at")
      .in("board_id", boardIds)
      .order("created_at", { ascending: false });
    for (const row of states) {
      if (!latestSnapshots[row.board_id]) {
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

  let mindmap: KnowledgeBaseMindmap | null = null;
  const { data: mindmapRow } = await supabase
    .from("omnia_project_mindmaps")
    .select("id")
    .eq("project_id", projectId)
    .maybeSingle();
  if (mindmapRow?.id) {
    const { data: nodeRows = [] } = await supabase
      .from("omnia_mindmap_nodes")
      .select("id, parent_id, title, description, type")
      .eq("mindmap_id", mindmapRow.id);
    let linkRows: Array<{ id: string; from_id: string; to_id: string }> = [];
    try {
      const { data: linksData = [] } = await supabase
        .from("omnia_mindmap_links")
        .select("id, from_id, to_id")
        .eq("mindmap_id", mindmapRow.id);
      linkRows = linksData as Array<{ id: string; from_id: string; to_id: string }>;
    } catch {
      // ignore if links table not present
    }
    const root = (nodeRows || []).find((n: any) => n.parent_id == null);
    mindmap = {
      id: mindmapRow.id,
      rootNodeId: root?.id ?? null,
      nodes: (nodeRows || []).map((n: any) => ({
        id: n.id,
        parentId: n.parent_id ?? null,
        title: n.title,
        description: n.description ?? null,
        type: n.type || "topic",
      })),
      links: (linkRows || []).map((l) => ({ id: l.id, fromId: l.from_id, toId: l.to_id })),
    };
  }

  return {
    projectId,
    projectName: project?.name || null,
    files: filesOut,
    folders: foldersOut,
    boards: boardsOut,
    mindmap,
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
  if (kb.mindmap) {
    const nodes = kb.mindmap.nodes
      .slice(0, 80)
      .map((n) => `- ${n.title} (${n.type}) parent=${n.parentId || "root"}`);
    const links = kb.mindmap.links
      .slice(0, 80)
      .map((l) => `- ${l.fromId} -> ${l.toId}`);
    parts.push(
      `Mindmap:\nRoot: ${kb.mindmap.rootNodeId || "none"}\nNodes:\n${nodes.join(
        "\n"
      )}\nLinks:\n${links.join("\n")}`
    );
  }

  const full = parts.filter(Boolean).join("\n\n");
  if (full.length <= maxChars) return full;
  return `${full.slice(0, maxChars)}…`;
};
