import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// An applied migration is never edited (A§15): a changed, removed or new file
// fails here. A new migration adds its own line.
const PINNED: Record<string, string> = {
  '20261025000001_init.sql': '0ab7b74d1c62b643e9a172e36e7f4e9f7b59282997c44322757436b3587e78ad',
  '20261026000001_timing_tables.sql': '1264005e782e801b16c4e082c67cf73c6e46bea0e5346d8afee5b9481dd5042f',
  '20261026000002_grants.sql': '302ff6e6ec279a31b5b26a62034912f670b175b882ca1cbac205075acd56ed48',
  '20261030000001_recording.sql': 'b39b27def9a1d632dca21f4433d637e3b288249317f63b74002248b04d52ff2d',
  '20261109000001_weather.sql': '21c802b2bbcc2c1fcb7bbd96c0695748409a4886e43cea8b14637a7cc7832c25',
  '20261109000002_rain.sql': '1902d11ce8b5005a4d2f8208808d98e985a6edfc711e55939bb900a5a631dc23',
  '20261112000001_lap_source.sql': 'a460be81918e7f6e2763dc71e8e4ec7a7e72515918323c630e079e374044c9f2',
  '20261113000001_jolpica.sql': '73805a09329315ac72ced04ec3be90456919f94ba5bbe06cac84b336ba760e39',
  '20261113000002_ingest_status.sql': '4aab2d1b71f8a740eaf0397f668cee1baaf7873a1a669ea4ec41e98ebe26b405',
  '20261114000001_starting_grid.sql': '65c14270c8de4eb83317cfc8eb2812aaa8099f9563b7e110741e27cc7f919701',
};

const dir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

it('every migration matches its pinned sha256, and no file is added or removed', () => {
  const actual = Object.fromEntries(
    files.map((f) => [
      f,
      createHash('sha256')
        .update(readFileSync(dir + f))
        .digest('hex'),
    ]),
  );
  expect(actual).toEqual(PINNED);
});

// Expand, then contract (runbook update.md): a rollback runs the previous image on the new schema, so an up
// section never drops, renames, retypes or tightens what that image reads. The replace idiom (DROP CONSTRAINT x
// and ADD CONSTRAINT x in the same statement, how a CHECK widens) and DROP NOT NULL pass. A `-- contract: <why>`
// line above `-- migrate:down` passes the file: no release you could roll back to needs the old shape any more.
// ponytail: a keyword scan, not a parser. A replaced CHECK that narrows, a widened CHECK the old image cannot
// read, a unique index, data rewrites, SET SCHEMA and dynamic SQL in DO or function bodies (string literals are
// stripped) pass: review catches those. Parse the SQL if one ever slips through.
const CONTRACT = [
  /\bDROP\b/i,
  /\bRENAME\b/i,
  /\bREVOKE\b/i,
  /\bALTER\s+(?:COLUMN\s+)?(?!COLUMN\b)(?:"[^"]+"|\w+)\s+(?:SET\s+DATA\s+)?TYPE\b/i,
  /\bSET\s+NOT\s+NULL\b/i,
  // An ADD COLUMN NOT NULL without a DEFAULT: the old image's INSERTs fail.
  /^(?=.*\bADD\s+COLUMN\b)(?=.*\bNOT\s+NULL\b)(?!.*\bDEFAULT\b)/i,
];
const NAME = String.raw`("[^"]+"|\w+)`;
const names = (s: string, re: string) =>
  new Set([...s.matchAll(new RegExp(re + NAME, 'gi'))].map((m) => m[1]?.toLowerCase()));

function contractSteps(file: string): string[] {
  const head = file.split(/^-- migrate:down\b/m)[0] ?? '';
  if (/^-- contract: \S/m.test(head)) return [];
  // One left-to-right pass: a literal may hold "--", a comment an apostrophe.
  const code = (head.split(/^-- migrate:up\b/m).at(-1) ?? '').replace(
    /'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g,
    (m) => (m[0] === "'" ? "''" : ' '),
  );
  return code
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => {
      const added = names(s, String.raw`\bADD\s+CONSTRAINT\s+`);
      const dropped = names(s, String.raw`\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?`);
      const rest = s
        .replace(new RegExp(String.raw`\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?${NAME}`, 'gi'), (m, name: string) =>
          added.has(name.toLowerCase()) ? '' : m,
        )
        .replace(/\bDROP\s+NOT\s+NULL\b/gi, '');
      // A new constraint on an existing table tightens it, unless it replaces one of the same name.
      return CONTRACT.some((re) => re.test(rest)) || [...added].some((n) => !dropped.has(n));
    });
}

