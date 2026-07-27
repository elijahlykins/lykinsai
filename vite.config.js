import base44 from "@base44/vite-plugin"
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  server: {
    // Bind IPv4 explicitly. Default Vite-on-mac can listen only on ::1, and
    // Electron's load of http://localhost:5173 often hits 127.0.0.1 first →
    // ERR_CONNECTION_REFUSED / black window. strictPort keeps LYKN_APP_URL
    // honest so a leftover process can't silently shove us onto 5174.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  plugins: [
    base44({
      // Support for legacy code that imports the base44 SDK with @/integrations, @/entities, etc.
      // can be removed if the code has been updated to use the new SDK imports from @base44/sdk
      legacySDKImports: process.env.BASE44_LEGACY_SDK_IMPORTS === 'true'
    }),
    react(),
  ]
});