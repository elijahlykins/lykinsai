// Vault retrieval + legacy-named synthesis chunk index.
// Live RAG / embed / store helpers. The "synthesis" name is the table/RPC
// contract; do not delete because of the name.
import fetch from 'node-fetch';
import { chunkTextForSynthesis } from '../../synthesis-service.js';
import { contextualizeChunks } from '../../lib/rag/contextualize.js';
import { logAiUsage, estimateTokens } from '../../usageTracking.js';
import { memCache, sha256 } from './promptUtils.js';

let supabaseAdmin = null;

export function bindChatRetrieval(deps) {
  supabaseAdmin = deps.supabaseAdmin;
}

// ============================================
// VAULT RETRIEVAL — legacy-named synthesis chunk index
// One OpenAI embed + one Supabase RPC per request when enabled.
// ============================================
export const SYNTHESIS_RETRIEVAL_TOP_K = 12;
// Aligned with lykn_searchVault (0.35). The old 0.55 floor dropped many
// real vault hits on short/topic queries — Glass then looked "blind".
export const SYNTHESIS_MATCH_THRESHOLD = 0.35;
export const SYNTHESIS_RETRIEVAL_OVERFETCH = 28;
export const SYNTHESIS_BLOCK_MAX_CHARS = 5500;

// In-memory cache for retrieval embeddings. Same query within 15 minutes
// returns the cached vector — no API call, no log row. Vectors are 1536
// floats (~12 KB each) so we keep this small.
const _embedQueryCache = memCache('embed-query', { maxSize: 512, ttlMs: 15 * 60 * 1000 });

export async function openAiEmbedQueryText(text, { userId = null, actionType = 'embedding_retrieval' } = {}) {
  if (!process.env.OPENAI_API_KEY) return null;
  const input = String(text || '').trim().slice(0, 8000);
  if (input.length < 4) return null;

  const cacheKey = sha256(input);
  const cached = _embedQueryCache.get(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        dimensions: 1536,
        input,
      }),
    });
    if (!res.ok) {
      console.warn('⚠️ Synthesis embedding HTTP', res.status);
      return null;
    }
    const data = await res.json();
    const emb = data?.data?.[0]?.embedding;
    if (!Array.isArray(emb) || emb.length !== 1536) return null;
    _embedQueryCache.set(cacheKey, emb);
    if (userId) {
      const promptTokens = data?.usage?.prompt_tokens || data?.usage?.total_tokens || estimateTokens(input);
      logAiUsage({
        userId,
        actionType,
        model: 'text-embedding-3-small',
        provider: 'openai',
        inputTokens: promptTokens,
        outputTokens: 0,
        metadata: { input_chars: input.length },
      }).catch(() => {});
    }
    return emb;
  } catch (e) {
    console.warn('⚠️ Synthesis embedding error:', e?.message || e);
    return null;
  }
}

export function logSynthesisRetrievalStats(rows, opts = {}) {
  const { threshold } = opts;
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log(
      `📊 Synthesis retrieval: hits=0 threshold=${threshold != null ? Number(threshold).toFixed(2) : 'n/a'} (no rows above cutoff or index empty)`,
    );
    return;
  }
  const sims = rows
    .map((r) => r.similarity)
    .filter((x) => typeof x === 'number' && Number.isFinite(x));
  let simPart = 'sim=n/a';
  if (sims.length) {
    const min = Math.min(...sims);
    const max = Math.max(...sims);
    const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
    simPart = `sim min=${min.toFixed(3)} mean=${mean.toFixed(3)} max=${max.toFixed(3)}`;
  }
  const byType = {};
  for (const r of rows) {
    const t = String(r.source_type || 'unknown');
    byType[t] = (byType[t] || 0) + 1;
  }
  const srcPart = Object.keys(byType)
    .sort()
    .map((k) => `${k}:${byType[k]}`)
    .join(' ');
  console.log(
    `📊 Synthesis retrieval: n=${rows.length} ${simPart} sources={${srcPart || 'none'}} threshold=${threshold != null ? Number(threshold).toFixed(2) : 'n/a'}`,
  );
}

/**
 * Returns a prompt section or empty string. Uses the caller's JWT so RLS/auth.uid() apply.
 */
