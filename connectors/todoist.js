// ============================================================================
// connectors/todoist.js — Todoist OAuth adapter
// ============================================================================
// Pulls every active task into the vault as a bookmark note pointing at
// the Todoist task URL. Each task is something the user explicitly chose
// to capture, so they're naturally vault-worthy.
//
// Todoist API specifics:
//   • Auth URL : https://todoist.com/oauth/authorize
//   • Token URL: https://todoist.com/oauth/access_token
//   • Tokens   : long-lived bearer (no expiry, no refresh)
//   • Scope    : `data:read` for read-only (no `task:add` etc.)
//   • API      : REST v2 at https://api.todoist.com/rest/v2/
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';
import { saveConnectorNote } from './_save.js';

const TD_AUTH_URL = 'https://todoist.com/oauth/authorize';
const TD_TOKEN_URL = 'https://todoist.com/oauth/access_token';
const TD_REST = 'https://api.todoist.com/rest/v2';
const TD_SYNC = 'https://api.todoist.com/sync/v9';

export const SCOPES = ['data:read'];

const FETCH_TIMEOUT_MS = 12_000;

function withTimeout(promise, ms, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export const todoistAdapter = {
  id: 'todoist',

  buildAuthUrl({ clientId, redirectUri, state, scopes = SCOPES }) {
    const params = new URLSearchParams({
      client_id: clientId,
      scope: scopes.join(','),
      state,
      redirect_uri: redirectUri,
    });
    return `${TD_AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode({ code, clientId, clientSecret, redirectUri }) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    });
    const res = await withTimeout(
      fetch(TD_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }),
      FETCH_TIMEOUT_MS,
      'todoist-token',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Todoist token exchange: HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const j = await res.json();
    if (j.error) throw new Error(`Todoist: ${j.error}`);

    const accessToken = j.access_token;
    if (!accessToken) throw new Error('Todoist did not return an access_token');

    // Fetch the user via the Sync v9 endpoint (REST v2 doesn't expose /user).
    const meRes = await withTimeout(
      fetch(`${TD_SYNC}/sync`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          sync_token: '*',
          resource_types: '["user"]',
        }).toString(),
      }),
      FETCH_TIMEOUT_MS,
      'todoist-me',
    );
    if (!meRes.ok) throw new Error(`Todoist /sync user: HTTP ${meRes.status}`);
    const meJ = await meRes.json();
    const user = meJ.user || {};

    return {
      providerUserId: String(user.id),
      accessToken,
      refreshToken: null,
      tokenExpiresAt: null,
      scopes: SCOPES,
      account: {
        handle: user.email?.split('@')[0] || user.full_name || 'todoist',
        displayName: user.full_name || user.email || 'Todoist user',
        email: user.email || null,
        avatarUrl: user.avatar_medium ? `https://dcff1xvirvpfp.cloudfront.net/${user.avatar_medium}` : null,
      },
      metadata: {
        // Track which task ids we've already saved. Todoist task ids are
        // stable across edits, so a Set of ids is enough for dedupe.
        seen_task_ids: [],
      },
    };
  },

  async sync({ connection, supabaseAdmin, accessToken }) {
    const seen = new Set(connection.metadata?.seen_task_ids || []);

    const res = await withTimeout(
      fetch(`${TD_REST}/tasks`, { headers: { Authorization: `Bearer ${accessToken}` } }),
      FETCH_TIMEOUT_MS,
      'todoist-tasks',
    );
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorAuthError(`Todoist ${res.status}`);
    }
    if (!res.ok) throw new Error(`Todoist /tasks: HTTP ${res.status}`);

    const tasks = await res.json();
    if (!Array.isArray(tasks)) return { saved: 0, skipped: 0 };

    let saved = 0;
    let skipped = 0;
    const newSeen = [...seen];

    for (const task of tasks) {
      if (seen.has(task.id)) {
        skipped++;
        continue;
      }
      const result = await saveTaskAsNote({
        supabaseAdmin,
        userId: connection.user_id,
        task,
      });
      if (result === 'saved' || result === 'updated') saved++;
      else skipped++;

      newSeen.push(task.id);
    }

    // Cap the seen-set so it doesn't grow unbounded for power users.
    // 5000 is plenty — Todoist enforces a 5000-task limit on Free anyway.
    const trimmed = newSeen.slice(-5000);

    if (trimmed.length !== (connection.metadata?.seen_task_ids?.length || 0)) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: { ...(connection.metadata || {}), seen_task_ids: trimmed },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

async function saveTaskAsNote({ supabaseAdmin, userId, task }) {
  const url = task.url || `https://todoist.com/showTask?id=${task.id}`;

  const title = (task.content || 'Todoist task').slice(0, 280);
  const desc = (task.description || '').slice(0, 1200);
  const due = task.due?.date || task.due?.string || '';
  const priorityMap = { 1: '', 2: 'P3', 3: 'P2', 4: 'P1' };
  const priority = priorityMap[task.priority] || '';
  const meta = [due && `due ${due}`, priority].filter(Boolean).join(' · ');
  const description = meta ? `${meta}${desc ? `\n\n${desc}` : ''}` : desc;

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image: '',
    favicon: 'https://todoist.com/favicon.ico',
    siteName: 'Todoist',
    articleText: desc,
    oembedType: 'todoist',
    oembedHtml: '',
    authorName: '',
    authorHandle: '',
  };

  const labels = (task.labels || []).map((l) => String(l).toLowerCase());
  const tags = ['todoist', 'task', ...labels, 'link', 'uploaded'];
  const createdAt = task.created_at ? new Date(task.created_at).toISOString() : undefined;

  const body = [
    due ? `Due: ${due}` : '',
    priority ? `Priority: ${priority}` : '',
    labels.length ? `Labels: ${labels.join(', ')}` : '',
    desc ? '\n' + desc : '',
  ].filter(Boolean).join('\n');

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags,
    source: 'todoist_task',
    createdAt,
    body,
    embedMetadata: { source: 'todoist_task', title, url, due, priority, labels },
  });
}
