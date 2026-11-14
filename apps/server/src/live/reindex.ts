import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { z } from 'zod';
import { codeOf, type DB } from '../db/db.ts';
import { openFile, recordingLines } from './recording.ts';

// reindex-recordings (#109, A§11.2): a `recording` row for every recorder directory that has none, after a database
// loss. The files are `live`'s (A§12.1): the path, session_key and started_at come from the directory name only, never
// from a file; `complete` only from a recording.json that names the same session and start. Each directory is read
// once (O_NOFOLLOW, regular files only, MAX_LINE), which proves it readable. Logs carry fixed fields only, never file
// text.

const NAME = /^(\d{1,9})-(\d{1,15})$/;
const MAX_JSON = 4096;

export type ReindexDeps = { db: Kysely<DB>; log: Pick<Logger, 'info' | 'error'>; liveDir: string };

/** recording.json's `complete` when it names this session and start; false for anything else (absent, big, bad, FIFO). */
async function completeOf(dir: string, key: number, startedAt: string): Promise<boolean> {
  const fh = await openFile(join(dir, 'recording.json')).catch(() => undefined);
  if (!fh) return false;
  try {
    const buf = Buffer.alloc(MAX_JSON + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_JSON) return false;
    const meta = z
      .looseObject({ session_key: z.literal(key), started_at: z.literal(startedAt), complete: z.boolean() })
      .safeParse(JSON.parse(buf.toString('utf8', 0, bytesRead)));
    return meta.success && meta.data.complete;
  } catch {
    return false;
  } finally {
    await fh.close();
  }
}

/** True when no directory failed. A directory that has a row is left as it is. */
export async function reindexRecordings({ db, log, liveDir }: ReindexDeps): Promise<boolean> {
  const started = performance.now();
  const paths = (await readdir(liveDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && NAME.test(d.name)) // a symlink is no directory here
    .map((d) => d.name)
    .sort();
  const known = new Set((await db.selectFrom('recording').select('path').execute()).map((r) => r.path));
  let [inserted, existing, failed] = [0, 0, 0];
  const failure = (path: string, error: string, cause: string) => {
    failed++;
    log.error({ path, error, cause }, 'reindex');
  };
  for (const path of paths) {
    if (known.has(path)) {
      existing++;
      continue;
    }
    const [, key, ms] = NAME.exec(path) ?? [];
    const [session_key, startedAt] = [Number(key), new Date(Number(ms))];
    const dir = join(liveDir, path);
    let bytes = 0;
    let last = startedAt.getTime();
    let complete: boolean;
    let endedAt: Date;
    try {
      for await (const line of recordingLines(dir)) {
        bytes += Buffer.byteLength(line.text) + 1; // the recorder's count: each line and its newline
        last = line.r;
      }
      endedAt = new Date(last); // a safe integer beyond 8.64e15 ms is no time: this directory fails, not the run
      if (Number.isNaN(endedAt.getTime())) throw Object.assign(new Error('bad_time'), { code: 'bad_time' });
      complete = await completeOf(dir, session_key, startedAt.toISOString());
    } catch (err) {
      failure(path, 'unreadable', codeOf(err));
      continue;
    }
    try {
      const { numInsertedOrUpdatedRows: n } = await db
        .insertInto('recording')
        .values({ session_key, path, started_at: startedAt, ended_at: endedAt, bytes, complete })
        .onConflict((oc) => oc.column('path').doNothing())
        .executeTakeFirstOrThrow();
      if (!n) {
        existing++; // the daemon's row, made since the listing
        continue;
      }
    } catch (err) {
      if (codeOf(err) !== '23503') throw err;
      failure(path, 'no_session', codeOf(err));
      continue;
    }
    inserted++;
    log.info({ session_key, complete }, 'recording reindexed');
  }
  const ms = Math.round(performance.now() - started);
  log[failed === 0 ? 'info' : 'error']({ inserted, existing, failed, ms }, 'reindex_done');
  return failed === 0;
}