it('no up section has a contract step', () => {
  expect(files.map((f) => [f, contractSteps(readFileSync(dir + f, 'utf8'))])).toEqual(files.map((f) => [f, []]));
});

it.each([
  ['DROP TABLE', 'DROP TABLE lap;', true],
  ['DROP COLUMN', 'ALTER TABLE lap DROP COLUMN filled;', true],
  ['an unpaired DROP CONSTRAINT', 'ALTER TABLE lap DROP CONSTRAINT lap_source_check;', true],
  ['RENAME COLUMN', 'ALTER TABLE lap RENAME COLUMN lap_ms TO ms;', true],
  ['ALTER COLUMN c TYPE', 'ALTER TABLE lap ALTER COLUMN lap_ms TYPE bigint;', true],
  ['SET NOT NULL', 'ALTER TABLE lap ALTER COLUMN lap_ms SET NOT NULL;', true],
  [
    'the replace idiom',
    "ALTER TABLE lap\n  DROP CONSTRAINT lap_source_check,\n  ADD CONSTRAINT lap_source_check CHECK (source IN ('openf1', 'x'));",
    false,
  ],
  ['DROP NOT NULL', 'ALTER TABLE lap ALTER COLUMN lap_ms DROP NOT NULL;', false],
  ['ALTER TYPE … ADD VALUE', "ALTER TYPE state ADD VALUE 'paused';", false],
  ['a column named type', 'ALTER TABLE session ALTER COLUMN type SET DEFAULT NULL;', false],
  ['"drop" in a comment and in a string', "-- don't drop it\nUPDATE lap SET note = 'drop it';", false],
  [
    'a -- contract: line',
    '-- contract: no release reads lap.filled any more\nALTER TABLE lap DROP COLUMN filled;',
    false,
  ],
  ['DROP only in the down section', 'CREATE TABLE t (a int);\n-- migrate:down\nDROP TABLE t;', false],
  [
    '"--" in a string does not hide a later DROP',
    "COMMENT ON COLUMN lap.x IS 'filled -- see #12';\nALTER TABLE lap DROP COLUMN y;\nINSERT INTO t VALUES ('a');",
    true,
  ],
  ['a block comment with an apostrophe', "/* it's */ ALTER TABLE lap DROP COLUMN y;", true],
  ['"drop" in a block comment', '/* we never drop */ CREATE TABLE t (a int);', false],
  ['REVOKE', 'REVOKE SELECT ON lap FROM f1_api;', true],
  ['an unpaired ADD CONSTRAINT', 'ALTER TABLE lap ADD CONSTRAINT lap_x_check CHECK (lap_ms > 0);', true],
  ['ADD COLUMN NOT NULL without DEFAULT', 'ALTER TABLE lap ADD COLUMN x int NOT NULL;', true],
  ['ADD COLUMN NOT NULL DEFAULT', 'ALTER TABLE lap ADD COLUMN x int NOT NULL DEFAULT 0;', false],
  [
    "one table's ADD does not excuse another's DROP",
    'ALTER TABLE a DROP CONSTRAINT c;\nALTER TABLE b ADD CONSTRAINT c CHECK (true);',
    true,
  ],
])('%s: flagged %s', (_name, up, flagged) => {
  expect(contractSteps(`-- migrate:up\n${up}\n`).length > 0).toBe(flagged);
});

it('a -- contract: line counts above -- migrate:down only', () => {
  const drop = 'ALTER TABLE lap DROP COLUMN y;';
  const why = '-- contract: no release reads lap.y any more';
  expect(contractSteps(`${why}\n-- migrate:up\n${drop}\n`)).toEqual([]);
  expect(contractSteps(`-- migrate:up\n${drop}\n-- migrate:down\n${why}\n`)).toEqual(['ALTER TABLE lap DROP COLUMN y']);
});
