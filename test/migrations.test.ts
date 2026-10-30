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
  '20261030000001_recording.sql': '7f4588de2b0b7e1e0e68ee9ff0374ebc2934469c9a5bc02e0d71611af9cc565a',
};

it('every migration matches its pinned sha256, and no file is added or removed', () => {
  const dir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
  const actual = Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => [
        f,
        createHash('sha256')
          .update(readFileSync(dir + f))
          .digest('hex'),
      ]),
  );
  expect(actual).toEqual(PINNED);
});
