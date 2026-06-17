import React from 'react';
import {
  cacheBustReload,
  clearLyknChatLocalStorage,
  isLikelyStaleBundleError,
  reportClientError,
} from '@/lib/errorRecovery';

// How many times we'll silently self-heal a transient render crash before
// surfacing the full "Clear Cache & Retry" recovery UI. A hooks-count
// mismatch (#310) or a first-render data race on a heavy lazy route (the
// synthesis canvas pulls in three.js + r3f + the Bloom pipeline) typically
// heals in a single re-render, so a small budget keeps the recovery
// invisible without masking a genuinely broken page forever.
const MAX_SILENT_RECOVERIES = 2;
// How long the boundary has to stay error-free before we forgive past
// silent recoveries, so a fresh, unrelated transient error later in the
// session still gets its own quiet self-heal instead of flashing the UI.
const RECOVERY_DECAY_MS = 4000;

class RouteErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      retryCount: 0,
      // `recovering` gates the UI: while true we render a quiet, neutral
      // loader instead of the alarming recovery page, so a self-healing
      // transient crash never flashes "This page ran into an issue".
      recovering: false,
      recoveryAttempts: 0,
    };
    this.recoverTimer = null;
    this.decayTimer = null;
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[RouteErrorBoundary]', error, errorInfo);
    reportClientError(error, errorInfo, 'route');

    // A fresh crash invalidates any pending "forgive past recoveries" timer.
    if (this.decayTimer) { clearTimeout(this.decayTimer); this.decayTimer = null; }

    // Stale-bundle self-heal. Hard-reload with cache-bust ONCE per session
    // (sessionStorage guard) so we can't infinite-loop if the chunk really
    // is broken on origin. Flag `recovering` so the paint before the reload
    // shows the quiet loader rather than the scary error page.
    const STALE_BUNDLE_KEY = 'lykn_route_boundary_stale_reload_done';
    if (isLikelyStaleBundleError(error)) {
      let alreadyTried = false;
      try { alreadyTried = sessionStorage.getItem(STALE_BUNDLE_KEY) === '1'; } catch { /* private mode */ }
      if (!alreadyTried) {
        try { sessionStorage.setItem(STALE_BUNDLE_KEY, '1'); } catch { /* ignore */ }
        this.setState({ errorInfo, recovering: true });
        cacheBustReload();
        return;
      }
      // Reload already attempted and the chunk still won't load — surface
      // the real recovery UI so the user can clear cache / go home.
      this.setState({ errorInfo, recovering: false });
      return;
    }

    // Transient render crash (hooks #310, first-render data race, a GPU
    // hiccup in the lazy 3D scene, …). Give it a small budget of silent
    // re-renders before we ever show the recovery page.
    if (this.state.recoveryAttempts < MAX_SILENT_RECOVERIES) {
      const isHookError = error?.message?.includes('#310') || error?.message?.includes('more hooks');
      // A hooks-count mismatch is the one case where stale persisted draft
      // state can wedge the render, so wipe the omnia cache on that path.
      if (isHookError) clearLyknChatLocalStorage();
      this.setState((prev) => ({
        errorInfo,
        recovering: true,
        recoveryAttempts: prev.recoveryAttempts + 1,
      }));
      if (this.recoverTimer) clearTimeout(this.recoverTimer);
      this.recoverTimer = setTimeout(() => {
        this.recoverTimer = null;
        this.setState({ hasError: false, error: null, errorInfo: null, recovering: false });
      }, 60);
      return;
    }

    // Silent budget exhausted: the crash is persistent, so stop hiding it.
    this.setState({ errorInfo, recovering: false });
  }

  componentDidUpdate(prevProps) {
    if (this.state.hasError && prevProps.children !== this.props.children) {
      this.setState({ hasError: false, error: null, errorInfo: null, recovering: false });
    }
    // Once we've rendered children cleanly again, start a timer to forgive
    // the silent-recovery budget. If another crash lands first it clears
    // this timer (see componentDidCatch), so a persistent loop still
    // escalates to the full UI rather than self-healing forever.
    if (!this.state.hasError && this.state.recoveryAttempts > 0 && !this.decayTimer) {
      this.decayTimer = setTimeout(() => {
        this.decayTimer = null;
        this.setState({ recoveryAttempts: 0 });
      }, RECOVERY_DECAY_MS);
    }
  }

  componentWillUnmount() {
    if (this.recoverTimer) clearTimeout(this.recoverTimer);
    if (this.decayTimer) clearTimeout(this.decayTimer);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    // While silently self-healing, render a quiet, theme-neutral loader so
    // the transient crash never flashes the alarming recovery page.
    if (this.state.recovering) {
      return (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '60vh',
          padding: '40px 20px',
        }}>
          <div
            aria-label="Loading"
            role="status"
            style={{
              width: '28px',
              height: '28px',
              border: '3px solid rgba(127,127,127,0.25)',
              borderTopColor: 'rgba(127,127,127,0.75)',
              borderRadius: '50%',
              animation: 'lykn-route-boundary-spin 0.8s linear infinite',
            }}
          />
          <style>{'@keyframes lykn-route-boundary-spin{to{transform:rotate(360deg)}}'}</style>
        </div>
      );
    }

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
        recovering: false,
        recoveryAttempts: 0,
      }));
    };

    const handleClearAndRetry = () => {
      clearLyknChatLocalStorage();
      try { sessionStorage.removeItem('lykn_route_boundary_stale_reload_done'); } catch { /* ignore */ }
      cacheBustReload();
    };

    const handleGoHome = () => {
      clearLyknChatLocalStorage();
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
