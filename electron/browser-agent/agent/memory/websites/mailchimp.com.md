# Mailchimp (mailchimp.com, *.admin.mailchimp.com)

- The app lives on a region host like `us21.admin.mailchimp.com`. Signing in at
  `login.mailchimp.com` redirects there; do not try to guess the region prefix.
- Google's "Continue with Google" button does not work in an embedded browser.
  If the user needs to sign in, tell them to use email + password.

## Getting to a new email

- Create > Email, or the "Create" button in the top bar. Campaigns already made
  are under Campaigns / All campaigns.
- A new email asks for a template first. The choice matters a lot:
  - **"Code your own" / "Paste in code"** takes a block of HTML directly. When
    the content is written elsewhere, this is by far the most reliable route -
    one paste instead of a dozen drags.
  - **A drag-and-drop layout** requires dragging content blocks from the right
    panel into the canvas. Clicking a block in the palette does nothing; it has
    to be dragged.
  - **"Replicate" on an existing campaign** copies its layout and styling, then
    only the text needs changing. This is the right choice whenever the user
    refers to matching their previous emails - it inherits the format exactly
    instead of trying to recreate it.
- Replicate lives in the campaign row's dropdown menu on the Campaigns list
  (the "..." / caret at the end of the row).

## The editor

- The email canvas renders in an iframe. Its contents appear in the element list
  marked `[embedded: ...]` and are interacted with normally.
- Text blocks need a click to select, then editing happens in a small toolbar
  overlay. Existing placeholder copy is replaced in place rather than cleared
  and retyped.
- The content panel on the right scrolls inside itself - scroll it with its own
  element as the target, not the page.
- Subject line and preview text are set from the campaign settings area
  ("Subject" / "Add subject"), not inside the canvas.
- Changes save automatically; "Saved" or a timestamp in the header is the
  evidence. There is also a "Save and Close" / "Continue" control to leave the
  editor.

## Audience and sending

- The recipients/audience selector is part of the campaign setup, separate from
  the content. A campaign cannot send without one, and the Send button stays
  disabled until it is set - a disabled Send usually means audience, subject or
  from-name is missing, not that the click failed.
- "Send" delivers to the whole selected audience and cannot be undone. That is a
  consequential action: only do it when the request explicitly asked to send,
  and get approval otherwise.
- "Schedule" is equally consequential.
- Preparing a draft and stopping before Send is the correct outcome for any ask
  that says draft, prepare, write, or set up.
