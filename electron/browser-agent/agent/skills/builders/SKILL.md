# Builders and visual editors

Email campaign builders, design tools, page builders and slide editors work
differently from documents and forms. Assume none of the usual signals apply
until you have looked at the page.

## Find the editing surface first

The thing you need to edit is usually not in the outer page. It is either in an
embedded document (marked `[embedded: host]` in the element list) or drawn on a
canvas. Before deciding anything, work out which:

- **Embedded** — the elements are listed with `[embedded: ...]`. Interact with
  them exactly like any other element; they are already resolved for you.
- **Drawn** — few named controls, and the visible text describes chrome
  (toolbars, menus, panels) rather than content. Take a `screenshot` and work
  from what you can see, using `click_coord` and `drag`.

Never conclude a document is empty because the element list looks empty. In a
drawn editor the element list can never show the content.

## Prefer the plainest route to the same result

These tools usually offer several ways to do one job, and the visual one is the
hardest to drive. Look for the simpler path before committing to the pretty one:

- A blank or plain-text layout instead of a drag-and-drop template.
- A "paste in your own HTML / code your own" option instead of assembling blocks
  by hand.
- Duplicating an existing item and editing its text, instead of building from
  nothing. If the user referred to how they have done this before, find the
  previous one and duplicate it — that inherits the format for free.
- A template with placeholder text, where the work is replacing words rather
  than placing elements.

Choosing the plain route is not cutting a corner; it is the difference between
finishing and not.

## Adding content

- To add a block, element or section, `drag` it from the palette into the
  layout. Clicking a palette item usually does nothing at all — dragging is the
  gesture these products are built around.
- Drop onto a specific place, not the middle of the canvas: the gap between two
  existing blocks, the empty placeholder, the named region.
- After a drop, re-observe. A successful drop changes the layout and often opens
  a settings panel for the new item.
- Palettes and block lists scroll inside themselves. If what you want is not
  listed, `scroll` with the palette's own element as the `target`.

## Editing text

- Placeholder text ("Your text here", "Lorem ipsum", "Add your title") is meant
  to be replaced. Use `replace_text` on the exact placeholder rather than
  clearing and retyping the whole region.
- A text box usually needs a click to select it and a second click (or a
  double-click) to enter edit mode before typing lands.
- Formatting is faster by shortcut than by toolbar: `press_key` with
  `modifiers`, e.g. key `b` + `["meta"]` for bold.

## Confirming your work

Most correct actions here produce no change a page scrape can see. When the
verification says an action could not be confirmed, that is not a failure and
you should not repeat it. Take a `screenshot` and confirm with your eyes, then
carry on.

Do not retype content you have already typed because the field reads back empty.
Canvas and code editors routinely refuse to report their own contents. Check the
screenshot before assuming the text is missing.

## Saving

- These tools autosave; a "Saved" or "All changes saved" indicator is your
  evidence.
- Distinguish saving from sending. Saving a draft, naming a design, and exiting
  the editor are all ordinary progress. Sending a campaign to a list, publishing
  a page, or sharing with people is delivery — that follows the normal rules for
  outbound actions.
