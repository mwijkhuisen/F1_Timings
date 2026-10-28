import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Zod 4 probes `new Function` when a schema is built, which the CSP forbids (A§12.2).
// @f1/contracts builds its schemas on import, so jitless must be set before it loads (D7).
it('the first import of main.tsx is ./lib/zod.ts', () => {
  const main = readFileSync(fileURLToPath(new URL('../src/main.tsx', import.meta.url)), 'utf8');
  const first = /^import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/m.exec(main);
  expect(first?.[1]).toBe('./lib/zod.ts');
});

it('lib/zod.ts sets jitless', () => {
  const zod = readFileSync(fileURLToPath(new URL('../src/lib/zod.ts', import.meta.url)), 'utf8');
  expect(zod).toMatch(/config\(\{ jitless: true \}\)/);
});
