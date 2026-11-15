import { setTimeout } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { download, type Failure, ORIGIN } from '../apps/server/src/archive/files.ts';
import { GAP_MS } from '../apps/server/src/archive/job.ts';
import { checkToken, readTokenFile } from '../apps/server/src/live/token.ts';
import { EXIT_USAGE } from '../apps/server/src/main.ts';

// Asks which years' `static/<year>/Index.json` the F1 archive serves (A§6.2, P3d): one GET per year with the F1 TV token,
// from 2011 to 2017 by default, after a control on 2018, which is known to answer 200. Run on the owner's machine only: CI
// never calls F1 (A§12.1 invariant 4). The token comes from a 0600 file and goes only to livetiming.formula1.com
// (download(), apps/server/src/archive/files.ts). It prints one line per year, a status or a fixed code and counts,
// never a body, a URL, the token or any Index text.

const USAGE = 'usage: archive-probe.ts --token-file <path> [--from <year>] [--to <year>]';
const CONTROL = 2018;

const describe = (error: Failure) => (error.code === 'http' ? String(error.status) : error.code);

/** Meetings, sessions and sessions with a `Path` of an Index.json, or undefined when it is no `{Meetings: [...]}`. */
function indexCounts(text: string) {
  let index: unknown;
  try {
    index = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
  const meetings = (index as { Meetings?: unknown } | null)?.Meetings;
  if (!Array.isArray(meetings)) return undefined;
  let [sessions, paths] = [0, 0];
  for (const m of meetings) {
    const list = m !== null && typeof m === 'object' && Array.isArray(m.Sessions) ? (m.Sessions as unknown[]) : [];
    sessions += list.length;
    paths += list.filter((s) => typeof (s as { Path?: unknown } | null)?.Path === 'string').length;
  }
  return { meetings: meetings.length, sessions, paths };
}

export async function archiveProbe(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => console.error(line),
  now = () => Date.now(),
  sleep: (ms: number) => Promise<unknown> = (ms) => setTimeout(ms),
): Promise<number> {
  if (env.CI) {
    log('archive-probe refuses to run under CI (A§12.1 invariant 4)');
    return 1;
  }
  let args: ReturnType<typeof parseOptions>;
  try {
    args = parseOptions(argv);
  } catch {
    log(USAGE);
    return EXIT_USAGE;
  }
  const { 'token-file': tokenFile, from = '2011', to = '2017' } = args.values;
  const [first, last] = [Number(from), Number(to)];
  if (
    args.positionals.length > 0 ||
    tokenFile === undefined ||
    !/^\d{4}$/.test(from) ||
    !/^\d{4}$/.test(to) ||
    first < 1950 ||
    first > last ||
    last > new Date(now()).getUTCFullYear()
  ) {
    log(USAGE);
    return EXIT_USAGE;
  }

  const file = readTokenFile(tokenFile);
  const checked = file.ok ? checkToken(file.value, now()) : file;
  if (!checked.ok) {
    log(`archive-probe: ${checked.error}`);
    return 1;
  }
  const { token, exp } = checked.value;
  log(`token: expires ${new Date(exp * 1000).toISOString()}`);

  const years = [CONTROL];
  for (let year = first; year <= last; year++) if (year !== CONTROL) years.push(year);
  for (const year of years) {
    // At least GAP_MS between request starts, as the archive job (A§6.2).
    if (year !== CONTROL) await sleep(GAP_MS);
    const mark = year === CONTROL ? ' (control)' : '';
    const got = await download(`${ORIGIN}/static/${year}/Index.json`, token);
    const counts = got.ok ? indexCounts(got.value.bytes.toString('utf8')) : undefined;
    log(
      !got.ok
        ? `${year} ${describe(got.error)}${mark}`
        : counts === undefined
          ? `${year} ${got.value.status} index_format${mark}`
          : `${year} ${got.value.status} meetings ${counts.meetings} sessions ${counts.sessions} paths ${counts.paths}${mark}`,
    );
    // Only an Index with sessions proves the token: else a 401 or 403 for an older year would prove nothing.
    if (year === CONTROL && !(counts !== undefined && counts.paths > 0)) {
      log(`archive-probe: control ${CONTROL} is no 200 Index with sessions, the token is not proven`);
      return 1;
    }
  }
  return 0;
}

const parseOptions = (argv: readonly string[]) =>
  parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { 'token-file': { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } },
  });

if (import.meta.main) {
  process.exitCode = await archiveProbe(process.argv.slice(2), process.env);
}
