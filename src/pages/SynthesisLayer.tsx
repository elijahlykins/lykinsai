import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { useUserPlan } from "@/lib/useUserPlan";
import PlanGate from "@/components/PlanGate";
import { PLAN_LIMITS } from "@/lib/pricing-config";
import { useQuery } from "@tanstack/react-query";
import {
  Brain,
  ChevronDown,
  ExternalLink,
  FolderOpen,
  Hash,
  LayoutGrid,
  Lock,
  Network,
  PanelRightClose,
  StickyNote,
  Sparkles,
  Tag,
  ZoomIn,
  ZoomOut,
  Maximize2,
} from "lucide-react";
import { GridIcon } from "@/components/ui/GridIcon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import SynthesisScene3D from "@/pages/synthesis/SynthesisScene3D";
import {
  DEMO_PROJECTS,
  DEMO_BOARDS,
  DEMO_SYNTHESIS_PROFILE,
  DEMO_SYNTHESIS_NOTES,
  isDemoNodeId,
} from "@/lib/demoSynthesis";
import { isDemoGridId } from "@/lib/demoGrids";
import {
  hasPrototypeNeurons,
  readPrototypeChat,
  readPrototypeNeurons,
  readPrototypeStep,
  writePrototypeStep,
} from "@/lib/prototypeHandoff";

// Demo grid boards have real preview routes (see demoGrids.js), so they're
// navigable even though their ids match the `demo-*` pattern. Other demo
// node ids (projects, vault notes) still aren't navigable because their
// routes don't exist yet.
const isBlockedDemoId = (id: string | null | undefined): boolean => {
  if (!id) return true;
  // The synthetic prototype "First Conversation" grid is registered as a
  // demo-grid id (see demoGrids.js), so it routes through /grid/<id>
  // straight into OmniaGrid like any other demo board.
  if (isDemoGridId(id)) return false;
  return isDemoNodeId(id);
};


/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type NodeKind = "root" | "category" | "project" | "grid" | "vault" | "tag" | "neuron";

interface MindNode {
  id: string;
  label: string;
  kind: NodeKind;
  color: string;
  glow: string;
  radius: number;
  parentId: string | null;
  categoryId?: string;
  meta?: Record<string, any>;
}

interface MindEdge {
  from: string;
  to: string;
  cross?: boolean;
}

interface SimNode extends MindNode {
  x: number;
  y: number;
  /**
   * Depth axis for the 3D renderer. 2D layout still happens in (x, y); z is
   * assigned per-category in `simulateLayout` so categories sit on separate
   * planes and the graph reads as layered when orbited.
   */
  z: number;
  vx: number;
  vy: number;
  fixed?: boolean;
  connectionCount: number;
  relevance: number;
}

/* ------------------------------------------------------------------ */
/*  Palette                                                            */
/* ------------------------------------------------------------------ */

const palette = {
  root:     { bg: "#6366f1", glow: "rgba(99,102,241,0.35)" },
  projects: { bg: "#8b5cf6", glow: "rgba(139,92,246,0.30)" },
  grids:    { bg: "#3b82f6", glow: "rgba(59,130,246,0.30)" },
  vault:    { bg: "#10b981", glow: "rgba(16,185,129,0.30)" },
  tags:     { bg: "#f59e0b", glow: "rgba(245,158,11,0.30)" },
  neurons:  { bg: "#ec4899", glow: "rgba(236,72,153,0.30)" },
  project:  { bg: "#a78bfa", glow: "rgba(167,139,250,0.25)" },
  grid:     { bg: "#60a5fa", glow: "rgba(96,165,250,0.25)" },
  note:     { bg: "#34d399", glow: "rgba(52,211,153,0.25)" },
  tag:      { bg: "#fbbf24", glow: "rgba(251,191,36,0.25)" },
  neuron:   { bg: "#f472b6", glow: "rgba(244,114,182,0.25)" },
};

/* ------------------------------------------------------------------ */
/*  Build graph                                                        */
/* ------------------------------------------------------------------ */

