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
// global WebSocket (undici). P2a compares it with @microsoft/signalr (lib.ts).

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

export type Closed = {
  code?: number;
  reason?: string;
  allowReconnect?: boolean;
  error?: { step: string; name?: string; code?: string; status?: number };
};
export type Conn = { subscribed: Promise<unknown>; closed: Promise<Closed>; close(): void };
export type OnFeed = (topic: string, payload: unknown, ts: string, receivedAt: number) => void;
/** Progress for events.jsonl: 'negotiated' and 'open' (the handshake answered). */
export type OnStep = (step: string) => void;

const BASE = 'https://livetiming.formula1.com/signalrcore';
const RS = '\x1e';
const PING_MS = 15_000;
const IDLE_MS = 30_000;
const HTTP_TIMEOUT_MS = 30_000;

/** An HTTP step failed. Only the step and status are kept: never a URL, a header or a body. */
export class StepError extends Error {
  step: string;
  status: number | undefined;
  constructor(step: string, status?: number) {
    super(`${step} failed${status === undefined ? '' : ` with ${status}`}`);
    this.step = step;
    this.status = status;
  }
}

export function toError(err: unknown, step: string): NonNullable<Closed['error']> {
  const e = err as { name?: string; code?: string; cause?: { code?: string }; step?: string; status?: number };
  return { step: e?.step ?? step, name: e?.name, code: e?.code ?? e?.cause?.code, status: e?.status };
}

/** The OPTIONS answer is a 405 but sets the load balancer's sticky cookie, which negotiate and the socket must carry. */
export async function albCookie(): Promise<string> {
  const res = await fetch(`${BASE}/negotiate`, {
    method: 'OPTIONS',
    redirect: 'error',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const value = res.headers
    .getSetCookie()
    .map((c) => /^AWSALBCORS=([^;]*)/.exec(c)?.[1])
    .find((v) => v !== undefined);
  if (!value) throw new StepError('options', res.status);
  return `AWSALBCORS=${value}`;
}

export function connect(token: string | undefined, onFeed: OnFeed, onStep: OnStep = () => {}): Conn {
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
    idle = setTimeout(() => finish({ reason: 'no frame for 30 s', error: { step: 'timeout' } }), IDLE_MS);
  };

  let step = 'options';
  (async () => {
    const cookie = await albCookie();
    step = 'negotiate';
    if (done) return;
    const headers: Record<string, string> = { Cookie: cookie };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${BASE}/negotiate?negotiateVersion=1`, {
      method: 'POST',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new StepError('negotiate', res.status);
    const { connectionToken } = (await res.json()) as { connectionToken?: unknown };
    if (typeof connectionToken !== 'string') throw new StepError('negotiate', res.status);
    if (done) return;
    onStep('negotiated');
    step = 'socket';

    // undici's WebSocketInit takes headers (non-standard), so the cookie and token reach the upgrade request.
    const socket = new WebSocket(
      `wss://livetiming.formula1.com/signalrcore?id=${encodeURIComponent(connectionToken)}`,
      {
        headers,
      },
    );
    ws = socket;
    socket.binaryType = 'arraybuffer';
    let handshaken = false;
    let buf = '';
    let socketError: Closed['error'];
    let serverClose: Closed = {};

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
      ping = setInterval(() => send({ type: 6 }), PING_MS);
      resetIdle();
    });
    socket.addEventListener('error', (ev) => {
      socketError = toError((ev as ErrorEvent).error, 'socket');
    });
    socket.addEventListener('close', (ev) =>
      finish({ ...serverClose, code: ev.code, reason: ev.reason || serverClose.reason, error: socketError }),
    );
    socket.addEventListener('message', (ev) => {
      if (done) return; // after finish(): no feed lines past the close event, no re-armed idle timer
      const receivedAt = Date.now();
      resetIdle();
      buf += typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString();
      const records = buf.split(RS);
      buf = records.pop() ?? '';
      for (const record of records) {
        let msg: { type?: number; target?: string; arguments?: unknown[]; invocationId?: string } & Record<
          string,
          unknown
        >;
        try {
          msg = JSON.parse(record);
        } catch {
          return finish({ reason: 'unparsable frame', error: { step: 'parse' } });
        }
        if (!handshaken) {
          // The first record answers the handshake: {} or {"error": "..."}.
          if (typeof msg.error === 'string') return finish({ reason: msg.error, error: { step: 'handshake' } });
          handshaken = true;
          onStep('open');
          send({ type: 1, invocationId: '1', target: 'Subscribe', arguments: [TOPICS] });
        } else if (msg.type === 1 && msg.target === 'feed') {
          const [topic, payload, ts] = msg.arguments ?? [];
          onFeed(String(topic), payload, String(ts), receivedAt);
        } else if (msg.type === 3 && msg.invocationId === '1') {
          if (typeof msg.error === 'string') rejectSub(new StepError('subscribe'));
          else resolveSub(msg.result);
        } else if (msg.type === 7) {
          // The server's close message; the socket close follows and carries the code.
          serverClose = {
            reason: typeof msg.error === 'string' ? msg.error : undefined,
            allowReconnect: !!msg.allowReconnect,
          };
          socket.close(1000);
        }
        // type 6 (ping) only resets the idle timer.
      }
    });
  })().catch((err) => finish({ error: toError(err, step) }));

  return { subscribed, closed, close: () => finish({ reason: 'client close' }) };
}
