// ============================================================================
// connectors/trello.js — Trello adapter (token-paste, no OAuth dance)
// ============================================================================
// Pulls cards from boards the user has starred into the vault as bookmark
// notes. Each starred board's open cards become individual notes pointing
// at trello.com/c/<shortLink>.
//
// Auth model: We avoid OAuth 1.0a (Trello's only true server-side OAuth)
// in favor of Trello's "user token" model, which is officially supported
// and simpler:
//   1. Server holds a single TRELLO_API_KEY (registered once at
//      trello.com/app-key).
//   2. User clicks a help link that sends them to
//      https://trello.com/1/authorize?key=<KEY>&...&response_type=token
//      where Trello shows an approval dialog and (after consent) presents
//      a token for the user to copy.
//   3. User pastes that token into our TokenConnectDialog.
//   4. We validate via /1/members/me?key=KEY&token=TOKEN and persist.
//
// Every Trello API call uses ?key=<KEY>&token=<USER_TOKEN>. The KEY is
// always our app's shared key; the TOKEN is per-user.
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';

const TR_API = 'https://api.trello.com/1';
const TR_AUTHORIZE = 'https://trello.com/1/authorize';
const FETCH_TIMEOUT_MS = 12_000;

// Per-board card cap and total board cap per sync — Trello power users
// can have hundreds of boards with thousands of cards apiece. We bound
// the work so a sync stays under a minute.
const MAX_BOARDS = 30;
const MAX_CARDS_PER_BOARD = 100;

function withTimeout(promise, ms = FETCH_TIMEOUT_MS, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function trelloApiKey() {
  return process.env.TRELLO_API_KEY || '';
}

async function trelloGet(path, token, label, params = {}) {
  const url = new URL(`${TR_API}/${path}`);
  url.searchParams.set('key', trelloApiKey());
  url.searchParams.set('token', token);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await withTimeout(fetch(url), FETCH_TIMEOUT_MS, `trello-${label}`);
  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => '');
    throw new ConnectorAuthError(`Trello ${res.status}: ${body.slice(0, 120)}`);
  }
  if (!res.ok) {
    throw new Error(`Trello ${path}: HTTP ${res.status}`);
  }
  return res.json();
}

export const trelloAdapter = {
  id: 'trello',
  authMode: 'token',

  // Readiness hook for the framework's boot diagnostics. Trello is a
  // token-mode adapter but still needs a server-side shared API key.
  isReady({ env }) {
    return Boolean(env?.TRELLO_API_KEY);
  },

  // Used by boot diagnostics when isReady returns false — points the
  // operator at the right env var to set.
  envHint: 'TRELLO_API_KEY',

  /**
   * Returns dynamic connect info (called by the dialog when it opens).
   * Trello's authorize URL needs our server-side API key embedded — the
   * frontend doesn't know it, so we build the URL here.
   */
  connectInfo() {
    const key = trelloApiKey();
    if (!key) {
      return {
        message:
          'Server is missing TRELLO_API_KEY. Register an app at trello.com/app-key, then set TRELLO_API_KEY in .env and restart.',
      };
    }
    const params = new URLSearchParams({
      key,
      name: 'LYKN',
      scope: 'read',
      expiration: 'never',
      response_type: 'token',
    });
    return {
      tokenHelpUrl: `${TR_AUTHORIZE}?${params.toString()}`,
      tokenHelpLabel: 'Open Trello → approve → copy your token',
      message:
        "Click the link below, approve LYKN, then copy the token Trello shows and paste it above.",
    };
  },

  async connectWithToken({ fields }) {
    const token = String(fields?.token || '').trim();
    if (!token) throw new Error('Trello user token is required.');
    if (!trelloApiKey()) {
      throw new Error('Server is missing TRELLO_API_KEY. Set it in .env and restart.');
    }

    let me;
    try {
      me = await trelloGet('members/me', token, 'me', {
        fields: 'id,username,fullName,email,avatarUrl,initials',
      });
    } catch (err) {
      if (/401|403|invalid/i.test(err.message)) {
        throw new Error('Trello rejected this token. Generate a new one and try again.');
      }
      throw err;
    }

    return {
      providerUserId: String(me.id),
      accessToken: token,
      refreshToken: null,
      tokenExpiresAt: null, // We requested expiration=never
      scopes: ['read'],
      account: {
        handle: me.username || '',
        displayName: me.fullName || me.username || 'Trello user',
        email: me.email || null,
        avatarUrl: me.avatarUrl ? `${me.avatarUrl}/170.png` : null,
      },
      metadata: {
        // Per-board cursors so we don't re-import already-seen cards.
        // Shape: { [boardId]: latestCardDateLastActivity ISO }
        board_cursors: {},
      },
    };
  },

  /**
   * For each starred board, pull open cards and save the new ones as
   * vault notes. Cursor per board = latest dateLastActivity we've seen.
   */
  async sync({ connection, supabaseAdmin, accessToken }) {
    const boardCursors = { ...(connection.metadata?.board_cursors || {}) };

    // Get the user's starred boards. Trello's "filter=starred" returns
    // boards the user has starred — typically a small focused list.
    const boards = await trelloGet('members/me/boards', accessToken, 'boards', {
      filter: 'starred',
      fields: 'id,name,url,shortLink,prefs',
    });

    if (!Array.isArray(boards) || !boards.length) {
      // No starred boards — fall back to recently-active boards so the
      // user still gets cards on their first sync. Capped to MAX_BOARDS.
      const active = await trelloGet('members/me/boards', accessToken, 'boards-active', {
        filter: 'open',
        fields: 'id,name,url,shortLink,prefs',
      });
      boards.push(...(Array.isArray(active) ? active : []).slice(0, MAX_BOARDS));
    }

    let saved = 0;
    let skipped = 0;

    for (const board of boards.slice(0, MAX_BOARDS)) {
      const cursorIso = boardCursors[board.id] || null;
      const cursorTime = cursorIso ? new Date(cursorIso).getTime() : 0;
      let newest = cursorTime;

      const cards = await trelloGet(`boards/${board.id}/cards`, accessToken, 'cards', {
        filter: 'open',
        fields:
          'id,name,desc,url,shortLink,dateLastActivity,due,closed,labels',
        limit: MAX_CARDS_PER_BOARD,
      });

      for (const card of cards || []) {
        const dla = card.dateLastActivity ? new Date(card.dateLastActivity).getTime() : 0;
        if (cursorTime && dla && dla <= cursorTime) continue;

        const result = await saveTrelloCardAsNote({
          supabaseAdmin,
          userId: connection.user_id,
          card,
          board,
        });
        if (result === 'saved') saved++;
        else skipped++;

        if (dla > newest) newest = dla;
      }

      if (newest && newest !== cursorTime) {
        boardCursors[board.id] = new Date(newest).toISOString();
      }
    }

    await supabaseAdmin
      .from('social_connections')
      .update({
        metadata: {
          ...(connection.metadata || {}),
          board_cursors: boardCursors,
        },
      })
      .eq('id', connection.id);

    return { saved, skipped };
  },
};

