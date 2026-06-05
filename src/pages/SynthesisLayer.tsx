import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence, useDragControls } from "framer-motion";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { useUserPlan } from "@/lib/useUserPlan";
import PlanGate from "@/components/PlanGate";
import LoadingScreen from "@/components/LoadingScreen";
import { PLAN_LIMITS } from "@/lib/pricing-config";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Atom,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FolderPlus,
  Hash,
  LayoutGrid,
  Link2,
  Loader2,
  Lock,
  Network,
  PanelRightClose,
  Plus,
  Search,
  StickyNote,
  Sparkles,
  Tag,
  X,
} from "lucide-react";
import BeliefWindowPanel from "@/components/synthesis/BeliefWindowPanel";
import NeuronPanel from "@/components/synthesis/NeuronPanel";
import VaultAttachment from "@/components/synthesis/VaultAttachment";
import { parseVaultContent } from "@/lib/vaultContent";
import {
  fetchMindmapVaultGraphData,
  hydrateMindmapNoteContent,
  type MindmapNoteRow,
} from "@/lib/vault/fetchMindmapNotes";
import {
  noteSourceApp as resolveNoteSourceApp,
  type ConnectorRollupSummary,
} from "@/lib/vault/connectorSources";
import { API_BASE_URL } from "@/lib/api-config";
import { toUserFacingError } from "@/lib/ai/userFacingErrors";
import { notifyVaultCapIfApplicable } from "@/lib/vault/vaultCapError";
import {
  isSynthesisCapError,
  notifySynthesisCapIfApplicable,
} from "@/lib/vault/synthesisCapError";
import { GridIcon } from "@/components/ui/GridIcon";
// `SynthesisScene3D` pulls in three.js + react-three-fiber + drei + the
// Bloom postprocessing pipeline. That's the largest single import in the
// app — eager-importing it forced every other route to parse those modules
// at app boot. Lazy-loading keeps the rest of the app (Vault, Connections,
// Billing, …) snappy and only pays the cost when the user actually opens
// the synthesis canvas. The Suspense fallback below paints the dark canvas
// chrome so the lazy boundary is invisible to the user.
const SynthesisScene3D = lazy(() => import("@/pages/synthesis/SynthesisScene3D"));
import SynthesisSceneErrorBoundary from "@/pages/synthesis/SynthesisSceneErrorBoundary";
import { useIsMobile } from "@/hooks/useViewportTier";
import { isDemoNodeId } from "@/lib/demoSynthesis";
import { isDemoGridId } from "@/lib/demoGrids";
import { fetchBoardsWithContext } from "@/lib/board/fetchBoardsWithContext";
import {
  createUserLinks,
  listUserLinks,
  type UserLink,
} from "@/lib/userLinks";
import {
  addNeuronsToProject,
  createUserProject,
  listUserProjects,
  type UserProject,
} from "@/lib/userProjects";
import ProjectPanel from "@/components/synthesis/ProjectPanel";
import { PROJECTS_CHANGED_EVENT } from "@/lib/synthesis/projectLiveSync";

// Demo grid boards have real preview routes (see demoGrids.js), so they're
// navigable even though their ids match the `demo-*` pattern. Other demo
// node ids (vault notes) still aren't navigable because their routes
// don't exist yet.
const isBlockedDemoId = (id: string | null | undefined): boolean => {
  if (!id) return true;
  // The synthetic prototype "First Conversation" grid is registered as a
  // demo-grid id (see demoGrids.js), so it routes through /grid/<id>
  // straight into OmniaGrid like any other demo board.
  if (isDemoGridId(id)) return false;
  return isDemoNodeId(id);
};

/** Neuron kinds shown in the create/add-to-project picker. */
const PROJECT_KIND_FILTERS = [
  { id: "all", label: "All" },
  { id: "vault", label: "Vault" },
  { id: "belief", label: "Beliefs" },
  { id: "concept", label: "Concepts" },
  { id: "fact", label: "Facts" },
  { id: "learned", label: "Learned" },
  { id: "perspective", label: "Perspectives" },
  { id: "chat", label: "Chats" },
] as const;

type ProjectKindFilter = (typeof PROJECT_KIND_FILTERS)[number]["id"];

const isProjectAddableNode = (n: MindNode): boolean =>
  n.kind !== "root" && n.kind !== "category" && n.kind !== "project";

/** Bucket a graph node into a project-picker filter chip. */
const projectNodeBucket = (n: MindNode): Exclude<ProjectKindFilter, "all"> => {
  if (n.kind === "grid") return "chat";
  if (n.kind === "neuron" && n.meta?.source === "manual_fact") return "fact";
  if (n.kind === "neuron") return "learned";
  return n.kind as Exclude<ProjectKindFilter, "all">;
};

const projectNodeKindLabel = (n: MindNode): string => {
  const bucket = projectNodeBucket(n);
  if (bucket === "fact" && n.meta?.kindLabel) return String(n.meta.kindLabel);
  if (bucket === "learned" && n.meta?.neuronKind) return String(n.meta.neuronKind);
  const chip = PROJECT_KIND_FILTERS.find((f) => f.id === bucket);
  return chip?.label ?? bucket;
};

const projectNodeSearchHaystack = (n: MindNode): string =>
  `${n.label || ""} ${projectNodeKindLabel(n)} ${projectNodeBucket(n)} ${n.meta?.kindLabel || ""} ${n.meta?.neuronKind || ""}`.toLowerCase();


/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */
//
// Graph + simulation types live in `./synthesis/layoutTypes` so the
// Web Worker that runs `simulateLayout` (`./synthesis/layoutEngine`)
// can import them without dragging React + the rest of this module
// into the worker bundle. Re-imported here so the rest of this file
// reads unchanged.

import type {
  NodeKind,
  MindNode,
  MindEdge,
  SimNode,
  LayoutMode,
} from "./synthesis/layoutTypes";
import { simulateLayout } from "./synthesis/layoutEngine";
import LayoutWorker from "./synthesis/layoutWorker?worker";
import type {
  LayoutRequest,
  LayoutResponse,
} from "./synthesis/layoutWorker";

/* ------------------------------------------------------------------ */
/*  Palette                                                            */
/* ------------------------------------------------------------------ */

const palette = {
  root:     { bg: "#6366f1", glow: "rgba(99,102,241,0.35)" },
  // Projects — user-authored neuron clusters (lykn_projects + lykn_project_
  // neurons). Surfaced as their own top-level Projects category so the
  // user can navigate their projects directly from the brain. Teal is
  // chosen so the cluster reads distinctly against Chats (blue), Vault
  // (green), Concepts (orange), Facts (pink), and Beliefs (white).
  // (Note: boards still carry `project_id` in their DB row independently;
  // those don't surface here — only the user-clustered `lykn_projects`
  // rows do. The old sidebar-projects category was retired; this new
  // category is purpose-built for the user-clustered projects feature.)
  projects: { bg: "#14b8a6", glow: "rgba(20,184,166,0.32)" },
  project:  { bg: "#2dd4bf", glow: "rgba(45,212,191,0.30)" },
  grids:    { bg: "#3b82f6", glow: "rgba(59,130,246,0.30)" },
  vault:    { bg: "#10b981", glow: "rgba(16,185,129,0.30)" },
  // Legacy palette entries kept so any older `node.color` reads (e.g.
  // tag pills, neuron subroutines that still reference these slugs)
  // don't crash. After the 5-category collapse the only categories
  // that still surface as containers are Chats / Vault / Belief /
  // Facts / Concepts. `tags`, `neurons`, `beliefs`, `perspectives` no
  // longer back a top-level cluster but the swatches remain for
  // legacy meta / edge-case rendering.
  tags:     { bg: "#f59e0b", glow: "rgba(245,158,11,0.30)" },
  neurons:  { bg: "#ec4899", glow: "rgba(236,72,153,0.30)" },
  beliefs:  { bg: "#818cf8", glow: "rgba(129,140,248,0.40)" },
  // Concepts are the cross-cutting topic layer (056-058 migrations).
  // Palette is a warm amber so they read as a third cluster distinct
  // from neurons (pink) and beliefs (indigo). The concept cluster
  // semantically lives "between" beliefs and the raw notes/facts —
  // they organise everything else without being normative.
  concepts: { bg: "#f97316", glow: "rgba(249,115,22,0.35)" },
  // Facts — observable truths about the user. In the 5-category model
  // this cluster absorbs the old "AI Learned" tier (themes, goals,
  // recurring topics, vocabulary), so it inherits the pink palette
  // that tier used to wear — both user-stated and AI-observed facts
  // share the same visual identity now ("once it's a fact, it's just
  // a fact"). The deeper pink for the category sphere matches the
  // historical `palette.neurons.bg`.
  facts:    { bg: "#ec4899", glow: "rgba(236,72,153,0.35)" },
  // Perspectives — long-form stories / points of view the user has
  // explicitly written down. Sits next to Facts as another user-
  // authored tier (Facts = short; Perspectives = long). Coloured violet
  // so the cluster reads as its own thing distinct from Beliefs
  // (indigo) which are normative, while Perspectives are narrative.
  perspectives: { bg: "#c4b5fd", glow: "rgba(196,181,253,0.35)" },
  grid:     { bg: "#60a5fa", glow: "rgba(96,165,250,0.25)" },
  note:     { bg: "#34d399", glow: "rgba(52,211,153,0.25)" },
  tag:      { bg: "#fbbf24", glow: "rgba(251,191,36,0.25)" },
  neuron:   { bg: "#f472b6", glow: "rgba(244,114,182,0.25)" },
  // BELIEF — the deepest-self cluster (beliefs + perspectives bundled).
  // Pure white so the cluster reads as "lit from within" against the
  // colored category clusters around it. White + the boosted emissive
  // in SynthesisScene3D (3.6, pulsing) makes the principles look like
  // little stars, which matches the intent that beliefs are the
  // highest-order tier and the AI's brightest signal. The same swatch
  // backs both the `__cat_belief__` category sphere and individual
  // belief / perspective nodes inside it.
  belief:   { bg: "#ffffff", glow: "rgba(255,255,255,0.45)" },
  // Individual concept nodes — slightly desaturated amber so they
  // recede next to belief stars but still pop out as a coherent
  // cluster amid the colored category groups around them.
  concept:  { bg: "#fb923c", glow: "rgba(251,146,60,0.30)" },
  // Individual perspective nodes — slightly brighter violet than the
  // category glow so they pop within their own cluster without
  // overpowering the brighter belief stars next door.
  perspective: { bg: "#a78bfa", glow: "rgba(167,139,250,0.30)" },
};

/* ------------------------------------------------------------------ */
/*  Build graph                                                        */
/* ------------------------------------------------------------------ */

// `content` is intentionally NOT in the mindmap notes query — it can run
// into hundreds of KB for power users and the graph only needs the
// summary/themes for cross-edge heuristics. The DetailPanel lazy-fetches
// the body when a vault node is actually opened (see `vaultContentQuery`).
// Optional here so legacy callers (e.g. WelcomePanel removal) still compile.
type NoteRow = MindmapNoteRow & { ai_signals?: any };

// Connector source slug → (app key, display label). Notes whose `source`
// matches one of these get collapsed into a single rollup node per app
// inside the Vault category instead of each becoming its own vault node.
//
// Why a rollup at all — the synthesis layer should read as "the user's
// brain". Manually saved notes, web-clipper captures, and share-sheet
// items are deliberate brain content; they remain individual nodes. But
// a connected Gmail inbox can sync hundreds of messages a week, and a
// connected Notion workspace can sync hundreds of pages on first auth.
// Painting one neon dot per inbox item buries the user's real notes
// under a wall of noise and makes the page misrepresent what's
// actually in their head — "1000 dots" reads as "1000 thoughts" when
// it's really "1000 emails my CEO sent me".
//
// The data is NOT hidden from synthesis: chunks are still embedded,
// facts still extract, concepts still mint, beliefs still promote.
// The rollup is purely a visualisation collapse so the graph stays
// scannable. Clicking the rollup opens a DetailPanel listing the
// underlying items, each with the same lazy-content fetch a normal
// vault node uses.
//
// Magic tag that marks a Vault note as a Perspective neuron. We
// piggyback on the existing `notes` table for storage so the
// Perspective composer doesn't require a new migration, but the
// synthesis layer hides these from the Vault cluster and surfaces
// them under their own Perspectives category instead. The leading
// underscore keeps the tag from cluttering the user's normal tag
// list in the Vault UI (tag rendering filters out underscore-
// prefixed labels — see `isUserFacingTag` below).
export const PERSPECTIVE_NOTE_TAG = "_perspective";

function isPerspectiveNote(note: NoteRow): boolean {
  return Array.isArray(note.tags) && note.tags.includes(PERSPECTIVE_NOTE_TAG);
}

function isUserFacingTag(tag: string): boolean {
  // Tags starting with `_` are internal markers (currently just
  // `_perspective`) — hide them from the tag cloud so the user
  // never sees a "#_perspective" pseudo-tag floating around.
  return !tag.startsWith("_");
}

function noteSourceApp(note: NoteRow): { app: string; label: string } | null {
  return resolveNoteSourceApp(note.source);
}

function sourceRollupNodeId(app: string): string {
  return `vault_source_${app}`;
}

function extractNoteThemes(note: NoteRow): string[] {
  const themes: string[] = [];
  if (note.ai_signals) {
    const sig = typeof note.ai_signals === "string" ? JSON.parse(note.ai_signals) : note.ai_signals;
    if (Array.isArray(sig?.themes)) themes.push(...sig.themes.map((t: any) => String(t).toLowerCase().trim()));
    if (Array.isArray(sig?.recurring_topics)) themes.push(...sig.recurring_topics.map((t: any) => String(t).toLowerCase().trim()));
    if (Array.isArray(sig?.entities)) themes.push(...sig.entities.map((t: any) => String(t).toLowerCase().trim()));
  }
  return [...new Set(themes)].filter(Boolean);
}

interface SynthesisData {
  themes: string[];
  narrative: string;
  signals: Record<string, any>;
}

type ChunkRow = { source_type: string; source_id: string; content: string };

const STOP_WORDS = new Set([
  "that","this","with","from","have","been","will","were","they","their",
  "about","would","could","should","which","there","these","those","being",
  "other","after","before","where","while","under","above","between","through",
  "again","further","here","just","more","most","only","some","such","than",
  "them","then","very","also","into","over","when","what","does","each",
]);

function extractKeywords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 4 && !STOP_WORDS.has(w)),
  );
}

const EMPTY_VAULT_GRID_MAP: Map<string, Set<string>> = new Map();

function buildVaultGridMap(chunks: ChunkRow[]): Map<string, Set<string>> {
  const vaultChunks = chunks.filter((c) => c.source_type === "vault_note");
  const gridChunks = chunks.filter((c) => c.source_type === "grid_board");
  if (!vaultChunks.length || !gridChunks.length) return new Map();

  const gridKw = new Map<string, Set<string>>();
  gridChunks.forEach((gc) => gridKw.set(gc.source_id, extractKeywords(gc.content)));

  const mapping = new Map<string, Set<string>>();
  vaultChunks.forEach((vc) => {
    const vkw = extractKeywords(vc.content);
    gridKw.forEach((gkw, boardId) => {
      let shared = 0;
      for (const kw of vkw) { if (gkw.has(kw) && ++shared >= 3) break; }
      if (shared >= 3) {
        if (!mapping.has(vc.source_id)) mapping.set(vc.source_id, new Set());
        mapping.get(vc.source_id)!.add(boardId);
      }
    });
  });
  return mapping;
}

