// ============================================================================
// connectors/notion.js — Notion OAuth adapter
// ============================================================================
// Pulls pages the user has shared with the LYKN integration into the vault.
//
// Notion's OAuth model is "workspace install" — the user picks which pages
// or databases to grant the integration access to. We then call /v1/search
// to enumerate everything visible to our bot token, sorted by
// last_edited_time descending, and save each page as a bookmark note
// pointing at notion.so/{page_id}.
//
// API:
//   • Auth URL : https://api.notion.com/v1/oauth/authorize
//                ?owner=user → user token (not workspace bot install)
//   • Token URL: https://api.notion.com/v1/oauth/token
//   • Auth     : HTTP Basic with client_id:client_secret on token swap
//   • Token    : bearer, no expiry
//   • Header   : Notion-Version: 2022-06-28 required on every API call
//
// What gets pulled
// ----------------
// For every page visible to the integration:
//   1. /v1/search enumerates pages newest-edited first
//   2. /v1/blocks/{page_id}/children walks the block tree (bounded depth +
//      bounded block count) and flattens supported text-bearing block types
//      into a plain-text body — paragraphs, headings, lists, to-dos, quotes,
//      code, callouts, sub-page/database references, etc.
//   3. The body lands in `notes.content`, which makes the page searchable
//      by both substring (MCP `lykn_searchVault`) and vector embeddings
//      (synthesis layer — see embedAndStoreChunks call in savePageAsNote).
//
// Existing pages get UPDATED on subsequent syncs whenever their
// `last_edited_time` advances past our cursor (the previous behavior was
// "skip if URL already in vault", which silently dropped every edit the
// user made to a page after first import).
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';
import { embedAndStoreChunks } from '../synthesis-service.js';
import { buildAttachmentColumns } from '../lib/vault/attachmentType.js';

const NOTION_AUTH_URL = 'https://api.notion.com/v1/oauth/authorize';
const NOTION_TOKEN_URL = 'https://api.notion.com/v1/oauth/token';
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const FETCH_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_SYNC = 5; // 500 pages per sync

// Bounds on per-page block walks. Notion pages can be effectively unbounded
// (toggle trees, sub-pages, databases). These caps stop a single huge page
// from monopolizing one sync tick — at depth 5 / 500 blocks we capture the
// "body" of essentially every real-world page without runaway API spend.
const MAX_BLOCKS_PER_PAGE = 500;
const MAX_BLOCK_DEPTH = 5;
const BLOCKS_PAGE_SIZE = 100;

