import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import ErrorBoundary from '@/lib/ErrorBoundary'

try {
  const saved = JSON.parse(localStorage.getItem('lykinsai_settings') || '{}');
  const fontScales = { small: '0.875', medium: '1', large: '1.125' };
  const densities  = { compact: '0.75', comfortable: '1', spacious: '1.25' };
  if (saved.fontSize)      document.documentElement.style.setProperty('--font-scale', fontScales[saved.fontSize] || '1');
  if (saved.layoutDensity) document.documentElement.style.setProperty('--layout-density', densities[saved.layoutDensity] || '1');

  // Dark mode is the default for the LYKN walkthrough (landing →
  // synthesis → vault → grid). Logic:
  //   1. Detect whether a Supabase auth session is present in
  //      localStorage. Supabase persists sessions under keys of
  //      the form `sb-<projectref>-auth-token`, so we just look
  //      for any localStorage key that matches that pattern with
  //      a non-empty value.
  //   2. If NO auth session is present, the visitor is in the
  //      walkthrough — force dark mode regardless of any stale
  //      saved theme. This is what fixes the case where an old
  //      session still has `theme: 'system'` saved from before
  //      the dark-default switch and the OS is light.
  //   3. If an auth session IS present, respect the user's saved
  //      theme preference (defaulting to 'dark' for new users).
  let hasAuthSession = false;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && /^sb-.*-auth-token$/.test(k) && localStorage.getItem(k)) {
        hasAuthSession = true;
        break;
      }
    }
  } catch {
    // localStorage access can throw in private mode; treat as no session.
  }

  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const savedTheme = saved.theme || 'dark';
  const effectiveTheme = hasAuthSession ? savedTheme : 'dark';
  const isDark = effectiveTheme === 'dark' || (effectiveTheme === 'system' && prefersDark);
  if (isDark) {
    document.documentElement.classList.add('dark');
    document.documentElement.style.setProperty('--app-background', '#1e1e1e');
  } else {
    document.documentElement.classList.remove('dark');
    document.documentElement.style.removeProperty('--app-background');
  }
} catch {}

try {
  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Root element not found!');
  }

  ReactDOM.createRoot(rootElement).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
} catch (error) {
  if (import.meta.env.DEV) console.error('Failed to render app:', error);
  document.body.innerHTML = `
    <div style="padding: 40px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; max-width: 480px; margin: 80px auto;">
      <h1 style="font-size: 1.5rem; font-weight: 600; color: #1a1a1a; margin-bottom: 12px;">Something went wrong</h1>
      <p style="font-size: 0.95rem; color: #666; margin-bottom: 24px;">We couldn't load the app. Please try refreshing the page.</p>
      <button onclick="window.location.reload()" style="padding: 10px 24px; font-size: 0.9rem; font-weight: 500; color: #fff; background: #111; border: none; border-radius: 8px; cursor: pointer;">
        Refresh Page
      </button>
    </div>
  `;
}

if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', () => {
    window.parent?.postMessage({ type: 'sandbox:beforeUpdate' }, '*');
  });
  import.meta.hot.on('vite:afterUpdate', () => {
    window.parent?.postMessage({ type: 'sandbox:afterUpdate' }, '*');
  });
}



