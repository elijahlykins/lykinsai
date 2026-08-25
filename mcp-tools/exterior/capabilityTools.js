// ============================================================================
// mcp-tools/exterior/capabilityTools.js — Model Builder capability tools
// ============================================================================

import { manageFile } from '../../lib/exterior/capabilities/fileOps.js';
import { parseDocument } from '../../lib/exterior/capabilities/documentParse.js';
import { runCode } from '../../lib/exterior/capabilities/runCode.js';
import { buildSpreadsheet } from '../../lib/exterior/capabilities/spreadsheet.js';
import { runSymbolicMath } from '../../lib/exterior/capabilities/symbolicMath.js';
import { processImage } from '../../lib/exterior/capabilities/processImage.js';
import { transcribeAudio } from '../../lib/exterior/capabilities/transcribeAudio.js';
import { generateSpeech } from '../../lib/exterior/capabilities/generateAudio.js';
import { buildTemplate } from '../../lib/exterior/capabilities/buildTemplate.js';
import { buildReactArtifact } from '../../lib/exterior/capabilities/buildReactArtifact.js';
import { renderVideo } from '../../lib/exterior/capabilities/renderVideo.js';
import { translateText } from '../../lib/exterior/capabilities/translate.js';
import { httpRequest } from '../../lib/exterior/capabilities/httpRequest.js';
import { capabilityCtx } from '../../lib/exterior/capabilityStorage.js';
import { logAiUsage } from '../../usageTracking.js';
import { jsonContent, errorContent } from '../index.js';

function withCtx(fn) {
  return async (args = {}, ctx = {}) => {
    const c = capabilityCtx({ ...ctx, logUsage: (info) => logAiUsage(info) });
    const result = await fn(args, c);
    if (result?.ok === false && result.error) {
      // Surface `hint` so scope-guard / edit retries actually see the recovery
      // instructions (edits path vs full_rewrite) instead of just the error code.
      const hint = typeof result.hint === 'string' && result.hint.trim()
        ? result.hint.trim()
        : '';
      return errorContent(hint ? `${result.error}: ${hint}` : result.error);
    }
    return jsonContent(result);
  };
}

export const manageFileTool = {
  name: 'lykn_manage_file',
  title: 'Create, edit, convert, or load files',
  scope: 'read',
  description: [
    'Create, edit, convert, or load user files. Supported formats: markdown, html, csv, json, plain text.',
    'Authenticated users get a persisted download URL (file_url). Use action=load with storage_path to read back.',
    'For interactive mini-apps and custom UIs: action=create with a .html filename and full self-contained HTML.',
    'The chat UI renders .html files inline as a live preview — prefer this over pasting HTML in markdown.',
    'EDITING an open file: pass `edits` ONLY — {find, replace} patches copied from [ARTIFACT_OPEN]. Do NOT resubmit full content unless the user asked to rebuild (then set full_rewrite: true).',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'edit', 'convert', 'load'] },
      filename: { type: 'string' },
      content: { type: 'string' },
      edits: {
        type: 'array',
        description: 'Targeted find/replace patches against the open file (instead of full content).',
        items: {
          type: 'object',
          properties: {
            find: { type: 'string' },
            replace: { type: 'string' },
          },
          required: ['find', 'replace'],
          additionalProperties: false,
        },
      },
      full_rewrite: {
        type: 'boolean',
        description: 'Set true ONLY when replacing an open file with full content because the user asked to rebuild.',
      },
      storage_path: { type: 'string', description: 'For load action — path from a prior file_url response.' },
      source_format: { type: 'string' },
      target_format: { type: 'string' },
      persist: { type: 'boolean', description: 'Default true when user is signed in.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  handler: withCtx(manageFile),
};

export const parseDocumentTool = {
  name: 'lykn_parse_document',
  title: 'Parse a document or web page',
  scope: 'read',
  description: [
    'Extract text from PDF, DOCX, XLSX, PPTX, CSV, ODT, plain text, or readable web pages.',
    'Pass a URL or base64-encoded file bytes plus filename when possible.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      base64: { type: 'string' },
      filename: { type: 'string' },
      mime_type: { type: 'string' },
      text: { type: 'string' },
    },
    additionalProperties: false,
  },
  handler: withCtx(parseDocument),
};

