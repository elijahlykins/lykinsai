// ============================================================================
// connectors/google/gmail.js — Gmail adapter
// ============================================================================
// Pulls two streams of email into the vault:
//
//   1. Starred mail → `source: 'gmail_starred'`, tagged 'starred'. These
//      are user-curated and persist forever.
//   2. Recent inbox mail (last 30 days) → `source: 'gmail_inbox'`,
//      tagged 'inbox'. This is the "as it arrives" feed — the algorithm
//      is meant to *know* about new mail without the user having to
//      do anything. We cap aggressively (200/sync) so a busy inbox
//      can't blow through the user's vault cap on the first sync, and
//      we use `internalDate` cursors so each subsequent poll only
//      pulls genuinely-new mail.
//
// Both streams are deduped (same `saveGoogleNote` upsert path) and both
// flow through `embedAndStoreChunks` so the synthesis layer's vector
// retrieval can find what's in your inbox.
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
// Per-stream caps. 200 starred emails per sync covers all but the most
// extreme power users; 200 inbox messages per sync handles ~10 days of
// a very busy inbox before falling back to the cursor on subsequent
// polls.
const MAX_PAGES_STARRED = 4;
const MAX_PAGES_INBOX = 4;
// Inbox lookback on first sync (no cursor yet). Bounded so connecting
// Gmail doesn't pull a year of trivial automated mail into the vault.
const INBOX_LOOKBACK_DAYS = 30;

// Subjects we never want noisy in the vault — auto-generated bulk mail
// that pollutes retrieval more than it informs. Matched substring,
// case-insensitive. Users can still see these in Gmail directly.
const INBOX_SKIP_SUBJECT_RE = /\b(unsubscribe|newsletter|verify your email|password reset|delivery (notification|status))\b/i;

async function syncGmail({ connection, supabaseAdmin, accessToken }) {
  let saved = 0;
  let skipped = 0;

  const starred = await syncGmailQuery({
    connection,
    supabaseAdmin,
    accessToken,
    cursorKey: 'starred_cursor',
    query: 'is:starred',
    maxPages: MAX_PAGES_STARRED,
    source: 'gmail_starred',
    tags: ['gmail', 'starred', 'email', 'link', 'uploaded'],
    skipSubject: null,
  });
  saved += starred.saved;
  skipped += starred.skipped;

  // For the inbox stream we use Gmail's `newer_than:30d` operator on
  // the very first sync (when there's no cursor yet) so we don't pull
  // years of mail. After the cursor lands we just walk newest-first
  // until we hit the cursor.
  const meta = connection.metadata || {};
  const inboxQuery =
    meta.inbox_cursor
      ? 'in:inbox -in:chats'
      : `in:inbox -in:chats newer_than:${INBOX_LOOKBACK_DAYS}d`;

  const inbox = await syncGmailQuery({
    connection,
    supabaseAdmin,
    accessToken,
    cursorKey: 'inbox_cursor',
    query: inboxQuery,
    maxPages: MAX_PAGES_INBOX,
    source: 'gmail_inbox',
    tags: ['gmail', 'inbox', 'email'],
    skipSubject: INBOX_SKIP_SUBJECT_RE,
  });
  saved += inbox.saved;
  skipped += inbox.skipped;

  return { saved, skipped };
}

// Generic Gmail-query → vault-notes pipeline used by both the starred
// and inbox streams. Each stream stores its own internalDate cursor in
// the connection's metadata so the streams advance independently.
async function syncGmailQuery({
  connection,
  supabaseAdmin,
  accessToken,
  cursorKey,
  query,
  maxPages,
  source,
  tags,
  skipSubject,
}) {
  const meta = connection.metadata || {};
  const cursorIso = meta[cursorKey] || null;
  const cursorTime = cursorIso ? new Date(cursorIso).getTime() : 0;

  let saved = 0;
  let skipped = 0;
  let pageToken = null;
  let newest = cursorTime;

  pages: for (let page = 0; page < maxPages; page++) {
    const listParams = new URLSearchParams({
      q: query,
      maxResults: String(PAGE_SIZE),
      ...(pageToken ? { pageToken } : {}),
    });
    const listData = await gFetch(
      `${GMAIL_API}/users/me/messages?${listParams}`,
      accessToken,
      {},
      `gmail-list-${source}-p${page}`,
    );
    const ids = (listData.messages || []).map((m) => m.id);
    if (!ids.length) break;

    for (const id of ids) {
      // metadata format gives us headers (Subject/From) and snippet without
      // the full body — fastest, cheapest, and easier to verify.
      const message = await gFetch(
        `${GMAIL_API}/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`,
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
        source,
        tags,
        skipSubject,
      });
      if (result === 'saved' || result === 'updated') saved++;
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
        metadata: { ...meta, [cursorKey]: new Date(newest).toISOString() },
      })
      .eq('id', connection.id);
  }

  return { saved, skipped };
}

async function saveGmailMessage({ supabaseAdmin, userId, message, source, tags, skipSubject }) {
  const id = message.id;
  if (!id) return 'skipped';
  const url = `https://mail.google.com/mail/u/0/#inbox/${id}`;

  const headers = message.payload?.headers || [];
  const headerMap = Object.fromEntries(headers.map((h) => [h.name?.toLowerCase(), h.value || '']));
  const subject = headerMap.subject || '(no subject)';
  if (skipSubject && skipSubject.test(subject)) return 'skipped';

  const from = parseFromHeader(headerMap.from || '');

  const title = subject.slice(0, 280);
  const snippet = (message.snippet || '').replace(/\s+/g, ' ').slice(0, 1200);
  const fromLine = `${from.name || from.email}${from.email && from.name ? ` <${from.email}>` : ''}`;
  const description = `${fromLine}\n\n${snippet}`;
  // Synthesis embed body: header context + snippet. The algorithm
  // doesn't need full HTML — sender + subject + first ~1.2k chars is
  // enough for "knows about your email" semantic retrieval.
  const body = [
    `From: ${fromLine}`,
    headerMap.to ? `To: ${headerMap.to}` : '',
    `Subject: ${subject}`,
    '',
    snippet,
  ].filter(Boolean).join('\n');

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image: '',
    favicon: 'https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png',
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
    tags,
    source,
    createdAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : undefined,
    body,
    embedMetadata: {
      source,
      title,
      url,
      from: from.email || from.name || '',
      subject,
    },
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
  initialMeta: { starred_cursor: null, inbox_cursor: null },
  sync: syncGmail,
});
