const MAX_VAULT_NOTE_IDS = 80;

/** Normalize vault note id list from API query/body. */
export function parseVaultNoteIds(raw) {
  if (raw == null) return [];
  let list = raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const id = String(item || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_VAULT_NOTE_IDS) break;
  }
  return out;
}
