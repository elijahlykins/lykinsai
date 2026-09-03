import { EXTERNAL_CALENDAR_SYNC_ENABLED } from '../../lib/calendar/calendarConfig.js';
import {
  connectAppleCalendar,
  disconnectCalendarConnection,
  finishGoogleCalendarAuthorization,
  listCalendarConnections,
  startGoogleCalendarAuthorization,
  syncCalendarConnection,
  updateCalendarConnection,
} from '../../lib/calendar/calendarService.js';

function rejectExternalSync(res) {
  return res.status(410).json({
    error: 'Google and Apple calendar sync is temporarily unavailable.',
  });
}

function apiBase(port) {
  return (
    process.env.PUBLIC_API_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    `http://localhost:${port}`
  ).replace(/\/$/, '');
}

function callbackHtml({ ok, trustedOrigin }) {
  const payload = JSON.stringify({
    type: 'lykn:calendar-oauth',
    provider: 'google-calendar',
    ok,
  });
  const target = trustedOrigin ? JSON.stringify(trustedOrigin) : 'null';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Google Calendar</title></head>
<body><p>${ok ? 'Google Calendar connected. You can close this window.' : 'Google Calendar connection failed.'}</p>
<script>(function(){var target=${target};if(target&&window.opener){window.opener.postMessage(${payload},target);}setTimeout(function(){window.close();},${ok ? 400 : 2000});})();</script>
</body></html>`;
}

export function registerCalendarConnectionRoutes(app, { requireAuth, supabaseAdmin, PORT }) {
  const redirectUri = `${apiBase(PORT)}/oauth/calendar/google/callback`;
  let trustedOrigin = null;
  try {
    trustedOrigin = new URL(
      process.env.FRONTEND_BASE_URL || process.env.FRONTEND_URL || 'http://localhost:5173',
    ).origin;
  } catch {
    trustedOrigin = null;
  }

  app.get('/api/calendar/connections', requireAuth, async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      const connections = await listCalendarConnections(supabaseAdmin, req.user.id);
      return res.json({ connections });
    } catch (error) {
      console.error('[calendar] list connections failed:', error?.message || error);
      return res.status(500).json({ error: 'Could not load calendar connections' });
    }
  });

  app.post('/api/calendar/connections/google/start', requireAuth, async (req, res) => {
    if (!EXTERNAL_CALENDAR_SYNC_ENABLED) return rejectExternalSync(res);
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      const result = await startGoogleCalendarAuthorization(supabaseAdmin, req.user.id, {
        redirectUri,
        redirectAfter: req.body?.redirectAfter || null,
      });
      return res.json(result);
    } catch (error) {
      console.error('[calendar] Google authorization start failed:', error?.message || error);
      return res.status(500).json({ error: 'Could not start Google Calendar sign-in' });
    }
  });

  app.get('/oauth/calendar/google/callback', async (req, res) => {
    if (!EXTERNAL_CALENDAR_SYNC_ENABLED) {
      return res.status(410).type('html').send(callbackHtml({ ok: false, trustedOrigin }));
    }
    try {
      if (req.query?.error) throw new Error(String(req.query.error));
      const finished = await finishGoogleCalendarAuthorization(supabaseAdmin, {
        state: String(req.query?.state || ''),
        code: String(req.query?.code || ''),
        redirectUri,
      });
      void syncCalendarConnection(
        supabaseAdmin,
        finished.userId,
        finished.connection.id,
      ).catch((error) => console.warn('[calendar] initial Google sync failed:', error?.message || error));
      return res.status(200).type('html').send(callbackHtml({ ok: true, trustedOrigin }));
    } catch (error) {
      console.warn('[calendar] Google authorization callback failed:', error?.message || error);
      return res.status(400).type('html').send(callbackHtml({ ok: false, trustedOrigin }));
    }
  });

  app.post('/api/calendar/connections/apple', requireAuth, async (req, res) => {
    if (!EXTERNAL_CALENDAR_SYNC_ENABLED) return rejectExternalSync(res);
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      const connection = await connectAppleCalendar(
        supabaseAdmin,
        req.user.id,
        req.body || {},
      );
      void syncCalendarConnection(supabaseAdmin, req.user.id, connection.id)
        .catch((error) => console.warn('[calendar] initial Apple sync failed:', error?.message || error));
      return res.json({ connection });
    } catch (error) {
      const message = error?.isUserFacing || /iCloud|Apple|password|calendar/i.test(error?.message || '')
        ? String(error.message).slice(0, 300)
        : 'Could not connect Apple Calendar';
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/calendar/connections/:id/sync', requireAuth, async (req, res) => {
    if (!EXTERNAL_CALENDAR_SYNC_ENABLED) return rejectExternalSync(res);
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      return res.json(
        await syncCalendarConnection(supabaseAdmin, req.user.id, req.params.id),
      );
    } catch (error) {
      return res.status(error?.isAuthError ? 401 : 500).json({
        error: error?.isUserFacing ? error.message : 'Calendar sync failed',
        status: error?.isAuthError ? 'reauth' : 'error',
      });
    }
  });

  app.patch('/api/calendar/connections/:id', requireAuth, async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      if (!['active', 'paused'].includes(req.body?.status)) {
        return res.status(400).json({ error: 'status must be active or paused' });
      }
      const connection = await updateCalendarConnection(
        supabaseAdmin,
        req.user.id,
        req.params.id,
        req.body.status,
      );
      return res.json({ connection });
    } catch {
      return res.status(500).json({ error: 'Calendar connection update failed' });
    }
  });

  app.delete('/api/calendar/connections/:id', requireAuth, async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      await disconnectCalendarConnection(supabaseAdmin, req.user.id, req.params.id);
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Calendar disconnect failed' });
    }
  });
}
