// ============================================================================
// server/routes/connections.routes.js — custom connections + concepts v1
// ============================================================================
// Extracted verbatim from server.js (Wave 2 of the server decomposition).
// Handler bodies are unchanged; only the registration moved. Paths, methods,
// middleware chains, and registration order are preserved exactly —
// tests/server/serverRouteManifest.test.mjs enforces this.
//
// Two registrars because registerCustomModelRoutes(...) registers BETWEEN the
// custom-connections block and the concepts block in server.js, and the
// manifest ordering contract requires that position to be preserved.

import {
  listCustomConnections,
  createCustomConnection,
  updateCustomConnection,
  deleteCustomConnection,
  callApp,
  CustomConnectionError,
} from '../../lib/customConnections/customConnections.js';
import { embedAndPersistConcept } from '../../conceptEmbedding.js';

// --- Custom connections (universal bring-your-own-API-key) ----------------
// The user attaches ANY app (base URL + API key + how to send it); the LYKN
// agent then acts on it via lykn_call_app, with the secret injected
// server-side. The secret is write-only from the client's POV — it is never
// returned by these routes (the service strips it).
function _customConnErr(e) {
  if (e instanceof CustomConnectionError || e?.isValidation) {
    return { status: 400, body: { error: 'validation', message: e.message } };
  }
  console.error('❌ custom-connections:', e?.message || e);
  return { status: 500, body: { error: 'internal' } };
}

/**
 * Custom connections (universal bring-your-own-API-key) — 5 routes.
 * @param {import('express').Express} app
 * @param {object} deps bootstrap-owned singletons: requireAuth middleware,
 *   supabaseAdmin client, and the shared connected-tools cache invalidator.
 */
export function registerCustomConnectionsRoutes(app, { requireAuth, supabaseAdmin, invalidateConnectedToolsCache }) {
  app.get('/api/custom-connections', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      const connections = await listCustomConnections(supabaseAdmin, userId);
      return res.json({ ok: true, connections });
    } catch (e) {
      const { status, body } = _customConnErr(e);
      return res.status(status).json(body);
    }
  });

  app.post('/api/custom-connections', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      const connection = await createCustomConnection(supabaseAdmin, userId, req.body || {});
      invalidateConnectedToolsCache(userId);
      return res.json({ ok: true, connection });
    } catch (e) {
      const { status, body } = _customConnErr(e);
      return res.status(status).json(body);
    }
  });

  app.patch('/api/custom-connections/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      const connection = await updateCustomConnection(supabaseAdmin, userId, String(req.params.id || ''), req.body || {});
      if (!connection) return res.status(404).json({ error: 'not_found' });
      invalidateConnectedToolsCache(userId);
      return res.json({ ok: true, connection });
    } catch (e) {
      const { status, body } = _customConnErr(e);
      return res.status(status).json(body);
    }
  });

  app.delete('/api/custom-connections/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      await deleteCustomConnection(supabaseAdmin, userId, String(req.params.id || ''));
      invalidateConnectedToolsCache(userId);
      return res.json({ ok: true });
    } catch (e) {
      const { status, body } = _customConnErr(e);
      return res.status(status).json(body);
    }
  });

  // One-shot test call so the user can verify the credential + base URL work
  // before relying on the agent. Always a GET against the given path (default
  // the base URL itself), so it never triggers a write.
  app.post('/api/custom-connections/:id/test', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      const result = await callApp({
        client: supabaseAdmin,
        userId,
        connection: String(req.params.id || ''),
        method: 'GET',
        path: typeof req.body?.path === 'string' ? req.body.path : '',
      });
      return res.json({ ok: true, result });
    } catch (e) {
      const { status, body } = _customConnErr(e);
      return res.status(status).json(body);
    }
  });
}

/**
 * Concepts v1 (056-058) — 6 routes.
 * @param {import('express').Express} app
 * @param {object} deps bootstrap-owned singletons: requireAuth middleware,
 *   supabaseAdmin client, and createSynthesisUserClient (RLS-scoped client
 *   factory that lives in server.js).
 */
