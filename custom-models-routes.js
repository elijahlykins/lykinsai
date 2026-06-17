// ============================================================================
// custom-models-routes.js — published custom models read API
// ============================================================================
//
// The Model Builder UI was retired; only the read path that feeds the in-chat
// model picker (GET /published) remains. Existing published models keep
// working — they're executed by the chat runtime, not these routes.

import { listPublishedCustomModels } from './custom-models-service.js';

/**
 * @param {import('express').Express} app
 * @param {{ requireAuth: Function, supabaseAdmin: object }} deps
 */
export function registerCustomModelRoutes(app, { requireAuth, supabaseAdmin }) {
  console.log('→ Custom models API: /api/v1/custom-models/published registered');

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
      return res
        .status(500)
        .json({ error: 'internal', message: e?.message || 'Request failed' });
    }
  });
}
