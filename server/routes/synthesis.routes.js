// ============================================================================
// server/routes/synthesis.routes.js — retained vault retrieval maintenance
// ============================================================================
// Extracted verbatim from server.js (Wave 2 of the server decomposition).
// Handler bodies are unchanged; only the registration moved. Paths, methods,
// middleware chains, and registration order are preserved exactly —
// tests/server/serverRouteManifest.test.mjs enforces this.
//
// Two registrars:
//   • registerSynthesisRoutes — legacy-named vault retrieval reindex/purge.
//   • registerSynthesisMaintenanceRoutes — /api/vault/enrich-note,
//     /api/vault/reconcile, and /api/synthesis/backfill. In server.js these
//     three had helper *definitions* (not registrations) between them, so one
//     registrar at the original enrich-note position preserves stack order.
//     Helpers exclusively used by these routes moved into the registrar
//     closure (bodies unchanged, single instance — the registrar runs once);
//     helpers shared with enrichVaultNoteSummary/notes-ingest stayed in
//     server.js and are passed in.
//
import crypto from 'crypto';
import { chunkTextForSynthesis } from '../../synthesis-service.js';
import { runVaultReconciler } from '../../jobs/vaultReconcilerJob.js';
import { getUserRowById } from '../../lib/security/userOwnedAccess.js';

// Moved with the reindex/purge routes — they are its only consumers.
const SYNTHESIS_ALLOWED_SOURCES = new Set(['vault_note', 'grid_board', 'conversation_exchange']);

/**
 * Vault retrieval index routes retained under their existing API paths.
 * @param {import('express').Express} app
 * @param {object} deps bootstrap-owned singletons from server.js: auth/access
 *   middleware, the synthesis rate limiter, the Supabase
 *   admin client, and the shared server-local synthesis service functions
 *   (passed, not moved, because other server.js call sites still use them).
 */
export function registerSynthesisRoutes(app, {
  requireAuth,
  requireAppAccess,
  synthesisLimiter,
  supabaseAdmin,
  createSynthesisUserClient,
  deleteSynthesisChunksForSource,
  replaceSynthesisChunks,
}) {
  app.post('/api/synthesis/reindex', requireAuth, requireAppAccess, synthesisLimiter, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const { sourceType, sourceId, text, metadata = {} } = req.body || {};
      if (!SYNTHESIS_ALLOWED_SOURCES.has(String(sourceType))) {
        return res.status(400).json({ error: 'Invalid sourceType' });
      }
      const sid = String(sourceId || '').trim();
      if (!sid || sid.length > 200) return res.status(400).json({ error: 'Invalid sourceId' });

      // Source-id ownership check. Without this, an authenticated user can
      // pollute their own retrieval space with embeddings keyed to arbitrary
      // (or non-existent) `vault_note` ids, burn embed quota, and confuse
      // future RAG queries. We only verify what we can: vault notes live in
      // vault_items; conversation exchanges + grid boards have their
      // own checks downstream (board ids are user-prefixed; conversation
      // exchanges resolve via the user's own session).
      if (sourceType === 'vault_note') {
        if (!supabaseAdmin) {
          return res.status(503).json({ error: 'Database not configured' });
        }
        const { data: owned, error: ownErr } = await getUserRowById(
          supabaseAdmin,
          'vault_items',
          userId,
          sid,
          'id',
        );
        if (ownErr) {
          console.error('❌ Synthesis reindex ownership check:', ownErr?.message || ownErr);
          return res.status(500).json({ error: 'Reindex failed' });
        }
        if (!owned) return res.status(404).json({ error: 'Source not found' });
      }

      if (!process.env.OPENAI_API_KEY) {
        return res.status(503).json({ error: 'Embeddings not configured' });
      }

      const chunks = chunkTextForSynthesis(String(text || ''));
      if (chunks.length === 0) {
        if (supabaseAdmin) {
          await deleteSynthesisChunksForSource(supabaseAdmin, userId, sourceType, sid);
        } else {
          const uc = createSynthesisUserClient(req.headers.authorization);
          if (!uc) return res.status(503).json({ error: 'Database not configured' });
          await deleteSynthesisChunksForSource(uc, userId, sourceType, sid);
        }
        return res.json({ ok: true, chunks: 0, cleared: true });
      }
      const meta = metadata && typeof metadata === 'object' ? metadata : {};
      const n = await replaceSynthesisChunks(userId, req.headers.authorization, sourceType, sid, chunks, meta, String(text || ''));
      console.log(`📚 Synthesis reindexed ${sourceType}/${sid}: ${n} chunk(s)`);
      return res.json({ ok: true, chunks: n });
    } catch (e) {
      console.error('❌ Synthesis reindex:', e?.message || e);
      return res.status(500).json({ error: 'Reindex failed' });
    }
  });

  app.post('/api/synthesis/purge', requireAuth, synthesisLimiter, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const { sourceType, sourceId } = req.body || {};
      if (!SYNTHESIS_ALLOWED_SOURCES.has(String(sourceType))) {
        return res.status(400).json({ error: 'Invalid sourceType' });
      }
      const sid = String(sourceId || '').trim();
      if (!sid || sid.length > 200) return res.status(400).json({ error: 'Invalid sourceId' });
      if (supabaseAdmin) {
        await deleteSynthesisChunksForSource(supabaseAdmin, userId, sourceType, sid);
      } else {
        const uc = createSynthesisUserClient(req.headers.authorization);
        if (!uc) return res.status(503).json({ error: 'Database not configured' });
        await deleteSynthesisChunksForSource(uc, userId, sourceType, sid);
      }
      return res.json({ ok: true });
    } catch (e) {
      console.error('❌ Synthesis purge:', e?.message || e);
      return res.status(500).json({ error: 'Purge failed' });
    }
  });

}