export const runCodeTool = {
  name: 'lykn_run_code',
  title: 'Run code (Python or JavaScript)',
  scope: 'read',
  description: [
    'Execute Python or JavaScript for coding, debugging, review, and analysis.',
    'Python debug/review modes allow safe stdlib imports (math, json, statistics, etc.).',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      language: { type: 'string', enum: ['python', 'javascript'] },
      mode: { type: 'string', enum: ['write', 'debug', 'review', 'refactor'] },
      profile: { type: 'string', enum: ['strict', 'analysis'] },
      code: { type: 'string' },
    },
    required: ['code'],
    additionalProperties: false,
  },
  handler: withCtx(runCode),
};

export const buildSpreadsheetTool = {
  name: 'lykn_build_spreadsheet',
  title: 'Build spreadsheet tables',
  scope: 'read',
  description: [
    'Create markdown tables, CSV, or XLSX from headers and row data.',
    'Returns a download URL when the user is signed in. Include markdown_table or download link in your reply.',
    'EDITING an open sheet: pass `cell_edits` ONLY — do NOT resubmit full headers/rows unless the user asked to rebuild (full_rewrite: true).',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      headers: { type: 'array', items: { type: 'string' } },
      rows: { type: 'array', items: { type: 'object' } },
      cell_edits: {
        type: 'array',
        description:
          'Targeted cell/row patches against the open spreadsheet. ' +
          'Use {row, col|column, value}, {row, values}, {insert_row, values}, or {remove_row}.',
        items: { type: 'object' },
      },
      full_rewrite: {
        type: 'boolean',
        description: 'Set true ONLY when replacing an open sheet with full headers/rows because the user asked to rebuild.',
      },
      output_format: { type: 'string', enum: ['markdown', 'csv', 'xlsx'] },
    },
    // rows required for new builds; open-sheet cell_edits turns omit them.
    additionalProperties: false,
  },
  handler: withCtx(buildSpreadsheet),
};

export const symbolicMathTool = {
  name: 'lykn_symbolic_math',
  title: 'Symbolic math',
  scope: 'read',
  description: [
    'Simplify, solve, integrate, differentiate, expand, or factor symbolic expressions.',
    'Uses SymPy when available; falls back to Gemini/OpenAI otherwise.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      expression: { type: 'string' },
      mode: {
        type: 'string',
        enum: ['simplify', 'solve', 'integrate', 'differentiate', 'expand', 'factor'],
      },
    },
    required: ['expression'],
    additionalProperties: false,
  },
  handler: withCtx(runSymbolicMath),
};

export const processImageTool = {
  name: 'lykn_process_image',
  title: 'OCR, analyze, or edit images',
  scope: 'read',
  description: [
    'OCR (including PDFs), vision analysis, or image editing.',
    'For edit, pass operation=edit plus a detailed prompt — returns a hosted image_url.',
    'For brand-new images from scratch use lykn_generate_image.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['ocr', 'analyze', 'edit'] },
      image_url: { type: 'string' },
      base64: { type: 'string' },
      mime_type: { type: 'string' },
      prompt: { type: 'string' },
      aspect_ratio: { type: 'string' },
      image_size: { type: 'string' },
    },
    required: ['operation'],
    additionalProperties: false,
  },
  handler: withCtx(processImage),
};

export const transcribeAudioTool = {
  name: 'lykn_transcribe_audio',
  title: 'Transcribe audio to text',
  scope: 'read',
  description: 'Transcribe speech from an audio URL or base64 payload using Whisper.',
  inputSchema: {
    type: 'object',
    properties: {
      audio_url: { type: 'string' },
      base64: { type: 'string' },
      language: { type: 'string' },
      prompt: { type: 'string' },
    },
    additionalProperties: false,
  },
  handler: withCtx(transcribeAudio),
};

export const generateSpeechTool = {
  name: 'lykn_generate_speech',
  title: 'Generate speech from text',
  scope: 'read',
  description: 'Convert text to speech. Returns a hosted download URL for the audio file.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      voice: { type: 'string', enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] },
      format: { type: 'string', enum: ['mp3', 'opus', 'aac', 'flac'] },
    },
    required: ['text'],
    additionalProperties: false,
  },
  handler: withCtx(generateSpeech),
};

