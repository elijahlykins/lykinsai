
const DEFAULT_NOTE_LIMIT = 30;
const DEFAULT_MAX_CHARS_PER_NOTE = 14_000;

function truncateText(text, maxChars) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}…`;
}

function vaultIncludesDocuments(vaultSource) {
  return vaultSource === 'all' || vaultSource === 'tagged' || vaultSource === 'selected';
}

/**
 * Recent vault notes as raw text for document chunking.
 */
export async function fetchVaultNoteChunks(client, userId, opts = {}) {
  if (!client || !userId) return [];
  const limit = Math.min(Math.max(Number(opts.limit) || DEFAULT_NOTE_LIMIT, 1), 80);
  const maxChars = Math.min(
    Math.max(Number(opts.maxCharsPerNote) || DEFAULT_MAX_CHARS_PER_NOTE, 500),
    50_000,
  );

  const tags = Array.isArray(opts.tags)
    ? opts.tags.map((t) => String(t || '').trim()).filter(Boolean)
    : [];

  const noteIds = Array.isArray(opts.noteIds)
    ? opts.noteIds.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 80)
    : [];

  let query = client
    .from('vault_items')
    .select('id, title, content, ai_summary, source, updated_at, tags')
    .eq('user_id', userId);

  if (noteIds.length > 0) {
    query = query.in('id', noteIds);
  } else if (tags.length > 0) {
    query = query.overlaps('tags', tags);
  }

  const { data, error } = await query
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(noteIds.length > 0 ? Math.min(noteIds.length, limit) : limit);

  if (error) {
    console.warn('[training] fetchVaultNoteChunks:', error.message);
    return [];
  }

  return (data || [])
    .map((n) => {
      const raw = n.content || n.ai_summary || '';
      const body = truncateText(raw, maxChars);
      return {
        id: n.id,
        title: (n.title || 'Untitled').trim(),
        source: n.source || null,
        updated_at: n.updated_at,
        text: body,
        char_count: body.length,
      };
    })
    .filter((c) => c.char_count >= (Number.isFinite(opts.minChars) ? opts.minChars : 80));
}
