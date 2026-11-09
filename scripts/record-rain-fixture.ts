import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { EXIT_USAGE } from '../apps/server/src/main.ts';
import { createRainClient, parseAnswer, type RainApi } from '../apps/server/src/rain/client.ts';
import { ceil15, floor15, rainQuery } from '../apps/server/src/rain/grid.ts';
import { gridPoints } from '../packages/contracts/src/geo.ts';

// Records one Open-Meteo answer for a rain grid (P5c): <case>.raw (the body as sent, any status)
// and <case>.meta.json (what and when). Run on the owner's machine only: CI never calls
// Open-Meteo (A§12.1 invariant 4). Never record a UK session: UK Met Office data is CC BY-SA.

export const FIXTURES = join(import.meta.dirname, '../apps/server/src/rain/fixtures');
export const ATTRIBUTION =
  'Data: Open-Meteo.com, CC BY 4.0, https://open-meteo.com/ — https://creativecommons.org/licenses/by/4.0/';
const USAGE =
  'usage: record-rain-fixture.ts <case> <lat0> <lon0> <date_start ISO> <date_end ISO> [--api forecast|historical]';
const SIZE = 7;
const STEP_M = 1500;

export async function record(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => console.error(line),
  dir = FIXTURES,
): Promise<number> {
  if (env.CI) {
    log('record-rain-fixture refuses to run under CI (A§12.1 invariant 4)');
    return 1;
  }
  let args: ReturnType<typeof parseOptions>;
  try {
    args = parseOptions(argv);
  } catch {
    log(USAGE);
    return EXIT_USAGE;
  }
  const [name = '', ...rest] = args.positionals;
  const [lat0, lon0] = rest.slice(0, 2).map(Number);
  const [start, end] = rest.slice(2).map(Date.parse);
  const api = args.values.api ?? 'historical';
  if (
    rest.length !== 4 ||
    !/^[a-z]+(-[a-z]+)*$/.test(name) ||
    ![lat0, lon0, start, end].every(Number.isFinite) ||
    (api !== 'forecast' && api !== 'historical')
  ) {
    log(USAGE);
    return EXIT_USAGE;
  }

  const points = gridPoints(lat0 as number, lon0 as number, SIZE, STEP_M);
  const query = rainQuery(points, floor15((start as number) - 3_600_000), ceil15((end as number) + 1_800_000));
  const fetched = await createRainClient().text(api as RainApi, query);
  if (!fetched.ok) {
    log(`record-rain-fixture: ${JSON.stringify(fetched.error)}`);
    return 1;
  }
  const { status, text } = fetched.value;
  const meta = {
    api,
    query,
    fetchedAt: new Date().toISOString(),
    status,
    points: points.length,
    grid: { lat0, lon0, size: SIZE, step_m: STEP_M },
    attribution: ATTRIBUTION,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.raw`), text);
  writeFileSync(join(dir, `${name}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
  const answer = status === 200 ? parseAnswer(text, points.length) : undefined;
  const steps = answer?.[0]?.minutely_15.time.length;
  log(
    `${name}: HTTP ${status}, ${text.length} bytes${steps === undefined ? '' : `, ${points.length} × ${steps} steps`}`,
  );
  return 0;
}

const parseOptions = (argv: readonly string[]) =>
  parseArgs({ args: [...argv], allowPositionals: true, options: { api: { type: 'string' } } });

if (import.meta.main) {
  process.exitCode = await record(process.argv.slice(2), process.env);
}