export function registerConceptsRoutes(app, { requireAuth, supabaseAdmin, createSynthesisUserClient }) {
  // --- Concepts (056-058) ---------------------------------------------------
  // First-class concept/topic layer with hybrid AI/user authorship. The
  // nightly jobs/conceptsJob.js writes ai_clustered rows (status='proposed');
  // these endpoints are the user-facing CRUD + the read paths the 3D graph
  // and briefing call. All routes require the JWT requireAuth — concepts
  // are an internal UI surface, not part of the MCP REST contract.
  app.get('/api/v1/concepts', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const client = createSynthesisUserClient(req.headers.authorization) || supabaseAdmin;
      if (!client) return res.status(503).json({ error: 'Database not configured' });
      const { data, error } = await client.rpc('concepts_overview');
      if (error) {
        console.error('[supabase] GET /api/v1/concepts overview', error);
        return res.status(500).json({ error: 'database_error' });
      }
      return res.json({ concepts: data || [] });
    } catch (e) {
      console.error('GET /api/v1/concepts:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/v1/concepts/:id/links', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const conceptId = String(req.params.id || '');
      if (!/^[0-9a-fA-F-]{36}$/.test(conceptId)) {
        return res.status(400).json({ error: 'Invalid concept id' });
      }
      const client = createSynthesisUserClient(req.headers.authorization) || supabaseAdmin;
      if (!client) return res.status(503).json({ error: 'Database not configured' });
      const { data, error } = await client.rpc('concept_links', { p_concept_id: conceptId });
      if (error) {
        console.error('[supabase] GET /api/v1/concepts/:id/links', error);
        return res.status(500).json({ error: 'database_error' });
      }
      return res.json({ links: data || [] });
    } catch (e) {
      console.error('GET /api/v1/concepts/:id/links:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/v1/concepts', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const body = req.body || {};
      const rawLabel = typeof body.label === 'string' ? body.label.trim() : '';
      if (rawLabel.length < 1 || rawLabel.length > 128) {
        return res.status(400).json({ error: 'label must be 1-128 chars' });
      }
      const kind = ['theme', 'topic', 'entity'].includes(body.kind) ? body.kind : 'topic';
      const slug = rawLabel.toLowerCase().replace(/\s+/g, ' ').slice(0, 128);

      // Composer extras (migration 063): { why?, story?, notes? }. Sanitise
      // + cap each documented field; ignore anything else. We compute this
      // up here so both the insert path (new concept) and the bump path
      // (concept already existed) can write the latest metadata blob the
      // user typed — clicking Save with new notes/story/why for an
      // existing concept should not silently drop them.
      const metadataPatch = {};
      if (body?.metadata && typeof body.metadata === 'object') {
        const m = body.metadata;
        if (typeof m.story === 'string') {
          const story = m.story.trim().slice(0, 8000);
          if (story) metadataPatch.story = story;
        }
        if (typeof m.notes === 'string') {
          const notes = m.notes.trim().slice(0, 4000);
          if (notes) metadataPatch.notes = notes;
        }
        if (typeof m.why === 'string') {
          const why = m.why.trim().slice(0, 4000);
          if (why) metadataPatch.why = why;
        }
      }

      const client = createSynthesisUserClient(req.headers.authorization) || supabaseAdmin;
      if (!client) return res.status(503).json({ error: 'Database not configured' });

      // Idempotent: if the user already has a live concept with this
      // slug, return it (status bumped to active and last_touched_at
      // refreshed) — same shape the merge / dismiss path uses.
      const { data: existing } = await client
        .from('lykn_concepts')
        .select('id')
        .eq('user_id', userId)
        .eq('slug', slug)
        .is('merged_into_id', null)
        .maybeSingle();

      if (existing?.id) {
        await client
          .from('lykn_concepts')
          .update({
            status: 'active',
            last_touched_at: new Date().toISOString(),
            ...(Object.keys(metadataPatch).length > 0 ? { metadata: metadataPatch } : {}),
          })
          .eq('id', existing.id)
          .eq('user_id', userId);
        return res.json({ id: existing.id, existed: true });
      }

      const { data: inserted, error: insErr } = await client
        .from('lykn_concepts')
        .insert({
          user_id: userId,
          label: rawLabel,
          slug,
          kind,
          source: 'user_authored',
          status: 'active',
          confidence: 1.0,
          ...(Object.keys(metadataPatch).length > 0 ? { metadata: metadataPatch } : {}),
        })
        .select('id')
        .single();
      if (insErr) {
        console.error('insert concept:', insErr);
        return res.status(400).json({ error: insErr.message });
      }
      // Fire-and-forget embed-on-write.
      embedAndPersistConcept(client, { conceptId: inserted.id, userId, label: rawLabel }).catch(() => {});
      return res.json({ id: inserted.id, existed: false });
    } catch (e) {
      console.error('POST /api/v1/concepts:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  app.patch('/api/v1/concepts/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const conceptId = String(req.params.id || '');
      if (!/^[0-9a-fA-F-]{36}$/.test(conceptId)) {
        return res.status(400).json({ error: 'Invalid concept id' });
      }
      const body = req.body || {};
      const patch = {};
      let didRename = false;
      let newLabel = null;

      if (typeof body.label === 'string') {
        newLabel = body.label.trim();
        if (newLabel.length < 1 || newLabel.length > 128) {
          return res.status(400).json({ error: 'label must be 1-128 chars' });
        }
        patch.label = newLabel;
        patch.slug = newLabel.toLowerCase().replace(/\s+/g, ' ').slice(0, 128);
        didRename = true;
      }
      if (typeof body.status === 'string') {
        if (!['proposed', 'active', 'dismissed'].includes(body.status)) {
          return res.status(400).json({ error: 'invalid status' });
        }
        patch.status = body.status;
        if (body.status === 'dismissed') {
          patch.dismissed_at = new Date().toISOString();
        } else {
          patch.dismissed_at = null;
        }
      }
      if (typeof body.kind === 'string') {
        if (!['theme', 'topic', 'entity'].includes(body.kind)) {
          return res.status(400).json({ error: 'invalid kind' });
        }
        patch.kind = body.kind;
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'no fields to update' });
      }
      patch.last_touched_at = new Date().toISOString();

      const client = createSynthesisUserClient(req.headers.authorization) || supabaseAdmin;
      if (!client) return res.status(503).json({ error: 'Database not configured' });

      const { error: upErr } = await client
        .from('lykn_concepts')
        .update(patch)
        .eq('id', conceptId)
        .eq('user_id', userId);
      if (upErr) {
        console.error('patch concept:', upErr);
        return res.status(400).json({ error: upErr.message });
      }
      if (didRename && newLabel) {
        // Clear stale embedding + re-embed under the new label.
        await client
          .from('lykn_concepts')
          .update({ embedding: null, embedded_at: null })
          .eq('id', conceptId)
          .eq('user_id', userId);
        embedAndPersistConcept(client, { conceptId, userId, label: newLabel }).catch(() => {});
      }
      return res.json({ ok: true });
    } catch (e) {
      console.error('PATCH /api/v1/concepts/:id:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/v1/concepts/:id/merge', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const fromId = String(req.params.id || '');
      const intoId = String(req.body?.into_id || '');
      if (!/^[0-9a-fA-F-]{36}$/.test(fromId) || !/^[0-9a-fA-F-]{36}$/.test(intoId)) {
        return res.status(400).json({ error: 'Invalid id(s)' });
      }
      const client = createSynthesisUserClient(req.headers.authorization) || supabaseAdmin;
      if (!client) return res.status(503).json({ error: 'Database not configured' });

      const { data, error } = await client.rpc('merge_concepts', {
        from_id: fromId,
        into_id: intoId,
      });
      if (error) {
        console.error('[supabase] POST /api/v1/concepts/:id/merge', error);
        return res.status(500).json({ error: 'database_error' });
      }
      return res.json({ merged_rows: data });
    } catch (e) {
      console.error('POST /api/v1/concepts/:id/merge:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/v1/concepts/:id/link', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const conceptId = String(req.params.id || '');
      if (!/^[0-9a-fA-F-]{36}$/.test(conceptId)) {
        return res.status(400).json({ error: 'Invalid concept id' });
      }
      const targetKind = String(req.body?.target_kind || '');
      const targetId = String(req.body?.target_id || '');
      if (!/^[0-9a-fA-F-]{36}$/.test(targetId)) {
        return res.status(400).json({ error: 'Invalid target id' });
      }
      const table = ({
        note: 'concept_notes',
        fact: 'concept_facts',
        belief: 'concept_beliefs',
        chat: 'concept_chats',
      })[targetKind];
      const column = ({
        note: 'note_id',
        fact: 'fact_id',
        belief: 'belief_id',
        chat: 'chat_id',
      })[targetKind];
      if (!table || !column) {
        return res.status(400).json({ error: 'invalid target_kind' });
      }
      const client = createSynthesisUserClient(req.headers.authorization) || supabaseAdmin;
      if (!client) return res.status(503).json({ error: 'Database not configured' });

      const row = {
        user_id: userId,
        concept_id: conceptId,
        [column]: targetId,
        weight: 1.0,
        source: 'user',
      };
      const { error } = await client
        .from(table)
        .upsert(row, {
          onConflict: `user_id,concept_id,${column}`,
          ignoreDuplicates: false,
        });
      if (error) {
        console.error(`[supabase] POST /api/v1/concepts/:id/link upsert ${table}`, error);
        return res.status(500).json({ error: 'database_error' });
      }
      return res.json({ ok: true });
    } catch (e) {
      console.error('POST /api/v1/concepts/:id/link:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
