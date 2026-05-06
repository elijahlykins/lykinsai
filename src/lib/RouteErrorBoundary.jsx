import React from 'react';
import { API_BASE_URL } from '@/lib/api-config';

const OMNIA_LS_PREFIXES = [
  'omnia_draft_',
  'omnia_chat_',
  'omnia_camera_',
  'omnia_vault_saved_',
  'omnia_board_id',
  'omnia_title',
];

function clearOmniaLocalStorage() {
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && OMNIA_LS_PREFIXES.some((p) => key.startsWith(p))) {
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
// `location.reload()` is honored by most browsers, but iOS Safari (and
// iOS Safari in PWA "Add to Home Screen" mode in particular) is known
// to ignore `cache-control: must-revalidate` on the HTML doc, serving
// the stale cached index.html which then references stale JS chunk
// hashes. A query-string change defeats that — Safari treats it as a
// distinct URL and revalidates against origin. Also clears any in-page
// `cache: 'force-cache'` Request entries before navigating.
function cacheBustReload() {
  try {
    if (typeof caches !== 'undefined' && caches?.keys) {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
    }
  } catch {
    // ignore — Cache API unavailable / blocked in private mode
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
function isLikelyStaleBundleError(error) {
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
function reportClientError(error, errorInfo) {
  try {
    if (typeof window === 'undefined') return;
    const lsKeysSnapshot = (() => {
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k.startsWith('lykn_') || k.startsWith('omnia_') || k.startsWith('lykinsai_'))) {
            keys.push(k);
          }
        }
        return keys;
      } catch {
        return [];
      }
    })();
    const payload = {
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

class RouteErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, retryCount: 0, autoRecoveryAttempted: false };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[RouteErrorBoundary]', error, errorInfo);
    reportClientError(error, errorInfo);
    this.setState({ errorInfo });

    // Stale-bundle self-heal. The most common reason "everyone hits a
    // generic error after a deploy" is iOS Safari serving a cached
    // index.html that points at JS chunks the new build doesn't have.
    // We hard-reload with a cache-bust query param ONCE per session
    // (sessionStorage guard) so we can't infinite-loop if the chunk
    // really is broken on origin.
    const STALE_BUNDLE_KEY = 'lykn_route_boundary_stale_reload_done';
    if (isLikelyStaleBundleError(error)) {
      let alreadyTried = false;
      try { alreadyTried = sessionStorage.getItem(STALE_BUNDLE_KEY) === '1'; } catch { /* private mode */ }
      if (!alreadyTried) {
        try { sessionStorage.setItem(STALE_BUNDLE_KEY, '1'); } catch { /* ignore */ }
        cacheBustReload();
        return;
      }
    }

    const isHookError = error?.message?.includes('#310') || error?.message?.includes('more hooks');
    if (!this.state.autoRecoveryAttempted && isHookError) {
      this.setState({ autoRecoveryAttempted: true });
      clearOmniaLocalStorage();
      setTimeout(() => {
        this.setState({ hasError: false, error: null, errorInfo: null, retryCount: 0 });
      }, 50);
    }
  }

  componentDidUpdate(prevProps) {
    if (this.state.hasError && prevProps.children !== this.props.children) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    // First retry is a soft re-render (in case the throw was an isolated
    // transient — e.g. a flaky network call inside render). Every retry
    // after that escalates to a hard cache-busting reload, since a
    // deterministic render-time crash will never resolve by re-rendering
    // the same code against the same state.
    const handleRetry = () => {
      if (this.state.retryCount >= 1) {
        cacheBustReload();
        return;
      }
      this.setState((prev) => ({
        hasError: false,
        error: null,
        errorInfo: null,
        retryCount: prev.retryCount + 1,
      }));
    };

    // "Clear Cache & Retry" used to only wipe a handful of localStorage
    // keys, which never helped when the actual problem was a stale HTML
    // pointing at stale JS chunks. Now it wipes app localStorage AND
    // forces a fresh HTML fetch via a cache-bust query param — the only
    // recovery path that reliably works on iOS Safari standalone PWAs.
    const handleClearAndRetry = () => {
      clearOmniaLocalStorage();
      try { sessionStorage.removeItem('lykn_route_boundary_stale_reload_done'); } catch { /* ignore */ }
      cacheBustReload();
    };

    const handleGoHome = () => {
      clearOmniaLocalStorage();
      try {
        const u = new URL(window.location.origin + '/');
        u.searchParams.set('_r', String(Date.now()));
        window.location.replace(u.toString());
      } catch {
        window.location.href = '/';
      }
    };

    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '60vh',
        padding: '40px 20px',
        fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        textAlign: 'center',
      }}>
        <div style={{
          width: '48px',
          height: '48px',
          borderRadius: '50%',
          background: '#fef2f2',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '20px',
          fontSize: '1.5rem',
        }}>
          !
        </div>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#1a1a1a', marginBottom: '8px' }}>
          This page ran into an issue
        </h2>
        <p style={{ fontSize: '0.9rem', color: '#666', marginBottom: '24px', maxWidth: '400px' }}>
          {this.state.retryCount > 0
            ? "Still having trouble. Try clearing cached data or heading back to the dashboard."
            : "Don't worry — your data is safe. Let's try loading this again."}
        </p>
        {this.state.error && (
          <details style={{
            textAlign: 'left',
            marginBottom: '20px',
            padding: '12px',
            background: '#fef2f2',
            border: '1px solid #fca5a5',
            borderRadius: '8px',
            maxWidth: '500px',
            width: '100%',
          }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, color: '#b91c1c', fontSize: '0.8rem' }}>
              Error details (tap to expand)
            </summary>
            <pre style={{ fontSize: '0.75rem', color: '#991b1b', whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: '8px' }}>
              {String(this.state.error?.message || this.state.error)}
            </pre>
            {this.state.error?.stack && (
              <pre style={{ fontSize: '0.7rem', color: '#6b7280', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '200px', overflow: 'auto', marginTop: '4px' }}>
                {this.state.error.stack}
              </pre>
            )}
            {this.state.errorInfo?.componentStack && (
              <pre style={{ fontSize: '0.7rem', color: '#6b7280', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '200px', overflow: 'auto', marginTop: '4px' }}>
                {this.state.errorInfo.componentStack}
              </pre>
            )}
          </details>
        )}
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            onClick={handleRetry}
            style={{
              padding: '10px 20px',
              fontSize: '0.9rem',
              fontWeight: 500,
              color: '#fff',
              backgroundColor: '#111',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
            }}
          >
            Try Again
          </button>
          <button
            onClick={handleClearAndRetry}
            style={{
              padding: '10px 20px',
              fontSize: '0.9rem',
              fontWeight: 500,
              color: '#111',
              backgroundColor: '#f3f4f6',
              border: '1px solid #d1d5db',
              borderRadius: '8px',
              cursor: 'pointer',
            }}
          >
            Clear Cache &amp; Retry
          </button>
          <button
            onClick={handleGoHome}
            style={{
              padding: '10px 20px',
              fontSize: '0.9rem',
              fontWeight: 500,
              color: '#6b7280',
              backgroundColor: 'transparent',
              border: '1px solid #e5e7eb',
              borderRadius: '8px',
              cursor: 'pointer',
            }}
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }
}

export default RouteErrorBoundary;
