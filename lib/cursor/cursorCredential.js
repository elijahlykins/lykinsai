const CURSOR_API_BASE = (process.env.CURSOR_API_BASE || 'https://api.cursor.com').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = 12_000;

export class CursorCredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CursorCredentialError';
    this.isUserFacing = true;
  }
}

function normalizeRepo(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return `https://github.com/${value}`;
  return value;
}

export async function fetchCursorIdentity(apiKey, { fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${CURSOR_API_BASE}/v1/me`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new CursorCredentialError(
        'Cursor rejected this API key. Create a new one at cursor.com/dashboard -> Integrations (it needs Cloud Agents access).',
      );
    }
    if (!response.ok) throw new Error(`Cursor /v1/me: HTTP ${response.status}`);
    return response.json().catch(() => ({}));
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Cursor credential check timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function validateCursorCredential(fields = {}, options = {}) {
  const apiKey = String(fields.api_key || fields.token || '').trim();
  if (!apiKey) throw new CursorCredentialError('A Cursor API key is required.');
  const identity = await fetchCursorIdentity(apiKey, options);
  const email = identity?.userEmail || identity?.email || null;
  const keyName = identity?.apiKeyName || identity?.name || null;
  return {
    secret: apiKey,
    label: keyName ? `Cursor (${keyName})` : 'Cursor Cloud',
    metadata: {
      default_repo: normalizeRepo(fields.repo) || null,
      account_email: email,
      key_name: keyName,
    },
  };
}