// Parent / sentence-window expansion for synthesis retrieval. For the top
// matched chunks, fetch the neighbouring chunk_index rows (±1) from the same
// source and stitch them into a single window so the model gets context around
// the hit, not an isolated fragment. Returns an array aligned to `rows` where
// each entry is the windowed text (or undefined to fall back to the raw chunk).
// One bounded REST query; any failure returns an empty map (safe fallback).
export async function expandSynthesisChunkWindows(authHeader, rows) {
  if (process.env.RAG_PARENT_WINDOW === '0') return null;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  // No user JWT (voice custom-LLM path): expand via the service-role client.
  // The rows we expand were already user-scoped by the caller's match RPC, and
  // source_id values are globally-unique uuids, so this can't leak across users.
  const hasUserAuth = authHeader && String(authHeader).startsWith('Bearer ');
  const useAdmin = !hasUserAuth && !!supabaseAdmin;
  if (!hasUserAuth && !useAdmin) return null;
  try {
    const TOP = Math.min(rows.length, 6); // only expand the strongest hits
    const sourceIds = new Set();
    const neededIdx = new Set();
    for (let i = 0; i < TOP; i++) {
      const r = rows[i];
      const sid = r?.source_id;
      const ci = Number(r?.chunk_index);
      if (sid == null || !Number.isInteger(ci)) continue;
      sourceIds.add(String(sid));
      for (const n of [ci - 1, ci, ci + 1]) if (n >= 0) neededIdx.add(n);
    }
    if (sourceIds.size === 0 || neededIdx.size === 0) return null;

    let chunkRows;
    if (useAdmin) {
      const { data, error } = await supabaseAdmin
        .from('lykn_synthesis_chunks')
        .select('source_type,source_id,chunk_index,content')
        .in('source_id', [...sourceIds])
        .in('chunk_index', [...neededIdx]);
      if (error) return null;
      chunkRows = data;
    } else {
      const idList = [...sourceIds].map((s) => `"${s.replace(/"/g, '')}"`).join(',');
      const ciList = [...neededIdx].join(',');
      const url =
        `${SUPABASE_URL}/rest/v1/lykn_synthesis_chunks` +
        `?select=source_type,source_id,chunk_index,content` +
        `&source_id=in.(${encodeURIComponent(idList)})` +
        `&chunk_index=in.(${encodeURIComponent(ciList)})`;
      const res = await fetch(url, {
        headers: { Authorization: authHeader, apikey: SUPABASE_ANON_KEY },
      });
      if (!res.ok) return null;
      chunkRows = await res.json();
    }
    if (!Array.isArray(chunkRows)) return null;

    // key: source_type|source_id -> Map(chunk_index -> content)
    const bySource = new Map();
    for (const c of chunkRows) {
      const key = `${c.source_type}|${c.source_id}`;
      if (!bySource.has(key)) bySource.set(key, new Map());
      bySource.get(key).set(Number(c.chunk_index), String(c.content || ''));
    }

    const out = new Array(rows.length);
    for (let i = 0; i < TOP; i++) {
      const r = rows[i];
      const ci = Number(r?.chunk_index);
      const map = bySource.get(`${r.source_type}|${r.source_id}`);
      if (!map || !Number.isInteger(ci)) continue;
      const parts = [map.get(ci - 1), map.get(ci) ?? r.content, map.get(ci + 1)]
        .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (parts.length) out[i] = parts.join(' … ');
    }
    return out;
  } catch (e) {
    console.warn('⚠️ Synthesis window expansion:', e?.message || e);
    return null;
  }
}

export const WHAT_IVE_SAVED_SOURCE_LABELS = {
  vault: 'Vault',
  note: 'Vault',
  notes: 'Vault',
  media: 'Vault',
  notion: 'Notion',
  gmail: 'Gmail',
  slack: 'Slack',
  github: 'GitHub',
  linear: 'Linear',
  todoist: 'Todoist',
  trello: 'Trello',
  drive: 'Google Drive',
  'google-drive': 'Google Drive',
  calendar: 'Calendar',
  readwise: 'Readwise',
  raindrop: 'Raindrop',
  spotify: 'Spotify',
  figma: 'Figma',
  canva: 'Canva',
  cursor: 'Cursor',
};

export function labelForWhatIveSavedSource(sourceType) {
  const key = String(sourceType || '').trim().toLowerCase();
  if (!key) return 'Vault';
  if (WHAT_IVE_SAVED_SOURCE_LABELS[key]) return WHAT_IVE_SAVED_SOURCE_LABELS[key];
  // Connector tags often look like "notion_page" / "gmail_message".
  for (const [k, label] of Object.entries(WHAT_IVE_SAVED_SOURCE_LABELS)) {
    if (key.includes(k)) return label;
  }
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40) || 'Vault';
}

export function formatWhatIveSavedHitLabel(row, titleBySourceId = null) {
  const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const sourceId = String(row?.source_id || '').trim();
  const title = String(
    meta.title || meta.note_title || meta.name || titleBySourceId?.get(sourceId) || '',
  ).replace(/\s+/g, ' ').trim().slice(0, 120);
  const origin = labelForWhatIveSavedSource(row?.source_type || meta.source || meta.connector);
  // Always include vault_<uuid> so the model can lykn_loadNeuron without inventing an id.
  const nodeId =
    String(row?.source_type || '').toLowerCase() === 'vault_note' && sourceId
      ? `vault_${sourceId}`
      : sourceId
        ? `vault_${sourceId}`
        : '';
  const idBit = nodeId ? ` · node_id=${nodeId}` : '';
  if (title) return `From Vault · "${title}" (${origin})${idBit}`;
  return `From Vault · ${origin} item${idBit}`;
}

/** Best-effort title lookup for vault note source_ids missing metadata.title. */
export async function lookupVaultTitlesForSynthesisRows(authHeader, userId, rows) {
  const map = new Map();
  if (!Array.isArray(rows) || !rows.length) return map;
  const ids = [];
  for (const r of rows) {
    const meta = r?.metadata && typeof r.metadata === 'object' ? r.metadata : {};
    if (meta.title || meta.note_title || meta.name) continue;
    const sid = String(r?.source_id || '').trim();
    // Vault notes use UUIDs as source_id.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sid)) {
      ids.push(sid);
    }
  }
  const unique = [...new Set(ids)].slice(0, 24);
  if (!unique.length) return map;
  const client = supabaseAdmin || (authHeader ? createSynthesisUserClient(authHeader) : null);
  if (!client) return map;
  try {
    let q = client.from('notes').select('id, title').in('id', unique);
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q;
    if (error || !Array.isArray(data)) return map;
    for (const n of data) {
      const t = String(n?.title || '').replace(/\s+/g, ' ').trim();
      if (t && n.id) map.set(String(n.id), t);
    }
  } catch (e) {
    console.warn('⚠️ Vault title lookup for WHAT_IVE_SAVED:', e?.message || e);
  }
  return map;
}