export const buildTemplateTool = {
  name: 'lykn_build_template',
  title: 'Build structured templates',
  scope: 'read',
  description: [
    'Build slideshows, lessons, worksheets, documents, emails, forms, social posts, or layouts.',
    'Exports a PDF (the easy, universal download), plus Markdown, JSON, HTML, and PPTX (slides) when signed in.',
    'The chat UI renders HTML artifacts inline and offers the PDF/PPTX/Markdown downloads — use this for study guides, docs, and pitch decks.',
    'Pass export_formats: ["html","pptx"] for presentations. Summarise in prose after; no need to paste URLs.',
    'Pass `theme` to set the accent color (name like "blue", "green", "purple", "red", "teal", "orange" or a hex like "#2563eb").',
    'Pass `font` to set the typeface (inter, georgia, playfair, space-grotesk, merriweather, mono, system).',
    'STYLE-ONLY EDITS on an open deck/doc: omit `sections` entirely and pass only `theme` and/or `font` (keep the same title + template_type). The server reuses the existing slides verbatim — do NOT rewrite slide copy when the user only asked for a font or color change.',
    'CONTENT EDITS on an open deck/doc: pass `section_edits` ONLY (index/id field overlays, find/replace, insert_at, remove_*). Do NOT resubmit the full `sections` array unless the user asked to rebuild (then set full_rewrite: true).',
    'Do NOT use emojis anywhere in titles, headings, body, notes, or metadata — keep generated documents, decks, and PDFs clean and professional (any emoji is stripped from the output regardless).',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      template_type: {
        type: 'string',
        enum: [
          'slideshow',
          'presentation',
          'education',
          'worksheet',
          'document',
          'email',
          'form',
          'social',
          'layout',
          'generic',
        ],
      },
      title: { type: 'string' },
      sections: { type: 'array', items: { type: 'object' } },
      section_edits: {
        type: 'array',
        description:
          'Targeted patches to the open template. Prefer over full sections. ' +
          'Supports {find,replace}, {index|id, heading?, body?, notes?}, {insert_at, section}, {remove_index|remove_id}.',
        items: { type: 'object' },
      },
      content_edits: {
        type: 'array',
        description: 'Find/replace patches against open document `content` (when not using sections).',
        items: {
          type: 'object',
          properties: {
            find: { type: 'string' },
            replace: { type: 'string' },
          },
          required: ['find', 'replace'],
          additionalProperties: false,
        },
      },
      full_rewrite: {
        type: 'boolean',
        description:
          'Set true ONLY when replacing an open template with full sections/content because the user asked to rebuild.',
      },
      metadata: { type: 'object' },
      content: { type: 'string' },
      theme: {
        type: 'string',
        description: 'Accent color: a name (blue, green, purple, red, teal, indigo, rose, amber, slate, orange) or a hex like #2563eb.',
      },
      font: {
        type: 'string',
        description:
          'Typeface for the template: inter, georgia, playfair, space-grotesk, merriweather, mono, system (or a CSS font-family string).',
      },
      export_formats: {
        type: 'array',
        items: { type: 'string', enum: ['markdown', 'json', 'html', 'pptx'] },
      },
    },
    required: ['template_type'],
    additionalProperties: false,
  },
  handler: withCtx(buildTemplate),
};

