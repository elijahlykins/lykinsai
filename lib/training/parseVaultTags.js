const MAX_VAULT_TAGS = 40;

/** Normalize vault tag list from API query/body. */
export function parseVaultTags(raw) {
  if (raw == null) return [];
  let list = raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
      else list = raw.split(',');
    } catch {
      list = raw.split(',');
    }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const t = String(item || '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_VAULT_TAGS) break;
  }
  return out;
}
