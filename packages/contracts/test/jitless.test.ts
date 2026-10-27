import { expect, it } from 'vitest';

// The web's CSP has no 'unsafe-eval' (A§12.1 #6): zod probes `new Function` when it builds an object
// schema unless `jitless` is set first, and the contracts build theirs on import. So P1d sets
// `config({ jitless: true })` in a module imported before `@f1/contracts` (CLAUDE.md gotcha).
// Its own file: the zod instance, its config and its eval probe are fresh here.

it('with z.config({ jitless: true }) set first, importing, building and using the contracts makes no Function call', async () => {
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
    const { config, z } = await import('zod');
    config({ jitless: true });
    const contracts = await import('../src/index.ts');
    expect(contracts.Seasons.parse([{ year: 2026, meetings: 1, sessions: 5 }])).toHaveLength(1);
    expect(contracts.Status.safeParse({}).success).toBe(false);
    expect(calls).toBe(0);

    // The probe is real and the counter sees it: without jitless a new object schema makes one.
    config({ jitless: false });
    z.object({ a: z.string() });
    expect(calls).toBeGreaterThan(0);
  } finally {
    globalThis.Function = original;
  }
});
