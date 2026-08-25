# Tool: edit_report

Revise the research report already produced in this task or conversation. The
tool has the current report and applies your changes to it, returning the full
updated document.

## When

The user asked to change, extend, shorten, restyle, or correct an existing
report. Never use it to write a first report — that is research_report.

## Instruction

Describe the edits precisely: what changes, what stays, and any new
information to work in. "Make it better" instructions produce arbitrary
rewrites; name the sections and the nature of each change.

## Rules

- Edits do not re-run research. If the change needs new facts the report does
  not contain, say so in the instruction so the tool works only with what it
  can support — or run research_report for the missing ground first.
