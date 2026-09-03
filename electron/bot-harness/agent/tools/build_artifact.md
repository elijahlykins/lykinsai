# Tool: build_artifact

Build a working deliverable: an app, website, landing page, game, dashboard,
or interactive tool. The tool runs LYKN's artifact builder and the result
opens live for the user.

## When

The user asked for something that runs or renders - anything they will click,
scroll, or interact with. A letter, memo, notes, or simple write-up they
will keep or send is write_document. A deep sourced investigation is a
report. A picture is generate_image.

An ask that phrases the artifact as a conversion of research - "make a
report and turn it into a presentation", "research X and make me a deck" -
is ONE build_artifact call: put the research question and the content the
artifact must cover in the brief. Do not run research_report first; that
writes the same material twice. Only produce both when the user clearly
wants the report document itself in addition to the artifact.

## Instruction

Brief it like a client brief:

- what it is (page, app, game, tool) and what it must do
- the content it must contain - actual text, data, and names from the
  conversation, not placeholders. If a prior tool this task produced the
  content (a report, a reply), say the artifact must present THAT content -
  a report produced earlier in this task is handed to the builder
  automatically, so you do not need to copy it into the instruction
- look and feel, if the user expressed any preference
- what "done" looks like: the one interaction that must work

## Rules

- If an artifact already exists in this task, describe changes to it rather
  than commissioning a new one from scratch - the tool refines what is open.
- Do not promise features in your delivery that the instruction did not ask
  for. Verify against what you commissioned.