/** Prefer vault_note chunks, then higher similarity; dedupe by source_id. */
export function rankSynthesisRowsForWhatIveSaved(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && String(r.content || '').trim()) : [];
  const scored = list.map((r, i) => {
    const st = String(r.source_type || '').toLowerCase();
    const isVault = st === 'vault_note' || st === 'vault' || st === 'note' || st === 'notes';
    const sim = typeof r.similarity === 'number' ? r.similarity : 0;
    return { r, i, isVault, sim };
  });
  scored.sort((a, b) => {
    if (a.isVault !== b.isVault) return a.isVault ? -1 : 1;
    if (b.sim !== a.sim) return b.sim - a.sim;
    return a.i - b.i;
  });
  const seen = new Set();
  const out = [];
  for (const item of scored) {
    const key = `${item.r.source_type || ''}:${item.r.source_id || item.i}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item.r);
    if (out.length >= SYNTHESIS_RETRIEVAL_TOP_K) break;
  }
  return out;
}

/**
 * Lexical BM25 vault notes merged into WHAT_IVE_SAVED when dense search
 * alone is thin — recovers exact-title / keyword hits embeddings miss.
 * Artifact notes are often title + [ATTACHMENTS_JSON] only — never drop those.
 */
export async function fetchBm25VaultRowsForWhatIveSaved(userId, queryText, existingSourceIds) {
  if (!supabaseAdmin || !userId) return [];
  const raw = String(queryText || '').trim().slice(0, 200);
  if (raw.length < 2) return [];
  // Prefer topic words so "I have something on prosthetics" still hits a title.
  let probe = raw;
  let relatedProbes = [];
  try {
    const { normalizeVaultSearchQuery } = await import('./lib/rag/vaultHybrid.js');
    probe = normalizeVaultSearchQuery(raw) || raw;
  } catch {
    /* keep raw */
  }
  // Related-word probes (morph always; LLM synonyms when keyed) so Glass
  // auto-recall can find "artificial limbs" ↔ "prosthetics" saves.
  if (process.env.RAG_QUERY_EXPANSION !== '0') {
    try {
      const { expandQuery } = await import('./lib/rag/queryExpansion.js');
      relatedProbes = await expandQuery(probe, {
        enabled: !!process.env.OPENAI_API_KEY,
        force: true,
        mode: 'related',
        max: 5,
        timeoutMs: 3500,
      });
    } catch (e) {
      console.warn('⚠️ WHAT_IVE_SAVED related expand:', e?.message || e);
    }
  }
  try {
    const seenIds = new Set();
    const ids = [];
    const bm25Queries = [probe, raw, ...relatedProbes]
      .map((s) => String(s || '').trim().slice(0, 200))
      .filter((s, i, a) => s && a.findIndex((x) => x.toLowerCase() === s.toLowerCase()) === i)
      .slice(0, 6);
    for (const q of bm25Queries) {
      const { data: bm, error } = await supabaseAdmin.rpc('search_notes_bm25', {
        p_user_id: userId,
        p_query: q,
        match_count: 12,
      });
      if (error) {
        console.warn('⚠️ WHAT_IVE_SAVED BM25 rpc:', error.message);
        continue;
      }
      for (const r of bm || []) {
        const id = String(r.id || '');
        if (!id || seenIds.has(id)) continue;
        if (existingSourceIds instanceof Set && existingSourceIds.has(id)) continue;
        seenIds.add(id);
        ids.push(id);
        if (ids.length >= 10) break;
      }
      if (ids.length >= 10) break;
    }
    // Title / summary ilike safety net — include related terms so artifact
    // titles match synonyms (e.g. "Top Prosthetic Companies" ← "artificial limb").
    const titleTerms = bm25Queries.filter((t) => t.length >= 3).slice(0, 6);
    if (titleTerms.length) {
      const patterns = [];
      for (const term of titleTerms) {
        const esc = term.replace(/[%_,()]/g, '\\$&');
        patterns.push(`title.ilike.%${esc}%`);
        patterns.push(`ai_summary.ilike.%${esc}%`);
      }
      const { data: titleHits } = await supabaseAdmin
        .from('vault_items')
        .select('id')
        .eq('user_id', userId)
        .or(patterns.slice(0, 20).join(','))
        .limit(10);
      for (const r of titleHits || []) {
        const id = String(r.id || '');
        if (!id || seenIds.has(id)) continue;
        if (existingSourceIds instanceof Set && existingSourceIds.has(id)) continue;
        seenIds.add(id);
        ids.push(id);
      }
    }
    if (!ids.length) return [];
    const { data: notes, error: nErr } = await supabaseAdmin
      .from('vault_items')
      .select('id, title, content, ai_summary')
      .eq('user_id', userId)
      .in('id', ids.slice(0, 12));
    if (nErr || !Array.isArray(notes)) return [];
    const byId = new Map(notes.map((n) => [String(n.id), n]));
    const rows = [];
    for (const id of ids.slice(0, 12)) {
      const n = byId.get(id);
      if (!n) continue;
      const title = String(n.title || '').replace(/\s+/g, ' ').trim();
      const summary = String(n.ai_summary || '').replace(/\s+/g, ' ').trim();
      const stripped = String(n.content || '')
        .replace(/\[ATTACHMENTS_JSON:[\s\S]*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
      // Marker-only artifacts: title IS the searchable body.
      const body = (summary || stripped || title || 'Saved vault item').slice(0, 400);
      rows.push({
        source_type: 'vault_note',
        source_id: id,
        content: body,
        similarity: 0.55,
        metadata: { title: title || 'Vault item' },
      });
    }
    return rows;
  } catch (e) {
    console.warn('⚠️ WHAT_IVE_SAVED BM25:', e?.message || e);
    return [];
  }
}

// ============================================
// CONNECTED-SOURCE URL → VAULT NOTE LOOKUP
// ============================================
// When the user pastes a URL from a service we sync (Notion, Drive, GitHub,
// Linear, Figma, Slack, etc.) the literal URL string doesn't semantically
// match the embedded page chunks, so synthesis retrieval misses. Generic
// web scraping also fails because these endpoints are auth-gated and
// return a login page (or nothing) to our unauthenticated fetch. The
// content IS in the vault as a `notes` row whose `content` contains the
// URL inside a bookmark JSON marker — we just need an exact-match lookup
// keyed off the URL itself. This block injects the matching note body
// into the prompt so the model can answer "what does this Notion page
// say?" / "summarize this Linear ticket" / etc. against the real text
// instead of stalling with "I can't access external pages."
//
// Per-URL note body cap: ~6K chars. Total block cap: ~18K chars (the
// outer prompt assembly already truncates aggressively if the combined
// prompt exceeds the model's context window). We limit to 3 URLs per
// message so a paste of "here are 50 docs" doesn't run away.
export const CONNECTED_SOURCE_HOSTS = [
  // hostname pattern → friendly label for the prompt
  { re: /\bnotion\.so\b/i,             label: 'Notion' },
  { re: /\b(docs|drive|sheets|slides)\.google\.com\b/i, label: 'Google Drive/Docs' },
  { re: /\bcalendar\.google\.com\b/i,  label: 'Google Calendar' },
  { re: /\bmail\.google\.com\b/i,      label: 'Gmail' },
  { re: /\boutlook\.(live|office)\.com\b/i, label: 'Outlook' },
  { re: /\bslack\.com\b/i,             label: 'Slack' },
  { re: /\bgithub\.com\b/i,            label: 'GitHub' },
  { re: /\blinear\.app\b/i,            label: 'Linear' },
  { re: /\btodoist\.com\b/i,           label: 'Todoist' },
  { re: /\btrello\.com\b/i,            label: 'Trello' },
  { re: /\bfigma\.com\b/i,             label: 'Figma' },
  { re: /\bcanva\.com\b/i,             label: 'Canva' },
  { re: /\bloom\.com\b/i,              label: 'Loom' },
  { re: /\bvimeo\.com\b/i,             label: 'Vimeo' },
  { re: /\bdribbble\.com\b/i,          label: 'Dribbble' },
  { re: /\bbehance\.net\b/i,           label: 'Behance' },
  { re: /\breadwise\.io\b/i,           label: 'Readwise' },
  { re: /\braindrop\.io\b/i,           label: 'Raindrop' },
  { re: /\binstapaper\.com\b/i,        label: 'Instapaper' },
  { re: /\bgetpocket\.com\b/i,         label: 'Pocket' },
  { re: /\bspotify\.com\b/i,           label: 'Spotify' },
  { re: /\bmusic\.apple\.com\b/i,      label: 'Apple Music' },
  { re: /\bsoundcloud\.com\b/i,        label: 'SoundCloud' },
  { re: /\bpinterest\.com\b/i,         label: 'Pinterest' },
  { re: /\bbsky\.app\b/i,              label: 'Bluesky' },
  { re: /\breddit\.com\b/i,            label: 'Reddit' },
  // Mastodon is federated — we only sync, so we match any mastodon URL by path heuristic.
];

export const VAULT_URL_LOOKUP_MAX_URLS = 3;
export const VAULT_URL_LOOKUP_PER_NOTE_CHARS = 6000;
export const VAULT_URL_LOOKUP_TOTAL_CHARS = 18000;

// ---------------------------------------------------------------------------
// LIVE RE-FETCH: pull a Notion page body directly from Notion's API at
// chat time, when the synced vault note's body is empty. This converts
// drag-into-chat into a real-time read for the dragged item — which is
// the user's actual mental model ("I dragged this in, you should read
// it"). Cached aggressively (we write the fresh body back to the vault
// note so subsequent turns hit the cheap synced path).
// ---------------------------------------------------------------------------
// Extracts the 32-char Notion page id from any of the URL formats Notion
// emits. Notion page URLs always end with a 32-char hex id (sometimes
// with hyphens, sometimes bare). Examples:
//   https://www.notion.so/Lykins-AI-Project-Overview-e6016e5d764a47f...
//   https://www.notion.so/e6016e5d764a47f48b9b3c2c1d3e4f5a
//   https://www.notion.so/workspace/Page-Title-e6016e5d764a47f48b9b...
export function extractNotionPageIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  // Strip query/fragment.
  const clean = url.split('?')[0].split('#')[0];
  // Last path segment.
  const last = clean.split('/').filter(Boolean).pop() || '';
  // Notion page ids are 32 hex chars, optionally hyphenated 8-4-4-4-12.
  // The last segment is either `<title>-<32hex>` or just `<32hex>`.
  const match = last.match(/([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (!match) return null;
  // Normalize to hyphenated form, which is what /v1/blocks/{id} accepts.
  const raw = match[1].replace(/-/g, '');
  if (raw.length !== 32) return null;
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

// Pulls the user's active Notion access token from social_connections,
// extracts the page id from the URL, and calls the Notion connector's
// fetchPageBody helper. Returns the flattened text body (possibly empty).
// Bounded at 6s wall clock — anything longer would tank chat latency.
export const LIVE_REFETCH_TIMEOUT_MS = 6000;
let _connectorTokenHelpers = null;
let _notionFetchPageBody = null;

export async function loadConnectorTokenHelpers() {
  if (_connectorTokenHelpers) return _connectorTokenHelpers;
  const mod = await import('./connectors-service.js');
  _connectorTokenHelpers = { decryptToken: mod.decryptToken };
  return _connectorTokenHelpers;
}

export async function loadNotionFetchPageBody() {
  if (_notionFetchPageBody) return _notionFetchPageBody;
  const mod = await import('./connectors/notion.js');
  _notionFetchPageBody = mod.fetchPageBody;
  return _notionFetchPageBody;
}

export async function liveRefetchNotionPageBody(userId, url) {
  if (!supabaseAdmin || !userId || !url) return '';
  const pageId = extractNotionPageIdFromUrl(url);
  if (!pageId) {
    console.warn(`📡 live-refetch: could not parse Notion page id from ${url}`);
    return '';
  }
  // Find the user's active Notion connection. There can technically be
  // multiple (different workspaces); pick the most recently synced.
  const { data: conns, error } = await supabaseAdmin
    .from('social_connections')
    .select('id, access_token, status')
    .eq('user_id', userId)
    .eq('provider', 'notion')
    .order('last_synced_at', { ascending: false, nullsFirst: false })
    .limit(3);
  if (error) {
    console.warn(`📡 live-refetch: connection lookup failed:`, error.message);
    return '';
  }
  const active = (conns || []).find((c) => c.status !== 'reauth' && c.status !== 'error') || (conns || [])[0];
  if (!active?.access_token) {
    console.warn(`📡 live-refetch: no active Notion connection for user ${userId}`);
    return '';
  }
  let accessToken;
  try {
    const { decryptToken } = await loadConnectorTokenHelpers();
    accessToken = decryptToken(active.access_token);
  } catch (e) {
    console.warn(`📡 live-refetch: token decrypt failed:`, e?.message || e);
    return '';
  }
  if (!accessToken) return '';
  let fetchPageBodyFn;
  try {
    fetchPageBodyFn = await loadNotionFetchPageBody();
  } catch (e) {
    console.warn(`📡 live-refetch: could not load notion connector:`, e?.message || e);
    return '';
  }
  // Wall-clock bound so a slow Notion API can't hang the chat turn.
  try {
    const result = await Promise.race([
      fetchPageBodyFn({ accessToken, pageId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('live-refetch timed out')), LIVE_REFETCH_TIMEOUT_MS)),
    ]);
    return String(result || '').trim();
  } catch (e) {
    console.warn(`📡 live-refetch threw:`, e?.message || e);
    return '';
  }
}

// Cache the freshly fetched body back into the vault note so future turns
// (or queries from other surfaces) hit the cheap synced path instead of
// re-fetching from Notion. Surgically updates only the post-marker portion
// of `content` so we don't disturb the attachments JSON.
export async function persistLiveFetchedBody({ userId, noteId, content, freshBody }) {
  if (!supabaseAdmin || !userId || !noteId || !freshBody) return;
  const raw = String(content || '');
  const span = findAttachmentsMarkerSpan(raw);
  let nextContent;
  if (span) {
    nextContent = `${raw.slice(0, span.markerEnd)}\n${freshBody}`.replace(/\n{3,}/g, '\n\n').trim();
  } else {
    nextContent = `${raw.trim()}\n\n${freshBody}`.trim();
  }
  await supabaseAdmin
    .from('vault_items')
    .update({ content: nextContent, updated_at: new Date().toISOString() })
    .eq('id', noteId)
    .eq('user_id', userId);
  // Reindex synthesis chunks + regenerate summary so the next semantic
  // retrieval / drag-in uses the fresh content. Fire-and-forget.
  enrichVaultNoteSummary({ userId, noteId }).catch(() => {});
}

export function detectConnectedSourceUrls(text) {
  const t = String(text || '');
  if (!t) return [];
  const allUrls = (t.match(URL_RE) || []).slice(0, 20);
  const seen = new Set();
  const matches = [];
  for (const url of allUrls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const hit = CONNECTED_SOURCE_HOSTS.find((h) => h.re.test(url));
    if (hit) matches.push({ url, label: hit.label });
    if (matches.length >= VAULT_URL_LOOKUP_MAX_URLS) break;
  }
  return matches;
}

// Extracts the user-supplied portion of an assembled prompt for URL
// detection. We need to scan THIS turn's user message + any drag-into-chat
// attachment context, but NOT historical conversation URLs (the user
// already discussed those).
//
// The prompt shape we receive varies by code path:
//   • Orchestrator raw (req.body.prompt before stream-side rebuild):
//       Conversation so far:\n…\n\nLatest user message:\n<text>[Attached content]…
//   • After buildLyknStreamPrompt rewrites prompt with the persona:
//       <persona>\n\n[FULL_CONTEXT]\n<orchestrator raw>\n\n[USER]\n<text>
//   • Invoke-mode buildLyknChatPrompt rewrite:
//       <persona>\n\n[CONVERSATION]\n…\n\n[WORKSPACE_CONTEXT]\n…\n\n[REQUEST_CONTEXT]\n<orchestrator raw>\n\n[LATEST_USER_MESSAGE]\n<text>
//
// We look (in priority order) for [Attached content] / Latest user message /
// [REQUEST_CONTEXT] / [LATEST_USER_MESSAGE] / [USER] — the first marker
// found wins, and we slice forward from it. This catches dragged Notion /
// Drive / GitHub / etc. URLs regardless of which code path assembled the
// prompt. Cap at 12K chars so an enormous pasted blob can't dominate the
// regex scan.
export function extractUserSuppliedContent(prompt, fallbackText) {
  const p = String(prompt || '');
  if (!p) return String(fallbackText || '');
  // [Attached content] is the strongest signal — emitted by the orchestrator's
  // buildAttachmentContext exclusively for drag-into-chat items. If present,
  // start the scan there to ensure we always see attachment URLs.
  const attMarker = '[Attached content]';
  const attIdx = p.lastIndexOf(attMarker);
  if (attIdx >= 0) return p.slice(attIdx, attIdx + 12000);
  const markers = [
    'Latest user message:\n',
    '[REQUEST_CONTEXT]\n',
    '[LATEST_USER_MESSAGE]\n',
    '[USER]\n',
  ];
  for (const m of markers) {
    const idx = p.lastIndexOf(m);
    if (idx >= 0) return p.slice(idx + m.length, idx + m.length + 12000);
  }
  return String(fallbackText || p.slice(-12000));
}

// `content` stores Notion/etc. bookmarks as [ATTACHMENTS_JSON:[{"url":"..."}]],
// followed by the flattened page body. We use Postgres `ilike` with the URL
// as a substring — exact equality won't work because the URL is embedded in
// a JSON blob alongside other fields. The bookmark `url` field is the only
// place a connected-source URL appears verbatim, so substring matches are
// unambiguous in practice.
export async function fetchVaultNotesByUrls(userId, urlMatches) {
  if (!supabaseAdmin || !userId || !urlMatches.length) return '';
  const out = [];
  let totalChars = 0;
  // Track noteIds we touched so we can opportunistically enqueue a summary
  // backfill for any that lack `ai_summary` (e.g. older Notion-synced rows
  // from before the sync-side enrichment hook was wired). Fire-and-forget.
  const noteIdsNeedingSummary = [];
  for (const { url, label } of urlMatches) {
    try {
      const { data, error } = await supabaseAdmin
        .from('vault_items')
        .select('id, title, content, source, updated_at, tags, ai_summary, ai_signals')
        .eq('user_id', userId)
        .ilike('content', `%${url}%`)
        .order('updated_at', { ascending: false })
        .limit(1);
      if (error) {
        console.warn(`⚠️ vault URL lookup error for ${url}:`, error.message);
        continue;
      }
      const row = (data || [])[0];
      if (!row) {
        out.push(
          `URL: ${url}\nMATCH: none\nNOTE: This ${label} URL is NOT currently in the user's synced vault. Either the user hasn't connected ${label}, the integration wasn't granted access to this specific page, or it was created/shared after the last sync. Tell them this concretely and offer to fix it via the Connections page — do NOT claim you can read the URL.`,
        );
        continue;
      }
      const title = String(row.title || 'Untitled').slice(0, 200);
      const tags = Array.isArray(row.tags) ? row.tags.join(', ') : '';
      // Robust parser: marker-aware extraction of the flattened page body
      // appended after `[ATTACHMENTS_JSON:[…]]`. The naive `indexOf(']]')`
      // approach we had broke whenever the JSON contained `]]` inside a
      // string value (which is normal for Notion bodies — wiki links,
      // code blocks, project specs).
      let body = extractBodyAfterAttachmentsMarker(row.content);
      let bodySource = body.length ? 'synced' : 'none';

      // LIVE RE-FETCH FALLBACK
      // When the stored body is empty (page synced before body capture was
      // wired, or the original sync's /v1/blocks call returned an empty
      // result for some reason), and we still have an active OAuth token
      // for this connector, fetch the page content directly from the
      // provider's API right now and inject the fresh result. This makes
      // drag-into-chat behave like real-time access for the dragged item,
      // which is the user's mental model — they dragged it expecting the
      // AI to "read" it.
      //
      // Only attempted for connectors with an API endpoint that can return
      // the page body cheaply from a URL. Notion is currently the only one
      // wired in (its /v1/blocks/{id}/children is exactly what we already
      // use at sync time). Live fetch is bounded to one connector call
      // per turn and capped at ~5s wall clock to keep chat latency sane.
      if (!body && label === 'Notion') {
        try {
          const liveBody = await liveRefetchNotionPageBody(userId, url);
          if (liveBody && liveBody.length > 0) {
            body = liveBody;
            bodySource = 'live-refetch';
            console.log(`📡 live-refetch succeeded for ${url}: ${liveBody.length} chars`);
            // Best-effort: persist the freshly fetched body back into the
            // vault note so future turns hit the cached path instead of
            // re-fetching. Fire-and-forget; never blocks chat response.
            persistLiveFetchedBody({ userId, noteId: row.id, content: row.content, freshBody: liveBody })
              .catch((e) => console.warn(`⚠️ persist live-fetched body for ${row.id} failed:`, e?.message || e));
          }
        } catch (e) {
          console.warn(`⚠️ live-refetch threw for ${url}:`, e?.message || e);
        }
      }
      const summary = String(row.ai_summary || '').trim();
      const signals = row.ai_signals && typeof row.ai_signals === 'object' ? row.ai_signals : null;
      const themes = Array.isArray(signals?.themes) ? signals.themes.filter(Boolean).slice(0, 8).join(', ') : '';
      const entities = Array.isArray(signals?.entities) ? signals.entities.filter(Boolean).slice(0, 8).join(', ') : '';

      // Diagnostic: connectors that capture only metadata (databases-only
      // Notion pages, image-only Pinterest pins, etc.) leave body empty.
      // Without this log we couldn't tell whether "model says it can't
      // read the body" meant "body was zero chars" or "body was there
      // and the model ignored it." Logged at every URL lookup.
      console.log(`📄 vault note id=${row.id} title="${title.slice(0, 60)}" → summary=${summary ? `${summary.length}c` : 'none'} body=${body.length}c (${bodySource}) content=${(row.content || '').length}c`);

      const trimmed = body.slice(0, VAULT_URL_LOOKUP_PER_NOTE_CHARS);
      const truncatedNote = body.length > VAULT_URL_LOOKUP_PER_NOTE_CHARS
        ? `\n\n…(BODY truncated to fit the prompt budget; the source page is ${body.length} chars total. Answer from this excerpt + SUMMARY. If the user asks about a section we didn't include, say so and ask them to narrow.)`
        : '';

      // Block layout (in order of cheapness for the model to consume):
      //   1. URL + source identity
      //   2. TITLE
      //   3. SUMMARY (AI-generated, 2-5 sentences) — answer from this first if it covers the question
      //   4. THEMES / ENTITIES — quick signal tags
      //   5. BODY — full flattened page content, truncated to budget
      // The model is instructed in the persona to use SUMMARY first and
      // only walk the BODY when the question needs deeper grounding.
      const parts = [
        `URL: ${url}`,
        `SOURCE: ${label} (synced; vault note id=${row.id}, source=${row.source})`,
        `TITLE: ${title}`,
      ];
      if (tags) parts.push(`TAGS: ${tags}`);
      if (summary) parts.push(`SUMMARY (AI-generated, 2-5 sentences — use this FIRST):\n${summary}`);
      else parts.push('SUMMARY: (not yet generated — fall back to BODY for this turn; a summary will be generated on the next sync)');
      if (themes) parts.push(`THEMES: ${themes}`);
      if (entities) parts.push(`ENTITIES: ${entities}`);

      // BODY presentation depends on what actually got synced. Connector
      // bodies vary wildly: a text-heavy Notion page might be 5K+ chars
      // of flattened prose, while a databases-only / images-only page
      // could be zero. We label each case explicitly so the model can
      // tell the user something true instead of stalling.
      const sourceLabel = bodySource === 'live-refetch'
        ? `live-fetched from ${label} just now`
        : `synced into vault`;
      if (body.length === 0) {
        parts.push(
          `BODY: (empty — we tried both the synced cache and a live re-fetch from ${label}; neither returned text content. This usually means the page contains only databases, embeds, images, sub-pages, or other non-text blocks that we can't transcribe. The SUMMARY above is the only textual content available. Tell the user honestly: "the page exists in your vault but has no flattened text body — it's likely all databases/embeds/images. Want me to work from the title, or paste the relevant section?")`,
        );
      } else if (body.length < 200) {
        parts.push(
          `BODY (only ${body.length} chars of text body extracted from this ${label} page, ${sourceLabel} — sparse content, likely a stub or mostly-embedded page):\n${trimmed}`,
        );
      } else {
        parts.push(
          `BODY (full flattened page text, ${body.length} chars, ${sourceLabel} — this IS the page content, treat it as authoritative for any question about the document):\n${trimmed}${truncatedNote}`,
        );
      }

      if (!summary && row.id) noteIdsNeedingSummary.push(row.id);

      const block = parts.join('\n');
      if (totalChars + block.length > VAULT_URL_LOOKUP_TOTAL_CHARS) {
        out.push(`URL: ${url}\nMATCH: found (id=${row.id}) but omitted from this prompt to stay under context budget. Ask the user to narrow to one URL at a time.`);
        continue;
      }
      out.push(block);
      totalChars += block.length;
    } catch (e) {
      console.warn(`⚠️ vault URL lookup threw for ${url}:`, e?.message || e);
    }
  }
  if (!out.length) return '';
  const matchCount = out.filter((b) => b.includes('SOURCE:')).length;
  console.log(`🔗 Vault URL lookup: matched ${matchCount}/${urlMatches.length} URLs (${noteIdsNeedingSummary.length} need summary backfill)`);

  // Fire-and-forget: enqueue summary generation for any matched note that
  // lacks `ai_summary`. The model still gets the BODY on this turn, but
  // future turns will have the cheaper SUMMARY-first path available.
  if (noteIdsNeedingSummary.length) {
    for (const id of noteIdsNeedingSummary) {
      enrichVaultNoteSummary({ userId, noteId: id }).catch((e) => {
        console.warn(`⚠️ background enrich for note ${id} failed:`, e?.message || e);
      });
    }
  }

  return [
    '[VAULT_URL_MATCHES]',
    "The user's latest message contains URLs from services we sync into their Vault. For each URL below, we did an exact lookup against their synced notes. When MATCH says 'found', you have the SUMMARY (2-5 sentence AI-generated overview) and the BODY (full flattened page text). ANSWERING RULE: try the SUMMARY first — if it answers the user's question, quote/paraphrase from it and stop. If the question needs specifics the summary doesn't cover (a particular section, exact quote, specific number, sub-page detail), drop into the BODY and answer from there. Never claim you can't access the page when MATCH=found — the content IS in this prompt. When MATCH=none, say so concretely and offer the Connections-page fix; do NOT ask the user to paste the content.",
    '',
    out.join('\n\n---\n\n'),
  ].join('\n');
}

