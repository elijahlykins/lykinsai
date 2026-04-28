// ============================================================================
// connectors/google/gmail.js — Gmail adapter
// ============================================================================
// Pulls every starred email into the vault as a bookmark. Each note links
// back to the message in Gmail's web UI; we don't store full bodies, just
// subject + sender + a short snippet (whatever Gmail returns in the metadata
// envelope).
//
// IMPORTANT — Restricted scope:
//   `gmail.readonly` is one of Google's most heavily reviewed scopes. Going
//   to production requires CASA Tier 2 or 3 security assessment (3rd-party
//   pentest, several thousand $). Until verified, only allowlisted Google
//   Cloud test users can sign in.
//
//   For lower-risk auth, swap to `gmail.metadata` (still sensitive, but
//   easier to verify): change the scope below and switch the API to
//   `format=metadata` on messages.get. Code path is the same.
// ============================================================================

import { createGoogleAdapter, gFetch, saveGoogleNote } from './_shared.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

const PAGE_SIZE = 50;
const MAX_PAGES_PER_SYNC = 4; // 200 starred emails per sync

async function syncGmailStarred({ connection, supabaseAdmin, accessToken }) {
  const meta = connection.metadata || {};
  const cursorIso = meta.starred_cursor || null;
  const cursorTime = cursorIso ? new Date(cursorIso).getTime() : 0;

  let saved = 0;
  let skipped = 0;
  let pageToken = null;
  let newest = cursorTime;

  pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
    // Search for starred messages, newest first.
    const listParams = new URLSearchParams({
      q: 'is:starred',
      maxResults: String(PAGE_SIZE),
      ...(pageToken ? { pageToken } : {}),
    });
    const listData = await gFetch(
      `${GMAIL_API}/users/me/messages?${listParams}`,
      accessToken,
      {},
      `gmail-list-p${page}`,
    );
    const ids = (listData.messages || []).map((m) => m.id);
    if (!ids.length) break;

    for (const id of ids) {
      // metadata format gives us headers (Subject/From) and snippet without
      // the full body — fastest, cheapest, and easier to verify.
      const message = await gFetch(
        `${GMAIL_API}/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        accessToken,
        {},
        `gmail-get-${id}`,
      );

      const internalDate = Number(message.internalDate || 0);
      if (cursorTime && internalDate <= cursorTime) break pages;

      const result = await saveGmailMessage({
        supabaseAdmin,
        userId: connection.user_id,
        message,
      });
      if (result === 'saved') saved++;
      else skipped++;

      if (internalDate > newest) newest = internalDate;
    }

    pageToken = listData.nextPageToken;
    if (!pageToken) break;
  }

  if (newest && newest !== cursorTime) {
    await supabaseAdmin
      .from('social_connections')
      .update({
        metadata: { ...meta, starred_cursor: new Date(newest).toISOString() },
      })
      .eq('id', connection.id);
  }

  return { saved, skipped };
}

async function saveGmailMessage({ supabaseAdmin, userId, message }) {
  const id = message.id;
  if (!id) return 'skipped';
  const url = `https://mail.google.com/mail/u/0/#inbox/${id}`;

  const headers = message.payload?.headers || [];
  const headerMap = Object.fromEntries(headers.map((h) => [h.name?.toLowerCase(), h.value || '']));
  const subject = headerMap.subject || '(no subject)';
  const from = parseFromHeader(headerMap.from || '');

  const title = subject.slice(0, 280);
  const snippet = (message.snippet || '').replace(/\s+/g, ' ').slice(0, 1200);
  const description = `${from.name || from.email}${from.email && from.name ? ` <${from.email}>` : ''}\n\n${snippet}`;

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image: '',
    favicon: 'https://www.google.com/gmail/about/static/images/logo-gmail.png',
    siteName: 'Gmail',
    articleText: snippet,
    oembedType: 'gmail',
    oembedHtml: '',
    authorName: from.name || from.email,
    authorHandle: from.email,
  };

  return saveGoogleNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags: ['gmail', 'starred', 'email', 'link', 'uploaded'],
    source: 'gmail_starred',
    createdAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : undefined,
  });
}

// Parses an RFC-5322 From header: `"Display Name" <user@example.com>` or
// just `user@example.com`.
function parseFromHeader(raw) {
  if (!raw) return { name: '', email: '' };
  const match = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  if (raw.includes('@')) return { name: '', email: raw.trim() };
  return { name: raw.trim(), email: '' };
}

export const gmailAdapter = createGoogleAdapter({
  id: 'gmail',
  scopes: SCOPES,
  initialMeta: { starred_cursor: null },
  sync: syncGmailStarred,
});
