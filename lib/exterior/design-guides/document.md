# Document / Report / Worksheet Guide

How to build reading-first artifacts: reports, study guides, worksheets,
articles, briefs, documentation, cheat sheets. Colors and type come from the
[DESIGN_SYSTEM] brief (documents usually pair with the Editorial system) —
this guide covers document structure and typographic craft.

## Document skeleton

1. **Masthead** — kicker line (uppercase, tracking-widest, accent, text-sm: "STUDY GUIDE", "Q3 REPORT"), then the title (font-display, text-4xl), then a one-sentence standfirst (muted, text-lg), then a meta row (date · author · reading time) separated by a hairline rule.
2. **TL;DR / Key takeaways** (reports & guides) — a tinted callout card near the top with 3–5 bullet takeaways. Busy readers stop here; make it complete.
3. **Table of contents** (documents ≥ 5 sections) — numbered list of section links (anchor `href="#id"` to real section ids).
4. **Numbered sections** — the open-design pattern: mono accent number + heading ("01 — Fundamentals"). Consistent `space-y-10`+ rhythm between sections.
5. **Closing element** — summary, glossary, further-reading list, or answer key (worksheets). Documents don't just stop.

## Typography (the entire design)

- Single reading column `max-w-3xl mx-auto px-6 py-12`. NEVER full-width paragraphs.
- Body copy inside `prose prose-stone max-w-none` (typography plugin) so paragraphs, lists, and blockquotes are typeset properly; override headings with font-display where needed.
- Line length is sacred: if a paragraph exceeds ~75 characters per line, the column is too wide.
- Definitions, formulas, key terms: `font-mono` on a soft chip (`bg-stone-100 rounded px-1.5`) or a bordered definition card.
- Blockquotes: border-l-4 in the accent, italic, attribution on its own line.

## Content blocks to use (pick what the document needs)

- **Callout cards** — tinted background + icon for notes/warnings/tips; one accent family, semantic amber/red reserved for true warnings.
- **Tables** — bordered rows only (border-b), header row uppercase text-xs, numbers right-aligned mono. For data comparison, not layout.
- **Worksheet exercises** — numbered question cards with real answer space: bordered input areas, checkbox lists, or blank ruled lines (border-b spans). Include an answer key section at the end (visually separated or behind a toggle).
- **Figures** — Recharts or styled-div diagrams with numbered captions ("Fig. 2 — Retention by cohort", text-sm muted, centered).
- **Checklists** — square-checkbox rows (functional checkboxes if the doc is interactive).

## Content rules

- Write the full document — real explanations, worked examples, correct answers. A "study guide on photosynthesis" contains actual photosynthesis content, complete.
- Structure over prose walls: 2–4 sentence paragraphs, subheadings every 3–5 paragraphs, lists whenever items are enumerable.
- No emojis. No decorative icons scattered through body text.

## Print / export

- Keep it print-friendly: white background, dark text, no hover-dependent content. If an export button fits, `window.print()` is enough (print styles hide nav/buttons via `print:hidden`).

## Quality bar (self-check before returning)

- TOC links jump to real anchors; section numbers sequential.
- Reading column consistent; nothing stretches full-width except section rules.
- Worksheets have usable answer space and an answer key.
- Hierarchy visible at arm's length: title → sections → subsections all distinct.
