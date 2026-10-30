import type { HubConnection } from '@microsoft/signalr';
import { HttpTransportType, HubConnectionBuilder, LogLevel } from '@microsoft/signalr';
import { albCookie, type Closed, type Conn, type OnFeed, type OnStep, TOPICS, toError } from './native.ts';

// The same connect() as native.ts on @microsoft/signalr (A§11.1). No withAutomaticReconnect: record.ts reconnects
// both clients the same way. Logging is off because the library logs URLs with ?id=<connectionToken>.
//
// The library exposes no close code or negotiate status as fields: a failed negotiate is a
// FailedToNegotiateWithServerError and an unclean socket close an Error, each with the number only in its message.
// We read just that number from the message and drop the rest.

const HUB = 'https://livetiming.formula1.com/signalrcore';

function libError(err: unknown): Closed {
  const e = toError(err, 'lib');
  const message = err instanceof Error ? err.message : '';
  const status = (err as { statusCode?: number })?.statusCode ?? Number(/Status code '(\d+)'/.exec(message)?.[1]);
  const code = Number(/status code: (\d+)/.exec(message)?.[1]);
  return {
    code: Number.isNaN(code) ? undefined : code,
    error: { step: e.step === 'options' ? 'options' : 'lib', name: e.name, code: e.code, status: status || e.status },
  };
}

export function connect(token: string | undefined, onFeed: OnFeed, onStep: OnStep = () => {}): Conn {
  let hub: HubConnection | undefined;
  let stopped = false;
  let started = false;
  let resolveClosed: (c: Closed) => void = () => {};
  const closed = new Promise<Closed>((res) => {
    resolveClosed = res;
  });

  const subscribed = (async () => {
    const cookie = await albCookie();
    if (stopped) throw new Error('closed');
    hub = new HubConnectionBuilder()
      .withUrl(HUB, {
        transport: HttpTransportType.WebSockets,
        headers: { Cookie: cookie },
        ...(token ? { accessTokenFactory: () => token } : {}),
      })
      .configureLogging(LogLevel.None)
      .build();
    hub.on('feed', (topic: string, payload: unknown, ts: string) => onFeed(topic, payload, ts, Date.now()));
    hub.onclose((err) => resolveClosed(err ? libError(err) : { reason: stopped ? 'client close' : undefined }));
    await hub.start();
    started = true;
    onStep('open');
    return hub.invoke('Subscribe', TOPICS);
  })();
  // A failed start() never calls onclose, so it closes the conn here. A failed Subscribe leaves the hub open.
  subscribed.catch((err) => {
    if (!started) resolveClosed(stopped ? { reason: 'client close' } : libError(err));
  });

  return {
    subscribed,
    closed,
    close: () => {
      stopped = true;
      if (hub) void hub.stop();
      else resolveClosed({ reason: 'client close' });
    },
  };
}
