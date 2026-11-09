import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CIRCUITS } from '../packages/contracts/src/circuits.ts';

// scripts/rain-facts.sql names the mapped circuits once, in a VALUES list, for its [box] queries (P5c). The list
// is pinned to CIRCUITS here, so a new circuit cannot be added to the map without the check learning it.
const sql = readFileSync(join(import.meta.dirname, '../scripts/rain-facts.sql'), 'utf8');

it('scripts/rain-facts.sql lists exactly the circuits of CIRCUITS, once', () => {
  const list = /string_agg\(quote_literal\(name\)[^)]*\) AS mapped FROM \(VALUES([\s\S]*?)\) AS m\(name\)/.exec(sql);
  expect(list, 'the VALUES list').not.toBeNull();
  const names = [...(list?.[1] ?? '').matchAll(/\('([^']+)'\)/g)].map((m) => m[1]);
  expect(names).toHaveLength(new Set(names).size);
  expect([...names].sort()).toEqual(Object.keys(CIRCUITS).sort());
  // Every other query takes the list from :mapped: no second, driftable copy of a name.
  const rest = sql.replace(list?.[0] ?? '', '').replace(/--.*$/gm, '');
  for (const name of Object.keys(CIRCUITS)) expect(rest, name).not.toContain(`'${name}'`);
});
