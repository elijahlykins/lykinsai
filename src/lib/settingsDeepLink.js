/**
 * Deep-link into Studio Settings on a specific pane.
 *
 * `/settings` is a legacy product route that redirects into Studio.
 * Privacy, Support, and other public pages should send people to
 * `/studio?settings=account` (or another known pane) so the Settings
 * window actually opens on Account.
 */

export const STUDIO_SETTINGS_QUERY_PARAM = 'settings';

export function studioSettingsPath(view = 'account') {
  const pane = String(view || 'account').trim() || 'account';
  return `/studio?${STUDIO_SETTINGS_QUERY_PARAM}=${encodeURIComponent(pane)}`;
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
