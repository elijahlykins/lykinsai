# Tool: create_routine

Set up a routine: a task this bot will run on its own, on a schedule or when
something happens on the user's computer. Use it when the user asks for
recurring or standing work — "every weekday at 8, check competitor pricing",
"when a PDF lands in my Downloads, summarize it", "keep an eye on my test
suite and fix simple failures".

Creating a routine runs NOTHING now. It records what to do and when; each
occurrence later runs as its own task under this bot's identity, and the user
sees every routine on the bot's page where they can pause, run, or delete it.

## Instruction

Pass ONE JSON object:

```json
{
  "name": "Morning pricing check",
  "instructions": "Check competitor pricing pages for Acme and Beta, summarize any changes since yesterday.",
  "trigger": { "type": "schedule", "schedule": { "kind": "weekdays", "time": "08:00" } },
  "notificationPolicy": "always"
}
```

Triggers:

- `{ "type": "schedule", "schedule": { "kind": "daily" | "weekdays", "time": "HH:MM" } }`
- `{ "type": "schedule", "schedule": { "kind": "weekly", "time": "HH:MM", "days": [1, 5] } }` (0=Sun … 6=Sat)
- `{ "type": "schedule", "schedule": { "kind": "interval", "everyMs": 900000 } }` (minimum 1 minute)
- `{ "type": "schedule", "schedule": { "kind": "once", "at": "2026-09-01T08:00:00" } }`
- `{ "type": "filesystem", "path": "~/Downloads", "event": "created", "pattern": "*.pdf" }`
- `{ "type": "process", "name": "npm run build", "event": "exited" }`
- `{ "type": "manual" }` (the user runs it by hand)

`notificationPolicy`: `always` (default), `on_success`, `on_failure`,
`on_change` (monitors: only when the watched condition fires), `silent`.

Times are the user's local time. `instructions` must stand alone: each
occurrence runs fresh with no memory of this conversation, so fold in every
name, path, and preference the work needs.

## What comes back

Confirmation with the routine's name, its human-readable trigger, and what it
is allowed to do — repeat that back to the user so they know what was set up.
On a parse failure you get the reason; ask the user for the missing piece
(usually WHEN it should run) instead of guessing.

## Rules

- Only create a routine the user actually asked to be recurring or standing.
  A one-off "check pricing now" is normal task work, not a routine.
- Do not create duplicates: if the user refines an existing routine, say the
  routine already exists and what it does — the user edits or deletes it on
  the bot's page.
- The routine's capabilities are derived from its instructions and shown to
  the user. Never phrase instructions to smuggle in authority the user did
  not ask for (sending, buying, deleting).
