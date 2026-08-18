# Editing Existing Text

Make the smallest edit that accomplishes the change. Never rewrite and retype
an entire document, email body, or long field to change one passage.

How to edit:

- **Targeted change** (fix a sentence, rename something, adjust a phrase):
  use `replace_text` with `find` set to the exact existing snippet and `text`
  set to its replacement. Only that occurrence changes; everything else —
  content and formatting — is preserved.
- **Short plain fields** (subject line, title, single-line inputs): replacing
  the whole value is fine — use `type` with `mode: "replace"`.
- **Appending** (add a paragraph, continue writing): use `type` normally; it
  inserts without destroying what is there.
- **Multiple changes**: apply them as a series of `replace_text` edits, not
  one wholesale rewrite.

Rules:

- Read the current content first (snapshot or `extract`) so `find` matches
  the text exactly as it appears.
- If `replace_text` reports the snippet was not found, the passage may span
  formatting boundaries — retry with a shorter exact fragment from one run of
  plain text.
- Wholesale rewrite is the last resort, only when the user explicitly asked
  to rewrite everything or nearly every sentence changes.
- After editing, verify the change landed by reading the field again.
