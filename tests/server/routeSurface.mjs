// ============================================================================
// tests/server/routeSurface.mjs — Express registration-surface extraction
// ============================================================================
// Reads the live Express 5 router stack (app.router.stack) and produces a
// deterministic, ordered description of the server's registration surface:
// every app.use() middleware and every route, in exact registration order,
// with method, path, handler-chain names, domain, and risk flags.
//
// This is the mechanical contract future extraction agents diff against.
// It intentionally records ONLY externally meaningful facts (order, method,
// path, chain names/length) — no handler internals — so the manifest stays
// stable across pure code moves and only changes when the surface changes.

/** Secret-gated cron/ops endpoints (Bearer shared-secret, no requireAuth). */
const SECRET_GATED_PATHS = new Set([
  '/api/discover/ingest',
  '/api/vault/reconcile',
  '/api/synthesis/backfill',
  '/api/feeds/poll-due',
  '/api/connections/poll-due',
  '/api/ai/cursor-builds/poll-due',
]);

/** SSE / streamed-response endpoints. */
const STREAMING_PATHS = new Set([
  '/api/ai/stream',
  '/api/ai/stream-guest',
  '/api/ai/elevenlabs/llm',
  '/api/ai/elevenlabs/llm/chat/completions',
  '/api/ai/elevenlabs/llm/chat/completions/chat/completions',
]);

/** Endpoints consumed by external machines (paths are frozen contracts). */
const EXTERNAL_CONTRACT_PATHS = new Set([
  '/api/stripe/webhook',            // Stripe
  '/api/health',                    // Render health check (render.yaml)
  '/oauth/callback/:provider',      // OAuth provider redirect URIs
  '/f/:token',                      // branded links in the wild
  '/api/ai/elevenlabs/llm',         // ElevenLabs custom-LLM proxy (3 aliases)
  '/api/ai/elevenlabs/llm/chat/completions',
  '/api/ai/elevenlabs/llm/chat/completions/chat/completions',
  ...SECRET_GATED_PATHS,            // external cron schedulers
]);

