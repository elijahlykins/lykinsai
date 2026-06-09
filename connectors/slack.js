// ============================================================================
// connectors/slack.js — Slack OAuth (user-token) adapter
// ============================================================================
// Pulls every message the user has saved (formerly "starred") into the vault.
// We use Slack's USER token flow (not bot token) so we act as the user and
// can read the user's personal saved-items list.
//
// Slack OAuth specifics:
//   • Auth URL : https://slack.com/oauth/v2/authorize
//                user_scope=<USER_SCOPES below>   (user token, no bot scopes)
//   • Token URL: https://slack.com/api/oauth.v2.access
//   • Token    : returned at `authed_user.access_token` (xoxp-…), no expiry
//                by default (workspace can enforce 12h rotation; we don't
//                attempt rotation here — if revoked we mark status='reauth').
//   • API      : POST https://slack.com/api/<method>
//                Auth via Authorization: Bearer xoxp-… header
//
// `stars.list` is officially deprecated in favor of "saved" but still works
// and is the only documented endpoint that returns a user's saved items.
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';
import { saveConnectorNote } from './_save.js';

const SL_AUTH_URL = 'https://slack.com/oauth/v2/authorize';
const SL_TOKEN_URL = 'https://slack.com/api/oauth.v2.access';
const SL_API = 'https://slack.com/api';

// User-token scopes. We request enough to both PULL saved messages into the
// vault AND let the LYKN agent ACT on Slack via lykn_call_app (list/read
// channels the user belongs to, search, and post as the user). A user token
// reads any conversation the user is already in — no bot-invite dance — and
// chat:write posts as the user. Workspace admins can still restrict these.
export const USER_SCOPES = [
  // identity + saved items (vault sync)
  'team:read',
  'users:read',
  'stars:read',
  // channel/conversation discovery
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  // message history (read)
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  // search
  'search:read',
  // post as the user (write)
  'chat:write',
];

const FETCH_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_SYNC = 4;

function withTimeout(promise, ms = FETCH_TIMEOUT_MS, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function slackCall(method, accessToken, params = {}) {
  const url = `${SL_API}/${method}`;
  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body: new URLSearchParams(params).toString(),
    }),
    FETCH_TIMEOUT_MS,
    `slack-${method}`,
  );
  if (!res.ok) throw new Error(`Slack ${method}: HTTP ${res.status}`);
  const j = await res.json();
  if (!j.ok) {
    // Slack returns 200 OK with { ok: false, error: "..." }. Promote
    // auth errors so the framework marks the connection as reauth-needed.
    if (['invalid_auth', 'token_revoked', 'token_expired', 'not_authed'].includes(j.error)) {
      throw new ConnectorAuthError(`Slack ${method}: ${j.error}`);
    }
    throw new Error(`Slack ${method}: ${j.error}`);
  }
  return j;
}

