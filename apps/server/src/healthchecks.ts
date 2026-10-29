import type { Logger } from 'pino';
import { readSecret } from './db/migrate.ts';

// The healthchecks.io ping (A§14.5). The ping key is part of the URL, so nothing here logs
// a URL, the key or an error message: fixed codes only.

const KEY = /^[A-Za-z0-9_-]{22}$/;

/**
 * Pings `https://hc-ping.com/<key>/<slug>` with the key from the file secret `hc_ping_key`.
 * No secret file (dev, tests) means no request. Never throws: a failed ping is logged as a
 * code and the work that called it goes on.
 */
export async function pingHealthchecks(
  slug: string,
  log: Pick<Logger, 'error'>,
  { secretsDir, timeoutMs = 10_000 }: { secretsDir?: string; timeoutMs?: number } = {},
): Promise<void> {
  const key = readSecret('hc_ping_key', secretsDir);
  if (key === undefined) return;
  if (!KEY.test(key)) {
    log.error({ last_error: 'hc_key_invalid' }, 'healthchecks');
    return;
  }
  try {
    const res = await fetch(`https://hc-ping.com/${key}/${slug}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel();
    if (!res.ok) log.error({ last_error: 'hc_ping_failed', status: res.status }, 'healthchecks');
  } catch {
    log.error({ last_error: 'hc_ping_failed' }, 'healthchecks'); // not the error: its message can quote the URL
  }
}
