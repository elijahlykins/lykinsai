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
- **Never retype into a field that already holds your text.** Typing appends by
  default, so a retry duplicates the content. If a field reads back differently
  from what you typed, look at what it actually contains: sites reformat phone
  numbers, cards, dates and currency as you type, and a reformatted value is a
  success, not a failure. Use `type` with `mode: "replace"` if a plain field
  really does need overwriting, and `replace_text` for rich text.
- Some controls need real interaction patterns: dropdowns may need a click to
  open before selecting; comboboxes may need typing plus choosing a
  suggestion.
- After any action that plausibly changed the page (click on a button or
  link, submit, select), work from a fresh snapshot before the next decision.

# Forms

- Understand a field before filling it: role, label, current value,
  placeholder, and whether it is required.
- Do not overwrite already-populated fields unless the task requires changing
  them.
- Fill fields with exactly the information the task calls for; do not invent
  plausible values for fields you do not have data for — ask the user instead.
- Validate important values after typing: the field's actual value is the
  evidence, not the fact that a type action ran.
- Filling a form and submitting a form are different actions. Submission may
  be consequential (sending, purchasing, applying) and may require user
  approval — check the safety rules before submitting.
- Watch for inline validation errors after filling or submitting; they are
  evidence the form was not accepted.

# Editing existing text

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

## Finishing what a dialog started

A dialog you filled in is not done until you press its own commit button —
Send, Share, Invite, Save, Done. Two rules make that reliable:

- **Press the dialog's own control.** Its buttons are in the element list
  marked `[dialog]`; the commit is usually the last of them. Click it by
  reference. If the element list genuinely does not offer one, press Enter —
  most dialogs commit on it.
- **Never click page chrome while a dialog is open.** The top bar, the apps
  grid, the sidebar, the account avatar — clicking any of them dismisses the
  dialog and throws away what you filled in. If you find yourself reopening
  the same dialog, that is what happened: the last thing you clicked was
  behind it, not in it.

If you have opened the same dialog twice, stop and look at what is actually in
it before clicking anything else. Re-entering it a third time will not reveal
something the first two did not.

## Sharing something with a person

Share dialogs (Drive, Docs, Notion, Figma) have two routes to the same result,
and one of them fails far more often than the other:

1. **Add them as a recipient** — type the address into the "Add people" field
   and confirm. This is the better outcome when it works: the person gets
   access under their own account, and the item's visibility does not change.
2. **Copy the link and send it** — use the dialog's "Copy link" button, then
   email that link to them. Check what the link actually grants first: if the
   dialog says access is restricted, the link is useless to them, so set
   general access to anyone-with-the-link before sending it, and say in the
   email that you did.

Try the recipient field first. If it will not take the address after two real
attempts — you click it, type, and the address does not appear as text or as a
chip — stop repeating it. Take the Copy link route instead and tell the user
which one you used. Two failed attempts is the signal; a third is a fourth.

Never leave a share half-done: either the person is on the recipient list, or
they have a working link, or you say plainly that neither happened.

## Writing a document into a tool

When the work is a body of text — a page in Notion, a doc in Google Docs, an
outline in Slides — the draft is given to you in the goal. Do not retype it,
and do not go looking for the writing area first:

1. `paste_text` with the whole body. It finds and focuses the editor itself,
   including editors whose writing surface has no name you could click.
2. Read the page back. The text should be there.
3. Only if it is not: click into the body and paste again.

Hunting for the writing surface before pasting is the way this goes wrong. An
empty rich editor often has nothing to aim at — no label, no placeholder, no
visible box — so clicking at where it looks like it should be lands on nothing
and the document never gets written. The paste knows where to go; use it.

Type only what a paste cannot carry: a title field, a name, a single line.

## Fixing a value you got wrong

You typed the wrong thing into a field — a mistyped address, the wrong name,
text in the wrong box. Put it right the same way in every app:

- `type` with `mode: "replace"` on that field. It empties the field first and
  types the correct value, and it works on plain inputs, rich-text boxes, and
  the recipient fields that turn what you type into a chip. Do NOT type the
  correct value on its own — typing appends, so you end up holding both.
- If the wrong value has already become a **chip** (a committed recipient,
  tag or token), `mode: "replace"` clears it along with everything else in the
  field. Retyping the remaining values afterwards is expected and fine.
- Read the field back afterwards. A correction is worth one `extract` to be
  sure the old value is gone rather than sitting beside the new one.
- Do not go hunting for the little × on the thing you want to remove. It is
  usually drawn rather than labeled, and clicking at it is how a simple fix
  turns into a dozen wasted rounds.

Rules:

- Read the current content first (snapshot or `extract`) so `find` matches
  the text exactly as it appears.
- If `replace_text` reports the snippet was not found, the passage may span
  formatting boundaries — retry with a shorter exact fragment from one run of
  plain text.
- Wholesale rewrite is the last resort, only when the user explicitly asked
  to rewrite everything or nearly every sentence changes.
- After editing, verify the change landed by reading the field again.