export const slackAdapter = {
  id: 'slack',

  buildAuthUrl({ clientId, redirectUri, state, scopes = USER_SCOPES }) {
    const params = new URLSearchParams({
      client_id: clientId,
      // user_scope, NOT scope — we want a user token, not a bot token.
      user_scope: scopes.join(','),
      redirect_uri: redirectUri,
      state,
    });
    return `${SL_AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode({ code, clientId, clientSecret, redirectUri }) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    });
    const res = await withTimeout(
      fetch(SL_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }),
      FETCH_TIMEOUT_MS,
      'slack-token',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Slack token exchange: HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const j = await res.json();
    if (!j.ok) throw new Error(`Slack: ${j.error || 'token exchange failed'}`);

    const userAuth = j.authed_user || {};
    const accessToken = userAuth.access_token;
    if (!accessToken) throw new Error('Slack did not return user access_token');

    const team = j.team || {};
    // Resolve the workspace domain so we can construct message permalinks
    // without an extra round-trip per saved message.
    let workspaceDomain = '';
    try {
      const teamInfo = await slackCall('team.info', accessToken);
      workspaceDomain = teamInfo.team?.domain || '';
    } catch (e) {
      console.warn('[slack] team.info failed:', e.message);
    }

    // Look up the authenticated user for display purposes.
    let userInfo = {};
    try {
      const u = await slackCall('users.info', accessToken, { user: userAuth.id });
      userInfo = u.user || {};
    } catch (e) {
      console.warn('[slack] users.info failed:', e.message);
    }

    return {
      providerUserId: String(userAuth.id),
      accessToken,
      refreshToken: null,
      tokenExpiresAt: null,
      scopes: (userAuth.scope || '').split(',').filter(Boolean),
      account: {
        handle: userInfo.name || userAuth.id,
        displayName: userInfo.profile?.real_name || userInfo.real_name || userInfo.name || userAuth.id,
        email: userInfo.profile?.email || null,
        avatarUrl: userInfo.profile?.image_192 || userInfo.profile?.image_72 || null,
      },
      metadata: {
        team_id: team.id,
        team_name: team.name,
        workspace_domain: workspaceDomain,
        saved_cursor: null, // ts of the most-recent saved message we've seen
      },
    };
  },

  async sync({ connection, supabaseAdmin, accessToken }) {
    const meta = connection.metadata || {};
    const cursorTs = parseFloat(meta.saved_cursor || '0') || 0;
    const workspaceDomain = meta.workspace_domain || '';

    let saved = 0;
    let skipped = 0;
    let cursor = undefined;
    let newestTs = cursorTs;

    pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      const data = await slackCall('stars.list', accessToken, {
        count: String(PAGE_SIZE),
        ...(cursor ? { cursor } : {}),
      });
      const items = data.items || [];
      if (!items.length) break;

      for (const item of items) {
        if (item.type !== 'message' || !item.message) {
          skipped++;
          continue;
        }
        const msg = item.message;
        const ts = parseFloat(msg.ts || '0') || 0;
        if (cursorTs && ts <= cursorTs) break pages;

        const result = await saveSavedMessage({
          supabaseAdmin,
          userId: connection.user_id,
          channelId: item.channel,
          message: msg,
          workspaceDomain,
        });
        if (result === 'saved' || result === 'updated') saved++;
        else skipped++;

        if (ts > newestTs) newestTs = ts;
      }

      cursor = data.response_metadata?.next_cursor;
      if (!cursor) break;
    }

    if (newestTs && newestTs !== cursorTs) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: { ...meta, saved_cursor: String(newestTs) },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

async function saveSavedMessage({
  supabaseAdmin,
  userId,
  channelId,
  message,
  workspaceDomain,
}) {
  // Construct the Slack permalink without an extra API call. Format:
  //   https://{workspace}.slack.com/archives/{channel_id}/p{ts_no_dot}
  // Where ts_no_dot is the message ts with the period removed (e.g.
  // "1709331234.000200" → "1709331234000200").
  if (!workspaceDomain || !channelId || !message.ts) return 'skipped';
  const tsNoDot = message.ts.replace('.', '');
  const url = `https://${workspaceDomain}.slack.com/archives/${channelId}/p${tsNoDot}`;

  const text = (message.text || '').replace(/\s+/g, ' ').slice(0, 1200) || '(no content)';
  const author = message.username || message.user || 'Slack user';
  const title = `Slack: ${text.slice(0, 100)}`.slice(0, 280);

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description: text,
    image: '',
    favicon: 'https://a.slack-edge.com/80588/marketing/img/meta/favicon-32.png',
    siteName: workspaceDomain ? `${workspaceDomain}.slack.com` : 'Slack',
    articleText: text,
    oembedType: 'slack',
    oembedHtml: '',
    authorName: author,
    authorHandle: '',
  };

  const tags = ['slack', 'saved', 'message', 'link', 'uploaded'];
  const tsMs = Math.floor(parseFloat(message.ts) * 1000);
  const createdAt = tsMs ? new Date(tsMs).toISOString() : undefined;

  const body = [
    author ? `From: ${author}` : '',
    workspaceDomain ? `Workspace: ${workspaceDomain}.slack.com` : '',
    '',
    text,
  ].filter(Boolean).join('\n');

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags,
    source: 'slack_saved',
    createdAt,
    body,
    embedMetadata: { source: 'slack_saved', title, url, author, workspace: workspaceDomain || '' },
  });
}
