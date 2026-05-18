// ============================================================================
// connectors/_save.js — Shared "insert + embed" helper for connector adapters
// ============================================================================
// Every non-Google connector adapter (GitHub, Reddit, Slack, Linear, Todoist,
// Trello, Outlook, X, Bluesky, Mastodon, Pinterest, Raindrop, Readwise,
// Spotify, Vimeo, Canva, Dribbble) used to do the same dance inline:
//
//   1. SELECT id WHERE content ILIKE '%<url>%' LIMIT 1
//   2. If row exists → 'skipped'.
//   3. Otherwise INSERT into notes with the canonical
//      `<title>\n\n[ATTACHMENTS_JSON:[{...}]]` content layout.
//   4. On insert error, fall back to a minimal-column insert (just user_id,
//      title, content) so caps-trigger / column-mismatch errors still let
//      the row land in the vault.
//   5. Return 'saved' / 'skipped'.
//
// That worked for the vault UI, but it left two gaps:
//
//   • No upsert. Linear issue descriptions, Slack message edits, Trello
//     card moves, etc. all silently went stale because the dedupe path
//     dropped every subsequent edit on the floor. Notion + Google had
//     already moved to upsert; everyone else was still skip-on-URL.
//
//   • No `embedAndStoreChunks`. The synthesis layer's vector retrieval
//     (`lykn_synthesis_chunks`) was populated only for Notion + the
//     Google adapters. Slack saved messages, Linear issues, Readwise
//     highlights, etc. lived in `notes` but were invisible to chat
//     semantic retrieval — they could only be found via substring
//     search, not "find me anything related to X."
//
// This helper closes both gaps in one place. Each adapter now passes its
// per-item shape (title / attachment / tags / source / optional body) and
// the helper handles the upsert + fire-and-forget embed path consistently.
//
// Behavior:
//   • Dedupe by `dedupeNeedle` (defaults to `url`). Adapters with a
//     non-URL identity (Trello shortLink, X tweet id, Bluesky rkey,
//     Mastodon status id, Canva design id) pass that fragment instead.
//   • If the row already exists and `mode === 'upsert'` (default), the
//     helper UPDATEs `title` + `content` + `updated_at` whenever the
//     content has actually changed (no-op write skipped via direct
//     content compare). When `mode === 'skip-if-exists'`, the helper
//     preserves the legacy "saved once, never overwrite" semantics for
//     adapters where upstream items are append-only and shouldn't churn.
//   • After the row is inserted/updated, fires `embedAndStoreChunks`
//     against `lykn_synthesis_chunks` with `source_type: 'vault_note'`.
//     This is fire-and-forget: an OpenAI 429 / outage logs a warning
//     but never breaks the connector sync. Embedding text is
//     `body || (title + attachment.description)` — adapters that have
//     real text (issue description, message body, article excerpt)
//     should pass `body` for richer retrieval.
//
// Returns 'saved' (new row), 'updated' (existing row's content
// refreshed), or 'skipped' (no needle, insert failed, or no-op).
// ============================================================================

import { embedAndStoreChunks } from '../synthesis-service.js';

/**
 * @param {object} args
 * @param {object} args.supabaseAdmin   service-role client (required)
 * @param {string} args.userId          owner of the new note
 * @param {string} [args.dedupeNeedle]  substring to ILIKE-match on
 *                                      `notes.content` for dedupe.
 *                                      Defaults to `url`.
 * @param {string} args.url             canonical bookmark URL (used as
 *                                      embed metadata + default needle).
 * @param {string} args.title           note title
 * @param {object} args.attachment      bookmark JSON to wrap in the
 *                                      `[ATTACHMENTS_JSON:[...]]` marker
 * @param {string[]} args.tags          tags array (no auto-defaults)
 * @param {string} args.source          `notes.source` slug (e.g.
 *                                      'linear_issue', 'slack_saved')
 * @param {string} [args.createdAt]     ISO timestamp; falls back to
 *                                      column default (now()) when omitted
 * @param {string} [args.body]          plain-text body to embed. When
 *                                      present it's also appended to
 *                                      `notes.content` after the
 *                                      attachments marker so substring
 *                                      search finds it too.
 * @param {object} [args.embedMetadata] per-chunk metadata for
 *                                      `lykn_synthesis_chunks.metadata`
 *                                      (defaults to {source, title, url}).
 * @param {'upsert'|'skip-if-exists'} [args.mode]
 *                                      'upsert' (default) reflects
 *                                      upstream edits; 'skip-if-exists'
 *                                      preserves legacy never-overwrite
 *                                      semantics.
 * @returns {Promise<'saved'|'updated'|'skipped'>}
 */