// ============================================
// VAULT RETRIEVAL — embed + store
// ============================================
// Chunking now lives in synthesis-service.js (single source of truth, imported
// above as `chunkTextForSynthesis`) — no more drifting duplicate.
export const SYNTHESIS_EMBED_BATCH = 32;

export async function openAiEmbedMany(strings, { userId = null, actionType = 'embedding_reindex', metadata = null } = {}) {
  if (!process.env.OPENAI_API_KEY || !strings.length) return null;
  const MAX_RETRIES = 5;
  const all = [];
  let totalPromptTokens = 0;
  for (let i = 0; i < strings.length; i += SYNTHESIS_EMBED_BATCH) {
    const batch = strings.slice(i, i + SYNTHESIS_EMBED_BATCH);
    let res;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          dimensions: 1536,
          input: batch,
        }),
      });
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after'), 10);
        const delayMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 30000);
        console.warn(`⏳ Synthesis embed 429 — retry ${attempt + 1}/${MAX_RETRIES} in ${(delayMs / 1000).toFixed(1)}s`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      break;
    }
    if (!res.ok) {
      console.warn('⚠️ Synthesis batch embed HTTP', res.status);
      return null;
    }
    const data = await res.json();
    const items = Array.isArray(data?.data) ? data.data : [];
    items.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const item of items) {
      const emb = item?.embedding;
      if (!Array.isArray(emb) || emb.length !== 1536) return null;
      all.push(emb);
    }
    totalPromptTokens += data?.usage?.prompt_tokens || data?.usage?.total_tokens || batch.reduce((acc, s) => acc + estimateTokens(s), 0);
  }
  if (all.length === strings.length) {
    if (userId && totalPromptTokens > 0) {
      logAiUsage({
        userId,
        actionType,
        model: 'text-embedding-3-small',
        provider: 'openai',
        inputTokens: totalPromptTokens,
        outputTokens: 0,
        metadata: { chunks: strings.length, ...(metadata || {}) },
      }).catch(() => {});
    }
    return all;
  }
  return null;
}

