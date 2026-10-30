import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

// A real local stand-in for the F1 SignalR endpoint: node:http and hand-written WebSocket frames, no dependency. It
// sends only what a test tells it to, so every stream is finite.

const RS = '\x1e';

/** An unmasked server text frame. */
const frame = (text: string): Buffer => {
  const body = Buffer.from(text);
  const n = body.length;
  if (n < 126) return Buffer.concat([Buffer.from([0x81, n]), body]);
  if (n < 65_536) {
    const head = Buffer.from([0x81, 126, 0, 0]);
    head.writeUInt16BE(n, 2);
    return Buffer.concat([head, body]);
  }
  const head = Buffer.alloc(10);
  head[0] = 0x81;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(n), 2);
  return Buffer.concat([head, body]);
};

/** Whole masked client frames off the front of `buf`: opcode and text, and what is left over. */
function readFrames(buf: Buffer): { frames: { opcode: number; text: string }[]; rest: Buffer } {
  const frames: { opcode: number; text: string }[] = [];
  let at = 0;
  while (buf.length - at >= 6) {
    const first = buf.readUInt8(at);
    const short = buf.readUInt8(at + 1) & 0x7f;
    const headLength = short === 126 ? 8 : 6; // the client only sends small frames: never the 64-bit length
    if (buf.length - at < headLength) break;
    const n = short === 126 ? buf.readUInt16BE(at + 2) : short;
    if (buf.length - at < headLength + n) break;
    const mask = buf.subarray(at + headLength - 4, at + headLength);
    const body = Buffer.from(buf.subarray(at + headLength, at + headLength + n));
    for (let i = 0; i < n; i++) body.writeUInt8(body.readUInt8(i) ^ mask.readUInt8(i % 4), i);
    frames.push({ opcode: first & 0x0f, text: body.toString() });
    at += headLength + n;
  }
  return { frames, rest: buf.subarray(at) };
}

export type Seen = { step: 'options' | 'negotiate' | 'upgrade'; cookie?: string; authorization?: string };
export type FeedMessage = [topic: string, payload: unknown, ts?: string];

const feedFrames = (messages: FeedMessage[]) =>
  messages.map((args) => frame(JSON.stringify({ type: 1, target: 'feed', arguments: args }) + RS));

export type FakeSignalR = {
  base: string;
  connectionToken: string;
  /** What the handlers saw, in order. */
  seen: Seen[];
  /** The topic list of every Subscribe. */
  subscribes: unknown[];
  /** Programmable per test. */
  behaviour: {
    negotiateStatus?: number;
    optionsCookie?: boolean;
    handshakeError?: string;
    subscribeError?: string;
    /** The upgrade request is never answered. */
    hangUpgrade?: boolean;
    /** No handshake answer, no anything: the socket opens and stays silent. */
    silent?: boolean;
    /** The full state the next Subscribe answers with. */
    fullState: unknown;
    /** Feed messages that go out in the same TCP write as the Subscribe answer. */
    afterSubscribe?: FeedMessage[];
  };
  /** The upgrades so far (each one is a real TCP connection). */
  connections(): number;
  /** Sends the feed messages on the open socket, each in its own frame but all in one TCP write. */
  feed(messages: FeedMessage[]): void;
  /** Any SignalR record as-is, one frame. */
  record(message: unknown): void;
  /** One frame of raw text. */
  raw(text: string): void;
  /** A WebSocket close frame with this code. */
  closeFrame(code: number): void;
  /** Ends the TCP connection with no close frame, after what was already written has gone out. */
  drop(): void;
  stop(): Promise<void>;
};

export async function startFakeSignalR(): Promise<FakeSignalR> {
  const seen: Seen[] = [];
  const subscribes: unknown[] = [];
  const behaviour: FakeSignalR['behaviour'] = { fullState: {} };
  const connectionToken = 'fake-connection-token';
  const sockets = new Set<Duplex>();
  let open: Duplex | undefined;
  let connections = 0;

  const note = (step: Seen['step'], req: IncomingMessage) =>
    seen.push({
      step,
      ...(req.headers.cookie === undefined ? {} : { cookie: req.headers.cookie }),
      ...(req.headers.authorization === undefined ? {} : { authorization: req.headers.authorization }),
    });

  const http = createServer((req, res) => {
    if (req.method === 'OPTIONS' && req.url?.startsWith('/signalrcore/negotiate')) {
      note('options', req);
      res.writeHead(405, behaviour.optionsCookie === false ? {} : { 'Set-Cookie': 'AWSALBCORS=fake-alb; Path=/' });
      return res.end();
    }
    if (req.method === 'POST' && req.url?.startsWith('/signalrcore/negotiate')) {
      note('negotiate', req);
      if (behaviour.negotiateStatus !== undefined) {
        res.writeHead(behaviour.negotiateStatus);
        return res.end('negotiate says no, see https://secret.example/there');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ connectionToken }));
    }
    res.writeHead(404);
    res.end();
  });

  http.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    note('upgrade', req);
    connections++;
    if (behaviour.hangUpgrade) return;
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    open = socket;
    let pending: Buffer = Buffer.alloc(0);
    let handshaken = false;
    socket.on('data', (chunk: Buffer) => {
      const { frames, rest } = readFrames(Buffer.concat([pending, chunk]));
      pending = rest;
      for (const { opcode, text } of frames) {
        if (opcode === 8) {
          socket.end(Buffer.from([0x88, 0]));
          continue;
        }
        if (behaviour.silent) continue;
        for (const record of text.split(RS).filter(Boolean)) {
          const msg = JSON.parse(record) as { target?: string; invocationId?: string; arguments?: unknown[] };
          if (!handshaken) {
            handshaken = true;
            const answer = behaviour.handshakeError === undefined ? {} : { error: behaviour.handshakeError };
            socket.write(frame(JSON.stringify(answer) + RS));
          } else if (msg.target === 'Subscribe') {
            subscribes.push(msg.arguments?.[0]);
            const answer =
              behaviour.subscribeError === undefined
                ? { type: 3, invocationId: msg.invocationId, result: behaviour.fullState }
                : { type: 3, invocationId: msg.invocationId, error: behaviour.subscribeError };
            socket.write(
              Buffer.concat([frame(JSON.stringify(answer) + RS), ...feedFrames(behaviour.afterSubscribe ?? [])]),
            );
          }
        }
      }
    });
  });

  await new Promise<void>((res) => http.listen(0, '127.0.0.1', res));
  const { port } = http.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}/signalrcore`,
    connectionToken,
    seen,
    subscribes,
    behaviour,
    connections: () => connections,
    feed: (messages) => void open?.write(Buffer.concat(feedFrames(messages))),
    record: (message) => void open?.write(frame(JSON.stringify(message) + RS)),
    raw: (text) => void open?.write(frame(text)),
    closeFrame(code) {
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code);
      open?.write(Buffer.concat([Buffer.from([0x88, 2]), body]));
    },
    drop: () => void (open as (Duplex & { destroySoon?: () => void }) | undefined)?.destroySoon?.(),
    async stop() {
      for (const s of sockets) s.destroy();
      http.closeAllConnections();
      await new Promise((res) => http.close(res));
    },
  };
}
