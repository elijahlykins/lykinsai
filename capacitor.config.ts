import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ai.lykn.app',
  appName: 'LYKN',
  // webDir is only used as an offline fallback. The live app is loaded
  // from server.url below, so the deployed frontend + backend are used as-is.
  webDir: 'dist',
  server: {
    // Fastest personal-testing route: load the already-deployed web app
    // inside the native shell. Swap to http://<your-mac-LAN-ip>:5173 to
    // test against a local dev server instead.
    url: 'https://lykn.io',
    cleartext: false,
  },
  ios: {
    contentInset: 'always',
  },
};

export default config;
