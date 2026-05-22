import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence, useDragControls } from "framer-motion";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { useUserPlan } from "@/lib/useUserPlan";
import PlanGate from "@/components/PlanGate";
import { PLAN_LIMITS } from "@/lib/pricing-config";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Atom,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
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
} from "lucide-react";
import BeliefWindowPanel from "@/components/synthesis/BeliefWindowPanel";
import { API_BASE_URL } from "@/lib/api-config";
import { GridIcon } from "@/components/ui/GridIcon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  appendPrototypeNeuron,
  clearPrototypeState,
  hasPrototypeNeurons,
  readPrototypeChat,
  readPrototypeNeurons,
  readPrototypeStep,
  readPrototypeTourMode,
  writePrototypeStep,
  writePrototypeTourMode,
} from "@/lib/prototypeHandoff";

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
  // (The Projects category was retired when the sidebar projects feature
  // was removed; the palette swatch + per-node color went with it. Boards
  // still carry `project_id` in their DB row but the synthesis-layer page
  // no longer surfaces that grouping — they all hang directly off the
  // Chats category now.)
  grids:    { bg: "#3b82f6", glow: "rgba(59,130,246,0.30)" },
  vault:    { bg: "#10b981", glow: "rgba(16,185,129,0.30)" },
  tags:     { bg: "#f59e0b", glow: "rgba(245,158,11,0.30)" },
  neurons:  { bg: "#ec4899", glow: "rgba(236,72,153,0.30)" },
  // Beliefs are the layer above neurons — palette emphasizes that this is
  // a separate, higher-order tier (deeper indigo, brighter glow) so the
  // user reads the cluster as "principles" not just more facts.
  beliefs:  { bg: "#818cf8", glow: "rgba(129,140,248,0.40)" },
  // Concepts are the cross-cutting topic layer (056-058 migrations).
  // Palette is a warm amber so they read as a third cluster distinct
  // from neurons (pink) and beliefs (indigo). The concept cluster
  // semantically lives "between" beliefs and the raw notes/facts —
  // they organise everything else without being normative.
  concepts: { bg: "#f97316", glow: "rgba(249,115,22,0.35)" },
  // Facts — the user-authored side of the "AI Learned" axis. Same
  // top-level container shape as Chats / Vault / Beliefs / Concepts;
  // colored cyan so it reads as its own cluster and never gets
  // confused with the pink "AI Learned" container or the green Vault.
  facts:    { bg: "#06b6d4", glow: "rgba(6,182,212,0.35)" },
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
  // Individual concept nodes — slightly desaturated amber so they
  // recede next to belief stars but still pop out as a coherent
  // cluster amid the colored category groups around them.
  concept:  { bg: "#fb923c", glow: "rgba(251,146,60,0.30)" },
};

/* ------------------------------------------------------------------ */
/*  Build graph                                                        */
/* ------------------------------------------------------------------ */

// `content` is intentionally NOT in the mindmap notes query — it can run
// into hundreds of KB for power users and the graph only needs the
// summary/themes for cross-edge heuristics. The DetailPanel lazy-fetches
// the body when a vault node is actually opened (see `vaultContentQuery`).
// Optional here so legacy callers (e.g. WelcomePanel removal) still compile.
type NoteRow = { id: string; title?: string; content?: string; tags?: string[]; ai_summary?: string | null; ai_signals?: any; source?: string | null };

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
// New connector sources without an entry here fall through to the
// individual-node path (they look like manual saves). Add new rows as
// new connectors land in `connectors/` if they're high-volume.
const CONNECTOR_SOURCE_APPS: Record<string, { app: string; label: string }> = {
  // Gmail's two sub-sources collapse to one app — the user thinks of
  // "Gmail" as one thing, not "starred mail" + "inbox mail".
  gmail_starred:     { app: "gmail",     label: "Gmail" },
  gmail_inbox:       { app: "gmail",     label: "Gmail" },
  outlook_flagged:   { app: "outlook",   label: "Outlook" },
  notion_page:       { app: "notion",    label: "Notion" },
  slack_saved:       { app: "slack",     label: "Slack" },
  github_starred:    { app: "github",    label: "GitHub" },
  linear_issue:      { app: "linear",    label: "Linear" },
  todoist:           { app: "todoist",   label: "Todoist" },
  trello_card:       { app: "trello",    label: "Trello" },
  readwise:          { app: "readwise",  label: "Readwise" },
  raindrop_bookmark: { app: "raindrop",  label: "Raindrop" },
  spotify_liked:     { app: "spotify",   label: "Spotify" },
  vimeo_liked:       { app: "vimeo",     label: "Vimeo" },
  youtube_liked:     { app: "youtube",   label: "YouTube" },
  x_bookmark:        { app: "x",         label: "X" },
  bluesky_like:      { app: "bluesky",   label: "Bluesky" },
  pinterest_pin:     { app: "pinterest", label: "Pinterest" },
  lastfm_loved:      { app: "lastfm",    label: "Last.fm" },
  karakeep:          { app: "karakeep",  label: "Karakeep" },
  linkding:          { app: "linkding",  label: "linkding" },
  pinboard:          { app: "pinboard",  label: "Pinboard" },
  goodreads:         { app: "goodreads", label: "Goodreads" },
  hardcover:         { app: "hardcover", label: "Hardcover" },
  // Calendar events are noisy and rarely "thoughts" — roll up.
  gcal_event:        { app: "gcal",      label: "Google Calendar" },
  // Drive family all roll up under one "Google Drive" node — Docs/
  // Sheets/Slides are sub-types of the same surface from the user's
  // mental model perspective.
  gdrive_starred:    { app: "gdrive",    label: "Google Drive" },
  gdocs_starred:     { app: "gdrive",    label: "Google Drive" },
  gsheets_starred:   { app: "gdrive",    label: "Google Drive" },
  gslides_starred:   { app: "gdrive",    label: "Google Drive" },
};