function buildGraph(
  boards: { id: string; title: string; created_at?: string | null }[],
  notes: NoteRow[],
  synthesisThemes: string[],
  synthesis: SynthesisData | null,
  vaultGridMap: Map<string, Set<string>>,
  // Active beliefs (Hyrum-Smith belief-window layer). Rendered as their own
  // category cluster so the user can see the principles the AI answers
  // through. Empty array means we omit the category entirely.
  beliefs: Array<{
    id: string;
    belief_text: string;
    serves_need: string;
    confidence: number;
    status?: string;
    rationale?: string | null;
    source?: string | null;
    created_at?: string;
  }> = [],
  // User-stated / user-confirmed atomic facts. Rendered as additional
  // "AI Learned" neurons so freshly-saved Basic neurons appear in the
  // graph instantly (otherwise they'd only surface after a synthesis
  // profile rebuild, which made the Save button look like a no-op).
  manualFacts: Array<{
    id: string;
    fact_kind: string;
    fact_text: string;
    confidence: number;
    status?: string;
    first_seen_at?: string;
    last_seen_at?: string;
  }> = [],
  // Provenance walked server-side from `lykn_beliefs.promoted_from_facts`
  // and each promoting fact's `evidence[]` array. Drives the cross-
  // cluster edges (belief→fact, fact→vault note, fact→board) that turn
  // the 3D view into a visible web rather than four clusters around a
  // root. Loaded by `get_belief_provenance` and grouped by belief_id
  // for cheap iteration here. Empty map = no edges added (older clients
  // without the migration still render the legacy hierarchy fine).
  beliefProvenance: Map<string, Array<{ factId: string; sourceType: string; sourceId: string }>> = new Map(),
  // First-class concepts (058 RPC: concepts_overview). Each carries
  // its label + counts so the graph can both render a concept node
  // and immediately know how connected it is for layout / sizing.
  // Empty array means we omit the concepts category entirely (same
  // behavior as the beliefs cluster when no beliefs are active).
  concepts: Array<{
    concept_id: string;
    label: string;
    kind: string;
    source: string;
    status: string;
    confidence: number;
    note_count: number;
    fact_count: number;
    belief_count: number;
    chat_count: number;
    last_touched_at?: string | null;
    created_at?: string | null;
  }> = [],
  // Links per concept — populated by paging through concept_links()
  // for the concepts in view. Map<concept_id, Array<link>> where
  // each link is { kind: note|fact|belief|chat, targetId }.
  // Drives the concept-cluster cross-edges to the underlying nodes
  // (concept → vault, concept → fact, concept → belief, concept →
  // grid) so the orange concept layer ties everything together.
  conceptLinks: Map<string, Array<{ kind: "note" | "fact" | "belief" | "chat"; targetId: string }>> = new Map(),
  // Optional: categories that should always appear even if they have no
  // children. Used by the landing prototype so a brand-new guest sees the
  // shell of their future workspace (Chats / Vault / Tags)
  // sitting empty alongside the neurons they've just created.
  forceCategoryIds: Set<string> = new Set(),
  // Optional: override the label on the root "Your Mind" node. Used by the
  // landing prototype handoff to render the root as "Your Synthesis Layer".
  rootLabel: string = "Your Mind",
  // User-authored projects (lykn_projects). Surfaced as a top-level
  // Projects category — each project becomes its own node parented to
  // __cat_projects__, with cross-edges out to every clustered member
  // node so the user can see at a glance which neurons belong to which
  // project. Clicking a project node opens the existing ProjectPanel
  // (updates + connected neurons + add-neurons CTA). Empty array means
  // the category is omitted unless forceCategoryIds includes
  // __cat_projects__.
  userProjects: UserProject[] = [],
  // Accurate per-app connector totals from vault_connector_source_counts()
  // (migration 073). Manual notes in `notes` exclude connector rows;
  // rollups are materialised from these counts instead of row scans.
  connectorRollups: ConnectorRollupSummary[] = [],
) {
  const nodes: MindNode[] = [];
  const edges: MindEdge[] = [];

  const rootId = "__root__";
  nodes.push({ id: rootId, label: rootLabel, kind: "root", radius: 42, color: palette.root.bg, glow: palette.root.glow, parentId: null, meta: { narrative: synthesis?.narrative } });

  // Split notes into Perspective neurons vs regular Vault notes. The
  // user creates Perspectives via the Perspective template in the
  // "+" menu (long-form title + story). We piggyback storage on the
  // `notes` table with a magic `_perspective` tag, but the synthesis
  // layer must keep these out of the green Vault cluster so a
  // Perspective doesn't show up twice in the brain.
  const perspectiveNotes = notes.filter(isPerspectiveNote);
  const vaultNotes = notes.filter((n) => !isPerspectiveNote(n));

  const cats: { id: string; label: string; color: string; glow: string }[] = [];
  if (boards.length > 0 || forceCategoryIds.has("__cat_grids__")) cats.push({ id: "__cat_grids__", label: "Chats", color: palette.grids.bg, glow: palette.grids.glow });
  if (vaultNotes.length > 0 || connectorRollups.length > 0 || forceCategoryIds.has("__cat_vault__")) {
    cats.push({ id: "__cat_vault__", label: "Vault", color: palette.vault.bg, glow: palette.vault.glow });
  }

  // Tag pass operates on the regular Vault notes only — Perspectives
  // carry the `_perspective` marker tag which we never want to expose
  // as a user-facing tag. `isUserFacingTag` also filters any future
  // underscore-prefixed internal tags out of the visible tag cloud.
  //
  // Post-slim-down (5-category model), tags are NOT a top-level cluster
  // — they're per-Vault-item attributes. We still walk the tag set
  // here so we can draw vault↔vault cross-edges between notes that
  // share a tag (see the "Shared-tag cross-edges" pass further down),
  // which preserves the "tagged notes feel connected in the brain"
  // signal without spending pixels on an orange Tags landmark.
  const allTags = new Set<string>();
  vaultNotes.forEach((n) => (n.tags || []).forEach((t) => {
    if (isUserFacingTag(t)) allTags.add(t);
  }));

  cats.forEach((c) => {
    nodes.push({ id: c.id, label: c.label, kind: "category", radius: 30, color: c.color, glow: c.glow, parentId: rootId });
    edges.push({ from: rootId, to: c.id });
  });

  boards.forEach((b) => {
    const nid = `grid_${b.id}`;
    nodes.push({ id: nid, label: b.title || "New Chat", kind: "grid", radius: 20, color: palette.grid.bg, glow: palette.grid.glow, parentId: "__cat_grids__", categoryId: "__cat_grids__", meta: { boardId: b.id, createdAt: b.created_at || null } });
    edges.push({ from: "__cat_grids__", to: nid });
  });

  // Build per-note theme map for cross-linking
  const noteThemeMap = new Map<string, string[]>();
  notes.forEach((n) => {
    const themes = extractNoteThemes(n);
    noteThemeMap.set(n.id, themes);
  });

  // Partition notes into individual vault nodes vs. connector-source
  // rollups. Manual saves (no source / unknown source) get their own
  // node — those are the user's deliberate brain content. Connector
  // syncs (gmail, slack, notion, …) all collapse into a single rollup
  // per app so a few thousand inbox items don't repaint the page as
  // noise. See the CONNECTOR_SOURCE_APPS comment for the rationale.
  //
  // `noteIdToVaultNodeId` is the source of truth for every downstream
  // pass that wants to draw an edge to a note (tag pass, theme pass,
  // neuron pass, concept_links, belief provenance). They MUST go
  // through `vaultNodeIdFor()` so edges to rolled-up notes get
  // redirected onto the rollup id instead of dangling against a
  // non-existent `vault_<id>` node.
  const noteIdToVaultNodeId = new Map<string, string>();
  type RollupGroup = {
    app: string;
    label: string;
    items: Array<{ noteId: string; title: string; ai_summary: string | null; tags: string[]; sourceSlug: string }>;
    aggregateCount?: number;
  };
  const rollupGroups = new Map<string, RollupGroup>();

  // Seed rollups from server-side counts (accurate totals, no row fetch).
  for (const rollup of connectorRollups) {
    const rollupId = sourceRollupNodeId(rollup.app);
    rollupGroups.set(rollupId, {
      app: rollup.app,
      label: rollup.label,
      items: [],
      aggregateCount: rollup.itemCount,
    });
  }

  // Vault rendering iterates over the non-perspective slice only.
  // Perspectives get their own cluster below; double-rendering would
  // both clutter the Vault and break cross-cluster edges (a concept
  // link to a perspective should target the Perspective node, not a
  // shadow copy under Vault).
  vaultNotes.forEach((n) => {
    const sourceInfo = noteSourceApp(n);
    if (sourceInfo) {
      const rollupId = sourceRollupNodeId(sourceInfo.app);
      noteIdToVaultNodeId.set(n.id, rollupId);
      // Fallback when migration 073 is not applied: accumulate sample
      // rows client-side so rollups still render (counts may be low).
      let group = rollupGroups.get(rollupId);
      if (!group) {
        group = { app: sourceInfo.app, label: sourceInfo.label, items: [] };
        rollupGroups.set(rollupId, group);
      }
      group.items.push({
        noteId: n.id,
        title: n.title || "Untitled",
        ai_summary: n.ai_summary || null,
        tags: n.tags || [],
        sourceSlug: String(n.source || ""),
      });
      return;
    }

    const noteThemes = noteThemeMap.get(n.id) || [];
    const attachments = n.content?.includes("[ATTACHMENTS_JSON:")
      ? parseVaultContent(n.content).attachments
      : [];

    // Vault renders one card per attachment; mirror that here so a note
    // backing three files becomes three neurons, not one.
    if (attachments.length > 1) {
      attachments.forEach((att, idx) => {
        const nid = `vault_${n.id}_att_${idx}`;
        if (idx === 0) noteIdToVaultNodeId.set(n.id, nid);
        const attName = String(att?.name || att?.title || "").trim();
        const preview =
          (attName || n.title || n.ai_summary || "").slice(0, 60).trim() || "Note";
        nodes.push({
          id: nid,
          label: preview,
          kind: "vault",
          radius: 18,
          color: palette.note.bg,
          glow: palette.note.glow,
          parentId: "__cat_vault__",
          categoryId: "__cat_vault__",
          meta: {
            noteId: n.id,
            attachmentIndex: idx,
            title: attName || n.title,
            tags: n.tags,
            ai_summary: n.ai_summary,
            themes: noteThemes,
            createdAt: n.created_at || null,
            vaultItemHint: String(att?.type || ""),
          },
        });
        edges.push({ from: "__cat_vault__", to: nid });
      });
      return;
    }

    const nid = `vault_${n.id}`;
    noteIdToVaultNodeId.set(n.id, nid);
    // Preview prefers title → summary → attachment name → "Note".
    const singleAttName =
      attachments.length === 1 ? String(attachments[0]?.name || "").trim() : "";
    const preview =
      (n.title || singleAttName || n.ai_summary || "").slice(0, 60).trim() || "Note";
    nodes.push({
      id: nid,
      label: preview,
      kind: "vault",
      radius: 18,
      color: palette.note.bg,
      glow: palette.note.glow,
      parentId: "__cat_vault__",
      categoryId: "__cat_vault__",
      meta: {
        noteId: n.id,
        title: n.title,
        tags: n.tags,
        ai_summary: n.ai_summary,
        themes: noteThemes,
        createdAt: n.created_at || null,
        vaultItemHint:
          attachments.length === 1 ? String(attachments[0]?.type || "") : undefined,
      },
    });
    edges.push({ from: "__cat_vault__", to: nid });
  });

  // Helper used everywhere downstream that previously hard-coded
  // `vault_${noteId}`. For rolled-up notes this returns the rollup
  // node id; for individual notes it returns the per-note id; if the
  // note isn't in our payload at all (truncated by the query LIMIT)
  // it falls back to a literal `vault_<id>` — that edge will be
  // dropped by the layout engine's `visibleIds` filter, same as
  // today's behaviour for orphan provenance/concept-link targets.
  const vaultNodeIdFor = (noteId: string): string =>
    noteIdToVaultNodeId.get(noteId) || `vault_${noteId}`;

  // Materialize rollup nodes after the per-note loop so the size +
  // label reflect the final aggregate. Sort by item count desc so
  // when the simulation seeds children around the Vault category,
  // the biggest connector inboxes get the most prominent placement.
  const sortedRollups = Array.from(rollupGroups.entries()).sort(
    (a, b) => {
      const countA = a[1].aggregateCount ?? a[1].items.length;
      const countB = b[1].aggregateCount ?? b[1].items.length;
      return countB - countA;
    },
  );
  sortedRollups.forEach(([rollupId, group]) => {
    const itemCount = group.aggregateCount ?? group.items.length;
    if (itemCount <= 0) return;
    const radius = Math.min(28, 18 + Math.floor(Math.log2(itemCount + 1) * 1.6));
    nodes.push({
      id: rollupId,
      label: `${group.label} · ${itemCount.toLocaleString()}`,
      kind: "vault",
      radius,
      color: palette.note.bg,
      glow: palette.note.glow,
      parentId: "__cat_vault__",
      categoryId: "__cat_vault__",
      meta: {
        isSourceRollup: true,
        sourceApp: group.app,
        sourceLabel: group.label,
        itemCount,
        items: group.items.slice(0, 300),
      },
    });
    edges.push({ from: "__cat_vault__", to: rollupId });
  });

  const tagArr = Array.from(allTags);
  // Shared-tag cross-edges. Tags are no longer their own cluster, so the
  // visual signal "these two notes share #design" has to come from a
  // direct vault↔vault line rather than a #design tag node both notes
  // attach to. For each tag, we draw a STAR pattern (notes[0] → each
  // other vault node tagged with it) instead of every-pair so a tag
  // shared by 30 notes doesn't blow up to 435 edges. The 8-note cap
  // per tag keeps even popular tags bounded; tags rarely connect more
  // than ~8 notes in a way the user actually wants to see threaded in
  // the brain. `addCrossEdge` (defined below) dedupes across tags so
  // two notes sharing three tags still produce a single edge.
  //
  // We push the edges directly here instead of through `addCrossEdge`
  // because the helper isn't declared until later in this function;
  // dedup happens via the `edgeSet` `addCrossEdge` builds out of the
  // edges array, so these still get deduped against the heuristic /
  // provenance passes that follow.
  const SHARED_TAG_EDGE_CAP = 8;
  tagArr.forEach((tag) => {
    const tagged = vaultNotes.filter((n) => (n.tags || []).includes(tag));
    if (tagged.length < 2) return;
    const targets = new Set<string>();
    tagged.forEach((n) => {
      const t = vaultNodeIdFor(n.id);
      targets.add(t);
    });
    const targetArr = Array.from(targets);
    if (targetArr.length < 2) return;
    const hub = targetArr[0];
    targetArr.slice(1, 1 + SHARED_TAG_EDGE_CAP).forEach((other) => {
      if (other === hub) return;
      edges.push({ from: hub, to: other, cross: true });
    });
  });

  // --- Neurons: AI-learned themes, goals, patterns from synthesis ---
  const neuronItems: { id: string; label: string; kind: "theme" | "goal" | "pattern" | "topic"; source: string }[] = [];

  if (synthesis) {
    (synthesis.themes || []).forEach((t: string) => {
      neuronItems.push({ id: `neuron_theme_${t}`, label: t, kind: "theme", source: "theme" });
    });
    const sig = synthesis.signals || {};
    if (Array.isArray(sig.goals)) {
      sig.goals.forEach((g: string) => neuronItems.push({ id: `neuron_goal_${g}`, label: g, kind: "goal", source: "goal" }));
    }
    if (Array.isArray(sig.recurring_topics)) {
      sig.recurring_topics.forEach((t: string) => {
        const nid = `neuron_topic_${t}`;
        if (!neuronItems.some((n) => n.id === nid)) {
          neuronItems.push({ id: nid, label: t, kind: "topic", source: "recurring_topic" });
        }
      });
    }
    if (sig.reasoning_style && typeof sig.reasoning_style === "string") {
      neuronItems.push({ id: `neuron_style_reasoning`, label: sig.reasoning_style, kind: "pattern", source: "reasoning_style" });
    }
    if (Array.isArray(sig.vocabulary)) {
      sig.vocabulary.slice(0, 8).forEach((v: string) => {
        neuronItems.push({ id: `neuron_vocab_${v}`, label: v, kind: "pattern", source: "vocabulary" });
      });
    }
  }

  // 5-category model:
  //   • Chats     — conversations + boards (above)
  //   • Vault     — files / notes / clippings (above) + tags-as-attributes
  //   • Belief    — Beliefs + Perspectives bundled (the deepest-self layer)
  //   • Facts     — user-stated facts + AI-learned themes/goals/topics
  //   • Concepts  — recurring themes that tie everything together
  //
  // The retired top-level clusters (Tags, AI Learned, Perspectives
  // alone) all fold into one of those five. Comments below reference
  // the new home of each old cluster.

  // BELIEF — beliefs (white "stars") + perspectives (long-form stories)
  // share one cluster. They both express the deepest layer of the
  // user (principles + narrative), and rendering them together stops
  // the user from feeling like "Beliefs" and "Perspectives" are two
  // separate things to maintain. The category is labelled "Belief"
  // singular even though perspectives live inside it — perspectives
  // will surface as a Belief sub-type when we build out the sub-
  // chooser; for now they ride along under the Belief umbrella.
  const beliefHasContent = beliefs.length > 0 || perspectiveNotes.length > 0;
  if (beliefHasContent || forceCategoryIds.has("__cat_belief__")) {
    cats.push({ id: "__cat_belief__", label: "Beliefs", color: palette.belief.bg, glow: palette.belief.glow });
  }

  // Concepts — first-class topic layer (migrations 056-058). Sits as a
  // sibling cluster to You; the orange dots earn their pixels by
  // tying together the colored clusters around them. We hide
  // dismissed concepts and concepts with zero attachments by default
  // so downstream layout + cross-edge passes only see the kept ones.
  const liveConcepts = (concepts || []).filter((c) => {
    if (!c?.concept_id) return false;
    if (c.status === "dismissed") return false;
    const total = (c.note_count || 0) + (c.fact_count || 0) + (c.belief_count || 0) + (c.chat_count || 0);
    // user_authored / promoted_from_* concepts always render even at
    // zero links so the user can see what they've explicitly minted;
    // ai_clustered + proposed concepts hide until they've earned at
    // least one link to avoid cluttering the graph with noise.
    if (total > 0) return true;
    return c.source !== "ai_clustered" || c.status === "active";
  });
  if (liveConcepts.length > 0 || forceCategoryIds.has("__cat_concepts__")) {
    cats.push({ id: "__cat_concepts__", label: "Concepts", color: palette.concepts.bg, glow: palette.concepts.glow });
  }

  // Facts — observable truths about the user. Two sources land here:
  //   1. `manualFacts`: things the user explicitly typed into the
  //      Fact composer ("I live in Seattle", "I'm building LYKN").
  //   2. `neuronItems`: themes / goals / recurring topics / vocabulary
  //      the synthesis profile inferred. Pre-collapse these lived in
  //      a separate "AI Learned" cluster; the 5-category model folds
  //      them in here. The user can always correct or add — there's
  //      no visual distinction between "you wrote this" and "AI
  //      noticed this" once it's a fact.
  const factsHasContent = manualFacts.length > 0 || neuronItems.length > 0;
  if (factsHasContent || forceCategoryIds.has("__cat_facts__")) {
    cats.push({ id: "__cat_facts__", label: "Facts", color: palette.facts.bg, glow: palette.facts.glow });
  }

  if ((beliefHasContent || forceCategoryIds.has("__cat_belief__")) && !nodes.some((n) => n.id === "__cat_belief__")) {
    nodes.push({ id: "__cat_belief__", label: "Beliefs", kind: "category", radius: 32, color: palette.belief.bg, glow: palette.belief.glow, parentId: rootId });
    edges.push({ from: rootId, to: "__cat_belief__" });
  }
  if ((liveConcepts.length > 0 || forceCategoryIds.has("__cat_concepts__")) && !nodes.some((n) => n.id === "__cat_concepts__")) {
    nodes.push({ id: "__cat_concepts__", label: "Concepts", kind: "category", radius: 30, color: palette.concepts.bg, glow: palette.concepts.glow, parentId: rootId });
    edges.push({ from: rootId, to: "__cat_concepts__" });
  }
  if ((factsHasContent || forceCategoryIds.has("__cat_facts__")) && !nodes.some((n) => n.id === "__cat_facts__")) {
    nodes.push({ id: "__cat_facts__", label: "Facts", kind: "category", radius: 30, color: palette.facts.bg, glow: palette.facts.glow, parentId: rootId });
    edges.push({ from: rootId, to: "__cat_facts__" });
  }

  // Perspective nodes — long-form stories the user explicitly
  // authored via the Perspective template. The note row stores the
  // headline in `title` and the body in `content` (`content` isn't on
  // this query's projection, so the DetailPanel lazy-fetches it on
  // demand via the same path Vault notes use). Slightly larger than
  // Vault notes so they read as deliberate landmarks in the cluster.
  perspectiveNotes.forEach((n) => {
    const nid = `perspective_${n.id}`;
    const label = (n.title || n.ai_summary || "Perspective").slice(0, 60).trim() || "Perspective";
    nodes.push({
      id: nid,
      label,
      kind: "perspective",
      radius: 20,
      // Perspectives now share the white Belief treatment. Pre-collapse
      // they had their own violet swatch; the 5-category model
      // unifies them so the user reads beliefs and perspectives as
      // one cohesive deepest-self cluster instead of two parallel
      // tiers competing for attention.
      color: palette.belief.bg,
      glow: palette.belief.glow,
      parentId: "__cat_belief__",
      categoryId: "__cat_belief__",
      meta: {
        // Mirror the Vault meta shape so the DetailPanel's existing
        // note-fetching path (which keys off `noteId`) Just Works for
        // perspectives too — the body lazy-loads from `notes.content`
        // the moment the user opens the node.
        noteId: n.id,
        title: n.title,
        ai_summary: n.ai_summary,
        tags: n.tags,
        isPerspective: true,
        createdAt: n.created_at || null,
      },
    });
    edges.push({ from: "__cat_belief__", to: nid });
  });

  // Concept nodes — placed under their own category. Sized by total
  // attached items so concepts with deep coverage (lots of notes /
  // facts / beliefs / chats) read as landmarks; sparsely-attached
  // proposals stay small. Cross-cluster edges to the underlying
  // notes / facts / beliefs / boards are drawn in the cross-edge
  // pass below using `conceptLinks` once every node has been
  // created (same pattern beliefs use for provenance edges).
  const conceptIdToNodeId = new Map<string, string>();
  liveConcepts.forEach((c) => {
    const nid = `concept_${c.concept_id}`;
    conceptIdToNodeId.set(c.concept_id, nid);
    const total = (c.note_count || 0) + (c.fact_count || 0) + (c.belief_count || 0) + (c.chat_count || 0);
    // Bigger than vault notes (18) and neurons (16), smaller than
    // beliefs (24). Concepts that bind together a dozen items
    // visibly outweigh those tying together two.
    const radius = 18 + Math.min(8, Math.floor(total / 3));
    const labelShown = c.label.length > 32 ? `${c.label.slice(0, 30)}…` : c.label;
    nodes.push({
      id: nid,
      label: labelShown,
      kind: "concept",
      radius,
      color: palette.concept.bg,
      glow: palette.concept.glow,
      parentId: "__cat_concepts__",
      categoryId: "__cat_concepts__",
      meta: {
        conceptId: c.concept_id,
        conceptLabel: c.label,
        conceptKind: c.kind,
        conceptSource: c.source,
        conceptStatus: c.status,
        conceptConfidence: c.confidence,
        conceptNoteCount: c.note_count,
        conceptFactCount: c.fact_count,
        conceptBeliefCount: c.belief_count,
        conceptChatCount: c.chat_count,
        conceptLastTouchedAt: c.last_touched_at || null,
        conceptCreatedAt: c.created_at || null,
      },
    });
    edges.push({ from: "__cat_concepts__", to: nid });
  });

  // Belief nodes — placed under their own category. Each belief is bigger
  // than a neuron because it represents a higher-order principle. Cross-
  // cluster edges to the supporting facts (and through them to the
  // source vault notes / boards) are drawn in the provenance pass at
  // the bottom of this function once every node has been created.
  beliefs.forEach((b) => {
    const nid = `belief_${b.id}`;
    nodes.push({
      id: nid,
      label: b.belief_text.length > 48 ? `${b.belief_text.slice(0, 46)}…` : b.belief_text,
      kind: "belief",
      // Belief nodes are intentionally larger than neurons — principles
      // should out-mass facts in the spatial map so the eye treats them as
      // landmarks. Bumped from 19 → 24 alongside the brighter emissive in
      // SynthesisScene3D.
      radius: 24,
      color: palette.belief.bg,
      glow: palette.belief.glow,
      parentId: "__cat_belief__",
      categoryId: "__cat_belief__",
      meta: {
        beliefId: b.id,
        beliefText: b.belief_text,
        servesNeed: b.serves_need,
        confidence: b.confidence,
        beliefStatus: b.status || "active",
        beliefRationale: b.rationale || null,
        beliefSource: b.source || null,
        beliefCreatedAt: b.created_at || null,
      },
    });
    edges.push({ from: "__cat_belief__", to: nid });
  });

  // Slugs covered by a first-class concept node. We demote the
  // heuristic `neuron_theme_*` / `neuron_topic_*` neurons that just
  // mirror those slugs so the user doesn't see the same label twice
  // (once as an orange concept, once as a pink neuron) in the same
  // scene. Other neuron kinds (goals, vocabulary, reasoning style)
  // always render — they're orthogonal to concepts.
  const conceptCoverSlugs = new Set<string>(
    liveConcepts.map((c) => String(c.label || "").toLowerCase().trim()).filter(Boolean),
  );

  const neuronNodeIds = new Set<string>();
  neuronItems.forEach((ni) => {
    if (neuronNodeIds.has(ni.id)) return;
    // If a first-class concept already represents this label, drop
    // the duplicate neuron node — the cross-edges the neuron block
    // would have built (notes/boards/tags by string match)
    // are reconstructed by the concept→target pass below using the
    // real concept_links data, which is strictly higher signal.
    if ((ni.kind === "theme" || ni.kind === "topic") && conceptCoverSlugs.has(ni.label.toLowerCase().trim())) {
      return;
    }
    neuronNodeIds.add(ni.id);
    const kindLabel = ni.kind === "theme" ? "Theme" : ni.kind === "goal" ? "Goal" : ni.kind === "topic" ? "Topic" : "Pattern";
    nodes.push({
      id: ni.id, label: ni.label, kind: "neuron", radius: 16,
      // Post-slim-down AI-learned neurons (themes / goals / topics /
      // vocabulary / reasoning_style) land inside the Facts cluster
      // with the Facts cyan treatment — no separate "AI Learned" tier.
      // The user can correct/edit them like any other fact.
      color: palette.facts.bg, glow: palette.facts.glow,
      parentId: "__cat_facts__", categoryId: "__cat_facts__",
      meta: { neuronKind: ni.kind, source: ni.source, kindLabel },
    });
    edges.push({ from: "__cat_facts__", to: ni.id });

    // Cross-link neurons to notes/boards/tags that relate to this theme
    const term = ni.label.toLowerCase();

    // Dedup like the tag pass — a neuron matched by 20 rolled-up gmail
    // items shouldn't draw 20 edges into the same Gmail rollup node.
    const seenNeuronTargets = new Set<string>();
    notes.forEach((n) => {
      const noteThemes = noteThemeMap.get(n.id) || [];
      const noteTags = (n.tags || []).map((t) => t.toLowerCase());
      // `content` is no longer fetched for the graph (see NoteRow comment);
      // ai_summary + title is a strict subset of what we used to match
      // against but covers >90% of real cross-link cases in practice.
      const haystack = `${(n.title || "").toLowerCase()} ${(n.ai_summary || "").toLowerCase()}`;
      if (noteThemes.includes(term) || noteTags.includes(term) || haystack.includes(term)) {
        const target = vaultNodeIdFor(n.id);
        if (seenNeuronTargets.has(target)) return;
        seenNeuronTargets.add(target);
        edges.push({ from: ni.id, to: target, cross: true });
      }
    });

    boards.forEach((b) => {
      if ((b.title || "").toLowerCase().includes(term)) {
        edges.push({ from: ni.id, to: `grid_${b.id}`, cross: true });
      }
    });

    tagArr.forEach((tag) => {
      if (tag.toLowerCase().includes(term) || term.includes(tag.toLowerCase())) {
        edges.push({ from: ni.id, to: `tag_${tag}`, cross: true });
      }
    });
  });

  // Manual / user-stated atomic facts. We render each as its own neuron
  // node with a stable `fact_<uuid>` id so the page-level forming-watcher
  // (see `pendingFormingFactId`) can match the freshly-saved row and play
  // the camera-focus pulse on it. Dedup against the synthesis-derived
  // neurons by case-insensitive label so a fact that already shows up as
  // a profile theme/topic doesn't render twice. fact_kind drives a small
  // sub-label ("Identity", "Focus", etc.) so the user can tell at a
  // glance what bucket the AI filed it under.
  const usedNeuronLabels = new Set<string>(
    Array.from(neuronNodeIds).map((nid) => {
      const n = nodes.find((x) => x.id === nid);
      return (n?.label || "").toLowerCase().trim();
    }).filter(Boolean),
  );
  const factKindLabel = (k: string) => {
    switch (k) {
      case "identity": return "Identity";
      case "focus": return "Focus";
      case "theme": return "Theme";
      case "goal": return "Goal";
      case "preference": return "Preference";
      case "style": return "Style";
      case "constraint": return "Constraint";
      case "relationship": return "Relationship";
      default: return "Fact";
    }
  };
  manualFacts.forEach((f) => {
    const label = (f.fact_text || "").trim();
    if (!label) return;
    const lower = label.toLowerCase();
    if (usedNeuronLabels.has(lower)) return;
    usedNeuronLabels.add(lower);
    const nid = `fact_${f.id}`;
    nodes.push({
      id: nid,
      label: label.length > 56 ? `${label.slice(0, 54)}…` : label,
      kind: "neuron",
      radius: 16,
      color: palette.facts.bg,
      glow: palette.facts.glow,
      parentId: "__cat_facts__",
      categoryId: "__cat_facts__",
      meta: {
        neuronKind: "fact",
        source: "manual_fact",
        kindLabel: factKindLabel(f.fact_kind),
        factId: f.id,
        factKind: f.fact_kind,
        factText: f.fact_text,
        confidence: f.confidence,
        factStatus: f.status || "stated",
        factFirstSeenAt: f.first_seen_at || null,
        factLastSeenAt: f.last_seen_at || null,
      },
    });
    edges.push({ from: "__cat_facts__", to: nid });
  });

  // Thematic cross-links: connect items that share synthesis themes
  // Link notes to boards if a note's themes appear in a board's title
  const boardTitleLower = new Map(boards.map((b) => [`grid_${b.id}`, (b.title || "").toLowerCase()]));
  const edgeSet = new Set(edges.map((e) => `${e.from}__${e.to}`));
  const addCrossEdge = (from: string, to: string, opts?: { provenance?: boolean }) => {
    const key = `${from}__${to}`;
    const keyRev = `${to}__${from}`;
    if (from === to) return;
    // Provenance edges always get added — even if a heuristic
    // cross-edge already connects the same pair — so the renderer
    // can promote the visual treatment to the indigo provenance
    // style. We dedupe within the provenance pass below by
    // upgrading an existing entry in-place.
    if (opts?.provenance) {
      // If we already drew a heuristic cross-edge between this
      // pair, upgrade it to provenance instead of adding a second
      // duplicate line.
      const existing = edges.find(
        (e) =>
          (e.from === from && e.to === to) ||
          (e.from === to && e.to === from),
      );
      if (existing) {
        existing.provenance = true;
        return;
      }
      edgeSet.add(key);
      edges.push({ from, to, cross: true, provenance: true });
      return;
    }
    if (!edgeSet.has(key) && !edgeSet.has(keyRev)) {
      edgeSet.add(key);
      edges.push({ from, to, cross: true });
    }
  };

  notes.forEach((n) => {
    const themes = noteThemeMap.get(n.id) || [];
    // Rolled-up notes redirect onto the rollup node; `addCrossEdge`
    // dedupes so dozens of gmail items overlapping the same board only
    // produce a single Gmail-rollup → grid edge.
    const noteId = vaultNodeIdFor(n.id);
    // `content` is no longer projected; use title+summary as the haystack.
    // This is a deliberate slight degradation of heuristic cross-edge
    // recall in exchange for cutting the notes payload by ~10x. Provenance
    // edges (belief→fact→source) still produce the strongest cross-links.
    const noteHaystack = `${(n.title || "").toLowerCase()} ${(n.ai_summary || "").toLowerCase()}`;
    const noteSummary = (n.ai_summary || "").toLowerCase();

    // Synthesis-chunk–based vault→grid edges
    const linkedBoards = vaultGridMap.get(n.id);
    if (linkedBoards) {
      linkedBoards.forEach((boardId) => {
        const gridNodeId = `grid_${boardId}`;
        if (nodes.some((nd) => nd.id === gridNodeId)) addCrossEdge(noteId, gridNodeId);
      });
    }

    // Connect to boards whose titles appear in note title/summary/themes
    boardTitleLower.forEach((title, boardNodeId) => {
      if (title.length < 3) return;
      const titleWords = title.split(/\s+/).filter((w) => w.length > 2);
      const titleMatch = titleWords.length > 0 && titleWords.every((w) => noteHaystack.includes(w));
      if (
        titleMatch ||
        (noteSummary && titleWords.length > 0 && titleWords.every((w) => noteSummary.includes(w))) ||
        themes.some((t) => title.includes(t) || t.includes(title.split(" ")[0]))
      ) {
        addCrossEdge(noteId, boardNodeId);
      }
    });

  });

  // Connect notes that share themes with each other. Two notes that
  // both rolled up into the same source (e.g. both gmail) resolve to
  // the same node id — skip the self-loop so we don't draw an edge
  // from Gmail to itself.
  const noteIds = notes.map((n) => n.id);
  for (let i = 0; i < noteIds.length; i++) {
    const themesA = noteThemeMap.get(noteIds[i]) || [];
    if (themesA.length === 0) continue;
    const fromId = vaultNodeIdFor(noteIds[i]);
    for (let j = i + 1; j < noteIds.length; j++) {
      const themesB = noteThemeMap.get(noteIds[j]) || [];
      if (themesA.some((t) => themesB.includes(t))) {
        const toId = vaultNodeIdFor(noteIds[j]);
        if (fromId === toId) continue;
        addCrossEdge(fromId, toId);
      }
    }
  }

  // Connect boards whose titles share synthesis themes.
  boards.forEach((b1, i) => {
    const b1Title = (b1.title || "").toLowerCase();
    boards.forEach((b2, j) => {
      if (j <= i) return;
      const b2Title = (b2.title || "").toLowerCase();
      // check if any synthesis theme connects them
      const sharedTheme = synthesisThemes.some((t) => {
        const tl = t.toLowerCase();
        return (b1Title.includes(tl) || tl.includes(b1Title.split(" ")[0])) &&
               (b2Title.includes(tl) || tl.includes(b2Title.split(" ")[0]));
      });
      if (sharedTheme) addCrossEdge(`grid_${b1.id}`, `grid_${b2.id}`);
    });
  });

  // -------------------------------------------------------------------
  // Provenance cross-edges: belief → fact → source
  // -------------------------------------------------------------------
  // For each belief in view, walk its `promoted_from_facts` (carried by
  // `beliefProvenance`) and draw:
  //   • belief_<id> → fact_<id>           (audit edge — which facts seeded it)
  //   • fact_<id>   → vault_<note_id>     (when evidence cites a vault note
  //                                         AND that note node exists)
  //   • fact_<id>   → grid_<board_id>     (when evidence cites a board AND
  //                                         that board node exists)
  // Edges to nodes we never built (a fact that hasn't surfaced in
  // manualFacts, or a source we don't have a node for) are silently
  // skipped so the graph never references missing nodes. Uses the same
  // `addCrossEdge` helper as the heuristic cross-edges so dedup and
  // direction-flip handling stay consistent.
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  beliefs.forEach((b) => {
    const beliefNodeId = `belief_${b.id}`;
    if (!nodeIdSet.has(beliefNodeId)) return;
    const entries = beliefProvenance.get(b.id);
    if (!entries || entries.length === 0) return;
    for (const entry of entries) {
      const factNodeId = `fact_${entry.factId}`;
      if (nodeIdSet.has(factNodeId)) {
        addCrossEdge(beliefNodeId, factNodeId, { provenance: true });
      }
      if (entry.sourceType === "vault_note" && entry.sourceId) {
        // Belief provenance pointing at a rolled-up note redirects
        // onto its rollup so the "this belief is grounded in your
        // Gmail" relationship reads at the right granularity. If
        // the note isn't in our payload at all, `vaultNodeIdFor`
        // returns a literal `vault_<id>` which then fails the
        // `nodeIdSet.has(...)` check below — same skip as today.
        const vaultNodeId = vaultNodeIdFor(entry.sourceId);
        if (nodeIdSet.has(vaultNodeId)) {
          addCrossEdge(
            nodeIdSet.has(factNodeId) ? factNodeId : beliefNodeId,
            vaultNodeId,
            { provenance: true },
          );
        }
      } else if (entry.sourceType === "board" && entry.sourceId) {
        const gridNodeId = `grid_${entry.sourceId}`;
        if (nodeIdSet.has(gridNodeId)) {
          addCrossEdge(
            nodeIdSet.has(factNodeId) ? factNodeId : beliefNodeId,
            gridNodeId,
            { provenance: true },
          );
        }
      }
    }
  });

  // -------------------------------------------------------------------
  // Concept cross-edges: concept_<id> → vault/grid/fact/belief
  // -------------------------------------------------------------------
  // For each concept in view, walk its concept_links rows and draw an
  // edge to every linked vault note / board / fact / belief node. Uses
  // the same provenance:true treatment as the belief edges above so
  // the renderer paints them in solid indigo and the cross-cluster
  // web reads as a coherent overlay. Links to nodes we never built
  // (a fact that hasn't surfaced in manualFacts, a board outside this
  // user's view, etc.) are silently skipped — the graph never points
  // at missing nodes.
  liveConcepts.forEach((c) => {
    const conceptNodeId = conceptIdToNodeId.get(c.concept_id);
    if (!conceptNodeId || !nodeIdSet.has(conceptNodeId)) return;
    const links = conceptLinks.get(c.concept_id);
    if (!links || links.length === 0) return;
    for (const link of links) {
      let targetNodeId: string | null = null;
      // Concept→note edges redirect through `vaultNodeIdFor` so a
      // concept linked to 12 rolled-up gmail items pulls a single
      // line into the Gmail rollup (deduped by addCrossEdge) rather
      // than fanning out to 12 missing per-note nodes.
      if (link.kind === "note") targetNodeId = vaultNodeIdFor(link.targetId);
      else if (link.kind === "chat") targetNodeId = `grid_${link.targetId}`;
      else if (link.kind === "fact") targetNodeId = `fact_${link.targetId}`;
      else if (link.kind === "belief") targetNodeId = `belief_${link.targetId}`;
      if (!targetNodeId || !nodeIdSet.has(targetNodeId)) continue;
      addCrossEdge(conceptNodeId, targetNodeId, { provenance: true });
    }
  });

  // -------------------------------------------------------------------
  // Projects category — user-clustered projects (lykn_projects + 063).
  // -------------------------------------------------------------------
  // Each row in `userProjects` becomes its own node inside the new
  // Projects category. We size the node by member count so projects
  // with deep coverage read as landmarks; an empty project still
  // renders as a small node so the user can find it and add neurons.
  // Cross-edges from each project node to every member node id make
  // the cluster visible in the brain — the user sees "this project is
  // these neurons" without needing to switch into project-filter mode.
  //
  // Member edges only fire when the target node exists in the graph
  // (same guard as the concept_links / belief-provenance passes). A
  // member pointing at a deleted neuron is silently skipped — the
  // ProjectPanel will still list it as a stale row, but the brain
  // never paints a line into empty space.
  const projectsHasContent = userProjects.length > 0;
  if (projectsHasContent || forceCategoryIds.has("__cat_projects__")) {
    if (!nodes.some((n) => n.id === "__cat_projects__")) {
      nodes.push({
        id: "__cat_projects__",
        label: "Projects",
        kind: "category",
        radius: 30,
        color: palette.projects.bg,
        glow: palette.projects.glow,
        parentId: rootId,
      });
      edges.push({ from: rootId, to: "__cat_projects__" });
    }
  }

  userProjects.forEach((p) => {
    const nid = `project_${p.id}`;
    // Project node radius is driven by member count, capped so a 50-
    // neuron project doesn't outsize the category sphere above it.
    // Floor matches concept/fact sizing so a brand-new empty project
    // still reads as a real node, not a stray dot.
    const memberCount = p.members.length;
    const radius = 18 + Math.min(10, Math.floor(Math.log2(memberCount + 1) * 1.5));
    const labelShown = p.name.length > 36 ? `${p.name.slice(0, 34)}…` : p.name;
    nodes.push({
      id: nid,
      label: labelShown,
      kind: "project",
      radius,
      color: palette.project.bg,
      glow: palette.project.glow,
      parentId: "__cat_projects__",
      categoryId: "__cat_projects__",
      meta: {
        projectId: p.id,
        projectName: p.name,
        projectDescription: p.description,
        projectStatus: p.status,
        projectCreatedByClient: p.createdByClient,
        projectMemberCount: memberCount,
        projectPushCount: p.pushCount,
        projectLastActiveAt: p.lastActiveAt,
      },
    });
    edges.push({ from: "__cat_projects__", to: nid });

    // Membership cross-edges — one line from the project node to each
    // clustered neuron that actually exists in the graph. We rebuild
    // the node-id set inline (vs reusing `nodeIdSet` from earlier) so
    // the just-pushed project nodes are also addressable for
    // member→project lookups in future passes; reusing the stale set
    // would silently skip any project-to-project edges if we ever
    // added them.
    if (memberCount > 0) {
      const live = new Set(nodes.map((n) => n.id));
      for (const m of p.members) {
        if (!m.nodeId || !live.has(m.nodeId)) continue;
        addCrossEdge(nid, m.nodeId);
      }
    }
  });

  // `noteIdToVaultNodeId` is returned alongside the graph so consumers
  // (DetailPanel, ConceptDetailSection, the page-level click handler)
  // can translate a raw `notes.id` into the graph node id it landed on.
  // Critical for navigation FROM a concept_link / belief provenance
  // row TO the underlying vault representation when the note got
  // rolled up into a connector source — clicking "Open in graph" on
  // a gmail-sourced fact should focus the Gmail rollup, not search
  // for a `vault_<emailId>` node that was never built.
  return { nodes, edges, noteIdToVaultNodeId };
}

/* ------------------------------------------------------------------ */
/*  Layout modes                                                       */
/* ------------------------------------------------------------------ */

// `LayoutMode` lives in ./synthesis/layoutTypes (see top-of-file import).

const layoutModes: { id: LayoutMode; label: string; icon: typeof Network }[] = [
  // "Default" is pinned to the top of the dropdown because it's the
  // load-in view — the user lands in this mode and sees the composed,
  // evenly-spread force-directed cloud here, so the dropdown order
  // reflects what's already on screen. The mode id is kept as
  // "connections" for back-compat with the layout engine + any saved
  // URL state; only the label + position changed. (This is NOT a
  // semantic "most-connected-to-its-peers" clustering — that
  // experiment was retired because it made the scene look noisy.
  // Default just looks pretty and reflects the user's own categories.)
  { id: "connections", label: "Default",        icon: Network },
  { id: "section",     label: "By Section",     icon: LayoutGrid },
  { id: "topic",       label: "By Idea",        icon: Sparkles },
  // "By Project" reuses the connections-mode physics (the layout
  // engine has no special branch for it — see layoutEngine.ts) but
  // routes a focus set into the 3D scene so only the picked
  // project's clustered neurons glow against a dimmed background.
  // The project chooser sub-dropdown only renders while this mode
  // is active, mirroring how "By Idea" reveals the tag picker.
  { id: "project",     label: "By Project",     icon: FolderPlus },
];

/* ------------------------------------------------------------------ */
/*  Force simulation                                                   */
/* ------------------------------------------------------------------ */
//
// `simulateLayout` + `computeIdeaRelevance` were extracted to
// `./synthesis/layoutEngine` so they can run inside a Web Worker (see
// `./synthesis/layoutWorker`). The worker is the default path used by
// the main component below; `simulateLayout` is also imported
// synchronously as a same-tab fallback for environments without
// Worker support (older test runners, prerender, etc.).

// Removed local definitions — body lives in layoutEngine.ts now
// (~387 lines of pure math). The marker function below is rewritten
// as a one-line stub so the deletion is a single contiguous block.
// (The 387-line bodies of `computeIdeaRelevance` and `simulateLayout`
// live in ./synthesis/layoutEngine now. The worker imports them; the
// main thread imports `simulateLayout` for the rare same-tab fallback
// path.)

/* ------------------------------------------------------------------ */
/*  (SVG renderer helpers — edgePath / NodeIcon / catIcon — were      */
/*  removed when the visualisation moved to react-three-fiber. The 3D  */
/*  scene draws straight 3D lines and uses sphere primitives in place  */
/*  of in-node icons; legend + sidebar still cover icon affordance.)   */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Welcome panel (removed)                                            */
/* ------------------------------------------------------------------ */
//
// The typewriter-intro WelcomePanel used to live here (~165 lines). It
// was superseded by the in-chat load-in greeting (LoadInBriefingPanel)
// months ago but kept compiling because `showWelcome` state + a few
// `setShowWelcome(false)` calls were still wired up across the page.
// It is no longer rendered anywhere — and its 60fps requestAnimationFrame
// typewriter loop would re-fire the entire page tree on every frame if
// anyone re-mounted it, so we delete the component entirely rather than
// leaving a footgun in the module. The `showWelcome` state in the main
// component was also dropped because it was permanently `false`.

/* ------------------------------------------------------------------ */
/*  Vault content parser + attachment renderer                          */
/* ------------------------------------------------------------------ */
//
// Both helpers were extracted into shared modules so the NeuronPanel
// (which sits in the components/ tree and gets imported by THIS file)
// can render the same vault media without creating a circular import
// back through this page module. The behaviour is byte-identical to
// the inlined versions that previously lived here — only the storage
// location changed.

// ---------------------------------------------------------------------
// "Why / when / accept" detail sections rendered inside DetailPanel
// for synthesis-layer items. Pulled out into their own components so
// each can own its accept-button loading state without breaking the
// hooks rules in the surrounding DetailPanel render.
// ---------------------------------------------------------------------

