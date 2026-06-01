import React from 'react';
import {
  cacheBustReload,
  clearOmniaLocalStorage,
  isLikelyStaleBundleError,
  reportClientError,
} from '@/lib/errorRecovery';

// Top-level boundary mounted at the root in `main.jsx`. Catches anything
// that throws OUTSIDE the routed Routes tree — providers (SupabaseAuth,
// Intake, QueryClient), the AppShell layout chrome (MobileTabBar,
// MobileExperienceNotice, AppSidebar, IntakeModal, GuestSignInPrompt,
// VaultUploadToast), and React Router itself. RouteErrorBoundary only
// catches throws that happen INSIDE Routes, so a crash in any of the
// always-on chrome bypasses it and lands here.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      retryCount: 0,
      autoRecoveryAttempted: false,
    };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary]', error, errorInfo);
    reportClientError(error, errorInfo, 'root');
    this.setState({ errorInfo });

    // Stale-bundle self-heal — same logic as RouteErrorBoundary, but
    // gated on its own sessionStorage key so the two boundaries don't
    // step on each other.
    const STALE_BUNDLE_KEY = 'lykn_root_boundary_stale_reload_done';
    if (isLikelyStaleBundleError(error)) {
      let alreadyTried = false;
      try { alreadyTried = sessionStorage.getItem(STALE_BUNDLE_KEY) === '1'; } catch { /* private mode */ }
      if (!alreadyTried) {
        try { sessionStorage.setItem(STALE_BUNDLE_KEY, '1'); } catch { /* ignore */ }
        cacheBustReload();
        return;
      }
    }

    if (!this.state.autoRecoveryAttempted) {
      this.setState({ autoRecoveryAttempted: true });
      const cleared = clearOmniaLocalStorage();
      if (import.meta.env.DEV) console.warn(`[ErrorBoundary] Cleared ${cleared} cached keys — attempting auto-recovery`);
      setTimeout(() => {
        this.setState({ hasError: false, error: null, errorInfo: null });
      }, 100);
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
        autoRecoveryAttempted: false,
      }));
    };

    const handleClearAndRetry = () => {
      clearOmniaLocalStorage();
      try { sessionStorage.removeItem('lykn_root_boundary_stale_reload_done'); } catch { /* ignore */ }
      cacheBustReload();
    };

    const handleHardRefresh = () => {
      clearOmniaLocalStorage();
      cacheBustReload();
    };

    return (
      <div style={{ padding: '40px', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', textAlign: 'center', maxWidth: '640px', margin: '80px auto' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 600, color: '#1a1a1a', marginBottom: '12px' }}>Something went wrong</h1>
        <p style={{ fontSize: '0.95rem', color: '#666', marginBottom: '24px' }}>
          We hit an unexpected issue. You can try recovering below — your data is safe in the cloud.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center' }}>
          <button
            onClick={handleRetry}
            style={{ padding: '10px 24px', fontSize: '0.9rem', fontWeight: 500, color: '#fff', backgroundColor: '#111', border: 'none', borderRadius: '8px', cursor: 'pointer', width: '220px' }}
          >
            Try Again
          </button>
          <button
            onClick={handleClearAndRetry}
            style={{ padding: '10px 24px', fontSize: '0.9rem', fontWeight: 500, color: '#111', backgroundColor: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: '8px', cursor: 'pointer', width: '220px' }}
          >
            Clear Cache &amp; Retry
          </button>
          <button
            onClick={handleHardRefresh}
            style={{ padding: '8px 20px', fontSize: '0.8rem', fontWeight: 400, color: '#6b7280', backgroundColor: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
          >
            Full page refresh
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