export const buildReactArtifactTool = {
  name: 'lykn_build_react_artifact',
  title: 'Build a React artifact (live interactive preview)',
  scope: 'read',
  description: [
    'Build a document, dashboard, tool, game, or any interactive deliverable by',
    'WRITING REACT CODE — claude.ai Artifacts style. LYKN renders it live in a',
    'sandboxed panel next to the chat.',
    '',
    'TWO BUILD MODES:',
    '  1) SINGLE FILE — pass `title` + `code` (one component, export default).',
    '     Best for docs, dashboards, small tools, simple games.',
    '  2) MULTI-FILE PROJECT — pass `title` + `files` (array of {path, content})',
    '     with entry App.jsx (or set `entry`). Use RELATIVE imports between your',
    '     files: `import Player from "./game/Player.js"`. Prefer this for complex',
    '     apps, 3D games, multi-scene tools — split systems into modules',
    '     (game/, components/, lib/). Up to ~48 files.',
    '  Also pass `todos` (coding plan: [{id, content, status}]) on complex builds',
    '  with short human labels of each part (Hero, Pricing, Footer) and mark the',
    '  current step in_progress so the user can follow along while you write.',
    '  Update statuses as you finish steps. Pass `assets` ([{name, url}]) to',
    '  register hosted image/audio URLs as `import ASSETS from "./assets.js"` or',
    '  window.__lyknAssets — use URLs from lykn_generate_image / [USER_IMAGES].',
    '',
    'No CDN imports needed — a FULL library stack is ALREADY in scope:',
    '  • React 18 + every hook (useState, useEffect, useMemo, useRef, …)',
    '  • Tailwind CSS classes (className="p-6 text-2xl font-bold …") with the',
    '    forms, typography (`prose`), aspect-ratio, and line-clamp plugins',
    '  • Recharts via the `Recharts` global (const { LineChart, Line, XAxis } = Recharts)',
    '  • lucide-react icons via the `LucideReact` global (const { Check } = LucideReact)',
    '  • framer-motion: `motion` and `AnimatePresence` are in scope (more via window.Motion)',
    '  • d3 (`d3`), three.js (`THREE`), lodash (`_`), dayjs (`dayjs`), mathjs (`math`)',
    '  • PapaParse (`Papa`), marked (`marked`), Tone.js (`Tone`), canvas-confetti (`confetti`)',
    '  • html2canvas (`html2canvas`) + jsPDF (`jsPDF`) for in-artifact PDF/PNG export buttons',
    'You MAY write `import` lines for any of those packages — the runner strips',
    'and rewires them — but no OTHER packages exist, and no network calls.',
    '',
    'DATA THAT SURVIVES — `lykn.db` (use this for ANY app that saves things):',
    '  Anything the user creates and expects to still be there tomorrow — notes,',
    '  tasks, entries, settings, saved games — goes in `lykn.db`, NOT in',
    '  localStorage and NOT only in React state. React state alone is wiped on',
    '  every reload, so a "notes app" built on useState loses every note.',
    '  The API is async, promise-based, and scoped to this app alone:',
    '    await lykn.db.set(collection, key, value)   // value: any JSON',
    '    await lykn.db.get(collection, key)',
    '    await lykn.db.list(collection, { limit })   // newest first',
    '    await lykn.db.delete(collection, key)',
    '    await lykn.db.search(collection, "query")',
    '    await lykn.db.count(collection)',
    '  A `collection` is a table name you choose ("notes", "tasks"); `key` is',
    '  the row id (use crypto.randomUUID()). Load in a useEffect on mount and',
    '  write on every change. Guard with `if (window.lykn)` so the same code',
    '  still previews in chat, where the bridge is absent — fall back to plain',
    '  React state there and the app upgrades itself once installed.',
    '  DESIGN THE DATA FIRST: before writing UI, decide the collections, what a',
    '  row looks like, and when it is read and written. State the shape in a',
    '  short comment at the top of the file.',
    '',
    'MANIFEST — include an `app.json` file whenever you build something the user',
    'would want to keep and reopen (a real app, not a one-off page):',
    '    {"name":"Notes","description":"Jot things down","icon":"notebook",',
    '     "entry":"App.jsx","capabilities":["storage"]}',
    '  `icon` is a lucide-react icon name (kebab or Pascal) and becomes the app\'s',
    '  icon in the dock — pick the one that says what THIS app is (dumbbell for a',
    '  workout log, piggy-bank for savings, gamepad-2 for a game), never a generic',
    '  app-window/layout-dashboard, so two installed apps never look alike.',
    '  Capabilities are permissions the user is asked to approve, so request the',
    '  MINIMUM: "storage" (own data — always fine), "vault.read", "vault.write",',
    '  "files.read", "ai", "net" plus "net:<host>" per allowed host. Anything not',
    '  listed here is refused at run time, so never request one speculatively.',
    '  With app.json present the user gets an Install button that puts the app in',
    '  their dock with its own private database.',
    '',
    'INSTALLED APPS run offline from a real origin and ship React, Tailwind,',
    'lucide-react, Recharts, and framer-motion. The rest of the list above',
    '(three.js, d3, Tone, PapaParse, …) is preview-only, so an app the user will',
    'install should stick to those five and write anything else by hand.',
    '',
    'STYLING (already loaded — USE these, never ship browser-default styling):',
    '  • Fonts: Inter is the default (`font-sans`); use `font-display` (Space',
    '    Grotesk) for hero/heading text and `font-mono` (JetBrains Mono) for code.',
    '  • daisyUI component classes for instant polish: btn/btn-primary, card,',
    '    badge, tabs, table, modal, progress, alert, stat, toggle, drawer, navbar.',
    '    Mix freely with Tailwind utilities.',
    '  • animate.css classes for entrances (animate__animated animate__fadeInUp)',
    '    or framer-motion for anything interactive/orchestrated.',
    '  • Design bar: pick ONE accent color scale that FITS THE SUBJECT and',
    '    stick to it — NEVER default to purple/violet/indigo/fuchsia unless the',
    '    user explicitly asks (vary: blues, teals, emerald, orange, rose, amber,',
    '    cyan, graphite); SOLID colors only — no gradients (bg-gradient-*,',
    '    gradient text, gradient buttons) unless the user explicitly asks for',
    '    one; generous whitespace (p-6/p-8, space-y-6);',
    '    rounded-xl/rounded-2xl cards with shadow-soft (custom) or shadow-sm —',
    '    never heavy default shadows; a clear type hierarchy (text-3xl/4xl',
    '    font-display bold heading → text-sm text-gray-500 supporting);',
    '    long-form text inside `prose max-w-none`.',
    '  • Fonts: keep typography SIMPLE — Inter for nearly everything, hierarchy',
    '    from size/weight/spacing; font-display only for large display headings,',
    '    font-mono for numbers/code. No expressive type unless the user asks.',
    '  • Range: you have a real portfolio — clean product, minimal, editorial,',
    '    glassmorphic, neumorphic (soft UI), neo-brutalist, warm organic, dark',
    '    dashboard, playful — follow the [DESIGN_SYSTEM] brief for the active one',
    '    and let different builds look genuinely different. AVOID the vibe-coded',
    '    fingerprint (purple gradients, badge-over-centered-hero, three icon',
    '    cards, 1-2-3 step cards, emoji icons, glow-orb dark modes) — the',
    '    [DESIGN_SYSTEM] block lists the full ban list.',
    '  • Complexity: match the ask — a quick utility is ONE focused, styled',
    '    screen; a website/presentation gets full multi-section treatment; an',
    '    app/game gets multi-view navigation and real states. No filler, no',
    '    under-building.',
    '  • Craft: define a const THEME token object up top and bind every color/',
    '    radius through it; componentize anything repeated (map over data',
    '    arrays, no copy-pasted markup); mobile-first responsive classes',
    '    (base → sm:/md:/lg:) so it works at phone AND desktop; hover/focus',
    '    states on everything interactive.',
    '',
    'IMAGES inside artifacts — real <img> URLs are allowed ONLY from:',
    '  • https://picsum.photos/seed/<any-word>/<w>/<h> — real photos (seeded =',
    '    stable); use for hero/section/card imagery when a generic photo fits.',
    '  • https://i.pravatar.cc/<size>?u=<seed> — people avatars (testimonials,',
    '    team sections, user lists).',
    '  • https://api.dicebear.com/9.x/<style>/svg?seed=<seed> — illustrated',
    '    avatars (styles: notionists, lorelei, shapes, identicon, bottts).',
    '  • https://placehold.co/<w>x<h>/<bg>/<fg>?text=<label> — labeled',
    '    placeholders when the user will swap in their own asset.',
    '  • Any URL handed to you in [USER_IMAGES] (the user\'s own uploaded',
    '    images) or [GENERATED_IMAGES] (images LYKN generated earlier in this',
    '    chat) — both hosted for embedding; prefer these over stock whenever',
    '    they exist. Also any file_url returned by lykn_generate_image in THIS',
    '    conversation.',
    'NEVER invent any other image URL (unsplash/imgur/cdn links you \"remember\"',
    '404 and leave broken boxes). With no suitable source, build the visual',
    'from styled divs/SVG/icons instead — that is always acceptable.',
    '',
    'ANIMATING IMAGES — user/generated images are first-class build material,',
    'not just decoration. When the user says "animate this", "bring it to',
    'life", or builds around an image, pick the technique that fits:',
    '  • motion.img / motion.div with bg-image — entrances, hover lift/tilt,',
    '    infinite float (animate={{ y: [0,-10,0] }} transition={{ repeat:',
    '    Infinity }}), drag, layout transitions.',
    '  • Ken Burns: slow scale+pan via CSS keyframes or framer-motion — the',
    '    default treatment for cinematic hero photos.',
    '  • Scroll choreography: framer-motion useScroll + useTransform for',
    '    parallax layers, scroll-driven scale/fade/pin effects.',
    '  • Reveals: clip-path / mask keyframes (wipe, iris, split), or stagger a',
    '    grid of tiles each showing an offset slice via background-position.',
    '  • Interactive: mouse-tracking 3D tilt (perspective + rotateX/Y from',
    '    cursor), magnetic hover, before/after comparison sliders.',
    '  • Game/canvas: draw the image into <canvas> (new Image() + drawImage)',
    '    for sprites, physics, particle disintegration/assembly effects.',
    '  • Ambient depth: duplicate the image as a blurred oversized backdrop',
    '    (blur-3xl opacity-30) behind the sharp copy.',
    'Always set explicit width/height or aspect-[w/h] so layout never jumps,',
    'object-cover for fills, and loading="lazy" below the fold.',
    '',
    'WHEN TO USE: full mini apps and websites (landing pages, multi-section',
    'sites, dashboards, tools), presentations/slide decks with animated',
    'transitions, documents, reports, study guides, worksheets, calculators,',
    'quizzes, games (2D canvas, 3D via THREE, sound via Tone), prototypes —',
    'anything the user should read or interact with. Prefer this over',
    'lykn_manage_file HTML pages and over dumping code in markdown. For plain',
    'slide DECKS that need a pptx download, lykn_build_template is still the',
    'right tool; for a downloadable xlsx, lykn_build_spreadsheet.',
    '',
    'QUALITY BAR: make it polished and complete — real layout, spacing, and',
    'typography via Tailwind; animation via framer-motion where it helps;',
    'sensible sample data only when the user gave none; no emojis in documents.',
    'Don\'t under-build: multi-view apps, full page sections, working game',
    'loops, and print/export buttons are all expected when the request calls',
    'for them. The component must render standalone with NO props.',
    '',
    'EDITING AN EXISTING ARTIFACT — SCOPE DISCIPLINE (the user\'s #1',
    'complaint is edits that change things they did not ask about):',
    '  • Change ONLY what the user requested. Every other line must survive',
    '    byte-for-byte — no reformatting, re-indenting, renaming, recoloring,',
    '    comment stripping, copy rewrites, layout shuffles, or "while I\'m',
    '    here" improvements. An unrequested change is a BUG, even if you',
    '    think it makes the artifact better.',
    '  • PRESERVE THE LOOK: keep THEME tokens, Tailwind classes, layout, and',
    '    fonts. "Add more hooks / expand the bank / fix this copy" is a',
    '    CONTENT edit — never an excuse to redesign the UI.',
    '  • `edits` is the DEFAULT edit mechanism: an array of {find, replace,',
    '    path?} patches where each `find` is an EXACT, UNIQUE snippet copied',
    '    from [ARTIFACT_OPEN] (for multi-file, set `path` to the file). Use',
    '    replace: "" to delete. Keep each `replace` MINIMAL.',
    '  • ONE CALL: put every requested change in that single `edits` array.',
    '    Do not call this tool once per tweak — intermediate versions spam the chat.',
    '  • Multi-file also supports `file_ops`: [{op:"write"|"delete", path,',
    '    content?}] to add/replace whole files without resubmitting the tree.',
    '  • Full `code`/`files` on an edit turn is REJECTED unless the user',
    '    explicitly asked for a sweeping change — then pass full_rewrite: true.',
    '  • If [ARTIFACT_RUNTIME_ERRORS] lists preview crashes, FIX those with',
    '    targeted edits before adding features.',
    '  • Keep `todos` current on long builds (mark completed / in_progress).',
    '',
    'After it returns, reply with a 1-2 sentence summary. NEVER paste the code,',
    'HTML, or URLs into the chat — the panel shows the artifact automatically.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short human title shown on the artifact card.' },
      code: {
        type: 'string',
        description:
          'Complete single-file React component (JSX/TSX) with export default. ' +
          'For complex multi-module builds prefer `files` instead.',
      },
      files: {
        type: 'array',
        description:
          'Multi-file project sources. Each item: {path, content}. Entry defaults to App.jsx. ' +
          'Use relative imports between files. Prefer for games/complex apps.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Project-relative path, e.g. App.jsx or game/Player.js' },
            content: { type: 'string', description: 'Full file source.' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
      entry: {
        type: 'string',
        description: 'Entry file path inside `files` (default App.jsx).',
      },
      edits: {
        type: 'array',
        description:
          'Targeted patches to the open artifact (instead of full code/files). ' +
          'For multi-file projects include `path`.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File to patch (multi-file projects).' },
            find: { type: 'string', description: 'Exact snippet copied from the current source (unique, whitespace included).' },
            replace: { type: 'string', description: 'Replacement text ("" deletes the snippet).' },
          },
          required: ['find', 'replace'],
          additionalProperties: false,
        },
      },
      file_ops: {
        type: 'array',
        description:
          'Add/replace/delete whole files in an open multi-file project without resubmitting every file.',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['write', 'delete'], description: 'write upserts content; delete removes the file.' },
            path: { type: 'string' },
            content: { type: 'string', description: 'Required for write.' },
          },
          required: ['op', 'path'],
          additionalProperties: false,
        },
      },
      todos: {
        type: 'array',
        description:
          'Coding plan with short human labels of each part (Hero, Pricing, Footer). Mark the current step in_progress. Statuses: pending | in_progress | completed | cancelled.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
          },
          required: ['content'],
          additionalProperties: false,
        },
      },
      assets: {
        type: 'array',
        description:
          'Hosted asset URLs to inject as ./assets.js (and window.__lyknAssets). Use lykn_generate_image / user upload URLs only.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Key used in ASSETS[name].' },
            url: { type: 'string', description: 'https URL of the asset.' },
          },
          required: ['name', 'url'],
          additionalProperties: false,
        },
      },
      full_rewrite: {
        type: 'boolean',
        description:
          'Set true ONLY when replacing an OPEN artifact with full `code`/`files` because the user explicitly ' +
          'asked for a sweeping change (full restyle/restructure). Without this flag, full submissions over ' +
          'an open artifact are always rejected — use `edits` / `file_ops` instead.',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
  handler: withCtx(buildReactArtifact),
};

