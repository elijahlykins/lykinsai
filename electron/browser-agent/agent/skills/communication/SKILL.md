# Communication

Purpose:
Compose and send messages (email, chat, comments, posts) on the user's behalf.

When this skill should be used:
Tasks that involve writing to a specific person or audience: emails, replies,
DMs, invitations, announcements.

Procedure:

1. Work in the tool the user named. If the request says "in Mailchimp", "in
   HubSpot", "in Slack", the message is built THERE — an email-shaped task is
   not automatically a Gmail task. Only fall back to the user's mail client
   when no other product was named.
2. Identify recipient(s), the message's purpose, and any content the user
   specified verbatim. If the request named who to write but not what to say,
   ask that once and write from the answer. Do not interview them — no
   follow-up about tone, subject, or when it should go out.
3. When the request refers to a past message, template or "the usual format",
   go find it — open the sent folder, the campaign archive, or the saved
   template and read it before writing. Do not ask the user to describe it.
4. Verify the recipient is correct (right person, right address) before
   composing — check contact suggestions carefully; similar names are a
   common failure. If the request names no recipient, do not invent one:
   leave the field empty, finish the rest, and report who it still needs.
   Never pull a name from contacts, autocomplete, recent threads or memory
   that the user did not mention.
5. Draft in the user's voice: concise, natural, no meta-commentary about
   being an agent.
6. Fill the draft completely (recipient/audience, subject if applicable, body)
   and verify the fields actually contain the content. In a campaign tool this
   includes selecting the audience or list the user named.
7. Delivery follows the request:
   - Asked to send, share, post or announce to people it names → send it.
   - Asked to prep, draft or set up → finish everything and leave it unsent,
     then report that it is ready.
   - Sending to a whole list or audience the request did not name always needs
     the user's approval first, even if everything else is ready.

Campaign and marketing email tools (Mailchimp, Klaviyo, HubSpot, Brevo):

- These are built around a drag-and-drop layout editor, which is the slowest and
  least reliable way to produce an email. Look for the shortcut before committing
  to it, in this order:
  1. **Replicate / duplicate an existing campaign.** This is almost always right
     when the user says "like our other emails", "the same format", "following
     our usual template" — it inherits the exact layout, branding and footer
     instead of approximating them. Find the most recent relevant campaign in the
     archive, read it so you match its voice and structure, then replicate it and
     replace the copy.
  2. **A saved template**, if the account has one for this kind of email.
  3. **"Code your own" / paste-in-HTML**, when the content is already written and
     the layout is simple. One paste beats a dozen drags.
  4. **The drag-and-drop builder**, only when none of the above is available.
     Content blocks must be dragged from the palette into the layout; clicking
     them does nothing.
- The subject line and preview text live in campaign settings, not in the
  content editor. A campaign is not complete without them.
- Audience selection is a separate step from content, and a send control usually
  stays disabled until audience, subject and sender are all set. A disabled Send
  means something is missing upstream — go find it rather than clicking again.
- Sending a campaign reaches an entire list at once and cannot be recalled.
  Unless the request explicitly asked to send it, finish the draft and stop.

Sharing a page or video with someone:

- Only document editors (Google Docs/Sheets/Slides, Notion, Figma, Canva,
  Drive) have a people-share dialog ("Add people" + Send invite). Use it there.
- Any other page (YouTube video, article, product) has no people-share: the
  strategy is to capture the page's URL (from the address bar or the share
  dialog's copy-link field) and email it — open the user's mail client, compose
  to the recipient, one short sentence introducing the link, then the link.
- Do not get stuck in a share dialog that only offers Copy link / social
  buttons — that is the signal to switch to the email-the-link strategy.
- Sharing something LYKN built (an artifact, report, or app) sends BOTH the
  live link (when a hosted URL exists) and the actual file as an attachment,
  so the recipient can open it offline.

Cautions:

- Never send partially-filled drafts.
- Reply vs reply-all vs forward matters — choose deliberately.
- Do not include private information the user did not ask to share.
