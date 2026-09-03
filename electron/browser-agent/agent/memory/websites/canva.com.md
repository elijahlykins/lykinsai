# Canva (canva.com)

The Canva editor draws its page onto a canvas. The element list describes the
toolbars, side panels and menus around it, and can never describe the design
itself. Work from the attached screenshot, and use `click_coord` and `drag` for
anything on the page area.

## Starting a design

- The home page has a search box for templates and size presets
  ("Instagram post", "Presentation", "Poster"). Searching for the format and
  picking a template is far more reliable than starting from blank - a template
  arrives with text placeholders that only need replacing.
- `canva.com/design/…/edit` is an open editor. The home page is `canva.com`.
- Existing work is under "Projects" / "Recent designs". Duplicating a previous
  design inherits its style; that is the right route when the user asks for
  something matching what they made before.

## The editor layout

- Far-left icon rail: Design (templates), Elements, Text, Brand, Uploads,
  Projects. Clicking one opens its panel next to the rail.
- That panel is a scrolling list of items. To use one, drag it from the panel
  onto the page. Clicking an element in the panel sometimes drops it in the
  centre of the page, but dragging to a specific spot is what places it
  correctly.
- The panel scrolls internally - scroll it with its own element as the target.
- Top bar holds document-level controls: the design name, Share, and the
  file/resize menus.

## Text

- Text > "Add a heading" / "Add a subheading" / "Add a little bit of body text"
  adds a text box. Drag it to place it.
- Editing existing text: click the text box once to select it, then click again
  (or double-click) to enter edit mode. Typing before edit mode is entered goes
  nowhere or triggers a keyboard shortcut instead.
- Once in edit mode, select-all before typing to replace, otherwise the new text
  appends to the placeholder.
- Formatting is on the toolbar that appears above the selected box, and by
  shortcut: Cmd/Ctrl+B bold, Cmd/Ctrl+I italic.

## Useful shortcuts

- `T` adds a text box, `R` a rectangle, `L` a line (when nothing is in edit
  mode).
- Cmd/Ctrl+D duplicates the selection, Cmd/Ctrl+Z undoes, Delete removes it.
- Cmd/Ctrl+G groups, Cmd/Ctrl+Shift+G ungroups.

## Confirming and finishing

- Nothing about the design shows up in a page scrape. After placing or editing
  anything, confirm with a screenshot rather than by looking for a DOM change.
  Do not retype text because a field read back empty - it always reads empty.
- Canva autosaves; "All changes saved" appears in the top bar.
- Share > Download exports a file. Share > invite people delivers the design to
  others, which is an outbound action and follows the normal rules.