/**
 * Synthesis maintenance band — enrich-note, vault reconcile, backfill.
 * @param {import('express').Express} app
 * @param {object} deps bootstrap-owned singletons from server.js, including
 *   enrichVaultNoteSummary + backfillVaultText (shared with the notes-ingest
 *   path and the server.js export contract, so they stay in server.js).
 */
export function registerSynthesisMaintenanceRoutes(app, {
  requireAuth,
  requireAppAccess,
  synthesisLimiter,
  supabaseAdmin,
  createSynthesisUserClient,
  safeErr,
  enrichVaultNoteSummary,
  backfillVaultText,
  replaceSynthesisChunks,
}) {
  function verifyBackfillSecret(req) {
    const expected = process.env.BACKFILL_SECRET;
    if (!expected || String(expected).length < 32) return false;
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return false;
    try {
      const a = Buffer.from(token, 'utf8');
      const b = Buffer.from(String(expected), 'utf8');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  // Second, independent gate for the vault reconciler's DESTRUCTIVE mode. The
  // endpoint bearer is BACKFILL_SECRET (shared with /api/synthesis/backfill), so
  // on its own a single leaked bearer would authorize permanent deletion. The
  // delete path additionally requires a distinct VAULT_RECONCILER_DELETE_SECRET,
  // presented in the `X-Reconciler-Delete-Token` header — a separate secret that
  // is not reused by any read path. Compared timing-safe; fails closed when unset.
  function verifyReconcilerDeleteSecret(req) {
    const expected = process.env.VAULT_RECONCILER_DELETE_SECRET;
    if (!expected || String(expected).length < 32) return false;
    const token = String(req.headers['x-reconciler-delete-token'] || '').trim();
    if (!token) return false;
    try {
      const a = Buffer.from(token, 'utf8');
      const b = Buffer.from(String(expected), 'utf8');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  const backfillSleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function backfillTake(s, max) {
    const x = String(s || '')
      .replace(/\s+/g, ' ')
      .trim();
    return x.length <= max ? x : `${x.slice(0, max)}…`;
  }

  /** Mirrors src/lib/synthesis/sourceText.ts snapshotToSynthesisText for server-side backfill. */
  function backfillSnapshotToText(snapshot) {
    const lines = [];
    const title = String(snapshot?.title || '').trim();
    if (title) lines.push(`Board: ${title}`);
    const blocks = snapshot?.blocks || {};
    const order = Array.isArray(snapshot?.blockOrder) ? snapshot.blockOrder : Object.keys(blocks);
    for (const id of order.slice(0, 120)) {
      const b = blocks[id];
      if (!b) continue;
      const type = String(b.type || '');
      if (type === 'text') {
        const fmt = String(b.format || 'plain');
        const c = backfillTake(String(b.content || ''), 4000);
        if (c) lines.push(`[text ${fmt}] ${c}`);
      } else if (type === 'create') {
        const mode = String(b.mode || '').toLowerCase();
        const data = b.data || {};
        if (mode === 'video') {
          const url = String(data.url || b.url || '');
          const vid = String(data.videoId || b.videoId || '');
          if (url || vid) lines.push(`[video] ${vid || url}`);
        } else if (mode === 'embed' || mode === 'file') {
          lines.push(
            `[file] ${backfillTake(String(data.name || data.title || ''), 200)} ${backfillTake(String(data.url || ''), 500)}`,
          );
        } else if (mode === 'image' || mode === 'generated') {
          lines.push(`[image] ${backfillTake(String(data.title || data.name || ''), 200)}`);
        } else {
          const tx = backfillTake(String(data.title || data.content || mode || ''), 1500);
          if (tx) lines.push(`[create ${mode}] ${tx}`);
        }
      } else if (type === 'youtube' || type === 'link') {
        lines.push(`[${type}] ${backfillTake(String(b.url || (b.data && b.data.url) || ''), 800)}`);
      } else if (type === 'image') {
        lines.push(`[image] ${backfillTake(String(b.src || ''), 300)}`);
      } else {
        const c = backfillTake(String(b.content || (b.data && b.data.content) || ''), 2000);
        if (c) lines.push(`[${type}] ${c}`);
      }
    }
    const wires = Array.isArray(snapshot?.wireConnections) ? snapshot.wireConnections : [];
    if (wires.length) {
      lines.push(
        `Connections: ${wires
          .slice(0, 40)
          .map((w) => `${w.fromId}->${w.toId}`)
          .join('; ')}`,
      );
    }
    return lines.join('\n').slice(0, 120_000);
  }

  async function collectBackfillUserIds(singleUserId) {
    if (singleUserId && String(singleUserId).trim()) return [String(singleUserId).trim()];
    const set = new Set();
    const add = (rows, key) => {
      for (const r of rows || []) {
        if (r && r[key]) set.add(String(r[key]));
      }
    };
    const { data: n } = await supabaseAdmin.from('vault_items').select('user_id');
    add(n, 'user_id');
    const { data: b } = await supabaseAdmin.from('lykn_chats').select('user_id');
    add(b, 'user_id');
    const { data: m } = await supabaseAdmin.from('ai_conversation_memory').select('user_id');
    add(m, 'user_id');
    return [...set];
  }

  /**
   * Post-save: LLM summary + signals on notes row, then re-embed vault_note for retrieval.
   * Requires migration 025 (ai_summary, ai_signals on notes).
   */
  app.post('/api/vault/enrich-note', requireAuth, requireAppAccess, synthesisLimiter, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const noteId = String(req.body?.noteId || '').trim();
      if (!noteId) return res.status(400).json({ error: 'noteId required' });

      const client = createSynthesisUserClient(req.headers.authorization) || supabaseAdmin;
      if (!client) return res.status(503).json({ error: 'Database not configured' });

      const result = await enrichVaultNoteSummary({ userId, noteId, supabaseAdmin: client });
      if (!result.ok) {
        // Map internal reasons → HTTP responses. Keep the surface narrow
        // so we don't leak Postgres error text to clients.
        const reason = result.reason || 'enrich_failed';
        if (reason === 'openai_key_missing') return res.status(503).json({ error: 'LLM not configured' });
        if (reason === 'not_found')          return res.status(404).json({ error: 'Note not found' });
        if (reason === 'llm_failed')         return res.status(502).json({ error: 'enrich_llm_failed' });
        if (reason === 'parse_failed')       return res.status(502).json({ error: 'enrich_parse_failed' });
        if (reason === 'columns_missing')    return res.status(503).json({ error: 'notes_ai_columns_missing', hint: result.hint });
        return res.status(500).json({ error: reason });
      }
      if (result.skipped) return res.json({ ok: true, skipped: true, reason: result.reason });

      // Re-embed for synthesis retrieval with the new summary prepended to
      // the chunk corpus — improves retrieval precision because the summary
      // acts as a dense per-chunk semantic key.
      const { data: noteAfter } = await getUserRowById(
        client,
        'vault_items',
        userId,
        noteId,
        'title, content',
      );
      if (noteAfter) {
        const baseText = backfillVaultText(noteAfter.title, noteAfter.content);
        const embedRaw = result.summary ? `Summary (AI):\n${result.summary}\n\n${baseText}` : baseText;
        const chunks = chunkTextForSynthesis(embedRaw);
        if (chunks.length) {
          const n = await replaceSynthesisChunks(userId, req.headers.authorization, 'vault_note', noteId, chunks, {
            title: noteAfter.title,
            vaultEnriched: true,
          });
          return res.json({ ok: true, chunks: n, enriched: true });
        }
      }
      return res.json({ ok: true, chunks: 0, enriched: true });
    } catch (e) {
      console.error('❌ vault enrich-note:', e?.message || e);
      return res.status(500).json({ error: 'enrich_failed' });
    }
  });

  // Vault upload reconciler — cron-triggered backstop for the orphan-upload
  // race (see jobs/vaultReconcilerJob.js). Bearer-authed with the same operator
  // secret as the synthesis backfill. SAFE BY DEFAULT: dry-run unless the body
  // opts in. Destructive leaked-file deletion is double-gated — the request must
  // set deleteLeaked AND the server must have VAULT_RECONCILER_DELETE_ENABLED=1.
  app.post('/api/vault/reconcile', async (req, res) => {
    if (!verifyBackfillSecret(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'SUPABASE_SERVICE_ROLE_KEY required for reconcile' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const apply = body.apply === true || body.dryRun === false;
    const deleteEnabled = String(process.env.VAULT_RECONCILER_DELETE_ENABLED || '') === '1';
    // Destructive delete requires ALL THREE: the request flag, the env enable,
    // and a valid dedicated delete secret (distinct from the endpoint bearer).
    // A leaked BACKFILL_SECRET alone can no longer trigger deletion.
    const deleteRequested = body.deleteLeaked === true;
    const deleteSecretOk = verifyReconcilerDeleteSecret(req);
    if (deleteRequested && deleteEnabled && !deleteSecretOk) {
      return res.status(403).json({
        error: 'Destructive reconcile requires a valid X-Reconciler-Delete-Token',
      });
    }
    const deleteLeaked = deleteRequested && deleteEnabled && deleteSecretOk;
    const toInt = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

    try {
      const summary = await runVaultReconciler({
        dryRun: !apply,
        deleteLeaked,
        graceMinutes: toInt(body.graceMinutes, undefined),
        leakGraceMinutes: toInt(body.leakGraceMinutes, undefined),
        bucket: typeof body.bucket === 'string' ? body.bucket : undefined,
      });
      return res.json({
        ok: true,
        // Surface when a destructive delete was requested but refused by config,
        // so an operator isn't surprised that nothing was deleted.
        deleteLeakedRequested: body.deleteLeaked === true,
        deleteLeakedEnabled: deleteEnabled,
        summary,
      });
    } catch (err) {
      console.error('❌ /api/vault/reconcile:', err?.stack || err?.message || err);
      return res.status(500).json({ error: safeErr(err, 'reconcile_failed') });
    }
  });

  app.post('/api/synthesis/backfill', async (req, res) => {
    if (!verifyBackfillSecret(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'SUPABASE_SERVICE_ROLE_KEY required for backfill' });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ error: 'OPENAI_API_KEY required for backfill' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const userIdFilter = body.userId ? String(body.userId).trim() : '';
    const allSources = ['vault_note', 'grid_board', 'conversation_exchange'];
    let sources = Array.isArray(body.sources) && body.sources.length ? body.sources.map((s) => String(s)) : allSources;
    sources = sources.filter((s) => allSources.includes(s));
    if (!sources.length) sources = allSources;

    const errors = [];
    let usersProcessed = 0;
    let chunksWritten = 0;

    try {
      const userIds = await collectBackfillUserIds(userIdFilter);
      if (!userIds.length) {
        return res.json({ ok: true, usersProcessed: 0, chunksWritten: 0, errors: [], message: 'no_users_found' });
      }

      for (const uid of userIds) {
        usersProcessed += 1;
        console.log(`📊 Backfill: start user ${String(uid).slice(0, 8)}… sources=${sources.join(',')}`);

        if (sources.includes('vault_note')) {
          let from = 0;
          const page = 200;
          for (;;) {
            const { data: notes, error: nErr } = await supabaseAdmin
              .from('vault_items')
              .select('id, title, content')
              .eq('user_id', uid)
              .range(from, from + page - 1);
            if (nErr) {
              errors.push({ userId: uid, source: 'vault_note', sourceId: '*', error: nErr.message });
              break;
            }
            if (!notes?.length) break;
            for (const note of notes) {
              try {
                const text = backfillVaultText(note.title, note.content);
                const chunks = chunkTextForSynthesis(text);
                if (!chunks.length) continue;
                const n = await replaceSynthesisChunks(uid, null, 'vault_note', String(note.id), chunks, {
                  backfill: true,
                  title: note.title,
                });
                chunksWritten += n;
              } catch (e) {
                errors.push({
                  userId: uid,
                  source: 'vault_note',
                  sourceId: String(note.id),
                  error: e?.message || String(e),
                });
              }
              await backfillSleep(50);
            }
            if (notes.length < page) break;
            from += page;
          }
        }

        if (sources.includes('grid_board')) {
          const { data: boards, error: bErr } = await supabaseAdmin
            .from('lykn_chats')
            .select('id, title')
            .eq('user_id', uid);
          if (bErr) {
            errors.push({ userId: uid, source: 'grid_board', sourceId: '*', error: bErr.message });
          } else {
            for (const br of boards || []) {
              try {
                const { data: stRows } = await supabaseAdmin
                  .from('lykn_chat_states')
                  .select('state')
                  .eq('chat_id', br.id)
                  .order('updated_at', { ascending: false })
                  .limit(1);
                const stRow = Array.isArray(stRows) && stRows[0] ? stRows[0] : null;
                const snap = { ...(stRow?.state || {}), title: br.title || stRow?.state?.title || 'Untitled' };
                const text = backfillSnapshotToText(snap);
                const chunks = chunkTextForSynthesis(text);
                if (!chunks.length) continue;
                const n = await replaceSynthesisChunks(uid, null, 'grid_board', String(br.id), chunks, {
                  backfill: true,
                  title: br.title,
                });
                chunksWritten += n;
              } catch (e) {
                errors.push({
                  userId: uid,
                  source: 'grid_board',
                  sourceId: String(br.id),
                  error: e?.message || String(e),
                });
              }
              await backfillSleep(50);
            }
          }
        }

        if (sources.includes('conversation_exchange')) {
          let cfrom = 0;
          const cpage = 200;
          for (;;) {
            const { data: mems, error: mErr } = await supabaseAdmin
              .from('ai_conversation_memory')
              .select('id, user_message, assistant_message')
              .eq('user_id', uid)
              .range(cfrom, cfrom + cpage - 1);
            if (mErr) {
              errors.push({ userId: uid, source: 'conversation_exchange', sourceId: '*', error: mErr.message });
              break;
            }
            if (!mems?.length) break;
            for (const row of mems) {
              try {
                const text = `User:\n${String(row.user_message || '').slice(0, 8000)}\n\nAssistant:\n${String(row.assistant_message || '').slice(0, 8000)}`;
                const chunks = chunkTextForSynthesis(text);
                if (!chunks.length) continue;
                const n = await replaceSynthesisChunks(uid, null, 'conversation_exchange', String(row.id), chunks, {
                  backfill: true,
                });
                chunksWritten += n;
              } catch (e) {
                errors.push({
                  userId: uid,
                  source: 'conversation_exchange',
                  sourceId: String(row.id),
                  error: e?.message || String(e),
                });
              }
              await backfillSleep(50);
            }
            if (mems.length < cpage) break;
            cfrom += cpage;
          }
        }

        console.log(`📊 Backfill: done user ${String(uid).slice(0, 8)}… cumulative_chunks=${chunksWritten}`);
      }

      return res.json({
        ok: true,
        usersProcessed,
        chunksWritten,
        errors,
      });
    } catch (e) {
      console.error('❌ Synthesis backfill:', e?.message || e);
      return res.status(500).json({ error: 'backfill_failed', detail: e?.message, errors });
    }
  });
}