// ---------------------------------------------------------------------------
// Save a Trello card as a vault note
// ---------------------------------------------------------------------------
async function saveTrelloCardAsNote({ supabaseAdmin, userId, card, board }) {
  if (!card?.url || !card?.shortLink) return 'skipped';
  const url = card.url;

  const { data: existing } = await supabaseAdmin
    .from('notes')
    .select('id')
    .eq('user_id', userId)
    .ilike('content', `%${card.shortLink}%`)
    .limit(1);
  if (existing && existing.length > 0) return 'skipped';

  const title = card.name || 'Untitled card';
  const desc = (card.desc || '').slice(0, 1200);
  const dueLine = card.due ? `Due ${new Date(card.due).toLocaleString()}\n\n` : '';
  const description =
    `${dueLine}${desc}${desc ? '\n\n' : ''}On board: ${board.name || ''}`.trim();

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image: '', // Trello card thumbnails require an extra fetch; skip for v1
    favicon: 'https://a.trellocdn.com/prgb/dist/images/favicon-196x196.png',
    siteName: 'Trello',
    articleText: desc,
    oembedType: 'trello',
    oembedHtml: '',
    authorName: board.name || '',
    authorHandle: '',
  };

  const noteContent = `${title}\n\n[ATTACHMENTS_JSON:${JSON.stringify([attachment])}]`;

  const tags = ['trello', 'card', 'link', 'uploaded'];
  if (Array.isArray(card.labels)) {
    for (const l of card.labels.slice(0, 5)) {
      if (l?.name) tags.push(String(l.name).toLowerCase().slice(0, 24));
    }
  }
  const createdAt = card.dateLastActivity
    ? new Date(card.dateLastActivity).toISOString()
    : undefined;

  const { error } = await supabaseAdmin
    .from('notes')
    .insert({
      user_id: userId,
      title,
      content: noteContent,
      source: 'trello_card',
      tags,
      created_at: createdAt,
    });
  if (error) {
    const { error: err2 } = await supabaseAdmin
      .from('notes')
      .insert({ user_id: userId, title, content: noteContent });
    if (err2) {
      console.error(`[trello] note insert failed for ${url}:`, err2.message);
      return 'skipped';
    }
  }
  return 'saved';
}
