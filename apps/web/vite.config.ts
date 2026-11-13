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
 * file, F1_REVISION included, so each release drops the offline data, whose keys carry the old `?v=` (A§13); the
 * shell is `/` and every .js and .css file.
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
    const files = names.filter((n) => n !== 'sw.js' && /\.(js|css)$/.test(n)).map((n) => `/${n}`);
    // The list goes into a string literal, comma-joined: nothing but plain path characters.
    for (const f of files) if (!/^\/[\w./-]+$/.test(f)) throw new Error(`shell file ${f}`);
    const shell = ['/', ...files];
    const build = hash.digest('hex').slice(0, 12);
    // Replacer functions, so a `$&` or the like in a value is never interpreted.
    sw.code = sw.code.replaceAll('__F1_BUILD__', () => build).replaceAll('__F1_SHELL__', () => shell.join(','));
    this.emitFile({ type: 'asset', fileName: 'icon-512.png', source: iconPng() });
  },
});

// The release's git commit or `dev` (A§10), the `?v=` cache key. Same format as REVISION in packages/contracts (the
// config must not import zod).
const revision = process.env.F1_REVISION ?? 'dev';
if (!/^(?:[0-9a-f]{40}|dev)$/.test(revision)) throw new Error('F1_REVISION is malformed');

export default defineConfig({
  plugins: [react(), worker()],
  define: { 'import.meta.env.F1_REVISION': JSON.stringify(revision) },
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