function withTimeout(promise, ms, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function basicAuth(clientId, clientSecret) {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

function notionHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

export const notionAdapter = {
  id: 'notion',

  buildAuthUrl({ clientId, redirectUri, state }) {
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      owner: 'user',
      redirect_uri: redirectUri,
      state,
    });
    return `${NOTION_AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode({ code, clientId, clientSecret, redirectUri }) {
    const res = await withTimeout(
      fetch(NOTION_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(clientId, clientSecret),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      }),
      FETCH_TIMEOUT_MS,
      'notion-token',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Notion token exchange: HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const j = await res.json();

    const accessToken = j.access_token;
    if (!accessToken) throw new Error('Notion did not return an access_token');

    // Notion "owner=user" returns owner.user with profile fields.
    const ownerUser = j.owner?.user || {};
    const handle =
      ownerUser?.person?.email?.split('@')[0] ||
      ownerUser?.name ||
      j.workspace_name ||
      'notion-user';
    const providerUserId = ownerUser?.id || j.bot_id;

    return {
      providerUserId: String(providerUserId),
      accessToken,
      refreshToken: null,
      tokenExpiresAt: null,
      scopes: [],
      account: {
        handle,
        displayName: ownerUser?.name || j.workspace_name || handle,
        email: ownerUser?.person?.email || null,
        avatarUrl: ownerUser?.avatar_url || j.workspace_icon || null,
      },
      metadata: {
        workspace_id: j.workspace_id,
        workspace_name: j.workspace_name,
        workspace_icon: j.workspace_icon,
        bot_id: j.bot_id,
        // Cursor: ISO timestamp of the most recently edited page we've seen.
        last_edited_cursor: null,
      },
    };
  },

  async sync({ connection, supabaseAdmin, accessToken }) {
    const cursorIso = connection.metadata?.last_edited_cursor || null;
    const cursorTime = cursorIso ? new Date(cursorIso).getTime() : 0;

    let saved = 0;
    let skipped = 0;
    let startCursor = undefined;
    let newestEdited = cursorTime;

    pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      const body = {
        filter: { property: 'object', value: 'page' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: PAGE_SIZE,
        ...(startCursor ? { start_cursor: startCursor } : {}),
      };
      const res = await withTimeout(
        fetch(`${NOTION_API}/search`, {
          method: 'POST',
          headers: notionHeaders(accessToken),
          body: JSON.stringify(body),
        }),
        FETCH_TIMEOUT_MS,
        `notion-search-p${page}`,
      );
      if (res.status === 401 || res.status === 403) {
        const t = await res.text().catch(() => '');
        throw new ConnectorAuthError(`Notion ${res.status}: ${t.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`Notion search page ${page}: HTTP ${res.status}`);

      const j = await res.json();
      const results = j.results || [];
      if (!results.length) break;

      for (const item of results) {
        const editedTime = new Date(item.last_edited_time || 0).getTime();
        // Newest-first iteration: as soon as we hit a page older than the
        // last cursor we know everything after it is already in sync.
        if (cursorTime && editedTime <= cursorTime) break pages;

        const result = await savePageAsNote({
          supabaseAdmin,
          accessToken,
          userId: connection.user_id,
          item,
          workspaceName: connection.metadata?.workspace_name || 'Notion',
        });
        if (result === 'saved') saved++;
        else if (result === 'updated') saved++;
        else skipped++;

        if (editedTime > newestEdited) newestEdited = editedTime;
      }

      if (!j.has_more || !j.next_cursor) break;
      startCursor = j.next_cursor;
    }

    if (newestEdited && newestEdited !== cursorTime) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: {
            ...(connection.metadata || {}),
            last_edited_cursor: new Date(newestEdited).toISOString(),
          },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

// ---------------------------------------------------------------------------
// Save one Notion page as a vault note (upsert + body fetch + reindex)
// ---------------------------------------------------------------------------
// Returns one of:
//   'saved'   — brand-new note row inserted
//   'updated' — pre-existing row's content/title refreshed from Notion
//   'skipped' — page lacked a URL or insert failed (logged, never thrown)
//
// Why upsert instead of "skip if URL exists"
// ------------------------------------------
// The old behavior captured a page once and then ignored every subsequent
// edit, because the sync loop dedupes by `content ILIKE %url%`. That meant
// the vault held a stale title/description for every page the user later
// renamed or rewrote in Notion. The new path:
//   1. Looks up the existing note for this page URL (single-shot scan)
//   2. Fetches the live block tree from Notion
//   3. INSERTs or UPDATEs accordingly
//   4. Triggers a synthesis reindex (embedAndStoreChunks) so semantic
//      retrieval reflects the latest body
//
// We deliberately leave user-added tags alone on update — only the
// adapter-managed fields (title, content, source) get refreshed. User
// curation survives Notion-side edits.
async function savePageAsNote({ supabaseAdmin, accessToken, userId, item, workspaceName }) {
  const url = item.url;
  if (!url) return 'skipped';

  const title = extractNotionTitle(item) || 'Notion page';
  const icon = extractNotionIcon(item);
  const cover = item?.cover?.external?.url || item?.cover?.file?.url || '';

  // Fetch the live block tree. Auth failures here propagate up so the
  // sync orchestrator can flip the connection to 'reauth'. Other errors
  // are swallowed inside fetchPageBody — we'll still save the bookmark
  // shell so the page at least appears in the vault.
  let body = '';
  try {
    body = await fetchPageBody({ accessToken, pageId: item.id });
  } catch (err) {
    if (err instanceof ConnectorAuthError) throw err;
    console.warn(`[notion] body fetch failed for ${url}: ${err.message}`);
  }

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description: body ? body.slice(0, 280) : `Notion page in ${workspaceName}`,
    image: cover || icon || '',
    favicon: 'https://www.notion.so/images/favicon.ico',
    siteName: workspaceName,
    articleText: body.slice(0, 8000),
    oembedType: 'notion',
    oembedHtml: '',
    authorName: '',
    authorHandle: '',
  };

  // `content` layout: title, attachment JSON (which the vault UI parses
  // for the bookmark card), then the plain-text body. Putting body LAST
  // matters — the MCP `lykn_searchVault` tool does substring matching on
  // `content`, and embedAndStoreChunks chunks the same string. Keeping
  // the body in the same field unifies "what users search" with "what
  // the AI retrieves semantically."
  const noteContent = [
    title,
    '',
    `[ATTACHMENTS_JSON:${JSON.stringify([attachment])}]`,
    body ? '\n' + body : '',
  ].join('\n').trim();

  const attachmentColumns = buildAttachmentColumns(attachment);

  const editedAt = item.last_edited_time ? new Date(item.last_edited_time).toISOString() : undefined;

  // Find an existing row for this page URL. We key on the URL substring
  // because the bookmark JSON always embeds the canonical notion.so URL,
  // and Notion page URLs are stable across edits.
  const { data: existingRows } = await supabaseAdmin
    .from('vault_items')
    .select('id')
    .eq('user_id', userId)
    .eq('source', 'notion_page')
    .ilike('content', `%${url}%`)
    .limit(1);
  const existing = existingRows && existingRows[0];

  let noteId = existing?.id || null;
  let mode = existing ? 'updated' : 'saved';

  if (existing) {
    const { error: updErr } = await supabaseAdmin
      .from('vault_items')
      .update({
        title,
        content: noteContent,
        updated_at: new Date().toISOString(),
        ...attachmentColumns,
      })
      .eq('id', existing.id)
      .eq('user_id', userId);
    if (updErr) {
      console.error(`[notion] note update failed for ${url}:`, updErr.message);
      return 'skipped';
    }
  } else {
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('vault_items')
      .insert({
        user_id: userId,
        title,
        content: noteContent,
        source: 'notion_page',
        tags: ['notion', 'page', 'link', 'uploaded'],
        created_at: editedAt,
        ...attachmentColumns,
      })
      .select('id')
      .single();
    if (insErr) {
      console.error(`[notion] note insert failed for ${url}:`, insErr.message);
      return 'skipped';
    }
    noteId = inserted?.id || null;
  }

  // Fire-and-forget synthesis embed. We never want a transient OpenAI 429
  // or embedding outage to break the connector sync — the page is already
  // in the vault and will be re-embedded on the next edit. The await is
  // intentional (back-pressure) but failures are logged, not thrown.
  if (noteId && body && body.length >= 8) {
    try {
      const result = await embedAndStoreChunks({
        supabaseAdmin,
        userId,
        sourceType: 'vault_note',
        sourceId: noteId,
        text: body,
        metadata: {
          source: 'notion_page',
          title,
          workspace: workspaceName,
          url,
        },
      });
      if (!result.ok && result.reason !== 'openai_key_missing') {
        console.warn(`[notion] embed failed for ${url}: ${result.reason}`);
      }
    } catch (err) {
      console.warn(`[notion] embed threw for ${url}: ${err.message}`);
    }
  }

  // AI summary generation for the synced Notion page. Without this, the
  // chat layer's [VAULT_URL_MATCHES] block falls back to dumping the full
  // body every time the user drags this page in — wasteful and slow.
  // With it, the model gets a 2-5 sentence overview up front and only
  // walks the body when the summary doesn't cover the question (matches
  // the "summary-first, body-on-demand" design we're targeting for all
  // connected-source vault items).
  //
  // Strict fire-and-forget: we never block the sync loop on summary
  // generation, and we never propagate failures. enrichVaultNoteSummary
  // is idempotent (hashes the stripped body), so calling it on every
  // sync is a no-op for unchanged pages — one DB read, no LLM call.
  if (noteId) {
    enrichNoteSummary(noteId, userId).catch((err) => {
      console.warn(`[notion] summary enrich threw for ${url}: ${err?.message || err}`);
    });
  }

  return mode;
}

