import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { EXIT_USAGE } from '../apps/server/src/main.ts';
import { createClient, url } from '../apps/server/src/openf1/client.ts';
import { ENDPOINTS, type Endpoint, parse } from '../apps/server/src/openf1/schemas.ts';

// Records one OpenF1 fixture (A§15): <endpoint>-<case>.raw (the trimmed body),
// .meta.json (where and when) and .golden.json (the parsed rows). Run on the
// owner's machine only: CI never calls OpenF1 (A§12.1 invariant 4).

export const FIXTURES = join(import.meta.dirname, '../apps/server/src/openf1/fixtures');
const USAGE = 'usage: record-fixture.ts <endpoint> <case> <query> [--drivers 1,44] [--laps 1-3,30-35]';

/** One row per line: short diffs. Biome skips the fixtures folder (biome.json). */
export const rowsJson = (rows: readonly unknown[]) =>
  rows.length === 0 ? '[]\n' : `[\n${rows.map((row) => JSON.stringify(row)).join(',\n')}\n]\n`;

export async function record(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => console.error(line),
  dir = FIXTURES,
): Promise<number> {
  if (env.CI) {
    log('record-fixture refuses to run under CI (A§12.1 invariant 4)');
    return 1;
  }
  let args: ReturnType<typeof parseOptions>;
  try {
    args = parseOptions(argv);
  } catch {
    log(USAGE);
    return EXIT_USAGE;
  }
  const [endpoint, name, query] = args.positionals;
  if (args.positionals.length !== 3 || !isEndpoint(endpoint) || !/^[a-z]+$/.test(name ?? '') || query === undefined) {
    log(USAGE);
    return EXIT_USAGE;
  }
  const drivers = args.values.drivers?.split(',').map(Number);
  const laps = args.values.laps?.split(',').map((range) => range.split('-').map(Number));
  const params = Object.fromEntries(new URLSearchParams(query));

  const fetched = await createClient().get(endpoint, params);
  if (!fetched.ok) {
    log(`record-fixture: ${JSON.stringify(fetched.error)}`);
    return 1;
  }
  const { status, body } = fetched.value;
  if (!Array.isArray(body)) {
    log('record-fixture: the body is not an array');
    return 1;
  }
  const kept = (body as Record<string, unknown>[]).filter(
    (row) =>
      (drivers === undefined || drivers.includes(Number(row.driver_number))) &&
      (laps === undefined ||
        laps.some(([from = 0, to = from]) => Number(row.lap_number) >= from && Number(row.lap_number) <= to)),
  );
  const parsed = parse(endpoint, kept);
  if (!parsed.ok) {
    log(`record-fixture: ${JSON.stringify(parsed.error)}`);
    return 1;
  }

  const base = join(dir, `${endpoint}-${name}`);
  const meta = {
    url: url(endpoint, params),
    fetchedAt: new Date().toISOString(),
    status,
    trim: { drivers: args.values.drivers ?? null, laps: args.values.laps ?? null },
    rows: { fetched: body.length, kept: kept.length },
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${base}.raw`, rowsJson(kept));
  writeFileSync(`${base}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(`${base}.golden.json`, rowsJson(parsed.value));
  log(`${endpoint}-${name}: kept ${kept.length} of ${body.length} rows (HTTP ${status})`);
  return 0;
}

const parseOptions = (argv: readonly string[]) =>
  parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { drivers: { type: 'string' }, laps: { type: 'string' } },
  });

const isEndpoint = (value: string | undefined): value is Endpoint => ENDPOINTS.includes(value as Endpoint);

if (import.meta.main) {
  process.exitCode = await record(process.argv.slice(2), process.env);
}
