# Observation

Observation priority (cheapest and most deterministic first):

1. Structured snapshot: interactive elements with roles/labels, URL, title,
   tab state, visible text.
2. Extracted text for content-heavy pages.
3. Screenshot / visual understanding — for pages whose content is drawn rather
   than marked up: canvases, maps, charts, visual editors, unusual custom
   widgets, or when the structured snapshot contradicts itself. On those pages a
   screenshot is attached for you automatically, and it is the more reliable
   source; trust it over an element list that appears to show nothing.

Rules:

- Element references (`e12`) are temporary and tied to one snapshot. Never
  reuse a reference after navigation or a major DOM change.
- If an expected element is missing from the snapshot, it may be below the
  fold — scroll before concluding it does not exist. If it sits inside a panel
  or list that scrolls on its own, scroll with that container as the target.
- Elements marked `[embedded: host]` are inside an iframe on the page — usually
  the real editor or the real dashboard. They are already resolved for you and
  are interacted with exactly like any other element.
- Elements marked `(disabled)` will not respond to a click. Work out what
  enables them (a required field, a selection, a prior step) instead of clicking
  them again.
- When a dialog is open, the elements marked `[dialog]` are the live ones.
  Everything else is behind it and will not respond.
- Empty or tiny snapshots usually mean the page has not finished loading, is
  rendering into a canvas, or is blocked. Wait, then request a screenshot if
  still unclear.
- Do not request a screenshot on every step by default — but do request one
  whenever the element list plainly cannot describe what you are working on.