function noteSourceApp(note: NoteRow): { app: string; label: string } | null {
  const src = (note.source || "").trim();
  if (!src) return null;
  return CONNECTOR_SOURCE_APPS[src] || null;
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
  boards: { id: string; title: string }[],
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
) {
  const nodes: MindNode[] = [];
  const edges: MindEdge[] = [];

  const rootId = "__root__";
  nodes.push({ id: rootId, label: rootLabel, kind: "root", radius: 42, color: palette.root.bg, glow: palette.root.glow, parentId: null, meta: { narrative: synthesis?.narrative } });

  const cats: { id: string; label: string; color: string; glow: string }[] = [];
  if (boards.length > 0 || forceCategoryIds.has("__cat_grids__")) cats.push({ id: "__cat_grids__", label: "Chats", color: palette.grids.bg, glow: palette.grids.glow });
  if (notes.length > 0 || forceCategoryIds.has("__cat_vault__")) cats.push({ id: "__cat_vault__", label: "Vault", color: palette.vault.bg, glow: palette.vault.glow });

  const allTags = new Set<string>();
  notes.forEach((n) => (n.tags || []).forEach((t) => allTags.add(t)));
  if (allTags.size > 0 || forceCategoryIds.has("__cat_tags__")) cats.push({ id: "__cat_tags__", label: "Tags", color: palette.tags.bg, glow: palette.tags.glow });

  cats.forEach((c) => {
    nodes.push({ id: c.id, label: c.label, kind: "category", radius: 30, color: c.color, glow: c.glow, parentId: rootId });
    edges.push({ from: rootId, to: c.id });
  });

  boards.forEach((b) => {
    const nid = `grid_${b.id}`;
    nodes.push({ id: nid, label: b.title || "New Chat", kind: "grid", radius: 20, color: palette.grid.bg, glow: palette.grid.glow, parentId: "__cat_grids__", categoryId: "__cat_grids__", meta: { boardId: b.id } });
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
  const rollupGroups = new Map<
    string,
    { app: string; label: string; items: Array<{ noteId: string; title: string; ai_summary: string | null; tags: string[]; sourceSlug: string }> }
  >();

  notes.forEach((n) => {
    const sourceInfo = noteSourceApp(n);
    if (sourceInfo) {
      const rollupId = sourceRollupNodeId(sourceInfo.app);
      noteIdToVaultNodeId.set(n.id, rollupId);
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

    const nid = `vault_${n.id}`;
    noteIdToVaultNodeId.set(n.id, nid);
    // Preview prefers title → summary → "Note". `content` is no longer in
    // the payload, so we can't slice the raw body here. Title/summary are
    // both bounded and arrive in the same query.
    const preview = (n.title || n.ai_summary || "").slice(0, 60).trim() || "Note";
    const noteThemes = noteThemeMap.get(n.id) || [];
    nodes.push({ id: nid, label: preview, kind: "vault", radius: 18, color: palette.note.bg, glow: palette.note.glow, parentId: "__cat_vault__", categoryId: "__cat_vault__", meta: { noteId: n.id, title: n.title, tags: n.tags, ai_summary: n.ai_summary, themes: noteThemes } });
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
    (a, b) => b[1].items.length - a[1].items.length,
  );
  sortedRollups.forEach(([rollupId, group]) => {
    // Slight radius bump for big rollups so a 200-item Gmail node
    // reads as more substantial than a 5-item Bluesky one. Capped so
    // the node never grows into category-sized territory.
    const radius = Math.min(28, 18 + Math.floor(Math.log2(group.items.length + 1) * 1.6));
    nodes.push({
      id: rollupId,
      label: `${group.label} · ${group.items.length}`,
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
        itemCount: group.items.length,
        // Cap items shipped to the client memory-side at 300. The
        // DetailPanel renders a virtualised list and is happy with
        // this much; the rollup label still shows the full count
        // above so a user with 1k+ inbox items sees the real number.
        items: group.items.slice(0, 300),
      },
    });
    edges.push({ from: "__cat_vault__", to: rollupId });
  });

  const tagArr = Array.from(allTags);
  tagArr.forEach((tag) => {
    const nid = `tag_${tag}`;
    nodes.push({ id: nid, label: `#${tag}`, kind: "tag", radius: 18, color: palette.tag.bg, glow: palette.tag.glow, parentId: "__cat_tags__", categoryId: "__cat_tags__", meta: { tag } });
    edges.push({ from: "__cat_tags__", to: nid });
    // Dedup the tag→target edges per tag. Pre-rollup every per-note
    // tag pair was unique (tag → vault_<noteId>); post-rollup many
    // tagged notes collapse to the same rollup target, so without
    // local dedup we'd push the same `tag_x → vault_source_gmail`
    // edge dozens of times. `edgeSet` below would still dedup it for
    // cross-edge passes, but these edges aren't created via
    // `addCrossEdge` so they'd otherwise survive.
    const seen = new Set<string>();
    notes.forEach((n) => {
      if (!(n.tags || []).includes(tag)) return;
      const target = vaultNodeIdFor(n.id);
      if (seen.has(target)) return;
      seen.add(target);
      edges.push({ from: nid, to: target, cross: true });
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

  if (neuronItems.length > 0 || forceCategoryIds.has("__cat_neurons__")) {
    cats.push({ id: "__cat_neurons__", label: "AI Learned", color: palette.neurons.bg, glow: palette.neurons.glow });
  }

  // Beliefs — promoted, user-ratified principles that sit ABOVE atomic
  // facts. Render as their own cluster so the user reads them as a
  // separate, higher-order tier (visually closer to the root than the
  // long-tail neurons).
  if (beliefs.length > 0 || forceCategoryIds.has("__cat_beliefs__")) {
    cats.push({ id: "__cat_beliefs__", label: "Beliefs", color: palette.beliefs.bg, glow: palette.beliefs.glow });
  }

  // Concepts — first-class topic layer (migrations 056-058). Lives as
  // its own category sibling to Beliefs so the user reads it as the
  // cross-cutting glue between the colored clusters around it. We hide
  // dismissed concepts and concepts with zero attachments by default
  // — the orange dots only earn their pixels when they're tying
  // something together. Filtering happens here so downstream layout +
  // cross-edge passes only see the kept concepts.
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

  // Facts — top-level container for things the user explicitly puts in
  // about themselves (the user-authored counterpart to AI Learned).
  // Every row coming out of `manualFacts` is something the user said
  // out loud / typed into the Fact composer, so this is the home for
  // them — AI Learned stays reserved for synthesis-derived themes,
  // goals, and recurring topics the AI inferred on its own.
  if (manualFacts.length > 0 || forceCategoryIds.has("__cat_facts__")) {
    cats.push({ id: "__cat_facts__", label: "Facts", color: palette.facts.bg, glow: palette.facts.glow });
  }

  // (categories were already pushed above, but neurons cat needs to go in too)
  if ((neuronItems.length > 0 || forceCategoryIds.has("__cat_neurons__")) && !nodes.some((n) => n.id === "__cat_neurons__")) {
    nodes.push({ id: "__cat_neurons__", label: "AI Learned", kind: "category", radius: 30, color: palette.neurons.bg, glow: palette.neurons.glow, parentId: rootId });
    edges.push({ from: rootId, to: "__cat_neurons__" });
  }
  if ((beliefs.length > 0 || forceCategoryIds.has("__cat_beliefs__")) && !nodes.some((n) => n.id === "__cat_beliefs__")) {
    nodes.push({ id: "__cat_beliefs__", label: "Beliefs", kind: "category", radius: 32, color: palette.beliefs.bg, glow: palette.beliefs.glow, parentId: rootId });
    edges.push({ from: rootId, to: "__cat_beliefs__" });
  }
  if ((liveConcepts.length > 0 || forceCategoryIds.has("__cat_concepts__")) && !nodes.some((n) => n.id === "__cat_concepts__")) {
    nodes.push({ id: "__cat_concepts__", label: "Concepts", kind: "category", radius: 30, color: palette.concepts.bg, glow: palette.concepts.glow, parentId: rootId });
    edges.push({ from: rootId, to: "__cat_concepts__" });
  }
  if ((manualFacts.length > 0 || forceCategoryIds.has("__cat_facts__")) && !nodes.some((n) => n.id === "__cat_facts__")) {
    nodes.push({ id: "__cat_facts__", label: "Facts", kind: "category", radius: 30, color: palette.facts.bg, glow: palette.facts.glow, parentId: rootId });
    edges.push({ from: rootId, to: "__cat_facts__" });
  }

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
      parentId: "__cat_beliefs__",
      categoryId: "__cat_beliefs__",
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
    edges.push({ from: "__cat_beliefs__", to: nid });
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
      color: palette.neuron.bg, glow: palette.neuron.glow,
      parentId: "__cat_neurons__", categoryId: "__cat_neurons__",
      meta: { neuronKind: ni.kind, source: ni.source, kindLabel },
    });
    edges.push({ from: "__cat_neurons__", to: ni.id });

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
  { id: "section",     label: "By Section",     icon: LayoutGrid },
  { id: "connections", label: "Most Connected", icon: Network },
  { id: "topic",       label: "By Idea",        icon: Sparkles },
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
        setError(`Couldn't accept (status ${res.status}). Try again.`);
        return;
      }
      setStatus("active");
      // Refresh the belief cluster + load-in greeting so the badge
      // count drops and the node re-colors to "active".
      queryClient.invalidateQueries({ queryKey: ["mindmap_active_beliefs"] });
      queryClient.invalidateQueries({ queryKey: ["belief_window"] });
    } catch (e) {
      setError((e as Error)?.message || "Network error. Try again.");
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
        setError(upErr.message || "Couldn't accept. Try again.");
        return;
      }
      setStatus("confirmed");
      queryClient.invalidateQueries({ queryKey: ["mindmap_manual_facts"] });
    } catch (e) {
      setError((e as Error)?.message || "Network error. Try again.");
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
      setError((e as Error).message);
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
      setError((e as Error).message);
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
      setError((e as Error).message);
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
      setError((e as Error).message);
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
    : null;

  // Lazy-fetch the full vault note body only when this panel is actually
  // opened for a vault node. The mindmap notes query intentionally drops
  // `content` to keep the page-load payload small (see NoteRow comment);
  // here we pay one small round-trip on click and react-query caches the
  // result so re-opening the same note is instant.
  const vaultNoteId = node.kind === "vault" ? (node.meta?.noteId as string | undefined) : undefined;
  const { data: vaultContent } = useQuery({
    queryKey: ["mindmap_vault_note_content", vaultNoteId],
    queryFn: async () => {
      if (!vaultNoteId) return "";
      const { data, error } = await supabase
        .from("notes")
        .select("content")
        .eq("id", vaultNoteId)
        .maybeSingle();
      if (error) return "";
      return String(data?.content || "");
    },
    enabled: !!vaultNoteId,
    staleTime: 5 * 60 * 1000,
  });

  const vaultParsed = useMemo(() => {
    if (node.kind !== "vault") return null;
    return parseVaultContent(String(vaultContent || ""));
  }, [node, vaultContent]);

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
  concept: {
    title: "Concept Neuron",
    short: "A theme that ties your ideas together",
    description:
      "A named idea the AI should track across your work. Concepts behave like topics — once they exist, anything you say or save that touches them links back here. Example: \"Personal CRM\" or \"Design systems.\"",
    accent: "blue",
    accentHex: "#60a5fa",
    accentRing: "border-blue-400/35",
    accentChip: "bg-blue-500/15 text-blue-200 border-blue-400/30",
    accentGlow: "shadow-[0_0_60px_rgba(96,165,250,0.5)]",
  },
  tag: {
    title: "Tag",
    short: "A label you can hang on Vault items",
    description:
      "Tags are how you organize the Vault. Name one here and it'll show up as a filter the next time you save something — perfect for grouping notes, files, or saved chats by project or theme.",
    accent: "blue",
    accentHex: "#60a5fa",
    accentRing: "border-blue-400/35",
    accentChip: "bg-blue-500/15 text-blue-200 border-blue-400/30",
    accentGlow: "shadow-[0_0_60px_rgba(96,165,250,0.5)]",
  },
} as const;

type NeuronCreationModalProps = {
  type: "basic" | "belief" | "concept" | "tag";
  onClose: () => void;
  /** Called after a successful save with the server-returned id (for
      beliefs the lykn_beliefs UUID; for basic neurons the fact id;
      for concepts the lykn_concepts UUID; for tags the new note id
      that carries the tag). For guests this is a synthetic local id
      (see `isGuest` below) so downstream code can still treat the
      handoff uniformly. The second arg carries the raw text the user
      submitted — useful for types whose graph-node id derives from
      the label rather than the row id (e.g. tags use `tag_<text>`,
      not `tag_<noteId>`). */
  onCreated: (newId: string | null, text: string) => void;
  /** True when the visitor is unauthenticated and this is their free
      "try one neuron before signing in" attempt. Skips every backend
      call and instead writes the neuron to localStorage via the
      prototype-handoff helpers so it renders in the preview brain. */
  isGuest?: boolean;
};

function NeuronCreationModal({ type, onClose, onCreated, isGuest = false }: NeuronCreationModalProps) {
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
      let newId: string | null = null;
      if (isGuest) {
        // Guest "first neuron" freebie. We don't have an authenticated
        // backend to persist to, so we stash the neuron in localStorage
        // through the existing prototype-handoff machinery and tag it
        // with `neuronType` so the synthesis layer routes it under the
        // matching category (Facts / Beliefs / Concepts / Tags) — the
        // legacy code only knew how to drop prototypes into AI Learned,
        // which is the wrong cluster for everything except the
        // wake-screen chat's inferred themes.
        const localId = `proto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const neuronType =
          type === "belief" ? "belief"
          : type === "concept" ? "concept"
          : type === "tag" ? "tag"
          : "fact";
        appendPrototypeNeuron({
          id: localId,
          kind: "identity",
          text: t,
          neuronType,
          reason:
            type === "belief"
              ? "Belief you wrote during the tour."
              : type === "concept"
              ? "Concept you wrote during the tour."
              : type === "tag"
              ? "Tag you wrote during the tour."
              : "Fact you wrote during the tour.",
        });
        newId = localId;
      } else if (type === "basic") {
        // Always send 'identity' — the server's reconciler downgrades /
        // reclassifies the kind based on text content if it obviously
        // fits another bucket (focus / goal / etc.).
        const res = await fetch(`${API_BASE_URL}/api/learned`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: t, kind: "identity" }),
        });
        const body = await res.json().catch(() => null);
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
        newId = body?.fact?.id ?? null;
      } else if (type === "belief") {
        // Default servesNeed to "value" — most user-authored beliefs are
        // about craft, identity, or how-they-work, which fits the Hyrum
        // Smith "value" need (feeling capable / your work matters). The
        // user can re-categorize later via the Core Beliefs panel's
        // inline need editor.
        const res = await fetch(`${API_BASE_URL}/api/beliefs/manual`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: t, servesNeed: "value" }),
        });
        const body = await res.json().catch(() => null);
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
        newId = body?.belief?.id ?? null;
      } else if (type === "concept") {
        // Manual concept creation routes through the public concept
        // CRUD endpoint, which auto-embeds in the background and
        // idempotently dedupes by slug. Default kind is "topic" — the
        // catch-all that fits most user-authored entries (themes are
        // AI-derived; entities are proper nouns the synthesis pipeline
        // tags).
        const res = await fetch(`${API_BASE_URL}/api/v1/concepts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: t, kind: "topic" }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const reason =
            body?.error ||
            (res.status === 401 ? "auth_required" : null) ||
            `http_${res.status}`;
          setError(`Couldn't save — ${reason}.`);
          setSubmitting(false);
          return;
        }
        newId = body?.id ?? null;
      } else {
        // type === "tag" — tags don't live in their own table; they're
        // string arrays on individual notes. To "create" a tag we
        // insert a minimal Vault note carrying the tag, which makes
        // the label show up as a filter in the Vault and as a node
        // in the Tags category of the synthesis layer.
        const { data: authData } = await supabase.auth.getUser();
        const authUserId = authData?.user?.id;
        if (!authUserId) {
          setError("Couldn't save — auth_required.");
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
          setError(`Couldn't save — ${insErr?.message || "insert_failed"}.`);
          setSubmitting(false);
          return;
        }
        newId = inserted.id as string;
      }

      // Phase 2: hold the modal open through the formation animation.
      // Roughly 1.4s of "neuron forming", then close + handoff.
      setFormedText(t);
      setPhase("forming");
      window.setTimeout(() => {
        onCreated(newId, t);
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
                  {type === "belief" ? (
                    <Atom size={10} />
                  ) : type === "concept" ? (
                    <Sparkles size={10} />
                  ) : type === "tag" ? (
                    <Tag size={10} />
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
                  maxLength={
                    type === "belief"
                      ? 140
                      : type === "tag"
                      ? 48
                      : type === "concept"
                      ? 128
                      : 240
                  }
                  placeholder={
                    type === "belief"
                      ? "e.g. 'Treat others the way you want to be treated.'"
                      : type === "concept"
                      ? "e.g. 'Personal CRM'"
                      : type === "tag"
                      ? "e.g. 'side-project'"
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
                {type === "tag" ? "Save tag" : "Save neuron"}
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

// Text the tour welcome card types out in the left-side overlay on first
// arrival from the wake screen. Kept short so the typewriter beat doesn't
// outrun the visitor's attention while the brain orbits in the background.
const TOUR_WELCOME_TEXT =
  "This is your synthesis layer, your digital brain.\n\nRight now you can see the seven neurons it grows from: Chats, Vault, Tags, Facts, AI Learned, Beliefs, and Concepts. Each one starts empty and fills as you use LYKN.\n\nYou can also build your own neurons to organize anything you want.";

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
    // Tour mode: the visitor just arrived from the wake screen via the
    // "Get started" → seedTourNeurons() path. Even if a stale step
    // value (vault/grid/done) is sitting in localStorage from a prior
    // session, this IS a fresh tour, so the sign-in wall should stay
    // closed. We also reset the step to "synthesis" so downstream
    // surfaces (sidebar nudges, VaultNew, OmniaGrid, and the global
    // walkthrough trap in AppShell) treat the walkthrough as starting
    // over.
    //
    // This effect deliberately does NOT short-circuit when
    // `hasPrototypeNeurons()` is false. The legacy flow only ever
    // surfaced the walkthrough state for guests who'd authored a
    // neuron in the landing chat; the new Get-Started → arrow path
    // skips neuron creation entirely. Gating on neurons here would
    // leave the prototype step unwritten for the most common path,
    // which in turn would silently disable the global lockdown
    // overlay + chrome hiding because `isWalkthroughLockActive` keys
    // off the step.
    if (readPrototypeTourMode()) {
      const stale = readPrototypeStep();
      if (stale !== "synthesis") writePrototypeStep("synthesis");
      return;
    }
    // Guests who landed here WITHOUT going through Get Started (e.g.
    // they typed `/synthesis-layer` straight in) but have prototype
    // neurons from the legacy landing chat still get the sign-in
    // wall on second-visit. The neuron gate stays scoped to this
    // legacy branch so we don't mis-fire the wall for fresh Get-
    // Started visitors who haven't built anything yet.
    if (!hasPrototypeNeurons()) {
      // No prior session to wall — also no walkthrough hand-off
      // (no tour mode flag and no neuron history). Let them through.
      return;
    }
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
  // Read once on mount via the current location; we don't keep this
  // param in the URL after handling it (router-replace) so refreshes
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
  const [creatingNeuronType, setCreatingNeuronType] = useState<"basic" | "belief" | "concept" | "tag" | null>(null);
  // Legacy per-type pending-forming states were consolidated into the
  // generic `pendingFormingNodeId` further down (search this file for
  // its declaration). Modal saves and any other create paths now
  // compute the full graph node id at the call site and queue it
  // there directly, so we no longer need fact / belief specific state.
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const tagMenuRef = useRef<HTMLDivElement>(null);
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
      // (Used to also listen on `lykn_project_state` to refresh the
      // projects list — dropped along with the projects category when the
      // sidebar projects feature was retired. The load-in greeting still
      // pulls the latest project_state on every fresh /app load via
      // /api/v1/synthesis/activity, so external MCP pushes still surface
      // in the briefing; they just no longer animate a node into the 3D
      // graph here.)
      .subscribe();

    return () => {
      if (flushTimer) window.clearTimeout(flushTimer);
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
      const { data } = await supabase.from("omnia_boards").select("id, title").eq("user_id", user.id).order("updated_at", { ascending: false }).limit(80);
      return data || [];
    },
    enabled: !!user?.id,
  });

  const { data: notes = [], isFetched: notesFetched } = useQuery({
    queryKey: ["mindmap_notes", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      // NOTE: deliberately omit `content` from the projection — the graph
      // only needs id/title/tags/summary/signals/source for cross-edge
      // heuristics + per-source rollup grouping. Shipping 100 full note
      // bodies on every mount was the single biggest payload on this
      // page. DetailPanel lazy-fetches `content` on demand.
      //
      // `source` is the connector-slug ('gmail_inbox', 'notion_page',
      // 'slack_saved', …) used by `buildGraph` to collapse high-volume
      // connector syncs into a single per-app rollup node instead of
      // flooding the Vault category with one node per inbox item.
      // Limit is bumped from 100 → 300 because manual notes typically
      // sit well under the old cap but connector firehose users can
      // have hundreds of gmail / notion / slack items — and we want
      // the rollup counts to match what the user actually has, not be
      // capped to the first 100.
      const { data } = await supabase.from("notes").select("id, title, tags, ai_summary, ai_signals, source").eq("user_id", user.id).order("updated_at", { ascending: false }).limit(300);
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
  // Tour mode: the visitor landed here straight off the wake screen
  // (no describe-yourself chat). The sample neurons in `prototypeNeurons`
  // were seeded by `seedTourNeurons()` so the brain isn't empty, and we
  // owe them a welcome card + an arrow at the "+" create-neuron button.
  // `tourMode` is set once on mount from localStorage so the welcome
  // overlay doesn't pop back in if the user briefly opens the + menu
  // (which clears the localStorage flag — see below).
  const [tourMode, setTourMode] = useState(() => readPrototypeTourMode());
  // Welcome-card visibility initializer. We used to key the card purely
  // off `readPrototypeTourMode()`, but the tour-mode flag is a single-
  // use signal that the synthesis-layer effect below clears on mount.
  // That meant a guest who hard-refreshed `/synthesis-layer` mid-tour
  // (or got bounced here by the AppShell walkthrough trap) found the
  // card gone with no arrow to click — and combined with the
  // walkthrough click-blocker overlay, that's a permanent stuck state.
  // Initializing the card from the walkthrough STEP instead (which
  // persists across reloads until the visitor clicks through) keeps
  // the card alive any time a guest is meant to be on this beat.
  const [tourWelcomeOpen, setTourWelcomeOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    if (readPrototypeTourMode()) return true;
    return readPrototypeStep() === "synthesis";
  });
  // Typewriter state for the left-side welcome card. The card is NOT a
  // modal — it doesn't dim the screen — so the visitor can watch the
  // brain orbit behind it while LYKN "types" the explanation in real
  // time. Once the full string lands, the "Show me how to add one"
  // button fades in.
  const [tourTypedText, setTourTypedText] = useState("");
  const [tourTypedDone, setTourTypedDone] = useState(false);
  const typewriterIntervalRef = useRef<number | null>(null);
  // Consume the localStorage tour flag on first mount: clearing it here
  // means a mid-tour browser refresh doesn't replay the welcome card,
  // while the in-memory `tourMode` keeps the "+" button hint alive until
  // the visitor finds the menu. The flag only gets re-armed by the wake
  // screen calling `seedTourNeurons()` again on a fresh visit.
  useEffect(() => {
    if (tourMode) writePrototypeTourMode(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // After the visitor dismisses the welcome card we flip on a pulsing
  // ring around the "+" button and a small "Tap to add your own neuron"
  // label. This stays up until the visitor opens the + menu — i.e.
  // they've found the affordance the tour was teaching them.
  const [tourAddNeuronHintVisible, setTourAddNeuronHintVisible] = useState(false);
  // Auto-orbit the camera for the first ~14s of the tour so the brand-
  // new visitor sees the brain from several angles before they have to
  // figure out drag-to-orbit themselves. Clears the second they grab
  // the canvas (the drei OrbitControls auto-cancels) or the timer
  // expires — whichever comes first.
  const [tourAutoRotate, setTourAutoRotate] = useState(false);
  useEffect(() => {
    if (!tourMode) return;
    // Start the slow orbit a beat AFTER the scene mounts so the lazy
    // SynthesisScene3D Suspense boundary has time to swap in. Otherwise
    // the rotation prop arrives while the fallback is still painting
    // and gets discarded.
    const startAt = window.setTimeout(() => setTourAutoRotate(true), 600);
    const stopAt = window.setTimeout(() => setTourAutoRotate(false), 15_000);
    return () => {
      window.clearTimeout(startAt);
      window.clearTimeout(stopAt);
    };
  }, [tourMode]);

  // Type out the welcome text in the left-side card, character by
  // character. Starts after a short delay so it doesn't begin while the
  // boot route transition is still in flight. ~22ms per character feels
  // like LYKN is "thinking and writing" without dragging out the read.
  useEffect(() => {
    if (!tourWelcomeOpen) return;
    setTourTypedText("");
    setTourTypedDone(false);
    let cancelled = false;
    let i = 0;
    const startTimer = window.setTimeout(() => {
      const id = window.setInterval(() => {
        if (cancelled) return;
        i += 1;
        setTourTypedText(TOUR_WELCOME_TEXT.slice(0, i));
        if (i >= TOUR_WELCOME_TEXT.length) {
          window.clearInterval(id);
          setTourTypedDone(true);
        }
      }, 22);
      // Stash so the cleanup can clear an in-flight interval.
      typewriterIntervalRef.current = id;
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      if (typewriterIntervalRef.current) {
        window.clearInterval(typewriterIntervalRef.current);
        typewriterIntervalRef.current = null;
      }
    };
  }, [tourWelcomeOpen]);
  // Any real interaction with the canvas (drag, click on a neuron, etc.)
  // should kill the spin so we don't fight the user's gesture. Bind a
  // pointer-down listener at the container level — it bubbles up from
  // both Canvas and the surrounding chrome.
  const containerStopAutoRotateRef = useRef(false);
  useEffect(() => {
    if (!tourAutoRotate) return;
    const el = containerRef.current;
    if (!el) return;
    const stop = () => {
      if (containerStopAutoRotateRef.current) return;
      containerStopAutoRotateRef.current = true;
      setTourAutoRotate(false);
    };
    el.addEventListener("pointerdown", stop, { once: true });
    el.addEventListener("wheel", stop, { once: true, passive: true });
    return () => {
      el.removeEventListener("pointerdown", stop);
      el.removeEventListener("wheel", stop);
    };
  }, [tourAutoRotate]);

  // Bug fix (2026-05): if a guest goes through the landing walkthrough
  // and then signs into an EXISTING account, we used to keep showing
  // the prototype's "empty workspace + 1 neuron" instead of their real
  // synthesis layer. Detect that case here: signed in + queries
  // finished + at least one piece of real data exists → wipe prototype
  // state and let the real synthesisData/boards/notes render.
  //
  // We deliberately wait for *every* query to settle before deciding,
  // otherwise we'd nuke the prototype during the brief loading window
  // when all defaults are `[]` and we'd misclassify a genuinely empty
  // brand-new account as "no data → keep prototype".
  const allQueriesFetched =
    boardsFetched && notesFetched && profileFetched && chunksFetched;
  useEffect(() => {
    if (!user?.id) return;
    if (prototypeNeurons.length === 0) return;
    if (!allQueriesFetched) return;
    const hasRealData =
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
    boards,
    notes,
    synthesisChunks,
    synthesisProfile,
  ]);

  // True whenever we're rendering the landing-prototype walkthrough —
  // i.e. the visitor created at least one neuron in the landing chat
  // and we're still inside the guided tour. The effect above tears
  // this back down once an existing signed-in user is detected.
  //
  // `tourMode` also counts: a tour visitor arrives with ZERO neurons
  // but still needs the "this is your synthesis layer" framing (root
  // label, narrative, forced-empty category clusters) — so we treat
  // tour mode as a stand-in for the handoff display state.
  const isPrototypeHandoff = prototypeNeurons.length > 0 || tourMode;

  // Guest-preview surface: an unauthenticated visitor with no real
  // chat-handoff data ALWAYS sees the six top-level containers (Chats,
  // Vault, Facts, AI Learned, Beliefs, Concepts) so the synthesis
  // layer never collapses to a blank "empty" placeholder on them.
  // This is deliberately decoupled from `tourMode`: the tour flag is
  // a one-shot UX flag (welcome card + auto-rotate + "+" pulse), but
  // the category SHAPE should persist for the whole guest session,
  // including after the visitor dismisses the welcome card or pokes
  // the "+" menu. The signed-in / "real handoff with neurons" paths
  // are unaffected.
  // All seven category containers (Chats / Vault / Tags / Facts / AI
  // Learned / Beliefs / Concepts) stay forced-on for ANY unauthenticated
  // visitor — even after they've used their "first neuron" freebie. We
  // want the brain to keep looking populated and structured so the
  // visible payoff motivates the sign-up (vs. collapsing back to just
  // the one neuron they wrote and an otherwise-empty root).
  const showGuestCategories = !user?.id;

  // No more demo-content fallback. Brand-new signed-in users with no
  // boards/notes used to see a synthetic "Morning practice / Harbor /
  // Greenroom" workspace stitched in from `demoSynthesis.js`; that demo
  // shipped the user out of the walkthrough into a fake mind that wasn't
  // theirs. Now the synthesis layer only ever shows real data + the
  // user's prototype handoff, with an empty workspace falling through to
  // the standard empty-state placeholder below.
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
    // neuron(s). Everything else (grids, vault, tags) renders as an
    // empty category shell so the page reads as a brand-new mind with
    // exactly one thing in it.
    if (isPrototypeHandoff) {
      return {
        // Only the legacy untyped wake-screen-chat prototypes flow into
        // AI Learned `themes`. Anything authored from the synthesis
        // layer's "+" menu carries a `neuronType` and gets routed to
        // its proper category (Facts / Beliefs / Concepts / Tags) in
        // the post-build pass below — otherwise every prototype would
        // collapse back into AI Learned regardless of which button
        // the visitor pressed.
        themes: prototypeNeurons.filter((n) => !n.neuronType).map((n) => n.text),
        narrative: tourMode
          ? "This is your synthesis layer, the seven neurons your digital brain grows from. Chats, Vault, Tags, Facts, AI Learned, Beliefs, and Concepts all start empty and fill as you use LYKN. You can also build your own neurons to organize anything you want. Tap the + button to add your first one."
          : "This is your synthesis layer the moment it woke up. The neuron you just created is the only thing here — your chats, vault, and tags are waiting to be filled.",
        signals: {},
      };
    }
    if (!synthesisProfile) return null;
    return {
      themes: Array.isArray(synthesisProfile.themes) ? synthesisProfile.themes : [],
      narrative: synthesisProfile.narrative || "",
      signals: (synthesisProfile.signals && typeof synthesisProfile.signals === "object") ? synthesisProfile.signals as Record<string, any> : {},
    };
  }, [synthesisProfile, isPrototypeHandoff, prototypeNeurons, tourMode]);

  const synthesisThemes: string[] = useMemo(() => {
    const t: string[] = [];
    if (synthesisData?.themes) t.push(...synthesisData.themes);
    if (synthesisData?.signals?.recurring_topics) t.push(...synthesisData.signals.recurring_topics);
    return [...new Set(t.map((s: string) => s.toLowerCase().trim()))].filter(Boolean);
  }, [synthesisData]);

  // Force-render the empty top-level containers depending on what the
  // visitor is.
  //
  //  • Guest preview (any unauthenticated visitor with no chat-handoff
  //    neurons): the synthesis layer is the headline destination, so
  //    we render the SIX top-level containers the brain grows into —
  //    Chats, Vault, Facts, AI Learned, Beliefs, Concepts — and
  //    nothing else. The visitor sees the shape, the typewriter card
  //    on the left explains it, and the "+" button is the call to
  //    action. This stays on for the entire guest session, including
  //    after they dismiss the welcome card or open the "+" menu.
  //
  //  • Real handoff (signed-in visitor with neurons from the chat):
  //    we want them to see Chats / Vault / Tags around their freshly-
  //    minted neuron so the future workspace shape is implied — but
  //    NOT the empty AI Learned / Beliefs / Concepts / Facts clusters
  //    (their real data lives elsewhere; these would just clutter the
  //    centroid).
  const forceCategoryIds = useMemo(
    () => {
      if (showGuestCategories) {
        return new Set<string>([
          "__cat_grids__",
          "__cat_vault__",
          "__cat_tags__",
          "__cat_neurons__",
          "__cat_beliefs__",
          "__cat_concepts__",
          "__cat_facts__",
        ]);
      }
      if (isPrototypeHandoff) {
        return new Set<string>([
          "__cat_grids__",
          "__cat_vault__",
          "__cat_tags__",
        ]);
      }
      return new Set<string>();
    },
    [isPrototypeHandoff, showGuestCategories],
  );

  /* Build + simulate */
  const rootLabel = isPrototypeHandoff ? "Your Synthesis Layer" : "Your Mind";
  const { nodes: allNodes, edges, noteIdToVaultNodeId } = useMemo(
    () => {
      const built = buildGraph(effectiveBoards, effectiveNotes, synthesisThemes, synthesisData, vaultGridMap, activeBeliefs, manualFacts, beliefProvenance, conceptRows, conceptLinks, forceCategoryIds, rootLabel);
      // Prototype handoff: stamp each prototype-neuron node with the
      // ordinal (1st, 2nd, ...) and the AI-supplied "why" reason so the
      // detail panel can render "Nth neuron created" + a custom blurb
      // for every neuron the user has built so far. Typed prototypes
      // (`neuronType` set) get INJECTED into the right category cluster
      // first — buildGraph only knows how to materialise the legacy
      // theme-style prototypes under AI Learned, so anything authored
      // through the new "+" menu has to be added here.
      if (isPrototypeHandoff && prototypeNeurons.length > 0) {
        // Compute the synthesis-layer node id for a prototype neuron.
        // Legacy (untyped) prototypes were already pushed under
        // `neuron_theme_${text}` via the synthesisThemes path; typed
        // prototypes get a per-category id so they slot into the right
        // cluster.
        const protoNodeId = (pn: { text: string; id: string; neuronType?: string }): string => {
          switch (pn.neuronType) {
            case "fact":    return `fact_${pn.id}`;
            case "belief":  return `belief_${pn.id}`;
            case "concept": return `concept_${pn.id}`;
            case "tag":     return `tag_${pn.text}`;
            default:        return `neuron_theme_${pn.text}`;
          }
        };

        for (const pn of prototypeNeurons) {
          if (!pn.neuronType) continue;
          const nid = protoNodeId(pn);
          if (built.nodes.some((n) => n.id === nid)) continue;
          const label = pn.text.length > 56 ? `${pn.text.slice(0, 54)}…` : pn.text;
          if (pn.neuronType === "fact") {
            built.nodes.push({
              id: nid,
              label,
              kind: "neuron",
              radius: 16,
              color: palette.facts.bg,
              glow: palette.facts.glow,
              parentId: "__cat_facts__",
              categoryId: "__cat_facts__",
              meta: { neuronKind: "fact", source: "prototype_fact", factText: pn.text },
            });
            built.edges.push({ from: "__cat_facts__", to: nid });
          } else if (pn.neuronType === "belief") {
            built.nodes.push({
              id: nid,
              label: pn.text.length > 48 ? `${pn.text.slice(0, 46)}…` : pn.text,
              kind: "belief",
              radius: 24,
              color: palette.belief.bg,
              glow: palette.belief.glow,
              parentId: "__cat_beliefs__",
              categoryId: "__cat_beliefs__",
              meta: { beliefText: pn.text, source: "prototype_belief" },
            });
            built.edges.push({ from: "__cat_beliefs__", to: nid });
          } else if (pn.neuronType === "concept") {
            const labelShown = pn.text.length > 32 ? `${pn.text.slice(0, 30)}…` : pn.text;
            built.nodes.push({
              id: nid,
              label: labelShown,
              kind: "concept",
              radius: 18,
              color: palette.concept.bg,
              glow: palette.concept.glow,
              parentId: "__cat_concepts__",
              categoryId: "__cat_concepts__",
              meta: { conceptLabel: pn.text, conceptSource: "prototype_concept" },
            });
            built.edges.push({ from: "__cat_concepts__", to: nid });
          } else if (pn.neuronType === "tag") {
            built.nodes.push({
              id: nid,
              label: `#${pn.text}`,
              kind: "tag",
              radius: 18,
              color: palette.tag.bg,
              glow: palette.tag.glow,
              parentId: "__cat_tags__",
              categoryId: "__cat_tags__",
              meta: { tag: pn.text, source: "prototype_tag" },
            });
            built.edges.push({ from: "__cat_tags__", to: nid });
          }
        }

        // Stamp the per-neuron prototype meta (ordinal / reason / kind)
        // onto whichever node id corresponds to each prototype — works
        // uniformly for legacy and typed prototypes now that we resolve
        // the id through `protoNodeId`.
        for (let i = 0; i < prototypeNeurons.length; i++) {
          const pn = prototypeNeurons[i];
          const nid = protoNodeId(pn);
          const node = built.nodes.find((n) => n.id === nid);
          if (!node) continue;
          node.meta = {
            ...(node.meta || {}),
            prototypeOrdinal: pn.ordinal || i + 1,
            prototypeReason: pn.reason || "",
            prototypeKind: pn.kind,
            prototypeNeuronType: pn.neuronType || null,
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
            const nid = protoNodeId(pn);
            if (built.nodes.some((n) => n.id === nid)) {
              built.edges.push({ from: nid, to: gridId, cross: true });
            }
          }
        }
      }
      return built;
    },
    [effectiveBoards, effectiveNotes, synthesisThemes, synthesisData, vaultGridMap, activeBeliefs, manualFacts, beliefProvenance, conceptRows, conceptLinks, forceCategoryIds, rootLabel, isPrototypeHandoff, prototypeNeurons, tourMode],
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

  // Count only the nodes the user actually created — chats, vault notes,
  // tags, and AI-learned neurons. The root node and the category shells
  // (Chats / Vault / Tags / AI Learned) are scaffolding that exists
  // regardless of activity, so they're excluded from the free-tier cap
  // below.
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
  const [resetSignal] = useState(0);

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

  // Stable identity for SynthesisScene3D so the scene's React.memo (if
  // any) and prop-equality short-circuits actually fire. Inline lambdas
  // produced new closures on every parent render and forced the scene
  // to reconcile its entire subtree on every hover tick.
  const handleBackgroundClick = useCallback(() => {
    if (prototypeFocusId) return;
    setSelectedId(null);
  }, [prototypeFocusId]);

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
    // Tour-mode neurons are samples seeded by the wake screen, not a
    // freshly-created real neuron. Playing the "your first neuron is
    // forming" animation on a sample would be a lie — and would also
    // yank the camera onto whichever sample happens to be last in the
    // seed array, hiding the rest of the brain. Skip the formation and
    // let the autoRotate intro + welcome card do the talking instead.
    if (tourMode) {
      didPlayPrototypeIntro.current = true;
      return;
    }
    didPlayPrototypeIntro.current = true;
    setFormingNodeId(prototypeFocusId);
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
  }, [prototypeFocusId, nodeMap, tourMode]);

  // Page-level unmount cleanup for the prototype-intro timeouts. Splitting
  // this from the effect that schedules them is what keeps them alive
  // through interim re-renders (see the long comment above).
  useEffect(() => {
    return () => {
      prototypeIntroTimeouts.current.forEach((id) => window.clearTimeout(id));
      prototypeIntroTimeouts.current = [];
    };
  }, []);

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
    const focusAt = window.setTimeout(() => setSelectedId(targetId), 400);
    const clearAt = window.setTimeout(() => setFormingNodeId(null), 2000);
    beliefFormingWatchTimeouts.current.push(focusAt, clearAt);
    setPendingFormingNodeId(null);
  }, [pendingFormingNodeId, nodeMap]);

  useEffect(() => {
    return () => {
      beliefFormingWatchTimeouts.current.forEach((id) => window.clearTimeout(id));
      beliefFormingWatchTimeouts.current = [];
    };
  }, []);

  // The empty-state placeholder should only kick in when there is genuinely
  // nothing to show — including no neurons. The prototype handoff has no
  // boards/notes but does have neurons, so it renders the scene. The
  // guest-preview path also has zero boards/notes/neurons but
  // force-renders the six top-level containers, so the scene has
  // nodes to draw and the placeholder would lie about an "empty"
  // layer the visitor can see in front of them. Exempt that path
  // from the empty check.
  const isEmpty =
    !showGuestCategories &&
    effectiveBoards.length === 0 &&
    effectiveNotes.length === 0 &&
    (synthesisData?.themes?.length ?? 0) === 0;
  const selectedNode = selectedId ? nodeMap.get(selectedId) : null;
  const panelOpen = selectedNode != null;
  // Unified "is any right-side pullout open?" so the top-right chevron
  // toggle can act as the single close affordance for ALL right-edge
  // panels (Core Beliefs, Detail, Welcome). The shared "what's new"
  // updates panel was retired in favour of routing each individual
  // update to its own node-specific DetailPanel via `?focus=<id>`.
  const anyRightPanelOpen =
    beliefWindowOpen || selectedNode != null;
  const closeAllRightPanels = useCallback(() => {
    setBeliefWindowOpen(false);
    setSelectedId(null);
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
              autoRotate={tourAutoRotate}
              // Keep the camera pulled in close on the prototype neuron even
              // after the formation animation clears, so the user doesn't
              // see it ease back out to the wider default focus distance.
              focusDistanceOverride={isPrototypeHandoff ? 240 : null}
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
            isGuest={!user?.id}
            onClose={() => setCreatingNeuronType(null)}
            onCreated={(newId, savedText) => {
              // Guest "first neuron" branch — the modal already wrote
              // the new neuron to localStorage; pull the refreshed
              // list into state so the synthesis layer rebuilds with
              // it visible and the next "+" tap bounces to sign-in.
              if (!user?.id) {
                const refreshed = readPrototypeNeurons();
                setPrototypeNeurons(refreshed);
                // Tour mode's whole purpose is "show the empty
                // containers" — once a real neuron exists we want
                // the regular preview rendering, not the tour
                // narrative + welcome card. Clear the flag so the
                // next mount doesn't relaunch the welcome.
                if (tourMode) {
                  setTourMode(false);
                  writePrototypeTourMode(false);
                }
                // Queue the formation pulse against whichever node id
                // the post-build pass will produce for this prototype
                // (must mirror `protoNodeId` in the allNodes useMemo).
                const justSaved = refreshed[refreshed.length - 1];
                if (justSaved) {
                  const targetId =
                    justSaved.neuronType === "fact"    ? `fact_${justSaved.id}` :
                    justSaved.neuronType === "belief"  ? `belief_${justSaved.id}` :
                    justSaved.neuronType === "concept" ? `concept_${justSaved.id}` :
                    justSaved.neuronType === "tag"     ? `tag_${justSaved.text}` :
                    `neuron_theme_${justSaved.text}`;
                  setPendingFormingNodeId(targetId);
                }
                return;
              }
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
              } else if (creatingNeuronType === "tag") {
                // Tag creation inserts a Vault note carrying the tag.
                // The tag-cluster node id is derived from the tag text
                // itself (`tag_<text>`), not the note id, which is why
                // we queue the pulse off `savedText` rather than newId.
                if (savedText) setPendingFormingNodeId(`tag_${savedText}`);
                queryClient.invalidateQueries({ queryKey: ["mindmap_notes", user?.id] });
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
            className="flex items-center gap-1.5 text-[0.6875rem] font-medium text-white/75 hover:text-white transition-colors"
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
        <span>{effectiveBoards.length} chats</span>
        <span className="w-px h-3 bg-white/15" />
        <span>{effectiveNotes.length} notes</span>
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
          {/* Tour hint: pulse + caption that lights up the "+" button
              after the visitor dismisses the welcome card. Pointer-
              events-none on the ring so it never eats the click that
              opens the menu. Removed the moment the menu opens (the
              user has found the affordance the tour was teaching). */}
          {tourAddNeuronHintVisible && (
            <>
              <span
                aria-hidden
                className="pointer-events-none absolute -inset-2 rounded-full border border-blue-400/60 animate-ping"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute -inset-1 rounded-full border border-blue-400/45"
              />
              <div
                aria-hidden
                className="pointer-events-none absolute bottom-full right-0 mb-3 whitespace-nowrap rounded-md bg-[rgba(15,15,18,0.95)] backdrop-blur border border-blue-400/35 px-2.5 py-1.5 text-[0.7rem] font-medium text-blue-100 shadow-[0_6px_18px_rgba(0,0,0,0.5)]"
              >
                Tap + to add your own neuron
              </div>
            </>
          )}
          <button
            onClick={() => {
              setAddMenuOpen((v) => !v);
              // Tour cleanup: the user has reached the "create a neuron"
              // affordance, which is the whole point of the tour. Clear
              // the hint + the tour flag so they don't see it again the
              // next time they land on this page in this session.
              if (tourAddNeuronHintVisible) setTourAddNeuronHintVisible(false);
              if (tourMode) {
                setTourMode(false);
                writePrototypeTourMode(false);
              }
            }}
            className={`relative w-11 h-11 rounded-full backdrop-blur border flex items-center justify-center shadow-[0_6px_20px_rgba(0,0,0,0.35)] transition-colors ${
              addMenuOpen
                ? "bg-blue-500/25 border-blue-400/45 text-blue-100"
                : tourAddNeuronHintVisible
                  ? "bg-blue-500/20 border-blue-400/55 text-blue-100"
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
                // exposes every neuron type the user can author, and
                // we don't want any single entry's brand color to read
                // as the "default" choice. Order is fixed: the three
                // manual-creation types (Belief / Fact / Concept) come
                // first, then the structural shortcuts (Tag opens the
                // tag composer, Vault and Chat route the user to those
                // pages where the larger creation flows live).
                className="absolute bottom-full right-0 mb-2 w-60 rounded-xl bg-black border border-white/20 shadow-[0_14px_40px_rgba(0,0,0,0.6)] overflow-hidden z-50"
                role="menu"
              >
                {([
                  {
                    key: "belief",
                    label: "Belief",
                    blurb: "A principle that shapes every reply.",
                    Icon: Atom,
                    onClick: () => {
                      setAddMenuOpen(false);
                      // Guest carrot: an unauthenticated visitor gets to
                      // build ONE neuron before the sign-in wall drops
                      // (it gets persisted to localStorage through the
                      // prototype-handoff machinery, same path the
                      // wake-screen chat used to use). After that we
                      // bounce them to sign-in — they've seen the
                      // formation animation and they've got a node in
                      // the brain; further authoring needs an account.
                      if (!user?.id && prototypeNeurons.length >= 1) {
                        setSynthSignInOpen(true);
                        return;
                      }
                      setCreatingNeuronType("belief");
                    },
                  },
                  {
                    key: "fact",
                    label: "Fact",
                    blurb: "A single fact about you the AI should remember.",
                    Icon: Brain,
                    onClick: () => {
                      setAddMenuOpen(false);
                      if (!user?.id && prototypeNeurons.length >= 1) {
                        setSynthSignInOpen(true);
                        return;
                      }
                      setCreatingNeuronType("basic");
                    },
                  },
                  {
                    key: "concept",
                    label: "Concept",
                    blurb: "A theme that ties your ideas together.",
                    Icon: Sparkles,
                    onClick: () => {
                      setAddMenuOpen(false);
                      if (!user?.id && prototypeNeurons.length >= 1) {
                        setSynthSignInOpen(true);
                        return;
                      }
                      setCreatingNeuronType("concept");
                    },
                  },
                  {
                    key: "tag",
                    label: "Tag",
                    blurb: "A new label to organize the Vault.",
                    Icon: Tag,
                    onClick: () => {
                      setAddMenuOpen(false);
                      if (!user?.id && prototypeNeurons.length >= 1) {
                        setSynthSignInOpen(true);
                        return;
                      }
                      setCreatingNeuronType("tag");
                    },
                  },
                  {
                    key: "vault",
                    label: "Vault",
                    blurb: "Save a note, file, or link.",
                    Icon: StickyNote,
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
                    onClick: () => {
                      setAddMenuOpen(false);
                      navigate("/app");
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
                    {idx < arr.length - 1 ? <div className="h-px bg-white/12" /> : null}
                  </div>
                ))}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      {/* Legend — order matches the canonical reading order around the
          root: outer scaffolding categories (Chats / Vault / Tags) first,
          then the AI-derived tiers (Learned → Concepts → Beliefs) which
          sit on top of the raw content. Projects was dropped when the
          sidebar projects feature was retired; Concepts was added here
          so the legend reflects every category the graph actually
          renders (it was the only category color the user could see
          without a swatch). */}
      <div className="absolute bottom-6 left-6 z-20 flex flex-wrap gap-3 text-[0.625rem] text-white/55 pointer-events-none">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.grids.bg, color: palette.grids.bg }} /> Chats</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.vault.bg, color: palette.vault.bg }} /> Vault</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.tags.bg, color: palette.tags.bg }} /> Tags</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.facts.bg, color: palette.facts.bg }} /> Facts</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.neurons.bg, color: palette.neurons.bg }} /> AI Learned</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: palette.concepts.bg, color: palette.concepts.bg }} /> Concepts</span>
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
          on-page-load greeting now lives in chat — LYKN posts a fresh
          "what's been happening / approvals needed / project updates"
          message at the top of a new chat every time the user loads
          into `/app`. See `fetchLoadInUpdatesMessage`. */}
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
            // First-class concepts (056-058). The concept detail
            // section uses this list to populate its merge picker.
            // We pass the full live set so merging into a concept that
            // happens to be off-screen still works. Reference is memoized
            // (see `allConceptsForPanel` below) so DetailPanel can rely
            // on stable identity for downstream useMemo deps.
            allConcepts={allConceptsForPanel}
            vaultNodeIdFor={vaultNodeIdFor}
          />
        ) : null}
      </AnimatePresence>

      {/* Tour welcome card — left-side typewriter overlay shown only on
          the visitor's first arrival at the synthesis layer from the
          wake screen. Deliberately NOT a modal: no backdrop, no screen
          mute, no click trap. The visitor can watch the brain auto-
          orbit behind it while LYKN "types" the explanation in real
          time, then dismisses the card to expose the pulsing "+" button
          hint. AnimatePresence handles the fade in/out so the card
          slides in from the left edge and fades back out cleanly. */}
      <AnimatePresence>
        {tourWelcomeOpen && (
          <motion.div
            key="tour-welcome-card"
            initial={{ opacity: 0, x: -24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.45, ease: "easeOut" }}
            className="fixed left-6 top-20 z-[9995] w-[min(88vw,18rem)]"
            role="dialog"
            aria-label="Synthesis layer welcome"
          >
            <div className="pointer-events-auto relative rounded-2xl bg-[rgba(15,15,18,0.78)] backdrop-blur-md border border-white/10 px-4 py-3.5 shadow-[0_18px_50px_rgba(0,0,0,0.5)]">
              {/* Dismiss button intentionally removed: the walkthrough
                  is now a forced flow for guests. The only way past
                  this card is the arrow → vault hand-off (or signing
                  in, which unmounts the card entirely). Earlier
                  iterations let visitors X-out and roam free, but
                  testers consistently bailed at this step without
                  realizing the rest of the tour existed. */}
              <p className="text-[0.8rem] leading-relaxed text-white/80 whitespace-pre-wrap min-h-[8.5rem] pr-4">
                {tourTypedText}
                {!tourTypedDone && (
                  <span aria-hidden className="lykn-wake-cursor">|</span>
                )}
              </p>
              <AnimatePresence>
                {tourTypedDone && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4, delay: 0.15 }}
                    className="mt-3 flex justify-end"
                  >
                    {/* Walkthrough advancer: clicking the arrow hands off
                        to the next leg of the tour — the Connections
                        message that types out the moment the Vault page
                        mounts under the "vault" prototype step. We close
                        the welcome card here, flip the prototype step
                        forward, and navigate; the sidebar's walkthrough
                        glow + the Vault intro pick up from there. */}
                    <button
                      type="button"
                      onClick={() => {
                        setTourWelcomeOpen(false);
                        if (tourMode) {
                          setTourMode(false);
                          writePrototypeTourMode(false);
                        }
                        // Re-arm the Vault page's one-shot welcome card.
                        // It self-stamps `PROTO_VAULT_INTRO_SS_KEY` on
                        // the first run so refreshing /vault doesn't
                        // replay the typewriter; clearing it here means
                        // every time the user advances out of the
                        // synthesis layer the next leg shows fresh.
                        try {
                          window.sessionStorage.removeItem("lykn_prototype_vault_intro_played");
                        } catch {
                          // ignore (private mode / quota)
                        }
                        const current = readPrototypeStep();
                        if (current !== "vault" && current !== "done") {
                          writePrototypeStep("vault");
                        }
                        navigate("/vault");
                      }}
                      className="rounded-full bg-blue-500/20 hover:bg-blue-500/30 border border-blue-400/40 text-blue-100 hover:text-white p-1.5 transition-colors"
                      aria-label="Next: Connections"
                      title="Next: Connections"
                    >
                      <ArrowRight size={14} />
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
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
