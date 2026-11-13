import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { IGNORED, PERIOD_LIKE } from '../packages/contracts/src/race-control.ts';

// Query 6 of scripts/race-control-forms.sql lists what /status lists as unknown wording (#105): it must use the
// patterns of the contract verbatim, as PostgreSQL string literals, so the two cannot drift apart.
const sql = readFileSync(join(import.meta.dirname, '../scripts/race-control-forms.sql'), 'utf8');
const query6 = sql.slice(sql.indexOf("\\echo '6."));

it('query 6 of scripts/race-control-forms.sql matches PERIOD_LIKE and not IGNORED, verbatim', () => {
  expect(query6).toContain(`rc.message ~ '${PERIOD_LIKE.source}'`);
  expect(query6).toContain(`rc.message !~ '${IGNORED.source}'`);
});