// Ordered domain rules — first match wins. Mirrors the domain grouping in
// docs/refactor/server-decomposition-plan.md §3.
const DOMAIN_RULES = [
  [/^\/api\/stripe\/webhook$|^\/api\/billing\b/, 'billing'],
  [/^\/api\/admin\//, 'admin'],
  [/^\/api\/usage\//, 'usage'],
  [/^\/api\/youtube\/|^\/api\/whisper\/transcribe$/, 'youtube'],
  [/^\/api\/search$|^\/api\/scrape$|^\/api\/unfurl$/, 'webtools'],
  [/^\/api\/files\/|^\/api\/vault\/save-/, 'files'],
  [/^\/api\/auth\/|^\/api\/feedback$|^\/api\/projects\/invite$/, 'authFlows'],
  // The poll-due cron trio belongs to the feeds/cron cluster.
  [/poll-due$|^\/api\/feeds\b/, 'feeds'],
  [/^\/api\/connections\b|^\/oauth\//, 'connectors'],
  [/^\/api\/custom-connections\b|^\/api\/v1\/concepts\b/, 'connections'],
  [/^\/api\/v1\/custom-models\b/, 'customModels'],
  [/^\/api\/discover\//, 'discover'],
  [/^\/api\/synthesis\b|^\/api\/vault\/enrich-note$|^\/api\/vault\/reconcile$/, 'synthesis'],
  [/^\/api\/learned\b|^\/api\/user-facts\b|^\/api\/beliefs\b|^\/api\/rules\b|^\/api\/applied\b|^\/api\/ai\/feedback$|^\/api\/v1\/synthesis\/activity$/, 'learning'],
  [/^\/api\/account\b|^\/api\/night-shift\b|^\/api\/steward\b|^\/api\/metrics\/ingest$/, 'account'],
  [/^\/api\/desktop\/|^\/api\/ai\/name-chat$/, 'desktop'],
  [/^\/api\/ai\/(tts|realtime|tune-instructions|elevenlabs)\b/, 'voice'],
  [/^\/api\/ai\/(imagine-image|describe-image|vault-search)$|^\/api\/storage\/|^\/api\/vault\/backfill-descriptions$/, 'vaultMedia'],
  [/^\/api\/ai\/(transcribe|meeting-chunk|summarize-conversation|clean-transcript|live-assist|meeting-notes|suggest|name-grid)$/, 'assistAi'],
  [/^\/api\/ai\/(models|stream|stream-guest|invoke|local-tool-result)$/, 'chatCore'],
  [/^\/api\/health$|^\/api\/client-error$|^\/f\/|^\/api\/artifacts\//, 'platform'],
];

export function classifyDomain(routePath) {
  for (const [re, domain] of DOMAIN_RULES) {
    if (re.test(routePath)) return domain;
  }
  return 'other';
}

function classifyFlags(routePath, chain) {
  const flags = [];
  if (chain.includes('requireAuth')) flags.push('auth');
  if (chain.includes('requireAdmin')) flags.push('admin');
  if (chain.includes('requireAppAccess')) flags.push('appAccess');
  if (chain.includes('checkAiUsageLimit')) flags.push('usageGate');
  if (chain.includes('multerMiddleware')) flags.push('upload');
  if (chain.includes('rawParser')) flags.push('rawBody');
  if (routePath === '/api/stripe/webhook') flags.push('webhook');
  if (SECRET_GATED_PATHS.has(routePath)) flags.push('secretGated');
  if (STREAMING_PATHS.has(routePath)) flags.push('streaming');
  if (EXTERNAL_CONTRACT_PATHS.has(routePath)) flags.push('externalContract');
  if (/^\/api\/(billing|stripe)\b/.test(routePath) || chain.includes('checkAiUsageLimit')) flags.push('billingSensitive');
  if (/^\/api\/desktop\//.test(routePath) || routePath === '/api/ai/local-tool-result' || routePath === '/api/ai/realtime/tool') flags.push('agentTool');
  return flags;
}

/** Probe an app.use() layer's mount prefix without relying on internals. */
function detectMount(layer) {
  const matches = (p) => {
    try {
      return Boolean(layer.match(p));
    } catch {
      return null;
    }
  };
  if (matches('/zz-mount-probe-zz')) return '/';
  if (matches('/api/zz-mount-probe-zz')) return '/api/';
  return '(unknown)';
}

/**
 * Extract the ordered registration surface from a live Express 5 app.
 * Returns an array of entries:
 *   { kind:'use',   name, mount, argc }
 *   { kind:'route', methods:[...], path, chain:[names], domain, flags:[...] }
 */
export function extractSurface(app) {
  const stack = app.router?.stack || app._router?.stack;
  if (!Array.isArray(stack)) throw new Error('Could not locate Express router stack');
  return stack.map((layer) => {
    if (layer.route) {
      const route = layer.route;
      const path = String(route.path);
      const methods = Object.keys(route.methods).map((m) => m.toUpperCase()).sort();
      const chain = route.stack.map((l) => l.name || '<anonymous>');
      return {
        kind: 'route',
        methods,
        path,
        chain,
        domain: classifyDomain(path),
        flags: classifyFlags(path, chain),
      };
    }
    return {
      kind: 'use',
      name: layer.name || '<anonymous>',
      mount: detectMount(layer),
      argc: layer.handle?.length ?? null,
    };
  });
}

/** Duplicate registrations: same METHOD+path appearing more than once. */
export function findDuplicates(entries) {
  const seen = new Map();
  const dupes = [];
  entries.forEach((e, i) => {
    if (e.kind !== 'route') return;
    for (const m of e.methods) {
      const key = `${m} ${e.path}`;
      if (seen.has(key)) dupes.push({ key, firstIndex: seen.get(key), duplicateIndex: i });
      else seen.set(key, i);
    }
  });
  return dupes;
}

function pathToMatcher(routePath) {
  // Express 5 param segments (:name) → one non-slash segment. Escape the rest.
  const pattern = routePath
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${pattern}/?$`);
}

/**
 * Ordering hazards between param routes and static routes sharing a method.
 *   shadowedStatic  — an EARLIER param route already captures a LATER static
 *                     path (the static handler is dead; would be a live bug).
 *   orderSensitive  — a LATER param route would capture an EARLIER static
 *                     path if their registration order ever flipped
 *                     (the hazard future extraction must not introduce).
 */
export function analyzeOrderHazards(entries) {
  const routes = entries
    .map((e, index) => ({ ...e, index }))
    .filter((e) => e.kind === 'route');
  const shadowedStatic = [];
  const orderSensitive = [];
  for (const param of routes) {
    if (!param.path.includes(':')) continue;
    const matcher = pathToMatcher(param.path);
    for (const other of routes) {
      if (other.index === param.index || other.path.includes(':')) continue;
      const sharedMethods = param.methods.filter((m) => other.methods.includes(m));
      if (sharedMethods.length === 0) continue;
      if (!matcher.test(other.path)) continue;
      const record = {
        methods: sharedMethods,
        paramRoute: param.path,
        staticRoute: other.path,
      };
      if (param.index < other.index) shadowedStatic.push(record);
      else orderSensitive.push(record);
    }
  }
  return { shadowedStatic, orderSensitive };
}

/** Full manifest document (what gets checked in / diffed). */
export function buildManifest(app) {
  const entries = extractSurface(app);
  const routes = entries.filter((e) => e.kind === 'route');
  const byDomain = {};
  const byMethod = {};
  for (const r of routes) {
    byDomain[r.domain] = (byDomain[r.domain] || 0) + 1;
    for (const m of r.methods) byMethod[m] = (byMethod[m] || 0) + 1;
  }
  return {
    _comment: [
      'GENERATED — do not edit by hand. Regenerate with: npm run test:server:update-manifest',
      'Ordered registration surface of server.js (Express app). Entry order IS the contract:',
      'Express matches in registration order, so any reordering here is a behavior change.',
    ],
    routeCount: routes.length,
    middlewareCount: entries.length - routes.length,
    byMethod: Object.fromEntries(Object.entries(byMethod).sort()),
    byDomain: Object.fromEntries(Object.entries(byDomain).sort()),
    duplicates: findDuplicates(entries),
    orderHazards: analyzeOrderHazards(entries),
    entries,
  };
}
