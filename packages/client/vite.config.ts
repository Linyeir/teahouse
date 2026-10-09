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
      // Registered in main.tsx, and only in browsers: the apps ship the shell themselves.
      injectRegister: null,
      // Lets browsers install Teahouse and gives the installed version its icons.
      manifest: {
        name: 'Teahouse',
        short_name: 'Teahouse',
        description: 'AI roleplay in the style of a visual novel',
        display: 'standalone',
        start_url: '/',
        theme_color: '#0F3A2E',
        background_color: '#F4ECD8',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
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
