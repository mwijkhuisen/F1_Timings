import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// The same pin lives in several files and Dependabot or a hand edit can move only one (#106).
// pinErrors takes the file texts, so the negative cases below can plant a mismatch in one of them.
type File = 'ci' | 'compose' | 'dependabot' | 'server' | 'web' | 'nodeVersion';

// PGDATA is per major (/var/lib/postgresql/<major>/docker): this moves only with the runbook
// docs/runbooks/update.md "A PostgreSQL major upgrade", never with a Dependabot PR.
const PG_MAJOR = '18';

function pinErrors(t: Record<File, string>): string[] {
  const errors: string[] = [];
  // The one capture of a /gm regex; any other count is an error, so a refactor cannot pass vacuously.
  const one = (pin: string, file: File, re: RegExp): string | undefined => {
    const found = [...t[file].matchAll(re)];
    if (found.length !== 1) errors.push(`${pin}: ${file} has ${found.length} matches`);
    return found.length === 1 ? found[0]?.[1] : undefined;
  };
  const same = (pin: string, a?: string, b?: string) => {
    if (a !== undefined && b !== undefined && a !== b) errors.push(`${pin}: ${a} != ${b}`);
  };

  const ciPg = one('postgres_image', 'ci', /^\s+image: (postgres:\S+)$/gm);
  const composePg = one('postgres_image', 'compose', /^\s+image: (postgres:\S+)$/gm);
  same('postgres_image', ciPg, composePg);
  for (const [file, image] of [
    ['ci', ciPg],
    ['compose', composePg],
  ] as const) {
    const major = image?.match(/^postgres:(\d+)\./)?.[1];
    if (major !== undefined && major !== PG_MAJOR) errors.push(`postgres_major: ${file} has ${major}, not ${PG_MAJOR}`);
  }

  same(
    'dbmate_version',
    one('dbmate_version', 'ci', /^\s+DBMATE_VERSION: v(\S+)$/gm),
    one('dbmate_version', 'server', /^ARG DBMATE_VERSION=(\S+)$/gm),
  );
  same(
    'dbmate_sha256',
    one('dbmate_sha256', 'ci', /^\s+DBMATE_SHA256: ([0-9a-f]{64})$/gm),
    one('dbmate_sha256', 'server', /^ADD --checksum=sha256:([0-9a-f]{64}) /gm),
  );

  const serverNode = one('node_build_stage', 'server', /^FROM (node:\S+) AS build$/gm);
  const webNode = one('node_build_stage', 'web', /^FROM (node:\S+) AS build$/gm);
  same('node_build_stage', serverNode, webNode);

  // Only the major must agree: .node-version is the dev and CI runtime, the build stages compile
  // (D2 of #106). The runtime image has no minor tag.
  const devMajor = one('node_major', 'nodeVersion', /^(\d+)\./gm);
  for (const [what, major] of [
    ['server build stage', serverNode?.match(/^node:(\d+)\./)?.[1]],
    ['web build stage', webNode?.match(/^node:(\d+)\./)?.[1]],
    ['distroless nodejs', one('node_major', 'server', /^FROM gcr\.io\/distroless\/nodejs(\d+)-/gm)],
  ] as const) {
    if (devMajor !== undefined && major !== undefined && major !== devMajor) {
      errors.push(`node_major: ${what} is ${major}, .node-version says ${devMajor}`);
    }
  }

  // Comment lines go first, so the explaining comment cannot satisfy the check. The block runs from the
  // docker-compose entry to the next entry (the plain docker entry shares the prefix).
  const stripped = t.dependabot.replace(/^[ \t]*#.*$/gm, '');
  const entries = [...stripped.matchAll(/package-ecosystem: docker-compose$/gm)];
  if (entries.length !== 1) {
    errors.push(`dependabot_postgres_major: dependabot has ${entries.length} matches`);
  } else {
    const block = stripped.slice(entries[0]?.index).split(/^[ \t]*- package-ecosystem/m)[0] ?? '';
    const ignores = block
      .split(/^[ \t]*- (?=dependency-name:)/m)
      .filter((item) => /dependency-name: postgres$/m.test(item) && item.includes('version-update:semver-major'));
    if (ignores.length !== 1) errors.push(`dependabot_postgres_major: dependabot has ${ignores.length} matches`);
  }
  return errors;
}

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const real: Record<File, string> = {
  ci: read('.github/workflows/ci.yml'),
  compose: read('deploy/compose.yaml'),
  dependabot: read('.github/dependabot.yml'),
  server: read('deploy/server/Dockerfile'),
  web: read('deploy/web/Dockerfile'),
  nodeVersion: read('.node-version'),
};

// A replacement that keeps the capture and swaps the rest, whatever the current value is.
const swap = (re: RegExp, to: string) => (s: string) => s.replace(re, (_m, keep: string) => keep + to);
const pinNames = (errors: string[]) => [...new Set(errors.map((e) => e.split(':')[0]))];

it('the real files agree', () => {
  expect(pinErrors(real)).toEqual([]);
});

it.each<[string, File, (s: string) => string]>([
  ['postgres_image', 'ci', swap(/(image: postgres:\S+@sha256:)[0-9a-f]/, 'z')],
  ['dbmate_version', 'server', swap(/^(ARG DBMATE_VERSION=).+$/m, '9.99.0')],
  ['dbmate_sha256', 'ci', swap(/^(\s+DBMATE_SHA256: )[0-9a-f]{64}$/m, '0'.repeat(64))],
  ['node_build_stage', 'web', swap(/^(FROM node:)\d+\.\d+\.\d+/m, '26.99.0')],
  ['node_major', 'nodeVersion', () => '27.0.0\n'],
  ['node_major', 'server', swap(/^(FROM gcr\.io\/distroless\/nodejs)\d+/m, '27')],
  ['dependabot_postgres_major', 'dependabot', (s) => s.replace(/^.*dependency-name: postgres$/m, '')],
  ['dependabot_postgres_major', 'dependabot', (s) => s.replaceAll('version-update:semver-major', '')],
])('a planted mismatch fails %s (%#)', (pin, file, mutate) => {
  expect(pinNames(pinErrors({ ...real, [file]: mutate(real[file]) }))).toEqual([pin]);
});

it('both files on an identical postgres 19 ref fail postgres_major only', () => {
  const to19 = swap(/(image: postgres:)18\./, '19.');
  expect(pinNames(pinErrors({ ...real, ci: to19(real.ci), compose: to19(real.compose) }))).toEqual(['postgres_major']);
});

it('a deleted postgres line is "has 0 matches", not a pass', () => {
  const compose = real.compose.replace(/^\s+image: postgres:.*\n/m, '');
  expect(pinErrors({ ...real, compose })).toContain('postgres_image: compose has 0 matches');
});

it('a comment cannot stand in for the Dependabot ignore', () => {
  const dependabot = real.dependabot.replace(/^.*dependency-name: postgres$/m, '# dependency-name: postgres');
  expect(pinErrors({ ...real, dependabot })).toContain('dependabot_postgres_major: dependabot has 0 matches');
});
