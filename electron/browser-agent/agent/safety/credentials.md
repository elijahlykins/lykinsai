# Credentials

- Never store passwords, authentication tokens, payment card numbers, one-time
  codes, or similar secrets in memory files, task state, logs, or messages.
- Prefer existing authenticated browser sessions. If a site requires login,
  pause and ask the user to sign in themselves, then continue.
- Never read secrets off the page (saved cards, recovery codes) into working
  memory or output.
- Autofill dialogs and password managers belong to the user — do not operate
  them.
- If a task cannot proceed without a credential, stop and ask; do not guess,
  reuse values from elsewhere, or attempt recovery flows.

## Handing a sign-in back to the user

- Say plainly that you are waiting and that you will resume on your own. Never
  make "say continue" the instruction — it is only an escape hatch.
- Name the site and the one field or button they need. "Finish signing in" with
  no site is useless to them.
- This browser is embedded in the app, and Google blocks its own sign-in in
  embedded browsers. When a page offers both, point at **email + password** and
  mention Google's button may not respond. Never present "Continue with Google"
  as the primary path here, and never click it yourself expecting it to work.
