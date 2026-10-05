import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const server = process.env.TEAHOUSE_DEV_SERVER ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: server, ws: true },
    },
  },
});
