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
  name: 'lykn_searchVault',
  title: 'Search the user\'s LYKN vault for notes / saved items',
  scope: 'read',
  description: [
    'Substring search across the LYKN user\'s vault (notes, saved articles,',
    'links, files, AI snippets). Returns up to 25 hits ranked by recency.',
    'Each hit: { node_id: "vault_<uuid>", id, title, snippet, tags,',
    'created_at, updated_at, url: "/vault?note=<id>" }.',
    '',
    'IMPORTANT — hits are SNIPPETS, and they DO NOT render in the LYKN',
    'chat on their own. If the user wants to SEE / OPEN / READ / "bring',
    'in" / "pull up" / "show me" a saved item (any verb implying looking',
    'at the thing itself, not just discussing it), you MUST follow up',
    'with `lykn_loadNeuron({ node_id })` — or `lykn_loadNeurons` for',
    'several — using the `node_id` field from the hit (NOT the bare `id`,',
    'which is missing the required `vault_` prefix). loadNeuron returns',
    'the full body AND causes the saved file/note/link/image to render as',
    'a rich card under your reply. Don\'t paraphrase the snippet in that',
    'case — the card shows the content; your prose just frames WHY you',
    'brought it in.',
    '',
    'Skip the loadNeuron step only when the user wants a LIST of titles',
    '("what notes do I have on X?") and is not asking to see the items.',
    '',
    'Typical triggers: "what did I save about X?", "find that article on',
    'Y", "did I take notes on Z?", "pull up my note on …".',
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
        // Stable cross-store id the model can hand directly to
        // lykn_loadNeuron / lykn_loadNeurons / lykn_addProjectNeurons.
        // Without this the model has to know to prefix `vault_` itself,
        // which it routinely got wrong (passing the bare uuid into
        // loadNeuron returns "unrecognised_node_id" and the saved note
        // never makes it into the chat as a rich card).
        node_id: `vault_${n.id}`,
        // Bare uuid kept for backward compat with anything that already
        // reads `id` (the REST mirror docs reference it). New callers
        // should prefer `node_id`.
        id: n.id,
        title: n.title || '(untitled)',
        snippet: snippet.trim(),
        tags: (Array.isArray(n.tags) ? n.tags : [])
          .map((t) => (typeof t === 'string' ? t : t?.name || t?.label || String(t || '')))
          .filter(Boolean)
          .slice(0, 8),
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
