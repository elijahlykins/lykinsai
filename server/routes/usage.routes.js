// ============================================================================
// server/routes/usage.routes.js — per-user usage tracking API
// ============================================================================
// Extracted verbatim from server.js (Wave 1 of the server decomposition).
// Paths, methods, middleware chains, and registration order are preserved
// exactly — tests/server/serverRouteManifest.test.mjs enforces this.
//
// These endpoints report ACTIVITY (requests, tokens, timestamps) only.
// Provider cost, legacy credits, and any internal economics stay server-side:
// the customer-facing money view is /api/billing/credits and /api/usage/
// summary|events, which report the customer charge, never the raw cost.

import {
  getUserMonthlyUsage,
  getUserSessions,
  getSessionWithLogs,
} from '../../usageTracking.js';

function publicSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    chat_id: session.chat_id,
    started_at: session.started_at,
    last_activity_at: session.last_activity_at,
    ended_at: session.ended_at,
    total_tokens: session.total_tokens || 0,
  };
}

function publicLog(log) {
  if (!log) return null;
  return {
    id: log.id,
    action_type: log.action_type,
    model: log.model,
    provider: log.provider,
    input_tokens: log.input_tokens || 0,
    output_tokens: log.output_tokens || 0,
    total_tokens: log.total_tokens || 0,
    created_at: log.created_at,
  };
}

function publicMonthly(monthly) {
  const breakdown = {};
  for (const [action, stats] of Object.entries(monthly.action_breakdown || {})) {
    breakdown[action] = { count: stats.count || 0, tokens: stats.tokens || 0 };
  }
  return {
    total_tokens: monthly.total_tokens || 0,
    action_breakdown: breakdown,
    log_count: monthly.log_count || 0,
    billable_count: monthly.billable_count || 0,
  };
}

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
        ...publicMonthly(monthly),
        recent_sessions: (sessions || []).map(publicSession),
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

      return res.json({
        session: publicSession(result.session),
        logs: (result.logs || []).map(publicLog),
      });
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

      return res.json({ sessions: (sessions || []).map(publicSession) });
    } catch (error) {
      console.error('❌ Usage history error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch usage history' });
    }
  });
}
