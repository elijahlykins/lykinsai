/**
 * Canonical LYKN training format: one {"prompt","response"} object per line.
 */

export function pairsToJsonl(pairs) {
  return pairs.map((p) => JSON.stringify({ prompt: p.prompt, response: p.response })).join('\n');
}

export function parseJsonl(content) {
  const lines = String(content || '').split('\n').filter((l) => l.trim());
  const pairs = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row?.prompt && row?.response) pairs.push({ prompt: row.prompt, response: row.response });
    } catch {
      /* skip bad line */
    }
  }
  return pairs;
}
