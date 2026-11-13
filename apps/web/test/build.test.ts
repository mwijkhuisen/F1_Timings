import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeCaches, ORIGIN } from './caches.ts';

type Chunk = Rolldown.OutputChunk;

// The CSP allows no inline script or style, no data: or blob: URL and no eval (A§12.2).
// This builds the real app and scans what would be served.

const webDir = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'f1-web-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// A data: URL has a media type (`data:image/png`) or sits in url(); a minified object key such as `{data:e}` is neither.
const DATA_URL = /\bdata:[\w.+-]+\/[\w.+-]+/;
const CSS_DATA_URL = /url\(\s*['"]?data:/i;
// A blob: URL is a string, or a url() argument, that starts with the scheme.
const BLOB_URL = /['"`(]blob:/;

describe('the scan patterns', () => {
  it.each([
    ['a data: image URL', DATA_URL, 'img.src="data:image/png;base64,AAAA"'],
    ['a data: URL in CSS', CSS_DATA_URL, 'a{background:url( "data:image/svg+xml,%3Csvg")}'],
    ['a blob: URL in a string', BLOB_URL, 'new Worker("blob:https://x/1")'],
    ['a blob: URL in CSS', BLOB_URL, 'a{background:url(blob:https://x/1)}'],
  ])('match %s', (_name, re, text) => {
    expect(text).toMatch(re);
  });

  it.each([
    ['a minified object key', DATA_URL, 'return{data:e,error:t}'],
    ['a data: argument that is no URL', CSS_DATA_URL, 'f(data:1)'],
    ['a blob: object key', BLOB_URL, 'return{blob:e}'],
  ])('do not match %s', (_name, re, text) => {
    expect(text).not.toMatch(re);
  });
});

describe('the ECharts importer', () => {
  // No build needed: the source files, by what they import.
  const src = fileURLToPath(new URL('../src', import.meta.url));
  const files = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) =>
      join(e.parentPath, e.name)
        .slice(src.length + 1)
        .replaceAll('\\', '/'),
    );
  const importing = (target: RegExp) =>
    files.filter((f) =>
      [...readFileSync(join(src, f), 'utf8').matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)].some(([, m = '']) =>
        target.test(m),
      ),
    );

  it('is views/Chart.tsx alone, which only the chart views (Compare and Weather) use', () => {
    expect(files).toContain('lib/echarts.ts');
    expect(importing(/(^|\/)echarts\.ts$/)).toEqual(['views/Chart.tsx']);
    expect(importing(/(^|\/)Chart\.tsx$/).sort()).toEqual(['views/Compare.tsx', 'views/Weather.tsx']);
  });
});

describe('the CSP', () => {
  // Pinned whole: #121 added worker-src 'self' and nothing else.
  it('is exactly this in deploy/web/Caddyfile', () => {
    const caddyfile = readFileSync(join(webDir, '../../deploy/web/Caddyfile'), 'utf8');
    expect([...caddyfile.matchAll(/Content-Security-Policy "([^"]*)"/g)].map(([, csp]) => csp)).toEqual([
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    ]);
  });
});

const SHA = 'c'.repeat(40);

