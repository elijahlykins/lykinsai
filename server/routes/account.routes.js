// ACCOUNT ROUTES — extracted verbatim from server.js (Wave 4).
//
// 7 routes: account preferences GET/PATCH, night-shift briefs GET,
// steward items GET/POST/PATCH, and DELETE /api/account (full lifecycle
// teardown: Stripe cancel, storage purge, Apple token revoke, auth delete).
//
// Dependency notes:
// - requireAuth / supabaseAdmin / stripe are bootstrap-owned singletons.
// - revokeAppleToken is a stateless helper from lib/appleAuth.js; ESM
//   module-cache identity makes a direct import equivalent.
import { revokeAppleToken } from '../../lib/appleAuth.js';

export function registerAccountRoutes(app, deps) {
  const {
    requireAuth,
    supabaseAdmin,
    stripe,
  } = deps;

  // =====================================================================
  // ACCOUNT — preferences + lifecycle
  // =====================================================================
  // These endpoints back the Settings page sections that need server
  // authority (privacy toggles that the cron must honour, account
  // deletion that has to cascade through Stripe + storage + auth).
  //
  // Display name + password changes are *not* here — the client calls
  // supabase.auth.updateUser({ data, password }) directly so we don't
  // have to proxy auth state.

  // ---- Preferences shape -----------------------------------------------
  // Centralised so GET and PATCH return the same field set and the
  // PATCH validator can reject unknown keys. Keep in sync with
  // migration 060_user_preferences.sql.
  const USER_PREFERENCE_DEFAULTS = Object.freeze({
    memory_paused: false,
    training_opt_out: false,
    chat_retention_days: null,
    email_product_updates: true,
    night_shift_enabled: false,
    night_shift_tier: 'brief',
    metadata: {},
  });

  function sanitisePreferencesPatch(body) {
    const out = {};
    if (!body || typeof body !== 'object') return { ok: false, reason: 'body_required' };

    if ('memory_paused' in body) {
      if (typeof body.memory_paused !== 'boolean') return { ok: false, reason: 'memory_paused_must_be_boolean' };
      out.memory_paused = body.memory_paused;
    }
    if ('training_opt_out' in body) {
      if (typeof body.training_opt_out !== 'boolean') return { ok: false, reason: 'training_opt_out_must_be_boolean' };
      out.training_opt_out = body.training_opt_out;
    }
    if ('email_product_updates' in body) {
      if (typeof body.email_product_updates !== 'boolean') return { ok: false, reason: 'email_product_updates_must_be_boolean' };
      out.email_product_updates = body.email_product_updates;
    }
    if ('night_shift_enabled' in body) {
      if (typeof body.night_shift_enabled !== 'boolean') return { ok: false, reason: 'night_shift_enabled_must_be_boolean' };
      out.night_shift_enabled = body.night_shift_enabled;
    }
    if ('night_shift_tier' in body) {
      const tier = String(body.night_shift_tier || '').trim();
      if (tier !== 'brief' && tier !== 'research' && tier !== 'delegate') {
        return { ok: false, reason: 'night_shift_tier_invalid' };
      }
      out.night_shift_tier = tier;
    }
    if ('chat_retention_days' in body) {
      const v = body.chat_retention_days;
      if (v === null) {
        out.chat_retention_days = null;
      } else if (Number.isInteger(v) && v >= 1 && v <= 3650) {
        out.chat_retention_days = v;
      } else {
        return { ok: false, reason: 'chat_retention_days_invalid' };
      }
    }
    if ('metadata' in body) {
      if (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
        return { ok: false, reason: 'metadata_must_be_object' };
      }
      out.metadata = body.metadata;
    }

    if (Object.keys(out).length === 0) return { ok: false, reason: 'no_valid_fields' };
    return { ok: true, patch: out };
  }

  // GET /api/account/preferences — returns the current row, seeding
  // defaults on first read if the trigger hasn't fired (e.g. legacy
  // users who predate migration 060).
  app.get('/api/account/preferences', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'service_role_not_configured' });

      const { data, error } = await supabaseAdmin
        .from('lykn_user_preferences')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;

      if (data) {
        return res.json({ ok: true, preferences: data });
      }

      // Self-heal: insert defaults so subsequent reads/writes see a row.
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from('lykn_user_preferences')
        .insert({ user_id: userId, ...USER_PREFERENCE_DEFAULTS })
        .select('*')
        .single();
      if (insErr) throw insErr;
      return res.json({ ok: true, preferences: inserted });
    } catch (e) {
      console.error('❌ GET /api/account/preferences:', e?.message || e);
      return res.status(500).json({ error: 'preferences_fetch_failed' });
    }
  });

  // PATCH /api/account/preferences — partial update. Unknown keys are
  // rejected so a frontend typo can't quietly persist garbage.
  app.patch('/api/account/preferences', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'service_role_not_configured' });

      const parsed = sanitisePreferencesPatch(req.body);
      if (!parsed.ok) return res.status(400).json({ error: parsed.reason });

      const { data, error } = await supabaseAdmin
        .from('lykn_user_preferences')
        .upsert({ user_id: userId, ...USER_PREFERENCE_DEFAULTS, ...parsed.patch }, { onConflict: 'user_id' })
        .select('*')
        .single();
      if (error) throw error;
      return res.json({ ok: true, preferences: data });
    } catch (e) {
      console.error('❌ PATCH /api/account/preferences:', e?.message || e);
      return res.status(500).json({ error: 'preferences_update_failed' });
    }
  });

  // GET /api/night-shift/briefs — fresh morning_brief rows for overlay / desktop.
  const NIGHT_SHIFT_BRIEF_MAX_AGE_MS = 20 * 60 * 60 * 1000;
  app.get('/api/night-shift/briefs', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'service_role_not_configured' });

      const since = new Date(Date.now() - NIGHT_SHIFT_BRIEF_MAX_AGE_MS).toISOString();
      const { data: rows, error } = await supabaseAdmin
        .from('lykn_project_state')
        .select('id, project_id, state_value, created_at, set_by_client')
        .eq('user_id', userId)
        .eq('state_key', 'morning_brief')
        .is('superseded_at', null)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;

      const projectIds = [...new Set((rows || []).map((r) => r.project_id).filter(Boolean))];
      let projectNameById = new Map();
      if (projectIds.length) {
        const { data: projects, error: projErr } = await supabaseAdmin
          .from('lykn_projects')
          .select('id, name')
          .eq('user_id', userId)
          .eq('status', 'active')
          .in('id', projectIds);
        if (projErr) throw projErr;
        projectNameById = new Map((projects || []).map((p) => [p.id, p.name]));
      }

      const briefs = (rows || [])
        .filter((row) => projectNameById.has(row.project_id))
        .slice(0, 12)
        .map((row) => ({
          id: row.id,
          projectId: row.project_id,
          projectName: projectNameById.get(row.project_id) || 'Project',
          value: row.state_value,
          setAt: row.created_at,
          setByClient: row.set_by_client,
        }));

      return res.json({ ok: true, briefs });
    } catch (e) {
      console.error('❌ GET /api/night-shift/briefs:', e?.message || e);
      return res.status(500).json({ error: 'night_shift_briefs_failed' });
    }
  });

  // GET /api/steward/items?project_id=
  app.get('/api/steward/items', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      const projectId = String(req.query.project_id || '').trim();
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!projectId) return res.status(400).json({ error: 'project_id_required' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'service_role_not_configured' });

      const { data, error } = await supabaseAdmin
        .from('lykn_steward_items')
        .select('id, title, spec, status, result_summary, blocked_reason, approved_at, created_at, updated_at, completed_at, source, execution_kind, repo, sub_model_id, cursor_build_id, sub_model_task_id')
        .eq('user_id', userId)
        .eq('project_id', projectId)
        .neq('status', 'cancelled')
        .order('updated_at', { ascending: false })
        .limit(60);
      if (error) throw error;
      return res.json({ ok: true, items: data || [] });
    } catch (e) {
      console.error('❌ GET /api/steward/items:', e?.message || e);
      return res.status(500).json({ error: 'steward_list_failed' });
    }
  });

  // POST /api/steward/items { project_id, title }
  app.post('/api/steward/items', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'service_role_not_configured' });

      const projectId = String(req.body?.project_id || '').trim();
      const title = String(req.body?.title || '').trim().slice(0, 280);
      if (!projectId || !title) return res.status(400).json({ error: 'project_id_and_title_required' });

      const { data, error } = await supabaseAdmin
        .from('lykn_steward_items')
        .insert({
          user_id: userId,
          project_id: projectId,
          title,
          status: 'backlog',
          source: 'projects-ui',
        })
        .select('id, title, spec, status, created_at, updated_at')
        .single();
      if (error) throw error;
      return res.json({ ok: true, item: data });
    } catch (e) {
      console.error('❌ POST /api/steward/items:', e?.message || e);
      return res.status(500).json({ error: 'steward_create_failed' });
    }
  });

  // PATCH /api/steward/items/:id { status?, spec? }
  app.patch('/api/steward/items/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      const id = String(req.params.id || '').trim();
      if (!userId || !id) return res.status(400).json({ error: 'bad_request' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'service_role_not_configured' });

      const allowed = new Set(['backlog', 'ready', 'scheduled', 'cancelled']);
      const patch = {};
      if ('status' in req.body) {
        const st = String(req.body.status || '').trim();
        if (!allowed.has(st)) return res.status(400).json({ error: 'invalid_status' });
        patch.status = st;
        if (st === 'scheduled') patch.approved_at = new Date().toISOString();
      }
      if ('spec' in req.body) patch.spec = String(req.body.spec || '').trim().slice(0, 4000);
      if ('execution_kind' in req.body) {
        const kind = String(req.body.execution_kind || '').trim();
        if (kind === 'research' || kind === 'code' || kind === 'agent') patch.execution_kind = kind;
      }
      if ('repo' in req.body) patch.repo = String(req.body.repo || '').trim().slice(0, 500) || null;
      if ('sub_model_id' in req.body) {
        const sid = String(req.body.sub_model_id || '').trim();
        patch.sub_model_id = sid || null;
      }
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'no_valid_fields' });

      const { data, error } = await supabaseAdmin
        .from('lykn_steward_items')
        .update(patch)
        .eq('id', id)
        .eq('user_id', userId)
        .select('id, title, spec, status, approved_at, updated_at, result_summary, blocked_reason, execution_kind, repo, sub_model_id')
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'not_found' });
      return res.json({ ok: true, item: data });
    } catch (e) {
      console.error('❌ PATCH /api/steward/items:', e?.message || e);
      return res.status(500).json({ error: 'steward_update_failed' });
    }
  });

  // DELETE /api/account — hard delete the user. Body must include
  // `{ confirm: "DELETE" }` so a misclick or stray request can't wipe
  // an account. The order matters:
  //   1. Cancel the Stripe subscription (best-effort; we still proceed
  //      on failure so a user blocked by Stripe outage can still leave).
  //   2. Purge their Supabase Storage objects under user-files/{userId}/.
  //   3. Revoke the Sign in with Apple token if one is stored (best-effort;
  //      App Review requires the attempt, but an Apple outage must not
  //      block a user from leaving).
  //   4. Delete the auth.users row, which cascades through every
  //      ON DELETE CASCADE FK in the schema (facts, beliefs, concepts,
  //      vault items, chats, billing, preferences, MCP tokens, ...).
  //      The FKs are added by migration 113 — before it, NOTHING
  //      referenced auth.users and this delete orphaned every row.
  app.delete('/api/account', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'service_role_not_configured' });

      const confirm = String(req.body?.confirm || '').trim();
      if (confirm !== 'DELETE') return res.status(400).json({ error: 'confirm_phrase_required' });

      // Step 1: cancel Stripe subscription if present. Best-effort.
      if (stripe) {
        try {
          const { data: billing } = await supabaseAdmin
            .from('user_billing')
            .select('stripe_subscription_id, stripe_customer_id')
            .eq('user_id', userId)
            .maybeSingle();
          if (billing?.stripe_subscription_id) {
            await stripe.subscriptions.cancel(billing.stripe_subscription_id).catch((e) => {
              console.warn(`[account-delete] subscription cancel failed: ${e?.message || e}`);
            });
          }
          if (billing?.stripe_customer_id) {
            await stripe.customers.del(billing.stripe_customer_id).catch((e) => {
              console.warn(`[account-delete] customer delete failed: ${e?.message || e}`);
            });
          }
        } catch (e) {
          console.warn(`[account-delete] stripe cleanup error: ${e?.message || e}`);
        }
      }

      // Step 2: purge storage. Objects live at `<userId>/<fileId>/<file>`
      // (plus image variants like thumb.jpg beside the original), so a
      // single non-recursive list of `<userId>/` only returns the <fileId>
      // folder placeholders — and Storage `remove()` targets objects, not
      // folders, so removing those paths silently deletes nothing. Walk the
      // tree instead: list every folder (entries with a null `id` are
      // subfolders, non-null are objects — the same convention the iOS
      // client relies on in SupabaseWriteQueueExecutor.performDelete),
      // paginate past the per-list cap, then remove objects in batches.
      try {
        const bucket = supabaseAdmin.storage.from('user-files');
        const objectPaths = [];
        const pendingFolders = [String(userId)];
        const PAGE_SIZE = 1000;

        while (pendingFolders.length > 0) {
          const folder = pendingFolders.pop();
          let offset = 0;
          for (;;) {
            const { data: entries, error: listErr } = await bucket.list(folder, {
              limit: PAGE_SIZE,
              offset,
            });
            if (listErr) {
              console.warn(`[account-delete] storage list failed for ${folder}: ${listErr.message}`);
              break;
            }
            if (!Array.isArray(entries) || entries.length === 0) break;
            for (const entry of entries) {
              if (entry.id === null || entry.id === undefined) {
                pendingFolders.push(`${folder}/${entry.name}`);
              } else {
                objectPaths.push(`${folder}/${entry.name}`);
              }
            }
            if (entries.length < PAGE_SIZE) break;
            offset += entries.length;
          }
        }

        let removed = 0;
        for (let i = 0; i < objectPaths.length; i += 100) {
          const batch = objectPaths.slice(i, i + 100);
          const { error: removeErr } = await bucket.remove(batch);
          if (removeErr) {
            console.warn(`[account-delete] storage batch remove failed: ${removeErr.message}`);
          } else {
            removed += batch.length;
          }
        }
        console.log(`[account-delete] storage purge for ${userId}: found ${objectPaths.length} objects, removed ${removed}`);
      } catch (e) {
        console.warn(`[account-delete] storage cleanup error: ${e?.message || e}`);
      }

      // Step 3: revoke Sign in with Apple, if this user signed in natively
      // and we captured a refresh token at sign-in (POST /api/auth/apple/
      // token-exchange). Best-effort — Apple treats already-revoked tokens
      // as success, and the row itself dies with the auth user below.
      try {
        const { data: appleRow } = await supabaseAdmin
          .from('lykn_apple_tokens')
          .select('refresh_token')
          .eq('user_id', userId)
          .maybeSingle();
        if (appleRow?.refresh_token) {
          const revoked = await revokeAppleToken(appleRow.refresh_token);
          if (!revoked) console.warn(`[account-delete] apple token revoke failed for ${userId}`);
        }
      } catch (e) {
        console.warn(`[account-delete] apple revoke error: ${e?.message || e}`);
      }

      // Step 4: delete the auth user. Cascades through every FK.
      const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (delErr) {
        console.error(`[account-delete] auth.admin.deleteUser failed for ${userId}: ${delErr.message}`);
        return res.status(500).json({ error: 'delete_failed', detail: delErr.message });
      }

      return res.json({ ok: true });
    } catch (e) {
      console.error('❌ DELETE /api/account:', e?.message || e);
      return res.status(500).json({ error: 'delete_failed' });
    }
  });
}
