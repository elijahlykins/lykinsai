// ============================================================================
// mcp-tools/searchVault.js — MCP tool wrapper around hybrid vault search
// ============================================================================
// Engine lives in lib/rag/vaultHybrid.js so Vault retrieval paths share it
// without a circular import through mcp-tools/index.js.

import { jsonContent, errorContent } from './content.js';
import {
  retrieveVaultHybridHits,
  normalizeVaultSearchQuery,
  VAULT_HYBRID_MAX_RESULTS,
  VAULT_HYBRID_DEFAULT_LIMIT,
} from '../lib/rag/vaultHybrid.js';

export { retrieveVaultHybridHits, normalizeVaultSearchQuery };

const MAX_QUERY_LEN = 200;

export const searchVaultTool = {
  name: 'lykn_searchVault',
  title: "Search the user's LYKN vault for notes / saved items",
  scope: 'read',
  description: [
    'Hybrid search across the LYKN user\'s vault (notes, saved articles,',
    'links, files, IMAGES, AI snippets, artifacts). Combines BM25 + title',
    'match + related-word expansion (synonyms / variants) + semantic vector',
    'search + reranking — so "prosthetics" can find "artificial limb" notes,',
    'and images/files match on vision descriptions, not just literal words.',
    'Returns compact hits: { node_id, title, snippet, match, similarity? }.',
    'Follow up with read_document using node_id when the',
    'user wants the full body. Do not return full notes from search.',
    '',
    'QUERY TIP: pass the TOPIC words (e.g. "porsche pricing"), not the full',
    'chat sentence. If the first query returns little, retry with a synonym',
    'or a broader noun before telling the user it\'s not there.',
    '',
    'IMPORTANT — hits are SNIPPETS, and they DO NOT render in the LYKN',
    'chat on their own. If the user wants to SEE / OPEN / READ / "bring',
    'in" / "pull up" / "show me" a saved item (any verb implying looking',
    'at the thing itself, not just discussing it), follow up with',
    '`read_document({ node_id })` for the full body, or display_document',
    'to put it on screen.',
    '',
    'Skip the full read only when the user wants a LIST of titles',
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
        description:
          'Topic-focused search query (nouns/phrases). Hybrid BM25 + semantic — prefer "porsche pricing" over a full chat sentence.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: VAULT_HYBRID_MAX_RESULTS,
        description: `Max results to return (1-${VAULT_HYBRID_MAX_RESULTS}). Defaults to ${VAULT_HYBRID_DEFAULT_LIMIT}.`,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (ctx?.skipVaultSearch) {
      return errorContent(
        'The old vault search is retired. Use [AI DRIVE] + lykn_open_app for things LYKN built, ' +
          'and local_search_files / local_list_dir / local_pull_file for files on their Mac. ' +
          'Do not search connected apps or a media library.',
      );
    }
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }
    const queryRaw = String(args?.query || '').trim().slice(0, MAX_QUERY_LEN);
    if (!queryRaw) return errorContent('query is required and must be non-empty.');
    const limit = Number.isFinite(args.limit)
      ? Math.max(1, Math.min(VAULT_HYBRID_MAX_RESULTS, args.limit))
      : VAULT_HYBRID_DEFAULT_LIMIT;

    const result = await retrieveVaultHybridHits(ctx, { query: queryRaw, limit });
    if (result.ok === false) {
      return errorContent(result.error || 'Vault search failed.');
    }
    return jsonContent(result);
  },
};
