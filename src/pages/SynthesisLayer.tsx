import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence, useDragControls } from "framer-motion";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { useUserPlan } from "@/lib/useUserPlan";
import PlanGate from "@/components/PlanGate";
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
  FolderOpen,
  Hash,
  LayoutGrid,
  Loader2,
  Lock,
  Network,
  PanelRightClose,
  Plus,
  StickyNote,
  Sparkles,
  Tag,
  X,
  ZoomIn,
  ZoomOut,
  Maximize2,
} from "lucide-react";
import BeliefWindowPanel from "@/components/synthesis/BeliefWindowPanel";
import SynthesisUpdatesPanel from "@/components/synthesis/SynthesisUpdatesPanel";
import { API_BASE_URL } from "@/lib/api-config";
import { GridIcon } from "@/components/ui/GridIcon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import SynthesisScene3D from "@/pages/synthesis/SynthesisScene3D";
import SynthesisSceneErrorBoundary from "@/pages/synthesis/SynthesisSceneErrorBoundary";
import { useIsMobile } from "@/hooks/useViewportTier";
import { isDemoNodeId } from "@/lib/demoSynthesis";
import { isDemoGridId } from "@/lib/demoGrids";
import {
  clearPrototypeState,
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

type NodeKind = "root" | "category" | "project" | "grid" | "vault" | "tag" | "neuron" | "belief";

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
  // Beliefs are the layer above neurons — palette emphasizes that this is
  // a separate, higher-order tier (deeper indigo, brighter glow) so the
  // user reads the cluster as "principles" not just more facts.
  beliefs:  { bg: "#818cf8", glow: "rgba(129,140,248,0.40)" },
  project:  { bg: "#a78bfa", glow: "rgba(167,139,250,0.25)" },
  grid:     { bg: "#60a5fa", glow: "rgba(96,165,250,0.25)" },
  note:     { bg: "#34d399", glow: "rgba(52,211,153,0.25)" },
  tag:      { bg: "#fbbf24", glow: "rgba(251,191,36,0.25)" },
  neuron:   { bg: "#f472b6", glow: "rgba(244,114,182,0.25)" },
  // Core Belief nodes are pure white — they're meant to read as "lit from
  // within" against the colored category clusters around them. White +
  // the boosted emissive in SynthesisScene3D (3.6, pulsing) makes the
  // principles look like little stars, which matches the intent that
  // beliefs are the highest-order tier and the AI's brightest signal.
  belief:   { bg: "#ffffff", glow: "rgba(255,255,255,0.45)" },
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
  // Active beliefs (Hyrum-Smith belief-window layer). Rendered as their own
  // category cluster so the user can see the principles the AI answers
  // through. Empty array means we omit the category entirely.
  beliefs: Array<{ id: string; belief_text: string; serves_need: string; confidence: number }> = [],
  // User-stated / user-confirmed atomic facts. Rendered as additional
  // "AI Learned" neurons so freshly-saved Basic neurons appear in the
  // graph instantly (otherwise they'd only surface after a synthesis
  // profile rebuild, which made the Save button look like a no-op).
  manualFacts: Array<{ id: string; fact_kind: string; fact_text: string; confidence: number }> = [],
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
  if (boards.length > 0 || forceCategoryIds.has("__cat_grids__")) cats.push({ id: "__cat_grids__", label: "Chats", color: palette.grids.bg, glow: palette.grids.glow });
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
    nodes.push({ id: nid, label: b.title || "New Chat", kind: "grid", radius: 20, color: palette.grid.bg, glow: palette.grid.glow, parentId: "__cat_grids__", categoryId: "__cat_grids__", meta: { boardId: b.id, projectId: b.project_id } });
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

  if (neuronItems.length > 0 || manualFacts.length > 0) {
    cats.push({ id: "__cat_neurons__", label: "AI Learned", color: palette.neurons.bg, glow: palette.neurons.glow });
  }

  // Beliefs — promoted, user-ratified principles that sit ABOVE atomic
  // facts. Render as their own cluster so the user reads them as a
  // separate, higher-order tier (visually closer to the root than the
  // long-tail neurons).
  if (beliefs.length > 0 || forceCategoryIds.has("__cat_beliefs__")) {
    cats.push({ id: "__cat_beliefs__", label: "Beliefs", color: palette.beliefs.bg, glow: palette.beliefs.glow });
  }

  // (categories were already pushed above, but neurons cat needs to go in too)
  if ((neuronItems.length > 0 || manualFacts.length > 0) && !nodes.some((n) => n.id === "__cat_neurons__")) {
    nodes.push({ id: "__cat_neurons__", label: "AI Learned", kind: "category", radius: 30, color: palette.neurons.bg, glow: palette.neurons.glow, parentId: rootId });
    edges.push({ from: rootId, to: "__cat_neurons__" });
  }
  if ((beliefs.length > 0 || forceCategoryIds.has("__cat_beliefs__")) && !nodes.some((n) => n.id === "__cat_beliefs__")) {
    nodes.push({ id: "__cat_beliefs__", label: "Beliefs", kind: "category", radius: 32, color: palette.beliefs.bg, glow: palette.beliefs.glow, parentId: rootId });
    edges.push({ from: rootId, to: "__cat_beliefs__" });
  }

  // Belief nodes — placed under their own category. Each belief is bigger
  // than a neuron because it represents a higher-order principle. Cross-
  // edges to related neurons / vault notes are deliberately NOT drawn here
  // (the BeliefWindowPanel side panel is the canonical place to inspect
  // a belief's supporting facts) so the 3D view stays readable.
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
      parentId: "__cat_beliefs__",
      categoryId: "__cat_beliefs__",
      meta: {
        beliefId: b.id,
        beliefText: b.belief_text,
        servesNeed: b.serves_need,
        confidence: b.confidence,
      },
    });
    edges.push({ from: "__cat_beliefs__", to: nid });
  });

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
      color: palette.neuron.bg,
      glow: palette.neuron.glow,
      parentId: "__cat_neurons__",
      categoryId: "__cat_neurons__",
      meta: {
        neuronKind: "fact",
        source: "manual_fact",
        kindLabel: factKindLabel(f.fact_kind),
        factId: f.id,
        factKind: f.fact_kind,
        factText: f.fact_text,
        confidence: f.confidence,
      },
    });
    edges.push({ from: "__cat_neurons__", to: nid });
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
  { id: "section",     label: "By Section",     icon: LayoutGrid },
  { id: "connections", label: "Most Connected", icon: Network },
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
  // Hard floors / caps on the simulation. Without these, two co-seeded
  // siblings (same parentAngle + similar jitter) yield dist ≈ 1, so the
  // inverse-square repulsion produces a one-tick impulse big enough to
  // launch a node thousands of units away. Sparsely-populated clusters
  // (e.g. Beliefs in section mode) are especially prone to this because
  // they absorb cumulative repulsion from dense neighbour clusters with
  // very little edge-attraction to pull them back.
  const MIN_REPULSION_DIST = 30;
  const MAX_VELOCITY = 25;
  const MAX_RADIUS = mode === "section" ? 720 : 900;
  // In section mode each cluster is supposed to read as a self-contained
  // group, so we additionally clamp non-fixed nodes within a fixed radius
  // of their parent category.
  const PARENT_MAX_RADIUS = 340;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (let i = 0; i < simNodes.length; i++) {
      const a = simNodes[i];
      if (a.fixed) continue;
      for (let j = i + 1; j < simNodes.length; j++) {
        const b = simNodes[j];
        if (b.fixed) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const rawDist = Math.sqrt(dx * dx + dy * dy) || 1;
        const dist = Math.max(rawDist, MIN_REPULSION_DIST);
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

      // Cap per-tick velocity. A single bad repulsion impulse from a
      // co-seeded neighbour can otherwise punt a node into outer space
      // before damping has a chance to bleed it off.
      const vMag = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
      if (vMag > MAX_VELOCITY) {
        const k = MAX_VELOCITY / vMag;
        node.vx *= k;
        node.vy *= k;
      }

      node.x += node.vx;
      node.y += node.vy;

      // Section mode: keep each child within a fixed radius of its parent
      // category. This is what makes "Beliefs" actually look like a
      // cluster instead of a stray belief floating across the canvas.
      if (mode === "section") {
        const parent = map.get(node.categoryId || node.parentId || "");
        if (parent) {
          const pdx = node.x - parent.x;
          const pdy = node.y - parent.y;
          const pr = Math.sqrt(pdx * pdx + pdy * pdy);
          if (pr > PARENT_MAX_RADIUS) {
            const k = PARENT_MAX_RADIUS / pr;
            node.x = parent.x + pdx * k;
            node.y = parent.y + pdy * k;
            node.vx *= 0.4;
            node.vy *= 0.4;
          }
        }
      }

      // Global outer-radius clamp. Catches any stragglers that escaped
      // their parent (or in non-section modes, drifted past the playing
      // field). Bleed velocity so they don't immediately re-launch.
      const rdx = node.x - cx;
      const rdy = node.y - cy;
      const r = Math.sqrt(rdx * rdx + rdy * rdy);
      if (r > MAX_RADIUS) {
        const k = MAX_RADIUS / r;
        node.x = cx + rdx * k;
        node.y = cy + rdy * k;
        node.vx *= 0.5;
        node.vy *= 0.5;
      }
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
  // On phones the right-side 360px drawer covers ~95% of the screen and
  // hides the neuron the user just tapped. Slide up as a draggable
  // sheet with three on-screen snap points (expanded / collapsed /
  // minimized) plus a dismissed off-screen state. See DetailPanel for
  // the full mechanism notes — this mirrors it exactly.
  const isMobile = useIsMobile();
  const SHEET_HEIGHT_VH = 92;
  const COLLAPSED_VISIBLE_VH = 50;
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
      initial={isMobile ? { y: dismissedY, opacity: 0 } : { x: 380, opacity: 0 }}
      animate={isMobile ? { y: targetY, opacity: 1 } : { x: 0, opacity: 1 }}
      exit={isMobile ? { y: dismissedY, opacity: 0 } : { x: 380, opacity: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
      drag={isMobile ? "y" : false}
      dragControls={dragControls}
      dragListener={false}
      dragElastic={0.04}
      dragMomentum={false}
      dragConstraints={isMobile ? { top: 0, bottom: dismissedY } : undefined}
      onDragEnd={(_, info) => {
        const current = targetY + info.offset.y;
        const v = info.velocity.y;
        const projected = current + v * 0.15;
        const dismissThresh = dismissedY - vh * 0.04;
        if (projected > dismissThresh || v > 2500) { onClose(); return; }
        if (v < -800) { setSheetState("expanded"); return; }
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
      <div className="flex items-center justify-end px-5 pt-2 pb-3">
        <button
          onClick={onClose}
          aria-label="Close panel"
          className={
            isMobile
              ? "w-9 h-9 rounded-full bg-white/8 hover:bg-white/14 flex items-center justify-center transition-colors"
              : "w-6 h-6 rounded-md hover:bg-white/8 flex items-center justify-center transition-colors"
          }
        >
          {isMobile
            ? <X size={16} className="text-white/85" />
            : <PanelRightClose size={15} className="text-gray-400" />}
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
          affordance for every right-side panel, mirroring how
          SynthesisUpdatesPanel handles dismissal. We right-pad the row
          so the kind label clears the always-visible chevron. Mobile
          keeps an X because the bottom-sheet form factor lives at the
          bottom of the screen and reaching the top-right corner mid-
          read is awkward; the sheet also supports drag-to-dismiss. */}
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
            : node.kind === "category" ? node.label : node.kind}
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

const NEURON_TYPE_THEME = {
  basic: {
    title: "Basic Neuron",
    short: "A single fact about you",
    description:
      "Atomic memory the AI can lean on. Anything from \"I work as a designer\" to \"I focus best in the morning.\" It joins your other learned neurons and the AI uses it for context on every reply.",
    // Light/dark blue family — the same accent the rest of the product
    // uses for primary signal (LandingPrototype start pill, sidebar
    // active state, neuron pill on the wake screen). Keeping basic
    // neurons on this palette makes them read as a first-class part of
    // the product chrome rather than a one-off violet.
    accent: "blue",
    accentHex: "#60a5fa", // blue-400
    accentRing: "border-blue-400/35",
    accentChip: "bg-blue-500/15 text-blue-200 border-blue-400/30",
    accentGlow: "shadow-[0_0_60px_rgba(96,165,250,0.5)]",
  },
  belief: {
    title: "Core Belief Neuron",
    short: "A principle that shapes every reply",
    description:
      "The principles you live by. The AI runs every reply through these before anything else — they shape how it answers, what it suggests, and what it pushes back on. Example: \"Treat others the way you want to be treated.\"",
    // Same blue family as Basic neuron — both creation flows are
    // first-class product chrome and should read as one consistent
    // visual surface, not two competing palettes.
    accent: "blue",
    accentHex: "#60a5fa", // blue-400
    accentRing: "border-blue-400/35",
    accentChip: "bg-blue-500/15 text-blue-200 border-blue-400/30",
    accentGlow: "shadow-[0_0_60px_rgba(96,165,250,0.5)]",
  },
} as const;

type NeuronCreationModalProps = {
  type: "basic" | "belief";
  onClose: () => void;
  /** Called after a successful save with the server-returned id (for
      beliefs the lykn_beliefs UUID; for basic neurons the fact id). */
  onCreated: (newId: string | null) => void;
};

function NeuronCreationModal({ type, onClose, onCreated }: NeuronCreationModalProps) {
  const theme = NEURON_TYPE_THEME[type];
  const [phase, setPhase] = useState<"compose" | "forming">("compose");

  // compose-phase state — both modal types are now just a single text
  // field, so we don't need any per-type form state. Beliefs default
  // their `serves_need` to "value" (the closest fit for craft-identity
  // principles, which is what most user-authored beliefs are); the user
  // can re-categorize from the Core Beliefs panel's inline need-edit.
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the forming-phase visual displays as the freshly-minted neuron's
  // body text. Frozen at submit time so input edits don't bleed in mid-
  // animation.
  const [formedText, setFormedText] = useState("");

  const canSubmit = !!text.trim() && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const t = text.trim();
    try {
      let res: Response;
      if (type === "basic") {
        // Always send 'identity' — the server's reconciler downgrades /
        // reclassifies the kind based on text content if it obviously
        // fits another bucket (focus / goal / etc.).
        res = await fetch(`${API_BASE_URL}/api/learned`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: t, kind: "identity" }),
        });
      } else {
        // Default servesNeed to "value" — most user-authored beliefs are
        // about craft, identity, or how-they-work, which fits the Hyrum
        // Smith "value" need (feeling capable / your work matters). The
        // user can re-categorize later via the Core Beliefs panel's
        // inline need editor.
        res = await fetch(`${API_BASE_URL}/api/beliefs/manual`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: t, servesNeed: "value" }),
        });
      }
      const body = await res.json().catch(() => null);
      // Both endpoints can fail in two ways: HTTP non-2xx, or HTTP 200
      // with `{ ok: false, reason }` (defensive — server wraps these
      // now, but treat both paths as failure regardless). Surface the
      // reason verbatim so the user sees why instead of a generic
      // "try again" that hides bugs.
      if (!res.ok || (body && body.ok === false)) {
        const reason =
          body?.error ||
          body?.reason ||
          (res.status === 401 ? "auth_required" : null) ||
          `http_${res.status}`;
        setError(`Couldn't save — ${reason}.`);
        setSubmitting(false);
        return;
      }
      const newId =
        type === "belief"
          ? (body?.belief?.id ?? null)
          : (body?.fact?.id ?? null);

      // Phase 2: hold the modal open through the formation animation.
      // Roughly 1.4s of "neuron forming", then close + handoff.
      setFormedText(t);
      setPhase("forming");
      window.setTimeout(() => {
        onCreated(newId);
        onClose();
      }, 1400);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "network_error";
      setError(`Couldn't save — ${msg}.`);
      setSubmitting(false);
    }
  };

  return (
    // Backdrop — full-screen, dimmed, click-outside to cancel ONLY in
    // compose phase; once forming is playing we lock interactions so the
    // user actually watches the animation through.
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 backdrop-blur-md p-4"
      onClick={() => { if (phase === "compose") onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={theme.title}
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.96 }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}
        onClick={(e) => e.stopPropagation()}
        className={`relative w-full max-w-md rounded-2xl bg-[rgba(15,15,18,0.97)] border ${theme.accentRing} shadow-[0_30px_80px_rgba(0,0,0,0.55)] overflow-hidden`}
      >
        {phase === "compose" ? (
          <>
            {/* Header — type name + short tagline + X */}
            <div className="px-5 pt-5 pb-3 flex items-start justify-between gap-3 border-b border-white/8">
              <div className="min-w-0">
                <div className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 border text-[0.6rem] font-medium ${theme.accentChip} mb-2`}>
                  {type === "belief" ? <Atom size={10} /> : <Brain size={10} />}
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

            <div className="px-5 py-4 space-y-4">
              {/* Description */}
              <p className="text-[0.78rem] text-white/65 leading-relaxed">
                {theme.description}
              </p>

              {/* Form fields (type-specific) */}
              <div className="space-y-3">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  autoFocus
                  rows={3}
                  maxLength={type === "belief" ? 140 : 240}
                  placeholder={
                    type === "belief"
                      ? "e.g. 'Treat others the way you want to be treated.'"
                      : "e.g. 'Designer building LYKN solo.'"
                  }
                  className="w-full bg-black/30 border border-white/15 rounded-lg px-3 py-2.5 text-[0.85rem] text-white/95 leading-snug placeholder:text-white/30 focus:outline-none focus:border-white/30 resize-none"
                />

                {error ? (
                  <p className="text-[0.7rem] text-rose-300/85">{error}</p>
                ) : null}
              </div>
            </div>

            {/* Footer — Save only. Cancel/dismiss is the X in the header
                (and clicking the dimmed backdrop), so a second cancel
                button down here was redundant chrome. */}
            <div className="px-5 pb-5 pt-2">
              <button
                onClick={submit}
                disabled={!canSubmit}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border bg-blue-500/22 hover:bg-blue-500/32 border-blue-400/40 text-blue-100 text-[0.82rem] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Save neuron
              </button>
            </div>
          </>
        ) : (
          // Forming phase — the "watch it get created" moment.
          <NeuronFormingVisual theme={theme} text={formedText} />
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
  const { user, signInWithOAuth } = useAuth();
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
  // The welcome modal is no longer the on-page-load greeter for the
  // synthesis layer — the SynthesisUpdatesPanel ("Recent activity" right-
  // side pullout) is. We keep the showWelcome state and setter around so
  // the prototype-handoff animation flow's `setShowWelcome(false)` calls
  // still compile, but the WelcomePanel itself is no longer rendered
  // anywhere on this page. Default is false unconditionally.
  const [showWelcome, setShowWelcome] = useState(false);

  // Recent-activity panel open state. Lifted to the page so the toolbar
  // can render a "Recent activity" reopen pill when the panel is closed,
  // and so the page is the single source of truth for "is the right-
  // side updates pullout currently visible." Auto-opens on mount; close
  // is in-memory only (no persisted dismissal) so reload reopens.
  const [updatesOpen, setUpdatesOpen] = useState(true);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [dimensions, setDimensions] = useState({ w: 1200, h: 800 });
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("connections");
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showTagMenu, setShowTagMenu] = useState(false);
  // Core Beliefs slide-out — the user-facing surface for the layer above
  // atomic facts (need → belief → rule → result). Lazy-mounts on first open.
  const [beliefWindowOpen, setBeliefWindowOpen] = useState(false);
  // The "+" toolbar menu — { Basic neuron, Core Belief neuron }. Tap a
  // type and the menu closes; a centered creation modal takes over.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // Which neuron creation modal (if any) is currently open. Single source
  // of truth — only one modal at a time, and the backdrop dimming is
  // implicit in this state.
  const [creatingNeuronType, setCreatingNeuronType] = useState<"basic" | "belief" | null>(null);
  // After a successful belief save, we stash the new belief's id here so
  // the graph-side formation animation can fire as soon as the refetched
  // useQuery surfaces the corresponding `belief_<id>` node. Cleared once
  // the animation has been triggered.
  const [pendingFormingBeliefId, setPendingFormingBeliefId] = useState<string | null>(null);
  // Same idea as pendingFormingBeliefId, but for Basic neurons (atomic facts
  // saved to lykn_user_model_facts). The forming-watcher waits for the
  // matching `fact_<uuid>` graph node to appear after the manualFacts
  // query refetches, then plays the camera-focus pulse on it. Without
  // this the basic-neuron Save would persist the row + invalidate the
  // query but produce no visible feedback in the graph itself.
  const [pendingFormingFactId, setPendingFormingFactId] = useState<string | null>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const tagMenuRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);

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
  //   • lykn_project_state UPDATE                  → updates panel + project state
  //
  // Filters: all three are scoped server-side to user_id=eq.<uid>. The
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

    const channel = supabase
      .channel(`synthesis-live:${uid}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lykn_user_model_facts", filter: `user_id=eq.${uid}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ["mindmap_manual_facts", uid] });
          // Synthesis profile + chunks roll fact-derived themes/topics
          // into the AI Learned cluster — invalidate them too so the
          // graph picks up the new neuron alongside the raw fact.
          queryClient.invalidateQueries({ queryKey: ["mindmap_synthesis_profile", uid] });
          queryClient.invalidateQueries({ queryKey: ["mindmap_synthesis_chunks", uid] });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lykn_beliefs", filter: `user_id=eq.${uid}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ["mindmap_active_beliefs", uid] });
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "lykn_project_state", filter: `user_id=eq.${uid}` },
        () => {
          // SynthesisUpdatesPanel refetches /api/v1/synthesis/activity
          // every time it opens, so we don't need to invalidate it
          // here. We DO want the projects list to refresh in case a
          // remote push created/renamed/archived a project.
          queryClient.invalidateQueries({ queryKey: ["mindmap_projects", uid] });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user?.id, queryClient]);

  /* Data queries */
  const { data: projects = [], isFetched: projectsFetched } = useQuery({
    queryKey: ["mindmap_projects", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data } = await supabase.from("omnia_projects").select("id, name").eq("user_id", user.id).order("updated_at", { ascending: false }).limit(50);
      return data || [];
    },
    enabled: !!user?.id,
  });

  const { data: boards = [], isFetched: boardsFetched } = useQuery({
    queryKey: ["mindmap_boards", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data } = await supabase.from("omnia_boards").select("id, title, project_id").eq("user_id", user.id).order("updated_at", { ascending: false }).limit(80);
      return data || [];
    },
    enabled: !!user?.id,
  });

  const { data: notes = [], isFetched: notesFetched } = useQuery({
    queryKey: ["mindmap_notes", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data } = await supabase.from("notes").select("id, title, content, tags, ai_summary, ai_signals").eq("user_id", user.id).order("updated_at", { ascending: false }).limit(100);
      return data || [];
    },
    enabled: !!user?.id,
  });

  const { data: synthesisProfile, isFetched: profileFetched } = useQuery({
    queryKey: ["mindmap_synthesis_profile", user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data } = await supabase.from("lykn_user_synthesis_profile").select("themes, signals, narrative").eq("user_id", user.id).maybeSingle();
      return data;
    },
    enabled: !!user?.id,
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
  });

  // Active beliefs (Hyrum-Smith belief-window layer). Rendered as their own
  // category cluster in the 3D scene so the user can see the principles the
  // AI is currently answering through. The detailed Accept/Edit/Retire
  // affordances live in BeliefWindowPanel — this query just feeds the graph.
  const { data: activeBeliefs = [] } = useQuery({
    queryKey: ["mindmap_active_beliefs", user?.id, beliefWindowOpen],
    queryFn: async () => {
      if (!user?.id) return [] as Array<{
        id: string; belief_text: string; serves_need: string; confidence: number;
      }>;
      const { data } = await supabase
        .from("lykn_beliefs")
        .select("id, belief_text, serves_need, confidence")
        .eq("user_id", user.id)
        .eq("status", "active")
        .order("confidence", { ascending: false })
        .limit(30);
      return (data || []) as Array<{
        id: string; belief_text: string; serves_need: string; confidence: number;
      }>;
    },
    enabled: !!user?.id,
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
      const { data } = await supabase
        .from("lykn_user_model_facts")
        .select("id, fact_kind, fact_text, status, confidence")
        .eq("user_id", user.id)
        .in("status", ["stated", "confirmed"])
        .order("last_seen_at", { ascending: false })
        .limit(60);
      return (data || []) as Array<{
        id: string; fact_kind: string; fact_text: string; status: string; confidence: number;
      }>;
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
  // localStorage so this page can show them on every visit during the
  // walkthrough — including the moment a guest signs UP mid-walkthrough,
  // when `user?.id` flips on but we still want their freshly-formed
  // neuron to drive the scene rather than an empty / demo workspace.
  //
  // Held in component state (not just a useMemo on mount) so that when
  // an EXISTING user signs IN mid-walkthrough we can clear the
  // prototype data reactively and re-render with their real workspace
  // instead of being stuck on the prototype page until a refresh.
  const [prototypeNeurons, setPrototypeNeurons] = useState(() => readPrototypeNeurons());
  const [prototypeChat, setPrototypeChat] = useState(() => readPrototypeChat());

  // Bug fix (2026-05): if a guest goes through the landing walkthrough
  // and then signs into an EXISTING account, we used to keep showing
  // the prototype's "empty workspace + 1 neuron" instead of their real
  // synthesis layer. Detect that case here: signed in + queries
  // finished + at least one piece of real data exists → wipe prototype
  // state and let the real synthesisData/projects/boards render.
  //
  // We deliberately wait for *every* query to settle before deciding,
  // otherwise we'd nuke the prototype during the brief loading window
  // when all defaults are `[]` and we'd misclassify a genuinely empty
  // brand-new account as "no data → keep prototype".
  const allQueriesFetched =
    projectsFetched && boardsFetched && notesFetched && profileFetched && chunksFetched;
  useEffect(() => {
    if (!user?.id) return;
    if (prototypeNeurons.length === 0) return;
    if (!allQueriesFetched) return;
    const hasRealData =
      (projects?.length || 0) > 0 ||
      (boards?.length || 0) > 0 ||
      (notes?.length || 0) > 0 ||
      (synthesisChunks?.length || 0) > 0 ||
      Boolean(synthesisProfile);
    // Account-age check: a brand new sign-up triggered from inside the
    // walkthrough will have created_at within the last few minutes —
    // keep the prototype scene so their walkthrough continues. Anything
    // older than this is an EXISTING account being signed into mid-
    // walkthrough; treat it as "not the same person whose neuron is in
    // localStorage" and drop the prototype even if their workspace is
    // currently empty.
    const FRESH_ACCOUNT_GRACE_MS = 5 * 60 * 1000;
    const createdAtMs = user.created_at ? Date.parse(user.created_at) : NaN;
    const isExistingAccount =
      Number.isFinite(createdAtMs) &&
      Date.now() - createdAtMs > FRESH_ACCOUNT_GRACE_MS;
    if (!hasRealData && !isExistingAccount) return;
    // Existing user (or new user with real data) just signed in — drop
    // the prototype state so we render their real synthesis layer.
    clearPrototypeState();
    setPrototypeNeurons([]);
    setPrototypeChat([]);
  }, [
    user?.id,
    user?.created_at,
    allQueriesFetched,
    prototypeNeurons.length,
    projects,
    boards,
    notes,
    synthesisChunks,
    synthesisProfile,
  ]);

  // True whenever we're rendering the landing-prototype walkthrough —
  // i.e. the visitor created at least one neuron in the landing chat
  // and we're still inside the guided tour. The effect above tears
  // this back down once an existing signed-in user is detected.
  const isPrototypeHandoff = prototypeNeurons.length > 0;

  // No more demo-content fallback. Brand-new signed-in users with no
  // projects/boards used to see a synthetic "Morning practice / Harbor /
  // Greenroom" workspace stitched in from `demoSynthesis.js`; that demo
  // shipped the user out of the walkthrough into a fake mind that wasn't
  // theirs. Now the synthesis layer only ever shows real data + the
  // user's prototype handoff, with an empty workspace falling through to
  // the standard empty-state placeholder below.
  const effectiveProjects = useMemo(
    () => (isPrototypeHandoff ? [] : projects),
    [isPrototypeHandoff, projects],
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
      return boards;
    },
    [isPrototypeHandoff, boards, prototypeChat],
  );
  // For guests we intentionally bypass `notes` as a dependency — the
  // `useQuery` destructuring default (`= []`) produces a new empty array
  // reference on every render, which would otherwise invalidate this memo
  // (and every downstream memo) on every hover tick, re-seeding the force
  // layout with fresh random jitter.
  const effectiveNotes = useMemo<NoteRow[]>(() => {
    if (isPrototypeHandoff) return [];
    if (!user?.id) return [];
    return notes as NoteRow[];
  }, [isPrototypeHandoff, user?.id, notes]);

  const synthesisData: SynthesisData | null = useMemo(() => {
    // Prototype handoff: surface only the user's freshly-created
    // neuron(s). Everything else (projects, grids, vault, tags) renders
    // as an empty category shell so the page reads as a brand-new mind
    // with exactly one thing in it.
    if (isPrototypeHandoff) {
      return {
        themes: prototypeNeurons.map((n) => n.text),
        narrative:
          "This is your synthesis layer the moment it woke up. The neuron you just created is the only thing here — your projects, chats, vault, and tags are waiting to be filled.",
        signals: {},
      };
    }
    if (!synthesisProfile) return null;
    return {
      themes: Array.isArray(synthesisProfile.themes) ? synthesisProfile.themes : [],
      narrative: synthesisProfile.narrative || "",
      signals: (synthesisProfile.signals && typeof synthesisProfile.signals === "object") ? synthesisProfile.signals as Record<string, any> : {},
    };
  }, [synthesisProfile, isPrototypeHandoff, prototypeNeurons]);

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
      const built = buildGraph(effectiveProjects, effectiveBoards, effectiveNotes, synthesisThemes, synthesisData, vaultGridMap, activeBeliefs, manualFacts, forceCategoryIds, rootLabel);
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
    [effectiveProjects, effectiveBoards, effectiveNotes, synthesisThemes, synthesisData, vaultGridMap, activeBeliefs, manualFacts, forceCategoryIds, rootLabel, isPrototypeHandoff, prototypeNeurons],
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
      // Close the "+" add menu when clicking outside its anchor. The
      // modal that opens after picking a type lives at page-root and has
      // its own backdrop click-to-close — it doesn't share this ref.
      if (addMenuOpen && addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showModeMenu, showTagMenu, addMenuOpen]);

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
  }, [prototypeNeurons]);

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
    // Belief nodes (or the Beliefs category itself) shortcut to the
    // BeliefWindowPanel — that's where ratification, rule editing, and
    // the Why log live. Selecting them in the 3D scene with no panel
    // would just show a label nobody can act on.
    if (node.kind === "belief" || nodeId === "__cat_beliefs__") {
      setBeliefWindowOpen(true);
      // Still mark it selected so the 3D camera flies to it — the user
      // sees their principle highlighted while the panel slides in.
      setSelectedId(nodeId);
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

  // After a successful "Core Belief neuron" save, the modal sets
  // pendingFormingBeliefId to the new belief's UUID and triggers an
  // active-beliefs refetch. This effect waits for the matching
  // `belief_<uuid>` graph node to appear, then fires the same formation
  // pulse the prototype handoff uses (line draws toward the node, neuron
  // scales in, camera focuses on it). Bails after a 4s timeout so we
  // don't leave the page waiting on a query that never resolves.
  const beliefFormingWatchTimeouts = useRef<number[]>([]);
  useEffect(() => {
    if (!pendingFormingBeliefId) return;
    const targetId = `belief_${pendingFormingBeliefId}`;
    if (!nodeMap.has(targetId)) return;
    setFormingNodeId(targetId);
    setShowWelcome(false);
    const focusAt = window.setTimeout(() => setSelectedId(targetId), 400);
    const clearAt = window.setTimeout(() => setFormingNodeId(null), 2000);
    beliefFormingWatchTimeouts.current.push(focusAt, clearAt);
    setPendingFormingBeliefId(null);
  }, [pendingFormingBeliefId, nodeMap]);

  // Mirror of the belief-formation watcher above, but for Basic neurons.
  // The modal sets pendingFormingFactId to the new fact's UUID and
  // invalidates the manualFacts query. Once the query refetches and the
  // matching `fact_<uuid>` node appears in the graph, we run the same
  // formation pulse so the user actually watches their neuron land in
  // the scene instead of wondering whether Save did anything.
  useEffect(() => {
    if (!pendingFormingFactId) return;
    const targetId = `fact_${pendingFormingFactId}`;
    if (!nodeMap.has(targetId)) return;
    setFormingNodeId(targetId);
    setShowWelcome(false);
    const focusAt = window.setTimeout(() => setSelectedId(targetId), 400);
    const clearAt = window.setTimeout(() => setFormingNodeId(null), 2000);
    beliefFormingWatchTimeouts.current.push(focusAt, clearAt);
    setPendingFormingFactId(null);
  }, [pendingFormingFactId, nodeMap]);

  useEffect(() => {
    return () => {
      beliefFormingWatchTimeouts.current.forEach((id) => window.clearTimeout(id));
      beliefFormingWatchTimeouts.current = [];
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
  // Unified "is any right-side pullout open?" so the top-right chevron
  // toggle can act as the single close affordance for ALL right-edge
  // panels (Recent activity, Core Beliefs, Detail, Welcome). Previously
  // each panel had its own internal X button and the chevron only knew
  // about Recent activity, which made the close UX inconsistent.
  const anyRightPanelOpen =
    updatesOpen || beliefWindowOpen || selectedNode != null || showWelcome;
  const closeAllRightPanels = useCallback(() => {
    setUpdatesOpen(false);
    setBeliefWindowOpen(false);
    setSelectedId(null);
    setShowWelcome(false);
  }, []);
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
        description={`Your Free plan includes the Synthesis Layer up to ${FREE_SYNTHESIS_NODE_LIMIT} nodes. You've reached ${userCreatedNodeCount} — upgrade to Pro for the full, unlimited mind map.`}
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
            neurons={allNodes
              .filter((n) => n.kind === "neuron")
              .map((n) => n.label)}
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
      />

      {/* "What's new" right-side pullout — auto-opens once per browser
          session when there are events newer than the user's last visit.
          Replaces both the prior bottom-right card stack iteration AND
          the standalone "Activity" toolbar button: this surface is the
          one entry point for "what changed in my synthesis layer." See
          ui_updates_experience in project state (claude-desktop revised
          spec) for the design intent. Panel is graph-agnostic; we wire
          onFocusTarget here because the page owns camera/selection state.
          Belief / fact / project node ids follow the existing
          `<kind>_<uuid>` convention used by buildGraph. */}
      <SynthesisUpdatesPanel
        active
        open={updatesOpen}
        onClose={() => setUpdatesOpen(false)}
        onFocusTarget={(target) => {
          if (target.kind === "rule") return;
          const nodeId =
            target.kind === "belief"
              ? `belief_${target.id}`
              : target.kind === "fact"
                ? `fact_${target.id}`
                : `project_${target.id}`;
          setSelectedId(nodeId);
        }}
      />

      {/* Universal right-side pullout toggle — mirrors the AppSidebar's
          chevron on the left edge. Always visible, always at the same
          fixed corner, and sits at z-[100] so it stays on top of every
          right-edge panel (Recent activity z-[80], Core Beliefs z-[90],
          Detail panel z-30) and acts as a single close affordance for
          all of them. Behavior:
            • If any right-side panel is open → close them all.
            • If none are open → open the Recent activity panel (the
              default, since that's the panel users open most often).
          Each panel still ships with its own internal X for proximity,
          but the chevron is the canonical "dismiss the right side" UI. */}
      <button
        type="button"
        onClick={() => {
          if (anyRightPanelOpen) {
            closeAllRightPanels();
          } else {
            setUpdatesOpen(true);
          }
        }}
        className={
          isMobile
            ? "fixed top-3 right-3 z-[100] rounded-full w-8 h-8 hover:bg-blue-500/15 dark:hover:bg-blue-400/20 transition-colors flex items-center justify-center"
            : "fixed top-4 right-4 z-[100] rounded-full w-8 h-8 hover:bg-blue-500/15 dark:hover:bg-blue-400/20 transition-colors flex items-center justify-center"
        }
        title={anyRightPanelOpen ? "Hide panel" : "Show panel"}
        aria-label={anyRightPanelOpen ? "Hide right-side panel" : "Show recent activity"}
      >
        {anyRightPanelOpen ? (
          <ChevronRight className="w-4 h-4" />
        ) : (
          <ChevronLeft className="w-4 h-4" />
        )}
      </button>

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
            onClose={() => setCreatingNeuronType(null)}
            onCreated={(newId) => {
              if (creatingNeuronType === "belief" && newId) {
                // Belief nodes render directly off the active-beliefs
                // query, so once we refetch the new node will appear in
                // the graph and the watcher effect will trigger the
                // formingNodeId pulse.
                setPendingFormingBeliefId(newId);
                queryClient.invalidateQueries({ queryKey: ["mindmap_active_beliefs", user?.id] });
              } else {
                // Basic neurons land in lykn_user_model_facts. We render
                // user-stated/confirmed rows directly via the manualFacts
                // query so the new node shows up immediately — the
                // synthesis profile rebuild that would normally roll
                // these into themes/topics happens out-of-band on a
                // background cadence, way too slow to feel like a save.
                if (newId) setPendingFormingFactId(newId);
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
        <span>{effectiveProjects.length} projects</span>
        <span className="w-px h-3 bg-white/15" />
        <span>{effectiveBoards.length} chats</span>
        <span className="w-px h-3 bg-white/15" />
        <span>{effectiveNotes.length} notes</span>
      </div>

      {/* Bottom-right control cluster — add-neuron button on the LEFT,
          zoom controls (in / out / reset) on the RIGHT. Two separate
          flex children so the "+" can be a larger circular button while
          the zoom controls stay as a tight square stack. The flex
          container is bottom-anchored on the right edge of the canvas
          and shifts left when the detail panel opens. */}
      <div
        className="absolute bottom-6 z-20 flex items-end gap-2.5 transition-[right] duration-300"
        style={{ right: panelOpen || beliefWindowOpen || updatesOpen ? 384 : 24 }}
      >
        {/* Add-neuron entry — bigger, circular, sits visually as the
            primary action of the cluster. Picking a type opens a
            centered creation modal. */}
        <div ref={addMenuRef} className="relative">
          <button
            onClick={() => setAddMenuOpen((v) => !v)}
            className={`w-11 h-11 rounded-full backdrop-blur border flex items-center justify-center shadow-[0_6px_20px_rgba(0,0,0,0.35)] transition-colors ${
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
                // to the right side of the canvas, so the popover (224px
                // wide) needs to grow into the open canvas to its left
                // — anchoring `left-0` instead would push the popover off
                // the right edge of the viewport. z-50 keeps it stacked
                // above the zoom-column siblings.
                className="absolute bottom-full right-0 mb-2 w-56 rounded-xl bg-[rgba(15,15,18,0.97)] backdrop-blur-xl border border-white/15 shadow-[0_14px_40px_rgba(0,0,0,0.5)] overflow-hidden z-50"
                role="menu"
              >
                <button
                  role="menuitem"
                  onClick={() => {
                    setAddMenuOpen(false);
                    setCreatingNeuronType("basic");
                  }}
                  className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-white/8 transition-colors"
                >
                  <Brain size={13} className="mt-0.5 text-blue-300/85 flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[0.72rem] font-medium text-white/90">Basic neuron</div>
                    <div className="text-[0.62rem] text-white/45 mt-0.5 leading-snug">
                      A single fact about you the AI should remember.
                    </div>
                  </div>
                </button>
                <div className="h-px bg-white/8" />
                <button
                  role="menuitem"
                  onClick={() => {
                    setAddMenuOpen(false);
                    setCreatingNeuronType("belief");
                  }}
                  className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-white/8 transition-colors"
                >
                  <Atom size={13} className="mt-0.5 text-blue-300/85 flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[0.72rem] font-medium text-white/90">Core Belief neuron</div>
                    <div className="text-[0.62rem] text-white/45 mt-0.5 leading-snug">
                      A principle that shapes every reply.
                    </div>
                  </div>
                </button>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        {/* Zoom + reset stack */}
        <div className="flex flex-col gap-1.5">
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
      </div>

      {/* Legend */}
      <div className="absolute bottom-6 left-6 z-20 flex flex-wrap gap-3 text-[0.625rem] text-white/55 pointer-events-none">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.projects.bg, color: palette.projects.bg }} /> Projects</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.grids.bg, color: palette.grids.bg }} /> Chats</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.vault.bg, color: palette.vault.bg }} /> Vault</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.tags.bg, color: palette.tags.bg }} /> Tags</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.neurons.bg, color: palette.neurons.bg }} /> AI Learned</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.beliefs.bg, color: palette.beliefs.bg }} /> Beliefs</span>
      </div>

      {/* Orbit hint — first-time users may not realise drag = orbit (not pan).
          Fades after a few seconds via CSS animation; tiny enough to ignore. */}
      <div
        className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 text-[0.6rem] text-white/40 pointer-events-none animate-pulse"
      >
        drag to orbit · scroll to zoom · shift+drag to pan
      </div>

      {/* Neuron detail panel — opens when a node is selected (from a graph
          tap, an updates-panel row click, or a programmatic focus). The
          welcome modal that used to live in this slot has been retired:
          on-page-load greeting is now the SynthesisUpdatesPanel auto-open
          on the right edge. */}
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