export async function saveConnectorNote({
  supabaseAdmin,
  userId,
  dedupeNeedle,
  url,
  title,
  attachment,
  tags,
  source,
  createdAt,
  body = '',
  embedMetadata = null,
  mode = 'upsert',
}) {
  const needle = dedupeNeedle || url;
  if (!needle) return 'skipped';

  const attachmentsLine = `[ATTACHMENTS_JSON:${JSON.stringify([attachment])}]`;
  const noteContent = body
    ? [title, '', attachmentsLine, '\n' + body].join('\n').trim()
    : `${title}\n\n${attachmentsLine}`;

  const { data: existingRows } = await supabaseAdmin
    .from('notes')
    .select('id, content')
    .eq('user_id', userId)
    .ilike('content', `%${needle}%`)
    .limit(1);
  const existing = existingRows && existingRows[0];

  let noteId = existing?.id || null;
  let resultMode = existing ? 'updated' : 'saved';

  if (existing) {
    if (mode === 'skip-if-exists') {
      resultMode = 'skipped';
    } else if (String(existing.content || '') === noteContent) {
      // Upstream item hasn't changed since last sync; no write.
      resultMode = 'skipped';
    } else {
      const { error: updErr } = await supabaseAdmin
        .from('notes')
        .update({
          title,
          content: noteContent,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .eq('user_id', userId);
      if (updErr) {
        console.error(`[${source}] note update failed for ${needle}:`, updErr.message);
        return 'skipped';
      }
    }
  } else {
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('notes')
      .insert({
        user_id: userId,
        title,
        content: noteContent,
        source,
        tags,
        created_at: createdAt,
      })
      .select('id')
      .single();
    if (insErr) {
      // Fallback: caps trigger / column error → degrade to a minimal
      // insert with no source/tags so the user at least sees the row.
      const { data: insFallback, error: err2 } = await supabaseAdmin
        .from('notes')
        .insert({ user_id: userId, title, content: noteContent })
        .select('id')
        .single();
      if (err2) {
        console.error(`[${source}] note insert failed for ${needle}:`, err2.message);
        return 'skipped';
      }
      noteId = insFallback?.id || null;
    } else {
      noteId = inserted?.id || null;
    }
  }

  // Fire-and-forget synthesis embed. We always try to embed (even on
  // 'skipped' / no body) because the chunk store is keyed on
  // (user_id, source_type, source_id, chunk_index) and the helper is
  // hash-skip idempotent — running it on every sync is essentially
  // free for unchanged items but guarantees freshly-renamed Linear
  // issues / re-described Slack threads / re-tagged Raindrop bookmarks
  // / etc. land in the vector store the same tick we update the vault.
  if (noteId) {
    const embedText = body
      ? `${title}\n\n${body}`.trim()
      : `${title}\n\n${attachment?.description || ''}`.trim();
    if (embedText && embedText.length >= 8) {
      try {
        const result = await embedAndStoreChunks({
          supabaseAdmin,
          userId,
          sourceType: 'vault_note',
          sourceId: noteId,
          text: embedText,
          metadata: embedMetadata || { source, title, url: url || '' },
        });
        if (!result.ok && result.reason && result.reason !== 'openai_key_missing') {
          console.warn(`[${source}] embed failed for ${url || needle}: ${result.reason}`);
        }
      } catch (err) {
        // Embedding is best-effort; never let an OpenAI 429 break sync.
        console.warn(`[${source}] embed threw for ${url || needle}: ${err.message}`);
      }
    }
  }

  return resultMode;
}
