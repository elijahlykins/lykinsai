// ============================================================================
// mcp-tools/searchVault.js — substring search over the user's vault notes
// ============================================================================
// Read-only. Cheap keyword/substring search against the `notes` table —
// title + content. We deliberately keep this dumb (no LLM) so it's fast,
// deterministic, and free. The user's outside AI client is the smart half;
// it can re-rank / synthesise / quote whatever we return.
//
// If/when we add embedding search, this tool's name and shape stay the
// same — the handler grows a fallback path. External clients shouldn't
// need to know.

import { jsonContent, errorContent } from './index.js';

const MAX_QUERY_LEN = 200;
const MAX_RESULTS = 25;

export const searchVaultTool = {
  name: 'lykn.searchVault',
  title: 'Search the user\'s LYKN vault for notes / saved items',
  scope: 'read',
  description: [
    'Search the LYKN user\'s vault — their personal long-term memory of',
    'notes, saved articles, links, files, and AI-generated snippets — for',
    'substring matches against title and content. Returns up to 25 hits',
    'ranked by recency.',
    '',
    'Use this when the user asks something that\'s likely already in their',
    'archive ("what did I save about X?", "find that article on Y", "did',
    'I take notes on Z?"). Quote the matching snippet rather than',
    'paraphrasing — the user trusts what they wrote.',
    '',
    'Each result includes the note id and a URL. If the user wants to',
    'open the item, send them to /vault?note=<id>.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Free-text query. Substring match — keep it short and specific.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 25,
        description: `Max results to return (1-${MAX_RESULTS}). Defaults to 10.`,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }
    const queryRaw = String(args?.query || '').trim().slice(0, MAX_QUERY_LEN);
    if (!queryRaw) return errorContent('query is required and must be non-empty.');
    const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(MAX_RESULTS, args.limit)) : 10;

    // Supabase `ilike` substring search on title + content. PostgREST
    // supports `or=(title.ilike.%X%,content.ilike.%X%)`.
    const escaped = queryRaw.replace(/[%_]/g, '\\$&');
    const pattern = `%${escaped}%`;

    const { data, error } = await ctx.supabaseAdmin
      .from('notes')
      .select('id, title, content, created_at, updated_at, tags')
      .eq('user_id', ctx.userId)
      .or(`title.ilike.${pattern},content.ilike.${pattern}`)
      .order('updated_at', { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) {
      console.warn('[mcp:searchVault]', error.message);
      return errorContent(`vault search failed: ${error.message}`);
    }

    const hits = (data || []).map((n) => {
      const text = String(n.content || '');
      const idx = text.toLowerCase().indexOf(queryRaw.toLowerCase());
      const snippet = idx >= 0
        ? text.slice(Math.max(0, idx - 60), Math.min(text.length, idx + queryRaw.length + 180))
        : text.slice(0, 240);
      return {
        id: n.id,
        title: n.title || '(untitled)',
        snippet: snippet.trim(),
        tags: Array.isArray(n.tags) ? n.tags.slice(0, 8) : [],
        created_at: n.created_at,
        updated_at: n.updated_at,
        url: `/vault?note=${encodeURIComponent(n.id)}`,
      };
    });

    return jsonContent({
      ok: true,
      query: queryRaw,
      count: hits.length,
      hits,
    });
  },
};
