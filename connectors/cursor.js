// ============================================================================
// connectors/cursor.js — Cursor account (token-paste, bring-your-own key)
// ============================================================================
// UNLIKE the other adapters here, Cursor is NOT a read-only data source that
// syncs items into the vault. It is an ACTION connector: attaching it lets the
// LYKN agent hand coding tasks to a Cursor CLOUD AGENT on the USER'S OWN
// account (see lib/cursor/cursorBuilds.js + mcp-tools/buildWithCursor.js). The
// agent builds against any repo the user's key can reach and opens a PR.
//
// Auth model: Cursor has no third-party OAuth, so we use the same token-paste
// flow as Trello/Readwise. The user generates a personal API key at
// cursor.com/dashboard → Integrations (with Cloud Agents access) and pastes it.
// We validate it via GET /v1/me, then store it encrypted at rest like every
// other connector credential. Builds run on THAT key — never on a shared LYKN
// account.
//
// `sync` here does no vault import; it only re-validates the key so a revoked
// or rotated key flips the connection to `reauth` and the UI prompts a
// reconnect. That keeps the connections list honest without a data pull.
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';

const CURSOR_API_BASE = (process.env.CURSOR_API_BASE || 'https://api.cursor.com').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = 12_000;

function withTimeout(promise, ms = FETCH_TIMEOUT_MS, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// GET /v1/me — returns info about the API key being used. Cursor accepts both
// Basic (`-u KEY:`) and Bearer; we use Bearer to match cursorBuilds.js.
async function cursorMe(apiKey) {
  const res = await withTimeout(
    fetch(`${CURSOR_API_BASE}/v1/me`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }),
    FETCH_TIMEOUT_MS,
    'cursor-me',
  );
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorAuthError(`Cursor ${res.status}: API key rejected`);
  }
  if (!res.ok) throw new Error(`Cursor /v1/me: HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

function normalizeRepo(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  // Accept full URLs or owner/repo shorthand; store a canonical github URL.
  if (/^https?:\/\//i.test(v)) return v.replace(/\/+$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(v)) return `https://github.com/${v}`;
  return v;
}

export const cursorAdapter = {
  id: 'cursor',
  authMode: 'token',

  // No server-side shared credential is required — each user brings their own
  // key — so the connector is always "ready" to accept a connection.
  isReady() {
    return true;
  },

  // Surfaced by the connect dialog when it opens.
  connectInfo() {
    return {
      tokenHelpUrl: 'https://cursor.com/dashboard',
      tokenHelpLabel: 'Open Cursor Dashboard → Integrations → create an API key',
      message:
        'Generate a Cursor API key with Cloud Agents access (Dashboard → Integrations) and paste it above. Make sure your GitHub is connected to Cursor so the agent can clone your repos and open PRs.',
    };
  },

  /**
   * Validate a pasted Cursor API key and produce a connection-ready object.
   * fields: { api_key: string, repo?: string }
   */
  async connectWithToken({ fields }) {
    const apiKey = String(fields?.api_key || fields?.token || '').trim();
    if (!apiKey) throw new ConnectorAuthError('A Cursor API key is required.');

    let me;
    try {
      me = await cursorMe(apiKey);
    } catch (err) {
      if (err instanceof ConnectorAuthError || /401|403|rejected/i.test(err.message)) {
        throw new ConnectorAuthError('Cursor rejected this API key. Create a new one at cursor.com/dashboard -> Integrations (it needs Cloud Agents access).');
      }
      throw err;
    }

    const email = me?.userEmail || me?.email || null;
    const keyName = me?.apiKeyName || me?.name || null;
    const defaultRepo = normalizeRepo(fields?.repo);

    // Cursor's /me has no stable account UUID for user keys, so we key the
    // connection on the email (or key name) — both are stable enough that a
    // reconnect upserts the same row instead of duplicating.
    const providerUserId = email || keyName || 'cursor';

    return {
      providerUserId: String(providerUserId),
      accessToken: apiKey,
      refreshToken: null,
      tokenExpiresAt: null, // Cursor API keys don't expire unless revoked.
      scopes: ['cloud-agents'],
      account: {
        handle: keyName || 'cursor',
        displayName: keyName ? `Cursor (${keyName})` : 'Cursor',
        email,
        avatarUrl: null,
      },
      metadata: {
        // Optional default repo used when a build doesn't name one. The agent
        // may still target any repo this key can reach.
        default_repo: defaultRepo || null,
      },
    };
  },

  /**
   * No vault import — just re-validate the key so a revoked/rotated key surfaces
   * as `reauth` in the connections list. Throwing ConnectorAuthError lets the
   * framework mark the connection for reconnect.
   */
  async sync({ accessToken }) {
    await cursorMe(accessToken);
    return { saved: 0, skipped: 0 };
  },
};