// Bridge to server.js's `enrichVaultNoteSummary`. We lazy-import to avoid
// a circular dependency (server.js imports this connector module at boot).
let _enrichVaultNoteSummary = null;
async function enrichNoteSummary(noteId, userId) {
  if (!_enrichVaultNoteSummary) {
    try {
      const mod = await import('../server.js');
      _enrichVaultNoteSummary = mod.enrichVaultNoteSummary;
    } catch (e) {
      console.warn(`[notion] could not lazy-load enrichVaultNoteSummary: ${e?.message || e}`);
      return;
    }
  }
  if (typeof _enrichVaultNoteSummary !== 'function') return;
  const result = await _enrichVaultNoteSummary({ userId, noteId });
  if (result && !result.ok && result.reason && result.reason !== 'openai_key_missing' && result.reason !== 'columns_missing') {
    console.warn(`[notion] enrich for ${noteId} returned not-ok: ${result.reason}`);
  }
}

// Notion stores a page's title as a "title" property on the page. Different
// templates name the property differently (Name, Title, etc.), so we walk
// every property and grab the first one whose type === 'title'.
function extractNotionTitle(item) {
  const props = item.properties || {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop?.type === 'title' && Array.isArray(prop.title)) {
      const text = prop.title.map((t) => t.plain_text || '').join('').trim();
      if (text) return text.slice(0, 280);
    }
  }
  return '';
}

function extractNotionIcon(item) {
  const ic = item.icon;
  if (!ic) return '';
  if (ic.type === 'external') return ic.external?.url || '';
  if (ic.type === 'file') return ic.file?.url || '';
  // Emoji icons aren't useful as image URLs; ignore.
  return '';
}

