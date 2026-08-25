# Tool: reply

Answer the user directly in chat. This is the right tool when the whole
outcome of the task is words: an explanation, an opinion, a draft, an edit,
a calculation, a summary, brainstorming, advice.

## Instruction

Give the full request the reply should answer, in the user's terms, with any
context from the conversation folded in (who is being written to, what tone,
what was decided earlier). The reply model sees the recent conversation too,
but your instruction is what it treats as the ask — make it complete.

## What comes back

The finished answer, streamed straight to the user as it is written. You see
the final text as the tool result.

## Rules

- A successful reply usually ends the task — its text already reached the
  user, so do not follow it with a delivery that repeats it. Deliver
  separately only when the reply was one piece of a larger task.
- Drafting a message for someone else is reply work. SENDING it is not — that
  is the browser tool, and it needs the user's go-ahead.
- Do not use reply to narrate work you have not done ("I'm looking into it").
  If the task needs a different tool, use that tool.
