// ============================================================================
// validateSecrets.js — startup-time secrets validation (Agent 05)
// ============================================================================
// LYKN's first line of defense against misconfigured deployments. Runs once
// at server boot, refuses to start in production if a required secret is
// missing or below its declared minimum length, and logs a structured
// summary in development without exiting.
//
// SHIPPING ALONGSIDE THE PER-CALL 8-CHAR FLOOR (defense in depth):
//   - This module is the STARTUP gate.
//   - `verifyBackfillSecret` / `verifyDiscoverIngestSecret` /
//     `verifyAdminIngestSecret` in server.js keep their per-call floor.
//   Both checks coexist on purpose — if a hot-reloaded process somehow
//   keeps running with a swapped-out env, the per-call check is the
//   safety net.
//
// PROD: process.exit(1) on any failure. Render's auto-restart loop then
// surfaces the failure as a deployment-failed alert, which is the right
// signal — a silently misconfigured server is worse than a 503-from-boot.
//
// DEV: print warnings; do not exit. Dev environments routinely run with
// partial configs (no Stripe, no AI keys, etc.) — exiting would torpedo
// the developer onboarding experience.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Rules table — single source of truth for secret minimum lengths
// ---------------------------------------------------------------------------
//
// Shape: [name, minLen, requiredInProd, description]
//   - name: env var name
//   - minLen: minimum char length (raw env value length)
//   - requiredInProd: if true, missing-in-prod is a fatal error.
//                     if false, missing-anywhere is a warn-only.
//   - description: human-readable purpose (printed in error messages).
//
// Operator-cron secrets get a 32-char floor here and the matching
// per-call verify* helpers in server.js use the same 32-char floor.

export const SECRET_RULES = [
  // === Supabase (database + auth) ===
  ['SUPABASE_SERVICE_ROLE_KEY', 40, true,  'Supabase service-role key — bypasses RLS'],

  // === Stripe ===
  ['STRIPE_SECRET_KEY',         32, true,  'Stripe secret key (sk_live_...)'],
  ['STRIPE_WEBHOOK_SECRET',     32, true,  'Stripe webhook signing secret (whsec_...)'],

  // === Operator-cron secrets (Agent 02 handoff: ≥32 chars in prod) ===
  ['BACKFILL_SECRET',           32, true,  'Synthesis-backfill cron bearer'],
  ['ADMIN_INGEST_SECRET',       32, true,  'Feed/connector-poll cron bearer'],
  // Dedicated second gate for the vault reconciler's destructive delete mode
  // (X-Reconciler-Delete-Token). Optional — only needed when running the
  // reconciler with deletion enabled — but must be ≥32 chars when set.
  ['VAULT_RECONCILER_DELETE_SECRET', 32, false, 'Vault reconciler destructive-delete secret'],

  // === Connector AES key (must be 64 hex chars = 32 bytes for AES-256) ===
  ['CONNECTOR_TOKEN_KEY',       64, true,  'AES-256-GCM key for connector OAuth tokens (64 hex chars)'],

  // === Admin gate + HMAC signing (prod-required, no in-code default) ===
  // ADMIN_EMAILS: without this the /api/admin/* gate previously defaulted to
  // admin@lykn.io — anyone who could register that address got admin. Now the
  // default is removed and the value is mandatory in prod.
  ['ADMIN_EMAILS',              5,  true,  'Comma-separated admin email allowlist for /api/admin/*'],
  // VOICE_SESSION_SECRET: HMAC key for voice/file-proxy session tokens. Must be
  // its own dedicated secret — no service-role reuse, no dev-string fallback.
  ['VOICE_SESSION_SECRET',      32, true,  'HMAC signing key for voice/file-proxy session tokens'],

  // === AI provider keys (warn in prod if absent — service still boots) ===
  ['OPENAI_API_KEY',            20, false, 'OpenAI API key'],
  ['ANTHROPIC_API_KEY',         20, false, 'Anthropic API key'],
  ['GOOGLE_API_KEY',            20, false, 'Gemini API key'],
  ['XAI_API_KEY',               20, false, 'xAI / Grok API key'],

  // === Other server-side keys (warn-only) ===
  ['YOUTUBE_API_KEY',           20, false, 'YouTube Data API key'],
  ['RESEND_API_KEY',            20, false, 'Resend transactional email key'],
  ['SERPER_API_KEY',            20, false, 'Serper search proxy key'],
  ['LASTFM_API_KEY',            20, false, 'Last.fm public API key'],
  ['META_APP_TOKEN',            20, false, 'Meta (IG/FB) oEmbed app token'],
  ['WHISPER_HOSTED_API_KEY',    20, false, 'Hosted Whisper ASR key'],
  ['TRELLO_API_KEY',            16, false, 'Trello shared API key'],
  // Voice custom-LLM shared secret — warn if short; route also refuses <32.
  ['ELEVENLABS_LLM_SECRET',     32, false, 'ElevenLabs custom-LLM bearer secret'],
];