describe('web build', () => {
  const out = join(tmp, 'dist');
  const page = (p: string) => readFileSync(join(out, p), 'utf8');
  /** The app's chunks; the service worker's is `sw`. */
  let chunks: Chunk[] = [];
  let sw: Chunk | undefined;

  beforeAll(async () => {
    // Vitest sets NODE_ENV=test, which makes Vite bundle React's development build: build as the CLI does.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('F1_REVISION', SHA);
    try {
      const result = await build({ root: webDir, logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
      if (!('output' in result)) throw new Error('expected a single bundle output');
      const all = result.output.filter((o): o is Chunk => o.type === 'chunk');
      sw = all.find((c) => c.fileName === 'sw.js');
      chunks = all.filter((c) => c !== sw);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);

  it('embeds F1_REVISION in an output chunk, and a malformed one fails the build', async () => {
    expect(chunks.some((c) => c.code.includes(SHA))).toBe(true);
    vi.stubEnv('F1_REVISION', 'bad');
    try {
      await expect(
        build({ root: webDir, logLevel: 'silent', build: { outDir: join(tmp, 'bad'), write: false } }),
      ).rejects.toThrow('F1_REVISION is malformed');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('index.html has no inline script, style or handler', () => {
    const html = page('index.html');
    // Every <script> (any case) is an external file with an empty body.
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    expect(html.match(/<script\b/gi)).toHaveLength(scripts.length);
    for (const [, attrs = '', body = ''] of scripts) {
      expect(attrs).toMatch(/\ssrc="\/assets\/[^"]+\.js"/);
      expect(body.trim()).toBe('');
    }
    expect(html).not.toMatch(/<style\b|\sstyle=|\son[a-z]+=/i);
  });

  it('index.html makes no third-party request (invariant 6)', () => {
    // Every src/href is a same-origin path; no scheme, no protocol-relative URL.
    const refs = [...page('index.html').matchAll(/\s(?:src|href)="([^"]*)"/g)].map(([, v]) => v);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).toMatch(/^\/(?!\/)/);
  });

  it('no output file has a data: or blob: URL or createObjectURL', () => {
    // Text files only: the icon's bytes could match by chance.
    const files = readdirSync(out, { recursive: true, withFileTypes: true }).filter(
      (e) => e.isFile() && !e.name.endsWith('.png'),
    );
    expect(files.some((e) => e.name.endsWith('.js'))).toBe(true);
    expect(files.some((e) => e.name.endsWith('.css'))).toBe(true);
    expect(files.map((e) => e.name)).toEqual(expect.arrayContaining(['sw.js', 'manifest.webmanifest']));
    for (const e of files) {
      const path = join(e.parentPath, e.name);
      const text = readFileSync(path, 'utf8');
      expect(text, path).not.toMatch(DATA_URL);
      expect(text, path).not.toMatch(CSS_DATA_URL);
      expect(text, path).not.toMatch(BLOB_URL);
      expect(text, path).not.toContain('createObjectURL');
    }
  });

  it('ECharts stays out of the initial bundle: only the lazy chunk from lib/echarts.ts holds it', () => {
    // Rolldown chunks carry isEntry, isDynamicEntry, facadeModuleId, moduleIds, and imports (static) and
    // dynamicImports by file name. pnpm resolves modules to .../.pnpm/echarts@x/node_modules/echarts/....
    const LIB = /[\\/]node_modules[\\/](?:echarts|zrender)[\\/]/;
    const holdsLib = (c: Chunk) => c.moduleIds.some((id) => LIB.test(id));
    const byName = new Map(chunks.map((c) => [c.fileName, c]));
    const entries = chunks.filter((c) => c.isEntry);
    expect(entries).toHaveLength(1);
    // The initial bundle: the entry chunk and every chunk it imports statically, transitively.
    const initial = new Set<string>();
    const walk = (c: Chunk) => {
      if (initial.has(c.fileName)) return;
      initial.add(c.fileName);
      for (const f of c.imports) {
        const next = byName.get(f);
        if (next) walk(next);
      }
    };
    for (const c of entries) walk(c);
    expect(initial.size).toBeGreaterThan(0);
    for (const f of initial) expect(holdsLib(byName.get(f) as Chunk), f).toBe(false);

    const lazy = chunks.filter(holdsLib);
    expect(lazy).toHaveLength(1);
    expect(lazy[0]?.isDynamicEntry).toBe(true);
    expect(lazy[0]?.facadeModuleId).toMatch(/src[\\/]lib[\\/]echarts\.ts$/);
    expect(entries.some((c) => c.dynamicImports.includes(lazy[0]?.fileName ?? ''))).toBe(true);
  });

  // P5c: the map files (lib/api.ts globs them) load only with the rain map, one circuit at a time.
  it('keeps every map file out of the initial bundle, each in a lazy chunk of its own', () => {
    const MAP = /[\\/]src[\\/]map[\\/](?:osm[\\/])?[\w-]+\.json$/;
    const byName = new Map(chunks.map((c) => [c.fileName, c]));
    const initial = new Set<string>();
    const walk = (c: Chunk) => {
      if (initial.has(c.fileName)) return;
      initial.add(c.fileName);
      for (const f of c.imports) {
        const next = byName.get(f);
        if (next) walk(next);
      }
    };
    for (const c of chunks.filter((x) => x.isEntry)) walk(c);
    const mapChunks = chunks.filter((c) => c.moduleIds.some((id) => MAP.test(id)));
    const ids = mapChunks.flatMap((c) => c.moduleIds.filter((id) => MAP.test(id)));
    expect(ids.length).toBe(
      readdirSync(join(webDir, 'src/map')).filter((f) => f.endsWith('.json')).length + osmCount(),
    );
    // Rolldown's grouping: one chunk per JSON module, holding that module alone, each a dynamic entry that another
    // chunk imports dynamically.
    const dynamic = new Set(chunks.flatMap((c) => c.dynamicImports));
    for (const c of mapChunks) {
      expect(initial.has(c.fileName), c.fileName).toBe(false);
      expect(c.moduleIds, c.fileName).toHaveLength(1);
      expect(c.isDynamicEntry, c.fileName).toBe(true);
      expect(dynamic.has(c.fileName), c.fileName).toBe(true);
    }
    expect(mapChunks).toHaveLength(ids.length);
  });

  // #121: the service worker, a classic script at the root; vite.config.ts fills in its two placeholders.
  /** `/` and every emitted .js and .css file but sw.js. */
  const shell = () => [
    '/',
    ...readdirSync(out, { recursive: true, encoding: 'utf8' })
      .map((f) => f.replaceAll('\\', '/'))
      .filter((f) => f !== 'sw.js' && /\.(js|css)$/.test(f))
      .map((f) => `/${f}`)
      .sort(),
  ];

  it('sw.js is one chunk at the root that imports and exports nothing, its placeholders filled in', () => {
    expect(sw).toMatchObject({ isEntry: true, imports: [], dynamicImports: [], exports: [] });
    const code = page('sw.js');
    // No import or export statement (nor import()), which a classic worker script cannot run.
    expect(code).not.toMatch(/\b(import|export)\b/);
    expect(code).not.toContain('__F1_');
  });

  it("the app's entry registers /sw.js", () => {
    const entry = chunks.filter((c) => c.isEntry);
    expect(entry).toHaveLength(1);
    expect(entry[0]?.code).toMatch(/register\(.\/sw\.js./);
  });

  it('sw.js runs as a classic script: install keeps the shell, and a final session is answered', async () => {
    const caches = new FakeCaches();
    const fetch = vi.fn(async (input: Request | string) => {
      const path = typeof input === 'string' ? input : new URL(input.url).pathname;
      const type =
        path === '/'
          ? 'text/html'
          : path.endsWith('.css')
            ? 'text/css'
            : path.endsWith('.js')
              ? 'text/javascript'
              : 'application/json';
      return new Response('x', { headers: { 'content-type': type, 'cache-control': 'private, max-age=86400' } });
    });
    const on = new Map<string, (e: object) => void>();
    const self = {
      addEventListener: (type: string, f: (e: object) => void) => on.set(type, f),
      skipWaiting: vi.fn(async () => undefined),
      clients: { claim: vi.fn(async () => undefined) },
    };
    // A script, not a module: an import or export statement would be a SyntaxError here.
    runInNewContext(page('sw.js'), {
      self,
      caches: caches.storage,
      fetch,
      location: new URL(`${ORIGIN}/sw.js`),
      URL,
      Request,
      Response,
      Headers,
    });
    expect([...on.keys()].sort()).toEqual(['activate', 'fetch', 'install']);

    const waited: Promise<unknown>[] = [];
    const waitUntil = (p: Promise<unknown>) => waited.push(p);
    on.get('install')?.({ waitUntil });
    await Promise.all(waited);
    const names = await caches.keys();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^f1-[0-9a-f]{12}$/);
    const cache = await caches.open(names[0] ?? '');
    expect([...cache.entries.keys()].sort()).toEqual(
      shell()
        .map((p) => `${ORIGIN}${p}`)
        .sort(),
    );
    expect(self.skipWaiting).toHaveBeenCalledOnce();
    on.get('activate')?.({ waitUntil });
    await Promise.all(waited);
    expect(self.clients.claim).toHaveBeenCalledOnce();

    const respondWith = vi.fn();
    const url = `${ORIGIN}/api/v1/sessions/9158/laps?v=1`;
    on.get('fetch')?.({ request: { url, method: 'GET', mode: 'cors' }, respondWith });
    expect(respondWith).toHaveBeenCalledOnce();
    expect(await (await respondWith.mock.calls[0]?.[0])?.text()).toBe('x');
    expect(cache.entries.has(url)).toBe(true);
    // And a request it leaves to the browser.
    on.get('fetch')?.({ request: { url: `${ORIGIN}/api/v1/live`, method: 'GET', mode: 'cors' }, respondWith });
    expect(respondWith).toHaveBeenCalledOnce();
  });

  it('the manifest is valid JSON in the theme colour, with a 512×512 PNG icon', () => {
    const manifest = JSON.parse(page('manifest.webmanifest'));
    const bg = /--bg:\s*(#[0-9a-f]{6});/.exec(readFileSync(join(webDir, 'src/styles.css'), 'utf8'))?.[1];
    expect(bg).toBe('#15151e');
    expect(manifest).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone' });
    expect(manifest.background_color).toBe(bg);
    expect(manifest.theme_color).toBe(bg);
    expect(manifest.icons).toEqual([
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ]);
    const png = readFileSync(join(out, 'icon-512.png'));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.toString('latin1', 12, 16)).toBe('IHDR');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([512, 512]);
  });

  it('index.html links the manifest and the icon', () => {
    const html = page('index.html');
    // With credentials: a manifest is fetched in CORS mode without them, and Access would redirect it.
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/icon-512.png" />');
  });

  it('serves the third-party licences file (ADR-0008, ADR-0009)', () => {
    const text = page('third-party-licences.txt');
    expect(text).toContain('Copyright (c) 2019-2025 Tomislav Bacinger');
    expect(text).toContain('Open Database License (ODbL) 1.0');
    expect(text).toContain('Weather data by Open-Meteo.com');
    expect(text).toContain('Data: Jolpica-F1 (Ergast), CC BY-NC-SA 4.0');
  });
});

/** The OSM layer files, which may not exist yet (P5c, E8). */
function osmCount(): number {
  try {
    return readdirSync(join(webDir, 'src/map/osm')).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}
