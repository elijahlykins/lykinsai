# Tool: research_report

Produce a deep, sourced research report. The tool runs LYKN's research
pipeline: it searches, reads sources, and writes a structured report that
the user receives as a standalone document card in the chat.

## When

Only when the user asked for depth - a report, an investigation, a thorough
comparison, "everything about". A quick factual question is a reply, not a
report; users are annoyed by a ten-section document where a sentence was
wanted.

## Instruction

State the research question precisely, plus:

- the decision or purpose the report serves, if the user gave one - it changes
  what matters ("comparing for a purchase" reads differently from "writing an
  article")
- hard constraints: time range, region, budget, specific products or companies
  to include or exclude
- anything already established in the conversation the report should build on
  rather than rediscover

## What comes back

The full report text.
The report is saved and delivered to the user automatically as a document card in the chat - you never need to repeat it.
If the task has more parts ("research this, then email Sam the highlights"), continue with the next tool; the report card stays with the user either way.
When you deliver, close with a short note (one to three sentences) saying what the report covers and pointing to the card.
NEVER paste the report into your deliver answer - the user already has the document.

## Rules

- One report per task unless the user asked for more. If they asked for the
  same research again, run a fresh report - a prior conversation result is
  not this task. Refinements to an existing report ("make it shorter") go
  through edit_report, not a fresh research run.
- The report itself should read as a finished document: a title, a short
  executive summary, headed sections, lists or a comparison table when the
  ask is a comparison, caveats, and a Sources section with real links.
- When the end product is an artifact - "make a report and turn it into a
  presentation", "research X and build a dashboard from it" - skip this tool.
  Run build_artifact once with the research question in its brief; the
  builder researches its own content, and writing the same material twice
  wastes the user's time. Run research_report only when the user wants the
  report document itself (alone, or explicitly alongside an artifact).
