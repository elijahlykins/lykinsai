# Tool: write_document

Write a basic document as a simple HTML file, save it to the user's Downloads
folder and to AI Drive / Docs, and open it in the LYKN browser as a readable
page (not as HTML source, and not in Safari or Chrome). The file is a real
document they can read, attach, upload, or send.

## When

The user asked for something written out that they will keep or send: a
letter, memo, notes, write-up, one-pager, bio, statement, or a simple
document. Chat replies stay in `reply`. Deep sourced investigations stay
in `research_report`. Something they will click or play stays in
`build_artifact`.

Do not ask where to save it. Downloads and AI Drive / Docs are the destination.
This is the default for a keepable write-up. Do not open Google Docs instead.

## Instruction

Write the complete document. Lead with a title line (`Title: …` or `# Title`).
The rest is the body in markdown, or a full HTML document if they asked for
HTML. Include the actual wording - not a brief for someone else to write.

## What comes back

Confirmation of the filename and that it is in Downloads and AI Drive / Docs.
That confirmation is the delivery - do not paste the document back into chat.

## Rules

- One document per call unless they asked for more.
- Do not follow this tool with a shorter wrap-up of the same text.
- Sending or uploading the file somewhere else is a later step (browser or
  local_computer). Writing it out is this tool.
