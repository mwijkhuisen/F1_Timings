import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev and preview send /api to the local API. In production Caddy does (P1f);
// the real API refuses everything without an Access JWT, so local viewing
// needs an API with Access bypassed (never committed).
const api = { '/api': 'http://127.0.0.1:8080' };

export default defineConfig({
  plugins: [react()],
  server: { proxy: api },
  preview: { proxy: api },
  build: {
    // The CSP allows no inline script or style and no data: URL (A§12.2): keep everything in files.
    assetsInlineLimit: 0,
  },
});