// ---------------------------------------------------------------------------
// Page body fetcher
// ---------------------------------------------------------------------------
// Walks /v1/blocks/{id}/children recursively (paginated) and flattens
// supported text-bearing block types into a plain-text body. Bounded by
// MAX_BLOCKS_PER_PAGE and MAX_BLOCK_DEPTH so a pathological page (huge
// toggle trees, deep sub-page nests) can't monopolize a sync tick.
//
// Transient HTTP errors on a subtree are swallowed — we return whatever
// text we got rather than abandoning the page. Auth errors propagate as
// ConnectorAuthError so the sync orchestrator flips the connection to
// 'reauth'.
export async function fetchPageBody({ accessToken, pageId }) {
  const lines = [];
  let blocksFetched = 0;

  async function walkBlock(blockId, depth) {
    if (depth > MAX_BLOCK_DEPTH || blocksFetched >= MAX_BLOCKS_PER_PAGE) return;

    let cursor = null;
    do {
      const params = new URLSearchParams({ page_size: String(BLOCKS_PAGE_SIZE) });
      if (cursor) params.set('start_cursor', cursor);
      const url = `${NOTION_API}/blocks/${blockId}/children?${params.toString()}`;

      let res;
      try {
        res = await withTimeout(
          fetch(url, { headers: notionHeaders(accessToken) }),
          FETCH_TIMEOUT_MS,
          `notion-blocks-${depth}`,
        );
      } catch {
        // Network/timeout: bail this subtree, keep what we have.
        return;
      }

      if (res.status === 401 || res.status === 403) {
        throw new ConnectorAuthError(`Notion ${res.status} fetching blocks`);
      }
      if (res.status === 404) {
        // Block was deleted between /search and /blocks. Not fatal.
        return;
      }
      if (!res.ok) return;

      const j = await res.json().catch(() => null);
      const results = Array.isArray(j?.results) ? j.results : [];

      for (const block of results) {
        if (blocksFetched >= MAX_BLOCKS_PER_PAGE) break;
        blocksFetched++;
        const text = blockToText(block);
        if (text) lines.push(text);
        // Recurse into containers (toggles, columns, child pages, tables…).
        if (block?.has_children && depth < MAX_BLOCK_DEPTH) {
          await walkBlock(block.id, depth + 1);
        }
      }

      cursor = j?.next_cursor || null;
    } while (cursor && blocksFetched < MAX_BLOCKS_PER_PAGE);
  }

  await walkBlock(pageId, 0);
  return lines.join('\n').trim();
}

// Notion `rich_text` is an array of segments; we just need the plain_text.
function richTextToString(rich) {
  if (!Array.isArray(rich)) return '';
  return rich.map((r) => r?.plain_text || '').join('');
}

// Block → markdown-ish plain text. Unsupported block types return ''.
// We deliberately don't try to recreate Notion fidelity here — this string
// is for AI retrieval, not rendering.
function blockToText(block) {
  const t = block?.type;
  if (!t) return '';
  const data = block[t] || {};
  switch (t) {
    case 'paragraph':
      return richTextToString(data.rich_text);
    case 'heading_1':
      return `# ${richTextToString(data.rich_text)}`;
    case 'heading_2':
      return `## ${richTextToString(data.rich_text)}`;
    case 'heading_3':
      return `### ${richTextToString(data.rich_text)}`;
    case 'bulleted_list_item':
      return `- ${richTextToString(data.rich_text)}`;
    case 'numbered_list_item':
      return `1. ${richTextToString(data.rich_text)}`;
    case 'to_do':
      return `${data.checked ? '[x]' : '[ ]'} ${richTextToString(data.rich_text)}`;
    case 'toggle':
      return richTextToString(data.rich_text);
    case 'quote':
      return `> ${richTextToString(data.rich_text)}`;
    case 'callout':
      return richTextToString(data.rich_text);
    case 'code': {
      const body = richTextToString(data.rich_text);
      if (!body) return '';
      const lang = data.language || '';
      return '```' + lang + '\n' + body + '\n```';
    }
    case 'child_page':
      return data.title ? `[Sub-page] ${data.title}` : '';
    case 'child_database':
      return data.title ? `[Database] ${data.title}` : '';
    case 'equation':
      return data.expression || '';
    case 'divider':
      return '---';
    case 'bookmark':
    case 'embed':
    case 'link_preview':
      return data.url || '';
    case 'table_row': {
      const cells = Array.isArray(data.cells) ? data.cells : [];
      return cells.map((c) => richTextToString(c)).join(' | ');
    }
    default:
      // Includes: image, video, file, pdf, audio, breadcrumb, table_of_contents,
      // synced_block, link_to_page, template, column_list, column, unsupported.
      // Containers (column_list, column, table, synced_block) still recurse
      // via has_children in walkBlock; we just don't emit text for the container
      // itself.
      return '';
  }
}
