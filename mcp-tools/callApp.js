// ============================================================================
// mcp-tools/callApp.js — call ANY app the user connected (bring-your-own key)
// ============================================================================
// The universal action tool. The user attaches an app under Connections →
// Custom API (base URL + their API key + how to send it). This tool makes an
// HTTP request to that app, with the credential INJECTED server-side — the
// model only names the connection (by slug) and supplies method/path/body. It
// never sees, and must never ask for, the API key.
//
// Guardrails (enforced in lib/customConnections/customConnections.js):
//   • requests are host-pinned to the connection's base URL
//   • SSRF guard (no localhost / private IPs / cloud metadata)
//   • GET/HEAD always allowed; POST/PUT/PATCH/DELETE only when the connection
//     has writes enabled (otherwise the call is rejected — tell the user)
//   • response size + timeout capped; per-user/host rate limited

import { jsonContent, errorContent, requireWrite } from './content.js';

export const callAppTool = {
  name: 'lykn_call_app',
  title: 'Call a connected app\'s API (uses the user\'s stored key)',
  scope: 'write',
  description: [
    'Make an HTTP request to one of the user\'s connected apps (an arbitrary',
    'API they attached under Connections → Custom API). Use this to actually',
    'DO things in the user\'s tools — read records, search, create/update items',
    '— whenever the requested action lives in an app they\'ve connected.',
    '',
    'HOW: pass "connection" = the app\'s slug (from lykn_list_apps), the HTTP',
    '"method", a "path" relative to the app\'s base URL (e.g. "/v2/contacts"),',
    'and optional "query"/"body". The user\'s API key is added automatically by',
    'the server — do NOT include it, ask for it, or put it in headers.',
    '',
    'WRITES: GET is always allowed. POST/PUT/PATCH/DELETE only work if the',
    'connection has writes enabled; if a write is rejected with',
    '"writes_not_enabled", tell the user they need to enable writes for that',
    'connection in Connections (do not retry). Confirm destructive actions with',
    'the user first.',
    '',
    'If you don\'t know the slug, call lykn_list_apps first. Read the response',
    'status + body back plainly; on errors, report what the API returned.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      connection: {
        type: 'string',
        description: 'The slug of the connected app to call (from lykn_list_apps).',
      },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
        description: 'HTTP method. Defaults to GET.',
      },
      path: {
        type: 'string',
        description: 'Path relative to the connection\'s base URL (e.g. "/v1/items"). Leading slash optional.',
      },
      query: {
        type: 'object',
        description: 'Optional query-string parameters as a flat key→value object.',
        additionalProperties: true,
      },
      body: {
        description: 'Optional request body for write methods (object → sent as JSON, or a raw string).',
      },
      headers: {
        type: 'object',
        description: 'Optional extra request headers. Authorization/Cookie are ignored (the key is injected server-side).',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['connection'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx = {}) {
    const writeBlock = requireWrite(ctx);
    if (writeBlock) return writeBlock;
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const connection = String(args.connection || '').trim();
    if (!connection) {
      return errorContent('missing_connection: name which connected app to call (its slug from lykn_list_apps).');
    }

    let callApp;
    try {
      ({ callApp } = await import('../lib/customConnections/customConnections.js'));
    } catch (e) {
      return errorContent(`custom_connections_unavailable: ${e?.message || e}`);
    }

    const result = await callApp({
      client: ctx.supabaseAdmin,
      userId: ctx.userId,
      connection,
      method: args.method,
      path: args.path,
      query: args.query || null,
      body: args.body !== undefined ? args.body : null,
      headers: args.headers || null,
    });

    return jsonContent(result);
  },
};
