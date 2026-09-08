const WEB_SOURCE_TOOLS = new Set([
  'lykn_web_search',
  'web_search',
  'lykn_web_fetch',
  'web_fetch',
]);

/** Deduped {title,url} list, cap 40. Later titles for the same URL keep the first. */
export function mergeCitationSources(base, extra) {
  const out = [];
  const seen = new Set();
  for (const raw of [...(base || []), ...(extra || [])]) {
    if (!raw || typeof raw !== 'object') continue;
    const url = String(raw.url || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: String(raw.title || url).trim().slice(0, 160) || url,
      url,
    });
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * Citation links from a completed web search or page-fetch tool result.
 * Empty when the tool is unrelated, failed, or returned no URLs.
 */
export function extractSourcesFromWebToolResult(name, result) {
  if (!WEB_SOURCE_TOOLS.has(String(name || '')) || !result || result.ok === false) {
    return [];
  }
  const extra = [];
  if (Array.isArray(result.results)) {
    for (const hit of result.results) {
      if (hit && hit.url) extra.push({ title: hit.title, url: hit.url });
    }
  }
  if (Array.isArray(result.pages)) {
    for (const page of result.pages) {
      if (page && page.url) extra.push({ title: page.title, url: page.url });
    }
  }
  if (typeof result.url === 'string' && result.url.trim()) {
    extra.push({ title: result.title, url: result.url });
  }
  return mergeCitationSources([], extra);
}
