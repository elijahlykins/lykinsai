import { fetchWebPage } from './webFetch.js';

const DEFAULT_NUM_RESULTS = 5;
const DEEP_BROWSE_COUNT = 3;
const DEEP_PAGE_MAX_CHARS = 2000;

/**
 * Live web search via Serper. Callable from the agent-loop tool or server pre-fetch.
 */
export async function searchWeb(query, opts = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return { ok: false, error: 'query is required' };
  if (!process.env.SERPER_API_KEY) {
    return { ok: false, error: 'web_search_not_configured' };
  }

  const num = Math.max(1, Math.min(10, Number(opts.num) || DEFAULT_NUM_RESULTS));
  const deepBrowse = opts.deepBrowse !== false;
  // Serper: /search (organic) or /news. Used by deep research source prefs.
  const endpoint =
    String(opts.type || opts.serperType || '').toLowerCase() === 'news'
      ? 'https://google.serper.dev/news'
      : 'https://google.serper.dev/search';

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q, num }),
    });

    if (!res.ok) {
      let detail = '';
      try { detail = String(await res.text() || '').slice(0, 240); } catch { /* ignore */ }
      const creditsGone = /not enough credits/i.test(detail);
      if (detail) {
        console.warn(`⚠️ Serper ${res.status}${creditsGone ? ' (out of credits)' : ''}: ${detail}`);
      }
      return {
        ok: false,
        error: creditsGone ? 'serper_no_credits' : `serper_http_${res.status}`,
        query: q,
      };
    }

    const data = await res.json();
    const organic = Array.isArray(data.organic)
      ? data.organic
      : Array.isArray(data.news)
        ? data.news
        : [];
    const results = organic.slice(0, num).map((item, i) => ({
      rank: i + 1,
      title: item.title || 'Untitled',
      url: item.link || '',
      snippet: item.snippet || item.date || '',
    }));

    let pages = [];
    if (deepBrowse && results.length > 0) {
      const browseTargets = results.filter((r) => r.url).slice(0, DEEP_BROWSE_COUNT);
      const fetched = await Promise.all(
        browseTargets.map(async (hit) => {
          const page = await fetchWebPage(hit.url, { maxChars: DEEP_PAGE_MAX_CHARS });
          if (!page.ok || !page.content || page.content.length < 100) return null;
          return {
            title: hit.title,
            url: hit.url,
            content: page.content,
          };
        }),
      );
      pages = fetched.filter(Boolean);
    }

    return {
      ok: true,
      query: q,
      result_count: results.length,
      results,
      pages,
    };
  } catch (err) {
    return { ok: false, error: err?.message || 'search_error', query: q };
  }
}

/** Format search results for legacy prompt injection in server.js. */
export function formatSearchResultsForPrompt(payload) {
  if (!payload?.ok || !payload.results?.length) return '';

  const formatted = payload.results
    .map((item) => `${item.rank}. [${item.title}](${item.url}) — ${item.snippet}`)
    .join('\n');

  let deepContent = '';
  if (payload.pages?.length) {
    const blocks = payload.pages.map(
      (p) => `[PAGE: ${p.title} — ${p.url}]\n${p.content}`,
    );
    deepContent = `\n\n[DEEP_BROWSE_CONTENT]\nFull page content from top results. Use this for detailed, accurate answers:\n\n${blocks.join('\n\n---\n\n')}`;
  }

  return `[WEB_SEARCH_RESULTS]\nThe following are live web search results. Use them to give accurate, current answers. You MUST include a "Sources:" section at the very end of your response listing each source as a markdown link.\n${formatted}${deepContent}`;
}

/** Pull markdown citation links out of a search/evidence prompt block. */
export function extractSourcesFromSearchPrompt(text) {
  const out = [];
  const seen = new Set();
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const url = m[2];
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: String(m[1] || 'Source').trim() || 'Source', url });
  }
  return out.slice(0, 40);
}
