import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { iconPng } from './icon.ts';

// Dev and preview send /api to the local API. In production Caddy does (P1f);
// the real API refuses everything without an Access JWT, so local viewing
// needs an API with Access bypassed (never committed).
const api = { '/api': 'http://127.0.0.1:8080' };

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The service worker's placeholders (src/sw/main.ts) and the app icon (#121). The build id hashes every emitted
 * file, so a deploy that changes no web file keeps the offline data; the shell is `/` and every .js and .css file.
 */
const worker = (): Plugin => ({
  name: 'f1-sw',
  apply: 'build',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const sw = bundle['sw.js'];
    if (sw?.type !== 'chunk') throw new Error('sw.js is missing from the bundle');
    const names = Object.keys(bundle).sort();
    const hash = createHash('sha256');
    for (const name of names) {
      const file = bundle[name];
      if (file) hash.update(`${name}\0`).update(file.type === 'chunk' ? file.code : file.source);
    }
    const shell = ['/', ...names.filter((n) => n !== 'sw.js' && /\.(js|css)$/.test(n)).map((n) => `/${n}`)];
    sw.code = sw.code
      .replaceAll('__F1_BUILD__', hash.digest('hex').slice(0, 12))
      .replaceAll('__F1_SHELL__', shell.join(','));
    this.emitFile({ type: 'asset', fileName: 'icon-512.png', source: iconPng() });
  },
});

export default defineConfig({
  plugins: [react(), worker()],
  server: { proxy: api },
  preview: { proxy: api },
  build: {
    // The CSP allows no inline script or style and no data: URL (A§12.2): keep everything in files.
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: { index: here('index.html'), sw: here('src/sw/main.ts') },
      // The worker's scope is its directory: /sw.js covers the whole site.
      output: { entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js') },
    },
  },
});
