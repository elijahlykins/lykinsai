// ============================================================================
// server/routes/usage.routes.js — per-user usage tracking API
// ============================================================================
// Extracted verbatim from server.js (Wave 1 of the server decomposition).
// Handler bodies are unchanged; only the registration moved. Paths, methods,
// middleware chains, and registration order are preserved exactly —
// tests/server/serverRouteManifest.test.mjs enforces this.

import {
  getUserMonthlyUsage,
  getUserSessions,
  getSessionWithLogs,
} from '../../usageTracking.js';

/**
 * @param {import('express').Express} app
 * @param {object} deps bootstrap-owned middleware (same requireAuth instance
 *   used by every other route).
 */
export function registerUsageRoutes(app, { requireAuth }) {
  // ── Usage Tracking API ───────────────────────────────────────────────────────

  app.get('/api/usage/me', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const [monthly, sessions] = await Promise.all([
        getUserMonthlyUsage(userId),
        getUserSessions(userId, 10),
      ]);
      if (!monthly) {
        return res.status(503).json({ error: 'Failed to fetch usage data' });
      }

      return res.json({
        month: new Date().toISOString().slice(0, 7),
        ...monthly,
        recent_sessions: sessions,
      });
    } catch (error) {
      console.error('❌ Usage API error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch usage data' });
    }
  });

  app.get('/api/usage/session/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const result = await getSessionWithLogs(req.params.id, userId);
      if (!result) return res.status(404).json({ error: 'Session not found' });

      return res.json(result);
    } catch (error) {
      console.error('❌ Session API error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch session data' });
    }
  });

  app.get('/api/usage/history', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
      const sessions = await getUserSessions(userId, limit);

      return res.json({ sessions });
    } catch (error) {
      console.error('❌ Usage history error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch usage history' });
    }
  });
}
