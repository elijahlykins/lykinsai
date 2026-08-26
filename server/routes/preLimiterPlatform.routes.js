// ============================================================================
// server/routes/preLimiterPlatform.routes.js — pre-limiter platform routes
// ============================================================================
// ORDERING-SENSITIVE (Wave 7). These four routes are registered BEFORE the
// global /api/ rate limiter and are therefore limiter-exempt (current
// production behavior — see DEFERRED SECURITY FINDINGS below). They span two
// distinct bootstrap positions, so this module exports THREE registrars, each
// called from server.js at the exact position the inline route occupied:
//
//   registerClientErrorRoute      — right after the global branching JSON
//                                   parser, before the auth core exists.
//   registerHealthRoute           — immediately after client-error, still
//                                   before supabaseAdmin is created (which is
//                                   why it receives a lazy getter, not the
//                                   client itself — the const doesn't exist
//                                   yet at registration time).
//   registerFileProxyAndArtifactRoutes
//                                 — after the auth core (supabaseAdmin +
//                                   requireAuth exist), still before the
//                                   global /api/ limiter.
//
// DEFERRED SECURITY FINDINGS (preserved as-is, do NOT fix here):
//   • /api/client-error's per-route express.json({ limit: '10kb' }) is
//     effectively INERT — the global 1mb parser has already consumed the
//     body by the time it runs. Oversized bodies are rejected by zod field
//     caps (400), not by the parser (413). Current behavior, kept.
//   • /api/artifacts/react/rebuild sits before the /api/ global limiter and
//     is rate-limit EXEMPT. Current behavior, kept.

import express from 'express';
import { z, validate } from '../../validation.js';
import { SecurityEvent } from '../../security-logger.js';
import { verifyFileToken, FILE_PROXY_ROUTE } from '../../lib/exterior/fileProxy.js';
import { mimeTypeForFilename } from '../../lib/exterior/capabilityStorage.js';
import { buildReactArtifact } from '../../lib/exterior/capabilities/buildReactArtifact.js';

// ============================================
// CLIENT ERROR REPORTING
// ============================================
// Frontend `RouteErrorBoundary` posts here whenever it catches a render-time
// crash. No-op by design — we just log to stdout so the entry shows up in
// the Render service logs and can be tailed during incident triage. There's
// no Sentry/PostHog wired up yet; this is the fallback for "everyone is
// hitting an error and we can't see why".
//
// SECURITY (Agent 04):
//   • This is the ONLY public unauthenticated JSON-accepting endpoint in
//     the API. A 5MB / 1MB body parser default would let an unauthenticated
//     attacker flood the log sink and exhaust storage. The per-route
//     express.json({ limit: '10kb' }) below caps the body at 10kb — easily
//     enough for any legitimate stack trace + componentStack from
//     RouteErrorBoundary, but tight enough that abuse is bounded.
//   • The Zod schema strips unknown fields and length-caps each known one
//     so a misshapen or oversized field can't tail-pad the log lines.
const clientErrorSchema = z.object({
  message: z.string().max(2000).optional(),
  name: z.string().max(200).optional(),
  stack: z.string().max(10_000).optional(),
  componentStack: z.string().max(10_000).optional(),
  url: z.string().max(500).optional(),
  userAgent: z.string().max(500).optional(),
  timestamp: z.string().max(64).optional(),
  viewport: z.object({
    w: z.number().int().nonnegative().max(20_000),
    h: z.number().int().nonnegative().max(20_000),
  }).optional(),
  // Purely diagnostic, and the least important field here — a misshapen or
  // oversized list degrades to nothing rather than rejecting the report and
  // costing us the crash it was attached to.
  lsKeys: z.array(z.string().max(200)).max(100).optional().catch([]),
});

export function registerClientErrorRoute(app) {
  app.post(
    '/api/client-error',
    express.json({ limit: '10kb' }),
    validate(clientErrorSchema),
    (req, res) => {
      try {
        const b = req.body || {};
        const ip = req.headers['x-forwarded-for'] || req.ip || '';
        console.error(
          '🔴 [client-error]',
          JSON.stringify({
            ts: b.timestamp || new Date().toISOString(),
            url: b.url || '',
            ua: b.userAgent || '',
            viewport: b.viewport || null,
            message: b.message || '',
            name: b.name || '',
            stack: b.stack || '',
            componentStack: b.componentStack || '',
            lsKeys: Array.isArray(b.lsKeys) ? b.lsKeys : [],
            ip: String(ip).split(',')[0].trim(),
          }),
        );
      } catch (err) {
        console.error('🔴 [client-error] failed to log:', err);
      }
      // Always 204 — never let the reporter become a source of additional
      // client-side errors (CORS preflights for non-2xx, etc.).
      res.status(204).end();
    },
  );
}

