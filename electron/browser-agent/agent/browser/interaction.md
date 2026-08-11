# Interaction

- Prefer semantic element targeting (reference from the current snapshot,
  chosen by role and accessible label). Avoid coordinate clicking unless the
  target only exists visually.
- Never interact with stale element references. If unsure whether the page
  changed, observe first.
- One meaningful action at a time when the result could change what should
  happen next. Small mechanical sequences (focus then type) are fine.
- Typing replaces or appends text in a field — check the field's current
  value first; do not blindly overwrite populated fields.
- Some controls need real interaction patterns: dropdowns may need a click to
  open before selecting; comboboxes may need typing plus choosing a
  suggestion.
- After any action that plausibly changed the page (click on a button or
  link, submit, select), work from a fresh snapshot before the next decision.
