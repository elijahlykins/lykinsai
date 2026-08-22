// Shared helpers for the two render-time error boundaries
// (`src/lib/ErrorBoundary.jsx` at the root, `src/lib/RouteErrorBoundary.jsx`
// inside the routed shell). Kept out of the boundaries themselves so any
// future tweak — new stale-bundle pattern, new telemetry endpoint, broader
// localStorage wipe — only has to be made once.

import { API_BASE_URL } from '@/lib/api-config';

const LYKNCHAT_LS_PREFIXES = [
  'lyknchat_draft_',
  'lyknchat_chat_',
  'lyknchat_camera_',
  'lyknchat_vault_saved_',
  'lyknchat_active_id',
  'lyknchat_title',
];

export function clearLyknChatLocalStorage() {
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && LYKNCHAT_LS_PREFIXES.some((p) => key.startsWith(p))) {
        toRemove.push(key);
      }
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
    return toRemove.length;
  } catch {
    return 0;
  }
}

// Force a fresh HTML fetch by appending a cache-bust query param. Plain
// `location.reload()` is honored from the disk cache by iOS Safari (and
// Safari in PWA standalone mode in particular), even with
// `cache-control: must-revalidate`. A query-string change defeats that —
// Safari treats it as a distinct URL and revalidates against origin.
export function cacheBustReload() {
  try {
    if (typeof caches !== 'undefined' && caches?.keys) {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
    }
  } catch {
    // Cache API unavailable / blocked in private mode
  }
  try {
    const u = new URL(window.location.href);
    u.searchParams.set('_r', String(Date.now()));
    window.location.replace(u.toString());
  } catch {
    try {
      window.location.reload();
    } catch {
      // give up — something is very wrong with window.location
    }
  }
}

// Stale-bundle errors look like one of these (Vite/Rollup, native ESM,
// webpack-style chunk loaders). Catching by message because the error
// constructor varies by browser and bundler version.
export function isLikelyStaleBundleError(error) {
  const msg = String(error?.message || error || '');
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /ChunkLoadError/i.test(msg) ||
    /Loading chunk \d+ failed/i.test(msg) ||
    /Loading CSS chunk/i.test(msg) ||
    /Unexpected token '<'/i.test(msg) // CDN served HTML where JS was expected
  );
}

// Best-effort POST of the error to the backend so we get a server log entry
// for every render-time crash a user hits in prod (no Sentry wired up). Uses
// `fetch` with `keepalive: true` so the request survives the page being
// torn down by a refresh / navigation. Falls back to sendBeacon if fetch
// keepalive isn't supported (older Safari). Never throws.
export function reportClientError(error, errorInfo, source = 'route') {
  try {
    if (typeof window === 'undefined') return;
    // Clamped to what /api/client-error accepts. A long-lived install
    // accumulates well over a hundred of these (every desktop icon position is
    // one), and an oversized list used to fail validation and take the whole
    // report down with it — losing the crash we were trying to record.
    const lsKeysSnapshot = (() => {
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length && keys.length < 100; i++) {
          const k = localStorage.key(i);
          if (k && (k.startsWith('lykn_') || k.startsWith('lyknchat_') || k.startsWith('lykinsai_'))) {
            keys.push(k.slice(0, 200));
          }
        }
        return keys;
      } catch {
        return [];
      }
    })();
    const payload = {
      source,
      message: String(error?.message || error || 'unknown'),
      name: String(error?.name || ''),
      stack: String(error?.stack || '').split('\n').slice(0, 30).join('\n'),
      componentStack: String(errorInfo?.componentStack || '').split('\n').slice(0, 30).join('\n'),
      url: window.location.href,
      userAgent: window.navigator?.userAgent || '',
      viewport: { w: window.innerWidth, h: window.innerHeight },
      lsKeys: lsKeysSnapshot,
      timestamp: new Date().toISOString(),
    };
    const url = `${API_BASE_URL}/api/client-error`;
    const body = JSON.stringify(payload);
    if (typeof fetch === 'function') {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => { /* swallow — best effort */ });
    } else if (typeof navigator?.sendBeacon === 'function') {
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    }
  } catch {
    // never let the error reporter throw inside the boundary
  }
}
