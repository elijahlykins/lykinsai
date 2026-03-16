import React from 'react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    this.setState({
      error,
      errorInfo
    });
  }

  render() {
    if (this.state.hasError) {
      const isDev = import.meta.env?.DEV || window.location.hostname === 'localhost';
      return (
        <div style={{ padding: '40px', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', textAlign: 'center', maxWidth: '640px', margin: '80px auto' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, color: '#1a1a1a', marginBottom: '12px' }}>Something went wrong</h1>
          <p style={{ fontSize: '0.95rem', color: '#666', marginBottom: '24px' }}>
            We hit an unexpected issue. Please refresh the page to try again.
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
          <button
            onClick={() => window.location.reload()}
            style={{ padding: '10px 24px', fontSize: '0.9rem', fontWeight: 500, color: '#fff', backgroundColor: '#111', border: 'none', borderRadius: '8px', cursor: 'pointer' }}
          >
            Refresh Page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