// Connector OAuth secrets — required only when the matching CLIENT_ID is set
// (i.e. that connector is actually enabled on this deployment). Disabled
// connectors don't fail the boot.
export const CONNECTOR_PAIRS = [
  ['GITHUB_CLIENT_ID',    'GITHUB_CLIENT_SECRET'],
  ['REDDIT_CLIENT_ID',    'REDDIT_CLIENT_SECRET'],
  ['NOTION_CLIENT_ID',    'NOTION_CLIENT_SECRET'],
  ['SPOTIFY_CLIENT_ID',   'SPOTIFY_CLIENT_SECRET'],
  ['PINTEREST_CLIENT_ID', 'PINTEREST_CLIENT_SECRET'],
  ['LINEAR_CLIENT_ID',    'LINEAR_CLIENT_SECRET'],
  ['TODOIST_CLIENT_ID',   'TODOIST_CLIENT_SECRET'],
  ['VIMEO_CLIENT_ID',     'VIMEO_CLIENT_SECRET'],
  ['RAINDROP_CLIENT_ID',  'RAINDROP_CLIENT_SECRET'],
  ['DRIBBBLE_CLIENT_ID',  'DRIBBBLE_CLIENT_SECRET'],
  ['GOOGLE_CLIENT_ID',    'GOOGLE_CLIENT_SECRET'],
  ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
  ['SLACK_CLIENT_ID',     'SLACK_CLIENT_SECRET'],
  ['X_CLIENT_ID',         'X_CLIENT_SECRET'],
  ['CANVA_CLIENT_ID',     'CANVA_CLIENT_SECRET'],
];
const CONNECTOR_SECRET_MIN = 20;

// Public VITE_* allowlist. Anything else with the VITE_ prefix is a
// configuration mistake (Vite would bundle it into the browser).
const PUBLIC_VITE_ALLOWLIST = new Set([
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_STRIPE_PUBLISHABLE_KEY',
  'VITE_API_BASE_URL',
  'VITE_FRONTEND_BASE_URL',
  'VITE_PUBLIC_MCP_URL',
  'VITE_ADMIN_EMAILS', // bundled into browser (information-disclosure flagged in SECURITY_REPORT_05)
  'VITE_ENABLE_LEGACY_NOTES',
]);

// ---------------------------------------------------------------------------
// Public Zod schema — exported for tests / documentation. Not used in the
// runtime path itself (the rules table is iterated directly because we
// want to distinguish "missing" from "too short" cleanly, plus give a
// stable structured error format).
// ---------------------------------------------------------------------------
export const secretShapeSchema = z.object({
  name: z.string().min(1).max(64),
  minLen: z.number().int().min(0).max(1024),
  requiredInProd: z.boolean(),
  description: z.string().min(1).max(200),
});

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function classifyEntry(name, minLen, requiredInProd, isProd, env) {
  const value = env[name];
  if (!value) {
    if (requiredInProd && isProd) return { kind: 'fatal', name, msg: `Missing required secret: ${name}` };
    return { kind: 'warn', name, msg: `Optional secret not set: ${name}` };
  }
  if (value.length < minLen) {
    const tip = name === 'CONNECTOR_TOKEN_KEY'
      ? `${name} must be 64 hex chars (32 bytes for AES-256). Generate with: openssl rand -hex 32`
      : `${name} must be at least ${minLen} characters (got ${value.length}). Generate with: openssl rand -base64 32`;
    if (isProd) return { kind: 'fatal', name, msg: tip };
    return { kind: 'warn', name, msg: tip };
  }
  return { kind: 'ok', name };
}

