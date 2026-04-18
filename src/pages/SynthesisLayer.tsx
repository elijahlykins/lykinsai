import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
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
  X,
  ZoomIn,
  ZoomOut,
  Maximize2,
} from "lucide-react";
import { GridIcon } from "@/components/ui/GridIcon";

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
) {
  const nodes: MindNode[] = [];
  const edges: MindEdge[] = [];

  const rootId = "__root__";
  nodes.push({ id: rootId, label: "Your Mind", kind: "root", radius: 42, color: palette.root.bg, glow: palette.root.glow, parentId: null, meta: { narrative: synthesis?.narrative } });

  const cats: { id: string; label: string; color: string; glow: string }[] = [];
  if (projects.length > 0) cats.push({ id: "__cat_projects__", label: "Projects", color: palette.projects.bg, glow: palette.projects.glow });
  if (boards.length > 0) cats.push({ id: "__cat_grids__", label: "Grids", color: palette.grids.bg, glow: palette.grids.glow });
  if (notes.length > 0) cats.push({ id: "__cat_vault__", label: "Vault", color: palette.vault.bg, glow: palette.vault.glow });

  const allTags = new Set<string>();
  notes.forEach((n) => (n.tags || []).forEach((t) => allTags.add(t)));
  if (allTags.size > 0) cats.push({ id: "__cat_tags__", label: "Tags", color: palette.tags.bg, glow: palette.tags.glow });

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

  /* Per-category child counters for section mode */
  const catChildIdx = new Map<string, number>();
  const catChildCount = new Map<string, number>();
  if (mode === "section") {
    filtered.forEach((n) => {
      if (n.categoryId) catChildCount.set(n.categoryId, (catChildCount.get(n.categoryId) || 0) + 1);
    });
  }

  const simNodes: SimNode[] = filtered.map((n) => {
    const cc = connCount.get(n.id) || 0;
    const ratio = cc / maxConn;
    const relevance = relevanceMap?.get(n.id) ?? 1;

    if (n.kind === "root") {
      return { ...n, x: cx, y: cy, vx: 0, vy: 0, fixed: true, connectionCount: cc, relevance: 1 };
    }

    if (n.kind === "category") {
      const angle = catAngle.get(n.id) || 0;
      const dist = mode === "section" ? 220 : mode === "topic" ? 140 : 160;
      return { ...n, x: cx + Math.cos(angle) * dist, y: cy + Math.sin(angle) * dist, vx: 0, vy: 0, fixed: mode === "section", connectionCount: cc, relevance };
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
      return { ...n, x: catX + Math.cos(angle) * dist, y: catY + Math.sin(angle) * dist, vx: 0, vy: 0, fixed: false, connectionCount: cc, relevance };
    }

    if (mode === "topic" && relevanceMap) {
      // Position by relevance: high relevance → close to center, low → far out
      const jitter = (Math.random() - 0.5) * 1.6;
      const angle = parentAngle + jitter;
      const minDist = 100;
      const maxDist = 600;
      const dist = maxDist - relevance * (maxDist - minDist) + (Math.random() - 0.5) * 40;
      return { ...n, x: cx + Math.cos(angle) * dist, y: cy + Math.sin(angle) * dist, vx: 0, vy: 0, fixed: false, connectionCount: cc, relevance };
    }

    // connections mode: connection-weighted distance
    const jitter = (Math.random() - 0.5) * 1.2;
    const angle = parentAngle + jitter;
    const minDist = 200;
    const maxDist = 500;
    const dist = maxDist - ratio * (maxDist - minDist) + (Math.random() - 0.5) * 60;
    return { ...n, x: cx + Math.cos(angle) * dist, y: cy + Math.sin(angle) * dist, vx: 0, vy: 0, fixed: false, connectionCount: cc, relevance: 1 };
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
/*  Curved edge path                                                   */
/* ------------------------------------------------------------------ */

function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const curvature = dist * 0.12;
  const nx = -dy / dist;
  const ny = dx / dist;
  return `M ${x1} ${y1} Q ${mx + nx * curvature} ${my + ny * curvature} ${x2} ${y2}`;
}

/* ------------------------------------------------------------------ */
/*  Icons                                                              */
/* ------------------------------------------------------------------ */

function NodeIcon({ kind, size = 14 }: { kind: NodeKind; size?: number }) {
  const cls = "text-white/90";
  switch (kind) {
    case "root": return <Brain className={cls} size={size} />;
    case "project": return <FolderOpen className={cls} size={size} />;
    case "grid": return <GridIcon className={cls} size={size} />;
    case "vault": return <StickyNote className={cls} size={size} />;
    case "tag": return <Tag className={cls} size={size} />;
    case "neuron": return <Sparkles className={cls} size={size} />;
    default: return null;
  }
}

function catIcon(id: string, size = 14) {
  const cls = "text-white/90";
  if (id.includes("projects")) return <FolderOpen className={cls} size={size} />;
  if (id.includes("grids")) return <GridIcon className={cls} size={size} />;
  if (id.includes("vault")) return <Lock className={cls} size={size} />;
  if (id.includes("tags")) return <Tag className={cls} size={size} />;
  if (id.includes("neurons")) return <Sparkles className={cls} size={size} />;
  return null;
}

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
      className="absolute top-0 right-0 z-30 h-full w-[360px] border-l border-black/5 dark:border-white/8 flex flex-col"
      style={{ backgroundColor: "var(--app-background)" }}
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-end px-5 pt-5 pb-3">
        <button onClick={onClose} className="w-6 h-6 rounded-md hover:bg-black/5 dark:hover:bg-white/8 flex items-center justify-center transition-colors">
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
}: {
  node: MindNode;
  allNodes: MindNode[];
  edges: MindEdge[];
  onClose: () => void;
  onNavigate: (path: string) => void;
}) {
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

  const navPath = node.kind === "grid" && node.meta?.boardId
    ? `/grid/${node.meta.boardId}`
    : node.kind === "project" && node.meta?.projectId
    ? `/project/${node.meta.projectId}`
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
      className="absolute top-0 right-0 z-30 h-full w-[360px] border-l border-black/5 dark:border-white/8 flex flex-col"
      style={{ backgroundColor: "var(--app-background)" }}
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-3 px-5 pt-5 pb-3">
        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: node.color }} />
        <span className="text-xs font-semibold text-gray-700 dark:text-gray-200 capitalize flex-1 truncate">
          {node.kind === "category" ? node.label : node.kind}
        </span>
        <button onClick={onClose} className="w-6 h-6 rounded-md hover:bg-black/5 dark:hover:bg-white/8 flex items-center justify-center transition-colors">
          <PanelRightClose size={15} className="text-gray-400" />
        </button>
      </div>

      <div className="px-5 pb-4">
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100 leading-snug break-words">
          {node.kind === "vault" && node.meta?.title ? node.meta.title as string : node.label}
        </h2>
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
                        onClick={() => onNavigate(`/grid/${g.meta?.boardId}`)}
                        className="flex items-center gap-2 px-2.5 py-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-colors text-left"
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
                  {node.meta?.kindLabel || "Insight"}
                </span>
                <span className="text-[0.6rem] text-gray-400 dark:text-gray-500">
                  AI Neuron
                </span>
              </div>

              <p className="text-[0.75rem] text-gray-600 dark:text-gray-300 leading-relaxed mb-4">
                {originDesc[source] || `The AI recognized "${node.label}" as a ${kind} based on your activity across grids, vault, and conversations.`}
              </p>

              {connectedVault.length > 0 && (
                <div className="mb-3">
                  <p className="text-[0.625rem] font-medium text-gray-400 dark:text-gray-500 mb-1.5 uppercase tracking-wider">Related Vault Notes</p>
                  <div className="flex flex-col gap-1">
                    {connectedVault.slice(0, 6).map((c) => (
                      <div key={c.id} className="flex items-center gap-2 px-2 py-1 rounded-md bg-emerald-50/50 dark:bg-emerald-900/10">
                        <StickyNote size={10} className="text-emerald-400 flex-shrink-0" />
                        <span className="text-[0.6875rem] text-gray-600 dark:text-gray-300 truncate">{c.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {connectedGrids.length > 0 && (
                <div className="mb-3">
                  <p className="text-[0.625rem] font-medium text-gray-400 dark:text-gray-500 mb-1.5 uppercase tracking-wider">Related Grids</p>
                  <div className="flex flex-col gap-1">
                    {connectedGrids.slice(0, 6).map((c) => (
                      <button
                        key={c.id}
                        onClick={() => onNavigate(`/grid/${c.meta?.boardId}`)}
                        className="flex items-center gap-2 px-2 py-1 rounded-md bg-gray-100/50 dark:bg-white/[0.05] hover:bg-gray-100 dark:hover:bg-white/[0.08] transition-colors text-left"
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
                        onClick={() => onNavigate(`/project/${c.meta?.projectId}`)}
                        className="flex items-center gap-2 px-2 py-1 rounded-md bg-purple-50/50 dark:bg-purple-900/10 hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-colors text-left"
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
                      <span key={c.id} className="text-[0.6rem] px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">
                        {c.label}
                      </span>
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
                <div key={c.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: c.color }} />
                  <span className="text-[0.6875rem] text-gray-600 dark:text-gray-300 truncate flex-1">{c.label}</span>
                  <span className="text-[0.6rem] text-gray-400 dark:text-gray-500 capitalize">{c.kind}</span>
                </div>
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

export default function SynthesisLayer() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showWelcome, setShowWelcome] = useState(true);
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

  const vaultGridMap = useMemo(() => buildVaultGridMap(synthesisChunks), [synthesisChunks]);

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

  /* Build + simulate */
  const { nodes: allNodes, edges } = useMemo(() => buildGraph(projects, boards, notes, synthesisThemes, synthesisData, vaultGridMap), [projects, boards, notes, synthesisThemes, synthesisData, vaultGridMap]);
  const nodeMap = useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes]);

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

  const simNodes = useMemo(
    () => simulateLayout(allNodes, edges, dimensions.w / 2, dimensions.h / 2, layoutMode, filterTag),
    [allNodes, edges, dimensions.w, dimensions.h, layoutMode, filterTag],
  );
  const posMap = useMemo(() => new Map(simNodes.map((n) => [n.id, n])), [simNodes]);
  const visibleNodeIds = useMemo(() => new Set(simNodes.map((n) => n.id)), [simNodes]);

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

  /* Pan & zoom */
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0, cx: 0, cy: 0 });

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-node]")) return;
    isPanning.current = true;
    panStart.current = { x: e.clientX, y: e.clientY, cx: camera.x, cy: camera.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [camera.x, camera.y]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPanning.current) return;
    setCamera((c) => ({ ...c, x: panStart.current.cx + e.clientX - panStart.current.x, y: panStart.current.cy + e.clientY - panStart.current.y }));
  }, []);

  const handlePointerUp = useCallback(() => { isPanning.current = false; }, []);
  const resetView = useCallback(() => setCamera({ x: 0, y: 0, zoom: 1 }), []);

  /* Node click → select & show panel */
  const handleNodeClick = useCallback((node: SimNode) => {
    setShowWelcome(false);
    if (node.kind === "root") {
      setSelectedId(null);
      return;
    }
    setSelectedId((prev) => (prev === node.id ? null : node.id));
  }, []);

  const svgTransform = `translate(${dimensions.w / 2 + camera.x}, ${dimensions.h / 2 + camera.y}) scale(${camera.zoom}) translate(${-dimensions.w / 2}, ${-dimensions.h / 2})`;
  const isEmpty = projects.length === 0 && boards.length === 0 && notes.length === 0;
  const selectedNode = selectedId ? nodeMap.get(selectedId) : null;
  const panelOpen = selectedNode != null || showWelcome;
  const isTopicMode = layoutMode === "topic" && !!filterTag;

  const svgAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = svgAreaRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.92 : 1.08;
      setCamera((c) => ({ ...c, zoom: Math.min(3, Math.max(0.15, c.zoom * delta)) }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 overflow-hidden select-none"
      style={{ backgroundColor: "var(--app-background)" }}
    >
      {/* SVG interaction area — pan & zoom only happen here */}
      <div
        ref={svgAreaRef}
        className="absolute inset-0"
        style={{ cursor: isPanning.current ? "grabbing" : "grab" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
      {/* Subtle dot grid */}
      <div
        className="absolute inset-0 opacity-[0.03] dark:opacity-[0.04] pointer-events-none"
        style={{ backgroundImage: "radial-gradient(circle, currentColor 1px, transparent 1px)", backgroundSize: "40px 40px" }}
      />

      {/* Empty state */}
      {isEmpty && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div className="text-center space-y-3">
            <Brain className="w-12 h-12 text-indigo-300 dark:text-indigo-500 mx-auto" />
            <p className="text-sm text-gray-400 dark:text-gray-500">Your Synthesis Layer is empty.</p>
            <p className="text-xs text-gray-400 dark:text-gray-500">Create grids, projects, or vault notes to see them here.</p>
          </div>
        </div>
      )}

      {/* SVG Canvas */}
      <svg className="absolute inset-0 w-full h-full overflow-visible">
        <defs>
          <filter id="glow-sm"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          <filter id="glow-lg"><feGaussianBlur stdDeviation="8" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>

        <g transform={svgTransform}>
          {/* Edges */}
          {edges.filter((e) => visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to)).map((edge, i) => {
            const a = posMap.get(edge.from);
            const b = posMap.get(edge.to);
            if (!a || !b) return null;
            const isHl = hoveredNode !== null && highlightSet.has(edge.from) && highlightSet.has(edge.to);
            const isDimmed = hoveredNode !== null && !isHl;
            const edgeRelevance = isTopicMode ? Math.min(a.relevance, b.relevance) : 1;
            const relevanceDim = isTopicMode && edgeRelevance < 0.3;
            return (
              <motion.path
                key={`${edge.from}_${edge.to}_${i}`}
                d={edgePath(a.x, a.y, b.x, b.y)}
                fill="none"
                stroke={isHl ? a.color : edge.cross ? "rgba(148,163,184,0.10)" : "rgba(148,163,184,0.20)"}
                strokeWidth={isHl ? 2.5 : edge.cross ? 0.8 : 1.2}
                strokeDasharray={edge.cross ? "4 4" : undefined}
                opacity={isDimmed ? 0.08 : relevanceDim ? 0.12 : 1}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: isDimmed ? 0.08 : relevanceDim ? 0.12 : 1 }}
                transition={{ duration: 1, delay: i * 0.004 }}
              />
            );
          })}

          {/* Nodes */}
          {simNodes.map((node, i) => {
            const isHovered = hoveredNode === node.id;
            const isSelected = selectedId === node.id;
            const isDimmed = hoveredNode !== null && !highlightSet.has(node.id);
            const nodeOpacity = isDimmed
              ? 0.2
              : isTopicMode
                ? Math.max(0.12, node.relevance)
                : 1;

            return (
              <motion.g
                key={node.id}
                data-node
                style={{ cursor: node.kind === "root" ? "default" : "pointer" }}
                initial={{ opacity: 0, scale: 0 }}
                animate={{
                  opacity: nodeOpacity,
                  scale: isHovered ? 1.15 : isSelected ? 1.1 : 1,
                  x: node.x,
                  y: node.y,
                }}
                transition={{
                  x: { duration: 0.8, delay: i * 0.012 },
                  y: { duration: 0.8, delay: i * 0.012 },
                  opacity: { duration: 0.2 },
                  scale: { type: "spring", stiffness: 300, damping: 20 },
                }}
                onPointerEnter={() => setHoveredNode(node.id)}
                onPointerLeave={() => setHoveredNode(null)}
                onClick={() => handleNodeClick(node)}
              >
                {/* Selection ring */}
                {isSelected && (
                  <motion.circle
                    r={node.radius + 7}
                    fill="none"
                    stroke={node.color}
                    strokeWidth={2.5}
                    opacity={0.5}
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 0.5 }}
                  />
                )}

                {/* Hover glow */}
                <circle
                  r={node.radius + 8}
                  fill="none"
                  stroke={node.glow}
                  strokeWidth={isHovered ? 3 : 0}
                  opacity={isHovered ? 0.6 : 0}
                  filter="url(#glow-sm)"
                />

                {/* Ambient glow */}
                <circle
                  r={node.radius * 1.7}
                  fill={node.glow}
                  opacity={node.kind === "root" ? 0.2 : 0.08}
                  filter="url(#glow-lg)"
                />

                {/* Main circle */}
                <circle r={node.radius} fill={node.color} opacity={0.92} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />

                {/* Connection count badge for highly connected nodes */}
                {node.connectionCount > 3 && node.kind !== "root" && node.kind !== "category" && (
                  <>
                    <circle cx={node.radius * 0.7} cy={-node.radius * 0.7} r={7} fill="white" opacity={0.9} />
                    <text
                      x={node.radius * 0.7}
                      y={-node.radius * 0.7 + 3.5}
                      textAnchor="middle"
                      style={{ fontSize: "8px", fontWeight: 700, fill: node.color, pointerEvents: "none" }}
                    >
                      {node.connectionCount}
                    </text>
                  </>
                )}

                {/* Icon */}
                <foreignObject
                  x={-node.radius * 0.45}
                  y={-node.radius * 0.45}
                  width={node.radius * 0.9}
                  height={node.radius * 0.9}
                  style={{ pointerEvents: "none" }}
                >
                  <div className="w-full h-full flex items-center justify-center">
                    {node.kind === "category"
                      ? catIcon(node.id, Math.max(12, node.radius * 0.5))
                      : <NodeIcon kind={node.kind} size={Math.max(11, node.radius * 0.5)} />}
                  </div>
                </foreignObject>

                {/* Label */}
                <text
                  y={node.radius + 14}
                  textAnchor="middle"
                  className="fill-gray-600 dark:fill-gray-300"
                  style={{
                    fontSize: node.kind === "root" ? "11px" : node.kind === "category" ? "10px" : "9px",
                    fontWeight: node.kind === "root" || node.kind === "category" ? 600 : 400,
                    pointerEvents: "none",
                  }}
                >
                  {node.label.length > 24 ? node.label.slice(0, 22) + "…" : node.label}
                </text>
              </motion.g>
            );
          })}
        </g>
      </svg>
      </div>{/* end SVG interaction area */}

      {/* Organize dropdown — positioned to the right of the sidebar signed-in pill */}
      <div className="fixed top-4 left-[13.5rem] z-[80] flex items-center gap-2">
        <div ref={modeMenuRef} className="relative">
          <button
            onClick={() => { setShowModeMenu((v) => !v); setShowTagMenu(false); }}
            className="flex items-center gap-1.5 text-[0.6875rem] font-medium px-2.5 py-1.5 rounded-full bg-white/45 dark:bg-[rgba(60,60,60,0.14)] backdrop-blur-sm border border-black/6 dark:border-white/10 text-black/70 dark:text-white/70 hover:bg-white/60 dark:hover:bg-white/15 shadow-sm transition-colors"
          >
            {(() => { const m = layoutModes.find((l) => l.id === layoutMode); return m ? <m.icon size={13} /> : null; })()}
            {layoutModes.find((l) => l.id === layoutMode)?.label}
            <ChevronDown size={11} className="text-black/40 dark:text-white/40" />
          </button>
          <AnimatePresence>
            {showModeMenu && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.12 }}
                className="absolute top-full left-0 mt-1.5 w-48 rounded-xl bg-white/90 dark:bg-neutral-800/90 backdrop-blur-md border border-black/5 dark:border-white/8 shadow-lg py-1 z-50"
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
                        ? "bg-gray-100 dark:bg-white/10 text-gray-800 dark:text-gray-200 font-medium"
                        : "text-gray-600 dark:text-gray-300 hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
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
              className="flex items-center gap-1.5 text-[0.6875rem] font-medium px-2.5 py-1.5 rounded-full bg-amber-50 dark:bg-amber-900/20 border border-amber-200/50 dark:border-amber-700/30 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30 shadow-sm transition-colors"
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
                  className="absolute top-full left-0 mt-1.5 w-48 max-h-64 overflow-y-auto rounded-xl bg-white/90 dark:bg-neutral-800/90 backdrop-blur-md border border-black/5 dark:border-white/8 shadow-lg py-1 z-50 scrollbar-hide"
                >
                  {allIdeas.length === 0 ? (
                      <p className="px-3 py-2 text-[0.6875rem] text-gray-400">No ideas found</p>
                  ) : allIdeas.map((t) => (
                    <button
                      key={t}
                      onClick={() => { setFilterTag(t); setShowTagMenu(false); }}
                      className={`w-full text-left px-3 py-1.5 text-[0.6875rem] transition-colors ${
                        filterTag === t
                          ? "bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 font-medium"
                          : "text-gray-600 dark:text-gray-300 hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
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
          <h1 className="text-sm font-semibold text-gray-700 dark:text-gray-200 tracking-wide">Synthesis Layer</h1>
        </div>
      </div>

      {/* Stats */}
      <div className="absolute top-6 z-20 flex items-center gap-4 text-[0.625rem] text-gray-400 dark:text-gray-500 pointer-events-none transition-[right] duration-300"
        style={{ right: panelOpen ? 384 : 24 }}
      >
        <span>{projects.length} projects</span>
        <span className="w-px h-3 bg-gray-200 dark:bg-gray-700" />
        <span>{boards.length} grids</span>
        <span className="w-px h-3 bg-gray-200 dark:bg-gray-700" />
        <span>{notes.length} notes</span>
      </div>

      {/* Zoom controls */}
      <div
        className="absolute bottom-6 z-20 flex flex-col gap-1.5 transition-[right] duration-300"
        style={{ right: panelOpen ? 384 : 24 }}
      >
        <button onClick={() => setCamera((c) => ({ ...c, zoom: Math.min(3, c.zoom * 1.2) }))} className="w-8 h-8 rounded-lg bg-white/60 dark:bg-gray-800/60 backdrop-blur border border-black/5 dark:border-white/8 flex items-center justify-center hover:bg-white/90 dark:hover:bg-gray-700/80 transition-colors">
          <ZoomIn size={14} className="text-gray-600 dark:text-gray-300" />
        </button>
        <button onClick={() => setCamera((c) => ({ ...c, zoom: Math.max(0.15, c.zoom * 0.8) }))} className="w-8 h-8 rounded-lg bg-white/60 dark:bg-gray-800/60 backdrop-blur border border-black/5 dark:border-white/8 flex items-center justify-center hover:bg-white/90 dark:hover:bg-gray-700/80 transition-colors">
          <ZoomOut size={14} className="text-gray-600 dark:text-gray-300" />
        </button>
        <button onClick={resetView} className="w-8 h-8 rounded-lg bg-white/60 dark:bg-gray-800/60 backdrop-blur border border-black/5 dark:border-white/8 flex items-center justify-center hover:bg-white/90 dark:hover:bg-gray-700/80 transition-colors">
          <Maximize2 size={14} className="text-gray-600 dark:text-gray-300" />
        </button>
      </div>

      {/* Legend */}
      <div className="absolute bottom-6 left-6 z-20 flex flex-wrap gap-3 text-[0.625rem] text-gray-500 dark:text-gray-400 pointer-events-none">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: palette.projects.bg }} /> Projects</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: palette.grids.bg }} /> Grids</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: palette.vault.bg }} /> Vault</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: palette.tags.bg }} /> Tags</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: palette.neurons.bg }} /> AI Learned</span>
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
    </div>
  );
}
