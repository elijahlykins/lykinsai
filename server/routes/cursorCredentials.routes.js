import {
  CREDENTIAL_TYPES,
  createSupabaseCredentialStore,
  decryptToken,
} from '../../lib/security/credentialStore.js';
import {
  CursorCredentialError,
  fetchCursorIdentity,
  validateCursorCredential,
} from '../../lib/cursor/cursorCredential.js';

function toConnection(credential) {
  return {
    id: credential.id,
    provider: 'cursor',
    account_handle: credential.metadata?.key_name || 'cursor',
    account_display_name: credential.label || 'Cursor Cloud',
    account_email: credential.metadata?.account_email || null,
    status: credential.status,
    metadata: {
      default_repo: credential.metadata?.default_repo || null,
    },
    created_at: credential.createdAt,
    updated_at: credential.updatedAt,
  };
}

export function registerCursorCredentialRoutes(app, { requireAuth, supabaseAdmin }) {
  app.get('/api/cursor/credentials/connect-info', requireAuth, (_req, res) => {
    return res.json({
      tokenHelpUrl: 'https://cursor.com/dashboard',
      tokenHelpLabel: 'Open Cursor Dashboard → Integrations → create an API key',
      message:
        'Generate a Cursor API key with Cloud Agents access and paste it here. The key is encrypted and used only by the trusted Cursor build runtime.',
    });
  });

  app.get('/api/cursor/credentials', requireAuth, async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database unavailable' });
      const store = createSupabaseCredentialStore(supabaseAdmin);
      let rows = await store.list(req.user.id, {
        type: CREDENTIAL_TYPES.CURSOR_CLOUD_API_KEY,
      });
      if (rows.length === 0) {
        const { data: legacy } = await supabaseAdmin
          .from('social_connections')
          .select('id, access_token, account_display_name, account_email, metadata')
          .eq('user_id', req.user.id)
          .eq('provider', 'cursor')
          .eq('status', 'active')
          .order('updated_at', { ascending: false })
          .limit(1);
        const row = legacy?.[0];
        if (row?.access_token) {
          const migrated = await store.put(req.user.id, {
            type: CREDENTIAL_TYPES.CURSOR_CLOUD_API_KEY,
            secret: decryptToken(row.access_token),
            label: row.account_display_name || row.account_email || 'Cursor Cloud',
            metadata: {
              ...(row.metadata || {}),
              account_email: row.account_email || null,
              migrated_from_social_connection_id: row.id,
            },
          });
          rows = [migrated];
        }
      }
      return res.json({ connections: rows.map(toConnection) });
    } catch (error) {
      console.error('[cursorCredentials] list failed:', error?.message || error);
      return res.status(500).json({ error: 'Could not load Cursor credentials' });
    }
  });

  app.post('/api/cursor/credentials', requireAuth, async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database unavailable' });
      const validated = await validateCursorCredential(req.body || {});
      const store = createSupabaseCredentialStore(supabaseAdmin);
      const existing = await store.findActive(
        req.user.id,
        CREDENTIAL_TYPES.CURSOR_CLOUD_API_KEY,
      );
      const saved = existing
        ? await store.update(req.user.id, existing.id, validated)
        : await store.put(req.user.id, {
            type: CREDENTIAL_TYPES.CURSOR_CLOUD_API_KEY,
            ...validated,
          });
      return res.json({ connection: toConnection(saved) });
    } catch (error) {
      const safe = error instanceof CursorCredentialError || error?.isUserFacing;
      if (!safe) console.error('[cursorCredentials] save failed:', error?.message || error);
      return res.status(400).json({
        error: safe ? error.message : 'Could not save Cursor credential',
      });
    }
  });

  app.post('/api/cursor/credentials/:id/validate', requireAuth, async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      const store = createSupabaseCredentialStore(supabaseAdmin);
      const credential = await store.get(req.user.id, req.params.id, {
        includeSecret: true,
      });
      if (!credential || credential.type !== CREDENTIAL_TYPES.CURSOR_CLOUD_API_KEY) {
        return res.status(404).json({ error: 'Credential not found' });
      }
      await fetchCursorIdentity(credential.secret);
      await store.update(req.user.id, credential.id, {
        status: 'active',
        lastUsedAt: new Date().toISOString(),
      });
      return res.json({ ok: true, saved: 0, skipped: 0 });
    } catch (error) {
      if (error instanceof CursorCredentialError || error?.isUserFacing) {
        return res.status(401).json({ error: error.message, status: 'reauth' });
      }
      return res.status(500).json({ error: 'Credential validation failed' });
    }
  });

  app.patch('/api/cursor/credentials/:id', requireAuth, async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      const status = req.body?.status;
      if (!['active', 'paused'].includes(status)) {
        return res.status(400).json({ error: 'status must be active or paused' });
      }
      const updated = await createSupabaseCredentialStore(supabaseAdmin).update(
        req.user.id,
        req.params.id,
        { status },
      );
      if (!updated) return res.status(404).json({ error: 'Credential not found' });
      return res.json({ connection: toConnection(updated) });
    } catch {
      return res.status(500).json({ error: 'Credential update failed' });
    }
  });

  app.delete('/api/cursor/credentials/:id', requireAuth, async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      await createSupabaseCredentialStore(supabaseAdmin).remove(req.user.id, req.params.id);
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Credential delete failed' });
    }
  });
}