export const renderVideoTool = {
  name: 'lykn_render_video',
  title: 'Render an animation to a real .mp4 video',
  scope: 'read',
  description: [
    'Render a REAL .mp4 video from a Remotion composition you write — animated',
    'logos, image animations (Ken Burns, parallax, reveals), motion graphics,',
    'animated UI mockups, title cards, short product clips for landing pages',
    'and social. The server renders it frame-by-frame in headless Chrome and',
    'returns a hosted file_url; the video appears as an inline playable card.',
    '',
    'WHEN TO USE: the user wants a VIDEO FILE — "make this an mp4", "animate',
    'my logo into a video", "a clip for my landing page", "turn that image',
    'into an animation I can download". For live in-page interactivity use',
    'lykn_build_react_artifact instead (and embed any rendered video in it via',
    '<video src autoPlay muted loop playsInline>).',
    '',
    'HOW TO WRITE THE COMPOSITION (single file, export default one component):',
    '  • Import ONLY from "remotion" and "react". No other packages, no',
    '    Tailwind — style with inline style objects.',
    '  • Frame-driven: const frame = useCurrentFrame(); const {fps, width,',
    '    height, durationInFrames} = useVideoConfig(); every visual property',
    '    must be a pure function of frame.',
    '  • Motion math: interpolate(frame, [0,30], [0,1], {extrapolateRight:',
    '    "clamp", easing: Easing.out(Easing.cubic)}) and spring({frame, fps,',
    '    config:{damping: 14}}) for natural physics.',
    '  • Structure: <AbsoluteFill> for layers; <Sequence from={N}',
    '    durationInFrames={M}> to choreograph scenes on the timeline.',
    '  • Images: <Img src="https://..." /> from "remotion" (NOT <img>) — use',
    '    URLs from [USER_IMAGES] / [GENERATED_IMAGES] or the approved stock',
    '    services; never invent URLs. Animate the element: scale/pan (Ken',
    '    Burns), translate parallax layers, clipPath wipes, opacity crossfades,',
    '    blurred duplicate as ambient backdrop.',
    '  • SVG animates per-part: stroke draw-on via pathLength={1}',
    '    strokeDasharray={1} strokeDashoffset={1-progress}, staggered group',
    '    transforms, animated fills. Recreate simple logos as inline SVG for',
    '    the best "logo comes alive" results.',
    '  • Text/UI: plain divs with inline styles — system fonts only',
    '    (Helvetica/Arial/system-ui; no webfont loading). Fade/slide/scale text',
    '    in staggered Sequences.',
    '  • Do NOT call registerRoot() or <Composition> — pass only the component;',
    '    the server registers it with your duration/fps/size args.',
    '',
    'DEFAULTS & LIMITS: 1280x720 @ 30fps, 150 frames (5s) unless specified;',
    'max 900 frames (30s), max 1920px per side, fps 24/30/60. Rendering takes',
    'roughly real-time to 3x real-time — keep clips SHORT and purposeful.',
    'ALWAYS end the motion resolved (settled, not mid-animation) so the final',
    'frame looks good as a poster; for landing-page loops, make frame 0 and',
    'the last frame match so it loops seamlessly.',
    '',
    'After it returns, reply with a 1-2 sentence summary. NEVER paste the code',
    'or any URL into the chat — the video card renders automatically.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short human title shown on the video card.' },
      code: {
        type: 'string',
        description:
          'Complete single-file Remotion composition (TSX) with export default. ' +
          'Imports only from "remotion" and "react".',
      },
      duration_in_frames: {
        type: 'number',
        description: 'Total frames (default 150 = 5s at 30fps, max 900).',
      },
      fps: { type: 'number', enum: [24, 30, 60], description: 'Default 30.' },
      width: { type: 'number', description: 'Pixels, default 1280, max 1920.' },
      height: { type: 'number', description: 'Pixels, default 720, max 1920.' },
    },
    required: ['title', 'code'],
    additionalProperties: false,
  },
  handler: withCtx(renderVideo),
};

