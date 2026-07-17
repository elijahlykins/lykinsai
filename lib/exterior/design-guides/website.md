# Website / Landing Page Guide

How to structure and style a full website or landing page artifact. Colors,
type scale, and component recipes come from the [DESIGN_SYSTEM] brief — this
guide covers structure, composition, and craft for the WEBSITE format.

## Structure (in order — skip a section only if it truly doesn't apply)

1. **Nav bar** — sticky, slim (h-16), logo/wordmark left, 3–5 anchor links center/right, one CTA button. Mobile: hamburger toggling a full-width menu (must actually work with state).
2. **Hero** — the make-or-break section. min-h-[70–90vh], one clear headline (6–12 words, largest type on the page), one supporting sentence, primary + secondary CTA, and ONE visual anchor: a product mock (built from styled divs), a stat row, or an abstract shape composition — never an empty half. VARY the layout per build: split hero (text left, visual right), left-aligned with the visual bleeding off-edge, or full-bleed dark band — don't default to the centered-text hero every time, and no pill badge floating above the headline.
3. **Social proof strip** (when it fits the subject) — muted logos/names or a stat row (`4.9★ · 12k users · 99.9% uptime`).
4. **Features** — vary the presentation per build: a bento grid (one large cell + several small), alternating icon-left rows, a 2×2 grid with real mini-visuals, or a capability table. Do NOT default to the identical row of three rounded icon-cards — it's the most recognizable AI template on the web. Card copy stays short: 3–5 word title, 1–2 line description.
5. **Deep-dive sections** — 1–3 alternating two-column blocks (text left / visual right, then flipped). Each sells ONE idea with a heading, 2–3 sentences, and a bullet or mini-visual.
6. **Testimonials / use cases** (when it fits) — 2–3 quote cards with name + role. Invent plausible ones; keep quotes to 1–2 sentences.
7. **Pricing** (only if the subject implies it) — 2–3 tier cards, middle tier visually emphasized (ring in the accent + "Popular" badge).
8. **Final CTA** — full-width band restating the core promise with one big button. Never end a landing page on a content section.
9. **Footer** — dark or muted: wordmark, link columns, copyright line.

## Composition rules

- Page shell: sections are full-width bands; inner content `max-w-6xl mx-auto px-6`. Alternate band backgrounds (white / soft neutral / one dark band) so the page has rhythm when scrolling.
- Section padding `py-20 md:py-24`; heading → body gap `space-y-4`; grid gaps `gap-8`.
- Every section opens with the same header pattern: optional eyebrow label (accent, uppercase, tracking-widest, text-sm) → heading (font-display) → one-sentence subheading (muted). Center-align header, left-align card content.
- Visuals: prefer BUILT visuals — product mocks from nested rounded divs, browser-chrome frames (three dots + URL bar), styled stat blocks, Recharts sparklines, lucide icons on tinted circles. Real photos are allowed from the approved services only (seeded picsum for photography, pravatar/dicebear for people) and from [USER_IMAGES]/generated-image URLs when provided — the user's own images always beat stock. Never invent other image URLs.

## Content rules

- Write real copy for the actual subject — never lorem ipsum, never `[placeholder]`.
- Headlines state a benefit, not a category ("Ship your ideas the day you have them", not "A Productivity Tool").
- Numbers beat adjectives: "2× faster onboarding" over "blazing fast".
- No emojis anywhere on a website artifact.

## Motion

- framer-motion `whileInView` fade+rise (12–24px, 0.4–0.6s, easeOut, `viewport={{ once: true }}`) on section entry; stagger card grids by 0.05–0.1s.
- Hero entrance animates on load. CTAs get hover scale (1.02–1.05) + color shift. Nothing else moves.

## Responsive

- Mobile-first: single column stacks, `text-4xl` heroes scaling to `md:text-6xl`/`lg:text-7xl`, grids `grid-cols-1 md:grid-cols-3`, nav collapses to the working hamburger.
- Two-column deep-dives stack visual-below-text on mobile.

## Quality bar (self-check before returning)

- Nav links scroll to real section ids. Mobile menu opens/closes.
- No section is a stub — every one has finished copy and complete styling.
- One accent color family (from the design system) across every CTA/link/icon; no stray colors.
- Page ends CTA → footer.
