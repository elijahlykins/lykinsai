# Presentation / Slide Deck Guide

How to build a slide-deck artifact as a React component (when the user wants a
live deck rather than a PPTX download — PPTX goes through lykn_build_template
instead). Colors and type come from the [DESIGN_SYSTEM] brief — this guide
covers slide structure and deck mechanics.

## Deck mechanics (non-negotiable)

- Slides are an array of data (`const SLIDES = [...]`) rendered through one slide component — never 10 copy-pasted slide blocks.
- Full-viewport stage: each slide fills the frame (`h-screen w-full grid place-items-center`), content inside `max-w-4xl px-12`.
- Navigation MUST work three ways: ← → arrow keys (useEffect keydown listener), on-screen prev/next buttons (chevron icons, bottom corners), and clickable progress dots.
- Progress indicator: dots or `3 / 12` counter, bottom-center. Current dot in the accent.
- Slide transitions: framer-motion `AnimatePresence` horizontal slide+fade (~300ms). Direction follows navigation direction.

## Slide anatomy

1. **Title slide** — deck title huge (font-display, text-5xl/6xl), one-line subtitle, author/date small at the bottom. Visually distinct (dark band or accent treatment).
2. **Agenda/overview** (decks ≥ 6 slides) — 3–5 numbered items, not a wall of text.
3. **Content slides** — ONE idea per slide: a headline stating the point ("Retention doubles after week 2", never just "Retention") + at most 3–4 support bullets OR one visual (chart, stat row, diagram) + caption. If a slide needs 6 bullets, split it.
4. **Section dividers** (for multi-part decks) — number + section title on a contrasting background, nothing else.
5. **Data slides** — one Recharts chart per slide, big (h-72+), with the takeaway as the headline above it.
6. **Closing slide** — summary of 2–3 key points or a call to action; never end on a content slide.

## Slide design rules

- Presentation type runs BIGGER than web type: headlines text-4xl/5xl, bullets text-xl/2xl, captions text-base. If it wouldn't be readable projected across a room, it's too small.
- Bullets are fragments, max ~8 words, no periods, parallel grammar. Bold the 1–2 keywords per bullet.
- Generous slide padding — content floats in the frame with clear margins, never edge-to-edge text.
- Consistent furniture: slide number bottom-right, deck title or logo top-left at low opacity, identical across content slides.
- Alternate layouts (centered / two-column / big-stat / chart) so consecutive slides don't look stamped — but from the same component with a `layout` field, not new markup per slide.
- No emojis. Icons from lucide when a bullet needs a marker.

## Content rules

- Write the deck's actual content from the request/context — real arguments, real numbers (plausible when invented), specific examples. A 10-slide ask means 10 finished slides.
- Big-stat slides: one number at text-7xl+ with a one-line explanation — the strongest slide pattern; use it 1–2 times per deck.

## Quality bar (self-check before returning)

- Arrow keys, buttons, and dots all navigate; can't navigate past either end (or wraps intentionally).
- Every slide readable at a glance — no paragraph slides.
- Title and closing slides present; slide numbers correct.
- One accent family and one type scale across all slides.
