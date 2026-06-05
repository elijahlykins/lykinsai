// ============================================================================
// custom-models-routes.js — Model Builder persist API
// ============================================================================

import {
  listCustomModels,
  listPublishedCustomModels,
  getCustomModel,
  getLatestCustomModel,
  saveCustomModelDraft,
  publishCustomModel,
  deleteCustomModel,
  CustomModelValidationError,
} from './custom-models-service.js';

function modelErr(e) {
  if (e instanceof CustomModelValidationError || e?.name === 'CustomModelValidationError') {
    return { status: 400, body: { error: 'validation', message: e.message } };
  }
  return { status: 500, body: { error: 'internal', message: e?.message || 'Request failed' } };
}

/**
 * @param {import('express').Express} app
 * @param {{ requireAuth: Function, supabaseAdmin: object }} deps
 */
export function registerCustomModelRoutes(app, { requireAuth, supabaseAdmin }) {
  console.log('→ Custom models API: /api/v1/custom-models/* registered');

  app.get('/api/v1/custom-models', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      res.setHeader('Cache-Control', 'no-store');
      const models = await listCustomModels(supabaseAdmin, userId);
      return res.json({ models });
    } catch (e) {
      console.error('❌ GET /api/v1/custom-models:', e?.message || e);
      const err = modelErr(e);
      return res.status(err.status).json(err.body);
    }
  });

  app.get('/api/v1/custom-models/published', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      res.setHeader('Cache-Control', 'no-store');
      const models = await listPublishedCustomModels(supabaseAdmin, userId);
      return res.json({ models });
    } catch (e) {
      console.error('❌ GET /api/v1/custom-models/published:', e?.message || e);
      const err = modelErr(e);
      return res.status(err.status).json(err.body);
    }
  });

  app.get('/api/v1/custom-models/latest', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      res.setHeader('Cache-Control', 'no-store');
      const model = await getLatestCustomModel(supabaseAdmin, userId);
      return res.json({ model });
    } catch (e) {
      console.error('❌ GET /api/v1/custom-models/latest:', e?.message || e);
      const err = modelErr(e);
      return res.status(err.status).json(err.body);
    }
  });

  app.get('/api/v1/custom-models/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      if (req.params.id === 'latest' || req.params.id === 'published') {
        return res.status(404).json({ error: 'not_found' });
      }
      res.setHeader('Cache-Control', 'no-store');
      const model = await getCustomModel(supabaseAdmin, userId, req.params.id);
      if (!model) return res.status(404).json({ error: 'not_found' });
      return res.json({ model });
    } catch (e) {
      console.error('❌ GET /api/v1/custom-models/:id:', e?.message || e);
      const err = modelErr(e);
      return res.status(err.status).json(err.body);
    }
  });

  app.post('/api/v1/custom-models', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      const model = await saveCustomModelDraft(supabaseAdmin, userId, req.body || {});
      return res.status(201).json({ model });
    } catch (e) {
      const err = modelErr(e);
      return res.status(err.status).json(err.body);
    }
  });

  app.patch('/api/v1/custom-models/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      const { updateCustomModel } = await import('./custom-models-service.js');
      const model = await updateCustomModel(
        supabaseAdmin,
        userId,
        req.params.id,
        req.body || {},
        { publish: false },
      );
      if (!model) return res.status(404).json({ error: 'not_found' });
      return res.json({ model });
    } catch (e) {
      const err = modelErr(e);
      return res.status(err.status).json(err.body);
    }
  });

  app.post('/api/v1/custom-models/:id/publish', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      const model = await publishCustomModel(supabaseAdmin, userId, {
        ...(req.body || {}),
        id: req.params.id,
      });
      return res.json({ model });
    } catch (e) {
      const err = modelErr(e);
      return res.status(err.status).json(err.body);
    }
  });

  app.post('/api/v1/custom-models/publish', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      const model = await publishCustomModel(supabaseAdmin, userId, req.body || {});
      return res.json({ model });
    } catch (e) {
      const err = modelErr(e);
      return res.status(err.status).json(err.body);
    }
  });

  app.delete('/api/v1/custom-models/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      await deleteCustomModel(supabaseAdmin, userId, req.params.id);
      return res.json({ ok: true });
    } catch (e) {
      const err = modelErr(e);
      return res.status(err.status).json(err.body);
    }
  });
}
