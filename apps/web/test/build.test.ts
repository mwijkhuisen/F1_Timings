import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

describe('web build', () => {
  const out = join(tmp, 'dist');
  const page = (p: string) => readFileSync(join(out, p), 'utf8');
  let chunks: Chunk[] = [];

  beforeAll(async () => {
    // Vitest sets NODE_ENV=test, which makes Vite bundle React's development build: build as the CLI does.
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const result = await build({ root: webDir, logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
      if (!('output' in result)) throw new Error('expected a single bundle output');
      chunks = result.output.filter((o): o is Chunk => o.type === 'chunk');
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);

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
    const files = readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    expect(files.some((e) => e.name.endsWith('.js'))).toBe(true);
    expect(files.some((e) => e.name.endsWith('.css'))).toBe(true);
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
});
