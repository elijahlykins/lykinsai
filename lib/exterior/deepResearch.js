/**
 * Perplexity-style deep research pipeline:
 *   plan → parallel multi-query search → browse → gap pass → evidence pack
 *
 * Used when the client sends deepResearch: true (Glass Research / main Deep research).
 */
import { searchWeb } from './webSearch.js';
import { fetchWebPage } from './webFetch.js';

const PLAN_MODEL = process.env.DEEP_RESEARCH_PLAN_MODEL || 'gpt-4o-mini';

function envInt(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

const MAX_QUERIES = envInt('DEEP_RESEARCH_QUERIES', 8, 3, 12);
const RESULTS_PER_QUERY = envInt('DEEP_RESEARCH_RESULTS_PER_QUERY', 5, 3, 10);
const MAX_CANDIDATES = envInt('DEEP_RESEARCH_CANDIDATES', 16, 8, 30);
const MAX_PAGES = envInt('DEEP_RESEARCH_PAGES', 10, 4, 20);
const GAP_MAX_QUERIES = envInt('DEEP_RESEARCH_GAP_QUERIES', 4, 0, 6);
const GAP_MAX_PAGES = envInt('DEEP_RESEARCH_GAP_PAGES', 5, 0, 10);
const PAGE_MAX_CHARS = envInt('DEEP_RESEARCH_PAGE_CHARS', 3500, 1500, 6000);
const PROMPT_MAX_CHARS = envInt('DEEP_RESEARCH_PROMPT_CHARS', 72000, 20000, 120000);
const SEARCH_CONCURRENCY = envInt('DEEP_RESEARCH_SEARCH_CONCURRENCY', 4, 1, 8);
const BROWSE_CONCURRENCY = envInt('DEEP_RESEARCH_BROWSE_CONCURRENCY', 4, 1, 8);
const PLAN_TIMEOUT_MS = envInt('DEEP_RESEARCH_PLAN_TIMEOUT_MS', 12000, 4000, 30000);

function aborted(signal) {
  return Boolean(signal?.aborted);
}

function throwIfAborted(signal) {
  if (aborted(signal)) {
    const err = new Error('deep_research_aborted');
    err.code = 'ABORTED';
    throw err;
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    u.hash = '';
    // Drop common tracking params lightly.
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return String(url || '').trim();
  }
}

async function mapPool(items, concurrency, fn) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const results = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (next < list.length) {
      const idx = next++;
      results[idx] = await fn(list[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

function status(onStatus, msg) {
  if (typeof onStatus === 'function' && msg) {
    try {
      onStatus(String(msg));
    } catch {
      /* ignore */
    }
  }
}

function heuristicQueries(topic, max) {
  const q = String(topic || '').trim();
  if (!q) return [];
  const out = [q];
  const add = (s) => {
    const t = String(s || '').trim().slice(0, 200);
    if (!t) return;
    if (out.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    out.push(t);
  };
  add(`${q} overview`);
  add(`${q} latest developments`);
  add(`${q} statistics data`);
  add(`${q} criticism risks`);
  add(`${q} primary sources`);
  // Split on "and" / "vs" for light compound coverage.
  const parts = q.split(/\b(?:\band\b|\bvs\.?\b|\bversus\b)\b/i);
  for (const p of parts) {
    const t = p.trim();
    if (t.length >= 8 && t.length < q.length) add(t);
  }
  return out.slice(0, max);
}

async function callJsonLlm({ system, user, timeoutMs, signal }) {
  if (!process.env.OPENAI_API_KEY) return null;
  throwIfAborted(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: PLAN_MODEL,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '{}';
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function planResearch(topic, { onStatus, signal } = {}) {
  status(onStatus, 'Planning research…');
  const fallback = {
    angles: ['Overview', 'Recent developments', 'Evidence & data', 'Risks & counterpoints'],
    queries: heuristicQueries(topic, MAX_QUERIES),
  };
  const parsed = await callJsonLlm({
    system: [
      'You are a research planner for a deep web-research agent.',
      'Given a user topic, return JSON only:',
      '{"angles":["short research angle",...],"queries":["web search query",...]}',
      `Provide 4-6 distinct angles and ${Math.max(4, MAX_QUERIES - 1)}-${MAX_QUERIES} diverse search queries.`,
      'Queries should target primary sources, recent data, competing views, and concrete facts.',
      'Keep each query under 12 words. No duplicates. Do not answer the question.',
    ].join(' '),
    user: topic,
    timeoutMs: PLAN_TIMEOUT_MS,
    signal,
  });
  if (!parsed) return fallback;

  const angles = Array.isArray(parsed.angles)
    ? parsed.angles.map((a) => String(a || '').trim()).filter(Boolean).slice(0, 8)
    : fallback.angles;
  const queries = [];
  const seen = new Set();
  const push = (q) => {
    const t = String(q || '').trim().slice(0, 200);
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(t);
  };
  push(topic);
  if (Array.isArray(parsed.queries)) {
    for (const q of parsed.queries) push(q);
  }
  for (const q of fallback.queries) push(q);
  return {
    angles: angles.length ? angles : fallback.angles,
    queries: queries.slice(0, MAX_QUERIES),
  };
}

/**
 * Prefer domain diversity: round-robin across hostnames from ranked hits.
 */
export function selectDiverseCandidates(hits, max = MAX_CANDIDATES) {
  const byHost = new Map();
  for (const hit of hits || []) {
    const url = normalizeUrl(hit.url);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const host = hostnameOf(url) || 'unknown';
    if (!byHost.has(host)) byHost.set(host, []);
    const bucket = byHost.get(host);
    if (bucket.some((h) => normalizeUrl(h.url) === url)) continue;
    bucket.push({ ...hit, url });
  }
  const queues = [...byHost.values()].map((arr) => [...arr]);
  const out = [];
  const seenUrl = new Set();
  let progressed = true;
  while (out.length < max && progressed) {
    progressed = false;
    for (const q of queues) {
      if (out.length >= max) break;
      while (q.length) {
        const next = q.shift();
        const key = normalizeUrl(next.url);
        if (seenUrl.has(key)) continue;
        seenUrl.add(key);
        out.push(next);
        progressed = true;
        break;
      }
    }
  }
  return out;
}

async function searchMany(queries, { onStatus, signal } = {}) {
  const hits = [];
  const usedQueries = [];
  await mapPool(queries, SEARCH_CONCURRENCY, async (query) => {
    throwIfAborted(signal);
    status(onStatus, `Searching: ${query.slice(0, 48)}${query.length > 48 ? '…' : ''}`);
    const payload = await searchWeb(query, { num: RESULTS_PER_QUERY, deepBrowse: false });
    if (!payload?.ok || !payload.results?.length) return;
    usedQueries.push(query);
    for (const r of payload.results) {
      hits.push({
        title: r.title || 'Untitled',
        url: r.url || '',
        snippet: r.snippet || '',
        query,
        rank: r.rank || 99,
      });
    }
  });
  // Stable-ish ordering: better ranks first, then original order.
  hits.sort((a, b) => (a.rank || 99) - (b.rank || 99));
  return { hits, usedQueries };
}

async function browsePages(candidates, limit, { onStatus, signal, already = new Set() } = {}) {
  const targets = (candidates || [])
    .filter((c) => c?.url && !already.has(normalizeUrl(c.url)))
    .slice(0, limit);
  if (!targets.length) return [];

  let done = 0;
  const pages = await mapPool(targets, BROWSE_CONCURRENCY, async (hit) => {
    throwIfAborted(signal);
    done += 1;
    status(onStatus, `Reading sources (${done}/${targets.length})…`);
    const page = await fetchWebPage(hit.url, { maxChars: PAGE_MAX_CHARS, timeoutMs: 10000 });
    if (!page.ok || !page.content || page.content.length < 100) return null;
    already.add(normalizeUrl(hit.url));
    return {
      title: page.title || hit.title || 'Untitled',
      url: hit.url,
      content: page.content,
      snippet: hit.snippet || '',
    };
  });
  return pages.filter(Boolean);
}

async function gapAnalysis(topic, { angles, sources, pages, onStatus, signal } = {}) {
  if (GAP_MAX_QUERIES <= 0) {
    return { enough: true, moreQueries: [], notes: '' };
  }
  status(onStatus, 'Checking gaps…');
  const evidence = [
    `Angles: ${(angles || []).join('; ')}`,
    'Sources:',
    ...(sources || []).slice(0, 20).map((s, i) => `${i + 1}. ${s.title} — ${s.url} — ${s.snippet}`),
    'Page extracts:',
    ...(pages || []).slice(0, 8).map(
      (p) => `[${p.title}](${p.url})\n${String(p.content || '').slice(0, 500)}`,
    ),
  ].join('\n');

  const parsed = await callJsonLlm({
    system: [
      'You review gathered research evidence for gaps and conflicts.',
      'Return JSON only:',
      '{"enough":true|false,"moreQueries":["..."],"notes":"brief conflicts or gaps"}',
      `If evidence is thin, contradictory, or missing a key angle, set enough=false and give up to ${GAP_MAX_QUERIES} new search queries.`,
      'If coverage is solid, enough=true and moreQueries=[].',
      'Do not invent facts. Queries must be short web searches.',
    ].join(' '),
    user: `Topic: ${topic}\n\n${evidence}`.slice(0, 14000),
    timeoutMs: PLAN_TIMEOUT_MS,
    signal,
  });

  if (!parsed) {
    return { enough: pages.length >= Math.min(6, MAX_PAGES), moreQueries: [], notes: '' };
  }
  const moreQueries = Array.isArray(parsed.moreQueries)
    ? parsed.moreQueries.map((q) => String(q || '').trim().slice(0, 200)).filter(Boolean).slice(0, GAP_MAX_QUERIES)
    : [];
  return {
    enough: parsed.enough !== false || moreQueries.length === 0,
    moreQueries,
    notes: String(parsed.notes || '').trim().slice(0, 500),
  };
}

/**
 * Format evidence pack for prompt injection.
 */
export function formatDeepResearchForPrompt(pack) {
  if (!pack?.ok) return '';
  const sources = Array.isArray(pack.sources) ? pack.sources : [];
  const pages = Array.isArray(pack.pages) ? pack.pages : [];
  if (!sources.length && !pages.length) return '';

  const sourceLines = sources
    .slice(0, 40)
    .map((s, i) => `${i + 1}. [${s.title || 'Source'}](${s.url})${s.snippet ? ` — ${s.snippet}` : ''}`)
    .join('\n');

  let pageBlocks = '';
  let used = 0;
  const parts = [];
  for (const p of pages) {
    const block = `[PAGE: ${p.title} — ${p.url}]\n${p.content}`;
    if (used + block.length > PROMPT_MAX_CHARS) break;
    parts.push(block);
    used += block.length + 8;
  }
  if (parts.length) {
    pageBlocks = `\n\n[DEEP_BROWSE_CONTENT]\nFull page extracts from selected sources:\n\n${parts.join('\n\n---\n\n')}`;
  }

  const angles = (pack.angles || []).length
    ? `\nResearch angles covered: ${pack.angles.join('; ')}`
    : '';
  const queries = (pack.queries || []).length
    ? `\nQueries run: ${pack.queries.join(' | ')}`
    : '';
  const notes = pack.notes ? `\nAnalyst notes: ${pack.notes}` : '';

  return (
    `[DEEP_RESEARCH_EVIDENCE]\n` +
    `Multi-step live web research for the user's topic. This is your PRIMARY evidence.` +
    `${angles}${queries}${notes}\n\n` +
    `Sources index:\n${sourceLines || '(no serps)'}` +
    pageBlocks +
    `\n\n[RESEARCH_REPORT_INSTRUCTIONS]\n` +
    `Write a thorough research REPORT (not a casual chat reply):\n` +
    `1) Short executive summary (2–4 sentences)\n` +
    `2) Key findings under ## headers (bullets OK)\n` +
    `3) Explicit caveats / disagreements between sources when present\n` +
    `4) End with a **Sources** section listing markdown links ONLY from the evidence above — never invent URLs.\n` +
    `Prefer primary, recent, and authoritative sources. Cite claims inline with markdown links where natural.`
  );
}

/**
 * Run the full deep-research pipeline.
 *
 * @param {string} topic
 * @param {{ onStatus?: (s: string) => void, signal?: AbortSignal }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   query?: string,
 *   angles?: string[],
 *   queries?: string[],
 *   sources?: Array<{title:string,url:string,snippet:string}>,
 *   pages?: Array<{title:string,url:string,content:string}>,
 *   notes?: string,
 *   error?: string,
 * }>}
 */
export async function runDeepResearch(topic, opts = {}) {
  const { onStatus, signal } = opts;
  const query = String(topic || '').trim().slice(0, 500);
  if (!query || query.length < 4) {
    return { ok: false, error: 'topic_too_short' };
  }
  if (!process.env.SERPER_API_KEY) {
    return { ok: false, error: 'web_search_not_configured' };
  }

  try {
    throwIfAborted(signal);
    const plan = await planResearch(query, { onStatus, signal });
    throwIfAborted(signal);

    const round1 = await searchMany(plan.queries, { onStatus, signal });
    if (!round1.hits.length) {
      // Degrade: single-query deep browse via searchWeb.
      status(onStatus, 'Searching…');
      const fallback = await searchWeb(query, { num: 10, deepBrowse: true });
      if (!fallback?.ok || !fallback.results?.length) {
        return { ok: false, error: fallback?.error || 'no_results', query };
      }
      const sources = fallback.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet || '',
      }));
      return {
        ok: true,
        query,
        angles: plan.angles,
        queries: [query],
        sources,
        pages: fallback.pages || [],
        notes: '',
      };
    }

    const candidates = selectDiverseCandidates(round1.hits, MAX_CANDIDATES);
    const browsedUrls = new Set();
    let pages = await browsePages(candidates, MAX_PAGES, {
      onStatus,
      signal,
      already: browsedUrls,
    });

    const sourceMap = new Map();
    const pushSource = (s) => {
      const url = normalizeUrl(s.url);
      if (!url) return;
      if (!sourceMap.has(url)) {
        sourceMap.set(url, {
          title: s.title || 'Source',
          url,
          snippet: s.snippet || '',
        });
      }
    };
    for (const h of candidates) pushSource(h);
    for (const p of pages) pushSource(p);

    let notes = '';
    let allQueries = [...round1.usedQueries];
    const gap = await gapAnalysis(query, {
      angles: plan.angles,
      sources: [...sourceMap.values()],
      pages,
      onStatus,
      signal,
    });
    notes = gap.notes || '';

    if (!gap.enough && gap.moreQueries.length && GAP_MAX_PAGES > 0) {
      const round2 = await searchMany(gap.moreQueries, { onStatus, signal });
      allQueries = [...allQueries, ...round2.usedQueries];
      const moreCandidates = selectDiverseCandidates(round2.hits, GAP_MAX_PAGES + 4).filter(
        (c) => !browsedUrls.has(normalizeUrl(c.url)),
      );
      for (const h of moreCandidates) pushSource(h);
      const morePages = await browsePages(moreCandidates, GAP_MAX_PAGES, {
        onStatus,
        signal,
        already: browsedUrls,
      });
      pages = [...pages, ...morePages];
      for (const p of morePages) pushSource(p);
    }

    status(onStatus, 'Writing report…');

    // Prefer sources we actually browsed first in the index.
    const browsedSet = new Set(pages.map((p) => normalizeUrl(p.url)));
    const sources = [...sourceMap.values()].sort((a, b) => {
      const ab = browsedSet.has(normalizeUrl(a.url)) ? 0 : 1;
      const bb = browsedSet.has(normalizeUrl(b.url)) ? 0 : 1;
      return ab - bb;
    });

    return {
      ok: true,
      query,
      angles: plan.angles,
      queries: allQueries,
      sources,
      pages,
      notes,
    };
  } catch (err) {
    if (err?.code === 'ABORTED' || aborted(signal)) {
      return { ok: false, error: 'aborted', query };
    }
    console.warn('[deepResearch] failed:', err?.message || err);
    return { ok: false, error: err?.message || 'deep_research_error', query };
  }
}

/**
 * Convenience: run + format for prompt injection. Returns '' on failure.
 */
export async function runDeepResearchForPrompt(topic, opts = {}) {
  const pack = await runDeepResearch(topic, opts);
  if (!pack.ok) return { ok: false, text: '', pack };
  return { ok: true, text: formatDeepResearchForPrompt(pack), pack };
}