type NoteRow = { id: string; title?: string; content: string; tags?: string[]; ai_summary?: string | null; ai_signals?: any };

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
  projects: { id: string; name: string }[],
  boards: { id: string; title: string; project_id?: string | null }[],
  notes: NoteRow[],
  synthesisThemes: string[],
  synthesis: SynthesisData | null,
  vaultGridMap: Map<string, Set<string>>,
  // Optional: categories that should always appear even if they have no
  // children. Used by the landing prototype so a brand-new guest sees the
  // shell of their future workspace (Projects / Grids / Vault / Tags)
  // sitting empty alongside the neurons they've just created.
  forceCategoryIds: Set<string> = new Set(),
  // Optional: override the label on the root "Your Mind" node. Used by the
  // landing prototype handoff to render the root as "Your Synthesis Layer".
  rootLabel: string = "Your Mind",
) {
  const nodes: MindNode[] = [];
  const edges: MindEdge[] = [];

  const rootId = "__root__";
  nodes.push({ id: rootId, label: rootLabel, kind: "root", radius: 42, color: palette.root.bg, glow: palette.root.glow, parentId: null, meta: { narrative: synthesis?.narrative } });

  const cats: { id: string; label: string; color: string; glow: string }[] = [];
  if (projects.length > 0 || forceCategoryIds.has("__cat_projects__")) cats.push({ id: "__cat_projects__", label: "Projects", color: palette.projects.bg, glow: palette.projects.glow });
  if (boards.length > 0 || forceCategoryIds.has("__cat_grids__")) cats.push({ id: "__cat_grids__", label: "Grids", color: palette.grids.bg, glow: palette.grids.glow });
  if (notes.length > 0 || forceCategoryIds.has("__cat_vault__")) cats.push({ id: "__cat_vault__", label: "Vault", color: palette.vault.bg, glow: palette.vault.glow });

  const allTags = new Set<string>();
  notes.forEach((n) => (n.tags || []).forEach((t) => allTags.add(t)));
  if (allTags.size > 0 || forceCategoryIds.has("__cat_tags__")) cats.push({ id: "__cat_tags__", label: "Tags", color: palette.tags.bg, glow: palette.tags.glow });

  cats.forEach((c) => {
    nodes.push({ id: c.id, label: c.label, kind: "category", radius: 30, color: c.color, glow: c.glow, parentId: rootId });
    edges.push({ from: rootId, to: c.id });
  });

  projects.forEach((p) => {
    const nid = `project_${p.id}`;
    nodes.push({ id: nid, label: p.name || "Untitled", kind: "project", radius: 20, color: palette.project.bg, glow: palette.project.glow, parentId: "__cat_projects__", categoryId: "__cat_projects__", meta: { projectId: p.id } });
    edges.push({ from: "__cat_projects__", to: nid });
  });

  boards.forEach((b) => {
    const nid = `grid_${b.id}`;
    nodes.push({ id: nid, label: b.title || "New Grid", kind: "grid", radius: 20, color: palette.grid.bg, glow: palette.grid.glow, parentId: "__cat_grids__", categoryId: "__cat_grids__", meta: { boardId: b.id, projectId: b.project_id } });
    edges.push({ from: "__cat_grids__", to: nid });
    if (b.project_id && nodes.some((n) => n.id === `project_${b.project_id}`)) {
      edges.push({ from: `project_${b.project_id}`, to: nid, cross: true });
    }
  });

  // Build per-note theme map for cross-linking
  const noteThemeMap = new Map<string, string[]>();
  notes.forEach((n) => {
    const themes = extractNoteThemes(n);
    noteThemeMap.set(n.id, themes);
  });

  notes.forEach((n) => {
    const nid = `vault_${n.id}`;
    const preview = (n.content || "").replace(/\[ATTACHMENTS_JSON:[\s\S]*?\]/, "").slice(0, 60).trim() || "Note";
    const noteThemes = noteThemeMap.get(n.id) || [];
    nodes.push({ id: nid, label: preview, kind: "vault", radius: 18, color: palette.note.bg, glow: palette.note.glow, parentId: "__cat_vault__", categoryId: "__cat_vault__", meta: { noteId: n.id, title: n.title, content: n.content, tags: n.tags, ai_summary: n.ai_summary, themes: noteThemes } });
    edges.push({ from: "__cat_vault__", to: nid });
  });

  const tagArr = Array.from(allTags);
  tagArr.forEach((tag) => {
    const nid = `tag_${tag}`;
    nodes.push({ id: nid, label: `#${tag}`, kind: "tag", radius: 18, color: palette.tag.bg, glow: palette.tag.glow, parentId: "__cat_tags__", categoryId: "__cat_tags__", meta: { tag } });
    edges.push({ from: "__cat_tags__", to: nid });
    notes.forEach((n) => {
      if ((n.tags || []).includes(tag)) edges.push({ from: nid, to: `vault_${n.id}`, cross: true });
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

  if (neuronItems.length > 0) {
    cats.push({ id: "__cat_neurons__", label: "AI Learned", color: palette.neurons.bg, glow: palette.neurons.glow });
  }

  // (categories were already pushed above, but neurons cat needs to go in too)
  if (neuronItems.length > 0 && !nodes.some((n) => n.id === "__cat_neurons__")) {
    nodes.push({ id: "__cat_neurons__", label: "AI Learned", kind: "category", radius: 30, color: palette.neurons.bg, glow: palette.neurons.glow, parentId: rootId });
    edges.push({ from: rootId, to: "__cat_neurons__" });
  }

  const neuronNodeIds = new Set<string>();
  neuronItems.forEach((ni) => {
    if (neuronNodeIds.has(ni.id)) return;
    neuronNodeIds.add(ni.id);
    const kindLabel = ni.kind === "theme" ? "Theme" : ni.kind === "goal" ? "Goal" : ni.kind === "topic" ? "Topic" : "Pattern";
    nodes.push({
      id: ni.id, label: ni.label, kind: "neuron", radius: 16,
      color: palette.neuron.bg, glow: palette.neuron.glow,
      parentId: "__cat_neurons__", categoryId: "__cat_neurons__",
      meta: { neuronKind: ni.kind, source: ni.source, kindLabel },
    });
    edges.push({ from: "__cat_neurons__", to: ni.id });

    // Cross-link neurons to notes/boards/projects/tags that relate to this theme
    const term = ni.label.toLowerCase();

    notes.forEach((n) => {
      const noteThemes = noteThemeMap.get(n.id) || [];
      const noteTags = (n.tags || []).map((t) => t.toLowerCase());
      const content = ((n.content || "").toLowerCase());
      if (noteThemes.includes(term) || noteTags.includes(term) || content.includes(term)) {
        edges.push({ from: ni.id, to: `vault_${n.id}`, cross: true });
      }
    });

    boards.forEach((b) => {
      if ((b.title || "").toLowerCase().includes(term)) {
        edges.push({ from: ni.id, to: `grid_${b.id}`, cross: true });
      }
    });

    projects.forEach((p) => {
      if ((p.name || "").toLowerCase().includes(term)) {
        edges.push({ from: ni.id, to: `project_${p.id}`, cross: true });
      }
    });

    tagArr.forEach((tag) => {
      if (tag.toLowerCase().includes(term) || term.includes(tag.toLowerCase())) {
        edges.push({ from: ni.id, to: `tag_${tag}`, cross: true });
      }
    });
  });

  // Thematic cross-links: connect items that share synthesis themes
  // Link notes to boards if a note's themes appear in a board's title
  const boardTitleLower = new Map(boards.map((b) => [`grid_${b.id}`, (b.title || "").toLowerCase()]));
  const projectNameLower = new Map(projects.map((p) => [`project_${p.id}`, (p.name || "").toLowerCase()]));
  const edgeSet = new Set(edges.map((e) => `${e.from}__${e.to}`));
  const addCrossEdge = (from: string, to: string) => {
    const key = `${from}__${to}`;
    const keyRev = `${to}__${from}`;
    if (!edgeSet.has(key) && !edgeSet.has(keyRev) && from !== to) {
      edgeSet.add(key);
      edges.push({ from, to, cross: true });
    }
  };

  notes.forEach((n) => {
    const themes = noteThemeMap.get(n.id) || [];
    const noteId = `vault_${n.id}`;
    const noteContent = (n.content || "").toLowerCase();
    const noteSummary = (n.ai_summary || "").toLowerCase();

    // Synthesis-chunk–based vault→grid edges
    const linkedBoards = vaultGridMap.get(n.id);
    if (linkedBoards) {
      linkedBoards.forEach((boardId) => {
        const gridNodeId = `grid_${boardId}`;
        if (nodes.some((nd) => nd.id === gridNodeId)) addCrossEdge(noteId, gridNodeId);
      });
    }

    // Connect to boards whose titles appear in note content/summary/themes
    boardTitleLower.forEach((title, boardNodeId) => {
      if (title.length < 3) return;
      const titleWords = title.split(/\s+/).filter((w) => w.length > 2);
      const titleMatch = titleWords.length > 0 && titleWords.every((w) => noteContent.includes(w));
      if (
        titleMatch ||
        (noteSummary && titleWords.length > 0 && titleWords.every((w) => noteSummary.includes(w))) ||
        themes.some((t) => title.includes(t) || t.includes(title.split(" ")[0]))
      ) {
        addCrossEdge(noteId, boardNodeId);
      }
    });

    // Connect to projects whose names overlap with note themes/content
    projectNameLower.forEach((name, projNodeId) => {
      if (name.length < 3) return;
      const nameWords = name.split(/\s+/).filter((w) => w.length > 2);
      if (
        (nameWords.length > 0 && nameWords.every((w) => noteContent.includes(w))) ||
        themes.some((t) => name.includes(t) || t.includes(name.split(" ")[0]))
      ) {
        addCrossEdge(noteId, projNodeId);
      }
    });
  });

  // Connect notes that share themes with each other
  const noteIds = notes.map((n) => n.id);
  for (let i = 0; i < noteIds.length; i++) {
    const themesA = noteThemeMap.get(noteIds[i]) || [];
    if (themesA.length === 0) continue;
    for (let j = i + 1; j < noteIds.length; j++) {
      const themesB = noteThemeMap.get(noteIds[j]) || [];
      if (themesA.some((t) => themesB.includes(t))) {
        addCrossEdge(`vault_${noteIds[i]}`, `vault_${noteIds[j]}`);
      }
    }
  }

  // Connect boards that share themes (via notes linked to them)
  // If two boards are in the same project, they're already connected — skip
  // Instead connect boards whose linked notes share themes
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

  return { nodes, edges };
}

/* ------------------------------------------------------------------ */
/*  Layout modes                                                       */
/* ------------------------------------------------------------------ */

type LayoutMode = "connections" | "section" | "topic";

const layoutModes: { id: LayoutMode; label: string; icon: typeof Network }[] = [
  { id: "connections", label: "Most Connected", icon: Network },
  { id: "section",     label: "By Section",     icon: LayoutGrid },
  { id: "topic",       label: "By Idea",        icon: Sparkles },
];

/* ------------------------------------------------------------------ */
/*  Force simulation with layout-mode–aware seeding                    */
/* ------------------------------------------------------------------ */

function computeIdeaRelevance(nodes: MindNode[], edges: MindEdge[], idea: string): Map<string, number> {
  const il = idea.toLowerCase();
  const scores = new Map<string, number>();

  nodes.forEach((n) => {
    if (n.kind === "root" || n.kind === "category") { scores.set(n.id, 1); return; }

    let score = 0;
    if (n.kind === "vault") {
      const themes: string[] = n.meta?.themes || [];
      const tags: string[] = (n.meta?.tags || []).map((t: string) => t.toLowerCase());
      const content = ((n.meta?.content || "") as string).toLowerCase();
      const summary = ((n.meta?.ai_summary || "") as string).toLowerCase();
      if (themes.includes(il)) score = 1;
      else if (tags.includes(il)) score = 0.9;
      else if (summary.includes(il)) score = 0.8;
      else if (content.includes(il)) score = 0.7;
    } else if (n.kind === "grid") {
      const title = n.label.toLowerCase();
      if (title.includes(il) || il.includes(title.split(" ")[0])) score = 1;
    } else if (n.kind === "project") {
      const name = n.label.toLowerCase();
      if (name.includes(il) || il.includes(name.split(" ")[0])) score = 0.9;
    } else if (n.kind === "tag") {
      const tag = (n.meta?.tag || "").toLowerCase();
      if (tag === il) score = 1;
      else if (tag.includes(il) || il.includes(tag)) score = 0.85;
    } else if (n.kind === "neuron") {
      if (n.label.toLowerCase().includes(il) || il.includes(n.label.toLowerCase())) score = 0.95;
    }
    scores.set(n.id, score);
  });

  // Propagate: 1-hop neighbours of direct matches get a boost
  const adj = new Map<string, Set<string>>();
  nodes.forEach((n) => adj.set(n.id, new Set()));
  edges.forEach((e) => { adj.get(e.from)?.add(e.to); adj.get(e.to)?.add(e.from); });

  const directIds = new Set<string>();
  scores.forEach((s, id) => { if (s >= 0.7) directIds.add(id); });

  // 1-hop
  const hop1 = new Set<string>();
  directIds.forEach((id) => adj.get(id)?.forEach((nb) => { if (!directIds.has(nb)) hop1.add(nb); }));
  hop1.forEach((id) => { const cur = scores.get(id) || 0; scores.set(id, Math.max(cur, 0.45)); });

  // 2-hop
  hop1.forEach((id) => adj.get(id)?.forEach((nb) => {
    if (!directIds.has(nb) && !hop1.has(nb)) {
      const cur = scores.get(nb) || 0;
      scores.set(nb, Math.max(cur, 0.2));
    }
  }));

  return scores;
}

function simulateLayout(
  nodes: MindNode[],
  edges: MindEdge[],
  cx: number,
  cy: number,
  mode: LayoutMode,
  filterTag: string | null,
): SimNode[] {
  const connCount = new Map<string, number>();
  nodes.forEach((n) => connCount.set(n.id, 0));
  edges.forEach((e) => {
    connCount.set(e.from, (connCount.get(e.from) || 0) + 1);
    connCount.set(e.to, (connCount.get(e.to) || 0) + 1);
  });
  const maxConn = Math.max(1, ...connCount.values());

  /* Relevance map for "By Idea" mode */
  const relevanceMap = (mode === "topic" && filterTag)
    ? computeIdeaRelevance(nodes, edges, filterTag)
    : null;

  const filtered = nodes;

  const catAngle = new Map<string, number>();
  const catArr = filtered.filter((n) => n.kind === "category");
  const catSpread = (2 * Math.PI) / Math.max(catArr.length, 1);
  catArr.forEach((c, i) => catAngle.set(c.id, -Math.PI / 2 + i * catSpread));

  // Depth assignment for the 3D renderer. The simulation itself is still 2D
  // (operates only on x/y), so z is composed deterministically from a few
  // signals so it stays stable across re-renders and reads as a real 3D
  // cloud — not a stack of category-shaped pancakes — from any orbit angle.
  //
  // Total depth (~Z_SPAN) is roughly comparable to the in-plane extent so
  // looking at the graph from the side feels as deep as looking at it from
  // the front feels wide. Each node's z is the sum of:
  //   • category base    — categories spread along z, but only loosely so
  //                        they don't visually segregate into hard layers
  //   • kind offset      — neurons forward, tags back (semantic depth)
  //   • per-id stable    — large hash-driven jitter so siblings within a
  //     jitter           category form a 3D cloud, not a co-planar disk
  //   • angular bias     — nodes on opposite sides of root push opposite
  //                        directions in z, so the graph feels twisted
  //                        through depth instead of fanned out flat
  //   • hub bias         — highly-connected nodes pop slightly forward so
  //                        the busiest neurons read on top in any view
  const Z_SPAN = 900; // total depth range across all categories
  const catZ = new Map<string, number>();
  catArr.forEach((c, i) => {
    if (catArr.length <= 1) {
      catZ.set(c.id, 0);
    } else {
      const t = i / (catArr.length - 1); // 0..1
      // Soften category layering: categories sit at ±40% of Z_SPAN rather
      // than ±50%, leaving room for child jitter to spill across category
      // bands without nodes piling up at the front/back walls.
      catZ.set(c.id, (t - 0.5) * Z_SPAN * 0.8);
    }
  });
  const kindZOffset: Record<string, number> = {
    neuron: 90,
    project: 45,
    grid: 0,
    vault: -30,
    tag: -80,
    category: 0,
    root: 0,
  };
  const childZNoise = 260; // ± per-child stable jitter — drives the depth feel

  /* Per-category child counters for section mode */
  const catChildIdx = new Map<string, number>();
  const catChildCount = new Map<string, number>();
  if (mode === "section") {
    filtered.forEach((n) => {
      if (n.categoryId) catChildCount.set(n.categoryId, (catChildCount.get(n.categoryId) || 0) + 1);
    });
  }

  // Deterministic per-id jitter for z so the simulation iterations don't
  // re-roll z each pass (would cause depth flicker on hover/re-render).
  const idHash = (s: string): number => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  };
  const stableZJitter = (id: string): number => {
    const h = idHash(id);
    return ((h % 2000) / 2000 - 0.5) * 2 * childZNoise;
  };
  // 0..1 deterministic hash. Used in place of Math.random() for in-plane
  // jitter so the same node id always lands at the same position across
  // re-renders / memo recomputes.
  const idHash01 = (s: string): number => {
    const h = idHash(s);
    return ((h >>> 0) % 100000) / 100000;
  };
  // Map a category's angle around root into a z bias. Categories at angle 0
  // (right of root) push back, those at angle π (left) push forward, so the
  // graph corkscrews through depth instead of fanning out flat. Children
  // inherit a fraction of their parent category's angular bias.
  const angleZBias = (angle: number): number => Math.cos(angle) * (Z_SPAN * 0.18);
  const hubZBias = (cc: number): number => Math.min(1, cc / 8) * 70;

  const zForNode = (n: MindNode): number => {
    if (n.kind === "root") return 0;
    if (n.kind === "category") {
      const base = catZ.get(n.id) ?? 0;
      return base + angleZBias(catAngle.get(n.id) ?? 0);
    }
    const parentZ = catZ.get(n.categoryId || "") ?? 0;
    const offset = kindZOffset[n.kind] ?? 0;
    const angularBias = angleZBias(catAngle.get(n.categoryId || "") ?? 0) * 0.6;
    const hub = hubZBias(connCount.get(n.id) || 0);
    return parentZ + offset + stableZJitter(n.id) + angularBias + hub;
  };

  const simNodes: SimNode[] = filtered.map((n) => {
    const cc = connCount.get(n.id) || 0;
    const ratio = cc / maxConn;
    const relevance = relevanceMap?.get(n.id) ?? 1;
    const z = zForNode(n);

    if (n.kind === "root") {
      return { ...n, x: cx, y: cy, z, vx: 0, vy: 0, fixed: true, connectionCount: cc, relevance: 1 };
    }

    if (n.kind === "category") {
      const angle = catAngle.get(n.id) || 0;
      const dist = mode === "section" ? 220 : mode === "topic" ? 140 : 160;
      return { ...n, x: cx + Math.cos(angle) * dist, y: cy + Math.sin(angle) * dist, z, vx: 0, vy: 0, fixed: mode === "section", connectionCount: cc, relevance };
    }

    const parentAngle = catAngle.get(n.categoryId || "") || 0;

    if (mode === "section") {
      const idx = catChildIdx.get(n.categoryId || "") || 0;
      catChildIdx.set(n.categoryId || "", idx + 1);
      const total = catChildCount.get(n.categoryId || "") || 1;
      const arcSpan = Math.min(Math.PI * 0.8, total * 0.22);
      const angle = parentAngle - arcSpan / 2 + (idx / Math.max(total - 1, 1)) * arcSpan;
      const ring = Math.floor(idx / 10);
      const dist = 120 + ring * 80;
      const catNode = filtered.find((f) => f.id === n.categoryId);
      const catX = catNode ? cx + Math.cos(parentAngle) * 220 : cx;
      const catY = catNode ? cy + Math.sin(parentAngle) * 220 : cy;
      return { ...n, x: catX + Math.cos(angle) * dist, y: catY + Math.sin(angle) * dist, z, vx: 0, vy: 0, fixed: false, connectionCount: cc, relevance };
    }

    if (mode === "topic" && relevanceMap) {
      // Position by relevance: high relevance → close to center, low → far out.
      // Jitter derived from the node id (NOT Math.random) so re-running the
      // simulation produces identical positions — otherwise nodes would
      // teleport to fresh coords on every memo recompute, which reads as
      // the focal neuron "bouncing" on hover/zoom.
      const jitter = (idHash01(n.id) - 0.5) * 1.6;
      const angle = parentAngle + jitter;
      const minDist = 100;
      const maxDist = 600;
      const dist = maxDist - relevance * (maxDist - minDist) + (idHash01(n.id + "_d") - 0.5) * 40;
      return { ...n, x: cx + Math.cos(angle) * dist, y: cy + Math.sin(angle) * dist, z, vx: 0, vy: 0, fixed: false, connectionCount: cc, relevance };
    }

    // connections mode: connection-weighted distance. Same deterministic
    // jitter strategy as the topic-mode branch above.
    const jitter = (idHash01(n.id) - 0.5) * 1.2;
    const angle = parentAngle + jitter;
    const minDist = 200;
    const maxDist = 500;
    const dist = maxDist - ratio * (maxDist - minDist) + (idHash01(n.id + "_d") - 0.5) * 60;
    return { ...n, x: cx + Math.cos(angle) * dist, y: cy + Math.sin(angle) * dist, z, vx: 0, vy: 0, fixed: false, connectionCount: cc, relevance: 1 };
  });

  /* Only simulate edges between visible nodes */
  const visibleIds = new Set(simNodes.map((n) => n.id));
  const simEdges = edges.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to));
  const map = new Map(simNodes.map((n) => [n.id, n]));

  const REPULSION = mode === "section" ? 5000 : mode === "topic" ? 6000 : 8000;
  const EDGE_ATTRACTION = 0.001;
  const DAMPING = 0.85;
  const ITERATIONS = 100;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (let i = 0; i < simNodes.length; i++) {
      const a = simNodes[i];
      if (a.fixed) continue;
      for (let j = i + 1; j < simNodes.length; j++) {
        const b = simNodes[j];
        if (b.fixed) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = REPULSION / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }

    for (const edge of simEdges) {
      const a = map.get(edge.from);
      const b = map.get(edge.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = edge.cross ? 200 : (mode === "section" ? 100 : 140);
      const force = (dist - target) * EDGE_ATTRACTION;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (!a.fixed) { a.vx += fx; a.vy += fy; }
      if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
    }

    for (const node of simNodes) {
      if (node.fixed) continue;
      if (mode === "section") {
        const parent = map.get(node.categoryId || node.parentId || "");
        if (parent) {
          node.vx += (parent.x - node.x) * 0.0008;
          node.vy += (parent.y - node.y) * 0.0008;
        }
      } else if (mode === "topic") {
        // Strong pull toward center for high-relevance nodes, weak for low
        const strength = 0.0003 + node.relevance * 0.002;
        node.vx += (cx - node.x) * strength;
        node.vy += (cy - node.y) * strength;
      } else {
        const ratio = node.connectionCount / maxConn;
        const strength = 0.0002 + ratio * 0.0012;
        node.vx += (cx - node.x) * strength;
        node.vy += (cy - node.y) * strength;
      }
      node.vx *= DAMPING;
      node.vy *= DAMPING;
      node.x += node.vx;
      node.y += node.vy;
    }
  }

  return simNodes;
}

/* ------------------------------------------------------------------ */
/*  (SVG renderer helpers — edgePath / NodeIcon / catIcon — were      */
/*  removed when the visualisation moved to react-three-fiber. The 3D  */
/*  scene draws straight 3D lines and uses sphere primitives in place  */
/*  of in-node icons; legend + sidebar still cover icon affordance.)   */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Welcome panel (typewriter intro)                                   */
/* ------------------------------------------------------------------ */

const WELCOME_TEXT = `Welcome to the Synthesis Layer.\n\nThe Synthesis Layer is a living visualization of how LYKN is forming connections across everything you create — grids, projects, vault notes, tags, and conversations.\n\nEvery time the AI identifies a new pattern, recognizes a recurring theme, or surfaces an insight from your work, it creates a neuron — a visible node on this map that represents something the system has learned about you.\n\nThe closer a node sits to the center, the more deeply connected it is to your broader body of work. Cross-connections reveal how your ideas relate to each other — often in ways you might not expect.\n\nClick any node to inspect it.`;

function WelcomePanel({ onClose, neurons, onSelectNode }: { onClose: () => void; neurons: MindNode[]; onSelectNode: (id: string) => void }) {
  const [charCount, setCharCount] = useState(0);
  const mountTime = useRef(Date.now());

  useEffect(() => {
    let raf: number;
    const tick = () => {
      const elapsed = Date.now() - mountTime.current;
      const count = Math.min(WELCOME_TEXT.length, Math.floor(elapsed / 16));
      setCharCount(count);
      if (count < WELCOME_TEXT.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <motion.div
      initial={{ x: 380, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 380, opacity: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="absolute top-0 right-0 z-30 h-full w-[360px] border-l border-white/8 flex flex-col"
      style={{ backgroundColor: "rgba(12,12,22,0.82)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)" }}
      data-stop-canvas-wheel="true"
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-end px-5 pt-5 pb-3">
        <button onClick={onClose} className="w-6 h-6 rounded-md hover:bg-white/8 flex items-center justify-center transition-colors">
          <PanelRightClose size={15} className="text-gray-400" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-6 pt-2">
        <div className="text-[0.75rem] text-gray-500 dark:text-gray-400 leading-relaxed">
          {WELCOME_TEXT.slice(0, charCount).split("\n\n").map((para, i, arr) => {
            const isFirst = i === 0;
            const isLast = i === arr.length - 1;
            const isCta = charCount >= WELCOME_TEXT.length && isLast;
            return (
              <p key={i} className={`mb-3 ${isFirst ? "text-[0.9375rem] font-semibold text-gray-800 dark:text-gray-100" : ""} ${isCta ? "text-[0.6875rem] font-medium text-blue-300 dark:text-blue-300" : ""}`}>
                {para}
                {isLast && charCount < WELCOME_TEXT.length && (
                  <span className="inline-block w-[2px] h-[0.9em] bg-gray-400 dark:bg-gray-500 ml-0.5 animate-pulse align-text-bottom" />
                )}
              </p>
            );
          })}
        </div>

        {neurons.length > 0 && (
          <div className="mt-6">
            <p className="text-[0.6875rem] font-medium text-gray-500 dark:text-gray-400 mb-2.5">Recent Neurons</p>
            <div className="flex flex-col gap-1">
              {neurons.slice(0, 12).map((n) => (
                <button
                  key={n.id}
                  onClick={() => onSelectNode(n.id)}
                  className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md bg-black/[0.02] dark:bg-white/[0.03] hover:bg-pink-50 dark:hover:bg-pink-900/15 transition-colors text-left w-full"
                >
                  <Sparkles size={11} className="text-pink-400 flex-shrink-0" />
                  <span className="text-[0.6875rem] text-gray-600 dark:text-gray-300 truncate flex-1">{n.label}</span>
                  <span className="text-[0.575rem] text-gray-400 dark:text-gray-500 capitalize">{n.meta?.kindLabel || "Insight"}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Vault content parser                                               */
/* ------------------------------------------------------------------ */

function parseVaultContent(raw: string): { body: string; attachments: any[] } {
  const marker = "[ATTACHMENTS_JSON:";
  const start = raw.indexOf(marker);
  if (start === -1) return { body: raw.trim(), attachments: [] };
  const body = raw.slice(0, start).trim();
  try {
    const jsonStart = start + marker.length;
    let depth = 0;
    let jsonEnd = jsonStart;
    for (let i = jsonStart; i < raw.length; i++) {
      if (raw[i] === "[") depth++;
      else if (raw[i] === "]") {
        depth--;
        if (depth === 0) { jsonEnd = i; break; }
      }
    }
    const json = raw.slice(jsonStart, jsonEnd + 1);
    return { body, attachments: JSON.parse(json) };
  } catch {
    return { body, attachments: [] };
  }
}

function resolveStorageTarget(att: any): { bucket: string; path: string } | null {
  const explicitPath = String(att.storagePath || "").trim();
  if (explicitPath) return { bucket: String(att.storageBucket || "user-files").trim() || "user-files", path: explicitPath };
  const url = String(att.url || "").trim();
  if (!url || url.startsWith("data:")) return null;
  try {
    const parsed = new URL(url);
    const p = parsed.pathname || "";
    const pubMatch = p.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
    if (pubMatch) return { bucket: decodeURIComponent(pubMatch[1]), path: decodeURIComponent(pubMatch[2]) };
    const sigMatch = p.match(/\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
    if (sigMatch) return { bucket: decodeURIComponent(sigMatch[1]), path: decodeURIComponent(sigMatch[2].split("?")[0]) };
  } catch { /* not a URL */ }
  return null;
}

function VaultAttachment({ att }: { att: any }) {
  const type = String(att.type || "").toLowerCase();
  const rawUrl = String(att.url || "").trim();
  const name = String(att.name || att.title || "").trim();
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const storageTarget = useMemo(() => resolveStorageTarget(att), [att]);
  const needsSigning = !!storageTarget && rawUrl.includes("supabase.co/storage/");
  const displayUrl = signedUrl || rawUrl;

  useEffect(() => {
    if (!needsSigning || !storageTarget) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.storage.from(storageTarget.bucket).createSignedUrl(storageTarget.path, 60 * 60 * 24);
        if (!cancelled && data?.signedUrl) setSignedUrl(data.signedUrl);
        else if (!cancelled) setFailed(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [needsSigning, storageTarget]);

  if (type === "image") {
    if (needsSigning && !signedUrl) {
      if (failed) return (
        <div className="rounded-lg border border-black/5 dark:border-white/8 bg-black/[0.02] dark:bg-white/[0.03] p-4 flex items-center justify-center">
          <span className="text-[0.6875rem] text-gray-400">Image unavailable</span>
        </div>
      );
      return (
        <div className="rounded-lg border border-black/5 dark:border-white/8 bg-black/[0.02] dark:bg-white/[0.03] h-[120px] flex items-center justify-center animate-pulse">
          <span className="text-[0.625rem] text-gray-400">Loading…</span>
        </div>
      );
    }
    return (
      <div className="rounded-lg overflow-hidden border border-black/5 dark:border-white/8">
        <img src={displayUrl} alt={name} className="w-full max-h-[240px] object-cover" loading="lazy" />
        {name && <p className="text-[0.625rem] text-gray-400 dark:text-gray-500 px-2 py-1 truncate">{name}</p>}
      </div>
    );
  }

  if (type === "video" && !att.videoId) {
    if (needsSigning && !signedUrl && !failed) {
      return (
        <div className="rounded-lg border border-black/5 dark:border-white/8 bg-black/[0.02] dark:bg-white/[0.03] h-[120px] flex items-center justify-center animate-pulse">
          <span className="text-[0.625rem] text-gray-400">Loading…</span>
        </div>
      );
    }
    if (displayUrl) {
      return (
        <div className="rounded-lg overflow-hidden border border-black/5 dark:border-white/8">
          <video src={displayUrl} controls playsInline preload="metadata" className="w-full max-h-[200px]" />
          {name && <p className="text-[0.625rem] text-gray-400 dark:text-gray-500 px-2 py-1 truncate">{name}</p>}
        </div>
      );
    }
  }

  if ((type === "youtube" || att.videoId) && (att.videoId || rawUrl)) {
    const videoId = att.videoId || rawUrl.match(/(?:youtu\.be\/|v=)([^&\s]+)/)?.[1];
    if (videoId) {
      return (
        <div className="rounded-lg overflow-hidden border border-black/5 dark:border-white/8">
          <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
            <iframe
              src={`https://www.youtube.com/embed/${videoId}`}
              className="absolute inset-0 w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope"
              allowFullScreen
            />
          </div>
          {name && <p className="text-[0.625rem] text-gray-400 dark:text-gray-500 px-2 py-1 truncate">{name}</p>}
        </div>
      );
    }
  }

  if ((type === "bookmark" || type === "link") && rawUrl) {
    return (
      <a
        href={rawUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 px-3 py-2 rounded-lg border border-black/5 dark:border-white/8 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
      >
        <ExternalLink size={12} className="text-blue-400 flex-shrink-0" />
        <span className="text-[0.6875rem] text-blue-500 dark:text-blue-400 truncate">{name || rawUrl}</span>
      </a>
    );
  }

  if (type === "spreadsheet") {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-black/5 dark:border-white/8 bg-black/[0.02] dark:bg-white/[0.03]">
        <LayoutGrid size={12} className="text-emerald-400 flex-shrink-0" />
        <span className="text-[0.6875rem] text-gray-600 dark:text-gray-300 truncate">{name || "Spreadsheet"}</span>
        {att.rows && att.cols && <span className="text-[0.575rem] text-gray-400 ml-auto">{att.rows}×{att.cols}</span>}
      </div>
    );
  }

  if (rawUrl) {
    return (
      <a
        href={rawUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 px-3 py-2 rounded-lg border border-black/5 dark:border-white/8 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
      >
        <ExternalLink size={12} className="text-gray-400 flex-shrink-0" />
        <span className="text-[0.6875rem] text-gray-600 dark:text-gray-300 truncate">{name || rawUrl}</span>
      </a>
    );
  }

  return null;
}

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
  prototypeChat,
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
   * Landing-prototype handoff: the saved transcript of the first chat.
   * Rendered inline when the user clicks the synthetic
   * "First Conversation" grid (since it has no real /grid route).
   */
  prototypeChat?: { role: "user" | "ai"; content: string }[];
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

  // Demo grid/project nodes never hit the DB, so we can't navigate to
  // their detail pages (they'd 404 or show an empty grid). The Vault page
  // is always valid — guests see the preloaded demo vault there.
  const boardId = node.meta?.boardId as string | undefined;
  const projectId = node.meta?.projectId as string | undefined;
  const navPath = node.kind === "grid" && boardId && !isBlockedDemoId(boardId)
    ? `/grid/${boardId}`
    : node.kind === "project" && projectId && !isBlockedDemoId(projectId)
    ? `/project/${projectId}`
    : node.kind === "vault"
    ? "/vault"
    : null;

  const vaultParsed = useMemo(() => {
    if (node.kind !== "vault") return null;
    return parseVaultContent(String(node.meta?.content || ""));
  }, [node]);

  const contentPreview = node.kind === "vault"
    ? (vaultParsed?.body || null)
    : node.meta?.content
      ? (node.meta.content as string).replace(/\[ATTACHMENTS_JSON:[\s\S]*?\]/, "").trim()
      : null;

  const tags: string[] = node.meta?.tags || [];

  return (
    <motion.div
      initial={{ x: 380, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 380, opacity: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="absolute top-0 right-0 z-30 h-full w-[360px] border-l border-white/8 flex flex-col"
      style={{ backgroundColor: "rgba(12,12,22,0.82)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)" }}
      data-stop-canvas-wheel="true"
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-3 px-5 pt-5 pb-3">
        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: node.color }} />
        <span className={`text-xs font-semibold flex-1 truncate ${
          isPrototypeNeuron
            ? "text-pink-300 normal-case tracking-wide"
            : "text-gray-700 dark:text-gray-200 capitalize"
        }`}>
          {isPrototypeNeuron
            ? `${ordinalLabel(prototypeOrdinal || 1)} neuron created`
            : node.kind === "category" ? node.label : node.kind}
        </span>
        <button onClick={onClose} className="w-6 h-6 rounded-md hover:bg-black/5 dark:hover:bg-white/8 flex items-center justify-center transition-colors">
          <PanelRightClose size={15} className="text-gray-400" />
        </button>
      </div>

      <div className="px-5 pb-4">
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100 leading-snug break-words">
          {isPrototypeChatGrid
            ? "First Conversation"
            : node.kind === "vault" && node.meta?.title ? node.meta.title as string : node.label}
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

        {/* Vault view mode */}
        {node.kind === "vault" && (
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
                  <p className="text-[0.6875rem] font-medium text-gray-500 dark:text-gray-400 mb-2">Found in Grids</p>
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

        {node.kind === "grid" && node.meta?.projectId && (
          <div className="mb-4">
            <p className="text-[0.6875rem] font-medium text-gray-500 dark:text-gray-400 mb-1">Project</p>
            <p className="text-[0.75rem] text-gray-600 dark:text-gray-300">
              {allNodes.find((n) => n.id === `project_${node.meta!.projectId}`)?.label || "Unknown"}
            </p>
          </div>
        )}

        {node.kind === "category" && (
          <div className="mb-4">
            <p className="text-[0.6875rem] font-medium text-gray-500 dark:text-gray-400 mb-1">
              Contains {allNodes.filter((n) => n.categoryId === node.id).length} items
            </p>
          </div>
        )}

        {node.kind === "neuron" && (() => {
          const kind = node.meta?.neuronKind as string || "pattern";
          const source = node.meta?.source as string || "";
          const connectedVault = connected.filter((c) => c.kind === "vault");
          const connectedGrids = connected.filter((c) => c.kind === "grid");
          const connectedProjects = connected.filter((c) => c.kind === "project");
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
                  <p className="text-[0.625rem] font-medium text-gray-400 dark:text-gray-500 mb-1.5 uppercase tracking-wider">Related Grids</p>
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

              {connectedProjects.length > 0 && (
                <div className="mb-3">
                  <p className="text-[0.625rem] font-medium text-gray-400 dark:text-gray-500 mb-1.5 uppercase tracking-wider">Related Projects</p>
                  <div className="flex flex-col gap-1">
                    {connectedProjects.slice(0, 4).map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => onSelectNode(c.id)}
                        title={`Jump to ${c.label}`}
                        className="flex items-center gap-2 px-2 py-1 rounded-md bg-purple-50/50 dark:bg-purple-900/10 hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-colors text-left cursor-pointer w-full"
                      >
                        <FolderOpen size={10} className="text-purple-400 flex-shrink-0" />
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

      {navPath && (
        <div className="px-5 pb-5">
          <button
            onClick={() => onNavigate(navPath)}
            className="w-full flex items-center justify-center gap-2 text-[0.75rem] font-medium py-2.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.07] dark:hover:bg-white/[0.1] text-gray-700 dark:text-gray-200 transition-colors"
          >
            <ExternalLink size={13} />
            Open {node.kind === "vault" ? "Vault" : node.label}
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
// user-created nodes (everything except the root + category shells).
// Pulled from PLAN_LIMITS so the cap stays in lockstep with the rest of
// the pricing config; falling back here is just defensive in case the
// limits map ever drops the field.
const FREE_SYNTHESIS_NODE_LIMIT: number =
  Number.isFinite(PLAN_LIMITS.free?.synthesisNodes)
    ? (PLAN_LIMITS.free.synthesisNodes as number)
    : 50;

export default function SynthesisLayer() {
  const { user, signInWithOAuth } = useAuth();
  const { planId, loading: planLoading } = useUserPlan();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);

  // Landing-prototype handoff: a guest gets ONE free pass through the
  // synthesis layer (the first time they land on it after creating
  // their first neuron — that's when the formation animation plays).
  // Any subsequent visit funnels through a sticky sign-in wall so they
  // can't keep mining the synthesis surface for free. The wall is
  // armed on mount based on the persisted walkthrough step: if it's
  // anything past "synthesis" they've already seen this page once.
  const [synthSignInOpen, setSynthSignInOpen] = useState(false);
  const [synthSignInEmail, setSynthSignInEmail] = useState("");
  useEffect(() => {
    if (user?.id) return;
    if (!hasPrototypeNeurons()) return;
    const step = readPrototypeStep();
    // Step is null on first-ever visit (writePrototypeStep("synthesis")
    // ran from LandingPrototype but might be cleared) or "synthesis"
    // on the canonical first visit. Both mean "first time here, let
    // them through". Any other value (vault / grid / done) means they
    // already finished this beat and are coming BACK — wall them.
    if (step !== null && step !== "synthesis") {
      setSynthSignInOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Welcome modal opens for fresh visits, EXCEPT during the landing-prototype
  // handoff: those visitors just came from a chat where they explicitly
  // created a neuron, and the synthesis layer's job in that flow is to play
  // the formation animation, not pop a welcome modal in front of it.
  const [showWelcome, setShowWelcome] = useState(() => !hasPrototypeNeurons());
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [dimensions, setDimensions] = useState({ w: 1200, h: 800 });
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("connections");
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showTagMenu, setShowTagMenu] = useState(false);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const tagMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => {
      if (containerRef.current) {
        setDimensions({ w: containerRef.current.clientWidth, h: containerRef.current.clientHeight });
      }
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  /* Data queries */
  const { data: projects = [] } = useQuery({
    queryKey: ["mindmap_projects", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data } = await supabase.from("omnia_projects").select("id, name").eq("user_id", user.id).order("updated_at", { ascending: false }).limit(50);
      return data || [];
    },
    enabled: !!user?.id,
  });

  const { data: boards = [] } = useQuery({
    queryKey: ["mindmap_boards", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data } = await supabase.from("omnia_boards").select("id, title, project_id").eq("user_id", user.id).order("updated_at", { ascending: false }).limit(80);
      return data || [];
    },
    enabled: !!user?.id,
  });

  const { data: notes = [] } = useQuery({
    queryKey: ["mindmap_notes", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data } = await supabase.from("notes").select("id, title, content, tags, ai_summary, ai_signals").eq("user_id", user.id).order("updated_at", { ascending: false }).limit(100);
      return data || [];
    },
    enabled: !!user?.id,
  });

  const { data: synthesisProfile } = useQuery({
    queryKey: ["mindmap_synthesis_profile", user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data } = await supabase.from("lykn_user_synthesis_profile").select("themes, signals, narrative").eq("user_id", user.id).maybeSingle();
      return data;
    },
    enabled: !!user?.id,
  });

  const { data: synthesisChunks = [] } = useQuery({
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

  // Prototype-only: neurons created during the landing onboarding live in
  // localStorage so this page can show them on first guest visit. We read
  // once on mount; the list is small and stable for the session.
  const prototypeNeurons = useMemo(
    () => (user?.id ? [] : readPrototypeNeurons()),
    [user?.id],
  );
  // Prototype-only: the conversation transcript from the landing chat
  // becomes the user's very first "grid" — a tangible artifact in the
  // synthesis layer that shows the moment LYKN started learning them.
  const prototypeChat = useMemo(
    () => (user?.id ? [] : readPrototypeChat()),
    [user?.id],
  );

  // Demo-mode kicks in whenever the user hasn't created any projects or
  // grids yet (guests always match; brand-new signed-in users match until
  // they make their first one). In that state we overlay synthetic
  // projects / boards / synthesis profile so the layer feels alive instead
  // of flashing the "empty" placeholder. Real notes (or seeded demo notes)
  // stay as-is.
  const isDemoMode = projects.length === 0 && boards.length === 0;

  // True only when we're rendering the prototype handoff: a guest visitor
  // who just created their first neuron in the landing prototype. In that
  // mode we deliberately *don't* show the demo projects/boards/notes — we
  // want to show an empty workspace that's just been "woken up", with only
  // the user's neuron and the AI's basic capability neurons visible.
  const isPrototypeHandoff = !user?.id && prototypeNeurons.length > 0;

  const effectiveProjects = useMemo(
    () => {
      if (isPrototypeHandoff) return [];
      return isDemoMode ? DEMO_PROJECTS : projects;
    },
    [isPrototypeHandoff, isDemoMode, projects],
  );
  const effectiveBoards = useMemo(
    () => {
      if (isPrototypeHandoff) {
        // Synthesize the landing-prototype conversation as the user's
        // very first grid. The grid's id (`__prototype_first_chat__`)
        // is intercepted in DetailPanel so clicking it surfaces the
        // chat transcript inline rather than trying to navigate to a
        // non-existent grid route.
        //
        // Only surface the grid if the chat actually has user content
        // — an empty conversation (greeting only, no user messages
        // with non-trivial text) shouldn't save as a grid node in the
        // mind map. We require at least one user turn whose content
        // is more than 1 character so a stray space doesn't qualify.
        const hasRealUserTurn = prototypeChat.some(
          (t) => t.role === "user" && t.content.trim().length > 1,
        );
        if (!hasRealUserTurn) return [];
        return [
          {
            id: "__prototype_first_chat__",
            title: "First Conversation",
            project_id: null,
          },
        ];
      }
      return isDemoMode ? DEMO_BOARDS : boards;
    },
    [isPrototypeHandoff, isDemoMode, boards, prototypeChat.length],
  );
  // For guests we intentionally bypass `notes` as a dependency — the
  // `useQuery` destructuring default (`= []`) produces a new empty array
  // reference on every render, which would otherwise invalidate this memo
  // (and every downstream memo) on every hover tick, re-seeding the force
  // layout with fresh random jitter.
  const effectiveNotes = useMemo<NoteRow[]>(() => {
    if (isPrototypeHandoff) return [];
    if (!user?.id) return DEMO_SYNTHESIS_NOTES as unknown as NoteRow[];
    return notes as NoteRow[];
  }, [isPrototypeHandoff, user?.id, notes]);

  const synthesisData: SynthesisData | null = useMemo(() => {
    if (isDemoMode) {
      // Prototype handoff: surface only the user's freshly-created
      // neuron(s). Everything else (projects, grids, vault, tags) renders
      // as an empty category shell so the page reads as a brand-new mind
      // with exactly one thing in it.
      if (isPrototypeHandoff) {
        return {
          themes: prototypeNeurons.map((n) => n.text),
          narrative:
            "This is your synthesis layer the moment it woke up. The neuron you just created is the only thing here — your projects, grids, vault, and tags are waiting to be filled.",
          signals: {},
        };
      }
      return {
        themes: DEMO_SYNTHESIS_PROFILE.themes,
        narrative: DEMO_SYNTHESIS_PROFILE.narrative,
        signals: DEMO_SYNTHESIS_PROFILE.signals as Record<string, any>,
      };
    }
    if (!synthesisProfile) return null;
    return {
      themes: Array.isArray(synthesisProfile.themes) ? synthesisProfile.themes : [],
      narrative: synthesisProfile.narrative || "",
      signals: (synthesisProfile.signals && typeof synthesisProfile.signals === "object") ? synthesisProfile.signals as Record<string, any> : {},
    };
  }, [isDemoMode, synthesisProfile, isPrototypeHandoff, prototypeNeurons]);

  const synthesisThemes: string[] = useMemo(() => {
    const t: string[] = [];
    if (synthesisData?.themes) t.push(...synthesisData.themes);
    if (synthesisData?.signals?.recurring_topics) t.push(...synthesisData.signals.recurring_topics);
    return [...new Set(t.map((s: string) => s.toLowerCase().trim()))].filter(Boolean);
  }, [synthesisData]);

  // In prototype handoff mode we want the empty Projects / Grids / Vault
  // / Tags categories to render so the user sees the shape of their
  // future workspace alongside the one neuron they just created.
  const forceCategoryIds = useMemo(
    () =>
      isPrototypeHandoff
        ? new Set<string>([
            "__cat_projects__",
            "__cat_grids__",
            "__cat_vault__",
            "__cat_tags__",
          ])
        : new Set<string>(),
    [isPrototypeHandoff],
  );

  /* Build + simulate */
  const rootLabel = isPrototypeHandoff ? "Your Synthesis Layer" : "Your Mind";
  const { nodes: allNodes, edges } = useMemo(
    () => {
      const built = buildGraph(effectiveProjects, effectiveBoards, effectiveNotes, synthesisThemes, synthesisData, vaultGridMap, forceCategoryIds, rootLabel);
      // Prototype handoff: stamp each prototype-neuron node with the
      // ordinal (1st, 2nd, ...) and the AI-supplied "why" reason so the
      // detail panel can render "Nth neuron created" + a custom blurb
      // for every neuron the user has built so far.
      if (isPrototypeHandoff && prototypeNeurons.length > 0) {
        for (let i = 0; i < prototypeNeurons.length; i++) {
          const pn = prototypeNeurons[i];
          const neuronId = `neuron_theme_${pn.text}`;
          const node = built.nodes.find((n) => n.id === neuronId);
          if (!node) continue;
          node.meta = {
            ...(node.meta || {}),
            prototypeOrdinal: pn.ordinal || i + 1,
            prototypeReason: pn.reason || "",
            prototypeKind: pn.kind,
            isPrototypeNeuron: true,
          };
        }
        // Tie EVERY prototype neuron to the synthetic "First Conversation"
        // grid with a cross-link edge — semantically each neuron was born
        // out of that chat, and the visual connection makes the
        // relationship obvious in the 3D graph.
        const gridId = "grid___prototype_first_chat__";
        const haveGrid = built.nodes.some((n) => n.id === gridId);
        if (haveGrid) {
          for (const pn of prototypeNeurons) {
            const neuronId = `neuron_theme_${pn.text}`;
            if (built.nodes.some((n) => n.id === neuronId)) {
              built.edges.push({ from: neuronId, to: gridId, cross: true });
            }
          }
        }
      }
      return built;
    },
    [effectiveProjects, effectiveBoards, effectiveNotes, synthesisThemes, synthesisData, vaultGridMap, forceCategoryIds, rootLabel, isPrototypeHandoff, prototypeNeurons],
  );
  const nodeMap = useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes]);

  // Count only the nodes the user actually created — projects, grids, vault
  // notes, tags, and AI-learned neurons. The root node and the category
  // shells (Projects / Grids / Vault / Tags / AI Learned) are scaffolding
  // that exists regardless of activity, so they're excluded from the
  // free-tier cap below.
  const userCreatedNodeCount = useMemo(
    () => allNodes.filter((n) => n.kind !== "root" && n.kind !== "category").length,
    [allNodes],
  );

  // Free tier gets the full Synthesis Layer experience up to
  // FREE_SYNTHESIS_NODE_LIMIT user-created nodes. Once they cross it the
  // page swaps in the standard PlanGate paywall instead of the canvas.
  // Guests bypass this entirely so the demo / prototype-handoff scenes
  // can still run, and we wait for the plan query to resolve before
  // gating to avoid a paywall flash for paying users.
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
    effectiveNotes.forEach((n) => {
      (n.tags || []).forEach((t: string) => s.add(t.toLowerCase().trim()));
      extractNoteThemes(n).forEach((t) => s.add(t));
    });
    return Array.from(s).sort();
  }, [effectiveNotes, synthesisThemes]);

  const simNodes = useMemo(
    () => simulateLayout(allNodes, edges, dimensions.w / 2, dimensions.h / 2, layoutMode, filterTag),
    [allNodes, edges, dimensions.w, dimensions.h, layoutMode, filterTag],
  );
  // posMap / visibleNodeIds were SVG-render helpers; the 3D scene builds its
  // own internal posMap. Keeping them here would only re-allocate on every
  // render. Hover highlight set is the only derived index we still need.

  /* Close dropdowns on outside click */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (showModeMenu && modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) setShowModeMenu(false);
      if (showTagMenu && tagMenuRef.current && !tagMenuRef.current.contains(e.target as Node)) setShowTagMenu(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showModeMenu, showTagMenu]);

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

  // 3D camera: zoom is the only piece we still drive externally (the 3D
  // scene's OrbitControls handle orbit + pan internally). resetSignal is a
  // monotonic counter; bumping it tells the scene to re-snap the camera.
  const [resetSignal, setResetSignal] = useState(0);
  const resetView = useCallback(() => {
    setCamera({ x: 0, y: 0, zoom: 1 });
    setResetSignal((n) => n + 1);
  }, []);

  // Track the prototype-handoff neuron so click/background handlers can
  // refuse to deselect it (otherwise the camera would yank back to the
  // graph centroid the moment the user pokes their freshly-formed neuron).
  // Computed before handleNodeClick so the callback closure can read it.
  const prototypeFocusId = useMemo<string | null>(() => {
    if (user?.id) return null;
    if (prototypeNeurons.length === 0) return null;
    // buildGraph creates theme neurons with id `neuron_theme_<raw text>`,
    // taken straight from `synthesis.themes` (NOT the lowercased
    // `synthesisThemes` dedupe list). Match that exact format here so
    // `nodeMap.has(prototypeFocusId)` actually succeeds — otherwise the
    // formation effect bails and we render the regular synthesis view.
    //
    // Focus on the LATEST neuron (the one most recently created) so
    // returning to the synthesis layer after creating a 2nd / 3rd /
    // ... neuron snaps the camera + formation animation onto the new
    // arrival rather than the stale first one.
    const latest = prototypeNeurons[prototypeNeurons.length - 1];
    return `neuron_theme_${latest.text}`;
  }, [user?.id, prototypeNeurons]);

  /* Node click → select & show panel */
  const handleNodeClick = useCallback((nodeId: string) => {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    setShowWelcome(false);
    if (node.kind === "root") {
      // In prototype-handoff mode the only "selected" neuron is the user's
      // brand-new one; clicking root in that mode shouldn't yank the camera.
      if (prototypeFocusId) return;
      setSelectedId(null);
      return;
    }
    // Prototype handoff: clicking the highlighted neuron a second time
    // would normally toggle it off and fly the camera back to the graph
    // centroid — which feels like the neuron "jumping away" right when
    // the user is trying to interact with it. Lock it as the focus
    // instead so hover/click just keeps it centered.
    if (prototypeFocusId && nodeId === prototypeFocusId) {
      setSelectedId(prototypeFocusId);
      return;
    }
    setSelectedId((prev) => (prev === nodeId ? null : nodeId));
  }, [nodeMap, prototypeFocusId]);

  // Prototype handoff: when a guest arrives here right after creating their
  // first neuron in the landing prototype, play a 3D-scene-integrated
  // formation: an electric-blue line draws OUT from the "AI Learned"
  // category, the neuron scales into existence at the line's end, and
  // the camera glides in to center on it.
  //
  // Phase timeline:
  //   t=0    line begins drawing from category toward neuron position
  //   t=400  camera starts flying to the neuron (overlaps with formation)
  //   t=800  line reaches neuron position; neuron starts scaling in
  //   t=1400 neuron is full size; camera roughly centered by now
  //   t=2000 formingNodeId cleared → scene returns to its normal renderer
  //
  // Triggering the camera focus partway through (rather than at the end)
  // means the camera arrives and centers exactly as the neuron finishes
  // forming, so the user sees their neuron land dead-center on screen.
  const didPlayPrototypeIntro = useRef(false);
  const prototypeIntroTimeouts = useRef<number[]>([]);
  const [formingNodeId, setFormingNodeId] = useState<string | null>(null);
  useEffect(() => {
    if (didPlayPrototypeIntro.current) return;
    if (!prototypeFocusId) return;
    if (!nodeMap.has(prototypeFocusId)) return;
    didPlayPrototypeIntro.current = true;
    setFormingNodeId(prototypeFocusId);
    setShowWelcome(false);
    // CRITICAL: do NOT clear these timeouts in the effect's cleanup.
    // Upstream memos (synthesisData / synthesisThemes / allNodes) regenerate
    // their array references on most re-renders, which causes nodeMap to
    // re-create → this effect re-fires. If we tied the timeouts to the
    // effect's cleanup, they'd get killed on the very next render — meaning
    // setSelectedId never gets called and the camera never focuses on the
    // new neuron. Instead we store them on a ref and only clear them on
    // unmount of the page, not on re-renders.
    const focusAt = window.setTimeout(() => setSelectedId(prototypeFocusId), 400);
    const clearAt = window.setTimeout(() => setFormingNodeId(null), 2000);
    // Walkthrough nudge: a beat after the formation completes, advance
    // the prototype step to "vault" so the auto-mounted AppSidebar
    // re-opens with the Vault button glowing as the next thing to
    // explore. Only fire if we haven't already passed this step (e.g.
    // user came back to /synthesis-layer after visiting the vault).
    const advanceAt = window.setTimeout(() => {
      const current = readPrototypeStep();
      if (current === "vault" || current === "done") return;
      writePrototypeStep("vault");
    }, 4500);
    prototypeIntroTimeouts.current.push(focusAt, clearAt, advanceAt);
  }, [prototypeFocusId, nodeMap]);

  // Page-level unmount cleanup for the prototype-intro timeouts. Splitting
  // this from the effect that schedules them is what keeps them alive
  // through interim re-renders (see the long comment above).
  useEffect(() => {
    return () => {
      prototypeIntroTimeouts.current.forEach((id) => window.clearTimeout(id));
      prototypeIntroTimeouts.current = [];
    };
  }, []);

  // The empty-state placeholder should only kick in when there is genuinely
  // nothing to show — including no neurons. The prototype handoff has no
  // projects/boards/notes but does have neurons, so it renders the scene.
  const isEmpty =
    effectiveProjects.length === 0 &&
    effectiveBoards.length === 0 &&
    effectiveNotes.length === 0 &&
    (synthesisData?.themes?.length ?? 0) === 0;
  const selectedNode = selectedId ? nodeMap.get(selectedId) : null;
  const panelOpen = selectedNode != null || showWelcome;
  const isTopicMode = layoutMode === "topic" && !!filterTag;

  const svgAreaRef = useRef<HTMLDivElement>(null);

  // Wheel-on-canvas drives external zoom state. OrbitControls has its own
  // wheel-zoom disabled in the scene so this stays the source of truth.
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
  }, []);

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
        description={`Your Free plan includes the Synthesis Layer up to ${FREE_SYNTHESIS_NODE_LIMIT} nodes. You've reached ${userCreatedNodeCount} — upgrade to Studio for the full, unlimited mind map.`}
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
              <p className="text-xs text-gray-400">Create grids, projects, or vault notes to see them here.</p>
            </div>
          </div>
        )}

        {/* The actual 3D scene */}
        {!isEmpty && (
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
            // Prototype handoff: empty-space clicks must NOT deselect the
            // highlighted neuron (would fly the camera back to centroid
            // and undo the whole "this is YOUR neuron, look at it"
            // moment). Keep it locked there until the user signs in.
            onBackgroundClick={() => {
              if (prototypeFocusId) return;
              setSelectedId(null);
            }}
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
            // Keep the camera pulled in close on the prototype neuron even
            // after the formation animation clears, so the user doesn't
            // see it ease back out to the wider default focus distance.
            focusDistanceOverride={isPrototypeHandoff ? 240 : null}
          />
        )}
      </div>

      {/* Organize dropdown — positioned to the right of the sidebar signed-in pill */}
      <div className="fixed top-4 left-[13.5rem] z-[80] flex items-center gap-2">
        <div ref={modeMenuRef} className="relative">
          <button
            onClick={() => { setShowModeMenu((v) => !v); setShowTagMenu(false); }}
            className="flex items-center gap-1.5 text-[0.6875rem] font-medium px-2.5 py-1.5 rounded-full bg-white/8 backdrop-blur-sm border border-white/12 text-white/75 hover:bg-white/14 shadow-sm transition-colors"
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
                className="absolute top-full left-0 mt-1.5 w-48 rounded-xl bg-[rgba(20,20,32,0.92)] backdrop-blur-md border border-white/10 shadow-lg py-1 z-50"
              >
                {layoutModes.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => {
                      setLayoutMode(m.id);
                      setShowModeMenu(false);
                      if (m.id !== "topic") setFilterTag(null);
                      if (m.id === "topic" && allIdeas.length > 0 && !filterTag) setFilterTag(allIdeas[0]);
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
              className="flex items-center gap-1.5 text-[0.6875rem] font-medium px-2.5 py-1.5 rounded-full bg-amber-500/15 border border-amber-400/30 text-amber-200 hover:bg-amber-500/25 shadow-sm transition-colors"
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
                  className="absolute top-full left-0 mt-1.5 w-48 max-h-64 overflow-y-auto rounded-xl bg-[rgba(20,20,32,0.92)] backdrop-blur-md border border-white/10 shadow-lg py-1 z-50 scrollbar-hide"
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
      </div>

      {/* Title — centered */}
      <div className="absolute top-5 left-0 right-0 z-20 flex justify-center pointer-events-none">
        <div className="flex items-center gap-2.5">
          <h1 className="text-sm font-semibold text-white/85 tracking-wide" style={{ textShadow: "0 0 14px rgba(99,102,241,0.4)" }}>Synthesis Layer</h1>
        </div>
      </div>

      {/* Stats */}
      <div className="absolute top-6 z-20 flex items-center gap-4 text-[0.625rem] text-white/60 pointer-events-none transition-[right] duration-300"
        style={{ right: panelOpen ? 384 : 24 }}
      >
        <span>{effectiveProjects.length} projects</span>
        <span className="w-px h-3 bg-white/15" />
        <span>{effectiveBoards.length} grids</span>
        <span className="w-px h-3 bg-white/15" />
        <span>{effectiveNotes.length} notes</span>
      </div>

      {/* Zoom controls */}
      <div
        className="absolute bottom-6 z-20 flex flex-col gap-1.5 transition-[right] duration-300"
        style={{ right: panelOpen ? 384 : 24 }}
      >
        <button onClick={() => setCamera((c) => ({ ...c, zoom: Math.min(3, c.zoom * 1.2) }))} className="w-8 h-8 rounded-lg bg-white/8 backdrop-blur border border-white/10 flex items-center justify-center hover:bg-white/16 transition-colors">
          <ZoomIn size={14} className="text-white/80" />
        </button>
        <button onClick={() => setCamera((c) => ({ ...c, zoom: Math.max(0.15, c.zoom * 0.8) }))} className="w-8 h-8 rounded-lg bg-white/8 backdrop-blur border border-white/10 flex items-center justify-center hover:bg-white/16 transition-colors">
          <ZoomOut size={14} className="text-white/80" />
        </button>
        <button onClick={resetView} className="w-8 h-8 rounded-lg bg-white/8 backdrop-blur border border-white/10 flex items-center justify-center hover:bg-white/16 transition-colors" title="Reset view">
          <Maximize2 size={14} className="text-white/80" />
        </button>
      </div>

      {/* Legend */}
      <div className="absolute bottom-6 left-6 z-20 flex flex-wrap gap-3 text-[0.625rem] text-white/55 pointer-events-none">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.projects.bg, color: palette.projects.bg }} /> Projects</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.grids.bg, color: palette.grids.bg }} /> Grids</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.vault.bg, color: palette.vault.bg }} /> Vault</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.tags.bg, color: palette.tags.bg }} /> Tags</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.neurons.bg, color: palette.neurons.bg }} /> AI Learned</span>
      </div>

      {/* Orbit hint — first-time users may not realise drag = orbit (not pan).
          Fades after a few seconds via CSS animation; tiny enough to ignore. */}
      <div
        className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 text-[0.6rem] text-white/40 pointer-events-none animate-pulse"
      >
        drag to orbit · scroll to zoom · shift+drag to pan
      </div>

      {/* Detail / Welcome panel */}
      <AnimatePresence>
        {selectedNode ? (
          <DetailPanel
            key={selectedNode.id}
            node={selectedNode}
            allNodes={allNodes}
            edges={edges}
            onClose={() => setSelectedId(null)}
            onNavigate={navigate}
            // Clicking a connection in the panel jumps to that neuron in the
            // 3D graph: selectedId updates → SynthesisScene3D's focusNodeId
            // changes → CameraController lerps the orbit pivot to it. Set
            // unconditionally (not toggle) — clicking a connection should
            // always navigate, never deselect.
            onSelectNode={(id) => setSelectedId(id)}
            // Landing-prototype handoff: pass the saved chat transcript
            // so the synthetic "First Conversation" grid renders the
            // actual messages instead of an empty grid stub.
            prototypeChat={isPrototypeHandoff ? prototypeChat : undefined}
          />
        ) : showWelcome ? (
          <WelcomePanel
            key="__welcome__"
            onClose={() => setShowWelcome(false)}
            neurons={allNodes.filter((n) => n.kind === "neuron")}
            onSelectNode={(id) => { setShowWelcome(false); setSelectedId(id); }}
          />
        ) : null}
      </AnimatePresence>

      {/* Landing-prototype handoff: sticky sign-in wall for guests
          revisiting the synthesis layer after they've already done the
          one-time formation walkthrough. Same pattern as OmniaGrid's
          wall — closing it re-opens the next interaction so the page
          stays gated until they actually sign in. */}
      <Dialog
        open={synthSignInOpen}
        onOpenChange={(next) => {
          // Sticky for guests — ignore close attempts (X / ESC /
          // backdrop click) so the wall can't be dismissed. Only let
          // the modal close if the user signs in mid-render (which
          // also navigates away, so this is mostly a safety net).
          if (user?.id) setSynthSignInOpen(next);
        }}
      >
        <DialogContent className="sm:max-w-md border-white/10 bg-[#1a1a1a]/95 backdrop-blur-xl text-white p-7">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold tracking-tight">
              Sign in to revisit your synthesis layer.
            </DialogTitle>
            <DialogDescription className="text-sm text-white/60 leading-relaxed pt-2">
              The synthesis layer is your living mind map — every neuron, every connection, every grid you make. To keep growing it across visits, you'll need a free account.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-2 flex flex-col gap-2.5">
            <button
              type="button"
              onClick={() => { void signInWithOAuth?.("google"); }}
              className="w-full flex items-center justify-center gap-2.5 rounded-xl border border-white/10 bg-white text-black px-3 py-2.5 text-sm font-medium hover:bg-white/90 transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4" />
                <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853" />
                <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05" />
                <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335" />
              </svg>
              Continue with Google
            </button>
          </div>

          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-white/10" />
            </div>
            <div className="relative flex justify-center text-[0.625rem]">
              <span className="px-2 text-white/40 font-medium uppercase tracking-wider bg-[#1a1a1a]">
                or
              </span>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = synthSignInEmail.trim();
              setSynthSignInOpen(false);
              navigate("/login", { state: trimmed ? { email: trimmed } : undefined });
            }}
            className="flex flex-col gap-2"
          >
            <input
              type="email"
              value={synthSignInEmail}
              onChange={(e) => setSynthSignInEmail(e.target.value)}
              placeholder="Enter your email"
              autoComplete="email"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white/90 placeholder:text-white/35 outline-none focus:border-blue-400/40 focus:bg-white/10 transition-colors"
            />
            <button
              type="submit"
              className="w-full rounded-xl bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 px-3 py-2.5 text-sm font-semibold transition-colors"
            >
              Continue with email
            </button>
          </form>

          <p className="mt-1 text-center text-[10px] text-white/35 leading-relaxed">
            Free forever. No credit card. Takes 10 seconds.
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
