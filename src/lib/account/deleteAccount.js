export const ACCOUNT_DELETE_CONFIRM_PHRASE = 'DELETE';

export function canSubmitAccountDeletion(typed) {
  return String(typed || '').trim() === ACCOUNT_DELETE_CONFIRM_PHRASE;
}

/**
 * Call the existing account-deletion API. The server still requires
 * `{ confirm: "DELETE" }`; this helper will not send a request until the
 * typed phrase matches.
 *
 * @param {object} [opts]
 * @param {string} [opts.apiBase]
 * @param {string} [opts.token]
 * @param {string} [opts.confirm]
 * @param {typeof fetch} [opts.fetchImpl]
 */
export async function requestAccountDeletion(opts = {}) {
  const {
    apiBase,
    token,
    confirm,
    fetchImpl = fetch,
  } = opts;
  if (!canSubmitAccountDeletion(confirm)) {
    return { ok: false, error: 'confirmation_required', status: 0 };
  }
  const base = String(apiBase || '').replace(/\/$/, '');
  const auth = String(token || '').trim();
  if (!base) return { ok: false, error: 'api_unavailable', status: 0 };
  if (!auth) return { ok: false, error: 'not_signed_in', status: 0 };

  const res = await fetchImpl(`${base}/api/account`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ confirm: ACCOUNT_DELETE_CONFIRM_PHRASE }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      error: data?.error || 'delete_failed',
      status: res.status,
    };
  }
  return { ok: true, status: res.status, data };
}