export const translateTool = {
  name: 'lykn_translate',
  title: 'Translate text',
  scope: 'read',
  description: 'Translate text to a target language. Returns the translation only.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      target_language: { type: 'string' },
      source_language: { type: 'string' },
    },
    required: ['text', 'target_language'],
    additionalProperties: false,
  },
  handler: withCtx(translateText),
};

export const httpRequestTool = {
  name: 'lykn_http_request',
  title: 'HTTP / API request',
  scope: 'read',
  description: [
    'Make a restricted HTTP request to a public API. Private/local URLs blocked. Rate limited.',
    'Do not send cookies or Authorization headers.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
      url: { type: 'string' },
      headers: { type: 'object' },
      body: {},
    },
    required: ['url'],
    additionalProperties: false,
  },
  handler: withCtx(httpRequest),
};

export const CAPABILITY_TOOLS = [
  manageFileTool,
  parseDocumentTool,
  runCodeTool,
  buildSpreadsheetTool,
  symbolicMathTool,
  processImageTool,
  transcribeAudioTool,
  generateSpeechTool,
  buildTemplateTool,
  buildReactArtifactTool,
  renderVideoTool,
  translateTool,
  httpRequestTool,
];

export const CAPABILITY_TOOLS_BY_NAME = Object.freeze(
  Object.fromEntries(CAPABILITY_TOOLS.map((t) => [t.name, t])),
);
