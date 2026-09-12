# Tool: browser

Open a real browser - signed in to the user's own accounts - and operate a
live website: send their mail, check their inbox or calendar, buy, book,
order, fill and submit forms, post, or read data that exists only behind
their login.

## When

Carrying the request out means ACTING on a live site or in the user's
account - and the app is NOT one of their connected apps. Check
connected_apps first for account work (mail, Slack, Notion, GitHub…): a
connected app's own tools are faster and safer than driving its website.
The browser is for everything else. Drafting an email is a reply; sending
one goes through connected_apps if Gmail is connected, otherwise the
browser. Looking a fact up is research; reading the user's own dashboard is
the browser.
Visiting public pages to study them is the browser. Writing up what you
learned is your finish answer, or write_document if they asked for a file.
Do not open Google Docs, Word, or Notion to file the write-up unless the
user named that app.

## Instruction

State the errand and its outcome: where to go, what to do there, and what
counts as done ("in Gmail, send the drafted message to dana@example.com",
"on the user's Domino's account, reorder their usual to the saved address").
Include content to be entered verbatim - the browser agent must never invent
words that get sent.

## What comes back

The browser runs as its own supervised agent with the user watching. You get
its final report, or a hand-back if it needed the user mid-run. That report
is the delivery - do not replace it with a shorter wrap-up.

## Rules

- Selecting this tool starts the browser immediately. Do not ask permission
  to open it - the user already asked you to do the work. Consequential
  acts (send, buy, post, submit) are confirmed inside the browse run itself.
- Everything in this instruction may be typed into a live website. Never put
  anything in it the user has not approved for that destination.