export async function deleteSynthesisChunksForSource(client, userId, sourceType, sourceId) {
  const q = client.from('lykn_synthesis_chunks').delete().eq('user_id', userId).eq('source_type', sourceType).eq('source_id', String(sourceId));
  const { error } = await q;
  if (error) throw new Error(error.message);
}

export function createSynthesisUserClient(authHeader) {
  const token = String(authHeader || '').replace(/^Bearer\s+/i, '');
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !token) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function replaceSynthesisChunks(userId, authHeader, sourceType, sourceId, textChunks, baseMeta, fullText = '') {
  // Contextual Retrieval (Level 4): situate each chunk inside its parent doc
  // before embedding. No-op unless RAG_CONTEXTUAL_RETRIEVAL=1 AND the caller
  // passed the full source text. Done before the hash-skip so the cache key
  // reflects what actually gets stored/embedded.
  if (fullText && process.env.RAG_CONTEXTUAL_RETRIEVAL === '1') {
    try {
      textChunks = await contextualizeChunks(fullText, textChunks, {
        title: String(baseMeta?.title || ''),
      });
    } catch (e) {
      console.warn('⚠️ Contextual retrieval skipped:', e?.message || e);
    }
  }

  // Hash-skip path: if existing chunks for this source match the new
  // chunks exactly (same count, same content in the same order), there's
  // nothing to embed — bail before paying for the API call.
  const client = createSynthesisUserClient(authHeader) || supabaseAdmin;
  if (client) {
    try {
      const { data: existing } = await client
        .from('lykn_synthesis_chunks')
        .select('chunk_index, content')
        .eq('user_id', userId)
        .eq('source_type', sourceType)
        .eq('source_id', String(sourceId))
        .order('chunk_index');
      if (Array.isArray(existing) && existing.length === textChunks.length) {
        let allMatch = true;
        for (let i = 0; i < textChunks.length; i++) {
          if (String(existing[i]?.content || '') !== String(textChunks[i] || '')) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) {
          console.log(`[Synthesis] skip reindex (unchanged) ${sourceType}/${String(sourceId).slice(0, 12)} — ${textChunks.length} chunks`);
          return existing.length;
        }
      }
    } catch (e) {
      // Cache-skip is purely an optimization; never fail the upsert because
      // we couldn't read existing rows. Just fall through to the embed path.
      console.warn('⚠️ Synthesis hash-skip read failed, will re-embed:', e?.message || e);
    }
  }

  const embeddings = await openAiEmbedMany(textChunks, {
    userId,
    actionType: 'embedding_reindex',
    metadata: { source_type: sourceType, source_id: String(sourceId).slice(0, 200) },
  });
  if (!embeddings) throw new Error('embedding_failed');
  const rows = textChunks.map((content, chunk_index) => ({
    user_id: userId,
    source_type: sourceType,
    source_id: String(sourceId),
    chunk_index,
    content,
    embedding: embeddings[chunk_index],
    // `total_chunks` lets retrieval expand to neighbouring chunks (parent /
    // sentence-window) without a separate count query.
    metadata: { ...baseMeta, chunk_index, total_chunks: textChunks.length },
  }));

  // Idempotent replace: upsert on the unique constraint
  // (user_id, source_type, source_id, chunk_index), then delete any
  // leftover rows with `chunk_index >= rows.length` (cleanup of shrunk
  // sources).
  //
  // Old behavior was delete-then-insert. If the embed succeeded but the
  // insert failed (RLS race, transient PGRST blip, network), the source
  // ended up with ZERO chunks until the next reindex — silent retrieval
  // gap. Two concurrent reindexes for the same source could also briefly
  // race past each other's deletes.
  //
  // Upsert-first guarantees the source always has at least one valid
  // version of its chunks at any moment. The trailing delete is a
  // best-effort cleanup; if it fails, we just have stale tail chunks
  // until the next reindex (recall stays correct, precision degrades
  // marginally).
  //
  // Reuse the same client used for the hash-skip read above. If that
  // path didn't acquire a client (the `if (client)` block was skipped),
  // we still need one here — but the `client` var is already in scope,
  // so we just verify it's non-null.
  if (!client) throw new Error('no_supabase_client');

  const { error: upsertErr } = await client
    .from('lykn_synthesis_chunks')
    .upsert(rows, { onConflict: 'user_id,source_type,source_id,chunk_index' });
  if (upsertErr) throw new Error(`synthesis_upsert_failed: ${upsertErr.message}`);

  // Clean up any tail chunks left over from a previous, longer version
  // of this source. Best-effort: if it fails, recall stays correct.
  try {
    const { error: tailErr } = await client
      .from('lykn_synthesis_chunks')
      .delete()
      .eq('user_id', userId)
      .eq('source_type', sourceType)
      .eq('source_id', String(sourceId))
      .gte('chunk_index', rows.length);
    if (tailErr) {
      console.warn(
        `⚠️ Synthesis tail cleanup failed (${sourceType}/${String(sourceId).slice(0, 12)}): ${tailErr.message}`,
      );
    }
  } catch (e) {
    console.warn('⚠️ Synthesis tail cleanup threw:', e?.message || e);
  }

  return rows.length;
}
