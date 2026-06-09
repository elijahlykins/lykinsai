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
// Mirror of RouteErrorBoundary's silent-recovery budget: how many times the
// root boundary will quietly self-heal a transient crash before surfacing
// the full recovery UI, and how long it must stay error-free before that
// budget is forgiven for a later, unrelated transient error.
const MAX_SILENT_RECOVERIES = 2;
const RECOVERY_DECAY_MS = 4000;

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      retryCount: 0,
      // While true, render a quiet loader instead of the recovery page so a
      // self-healing transient crash never flashes "Something went wrong".
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
    console.error('[ErrorBoundary]', error, errorInfo);
    reportClientError(error, errorInfo, 'root');

    if (this.decayTimer) { clearTimeout(this.decayTimer); this.decayTimer = null; }

    // Stale-bundle self-heal — same logic as RouteErrorBoundary, but
    // gated on its own sessionStorage key so the two boundaries don't
    // step on each other.
    const STALE_BUNDLE_KEY = 'lykn_root_boundary_stale_reload_done';
    if (isLikelyStaleBundleError(error)) {
      let alreadyTried = false;
      try { alreadyTried = sessionStorage.getItem(STALE_BUNDLE_KEY) === '1'; } catch { /* private mode */ }
      if (!alreadyTried) {
        try { sessionStorage.setItem(STALE_BUNDLE_KEY, '1'); } catch { /* ignore */ }
        this.setState({ errorInfo, recovering: true });
        cacheBustReload();
        return;
      }
      this.setState({ errorInfo, recovering: false });
      return;
    }

    if (this.state.recoveryAttempts < MAX_SILENT_RECOVERIES) {
      const cleared = clearOmniaLocalStorage();
      if (import.meta.env.DEV) console.warn(`[ErrorBoundary] Cleared ${cleared} cached keys — attempting silent recovery`);
      this.setState((prev) => ({
        errorInfo,
        recovering: true,
        recoveryAttempts: prev.recoveryAttempts + 1,
      }));
      if (this.recoverTimer) clearTimeout(this.recoverTimer);
      this.recoverTimer = setTimeout(() => {
        this.recoverTimer = null;
        this.setState({ hasError: false, error: null, errorInfo: null, recovering: false });
      }, 100);
      return;
    }

    // Silent budget exhausted — the crash is persistent, surface the UI.
    this.setState({ errorInfo, recovering: false });
  }

  componentDidUpdate() {
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

    // Quiet, theme-neutral loader while silently self-healing.
    if (this.state.recovering) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', padding: '40px 20px' }}>
          <div
            aria-label="Loading"
            role="status"
            style={{
              width: '28px',
              height: '28px',
              border: '3px solid rgba(127,127,127,0.25)',
              borderTopColor: 'rgba(127,127,127,0.75)',
              borderRadius: '50%',
              animation: 'lykn-root-boundary-spin 0.8s linear infinite',
            }}
          />
          <style>{'@keyframes lykn-root-boundary-spin{to{transform:rotate(360deg)}}'}</style>
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
