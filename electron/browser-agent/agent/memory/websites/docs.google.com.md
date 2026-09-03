# Google Docs / Slides (docs.google.com)

Open this site only when the user asked to write in Google Docs or Slides.
Do not come here to file your own research or browse write-up. That finish
answer, or `write_document`, is the document.

The page itself is drawn on a canvas. Chrome around it (File / Edit / Share,
the filename) shows up in the element list; the document body does not.

## Writing

- `paste_text` the whole body. It finds the page for you. Do not hunt for a
  writing surface, and do not click the filename first.
- After the paste, read the page back. If the words are there, the write is
  done. Docs autosaves; "Untitled document" with the body in it is finished.
- Do not click Rename / "Untitled document" as a finishing step. Name the file
  only when the user asked for a title, and then type just that short name
  with `type` mode "replace".
- Never put the document body into the title field. A long type aimed at
  Rename missed the page.
- Changing a sentence or section is not a rename. `replace_text` cannot see
  canvas text. `paste_text` the revised body with mode "replace", or type
  into Document body - never into Rename.

## Title vs body

- The top-left name ("Untitled document") is a rename field, not the editor.
  Clicking it and typing is how a write turns into a filename loop.
- The body does not report its contents back. An empty scrape after a paste
  is normal. Do not retype.

## Sharing

- Share is the button in the top right. Invite from the dialog; do not type
  the share instruction into the document.
