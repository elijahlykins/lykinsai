// ============================================================================
// Design systems for coded artifacts (lykn_build_react_artifact).
//
// Portable DESIGN.md-style briefs — the format is adapted from the
// open-design project (github.com/nexu-io/open-design, Apache-2.0): a
// compact, sectioned spec (theme / color / typography / spacing / components
// / motion / anti-patterns) that gets injected into the build prompt so the
// model designs inside a coherent system instead of improvising per turn.
//
// Every brief is written against what the artifact runner ACTUALLY loads
// (see buildReactArtifact.js): Tailwind + forms/typography plugins, Inter /
// Space Grotesk / JetBrains Mono, daisyUI light theme, animate.css,
// framer-motion. Hex tokens are used directly via Tailwind arbitrary values
// (bg-[#0D9488]) or the closest utility scale.
//
// COLOR (Build default): a quiet earthy-neutral palette — black / white /
// grays plus muted dark & sage greens, dark & slate blues, beige, and browns.
// Bright candy accents (orange, rose, cyan, electric emerald, etc.) only when
 // the user (1) asks for color / a chromatic style, or (2) attaches a
 // reference idea. Purple is still never default.
 //
 // pickDesignSystem() chooses a preset from the user's request wording; when
 // no style is named it ROTATES through a default pool (instead of always
 // landing on one house style) so consecutive generic builds come out looking
 // different from each other. The user can always name a style ("make it
 // playful", "glassmorphic", "dark dashboard") — the keywords catch that.
 //
 // FONTS: deliberately boring. The runner loads Inter (font-sans), Space
 // Grotesk (font-display), JetBrains Mono (font-mono) — briefs default to the
 // plain sans with hierarchy built from SIZE/WEIGHT/SPACING, reserve
 // font-display for large display headings at most, and never ask for
 // decorative faces. Fancy typography only happens when the user requests it.
 // ============================================================================

// Curated accent palettes the server rotates through when color is ALLOWED.
 // Each carries solid tokens plus Tailwind tint/text/ring classes. The
 // gradient recipe is OPT-IN ONLY. No purples — if the user wants purple
 // they'll say so.
export const ACCENT_PALETTES = [
  { name: 'ocean blue', primary: '#2563EB', hover: '#1D4ED8', tint: 'bg-blue-50', tintText: 'text-blue-700', ring: 'ring-blue-500', gradient: 'from-blue-600 via-sky-500 to-cyan-400' },
  { name: 'deep teal', primary: '#0D9488', hover: '#0F766E', tint: 'bg-teal-50', tintText: 'text-teal-700', ring: 'ring-teal-500', gradient: 'from-teal-600 via-emerald-500 to-lime-400' },
  { name: 'emerald', primary: '#059669', hover: '#047857', tint: 'bg-emerald-50', tintText: 'text-emerald-700', ring: 'ring-emerald-500', gradient: 'from-emerald-600 via-teal-500 to-cyan-400' },
  { name: 'sunset orange', primary: '#EA580C', hover: '#C2410C', tint: 'bg-orange-50', tintText: 'text-orange-700', ring: 'ring-orange-500', gradient: 'from-orange-500 via-rose-500 to-pink-500' },
  { name: 'crimson rose', primary: '#E11D48', hover: '#BE123C', tint: 'bg-rose-50', tintText: 'text-rose-700', ring: 'ring-rose-500', gradient: 'from-rose-600 via-red-500 to-orange-400' },
  { name: 'amber gold', primary: '#D97706', hover: '#B45309', tint: 'bg-amber-50', tintText: 'text-amber-700', ring: 'ring-amber-500', gradient: 'from-amber-500 via-orange-500 to-rose-500' },
  { name: 'cyan electric', primary: '#0891B2', hover: '#0E7490', tint: 'bg-cyan-50', tintText: 'text-cyan-700', ring: 'ring-cyan-500', gradient: 'from-cyan-500 via-sky-500 to-blue-600' },
  { name: 'forest green', primary: '#16A34A', hover: '#15803D', tint: 'bg-green-50', tintText: 'text-green-700', ring: 'ring-green-500', gradient: 'from-green-600 via-emerald-500 to-teal-400' },
  { name: 'graphite mono', primary: '#18181B', hover: '#3F3F46', tint: 'bg-zinc-100', tintText: 'text-zinc-800', ring: 'ring-zinc-600', gradient: 'from-zinc-800 via-zinc-600 to-zinc-400' },
];

/** Quiet earthy-neutral accents — Build default until the user opts into chroma. */
export const NEUTRAL_ACCENT_PALETTES = [
  { name: 'graphite mono', primary: '#18181B', hover: '#3F3F46', tint: 'bg-zinc-100', tintText: 'text-zinc-800', ring: 'ring-zinc-600', gradient: 'from-zinc-800 via-zinc-600 to-zinc-400' },
  { name: 'dark green', primary: '#1C3D2E', hover: '#163328', tint: 'bg-[#E8F0EB]', tintText: 'text-[#1C3D2E]', ring: 'ring-[#1C3D2E]', gradient: 'from-[#1C3D2E] via-[#2F5D46] to-[#6B8F7A]' },
  { name: 'sage green', primary: '#5F7A65', hover: '#4A6352', tint: 'bg-[#EFF3F0]', tintText: 'text-[#3D5244]', ring: 'ring-[#5F7A65]', gradient: 'from-[#5F7A65] via-[#7A9480] to-[#B4C4B8]' },
  { name: 'dark blue', primary: '#1E3A5F', hover: '#172E4C', tint: 'bg-[#E8EEF5]', tintText: 'text-[#1E3A5F]', ring: 'ring-[#1E3A5F]', gradient: 'from-[#1E3A5F] via-[#2F5280] to-[#6B87A8]' },
  { name: 'slate blue', primary: '#4A6274', hover: '#3A4F5E', tint: 'bg-[#EEF2F5]', tintText: 'text-[#344656]', ring: 'ring-[#4A6274]', gradient: 'from-[#4A6274] via-[#6A8090] to-[#A8B6C0]' },
  { name: 'warm beige', primary: '#A89880', hover: '#8F7F68', tint: 'bg-[#F7F3EC]', tintText: 'text-[#5C5346]', ring: 'ring-[#A89880]', gradient: 'from-[#A89880] via-[#C4B59A] to-[#E8DFD0]' },
  { name: 'clay brown', primary: '#6B4F3A', hover: '#563F2E', tint: 'bg-[#F3EDE7]', tintText: 'text-[#6B4F3A]', ring: 'ring-[#6B4F3A]', gradient: 'from-[#6B4F3A] via-[#8A6B52] to-[#C4A882]' },
  { name: 'walnut brown', primary: '#4A3728', hover: '#3A2B1F', tint: 'bg-[#F0EBE6]', tintText: 'text-[#4A3728]', ring: 'ring-[#4A3728]', gradient: 'from-[#4A3728] via-[#6B5340] to-[#A89078]' },
];

