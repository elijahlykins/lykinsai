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