function formatRelativeWhen(iso?: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: new Date(t).getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

function clientDisplayLabel(slug?: string | null): string {
  if (!slug) return "your synthesis layer";
  const map: Record<string, string> = {
    claude: "Claude",
    "claude-desktop": "Claude Desktop",
    "claude-web": "Claude (web)",
    "claude-code": "Claude Code",
    cursor: "Cursor",
    gemini: "Gemini",
    chatgpt: "ChatGPT",
    "lykn-chat": "LYKN",
    "lykn-promotion": "LYKN synthesis",
    manual: "you",
  };
  return map[slug] || slug;
}

const BeliefDetailSection: React.FC<{ node: MindNode }> = ({ node }) => {
  const beliefId = String(node.meta?.beliefId || "");
  const beliefText = String(node.meta?.beliefText || node.label || "");
  const beliefStatus = String(node.meta?.beliefStatus || "active");
  const rationale = node.meta?.beliefRationale as string | null | undefined;
  const sourceClient = node.meta?.beliefSource as string | null | undefined;
  const createdAt = node.meta?.beliefCreatedAt as string | null | undefined;
  const servesNeed = String(node.meta?.servesNeed || "");
  const confidence = typeof node.meta?.confidence === "number" ? node.meta.confidence : null;

  const [status, setStatus] = useState(beliefStatus);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    // Reset when the focused belief changes — the panel re-mounts
    // via `key={selectedNode.id}` so this is mostly belt-and-braces.
    setStatus(beliefStatus);
    setError(null);
  }, [beliefId, beliefStatus]);

  const isProposed = status === "proposed";

  const accept = async () => {
    if (!beliefId || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/beliefs/${beliefId}/ratify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        setError(toUserFacingError());
        return;
      }
      setStatus("active");
      // Refresh the belief cluster + load-in greeting so the badge
      // count drops and the node re-colors to "active".
      queryClient.invalidateQueries({ queryKey: ["mindmap_active_beliefs"] });
      queryClient.invalidateQueries({ queryKey: ["belief_window"] });
    } catch (e) {
      setError(toUserFacingError());
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-3">
        <Atom size={13} className="text-amber-400" />
        <span
          className={`text-[0.6rem] px-1.5 py-0.5 rounded-full font-medium ${
            isProposed
              ? "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300"
              : "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
          }`}
        >
          {isProposed ? "Proposed belief" : "Active belief"}
        </span>
        {servesNeed ? (
          <span className="text-[0.6rem] text-gray-400 dark:text-gray-500 capitalize">
            Serves {servesNeed}
          </span>
        ) : null}
      </div>

      <p className="text-[0.875rem] text-gray-800 dark:text-gray-100 leading-relaxed mb-3">
        “{beliefText}”
      </p>

      {rationale ? (
        <div className="mb-3">
          <p className="text-[0.625rem] font-medium text-gray-400 dark:text-gray-500 mb-1 uppercase tracking-wider">
            Why it was added
          </p>
          <div className="text-[0.75rem] text-gray-600 dark:text-gray-300 leading-relaxed rounded-lg bg-black/[0.02] dark:bg-white/[0.03] p-3 whitespace-pre-wrap">
            {rationale}
          </div>
        </div>
      ) : (
        <div className="mb-3">
          <p className="text-[0.625rem] font-medium text-gray-400 dark:text-gray-500 mb-1 uppercase tracking-wider">
            Why it was added
          </p>
          <p className="text-[0.75rem] text-gray-500 dark:text-gray-400 italic">
            {clientDisplayLabel(sourceClient)} surfaced this as a recurring principle in how you think.
          </p>
        </div>
      )}

      {createdAt ? (
        <div className="mb-4">
          <p className="text-[0.625rem] font-medium text-gray-400 dark:text-gray-500 mb-1 uppercase tracking-wider">
            When it was added
          </p>
          <p className="text-[0.75rem] text-gray-600 dark:text-gray-300">
            {new Date(createdAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}{" "}
            <span className="text-gray-400 dark:text-gray-500">· {formatRelativeWhen(createdAt)}</span>
            {sourceClient ? (
              <span className="text-gray-400 dark:text-gray-500"> · from {clientDisplayLabel(sourceClient)}</span>
            ) : null}
          </p>
        </div>
      ) : null}

      {confidence != null ? (
        <p className="text-[0.6875rem] text-gray-500 dark:text-gray-400 mb-3">
          Confidence: <span className="font-medium">{Math.round(confidence * 100)}%</span>
        </p>
      ) : null}

      {isProposed ? (
        <div className="space-y-2">
          <button
            type="button"
            onClick={accept}
            disabled={pending || !beliefId}
            className="w-full flex items-center justify-center gap-2 text-[0.8125rem] font-semibold py-2.5 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 disabled:bg-emerald-500/40 text-white transition-colors shadow-[0_2px_10px_rgba(16,185,129,0.25)]"
          >
            {pending ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Accepting…
              </>
            ) : (
              <>
                <Check size={14} />
                Accept as official belief
              </>
            )}
          </button>
          {error ? (
            <p className="text-[0.6875rem] text-red-500">{error}</p>
          ) : (
            <p className="text-[0.625rem] text-gray-400 dark:text-gray-500 text-center">
              Accepting promotes this to your active belief layer and proposes 2–3 rules to support it.
            </p>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 text-[0.75rem]">
          <Check size={13} />
          Active in your belief layer
        </div>
      )}
    </div>
  );
};

const FactDetailSection: React.FC<{ node: MindNode }> = ({ node }) => {
  const factId = String(node.meta?.factId || "");
  const factText = String(node.meta?.factText || node.label || "");
  const factKindLbl = String(node.meta?.kindLabel || "Identity fact");
  const factStatus = String(node.meta?.factStatus || "stated");
  const firstSeenAt = node.meta?.factFirstSeenAt as string | null | undefined;
  const confidence = typeof node.meta?.confidence === "number" ? node.meta.confidence : null;

  const [status, setStatus] = useState(factStatus);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    setStatus(factStatus);
    setError(null);
  }, [factId, factStatus]);

  const needsConfirm = status === "inferred" || status === "unconfirmed";

  const accept = async () => {
    if (!factId || pending) return;
    setPending(true);
    setError(null);
    try {
      const { error: upErr } = await supabase
        .from("lykn_user_model_facts")
        .update({ status: "confirmed" })
        .eq("id", factId);
      if (upErr) {
        setError(toUserFacingError());
        return;
      }
      setStatus("confirmed");
      queryClient.invalidateQueries({ queryKey: ["mindmap_manual_facts"] });
    } catch (e) {
      setError(toUserFacingError());
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles size={13} className="text-pink-400" />
        <span
          className={`text-[0.6rem] px-1.5 py-0.5 rounded-full font-medium ${
            needsConfirm
              ? "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300"
              : "bg-pink-100 dark:bg-pink-900/30 text-pink-700 dark:text-pink-300"
          }`}
        >
          {needsConfirm ? "Awaiting confirmation" : factKindLbl}
        </span>
        <span className="text-[0.6rem] text-gray-400 dark:text-gray-500">Neuron</span>
      </div>

      <p className="text-[0.875rem] text-gray-800 dark:text-gray-100 leading-relaxed mb-3">
        “{factText}”
      </p>

      <div className="mb-3">
        <p className="text-[0.625rem] font-medium text-gray-400 dark:text-gray-500 mb-1 uppercase tracking-wider">
          Why it was added
        </p>
        <p className="text-[0.75rem] text-gray-600 dark:text-gray-300 leading-relaxed">
          {status === "stated"
            ? "You stated this directly in chat — LYKN saved it as a Basic neuron."
            : status === "confirmed"
              ? "You confirmed this when LYKN surfaced it from your conversations."
              : "LYKN's synthesis layer inferred this from patterns in your chats and vault. It's awaiting your confirmation before becoming a permanent neuron."}
        </p>
      </div>

      {firstSeenAt ? (
        <div className="mb-4">
          <p className="text-[0.625rem] font-medium text-gray-400 dark:text-gray-500 mb-1 uppercase tracking-wider">
            When it was added
          </p>
          <p className="text-[0.75rem] text-gray-600 dark:text-gray-300">
            {new Date(firstSeenAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}{" "}
            <span className="text-gray-400 dark:text-gray-500">· {formatRelativeWhen(firstSeenAt)}</span>
          </p>
        </div>
      ) : null}

      {confidence != null ? (
        <p className="text-[0.6875rem] text-gray-500 dark:text-gray-400 mb-3">
          Confidence: <span className="font-medium">{Math.round(confidence * 100)}%</span>
        </p>
      ) : null}

      {needsConfirm ? (
        <div className="space-y-2">
          <button
            type="button"
            onClick={accept}
            disabled={pending || !factId}
            className="w-full flex items-center justify-center gap-2 text-[0.8125rem] font-semibold py-2.5 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 disabled:bg-emerald-500/40 text-white transition-colors shadow-[0_2px_10px_rgba(16,185,129,0.25)]"
          >
            {pending ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Confirming…
              </>
            ) : (
              <>
                <Check size={14} />
                Accept as official neuron
              </>
            )}
          </button>
          {error ? (
            <p className="text-[0.6875rem] text-red-500">{error}</p>
          ) : (
            <p className="text-[0.625rem] text-gray-400 dark:text-gray-500 text-center">
              Accepting marks this as confirmed — LYKN will lean on it for context on every reply.
            </p>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 text-[0.75rem]">
          <Check size={13} />
          {status === "confirmed" ? "Confirmed neuron" : "Active neuron"}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------
// Concept detail section — rendered inside DetailPanel when the user
// taps a `concept_<id>` node. Pulls the concept's links via the
// concept_links RPC and surfaces rename / dismiss / restore + merge
// actions. We deliberately keep this co-located with the other detail
// sections so the panel stays a single component; a full standalone
// /concepts page is out of scope for stage 2 (see plan).
// ---------------------------------------------------------------------
const ConceptDetailSection: React.FC<{
  node: MindNode;
  allConcepts: Array<{ concept_id: string; label: string; status: string }>;
  onSelectNode: (id: string) => void;
  onNavigate: (path: string) => void;
  // Resolves a raw `notes.id` to its graph node id — either the per-
  // note vault node (manual save) or the connector-source rollup
  // (Gmail / Notion / …) when the note was collapsed out of the
  // graph. Without this the "Open in graph" buttons for note-typed
  // concept_links would target `vault_<id>` nodes that don't exist
  // for rolled-up sources, opening an empty detail panel.
  vaultNodeIdFor: (noteId: string) => string;
}> = ({ node, allConcepts, onSelectNode, onNavigate, vaultNodeIdFor }) => {
  const conceptId = String(node.meta?.conceptId || "");
  const conceptLabel = String(node.meta?.conceptLabel || node.label || "");
  const conceptSource = String(node.meta?.conceptSource || "");
  const conceptStatusInitial = String(node.meta?.conceptStatus || "active");
  const conceptKind = String(node.meta?.conceptKind || "topic");
  const noteCount = (node.meta?.conceptNoteCount as number) || 0;
  const factCount = (node.meta?.conceptFactCount as number) || 0;
  const beliefCount = (node.meta?.conceptBeliefCount as number) || 0;
  const chatCount = (node.meta?.conceptChatCount as number) || 0;

  const [status, setStatus] = useState(conceptStatusInitial);
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(conceptLabel);
  const [mergePickerOpen, setMergePickerOpen] = useState(false);
  const [pending, setPending] = useState<null | "rename" | "dismiss" | "restore" | "merge">(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    setStatus(conceptStatusInitial);
    setDraftLabel(conceptLabel);
    setEditing(false);
    setMergePickerOpen(false);
    setError(null);
  }, [conceptId, conceptStatusInitial, conceptLabel]);

  const { data: links = [] } = useQuery({
    queryKey: ["concept_links", conceptId],
    queryFn: async () => {
      if (!conceptId) return [] as Array<{
        target_kind: "note" | "fact" | "belief" | "chat";
        target_id: string;
        target_label: string;
        source: string;
        weight: number;
      }>;
      const { data, error: rpcErr } = await supabase.rpc("concept_links", {
        p_concept_id: conceptId,
      });
      if (rpcErr) return [];
      return (data || []) as Array<{
        target_kind: "note" | "fact" | "belief" | "chat";
        target_id: string;
        target_label: string;
        source: string;
        weight: number;
      }>;
    },
    enabled: !!conceptId,
  });

  const sourceLabel = ({
    ai_clustered: "AI-clustered",
    user_authored: "User-created",
    promoted_from_tag: "From a tag",
    promoted_from_theme: "From a profile theme",
  } as Record<string, string>)[conceptSource] || conceptSource || "AI-clustered";

  const invalidateConcepts = () => {
    queryClient.invalidateQueries({ queryKey: ["mindmap_concepts"] });
    queryClient.invalidateQueries({ queryKey: ["mindmap_concept_links"] });
    queryClient.invalidateQueries({ queryKey: ["concept_links", conceptId] });
  };

  const callApi = async (path: string, method: string, body?: any) => {
    const sess = (await supabase.auth.getSession()).data.session;
    const token = sess?.access_token;
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${txt ? `: ${txt.slice(0, 120)}` : ""}`);
    }
    return res.json().catch(() => ({}));
  };

  const saveRename = async () => {
    const next = draftLabel.trim();
    if (!next || next.length > 128 || next === conceptLabel) {
      setEditing(false);
      return;
    }
    setPending("rename");
    setError(null);
    try {
      await callApi(`/api/v1/concepts/${conceptId}`, "PATCH", { label: next });
      setEditing(false);
      invalidateConcepts();
    } catch (e) {
      setError(toUserFacingError());
    } finally {
      setPending(null);
    }
  };

  const dismiss = async () => {
    setPending("dismiss");
    setError(null);
    try {
      await callApi(`/api/v1/concepts/${conceptId}`, "PATCH", { status: "dismissed" });
      setStatus("dismissed");
      invalidateConcepts();
    } catch (e) {
      setError(toUserFacingError());
    } finally {
      setPending(null);
    }
  };

  const restore = async () => {
    setPending("restore");
    setError(null);
    try {
      await callApi(`/api/v1/concepts/${conceptId}`, "PATCH", { status: "active" });
      setStatus("active");
      invalidateConcepts();
    } catch (e) {
      setError(toUserFacingError());
    } finally {
      setPending(null);
    }
  };

  const doMerge = async (intoId: string) => {
    setPending("merge");
    setError(null);
    try {
      await callApi(`/api/v1/concepts/${conceptId}/merge`, "POST", { into_id: intoId });
      setMergePickerOpen(false);
      invalidateConcepts();
      // Camera-focus on the surviving concept so the user can see
      // where the merged links landed.
      onSelectNode(`concept_${intoId}`);
    } catch (e) {
      setError(toUserFacingError());
    } finally {
      setPending(null);
    }
  };

  const mergeCandidates = allConcepts.filter(
    (c) => c.concept_id !== conceptId && c.status !== "dismissed",
  );

  const linkRow = (l: { target_kind: string; target_id: string; target_label: string }) => {
    const targetId =
      l.target_kind === "note" ? vaultNodeIdFor(l.target_id)
      : l.target_kind === "fact" ? `fact_${l.target_id}`
      : l.target_kind === "belief" ? `belief_${l.target_id}`
      : l.target_kind === "chat" ? `grid_${l.target_id}`
      : null;
    const tone =
      l.target_kind === "note" ? "bg-emerald-50/50 dark:bg-emerald-900/10 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/20"
      : l.target_kind === "chat" ? "bg-sky-50/50 dark:bg-sky-900/10 hover:bg-sky-100/60 dark:hover:bg-sky-900/20"
      : l.target_kind === "fact" ? "bg-pink-50/50 dark:bg-pink-900/10 hover:bg-pink-100/60 dark:hover:bg-pink-900/20"
      : "bg-indigo-50/50 dark:bg-indigo-900/10 hover:bg-indigo-100/60 dark:hover:bg-indigo-900/20";
    return (
      <button
        key={`${l.target_kind}-${l.target_id}`}
        type="button"
        onClick={() => {
          if (targetId) onSelectNode(targetId);
        }}
        title={l.target_label}
        className={`flex items-center gap-2 px-2 py-1 rounded-md text-left cursor-pointer w-full transition-colors ${tone}`}
      >
        <span className="text-[0.55rem] uppercase tracking-wider text-gray-400 dark:text-gray-500 w-10 flex-shrink-0">
          {l.target_kind}
        </span>
        <span className="text-[0.6875rem] text-gray-600 dark:text-gray-300 truncate">
          {l.target_label}
        </span>
      </button>
    );
  };

  const linksByKind = useMemo(() => {
    const m: Record<string, typeof links> = { note: [], fact: [], belief: [], chat: [] };
    for (const l of links) {
      if (m[l.target_kind]) m[l.target_kind].push(l);
    }
    return m;
  }, [links]);

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-3">
        <Hash size={13} className="text-orange-400" />
        <span
          className={`text-[0.6rem] px-1.5 py-0.5 rounded-full font-medium ${
            status === "dismissed"
              ? "bg-gray-100 dark:bg-gray-800/40 text-gray-500 dark:text-gray-400"
              : status === "proposed"
              ? "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300"
              : "bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300"
          }`}
        >
          {status === "dismissed" ? "Dismissed" : status === "proposed" ? "Proposed concept" : "Active concept"}
        </span>
        <span className="text-[0.6rem] text-gray-400 dark:text-gray-500 capitalize">
          {conceptKind}
        </span>
      </div>

      {editing ? (
        <div className="mb-3 flex items-center gap-2">
          <input
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value.slice(0, 128))}
            className="flex-1 text-[0.875rem] bg-white/5 border border-white/10 rounded-md px-2 py-1 text-gray-800 dark:text-gray-100"
            onKeyDown={(e) => {
              if (e.key === "Enter") saveRename();
              else if (e.key === "Escape") {
                setEditing(false);
                setDraftLabel(conceptLabel);
              }
            }}
            autoFocus
          />
          <button
            type="button"
            onClick={saveRename}
            disabled={pending !== null}
            className="text-[0.75rem] px-2 py-1 rounded-md bg-orange-500/90 hover:bg-orange-500 disabled:bg-orange-500/40 text-white"
          >
            {pending === "rename" ? "…" : "Save"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-left mb-3 group"
          title="Click to rename"
        >
          <p className="text-[1rem] text-gray-800 dark:text-gray-100 leading-tight font-semibold group-hover:text-orange-500 transition-colors">
            {conceptLabel}
          </p>
          <p className="text-[0.625rem] text-gray-400 dark:text-gray-500 mt-0.5">
            {sourceLabel} · click to rename
          </p>
        </button>
      )}

      <div className="grid grid-cols-4 gap-1 mb-4">
        <div className="rounded-md bg-emerald-50/40 dark:bg-emerald-900/10 px-2 py-1.5 text-center">
          <div className="text-[0.875rem] font-semibold text-emerald-600 dark:text-emerald-300">{noteCount}</div>
          <div className="text-[0.55rem] uppercase tracking-wider text-emerald-500/70 dark:text-emerald-400/70">Notes</div>
        </div>
        <div className="rounded-md bg-pink-50/40 dark:bg-pink-900/10 px-2 py-1.5 text-center">
          <div className="text-[0.875rem] font-semibold text-pink-600 dark:text-pink-300">{factCount}</div>
          <div className="text-[0.55rem] uppercase tracking-wider text-pink-500/70 dark:text-pink-400/70">Neurons</div>
        </div>
        <div className="rounded-md bg-indigo-50/40 dark:bg-indigo-900/10 px-2 py-1.5 text-center">
          <div className="text-[0.875rem] font-semibold text-indigo-600 dark:text-indigo-300">{beliefCount}</div>
          <div className="text-[0.55rem] uppercase tracking-wider text-indigo-500/70 dark:text-indigo-400/70">Beliefs</div>
        </div>
        <div className="rounded-md bg-sky-50/40 dark:bg-sky-900/10 px-2 py-1.5 text-center">
          <div className="text-[0.875rem] font-semibold text-sky-600 dark:text-sky-300">{chatCount}</div>
          <div className="text-[0.55rem] uppercase tracking-wider text-sky-500/70 dark:text-sky-400/70">Chats</div>
        </div>
      </div>

      {(["note", "fact", "belief", "chat"] as const).map((kind) => {
        const rows = linksByKind[kind] || [];
        if (rows.length === 0) return null;
        const heading =
          kind === "note" ? "Notes" : kind === "fact" ? "Neurons" : kind === "belief" ? "Beliefs" : "Chats";
        return (
          <div key={kind} className="mb-3">
            <p className="text-[0.625rem] font-medium text-gray-400 dark:text-gray-500 mb-1.5 uppercase tracking-wider">
              {heading}
            </p>
            <div className="flex flex-col gap-1">
              {rows.slice(0, 8).map((l) => linkRow(l))}
              {rows.length > 8 && (
                <p className="text-[0.6rem] text-gray-400 dark:text-gray-500 italic pl-1">
                  + {rows.length - 8} more
                </p>
              )}
            </div>
          </div>
        );
      })}

      {/* Vault deep-link footer — sends the user to the filtered vault
          view for this concept. The /vault page already supports a
          ?concept= query param? if not, this still navigates to the
          page and the user can find the notes via search. */}
      <div className="mb-4">
        <button
          type="button"
          onClick={() => onNavigate(`/vault?concept=${encodeURIComponent(conceptId)}`)}
          className="w-full text-[0.6875rem] py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-gray-500 dark:text-gray-400 transition-colors flex items-center justify-center gap-1.5"
        >
          <ExternalLink size={11} />
          Open in vault
        </button>
      </div>

      <div className="space-y-2">
        {status !== "dismissed" ? (
          <>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setMergePickerOpen((v) => !v)}
                disabled={pending !== null || mergeCandidates.length === 0}
                className="flex-1 text-[0.75rem] py-1.5 rounded-md bg-white/5 hover:bg-white/10 disabled:bg-white/5 disabled:text-gray-500 text-gray-700 dark:text-gray-200 transition-colors"
                title={mergeCandidates.length === 0 ? "No other concepts to merge into" : "Merge this concept into another"}
              >
                {mergePickerOpen ? "Cancel merge" : "Merge into…"}
              </button>
              <button
                type="button"
                onClick={dismiss}
                disabled={pending !== null}
                className="flex-1 text-[0.75rem] py-1.5 rounded-md bg-red-500/10 hover:bg-red-500/20 disabled:bg-red-500/5 text-red-500 dark:text-red-400 transition-colors"
              >
                {pending === "dismiss" ? "…" : "Dismiss"}
              </button>
            </div>
            {mergePickerOpen && (
              <div className="rounded-md border border-white/8 bg-black/[0.03] dark:bg-white/[0.03] max-h-[12rem] overflow-y-auto">
                {mergeCandidates.slice(0, 30).map((c) => (
                  <button
                    key={c.concept_id}
                    type="button"
                    onClick={() => doMerge(c.concept_id)}
                    disabled={pending !== null}
                    className="w-full text-left text-[0.75rem] px-3 py-1.5 hover:bg-white/5 text-gray-700 dark:text-gray-200 disabled:opacity-50"
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={restore}
            disabled={pending !== null}
            className="w-full text-[0.75rem] py-1.5 rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 transition-colors"
          >
            {pending === "restore" ? "Restoring…" : "Restore concept"}
          </button>
        )}
        {error && <p className="text-[0.6875rem] text-red-500">{error}</p>}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Source rollup view (inside DetailPanel)                            */
/* ------------------------------------------------------------------ */
//
// Renders a list of items pooled into a connector-source rollup node
// (Gmail / Slack / Notion / …). Each row shows the item's title +
// optional one-line summary; clicking expands an inline preview that
// lazy-fetches the full body so opening the panel is cheap even for
// rollups with hundreds of items.
//
// Why inline expansion (not navigate-to-vault): the goal of the
// rollup is to keep the user inside the synthesis-layer surface. A
// click-through to /vault would yank them out of the 3D context.
// Items that need full editing get a footer link to /vault — same
// affordance the per-note view has.

const SourceRollupItemRow: React.FC<{
  noteId: string;
  title: string;
  summary: string | null;
  tags: string[];
  onNavigate: (path: string) => void;
}> = ({ noteId, title, summary, tags, onNavigate }) => {
  const [open, setOpen] = useState(false);
  // Mirrors the lazy-fetch pattern the regular vault view uses, but
  // gated on `open` so a 200-item rollup doesn't fire 200 queries at
  // mount. Each row pays its own round trip the first time it's
  // expanded, react-query caches the result so re-opening is instant.
  const { data: content } = useQuery({
    queryKey: ["mindmap_vault_note_content", noteId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notes")
        .select("content")
        .eq("id", noteId)
        .maybeSingle();
      if (error) return "";
      return String(data?.content || "");
    },
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });
  const parsed = useMemo(
    () => (open ? parseVaultContent(String(content || "")) : null),
    [open, content],
  );

  return (
    <div className="border-b border-gray-200/40 dark:border-white/[0.06] last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-2.5 py-2 hover:bg-gray-100/60 dark:hover:bg-white/[0.04] transition-colors flex items-start gap-2"
      >
        <StickyNote size={11} className="text-emerald-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-[0.75rem] text-gray-700 dark:text-gray-200 truncate">
            {title || "Untitled"}
          </p>
          {summary && !open && (
            <p className="text-[0.6875rem] text-gray-500 dark:text-gray-400 line-clamp-1 mt-0.5">
              {summary}
            </p>
          )}
        </div>
        <ChevronDown
          size={11}
          className={`text-gray-400 flex-shrink-0 mt-1 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1">
          {summary && (
            <p className="text-[0.6875rem] italic text-gray-500 dark:text-gray-400 mb-2">
              {summary}
            </p>
          )}
          {parsed && parsed.attachments.length > 0 && (
            <div className="mb-2 flex flex-col gap-1.5">
              {parsed.attachments.map((att: any, idx: number) => (
                <VaultAttachment key={idx} att={att} />
              ))}
            </div>
          )}
          {parsed && parsed.body && (
            <div className="text-[0.6875rem] text-gray-600 dark:text-gray-300 leading-relaxed whitespace-pre-wrap rounded-md bg-black/[0.02] dark:bg-white/[0.03] p-2 max-h-[180px] overflow-y-auto">
              {parsed.body.slice(0, 1200)}
              {parsed.body.length > 1200 && "…"}
            </div>
          )}
          {!parsed?.body && !parsed?.attachments?.length && content !== undefined && (
            <p className="text-[0.6875rem] italic text-gray-400 dark:text-gray-500">
              No preview available.
            </p>
          )}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {tags.slice(0, 6).map((t) => (
                <span
                  key={t}
                  className="text-[0.55rem] px-1.5 py-0.5 rounded-full bg-amber-100/70 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300"
                >
                  #{t}
                </span>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => onNavigate(`/vault?note=${noteId}`)}
            className="mt-2 text-[0.6875rem] text-indigo-500 dark:text-indigo-300 hover:underline inline-flex items-center gap-1"
          >
            <ExternalLink size={10} /> Open in Vault
          </button>
        </div>
      )}
    </div>
  );
};

const SourceRollupView: React.FC<{
  sourceApp: string;
  sourceLabel: string;
  itemCount: number;
  items: Array<{ noteId: string; title: string; ai_summary: string | null; tags: string[]; sourceSlug: string }>;
  onNavigate: (path: string) => void;
}> = ({ sourceApp, sourceLabel, itemCount, items, onNavigate }) => {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.title.toLowerCase().includes(q) ||
        (it.ai_summary || "").toLowerCase().includes(q) ||
        it.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [items, query]);
  const truncated = itemCount > items.length;

  return (
    <div className="mb-4">
      <div className="mb-3">
        <p className="text-[0.6875rem] font-medium text-gray-500 dark:text-gray-400 mb-1">
          Connected source
        </p>
        <p className="text-[0.75rem] text-gray-600 dark:text-gray-300 leading-relaxed">
          {itemCount.toLocaleString()} item{itemCount === 1 ? "" : "s"} synced
          from {sourceLabel}. Everything here is embedded into your
          synthesis layer — the bundle just lives behind one node so
          the graph stays your <em>brain</em>, not your inbox.
        </p>
      </div>

      {items.length > 6 && (
        <div className="mb-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${sourceLabel}…`}
            className="w-full text-[0.75rem] px-2.5 py-1.5 rounded-md bg-black/[0.04] dark:bg-white/[0.06] border border-transparent focus:border-indigo-400/40 focus:outline-none text-gray-700 dark:text-gray-200 placeholder:text-gray-400"
          />
        </div>
      )}

      <div className="rounded-lg bg-black/[0.015] dark:bg-white/[0.02] border border-gray-200/40 dark:border-white/[0.05] overflow-hidden">
        {filtered.length === 0 ? (
          <p className="text-[0.6875rem] text-gray-400 italic px-2.5 py-2">
            No items match.
          </p>
        ) : (
          filtered.map((it) => (
            <SourceRollupItemRow
              key={it.noteId}
              noteId={it.noteId}
              title={it.title}
              summary={it.ai_summary}
              tags={it.tags}
              onNavigate={onNavigate}
            />
          ))
        )}
      </div>

      {truncated && (
        <p className="text-[0.625rem] text-gray-400 mt-2 italic">
          Showing the most recent {items.length} of {itemCount.toLocaleString()}.
          Open Vault to browse the rest.
        </p>
      )}

      <button
        type="button"
        onClick={() => onNavigate(`/vault?source=${encodeURIComponent(sourceApp)}`)}
        className="mt-3 w-full text-[0.75rem] py-1.5 rounded-md bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 transition-colors inline-flex items-center justify-center gap-1.5"
      >
        <ExternalLink size={11} /> Open all {sourceLabel} items in Vault
      </button>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Detail panel                                                       */
/* ------------------------------------------------------------------ */

function DetailPanel({
  node,
  allNodes,
  edges,
  onClose,
  onNavigate,
  onSelectNode,
  onBeginLinking,
  prototypeChat,
  allConcepts,
  vaultNodeIdFor,
}: {
  node: MindNode;
  allNodes: MindNode[];
  edges: MindEdge[];
  onClose: () => void;
  onNavigate: (path: string) => void;
  /**
   * Select a different neuron from inside the panel — drives the
   * "click a connection in the side panel to jump to it" UX.
   * The 3D scene watches selectedId and flies the camera to the new node.
   */
  onSelectNode: (id: string) => void;
  /**
   * Enter linking mode with this node pre-selected. The page-level
   * `beginLinking` callback closes this panel, seeds the selection
   * with the current node id, and reveals the floating action bar
   * — the user only has to pick the OTHER end(s) of the link.
   */
  onBeginLinking?: (seedNodeIds: string[]) => void;
  /**
   * Landing-prototype handoff: the saved transcript of the first chat.
   * Rendered inline when the user clicks the synthetic
   * "First Conversation" grid (since it has no real /grid route).
   */
  prototypeChat?: { role: "user" | "ai"; content: string }[];
  /**
   * Every live concept the user owns. Powers the concept detail
   * section's merge picker — without it, the user can't pick a
   * target to merge into without leaving the panel.
   */
  allConcepts?: Array<{ concept_id: string; label: string; status: string }>;
  /**
   * Resolves a raw `notes.id` to its graph node id — accounts for
   * connector-source rollups (Gmail / Slack / Notion / …) where the
   * underlying per-note vault nodes don't exist in the graph because
   * they were collapsed into a single per-app rollup. Forwarded to
   * ConceptDetailSection's link rows so "Open in graph" lands on the
   * right node for both manual saves and rolled-up sources.
   */
  vaultNodeIdFor: (noteId: string) => string;
}) {
  // Landing-prototype handoff: the buildGraph patch in SynthesisLayer
  // stamps these onto every prototype-neuron node. When present, the
  // panel swaps the generic "neuron" header for "Nth neuron created"
  // and shows the AI-supplied "why was this created" sentence instead
  // of the generic "recurring theme" copy.
  const isPrototypeNeuron = Boolean(node.meta?.isPrototypeNeuron);
  const prototypeOrdinal = (node.meta?.prototypeOrdinal as number | undefined) || 0;
  const prototypeReason = (node.meta?.prototypeReason as string | undefined) || "";
  const ordinalLabel = (n: number): string => {
    if (n <= 0) return "";
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return `${n}st`;
    if (mod10 === 2 && mod100 !== 12) return `${n}nd`;
    if (mod10 === 3 && mod100 !== 13) return `${n}rd`;
    return `${n}th`;
  };
  const isPrototypeChatGrid =
    node.kind === "grid" && node.meta?.boardId === "__prototype_first_chat__";
  const connected = useMemo(() => {
    const ids = new Set<string>();
    edges.forEach((e) => {
      if (e.from === node.id) ids.add(e.to);
      if (e.to === node.id) ids.add(e.from);
    });
    ids.delete(node.parentId || "");
    ids.delete(node.categoryId || "");
    return allNodes.filter((n) => ids.has(n.id));
  }, [node, allNodes, edges]);

  // Demo grid nodes never hit the DB, so we can't navigate to their
  // detail pages (they'd 404 or show an empty grid). The Vault page is
  // always valid — guests see the preloaded demo vault there. (The old
  // "project" branch was removed alongside the Projects category.)
  const boardId = node.meta?.boardId as string | undefined;
  const navPath = node.kind === "grid" && boardId && !isBlockedDemoId(boardId)
    ? `/grid/${boardId}`
    : node.kind === "vault"
    ? "/vault"
    : node.kind === "perspective"
    ? "/vault"
    : null;

  // Lazy-fetch the full vault note body only when this panel is actually
  // opened for a vault node. The mindmap notes query intentionally drops
  // `content` to keep the page-load payload small (see NoteRow comment);
  // here we pay one small round-trip on click and react-query caches the
  // result so re-opening the same note is instant.
  // Both Vault notes and Perspectives are persisted in the `notes`
  // table, so they share the same lazy-content fetch — the projection
  // strips `content` from the initial query to keep the page payload
  // small, and we pay one round-trip per panel open. For guest
  // (prototype) Perspectives that haven't been saved server-side yet
  // we fall back to the story stashed on the prototype meta so the
  // user still sees their text echoed back.
  const noteBackedNoteId =
    (node.kind === "vault" || node.kind === "perspective")
      ? (node.meta?.noteId as string | undefined)
      : undefined;
  const isPrototypePerspective =
    node.kind === "perspective" && !!node.meta?.prototypeStory;
  const { data: noteBackedContent } = useQuery({
    queryKey: ["mindmap_vault_note_content", noteBackedNoteId],
    queryFn: async () => {
      if (!noteBackedNoteId) return "";
      const { data, error } = await supabase
        .from("notes")
        .select("content")
        .eq("id", noteBackedNoteId)
        .maybeSingle();
      if (error) return "";
      return String(data?.content || "");
    },
    enabled: !!noteBackedNoteId && !isPrototypePerspective,
    staleTime: 5 * 60 * 1000,
  });
  // Keep the local alias for downstream code that still reads
  // `vaultContent` (the parsed-vault block below + any future
  // additions). Both kinds resolve to the same `notes.content`
  // string so the alias stays accurate.
  const vaultContent = isPrototypePerspective
    ? (node.meta?.prototypeStory as string)
    : noteBackedContent;

  const vaultParsed = useMemo(() => {
    if (node.kind !== "vault" && node.kind !== "perspective") return null;
    return parseVaultContent(String(vaultContent || ""));
  }, [node, vaultContent]);

  const contentPreview = (node.kind === "vault" || node.kind === "perspective")
    ? (vaultParsed?.body || null)
    : node.meta?.content
      ? (node.meta.content as string).replace(/\[ATTACHMENTS_JSON:[\s\S]*?\]/, "").trim()
      : null;

  const tags: string[] = node.meta?.tags || [];
  // Same rationale as WelcomePanel: the desktop right-drawer covers the
  // tapped neuron on phones, so render as a bottom sheet on mobile and
  // leave the top half of the canvas visible. The camera-focus already
  // centres the neuron in the viewport; with a bottom sheet capped at
  // ~55vh, the neuron stays comfortably above the sheet.
  const isMobile = useIsMobile();

  // Bottom sheet is a 92vh-tall container anchored bottom-0. We move
  // it via the y transform between four positions:
  //   y = 0           → expanded   (top of sheet ≈ top of viewport)
  //   y = collapsedY  → collapsed  (≈50vh visible, default reading height)
  //   y = minimizedY  → minimized  (just the drag handle peeking above
  //                                 the bottom edge — keeps the neuron
  //                                 selected so the user can rotate the
  //                                 3D scene around it without losing
  //                                 context)
  //   y = dismissedY  → dismissed  (off-screen, calls onClose)
  //
  // Pixel values (not vh strings) are required for dragConstraints so
  // the sheet can follow the finger 1:1 across the full range. We
  // measure window.innerHeight up front and re-measure on resize so
  // the math survives URL-bar show/hide on iOS.
  const SHEET_HEIGHT_VH = 92;
  const COLLAPSED_VISIBLE_VH = 50;
  // Minimized leaves ~5vh of the sheet visible — enough to grab the
  // drag handle and pull the panel back up.
  const MINIMIZED_VISIBLE_VH = 5;
  const [vh, setVh] = useState(() =>
    typeof window !== "undefined" ? window.innerHeight : 800,
  );
  useEffect(() => {
    if (!isMobile) return;
    const onResize = () => setVh(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [isMobile]);
  const sheetHeightPx = (vh * SHEET_HEIGHT_VH) / 100;
  const collapsedY = (vh * (SHEET_HEIGHT_VH - COLLAPSED_VISIBLE_VH)) / 100;
  const minimizedY = (vh * (SHEET_HEIGHT_VH - MINIMIZED_VISIBLE_VH)) / 100;
  const expandedY = 0;
  const dismissedY = sheetHeightPx;
  type SheetState = "expanded" | "collapsed" | "minimized";
  const [sheetState, setSheetState] = useState<SheetState>("collapsed");
  const targetY =
    sheetState === "expanded" ? expandedY
    : sheetState === "minimized" ? minimizedY
    : collapsedY;
  const dragControls = useDragControls();

  return (
    <motion.div
      initial={isMobile ? { y: dismissedY, opacity: 0 } : { x: 380, opacity: 0 }}
      animate={isMobile ? { y: targetY, opacity: 1 } : { x: 0, opacity: 1 }}
      exit={isMobile ? { y: dismissedY, opacity: 0 } : { x: 380, opacity: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
      // dragListener=false: only the drag handle can initiate drag (set
      // up below via dragControls.start), so scrolling the content
      // doesn't accidentally yank the whole sheet around.
      drag={isMobile ? "y" : false}
      dragControls={dragControls}
      dragListener={false}
      dragElastic={0.04}
      dragMomentum={false}
      // Absolute coords: y can travel from 0 (fully expanded, top of
      // sheet at the top of the viewport-ish) all the way to dismissedY
      // (off-screen). Sheet follows the finger 1:1 in this range.
      dragConstraints={isMobile ? { top: 0, bottom: dismissedY } : undefined}
      onDragEnd={(_, info) => {
        // Compute current y from the snap baseline + drag offset, then
        // project ~150ms forward by velocity so a quick flick "wins"
        // the snap decision over raw position alone.
        const current = targetY + info.offset.y;
        const v = info.velocity.y;
        const projected = current + v * 0.15;
        // Dismissal is intentionally hard to trigger — the user has to
        // drag the panel essentially off the bottom of the screen, OR
        // produce an extreme downward flick (v > 2500 px/s). This lets
        // them pull the sheet way down to "minimized" so they can
        // rotate the 3D scene around the focused neuron without ever
        // losing it.
        const dismissThresh = dismissedY - vh * 0.04;
        if (projected > dismissThresh || v > 2500) {
          onClose();
          return;
        }
        // Snap to whichever of the three on-screen states the
        // projected resting position is closest to. Strong upward
        // velocity always promotes to expanded so a flick-up always
        // wins.
        if (v < -800) {
          setSheetState("expanded");
          return;
        }
        const distExpanded = Math.abs(projected - expandedY);
        const distCollapsed = Math.abs(projected - collapsedY);
        const distMinimized = Math.abs(projected - minimizedY);
        const min = Math.min(distExpanded, distCollapsed, distMinimized);
        if (min === distExpanded) setSheetState("expanded");
        else if (min === distMinimized) setSheetState("minimized");
        else setSheetState("collapsed");
      }}
      className={
        isMobile
          ? "absolute left-0 right-0 bottom-0 z-30 w-full border-t border-white/8 rounded-t-2xl flex flex-col"
          : "absolute top-0 right-0 z-30 h-full w-[360px] border-l border-white/8 flex flex-col"
      }
      style={{
        backgroundColor: "rgba(23,23,23,0.85)",
        backdropFilter: "blur(18px)",
        WebkitBackdropFilter: "blur(18px)",
        ...(isMobile
          ? {
              height: `${SHEET_HEIGHT_VH}vh`,
              paddingBottom: "env(safe-area-inset-bottom, 0px)",
            }
          : null),
      }}
      data-stop-canvas-wheel="true"
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {isMobile && (
        <div
          // Handle gets a generous touch target (~36px tall) and is the
          // ONLY drag-origin for the sheet — content below scrolls
          // freely without dragging the whole sheet with it.
          onPointerDown={(e) => dragControls.start(e)}
          onClick={() => setSheetState((s) => (s === "expanded" ? "collapsed" : "expanded"))}
          className="flex justify-center items-center pt-2.5 pb-3 cursor-grab active:cursor-grabbing select-none"
          style={{ touchAction: "none" }}
          role="button"
          aria-label={sheetState === "expanded" ? "Collapse panel" : "Expand panel"}
        >
          <span className="block w-10 h-1 rounded-full bg-white/25" />
        </div>
      )}
      {/* Header. Desktop has no internal close button — the page-level
          chevron toggle (z-[100], right-4) is the canonical close
          affordance for every right-side panel. We right-pad the row
          so the kind label clears the chevron when it's visible.
          Mobile keeps an X because the bottom-sheet form factor lives
          at the bottom of the screen and reaching the top-right
          corner mid-read is awkward; the sheet also supports
          drag-to-dismiss. */}
      <div className={
        isMobile
          ? "flex items-center gap-3 px-5 pt-2 pb-3"
          : "flex items-center gap-3 pl-5 pr-12 pt-2 pb-3"
      }>
        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: node.color }} />
        <span className={`text-xs font-semibold flex-1 truncate ${
          isPrototypeNeuron
            ? "text-pink-300 normal-case tracking-wide"
            : "text-gray-700 dark:text-gray-200 capitalize"
        }`}>
          {isPrototypeNeuron
            ? `${ordinalLabel(prototypeOrdinal || 1)} neuron created`
            : node.kind === "category" ? node.label
            : node.meta?.isSourceRollup ? String(node.meta.sourceLabel || node.kind)
            : node.kind}
        </span>
        {isMobile ? (
          <button
            onClick={onClose}
            aria-label="Close panel"
            className="w-9 h-9 rounded-full bg-white/8 hover:bg-white/14 flex items-center justify-center transition-colors flex-shrink-0"
          >
            <X size={16} className="text-white/85" />
          </button>
        ) : null}
      </div>

      <div className="px-5 pb-4">
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100 leading-snug break-words">
          {isPrototypeChatGrid
            ? "First Conversation"
            : node.meta?.isSourceRollup
            ? `${String(node.meta.sourceLabel || "Source")} · ${Number(node.meta.itemCount || 0).toLocaleString()} items`
            : (node.kind === "vault" || node.kind === "perspective") && node.meta?.title ? node.meta.title as string : node.label}
        </h2>
        {isPrototypeChatGrid && (
          <p className="text-[0.6875rem] text-gray-400 dark:text-gray-500 mt-1.5">
            The chat where LYKN started learning you. Every neuron above
            grew out of this conversation.
          </p>
        )}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {tags.map((t) => (
              <span key={t} className="text-[0.6rem] px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">
                #{t}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5 scrollbar-hide">
        {/* Prototype handoff: render the first-chat transcript inline */}
        {isPrototypeChatGrid && prototypeChat && prototypeChat.length > 0 && (
          <div className="mb-4 flex flex-col gap-2.5">
            {prototypeChat.map((turn, i) => (
              <div
                key={i}
                className={`flex ${turn.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-[0.75rem] leading-relaxed whitespace-pre-wrap ${
                    turn.role === "user"
                      ? "rounded-br-md bg-white/8 text-white/90 border border-white/10"
                      : "rounded-bl-md bg-blue-500/10 text-blue-50/90 border border-blue-400/20"
                  }`}
                >
                  {turn.content}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Connector source rollup — special-cased ahead of the regular
            vault view. A rollup node represents N synced items from a
            single connector (Gmail / Slack / Notion / …). We render a
            scannable list of items here; clicking one expands an inline
            preview that lazy-fetches the full body, same pattern the
            per-note vault view uses below. */}
        {node.kind === "vault" && node.meta?.isSourceRollup && (
          <SourceRollupView
            sourceApp={String(node.meta.sourceApp || "")}
            sourceLabel={String(node.meta.sourceLabel || "")}
            itemCount={Number(node.meta.itemCount || 0)}
            items={(node.meta.items as Array<{ noteId: string; title: string; ai_summary: string | null; tags: string[]; sourceSlug: string }>) || []}
            onNavigate={onNavigate}
          />
        )}

        {/* Vault view mode */}
        {node.kind === "vault" && !node.meta?.isSourceRollup && (
          <>
            {node.meta?.ai_summary && (
              <div className="mb-4">
                <p className="text-[0.6875rem] font-medium text-gray-500 dark:text-gray-400 mb-1.5">AI Summary</p>
                <p className="text-[0.75rem] text-gray-600 dark:text-gray-300 leading-relaxed italic">
                  {node.meta.ai_summary as string}
                </p>
              </div>
            )}

            {vaultParsed && vaultParsed.attachments.length > 0 && (
              <div className="mb-4 flex flex-col gap-2">
                {vaultParsed.attachments.map((att: any, idx: number) => (
                  <VaultAttachment key={idx} att={att} />
                ))}
              </div>
            )}

            {vaultParsed && vaultParsed.body && (
              <div className="mb-4">
                <div className="text-[0.75rem] text-gray-600 dark:text-gray-300 leading-relaxed whitespace-pre-wrap">
                  {vaultParsed.body}
                </div>
              </div>
            )}

            {!vaultParsed?.body && !vaultParsed?.attachments.length && !node.meta?.ai_summary && (
              <div className="mb-4">
                <p className="text-[0.75rem] text-gray-400 dark:text-gray-500 italic">No content available for this note.</p>
              </div>
            )}

            {(() => {
              const linkedGrids = connected.filter((c) => c.kind === "grid");
              if (!linkedGrids.length) return null;
              return (
                <div className="mb-4">
                  <p className="text-[0.6875rem] font-medium text-gray-500 dark:text-gray-400 mb-2">Found in Chats</p>
                  <div className="flex flex-col gap-1">
                    {linkedGrids.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => onSelectNode(g.id)}
                        title={`Jump to ${g.label}`}
                        className="flex items-center gap-2 px-2.5 py-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-colors text-left cursor-pointer w-full"
                      >
                        <GridIcon size={12} className="text-blue-400 flex-shrink-0" />
                        <span className="text-[0.6875rem] text-gray-600 dark:text-gray-300 truncate">{g.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })()}

            {(node.meta?.themes as string[] || []).length > 0 && (
              <div className="mb-4">
                <p className="text-[0.6875rem] font-medium text-gray-500 dark:text-gray-400 mb-1.5">Themes</p>
                <div className="flex flex-wrap gap-1.5">
                  {(node.meta!.themes as string[]).map((t) => (
                    <span key={t} className="text-[0.6rem] px-1.5 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-300">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Non-vault content preview */}
        {node.kind !== "vault" && contentPreview && (
          <div className="mb-4">
            <p className="text-[0.6875rem] font-medium text-gray-500 dark:text-gray-400 mb-1.5">Content</p>
            <div className="text-[0.75rem] text-gray-600 dark:text-gray-300 leading-relaxed whitespace-pre-wrap rounded-lg bg-black/[0.02] dark:bg-white/[0.03] p-3 max-h-[280px] overflow-y-auto">
              {contentPreview.slice(0, 1200)}
              {contentPreview.length > 1200 && "…"}
            </div>
          </div>
        )}

        {node.kind === "category" && (
          <div className="mb-4">
            <p className="text-[0.6875rem] font-medium text-gray-500 dark:text-gray-400 mb-1">
              Contains {allNodes.filter((n) => n.categoryId === node.id).length} items
            </p>
          </div>
        )}

        {node.kind === "belief" && <BeliefDetailSection node={node} />}

        {node.kind === "concept" && (
          <ConceptDetailSection
            node={node}
            allConcepts={allConcepts || []}
            onSelectNode={onSelectNode}
            onNavigate={onNavigate}
            vaultNodeIdFor={vaultNodeIdFor}
          />
        )}

        {node.kind === "neuron" && node.meta?.neuronKind === "fact" && (
          <FactDetailSection node={node} />
        )}

        {node.kind === "neuron" && node.meta?.neuronKind !== "fact" && (() => {
          const kind = node.meta?.neuronKind as string || "pattern";
          const source = node.meta?.source as string || "";
          const connectedVault = connected.filter((c) => c.kind === "vault");
          const connectedGrids = connected.filter((c) => c.kind === "grid");
          const connectedTags = connected.filter((c) => c.kind === "tag");

          const originDesc: Record<string, string> = {
            theme: `The LYKN Synthesis Layer identified "${node.label}" as a recurring theme across your work. This neuron was formed because the AI detected this topic appearing consistently in your grids, vault notes, and conversations — indicating it's a core area of focus for you.`,
            goal: `This neuron represents a goal the AI inferred from your activity. By analyzing patterns in what you create, discuss, and save, the Synthesis Layer recognized "${node.label}" as something you're actively working toward.`,
            recurring_topic: `The AI noticed "${node.label}" surfacing repeatedly across different contexts — grids, notes, and conversations. This neuron was created to represent this persistent thread in your thinking, helping you see how this topic connects to your broader work.`,
            reasoning_style: `This neuron captures a reasoning pattern the AI observed in how you approach problems. The Synthesis Layer recognized "${node.label}" as characteristic of your thinking style based on your conversations and the way you structure ideas.`,
            vocabulary: `The AI identified "${node.label}" as part of your distinctive vocabulary — a term or phrase you use frequently and meaningfully. This neuron highlights language patterns that reflect how you think and communicate.`,
          };

          return (
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-3">
                <Sparkles size={13} className="text-pink-400" />
                <span className="text-[0.6rem] px-1.5 py-0.5 rounded-full bg-pink-100 dark:bg-pink-900/30 text-pink-700 dark:text-pink-300 font-medium">
                  {isPrototypeNeuron
                    ? `Neuron #${prototypeOrdinal || 1}`
                    : (node.meta?.kindLabel || "Insight")}
                </span>
                <span className="text-[0.6rem] text-gray-400 dark:text-gray-500">
                  AI Neuron
                </span>
              </div>

              <p className="text-[0.75rem] text-gray-600 dark:text-gray-300 leading-relaxed mb-4">
                {isPrototypeNeuron
                  ? prototypeReason
                    ? prototypeReason
                    : prototypeOrdinal === 1
                    ? `The very first thing your synthetic intelligence learned about you: "${node.label}". Every neuron after this one will branch out from what you share — your sources, your taste, the way you think — and connect into the same web you see here.`
                    : `The ${ordinalLabel(prototypeOrdinal || 1)} thing your synthetic intelligence learned about you: "${node.label}".`
                  : originDesc[source] || `The AI recognized "${node.label}" as a ${kind} based on your activity across grids, vault, and conversations.`}
              </p>

              {connectedVault.length > 0 && (
                <div className="mb-3">
                  <p className="text-[0.625rem] font-medium text-gray-400 dark:text-gray-500 mb-1.5 uppercase tracking-wider">Related Vault Notes</p>
                  <div className="flex flex-col gap-1">
                    {connectedVault.slice(0, 6).map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => onSelectNode(c.id)}
                        title={`Jump to ${c.label}`}
                        className="flex items-center gap-2 px-2 py-1 rounded-md bg-emerald-50/50 dark:bg-emerald-900/10 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/20 transition-colors text-left cursor-pointer w-full"
                      >
                        <StickyNote size={10} className="text-emerald-400 flex-shrink-0" />
                        <span className="text-[0.6875rem] text-gray-600 dark:text-gray-300 truncate">{c.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {connectedGrids.length > 0 && (
                <div className="mb-3">
                  <p className="text-[0.625rem] font-medium text-gray-400 dark:text-gray-500 mb-1.5 uppercase tracking-wider">Related Chats</p>
                  <div className="flex flex-col gap-1">
                    {connectedGrids.slice(0, 6).map((c) => (
                      // Click selects the grid neuron in the 3D graph (camera
                      // flies to it). The Detail panel for that node carries
                      // its own "Open Grid" footer button for users who want
                      // to leave the synthesis view.
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => onSelectNode(c.id)}
                        title={`Jump to ${c.label}`}
                        className="flex items-center gap-2 px-2 py-1 rounded-md bg-gray-100/50 dark:bg-white/[0.05] hover:bg-gray-100 dark:hover:bg-white/[0.08] transition-colors text-left cursor-pointer w-full"
                      >
                        <GridIcon size={10} className="text-blue-400 flex-shrink-0" />
                        <span className="text-[0.6875rem] text-gray-600 dark:text-gray-300 truncate">{c.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {connectedTags.length > 0 && (
                <div className="mb-3">
                  <p className="text-[0.625rem] font-medium text-gray-400 dark:text-gray-500 mb-1.5 uppercase tracking-wider">Related Tags</p>
                  <div className="flex flex-wrap gap-1.5">
                    {connectedTags.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => onSelectNode(c.id)}
                        title={`Jump to ${c.label}`}
                        className="text-[0.6rem] px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 hover:bg-amber-200 dark:hover:bg-amber-900/50 text-amber-700 dark:text-amber-300 transition-colors cursor-pointer"
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {node.kind === "root" && node.meta?.narrative && (
          <div className="mb-4">
            <p className="text-[0.6875rem] font-medium text-gray-500 dark:text-gray-400 mb-1.5">AI&apos;s Understanding of You</p>
            <div className="text-[0.75rem] text-gray-600 dark:text-gray-300 leading-relaxed whitespace-pre-wrap rounded-lg bg-black/[0.02] dark:bg-white/[0.03] p-3 max-h-[280px] overflow-y-auto">
              {(node.meta.narrative as string).slice(0, 1200)}
            </div>
          </div>
        )}

        {connected.length > 0 && (
          <div className="mb-4">
            <p className="text-[0.6875rem] font-medium text-gray-500 dark:text-gray-400 mb-2">
              Connections ({connected.length})
            </p>
            <div className="flex flex-col gap-1">
              {connected.slice(0, 30).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onSelectNode(c.id)}
                  title={`Jump to ${c.label}`}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-black/[0.03] dark:hover:bg-white/[0.06] transition-colors text-left cursor-pointer w-full"
                >
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: c.color, boxShadow: `0 0 6px ${c.color}80` }}
                  />
                  <span className="text-[0.6875rem] text-gray-600 dark:text-gray-300 truncate flex-1">{c.label}</span>
                  <span className="text-[0.6rem] text-gray-400 dark:text-gray-500 capitalize">{c.kind}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* "Link to other neurons" — visible on every non-root, non-
          category node. Clicking enters page-level linking mode with
          this node pre-selected; the floating action bar takes over
          and the panel closes so the canvas is unobscured. We deliberately
          allow guests to use this — the userLinks lib falls back to
          localStorage and the new edges still render in the brain. */}
      {onBeginLinking && node.kind !== "root" && node.kind !== "category" && (
        <div className="px-5 pb-3">
          <button
            onClick={() => onBeginLinking([node.id])}
            className="w-full flex items-center justify-center gap-2 text-[0.75rem] font-medium py-2.5 rounded-lg border border-blue-400/35 bg-blue-500/15 hover:bg-blue-500/25 text-blue-100 transition-colors"
          >
            <Link2 size={13} />
            Link to other neurons
          </button>
        </div>
      )}

      {navPath && (
        <div className="px-5 pb-5">
          <button
            onClick={() => onNavigate(navPath)}
            className="w-full flex items-center justify-center gap-2 text-[0.75rem] font-medium py-2.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.07] dark:hover:bg-white/[0.1] text-gray-700 dark:text-gray-200 transition-colors"
          >
            <ExternalLink size={13} />
            Open {node.kind === "vault" || node.kind === "perspective" ? "Vault" : node.label}
          </button>
        </div>
      )}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

// Free users get a real preview of the Synthesis Layer up to this many
// EXPLICIT user-created neurons (grids + vault notes + perspectives +
// ratified beliefs + manual facts). AI-derived nodes — clustered concepts,
// inferred facts, profile themes / goals / topics / vocabulary — never
// count toward this cap, so the nightly synthesis job can't accidentally
// paywall a free user out of their own brain just by inferring things.
//
// Pulled from PLAN_LIMITS so the cap stays in lockstep with the rest of
// the pricing config; the literal fallback matches the free-tier value
// today and is just defensive in case the limits map ever drops the field.
const FREE_SYNTHESIS_NODE_LIMIT: number =
  Number.isFinite(PLAN_LIMITS.free?.synthesisNodes)
    ? (PLAN_LIMITS.free.synthesisNodes as number)
    : 100;

// ---------------------------------------------------------------------------
// NeuronCreationModal
// ---------------------------------------------------------------------------
// Centered modal launched from the "+" toolbar menu. Handles BOTH neuron
// types (Basic neuron & Core Belief neuron) so the user gets a consistent
// "name → description → form → save → watch it form" experience no matter
// which kind they're authoring.
//
// Lifecycle phases:
//   1. "compose"  — backdrop dims the page, the modal shows the type's
//                   name + description + the relevant form. X or
//                   backdrop-click cancels.
//   2. "forming"  — after a successful save the form swaps for a brief
//                   formation visual: a glowing neuron sphere scales in,
//                   pulses, then fades out as the modal dismisses. This
//                   is the moment the user "watches the neuron get
//                   created" — even when the actual graph node won't
//                   materialize until the next refresh (basic neurons
//                   are derived from a downstream synthesis pass).
//   3. closes     — onClose() and onCreated(newId) fire. For belief
//                   neurons, onCreated provides the new belief UUID so
//                   the page can chain into the graph-level formingNodeId
//                   animation when the corresponding `belief_<uuid>` node
//                   shows up after the active-beliefs refetch.

// Basic neurons no longer expose the kind taxonomy in the UI — the modal
// just collects free text and we hand it off to /api/learned with the
// safe "identity" default. The server's reconciler reclassifies later if
// the fact text obviously fits another bucket (focus / goal / etc.), so
// hiding the dropdown costs nothing functional and removes a decision
// users were never excited about making.

// Each entry doubles as the modal's visual identity AND the structural
// blueprint of its compose form. Templates are intentionally distinct
// per type — a Fact is short-and-sweet, a Belief leaves room for the
// "why," and a Perspective is a small story. Building neurons should
// feel like snapping the right-shaped lego together, not filling out
// the same generic textbox over and over.
const NEURON_TYPE_THEME = {
  basic: {
    title: "Fact Neuron",
    short: "A single fact about you",
    // Fact = short and sweet. One sentence. The composer enforces
    // this with a single-line input + tight char cap so the user
    // physically can't write a paragraph here.
    description:
      "Atomic memory the AI can lean on. Keep it to one sentence — \"I work as a designer,\" \"I focus best in the morning.\" Short, true, easy to recall.",
    accent: "blue",
    accentHex: "#60a5fa", // blue-400
    accentRing: "border-blue-400/35",
    accentChip: "bg-blue-500/15 text-blue-200 border-blue-400/30",
    accentGlow: "shadow-[0_0_60px_rgba(96,165,250,0.5)]",
  },
  belief: {
    title: "Belief Neuron",
    short: "A principle that shapes every reply",
    // Belief = the principle PLUS the reason. Two-field form: the
    // belief itself, then a "why" rationale that gets stored on the
    // belief row. The AI uses the rationale to explain itself when it
    // applies this belief in chat.
    description:
      "The principles you live by. The AI runs every reply through these before anything else. Capture the belief AND why you hold it, so the AI can explain itself when it leans on this.",
    // Beliefs render as the WHITE cluster in the 3D scene
    // (palette.belief.bg = "#ffffff"). The build modal used to be
    // tinted indigo, which read as purple and didn't match the 3D
    // node colour anywhere else in the app. White accent here keeps
    // the build experience consistent with the cluster the neuron
    // is actually about to join.
    accent: "white",
    accentHex: "#ffffff",
    accentRing: "border-white/30",
    accentChip: "bg-white/10 text-white/95 border-white/25",
    accentGlow: "shadow-[0_0_60px_rgba(255,255,255,0.45)]",
  },
  concept: {
    title: "Concept Neuron",
    short: "A theme that ties your ideas together",
    description:
      "A named idea the AI should track across your work. Once it exists, anything you say or save that touches it links back here. Example: \"Personal CRM\" or \"Design systems.\"",
    accent: "amber",
    accentHex: "#fb923c", // orange-400 (matches concepts palette)
    accentRing: "border-orange-400/35",
    accentChip: "bg-orange-500/15 text-orange-200 border-orange-400/30",
    accentGlow: "shadow-[0_0_60px_rgba(251,146,60,0.5)]",
  },
  perspective: {
    title: "Perspective Neuron",
    short: "A story that shapes how you see the world",
    // Perspective = long-form lego. The user gets a title field +
    // a roomy story textarea. This is where life events, formative
    // memories, and "the time I learned X" go. The AI uses these
    // to ground replies in the user's lived experience instead of
    // pattern-matching generic advice.
    description:
      "A formative story or point of view the AI should know about you. Write the title and then tell the story — a project that changed how you work, a memory that explains how you see things. The AI uses these to ground its replies in your real life.",
    // Perspectives share the Belief cluster's WHITE treatment in the
    // 3D scene after the 5-category collapse (see the
    // "Perspectives now share the white Belief treatment" note
    // elsewhere in this file), so the build modal matches —
    // previously this was violet, which read as purple and was no
    // longer reflected anywhere in the rendered graph.
    accent: "white",
    accentHex: "#ffffff",
    accentRing: "border-white/30",
    accentChip: "bg-white/10 text-white/95 border-white/25",
    accentGlow: "shadow-[0_0_60px_rgba(255,255,255,0.45)]",
  },
  tag: {
    title: "Tag",
    short: "A label you can hang on Vault items",
    description:
      "Tags are how you organize the Vault. Name one here and it'll show up as a filter the next time you save something — perfect for grouping notes, files, or saved chats by project or theme.",
    accent: "amber",
    accentHex: "#fbbf24", // amber-400 (matches tags palette)
    accentRing: "border-amber-400/35",
    accentChip: "bg-amber-500/15 text-amber-200 border-amber-400/30",
    accentGlow: "shadow-[0_0_60px_rgba(251,191,36,0.5)]",
  },
} as const;

type NeuronCreationModalProps = {
  type: "basic" | "belief" | "concept" | "tag" | "perspective";
  onClose: () => void;
  /** Called after a successful save with the server-returned id (for
      beliefs the lykn_beliefs UUID; for basic neurons the fact id;
      for concepts the lykn_concepts UUID; for tags the new note id
      that carries the tag). The second arg carries the raw text the
      user submitted — useful for types whose graph-node id derives
      from the label rather than the row id (e.g. tags use `tag_<text>`,
      not `tag_<noteId>`). */
  onCreated: (newId: string | null, text: string) => void;
  /** Snapshot of every neuron currently in the synthesis graph.
      Powers the in-panel Connections multi-select so the user can
      wire the freshly-minted neuron to existing nodes as part of
      the same submit. Pass the same `allNodes` the 3D scene uses;
      the panel filters out the root + the empty category shells
      internally so the picker only shows real neurons. */
  existingNodes?: Array<{ id: string; label: string; kind: string; color?: string }>;
  /** Authenticated user id for the userLinks write. */
  userId?: string | null;
};

// Tiny presentational helpers for the per-type templates. Pulled out
// so the JSX in `NeuronCreationModal` reads as a sequence of fields
// rather than getting buried in repeated label/hint chrome. Both are
// purely cosmetic — no state, no side effects — and stay scoped to
// this file because no other modal needs this look.
function NeuronFieldLabel({
  label,
  hint,
  children,
}: {
  label?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      {label ? (
        <p className="text-[0.7rem] font-medium text-white/75">{label}</p>
      ) : null}
      {children}
      {hint ? (
        <p className="text-[0.62rem] text-white/40 leading-snug">{hint}</p>
      ) : null}
    </div>
  );
}

function NeuronCharCount({ value, max }: { value: string; max: number }) {
  const used = value.length;
  const near = used >= max * 0.9;
  return (
    <p
      className={`text-[0.55rem] tracking-wide text-right ${near ? "text-amber-300/75" : "text-white/30"}`}
    >
      {used}/{max}
    </p>
  );
}

function NeuronCreationModal({
  type,
  onClose,
  onCreated,
  existingNodes,
  userId,
}: NeuronCreationModalProps) {
  const theme = NEURON_TYPE_THEME[type];
  const [phase, setPhase] = useState<"compose" | "forming">("compose");

  // Unified compose state. After the 5-category collapse every neuron
  // type uses the SAME shape — title, why, story, connections,
  // additional notes — so the panel looks identical regardless of
  // which "+" entry the user clicked. The submit step routes each
  // field to the right column / table per type:
  //
  //   • Title       → primary text column (belief_text / fact_text /
  //                   label / notes.title for perspectives)
  //   • Why         → rationale column on beliefs; metadata.why on
  //                   facts + concepts; skipped on perspectives until
  //                   a follow-up migration adds metadata to notes
  //   • Story       → notes.content for perspectives; metadata.story
  //                   for beliefs / facts / concepts
  //   • Connections → lykn_user_links rows wiring the new neuron to
  //                   every selected existing node
  //   • Notes       → metadata.notes for beliefs / facts / concepts;
  //                   skipped on perspectives (see Why)
  //
  // The "perspective" type still routes through the existing notes-
  // table insert path; everything else hits the type-specific
  // /api/* endpoint with the metadata blob attached.
  const [title, setTitle] = useState("");
  const [why, setWhy] = useState("");
  const [story, setStory] = useState("");
  const [notes, setNotes] = useState("");
  const [selectedConnections, setSelectedConnections] = useState<Set<string>>(
    new Set(),
  );
  const [connectionSearch, setConnectionSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the forming-phase visual displays as the freshly-minted neuron's
  // body text. Frozen at submit time so input edits don't bleed in mid-
  // animation.
  const [formedText, setFormedText] = useState("");

  // Title is the only universally-required field. Perspectives ALSO
  // need a story body (the title alone isn't enough to count as a
  // perspective), but the Why / Notes / Connections are always
  // optional. The unified shape means the form is never harder to
  // fill out than the legacy per-type templates — the user can save
  // a Fact with just the title, exactly like before.
  const trimmedTitle = title.trim();
  const canSubmit = !submitting && (
    type === "perspective"
      ? !!trimmedTitle && !!story.trim()
      : !!trimmedTitle
  );

  // Filtered list for the Connections picker. We drop the root + the
  // empty category shells (no point linking the new neuron to "Vault"
  // the cluster, only to neurons inside it), and filter against the
  // search box if non-empty. Capped at 30 to keep render cheap when a
  // user has a thousand-node brain.
  const connectionCandidates = useMemo(() => {
    const all = existingNodes || [];
    const q = connectionSearch.trim().toLowerCase();
    const filtered = all.filter((n) => {
      if (n.kind === "root" || n.kind === "category") return false;
      if (!q) return true;
      return n.label.toLowerCase().includes(q);
    });
    return filtered.slice(0, 30);
  }, [existingNodes, connectionSearch]);

  const toggleConnection = (nodeId: string) => {
    setSelectedConnections((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  // Compute the synthesis-layer node id the parent will mint for the
  // freshly-saved neuron. Mirrors `buildGraph` + the prototype handoff
  // injection — keep these in sync if either is renamed.
  const newNodeIdFor = (
    savedType: typeof type,
    savedId: string | null,
    savedTitle: string,
  ): string | null => {
    if (!savedId) return null;
    switch (savedType) {
      case "belief":      return `belief_${savedId}`;
      case "concept":     return `concept_${savedId}`;
      case "perspective": return `perspective_${savedId}`;
      case "tag":         return `tag_${savedTitle}`;
      case "basic":       return `fact_${savedId}`;
      default:            return null;
    }
  };

  // Build the metadata blob we attach to /api/learned, /api/beliefs/manual,
  // and /api/v1/concepts. Each endpoint sanitises + caps the fields
  // server-side (see migration 063 comment), so we just hand them the
  // raw user input here.
  const buildMetadata = (): Record<string, string> | null => {
    const m: Record<string, string> = {};
    const s = story.trim();
    const n = notes.trim();
    const w = why.trim();
    if (s) m.story = s;
    if (n) m.notes = n;
    if (w) m.why = w;
    return Object.keys(m).length > 0 ? m : null;
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const t = trimmedTitle;
    const w = why.trim();
    const s = story.trim();
    const n = notes.trim();
    const metadata = buildMetadata();
    try {
      let newId: string | null = null;
      if (type === "basic") {
        // Always send 'identity' — the server's reconciler downgrades /
        // reclassifies the kind based on text content if it obviously
        // fits another bucket (focus / goal / etc.).
        const res = await fetch(`${API_BASE_URL}/api/learned`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: t,
            kind: "identity",
            ...(metadata ? { metadata } : {}),
          }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || (body && body.ok === false)) {
          const reason =
            body?.error ||
            body?.reason ||
            (res.status === 401 ? "auth_required" : null) ||
            `http_${res.status}`;
          // /api/learned forwards the PG trigger message verbatim as `error`,
          // so a synthesis-cap hit lands as `synthesis_neuron_cap_reached: …`
          // — dispatch the upgrade modal instead of showing the raw string.
          if (isSynthesisCapError({ message: reason })) {
            notifySynthesisCapIfApplicable({ message: reason });
            setError("Couldn't save — upgrade required.");
          } else {
            setError(toUserFacingError());
          }
          setSubmitting(false);
          return;
        }
        newId = body?.fact?.id ?? null;
      } else if (type === "belief") {
        // Default servesNeed to "value" — most user-authored beliefs are
        // about craft, identity, or how-they-work. The "Why" field maps
        // to the existing `rationale` column on lykn_beliefs; story +
        // notes ride along in the metadata jsonb (migration 063).
        const res = await fetch(`${API_BASE_URL}/api/beliefs/manual`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: t,
            servesNeed: "value",
            ...(w ? { rationale: w } : {}),
            ...(s || n ? { metadata: { ...(s ? { story: s } : {}), ...(n ? { notes: n } : {}) } } : {}),
          }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || (body && body.ok === false)) {
          const reason =
            body?.error ||
            body?.reason ||
            (res.status === 401 ? "auth_required" : null) ||
            `http_${res.status}`;
          // Same synthesis-cap detection as the basic-neuron path:
          // createManualBelief forwards the trigger error message via
          // `reason`, so cap hits arrive as a recognisable substring.
          if (isSynthesisCapError({ message: reason })) {
            notifySynthesisCapIfApplicable({ message: reason });
            setError("Couldn't save — upgrade required.");
          } else {
            setError(toUserFacingError());
          }
          setSubmitting(false);
          return;
        }
        newId = body?.belief?.id ?? null;
      } else if (type === "concept") {
        // Manual concept creation routes through the public concept
        // CRUD endpoint, which auto-embeds in the background and
        // idempotently dedupes by slug. Default kind is "topic". The
        // why / story / notes ride along in the metadata jsonb (063).
        const res = await fetch(`${API_BASE_URL}/api/v1/concepts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: t,
            kind: "topic",
            ...(metadata ? { metadata } : {}),
          }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const reason =
            body?.error ||
            (res.status === 401 ? "auth_required" : null) ||
            `http_${res.status}`;
          setError(toUserFacingError());
          setSubmitting(false);
          return;
        }
        newId = body?.id ?? null;
      } else if (type === "perspective") {
        // Perspectives still piggyback on the Vault notes table: title
        // + body land in `notes`, plus a `_perspective` tag the
        // synthesis-layer query filters on. The why / notes fields
        // are deliberately NOT persisted yet — the notes table doesn't
        // have a metadata column (deferred to a follow-up migration);
        // for now the panel renders those fields for visual parity
        // and the data lives in the user's session-only state.
        const { data: authData } = await supabase.auth.getUser();
        const authUserId = authData?.user?.id;
        if (!authUserId) {
          setError(toUserFacingError());
          setSubmitting(false);
          return;
        }
        const { data: inserted, error: insErr } = await supabase
          .from("notes")
          .insert({
            user_id: authUserId,
            title: t,
            content: s,
            tags: ["_perspective"],
          })
          .select("id")
          .single();
        if (insErr || !inserted?.id) {
          // Vault cap (029/052) and synthesis cap (066) both surface as
          // PG check_violations on this insert path — perspectives ARE
          // notes, so both triggers fire on the same row. Translate the
          // raw PG error into the existing upgrade-modal events before
          // falling back to the inline error string.
          if (notifyVaultCapIfApplicable(insErr) || notifySynthesisCapIfApplicable(insErr)) {
            setError("Couldn't save — upgrade required.");
          } else {
            setError(toUserFacingError());
          }
          setSubmitting(false);
          return;
        }
        newId = inserted.id as string;
      } else {
        // type === "tag" — legacy path retained so existing references
        // (programmatic creatingNeuronType="tag") don't blow up. The
        // "+" menu no longer exposes this entry post-5-category
        // collapse; tags are Vault-item attributes now.
        const { data: authData } = await supabase.auth.getUser();
        const authUserId = authData?.user?.id;
        if (!authUserId) {
          setError(toUserFacingError());
          setSubmitting(false);
          return;
        }
        const { data: inserted, error: insErr } = await supabase
          .from("notes")
          .insert({
            user_id: authUserId,
            title: t,
            content: `Notes tagged "${t}" will collect here.`,
            tags: [t],
          })
          .select("id")
          .single();
        if (insErr || !inserted?.id) {
          setError(toUserFacingError());
          setSubmitting(false);
          return;
        }
        newId = inserted.id as string;
      }

      // Connections persistence — wire the new neuron to every node the
      // user selected in the in-panel picker. We do this AFTER the
      // primary save so a userLinks failure can't lose the neuron
      // itself. `createUserLinks` self-falls-back to localStorage for
      // guests and on any Supabase error, so it always "succeeds" from
      // the caller's perspective.
      if (selectedConnections.size > 0) {
        const newNodeId = newNodeIdFor(type, newId, t);
        if (newNodeId) {
          const pairs = Array.from(selectedConnections).map((targetId) => ({
            fromNodeId: newNodeId,
            toNodeId: targetId,
            label: null,
          }));
          try {
            await createUserLinks(userId || null, pairs);
          } catch (linkErr) {
            // Non-fatal — the neuron is saved, just the wiring failed.
            console.warn("createUserLinks failed:", linkErr);
          }
        }
      }

      // Phase 2: hold the panel open through the formation animation.
      // Roughly 1.4s of "neuron forming", then close + handoff.
      setFormedText(t);
      setPhase("forming");
      window.setTimeout(() => {
        onCreated(newId, t);
        onClose();
      }, 1400);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "network_error";
      setError(toUserFacingError());
      setSubmitting(false);
    }
  };

  // Per-type copy for the Title field. Every neuron type has the SAME
  // field structure post-refactor, but the label / placeholder / cap
  // changes because "title" means slightly different things for each
  // (a fact's headline is ~one short line; a perspective's title is a
  // name for a longer story). The hint copy stays purposeful.
  const titleCopy = (() => {
    switch (type) {
      case "basic":
        return {
          label: "Title",
          placeholder: "e.g. 'Designer building LYKN solo.'",
          hint: "One sentence the AI should remember about you.",
          maxLength: 140,
        };
      case "belief":
        return {
          label: "Title",
          placeholder: "e.g. 'Treat others the way you want to be treated.'",
          hint: "The principle itself — one sentence.",
          maxLength: 200,
        };
      case "concept":
        return {
          label: "Title",
          placeholder: "e.g. 'Personal CRM'",
          hint: "A short, memorable name.",
          maxLength: 80,
        };
      case "perspective":
        return {
          label: "Title",
          placeholder: "e.g. 'How I learned to ship before perfecting.'",
          hint: "A name for this story or point of view.",
          maxLength: 80,
        };
      case "tag":
      default:
        return {
          label: "Title",
          placeholder: "e.g. 'side-project'",
          hint: "A short label.",
          maxLength: 48,
        };
    }
  })();

  return (
    // Right-side slide-out panel — replaces the centered modal so the
    // user can keep glancing at the 3D scene while filling out the
    // longer unified form (Title / Why / Story / Connections / Notes
    // adds up to ~5x the height of the old compact modal). A dim
    // backdrop still covers the rest of the page in compose phase to
    // focus attention on the form; clicking it cancels (same as
    // hitting the X). During the forming animation we lock both so
    // the formation plays out cleanly.
    //
    // Single-root return so AnimatePresence at the mount site has one
    // motion element to track for exit; the slide-out panel is nested
    // as a `position:fixed` child whose layout escapes the parent's
    // flow, so it still anchors to the right edge of the viewport.
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      className="fixed inset-0 z-[119] bg-black/55 backdrop-blur-[2px]"
      onClick={() => { if (phase === "compose") onClose(); }}
    >
      <motion.div
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", stiffness: 280, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={theme.title}
        className={`fixed top-0 right-0 z-[120] h-full w-full max-w-md bg-[rgba(15,15,18,0.97)] border-l ${theme.accentRing} shadow-[-20px_0_60px_rgba(0,0,0,0.55)] flex flex-col`}
      >
        {phase === "compose" ? (
          <>
            {/* Header — accent chip + title + close. Sticky to the
                panel top so it stays visible as the form scrolls. */}
            <div className="px-5 pt-5 pb-4 flex items-start justify-between gap-3 border-b border-white/8 flex-shrink-0">
              <div className="min-w-0">
                <div className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 border text-[0.6rem] font-medium ${theme.accentChip} mb-2`}>
                  {type === "belief" ? (
                    <Atom size={10} />
                  ) : type === "concept" ? (
                    <Sparkles size={10} />
                  ) : type === "tag" ? (
                    <Tag size={10} />
                  ) : type === "perspective" ? (
                    <StickyNote size={10} />
                  ) : (
                    <Brain size={10} />
                  )}
                  {theme.short}
                </div>
                <h2 className="text-base font-semibold text-white/95 tracking-tight">
                  {theme.title}
                </h2>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 rounded-md hover:bg-white/8 text-white/55 hover:text-white/95 transition-colors flex-shrink-0"
                aria-label="Close"
              >
                <X size={15} />
              </button>
            </div>

            {/* Scrollable form body — every neuron type renders the
                same five sections in the same order, so the panel
                feels purpose-built but consistent. The "Why" / "Story"
                / "Notes" textareas are all optional; the only required
                field is Title (and Story too for Perspectives, where
                the title alone wouldn't count as a real entry). */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              <p className="text-[0.78rem] text-white/65 leading-relaxed">
                {theme.description}
              </p>

              {/* 1. Title — primary text. The shape is always single-
                  line on the panel, even though the underlying
                  belief_text column accepts up to 200 chars (the
                  textarea would feel weirdly out-of-place when every
                  other type uses a single-line input). */}
              <NeuronFieldLabel label={titleCopy.label} hint={titleCopy.hint}>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  autoFocus
                  maxLength={titleCopy.maxLength}
                  placeholder={titleCopy.placeholder}
                  className="w-full bg-black/30 border border-white/15 rounded-lg px-3 py-2.5 text-[0.85rem] text-white/95 leading-snug placeholder:text-white/30 focus:outline-none focus:border-white/30"
                />
                <NeuronCharCount value={title} max={titleCopy.maxLength} />
              </NeuronFieldLabel>

              {/* 2. Why — rationale. Optional everywhere. For Beliefs
                  this maps to the existing `rationale` column; for
                  Facts + Concepts it goes into metadata.why. */}
              <NeuronFieldLabel
                label="Why are you adding this?"
                hint="Optional — gives the AI a hook for explaining itself when it leans on this neuron."
              >
                <textarea
                  value={why}
                  onChange={(e) => setWhy(e.target.value)}
                  rows={3}
                  maxLength={500}
                  placeholder="The reason this matters enough to remember…"
                  className="w-full bg-black/30 border border-white/15 rounded-lg px-3 py-2.5 text-[0.85rem] text-white/95 leading-snug placeholder:text-white/30 focus:outline-none focus:border-white/30 resize-none"
                />
                <NeuronCharCount value={why} max={500} />
              </NeuronFieldLabel>

              {/* 3. Connections — multi-select picker over every
                  existing node in the graph. We render a compact
                  search + chip grid; selected nodes get a check
                  icon and a highlighted background. The user can
                  also wire connections after the fact through the
                  bottom-right "+ → Link neurons" mode, so this
                  picker is purely a convenience. */}
              <div className="space-y-1.5">
                <p className="text-[0.7rem] font-medium text-white/75">
                  Connect to other neurons
                </p>
                <input
                  type="text"
                  value={connectionSearch}
                  onChange={(e) => setConnectionSearch(e.target.value)}
                  placeholder={
                    (existingNodes || []).length === 0
                      ? "No other neurons yet — connections come later."
                      : "Search by name…"
                  }
                  disabled={(existingNodes || []).length === 0}
                  className="w-full bg-black/30 border border-white/15 rounded-lg px-3 py-2 text-[0.78rem] text-white/95 placeholder:text-white/30 focus:outline-none focus:border-white/30 disabled:opacity-40 disabled:cursor-not-allowed"
                />
                {connectionCandidates.length > 0 ? (
                  <div className="max-h-44 overflow-y-auto rounded-lg border border-white/10 bg-black/20 divide-y divide-white/5">
                    {connectionCandidates.map((n) => {
                      const checked = selectedConnections.has(n.id);
                      return (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => toggleConnection(n.id)}
                          className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[0.74rem] transition-colors ${
                            checked
                              ? "bg-white/8 text-white/95"
                              : "text-white/70 hover:bg-white/5 hover:text-white/90"
                          }`}
                        >
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{
                              background: n.color || "#9ca3af",
                              boxShadow: `0 0 6px ${n.color || "#9ca3af"}80`,
                            }}
                          />
                          <span className="flex-1 truncate">{n.label}</span>
                          {checked ? (
                            <Check size={11} className="flex-shrink-0 text-white/85" />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {selectedConnections.size > 0 ? (
                  <p className="text-[0.62rem] text-white/45 leading-snug">
                    {selectedConnections.size} connection
                    {selectedConnections.size === 1 ? "" : "s"} will be wired
                    when you save.
                  </p>
                ) : (
                  <p className="text-[0.62rem] text-white/35 leading-snug">
                    Tap a neuron above to connect it. You can always wire more
                    later from the 3D scene.
                  </p>
                )}
              </div>

              {/* 4. Story — long-form body. Optional for every type
                  EXCEPT Perspectives, where the title alone isn't
                  enough — the story IS the perspective. */}
              <NeuronFieldLabel
                label={type === "perspective" ? "Story" : "Story (optional)"}
                hint={
                  type === "perspective"
                    ? "Tell it like you'd tell a friend. The AI uses this to ground replies in your real life."
                    : "Anything longer that fills out this neuron — context, examples, the back-story."
                }
              >
                <textarea
                  value={story}
                  onChange={(e) => setStory(e.target.value)}
                  rows={type === "perspective" ? 7 : 5}
                  maxLength={4000}
                  placeholder={
                    type === "perspective"
                      ? "In 2019, I spent six months perfecting a side project that never shipped…"
                      : "Context, examples, what led you to this…"
                  }
                  className="w-full bg-black/30 border border-white/15 rounded-lg px-3 py-2.5 text-[0.85rem] text-white/95 leading-relaxed placeholder:text-white/30 focus:outline-none focus:border-white/30 resize-none"
                />
                <NeuronCharCount value={story} max={4000} />
              </NeuronFieldLabel>

              {/* 5. Additional info — free-form notes. Anything that
                  doesn't fit the other slots: links, dates, side
                  references, "btw the AI should also know…". Lives
                  in metadata.notes so future surfaces can render it
                  in DetailPanel context. */}
              <NeuronFieldLabel
                label="Additional information"
                hint="Optional — links, dates, asides, anything else worth attaching."
              >
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder="Anything else…"
                  className="w-full bg-black/30 border border-white/15 rounded-lg px-3 py-2.5 text-[0.85rem] text-white/95 leading-snug placeholder:text-white/30 focus:outline-none focus:border-white/30 resize-none"
                />
                <NeuronCharCount value={notes} max={2000} />
              </NeuronFieldLabel>

              {error ? (
                <p className="text-[0.7rem] text-rose-300/85">{error}</p>
              ) : null}
            </div>

            {/* Footer — sticky save bar. Lives outside the scrollable
                body so it's always reachable; on a long story the
                user shouldn't have to scroll to find the button. */}
            <div className="px-5 py-4 border-t border-white/8 flex-shrink-0">
              <button
                onClick={submit}
                disabled={!canSubmit}
                style={{
                  background: `${theme.accentHex}26`,
                  borderColor: `${theme.accentHex}66`,
                  color: theme.accentHex,
                }}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-[0.82rem] font-semibold transition-colors hover:brightness-125 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {type === "tag"
                  ? "Save tag"
                  : type === "perspective"
                  ? "Save perspective"
                  : "Save neuron"}
              </button>
            </div>
          </>
        ) : (
          // Forming phase — the "watch it get created" moment.
          <div className="flex-1 flex items-center justify-center">
            <NeuronFormingVisual theme={theme} text={formedText} />
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// NeuronFormingVisual — replaces the form area when a neuron is forming.
// A pulsing colored sphere scales in from a point, settles, then fades
// out as the modal dismisses. Designed to be visible for ~1.4s — long
// enough that the formation reads as deliberate, short enough that it
// doesn't interrupt the user's flow.
// ---------------------------------------------------------------------------

function NeuronFormingVisual({
  theme,
  text,
}: {
  theme: typeof NEURON_TYPE_THEME[keyof typeof NEURON_TYPE_THEME];
  text: string;
}) {
  return (
    <div className="px-6 py-10 flex flex-col items-center gap-6">
      <div className="relative w-32 h-32 flex items-center justify-center">
        {/* Outer pulse ring */}
        <motion.div
          initial={{ scale: 0.2, opacity: 0 }}
          animate={{ scale: [0.2, 1.4, 1.6], opacity: [0, 0.6, 0] }}
          transition={{ duration: 1.4, ease: "easeOut" }}
          className={`absolute inset-0 rounded-full ${theme.accentGlow}`}
          style={{ background: `radial-gradient(circle, ${theme.accentHex}60 0%, transparent 60%)` }}
        />
        {/* Core sphere — settles into place */}
        <motion.div
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: [0, 1.15, 1], opacity: [0, 1, 1] }}
          transition={{ duration: 0.9, ease: "easeOut", times: [0, 0.6, 1] }}
          className="relative w-20 h-20 rounded-full"
          style={{
            background: `radial-gradient(circle at 35% 30%, ${theme.accentHex} 0%, ${theme.accentHex}80 60%, ${theme.accentHex}20 100%)`,
            boxShadow: `0 0 40px ${theme.accentHex}80, inset 0 0 20px ${theme.accentHex}40`,
          }}
        />
        {/* Inner pinpoint */}
        <motion.div
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: [0, 1, 0.8], opacity: [0, 1, 0.85] }}
          transition={{ duration: 0.7, ease: "easeOut", delay: 0.15 }}
          className="absolute w-3 h-3 rounded-full bg-white shadow-[0_0_18px_rgba(255,255,255,0.9)]"
        />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.55, duration: 0.4 }}
        className="text-center max-w-[18rem]"
      >
        <p className={`text-[0.62rem] font-semibold uppercase tracking-[0.2em] mb-1.5`} style={{ color: theme.accentHex }}>
          {theme.short}
        </p>
        <p className="text-[0.85rem] text-white/95 leading-snug">{text}</p>
      </motion.div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 1, 0] }}
        transition={{ duration: 1.2, delay: 0.3 }}
        className="text-[0.65rem] text-white/45"
      >
        Forming neuron…
      </motion.p>
    </div>
  );
}

export default function SynthesisLayer() {
  const { user } = useAuth();
  const { planId, loading: planLoading } = useUserPlan();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  // Phone-class viewports get a 2D fallback instead of the 3D scene. The
  // r3f canvas + Bloom postprocessing pipeline crashes on a non-trivial
  // slice of mobile WebGL contexts (iOS Safari low-power, certain Android
  // GPUs), bubbling a runtime error to RouteErrorBoundary that no amount
  // of "Clear Cache & Retry" recovers from. Mobile is a companion build
  // anyway (see MobileExperienceNotice — synthesis layer is desktop-first
  // by design), so we deliberately skip the heavy renderer there.
  const isMobile = useIsMobile();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // (Historical note: a `showWelcome` boolean used to gate the
  // typewriter WelcomePanel. The panel was replaced by the in-chat
  // load-in greeting and the boolean was permanently `false`, so it
  // and every `setShowWelcome(false)` no-op were removed alongside
  // the component itself. See the "Welcome panel (removed)" block
  // earlier in this file for the full rationale.)

  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  // Deep-link entry point used by the chat load-in greeting:
  //   ?focus=<node_id>      → select that node so the 3D scene flies
  //                           to it AND opens its node-specific
  //                           DetailPanel. Each update routes to its
  //                           own dedicated detail panel — there is
  //                           no longer a shared "what's new" pullout
  //                           on this page.
  //
  // The companion `?project=<id>` deep link (wired from the project
  // ToolCallPill in the chat) is handled in a separate effect further
  // down because it needs setters (`setFilterProjectId`,
  // `setSelectedProjectId`, `setLayoutMode`) that are declared below
  // this point — keeping them in one effect would trip the
  // use-before-declare lint and rely on TDZ ordering at runtime.
  //
  // Read once on mount via the current location; we don't keep these
  // params in the URL after handling them (router-replace) so refreshes
  // don't re-fire the same intent.
  const _routerLocation = useLocation();
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(_routerLocation.search);
    const focusId = params.get("focus");
    if (focusId) setSelectedId(focusId);
    // Legacy `?showUpdates=1` param: silently strip if any old links
    // are still in flight (cached emails, third-party copies of the
    // chat greeting). The panel it used to open no longer exists.
    // `?project=` is handled (and stripped) by the project deep-link
    // effect further down, so we don't touch it here.
    const legacyShowUpdates = params.has("showUpdates");
    if (focusId || legacyShowUpdates) {
      const cleaned = new URLSearchParams(_routerLocation.search);
      cleaned.delete("focus");
      cleaned.delete("showUpdates");
      const qs = cleaned.toString();
      const url = `${_routerLocation.pathname}${qs ? `?${qs}` : ""}${_routerLocation.hash || ""}`;
      window.history.replaceState({}, "", url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [dimensions, setDimensions] = useState({ w: 1200, h: 800 });
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("connections");
  const [filterTag, setFilterTag] = useState<string | null>(null);
  // Active project for the "By Project" filter. When non-null the
  // 3D scene receives a focusedSet of that project's member node
  // ids — members glow, non-members dim out. Cleared whenever the
  // user switches away from "project" layout mode (see the mode
  // dropdown's onClick).
  const [filterProjectId, setFilterProjectId] = useState<string | null>(null);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showTagMenu, setShowTagMenu] = useState(false);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  // Core Beliefs slide-out — the user-facing surface for the layer above
  // atomic facts (need → belief → rule → result). Lazy-mounts on first open.
  const [beliefWindowOpen, setBeliefWindowOpen] = useState(false);
  // The "+" toolbar menu — { Basic neuron, Core Belief neuron }. Tap a
  // type and the menu closes; a centered creation modal takes over.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // Which neuron creation modal (if any) is currently open. Single source
  // of truth — only one modal at a time, and the backdrop dimming is
  // implicit in this state.
  const [creatingNeuronType, setCreatingNeuronType] = useState<"basic" | "belief" | "concept" | "tag" | "perspective" | null>(null);
  // Linking mode — when active, clicking nodes toggles them in the
  // `linkSelection` set instead of opening their detail panel. The
  // user confirms with the floating action bar (bottom-center) which
  // upserts a row per pair into `lykn_user_links` (signed-in) or
  // localStorage (guests). Used to manually wire neurons together
  // that the inference passes (concept_links, belief→fact provenance,
  // tag→note, theme→note) didn't catch on their own.
  const [linkingMode, setLinkingMode] = useState(false);
  const [linkSelection, setLinkSelection] = useState<Set<string>>(new Set());
  // Optional label the user types alongside the link ("supports",
  // "contradicts", "reminds me of", …). Stays free-text — a future
  // pass may promote common labels to an enum.
  const [linkLabel, setLinkLabel] = useState("");
  // Flips to true while the upsert is in flight so the action bar's
  // "Connect" button can show a spinner + disable itself, matching
  // the same pattern the neuron creation modal uses.
  const [linkSubmitting, setLinkSubmitting] = useState(false);

  // Project-cluster mode — sister flow to linking. Same selection
  // mechanic (tap nodes in the 3D scene to add/remove from a Set),
  // but instead of upserting pairwise edges into `lykn_user_links`
  // we bind the whole selection to a NAMED project in
  // `lykn_projects` + `lykn_project_neurons`. The point is that the
  // same project row is what outside AI clients (Claude Desktop /
  // Cursor / Claude Code) read via lykn_listProjects /
  // lykn_getContextBlock — clustering here makes the project
  // visible to the AI for free, alongside whatever working state
  // those clients have been pushing into it.
  const [projectMode, setProjectMode] = useState(false);
  const [projectSelection, setProjectSelection] = useState<Set<string>>(new Set());
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectSubmitting, setProjectSubmitting] = useState(false);
  // When set, the project-cluster mode is in "add to existing"
  // form rather than "create new" — `commitProject` appends the
  // selected neurons onto the targeted project instead of
  // spawning one. Driven from the ProjectPanel's "Add neurons"
  // button. Cleared on cancel or commit so the next entry into
  // the mode defaults back to create.
  const [projectAddTargetId, setProjectAddTargetId] = useState<string | null>(null);
  // Free-text query that filters the addable-neurons list
  // rendered inside the project-mode action bar. Lets the user
  // pick neurons by typing instead of having to find them in
  // the 3D scene — invaluable once the brain accumulates a few
  // hundred nodes. Cleared whenever we enter or exit project
  // mode so a stale query doesn't ghost across sessions.
  const [projectSearchQuery, setProjectSearchQuery] = useState("");
  const [projectKindFilter, setProjectKindFilter] = useState<ProjectKindFilter>("all");

  // Project side-panel selection. Independent of `filterProjectId`
  // (which drives the scene's focus-glow) because the user might
  // want to keep a focus filter active while peeking at a different
  // project's panel — or close the panel without dropping the
  // filter. The two are wired together in the dropdown click
  // handler below as a convenience: tapping a project there both
  // sets the filter AND opens the panel, since that's the single
  // spot where the user is most clearly saying "let me dig into
  // this project."
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  // Deep-link entry point used by the project ToolCallPill in the chat:
  //   ?project=<project_id> → open that project's side panel AND flip
  //                           the scene into "By Project" focus mode
  //                           pinned to it, so the user immediately
  //                           sees which neurons are clustered into
  //                           the project the AI was just talking
  //                           about (lit-up members glowing against
  //                           the dimmed full graph). Mirrors the
  //                           triple-action the "By Project" dropdown
  //                           fires when the user picks a project
  //                           there. See projectDeepLink() in
  //                           ToolCallPill.tsx for the producer side.
  //
  // Read once on mount and stripped from the URL afterwards so a
  // refresh doesn't re-pop the panel against the user's wishes. We
  // intentionally don't validate the id against userProjects here —
  // by the time the chat-side tool returned `result.project.id` the
  // row existed; and even if the user deletes the project before
  // clicking the pill, setSelectedProjectId resolves to no `project`
  // (the lookup at line ~5783 returns null) and the panel just
  // doesn't render. Cheap and self-healing.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(_routerLocation.search);
    const projectId = params.get("project");
    if (!projectId) return;
    setFilterProjectId(projectId);
    setSelectedProjectId(projectId);
    setLayoutMode("project");
    const cleaned = new URLSearchParams(_routerLocation.search);
    cleaned.delete("project");
    const qs = cleaned.toString();
    const url = `${_routerLocation.pathname}${qs ? `?${qs}` : ""}${_routerLocation.hash || ""}`;
    window.history.replaceState({}, "", url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Legacy per-type pending-forming states were consolidated into the
  // generic `pendingFormingNodeId` further down (search this file for
  // its declaration). Modal saves and any other create paths now
  // compute the full graph node id at the call site and queue it
  // there directly, so we no longer need fact / belief specific state.
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const tagMenuRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const measure = () => {
      if (containerRef.current) {
        setDimensions({ w: containerRef.current.clientWidth, h: containerRef.current.clientHeight });
      }
    };
    // Resize fires dozens of times during a drag — each setDimensions
    // re-runs the O(n² × 100) `simulateLayout` memo and re-mounts every
    // 3D node prop. Debouncing to a single trailing update collapses
    // the burst to one layout pass once the user stops resizing.
    measure();
    let raf = 0;
    let timer: number | undefined;
    const onResize = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(measure);
      }, 150);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (timer) window.clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // ------------------------------------------------------------------
  // Supabase Realtime — live graph updates across AI clients.
  // ------------------------------------------------------------------
  // The 3D graph is fed by six React Query hooks below. Without this
  // effect the graph is static-on-load + invalidation-driven by LOCAL
  // mutations only, so a belief Cursor pushes via MCP from another
  // tool wouldn't appear until the user reloads. We don't patch the
  // graph directly — we just invalidate the relevant query keys, the
  // hooks refetch, and the buildGraph useMemo rebuilds. Cheap and
  // reuses every existing code path.
  //
  // Subscriptions:
  //   • lykn_user_model_facts INSERT/UPDATE/DELETE → fact node lifecycle
  //   • lykn_beliefs INSERT/UPDATE/DELETE          → belief node lifecycle
  //
  // Filters: both are scoped server-side to user_id=eq.<uid>. The
  // `supabase_realtime` publication enrolment + REPLICA IDENTITY FULL
  // are set up in migration 048; without those, filtered UPDATE events
  // silently drop. RLS SELECT policies on every table key off auth.uid()
  // = user_id, so even without the filter Realtime would refuse to
  // deliver other users' rows — the filter is a belt-and-suspenders
  // bandwidth optimisation, not the security boundary.
  //
  // Channel cleanup on unmount AND on user change so a sign-out doesn't
  // leak a subscription bound to the prior user_id filter.
  useEffect(() => {
    if (!user?.id) return;
    const uid = user.id;

    // Coalesce bursty realtime events into a single trailing-edge
    // invalidation pass. A typical MCP "push five facts and promote
    // one belief" burst used to fire 3 invalidations per fact + 1 per
    // belief in rapid succession — each one triggering a full graph
    // rebuild + force-simulation pass. Debouncing to 300ms collapses
    // the burst into one rebuild while keeping the perceived latency
    // imperceptible for human-driven mutations.
    const pendingKeys = new Set<string>();
    let flushTimer: number | undefined;
    const KEY_MAP: Record<string, unknown[]> = {
      facts: ["mindmap_manual_facts", uid],
      profile: ["mindmap_synthesis_profile", uid],
      chunks: ["mindmap_synthesis_chunks", uid],
      beliefs: ["mindmap_active_beliefs", uid],
      // Vault/Perspective notes — kept fresh so when the user deletes
      // a note from /vault (hard `.delete()` on the row) or saves a
      // new one (chat → Vault, share receiver, MCP push, …) the
      // synthesis layer's brain reflects it without a manual refresh.
      // Also covers the synthesis chunks since vault edits typically
      // re-chunk the note.
      notes: ["mindmap_vault_graph", uid],
      boards: ["mindmap_boards", uid],
      projects: ["lykn_projects", uid],
      project_state: ["lykn_project_state", uid],
    };
    const schedule = (...keys: string[]) => {
      for (const k of keys) pendingKeys.add(k);
      if (flushTimer) return;
      flushTimer = window.setTimeout(() => {
        flushTimer = undefined;
        for (const k of pendingKeys) {
          const key = KEY_MAP[k];
          if (key) queryClient.invalidateQueries({ queryKey: key });
        }
        pendingKeys.clear();
      }, 300);
    };

    const channel = supabase
      .channel(`synthesis-live:${uid}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lykn_user_model_facts", filter: `user_id=eq.${uid}` },
        () => {
          // Synthesis profile + chunks roll fact-derived themes/topics
          // into the AI Learned cluster — invalidate them too so the
          // graph picks up the new neuron alongside the raw fact.
          schedule("facts", "profile", "chunks");
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lykn_beliefs", filter: `user_id=eq.${uid}` },
        () => {
          schedule("beliefs");
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notes", filter: `user_id=eq.${uid}` },
        () => {
          // Any change to `notes` invalidates the mindmap notes query
          // so the Vault cluster, Perspectives cluster (notes carrying
          // `_perspective`), tag cluster, and rollup nodes all rebuild
          // off the fresh row set. Deletes are the headline case —
          // removing a note from /vault must remove its neuron here.
          // Chunks travel alongside since vault content typically gets
          // re-chunked on edit. We don't refresh `profile` here: the
          // synthesis profile rebuild is a heavier downstream pass and
          // its own subscription path already covers it.
          schedule("notes", "chunks");
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "omnia_boards", filter: `user_id=eq.${uid}` },
        () => {
          // Chats deleted from /app or renamed should likewise flow
          // through to the Chats cluster without a manual refresh.
          schedule("boards");
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lykn_projects", filter: `user_id=eq.${uid}` },
        () => {
          schedule("projects");
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lykn_project_neurons", filter: `user_id=eq.${uid}` },
        () => {
          schedule("projects");
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lykn_project_state", filter: `user_id=eq.${uid}` },
        () => {
          // AI pushes (MCP + in-LYKN chat) land here — refresh the
          // project panel Updates section + push counts on the graph.
          schedule("projects", "project_state");
        },
      )
      .subscribe();

    const onProjectsChanged = (evt: Event) => {
      const detail = (evt as CustomEvent<{ userId?: string | null }>).detail;
      if (detail?.userId && detail.userId !== uid) return;
      schedule("projects", "project_state");
    };
    window.addEventListener(PROJECTS_CHANGED_EVENT, onProjectsChanged);

    return () => {
      if (flushTimer) window.clearTimeout(flushTimer);
      window.removeEventListener(PROJECTS_CHANGED_EVENT, onProjectsChanged);
      void supabase.removeChannel(channel);
    };
  }, [user?.id, queryClient]);

  /* Data queries */
  const { data: boards = [], isFetched: boardsFetched } = useQuery({
    queryKey: ["mindmap_boards", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      // `project_id` is no longer projected — the synthesis-layer graph
      // dropped the Projects category, so this column would just be dead
      // payload on every mount. The DB column itself is still populated
      // (other surfaces — chat scoping, /api/v1/synthesis/activity —
      // continue to use it), it just doesn't ride along on this fetch.
      return fetchBoardsWithContext(user.id, 80);
    },
    enabled: !!user?.id,
    staleTime: 60_000,
  });

  const { data: vaultGraph = { notes: [], connectorRollups: [] }, isFetched: notesFetched } = useQuery({
    queryKey: ["mindmap_vault_graph", user?.id],
    queryFn: async () => {
      if (!user?.id) return { notes: [] as MindmapNoteRow[], connectorRollups: [] as ConnectorRollupSummary[] };
      const data = await fetchMindmapVaultGraphData(user.id);
      return {
        notes: await hydrateMindmapNoteContent(user.id, data.notes),
        connectorRollups: data.connectorRollups,
      };
    },
    enabled: !!user?.id,
    staleTime: 60_000,
  });
  const notes = vaultGraph.notes;
  const connectorRollups = vaultGraph.connectorRollups;

  const { data: synthesisProfile, isFetched: profileFetched } = useQuery({
    queryKey: ["mindmap_synthesis_profile", user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data } = await supabase.from("lykn_user_synthesis_profile").select("themes, signals, narrative").eq("user_id", user.id).maybeSingle();
      return data;
    },
    enabled: !!user?.id,
    staleTime: 120_000,
  });

  const { data: synthesisChunks = [], isFetched: chunksFetched } = useQuery({
    queryKey: ["mindmap_synthesis_chunks", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data } = await supabase
        .from("lykn_synthesis_chunks")
        .select("source_type, source_id, content")
        .eq("user_id", user.id)
        .in("source_type", ["vault_note", "grid_board"])
        .eq("chunk_index", 0)
        .limit(300);
      return (data || []) as ChunkRow[];
    },
    enabled: !!user?.id,
    staleTime: 60_000,
  });

  // Active beliefs (Hyrum-Smith belief-window layer). Rendered as their own
  // category cluster in the 3D scene so the user can see the principles the
  // AI is currently answering through. The detailed Accept/Edit/Retire
  // affordances live in BeliefWindowPanel — this query just feeds the graph.
  const { data: activeBeliefs = [] } = useQuery({
    // Query key intentionally does NOT include `beliefWindowOpen` —
    // toggling the panel open/closed used to bust the cache and refetch
    // every belief on every open. The realtime subscription above
    // invalidates this key whenever the actual data changes, so the
    // open/close state has no business in here.
    queryKey: ["mindmap_active_beliefs", user?.id],
    queryFn: async () => {
      if (!user?.id) return [] as Array<{
        id: string; belief_text: string; serves_need: string; confidence: number;
      }>;
      // Pull both active and proposed beliefs so the chat load-in
      // greeting's "Awaiting your approval" bubbles can deep-link
      // into the DetailPanel for a brand-new (still-proposed)
      // belief via `?focus=belief_<id>` — without this, the focused
      // node wouldn't exist in the graph and the pullout wouldn't
      // open. The detail panel's existing approval UI takes over
      // from there. Active beliefs are surfaced first so they still
      // dominate the visual cluster.
      const { data } = await supabase
        .from("lykn_beliefs")
        .select("id, belief_text, serves_need, confidence, status, rationale, source, created_at")
        .eq("user_id", user.id)
        .in("status", ["active", "proposed"])
        .order("status", { ascending: true }) // 'active' < 'proposed' lexically
        .order("confidence", { ascending: false })
        .limit(60);
      return (data || []) as Array<{
        id: string; belief_text: string; serves_need: string; confidence: number;
        status?: string; rationale?: string | null; source?: string | null; created_at?: string;
      }>;
    },
    enabled: !!user?.id,
    staleTime: 60_000,
  });

  // User-stated and user-confirmed atomic facts. We render these as their
  // own neuron nodes so a freshly-saved "Basic neuron" appears in the graph
  // immediately. The synthesis profile's themes/signals lag behind by a
  // background rebuild — without this query, hitting Save in the basic-
  // neuron modal would persist the row but show no visible node, making
  // the save look broken even though the data landed correctly. We
  // deliberately scope to status IN ('stated','confirmed') so we only
  // surface things the user explicitly authored or thumbs-upped, not the
  // long tail of low-confidence inferred facts (those still flow through
  // the normal synthesis profile when it next rebuilds).
  const { data: manualFacts = [] } = useQuery({
    queryKey: ["mindmap_manual_facts", user?.id],
    queryFn: async () => {
      if (!user?.id) return [] as Array<{
        id: string; fact_kind: string; fact_text: string; status: string; confidence: number;
      }>;
      // Include every non-dismissed fact so the chat load-in
      // greeting's "New neurons" bubble can deep-link via
      // `?focus=fact_<id>` even for facts that are still in
      // 'inferred' or 'unconfirmed' status. We keep the
      // stated/confirmed ones at the top for visual prominence;
      // the rest still appear so the DetailPanel can render them.
      const { data } = await supabase
        .from("lykn_user_model_facts")
        .select("id, fact_kind, fact_text, status, confidence, first_seen_at, last_seen_at")
        .eq("user_id", user.id)
        .neq("status", "dismissed")
        .order("status", { ascending: true })
        .order("last_seen_at", { ascending: false })
        .limit(120);
      return (data || []) as Array<{
        id: string; fact_kind: string; fact_text: string; status: string; confidence: number;
        first_seen_at?: string; last_seen_at?: string;
      }>;
    },
    enabled: !!user?.id,
    staleTime: 60_000,
  });

  // Belief → fact → source provenance for the active/proposed beliefs in
  // view. Powers the cross-cluster edges that turn the 3D mind from
  // four parallel clusters around a root into a visibly-interconnected
  // web: belief→fact (from `promoted_from_facts`) and fact→vault/grid
  // (from `lykn_user_model_facts.evidence[]`). The same RPC is shared
  // with the connector tile footers and the load-in briefing chips so
  // the three surfaces tell exactly the same provenance story.
  //
  // We refetch alongside `activeBeliefs` because a newly-promoted
  // belief or newly-cited fact should light up edges within the same
  // realtime update tick.
  const beliefIdsKey = useMemo(
    () => activeBeliefs.map((b) => b.id).sort().join(","),
    [activeBeliefs],
  );
  const { data: beliefProvenanceRows = [] } = useQuery({
    queryKey: ["mindmap_belief_provenance", user?.id, beliefIdsKey],
    queryFn: async () => {
      if (!user?.id || activeBeliefs.length === 0) {
        return [] as Array<{
          belief_id: string; fact_id: string; source_type: string; source_id: string;
        }>;
      }
      const { data, error } = await supabase.rpc("get_belief_provenance", {
        belief_ids: activeBeliefs.map((b) => b.id),
      });
      if (error) return [];
      return (data || []) as Array<{
        belief_id: string; fact_id: string; fact_text: string;
        source_type: string; source_id: string; source_label: string | null;
        source_connector: string | null; observed_at: string | null;
      }>;
    },
    enabled: !!user?.id && activeBeliefs.length > 0,
  });

  // Group rows by belief_id so buildGraph can walk one belief at a time.
  // Map<belief_id, Array<{ factId, sourceType, sourceId }>>
  const beliefProvenance = useMemo(() => {
    const m = new Map<string, Array<{ factId: string; sourceType: string; sourceId: string }>>();
    for (const row of beliefProvenanceRows) {
      if (!row?.belief_id || !row?.fact_id) continue;
      const arr = m.get(row.belief_id) || [];
      arr.push({
        factId: row.fact_id,
        sourceType: row.source_type || "",
        sourceId: row.source_id || "",
      });
      m.set(row.belief_id, arr);
    }
    return m;
  }, [beliefProvenanceRows]);

  // ---- Concepts (stage-2 topic layer) -----------------------------
  // First-class concept nodes via the concepts_overview RPC (058).
  // Each row carries note/fact/belief/chat counts so the graph can
  // size and filter them in one pass without a second round-trip.
  // We pull them eagerly alongside beliefs because concepts are the
  // cross-cutting glue between everything else in the graph — a
  // late fetch would cause the orange cluster to pop in after the
  // initial layout had already settled.
  const { data: conceptRows = [] } = useQuery({
    queryKey: ["mindmap_concepts", user?.id],
    queryFn: async () => {
      if (!user?.id) {
        return [] as Array<{
          concept_id: string; label: string; kind: string; source: string;
          status: string; confidence: number;
          note_count: number; fact_count: number; belief_count: number; chat_count: number;
          last_touched_at: string | null;
        }>;
      }
      const { data, error } = await supabase.rpc("concepts_overview");
      if (error) return [];
      return (data || []) as Array<{
        concept_id: string; label: string; slug: string; kind: string; source: string;
        status: string; confidence: number;
        note_count: number; fact_count: number; belief_count: number; chat_count: number;
        last_touched_at: string | null; created_at: string;
      }>;
    },
    enabled: !!user?.id,
  });

  // Concept links — single batched RPC (`concept_links_for_user`,
  // migration 061) that returns every (concept_id, target_kind,
  // target_id) tuple across the top-N most-recently-touched live
  // concepts the user owns. Replaces the previous fan-out that issued
  // 30 individual `concept_links(p_concept_id)` RPCs in 5 sequential
  // round-trips per page mount.
  //
  // The cap (default 30 on the server) is the same as the old client-
  // side `.slice(0, 30)`, so the visible concept set is identical;
  // only the network shape changed. `liveConceptCount` is folded into
  // the query key so the RPC is re-fired when concepts are added or
  // dismissed — server-side ordering is by `last_touched_at` so a
  // single concept gaining a new link bumps it to the top organically
  // without us tracking individual ids in the client.
  const liveConceptCount = useMemo(
    () => conceptRows.filter((c) => c.status !== "dismissed").length,
    [conceptRows],
  );
  const { data: conceptLinkRows = [] } = useQuery({
    queryKey: ["mindmap_concept_links_for_user", user?.id, liveConceptCount],
    queryFn: async () => {
      if (!user?.id || liveConceptCount === 0) {
        return [] as Array<{ concept_id: string; target_kind: string; target_id: string }>;
      }
      const { data, error } = await supabase.rpc("concept_links_for_user", { p_limit: 30 });
      if (error) return [];
      return (data || []) as Array<{ concept_id: string; target_kind: string; target_id: string }>;
    },
    enabled: !!user?.id && liveConceptCount > 0,
  });

  // Map<concept_id, Array<{kind, targetId}>> for buildGraph.
  const conceptLinks = useMemo(() => {
    const m = new Map<string, Array<{ kind: "note" | "fact" | "belief" | "chat"; targetId: string }>>();
    for (const row of conceptLinkRows) {
      const k = row.target_kind;
      if (k !== "note" && k !== "fact" && k !== "belief" && k !== "chat") continue;
      const arr = m.get(row.concept_id) || [];
      arr.push({ kind: k, targetId: row.target_id });
      m.set(row.concept_id, arr);
    }
    return m;
  }, [conceptLinkRows]);

  // User-authored cross-neuron links (migration 062). Read via the
  // userLinks lib which falls back to localStorage when the migration
  // hasn't been applied yet OR when the visitor is a guest. We don't
  // gate `enabled` on `user?.id` because the guest path is a legit
  // localStorage read; the lib handles the auth branching internally.
  const { data: userLinks = [] } = useQuery<UserLink[]>({
    queryKey: ["mindmap_user_links", user?.id || "guest"],
    queryFn: () => listUserLinks(user?.id),
    // Cross-device sync isn't time-sensitive — refetch on focus is
    // enough; we don't need realtime here because the writer (this
    // same page) calls invalidateQueries directly.
    staleTime: 60 * 1000,
  });

  // User-clustered projects (migration 045 + 063). Same persistence
  // shape as userLinks above — Supabase first, with localStorage
  // fallback for guests / pre-migration deployments. The "By
  // Project" filter dropdown lists these and applies the picked
  // project's member node ids as the scene's `focusedSet`, making
  // only those neurons glow against the dimmed full graph.
  const { data: userProjects = [] } = useQuery<UserProject[]>({
    queryKey: ["lykn_projects", user?.id || "guest"],
    queryFn: () => listUserProjects(user?.id),
    staleTime: 60 * 1000,
  });

  // Stable empty-map for guests (and any signed-in user with no chunks
  // yet) — without this, a fresh `synthesisChunks` array reference on each
  // render would make buildVaultGridMap return a fresh `new Map()` every
  // render, invalidating the downstream graph + layout memos and jittering
  // the force simulation.
  const vaultGridMap = useMemo(
    () => (synthesisChunks.length === 0 ? EMPTY_VAULT_GRID_MAP : buildVaultGridMap(synthesisChunks)),
    [synthesisChunks],
  );

  const allQueriesFetched =
    boardsFetched && notesFetched && profileFetched && chunksFetched;

  const synthesisData: SynthesisData | null = useMemo(() => {
    if (!synthesisProfile) return null;
    return {
      themes: Array.isArray(synthesisProfile.themes) ? synthesisProfile.themes : [],
      narrative: synthesisProfile.narrative || "",
      signals: (synthesisProfile.signals && typeof synthesisProfile.signals === "object") ? synthesisProfile.signals as Record<string, any> : {},
    };
  }, [synthesisProfile]);

  const synthesisThemes: string[] = useMemo(() => {
    const t: string[] = [];
    if (synthesisData?.themes) t.push(...synthesisData.themes);
    if (synthesisData?.signals?.recurring_topics) t.push(...synthesisData.signals.recurring_topics);
    return [...new Set(t.map((s: string) => s.toLowerCase().trim()))].filter(Boolean);
  }, [synthesisData]);

  // Force-render the empty top-level containers. The five top-level
  // categories — Chats, Vault, Belief, Facts, Concepts — are the
  // permanent shape of the brain. They're the same five landmarks
  // the tour welcome card names, so they should be visible regardless
  // of whether the user has any data inside them.
  //
  // This matters for two specific UX failures we used to hit:
  //   • Brand-new signed-in user with an empty Vault — the green
  //     Vault landmark wouldn't appear until they saved their first
  //     note, making the brain feel skeletal on day one.
  //   • Existing user deletes every Vault note (or every Fact, every
  //     Concept, …) — the entire category cluster would silently
  //     disappear, taking with it the affordance to ever add another
  //     one. "I deleted one thing and my whole Vault category vanished"
  //     was the surfaced complaint that motivated forcing these.
  //
  // The behaviour is identical across guest / prototype-handoff /
  // signed-in. The forceCategoryIds set is just the canonical 5
  // every time; buildGraph still skips the per-item rendering when
  // there's no underlying data, so an empty Vault renders as the
  // landmark sphere only (no child note dots), which is exactly what
  // we want — the shape persists, the contents come and go.
  const forceCategoryIds = useMemo(
    () => new Set<string>([
      "__cat_grids__",
      "__cat_vault__",
      "__cat_belief__",
      "__cat_facts__",
      "__cat_concepts__",
      // Projects is part of the canonical top-level shape now — keep
      // the landmark visible even when the user has zero projects so
      // they always know where to find their AI-clustered work.
      "__cat_projects__",
    ]),
    [],
  );

  /* Build + simulate */
  const { nodes: allNodes, edges, noteIdToVaultNodeId } = useMemo(
    () => {
      const built = buildGraph(boards, notes, synthesisThemes, synthesisData, vaultGridMap, activeBeliefs, manualFacts, beliefProvenance, conceptRows, conceptLinks, forceCategoryIds, "Your Mind", userProjects, connectorRollups);
      // User-authored manual links (migration 062). Injected here at
      // the end of the build pass so they layer on TOP of every
      // inferred edge (concept_links, belief→fact provenance,
      // tag→note, theme→note). Each row in `userLinks` already came
      // out of the lib with the pair normalized to (from < to), so
      // we don't need to re-normalize here — but we DO filter pairs
      // that target nodes the current graph doesn't contain (the
      // user may have linked to a node that's been deleted, or one
      // truncated by a query LIMIT). The layout engine would otherwise
      // happily try to route an edge to a non-existent endpoint and
      // crash the force simulation on the first tick.
      const nodeIdSet = new Set(built.nodes.map((n) => n.id));
      // Project name set used to disambiguate legacy rows whose
      // `source` column was stamped 'user' before the project-
      // cluster auto-link path learned to pass its own source
      // string. Those rows have the project name as their
      // label, so a label match is a reliable secondary signal:
      // the link came from a project commit even if the column
      // doesn't say so. Lowercased + trimmed so casing/whitespace
      // edits to the project name don't break the heuristic.
      const projectLabelSet = new Set(
        userProjects
          .map((p) => p.name.toLowerCase().trim())
          .filter((s) => s.length > 0),
      );
      for (const ul of userLinks) {
        if (!nodeIdSet.has(ul.fromNodeId) || !nodeIdSet.has(ul.toNodeId)) continue;
        // Only flag the explicit "Link neurons" verb's edges as
        // userLink — those get the distinct accent treatment
        // because the user deliberately wired them. Project
        // auto-links ride the same `lykn_user_links` table for
        // storage idempotency, but visually they should read as
        // ordinary cross-edges when the project filter ISN'T
        // active. Two signals classify a link as
        // project-spawned:
        //   1. `source = 'project_cluster'` — the column the
        //      auto-link writer stamps explicitly.
        //   2. label matches a project name — covers legacy
        //      rows committed before the source column was
        //      threaded through, AND any future writers that
        //      forget to pass source but DO label correctly.
        const labelKey = (ul.label || "").toLowerCase().trim();
        const isProjectClusterLink =
          (ul.source && ul.source !== "user") ||
          (labelKey.length > 0 && projectLabelSet.has(labelKey));
        // Edge shape per source:
        //   • Explicit user links → cross + userLink: solid
        //     bright sky-blue at 0.78 opacity. Stand-out
        //     accent because the user deliberately wired
        //     this pair.
        //   • Project-cluster links → NOT cross, NOT
        //     userLink: solid slate-gray at 0.40 opacity,
        //     same as a structural edge. Visible and tidy
        //     without competing with the explicit-link
        //     accent. We keep them out of the cross-edge
        //     bucket on purpose — cross edges render
        //     dashed at 0.20 opacity (the "inferred" look),
        //     which made the project mesh look like it
        //     wasn't connecting anything at all.
        //   • Everything else (heuristic cross-edges) →
        //     cross only: dashed slate-gray as before.
        built.edges.push({
          from: ul.fromNodeId,
          to: ul.toNodeId,
          cross: !isProjectClusterLink,
          userLink: !isProjectClusterLink,
        });
      }
      return built;
    },
    [boards, notes, synthesisThemes, synthesisData, vaultGridMap, activeBeliefs, manualFacts, beliefProvenance, conceptRows, conceptLinks, forceCategoryIds, userLinks, userProjects, connectorRollups],
  );
  const nodeMap = useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes]);

  // Stable resolver passed down to DetailPanel + ConceptDetailSection so
  // concept_links / belief provenance rows that target a `notes.id`
  // navigate to the correct graph node — either the per-note vault
  // node (manual saves) or the connector-source rollup (Gmail / Slack
  // / Notion / …). Closes over the latest mapping from buildGraph;
  // re-derives only when the graph rebuilds.
  const vaultNodeIdFor = useCallback(
    (noteId: string): string => noteIdToVaultNodeId.get(noteId) || `vault_${noteId}`,
    [noteIdToVaultNodeId],
  );

  // Stable derived arrays for downstream props. Without these, every
  // parent re-render (hover, zoom, panel toggle, …) creates fresh array
  // references that defeat React.memo on heavy children and force a
  // reconciliation of the entire 3D scene's prop tree.
  const neuronLabels = useMemo(
    () => allNodes.filter((n) => n.kind === "neuron").map((n) => n.label),
    [allNodes],
  );
  // Trimmed projection of concept rows for the DetailPanel merge picker.
  // Built once per conceptRows change so re-renders driven by hover /
  // camera / dropdown toggles don't hand the panel a fresh array.
  const allConceptsForPanel = useMemo(
    () => conceptRows.map((c) => ({
      concept_id: c.concept_id,
      label: c.label,
      status: c.status,
    })),
    [conceptRows],
  );

  // Count only the EXPLICIT neurons the user actually created themselves:
  // chats (grids), vault notes, perspectives, beliefs the user ratified
  // (status='active'), and manual facts they typed into the Fact composer
  // (`source: 'manual_fact'` in buildGraph).
  //
  // Everything AI-generated is intentionally free and does not count:
  //   • concepts (lykn_concepts, mostly ai_clustered by the nightly job)
  //   • neuron-style nodes derived from the synthesis profile
  //     (themes / goals / recurring_topics / reasoning_style / vocabulary)
  //   • inferred facts the model wrote before the user touched them
  //   • proposed beliefs awaiting ratification
  //
  // This matches the server-side cap (066_synthesis_neuron_cap_trigger.sql):
  // free users get the full synthesis layer up to FREE_SYNTHESIS_NODE_LIMIT
  // explicit neurons before the page swaps in the upgrade paywall, so the
  // nightly synthesis job piling on inferred facts / clustered concepts
  // never trips the gate by itself.
  const userCreatedNodeCount = useMemo(
    () =>
      allNodes.filter((n) => {
        // Always exclude scaffolding.
        if (n.kind === "root" || n.kind === "category") return false;
        // AI-clustered topic layer — never counts.
        if (n.kind === "concept") return false;
        // Beliefs only count once the user has ratified them. AI-proposed
        // beliefs sitting in the inbox don't push someone over the cap.
        if (n.kind === "belief") {
          const status = String(n.meta?.beliefStatus || "");
          return status === "active";
        }
        // The `neuron` kind covers both AI-derived profile bits (themes,
        // goals, recurring topics, vocabulary, reasoning style) and the
        // user's hand-typed facts. Only the manual ones count — that's
        // what `source: 'manual_fact'` is set to in the buildGraph fact
        // pass. Every AI-derived neuron carries one of the synthesis
        // source slugs and is exempt.
        if (n.kind === "neuron") {
          return String(n.meta?.source || "") === "manual_fact";
        }
        // grid, vault, perspective — explicit user creations, always count.
        return true;
      }).length,
    [allNodes],
  );

  // Free tier gets the full Synthesis Layer experience up to
  // FREE_SYNTHESIS_NODE_LIMIT explicit user-created neurons. Once they
  // cross it the page swaps in the standard PlanGate paywall instead of
  // the canvas. Guests bypass this entirely so the demo / prototype-
  // handoff scenes can still run, and we wait for the plan query to
  // resolve before gating to avoid a paywall flash for paying users.
  const overFreeSynthesisLimit =
    !planLoading &&
    !!user?.id &&
    planId === "free" &&
    Number.isFinite(FREE_SYNTHESIS_NODE_LIMIT) &&
    userCreatedNodeCount > FREE_SYNTHESIS_NODE_LIMIT;

  /* Collect all ideas: synthesis themes + note ai_signals themes + tags */
  const allIdeas = useMemo(() => {
    const s = new Set<string>();
    synthesisThemes.forEach((t) => s.add(t));
    notes.forEach((n) => {
      (n.tags || []).forEach((t: string) => s.add(t.toLowerCase().trim()));
      extractNoteThemes(n).forEach((t) => s.add(t));
    });
    return Array.from(s).sort();
  }, [notes, synthesisThemes]);

  // ----------------------------------------------------------------
  // simNodes: laid-out positions for every graph node. Computed in a
  // Web Worker (`./synthesis/layoutWorker`) so the O(n² × iterations)
  // force simulation never blocks the main thread. The worker reply
  // pattern is monotonic-jobId: every dependency change mints a new
  // job id, and only the latest job's response commits to state. Any
  // older response (the user changed `filterTag` mid-flight) is
  // dropped on the floor.
  //
  // First-paint behaviour: while the worker is still computing the
  // initial layout, `simNodes` is an empty array → the scene renders
  // no nodes (and the lazy-load Suspense boundary that wraps the
  // scene already shows the dark canvas chrome). Typical worker
  // latency for a 300-node graph is well under 100ms.
  //
  // Same-tab fallback: in environments without `Worker` support
  // (older test runners, SSR, edge cases) the worker constructor
  // throws and we fall back to running `simulateLayout` synchronously
  // on the main thread — same code path as before this refactor.
  const [simNodes, setSimNodes] = useState<SimNode[]>([]);
  const layoutWorkerRef = useRef<Worker | null>(null);
  const layoutJobIdRef = useRef(0);
  useEffect(() => {
    try {
      const w = new LayoutWorker();
      layoutWorkerRef.current = w;
      const onMessage = (event: MessageEvent<LayoutResponse>) => {
        const msg = event.data;
        if (!msg || msg.type !== "layout") return;
        if (msg.jobId !== layoutJobIdRef.current) return;
        setSimNodes(msg.simNodes);
      };
      w.addEventListener("message", onMessage);
      return () => {
        w.removeEventListener("message", onMessage);
        w.terminate();
        layoutWorkerRef.current = null;
      };
    } catch {
      // No Worker support — leave ref null; the per-input effect
      // below detects this and runs `simulateLayout` synchronously.
      return undefined;
    }
  }, []);
  useEffect(() => {
    const w = layoutWorkerRef.current;
    const jobId = ++layoutJobIdRef.current;
    if (w) {
      const req: LayoutRequest = {
        type: "layout",
        jobId,
        nodes: allNodes,
        edges,
        cx: dimensions.w / 2,
        cy: dimensions.h / 2,
        mode: layoutMode,
        filterTag,
      };
      w.postMessage(req);
    } else {
      // Synchronous fallback. Same call site as the old useMemo, just
      // wrapped in a try/catch so a bad input doesn't crash the page.
      try {
        const result = simulateLayout(
          allNodes,
          edges,
          dimensions.w / 2,
          dimensions.h / 2,
          layoutMode,
          filterTag,
        );
        setSimNodes(result);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[SynthesisLayer] synchronous simulateLayout threw:", err);
        setSimNodes([]);
      }
    }
  }, [allNodes, edges, dimensions.w, dimensions.h, layoutMode, filterTag]);
  // posMap / visibleNodeIds were SVG-render helpers; the 3D scene builds its
  // own internal posMap. Keeping them here would only re-allocate on every
  // render. Hover highlight set is the only derived index we still need.

  /* Close dropdowns on outside click */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (showModeMenu && modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) setShowModeMenu(false);
      if (showTagMenu && tagMenuRef.current && !tagMenuRef.current.contains(e.target as Node)) setShowTagMenu(false);
      if (showProjectMenu && projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) setShowProjectMenu(false);
      // Close the "+" add menu when clicking outside its anchor. The
      // modal that opens after picking a type lives at page-root and has
      // its own backdrop click-to-close — it doesn't share this ref.
      if (addMenuOpen && addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showModeMenu, showTagMenu, showProjectMenu, addMenuOpen]);

  /* Hover highlight */
  const highlightSet = useMemo(() => {
    if (!hoveredNode) return new Set<string>();
    const s = new Set<string>();
    s.add(hoveredNode);
    edges.forEach((e) => {
      if (e.from === hoveredNode) s.add(e.to);
      if (e.to === hoveredNode) s.add(e.from);
    });
    return s;
  }, [hoveredNode, edges]);

  // Filter focus set — currently driven only by the "By Project"
  // mode, but threaded into the 3D scene as a generic `focusedSet`
  // so future filters (saved searches, "what I touched today",
  // multi-project unions) can reuse the same render path. Empty
  // / null means "no filter" and the scene renders unchanged.
  //
  // We pull membership from the snapshot stored in
  // `lykn_project_neurons` (UserProject.members[].nodeId) rather
  // than re-deriving from the live graph, because the cluster's
  // identity is the user's choice from when they created it. A
  // node that's been deleted since clustering simply won't have
  // a match in `nodeMap` and the scene's posMap filter will skip
  // it; nothing else has to know.
  const projectFocusSet = useMemo<Set<string> | null>(() => {
    if (layoutMode !== "project" || !filterProjectId) return null;
    const project = userProjects.find((p) => p.id === filterProjectId);
    if (!project) return null;
    const s = new Set<string>();
    for (const m of project.members) s.add(m.nodeId);
    return s;
  }, [layoutMode, filterProjectId, userProjects]);

  // 3D camera: zoom is the only piece we still drive externally (the 3D
  // scene's OrbitControls handle orbit + pan internally). resetSignal is a
  // monotonic counter; bumping it tells the scene to re-snap the camera.
  const [resetSignal] = useState(0);

  /* Node click → select & show panel */
  const handleNodeClick = useCallback((nodeId: string) => {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    // Linking mode short-circuit. While the user is in link-build
    // mode every click toggles selection instead of opening the
    // detail panel — that's the whole point of the mode. We exclude
    // the root + category nodes from being linkable: the user
    // wants to wire together actual neurons (facts, beliefs,
    // perspectives, concepts, vault notes, …), not the structural
    // containers around them.
    if (linkingMode) {
      if (node.kind === "root" || node.kind === "category") return;
      setLinkSelection((prev) => {
        const next = new Set(prev);
        if (next.has(nodeId)) next.delete(nodeId);
        else next.add(nodeId);
        return next;
      });
      return;
    }
    // Project-cluster mode short-circuits the same way linking does:
    // every tap toggles the node in the project's selection set
    // instead of opening its detail panel. Structural containers
    // (root, category) are excluded — they're not real neurons the
    // user would want in a project.
    if (projectMode) {
      if (node.kind === "root" || node.kind === "category") return;
      setProjectSelection((prev) => {
        const next = new Set(prev);
        if (next.has(nodeId)) next.delete(nodeId);
        else next.add(nodeId);
        return next;
      });
      return;
    }
    if (node.kind === "root") {
      setSelectedId(null);
      return;
    }
    // The Belief cluster header (and the legacy __cat_beliefs__ id from
    // before the cluster rename) still opens the multi-belief manager
    // — that's where ratification, rule editing, and the Why log live
    // for browsing/curating ALL beliefs at once. INDIVIDUAL belief
    // nodes now flow through the same unified NeuronPanel as every
    // other neuron kind (see render below); the user asked for one
    // consistent panel per neuron click regardless of type.
    if (nodeId === "__cat_belief__" || nodeId === "__cat_beliefs__") {
      setBeliefWindowOpen(true);
      setSelectedId(nodeId);
      return;
    }
    // Project nodes route to the existing ProjectPanel (updates +
    // connected neurons + add-neurons CTA) rather than the unified
    // NeuronPanel. Clearing selectedId first makes sure the right-
    // side slot isn't holding a stale NeuronPanel underneath when
    // the project panel slides in. The project id was stamped onto
    // node.meta.projectId in buildGraph so we don't have to re-parse
    // it out of the node id here.
    if (node.kind === "project") {
      const projectId = (node.meta?.projectId as string | undefined) || null;
      if (projectId) {
        setSelectedId(null);
        setSelectedProjectId(projectId);
      }
      return;
    }
    // Switching to a non-category neuron while the multi-belief
    // manager is open: close the manager so it doesn't sit on top of
    // the new neuron's NeuronPanel (both anchor to right-0 with the
    // same z-index range).
    if (beliefWindowOpen) {
      setBeliefWindowOpen(false);
    }
    setSelectedId((prev) => (prev === nodeId ? null : nodeId));
  }, [nodeMap, linkingMode, projectMode, beliefWindowOpen]);

  // Stable identity for SynthesisScene3D so the scene's React.memo (if
  // any) and prop-equality short-circuits actually fire. Inline lambdas
  // produced new closures on every parent render and forced the scene
  // to reconcile its entire subtree on every hover tick.
  const handleBackgroundClick = useCallback(() => {
    // Empty-space clicks shouldn't exit linking or project-cluster
    // mode — the user is mid-selection and may have missed a node.
    // They explicitly exit via the Cancel button on the floating
    // action bar.
    if (linkingMode) return;
    if (projectMode) return;
    setSelectedId(null);
  }, [linkingMode, projectMode]);

  // Enter linking mode from the "+" menu or from a DetailPanel button.
  // The `seedNodeIds` param optionally pre-fills the selection set
  // (e.g. when entering from a panel we pre-select that node so the
  // user only has to pick the OTHER end). Linking mode also closes
  // the currently-open panel so the floating action bar isn't fighting
  // the right-side drawer for screen real estate.
  const beginLinking = useCallback((seedNodeIds: string[] = []) => {
    setLinkSelection(new Set(seedNodeIds));
    setLinkLabel("");
    setLinkingMode(true);
    setSelectedId(null);
    setAddMenuOpen(false);
    // Mutually-exclusive with project-cluster mode (see beginProject's
    // mirroring cleanup). Two floating action bars at bottom-center
    // would clobber each other.
    setProjectMode(false);
    setProjectSelection(new Set());
    setProjectName("");
    setProjectDescription("");
    setProjectSubmitting(false);
  }, []);

  const cancelLinking = useCallback(() => {
    setLinkingMode(false);
    setLinkSelection(new Set());
    setLinkLabel("");
    setLinkSubmitting(false);
  }, []);

  const commitLinking = useCallback(async () => {
    const ids = Array.from(linkSelection);
    if (ids.length < 2 || linkSubmitting) return;
    setLinkSubmitting(true);
    try {
      // Build every unique pair from the selection set. A 3-node
      // selection produces 3 links (A-B, A-C, B-C) — the user wired
      // them together, so each pair is a relationship in its own
      // right and renders as a separate edge. Larger selections
      // grow O(n²) but the link-mode UI caps practical use to a
      // handful at a time, so this stays inexpensive.
      const pairs: Array<{ fromNodeId: string; toNodeId: string; label?: string | null }> = [];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          pairs.push({
            fromNodeId: ids[i],
            toNodeId: ids[j],
            label: linkLabel.trim() || null,
          });
        }
      }
      await createUserLinks(user?.id, pairs);
      queryClient.invalidateQueries({ queryKey: ["mindmap_user_links", user?.id || "guest"] });
      cancelLinking();
    } catch (e) {
      // Persistence failure is non-fatal — the userLinks lib already
      // falls back to localStorage internally, so reaching this catch
      // means something genuinely unexpected happened. Log and bail
      // out of submitting state so the user can retry.
      console.error("commitLinking failed", e);
      setLinkSubmitting(false);
    }
  }, [linkSelection, linkSubmitting, linkLabel, user?.id, queryClient, cancelLinking]);

  // ----------------------------------------------------------------
  // Project-cluster mode — sister flow to the linking trio above.
  // Entered from the "+" menu. The user selects neurons in the 3D
  // scene, types a project name (and optional description), and
  // hits Create. We bind the cluster to a row in `lykn_projects`
  // (the same table the AI-driven setActiveProject MCP tool writes
  // into) plus one row per member in `lykn_project_neurons`. Same
  // table the MCP context block reads from, so the moment the user
  // commits the cluster, every outside AI client that hits
  // lykn_listProjects / lykn_getContextBlock can see it.
  //
  // Linking and project mode are mutually exclusive — you can't
  // hold a half-built link and a half-built project at the same
  // time. `beginProject` kicks `linkingMode` off (and vice versa,
  // see beginLinking which already clears any open panel) so the
  // floating action bars don't both try to render at the
  // bottom-center slot.
  // ----------------------------------------------------------------
  const beginProject = useCallback(() => {
    setProjectSelection(new Set());
    setProjectName("");
    setProjectDescription("");
    setProjectSubmitting(false);
    setProjectAddTargetId(null);
    setProjectSearchQuery("");
    setProjectKindFilter("all");
    setProjectMode(true);
    // Defensive: bail out of linking + close the right-side panel +
    // close the "+" menu so the project action bar owns the screen.
    setLinkingMode(false);
    setLinkSelection(new Set());
    setLinkLabel("");
    setSelectedId(null);
    setAddMenuOpen(false);
  }, []);

  const cancelProject = useCallback(() => {
    setProjectMode(false);
    setProjectSelection(new Set());
    setProjectName("");
    setProjectDescription("");
    setProjectSubmitting(false);
    setProjectAddTargetId(null);
    setProjectSearchQuery("");
    setProjectKindFilter("all");
  }, []);

  const commitProject = useCallback(async () => {
    if (projectSubmitting) return;
    if (projectSelection.size === 0) return;
    // Two commit paths share this callback: the "Create" form
    // (no add-target → require a name) and the "Add neurons to
    // existing" form (add-target set → name input is hidden).
    const isAdding = !!projectAddTargetId;
    const name = projectName.trim();
    if (!isAdding && !name) return;
    setProjectSubmitting(true);
    try {
      // Snapshot the label + kind for every selected node at commit
      // time. We send that snapshot into `lykn_project_neurons`
      // alongside the node_id so AI consumers don't have to walk
      // back through the heterogeneous graph-id namespace
      // (`belief_<uuid>`, `tag_<text>`, `neuron_theme_<slug>`, …)
      // to figure out what the user clustered. See migration 063
      // for the rationale.
      const members = Array.from(projectSelection)
        .map((id) => {
          const node = nodeMap.get(id);
          if (!node) return null;
          return {
            nodeId: id,
            label: node.label || null,
            kind: node.kind || null,
          };
        })
        .filter((m) => m != null);

      // Resolve the project context for both the cluster write
      // AND the auto-link pass below. In "create" mode we don't
      // know the project name until the user typed it; in "add"
      // mode we look up the live project so we can reach its
      // already-existing members for the link mesh.
      let projectLabel = name;
      let existingMemberIds: string[] = [];
      if (isAdding) {
        const targetProject = userProjects.find(
          (p) => p.id === projectAddTargetId,
        );
        await addNeuronsToProject(user?.id, projectAddTargetId!, members);
        if (targetProject) {
          projectLabel = targetProject.name;
          existingMemberIds = targetProject.members.map((m) => m.nodeId);
        }
      } else {
        await createUserProject(user?.id, {
          name,
          description: projectDescription.trim() || null,
          members,
        });
      }

      // ---------------------------------------------------------
      // Auto-link every neuron in this cluster to every other
      // neuron in this cluster. The user's mental model of a
      // project is "these neurons belong together" — surfacing
      // that as edges in the brain (via `lykn_user_links`) means
      // the relationship reads even when the user isn't
      // filtering by project. The project name flows in as the
      // link label so the user can later see WHY two neurons
      // got wired together.
      //
      // Pair construction:
      //   • create mode → full mesh across the new selection.
      //   • add mode    → every NEW neuron paired with every
      //                   already-existing member, plus pairs
      //                   among the new neurons themselves.
      // The userLinks lib normalises every (a,b) into lex order
      // and the unique constraint dedups across both paths, so
      // re-running on overlapping selections is idempotent.
      // ---------------------------------------------------------
      const newIds = members.map((m) => m.nodeId);
      // `source: 'project_cluster'` distinguishes these auto-
      // spawned pairs from explicit "Link neurons" rows so the
      // graph builder can render them as ordinary cross-edges
      // outside the project filter (instead of the user-link
      // accent that explicit links get). See the buildGraph
      // userLinks merge for the branching.
      const linkPairs: Array<{
        fromNodeId: string;
        toNodeId: string;
        label?: string | null;
        source?: string | null;
      }> = [];
      for (let i = 0; i < newIds.length; i++) {
        for (const existingId of existingMemberIds) {
          if (existingId === newIds[i]) continue;
          linkPairs.push({
            fromNodeId: newIds[i],
            toNodeId: existingId,
            label: projectLabel,
            source: "project_cluster",
          });
        }
        for (let j = i + 1; j < newIds.length; j++) {
          linkPairs.push({
            fromNodeId: newIds[i],
            toNodeId: newIds[j],
            label: projectLabel,
            source: "project_cluster",
          });
        }
      }
      if (linkPairs.length > 0) {
        // Fire against the same lib the explicit "Link neurons"
        // verb uses. Persistence failures are non-fatal — the
        // cluster itself already committed, so we log and move
        // on rather than rolling back the project write.
        try {
          await createUserLinks(user?.id, linkPairs);
        } catch (linkErr) {
          console.warn("project auto-link failed", linkErr);
        }
      }

      // Bust any caches that pull from `lykn_projects` /
      // `lykn_project_neurons` / `lykn_user_links` so the
      // synthesis layer (and the project-side panel) reflect
      // both the new cluster AND the freshly-spawned edges
      // immediately. Using broad keys on purpose — projects
      // are small and re-fetched cheaply.
      queryClient.invalidateQueries({ queryKey: ["lykn_projects", user?.id || "guest"] });
      queryClient.invalidateQueries({ queryKey: ["mindmap_user_links", user?.id || "guest"] });
      cancelProject();
    } catch (e) {
      // Same shape as commitLinking: persistence failures are
      // non-fatal because the lib already falls back to
      // localStorage internally. Reaching this catch means
      // something genuinely unexpected happened.
      console.error("commitProject failed", e);
      setProjectSubmitting(false);
    }
  }, [projectName, projectDescription, projectSelection, projectSubmitting, projectAddTargetId, userProjects, nodeMap, user?.id, queryClient, cancelProject]);

  // Sister to `beginProject` — enters the same cluster-selection
  // mode but anchors it to an EXISTING project so the next
  // commit appends members instead of creating one. Triggered
  // from the project side panel's "Add neurons" button. We
  // close the side panel on entry so the bottom-center action
  // bar isn't fighting the right-side drawer for screen real
  // estate (same rule the link/create flows already follow).
  const beginAddNeuronsToProject = useCallback((projectId: string) => {
    setProjectSelection(new Set());
    setProjectName("");
    setProjectDescription("");
    setProjectSubmitting(false);
    setProjectAddTargetId(projectId);
    setProjectSearchQuery("");
    setProjectKindFilter("all");
    setProjectMode(true);
    setLinkingMode(false);
    setLinkSelection(new Set());
    setLinkLabel("");
    // Deliberately leave `selectedProjectId` set so the project
    // side panel STAYS open while the user is adding members —
    // they can keep referencing the existing member list /
    // updates while picking new neurons. The cluster action bar
    // is bottom-center and the panel is right-edge, so the two
    // surfaces don't fight for the same slot. The "+" menu and
    // any open neuron panel still get cleared because those DO
    // share screen real estate with the action bar's selection
    // surface.
    setSelectedId(null);
    setAddMenuOpen(false);
  }, []);

  const [formingNodeId, setFormingNodeId] = useState<string | null>(null);

  // Generic post-save formation-pulse watcher. The "+" menu's modal
  // (and the belief / fact-specific UUID handoffs above) stash the
  // freshly-created node's full graph id into `pendingFormingNodeId`;
  // as soon as that node materialises in the rebuilt graph we fire the
  // same formation pulse the prototype handoff uses (line draws toward
  // it, neuron scales in, camera focuses on it). This covers EVERY
  // neuron type — Fact, Belief, Concept, Tag, and the guest prototype
  // variants — so the user always watches their save land in the
  // scene instead of wondering whether the button did anything.
  const [pendingFormingNodeId, setPendingFormingNodeId] = useState<string | null>(null);
  const beliefFormingWatchTimeouts = useRef<number[]>([]);
  useEffect(() => {
    if (!pendingFormingNodeId) return;
    if (!nodeMap.has(pendingFormingNodeId)) return;
    const targetId = pendingFormingNodeId;
    setFormingNodeId(targetId);
    const clearAt = window.setTimeout(() => setFormingNodeId(null), 2000);
    beliefFormingWatchTimeouts.current.push(clearAt);
    if (projectMode) {
      // Project clustering owns the user's focus right now —
      // the bottom-center action bar (and the open project
      // side panel, if any) are where they're working. Don't
      // pop the right-side NeuronPanel for the freshly-formed
      // neuron; instead tick it into the running cluster
      // selection so it lands in the search-list AND ships
      // with the next Create / Add commit. The user still
      // sees the formation pulse so they know the save took.
      setProjectSelection((prev) => {
        const next = new Set(prev);
        next.add(targetId);
        return next;
      });
    } else {
      // Default behaviour: focus the camera + open the
      // neuron's detail panel so the user sees their save
      // land in the scene.
      const focusAt = window.setTimeout(() => setSelectedId(targetId), 400);
      beliefFormingWatchTimeouts.current.push(focusAt);
    }
    setPendingFormingNodeId(null);
  }, [pendingFormingNodeId, nodeMap, projectMode]);

  useEffect(() => {
    return () => {
      beliefFormingWatchTimeouts.current.forEach((id) => window.clearTimeout(id));
      beliefFormingWatchTimeouts.current = [];
    };
  }, []);

  const isEmpty =
    boards.length === 0 &&
    notes.length === 0 &&
    (synthesisData?.themes?.length ?? 0) === 0;
  const selectedNode = selectedId ? nodeMap.get(selectedId) : null;
  const selectedProject = selectedProjectId
    ? userProjects.find((p) => p.id === selectedProjectId) || null
    : null;
  const panelOpen = selectedNode != null;
  // Unified "is any right-side pullout open?" so the top-right chevron
  // toggle can act as the single close affordance for ALL right-edge
  // panels (Core Beliefs, Detail, Welcome, Project). The shared
  // "what's new" updates panel was retired in favour of routing each
  // individual update to its own node-specific DetailPanel via
  // `?focus=<id>`.
  const anyRightPanelOpen =
    beliefWindowOpen || selectedNode != null || selectedProject != null;
  const closeAllRightPanels = useCallback(() => {
    setBeliefWindowOpen(false);
    setSelectedId(null);
    setSelectedProjectId(null);
  }, []);
  const isTopicMode = layoutMode === "topic" && !!filterTag;

  const svgAreaRef = useRef<HTMLDivElement>(null);

  // Wheel-on-canvas drives external zoom state. OrbitControls has its own
  // wheel-zoom disabled in the scene so this stays the source of truth.
  // NOTE: depends on `allQueriesFetched` so the listener re-attaches once
  // the LoadingScreen gate below clears and the canvas div actually
  // enters the DOM — otherwise svgAreaRef.current is null on first mount
  // for signed-in users and zoom is silently dead until refresh.
  useEffect(() => {
    const el = svgAreaRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Only handle wheel when the cursor is over the canvas area (not
      // overlay HTML like the side panel that has its own scroll).
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-stop-canvas-wheel="true"]')) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.92 : 1.08;
      setCamera((c) => ({ ...c, zoom: Math.min(3, Math.max(0.15, c.zoom * delta)) }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [allQueriesFetched, user?.id]);

  // Initial-load takeover for signed-in users. Until every core query
  // (boards / notes / synthesis profile / chunks) has settled, we'd
  // otherwise paint the "Your Synthesis Layer is empty" brain-icon
  // placeholder for a beat while data is still in flight — which reads
  // as a bug to users with non-empty workspaces. Show the same
  // "Getting things ready…" typewriter screen the Vault uses so the
  // transition between routes feels uniform.
  if (user?.id && !allQueriesFetched) {
    return <LoadingScreen isLoading={true} />;
  }

  // Free-tier paywall takeover. Routed through PlanGate (with no children)
  // so we get the same paywall UI used everywhere else — Lock card, plan
  // copy, "View plans" CTA — without re-implementing it here. PlanGate
  // checks the user's plan against `minPlan="studio"`, sees free < studio,
  // and renders its built-in fallback. This early return runs after every
  // hook above, which is what keeps it React-rules-of-hooks safe.
  if (overFreeSynthesisLimit) {
    return (
      <PlanGate
        minPlan="studio"
        feature="Mind Map"
        fallback={null}
        description={`Your Free plan includes the Synthesis Layer up to ${FREE_SYNTHESIS_NODE_LIMIT} neurons you create yourself (chats, vault notes, perspectives, ratified beliefs, manual facts). You've reached ${userCreatedNodeCount} — upgrade to Pro for the full, unlimited mind map. Concepts and other AI-derived nodes never count against this limit.`}
      >
        {null}
      </PlanGate>
    );
  }

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 overflow-hidden select-none"
      // Match the app's dark-mode background (--background = hsl(0 0% 12%)
      // in src/index.css). Hardcoded so the 3D glow stays readable even
      // when the user is in light mode — the bloom effect needs a dark
      // backdrop to read regardless of the rest of the app's theme.
      style={{ backgroundColor: "hsl(0 0% 12%)" }}
    >
      {/* 3D Scene area — orbit, hover, click happen inside the Canvas. The
          page-level wheel handler (above) still drives external zoom so the
          existing +/- buttons remain the source of truth. */}
      <div
        ref={svgAreaRef}
        className="absolute inset-0"
        style={{ cursor: "grab" }}
      >
        {/* Soft radial spotlight — adds a subtle cool sheen at center so neurons
            read against a slight gradient. Edges fade to fully transparent so
            the page-level dark-mode background (hsl(0 0% 12%)) shows through
            and the canvas matches the rest of the app's chrome. */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(120,130,180,0.10) 0%, rgba(31,31,31,0) 65%)",
          }}
        />

        {/* Subtle dot grid — kept from the SVG version for spatial reference */}
        <div
          className="absolute inset-0 opacity-[0.04] pointer-events-none"
          style={{
            backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.7) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }}
        />

        {/* Empty state */}
        {isEmpty && (
          <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
            <div className="text-center space-y-3">
              <Brain className="w-12 h-12 text-indigo-300 mx-auto" />
              <p className="text-sm text-gray-300">Your Synthesis Layer is empty.</p>
              <p className="text-xs text-gray-400">Create chats or vault notes to see them here.</p>
            </div>
          </div>
        )}

        {/* The actual 3D scene. Previously gated to desktop because of a
            theory that r3f + Bloom postprocessing crashes on iOS Safari
            WebGL — turned out the actual mobile crash was an
            `Illegal constructor` from a missing `Lock` icon import in
            MobileTabBar (commit 1700901), so the scene itself is now
            free to attempt rendering on phones. The local error boundary
            wraps it with a mobile-tailored fallback so we still degrade
            to the neuron card stack on devices where WebGL really does
            tap out. Stage 2 (mobile-tuned DPR / Bloom / touch controls)
            is a follow-up. */}
        {!isEmpty && (
          <SynthesisSceneErrorBoundary
            // Memoize so the error boundary doesn't see a new array on
            // every parent render (was triggering boundary children to
            // reconcile from scratch on every hover/zoom tick).
            neurons={neuronLabels}
            fallback={isMobile ? (
              <div className="absolute inset-0 z-10 overflow-y-auto px-5 py-10">
                <div className="max-w-md mx-auto space-y-4 text-center">
                  <Brain className="w-10 h-10 text-indigo-300 mx-auto" />
                  <h2 className="text-base font-semibold text-white/90">
                    Your synthesis layer
                  </h2>
                  <p className="text-xs text-white/55 leading-relaxed">
                    Open LYKN on a desktop browser to see the full interactive
                    3D mind map. Below are the neurons LYKN has learned about
                    you so far.
                  </p>
                  <div className="pt-4 flex flex-col gap-2 text-left">
                    {allNodes
                      .filter((n) => n.kind === "neuron")
                      .map((n) => (
                        <div
                          key={n.id}
                          className="rounded-xl border border-pink-400/30 bg-pink-500/[0.06] px-3.5 py-2.5"
                        >
                          <div className="flex items-center gap-2">
                            <span
                              aria-hidden
                              className="w-1.5 h-1.5 rounded-full bg-pink-300 shadow-[0_0_8px_rgba(244,114,182,0.9)]"
                            />
                            <span className="text-[10px] uppercase tracking-wider text-pink-300/80 font-semibold">
                              {n.meta?.isPrototypeNeuron
                                ? "Neuron"
                                : (n.meta?.kindLabel as string) || "Neuron"}
                            </span>
                          </div>
                          <p className="mt-1 text-sm text-white/90 leading-snug">
                            {n.label}
                          </p>
                          {typeof n.meta?.prototypeReason === "string" &&
                            n.meta.prototypeReason && (
                              <p className="mt-1.5 text-[11px] text-white/55 leading-relaxed">
                                {n.meta.prototypeReason}
                              </p>
                            )}
                        </div>
                      ))}
                  </div>
                </div>
              </div>
            ) : undefined}
          >
            {/* Suspense paints nothing while three.js + r3f are loading —
                the parent <div> already has the dark scene background and
                the radial spotlight, so the chunk swap looks like a brief
                loading hold on an already-decorated canvas instead of a
                white flash. */}
            <Suspense fallback={null}>
            <SynthesisScene3D
              nodes={simNodes}
              edges={edges}
              hoveredId={hoveredNode}
              selectedId={selectedId}
              // Selecting a node (from canvas click OR side-panel connection
              // click) flies the camera to it. Same source of truth as
              // selectedId — they always move together.
              focusNodeId={selectedId}
              highlightSet={highlightSet}
              isTopicMode={isTopicMode}
              zoom={camera.zoom}
              resetSignal={resetSignal}
              onHoverNode={setHoveredNode}
              onClickNode={handleNodeClick}
              // Linking mode visual feedback. The scene boosts each
              // selected node's emissive multiplier so the user can
              // see across the entire cloud which neurons they've
              // queued for the link without scrolling through the
              // action bar's count. Empty set = no boost (identical
              // to pre-link-mode rendering). Project-cluster mode
              // reuses the same prop because the visual treatment
              // ("these are the neurons you're collecting") is
              // identical — only the bottom-center action bar
              // differs.
              linkSelectedIds={
                linkingMode
                  ? linkSelection
                  : projectMode
                    ? projectSelection
                    : undefined
              }
              // Filter highlight (currently driven by the "By
              // Project" mode). Members of the picked project
              // glow with the same emissive boost link selections
              // use; everything else dims out. Null when no
              // filter is active — scene renders unchanged.
              focusedSet={projectFocusSet}
              // Prototype handoff: empty-space clicks must NOT deselect the
              // highlighted neuron (would fly the camera back to centroid
              // and undo the whole "this is YOUR neuron, look at it"
              // moment). Keep it locked there until the user signs in.
              onBackgroundClick={handleBackgroundClick}
              // Prototype handoff: when set, the scene draws an electric-blue
              // line out from "AI Learned" and scales the neuron into being
              // at the end of it, instead of rendering the node in place.
              formingNodeId={formingNodeId}
              // Prototype handoff: lock the camera ONLY while the neuron is
              // forming so the user sees the formation play out without
              // OrbitControls hijacking pointer events. The instant the
              // formation completes (formingNodeId clears) we hand control
              // back so the user can pan / rotate around their new neuron.
              lockCamera={formingNodeId != null}
              // Tour intro: slow cinematic orbit for the first ~15s after
              // arriving from the wake screen so the visitor sees their
              // (sample) brain from several angles before they have to
              // figure out drag-to-orbit themselves. Cancels on first
              // interaction — see the pointerdown listener bound to
              // containerRef above.
              autoRotate={false}
            />
            </Suspense>
          </SynthesisSceneErrorBoundary>
        )}
      </div>

      {/* Core Beliefs slide-out — opens the right-side panel that lists
          proposed/active beliefs, their rules, and the "Why" log. Lazy
          mount: the panel only fetches /api/beliefs the first time it
          opens (and on each subsequent open after a 5s freshness window).
          `initialComposerOpen` is set when the user reached the panel via
          the "+ → Core Belief neuron" entry, so it lands on the write-in
          composer. We clear the flag after the panel honors it. */}
      <BeliefWindowPanel
        open={beliefWindowOpen}
        onClose={() => setBeliefWindowOpen(false)}
        // When a belief neuron is selected in the 3D scene, hoist that
        // belief to the top of the panel and auto-expand it. Node ids
        // for beliefs are prefixed with `belief_`; strip the prefix to
        // get the raw uuid the panel keys on.
        focusBeliefId={
          beliefWindowOpen && selectedId && selectedId.startsWith("belief_")
            ? selectedId.slice("belief_".length)
            : null
        }
        // Perspectives feed the new Stories tab inside the panel.
        // Derive lightweight summaries from the notes payload the
        // synthesis layer already fetched — the _perspective tag is
        // the magic marker that splits perspective rows out of
        // regular Vault notes (see PERSPECTIVE_NOTE_TAG comment).
        perspectives={notes
          .filter(isPerspectiveNote)
          .map((n) => ({
            id: n.id,
            title: n.title || n.ai_summary || "Untitled perspective",
            ai_summary: n.ai_summary || null,
            created_at: null,
          }))}
        // "+ New" inside the Perspectives tab opens the same composer
        // the synthesis-layer "+ → Perspective" path uses.
        onCreatePerspective={() => setCreatingNeuronType("perspective")}
        // Clicking a perspective row focuses its node in the 3D scene
        // (and closes the panel so the DetailPanel can take over).
        onSelectPerspective={(perId) => {
          setBeliefWindowOpen(false);
          setSelectedId(`perspective_${perId}`);
        }}
      />

      {/* The shared "what's new" / Recent activity pullout was retired.
          Each individual update from the chat load-in greeting now
          deep-links to its own node-specific DetailPanel via
          `?focus=<id>`, which is the canonical "dedicated panel for
          that one thing" surface. The synthesis layer no longer owns
          a generic updates list. */}

      {/* Universal right-side close affordance — mirrors the
          AppSidebar's chevron on the left edge. Only visible when one
          of the remaining right-side panels (DetailPanel, Core Beliefs,
          Welcome) is open; dismisses all of them in one click. Each
          panel still ships with its own internal X for proximity. */}
      {anyRightPanelOpen ? (
        <button
          type="button"
          onClick={closeAllRightPanels}
          className={
            isMobile
              ? "fixed top-3 right-3 z-[100] rounded-full w-8 h-8 hover:bg-blue-500/15 dark:hover:bg-blue-400/20 transition-colors flex items-center justify-center"
              : "fixed top-4 right-4 z-[100] rounded-full w-8 h-8 hover:bg-blue-500/15 dark:hover:bg-blue-400/20 transition-colors flex items-center justify-center"
          }
          title="Hide panel"
          aria-label="Hide right-side panel"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      ) : null}

      {/* Core Beliefs has no standalone toolbar trigger — it's reached
          through the bottom-right "+" menu's "Core Belief neuron" entry,
          which opens the centered creation modal. Once the new belief
          forms in the 3D scene the user can keep working in the layer;
          to manage / ratify / edit existing beliefs they re-enter the
          panel via the AppliedRulePill "Open Core Beliefs →" link or
          the Why-log buttons under chat replies. */}

      {/* Centered neuron creation modal. Single component handles both
          neuron types (Basic neuron & Core Belief neuron) — the modal
          dims the screen, shows the type's name + description, captures
          the form input, and on save plays a brief "neuron forming"
          animation before dismissing. For Core Beliefs we additionally
          chain into the graph-level forming animation so the user sees
          their belief land in the 3D scene. */}
      <AnimatePresence>
        {creatingNeuronType ? (
          <NeuronCreationModal
            type={creatingNeuronType}
            // The unified composer's Connections picker needs the
            // full live node list (every belief / fact / concept /
            // perspective / vault note already in the graph). We
            // hand it the same `allNodes` the 3D scene uses and let
            // the panel filter out category shells + root internally.
            existingNodes={allNodes.map((n) => ({
              id: n.id,
              label: n.label || n.id,
              kind: n.kind,
              color: n.color,
            }))}
            userId={user?.id || null}
            onClose={() => setCreatingNeuronType(null)}
            onCreated={(newId, savedText) => {
              if (creatingNeuronType === "belief" && newId) {
                // Belief nodes render directly off the active-beliefs
                // query, so once we refetch the new node will appear in
                // the graph and the watcher effect will trigger the
                // formingNodeId pulse.
                setPendingFormingNodeId(`belief_${newId}`);
                queryClient.invalidateQueries({ queryKey: ["mindmap_active_beliefs", user?.id] });
              } else if (creatingNeuronType === "concept" && newId) {
                // Concepts land in lykn_concepts. The mindmap_concepts
                // query refetch surfaces the new node; embeddings fill
                // in asynchronously and don't gate the render. Queue
                // the same formation pulse the other types get.
                setPendingFormingNodeId(`concept_${newId}`);
                queryClient.invalidateQueries({ queryKey: ["mindmap_concepts", user?.id] });
                queryClient.invalidateQueries({ queryKey: ["mindmap_concept_links_for_user", user?.id] });
              } else if (creatingNeuronType === "perspective" && newId) {
                // Perspectives are persisted as Vault notes carrying
                // the `_perspective` tag; the synthesis layer surfaces
                // them as a dedicated Perspectives cluster (the
                // `mindmap_perspectives` query reads the same `notes`
                // table). Node id mirrors `perspective_<note_id>` so
                // the formation pulse lands on the freshly-minted node.
                setPendingFormingNodeId(`perspective_${newId}`);
                queryClient.invalidateQueries({ queryKey: ["mindmap_perspectives", user?.id] });
                // The Vault notes query also caches this row (filtered
                // out by the perspective tag in buildGraph), so refresh
                // it as well to keep counts consistent.
                queryClient.invalidateQueries({ queryKey: ["mindmap_vault_graph", user?.id] });
              } else if (creatingNeuronType === "tag") {
                // Tag creation inserts a Vault note carrying the tag.
                // The tag-cluster node id is derived from the tag text
                // itself (`tag_<text>`), not the note id, which is why
                // we queue the pulse off `savedText` rather than newId.
                if (savedText) setPendingFormingNodeId(`tag_${savedText}`);
                queryClient.invalidateQueries({ queryKey: ["mindmap_vault_graph", user?.id] });
              } else if (newId) {
                // Basic neurons land in lykn_user_model_facts. We render
                // user-stated/confirmed rows directly via the manualFacts
                // query so the new node shows up immediately — the
                // synthesis profile rebuild that would normally roll
                // these into themes/topics happens out-of-band on a
                // background cadence, way too slow to feel like a save.
                setPendingFormingNodeId(`fact_${newId}`);
                queryClient.invalidateQueries({ queryKey: ["mindmap_manual_facts", user?.id] });
                queryClient.invalidateQueries({ queryKey: ["mindmap_synthesis_profile", user?.id] });
                queryClient.invalidateQueries({ queryKey: ["mindmap_synthesis_chunks", user?.id] });
              }
            }}
          />
        ) : null}
      </AnimatePresence>

      {/* Organize dropdown — desktop sits to the right of the sidebar
          signed-in pill; mobile has no sidebar, so the desktop position
          (`left-[13.5rem]`) lands directly under the centered "Synthesis
          Layer" title and covers it. On mobile, drop it below the title
          and pin to the left edge. */}
      <div className={
        isMobile
          ? "fixed top-12 left-3 z-[80] flex items-center gap-2"
          : "fixed top-4 left-[13.5rem] z-[80] flex items-center gap-2"
      }>
        <div ref={modeMenuRef} className="relative">
          <button
            onClick={() => { setShowModeMenu((v) => !v); setShowTagMenu(false); }}
            // py-1.5 matches the vertical padding the topic/
            // project chips beside this button use, so the row's
            // resting height stays the same whether or not a
            // companion chip is rendered. Without it, switching
            // INTO "By Idea" or "By Project" suddenly grows the
            // row height and the bare-text mode button appears
            // to "drop into place" — which read as a layout jank.
            className="flex items-center gap-1.5 py-1.5 text-[0.6875rem] font-medium text-white/75 hover:text-white transition-colors"
          >
            {(() => { const m = layoutModes.find((l) => l.id === layoutMode); return m ? <m.icon size={13} /> : null; })()}
            {layoutModes.find((l) => l.id === layoutMode)?.label}
            <ChevronDown size={11} className="text-white/45" />
          </button>
          <AnimatePresence>
            {showModeMenu && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.12 }}
                className="absolute top-full left-0 mt-1.5 w-48 rounded-xl bg-[rgba(23,23,23,0.92)] backdrop-blur-md border border-white/10 shadow-lg py-1 z-50"
              >
                {layoutModes.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => {
                      setLayoutMode(m.id);
                      setShowModeMenu(false);
                      if (m.id !== "topic") setFilterTag(null);
                      if (m.id === "topic" && allIdeas.length > 0 && !filterTag) setFilterTag(allIdeas[0]);
                      // "By Project" filter — seed with the
                      // user's most recently active project so
                      // the scene immediately reflects a meaningful
                      // selection instead of showing the dimmed
                      // "no project picked" placeholder. Clear the
                      // pick when leaving this mode so re-entering
                      // doesn't surprise the user with a stale
                      // selection.
                      if (m.id !== "project") setFilterProjectId(null);
                      if (
                        m.id === "project" &&
                        userProjects.length > 0 &&
                        !filterProjectId
                      ) {
                        setFilterProjectId(userProjects[0].id);
                      }
                    }}
                    className={`w-full text-left px-3 py-2 flex items-center gap-2.5 text-[0.6875rem] transition-colors ${
                      layoutMode === m.id
                        ? "bg-white/12 text-white font-medium"
                        : "text-white/70 hover:bg-white/8"
                    }`}
                  >
                    <m.icon size={13} />
                    {m.label}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>


        {layoutMode === "topic" && (
          <div ref={tagMenuRef} className="relative">
            <button
              onClick={() => { setShowTagMenu((v) => !v); setShowModeMenu(false); }}
              className="flex items-center gap-1.5 text-[0.6875rem] font-medium px-2.5 py-1.5 rounded-md bg-amber-500/15 border border-amber-400/30 text-amber-200 hover:bg-amber-500/25 shadow-sm transition-colors"
            >
              <Hash size={12} />
              {filterTag || "Select idea"}
              <ChevronDown size={11} />
            </button>
            <AnimatePresence>
              {showTagMenu && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.12 }}
                  className="absolute top-full left-0 mt-1.5 w-48 max-h-64 overflow-y-auto rounded-xl bg-[rgba(23,23,23,0.92)] backdrop-blur-md border border-white/10 shadow-lg py-1 z-50 scrollbar-hide"
                >
                  {allIdeas.length === 0 ? (
                      <p className="px-3 py-2 text-[0.6875rem] text-white/45">No ideas found</p>
                  ) : allIdeas.map((t) => (
                    <button
                      key={t}
                      onClick={() => { setFilterTag(t); setShowTagMenu(false); }}
                      className={`w-full text-left px-3 py-1.5 text-[0.6875rem] transition-colors ${
                        filterTag === t
                          ? "bg-amber-500/20 text-amber-200 font-medium"
                          : "text-white/70 hover:bg-white/8"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* Project chooser — sister to the topic chooser above.
            Renders next to the mode dropdown only while the user
            is in "By Project" layout mode. The chosen project's
            member node ids flow into `projectFocusSet` and from
            there into the 3D scene's `focusedSet`, so only that
            project's clustered neurons glow against the dimmed
            full graph. Deliberately neutral (white-on-dark) to
            match the rest of the chrome — the "+" menu, the mode
            dropdown items, the legend — instead of carrying the
            violet accent the create-project action bar uses.
            That accent is reserved for the action surface; the
            filter is just a chip. */}
        {layoutMode === "project" && (
          <div ref={projectMenuRef} className="relative">
            <button
              onClick={() => { setShowProjectMenu((v) => !v); setShowModeMenu(false); setShowTagMenu(false); }}
              className="flex items-center gap-1.5 text-[0.6875rem] font-medium px-2.5 py-1.5 rounded-md bg-white/8 border border-white/15 text-white/80 hover:bg-white/14 hover:text-white shadow-sm transition-colors"
            >
              <FolderPlus size={12} />
              {(() => {
                const p = userProjects.find((x) => x.id === filterProjectId);
                if (p) {
                  // Compact chip: keep the running count to neurons
                  // only so the chip stays narrow. The expanded
                  // dropdown rows below carry the full breakdown
                  // (X neurons · Y pushes) where there's room to
                  // read it without truncating the project name.
                  const n = p.members.length;
                  return `${p.name} · ${n}`;
                }
                return userProjects.length === 0
                  ? "No projects yet"
                  : "Select project";
              })()}
              <ChevronDown size={11} />
            </button>
            <AnimatePresence>
              {showProjectMenu && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.12 }}
                  className="absolute top-full left-0 mt-1.5 w-64 max-h-72 overflow-y-auto rounded-xl bg-[rgba(23,23,23,0.92)] backdrop-blur-md border border-white/10 shadow-lg py-1 z-50 scrollbar-hide"
                >
                  {userProjects.length === 0 ? (
                    <div className="px-3 py-3 text-[0.6875rem] text-white/55 leading-relaxed">
                      No projects yet. Cluster a few neurons together
                      to get started.
                    </div>
                  ) : userProjects.map((p) => {
                    const active = filterProjectId === p.id;
                    return (
                      <button
                        key={p.id}
                        onClick={() => {
                          // Three things happen in one tap:
                          //   1. set the focus filter so the scene
                          //      glows only that project's members,
                          //   2. open the project side panel so the
                          //      user can read its updates / member
                          //      list / hit "Add neurons,"
                          //   3. close the dropdown.
                          // Doing all three at once matches how the
                          // user thinks about this affordance ("show
                          // me this project") and avoids forcing two
                          // clicks for the most common flow.
                          setFilterProjectId(p.id);
                          setSelectedProjectId(p.id);
                          setShowProjectMenu(false);
                        }}
                        className={`w-full text-left px-3 py-2 text-[0.6875rem] transition-colors flex items-start gap-2 ${
                          active
                            ? "bg-white/12 text-white font-medium"
                            : "text-white/75 hover:bg-white/8"
                        }`}
                      >
                        <FolderPlus
                          size={11}
                          className={`mt-0.5 shrink-0 ${active ? "text-white/85" : "text-white/45"}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{p.name}</div>
                          <div className="text-[0.6rem] text-white/45 mt-0.5">
                            {p.members.length} neuron
                            {p.members.length === 1 ? "" : "s"}
                            {" · "}
                            {p.pushCount || 0} push
                            {(p.pushCount || 0) === 1 ? "" : "es"}
                            {p.description ? ` · ${p.description}` : ""}
                          </div>
                        </div>
                      </button>
                    );
                  })}

                  {/* Divider + "Create new project" entry — same
                      verb the "+" menu exposes, surfaced here so
                      the user can spawn a project without having
                      to leave the filter dropdown they're already
                      in. The thicker divider mirrors the "+"
                      menu's "Link neurons" separator: it tells
                      the eye "the entries above are nouns, the
                      entry below is a verb." */}
                  {userProjects.length > 0 ? (
                    <div className="h-px bg-white/15 my-1 mx-2" />
                  ) : null}
                  <button
                    onClick={() => {
                      setShowProjectMenu(false);
                      beginProject();
                    }}
                    className="w-full text-left px-3 py-2 text-[0.6875rem] text-white/85 hover:bg-white/8 transition-colors flex items-center gap-2"
                  >
                    <Plus size={11} className="shrink-0 text-white/55" />
                    <span>Create new project</span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* Title — centered on desktop, left-aligned on mobile so it
          doesn't fight the centered 3D scene controls / stats overlays
          for that narrow strip of viewport real estate. */}
      <div className={
        isMobile
          ? "absolute top-5 left-3 z-20 flex pointer-events-none"
          : "absolute top-5 left-0 right-0 z-20 flex justify-center pointer-events-none"
      }>
        <div className="flex items-center gap-2.5">
          <h1 className="text-sm font-semibold text-white/85 tracking-wide" style={{ textShadow: "0 0 14px rgba(99,102,241,0.4)" }}>Synthesis Layer</h1>
        </div>
      </div>

      {/* Stats. Right offset always leaves room for the always-visible
          recent-activity toggle button (sidebar-style chevron pinned at
          right-4, w-8). When the detail panel or recent-activity panel
          covers the right edge entirely, push further. */}
      <div className="absolute top-6 z-20 flex items-center gap-4 text-[0.625rem] text-white/60 pointer-events-none transition-[right] duration-300"
        style={{ right: anyRightPanelOpen ? 396 : 56 }}
      >
        <span>{boards.length} chats</span>
        <span className="w-px h-3 bg-white/15" />
        <span>{notes.length} notes</span>
      </div>

      {/* Bottom-right control — single add-neuron button, centered in
          the corner. Previously this cluster also held a zoom in / out /
          reset column, but those have been retired in favour of the
          page-level wheel handler + drag-to-orbit being the only ways
          to move the camera. The "+" stays as the sole primary action
          and shifts left when a detail panel opens.
          Bottom offset adds `var(--mobile-tabbar-clear)` so the button
          floats above the MobileTabBar (when mounted) + the iOS home-
          indicator safe area. On desktop and during the walkthrough
          lockdown (chrome hidden → no tab bar), the variable resolves
          to 0px and the offset collapses back to the original 1.5rem.
          Without this clearance the tab bar lands directly on top of
          the "+", which on most phones makes it impossible to tap. */}
      <div
        className="absolute z-20 flex items-end transition-[right] duration-300"
        style={{
          right: panelOpen || beliefWindowOpen ? 384 : 24,
          bottom: "calc(1.5rem + var(--mobile-tabbar-clear, 0px))",
        }}
      >
        {/* Add-neuron entry — bigger, circular, sits visually as the
            primary action of the cluster. Picking a type opens a
            centered creation modal. */}
        <div ref={addMenuRef} className="relative">
          <button
            onClick={() => setAddMenuOpen((v) => !v)}
            className={`relative w-11 h-11 rounded-full backdrop-blur border flex items-center justify-center shadow-[0_6px_20px_rgba(0,0,0,0.35)] transition-colors ${
              addMenuOpen
                ? "bg-blue-500/25 border-blue-400/45 text-blue-100"
                : "bg-white/10 border-white/15 text-white/85 hover:bg-white/16 hover:border-white/25"
            }`}
            title="Add a neuron"
            aria-label="Add a neuron"
            aria-expanded={addMenuOpen}
          >
            <Plus size={18} />
          </button>

          <AnimatePresence>
            {addMenuOpen ? (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                transition={{ duration: 0.12 }}
                // Anchor to the button's RIGHT edge and extend leftward.
                // The "+" button is the leftmost item in a cluster pinned
                // to the right side of the canvas, so the popover needs
                // to grow into the open canvas to its left — anchoring
                // `left-0` instead would push the popover off the right
                // edge of the viewport. z-50 keeps it stacked above the
                // zoom-column siblings.
                //
                // The panel itself is intentionally black-and-white: it
                // exposes the five top-level categories of the brain
                // in the same order they read in the legend (Belief /
                // Vault / Facts / Concepts / Chats), then a divider,
                // then the "Link neurons" verb at the bottom. We don't
                // want any single entry's brand color to read as the
                // "default" choice.
                //
                // The category entries map to either a composer
                // (Belief / Facts / Concepts open the right write-in
                // form) or a navigation (Vault / Chats route to the
                // dedicated page where the larger creation flow
                // lives). The Belief entry currently opens the
                // Belief composer directly; a future pass will fan
                // it out into a small chooser (Belief / Perspective
                // sub-options) when Perspective creation gets
                // common enough that hiding it inside the Belief
                // panel's Stories tab feels wrong.
                className="absolute bottom-full right-0 mb-2 w-60 rounded-xl bg-black border border-white/20 shadow-[0_14px_40px_rgba(0,0,0,0.6)] overflow-hidden z-50"
                role="menu"
              >
                {([
                  // Order within the "noun" section above the divider
                  // groups the three "deepest-self" neurons (Beliefs,
                  // Facts, Concepts) together at the top, since they
                  // all open the unified creation panel. Vault and
                  // Chat sit below them as navigation entries — they
                  // bounce to a different page rather than open the
                  // composer, so visually separating them from the
                  // composer-trigger group makes the menu read as
                  // "create a neuron … (or jump to a surface)".
                  {
                    key: "belief",
                    label: "Beliefs",
                    blurb: "A core belief or principle that shapes every reply.",
                    Icon: Atom,
                    divider: false,
                    onClick: () => {
                      setAddMenuOpen(false);
                      setCreatingNeuronType("belief");
                    },
                  },
                  {
                    key: "fact",
                    label: "Fact",
                    blurb: "A single fact about you the AI should remember.",
                    Icon: Brain,
                    divider: false,
                    onClick: () => {
                      setAddMenuOpen(false);
                      setCreatingNeuronType("basic");
                    },
                  },
                  {
                    key: "concept",
                    label: "Concept",
                    blurb: "A theme that ties your ideas together.",
                    Icon: Sparkles,
                    divider: false,
                    onClick: () => {
                      setAddMenuOpen(false);
                      setCreatingNeuronType("concept");
                    },
                  },
                  {
                    key: "vault",
                    label: "Vault",
                    blurb: "Save a note, file, or link.",
                    Icon: StickyNote,
                    divider: false,
                    onClick: () => {
                      setAddMenuOpen(false);
                      navigate("/vault");
                    },
                  },
                  {
                    key: "chat",
                    label: "Chat",
                    blurb: "Start a new conversation with LYKN.",
                    Icon: LayoutGrid,
                    // Thicker divider here so Link neurons reads as a
                    // separate "verb" section below the five
                    // category creation/nav entries above it.
                    divider: true,
                    onClick: () => {
                      setAddMenuOpen(false);
                      navigate("/app");
                    },
                  },
                  {
                    // Linking is a verb, not a noun, so it lives below
                    // the divider — it's the second-most-common
                    // action from the "+" affordance ("I want to
                    // wire two things together").
                    key: "link",
                    label: "Link neurons",
                    blurb: "Connect two or more neurons together.",
                    Icon: Link2,
                    divider: false,
                    onClick: () => {
                      setAddMenuOpen(false);
                      beginLinking();
                    },
                  },
                  {
                    // Project clustering — pick the neurons that
                    // belong to a piece of work, give it a name,
                    // and the AI sees the cluster the next time it
                    // calls lykn_listProjects / lykn_getContextBlock
                    // through MCP. Sits right under "Link neurons"
                    // because it's the same selection mechanic
                    // applied to a different verb ("group these"
                    // instead of "wire these").
                    key: "project",
                    label: "Create project",
                    blurb: "Cluster neurons into a project the AI can see.",
                    Icon: FolderPlus,
                    divider: false,
                    onClick: () => {
                      setAddMenuOpen(false);
                      beginProject();
                    },
                  },
                ] as const).map((item, idx, arr) => (
                  <div key={item.key}>
                    <button
                      role="menuitem"
                      onClick={item.onClick}
                      className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-white/10 transition-colors"
                    >
                      <item.Icon size={13} className="mt-0.5 text-white/85 flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="text-[0.72rem] font-medium text-white">{item.label}</div>
                        <div className="text-[0.62rem] text-white/55 mt-0.5 leading-snug">
                          {item.blurb}
                        </div>
                      </div>
                    </button>
                    {idx < arr.length - 1 ? (
                      <div
                        className={
                          item.divider
                            ? "h-px bg-white/25"
                            : "h-px bg-white/12"
                        }
                      />
                    ) : null}
                  </div>
                ))}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      {/* Legend — five top-level clusters in canonical reading order:
          outer scaffolding (Chats / Vault) first, then the inner
          identity tiers (Belief / Facts / Concepts). Tags collapsed
          into Vault attributes; Perspectives folded into the Belief
          cluster; AI-learned neurons absorbed into Facts. */}
      <div className="absolute bottom-6 left-6 z-20 flex flex-wrap gap-3 text-[0.625rem] text-white/55 pointer-events-none">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.grids.bg, color: palette.grids.bg }} /> Chats</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.vault.bg, color: palette.vault.bg }} /> Vault</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.belief.bg, color: palette.belief.bg }} /> Beliefs</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.facts.bg, color: palette.facts.bg }} /> Facts</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.concepts.bg, color: palette.concepts.bg }} /> Concepts</span>
      </div>

      {/* Orbit hint — first-time users may not realise drag = orbit (not pan).
          Fades after a few seconds via CSS animation; tiny enough to ignore.
          Hidden during linking + project-cluster mode so it doesn't fight
          the action bar for the same bottom-center slot. */}
      {!linkingMode && !projectMode && (
        <div
          className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 text-[0.6rem] text-white/40 pointer-events-none animate-pulse"
        >
          drag to orbit · scroll to zoom · shift+drag to pan
        </div>
      )}

      {/* Link-mode action bar — floats at bottom-center while the
          user is wiring neurons together. Shows the running selection
          count, a free-text label field ("supports", "contradicts",
          …), and Connect / Cancel actions. Connect upserts one row
          per unique pair via the userLinks lib (Supabase when the
          migration is present, localStorage otherwise + always for
          guests). The bar also shows a tiny instruction line so the
          user knows what to do — "tap any neurons in the brain to
          select them" — because link mode is a transient state with
          no other visual indicator. */}
      <AnimatePresence>
        {linkingMode && (
          <motion.div
            key="link-mode-bar"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 w-[min(92vw,28rem)] rounded-2xl bg-[rgba(15,15,18,0.94)] backdrop-blur-md border border-blue-400/35 shadow-[0_18px_50px_rgba(0,0,0,0.55)] px-4 py-3"
            role="dialog"
            aria-label="Link neurons"
          >
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 h-7 w-7 rounded-full bg-blue-500/20 border border-blue-400/45 flex items-center justify-center flex-shrink-0">
                <Link2 size={13} className="text-blue-200" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[0.78rem] font-semibold text-white/95 leading-snug">
                  {linkSelection.size === 0
                    ? "Select neurons to link"
                    : linkSelection.size === 1
                    ? "1 neuron selected · pick another"
                    : `${linkSelection.size} neurons selected`}
                </p>
                <p className="text-[0.62rem] text-white/55 leading-snug mt-0.5">
                  Tap any neuron in the brain to add or remove it. Pick two or more, then Connect.
                </p>
              </div>
            </div>

            <div className="mt-3">
              <input
                type="text"
                value={linkLabel}
                onChange={(e) => setLinkLabel(e.target.value)}
                maxLength={48}
                placeholder="Optional label (e.g. 'supports', 'reminds me of')"
                className="w-full bg-black/30 border border-white/15 rounded-lg px-2.5 py-1.5 text-[0.72rem] text-white/95 placeholder:text-white/30 focus:outline-none focus:border-white/30"
              />
            </div>

            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={cancelLinking}
                className="flex-1 px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-[0.72rem] font-medium text-white/80 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={commitLinking}
                disabled={linkSelection.size < 2 || linkSubmitting}
                className="flex-[1.4] flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border bg-blue-500/22 hover:bg-blue-500/32 border-blue-400/40 text-blue-100 text-[0.72rem] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {linkSubmitting ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Link2 size={12} />
                )}
                Connect{linkSelection.size >= 2 ? ` ${linkSelection.size}` : ""}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Project-cluster action bar — sister to the link-mode bar
          above. Same bottom-center slot, same selection mechanic,
          but the call-to-action commits the selected neurons into
          a NAMED project (lykn_projects + lykn_project_neurons)
          rather than upserting pairwise edges. The two modes are
          mutually exclusive (see beginProject / beginLinking) so
          they never render simultaneously.

          The bar accepts one required input (project name) and one
          optional input (description) — both flow into the same
          `lykn_projects` row that the MCP server's
          `lykn_listProjects` / `lykn_getContextBlock` tools surface
          to outside AI clients. That's how the AI "sees" the
          cluster the moment the user creates it. */}
      <AnimatePresence>
        {projectMode && (() => {
          // Two visual variants share this action bar — see
          // `beginProject` (create new) vs.
          // `beginAddNeuronsToProject` (append to existing).
          // The append form skips the name/description inputs
          // because the project is already named, and swaps the
          // header copy + CTA label so the user knows which
          // path they're on.
          const addingTo = projectAddTargetId
            ? userProjects.find((p) => p.id === projectAddTargetId) || null
            : null;
          const isAdding = !!addingTo;
          // Build the addable-neuron list: every real neuron in
          // the brain except the structural containers (root,
          // category) — those aren't user-selectable in 3D
          // either, so showing them in the list would be
          // misleading. In "add to existing" mode we ALSO drop
          // members the project already has so the list stays
          // focused on what the user can newly contribute.
          const existingMemberIds = new Set<string>(
            addingTo ? addingTo.members.map((m) => m.nodeId) : [],
          );
          const queryLower = projectSearchQuery.trim().toLowerCase();
          const addablePool = allNodes.filter(
            (n) => isProjectAddableNode(n) && !existingMemberIds.has(n.id),
          );
          const kindFilterOptions = PROJECT_KIND_FILTERS.filter((chip) => {
            if (chip.id === "all") return true;
            return addablePool.some((n) => projectNodeBucket(n) === chip.id);
          });
          const effectiveKindFilter = kindFilterOptions.some((c) => c.id === projectKindFilter)
            ? projectKindFilter
            : "all";
          const addableMatches = addablePool
            .filter((n) => {
              if (effectiveKindFilter !== "all" && projectNodeBucket(n) !== effectiveKindFilter) {
                return false;
              }
              if (!queryLower) return true;
              return projectNodeSearchHaystack(n).includes(queryLower);
            })
            // Selected items float to the top so the running
            // selection is always visible at a glance, then the
            // remainder is alphabetical for predictable scroll.
            .sort((a, b) => {
              const aSel = projectSelection.has(a.id) ? 0 : 1;
              const bSel = projectSelection.has(b.id) ? 0 : 1;
              if (aSel !== bSel) return aSel - bSel;
              return (a.label || "").localeCompare(b.label || "");
            });
          const hasActiveFilter =
            !!queryLower || effectiveKindFilter !== "all";
          return (
            <motion.div
              key="project-mode-bar"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 16 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              // Deliberately neutral (white-on-dark) — matches the
              // "+" menu and the project filter chip. The link-mode
              // bar above keeps its blue accent because linking is
              // a paired-edge primitive across the whole brain;
              // project clustering is a quieter authoring action
              // and reads better without competing with the scene's
              // own color cues.
              //
              // Centering math: the bar normally sits dead-centre
              // of the viewport, but when a right-edge panel is
              // open (the project side panel during "Add neurons",
              // or a neuron panel anyone forgot to close) the
              // panel covers the right ~380px of the viewport.
              // We shift the bar's anchor to the centre of the
              // VISIBLE canvas (viewport minus panel width) so
              // it doesn't visually crowd the panel on narrower
              // screens. `-translate-x-1/2` keeps it true-centred
              // around whatever the anchor resolves to.
              className="absolute bottom-6 -translate-x-1/2 z-30 w-[min(92vw,30rem)] rounded-2xl bg-[rgba(15,15,18,0.94)] backdrop-blur-md border border-white/15 shadow-[0_18px_50px_rgba(0,0,0,0.55)] px-4 py-3 transition-[left] duration-200"
              style={{
                left: anyRightPanelOpen
                  ? "calc((100vw - 380px) / 2)"
                  : "50%",
              }}
              role="dialog"
              aria-label={isAdding ? "Add neurons to project" : "Create project"}
            >
              <div className="flex items-start gap-2.5">
                <div className="mt-0.5 h-7 w-7 rounded-full bg-white/10 border border-white/20 flex items-center justify-center flex-shrink-0">
                  <FolderPlus size={13} className="text-white/80" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[0.78rem] font-semibold text-white/95 leading-snug">
                    {isAdding
                      ? `Adding to “${addingTo!.name}”`
                      : projectSelection.size === 0
                        ? "Tap neurons to add them to your project"
                        : projectSelection.size === 1
                          ? "1 neuron selected · keep tapping or name it"
                          : `${projectSelection.size} neurons selected`}
                  </p>
                  <p className="text-[0.62rem] text-white/55 leading-snug mt-0.5">
                    {isAdding
                      ? `Tap any neuron in the brain to add it to this project. ${projectSelection.size} new neuron${projectSelection.size === 1 ? "" : "s"} queued.`
                      : "Cluster the neurons that belong to a piece of work. The AI sees this project the moment you create it."}
                  </p>
                </div>
              </div>

              {/* Search + clickable neuron list. Lives in BOTH
                  variants of the bar (create + add) — once the
                  brain has more than a handful of neurons,
                  hunting them in 3D is the bottleneck and a
                  filterable list is the fastest way to assemble
                  a cluster. Tapping a row toggles it in
                  `projectSelection` exactly like tapping the
                  same neuron in the 3D scene; the two input
                  surfaces stay perfectly in sync. */}
              <div className="mt-3 space-y-1.5">
                <div className="flex gap-2">
                  <div className="relative flex-1 min-w-0">
                    <Search
                      size={11}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none"
                    />
                    <input
                      type="text"
                      value={projectSearchQuery}
                      onChange={(e) => setProjectSearchQuery(e.target.value)}
                      placeholder={
                        isAdding
                          ? "Search neurons to add…"
                          : "Search neurons by name…"
                      }
                      className="w-full bg-black/30 border border-white/15 rounded-lg pl-7 pr-2.5 py-1.5 text-[0.72rem] text-white/95 placeholder:text-white/30 focus:outline-none focus:border-white/30"
                    />
                  </div>
                  <div className="relative shrink-0 w-[8.75rem]">
                    <select
                      value={effectiveKindFilter}
                      onChange={(e) =>
                        setProjectKindFilter(e.target.value as ProjectKindFilter)
                      }
                      aria-label="Filter by neuron type"
                      className="w-full appearance-none bg-black/30 border border-white/15 rounded-lg pl-2 pr-7 py-1.5 text-[0.72rem] text-white/95 focus:outline-none focus:border-white/30 cursor-pointer"
                    >
                      {kindFilterOptions.map((chip) => {
                        const count =
                          chip.id === "all"
                            ? addablePool.length
                            : addablePool.filter((n) => projectNodeBucket(n) === chip.id)
                                .length;
                        return (
                          <option key={chip.id} value={chip.id}>
                            {chip.label} ({count})
                          </option>
                        );
                      })}
                    </select>
                    <ChevronDown
                      size={11}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none"
                    />
                  </div>
                </div>
                <div className="max-h-60 overflow-y-auto rounded-lg border border-white/10 bg-black/20 scrollbar-hide">
                  {addableMatches.length === 0 ? (
                    <p className="px-3 py-3 text-[0.7rem] text-white/45 leading-relaxed">
                      {hasActiveFilter
                        ? "No neurons match your search or filter."
                        : isAdding
                          ? "Every neuron is already in this project."
                          : "No neurons in your brain yet."}
                    </p>
                  ) : (
                    addableMatches.map((n) => {
                      const selected = projectSelection.has(n.id);
                      return (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => {
                            // Same toggle semantics as a 3D
                            // tap, so the user can mix-and-match
                            // input surfaces during one cluster
                            // session without the selection set
                            // diverging from itself.
                            setProjectSelection((prev) => {
                              const next = new Set(prev);
                              if (next.has(n.id)) next.delete(n.id);
                              else next.add(n.id);
                              return next;
                            });
                          }}
                          className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[0.7rem] transition-colors border-b border-white/5 last:border-b-0 ${
                            selected
                              ? "bg-white/10 text-white"
                              : "text-white/80 hover:bg-white/[0.05]"
                          }`}
                        >
                          <span
                            aria-hidden
                            className={`shrink-0 w-3.5 h-3.5 rounded-[3px] border flex items-center justify-center text-[0.55rem] ${
                              selected
                                ? "bg-white text-black border-white"
                                : "border-white/30 bg-transparent"
                            }`}
                          >
                            {selected ? <Check size={9} /> : null}
                          </span>
                          <span className="flex-1 min-w-0 truncate">
                            {n.label || "(unlabeled)"}
                          </span>
                          <span className="shrink-0 text-[0.55rem] uppercase tracking-[0.12em] text-white/40">
                            {projectNodeKindLabel(n)}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
                {addablePool.length > 0 && (
                  <p className="text-[0.58rem] text-white/40 tabular-nums">
                    {hasActiveFilter
                      ? `Showing ${addableMatches.length} of ${addablePool.length} neurons`
                      : `${addablePool.length} neurons`}
                  </p>
                )}
              </div>

              {!isAdding && (
                <div className="mt-3 space-y-2">
                  <input
                    type="text"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    maxLength={120}
                    placeholder="Project name (e.g. 'Q1 fundraising deck')"
                    className="w-full bg-black/30 border border-white/15 rounded-lg px-2.5 py-1.5 text-[0.74rem] text-white/95 placeholder:text-white/30 focus:outline-none focus:border-white/30"
                  />
                  <textarea
                    value={projectDescription}
                    onChange={(e) => setProjectDescription(e.target.value)}
                    maxLength={320}
                    rows={2}
                    placeholder="Optional one-liner — what is this project about?"
                    className="w-full bg-black/30 border border-white/15 rounded-lg px-2.5 py-1.5 text-[0.72rem] text-white/95 placeholder:text-white/30 focus:outline-none focus:border-white/30 resize-none"
                  />
                </div>
              )}

              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={cancelProject}
                  className="flex-1 px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-[0.72rem] font-medium text-white/80 transition-colors"
                >
                  Cancel
                </button>
                {/* Create-new-neuron shortcut. Opens the SAME
                    type-picker the "+" button at the bottom-
                    right exposes (Belief / Vault / Fact /
                    Concept / Chat) — a project should never
                    invent a second creation surface. The
                    pendingFormingNodeId watcher takes any
                    neuron produced while projectMode is true
                    and auto-ticks it into projectSelection so
                    the user can compose-and-cluster in one
                    motion without re-entering this bar. */}
                <button
                  onClick={() => setAddMenuOpen(true)}
                  className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-[0.7rem] font-medium text-white/80 transition-colors"
                  aria-label="Create a new neuron and add it to this project"
                  title="Create a new neuron and add it to this project"
                >
                  <Plus size={11} />
                  Create new
                </button>
                <button
                  onClick={commitProject}
                  disabled={
                    projectSubmitting ||
                    projectSelection.size === 0 ||
                    (!isAdding && !projectName.trim())
                  }
                  className="flex-[1.4] flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/25 bg-white/12 hover:bg-white/18 text-white text-[0.72rem] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {projectSubmitting ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <FolderPlus size={12} />
                  )}
                  {isAdding
                    ? `Add${projectSelection.size > 0 ? ` · ${projectSelection.size}` : ""}`
                    : `Create${projectSelection.size > 0 ? ` · ${projectSelection.size}` : ""}`}
                </button>
              </div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* Neuron detail panel — opens when a node is selected from a
          graph tap, an updates-panel row click, or a programmatic
          focus. This is the SINGLE unified surface for every neuron
          kind (belief, concept, fact, note, perspective, chat, tag):
          one consistent layout so the user sees the same shape of
          information no matter what they click. The older bespoke
          `DetailPanel` is still in this file but no longer rendered
          for individual neurons; the multi-belief manager
          (`BeliefWindowPanel`) only opens when the user clicks the
          Belief cluster header or chooses the "+ → Core Belief neuron"
          entry. */}
      <NeuronPanel
        open={Boolean(selectedNode)}
        node={selectedNode || null}
        allNodes={allNodes}
        edges={edges}
        userId={user?.id || null}
        onClose={() => setSelectedId(null)}
        onSelectNode={(id) => setSelectedId(id)}
        onBeginLinking={beginLinking}
        onOpenProject={(projectId) => {
          setSelectedId(null);
          setSelectedProjectId(projectId);
        }}
        onAfterEdit={(n) => {
          // Refetch the graph data so a renamed belief/concept/vault
          // item reads through to the 3D scene + the connected-neuron
          // rows in this panel without a hard reload.
          if (n.kind === "belief") {
            queryClient.invalidateQueries({ queryKey: ["mindmap_active_beliefs", user?.id] });
          } else if (n.kind === "concept") {
            queryClient.invalidateQueries({ queryKey: ["mindmap_concepts", user?.id] });
          } else if (n.kind === "vault") {
            queryClient.invalidateQueries({ queryKey: ["mindmap_vault_graph", user?.id] });
          }
        }}
        onAfterDelete={(n) => {
          if (n.kind === "belief") {
            queryClient.invalidateQueries({ queryKey: ["mindmap_active_beliefs", user?.id] });
          } else if (n.kind === "concept") {
            queryClient.invalidateQueries({ queryKey: ["mindmap_concepts", user?.id] });
            queryClient.invalidateQueries({ queryKey: ["mindmap_concept_links", user?.id] });
          } else if (n.kind === "neuron") {
            // Both AI-learned (synthesis profile) + manually-authored
            // facts share the same backing table; invalidate both
            // query keys so whichever pulled the row drops it.
            queryClient.invalidateQueries({ queryKey: ["mindmap_manual_facts", user?.id] });
            queryClient.invalidateQueries({ queryKey: ["mindmap_synthesis_profile", user?.id] });
          } else if (n.kind === "vault" || n.kind === "perspective") {
            queryClient.invalidateQueries({ queryKey: ["mindmap_vault_graph", user?.id] });
          }
        }}
      />

      {/* Project side panel — opens when the user picks a
          project in the "By Project" filter dropdown. Lives in
          the same right-side slot as NeuronPanel; only one is
          mounted at a time because the dropdown click clears the
          selected node and clicking a clustered neuron in the
          project panel closes the project panel and opens the
          neuron's panel. */}
      <ProjectPanel
        open={Boolean(selectedProject)}
        project={selectedProject}
        userId={user?.id}
        onClose={() => setSelectedProjectId(null)}
        onSelectNode={(id) => {
          // Jumping into a clustered neuron's detail surface:
          // close the project panel, open the standard
          // NeuronPanel for that node. The scene's
          // selectedId-driven camera fly will center on it.
          setSelectedProjectId(null);
          setSelectedId(id);
        }}
        // Full project list powers the in-panel "Merge into…"
        // target picker. The panel filters out the currently-
        // viewed project itself, so we just pass the unfiltered
        // list and let the picker do the right thing.
        allProjects={userProjects}
        // After a live merge: the source row is gone, so any
        // page-level pointer at it (the "By Project" filter, the
        // selected-panel pointer) needs to either redirect to the
        // target or clear. Bust the React Query cache so the
        // dropdown + scene re-render with the post-merge list.
        onMergeComplete={(sourceId, targetId) => {
          if (filterProjectId === sourceId) setFilterProjectId(targetId);
          setSelectedProjectId(null);
          queryClient.invalidateQueries({
            queryKey: ["lykn_projects", user?.id || "guest"],
          });
          queryClient.invalidateQueries({
            queryKey: ["lykn_project_state", user?.id || "guest"],
          });
        }}
        onAddNeurons={beginAddNeuronsToProject}
        onCreateNeuron={(projectId) => {
          // Re-use the SAME type-picker the "+" button at the
          // bottom-right exposes (Belief / Vault / Fact /
          // Concept / Chat). Clustering should never invent a
          // second creation surface — the user already knows
          // the "+" menu and the auto-add hook in the
          // pendingFormingNodeId watcher takes any neuron
          // produced while projectMode is true and ticks it
          // straight into the running cluster selection.
          //
          // We first flip the page into project ADD mode
          // anchored to this project so the auto-add knows
          // where the new neuron belongs.
          if (projectAddTargetId !== projectId) {
            beginAddNeuronsToProject(projectId);
          }
          setAddMenuOpen(true);
        }}
      />
    </div>
  );
}
