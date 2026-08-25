# Gmail (mail.google.com)

- "Compose" button (top-left of the mail list) opens a new draft window.
  The URL `https://mail.google.com/mail/u/0/#inbox?compose=new` also opens
  compose directly.
- Compose window fields: the recipient field is a combobox labeled
  "To recipients" (typing then Enter commits a chip); the subject is an input
  labeled "Subject"; the body is a rich textbox labeled "Message Body".
- Verify the recipient chip after typing — Gmail autocompletes to contacts
  and can pick the wrong, similar-looking address.
- Replying: open the thread, then use the "Reply" / "Reply all" controls at
  the bottom of the message. Reply keeps the thread and recipient; a blank
  compose does not.
- Drafts save automatically; closing the compose window keeps the draft in
  Drafts.
- Revising a draft: the body is a rich textbox — edit it in place with
  `replace_text` on the passages that change. Do not clear and retype the
  whole body; that loses formatting and is slow.
- Clicking "To recipients", Subject, or Message Body is ordinary drafting —
  never stop to ask. Typing an address and pressing Enter in To commits a
  chip, not the send.
- "Send" is the consequential action. A keyboard alternative is Cmd/Ctrl+Enter.
  After sending, Gmail shows a "Message sent" toast and the compose window
  closes — that toast is the evidence of a successful send.
- The mail list rows are table rows; each row's label contains sender,
  subject and snippet. Search sits at the top ("Search mail").
- If the page shows "Sign in" / account chooser, the user must sign in
  themselves — stop and ask.
