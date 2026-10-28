import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Zod 4 probes `new Function` when a schema is built, which the CSP forbids (A§12.1 #6).
// @f1/contracts builds its schemas on import, so jitless must be set before it loads (D7).
it('the first import of main.tsx is ./lib/zod.ts', () => {
  const main = readFileSync(fileURLToPath(new URL('../src/main.tsx', import.meta.url)), 'utf8');
  const first = /^import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/m.exec(main);
  expect(first?.[1]).toBe('./lib/zod.ts');
});

// Nothing in this file imports zod statically, and Vitest isolates each test file, so the zod
// instance and its cached eval probe are fresh here. The last step proves the counter sees the probe.
it('importing lib/zod.ts, then the API module and its contracts, makes no Function call', async () => {
  const original = globalThis.Function;
  let calls = 0;
  globalThis.Function = new Proxy(original, {
    construct(target, args) {
      calls++;
      return Reflect.construct(target, args);
    },
    apply(target, self, args) {
      calls++;
      return Reflect.apply(target, self, args);
    },
  });
  try {
    await import('../src/lib/zod.ts');
    const { getJson } = await import('../src/lib/api.ts');
    const { Seasons } = await import('@f1/contracts');
    expect(getJson).toBeTypeOf('function');
    expect(Seasons.parse([{ year: 2026, meetings: 1, sessions: 5 }])).toHaveLength(1);
    expect(calls).toBe(0);

    const { config, z } = await import('zod');
    config({ jitless: false });
    z.object({ a: z.string() });
    expect(calls).toBeGreaterThan(0);
  } finally {
    globalThis.Function = original;
  }
});
