import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { getSelectedAiModel } from "@/lib/ai-model";
import { supabase } from "@/lib/supabase";

export type MindmapNodeType =
  | "topic"
  | "goal"
  | "task"
  | "asset"
  | "question"
  | "decision"
  | "note";

export type MindmapNode = {
  id: string;
  mindmapId: string;
  parentId: string | null;
  title: string;
  description: string | null;
  type: MindmapNodeType;
  positionX: number;
  positionY: number;
  color: string | null;
  sourceType?: "board" | "file";
  sourceId?: string;
};

export type MindmapLink = {
  id: string;
  mindmapId: string;
  fromId: string;
  toId: string;
};

type MindmapState = {
  nodes: Record<string, MindmapNode>;
  links: Record<string, MindmapLink>;
  rootNodeId: string | null;
  selectedNodeId: string | null;
  mindmapId: string | null;
  isLoading: boolean;
  isSaving: boolean;
  lastError: string | null;

  loadMindmapForProject: (projectId: string) => Promise<void>;
  createMindmapIfNotExists: (projectId: string) => Promise<string | null>;
  saveMindmap: () => void;
  addNode: (parentId: string | null, data: Partial<MindmapNode>) => string | null;
  updateNode: (nodeId: string, updates: Partial<MindmapNode>) => void;
  deleteNode: (nodeId: string) => void;
  moveNode: (nodeId: string, newParentId: string | null, newX: number, newY: number) => void;
  toggleLink: (fromId: string, toId: string) => void;
  setSelectedNode: (nodeId: string | null) => void;
  syncExternalNodes: (
    items: Array<{ sourceType: "board" | "file"; sourceId: string; title: string }>
  ) => void;
  requestAIMindmapEdit: (prompt: string, options?: { model?: string }) => Promise<void>;
};

const makeUuid = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  const s4 = () =>
    Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .slice(1);
  return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
};

const hashString = (input: string) => {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
};

const getSeededPosition = (id: string) => {
  const seed = hashString(id);
  const x = 10 + (seed % 80);
  const y = 10 + ((seed >> 3) % 80);
  return { x, y };
};

const toNodeRecord = (rows: any[], mindmapId: string) => {
  const record: Record<string, MindmapNode> = {};
  for (const row of rows || []) {
    record[row.id] = {
      id: row.id,
      mindmapId,
      parentId: row.parent_id ?? null,
      title: row.title ?? "Untitled",
      description: row.description ?? null,
      type: (row.type || "topic") as MindmapNodeType,
      positionX: Number.isFinite(row.position_x) ? Number(row.position_x) : 50,
      positionY: Number.isFinite(row.position_y) ? Number(row.position_y) : 50,
      color: row.color ?? null,
      sourceType: row.source_type ?? undefined,
      sourceId: row.source_id ?? undefined,
    };
  }
  return record;
};

let saveTimer: number | null = null;
const pendingDeleteIds = new Set<string>();
const pendingDeleteLinkIds = new Set<string>();

const scheduleSave = (fn: () => void) => {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(fn, 2500);
};

const buildLinkId = (fromId: string, toId: string) => {
  const a = String(fromId);
  const b = String(toId);
  return a < b ? `${a}::${b}` : `${b}::${a}`;
};

