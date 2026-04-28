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
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';

const NOTION_AUTH_URL = 'https://api.notion.com/v1/oauth/authorize';
const NOTION_TOKEN_URL = 'https://api.notion.com/v1/oauth/token';
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const FETCH_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_SYNC = 5; // 500 pages per sync

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
        if (cursorTime && editedTime <= cursorTime) break pages;

        const result = await savePageAsNote({
          supabaseAdmin,
          userId: connection.user_id,
          item,
          workspaceName: connection.metadata?.workspace_name || 'Notion',
        });
        if (result === 'saved') saved++;
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
// Save one Notion page as a vault note
// ---------------------------------------------------------------------------
async function savePageAsNote({ supabaseAdmin, userId, item, workspaceName }) {
  const url = item.url;
  if (!url) return 'skipped';

  const { data: existing } = await supabaseAdmin
    .from('notes')
    .select('id')
    .eq('user_id', userId)
    .ilike('content', `%${url}%`)
    .limit(1);
  if (existing && existing.length > 0) return 'skipped';

  const title = extractNotionTitle(item) || 'Notion page';
  const icon = extractNotionIcon(item);
  const cover = item?.cover?.external?.url || item?.cover?.file?.url || '';

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description: `Notion page in ${workspaceName}`,
    image: cover || icon || '',
    favicon: 'https://www.notion.so/images/favicon.ico',
    siteName: workspaceName,
    articleText: '',
    oembedType: 'notion',
    oembedHtml: '',
    authorName: '',
    authorHandle: '',
  };
  const noteContent = `${title}\n\n[ATTACHMENTS_JSON:${JSON.stringify([attachment])}]`;

  const editedAt = item.last_edited_time ? new Date(item.last_edited_time).toISOString() : undefined;

  const { error } = await supabaseAdmin
    .from('notes')
    .insert({
      user_id: userId,
      title,
      content: noteContent,
      source: 'notion_page',
      tags: ['notion', 'page', 'link', 'uploaded'],
      created_at: editedAt,
    });
  if (error) {
    const { error: err2 } = await supabaseAdmin
      .from('notes')
      .insert({ user_id: userId, title, content: noteContent });
    if (err2) {
      console.error(`[notion] note insert failed for ${url}:`, err2.message);
      return 'skipped';
    }
  }
  return 'saved';
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
