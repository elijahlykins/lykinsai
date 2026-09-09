/**
 * Deep-link into Studio Settings on a specific pane.
 *
 * `/settings` is a legacy product route that redirects into Studio.
 * Privacy, Support, and other public pages should send people to
 * `/studio?settings=account` (or another known pane) so the Settings
 * window actually opens on Account.
 */

export const STUDIO_SETTINGS_QUERY_PARAM = 'settings';

export function studioSettingsPath(view = 'account', extra = null) {
  const pane = String(view || 'account').trim() || 'account';
  const params = new URLSearchParams();
  params.set(STUDIO_SETTINGS_QUERY_PARAM, pane);
  if (extra && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) {
      if (value == null || value === '') continue;
      params.set(key, String(value));
    }
  }
  return `/studio?${params.toString()}`;
}

const BILLING_RETURN_KEYS = ['checkout', 'session_id', 'topup', 'usage_fund', 'source'];

/**
 * `/billing` used to be a standalone plan-comparison page. It now opens
 * Studio Settings → Billing, carrying Stripe return params through so a
 * checkout that still lands on the old URL is not lost.
 */
export function legacyBillingRedirectPath(search = '') {
  const raw = String(search || '');
  const query = raw.startsWith('?') ? raw.slice(1) : raw;
  let incoming;
  try {
    incoming = new URLSearchParams(query);
  } catch {
    incoming = new URLSearchParams();
  }
  const extra = {};
  for (const key of BILLING_RETURN_KEYS) {
    const value = incoming.get(key);
    if (value) extra[key] = value;
  }
  return studioSettingsPath('billing', extra);
}

export function parseSettingsDeepLink(search, allowedViews = []) {
  const rawSearch = String(search || '');
  const query = rawSearch.startsWith('?') ? rawSearch.slice(1) : rawSearch;
  let params;
  try {
    params = new URLSearchParams(query);
  } catch {
    return null;
  }
  const raw = String(params.get(STUDIO_SETTINGS_QUERY_PARAM) || params.get('section') || '').trim();
  if (!raw) return null;
  const allowed = Array.isArray(allowedViews) ? allowedViews : [];
  if (allowed.length && !allowed.includes(raw)) return null;
  return raw;
}

/**
 * `/settings` used to render a standalone page. It now opens Studio Settings.
 * Keep `?section=` / `?settings=` / `#connections` so Connections and other
 * panes are not rewritten to Account.
 */
export function legacySettingsRedirectPath(search = '', hash = '') {
  const fromQuery = parseSettingsDeepLink(search);
  const fromHash = String(hash || '').replace(/^#/, '').trim();
  return studioSettingsPath(fromQuery || fromHash || 'account');
}
