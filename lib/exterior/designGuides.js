// ============================================================================
// Per-format style guides for coded artifacts (lykn_build_react_artifact).
//
// Companion to designSystems.js: the [DESIGN_SYSTEM] brief owns colors /
// type tokens / component recipes, while these markdown guides own the
// STRUCTURE and craft of each artifact format — what sections a website
// needs and in what order, how a slide deck must navigate, how a dashboard
// lays out KPI rows, how a worksheet leaves answer space.
//
// The guides live as real .md files in design-guides/ so they can be
// edited like documentation (and diffed/reviewed as prose, not string
// literals). They're loaded once at module init and injected into the
// build prompt as a [STYLE_GUIDE] block on artifact turns.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUIDES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'design-guides');

function loadGuide(id) {
  try {
    return readFileSync(join(GUIDES_DIR, `${id}.md`), 'utf8').trim();
  } catch (err) {
    console.warn(`[designGuides] could not load ${id}.md:`, err?.message);
    return '';
  }
}

// Order matters for matching: the most specific format wins when a request
// matches several ("a presentation about my website idea" → presentation).
export const DESIGN_GUIDES = [
  {
    id: 'presentation',
    label: 'Presentation / slide deck',
    keywords: /\b(?:presentation|slide\s?deck|slides?|pitch\s?deck|keynote|deck)\b/i,
    content: loadGuide('presentation'),
  },
  {
    id: 'dashboard',
    label: 'Dashboard / analytics',
    keywords: /\b(?:dashboards?|analytics|admin\s+panel|metrics|kpis?|monitor(?:ing)?|tracker|stats?\s+(?:page|panel|view)|console)\b/i,
    content: loadGuide('dashboard'),
  },
  {
    id: 'document',
    label: 'Document / report / worksheet',
    keywords: /\b(?:report|study\s+guide|worksheets?|article|essay|whitepaper|documentation|docs?\b|cheat\s?sheet|handout|summary\s+doc|brief(?:ing)?|guide|notes)\b/i,
    content: loadGuide('document'),
  },
  {
    id: 'website',
    label: 'Website / landing page',
    keywords: /\b(?:websites?|web\s?site|landing\s?page|home\s?page|web\s?page|site\b|marketing\s+page|portfolio|storefront|sales\s+page)\b/i,
    content: loadGuide('website'),
  },
  {
    id: 'app',
    label: 'App / tool / game',
    keywords: /\b(?:apps?|tools?|games?|quiz(?:zes)?|calculator|timer|converter|tracker|widget|prototype|simulator|generator|playground|flashcards?|planner|todo)\b/i,
    content: loadGuide('app'),
  },
];

const GUIDES_BY_ID = Object.fromEntries(DESIGN_GUIDES.map((g) => [g.id, g]));

// ---------------------------------------------------------------------------
// Per-build STRUCTURE ROLLS. The guides above are craft checklists — what a
// good build of that format gets right — but a checklist read as a recipe
// produces the same layout every time (the "same dashboard, different
// colors" failure). Models can't be trusted to vary on their own (they
// revert to their statistical center), so the SERVER rolls the structural
// decisions per build and injects them as directives. Same craft bar,
// different skeleton every time.
// ---------------------------------------------------------------------------
const GUIDE_ROLLS = {
  dashboard: {
    'shell': [
      'slim icon sidebar on the left, main area a 12-col grid',
      'top header bar with tab navigation, full-width panel grid below',
      'no nav chrome at all — one bento grid where the title/meta is simply the first cell',
      'narrow KPI rail down the left, charts filling the right two-thirds',
      'command-center: full-viewport grid, only a thin status strip on top',
    ],
    'KPI treatment': [
      'classic stat cards in a top row',
      'oversized bare numbers inline in the header strip — no card boxes around them',
      'stacked vertically in a side rail with sparklines under each',
      'embedded in the corner of the chart panel each one relates to',
    ],
    'hero data view': [
      'one dominant time-series area chart',
      'two medium line charts side by side comparing series',
      'a large donut/radial with a ranked breakdown list beside it',
      'a horizontal-bar ranking chart',
      'a small-multiples grid of 6–8 sparklines',
    ],
    'supporting panel': [
      'live activity feed with timestamps',
      'status grid of labeled pill badges',
      'ranked top-N table',
      'progress-to-goal bars',
      'calendar heat strip',
    ],
  },
  website: {
    'hero archetype': [
      'split hero — copy left, built visual right',
      'left-aligned hero with the visual bleeding off the right edge',
      'full-bleed dark band hero with light text',
      'editorial hero — huge headline across the page, small intro column beneath',
      'product-first hero — big framed product mock with the headline above it',
    ],
    'feature presentation': [
      'bento grid (one large cell, several small)',
      'alternating icon-left rows',
      '2×2 grid with real mini-visuals in each cell',
      'capability comparison table',
      'numbered vertical list with generous whitespace',
    ],
    'section rhythm': [
      'alternating light band backgrounds',
      'one continuous background with hairline rules between sections',
      'one dark interlude band mid-page, light everywhere else',
    ],
  },
  app: {
    'shell': [
      'one centered card on a soft page background',
      'full-frame app with a compact header bar',
      'sidebar for navigation/settings, main working area right',
      'mobile-style bottom tab bar with view switching',
    ],
    'primary control emphasis': [
      'a huge central number/readout with controls beneath',
      'a big central action button with supporting inputs above',
      'a list/grid as the centerpiece with a floating add action',
    ],
  },
  presentation: {
    'deck aesthetic': [
      'light editorial slides — dark ink on paper, accent rules',
      'dark cinematic slides — near-black, white type, accent highlights',
      'bold color-slab slides — full-bleed accent backgrounds on dividers',
    ],
    'title slide layout': [
      'centered stack',
      'bottom-left aligned block, meta top-right',
      'split — title left, big numeral or shape right',
    ],
  },
  document: {
    'masthead': [
      'classic — kicker, title, standfirst, hairline rule',
      'cover block — title inside a full-width tinted band',
      'margin style — slim title column left, meta right',
    ],
    'section headers': [
      'mono accent numbers ("01 —") before each heading',
      'plain bold headings with a short accent rule above',
      'uppercase kicker labels above each heading',
    ],
  },
};

