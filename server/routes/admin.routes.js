// ============================================================================
// server/routes/admin.routes.js — admin dashboards (usage, billing, MCP, audit)
// ============================================================================
// Extracted verbatim from server.js (Wave 2 of the server decomposition).
// Handler bodies are unchanged; only the registration moved. Paths, methods,
// middleware chains (requireAuth → requireAdmin on every route), and
// registration order are preserved exactly —
// tests/server/serverRouteManifest.test.mjs enforces this.
//
// The MRR cache (_billingMrrCache) lives inside the register closure, which
// runs exactly once at bootstrap — same single-instance semantics as the old
// module-level declaration in server.js.

import {
  getAdminOverview,
  getAdminUsersList,
  getAdminUserDrilldown,
  getAdminRecentActivity,
  getAdminLiveActivity,
  getAdminDiagnostics,
} from '../../usageTracking.js';

/**
 * @param {import('express').Express} app
 * @param {object} deps bootstrap-owned singletons: requireAuth/requireAdmin
 *   middleware, supabaseAdmin + stripe clients, STRIPE_TRIAL_DAYS config,
 *   and the shared safeErr() error-shaping helper.
 */
export function registerAdminRoutes(app, { requireAuth, requireAdmin, supabaseAdmin, stripe, STRIPE_TRIAL_DAYS, safeErr }) {
  // ============================================
  // ADMIN USAGE DASHBOARD — cross-user totals (admin@lykn.io only)
  // ============================================

  app.get('/api/admin/usage/overview', requireAuth, requireAdmin, async (req, res) => {
    try {
      const range = String(req.query.range || '30d');
      const overview = await getAdminOverview(range);
      return res.json({ range, ...overview });
    } catch (error) {
      console.error('❌ Admin overview error:', error.message);
      return res.status(error?.status || 500).json({
        error: safeErr(error, 'Failed to fetch admin overview'),
        code: error?.code || 'unknown',
      });
    }
  });

  app.get('/api/admin/usage/users', requireAuth, requireAdmin, async (req, res) => {
    try {
      const range = String(req.query.range || 'mtd');
      const users = await getAdminUsersList(range);
      return res.json({ range, users });
    } catch (error) {
      console.error('❌ Admin users error:', error.message);
      return res.status(error?.status || 500).json({
        error: safeErr(error, 'Failed to fetch admin users list'),
        code: error?.code || 'unknown',
      });
    }
  });

  app.get('/api/admin/usage/users/:userId', requireAuth, requireAdmin, async (req, res) => {
    try {
      const userId = String(req.params.userId || '');
      if (!/^[0-9a-f-]{32,40}$/i.test(userId)) {
        return res.status(400).json({ error: 'Invalid userId' });
      }
      const range = String(req.query.range || '30d');
      const drilldown = await getAdminUserDrilldown(userId, range);
      if (!drilldown) return res.status(404).json({ error: 'User not found' });
      return res.json({ range, ...drilldown });
    } catch (error) {
      console.error('❌ Admin drilldown error:', error.message);
      return res.status(error?.status || 500).json({
        error: safeErr(error, 'Failed to fetch user drilldown'),
        code: error?.code || 'unknown',
      });
    }
  });

  app.get('/api/admin/usage/recent', requireAuth, requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
      const rows = await getAdminRecentActivity(limit);
      return res.json({ rows });
    } catch (error) {
      console.error('❌ Admin recent error:', error.message);
      return res.status(error?.status || 500).json({
        error: safeErr(error, 'Failed to fetch recent activity'),
        code: error?.code || 'unknown',
      });
    }
  });

  app.get('/api/admin/usage/live', requireAuth, requireAdmin, async (req, res) => {
    try {
      const minutes = Math.min(Math.max(Number(req.query.minutes) || 60, 1), 360);
      const data = await getAdminLiveActivity(minutes);
      return res.json(data);
    } catch (error) {
      console.error('❌ Admin live error:', error.message);
      return res.status(error?.status || 500).json({
        error: safeErr(error, 'Failed to fetch live activity'),
        code: error?.code || 'unknown',
      });
    }
  });

  app.get('/api/admin/usage/diagnostics', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const out = await getAdminDiagnostics();
      return res.json(out);
    } catch (error) {
      console.error('❌ Admin diagnostics error:', error.message);
      return res.status(500).json({ error: safeErr(error, 'Diagnostics failed') });
    }
  });

  // ============================================
  // ADMIN — Billing / subscription analytics
  // ============================================
  // Surfaces who's on trial, who's paying, and who canceled by reading
  // `user_billing` (current state, kept in sync by the Stripe webhook) and
  // `stripe_events` (raw webhook audit, for the cancellation feed). Emails are
  // resolved best-effort via the auth.admin API, mirroring /api/admin/usage.
  // MRR is computed live from Stripe for active/trialing subs (cached 60s) and
  // is null when Stripe isn't configured.

  const ACTIVE_SUB_STATUSES = ['active', 'trialing', 'past_due'];
  const CANCELED_SUB_STATUSES = ['canceled', 'unpaid', 'incomplete_expired'];

  let _billingMrrCache = { at: 0, value: null };

  async function computeStripeMrr(rows) {
    if (!stripe) return null;
    const now = Date.now();
    if (_billingMrrCache.value && now - _billingMrrCache.at < 60_000) {
      return _billingMrrCache.value;
    }
    const subIds = rows
      .filter((r) => r.stripe_subscription_id && ACTIVE_SUB_STATUSES.includes(String(r.status || '').toLowerCase()))
      .map((r) => r.stripe_subscription_id)
      .slice(0, 200); // v1 cap — aggregate in-process like the usage panel
    let cents = 0;
    let currency = 'usd';
    for (const subId of subIds) {
      try {
        const sub = await stripe.subscriptions.retrieve(subId);
        for (const item of sub.items?.data || []) {
          const price = item.price;
          const qty = Number(item.quantity || 1);
          const amount = Number(price?.unit_amount || 0) * qty;
          if (!amount) continue;
          if (price?.currency) currency = price.currency;
          const interval = price?.recurring?.interval;
          const intervalCount = Number(price?.recurring?.interval_count || 1) || 1;
          // Normalize everything to a monthly figure.
          if (interval === 'year') cents += Math.round(amount / (12 * intervalCount));
          else if (interval === 'week') cents += Math.round((amount * 52) / (12 * intervalCount));
          else if (interval === 'day') cents += Math.round((amount * 365) / (12 * intervalCount));
          else cents += Math.round(amount / intervalCount); // month (default)
        }
      } catch {
        // Skip subs we can't read; MRR stays best-effort.
      }
    }
    const value = { mrr_cents: cents, currency };
    _billingMrrCache = { at: now, value };
    return value;
  }

  app.get('/api/admin/billing/overview', requireAuth, requireAdmin, async (_req, res) => {
    try {
      if (!supabaseAdmin) return res.status(503).json({ error: 'service_role_not_configured' });

      const { data: rows, error } = await supabaseAdmin
        .from('user_billing')
        .select('user_id, plan, billing_period, status, current_period_end, cancel_at_period_end, stripe_subscription_id, stripe_customer_id')
        .order('current_period_end', { ascending: false, nullsFirst: false });
      if (error) throw new Error(error.message);

      // Resolve emails once (page 1, ≤1000 users) — same approach as usage panel.
      let emailById = new Map();
      try {
        if (typeof supabaseAdmin.auth?.admin?.listUsers === 'function') {
          const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
          for (const u of (list?.users || [])) {
            if (u?.id && u?.email) emailById.set(u.id, u.email);
          }
        }
      } catch {
        emailById = new Map();
      }

      const customerToEmail = new Map();
      const totals = {
        signups: 0,
        free_inactive: 0,
        trialing: 0,
        active: 0,
        past_due: 0,
        canceled: 0,
        comped: 0,
        cancel_scheduled: 0,
      };

      const subscribers = (rows || []).map((r) => {
        totals.signups += 1;
        const status = String(r.status || 'inactive').toLowerCase();
        const plan = String(r.plan || 'free').toLowerCase();
        const hasSub = Boolean(r.stripe_subscription_id);
        const email = emailById.get(r.user_id) || null;
        if (r.stripe_customer_id && email) customerToEmail.set(r.stripe_customer_id, email);

        if (status === 'trialing') totals.trialing += 1;
        else if (status === 'active') totals.active += 1;
        else if (status === 'past_due') totals.past_due += 1;
        else if (CANCELED_SUB_STATUSES.includes(status)) totals.canceled += 1;
        else if (plan === 'free') totals.free_inactive += 1;
        // Paid plan on file with no Stripe subscription id = manual / comped grant.
        if (!hasSub && plan !== 'free') totals.comped += 1;
        if (r.cancel_at_period_end && ACTIVE_SUB_STATUSES.includes(status)) totals.cancel_scheduled += 1;

        return {
          user_id: r.user_id,
          email,
          plan,
          billing_period: r.billing_period || null,
          status,
          current_period_end: r.current_period_end || null,
          cancel_at_period_end: Boolean(r.cancel_at_period_end),
          stripe_subscription_id: r.stripe_subscription_id || null,
          stripe_customer_id: r.stripe_customer_id || null,
        };
      });

      // Conversion funnel (best-effort, from current state only): everyone who
      // got a subscription id went through trial-checkout (card on file).
      const trialsStarted = subscribers.filter((s) => s.stripe_subscription_id).length;
      const converted = subscribers.filter((s) => s.status === 'active').length;
      const conversion = {
        trials_started: trialsStarted,
        converted,
        still_trialing: totals.trialing,
        churned: totals.canceled,
        rate: trialsStarted > 0 ? Number((converted / trialsStarted).toFixed(4)) : null,
      };

      // Cancellation feed from the raw webhook audit. Pull the most recent
      // events and keep deletions + cancel-scheduled updates.
      let cancellations = [];
      try {
        const { data: events } = await supabaseAdmin
          .from('stripe_events')
          .select('id, type, payload')
          .order('id', { ascending: false })
          .limit(400);
        for (const ev of events || []) {
          const type = ev.type;
          const obj = ev.payload?.data?.object || {};
          const isDeletion = type === 'customer.subscription.deleted';
          const isCancelScheduled =
            type === 'customer.subscription.updated' && obj?.cancel_at_period_end === true;
          if (!isDeletion && !isCancelScheduled) continue;
          const customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
          cancellations.push({
            event_id: ev.id,
            type,
            kind: isDeletion ? 'ended' : 'cancel_scheduled',
            at: ev.payload?.created ? new Date(ev.payload.created * 1000).toISOString() : null,
            email: customerToEmail.get(customerId) || null,
            customer_id: customerId || null,
            subscription_id: obj.id || null,
            status: obj.status || null,
            cancel_at_period_end: Boolean(obj.cancel_at_period_end),
          });
        }
        // De-dupe to the latest event per subscription so a sub that was
        // canceled then deleted shows once (most recent wins).
        const seenSub = new Set();
        cancellations = cancellations.filter((c) => {
          const key = c.subscription_id || c.event_id;
          if (seenSub.has(key)) return false;
          seenSub.add(key);
          return true;
        }).slice(0, 100);
      } catch (err) {
        console.warn('⚠️ admin/billing cancellation feed failed:', err?.message || err);
      }

      let mrr = null;
      try {
        mrr = await computeStripeMrr(subscribers);
      } catch (err) {
        console.warn('⚠️ admin/billing MRR compute failed:', err?.message || err);
      }

      return res.json({
        generated_at: new Date().toISOString(),
        stripe_configured: Boolean(stripe),
        totals,
        conversion,
        mrr_cents: mrr?.mrr_cents ?? null,
        mrr_currency: mrr?.currency || 'usd',
        trial_days: STRIPE_TRIAL_DAYS,
        subscribers,
        cancellations,
      });
    } catch (error) {
      console.error('❌ Admin billing overview error:', error.message);
      return res.status(error?.status || 500).json({
        error: safeErr(error, 'Failed to fetch billing overview'),
        code: error?.code || 'unknown',
      });
    }
  });

  // ============================================
  // ADMIN — MCP / context-backplane usage
  // ============================================
  // Pulls MCP and REST-mirror traffic out of `ai_usage_logs` (tagged at
  // ingest time with action_type IN ('mcp_tool', 'rest_synthesis')).
  // Returns one consolidated payload that powers the "MCP" section of
  // /admin/usage on the client. SECURITY DEFINER RPCs would be cleaner but
  // also a migration we don't need yet — these reads are admin-only and
  // service-role'd.
  app.get('/api/admin/usage/mcp', requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!supabaseAdmin) return res.status(503).json({ error: 'service_role_not_configured' });

      const minutes = Math.max(15, Math.min(Number(req.query.minutes) || 60 * 24, 60 * 24 * 7));
      const since = new Date(Date.now() - minutes * 60_000).toISOString();
      const out = {
        window: { minutes, since, now: new Date().toISOString() },
        totals: { calls: 0, ok: 0, errors: 0, distinct_users: 0, distinct_tokens: 0 },
        top_users: [],
        top_tools: [],
        top_clients: [],
        attribution_by_surface: [],
        recent: [],
        tokens: { total: 0, active: 0, revoked: 0 },
      };

      // 1. Pull MCP/REST log rows for the window. Cap at 5k to keep this
      //    cheap; we aggregate in-process which is fine for the foreseeable
      //    future. If MCP traffic ever exceeds that we'll move this into an
      //    SECURITY DEFINER RPC (mirroring admin_usage_overview).
      const { data: logs, error: logErr } = await supabaseAdmin
        .from('ai_usage_logs')
        .select('id, user_id, action_type, model, metadata, created_at')
        .in('action_type', ['mcp_tool', 'rest_synthesis'])
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(5000);
      if (logErr) {
        console.warn('[admin:mcp] log pull error:', logErr.message);
      }
      const rows = Array.isArray(logs) ? logs : [];

      out.totals.calls = rows.length;
      const tokenIds = new Set();
      const userIds = new Set();
      const toolCounts = new Map();
      const clientCounts = new Map();
      const userCounts = new Map();
      let okCount = 0;
      let errCount = 0;

      for (const r of rows) {
        const meta = r?.metadata || {};
        const ok = meta.ok === true || meta.ok === 'true';
        if (ok) okCount += 1; else errCount += 1;
        const tool = String(meta.tool || r.model || 'unknown');
        toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
        const client = String(meta.client_kind || 'unknown');
        clientCounts.set(client, (clientCounts.get(client) || 0) + 1);
        if (r.user_id) {
          userIds.add(r.user_id);
          userCounts.set(r.user_id, (userCounts.get(r.user_id) || 0) + 1);
        }
        if (meta.token_id) tokenIds.add(meta.token_id);
      }
      out.totals.ok = okCount;
      out.totals.errors = errCount;
      out.totals.distinct_users = userIds.size;
      out.totals.distinct_tokens = tokenIds.size;

      out.top_tools = Array.from(toolCounts.entries())
        .map(([name, calls]) => ({ name, calls }))
        .sort((a, b) => b.calls - a.calls)
        .slice(0, 12);
      out.top_clients = Array.from(clientCounts.entries())
        .map(([client_kind, calls]) => ({ client_kind, calls }))
        .sort((a, b) => b.calls - a.calls)
        .slice(0, 8);

      // Top users — resolve emails best-effort via the auth.admin API (the
      // service-role'd Supabase client can listUsers but doesn't accept an
      // `in (...)` filter, so we listUsers once and filter in-process). Fall
      // back to user_id-only if the admin API isn't available. Cheaper than
      // a SECURITY DEFINER RPC for a v1 admin panel.
      const topUserPairs = Array.from(userCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      if (topUserPairs.length) {
        let emailById = new Map();
        try {
          if (typeof supabaseAdmin.auth?.admin?.listUsers === 'function') {
            // listUsers paginates; we only need page 1 (≤1000 users) — admin
            // dashboards on a v1 product won't exceed that bracket.
            const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
            for (const u of (list?.users || [])) {
              if (u?.id && u?.email) emailById.set(u.id, u.email);
            }
          }
        } catch {
          emailById = new Map();
        }
        out.top_users = topUserPairs.map(([uid, calls]) => ({
          user_id: uid,
          email: emailById.get(uid) || null,
          calls,
        }));
      }

      out.recent = rows.slice(0, 50).map((r) => {
        const meta = r?.metadata || {};
        return {
          id: r.id,
          user_id: r.user_id,
          tool: String(meta.tool || r.model || 'unknown'),
          client_kind: String(meta.client_kind || 'unknown'),
          client_label: String(meta.client_label || '').slice(0, 240),
          token_id: meta.token_id || null,
          latency_ms: Number(meta.latency_ms) || 0,
          ok: meta.ok === true || meta.ok === 'true',
          error: meta.error || null,
          created_at: r.created_at,
        };
      });

      // 2. Token KPIs — separate from the call-log window.
      try {
        const { data: tokens } = await supabaseAdmin
          .from('lykn_mcp_tokens')
          .select('id, status');
        const tokRows = tokens || [];
        out.tokens.total = tokRows.length;
        out.tokens.active = tokRows.filter((t) => t.status === 'active').length;
        out.tokens.revoked = tokRows.filter((t) => t.status === 'revoked').length;
      } catch (e) {
        console.warn('[admin:mcp] tokens count error:', e?.message || e);
      }

      return res.json(out);
    } catch (error) {
      console.error('❌ Admin MCP error:', error?.message || error);
      return res.status(500).json({ error: safeErr(error, 'mcp_admin_failed') });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SECURITY AUDIT QUERY (Agent 06)
  // ─────────────────────────────────────────────────────────────────────────────
  // GET /api/admin/security/audit
  //
  // Surfaces the lykn_security_audit table (Agent 03's append-only audit log
  // + Agent 06's application-layer event sink) to an admin operator. Used
  // to investigate incidents per INCIDENT_RUNBOOK.md.
  //
  // Query params (all optional):
  //   ?event_type=oauth.replay_detected   exact event_type filter
  //   ?since=2024-01-01T00:00:00Z         ISO timestamp; defaults to -24h
  //   ?limit=100                          max 500; default 100
  //   ?user_id=<uuid>                     filter by owning user
  //   ?client_id=<opaque>                 filter by OAuth client
  //
  // Service-role-only: the audit table has RLS on with ZERO policies, so
  // supabaseAdmin (service-role client) is the ONLY way to read it.
  // Combined with requireAuth + requireAdmin (allowlisted admin emails),
  // this is least-privilege at three layers.
  //
  // CIA: Integrity (events queryable for forensics).
  // Principle: LP (admin only), KISS (one endpoint, no UI).
  app.get('/api/admin/security/audit', requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!supabaseAdmin) return res.status(503).json({ error: 'service_role_not_configured' });

      const rawLimit = parseInt(String(req.query.limit ?? '100'), 10);
      const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100, 500);

      // Default window: last 24 hours.
      let since;
      if (req.query.since) {
        const parsed = new Date(String(req.query.since));
        since = Number.isFinite(parsed.getTime())
          ? parsed.toISOString()
          : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      } else {
        since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      }

      let query = supabaseAdmin
        .from('lykn_security_audit')
        .select('*')
        .gte('occurred_at', since)
        .order('occurred_at', { ascending: false })
        .limit(limit);

      const eventType = req.query.event_type ? String(req.query.event_type) : null;
      if (eventType) query = query.eq('event_type', eventType);

      const userIdFilter = req.query.user_id ? String(req.query.user_id) : null;
      if (userIdFilter) query = query.eq('user_id', userIdFilter);

      const clientIdFilter = req.query.client_id ? String(req.query.client_id) : null;
      if (clientIdFilter) query = query.eq('client_id', clientIdFilter);

      const { data, error } = await query;
      if (error) {
        console.error('[supabase] /api/admin/security/audit', error);
        return res.status(500).json({ error: 'audit_query_failed' });
      }

      return res.json({
        events: data || [],
        count: (data || []).length,
        since,
        limit,
        filters: {
          event_type: eventType,
          user_id: userIdFilter,
          client_id: clientIdFilter,
        },
      });
    } catch (e) {
      console.error('❌ /api/admin/security/audit:', e?.message || e);
      return res.status(500).json({ error: 'audit_query_failed' });
    }
  });
}