export const useMindmapStore = create<MindmapState>()(
  immer((set, get) => ({
    nodes: {},
    links: {},
    rootNodeId: null,
    selectedNodeId: null,
    mindmapId: null,
    isLoading: false,
    isSaving: false,
    lastError: null,

    loadMindmapForProject: async (projectId) => {
      if (!projectId) return;
      set((state) => {
        state.isLoading = true;
        state.lastError = null;
      });
      try {
        const mindmapId = await get().createMindmapIfNotExists(projectId);
        if (!mindmapId) {
          set((state) => {
            state.isLoading = false;
          });
          return;
        }
        const { data } = await supabase
          .from("omnia_mindmap_nodes")
          .select("id, parent_id, title, description, type, position_x, position_y, color, source_type, source_id")
          .eq("mindmap_id", mindmapId);

        const nodeRecord = toNodeRecord(data || [], mindmapId);
        const { data: linkRows } = await supabase
          .from("omnia_mindmap_links")
          .select("id, from_id, to_id")
          .eq("mindmap_id", mindmapId);
        const linkRecord: Record<string, MindmapLink> = {};
        for (const row of linkRows || []) {
          linkRecord[row.id] = {
            id: row.id,
            mindmapId,
            fromId: row.from_id,
            toId: row.to_id,
          };
        }

        let root =
          Object.values(nodeRecord).find((n) => n.parentId == null) ||
          null;

        if (!root) {
          const rootId = makeUuid();
          await supabase.from("omnia_mindmap_nodes").insert({
            id: rootId,
            mindmap_id: mindmapId,
            parent_id: null,
            title: "Project Core",
            description: null,
            type: "topic",
            position_x: 50,
            position_y: 50,
            color: null,
          });
          nodeRecord[rootId] = {
            id: rootId,
            mindmapId,
            parentId: null,
            title: "Project Core",
            description: null,
            type: "topic",
            positionX: 50,
            positionY: 50,
            color: null,
          };
          root = nodeRecord[rootId];
        }

        set((state) => {
          state.mindmapId = mindmapId;
          state.nodes = nodeRecord;
          state.links = linkRecord;
          state.rootNodeId = root?.id ?? null;
          state.selectedNodeId = null;
          state.isLoading = false;
        });
      } catch (error: any) {
        console.error("Mindmap load failed:", error);
        set((state) => {
          state.isLoading = false;
          state.lastError = error?.message || "Failed to load mindmap";
        });
      }
    },

    createMindmapIfNotExists: async (projectId) => {
      if (!projectId) return null;
      const { data: existing } = await supabase
        .from("omnia_project_mindmaps")
        .select("id")
        .eq("project_id", projectId)
        .maybeSingle();
      if (existing?.id) return existing.id;

      const { data: created } = await supabase
        .from("omnia_project_mindmaps")
        .insert({ project_id: projectId })
        .select("id")
        .single();

      const mindmapId = created?.id;
      if (!mindmapId) return null;

      const rootId = makeUuid();
      await supabase.from("omnia_mindmap_nodes").insert({
        id: rootId,
        mindmap_id: mindmapId,
        parent_id: null,
        title: "Project Core",
        description: null,
        type: "topic",
        position_x: 50,
        position_y: 50,
        color: null,
      });

      return mindmapId;
    },

    saveMindmap: () => {
      scheduleSave(async () => {
        const { nodes, links, mindmapId } = get();
        if (!mindmapId) return;
        set((state) => {
          state.isSaving = true;
          state.lastError = null;
        });

        try {
          const payload = Object.values(nodes).map((node) => ({
            id: node.id,
            mindmap_id: mindmapId,
            parent_id: node.parentId,
            title: node.title,
            description: node.description,
            type: node.type,
            position_x: node.positionX,
            position_y: node.positionY,
            color: node.color,
            source_type: node.sourceType ?? null,
            source_id: node.sourceId ?? null,
            updated_at: new Date().toISOString(),
          }));

          if (payload.length) {
            await supabase.from("omnia_mindmap_nodes").upsert(payload, { onConflict: "id" });
          }

          const linkPayload = Object.values(links).map((link) => ({
            id: link.id,
            mindmap_id: mindmapId,
            from_id: link.fromId,
            to_id: link.toId,
            updated_at: new Date().toISOString(),
          }));
          if (linkPayload.length) {
            await supabase.from("omnia_mindmap_links").upsert(linkPayload, { onConflict: "id" });
          }

          if (pendingDeleteIds.size) {
            const ids = Array.from(pendingDeleteIds);
            pendingDeleteIds.clear();
            await supabase.from("omnia_mindmap_nodes").delete().in("id", ids);
          }

          if (pendingDeleteLinkIds.size) {
            const ids = Array.from(pendingDeleteLinkIds);
            pendingDeleteLinkIds.clear();
            await supabase.from("omnia_mindmap_links").delete().in("id", ids);
          }

          await supabase
            .from("omnia_project_mindmaps")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", mindmapId);

          set((state) => {
            state.isSaving = false;
          });
        } catch (error: any) {
          console.error("Mindmap save failed:", error);
          set((state) => {
            state.isSaving = false;
            state.lastError = error?.message || "Failed to save mindmap";
          });
        }
      });
    },

    addNode: (parentId, data) => {
      const mindmapId = get().mindmapId;
      if (!mindmapId) return null;
      const id = makeUuid();
      const pos = getSeededPosition(id);
      const node: MindmapNode = {
        id,
        mindmapId,
        parentId,
        title: String(data.title || "New node"),
        description: data.description ?? null,
        type: (data.type || "topic") as MindmapNodeType,
        positionX: Number.isFinite(data.positionX as number) ? Number(data.positionX) : pos.x,
        positionY: Number.isFinite(data.positionY as number) ? Number(data.positionY) : pos.y,
        color: data.color ?? null,
        sourceType: data.sourceType,
        sourceId: data.sourceId,
      };
      set((state) => {
        state.nodes[id] = node;
      });
      get().saveMindmap();
      return id;
    },

    updateNode: (nodeId, updates) => {
      set((state) => {
        const node = state.nodes[nodeId];
        if (!node) return;
        const patch = Object.fromEntries(
          Object.entries(updates).filter(([, value]) => value !== undefined)
        );
        Object.assign(node, patch);
      });
      get().saveMindmap();
    },

    deleteNode: (nodeId) => {
      const { rootNodeId, nodes, links } = get();
      if (!nodeId || nodeId === rootNodeId) return;
      pendingDeleteIds.add(nodeId);
      set((state) => {
        delete state.nodes[nodeId];
        for (const link of Object.values(state.links)) {
          if (link.fromId === nodeId || link.toId === nodeId) {
            pendingDeleteLinkIds.add(link.id);
            delete state.links[link.id];
          }
        }
        for (const child of Object.values(state.nodes)) {
          if (child.parentId === nodeId) child.parentId = rootNodeId;
        }
        if (state.selectedNodeId === nodeId) state.selectedNodeId = null;
      });
      get().saveMindmap();
    },

    moveNode: (nodeId, newParentId, newX, newY) => {
      set((state) => {
        const node = state.nodes[nodeId];
        if (!node) return;
        node.parentId = newParentId;
        node.positionX = newX;
        node.positionY = newY;
      });
      get().saveMindmap();
    },

    toggleLink: (fromId, toId) => {
      if (!fromId || !toId || fromId === toId) return;
      const mindmapId = get().mindmapId;
      if (!mindmapId) return;
      const id = buildLinkId(fromId, toId);
      set((state) => {
        if (state.links[id]) {
          pendingDeleteLinkIds.add(id);
          delete state.links[id];
        } else {
          state.links[id] = { id, mindmapId, fromId, toId };
        }
      });
      get().saveMindmap();
    },

    setSelectedNode: (nodeId) => {
      set((state) => {
        state.selectedNodeId = nodeId;
      });
    },

    syncExternalNodes: (items) => {
      const { nodes, rootNodeId } = get();
      const existing = Object.values(nodes);
      const incomingKey = new Set(items.map((i) => `${i.sourceType}:${i.sourceId}`));

      for (const item of items) {
        const found = existing.find(
          (n) => n.sourceType === item.sourceType && n.sourceId === item.sourceId
        );
        if (!found) {
          const pos = getSeededPosition(`${item.sourceType}:${item.sourceId}`);
          get().addNode(null, {
            title: item.title,
            type: item.sourceType === "file" ? "asset" : "note",
            positionX: pos.x,
            positionY: pos.y,
            sourceType: item.sourceType,
            sourceId: item.sourceId,
          });
        } else if (found.title !== item.title) {
          get().updateNode(found.id, { title: item.title });
        }
      }

      for (const node of existing) {
        if (!node.sourceType || !node.sourceId) continue;
        const key = `${node.sourceType}:${node.sourceId}`;
        if (incomingKey.has(key)) continue;
        if (node.sourceType === "file" || node.sourceType === "board") {
          get().deleteNode(node.id);
        }
      }
    },

    requestAIMindmapEdit: async (prompt, options) => {
      const { nodes, rootNodeId } = get();
      const nodeList = Object.values(nodes).map((n) => ({
        id: n.id,
        parentId: n.parentId,
        title: n.title,
        description: n.description,
        type: n.type,
        positionX: n.positionX,
        positionY: n.positionY,
      }));
      const context = JSON.stringify({ rootNodeId, nodes: nodeList });
      try {
        const { API_BASE_URL } = await import("@/lib/api-config");
        const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: options?.model || getSelectedAiModel(),
            intent: "mindmap",
            text: prompt,
            returnActions: true,
            context,
          }),
        });
        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          throw new Error(errorData.error || res.statusText);
        }
        const data = await res.json();
        const actions = Array.isArray(data.actions) ? data.actions : [];
        if (!actions.length) return;
        applyMindmapActions(actions, get);
      } catch (error: any) {
        console.error("Mindmap AI edit failed:", error);
        set((state) => {
          state.lastError = error?.message || "AI edit failed";
        });
      }
    },
  }))
);

