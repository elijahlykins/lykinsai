import React from 'react';

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

class RouteErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, retryCount: 0, autoRecoveryAttempted: false };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    if (import.meta.env.DEV) console.error('[RouteErrorBoundary]', error, errorInfo);

    const isHookError = error?.message?.includes('#310') || error?.message?.includes('more hooks');
    if (!this.state.autoRecoveryAttempted && isHookError) {
      this.setState({ autoRecoveryAttempted: true });
      clearOmniaLocalStorage();
      setTimeout(() => {
        this.setState({ hasError: false, error: null, retryCount: 0 });
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

    const isDev = !!import.meta.env?.DEV;

    const handleRetry = () => {
      this.setState((prev) => ({
        hasError: false,
        error: null,
        retryCount: prev.retryCount + 1,
      }));
    };

    const handleClearAndRetry = () => {
      clearOmniaLocalStorage();
      this.setState({ hasError: false, error: null, retryCount: 0 });
    };

    const handleGoHome = () => {
      clearOmniaLocalStorage();
      window.location.href = '/';
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
        {isDev && this.state.error && (
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
              Error Details (dev only)
            </summary>
            <pre style={{ fontSize: '0.75rem', color: '#991b1b', whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: '8px' }}>
              {String(this.state.error)}
            </pre>
            {this.state.error?.stack && (
              <pre style={{ fontSize: '0.7rem', color: '#6b7280', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '200px', overflow: 'auto', marginTop: '4px' }}>
                {this.state.error.stack}
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
