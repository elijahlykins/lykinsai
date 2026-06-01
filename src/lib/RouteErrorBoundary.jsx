import React from 'react';
import {
  cacheBustReload,
  clearOmniaLocalStorage,
  isLikelyStaleBundleError,
  reportClientError,
} from '@/lib/errorRecovery';

class RouteErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null, retryCount: 0, autoRecoveryAttempted: false };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[RouteErrorBoundary]', error, errorInfo);
    reportClientError(error, errorInfo, 'route');
    this.setState({ errorInfo });

    // Stale-bundle self-heal. Hard-reload with cache-bust ONCE per session
    // (sessionStorage guard) so we can't infinite-loop if the chunk really
    // is broken on origin.
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
      this.setState({ hasError: false, error: null, errorInfo: null });
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;

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
