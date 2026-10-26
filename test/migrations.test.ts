import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// An applied migration is never edited (A§15): a changed, removed or new file
// fails here. A new migration adds its own line.
const PINNED: Record<string, string> = {
  '20261025000001_init.sql': '0ab7b74d1c62b643e9a172e36e7f4e9f7b59282997c44322757436b3587e78ad',
  '20261026000001_timing_tables.sql': 'a9d992a08b028b063eed6887de36ed35e1ca0fd2bc68657aa9b40e4fae41150a',
  '20261026000002_grants.sql': '3e177dad760a4c13000a3392534a7aec881ece10d78d2dac118eec6355481e39',
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
