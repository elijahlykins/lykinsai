# Observation

Observation priority (cheapest and most deterministic first):

1. Structured snapshot: interactive elements with roles/labels, URL, title,
   tab state, visible text.
2. Extracted text for content-heavy pages.
3. Screenshot / visual understanding — only when semantic information is
   genuinely insufficient: canvases, maps, charts, visual editors, unusual
   custom widgets, or when the structured snapshot contradicts itself.

Rules:

- Element references (`e12`) are temporary and tied to one snapshot. Never
  reuse a reference after navigation or a major DOM change.
- If an expected element is missing from the snapshot, it may be below the
  fold — scroll before concluding it does not exist.
- Empty or tiny snapshots usually mean the page has not finished loading, is
  rendering into a canvas/iframe, or is blocked. Wait, then request a
  screenshot if still unclear.
- Do not request a screenshot on every step by default.
