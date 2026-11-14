import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Invariant 3 (A§12.1, #108): no F1 TV feed or archive data, FIA timing PDF or Jolpica dump in git,
// force-added files included. Parser fixtures are synthetic, in their own folders, and small.

const ROOT = join(import.meta.dirname, '..');
/**
 * Never, anywhere: the private folder, recorder files (feed-*.jsonl, *.gz), the archive's Index.json,
 * audio and transcripts (P6), PDFs (the FIA's) and zips (the Jolpica dump).
 */
const NEVER =
  /(^|\/)fixtures-private\/|(^|\/)feed-[^/]*\.jsonl|(^|\/)Index\.json$|\.(gz|zip|pdf|mp3|wav|m4a|aac|ogg|opus|flac|vtt|srt)$/i;
/** Feed, archive and dump files: each kind only in its own synthetic fixture folder. */
const DATA = /\.(jsonl|jsonStream)$|(^|\/)formula_one_[^/]*\.csv$|(^|\/)archive\/.+\.json$/i;
const SYNTHETIC =
  /^apps\/server\/test\/fixtures\/(live\/[^/]+\.jsonl|archive\/.+\.json(Stream)?|jolpica\/formula_one_[^/]+\.csv)$/i;
const FOLDERS = /^apps\/server\/test\/fixtures\/(live|archive|jolpica)\//;
const CAP = 32 * 1024; // the largest synthetic fixture is 8.4 KB; real files are megabytes
const MAX = 1024 * 1024; // any file: the largest today is a 417 KB design render

/** git as the test needs it: no GIT_DIR or GIT_INDEX_FILE from a hook, no global ignore file. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'core.excludesFile=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  });

/** The index's paths with their blob sizes, so a file deleted from the working tree still counts. */
const tracked = (cwd: string) =>
  git(cwd, 'ls-files', '-z', '--format=%(objectsize) %(path)')
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(' ');
      return { size: Number(line.slice(0, space)), path: line.slice(space + 1) };
    });

const offending = (files: { path: string; size: number }[]) =>
  files
    .filter(
      ({ path, size }) =>
        NEVER.test(path) || (DATA.test(path) && !SYNTHETIC.test(path)) || size > (FOLDERS.test(path) ? CAP : MAX),
    )
    .map(({ path }) => path)
    .sort();

describe('no F1 data in git (invariant 3)', () => {
  it('the tree holds none', () => {
    const files = tracked(ROOT);
    expect(files.length).toBeGreaterThan(100);
    expect(files.some(({ path }) => SYNTHETIC.test(path))).toBe(true);
    expect(offending(files)).toEqual([]);
  });

  it('fails on a planted feed-1.jsonl.gz, an .mp3 and a force-added fixtures-private/ file', () => {
    const repo = mkdtempSync(join(tmpdir(), 'f1-no-data-'));
    try {
      const plant = (path: string, size = 10) => {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), 'x'.repeat(size));
      };
      const planted = [
        'feed-1.jsonl.gz',
        'live/1-2/feed-3.jsonl',
        'docs/clip.mp3',
        'fixtures-private/archive/11408/TimingData.jsonStream',
        'docs/notes.jsonl',
        'TimingData.jsonStream',
        'snapshots/1.json.gz',
        'data/formula_one_lap.csv',
        'jolpica-f1-csv.zip',
        'docs/Race Classification.pdf',
        'apps/server/test/fixtures/live/feed-1.jsonl',
        'apps/server/test/fixtures/archive/race/feed.jsonl', // a kind outside its own folder
        'apps/server/test/fixtures/jolpica/TimingData.jsonStream',
        ...['wav', 'm4a', 'aac', 'ogg', 'opus', 'FLAC', 'vtt', 'srt'].map((ext) => `radio/clip.${ext}`),
        'docs/a.json.gz',
        '2023/meeting/race/Index.json',
        'data/archive/2023/race/TimingData.json', // an archive keyframe outside the synthetic folder
      ];
      for (const path of planted) plant(path);
      plant('apps/server/test/fixtures/live/big.jsonl', CAP + 1);
      plant('docs/render.webp', MAX + 1);
      for (const ok of [
        'apps/server/test/fixtures/live/race.jsonl',
        'apps/server/test/fixtures/archive/race/TimingData.jsonStream',
        'apps/server/test/fixtures/archive/index-2019.json',
        'apps/server/test/fixtures/jolpica/formula_one_lap.csv',
        'apps/server/src/openf1/fixtures/laps-normal.raw',
      ])
        plant(ok, CAP);
      plant('docs/overview.webp', MAX);
      writeFileSync(join(repo, '.gitignore'), 'fixtures-private/\n'); // hence the force-add below
      git(repo, 'init', '-q');
      git(repo, 'add', '-A');
      git(repo, 'add', '-f', 'fixtures-private/archive/11408/TimingData.jsonStream');
      expect(offending(tracked(repo))).toEqual(
        [...planted, 'apps/server/test/fixtures/live/big.jsonl', 'docs/render.webp'].sort(),
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
