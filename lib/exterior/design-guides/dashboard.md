# Dashboard / Analytics Guide

Craft rules for dashboards, admin panels, metrics views, and trackers.
Colors and surface tone come from the [DESIGN_SYSTEM] brief (dashboards can
be dark, light, minimal, or glass — don't assume dark slate). The overall
arrangement comes from the STRUCTURE ROLL in this block — this guide is
about getting whatever arrangement you're given RIGHT, not about one layout.

## Building blocks (compose per the structure roll — not all are required)

- **Header/status strip** — title + context (date range, environment) and at most 1–2 working controls (filter select, refresh). Slim, never a hero section.
- **KPIs** — tiny uppercase label, big mono number, delta (▲/▼ + % in semantic green/red). Present them however the roll says (cards, bare numbers, rail, embedded) — the anatomy stays the same.
- **Hero data view** — exactly ONE dominant visual per dashboard, styled fully, with a title and a one-line takeaway ("Revenue up 12% this quarter"). Everything else is visually subordinate to it.
- **Supporting panels** — 2–4 smaller panels with intentional grid spans (not equal boxes): secondary chart, top-N list, activity feed, status grid, progress bars.
- **Table** (optional) — bordered rows only (no vertical rules), mono numbers right-aligned, status pills, max ~8 visible rows.

## Chart craft (Recharts)

- One HERO chart styled fully; other charts simpler. Max 3 series per chart.
- Grid lines subtle (`strokeDasharray="3 3"`, low-contrast stroke); axes small text, no axis lines (`axisLine={false} tickLine={false}`).
- Tooltips must match the theme — set `contentStyle` background/border explicitly (dark panels need dark tooltips; white flashes are the #1 dashboard bug; light panels want a white tooltip with a real border).
- Area charts get a subtle fill (`fillOpacity` 0.1–0.2) under the line.
- Always wrap in `ResponsiveContainer` with a fixed height (h-64/h-72); never fixed pixel widths.
- Series colors: accent for the primary, emerald/amber for comparisons, semantic red only for negative metrics.

## Data design

- Generate realistic mock data with shape: trends, a dip or spike worth noticing, plausible names/amounts — not `[100, 200, 300]`. 12–30 points per series.
- Numbers formatted like an analyst: thousands separators, `$`/`%` units, 1 decimal max, `12.4k` compaction for big values.
- Every metric label says what it measures ("Monthly recurring revenue", not "Data 1").

## Density & hierarchy

- Dashboards are dense but never cramped: panel padding `p-5`, grid `gap-4/6`, page `p-6`.
- Type stays small (labels text-xs, body text-sm) EXCEPT the KPI numbers (text-3xl font-mono font-bold) — contrast in scale is what makes it scannable.
- Live/status indicators: small pulsing dot + label ("● Live", "Last synced 2m ago") in the header or panel corners.

## Motion

- Functional only: number count-up on load, 150ms panel fade-in, pulsing live dot. No scroll animations, no decorative movement.

## Quality bar (self-check before returning)

- Tooltips readable against panel background; no white flash on dark themes.
- KPI deltas use semantic colors consistently (green good / red bad).
- Panels align to one grid; no orphan panel dangling at odd widths.
- Interactive filters/selects actually update what's displayed (or are omitted).
