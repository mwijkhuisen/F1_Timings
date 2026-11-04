// The topic list and the AWSALBCORS cookie step follow FastF1 3.9.0 fastf1/livetiming/client.py:
//
// MIT License
//
// Copyright (c) 2026 Philipp Schäfer
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
// Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
// WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
// COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

// A hand-rolled SignalR Core client for the F1 live feed (A§11.1): negotiate, then the JSON hub protocol on Node's
// global WebSocket (undici). A close carries fixed codes and numbers only: never the server's text, a URL, a header
// or an error message (A§12.1 #1).

export const TOPICS = [
  'Heartbeat',
  'DriverList',
  'ExtrapolatedClock',
  'RaceControlMessages',
  'SessionInfo',
  'SessionStatus',
  'SessionData',
  'TimingAppData',
  'TimingStats',
  'TimingData',
  'TrackStatus',
  'WeatherData',
  'TopThree',
  'LapCount',
  'TeamRadio',
  'RcmSeries',
  'AudioStreams',
  'ContentStreams',
  'CarData.z',
  'Position.z',
];

/** The `feed_*` values of `recorder_status.last_error`. */
export type FeedCode =
  | 'feed_unauthorized'
  | 'feed_options'
  | 'feed_negotiate'
  | 'feed_socket'
  | 'feed_parse'
  | 'feed_handshake'
  | 'feed_subscribe'
  | 'feed_timeout';
/** No `error` is a clean close. */
export type Closed = { error?: FeedCode; closeCode?: number; status?: number };
export type Conn = { subscribed: Promise<unknown>; closed: Promise<Closed>; close(): void };
export type OnFeed = (topic: string, payload: unknown, ts: string, receivedAt: number) => void;
export type ConnectOptions = {
  base?: string;
  pingMs?: number;
  idleMs?: number;
  /**
   * The Subscribe result, in order with the `onFeed` calls. `subscribed` cannot give that: a promise reaction runs
   * only after every frame of the same network read has gone through `onFeed`, so the full state would land after
   * the newer deltas that follow it.
   */
  onSubscribed?: (result: unknown, receivedAt: number) => void;
};

const BASE = 'https://livetiming.formula1.com/signalrcore';
const RS = '\x1e';
const HTTP_TIMEOUT_MS = 30_000;

export function connect(
  token: string | undefined,
  onFeed: OnFeed,
  { base = BASE, pingMs = 15_000, idleMs = 30_000, onSubscribed }: ConnectOptions = {},
): Conn {
  let ws: WebSocket | undefined;
  let done = false;
  let ping: ReturnType<typeof setInterval> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let resolveSub: (v: unknown) => void = () => {};
  let rejectSub: (e: Error) => void = () => {};
  let resolveClosed: (c: Closed) => void = () => {};
  const subscribed = new Promise<unknown>((res, rej) => {
    resolveSub = res;
    rejectSub = rej;
  });
  subscribed.catch(() => {}); // the caller may never await it
  const closed = new Promise<Closed>((res) => {
    resolveClosed = res;
  });

  const finish = (c: Closed) => {
    if (done) return;
    done = true;
    clearInterval(ping);
    clearTimeout(idle);
    rejectSub(new Error('closed before the subscribe completed'));
    resolveClosed(c);
    ws?.close(1000);
  };
  const send = (msg: object) => ws?.send(JSON.stringify(msg) + RS);
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => finish({ error: 'feed_timeout' }), idleMs);
  };

  let step: FeedCode = 'feed_options';
  (async () => {
    // The OPTIONS answer is a 405 but sets the load balancer's sticky cookie, which negotiate and the socket must carry.
    const options = await fetch(`${base}/negotiate`, {
      method: 'OPTIONS',
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    await options.body?.cancel();
    const alb = options.headers
      .getSetCookie()
      .map((c) => /^AWSALBCORS=([^;]*)/.exec(c)?.[1])
      .find((v) => v !== undefined);
    if (!alb) return finish({ error: 'feed_options', status: options.status });
    if (done) return;

    step = 'feed_negotiate';
    const headers: Record<string, string> = { Cookie: `AWSALBCORS=${alb}` };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}/negotiate?negotiateVersion=1`, {
      method: 'POST',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return finish({ error: 'feed_unauthorized', status: res.status });
    if (!res.ok) return finish({ error: 'feed_negotiate', status: res.status });
    const { connectionToken } = (await res.json()) as { connectionToken?: unknown };
    if (typeof connectionToken !== 'string') return finish({ error: 'feed_negotiate', status: res.status });
    if (done) return;

    step = 'feed_socket';
    // Also covers an upgrade that never answers: undici has no handshake timeout of its own.
    resetIdle();
    // undici's WebSocketInit takes headers (non-standard), so the cookie and token reach the upgrade request.
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}?id=${encodeURIComponent(connectionToken)}`, {
      headers,
    });
    ws = socket;
    socket.binaryType = 'arraybuffer';
    let handshaken = false;
    let buf = '';
    let failed = false;

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
      ping = setInterval(() => send({ type: 6 }), pingMs);
      resetIdle();
    });
    socket.addEventListener('error', () => {
      failed = true;
    });
    socket.addEventListener('close', (ev) =>
      finish({ closeCode: ev.code, ...(failed || !ev.wasClean ? { error: 'feed_socket' } : {}) }),
    );
    socket.addEventListener('message', (ev) => {
      if (done) return; // after finish(): no feed lines past the close event, no re-armed idle timer
      const receivedAt = Date.now();
      resetIdle();
      buf += typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString();
      const records = buf.split(RS);
      buf = records.pop() ?? '';
      for (const record of records) {
        let msg: { type?: number; target?: string; arguments?: unknown[]; invocationId?: string; error?: unknown };
        try {
          msg = JSON.parse(record);
        } catch {
          return finish({ error: 'feed_parse' });
        }
        if (!handshaken) {
          // The first record answers the handshake: {} or {"error": "..."}.
          if (typeof msg.error === 'string') return finish({ error: 'feed_handshake' });
          handshaken = true;
          send({ type: 1, invocationId: '1', target: 'Subscribe', arguments: [TOPICS] });
        } else if (msg.type === 1 && msg.target === 'feed') {
          const [topic, payload, ts] = msg.arguments ?? [];
          onFeed(String(topic), payload, String(ts), receivedAt);
        } else if (msg.type === 3 && msg.invocationId === '1') {
          // Without the subscribe nothing will ever arrive: end the connection, so the caller reconnects.
          if (typeof msg.error === 'string') return finish({ error: 'feed_subscribe' });
          const { result } = msg as { result?: unknown };
          onSubscribed?.(result, receivedAt);
          resolveSub(result);
        } else if (msg.type === 7) {
          // The server's close message; the socket close follows and carries the code.
          if (typeof msg.error === 'string') failed = true;
          socket.close(1000);
        }
        // type 6 (ping) only resets the idle timer.
      }
    });
  })().catch(() => finish({ error: step }));

  return { subscribed, closed, close: () => finish({}) };
}
