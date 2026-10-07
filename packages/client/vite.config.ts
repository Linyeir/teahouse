import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const server = process.env.TEAHOUSE_DEV_SERVER ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [
    react(),
    // Caches the app shell, so a browser can open Teahouse while the server is unreachable
    // and show the local copy. Service workers need HTTPS or localhost; the apps do not.
    VitePWA({
      registerType: 'autoUpdate',
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        // The API is never served from the cache; offline data lives in IndexedDB.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': { target: server, ws: true },
    },
  },
});
