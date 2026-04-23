// Demo Synthesis Layer content — shown to guests (pre-sign-in) and to
// brand-new signed-in users who don't yet have any projects or grids of
// their own. Everything here is purely in-memory: no DB writes, no signed
// URLs, no RLS considerations.
//
// The demo deliberately mirrors the tags on the starter-pack vault items
// (see `demoVault.js`) so when buildGraph() wires everything together the
// resulting graph *looks* like it was synthesized from the user's own work.

import { DEMO_VAULT_ITEMS } from "./demoVault";

// Stable ids prefixed with `demo-` so the UI can detect synthetic nodes
// (and, e.g., avoid navigating to dead `/grid/demo-*` routes for guests).
export const DEMO_PROJECTS = [
  { id: "demo-project-morning", name: "Morning practice" },
  { id: "demo-project-moodboard", name: "Visual moodboard" },
  { id: "demo-project-travel", name: "Travel plans" },
];

export const DEMO_BOARDS = [
  { id: "demo-board-harbor", title: "Harbor — business idea", project_id: null },
  { id: "demo-board-greenroom", title: "Greenroom — content creation", project_id: null },
  { id: "demo-board-studio12", title: "Studio 12 — design spaces", project_id: null },
];

// Shape matches the real `lykn_user_synthesis_profile` row that buildGraph()
// consumes — themes drive the "AI Learned" neuron cluster, signals drive
// goals / recurring topics / reasoning style / vocabulary neurons.
export const DEMO_SYNTHESIS_PROFILE = {
  themes: ["calm", "morning", "design", "travel"],
  narrative:
    "Your vault suggests you're building toward a quieter, more intentional life. Themes of calm spaces, slow mornings, and thoughtful design recur across your saved images and notes. You gravitate toward neutral palettes, natural light, and writing as a practice — and you're drawn to travel that feels restorative rather than packed.",
  signals: {
    recurring_topics: [
      "slow mornings",
      "minimal spaces",
      "quiet travel",
      "intentional design",
    ],
    goals: [
      "build a calmer daily rhythm",
      "collect visual references for a personal moodboard",
      "plan travel that feels restorative",
    ],
    reasoning_style:
      "Prefers depth over breadth; thinks in metaphors and returns to the same few ideas from new angles.",
    vocabulary: ["calm", "intentional", "quiet", "slow", "moodboard"],
  },
};

// Per-note ai_signals (themes / recurring_topics / entities) so cross-links
// in buildGraph() light up — not every note needs signals, just a handful
// to make the graph feel alive.
const NOTE_AI_SIGNALS = {
  "Morning coastline": { themes: ["calm", "morning"], recurring_topics: ["slow mornings"] },
  "Quiet workspace": { themes: ["calm", "design"], recurring_topics: ["minimal spaces"] },
  "Soft architecture": { themes: ["design", "travel"], recurring_topics: ["intentional design"] },
  "Mountain morning": { themes: ["morning", "travel"], recurring_topics: ["slow mornings", "quiet travel"] },
  "Coffee ritual": { themes: ["morning", "calm"], recurring_topics: ["slow mornings"] },
  "Open notebook": { themes: ["morning"], recurring_topics: ["slow mornings"] },
  "Quiet city": { themes: ["travel", "calm"], recurring_topics: ["quiet travel"] },
  "Warm interior": { themes: ["design", "calm"], recurring_topics: ["minimal spaces"] },
  "Studio corner": { themes: ["design", "calm"], recurring_topics: ["minimal spaces"] },
  "Ocean quiet": { themes: ["calm", "travel"], recurring_topics: ["quiet travel"] },
};

const NOTE_AI_SUMMARY = {
  "Morning coastline":
    "An early-morning seascape saved as a reminder to protect the first hour of the day.",
  "Quiet workspace":
    "A minimal desk scene — lots of empty surface, one intentional object per zone.",
  "Soft architecture":
    "Light-filled atrium; referenced for the brand moodboard's spatial tone.",
  "Coffee ritual":
    "Slow pour-over — part of an emerging morning practice.",
  "Quiet city":
    "Evening streetscape, low activity. Fits a 'quiet travel' brief.",
};

// Builds synthetic NoteRow[] from the demo vault, shaped exactly like the
// rows the synthesis layer reads from Supabase. Used only for guests — for
// signed-in brand-new users we overlay demo projects/boards/neurons on top
// of their already-seeded real notes instead.
//
// IMPORTANT: consumers should use the exported `DEMO_SYNTHESIS_NOTES`
// singleton rather than calling this factory inside a component — a fresh
// array on every render invalidates downstream `useMemo`s (buildGraph,
// simulateLayout) and causes the force-layout to re-seed with new random
// jitter on every hover tick, making the graph jitter.
function buildDemoSynthesisNotes() {
  return DEMO_VAULT_ITEMS.map((item, i) => {
    const ai_signals = NOTE_AI_SIGNALS[item.title] || null;
    const ai_summary = NOTE_AI_SUMMARY[item.title] || null;

    if (item.kind === "image") {
      const attachment = [{
        type: "image",
        url: item.url,
        name: item.fileName,
        title: item.title,
      }];
      return {
        id: `demo-note-${i}`,
        title: item.title,
        content: `${item.title}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachment)}]`,
        tags: item.tags || [],
        ai_summary,
        ai_signals,
      };
    }
    return {
      id: `demo-note-${i}`,
      title: item.title,
      content: item.content,
      tags: item.tags || [],
      ai_summary,
      ai_signals,
    };
  });
}

// Stable module-level singleton — referential identity preserved across
// every render, so the synthesis-layer memos stay cache-hot for guests.
export const DEMO_SYNTHESIS_NOTES = Object.freeze(buildDemoSynthesisNotes());

// Lightweight detector so the SynthesisLayer can avoid navigating to dead
// `/grid/demo-*` / `/project/demo-*` routes (the demo data never hits the
// DB, so those pages would 404 or be empty).
export function isDemoNodeId(id) {
  return typeof id === "string" && id.includes("demo-");
}
