# Tool: research_report

Produce a deep, sourced research report. The tool runs LYKN's research
pipeline: it searches, reads sources, and writes a structured report that
opens for the user as a document.

## When

Only when the user asked for depth — a report, an investigation, a thorough
comparison, "everything about". A quick factual question is a reply, not a
report; users are annoyed by a ten-section document where a sentence was
wanted.

## Instruction

State the research question precisely, plus:

- the decision or purpose the report serves, if the user gave one — it changes
  what matters ("comparing for a purchase" reads differently from "writing an
  article")
- hard constraints: time range, region, budget, specific products or companies
  to include or exclude
- anything already established in the conversation the report should build on
  rather than rediscover

## What comes back

The full report text. It is delivered to the user as a document automatically;
you do not need to paste it anywhere.

## Rules

- One report per task unless the user asked for more. Refinements to an
  existing report go through edit_report, not a fresh research run.
- In your delivery, give the two or three findings that matter most — not the
  table of contents.
