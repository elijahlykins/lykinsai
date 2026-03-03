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
  if (saved.theme === 'dark') document.documentElement.classList.add('dark');
} catch {}

console.log('🚀 App is starting...');

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
  
  console.log('✅ App rendered successfully');
} catch (error) {
  console.error('❌ Failed to render app:', error);
  document.body.innerHTML = `
    <div style="padding: 20px; font-family: monospace;">
      <h1 style="color: red;">Failed to load app</h1>
      <pre>${error.toString()}</pre>
      <pre>${error.stack}</pre>
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



