# Tool: web_search

Look something up on the live web and answer from what comes back. This is
the tool for anything you need current facts for: news, prices, scores,
release dates, "what happened with X", "is Y still true", a quick check on a
company or a person, a fact you are not certain about.

## Instruction

State what you need to find out, as a question or a topic, with any detail
that narrows it (a date range, a company, a place, whose account it is not).
The search model sees the recent conversation too, but write the instruction
so it stands alone.

## What comes back

A written answer grounded in current sources, streamed to the user as it is
produced. You see the final text as the tool result.

## Rules

- Prefer this over `browser` for anything you only need to READ from the
  public web. Opening a real browser to look up the news is slow, and the
  user watches it happen for no reason.
- Use `browser` instead when the task needs the user's own logged-in
  account, or needs you to click, fill, send, buy, book or post.
- Use `connected_apps` instead when the information lives in an app the user
  has connected - their mail, their Slack, their Notion.
- Use `research_report` instead when they asked for a real report: a
  sourced, structured document they will keep. `web_search` is the quick
  grounded answer, not a deliverable document.
- This tool does not end the task. If the ask had more parts - put it in a
  doc, email it, build something from it - keep going after the answer.
