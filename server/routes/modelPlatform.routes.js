import {
  listCuratedModels,
  listModels,
  listRecommendedModels,
} from '../../lib/models/registry.js';
import { listPublicMarketingModels } from '../../lib/models/publicCatalog.js';
import {
  createUserRoute,
  deleteUserRoute,
  getUserModelSettings,
  listUserRoutes,
  putUserModelSettings,
  updateUserRoute,
} from '../../lib/models/userModelSettings.js';
import { dailyUsageSpend, listUsageEvents, summarizeUsageEvents } from '../../lib/usage/usageEvents.js';
import { syncOpenRouterCatalog } from '../../lib/inference/openRouterCatalog.js';
import {
  includedChatBaseline,
  modelBillingStateForPaidChat,
} from '../../lib/billing/usageEntitlements.js';

function publicModel(def) {
  return {
    id: def.id,
    label: def.label,
    provider: def.provider,
    family: def.family,
    recommended: def.recommended,
    visibility: def.visibility,
    capabilities: def.capabilities,
    contextWindow: def.contextWindow,
    pricing: def.pricing,
    enabled: def.enabled,
  };
}

export function registerModelPlatformRoutes(app, { requireAuth }) {
  // Public marketing catalog: names + lab logos only. No auth, no pricing.
  app.get('/api/public/models', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    return res.json({ ok: true, ...listPublicMarketingModels() });
  });

  app.get('/api/models', requireAuth, async (req, res) => {
    const sync = await syncOpenRouterCatalog().catch((err) => ({
      ok: false,
      reason: err?.message || 'sync_failed',
    }));
    const visibility = String(req.query.visibility || '').trim();
    const recommended = req.query.recommended === '1';
    const provider = String(req.query.provider || '').trim() || undefined;
    const capability = String(req.query.capability || '').trim() || undefined;
    const rows = recommended
      ? listRecommendedModels()
      : listModels({
          provider,
          capability,
          visibility: visibility || undefined,
        });
    return res.json({
      models: rows.map(publicModel),
      catalog: {
        ok: sync?.ok !== false,
        added: sync?.added || 0,
        cached: Boolean(sync?.cached),
      },
    });
  });

  app.get('/api/models/recommended', requireAuth, (_req, res) => {
    return res.json({ models: listRecommendedModels().map(publicModel) });
  });

  // Included-vs-metered chat billing per model, derived from canonical
  // registry pricing against the Auto advanced-tier baseline. The picker
  // shows "Included" / "Uses usage" from this; never exposes multipliers.
  app.get('/api/models/billing-states', requireAuth, (_req, res) => {
    res.set('Cache-Control', 'private, max-age=300');
    const states = {};
    for (const def of listModels()) {
      states[def.id] = modelBillingStateForPaidChat(def.id);
    }
    return res.json({ baseline_model: includedChatBaseline().modelId, states });
  });

  app.get('/api/models/curated', requireAuth, (_req, res) => {
    return res.json({ models: listCuratedModels().map(publicModel) });
  });

  app.post('/api/models/catalog/sync', requireAuth, async (req, res) => {
    if (!req.user?.is_admin && process.env.MODEL_CATALOG_SYNC_OPEN !== '1') {
      return res.status(403).json({ error: 'forbidden' });
    }
    const result = await syncOpenRouterCatalog({ force: true }).catch((err) => ({
      ok: false,
      reason: err?.message || 'sync_failed',
    }));
    return res.json(result);
  });

  app.get('/api/model-settings', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });
      const settings = await getUserModelSettings(userId);
      return res.json({ settings });
    } catch (err) {
      console.warn('[model-settings] get failed', err?.message || err);
      return res.json({ settings: { mode: 'lykn', categories: {} } });
    }
  });

  app.put('/api/model-settings', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });
      const settings = await putUserModelSettings(userId, req.body || {});
      return res.json({ settings });
    } catch (err) {
      console.warn('[model-settings] put failed', err?.message || err);
      return res.status(500).json({ error: 'save_failed' });
    }
  });

  app.get('/api/model-routes', requireAuth, async (req, res) => {
    const routes = await listUserRoutes(req.user.id);
    return res.json({ routes });
  });

  app.post('/api/model-routes', requireAuth, async (req, res) => {
    const result = await createUserRoute(req.user.id, req.body || {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.status(201).json({ route: result.route });
  });

  app.put('/api/model-routes/:id', requireAuth, async (req, res) => {
    const result = await updateUserRoute(req.user.id, req.params.id, req.body || {});
    if (!result.ok) {
      return res.status(result.error === 'not_found' ? 404 : 400).json({ error: result.error });
    }
    return res.json({ route: result.route });
  });

  app.delete('/api/model-routes/:id', requireAuth, async (req, res) => {
    await deleteUserRoute(req.user.id, req.params.id);
    return res.json({ ok: true });
  });

  app.get('/api/usage/events', requireAuth, async (req, res) => {
    const limit = Number(req.query.limit) || 30;
    const events = await listUsageEvents(req.user.id, { limit });
    return res.json({ events });
  });

  app.get('/api/usage/summary', requireAuth, async (req, res) => {
    const summary = await summarizeUsageEvents(req.user.id);
    return res.json(summary);
  });

  // Daily spend for the billing chart. Category-level customer charge only —
  // never model ids, providers, or raw provider cost.
  app.get('/api/usage/daily', requireAuth, async (req, res) => {
    const days = Number(req.query.days) || 30;
    const daily = await dailyUsageSpend(req.user.id, { days });
    return res.json(daily);
  });
}