// ============================================
// HEALTH CHECK (Agent 06)
// ============================================
// Public, unauthenticated, < 2s response — render.yaml declares
// healthCheckPath: /api/health. Before this route existed, Render fell
// back to TCP-port liveness, masking app-level failures (DB unreachable,
// required env vars unset, etc.). Now Render gets real signal.
//
// Registered BEFORE requireAuth so it is reachable without a token.
// Response NEVER includes: env values, version strings, hostname, memory,
// dependency versions, internal paths, user counts, or PII.
//
// Returns 200 when healthy, 503 when degraded — Render uses this to
// decide whether to route traffic to this instance. Replay-event count
// is informational only (does NOT flip the health gate).
//
// CIA: Availability. Principle: LP (minimum info in response), SbD.
//
// deps.getSupabaseAdmin is a lazy getter: this route registers BEFORE the
// supabaseAdmin const is initialized in the bootstrap (temporal dead zone),
// exactly as the inline version referenced the not-yet-declared module
// binding. The handler resolves it per request, same as before.
export function registerHealthRoute(app, { getSupabaseAdmin }) {
  app.get('/api/health', async (req, res) => {
    const supabaseAdmin = getSupabaseAdmin();
    const checks = {};
    let healthy = true;

    // 1. Supabase connectivity — lightweight ping with a hard 1.5s budget so
    //    a slow/blocked DB never holds the response past Render's 2s ceiling.
    if (!supabaseAdmin) {
      checks.database = 'unconfigured';
      healthy = false;
    } else {
      try {
        // lykn_user_preferences has no `id` column — its primary key is
        // `user_id` (see migration 060). Selecting a non-existent column
        // returns PostgREST error 42703 which silently flipped the
        // database probe to "degraded" before this fix.
        const dbProbe = supabaseAdmin
          .from('lykn_user_preferences')
          .select('user_id', { head: true, count: 'exact' })
          .limit(1);
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('db_timeout')), 1500),
        );
        const result = await Promise.race([dbProbe, timeout]);
        checks.database = result?.error ? 'degraded' : 'ok';
        if (result?.error) healthy = false;
      } catch {
        checks.database = 'unreachable';
        healthy = false;
      }
    }

    // 2. Required boot secrets still present at request time.
    //    (validateSecrets ran at startup; this is a runtime re-check that
    //    catches a hot-mutated env or a worker that lost env after fork.)
    checks.secrets = process.env.SUPABASE_SERVICE_ROLE_KEY ? 'ok' : 'missing';
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) healthy = false;

    // 3. Uptime in seconds. Operational signal, not a health gate.
    checks.uptime_seconds = Math.floor(process.uptime());

    // 4. Recent oauth.replay_detected count (last 5 min). Informational —
    //    NEVER flips healthy. Surfaces the number on the same response
    //    Render polls so a query layer can graph it without standing up a
    //    second metrics endpoint.
    if (supabaseAdmin) {
      try {
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const probe = supabaseAdmin
          .from('lykn_security_audit')
          .select('id', { head: true, count: 'exact' })
          .eq('event_type', SecurityEvent.OAUTH_REPLAY_DETECTED)
          .gte('occurred_at', fiveMinAgo);
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('replay_probe_timeout')), 500),
        );
        const r = await Promise.race([probe, timeout]);
        checks.replay_events_5m = Number.isFinite(r?.count) ? r.count : 0;
      } catch {
        checks.replay_events_5m = 'unavailable';
      }
    } else {
      checks.replay_events_5m = 'unavailable';
    }

    return res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    });
  });
}

// ============================================
// FILE DOWNLOAD PROXY — branded download links
// ============================================
// Serves capability artifacts (generated images, templates, exported files…)
// through a branded host instead of handing users a raw Supabase signed URL.
// New links mint on ARTIFACTS_BASE_URL (https://artifacts.lykn.io); the API
// hostname still serves /f/ for in-flight tokens until they expire.
// The `:token` is an HMAC-signed handle (bucket + object path + expiry) minted
// by lib/exterior/fileProxy.js, so the token itself is the authorization and no
// user session is required. Mounted OUTSIDE `/api/` on purpose so links read as
// `<host>/f/<token>` rather than exposing the storage backend.
// App origins allowed to embed proxied HTML artifacts (deck/template previews
// render in a cross-origin iframe on the frontend). The global security
// middleware slaps X-Frame-Options: DENY + a `default-src 'none'` CSP on every
// response, which would blank the preview — so the proxy route relaxes these
// just for the file it serves.
// CSP `frame-ancestors` can't express the tight regex our CORS layer uses for
// Vercel previews (partial-subdomain wildcards aren't valid CSP source
// expressions). So in PRODUCTION we drop the broad `https://*.vercel.app` — it
// would let ANY Vercel deployment iframe served artifacts (clickjacking /
// phishing chrome). Preview/dev builds keep it for convenience; a specific
// preview that needs framing can set FRONTEND_BASE_URL.
const FILE_PROXY_FRAME_ANCESTORS = [
  "'self'",
  'https://lykn.io',
  'https://*.lykn.io',
  process.env.NODE_ENV === 'production' ? null : 'https://*.vercel.app',
  'http://localhost:*',
  'http://127.0.0.1:*',
  // The Electron glass overlay (loaded via loadFile → file:// origin) embeds
  // built artifacts in an inline preview iframe (Build mode).
  'file:',
  process.env.FRONTEND_BASE_URL,
  process.env.FRONTEND_URL,
]
  .filter(Boolean)
  .filter((v, i, arr) => arr.indexOf(v) === i)
  .join(' ');

