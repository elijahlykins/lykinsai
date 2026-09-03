// ============================================================================
// mcp-tools/vaultItemLoad.js — internal vault-item hydrate
// ============================================================================
// Not a Chat/Voice tool. Voice read_document / display_document call this
// after resolving a vault_<uuid>. Markdown Memory stays on memory_*.

const VAULT_CONTENT_CAP = 16000;

function maybeTruncate(text, cap) {
  const str = String(text || '');
  if (str.length <= cap) return { text: str, truncated: false };

  const marker = '[ATTACHMENTS_JSON:';
  const markerAt = str.indexOf(marker);
  if (markerAt >= 0) {
    const markerChunk = str.slice(markerAt);
    if (markerChunk.length <= cap) {
      const bodyBudget = Math.max(0, cap - markerChunk.length - 2);
      const body = str.slice(0, markerAt).slice(0, bodyBudget).trimEnd();
      return {
        text: body ? `${body}\n\n${markerChunk}` : markerChunk,
        truncated: true,
        full_length: str.length,
      };
    }
  }

  return {
    text: str.slice(0, cap),
    truncated: true,
    full_length: str.length,
  };
}

/**
 * Load one vault_items row for the authenticated user.
 * Returns the payload object, `{ __error }`, or `{ ok: false, reason }`.
 */
export async function loadVaultItemById(nodeIdRaw, ctx, options = {}) {
  const vaultCap = Number.isFinite(options.vaultCap) ? options.vaultCap : VAULT_CONTENT_CAP;
  const idRaw = typeof nodeIdRaw === 'string' ? nodeIdRaw.trim() : '';
  if (!idRaw) {
    return { ok: false, reason: 'missing_node_id', message: 'node_id is required.' };
  }
  if (!ctx?.supabaseAdmin || !ctx?.userId) {
    return { __error: 'Unauthorized — no LYKN user resolved.' };
  }

  let nodeId = idRaw;
  if (!nodeId.startsWith('vault_')) {
    if (!/^[0-9a-f-]{8,36}$/i.test(nodeId)) {
      return {
        ok: false,
        reason: 'unrecognised_node_id',
        node_id: idRaw,
        message: 'node_id must be prefixed with vault_.',
      };
    }
    nodeId = `vault_${nodeId}`;
  }

  const id = nodeId.slice('vault_'.length);
  const { data, error } = await ctx.supabaseAdmin
    .from('vault_items')
    .select('id, title, content, tags, folder, source, created_at, updated_at')
    .eq('user_id', ctx.userId)
    .eq('id', id)
    .maybeSingle();
  if (error) return { __error: `vault note load failed: ${error.message}` };
  if (!data) {
    return {
      ok: false,
      reason: 'not_found',
      node_id: nodeId,
      message: 'That vault note id is not in the user\'s vault.',
    };
  }
  const body = maybeTruncate(data.content, vaultCap);
  return {
    ok: true,
    kind: 'vault',
    node_id: nodeId,
    display: `Vault note: "${data.title || '(untitled)'}"\n\n${body.text}${body.truncated ? `\n\n[truncated — full note is ${body.full_length} chars; open ${`/vault?note=${data.id}`} for the rest]` : ''}`,
    note: {
      id: data.id,
      title: data.title,
      content: body.text,
      truncated: body.truncated,
      full_length: body.truncated ? body.full_length : body.text.length,
      tags: data.tags || [],
      folder: data.folder,
      source: data.source,
      created_at: data.created_at,
      updated_at: data.updated_at,
      url: `/vault?note=${encodeURIComponent(data.id)}`,
    },
  };
}

export { VAULT_CONTENT_CAP };