/** Roll one option per axis for a guide. Exported for tests. */
export function rollGuideStructure(guideId) {
  const axes = GUIDE_ROLLS[guideId];
  if (!axes) return [];
  return Object.entries(axes).map(
    ([axis, options]) => `  • ${axis}: ${options[Math.floor(Math.random() * options.length)]}`,
  );
}

// "+" → Create menu artifactType keys (see ARTIFACT_BUILD_SPEC in server.js)
// that pin a guide regardless of wording. Deliberately unmapped: "webapp" is
// generic (wording decides website vs app vs dashboard), "deck" goes to the
// PPTX template tool rather than a React artifact, and spreadsheet/chart/
// diagram artifacts don't use these guides at all.
const GUIDE_BY_ARTIFACT_TYPE = {
  study: 'document',
  document: 'document',
  worksheet: 'document',
};

/**
 * Pick the style guide for a coded-artifact turn.
 * @param {string} userMessage  The user's request wording.
 * @param {string} [artifactType]  Explicit type from the Create menu ("webapp", "presentation"…).
 * @returns {string|null} guide id, or null when no format is discernible.
 */
export function pickDesignGuide(userMessage, artifactType) {
  const explicit = GUIDE_BY_ARTIFACT_TYPE[String(artifactType || '').toLowerCase()];
  if (explicit) return explicit;
  const text = String(userMessage || '');
  if (!text.trim()) return null;
  for (const g of DESIGN_GUIDES) {
    if (g.keywords.test(text)) return g.id;
  }
  // Generic "build/make me a …" with no recognizable format: no guide —
  // the DESIGN_SYSTEM brief + craft rules still apply on their own.
  return null;
}

/**
 * Format the [STYLE_GUIDE] prompt block for a guide id: the craft guide plus
 * this build's server-rolled structure directives. Returns '' when the id is
 * unknown or its file failed to load, so callers can push() blindly.
 */
export function formatDesignGuideBlock(guideId) {
  const g = GUIDES_BY_ID[guideId];
  if (!g || !g.content) return '';
  const roll = rollGuideStructure(guideId);
  return [
    `[STYLE_GUIDE — ${g.label}. The user's build matches this format. This guide is a CRAFT CHECKLIST (what a good ${g.id} gets right), NOT a layout template — do not reproduce one memorized arrangement. Follow it together with the [DESIGN_SYSTEM] brief (the design system owns colors/type tokens, this guide owns craft):`,
    g.content,
    ...(roll.length
      ? [
          `STRUCTURE ROLL for THIS build — rolled server-side so consecutive ${g.id} builds come out structurally different. Build to these directives (they override any default arrangement implied above), unless the user's request or the subject clearly demands otherwise. Ignore the roll when EDITING an existing artifact — keep its current structure:`,
          ...roll,
        ]
      : []),
    ']',
  ].join('\n');
}
