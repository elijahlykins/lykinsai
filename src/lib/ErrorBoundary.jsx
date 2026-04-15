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

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      autoRecoveryAttempted: false,
    };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    this.setState({ error, errorInfo });

    if (!this.state.autoRecoveryAttempted) {
      this.setState({ autoRecoveryAttempted: true });
      const cleared = clearOmniaLocalStorage();
      console.warn(`[ErrorBoundary] Cleared ${cleared} cached keys — attempting auto-recovery…`);
      setTimeout(() => {
        this.setState({ hasError: false, error: null, errorInfo: null });
      }, 100);
    }
  }

  render() {
    if (this.state.hasError) {
      const isDev = import.meta.env?.DEV || window.location.hostname === 'localhost';

      const handleRetry = () => {
        this.setState({ hasError: false, error: null, errorInfo: null });
      };

      const handleClearAndRetry = () => {
        clearOmniaLocalStorage();
        this.setState({
          hasError: false,
          error: null,
          errorInfo: null,
          autoRecoveryAttempted: false,
        });
      };

      const handleHardRefresh = () => {
        clearOmniaLocalStorage();
        window.location.reload();
      };

      return (
        <div style={{ padding: '40px', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', textAlign: 'center', maxWidth: '640px', margin: '80px auto' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, color: '#1a1a1a', marginBottom: '12px' }}>Something went wrong</h1>
          <p style={{ fontSize: '0.95rem', color: '#666', marginBottom: '24px' }}>
            We hit an unexpected issue. You can try recovering below — your data is safe in the cloud.
          </p>
          {isDev && this.state.error && (
            <details style={{ textAlign: 'left', marginBottom: '24px', padding: '16px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '8px' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, color: '#b91c1c', marginBottom: '8px' }}>Error Details (dev only)</summary>
              <pre style={{ fontSize: '0.8rem', color: '#991b1b', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '8px 0' }}>
                {String(this.state.error)}
              </pre>
              {this.state.error?.stack && (
                <pre style={{ fontSize: '0.75rem', color: '#6b7280', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '300px', overflow: 'auto' }}>
                  {this.state.error.stack}
                </pre>
              )}
              {this.state.errorInfo?.componentStack && (
                <pre style={{ fontSize: '0.75rem', color: '#6b7280', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '200px', overflow: 'auto', marginTop: '8px' }}>
                  {this.state.errorInfo.componentStack}
                </pre>
              )}
            </details>
          )}
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

    return this.props.children;
  }
}

export default ErrorBoundary;
