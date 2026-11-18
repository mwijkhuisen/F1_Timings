import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

// #208: scripts/check-workflows.sh fails a workflow whose top-level concurrency group has no commit
// part for a push. Each case plants one change in a copy of the real workflows.

const ROOT = join(import.meta.dirname, '..');
const WORKFLOWS = join(ROOT, '.github/workflows');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const run = (dir: string) => spawnSync('bash', [join(ROOT, 'scripts/check-workflows.sh'), dir], { encoding: 'utf8' });
const planted = (file: string, mutate: (s: string) => string) => {
  const dir = mkdtempSync(join(tmpdir(), 'check-workflows-'));
  dirs.push(dir);
  cpSync(WORKFLOWS, dir, { recursive: true });
  writeFileSync(join(dir, file), mutate(readFileSync(join(dir, file), 'utf8')));
  return run(dir);
};
const GROUP = /^( {2}group: [a-z]+-\$\{\{ github\.ref \}\}).+$/m;

it('the real workflows pass', () => {
  const result = run(WORKFLOWS);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});

it.each(['ci.yml', 'security.yml'])('%s with the old per-ref group fails', (file) => {
  expect(GROUP.test(readFileSync(join(WORKFLOWS, file), 'utf8'))).toBe(true);
  const result = planted(file, (s) => s.replace(GROUP, '$1'));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${file}: the top-level concurrency group has no github.sha part for a push`);
});

it('the commit part in a job-level group does not count', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template.
  const commit = "-${{ github.event_name == 'pull_request' && 'pr' || github.sha }}";
  const job = /^ {4}concurrency:\n {6}group: release$/m;
  expect(job.test(readFileSync(join(WORKFLOWS, 'ci.yml'), 'utf8'))).toBe(true);
  const result = planted('ci.yml', (s) => s.replace(GROUP, '$1').replace(job, (m) => m + commit));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ci.yml: the top-level concurrency group has no github.sha part for a push');
});

it('a workflow without a top-level concurrency fails', () => {
  const result = planted('ci.yml', (s) => s.replace(/^concurrency:\n(?: {2}.*\n)+/m, ''));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ci.yml: the top-level concurrency group has no github.sha part for a push');
});