const applyMindmapActions = (actions: any[], get: () => MindmapState) => {
  const list = Array.isArray(actions) ? actions : [];
  const st = get();
  const rootId = st.rootNodeId;
  for (const raw of list) {
    const type = String(raw?.type || "").trim().toLowerCase();
    if (!type) continue;

    if (type === "create_node") {
      st.addNode(raw.parentId ?? rootId ?? null, {
        title: raw.title || "New node",
        description: raw.description ?? null,
        type: raw.nodeType || raw.node_type || "topic",
        color: raw.color ?? null,
        positionX: Number.isFinite(raw.positionX) ? Number(raw.positionX) : undefined,
        positionY: Number.isFinite(raw.positionY) ? Number(raw.positionY) : undefined,
      });
      continue;
    }

    if (type === "update_node") {
      const nodeId = String(raw.nodeId || raw.id || "");
      if (!nodeId) continue;
      st.updateNode(nodeId, {
        title: raw.title,
        description: raw.description,
        type: raw.nodeType || raw.node_type,
        color: raw.color,
        positionX: Number.isFinite(raw.positionX) ? Number(raw.positionX) : undefined,
        positionY: Number.isFinite(raw.positionY) ? Number(raw.positionY) : undefined,
      });
      continue;
    }

    if (type === "delete_node") {
      const nodeId = String(raw.nodeId || raw.id || "");
      if (!nodeId || nodeId === rootId) {
        console.warn("Mindmap: refusing to delete root node", nodeId);
        continue;
      }
      st.deleteNode(nodeId);
      continue;
    }

    if (type === "reparent_node") {
      const nodeId = String(raw.nodeId || raw.id || "");
      const parentId = raw.parentId ?? null;
      if (!nodeId || nodeId === rootId) continue;
      const cur = st.nodes[nodeId];
      if (!cur) continue;
      st.moveNode(nodeId, parentId, cur.positionX, cur.positionY);
      continue;
    }

    if (type === "move_node") {
      const nodeId = String(raw.nodeId || raw.id || "");
      if (!nodeId) continue;
      const cur = st.nodes[nodeId];
      if (!cur) continue;
      const nx = Number.isFinite(raw.positionX) ? Number(raw.positionX) : cur.positionX;
      const ny = Number.isFinite(raw.positionY) ? Number(raw.positionY) : cur.positionY;
      st.moveNode(nodeId, cur.parentId, nx, ny);
    }
  }
};