function findOrphanedConnectorSecrets(env, isProd) {
  // For each (CLIENT_ID, CLIENT_SECRET) pair: if CLIENT_ID is set but
  // CLIENT_SECRET is missing/short, flag it. Symmetrically, an orphan
  // CLIENT_SECRET (set without CLIENT_ID) is just dead config — INFO not
  // fatal.
  const findings = [];
  for (const [idName, secretName] of CONNECTOR_PAIRS) {
    const id = env[idName];
    const secret = env[secretName];
    if (id && id.trim()) {
      if (!secret) {
        findings.push({
          kind: isProd ? 'fatal' : 'warn',
          name: secretName,
          msg: `Connector ${idName} is set but ${secretName} is missing. Either both must be set or both must be unset.`,
        });
      } else if (secret.length < CONNECTOR_SECRET_MIN) {
        findings.push({
          kind: isProd ? 'fatal' : 'warn',
          name: secretName,
          msg: `${secretName} is too short (got ${secret.length}, minimum ${CONNECTOR_SECRET_MIN}).`,
        });
      }
    } else if (secret && secret.trim()) {
      findings.push({
        kind: 'warn',
        name: secretName,
        msg: `${secretName} is set but ${idName} is missing — dead config. Either remove ${secretName} or set ${idName}.`,
      });
    }
  }
  return findings;
}

function findViteServerSideLeaks(env) {
  const offenders = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith('VITE_')) continue;
    if (PUBLIC_VITE_ALLOWLIST.has(key)) continue;
    offenders.push(key);
  }
  return offenders;
}

/**
 * Run all checks. In production, exits the process on any fatal finding.
 * In development, prints findings and returns.
 *
 * Returns a summary object so tests can call this directly without
 * hitting process.exit (controlled via the `_exit` injected fn).
 */
export function validateSecrets(opts = {}) {
  const env = opts.env || process.env;
  const isProd = (opts.nodeEnv || env.NODE_ENV) === 'production';
  const exitFn = opts._exit || process.exit;
  const logFn = opts._log || console;

  const fatals = [];
  const warns = [];
  const oks = [];

  // Core rules table
  for (const [name, minLen, requiredInProd, description] of SECRET_RULES) {
    const r = classifyEntry(name, minLen, requiredInProd, isProd, env);
    if (r.kind === 'fatal') fatals.push(`${r.msg} (${description})`);
    else if (r.kind === 'warn') warns.push(`${r.msg} (${description})`);
    else oks.push(name);
  }

  // Connector OAuth pair coherence
  for (const f of findOrphanedConnectorSecrets(env, isProd)) {
    if (f.kind === 'fatal') fatals.push(f.msg);
    else warns.push(f.msg);
  }

  // VITE_*-leak guard — production-fatal regardless of value content because
  // the misconfiguration itself indicates a developer mistake we don't want
  // to ship. In dev, warn so the developer sees it before deploying.
  const viteLeaks = findViteServerSideLeaks(env);
  if (viteLeaks.length > 0) {
    const msg = `Server secrets must not use VITE_ prefix (Vite would bundle them into the browser): ${viteLeaks.join(', ')}`;
    if (isProd) fatals.push(msg);
    else warns.push(msg);
  }

  // Render the result
  if (fatals.length > 0) {
    logFn.error('[secrets] FATAL: server cannot start with the following issues:');
    for (const m of fatals) logFn.error(`  - ${m}`);
    if (warns.length > 0) {
      logFn.warn('[secrets] Additional warnings:');
      for (const m of warns) logFn.warn(`  - ${m}`);
    }
    exitFn(1);
    // Tests inject a no-op exitFn — fall through to return.
    return { ok: false, fatals, warns, oks };
  }

  if (warns.length > 0) {
    logFn.warn(`[secrets] ${warns.length} warning(s) (non-fatal in ${isProd ? 'production' : 'development'}):`);
    for (const m of warns) logFn.warn(`  - ${m}`);
  }

  logFn.log(`[secrets] Validated ${oks.length}/${SECRET_RULES.length} required secrets — boot OK`);
  return { ok: true, fatals, warns, oks };
}
