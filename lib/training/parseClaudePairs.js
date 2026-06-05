/**
 * Parse Claude JSON array output into validated training pairs.
 */

function stripCodeFences(raw) {
  let s = String(raw || '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(s);
  if (fence) s = fence[1].trim();
  return s;
}

function tryParseJsonLoose(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    /* continue */
  }
  const start = raw.search(/[\[{]/);
  const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

export function normalizePromptKey(prompt) {
  return String(prompt || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export function isLowQualityPair(pair, { minResponseChars = 20, genericPatterns = [] } = {}) {
  const response = String(pair?.response || '').trim();
  if (response.length < minResponseChars) return true;
  for (const re of genericPatterns) {
    if (re.test(response)) return true;
  }
  return false;
}

/**
 * @returns {{ pairs: Array<{prompt:string,response:string}>, errors: string[] }}
 */
export function parseClaudePairs(rawText, opts = {}) {
  const errors = [];
  const cleaned = stripCodeFences(rawText);
  const parsed = tryParseJsonLoose(cleaned);
  if (!parsed) {
    return { pairs: [], errors: ['json_parse_failed'] };
  }
  const arr = Array.isArray(parsed) ? parsed : parsed?.pairs;
  if (!Array.isArray(arr)) {
    return { pairs: [], errors: ['expected_json_array'] };
  }

  const pairs = [];
  for (const item of arr) {
    const prompt = String(item?.prompt ?? '').trim();
    const response = String(item?.response ?? '').trim();
    if (!prompt || !response) {
      errors.push('missing_prompt_or_response');
      continue;
    }
    const row = { prompt, response };
    if (isLowQualityPair(row, opts)) {
      errors.push('low_quality_filtered');
      continue;
    }
    pairs.push(row);
  }
  return { pairs, errors };
}

export function dedupeAndShufflePairs(pairs, maxPairs) {
  const seen = new Set();
  const unique = [];
  for (const p of pairs) {
    const key = normalizePromptKey(p.prompt);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  for (let i = unique.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [unique[i], unique[j]] = [unique[j], unique[i]];
  }
  return unique.slice(0, maxPairs);
}
