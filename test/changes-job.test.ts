import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

// #208: the `changes` job's diff step, taken from ci.yml and run the way the runner runs it (bash
// -eo pipefail) in a throw-away repository, with a stub `docker` in front of the real jq. The names
// in its list are pinned by pins.test.ts; this proves the pathspecs and the label checks around them.

const ROOT = join(import.meta.dirname, '..');
const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const block = ci.match(/^ {8}id: diff\n {8}run: \|\n((?:(?: {10}.*)?\n)+)/m)?.[1] ?? '';
const script = block.replace(/^ {10}/gm, '');
// The runner has jq; a dev box may not (it then skips, CI never does).
const hasJq = spawnSync('jq', ['--version']).status === 0;

const STUB = `#!/usr/bin/env bash
[[ "$1 $2 $3 $5" == 'buildx imagetools inspect --format' ]] || exit 2
case $4 in */f1-server:main) v=$STUB_SERVER ;; */f1-web:main) v=$STUB_WEB ;; *) exit 2 ;; esac
[[ $v != FAIL ]] || exit 1
if [[ $STUB_SHAPE == index ]]; then
  printf '{"linux/amd64":{"config":{"Labels":{"org.opencontainers.image.revision":"%s"}}}}\\n' "$v"
else
  printf '{"architecture":"amd64","config":{"Labels":{"org.opencontainers.image.revision":"%s"}}}\\n' "$v"
fi
`;

let dir = '';
const env = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
});
const git = (...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd: join(dir, 'repo'),
    encoding: 'utf8',
    env: env(),
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
/** A commit on `from` (none: the first) that writes, or with null deletes, the given files. */
const commit = (from: string | undefined, files: Record<string, string | null>) => {
  if (from !== undefined) git('checkout', '-q', '--detach', from);
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, 'repo', path);
    if (text === null) rmSync(file, { recursive: true });
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
  }
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', 'x');
  return git('rev-parse', 'HEAD');
};

const sha: Record<string, string> = {};
const at = (key: string) => sha[key] ?? key;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'changes-job-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/docker'), STUB);
  chmodSync(join(dir, 'bin/docker'), 0o755);
  mkdirSync(join(dir, 'repo'));
  git('init', '-q');
  sha.base = commit(undefined, {
    '.dockerignore': '*\n',
    'package.json': '{}\n',
    'apps/server/package.json': '{}\n',
    'apps/server/src/a.ts': 'x\n',
    'apps/server/test/a.test.ts': 'x\n',
    'apps/web/src/a.ts': 'x\n',
    'db/migrations/1_a.sql': 'x\n',
    'docs/a.md': 'x\n',
    'deploy/bin/f1-update': 'x\n',
  });
  sha.docs = commit(sha.base, {
    'docs/a.md': 'y\n',
    'deploy/bin/f1-update': 'y\n',
    'apps/server/test/a.test.ts': 'y\n',
  });
  sha.sibling = commit(sha.base, { 'docs/b.md': 'x\n' });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (head: string, server: string, web = server, shape = 'single') => {
  git('checkout', '-q', '--detach', head);
  const out = join(dir, 'out');
  writeFileSync(out, '');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd: join(dir, 'repo'),
    encoding: 'utf8',
    env: {
      ...env(),
      GITHUB_OUTPUT: out,
      REGISTRY_PREFIX: 'ghcr.io/x',
      STUB_SERVER: server,
      STUB_WEB: web,
      STUB_SHAPE: shape,
    },
  });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  return readFileSync(out, 'utf8');
};

it('the step is in ci.yml', () => {
  expect(script).toContain('paths=(');
});

it.skipIf(!hasJq && !process.env.CI).each<[string, Record<string, string | null>]>([
  ['a file deep under apps/*/src', { 'apps/web/src/deep/er/b.ts': 'x\n' }],
  ['apps/*/package.json', { 'apps/server/package.json': '{"a":1}\n' }],
  ['package.json', { 'package.json': '{"a":1}\n' }],
  ['a migration deleted', { 'db/migrations': null }],
  // Without set -f the shell would expand apps/*/src to the src directories that remain.
  ["one app's src deleted", { 'apps/server/src': null }],
  ['.dockerignore', { '.dockerignore': '*\n!x\n' }],
  ['a Dockerfile', { 'deploy/web/Dockerfile': 'FROM x\n' }],
])('%s releases', (_name, files) => {
  expect(run(commit(at('docs'), files), at('base'))).toBe('release=true\n');
});

it.skipIf(!hasJq && !process.env.CI)('docs, tests and deploy/bin only release nothing, in both config shapes', () => {
  expect(run(at('docs'), at('base'))).toBe('release=false\n');
  expect(run(at('docs'), at('base'), at('base'), 'index')).toBe('release=false\n');
  expect(run(at('base'), at('base'))).toBe('release=false\n');
});

it.skipIf(!hasJq && !process.env.CI).each<[string, string, string]>([
  ['an unreadable label', 'FAIL', 'FAIL'],
  ['an empty label', '', ''],
  ['the label dev', 'dev', 'dev'],
  ['labels that differ (a half-pushed pair)', 'base', 'docs'],
  ['a label that is no ancestor (a sibling commit)', 'sibling', 'sibling'],
  ['a label that names no commit', '0'.repeat(40), '0'.repeat(40)],
])('%s releases', (_name, server, web) => {
  expect(run(at('docs'), at(server), at(web))).toBe('release=true\n');
});