export function registerFileProxyAndArtifactRoutes(app, { supabaseAdmin, requireAuth }) {
  app.get(FILE_PROXY_ROUTE, async (req, res) => {
    const claims = verifyFileToken(req.params.token);
    if (!claims) {
      return res.status(403).type('text/plain').send('Link expired or invalid');
    }
    if (!supabaseAdmin) {
      return res.status(503).type('text/plain').send('Storage unavailable');
    }

    try {
      const { data, error } = await supabaseAdmin.storage
        .from(claims.bucket)
        .download(claims.path);
      if (error || !data) {
        return res.status(404).type('text/plain').send('File not found');
      }

      const buffer = Buffer.from(await data.arrayBuffer());
      const filename = claims.filename || claims.path.split('/').pop() || 'download';
      // Trust the filename EXTENSION over Supabase's blob `.type`: storage's
      // download() reports `text/plain` for our generated .html/.md/.csv/.json
      // artifacts regardless of the content-type we uploaded with, which made the
      // preview iframe show raw HTML source instead of the rendered page. The
      // extension is authoritative for every artifact type we mint; fall back to
      // the storage-reported type only for unknown extensions.
      const byName = mimeTypeForFilename(filename);
      const contentType = byName !== 'application/octet-stream'
        ? byName
        : (data.type || 'application/octet-stream');
      const isHtml = /^text\/html/i.test(contentType);

      // Undo the global API security headers for THIS response only — they're
      // tuned for JSON endpoints and would block the very thing we're serving:
      //   • X-Frame-Options: DENY blocks the preview iframe outright.
      //   • CORP: same-origin blocks <img>/<iframe> loads from the frontend.
      //   • CSP: default-src 'none' blocks an embedded HTML doc's own assets.
      res.removeHeader('X-Frame-Options');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      if (isHtml) {
        // Permissive enough for AI-generated decks (inline scripts/styles, web
        // fonts, images) while still scoping who may frame the document. The
        // client also sandboxes this iframe, so scripts run on the artifacts
        // (or legacy API) origin — never the user's lykn.io session.
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self' data: blob: https:; " +
            "img-src 'self' data: blob: https:; " +
            "style-src 'unsafe-inline' 'self' https:; " +
            // 'unsafe-eval': React artifacts (lykn_build_react_artifact) compile
            // their JSX with Babel Standalone in-page and run it via new Function.
            "script-src 'unsafe-inline' 'unsafe-eval' 'self' blob: https:; " +
            "font-src 'self' data: https:; " +
            "media-src 'self' blob: https:; " +
            `frame-ancestors ${FILE_PROXY_FRAME_ANCESTORS}`,
        );
      } else {
        // Non-document files (images, pdf, audio, office docs) aren't subject to
        // a page CSP; drop the inherited `default-src 'none'` so nothing trips.
        res.removeHeader('Content-Security-Policy');
      }

      // Inline so previews (images, HTML decks) render in-browser; the download
      // attribute on the client anchor still forces a "Save as" when clicked.
      res.setHeader('Content-Type', contentType);
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${filename.replace(/"/g, '')}"`,
      );
      res.setHeader('Content-Length', String(buffer.length));
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.status(200).end(buffer);
    } catch (err) {
      console.error('📎 File proxy error:', err?.message || err);
      return res.status(500).type('text/plain').send('Download failed');
    }
  });

  // Manual code edits from the artifact panel's Code view: the user edited the
  // React artifact's JSX by hand and wants it re-rendered. Runs the exact same
  // validate → wrap-in-runner → persist pipeline as the lykn_build_react_artifact
  // tool (no AI involved), returning the same result shape (file_url,
  // preview_html, download_links) so the client swaps the artifact in place.
  app.post('/api/artifacts/react/rebuild', requireAuth, async (req, res) => {
    try {
      const result = await buildReactArtifact(
        {
          title: req.body?.title,
          code: req.body?.code,
          files: req.body?.files,
          entry: req.body?.entry,
          full_rewrite: true,
        },
        { supabaseAdmin, userId: req.user.id, allowFullRewrite: true, allowStyleChange: true },
      );
      if (result?.ok === false) return res.status(400).json(result);
      return res.json(result);
    } catch (err) {
      console.error('🧩 Artifact manual rebuild failed:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'rebuild_failed' });
    }
  });
}
