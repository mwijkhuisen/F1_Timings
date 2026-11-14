import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compoundOf, compoundsOf, tyresWords, UNKNOWN_COMPOUND } from '../src/lib/compound.ts';

// #126: the tyre compounds by season. The names are the F1 archive's (the VM's 2018–2021 import, Step 0 on the issue).

const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
const root = /^:root\s*\{([^}]*)\}/m.exec(css)?.[1] ?? '';
/** The fill a class key gets: its `.cmp-<key>` rule's token in :root, or null without a rule (the grey fallback). */
const fill = (key: string) => {
  const rule = new RegExp(`^\\.cmp-${key}\\s*\\{\\s*--cmp:\\s*var\\(--([\\w-]+)\\);`, 'm').exec(css);
  return rule ? (new RegExp(`--${rule[1]}:\\s*(#[0-9a-f]{6});`).exec(root)?.[1] ?? 'no token') : null;
};

const NOW = [
  ['SOFT', 'soft', 'Soft', 'S', '#ff5050'],
  ['MEDIUM', 'medium', 'Medium', 'M', '#ffd23f'],
  ['HARD', 'hard', 'Hard', 'H', '#ececec'],
  ['INTERMEDIATE', 'intermediate', 'Intermediate', 'I', '#4cd964'],
  ['WET', 'wet', 'Wet', 'W', '#4da6ff'],
  ['TEST', 'test', 'Test tyre', 'T', null],
  ['TEST_UNKNOWN', 'test', 'Test tyre', 'T', null],
] as const;

// Pirelli's 2018 colours: Hypersoft pink, Ultrasoft purple, Supersoft red, Soft yellow, Medium white, Hard ice blue,
// Superhard orange.
const Y2018 = [
  ['HYPERSOFT', 'hypersoft', 'Hypersoft', 'HS', '#ff8ad8'],
  ['ULTRASOFT', 'ultrasoft', 'Ultrasoft', 'US', '#c08cff'],
  ['SUPERSOFT', 'supersoft', 'Supersoft', 'SS', '#ff5050'],
  ['SOFT', 'soft-2018', 'Soft', 'S', '#ffd23f'],
  ['MEDIUM', 'medium-2018', 'Medium', 'M', '#ececec'],
  ['HARD', 'hard-2018', 'Hard', 'H', '#8fe3ff'],
  ['SUPERHARD', 'superhard', 'Superhard', 'SH', '#ff9a3c'],
  ['INTERMEDIATE', 'intermediate', 'Intermediate', 'I', '#4cd964'],
  ['WET', 'wet', 'Wet', 'W', '#4da6ff'],
  ['TEST', 'test', 'Test tyre', 'T', null],
  ['TEST_UNKNOWN', 'test', 'Test tyre', 'T', null],
] as const;

describe('a 2018 session', () => {
  it.each(Y2018)('maps %s to cmp-%s, "%s", %s and the fill %s', (feed, key, name, letter, colour) => {
    expect(compoundOf(feed, 2018)).toEqual({ key, name, letter });
    expect(fill(key)).toBe(colour);
  });

  it("gives Supersoft, Soft and Medium today's soft, medium and hard colours, and Hard its own ice blue", () => {
    expect(fill('supersoft')).toBe(fill('soft'));
    expect(fill('soft-2018')).toBe(fill('medium'));
    expect(fill('medium-2018')).toBe(fill('hard'));
    expect(fill('hard-2018')).not.toBe(fill('hard'));
  });

  it('lists its compounds softest first, then the wet-weather tyres and the test tyre', () => {
    expect(compoundsOf(2018).map((c) => c.key)).toEqual([
      'hypersoft',
      'ultrasoft',
      'supersoft',
      'soft-2018',
      'medium-2018',
      'hard-2018',
      'superhard',
      'intermediate',
      'wet',
      'test',
    ]);
  });
});

describe('a 2019+ session', () => {
  it.each([2019, 2020, 2021, 2022, 2026])('%s keeps the map of today', (year) => {
    for (const [feed, key, name, letter] of NOW) expect(compoundOf(feed, year)).toEqual({ key, name, letter });
    expect(compoundsOf(year).map((c) => c.key)).toEqual(['soft', 'medium', 'hard', 'intermediate', 'wet', 'test']);
  });

  it.each(NOW)('maps %s to cmp-%s, "%s", %s and the fill %s', (feed, key, _name, _letter, colour) => {
    expect(compoundOf(feed, 2026)?.key).toBe(key);
    expect(fill(key)).toBe(colour);
  });

  it('knows no 2018-only name: the map is strict per season', () => {
    for (const feed of ['HYPERSOFT', 'ULTRASOFT', 'SUPERSOFT', 'SUPERHARD']) expect(compoundOf(feed, 2019)).toBeNull();
  });

  it('is the map without a year (a player before its session detail)', () => {
    expect(compoundOf('SOFT', null)).toEqual(compoundOf('SOFT', 2026));
    expect(compoundOf('ULTRASOFT', null)).toBeNull();
  });
});

describe('any season', () => {
  it.each([2018, 2026])('%s knows no other name', (year) => {
    for (const feed of [null, 'UNKNOWN', 'soft', 'C3', '', '__proto__', 'constructor', 'toString'])
      expect(compoundOf(feed, year)).toBeNull();
  });

  it.each([2018, 2026])('%s has one set of letters per compound', (year) => {
    const letters = compoundsOf(year).map((c) => c.letter);
    expect(new Set(letters).size).toBe(letters.length);
    expect(letters).not.toContain(UNKNOWN_COMPOUND.letter);
  });

  it('gives every compound but the test tyre a fill of its own, and no rule for unknown', () => {
    for (const c of [...compoundsOf(2018), ...compoundsOf(2026)])
      expect(fill(c.key) === null, c.key).toBe(c.key === 'test');
    expect(fill(UNKNOWN_COMPOUND.key)).toBeNull();
    expect(css).toContain('background: var(--cmp, var(--unknown));');
  });

  it('words a dot for a screen reader', () => {
    expect(tyresWords(compoundOf('ULTRASOFT', 2018))).toBe('ultrasoft tyres');
    expect(tyresWords(compoundOf('TEST', 2019))).toBe('test tyres');
    expect(tyresWords(null)).toBe('unknown tyres');
  });
});
