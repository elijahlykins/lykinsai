// ============================================================================
// mcp-tools/listApps.js — LEGACY custom-connection discovery
// ============================================================================
// Isolated / legacy. Universal external tools now go through MCP
// (lib/mcp + ExternalToolResolver). Do not treat this as the future
// action layer. Not deleted until MCP parity is proven.

// Read. Lists the apps the user attached via Connections → Custom API (their
// own API keys). The agent calls this to learn which connections exist, each
// one's slug (how to reference it in lykn_call_app), what it's for, and whether
// writes are allowed. The secret is never returned.

import { jsonContent, errorContent } from './content.js';

export const listAppsTool = {
  name: 'lykn_list_apps',
  title: 'List the user\'s connected apps (custom API keys)',
  scope: 'read',
  description: [
    'List the custom app connections the user has attached to LYKN (their own',
    'API keys for arbitrary apps/services). Call this BEFORE lykn_call_app when',
    'you need to act on one of the user\'s apps and don\'t already know its slug,',
    'or when the user asks "what apps/APIs have I connected".',
    '',
    'Returns each connection\'s: slug (use this as the "connection" arg to',
    'lykn_call_app), name, base_url, description (what the API does / key',
    'endpoints), and writes_allowed (whether mutating calls are permitted).',
    'Never reveal or ask for the API key itself — it is injected server-side.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(_args = {}, ctx = {}) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }
    let listCustomConnections;
    let listOAuthBackedApps;
    try {
      ({ listCustomConnections, listOAuthBackedApps } = await import('../lib/customConnections/customConnections.js'));
    } catch (e) {
      return errorContent(`custom_connections_unavailable: ${e?.message || e}`);
    }

    let rows;
    try {
      rows = await listCustomConnections(ctx.supabaseAdmin, ctx.userId);
    } catch (e) {
      return errorContent(e?.message || 'Could not list connected apps.');
    }

    const customApps = (rows || [])
      .filter((r) => r.status === 'active')
      .map((r) => ({
        slug: r.slug,
        name: r.name,
        base_url: r.base_url,
        description: r.description || null,
        writes_allowed: Boolean(r.allow_writes),
        auth: r.auth_type === 'none' ? 'public' : 'key-on-file',
      }));

    // OAuth-backed action apps (e.g. Slack connected via the one-click OAuth
    // flow). Same lykn_call_app contract; the token was minted by OAuth rather
    // than pasted. A custom connection with the same slug takes precedence.
    let oauthApps = [];
    try {
      const list = await listOAuthBackedApps(ctx.supabaseAdmin, ctx.userId);
      const customSlugs = new Set(customApps.map((a) => a.slug));
      oauthApps = (list || [])
        .filter((a) => !customSlugs.has(a.slug))
        .map((a) => ({
          slug: a.slug,
          name: a.name,
          base_url: a.base_url,
          description: a.description || null,
          writes_allowed: Boolean(a.allow_writes),
          auth: 'oauth',
        }));
    } catch {
      // Non-fatal — fall back to custom apps only.
    }

    const apps = [...customApps, ...oauthApps];

    return jsonContent({
      ok: true,
      count: apps.length,
      apps,
      message: apps.length
        ? 'Use a slug as the "connection" arg to lykn_call_app.'
        : 'No custom apps connected. The user can attach one in Connections → Custom API.',
    });
  },
};
