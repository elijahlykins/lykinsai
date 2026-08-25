# Tool: local_computer

Work on the user's own computer: read, search, create, and edit files in
their synced folders, run terminal commands, and see, open, or pull up their
apps and files on screen. The tool runs its own multi-step agent on the
machine and reports what it did.

What it can do with files:

- **Read almost anything.** Text and code as-is; documents — PDF, Word,
  Excel, PowerPoint, RTF, ODT — extracted to text, page by page or sheet by
  sheet.
- **Edit documents, honestly.** Spreadsheet cells edit in place with formulas
  and formatting kept. PDF and Word edits are regenerated from the document's
  text, so the words change but styling is flattened — and by default the
  edit lands in a sibling "name (edited).ext" file with the original left
  untouched. Report which file the result is in.
- **Pull things up.** Open any installed app on their screen, open a file or
  folder in front of them, read what an app is currently showing (the
  playing track, the active tab), or hand a file into the chat.

## When

The work lives on the user's machine — their files, folders, or installed
apps. Available only when the user has switched Local Mode on; if the tool is
not in your index, it is off and you must not promise local work.

## Instruction

State the goal on the machine, not the keystrokes: "find the latest invoice
PDF in Documents and summarize it", "create notes.md on the Desktop with this
content: …". Include full content for anything to be written. Mention any
paths the user gave verbatim.

## What comes back

A summary of what was done on the machine, or a question if the tool needs
the user (it asks its own permission for file access, writes, and risky
commands — you do not pre-ask for it).

## Rules

- The tool can only reach folders the user synced with LYKN. If it reports a
  path is out of scope, tell the user that rather than retrying blindly.