/** @deprecated Prefer pickAccentPalette() — kept as the graphite member of the quiet pool. */
export const NEUTRAL_ACCENT = NEUTRAL_ACCENT_PALETTES[0];

/**
 * True when the user asked for vivid / chromatic color, or supplied a
 * visual reference idea the build should match. Quiet earthy neutrals
 * (sage, slate blue, beige, brown) are the DEFAULT and do not require this.
 */
export function userAllowsColor(userMessage, { hasReferenceImages = false } = {}) {
  if (hasReferenceImages) return true;
  const text = String(userMessage || '');
  if (!text.trim()) return false;
  // Explicit neutral / mono / earthy-quiet asks stay on the quiet pool.
  if (
    /\b(?:all\s+neutral|neutral\s+(?:colou?rs?|palette|theme|tones?|look)|neutral[- ]colou?red|gr[ae]yscale|monochrome|black\s*(?:and|&)\s*white|desaturat(?:e|ed)|no\s+colou?rs?|gray\s+only|grey\s+only|earthy|beige|brown|sage)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  // Explicit vivid color / palette / brand-chroma asks.
  if (
    /\b(?:colou?rful|vibrant|vivid|bright(?:er)?|neon|pastel|saturated|rainbow|multi[- ]?colou?r|brand\s+colou?rs?|pop\s+of\s+colou?r|splash\s+of\s+colou?r)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  // Named vivid hues (not the quiet earthy set already allowed by default).
  if (
    /\b(?:orange|amber|gold|rose|red|crimson|cyan|electric|coral|pink|yellow|lime|indigo|violet|purple|fuchsia|magenta|maroon|burgundy|mint|lavender|candy)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  // Asking for blue/green specifically still allows the quiet pool's matching
  // member via pickAccentPalette — treat as chromatic opt-in so vivid blues
  // from ACCENT_PALETTES can also be chosen when they named the hue.
  if (/\b(?:blue|teal|green|emerald|forest|ocean|navy|terracotta)\b/i.test(text)) {
    return true;
  }
  // Chromatic style systems the user explicitly named.
  if (
    /\b(?:playful|fun|kids?|cartoon|cute|friendly|candy|brutalist|warm|glassmorphic|glass\s+morphism|neumorph(?:ic|ism)?|bold\s+marketing|high[- ]?impact|cinematic|dramatic)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  // Bare "color(s)" / "palette" / "accent" without "neutral" → allow chroma.
  if (/\b(?:colou?rs?|palette|chromatic|use\s+(?:an?\s+)?accent)\b/i.test(text)) {
    return true;
  }
  return false;
}

/** Accent for this build — quiet earthy pool by default; vivid chroma when allowed. */
export function pickAccentPalette(userMessage, opts = {}) {
  const text = String(userMessage || '').toLowerCase();
  const allowColor = userAllowsColor(userMessage, opts);

  // Named quiet hues always map into the earthy pool (even if allowColor).
  if (/\bsage\b/.test(text)) {
    return NEUTRAL_ACCENT_PALETTES.find((p) => p.name === 'sage green') || NEUTRAL_ACCENT_PALETTES[2];
  }
  if (/\bbeige\b/.test(text)) {
    return NEUTRAL_ACCENT_PALETTES.find((p) => p.name === 'warm beige') || NEUTRAL_ACCENT_PALETTES[5];
  }
  if (/\b(?:walnut|clay)\b/.test(text) || (/\bbrown\b/.test(text) && !/\bbrownish\b/.test(text))) {
    const walnut = /\bwalnut\b/.test(text);
    return NEUTRAL_ACCENT_PALETTES.find((p) => p.name === (walnut ? 'walnut brown' : 'clay brown'))
      || NEUTRAL_ACCENT_PALETTES[6];
  }
  if (/\bdark\s+green\b/.test(text) || (/\bforest\b/.test(text) && !allowColor)) {
    return NEUTRAL_ACCENT_PALETTES.find((p) => p.name === 'dark green') || NEUTRAL_ACCENT_PALETTES[1];
  }
  if (/\bdark\s+blue\b/.test(text) || (/\bnavy\b/.test(text) && !/\bbright|vivid|neon\b/.test(text))) {
    return NEUTRAL_ACCENT_PALETTES.find((p) => p.name === 'dark blue') || NEUTRAL_ACCENT_PALETTES[3];
  }
  if (/\bslate\s+blue\b/.test(text)) {
    return NEUTRAL_ACCENT_PALETTES.find((p) => p.name === 'slate blue') || NEUTRAL_ACCENT_PALETTES[4];
  }
  // Plain "blue" / "green" without vivid cues → quiet pool, not candy ACCENT_PALETTES.
  if (!/\b(?:bright|vivid|neon|electric|candy|vibrant|colorful|colourful)\b/.test(text)) {
    if (/\bgreen\b/.test(text) && !/\bemerald|lime|mint\b/.test(text)) {
      return NEUTRAL_ACCENT_PALETTES.find((p) => p.name === 'sage green') || NEUTRAL_ACCENT_PALETTES[2];
    }
    if (/\bblue\b/.test(text) && !/\bsky|cyan|azure\b/.test(text)) {
      return NEUTRAL_ACCENT_PALETTES.find((p) => p.name === 'slate blue') || NEUTRAL_ACCENT_PALETTES[4];
    }
  }

  if (!allowColor) {
    return NEUTRAL_ACCENT_PALETTES[Math.floor(Math.random() * NEUTRAL_ACCENT_PALETTES.length)];
  }
  const colorful = ACCENT_PALETTES.filter((p) => p.name !== 'graphite mono');
  const pool = colorful.length ? colorful : ACCENT_PALETTES;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Briefs say "ACCENT" wherever the rotated palette's tokens apply — the
// concrete hex/classes are injected by formatDesignSystemBlock below.
export const DESIGN_SYSTEMS = {
  lykn: {
    name: 'LYKN Modern',
    keywords: /\b(?:lykn|default|modern|product|saas|clean\s+modern)\b/i,
    brief: [
      'THEME: confident modern product design — light, airy, precise. White surfaces, ONE accent color, soft depth.',
      'COLOR: primary = ACCENT primary (hover = ACCENT hover); tinted chips/sections = ACCENT tint + tint-text; surface #FFFFFF on page bg #F8FAFC (slate-50); text #0F172A (slate-900); muted text #64748B (slate-500); success #16A34A, warning #D97706, danger #DC2626. Favor the accent for CTAs and interaction signals; keep large areas neutral.',
      'TYPE: headings font-display (Space Grotesk) font-bold tracking-tight — hero text-4xl/5xl, section text-2xl/3xl; body font-sans (Inter) text-base leading-relaxed; supporting text-sm text-slate-500; code font-mono text-sm.',
      'SPACING: 8pt rhythm. Sections py-12/16, cards p-6/p-8, stacks space-y-6. max-w-5xl mx-auto page shells, max-w-prose for reading columns.',
      'COMPONENTS: cards rounded-2xl bg-white shadow-soft border border-slate-100; primary buttons rounded-xl solid ACCENT primary, text-white font-semibold px-5 py-2.5, hover ACCENT hover; secondary buttons border border-slate-200 text-slate-700; badges rounded-full ACCENT tint + tint-text text-xs font-medium px-2.5 py-1; inputs via Tailwind forms plugin with focus:ring-2 ACCENT ring.',
      'MOTION: framer-motion fade/slide entrances (150–250ms, easeOut), stagger lists by 0.05s; hover states on everything clickable.',
      'ANTI-PATTERNS: no rainbow palettes, no heavy default shadows (shadow-2xl), no cramped p-2 layouts, no browser-default typography.',
    ].join('\n'),
  },

  minimal: {
    name: 'Minimal',
    keywords: /\b(?:minimal(?:ist)?|simple|plain|clean|monochrome|quiet|understated)\b/i,
    brief: [
      'THEME: radical simplicity — near-monochrome, whitespace does the layout work, a single accent used sparingly.',
      'COLOR: text #111827; page + cards #FFFFFF; hairline borders #E5E7EB; muted #6B7280; ONE accent = ACCENT primary, reserved for links, active states, and the single primary action. Nothing else gets color.',
      'TYPE: everything font-sans (Inter). Headings font-semibold (not bold) with tracking-tight — h1 text-3xl, h2 text-xl; body text-[15px] leading-7; labels text-xs uppercase tracking-widest text-gray-400.',
      'SPACING: extremely generous — sections py-16/20, space-y-8 stacks, max-w-2xl reading measure. Separate concerns with whitespace first, 1px border-gray-200 rules second, never boxes-in-boxes.',
      'COMPONENTS: flat cards (border, rounded-lg, NO shadow); buttons rounded-lg border border-gray-900 text-gray-900 hover:bg-gray-900 hover:text-white, primary solid bg-gray-900 text-white; tables with border-b rows only.',
      'MOTION: almost none — opacity fades (150ms) at most. No bounces, no staggers.',
      'ANTI-PATTERNS: no gradients, no multiple accents, no shadows, no decorative icons, no filler copy.',
    ].join('\n'),
  },

  editorial: {
    name: 'Editorial',
    keywords: /\b(?:editorial|typeset|magazine|literary|long[- ]?form|print[- ]?style)\b/i,
    brief: [
      'THEME: a beautifully typeset document — reads like a serious publication, structured for study and print.',
      'COLOR: ink #1C1917 (stone-900) on paper #FFFFFF; muted #78716C (stone-500); accent = ACCENT primary for links, key terms, section numbers, and rules; highlight blocks = ACCENT tint with a border-l-4 in ACCENT primary.',
      'TYPE: title font-display text-4xl font-bold tracking-tight with a text-sm uppercase tracking-widest text-stone-400 kicker above; body inside `prose prose-stone max-w-none` (typography plugin) — it handles headings, lists, blockquotes; definitions/formulas in font-mono bg-stone-100 rounded px-1.5.',
      'SPACING: single reading column max-w-3xl mx-auto px-6 py-12; space-y-10 between numbered sections; generous 2rem paragraph rhythm via prose.',
      'COMPONENTS: numbered section headers ("01 — Introduction" pattern: mono accent number + display heading); key-takeaway cards bg-stone-50 rounded-xl p-6; footnote-style asides text-sm text-stone-500 border-t pt-4; clean bordered tables for data.',
      'MOTION: none beyond subtle scroll fade-ins. This is a document, not an app.',
      'ANTI-PATTERNS: no dashboard chrome, no bright buttons, no emojis, no second accent color, never full-width text lines.',
    ].join('\n'),
  },

  bold: {
    name: 'Bold Marketing',
    keywords: /\b(?:bold|dramatic|high[- ]?impact|striking|loud|cinematic|splash)\b/i,
    brief: [
      'THEME: high-energy launch page — oversized type, dark dramatic hero, one vivid SOLID accent, unmissable CTAs. Drama comes from scale, contrast, and motion — not gradients.',
      'COLOR: hero + footer on #0A0A0A with white text; body sections alternate white and #FAFAFA; ACCENT primary (solid) is used for hero headline highlight words (plain text color), CTA buttons, and stat numbers; supporting text zinc-400 on dark / zinc-600 on light.',
      'TYPE: hero font-display text-5xl md:text-7xl font-bold tracking-tighter leading-[1.05]; section headings text-3xl/4xl font-display; body Inter text-lg leading-relaxed; eyebrow labels text-sm font-semibold uppercase tracking-widest in ACCENT tint-text.',
      'SPACING: theatrical — hero min-h-[80vh] grid place-items-center, sections py-24, max-w-6xl mx-auto px-6; feature grids grid md:grid-cols-3 gap-8.',
      'COMPONENTS: primary CTA rounded-full px-8 py-4 text-lg font-semibold solid ACCENT primary, text-white, hover ACCENT hover + hover:scale-105 transition; glassy feature cards on dark (bg-white/5 backdrop-blur border border-white/10 rounded-2xl); social-proof strip of muted logos/stats; big footer CTA repeat.',
      'MOTION: framer-motion is the show — hero words stagger in, sections animate on scroll (whileInView), CTAs scale on hover, subtle floating elements.',
      'ANTI-PATTERNS: no gradients (hero, text, or buttons) unless the user asked for them, no timid gray buttons, no dense paragraphs in the hero, never skip the final CTA section.',
    ].join('\n'),
  },

  dashboard: {
    name: 'Dark Dashboard',
    keywords: /\b(?:dark\s+(?:mode|theme|dashboard)|terminal|dev\s+tool|ops|command\s+center|mission\s+control)\b/i,
    brief: [
      'THEME: focused dark ops surface — dense but readable, glowing accent data, everything scannable at a glance.',
      'COLOR: page #0F172A (slate-900), panels #1E293B (slate-800) with border-slate-700/60; text slate-100, secondary slate-400; accent = ACCENT primary for live values, active nav, and the main chart series; semantic greens/ambers/reds (emerald-400 / amber-400 / rose-400) for deltas and status dots.',
      'TYPE: headings font-display font-semibold text-lg/xl (dashboards stay compact); KPI numbers font-mono text-3xl font-bold in the accent; labels text-xs uppercase tracking-wider text-slate-500; body text-sm.',
      'SPACING: tight grid — p-6 page padding, gap-4/6 between panels, grid grid-cols-2 lg:grid-cols-4 for stat rows, panels p-5.',
      'COMPONENTS: stat cards (label, mono number, delta badge with arrow); rounded-xl panels; Recharts with slate-700 grid lines, accent + emerald series, dark tooltips (contentStyle background #1E293B, no white flashes); slim sidebar or top tab nav with an active accent indicator; status dots (h-2 w-2 rounded-full bg-emerald-400).',
      'MOTION: minimal and functional — number count-ups, 150ms panel fades, pulsing dot for "live". No decorative animation.',
      'ANTI-PATTERNS: no pure-black #000 backgrounds, no white chart tooltips, no rainbow chart palettes (max 3 series colors), no oversized hero sections.',
    ].join('\n'),
  },

  glass: {
    name: 'Glassmorphic',
    keywords: /\b(?:glassmorph\w*|glassy?|frosted|translucent|aurora|acrylic|vision\s?os|blurred?\s+panels?)\b/i,
    brief: [
      'THEME: layered frosted glass — translucent panels floating over a deep colored backdrop, depth from blur and light instead of borders and shadows. Premium, atmospheric, modern.',
      'BACKDROP: a deep SOLID base (near-black slate #0B1120, or a very dark shade of the ACCENT family) with at most TWO large, ultra-soft ACCENT-tinted light fields (blurred absolutely-positioned rounded shapes at 15-25% opacity, blur-3xl, placed off-center/off-edge) so the glass has something to refract. This backdrop treatment is allowed HERE as the defining ingredient of the style — everything ON the glass stays solid.',
      'COLOR: panel glass = bg-white/10 backdrop-blur-xl border border-white/15; elevated glass = bg-white/15; text white, secondary white/60; ACCENT primary (solid) for CTAs, active states, and key numbers; semantic colors at full strength on glass chips.',
      'TYPE: font-sans (Inter) everywhere; hero/headings font-semibold to font-bold tracking-tight — hierarchy from size and the glass layering, not from fancy faces; numbers font-mono where data appears.',
      'SPACING: airy — panels p-6/p-8 rounded-2xl/rounded-3xl, gap-6 grids, page px-6 py-16, max-w-6xl shells. Glass needs breathing room: never tile panels edge-to-edge.',
      'COMPONENTS: glass cards as above with a subtle inner top highlight (border-t border-white/20); primary buttons SOLID ACCENT primary rounded-xl text-white (solid buttons pop against glass — never glass-on-glass CTAs); secondary buttons bg-white/10 border-white/20; inputs bg-white/10 border-white/15 placeholder-white/40 focus:ring-2 ACCENT ring; nav as a floating glass bar (rounded-2xl, mx-auto, mt-4).',
      'MOTION: slow and floaty — framer-motion fades with slight y-drift (0.5s easeOut), panels lift on hover (hover:bg-white/15, subtle translate), light fields can drift very slowly. Nothing snappy or bouncy.',
      'ANTI-PATTERNS: no purple light fields (use the build ACCENT), no more than two backdrop glows, no glass text (text stays fully opaque), no thin gray-on-glass low-contrast copy, no heavy borders.',
    ].join('\n'),
  },

  neumorph: {
    name: 'Neumorphic',
    keywords: /\b(?:neumorph\w*|neomorph\w*|soft\s*ui|claymorph\w*|soft\s+3d|extruded|embossed)\b/i,
    brief: [
      'THEME: soft extruded UI — every control looks pressed out of (or into) one continuous material. Calm, tactile, monochromatic. Best for tools, players, calculators, smart-home style apps.',
      'COLOR: ONE surface color for page AND controls — #E3E8F0 (cool) or #EDEAE4 (warm), optionally tinted faintly toward the ACCENT family; text #3D4351, secondary #8A91A3; ACCENT primary is used SPARINGLY — icon fills, active toggle tracks, progress arcs, one key number — never large painted areas (color breaks the material illusion).',
      'DEPTH (the entire design language): raised elements get the dual shadow shadow-[6px_6px_12px_rgba(163,177,198,.6),-6px_-6px_12px_rgba(255,255,255,.9)]; pressed/active/input states get the inset version shadow-[inset_4px_4px_8px_rgba(163,177,198,.6),inset_-4px_-4px_8px_rgba(255,255,255,.9)]; NO borders anywhere, NO flat drop shadows. Define both as THEME tokens and reuse.',
      'TYPE: font-sans (Inter) only — font-semibold headings, font-medium labels, font-mono for big readouts (timers, values). Hierarchy from size/weight; the shadows are the decoration.',
      'SPACING: generous — controls min p-4, cards p-6/p-8 rounded-3xl, gap-6; layouts stay simple and centered, max-w-md/max-w-2xl. Neumorphism dies when cramped.',
      'COMPONENTS: buttons = raised rounded-2xl surface-colored, active:inset (the press IS the feedback); toggles/sliders with inset tracks and raised thumbs; inputs inset rounded-xl; circular dials/knobs (raised ring, accent arc via SVG) for the hero control; icon buttons as raised circles.',
      'MOTION: minimal — the raised→inset shadow swap on press (transition-shadow 150ms) carries interaction; small scale on tap (active:scale-[.98]). No entrance theatrics.',
      'ANTI-PATTERNS: this style is LOW-CONTRAST BY NATURE, so text must stay dark and generously sized (no light-gray small copy); no mixing with flat cards or bordered panels; not for long documents or dense dashboards; never put the dual shadow on tiny elements (chips, badges).',
    ].join('\n'),
  },

  brutalist: {
    name: 'Neo-Brutalist',
    keywords: /\b(?:neo[- ]?brutal\w*|brutal\w*|raw|punk|zine|indie|memphis|sticker|bold\s+retro)\b/i,
    brief: [
      'THEME: loud, raw, confident — thick black borders, hard offset shadows, flat fearless color. Looks hand-built on purpose; zero corporate polish.',
      'COLOR: paper #FFFDF5 or a bold flat page color from the ACCENT family; ink #000; ACCENT primary as FLAT fills for buttons/highlights/section bands, plus ONE clashing secondary (e.g. accent + yellow #FFD702 or accent + pink #FF90E8); no tints, no transparency.',
      'TYPE: the system sans pushed hard — font-black uppercase headings with tracking-tight (text-5xl/7xl), body font-medium text-base; labels/stamps font-mono uppercase text-xs tracking-widest. No decorative faces — weight and scale do the shouting.',
      'DEPTH: border-2 (small) / border-4 (cards, buttons) border-black everywhere + hard shadows shadow-[4px_4px_0_#000] (8px for heroes); hover = translate-x-[2px] translate-y-[2px] with shadow shrinking to 2px (the press). Corners square or rounded-lg max — never pill cards.',
      'SPACING: structured chaos — strong grid with p-6/p-8 cards and gap-6, then ONE or TWO deliberate rule-breaks (a rotated sticker badge -rotate-2, an element crossing a section boundary).',
      'COMPONENTS: buttons flat ACCENT fill, black border-2, hard shadow, font-bold uppercase; cards white with border-4 + hard shadow; marquee strips (border-y-4 border-black py-2 font-mono uppercase); tables with visible black borders; badges as rotated stamps.',
      'MOTION: snappy and physical — the shadow-press on click, quick 150ms hovers, marquee scroll if it fits. No fades, no floaty easing.',
      'ANTI-PATTERNS: no soft/blurred shadows, no gradients, no thin gray text, no rounded-3xl, no subtlety — if an element looks tentative, make it louder or cut it.',
    ].join('\n'),
  },

  warm: {
    name: 'Warm Organic',
    keywords: /\b(?:warm|organic|earthy|cozy|natural|calm(?:ing)?|wellness|mindful|spa|yoga|handmade|artisan|craft|coffee|bakery|garden|journal)\b/i,
    brief: [
      'THEME: warm, human, unhurried — cream paper, earthy color, soft edges. Feels like a well-made physical object, not software.',
      'COLOR: page #FAF6F0, cards #FFFFFF or #F5EFE6; ink #292524 (stone-800), muted #78716C; ACCENT drawn warm — if the rotated accent is cold, shift to its warmest neighbor (terracotta #C2410C, moss #4D7C0F, clay #B45309, dusty rose #9F1239) for buttons, links, and small painted moments; deep green #1C3D2E or warm charcoal for dark bands.',
      'TYPE: font-sans (Inter) with RELAXED settings — headings font-semibold (never black) tracking-normal text-3xl/4xl, body text-[15px]/base leading-loose, labels lowercase or normal-case (no shouting uppercase); font-display only for one hero line if the build has a hero.',
      'SPACING: very generous — sections py-16/20, cards p-8, space-y-8; asymmetric compositions welcome (offset images, staggered columns); max-w-5xl shells, max-w-prose reading.',
      'COMPONENTS: cards rounded-2xl with border border-stone-200/60 and shadow-sm at most; buttons rounded-full px-6 py-3 in the warm accent, text-white, hover darkens; quiet dividers (border-stone-200); organic touches — one large rounded-[40%] color blob behind a hero element, arched image frames (rounded-t-full), hand-drawn-feel SVG underlines under key words.',
      'MOTION: gentle — slow fades (0.5s), no springs, no staggered showmanship. Stillness is part of the style.',
      'ANTI-PATTERNS: no pure white #FFF page background, no cold grays (use stone/warm neutrals), no neon or saturated tech colors, no hard shadows, no dense grids — if it feels busy, remove something.',
    ].join('\n'),
  },

  playful: {
    name: 'Playful',
    keywords: /\b(?:playful|fun|kids?|colorful|cartoon|cute|friendly|classroom|children|teens?)\b/i,
    brief: [
      'THEME: friendly and energetic — chunky rounded shapes, candy colors, celebratory feedback. Fun but never chaotic.',
      'COLOR: cream page #FFFBEB (amber-50); white cards; primary action color = ACCENT primary used CONSISTENTLY for buttons and selections; #F59E0B (amber-500) for scores/stars/streaks; #10B981 (emerald-500) for correct/success; #F43F5E (rose-500) for wrong answers only; text #1F2937.',
      'TYPE: headings font-display font-bold text-3xl/4xl; body Inter text-base/lg; big friendly numbers font-display text-5xl; button labels font-bold.',
      'SPACING: roomy tap targets — cards p-6, buttons px-8 py-4, gap-4 grids; content max-w-3xl mx-auto.',
      'COMPONENTS: cards rounded-3xl bg-white border-4 in the ACCENT tint, shadow-soft; chunky buttons rounded-2xl solid ACCENT primary, text-white text-lg font-bold, with a darker bottom border (border-b-4 in ACCENT hover) and active:border-b-0 active:translate-y-1 (pressable look); progress bars rounded-full bg-amber-400; answer options as big selectable cards with hover:scale-[1.02]; score chips rounded-full.',
      'MOTION: springy framer-motion (type:"spring") pops for selections and results; confetti() on wins/completion; animate.css bounceIn for reveals; wrong answers shake gently.',
      'ANTI-PATTERNS: no corporate grays, no tiny text or tight targets, no harsh reds for anything except wrong answers, no motion so busy it distracts from the content.',
    ].join('\n'),
  },
};

const DEFAULT_SYSTEM_ID = 'lykn';

// Priority when multiple STYLE keyword sets match: the most specific wins.
// (e.g. "fun glassmorphic quiz" should be glass, not playful.)
const MATCH_PRIORITY = ['glass', 'neumorph', 'brutalist', 'playful', 'dashboard', 'editorial', 'warm', 'bold', 'minimal', 'lykn'];

// FORMAT words ("dashboard", "website", "report") deliberately do NOT pin a
// system — that's how every dashboard used to come out as the same dark
// slate panel grid. Instead each format rotates a weighted pool of systems
// that suit it, so two "make me a dashboard" asks produce genuinely
// different-looking builds. Only explicit STYLE words (the system keyword
// regexes above) pin a specific look.
const FORMAT_POOLS = [
  {
    re: /\b(?:dashboards?|analytics|admin\s+panel|metrics|kpis?|monitor(?:ing)?|console|stats?\s+(?:page|panel|view)|tracker)\b/i,
    pool: ['dashboard', 'dashboard', 'lykn', 'minimal', 'glass'],
  },
  {
    re: /\b(?:websites?|web\s?site|landing\s?page|home\s?page|marketing|promo|launch|startup|sales?\s+page|brand|portfolio|storefront)\b/i,
    pool: ['bold', 'bold', 'lykn', 'warm', 'minimal', 'glass', 'brutalist'],
  },
  {
    re: /\b(?:document|report|essay|article|study\s+guide|paper|whitepaper|research|worksheets?|notes|handout|cheat\s?sheet)\b/i,
    pool: ['editorial', 'editorial', 'minimal', 'warm'],
  },
  {
    re: /\b(?:games?|quiz(?:zes)?|flashcards?|trivia)\b/i,
    pool: ['playful', 'playful', 'brutalist', 'lykn'],
  },
  {
    re: /\b(?:presentation|slide\s?deck|slides?|pitch\s?deck|keynote)\b/i,
    pool: ['bold', 'minimal', 'editorial', 'lykn'],
  },
];

// When the request names NO style and NO known format, rotate through this
// pool instead of always serving one house look — half the anti-slop battle
// is two generic asks not coming back with the same design twice. Weighted
// toward the broadly-safe systems; neumorph is excluded (too specialized —
 // control-panel UIs only) and brutalist appears once (loud enough that it
 // should mostly be opt-in).
const DEFAULT_ROTATION = ['lykn', 'lykn', 'minimal', 'glass', 'glass', 'warm', 'brutalist'];
 // Neutral-only builds stay on quiet systems so the palette isn't fighting
 // a candy/brutal brief.
const NEUTRAL_DEFAULT_ROTATION = ['minimal', 'minimal', 'lykn', 'lykn', 'editorial'];

const NEUTRAL_FORMAT_POOLS = [
  {
    re: /\b(?:dashboards?|analytics|admin\s+panel|metrics|kpis?|monitor(?:ing)?|console|stats?\s+(?:page|panel|view)|tracker)\b/i,
    pool: ['dashboard', 'dashboard', 'minimal', 'lykn'],
  },
  {
    re: /\b(?:websites?|web\s?site|landing\s?page|home\s?page|marketing|promo|launch|startup|sales?\s+page|brand|portfolio|storefront)\b/i,
    pool: ['minimal', 'lykn', 'lykn', 'editorial', 'bold'],
  },
  {
    re: /\b(?:document|report|essay|article|study\s+guide|paper|whitepaper|research|worksheets?|notes|handout|cheat\s?sheet)\b/i,
    pool: ['editorial', 'editorial', 'minimal', 'lykn'],
  },
  {
    re: /\b(?:games?|quiz(?:zes)?|flashcards?|trivia)\b/i,
    pool: ['minimal', 'lykn', 'lykn', 'brutalist'],
  },
  {
    re: /\b(?:presentation|slide\s?deck|slides?|pitch\s?deck|keynote)\b/i,
    pool: ['minimal', 'editorial', 'lykn', 'bold'],
  },
];

const rollFrom = (pool) => pool[Math.floor(Math.random() * pool.length)];

/**
 * Pick a design system id from the user's request wording.
 * Explicit STYLE words pin a system; FORMAT words rotate a fitting pool;
 * anything else rotates the default pool — so no request shape maps to
 * one fixed look. When color is not allowed, prefer quiet/neutral pools.
 */
export function pickDesignSystem(userMessage, opts = {}) {
  const text = String(userMessage || '');
  const allowColor = userAllowsColor(text, opts);
  if (!text.trim()) return allowColor ? DEFAULT_SYSTEM_ID : 'minimal';
  for (const id of MATCH_PRIORITY) {
    if (DESIGN_SYSTEMS[id].keywords.test(text)) return id;
  }
  const formatPools = allowColor ? FORMAT_POOLS : NEUTRAL_FORMAT_POOLS;
  for (const f of formatPools) {
    if (f.re.test(text)) return rollFrom(f.pool);
  }
  return rollFrom(allowColor ? DEFAULT_ROTATION : NEUTRAL_DEFAULT_ROTATION);
}

/**
 * Format the [DESIGN_SYSTEM] prompt block for a coded-artifact turn: the
 * chosen brief, this build's ACCENT tokens (neutral by default), a
 * complexity-scaling rule, and a one-line catalog so the model can switch
 * systems when the user asks for a different look mid-conversation.
 *
 * Signature: formatDesignSystemBlock(systemId, accentOrOpts?, opts?)
 * — accent may be passed explicitly (tests / callers); otherwise it is
 *   picked from the user message + opts (hasReferenceImages, userMessage).
 */
export function formatDesignSystemBlock(systemId, accentOrOpts, maybeOpts) {
  const accentIsPalette =
    accentOrOpts &&
    typeof accentOrOpts === 'object' &&
    typeof accentOrOpts.primary === 'string' &&
    typeof accentOrOpts.name === 'string';
  const opts = accentIsPalette
    ? maybeOpts || {}
    : accentOrOpts && typeof accentOrOpts === 'object'
      ? accentOrOpts
      : maybeOpts || {};
  const userMessage = String(opts.userMessage || '');
  const allowColor = userAllowsColor(userMessage, opts);
  const accent = accentIsPalette
    ? accentOrOpts
    : pickAccentPalette(userMessage, opts);

  const id = DESIGN_SYSTEMS[systemId] ? systemId : DEFAULT_SYSTEM_ID;
  const sys = DESIGN_SYSTEMS[id];
  const catalog = Object.entries(DESIGN_SYSTEMS)
    .map(([key, s]) => (key === id ? `${s.name} (ACTIVE)` : s.name))
    .join(', ');

  const accentRule = allowColor
    ? `ACCENT for this build (every "ACCENT" reference above): ${accent.name} — primary ${accent.primary}, hover ${accent.hover}, tint ${accent.tint}, tint-text ${accent.tintText}, ring ${accent.ring}. ` +
      `If the subject clearly calls for a different color (a brand's real color, nature → greens, finance → blues), you may swap to a fitting NON-purple palette. ` +
      `NEVER use purple/violet/indigo/fuchsia as the accent unless the user explicitly asks for purple — reverting to purple is the #1 styling failure.`
    : `QUIET EARTHY-NEUTRAL palette for this build (default Build rule). Base = black / white / zinc-slate-stone grays, plus muted dark green, sage green, dark blue, slate blue, beige, and brown. ` +
      `ACCENT for this build: ${accent.name} — primary ${accent.primary}, hover ${accent.hover}, tint ${accent.tint}, tint-text ${accent.tintText}, ring ${accent.ring}. ` +
      `Use that accent sparingly for CTAs, links, focus rings, and key numbers. Keep large surfaces beige/cream/white/gray or a faint tint of the accent. ` +
      `BANNED unless the user asks or attaches a reference: bright orange, rose/pink, electric cyan, candy emerald, neon, rainbow, purple/violet/indigo. ` +
      `Semantic green/amber/red ONLY for true status states. Do NOT invent a loud "pop" accent outside this quiet set.`;

  const gradientRule = allowColor
    ? `GRADIENTS: do NOT use gradients — no bg-gradient-*, no gradient text (bg-clip-text), no gradient buttons. Solid accent + tints + neutrals carry the design. ` +
      `The ONLY exception is the user explicitly asking for a gradient; then use one tasteful family (${accent.gradient}) and nothing else.`
    : `GRADIENTS: banned this turn. No bg-gradient-*, no gradient text, no gradient buttons — solid quiet neutrals / earthy tones only.`;

  return [
    `[DESIGN_SYSTEM — "${sys.name}". When you build or edit a React artifact this turn, follow this brief EXACTLY — tokens, type scale, spacing, and component recipes. It overrides your own styling instincts:`,
    sys.brief,
    accentRule,
    gradientRule,
    `FONTS: keep typography SIMPLE — the plain sans (Inter) carries almost everything, with hierarchy built from size, weight, and spacing, not from typeface variety. ` +
      `font-display (Space Grotesk) is allowed only for large display headings where the active system says so; font-mono only for numbers/code/labels. ` +
      `Never simulate decorative/script/novelty type unless the user explicitly asks for expressive typography.`,
    `NEVER-DO LIST — the "vibe-coded" fingerprint. These patterns instantly mark a build as generic AI output; audits of AI-built sites show most share them. Each is BANNED unless the user explicitly asks or the active system explicitly says otherwise:`,
    [
      '  ✕ purple/indigo/violet accents or purple-to-blue gradients (the #1 tell)',
      '  ✕ inventing a loud candy accent (orange, rose, cyan, neon) when the user did not ask for vivid color and did not attach a reference',
      '  ✕ a pill badge floating above the hero headline ("✨ Introducing …", "New")',
      '  ✕ the centered-hero + exactly-three-rounded-icon-cards landing template',
      '  ✕ numbered 1-2-3 "How it works" step cards',
      '  ✕ cards with a colored left border as the accent treatment',
      '  ✕ decorative glassmorphism — random backdrop-blur panels and glow orbs sprinkled on (glass is ONLY the Glassmorphic system, used as a complete language)',
      '  ✕ dark mode with neon glow effects that serve no function',
      '  ✕ emojis as icons, bullets, or in headings/buttons (use lucide icons or nothing)',
      '  ✕ gradient text via bg-clip-text',
      '  ✕ the same rounded-xl + faint shadow on literally every element (vary elevation deliberately: some things flat, one thing prominent)',
      '  ✕ AI-brochure copy: "Streamline your workflow", "Supercharge", "Unlock the power of", "Effortlessly" — write specific, concrete copy instead',
      '  ✕ rainbow palettes / more than accent + one secondary + neutrals + semantics',
    ].join('\n'),
    `UX BAR (non-negotiable regardless of system):`,
    [
      '  • HIERARCHY: one clearly dominant element per screen/section — if everything is bold, nothing is. Size/contrast/position must make the eye path obvious.',
      '  • CONTRAST: body text always comfortably readable on its background (dark-on-light or white-on-dark; never light-gray-on-white or thin text on glass/images).',
      '  • AFFORDANCE: interactive things must look interactive (and non-interactive things must not); every control has visible hover, focus-visible, active, and disabled states.',
      '  • FEEDBACK: every action produces an immediate visible response — state change, movement, or message. No silent buttons.',
      '  • TOUCH & REACH: comfortable target sizes (≥40px), inputs with real labels (not placeholder-only), primary actions where thumbs/eyes land first.',
      '  • FORGIVENESS: destructive or irreversible actions need confirmation or undo; validation is inline and specific, never an alert().',
      '  • CONSISTENCY: the same element behaves and looks the same everywhere it appears; spacing stays on one scale (4/8pt).',
    ].join('\n'),
    `COMPLEXITY: match the build to the ask, across the full range. A quick utility (timer, converter, single form) = ONE focused screen, few elements, lots of whitespace — simple but still styled. A website/presentation/report = full multi-section treatment (nav, hero, content sections, footer / titled slides). An app/game/dashboard = multi-view with working navigation, state, and empty/finished states. Never pad a simple request with filler sections, and never flatten a big request into one thin screen.`,
    `CRAFT (how professional design tools make AI output look designed — follow all five):`,
    `1. TOKENS FIRST: start the component with a const THEME object holding this build's design tokens (accent colors, neutral scale, radii, spacing units) and bind EVERY color/radius through it or the system's named classes — never scatter one-off hex values or random Tailwind shades through the markup. One source of truth per artifact.`,
    `2. COMPONENTIZE REPETITION: anything that appears more than once (buttons, cards, list rows, section headings, nav links, stat blocks) must be a small internal component or a .map() over data — never copy-pasted markup with drifting classes. Content belongs in data arrays (const SECTIONS/FEATURES/QUESTIONS = [...]) rendered through those components.`,
    `3. STRUCTURE BEFORE STYLE: decide the section/screen outline first (what sections, in what order, what each must communicate), then apply the design system to that skeleton. Layout hierarchy carries the design; decoration comes last.`,
    `4. RESPONSIVE ALWAYS: mobile-first Tailwind — base classes for ~375px, then sm:/md:/lg: to scale type (text-3xl md:text-5xl), grids (grid-cols-1 md:grid-cols-3), and padding. It must look intentional at phone, tablet, and desktop widths, not just desktop.`,
    `5. SELF-AUDIT BEFORE RETURNING: scan your finished code like a design review — every spacing value on the same scale, text contrast readable on its background (no light-gray-on-white body copy), repeated elements rendered from one component, headings aligned to one grid, no stray colors outside the palette, interactive elements have hover/focus/disabled states.`,
    `Available systems: ${catalog}. If the user explicitly asks for a different look (e.g. "make it playful", "dark dashboard style"), switch to that system and restyle consistently. When EDITING an existing artifact, keep its existing system AND accent color unless the user asks to restyle.]`,
  ].join('\n');
}
