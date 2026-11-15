// @vitest-environment happy-dom
import { Lap, type Live as LiveData, type Recordings, SessionDetail, view, weatherRow } from '@f1/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { HttpError, isStale, markStale } from '../src/lib/api.ts';
import { useTitle } from '../src/lib/routes.ts';
import { MAX_HELD, openStream, streamUrl } from '../src/lib/stream.ts';
import { fmtClock } from '../src/lib/time.ts';
import { OFFLINE } from '../src/ui/ErrorView.tsx';
import { Live, Replay } from '../src/views/Live.tsx';
import { Player, type PlayerRecording } from '../src/views/Player.tsx';
import { practiceState, qualifyingState, raceState } from './feed-state.ts';
import { fetched } from './laps.ts';

// `view` (a zod parse of a topic) counts what the tower, the pit wall and the status series derive from the state.
vi.mock('@f1/contracts', async (load) => {
  const m = await load<typeof import('@f1/contracts')>();
  return { ...m, view: vi.fn(m.view) };
});

// markStale calls through: a test sees that a stream event that fails its contract raises the app-wide flag.
vi.mock('../src/lib/api.ts', async (load) => {
  const m = await load<typeof import('../src/lib/api.ts')>();
  return { ...m, markStale: vi.fn(m.markStale) };
});

// The Weather tab's chart (P5b): a stub ECharts that keeps every option set, so a test sees each redraw.
type Option = { series: { data: [number, number | null][] }[] };
const chart = vi.hoisted(() => ({ options: [] as Option[] }));
vi.mock('../src/lib/echarts.ts', () => ({
  init: () => ({
    setOption: (o: Option) => chart.options.push(o),
    resize() {},
    dispose() {},
  }),
}));

// The tower throws while `towerMock.fail` is on (#100: the per-tab error boundary); else it is the real one.
const towerMock = vi.hoisted(() => ({ fail: false }));
vi.mock('../src/views/Tower.tsx', async (load) => {
  const m = await load<typeof import('../src/views/Tower.tsx')>();
  const { createElement } = await import('react');
  return {
    ...m,
    Tower: (props: Parameters<typeof m.Tower>[0]) => {
      if (towerMock.fail) throw new Error('tower');
      return createElement(m.Tower, props);
    },
  };
});

// The player (A§13, A§15): a real React tree in happy-dom, a fake EventSource, fake timers, a stubbed fetch.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeES {
  static all: FakeES[] = [];
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(url: string) {
    this.url = url;
    FakeES.all.push(this);
  }
  addEventListener(name: string, f: (e: MessageEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), f]);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, data?: unknown) {
    // P5b: a snapshot carries `weather`; the tests that are not about it leave it out.
    if (name === 'snapshot' && data && typeof data === 'object' && !('weather' in data))
      data = { ...data, weather: [] };
    const e = new MessageEvent(name, { data: data === undefined ? undefined : JSON.stringify(data) });
    act(() => {
      for (const f of this.listeners.get(name) ?? []) f(e);
    });
  }
}

const S = Date.parse('2026-10-25T19:00:00.000Z');
const E = Date.parse('2026-10-25T21:00:00.000Z');
const NOW = Date.parse('2026-10-25T22:00:00.000Z');
const ended: PlayerRecording = { id: 7, started_at: new Date(S).toISOString(), ended_at: new Date(E).toISOString() };
const open: PlayerRecording = { ...ended, ended_at: null };

let root: Root;
let host: HTMLElement;

/** The failure probe's fetch (#100): by default it never answers, and rejects on abort, so no probe text shows. */
const pending = (_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) =>
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
  );
let fetchStub = vi.fn(pending);

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  FakeES.all = [];
  vi.stubGlobal('EventSource', FakeES);
  fetchStub = vi.fn(pending);
  vi.stubGlobal('fetch', fetchStub);
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// The Weather tab's rain map reads the query cache (P5c); no query runs, so a test fills what it needs beforehand.
let client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
});
const render = (props: Partial<Parameters<typeof Player>[0]>) =>
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <Player recording={open} start="live" detail={undefined} {...props} />
      </QueryClientProvider>,
    ),
  );
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const $ = <T extends Element>(sel: string) => {
  const el = host.querySelector<T>(sel);
  if (!el) throw new Error(`no ${sel}`);
  return el;
};
const click = (label: string) => act(() => $<HTMLButtonElement>(`button[aria-label="${label}"]`).click());
const button = (text: string) => {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent === text);
  if (!b) throw new Error(`no button ${text}`);
  act(() => b.click());
};
// React listens to `input`; the native setter bypasses its value tracker, as a real drag does.
const slide = (label: string, v: number) =>
  act(() => {
    const el = $<HTMLInputElement>(`input[aria-label="${label}"]`);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
const delayShown = () => Number($<HTMLInputElement>('input[aria-label="Delay"]').value);
const last = () => FakeES.all.at(-1) as FakeES;
const atOf = (es: FakeES) => new URL(es.url, 'http://x').searchParams.get('at');
/** `still=1` marks a still frame's open for the server's open log (#101); a playing stream has none. */
const stillOf = (es: FakeES) => new URL(es.url, 'http://x').searchParams.get('still');
const openCount = () => FakeES.all.filter((e) => !e.closed).length;

describe('streamUrl', () => {
  it('builds live and replay URLs', () => {
    expect(streamUrl({ recording: 7, at: 'live', delay: 12 })).toBe('/api/v1/playback/7/stream?at=live&delay=12');
    expect(streamUrl({ recording: 7, at: 1234, delay: 12 })).toBe('/api/v1/playback/7/stream?at=1234');
    expect(streamUrl({ recording: 7, at: 1234, delay: 12, still: true })).toBe(
      '/api/v1/playback/7/stream?at=1234&still=1',
    );
    // A still frame is a replay at T: live never carries it.
    expect(streamUrl({ recording: 7, at: 'live', delay: 12, still: true })).toBe(
      '/api/v1/playback/7/stream?at=live&delay=12',
    );
  });
});

describe('openStream hold (#101)', () => {
  const handlers = () => {
    const seen: string[] = [];
    return {
      seen,
      h: {
        onData: (f: { t: number }, kind: string) => seen.push(`${kind} ${f.t - NOW}`),
        onError: () => seen.push('error'),
        onStale: () => seen.push('stale'),
        onEnd: (t: number) => seen.push(`end ${t - NOW}`),
      },
    };
  };
  const delta = (t: number) => ({ t: NOW + t, topic: 'TrackStatus', data: { Status: '1' } });

  it('holds each event for `hold` after its arrival, in order; a change applies at once; a ping is never held', () => {
    const { seen, h } = handlers();
    const s = openStream({ recording: 7, at: 'live', delay: 0 }, h, FakeES as unknown as typeof EventSource);
    s.hold(2_000);
    const es = last();
    es.emit('snapshot', { t: NOW, state: {}, laps: [], stints: [] });
    advance(500);
    es.emit('delta', delta(500));
    es.emit('ping', { t: NOW + 500 });
    advance(1_499);
    expect(seen).toEqual([]);
    advance(1);
    expect(seen).toEqual(['snapshot 0']);
    advance(500);
    expect(seen).toEqual(['snapshot 0', 'delta 500']);
    es.emit('delta', delta(2_500)); // arrives at +2.5 s
    s.hold(5_000); // longer: due at +7.5 s
    advance(4_999);
    expect(seen).toHaveLength(2);
    s.hold(1_000); // shorter: overdue, applied at once
    expect(seen).toEqual(['snapshot 0', 'delta 500', 'delta 2500']);
    s.hold(0);
    es.emit('delta', delta(8_000));
    expect(seen.at(-1)).toBe('delta 8000'); // nothing queued and no hold: as it arrives
    s.close();
  });

  it('a held event that fails its contract is stale at once; close drops the held ones', () => {
    const { seen, h } = handlers();
    const s = openStream({ recording: 7, at: 'live', delay: 0 }, h, FakeES as unknown as typeof EventSource);
    s.hold(5_000);
    const es = last();
    es.emit('snapshot', { t: NOW, state: {}, laps: [], stints: [] });
    es.emit('delta', { t: 'x' });
    expect(seen).toEqual(['stale']);
    expect(es.closed).toBe(true);
    advance(10_000);
    expect(seen).toEqual(['stale']);
    s.close();

    const other = handlers();
    const t = openStream({ recording: 7, at: 'live', delay: 0 }, other.h, FakeES as unknown as typeof EventSource);
    t.hold(5_000);
    last().emit('snapshot', { t: NOW, state: {}, laps: [], stints: [] });
    t.close();
    advance(10_000);
    expect(other.seen).toEqual([]);
  });

  it(`fails as on an error past ${MAX_HELD} held events`, () => {
    const { seen, h } = handlers();
    const s = openStream({ recording: 7, at: 'live', delay: 0 }, h, FakeES as unknown as typeof EventSource);
    s.hold(60_000);
    const es = last();
    const listener = (name: string, data: unknown) => {
      // Straight to the listeners, without a React act() per event.
      for (const f of (es as unknown as { listeners: Map<string, ((e: MessageEvent) => void)[]> }).listeners.get(
        name,
      ) ?? [])
        f(new MessageEvent(name, { data: JSON.stringify(data) }));
    };
    listener('snapshot', { t: NOW, state: {}, laps: [], stints: [], weather: [] });
    for (let i = 1; i < MAX_HELD; i++) listener('delta', delta(i));
    expect(seen).toEqual([]);
    listener('delta', delta(MAX_HELD));
    expect(seen).toEqual(['error']);
    expect(es.closed).toBe(true);
    advance(120_000);
    expect(seen).toEqual(['error']);
    s.close();
  });
});

describe('Player', () => {
  it('a marker before the recording started is not drawn', () => {
    render({ recording: ended, start: S + 3_600_000 });
    const StatusSeries = {
      '0': { Utc: '2026-10-24T17:32:52Z', SessionStatus: 'Started' }, // the day before
      '1': { Utc: new Date(S + 600_000).toISOString(), SessionStatus: 'Started' },
    };
    last().emit('snapshot', { t: S + 3_600_000, state: { SessionData: { StatusSeries } }, laps: [], stints: [] });
    advance(250); // the store's flush
    expect(host.querySelectorAll('.marker')).toHaveLength(1);
  });

  it('delay slider: 0–120 in 1 s steps, ±1/±5/±30 clamp at the bounds', () => {
    render({});
    const input = $<HTMLInputElement>('input[aria-label="Delay"]');
    expect([input.min, input.max, input.step]).toEqual(['0', '120', '1']);
    expect(delayShown()).toBe(0);
    // P4e: the nudges are named for T ("earlier"/"later"); live, earlier is more delay.
    click('30 seconds later');
    click('1 second later');
    expect(delayShown()).toBe(0);
    click('5 seconds earlier');
    click('1 second earlier');
    expect(delayShown()).toBe(6);
    slide('Delay', 118);
    expect(delayShown()).toBe(118);
    expect(host.textContent).toContain('Delay 118 s');
    click('30 seconds earlier');
    expect(delayShown()).toBe(120);
    click('1 second earlier');
    expect(delayShown()).toBe(120);
    click('1 second later');
    expect(delayShown()).toBe(119);
  });

  it('delay is remembered per device, and defaults to 0 when storage throws', () => {
    localStorage.setItem('f1.delay', '45');
    render({});
    expect(delayShown()).toBe(45);
    expect(last().url).toContain('delay=45');
    click('5 seconds earlier'); // P4e: was "Delay +5 s"
    expect(localStorage.getItem('f1.delay')).toBe('50');
    act(() => root.unmount());

    for (const bad of ['121', '-3', '4.5', 'abc']) {
      localStorage.setItem('f1.delay', bad);
      root = createRoot(host);
      render({});
      expect(delayShown()).toBe(0);
      act(() => root.unmount());
    }

    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    root = createRoot(host);
    render({});
    expect(delayShown()).toBe(0);
    click('5 seconds earlier'); // the write throws; the value still shows (P4e: was "Delay +5 s")
    expect(delayShown()).toBe(5);
  });

  // #101: was "a delay change closes the old stream and opens one with the new delay".
  it("live: a delay change at or above the open stream's delay never opens a stream", () => {
    render({});
    expect(FakeES.all).toHaveLength(1);
    const first = last();
    expect(first.url).toBe('/api/v1/playback/7/stream?at=live&delay=0');
    // P4e: was "Delay +1 s" and "Delay +5 s".
    click('1 second earlier');
    advance(100);
    click('5 seconds earlier');
    advance(300);
    slide('Delay', 9);
    advance(1_000);
    // Back down to the stream's own delay: the held events are due, nothing is missing.
    slide('Delay', 0);
    advance(1_000);
    expect(FakeES.all).toHaveLength(1);
    expect(first.closed).toBe(false);
    expect(openCount()).toBe(1);
  });

  describe('live delay without a reopen (#101)', () => {
    const light = () => host.querySelector('.strip .lw')?.textContent;
    const clock = () => $('.clockline time').textContent;
    const yellow = { topic: 'TrackStatus', data: { Status: '2' } };
    const delayOf = (es: FakeES) => new URL(es.url, 'http://x').searchParams.get('delay');
    const pill = () => $('.clockline .pill').textContent;

    it('an increase holds every event for the difference after it arrives: T stands still, nothing after T shows', () => {
      render({ sessionKey: 9100 });
      const stream = last();
      stream.emit('snapshot', { t: NOW, state: raceState(), laps: [], stints: [] });
      advance(250);
      expect(light()).toBe('Track clear');
      advance(1_250); // T = NOW + 1.5 s

      click('5 seconds earlier'); // renders the clock line at once
      expect(pill()).toBe('LIVE, 5 s behind');
      expect(clock()).toBe(fmtClock(NOW + 1_000));
      // T stands at NOW + 1.5 s for the 5 s the page is now further behind.
      advance(1_000);
      expect(clock()).toBe(fmtClock(NOW + 1_000));
      stream.emit('delta', { t: NOW + 2_500, ...yellow }); // arrives at NOW + 2.5 s, due at NOW + 7.5 s
      advance(3_900); // NOW + 6.4 s: T has stood at NOW + 1.5 s (it runs again from NOW + 6.5 s, as now − 5 s)
      expect(clock()).toBe(fmtClock(NOW + 1_000));
      advance(1_099); // NOW + 7.499 s: T is NOW + 2.499 s, so the event at NOW + 2.5 s is not shown yet
      expect(light()).toBe('Track clear');
      expect(FakeES.all).toHaveLength(1);
      advance(1);
      advance(250);
      expect(light()).toBe('Yellow flag');
      expect(clock()).toBe(fmtClock(NOW + 2_000)); // resynced to the event, never past it
      // It runs again, 5 s further behind (unheld, T would be NOW + 9.75 s by now).
      advance(2_000);
      expect([fmtClock(NOW + 3_000), fmtClock(NOW + 4_000)]).toContain(clock());

      // `end` is held the same way: the bar stays live until it is due.
      // The server closes the response after `end`, so a real EventSource fires `error` at once: no failure, no reopen.
      stream.emit('end', { t: NOW + 4_750 });
      stream.emit('error');
      expect(stream.closed).toBe(true);
      expect(host.textContent).not.toContain('Reconnecting…');
      advance(4_999);
      expect(pill()).toBe('LIVE, 5 s behind');
      advance(1);
      expect(pill()).toBe('Paused');
      advance(60_000);
      expect(FakeES.all).toHaveLength(1); // it never reopens
    });

    it('a held `end` keeps the held events before it when the transport closes, and the watchdog stops', () => {
      render({ sessionKey: 9100 });
      const stream = last();
      stream.emit('snapshot', { t: NOW, state: raceState(), laps: [], stints: [] });
      advance(250);
      click('5 seconds earlier');
      stream.emit('delta', { t: NOW + 250, ...yellow });
      stream.emit('end', { t: NOW + 300 });
      stream.emit('error');
      advance(4_999);
      expect(light()).toBe('Track clear');
      advance(1);
      advance(250);
      expect(light()).toBe('Yellow flag'); // the held delta, then `end`
      expect(pill()).toBe('Paused');
      advance(60_000); // past the 40 s watchdog
      expect(FakeES.all).toHaveLength(1);
      expect(host.textContent).not.toContain('Reconnecting…');
    });

    it('a pending decrease reopens nothing once Live or a reconnect has opened at that delay', () => {
      localStorage.setItem('f1.delay', '30');
      render({ sessionKey: 9100 });
      slide('Delay', 20);
      advance(100);
      button('Pause');
      button('Live');
      expect(last().url).toBe('/api/v1/playback/7/stream?at=live&delay=20');
      const live = last();
      advance(1_000);
      expect(FakeES.all).toHaveLength(2);
      expect(live.closed).toBe(false);

      // An error, then a decrease 200 ms before the 1 s retry: the retry opens at the new delay, the timer adds none.
      live.emit('error');
      advance(800);
      slide('Delay', 10);
      advance(200);
      expect(last().url).toBe('/api/v1/playback/7/stream?at=live&delay=10');
      const retried = last();
      advance(1_000);
      expect(last()).toBe(retried);
      expect(retried.closed).toBe(false);
      expect(openCount()).toBe(1);
    });

    it("a decrease below the open stream's delay opens exactly one, 400 ms after the last change", () => {
      localStorage.setItem('f1.delay', '30');
      render({ sessionKey: 9100 });
      const first = last();
      expect(delayOf(first)).toBe('30');
      first.emit('snapshot', { t: NOW - 30_000, state: raceState(), laps: [], stints: [] });
      advance(250);
      click('5 seconds earlier'); // 35 s: holds 5 s
      advance(1_000);
      first.emit('delta', { t: NOW - 28_750, ...yellow }); // arrives at NOW + 1.25 s
      for (let i = 0; i < 3; i++) click('1 second later'); // 32 s: holds 2 s, so it is due at NOW + 3.25 s
      advance(1_999);
      expect(light()).toBe('Track clear');
      advance(1);
      advance(250);
      expect(light()).toBe('Yellow flag');
      expect(FakeES.all).toHaveLength(1);

      slide('Delay', 25); // below 30: the new data comes from a new stream
      advance(399);
      expect(FakeES.all).toHaveLength(1);
      expect(first.closed).toBe(false);
      advance(1);
      expect(FakeES.all).toHaveLength(2);
      expect(first.closed).toBe(true);
      expect(last().url).toBe('/api/v1/playback/7/stream?at=live&delay=25');
      expect(openCount()).toBe(1);
      // The closed stream shows nothing more.
      first.emit('delta', { t: NOW - 25_000, topic: 'TrackStatus', data: { Status: '5' } });
      advance(10_000);
      expect(light()).toBe('Yellow flag');
      expect(FakeES.all).toHaveLength(2);
    });

    it("a seek opens exactly one stream, and the old stream's held events never show", () => {
      render({ sessionKey: 9100 });
      const first = last();
      first.emit('snapshot', { t: NOW, state: raceState(), laps: [], stints: [] });
      advance(250);
      click('5 seconds earlier');
      first.emit('delta', { t: NOW + 250, ...yellow }); // held until NOW + 5.25 s
      slide('Position', NOW - 600_000);
      advance(400);
      expect(FakeES.all).toHaveLength(2);
      expect(first.closed).toBe(true);
      expect(atOf(last())).toBe(String(NOW - 600_000));
      expect(openCount()).toBe(1);
      advance(10_000);
      expect(light()).toBe('Track clear');
      expect(FakeES.all).toHaveLength(2);
    });

    it('an error during a hold reopens at the shown delay, which holds nothing; the held events are dropped', () => {
      render({ sessionKey: 9100 });
      const first = last();
      first.emit('snapshot', { t: NOW, state: raceState(), laps: [], stints: [] });
      advance(250);
      click('5 seconds earlier');
      first.emit('delta', { t: NOW + 250, ...yellow }); // held
      first.emit('error');
      advance(1_000);
      expect(FakeES.all).toHaveLength(2);
      expect(last().url).toBe('/api/v1/playback/7/stream?at=live&delay=5');
      advance(10_000);
      expect(light()).toBe('Track clear'); // dropped with the stream: the new snapshot covers it
      last().emit('snapshot', { t: Date.now() - 5_000, state: raceState(), laps: [], stints: [] });
      last().emit('delta', { t: Date.now() - 5_000, ...yellow });
      advance(250);
      expect(light()).toBe('Yellow flag'); // at once: the new stream is at the shown delay
    });
  });

  it('a seek, a nudge, pause and play each reopen at the right at (one stream at a time)', () => {
    const start = S + 3_600_000;
    render({ recording: ended, start });
    expect(atOf(last())).toBe(String(start));
    last().emit('snapshot', { t: start, state: {}, laps: [], stints: [] });

    const to = S + 1_800_000;
    slide('Position', to);
    advance(399);
    expect(FakeES.all).toHaveLength(1);
    advance(1);
    expect(FakeES.all).toHaveLength(2);
    expect(atOf(last())).toBe(String(to));
    expect(openCount()).toBe(1);

    // P4e: was "Position +5 s".
    click('5 seconds later');
    click('5 seconds later');
    advance(400);
    expect(FakeES.all).toHaveLength(3);
    expect(atOf(last())).toBe(String(to + 10_000));
    expect(openCount()).toBe(1);

    button('Pause');
    expect(openCount()).toBe(0);
    advance(5_000); // paused: T stands still and nothing opens
    expect(FakeES.all).toHaveLength(3);
    expect(host.textContent).toContain('Paused');

    button('Play');
    expect(FakeES.all).toHaveLength(4);
    expect(atOf(last())).toBe(String(to + 10_000));
    expect(openCount()).toBe(1);

    // A nudge past the end clamps to it (P4e: was "Position +30 s").
    click('30 seconds later');
    slide('Position', E + 60_000);
    advance(400);
    expect(atOf(last())).toBe(String(E));
    expect(openCount()).toBe(1);
  });

  it('pausing live switches to replay, and Live returns', () => {
    render({});
    last().emit('snapshot', { t: NOW - 2_000, state: {}, laps: [], stints: [] });
    button('Pause');
    expect(openCount()).toBe(0);
    expect(host.querySelector('input[aria-label="Delay"]')).toBeNull();
    button('Play');
    expect(atOf(last())).toBe(String(NOW - 2_000));
    button('Live');
    expect(last().url).toBe('/api/v1/playback/7/stream?at=live&delay=0');
    expect(openCount()).toBe(1);
  });

  it('an error closes the stream and reopens at the current T after backoff', () => {
    const start = S + 3_600_000;
    render({ recording: ended, start });
    last().emit('snapshot', { t: start, state: {}, laps: [], stints: [] });
    advance(2_000);
    const first = last();
    first.emit('error');
    expect(first.closed).toBe(true);
    expect(host.textContent).toContain('Reconnecting…');
    advance(999);
    expect(FakeES.all).toHaveLength(1);
    advance(1);
    expect(FakeES.all).toHaveLength(2);
    expect(atOf(last())).toBe(String(start + 3_000));

    // No snapshot in between: the wait doubles.
    last().emit('error');
    advance(1_999);
    expect(FakeES.all).toHaveLength(2);
    advance(1);
    expect(atOf(last())).toBe(String(start + 5_000));

    // A snapshot resets it.
    last().emit('snapshot', { t: start + 5_000, state: {}, laps: [], stints: [] });
    expect(host.textContent).not.toContain('Reconnecting…');
    last().emit('error');
    advance(1_000);
    expect(FakeES.all).toHaveLength(4);
    expect(atOf(last())).toBe(String(start + 6_000));
    expect(openCount()).toBe(1);

    // Five in a row without a snapshot: the reload hint, and it keeps retrying.
    const reload = 'The stream keeps failing. Reload the page (your Access session may have expired).';
    for (const wait of [2_000, 4_000, 8_000]) {
      last().emit('error');
      expect(host.textContent).not.toContain(reload);
      advance(wait);
    }
    last().emit('error');
    expect(host.textContent).toContain(reload);
    expect(host.textContent).not.toContain('Reconnecting…');
    advance(16_000);
    expect(FakeES.all).toHaveLength(8);
    expect(openCount()).toBe(1);
    last().emit('snapshot', { t: start, state: {}, laps: [], stints: [] });
    expect(host.textContent).not.toContain(reload);
  });

  it.each([
    ['a snapshot', 'snapshot'],
    ['a delta', 'delta'],
  ])('%s that fails its contract marks the app stale, closes and never reopens', (_name, event) => {
    const start = S + 3_600_000;
    render({ recording: ended, start });
    if (event === 'delta') last().emit('snapshot', { t: start, state: {}, laps: [], stints: [] });
    expect(markStale).not.toHaveBeenCalled();
    last().emit(event, { t: 'x' });
    expect(markStale).toHaveBeenCalledTimes(1);
    expect(isStale()).toBe(true);
    expect(last().closed).toBe(true);
    // The banner is the app's (ui/ErrorView.tsx): the player adds no line of its own.
    expect(host.textContent).not.toContain('A new version is out');
    expect(host.textContent).not.toContain('Reconnecting…');
    expect(host.textContent).not.toContain('keeps failing');
    const opened = FakeES.all.length;
    advance(60_000);
    expect(FakeES.all).toHaveLength(opened);
    expect(openCount()).toBe(0);
  });

  it('offline, the hint after five failures says the page needs the network (#121, D5)', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => onLine.mockRestore());
    const start = S + 3_600_000;
    render({ recording: ended, start });
    last().emit('snapshot', { t: start, state: {}, laps: [], stints: [] });
    for (const wait of [1_000, 2_000, 4_000, 8_000]) {
      last().emit('error');
      advance(wait);
    }
    last().emit('error');
    expect(host.textContent).toContain('You are offline: this page needs the network.');
    expect(host.textContent).not.toContain('The stream keeps failing.');
  });

  it('a silent stream is reopened after 40 s without events; pings keep it open', () => {
    const start = S + 3_600_000;
    render({ recording: ended, start });
    const first = last();
    first.emit('snapshot', { t: start, state: {}, laps: [], stints: [] });
    for (let i = 1; i <= 6; i++) {
      advance(15_000);
      first.emit('ping', { t: start + i * 15_000 });
    }
    expect(first.closed).toBe(false); // 90 s, a ping every 15 s
    advance(39_000);
    expect(first.closed).toBe(false);
    advance(1_000); // 40 s since the last ping
    expect(first.closed).toBe(true);
    expect(host.textContent).toContain('Reconnecting…');
    advance(1_000); // the backoff
    expect(FakeES.all).toHaveLength(2);
    expect(atOf(last())).toBe(String(start + 131_000));
    expect(openCount()).toBe(1);

    // A page resumed after its timers were frozen: the first check after the gap reopens.
    last().emit('snapshot', { t: start + 131_000, state: {}, laps: [], stints: [] });
    vi.setSystemTime(Date.now() + 300_000);
    advance(1_000);
    expect(FakeES.all.at(-2)?.closed).toBe(true);
  });

  it('the 1 s tick alone re-derives nothing from the state', () => {
    const start = S + 3_600_000;
    render({ recording: ended, start });
    const StatusSeries = { '0': { Utc: new Date(S + 600_000).toISOString(), SessionStatus: 'Started' } };
    last().emit('snapshot', {
      t: start,
      state: {
        SessionData: { StatusSeries },
        TimingData: { Lines: { '1': { Line: 1, Position: '1' } } },
        ExtrapolatedClock: { Utc: new Date(start).toISOString(), Remaining: '00:10:00', Extrapolating: true },
      },
      laps: [],
      stints: [],
    });
    advance(250);
    const clockText = () => host.querySelector('.clockline time')?.textContent; // P4e: the clock line is in the bar
    const left = () =>
      [...host.querySelectorAll('.strip > div')].find((d) => d.querySelector('dt')?.textContent === 'Left')
        ?.textContent;
    const before = clockText();
    expect(left()).toBe('Left09:59'); // 250 ms after the snapshot's T
    const calls = vi.mocked(view).mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    advance(5_000);
    expect(clockText()).not.toBe(before); // the clock ticked
    expect(left()).toBe('Left09:54'); // and so did the strip's LEFT cell
    expect(vi.mocked(view).mock.calls.length).toBe(calls);
  });

  it('a replay of an open recording ignores the stored delay: the seek bar ends at now', () => {
    localStorage.setItem('f1.delay', '45');
    render({ start: NOW - 60_000 });
    const bar = $<HTMLInputElement>('input[aria-label="Position"]');
    expect(bar.max).toBe(String(NOW));
    // NOW − 60 s in Amsterdam (CET); P4e: per minute while playing, so '22:59', was '22:59:00'.
    expect(bar.getAttribute('aria-valuetext')).toBe('22:59');
    click('30 seconds later');
    click('30 seconds later');
    click('30 seconds later');
    advance(400);
    expect(atOf(last())).toBe(String(NOW));
  });

  it("a seek while paused leaves LEFT where the tower stands until the still frame's snapshot", () => {
    const start = S + 3_600_000;
    render({ recording: ended, start, sessionKey: 9100 });
    const clock = { Utc: new Date(start).toISOString(), Remaining: '01:00:00', Extrapolating: true };
    last().emit('snapshot', {
      t: start,
      state: raceState({ extra: { ExtrapolatedClock: clock } }),
      laps: [],
      stints: [],
    });
    advance(10_000);
    const left = () => [...host.querySelectorAll('.strip div')].find((d) => d.textContent?.startsWith('Left'));
    expect(left()?.textContent).toBe('Left59:50');
    button('Pause');
    const to = start + 10_000 + 300_000;
    slide('Position', to);
    expect(left()?.textContent).toBe('Left59:50');
    advance(400);
    // P4e: the paused seek opens a still frame (no more "Press Play"); LEFT waits for its snapshot.
    expect(atOf(last())).toBe(String(to));
    expect(left()?.textContent).toBe('Left59:50');
    last().emit('snapshot', { t: to, state: raceState({ extra: { ExtrapolatedClock: clock } }), laps: [], stints: [] });
    advance(250);
    expect(left()?.textContent).toBe('Left54:50');
    advance(5_000); // paused: it stands
    expect(left()?.textContent).toBe('Left54:50');
  });

  it('/live: a refetch that sets ended_at keeps the player and its stream', () => {
    // No query fetches (msw would fail it): the data is put into the cache by hand.
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    const session = {
      session_key: 11404,
      meeting_name: 'Mexico City',
      session_name: 'Race',
      date_start: '',
      date_end: '',
    };
    const live = (ended_at: string | null): LiveData => ({
      session: { ...session, date_start: new Date(S).toISOString(), date_end: new Date(E).toISOString() },
      recording: { id: 7, started_at: new Date(S).toISOString(), ended_at, complete: false },
    });
    // TanStack notifies its observers on a 0 ms timer, a fake one here.
    const put = (d: LiveData) => {
      act(() => client.setQueryData(['live'], d));
      advance(0);
    };
    put(live(null));
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Live />
        </QueryClientProvider>,
      ),
    );
    expect(FakeES.all).toHaveLength(1);
    const first = last();
    expect(first.url).toContain('at=live');
    put(live(new Date(E).toISOString()));
    expect(FakeES.all).toHaveLength(1);
    expect(first.closed).toBe(false);
    expect($<HTMLInputElement>('input[aria-label="Position"]').max).toBe(String(E)); // the new ended_at

    // Once /live names something else, the page offers it.
    put({ ...live(null), recording: null });
    expect(first.closed).toBe(true);
    expect(host.textContent).toContain('Next:');
  });

  it('an error in live mode reopens at live', () => {
    render({});
    last().emit('error');
    advance(1_000);
    expect(FakeES.all).toHaveLength(2);
    expect(last().url).toBe('/api/v1/playback/7/stream?at=live&delay=0');
  });

  it('end closes the stream and never reopens', () => {
    render({ recording: ended, start: E - 10_000 });
    last().emit('snapshot', { t: E - 10_000, state: {}, laps: [], stints: [] });
    last().emit('end', { t: E });
    expect(last().closed).toBe(true);
    advance(120_000);
    expect(FakeES.all).toHaveLength(1);
    expect(host.textContent).toContain('Paused');
  });

  it('a snapshot then deltas update the tower; a laps event updates the lap table', () => {
    render({ recording: ended, start: S + 60_000, detail });
    const t = S + 60_000;
    last().emit('snapshot', {
      t,
      state: {
        DriverList: { '1': { Tla: 'VER', TeamColour: '3671C6' }, '44': { Tla: 'HAM' }, _kf: true },
        SessionInfo: { Type: 'Race' }, // the tower's Gap and Int depend on it
        TimingData: {
          Lines: {
            '1': { Line: 1, Position: '1', GapToLeader: 'LAP 3', LastLapTime: { Value: '1:20.000' } },
            '44': { Line: 2, Position: '2', GapToLeader: '+1.234', IntervalToPositionAhead: { Value: '+1.234' } },
          },
        },
        LapCount: { CurrentLap: 3, TotalLaps: 71 },
        SessionStatus: { Status: 'Started' }, // P4e: the strip's light word needs a running session
        TrackStatus: { Status: '1', Message: 'AllClear' },
      },
      laps: [lap(1, 1)],
      stints: [],
    });
    expect(host.textContent).toContain('Connecting'); // nothing renders before the 250 ms flush
    advance(250);
    const tower = () =>
      [...host.querySelectorAll('table[aria-label="Timing tower"] tbody th')].map((x) => x.textContent);
    expect(tower()).toEqual(['VER', 'HAM']);
    expect(host.textContent).toContain('+1.234');
    expect(host.textContent).toContain('Lap 3/71');
    // P4e: the clock line no longer shows TrackStatus.Message ("AllClear"); the strip's light word carries it.
    const light = () => host.querySelector('.strip .lw')?.textContent;
    expect(light()).toBe('Track clear');

    last().emit('delta', {
      t: t + 1_000,
      topic: 'TimingData',
      data: { Lines: { '1': { Line: 2 }, '44': { Line: 1 } } },
    });
    last().emit('delta', { t: t + 1_500, topic: 'TrackStatus', data: { Status: '2', Message: 'Yellow' } });
    expect(tower()).toEqual(['VER', 'HAM']); // throttled
    advance(250);
    expect(tower()).toEqual(['HAM', 'VER']);
    expect(light()).toBe('Yellow flag'); // P4e: was the clock line's "Yellow"

    button('Laps');
    const lapHeads = () => [...host.querySelectorAll('table.laps thead th')].map((x) => x.textContent);
    expect(lapHeads()).toEqual(['Driver', 'Best', '1']);
    last().emit('laps', { t: t + 2_000, laps: [lap(1, 2), lap(44, 1)], stints: [] });
    advance(250);
    expect(lapHeads()).toEqual(['Driver', 'Best', '1', '2']);
    // Drivers come from the stream's DriverList, ordered by its TimingData positions.
    expect([...host.querySelectorAll('table.laps tbody th')].map((x) => x.textContent)).toEqual(['VER', 'HAM']);
  });

  // #126: the tower names a tyre in the session's season, from the session detail's meeting year.
  it.each([
    [2018, 'cmp-ultrasoft', 'US'],
    [2026, 'cmp-unknown', '?'],
  ])("the tower's tyre in a %s session is %s %s", (year, cls, letter) => {
    render({ recording: ended, start: S + 60_000, detail: { ...detail, meeting: { ...detail.meeting, year } } });
    last().emit('snapshot', {
      t: S + 60_000,
      state: {
        DriverList: { '1': { Tla: 'VER' }, _kf: true },
        SessionInfo: { Type: 'Race' },
        TimingData: { Lines: { '1': { Line: 1, Position: '1' } } },
        TimingAppData: { Lines: { '1': { Stints: { '0': { Compound: 'ULTRASOFT', TotalLaps: 3 } } } } },
      },
      laps: [],
      stints: [],
    });
    advance(250);
    const dot = host.querySelector('table[aria-label="Timing tower"] .cmp');
    expect(dot?.className).toBe(`cmp ${cls}`);
    expect(dot?.textContent).toBe(letter);
  });
});

const lap = (driver_number: number, lap_number: number) =>
  Lap.parse({
    driver_number,
    lap_number,
    date_start: null,
    lap_ms: 80_000 + lap_number,
    s1_ms: null,
    s2_ms: null,
    s3_ms: null,
    i1_kph: null,
    i2_kph: null,
    st_kph: null,
    is_pit_out: false,
    is_pit_in: false,
    seg1: null,
    seg2: null,
    seg3: null,
    deleted: false,
    deleted_reason: null,
    quali_phase: null,
    compound: null,
    colour: { lap: null, s1: null, s2: null, s3: null },
  });

const detail = SessionDetail.parse({
  session: {
    session_key: 11404,
    meeting_key: 1300,
    type: 'Race',
    name: 'Race',
    date_start: '2026-10-25T20:00:00.000Z',
    date_end: '2026-10-25T22:00:00.000Z',
    ingest_state: 'scheduled',
    is_cancelled: false,
    ...fetched,
    fetch_count: 0,
  },
  meeting: {
    meeting_key: 1300,
    year: 2026,
    name: 'Mexico City Grand Prix',
    official_name: null,
    location: null,
    country_code: null,
    circuit_short_name: null,
    gmt_offset: null,
    date_start: null,
    date_end: null,
    is_cancelled: false,
  },
  drivers: [],
  results: [],
});

// App's title writer, as App mounts it for /live: the page title with the title word in front.
function Title() {
  useTitle('Live · F1 Timings');
  return null;
}

describe('the pit wall in the player', () => {
  const withTitle = (props: Partial<Parameters<typeof Player>[0]>) =>
    act(() =>
      root.render(
        <>
          <Title />
          <Player recording={open} start="live" detail={undefined} {...props} />
        </>,
      ),
    );
  const snapshot = (state: object) => {
    last().emit('snapshot', { t: NOW - 1_000, state, laps: [], stints: [] });
    advance(250);
  };

  it('puts the light in front of the tab title while the session runs', () => {
    withTitle({ sessionKey: 9100 });
    expect(document.title).toBe('Live · F1 Timings');
    snapshot(raceState({ track: '4' }));
    expect(document.title).toBe('Safety car · Live · F1 Timings');
    last().emit('delta', { t: NOW, topic: 'TrackStatus', data: { Status: '5' } });
    advance(250);
    expect(document.title).toBe('Red flag · Live · F1 Timings');
    last().emit('delta', { t: NOW, topic: 'SessionStatus', data: { Status: 'Aborted' } });
    advance(250);
    expect(document.title).toBe('Stopped · Live · F1 Timings');
    last().emit('delta', { t: NOW, topic: 'SessionStatus', data: { Status: 'Finished' } });
    advance(250);
    expect(document.title).toBe('Live · F1 Timings');
    expect(host.querySelector('.strip .lw')?.textContent).toBe('Chequered flag');
  });

  it('shows no light, strip or panel while the feed shows another session', () => {
    withTitle({ sessionKey: 9999 });
    snapshot(raceState({ track: '4' }));
    expect(document.title).toBe('Live · F1 Timings');
    expect(host.querySelector('.strip')).toBeNull();
    expect(host.querySelector('.side')).toBeNull();
    expect(host.textContent).toContain('Waiting for the session');
  });

  it('clears the title word when the player unmounts', () => {
    withTitle({ sessionKey: 9100 });
    snapshot(raceState({ track: '6' }));
    expect(document.title).toBe('VSC · Live · F1 Timings');
    act(() => root.render(<Title />));
    expect(document.title).toBe('Live · F1 Timings');
  });

  it('shows the strip above the view switch and the panel beside the tower', () => {
    render({ sessionKey: 9100, detail });
    snapshot(raceState({ msgs: [[2, 'Flag', 'GREEN LIGHT - PIT EXIT OPEN']] }));
    const strip = $('.strip');
    expect(strip.compareDocumentPosition($('fieldset.segmented')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect($('.pitwall .side').textContent).toContain('GREEN LIGHT - PIT EXIT OPEN');
    button('Laps');
    expect(host.querySelector('.side')).toBeNull();
    expect(host.querySelector('.strip')).not.toBeNull(); // on both tabs
  });

  it('filters race control by kind', () => {
    render({ sessionKey: 9100 });
    snapshot(
      raceState({
        msgs: [
          [2, 'Flag', 'GREEN LIGHT - PIT EXIT OPEN'],
          [5, 'SafetyCar', 'SAFETY CAR DEPLOYED'],
        ],
      }),
    );
    const feed = () => [...host.querySelectorAll('.feed li')].map((li) => li.textContent);
    expect(feed()).toEqual(['L5SCSAFETY CAR DEPLOYED', 'L2FLAGGREEN LIGHT - PIT EXIT OPEN']);
    button('Flags 1');
    expect(feed()).toEqual(['L2FLAGGREEN LIGHT - PIT EXIT OPEN']);
    button('Incidents 0');
    expect(host.textContent).toContain('No messages of this kind yet.');
    button('All 2');
    expect(feed()).toHaveLength(2);
  });

  it('a tap on a driver focuses the row, a second tap clears it', () => {
    render({ sessionKey: 9100 });
    snapshot(raceState());
    const driver = (tla: string) =>
      [...host.querySelectorAll<HTMLButtonElement>('.tower tbody th button')].find((b) => b.textContent === tla);
    const focused = () => [...host.querySelectorAll('.tower tr.focus th')].map((th) => th.textContent);
    expect(driver('BBB')?.getAttribute('aria-pressed')).toBe('false');
    act(() => driver('BBB')?.click());
    expect(driver('BBB')?.getAttribute('aria-pressed')).toBe('true');
    expect(focused()).toEqual(['BBB']);
    act(() => driver('CCC')?.click());
    expect(focused()).toEqual(['CCC']);
    expect(driver('BBB')?.getAttribute('aria-pressed')).toBe('false');
    act(() => driver('CCC')?.click());
    expect(focused()).toEqual([]);
    expect(host.querySelectorAll('.tower [aria-pressed="true"]')).toHaveLength(0);
  });
});

// #113: the Laps tab in a qualifying session, on the stream's lap rows up to T (A§13); D1: the feed adds the part each
// line that is not KnockedOut has reached.
describe('qualifying by phase in the player', () => {
  const T = S + 3_600_000;
  const qdetail = SessionDetail.parse({
    ...detail,
    session: { ...detail.session, session_key: 9102, type: 'Qualifying', name: 'Qualifying' },
  });
  // Lap rows of the phase: lap_ms 80 s + `ms` of the driver's lap, so every time on the page is its own string.
  const row = (driver: number, n: number, phase: number, ms: number) => ({
    ...lap(driver, n),
    lap_ms: ms,
    quali_phase: phase,
  });
  const q1 = [row(1, 1, 1, 80_501), row(2, 1, 1, 80_702)];
  const q2 = [row(1, 2, 2, 79_123), row(2, 2, 2, 79_456)];
  // SessionPart `part`; `lines` are the TimingData lines of drivers 1 and 2.
  const state = (part: number, lines: object = { '1': { Line: 1 }, '2': { Line: 2 } }) =>
    qualifyingState({ extra: { TimingData: { SessionPart: part, Lines: lines } } });
  const heads = () =>
    [...host.querySelectorAll('table[aria-label="Qualifying by phase"] thead th')].map((x) => x.textContent);
  const pressedButtons = () => [...host.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent);
  const tiles = () => [...host.querySelectorAll('dl[aria-label="Qualifying"] dt')].map((x) => x.textContent);
  const show = (st: object, laps: object[], props: Partial<Parameters<typeof Player>[0]> = { sessionKey: 9102 }) => {
    render({ recording: ended, start: T, detail: qdetail, ...props });
    last().emit('snapshot', { t: T, state: st, laps, stints: [] });
    advance(250);
    button('Laps');
  };

  it('shows the tiles and By phase on the stream rows, and a seek back drops the later phase', () => {
    show(state(2), [...q1, ...q2]);
    expect(pressedButtons()).toEqual(['Laps', 'By phase']);
    expect(heads()).toEqual(['Driver', 'Q1', 'Q2', 'To fastest', 'Timed laps']);
    expect(tiles()).toEqual(['Fastest in Q2', 'Q1 cut-off (P2)']);
    expect(host.textContent).toContain('1:19.123');
    expect(host.querySelector('.tiles[aria-label="Session"]')).toBeNull(); // no SessionTiles: the API holds the whole session

    const earlier = T - 1_200_000;
    slide('Position', earlier);
    advance(400);
    expect(atOf(last())).toBe(String(earlier));
    last().emit('snapshot', { t: earlier, state: state(1), laps: q1, stints: [] });
    advance(250);
    expect(heads()).toEqual(['Driver', 'Q1', 'To fastest', 'Timed laps']);
    expect(host.textContent).not.toContain('Q2');
    expect(host.textContent).not.toMatch(/1:19\./);
    expect(host.textContent).toContain('1:20.501');
  });

  it('counts a line that is not KnockedOut as through once SessionPart moved on; Every lap shows the lap table', () => {
    const lines = { '1': { Line: 1 }, '2': { Line: 2, KnockedOut: true } };
    show(state(2, lines), q1);
    expect(tiles()).toEqual(['Fastest in Q2', 'Q1 cut-off (P1)']);
    expect($('dl[aria-label="Qualifying"]').textContent).toContain('1:20.501AAA'); // the cut-off is car 1's best
    const rowOf = (tla: string) =>
      [...host.querySelectorAll('table.quali tbody tr')].find((tr) => tr.querySelector('th')?.textContent === tla);
    expect(rowOf('AAA')?.textContent).not.toContain('Knocked out in Q1');
    expect(rowOf('BBB')?.textContent).toContain('Knocked out in Q1'); // KnockedOut
    expect(host.querySelector('table.laps')).toBeNull();
    button('Every lap');
    expect(host.querySelector('table[aria-label="Qualifying by phase"]')).toBeNull();
    expect(host.querySelector('table.laps')).not.toBeNull();
  });

  it('a TimingData switch alone moves By phase, with no laps event', () => {
    show(state(1), q1);
    expect(heads()).toEqual(['Driver', 'Q1', 'To fastest', 'Timed laps']);
    // SessionPart 2 and car 2's KnockedOut in one delta; the lap rows do not change.
    last().emit('delta', {
      t: T + 1_000,
      topic: 'TimingData',
      data: { SessionPart: 2, Lines: { '2': { KnockedOut: true } } },
    });
    advance(250);
    expect(heads()).toEqual(['Driver', 'Q1', 'Q2', 'To fastest', 'Timed laps']);
    expect(tiles()).toEqual(['Fastest in Q2', 'Q1 cut-off (P1)']);
  });

  it('leaves the feed out while it shows another session', () => {
    show(state(2, { '1': { Line: 1 }, '2': { Line: 2, KnockedOut: true } }), q1, { sessionKey: 9999 });
    // The feed's SessionPart 2 would make Q2 a phase; the laps alone are Q1 only.
    expect(heads()).toEqual(['Driver', 'Q1', 'To fastest', 'Timed laps']);
  });

  it('keeps the plain lap table in a race', () => {
    render({ recording: ended, start: T, detail, sessionKey: 9100 });
    last().emit('snapshot', { t: T, state: raceState(), laps: [lap(1, 1)], stints: [] });
    advance(250);
    button('Laps');
    expect(host.querySelector('table.laps')).not.toBeNull();
    expect(host.textContent).not.toContain('By phase');
    expect(host.querySelector('dl[aria-label="Qualifying"]')).toBeNull();
  });
});

// The player's Weather tab (P5b, A§13): the feed's rows up to T, in P5a's tiles and chart.
describe('the Weather tab in the player', () => {
  const T = S + 3_600_000;
  const W = { AirTemp: '22.4', TrackTemp: '43.1', Rainfall: '0', Humidity: '40.0' }; // raceState's WeatherData
  const rows = [
    weatherRow({ ...W, AirTemp: '20.0' }, T - 120_000),
    weatherRow({ ...W, AirTemp: '21.0' }, T - 60_000),
    weatherRow(W, T),
  ];
  const air = () => host.querySelector('dl.tiles.wx > div dd.v')?.textContent;
  const lastX = () => Math.max(...(chart.options.at(-1)?.series ?? []).flatMap((x) => x.data.map((p) => p[0])));
  // The chart's lazy import, then its set-up and first draw.
  const drawn = async () => {
    for (let i = 0; i < 5; i++) await act(async () => {});
  };
  const start = (weather: unknown[], sessionKey = 9100) => {
    render({ recording: ended, start: T, sessionKey, detail });
    last().emit('snapshot', { t: T, state: raceState(), laps: [lap(1, 1)], stints: [], weather });
    advance(250);
  };

  beforeEach(() => {
    chart.options = [];
  });

  it('the view switch reads Tower · Laps · Order · Weather in a race; aria-pressed follows the click', () => {
    start(rows);
    const views = () => [...host.querySelectorAll('fieldset[aria-label="View"] button')];
    expect(views().map((b) => b.textContent)).toEqual(['Tower', 'Laps', 'Order', 'Weather']);
    const pressed = () => views().map((b) => b.getAttribute('aria-pressed'));
    expect(pressed()).toEqual(['true', 'false', 'false', 'false']);
    button('Weather');
    expect(pressed()).toEqual(['false', 'false', 'false', 'true']);
    expect(host.querySelector('table[aria-label="Timing tower"]')).toBeNull();
    expect(air()).toBe('20.0–22.4 °C');
    expect(host.querySelector('.strip')).not.toBeNull(); // the strip stays on every tab
    button('Laps');
    expect(pressed()).toEqual(['false', 'true', 'false', 'false']);
    expect(host.querySelector('table.laps')).not.toBeNull();
    expect(host.querySelector('dl.tiles.wx')).toBeNull();
    button('Tower');
    expect(host.querySelector('table[aria-label="Timing tower"]')).not.toBeNull();
  });

  it('shows no Order tab and no trend outside a race', () => {
    render({ recording: ended, start: T, detail });
    last().emit('snapshot', { t: T, state: practiceState(), laps: [lap(1, 1)], stints: [], weather: [] });
    advance(250);
    expect([...host.querySelectorAll('fieldset[aria-label="View"] button')].map((b) => b.textContent)).toEqual([
      'Tower',
      'Laps',
      'Weather',
    ]);
    expect(host.textContent).not.toContain('Interval change');
  });

  it('falls back to the Tower, pressed, when the session on the Order tab is no longer a race', () => {
    render({ recording: ended, start: T, detail });
    last().emit('snapshot', { t: T, state: raceState(), laps: [lap(1, 1)], stints: [], weather: [] });
    advance(250);
    button('Order');
    last().emit('snapshot', { t: T, state: practiceState(), laps: [lap(1, 1)], stints: [], weather: [] });
    advance(250);
    const views = [...host.querySelectorAll('fieldset[aria-label="View"] button')];
    expect(views.map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Tower', 'true'],
      ['Laps', 'false'],
      ['Weather', 'false'],
    ]);
    expect(host.querySelector('table[aria-label="Timing tower"]')).not.toBeNull();
  });

  describe('in a race, from the stream laps', () => {
    const started = (d: number, n: number, at: number) => ({
      ...lap(d, n),
      lap_ms: null,
      date_start: new Date(at).toISOString(),
    });
    // AAA (1) leads and is 1 s ahead after lap 1, 3 s after lap 2: the gap grew by 2 s.
    const laps = [
      started(1, 1, T - 300_000),
      started(1, 2, T - 210_000),
      started(1, 3, T - 120_000),
      started(2, 1, T - 299_000),
      started(2, 2, T - 209_000),
      started(2, 3, T - 117_000),
    ];
    const begin = () => {
      render({ recording: ended, start: T, sessionKey: 9100, detail });
      last().emit('snapshot', { t: T, state: raceState(), laps, stints: [], weather: [] });
      advance(250);
    };

    it('the tower gets the closing trend', () => {
      begin();
      expect($('table[aria-label="Timing tower"]').textContent).toContain('car ahead pulling away 2.0 s');
      expect($('table[aria-label="Timing tower"]').textContent).toContain('Interval change at the line over 3 laps');
    });

    it('the Order tab shows the running order with the feed grid and the lap 1 gains', () => {
      begin();
      button('Order');
      const table = $('table[aria-label="Running order"]');
      // raceState's GridPos: BBB 1, CCC 2, AAA 3, EEE 5 (DDD none). After lap 1 AAA leads: AAA gained 2 places, BBB lost 1.
      const grid = [...(table.querySelectorAll('tbody tr')[0]?.querySelectorAll('td') ?? [])].map((c) => c.textContent);
      expect(grid).toEqual(['BBB', 'CCC', 'AAA', 'EEE']);
      expect(table.textContent).toContain('gained 2 places');
      expect(table.textContent).toContain('lost 1 place');
      expect(host.querySelector('table[aria-label="Timing tower"]')).toBeNull();
    });
  });

  it('a WeatherData delta appends a row: the tiles and the chart after the flush', async () => {
    start(rows);
    button('Weather');
    await drawn();
    expect(chart.options).toHaveLength(1);
    expect(chart.options[0]?.series[0]?.data).toHaveLength(3);
    last().emit('delta', { t: T + 1_000, topic: 'WeatherData', data: { AirTemp: '25.0' } });
    expect(air()).toBe('20.0–22.4 °C'); // throttled
    advance(250);
    expect(air()).toBe('20.0–25.0 °C');
    expect(chart.options).toHaveLength(2);
    expect(chart.options[1]?.series[0]?.data.at(-1)).toEqual([T + 1_000, 25]);
    // The row is the whole reading at t: the track temperature the delta left alone is in it.
    expect(chart.options[1]?.series[1]?.data.at(-1)).toEqual([T + 1_000, 43.1]);
  });

  it('a seek back drops the later rows: only those up to the new T', async () => {
    start(rows);
    button('Weather');
    await drawn();
    expect(lastX()).toBe(T);
    const to = T - 90_000;
    slide('Position', to);
    advance(400);
    last().emit('snapshot', { t: to, state: raceState(), laps: [], stints: [], weather: rows.slice(0, 1) });
    advance(250);
    await drawn();
    expect(air()).toBe('20.0 °C');
    expect(lastX()).toBeLessThanOrEqual(to);
    expect(chart.options.at(-1)?.series[0]?.data).toEqual([[T - 120_000, 20]]);
  });

  it('the chart is redrawn only when a row arrives, not on the tick or a laps event', async () => {
    start(rows);
    button('Weather');
    await drawn();
    expect(chart.options).toHaveLength(1);
    advance(5_000);
    last().emit('laps', { t: T + 5_000, laps: [lap(1, 2)], stints: [] });
    advance(250);
    await drawn();
    expect(chart.options).toHaveLength(1);
    last().emit('delta', { t: T + 6_000, topic: 'WeatherData', data: { AirTemp: '23.0' } });
    advance(250);
    await drawn();
    expect(chart.options).toHaveLength(2);
  });

  it("a race's rain period names the leader's laps from the stream's lap rows", () => {
    render({ recording: ended, start: T, sessionKey: 9100, detail });
    const started = (n: number, at: number) => ({ ...lap(1, n), date_start: new Date(at).toISOString() });
    last().emit('snapshot', {
      t: T,
      state: raceState(),
      laps: [started(1, T - 150_000), started(2, T - 90_000), started(3, T - 10_000)],
      stints: [],
      weather: [
        weatherRow({ ...W, Rainfall: '1' }, T - 120_000),
        weatherRow({ ...W, Rainfall: '1' }, T - 60_000),
        weatherRow(W, T),
      ],
    });
    advance(250);
    button('Weather');
    expect(host.querySelector('dl.tiles.wx')?.textContent).toMatch(/· laps 1–2/);
  });

  // P5c: the rain map under the panels, from the player's T: no frame after it, and it follows T.
  it('shows the rain map up to T under the panels; it follows T, and the chart is not redrawn', async () => {
    const mexico = { ...detail, meeting: { ...detail.meeting, circuit_short_name: 'Mexico City' } };
    const mm = (v: number) => Array.from({ length: 49 }, (_, k) => (k === 24 ? v : 0));
    client.setQueryData(['rain', mexico.session.session_key], {
      grid: { map_id: 'mx-1962', centre_lat: 19.4, centre_lon: -99.09, size: 7, step_m: 1500, state: 'final' },
      frames: [-900_000, 0, 900_000].map((d, k) => ({ date: new Date(T + d).toISOString(), mm: mm(0.1 * (k + 1)) })),
    });
    client.setQueryData(['map', 'mx-1962'], { outline: 'M 0 0 L 1 1 Z', osm: null });
    render({ recording: ended, start: T, sessionKey: 9100, detail: mexico });
    last().emit('snapshot', { t: T, state: raceState(), laps: [], stints: [], weather: rows });
    advance(250);
    button('Weather');
    await drawn();
    expect(chart.options).toHaveLength(1);
    expect(host.querySelector('dl.tiles.wx + .card + .card.rainmap')).not.toBeNull(); // under the tiles and the chart
    const range = () => $<HTMLInputElement>('input[aria-label="Rain map time"]');
    expect([range().max, range().value]).toEqual(['1', '1']); // the frame at T, not the one 15 min later
    expect(host.querySelector('.rainsum')?.textContent).toBe(
      'Rain in 1 of 49 cells, heaviest 0.8 mm/h, at the circuit',
    );
    // 15 min of play; the pings keep the stream open, and each resyncs T.
    for (let i = 1; i <= 60; i++) {
      advance(15_000);
      last().emit('ping', { t: T + i * 15_000 });
    }
    expect([range().max, range().value]).toEqual(['2', '2']);
    await drawn();
    expect(chart.options).toHaveLength(1);
  });

  it('says "No weather in the feed yet." before the feed shows the session, and without rows', () => {
    start(rows, 9999);
    button('Weather');
    expect(host.textContent).toContain('No weather in the feed yet.');
    expect(host.querySelector('dl.tiles.wx')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    start([]);
    button('Weather');
    expect(host.textContent).toContain('No weather in the feed yet.');
    expect(host.querySelector('dl.tiles.wx')).toBeNull();
    // P5c: the rain map card is there without rows too (this venue has no outline: the test detail has no circuit).
    expect(host.querySelector('.card.rainmap h2')?.textContent).toBe('Rain around the circuit');
  });
});

// The player bar (P4e, A§13): one control model around T, nothing on screen ahead of T, a reload that comes back
// paused where you were. One test per criterion of #51.
describe('the player bar', () => {
  const T = S + 3_600_000; // 20:00Z, 21:00:00 in Amsterdam (CET)
  const utcOf = (hm: string) => `2026-10-25T${hm}:00.000Z`;
  /** A StatusSeries from [UTC HH:mm, field, value] rows, keyed 0, 1, … */
  const statusSeries = (rows: [string, 'SessionStatus' | 'TrackStatus', string][]) =>
    Object.fromEntries(rows.map(([hm, k, v], i) => [String(i), { Utc: utcOf(hm), [k]: v }]));
  const pitOut = (driver: number, n: number, hm: string) => ({
    ...lap(driver, n),
    is_pit_out: true,
    date_start: utcOf(hm),
  });
  const pill = () => $('.clockline .pill').textContent;
  const chips = () => [...host.querySelectorAll('section.player .chips button')].map((b) => b.textContent);
  const position = () => Number($<HTMLInputElement>('input[aria-label="Position"]').value);
  const tap = (tla: string) =>
    act(() =>
      [...host.querySelectorAll<HTMLButtonElement>('.tower tbody th button')]
        .find((b) => b.textContent === tla)
        ?.click(),
    );

  beforeEach(() => history.replaceState(null, '', '/'));

  it('nudges: live, earlier adds delay and later takes it off (0–120 s); in replay they move T', () => {
    render({});
    expect($('.clockline .pill').className).toBe('pill live');
    expect(pill()).toBe('LIVE · Delay not set');
    expect([...host.querySelectorAll('.transport button')].map((b) => b.textContent)).toEqual([
      '−30',
      '−5',
      '−1',
      'Pause',
      '+1',
      '+5',
      '+30',
    ]);
    expect($('.transport button:nth-child(4)').className).toBe('play');
    click('5 seconds earlier');
    expect(delayShown()).toBe(5);
    expect(pill()).toBe('LIVE, 5 s behind');
    click('5 seconds later');
    expect(delayShown()).toBe(0);
    expect(pill()).toBe('LIVE · Delay not set');
    click('1 second later');
    expect(delayShown()).toBe(0);
    for (let i = 0; i < 5; i++) click('30 seconds earlier');
    expect(delayShown()).toBe(120);
    expect(pill()).toBe('LIVE, 120 s behind');
    act(() => root.unmount());

    root = createRoot(host);
    render({ recording: ended, start: T });
    last().emit('snapshot', { t: T, state: {}, laps: [], stints: [] });
    expect($('.clockline .pill').className).toBe('pill');
    expect(pill()).toBe('Replay');
    const opened = FakeES.all.length;
    click('5 seconds earlier');
    advance(399);
    expect(FakeES.all).toHaveLength(opened);
    advance(1);
    expect(atOf(last())).toBe(String(T - 5_000));
    expect(openCount()).toBe(1);
  });

  it('has no forward jump: no mark or chip after T, only Play/Pause, six nudges, the back chips and Live', () => {
    render({ recording: open, start: T }); // a replay of an open recording: Live is a mode switch (D2)
    // A synthetic state that knows the future: each kind once before T and once after.
    const StatusSeries = statusSeries([
      ['19:10', 'SessionStatus', 'Started'],
      ['19:20', 'TrackStatus', 'SCDeployed'],
      ['19:25', 'TrackStatus', 'AllClear'],
      ['19:30', 'TrackStatus', 'VSCDeployed'],
      ['19:32', 'TrackStatus', 'AllClear'],
      ['19:40', 'TrackStatus', 'Red'],
      ['19:45', 'TrackStatus', 'AllClear'],
      ['19:50', 'SessionStatus', 'Finished'],
      ['20:10', 'TrackStatus', 'SCDeployed'],
      ['20:20', 'TrackStatus', 'Red'],
      ['20:30', 'SessionStatus', 'Started'],
      ['20:40', 'SessionStatus', 'Finished'],
    ]);
    last().emit('snapshot', { t: T, state: { SessionData: { StatusSeries } }, laps: [], stints: [] });
    advance(250);
    expect([...host.querySelectorAll('.marks .marker')].map((m) => m.getAttribute('title'))).toEqual([
      'Start 20:10:00',
      'Safety car 20:20:00',
      'Virtual safety car 20:30:00',
      'Red flag 20:40:00',
      'Chequered flag 20:50:00',
    ]);
    expect([...$('section.player').children].map((c) => c.className)).toEqual(['barhead', 'barbody']);
    expect([...$('.barhead').children].map((c) => c.className)).toEqual(['clockline', 'bartoggle']);
    expect([...$('.barbody').children].map((c) => c.className)).toEqual(['seek', 'transport', 'chips', 'announce']);
    expect([...$('section.player').querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Controls',
      '−30',
      '−5',
      '−1',
      'Pause',
      '+1',
      '+5',
      '+30',
      'Live',
      'Start 20:10',
      'SC 20:20',
      'VSC 20:30',
      'Red flag 20:40',
      'Chequered flag 20:50',
    ]);
    expect($('.transport .golive').textContent).toBe('Live');
    // Every chip goes back: the latest first, then each one before it.
    let before = position();
    for (const [chip, hm] of [
      ['Chequered flag 20:50', '19:50'],
      ['Red flag 20:40', '19:40'],
      ['VSC 20:30', '19:30'],
      ['SC 20:20', '19:20'],
      ['Start 20:10', '19:10'],
    ] as const) {
      button(chip);
      expect(position()).toBe(Date.parse(utcOf(hm)));
      expect(position()).toBeLessThan(before);
      before = position();
    }
    expect(chips()).toEqual(['Start 20:10']);
    advance(400);
    expect(atOf(last())).toBe(String(Date.parse(utcOf('19:10'))));
    expect(openCount()).toBe(1);
  });

  it('marks and chips stand at T: a backward seek drops a later SC at once, an open band grows with the tick', () => {
    render({ recording: ended, start: T });
    const StatusSeries = statusSeries([
      ['19:10', 'SessionStatus', 'Started'],
      ['19:55', 'TrackStatus', 'SCDeployed'],
    ]);
    last().emit('snapshot', { t: T, state: { SessionData: { StatusSeries } }, laps: [], stints: [] });
    advance(250);
    const band = () => host.querySelector<HTMLElement>('.marks .m-band');
    expect(band()?.className).toBe('marker m-band m-sc open');
    expect(host.querySelector('.marks .m-start')?.className).toBe('marker m-start');
    const w = () => Number.parseFloat(band()?.style.getPropertyValue('--w') ?? '');
    const w0 = w();
    expect(w0).toBeGreaterThan(0);
    const calls = vi.mocked(view).mock.calls.length;
    advance(5_000);
    expect(w()).toBeGreaterThan(w0); // the open band ends at T, which ticked
    expect(vi.mocked(view).mock.calls.length).toBe(calls); // and nothing was parsed for it
    expect(chips()).toEqual(['Start 20:10', 'SC 20:55']);

    // Back to before the SC: its band and chip go at once, before any new stream or snapshot.
    slide('Position', Date.parse(utcOf('19:50')));
    expect(band()).toBeNull();
    expect(chips()).toEqual(['Start 20:10']);
    expect(FakeES.all).toHaveLength(1);
    // A chip seeks back to its mark.
    button('Start 20:10');
    advance(400);
    expect(atOf(last())).toBe(String(Date.parse(utcOf('19:10'))));
    expect(openCount()).toBe(1);
  });

  it("the focused driver's last stop is a chip; a pit-out after T is none", () => {
    render({ recording: ended, start: T, sessionKey: 9100 });
    const laps = [pitOut(2, 21, '19:30'), pitOut(2, 40, '20:30'), pitOut(3, 40, '20:30')];
    last().emit('snapshot', { t: T, state: raceState(), laps, stints: [] });
    advance(250);
    expect(host.querySelector('section.player .chips')).toBeNull(); // no mark and no focus: no group at all
    tap('BBB');
    expect(chips()).toEqual(['BBB stop L20']); // lap 40's pit-out is after T
    expect($('section.player .chips').tagName).toBe('FIELDSET'); // a group, named by its aria-label
    expect($('section.player .chips').getAttribute('aria-label')).toBe('Back to');
    expect($('section.player .chips .label').textContent).toBe('Back to');
    expect($('section.player .chips .label').getAttribute('aria-hidden')).toBe('true'); // the name is not read twice
    tap('CCC');
    expect(host.querySelector('section.player .chips')).toBeNull(); // its only pit-out is after T
    tap('BBB');
    button('BBB stop L20');
    advance(400);
    expect(atOf(last())).toBe(String(Date.parse(utcOf('19:30'))));
  });

  it('a forward seek says once what it skipped in (old T, new T]: dismissible, and none after a backward seek', () => {
    render({ recording: ended, start: T, sessionKey: 9100, detail });
    const since = () => host.querySelector('p.since');
    const deleted = { ...lap(1, 10), deleted: true };
    last().emit('snapshot', { t: T, state: raceState(), laps: [deleted], stints: [] });
    advance(250);
    const to = Date.parse(utcOf('20:30'));
    slide('Position', to);
    advance(400);
    expect(since()).toBeNull(); // not before the new snapshot
    const msg = (hm: string, Message: string) => ({ Utc: utcOf(hm), Category: 'Other', Message });
    const state = raceState({
      extra: {
        SessionData: {
          StatusSeries: statusSeries([
            ['19:20', 'TrackStatus', 'SCDeployed'], // before the old T
            ['19:25', 'TrackStatus', 'AllClear'],
            ['20:05', 'TrackStatus', 'SCDeployed'],
            ['20:08', 'TrackStatus', 'AllClear'],
            ['20:15', 'TrackStatus', 'VSCDeployed'],
            ['20:16', 'TrackStatus', 'VSCEnding'],
            ['20:17', 'TrackStatus', 'AllClear'],
            ['20:50', 'TrackStatus', 'Red'], // after the new T (a synthetic future)
          ]),
        },
        RaceControlMessages: {
          Messages: {
            '0': msg('19:50', 'TURN 1 INCIDENT INVOLVING CARS 1 (AAA) AND 2 (BBB) NOTED'),
            '1': msg('20:12', 'TURN 4 INCIDENT INVOLVING CAR 3 (CCC) NOTED - CAUSING A COLLISION'),
            '2': msg('20:13', 'TURN 4 INCIDENT INVOLVING CAR 3 (CCC) UNDER INVESTIGATION'),
            '3': msg('20:45', 'TURN 9 INCIDENT INVOLVING CAR 4 (DDD) NOTED'),
          },
        },
      },
    });
    const laps = [
      deleted, // deleted before: not counted
      { ...lap(2, 5), deleted: true },
      pitOut(1, 21, '20:10'),
      pitOut(2, 22, '20:20'),
      pitOut(3, 1, '20:05'), // lap 1 is no stop
      pitOut(4, 30, '20:40'), // after the new T
    ];
    last().emit('snapshot', { t: to, state, laps, stints: [] });
    expect(since()?.querySelector('b')?.textContent).toBe('Before this point');
    expect(since()?.querySelector('span')?.textContent).toBe(
      '1 SC · 1 VSC · 2 pit stops · 1 lap deleted · 1 incident noted',
    );
    advance(250);
    // Above the view switch, below the strip; never a dialog.
    expect($('.strip').compareDocumentPosition($('p.since')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      $('p.since').compareDocumentPosition($('fieldset.segmented')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(host.querySelector('dialog, [role="dialog"]')).toBeNull();
    click('Dismiss');
    expect(since()).toBeNull();
    // Focus goes to the seek bar before the button unmounts, not back to the page.
    expect(document.activeElement).toBe($('input[aria-label="Position"]'));
    advance(60_000);
    expect(since()).toBeNull(); // shown once

    // Backward: no line, also once its snapshot is in.
    slide('Position', T);
    advance(400);
    last().emit('snapshot', { t: T, state: raceState(), laps: [deleted], stints: [] });
    expect(since()).toBeNull();
  });

  it('a seek while paused opens one still frame, closed by its snapshot; a new seek closes a pending one first', () => {
    render({ recording: ended, start: T });
    expect(stillOf(last())).toBeNull(); // playing
    last().emit('snapshot', { t: T, state: {}, laps: [], stints: [] });
    button('Pause');
    expect(openCount()).toBe(0);
    click('30 seconds earlier');
    advance(399);
    expect(FakeES.all).toHaveLength(1);
    advance(1);
    expect(FakeES.all).toHaveLength(2);
    expect(atOf(last())).toBe(String(T - 30_000));
    expect(stillOf(last())).toBe('1');
    expect(openCount()).toBe(1);
    expect(pill()).toBe('Paused'); // a still frame does not play
    last().emit('snapshot', { t: T - 30_000, state: {}, laps: [], stints: [] });
    expect(last().closed).toBe(true);
    expect(openCount()).toBe(0);
    advance(60_000);
    expect(FakeES.all).toHaveLength(2); // nothing reopens
    expect(position()).toBe(T - 30_000); // T stands at the still frame

    // A second seek while a still frame is pending closes it at once, before its own 400 ms.
    click('5 seconds earlier');
    advance(400);
    const pending = last();
    expect(atOf(pending)).toBe(String(T - 35_000));
    click('5 seconds earlier');
    expect(pending.closed).toBe(true);
    expect(openCount()).toBe(0);
    advance(400);
    expect(atOf(last())).toBe(String(T - 40_000));
    expect(openCount()).toBe(1);

    // An error retries it as a still frame at the same T.
    last().emit('error');
    expect(host.textContent).toContain('Reconnecting…');
    advance(1_000);
    expect(FakeES.all).toHaveLength(5);
    expect(atOf(last())).toBe(String(T - 40_000));
    expect(stillOf(last())).toBe('1');
    expect(openCount()).toBe(1);
    last().emit('snapshot', { t: T - 40_000, state: {}, laps: [], stints: [] });
    expect(openCount()).toBe(0);
    expect(host.textContent).not.toContain('Reconnecting…');

    button('Play');
    expect(atOf(last())).toBe(String(T - 40_000));
    expect(stillOf(last())).toBeNull();
    expect(pill()).toBe('Replay');
    expect(openCount()).toBe(1);
  });

  it('Play and Live after a long pause start T where they open: no jump by the pause before the first event', () => {
    render({ recording: open, start: T });
    last().emit('snapshot', { t: T, state: {}, laps: [], stints: [] });
    advance(10_000);
    button('Pause');
    const clock = () => $('.clockline time').textContent;
    const paused = clock();
    expect(paused).toBe(fmtClock(T + 10_000));
    advance(60_000);
    button('Play');
    expect(atOf(last())).toBe(String(T + 10_000));
    expect(clock()).toBe(paused); // not 60 s ahead
    expect(position()).toBe(T + 10_000);
    button('Pause');
    advance(60_000);
    button('Live');
    expect(last().url).toContain('at=live');
    expect(clock()).toBe(fmtClock(Date.now())); // live at a delay of 0, not the paused T + 60 s
  });

  it('an unmount closes the stream and leaves nothing to open later: playing, a pending seek, a still, a retry', () => {
    const cases: [string, () => void][] = [
      ['playing', () => {}],
      [
        'a pending seek',
        () => {
          slide('Position', T - 60_000);
          advance(100);
        },
      ],
      [
        'a pending still',
        () => {
          button('Pause');
          click('5 seconds earlier');
          advance(400);
          expect(openCount()).toBe(1);
        },
      ],
      ['a pending retry', () => last().emit('error')],
    ];
    for (const [name, before] of cases) {
      FakeES.all = [];
      render({ recording: ended, start: T });
      last().emit('snapshot', { t: T, state: {}, laps: [], stints: [] });
      before();
      const opened = FakeES.all.length;
      act(() => root.unmount());
      expect(openCount(), name).toBe(0);
      advance(120_000);
      expect(FakeES.all, name).toHaveLength(opened);
      root = createRoot(host);
    }
  });

  const recordings: Recordings = [
    {
      id: 7,
      session_key: 9100,
      year: 2026,
      meeting_name: 'Mexico City',
      session_name: 'Race',
      session_type: 'Race',
      date_start: new Date(T).toISOString(),
      started_at: ended.started_at,
      ended_at: ended.ended_at,
      complete: true,
    },
  ];
  // /replay/7 as App renders it, from a cache filled by hand (msw would fail a fetch).
  const replay = () => {
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    client.setQueryData(['recordings'], recordings);
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Replay recording={7} />
        </QueryClientProvider>,
      ),
    );
  };

  it('the replay keeps T in the URL: on pause, on a seek commit and every 15 s while playing', () => {
    history.replaceState(null, '', '/replay/7');
    replay();
    expect(atOf(last())).toBe(String(T));
    last().emit('snapshot', { t: T, state: {}, laps: [], stints: [] });
    advance(14_999);
    expect(location.search).toBe('');
    advance(1);
    expect(location.search).toBe('?t=21:00:15');
    advance(15_000);
    expect(location.search).toBe('?t=21:00:30');
    advance(2_000);
    button('Pause');
    expect(location.search).toBe('?t=21:00:32');
    advance(30_000);
    expect(location.search).toBe('?t=21:00:32'); // paused: no more writes
    click('30 seconds earlier');
    expect(location.search).toBe('?t=21:00:32'); // not before the commit
    advance(400);
    expect(location.search).toBe('?t=21:00:02');
    expect(location.pathname).toBe('/replay/7');
  });

  it('a replaceState that throws (a browser rate limit) never loses a seek', () => {
    history.replaceState(null, '', '/replay/7');
    replay();
    last().emit('snapshot', { t: T, state: {}, laps: [], stints: [] });
    const spy = vi.spyOn(history, 'replaceState').mockImplementation(() => {
      throw new DOMException('Too many calls', 'SecurityError');
    });
    try {
      click('30 seconds later');
      advance(400);
      expect(spy).toHaveBeenCalled();
      expect(atOf(last())).toBe(String(T + 30_000));
      expect(openCount()).toBe(1);
      advance(15_000); // the 15 s write throws too
      button('Pause');
      expect(openCount()).toBe(0);
      click('30 seconds earlier'); // a paused seek's still frame
      advance(400);
      expect(atOf(last())).toBe(String(T + 15_000));
      expect(openCount()).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('/live never writes T to the URL', () => {
    history.replaceState(null, '', '/live');
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    const live: LiveData = {
      session: {
        session_key: 9100,
        meeting_name: 'Mexico City',
        session_name: 'Race',
        date_start: new Date(S).toISOString(),
        date_end: new Date(E).toISOString(),
      },
      recording: { id: 7, started_at: open.started_at, ended_at: null, complete: false },
    };
    client.setQueryData(['live'], live);
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Live />
        </QueryClientProvider>,
      ),
    );
    expect(last().url).toContain('at=live');
    last().emit('snapshot', { t: NOW, state: {}, laps: [], stints: [] });
    advance(30_000);
    button('Pause');
    click('30 seconds earlier');
    advance(400);
    button('Play');
    advance(30_000);
    expect(location.pathname + location.search).toBe('/live');
  });

  it('a load with ?t resumes paused there as a still frame, with the note until Play', () => {
    history.replaceState(null, '', '/replay/7?t=20:30:00');
    replay();
    const at = S + 1_800_000; // 19:30Z
    expect(FakeES.all).toHaveLength(1);
    expect(atOf(last())).toBe(String(at));
    const note = 'Resumed at 20:30:00: press Play when the video is there.';
    expect(host.textContent).toContain(note);
    expect(pill()).toBe('Paused');
    last().emit('snapshot', { t: at, state: {}, laps: [], stints: [] });
    expect(openCount()).toBe(0);
    advance(10_000);
    expect(position()).toBe(at);
    expect(host.textContent).toContain(note);
    button('Play');
    expect(atOf(last())).toBe(String(at));
    expect(host.textContent).not.toContain('Resumed at');

    // A seek commit clears it too: the note would name an old time.
    act(() => root.unmount());
    root = createRoot(host);
    replay();
    expect(host.textContent).toContain(note);
    click('5 seconds later');
    advance(399);
    expect(host.textContent).toContain(note);
    advance(1);
    expect(host.textContent).not.toContain('Resumed at');
    expect(atOf(last())).toBe(String(at + 5_000));
  });

  it('a bad or out-of-range ?t falls back to the session start, with no note', () => {
    for (const t of ['abc', '25:00:00', '21:44', '23:30:00', '19:59:59']) {
      history.replaceState(null, '', `/replay/7?t=${t}`);
      FakeES.all = [];
      replay();
      expect(FakeES.all).toHaveLength(1);
      expect(atOf(last())).toBe(String(T));
      expect(host.textContent).not.toContain('Resumed at');
      expect(pill()).toBe('Replay');
      act(() => root.unmount());
      root = createRoot(host);
    }
  });

  it('announcements: one status region from the start, off by default, at most a line per 5 s keeping the newest', () => {
    render({ recording: ended, start: T, sessionKey: 9100 });
    const region = $('p.vh[role="status"]');
    expect(region.textContent).toBe('');
    const toggle = () => $<HTMLInputElement>('label.announce input[type="checkbox"]');
    expect(toggle().checked).toBe(false);
    expect($('label.announce').textContent).toBe('Announce events');
    let t = T;
    const delta = (topic: string, data: object, wait = 1_000) => {
      advance(wait - 250);
      t += wait;
      last().emit('delta', { t, topic, data });
      advance(250); // the flush
    };
    last().emit('snapshot', { t, state: raceState(), laps: [], stints: [] });
    advance(250);

    delta('TrackStatus', { Status: '4' }); // off: silent
    expect(region.textContent).toBe('');
    act(() => toggle().click());
    expect(toggle().checked).toBe(true);
    expect(localStorage.getItem('f1.announce')).toBe('1');
    expect($('p.vh[role="status"]')).toBe(region); // the same element, mounted from the first render

    delta('TrackStatus', { Status: '5' });
    expect(region.textContent).toBe('Red flag');
    delta('TrackStatus', { Status: '2' }); // 1 s later: waits
    expect(region.textContent).toBe('Red flag');
    delta('TrackStatus', { Status: '1' }); // and replaces the waiting line
    expect(region.textContent).toBe('Red flag');
    advance(2_999);
    expect(region.textContent).toBe('Red flag');
    advance(1); // 5 s after the first line: the newest
    expect(region.textContent).toBe('Track clear');
    advance(10_000);
    expect(region.textContent).toBe('Track clear'); // the dropped "Yellow flag" never comes

    // What changes in one flush is one line.
    advance(250);
    t += 250;
    last().emit('delta', {
      t,
      topic: 'SessionData',
      data: { StatusSeries: { '0': { Utc: new Date(t).toISOString(), SessionStatus: 'Started' } } },
    });
    last().emit('delta', {
      t,
      topic: 'TimingStats',
      data: {
        Lines: {
          '1': { PersonalBestLapTime: { Value: '1:20.100', Position: 1 } },
          '2': { PersonalBestLapTime: { Position: 2 } },
        },
      },
    });
    advance(250);
    expect(region.textContent).toBe('Start. Fastest lap: AAA 1:20.100');

    // A forward seek: where T landed, and what it skipped.
    advance(5_000);
    const to = t + 600_000;
    slide('Position', to);
    advance(400);
    const StatusSeries = statusSeries([['20:01', 'TrackStatus', 'SCDeployed']]);
    last().emit('snapshot', {
      t: to,
      state: raceState({ extra: { SessionData: { StatusSeries } } }),
      laps: [],
      stints: [],
    });
    expect(region.textContent).toBe(
      `At ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(to)}. Before this point: 1 SC.`,
    );
    advance(250);

    // Off: silent again.
    act(() => toggle().click());
    expect(localStorage.getItem('f1.announce')).toBe('0');
    delta('TrackStatus', { Status: '5' }, 6_000);
    advance(6_000);
    expect(region.textContent).toBe('');
  });

  it('announcements default to off when storage throws, and are remembered when it works', () => {
    localStorage.setItem('f1.announce', '1');
    render({});
    expect($<HTMLInputElement>('label.announce input').checked).toBe(true);
    act(() => root.unmount());
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    root = createRoot(host);
    render({});
    const toggle = $<HTMLInputElement>('label.announce input');
    expect(toggle.checked).toBe(false);
    act(() => toggle.click()); // the write throws; the toggle still works
    expect(toggle.checked).toBe(true);
  });

  it('the Position range reads HH:mm while playing and HH:mm:ss while paused', () => {
    render({ recording: ended, start: T + 5_000 });
    const text = () => $('input[aria-label="Position"]').getAttribute('aria-valuetext');
    expect(text()).toBe('21:00');
    advance(30_000);
    expect(text()).toBe('21:00'); // 21:00:35: no change within the minute
    advance(30_000);
    expect(text()).toBe('21:01');
    button('Pause');
    expect(text()).toBe('21:01:05');
    click('1 second later');
    expect(text()).toBe('21:01:06');
  });

  describe('minimized (#77)', () => {
    const toggle = () => $<HTMLButtonElement>('button.bartoggle');
    const headOf = () => [...$('.barhead').children].map((c) => c.className);
    const clock = () => $('.clockline time').textContent;

    it('keeps the clock line, Play/Pause and the toggle; the stream plays on, and the rest comes back', () => {
      render({ recording: ended, start: T, sessionKey: 9100 });
      last().emit('snapshot', { t: T, state: raceState(), laps: [], stints: [] });
      advance(250);
      const controls = $<HTMLElement>('.barbody');
      expect(toggle().textContent).toBe('Controls'); // the name stays; aria-expanded carries the state
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      expect(toggle().getAttribute('aria-controls')).toBe(controls.id);
      expect(controls.hidden).toBe(false);
      expect(headOf()).toEqual(['clockline', 'bartoggle']);
      const stream = last();
      const opened = FakeES.all.length;

      act(() => toggle().click());
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect($('section.player').className).toBe('player min');
      expect(localStorage.getItem('f1.minimized')).toBe('1');
      // The same element, hidden and empty: nothing in it can take focus or tick.
      expect($('.barbody')).toBe(controls);
      expect(controls.hidden).toBe(true);
      expect(controls.childElementCount).toBe(0);
      for (const sel of ['input[aria-label="Position"]', '.transport', '.player .chips', 'label.announce'])
        expect(host.querySelector(sel)).toBeNull();
      // The head: the clock line (T, time left, lap and mode), then Play/Pause, then the toggle.
      expect(headOf()).toEqual(['clockline', 'play', 'bartoggle']);
      expect([...$('.clockline').children].map((c) => c.className)).toEqual(['', 'left', 'lap', 'pill']);
      expect($('.barhead .play').textContent).toBe('Pause');
      // No reopen, no close: the stream and T are untouched, and the clock keeps ticking.
      expect(FakeES.all).toHaveLength(opened);
      expect(stream.closed).toBe(false);
      expect(clock()).toBe(fmtClock(T));
      advance(1_000);
      expect(clock()).toBe(fmtClock(T + 1_000));

      // Pause and Play work from the head.
      button('Pause');
      expect(openCount()).toBe(0);
      expect(clock()).toBe(fmtClock(T + 1_000));
      advance(5_000);
      expect(clock()).toBe(fmtClock(T + 1_000));
      button('Play');
      expect(atOf(last())).toBe(String(T + 1_250)); // the snapshot's 250 ms flush, then the 1 s
      expect(openCount()).toBe(1);

      // Expanded again: everything is back, Play/Pause once (in the transport), and the stream still not reopened.
      const playing = last();
      act(() => toggle().click());
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      expect($('section.player').className).toBe('player');
      expect(localStorage.getItem('f1.minimized')).toBe('0');
      expect(controls.hidden).toBe(false);
      expect(headOf()).toEqual(['clockline', 'bartoggle']);
      expect([...host.querySelectorAll('section.player .play')].map((b) => b.parentElement?.className)).toEqual([
        'transport',
      ]);
      expect($('input[aria-label="Position"]').getAttribute('aria-valuetext')).toBe(fmtClock(T).slice(0, 5));
      expect(clock()).toBe(fmtClock(T + 1_000));
      expect(last()).toBe(playing);
      expect(playing.closed).toBe(false);
    });

    it('is remembered per device, and is expanded when storage throws', () => {
      localStorage.setItem('f1.minimized', '1');
      render({});
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(host.querySelector('input[aria-label="Delay"]')).toBeNull();
      act(() => root.unmount());

      localStorage.setItem('f1.minimized', 'yes'); // only '1' minimizes
      root = createRoot(host);
      render({});
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      act(() => root.unmount());

      vi.stubGlobal('localStorage', {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      });
      root = createRoot(host);
      render({});
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      act(() => toggle().click()); // the write throws; the toggle still works
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(host.querySelector('input[aria-label="Delay"]')).toBeNull();
    });

    it('the toggle takes the focus, so none is lost when the focused control goes (Safari focuses no clicked button)', () => {
      render({ recording: ended, start: T });
      // happy-dom's click() moves no focus either, as Safari's: each control is focused by hand first.
      $<HTMLInputElement>('input[aria-label="Position"]').focus();
      act(() => toggle().click());
      expect(document.activeElement).toBe(toggle());
      $<HTMLButtonElement>('.barhead .play').focus();
      act(() => toggle().click());
      expect(host.querySelector('.barhead .play')).toBeNull();
      expect(document.activeElement).toBe(toggle());
    });

    it('replay: announcements still speak, and Dismiss focuses the toggle (there is no Position range)', () => {
      localStorage.setItem('f1.announce', '1');
      render({ recording: ended, start: T, sessionKey: 9100 });
      const region = $('p.vh[role="status"]');
      let t = T;
      last().emit('snapshot', { t, state: raceState(), laps: [], stints: [] });
      advance(250);
      // A forward seek, so the skipped line shows; then minimize.
      const to = Date.parse(utcOf('20:30'));
      slide('Position', to);
      advance(400);
      const StatusSeries = statusSeries([['20:05', 'TrackStatus', 'SCDeployed']]);
      t = to;
      last().emit('snapshot', {
        t,
        state: raceState({ extra: { SessionData: { StatusSeries } } }),
        laps: [],
        stints: [],
      });
      advance(250);
      expect($('p.since span').textContent).toBe('1 SC');
      act(() => toggle().click());
      // Dismiss from the keyboard: the focus is on it, and goes to the toggle, not to the page.
      $<HTMLButtonElement>('button[aria-label="Dismiss"]').focus();
      click('Dismiss');
      expect(host.querySelector('p.since')).toBeNull();
      expect(document.activeElement).toBe(toggle());
      // Announcements go on while minimized (the region sits outside the bar).
      advance(5_000);
      t += 5_000;
      last().emit('delta', { t, topic: 'TrackStatus', data: { Status: '5' } });
      advance(250);
      expect(region.textContent).toBe('Red flag');
    });

    it('live: toggling keeps the stream and the delay; a pending delay decrease still commits while minimized', () => {
      localStorage.setItem('f1.delay', '30');
      render({ recording: open, start: 'live' });
      const delayOf = (es: FakeES) => new URL(es.url, 'http://x').searchParams.get('delay');
      const stream = last();
      expect(atOf(stream)).toBe('live');
      expect(delayOf(stream)).toBe('30');
      const opened = FakeES.all.length;

      act(() => toggle().click());
      expect(host.querySelector('input[aria-label="Delay"]')).toBeNull();
      expect(pill()).toBe('LIVE, 30 s behind');
      act(() => toggle().click());
      expect(delayShown()).toBe(30);
      advance(1_000); // past any debounce
      expect(FakeES.all).toHaveLength(opened);
      expect(stream.closed).toBe(false);

      // A nudge below the stream's delay, then minimized within the 400 ms: the new delay reaches the stream all the
      // same (#101: an increase reopens nothing, so it is a decrease).
      click('5 seconds later');
      expect(delayShown()).toBe(25);
      advance(100);
      act(() => toggle().click());
      expect(pill()).toBe('LIVE, 25 s behind');
      advance(300);
      expect(stream.closed).toBe(true);
      expect(atOf(last())).toBe('live');
      expect(delayOf(last())).toBe('25');
      expect(openCount()).toBe(1);
      act(() => toggle().click());
      expect(delayShown()).toBe(25);
      act(() => root.unmount());

      // Mounted minimized: the stored delay applies to the stream and the pill.
      root = createRoot(host);
      render({ recording: open, start: 'live' });
      expect(toggle().getAttribute('aria-expanded')).toBe('true'); // expanded last
      localStorage.setItem('f1.minimized', '1');
      act(() => root.unmount());
      root = createRoot(host);
      render({ recording: open, start: 'live' });
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(delayOf(last())).toBe('25');
      expect(pill()).toBe('LIVE, 25 s behind');
    });
  });
});

describe('wake lock', () => {
  type Sentinel = { released: boolean; release: () => Promise<void> };
  let sentinels: Sentinel[];
  let request: ReturnType<typeof vi.fn>;
  const held = () => sentinels.filter((s) => !s.released).length;
  const flush = () => act(async () => {});
  const visibility = (v: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
    return act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  };
  const install = (fn: () => Promise<unknown>) => {
    request = vi.fn(fn);
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
  };
  beforeEach(() => {
    sentinels = [];
    install(async () => {
      const s: Sentinel = {
        released: false,
        release: vi.fn(async () => {
          s.released = true;
        }),
      };
      sentinels.push(s);
      return s;
    });
    history.replaceState(null, '', '/');
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'wakeLock');
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('a live player that plays and is visible requests the screen lock once', async () => {
    render({});
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('screen');
    expect(held()).toBe(1);
  });

  it('hidden then visible requests again; a visibilitychange while held keeps one lock', async () => {
    render({});
    await flush();
    await visibility('hidden');
    (sentinels[0] as Sentinel).released = true; // the browser lets go of a hidden page's lock
    await visibility('visible');
    expect(request).toHaveBeenCalledTimes(2);
    expect(held()).toBe(1);
    await visibility('visible');
    expect(held()).toBe(1);
  });

  it('Pause releases it, Play requests again, an unmount releases it', async () => {
    render({});
    await flush();
    button('Pause');
    await flush();
    expect(held()).toBe(0);
    button('Play');
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(held()).toBe(1);
    act(() => root.unmount());
    await flush();
    expect(held()).toBe(0);
    root = createRoot(host); // the afterEach unmounts it
  });

  it('a grant that lands after Pause is released at once', async () => {
    let grant: (s: Sentinel) => void = () => {};
    install(() => new Promise((resolve) => (grant = resolve)));
    render({});
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    button('Pause'); // cleanup runs while the request is pending
    await flush();
    const late: Sentinel = {
      released: false,
      release: vi.fn(async () => {
        late.released = true;
      }),
    };
    sentinels.push(late);
    await act(async () => grant(late));
    expect(late.release).toHaveBeenCalledTimes(1);
    expect(held()).toBe(0);
  });

  it('a still frame requests nothing, a hidden page waits for visible', async () => {
    history.replaceState(null, '', '/replay/7?t=20:30:00');
    render({ recording: ended, start: S, keepT: true });
    await flush();
    expect(request).not.toHaveBeenCalled();
    act(() => root.unmount());
    root = createRoot(host);
    history.replaceState(null, '', '/');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    render({});
    await flush();
    expect(request).not.toHaveBeenCalled();
    await visibility('visible');
    expect(request).toHaveBeenCalledTimes(1);
    expect(held()).toBe(1);
  });

  it('a refused request leaves the stream open and Pause and Play working', async () => {
    install(() => Promise.reject(new DOMException('no', 'NotAllowedError')));
    render({});
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(openCount()).toBe(1);
    button('Pause');
    expect(openCount()).toBe(0);
    button('Play');
    expect(openCount()).toBe(1);
    await flush();
  });

  it('the reload hint releases it, and the next snapshot takes it again', async () => {
    render({});
    await flush();
    for (const wait of [1_000, 2_000, 4_000, 8_000]) {
      last().emit('error');
      advance(wait);
    }
    await flush();
    expect(held()).toBe(1); // still reconnecting: the lock holds through the backoff
    last().emit('error');
    await flush();
    expect(host.textContent).toContain('The stream keeps failing.');
    expect(held()).toBe(0);
    advance(16_000);
    last().emit('snapshot', { t: NOW, state: {}, laps: [], stints: [] });
    await flush();
    expect(held()).toBe(1);
  });

  it('a stale stream releases it and never takes it again', async () => {
    render({});
    await flush();
    expect(held()).toBe(1);
    last().emit('delta', { t: 'x' }); // fails its contract: reload, no retry
    await flush();
    expect(held()).toBe(0);
    advance(60_000);
    await visibility('visible');
    expect(held()).toBe(0);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('without the API the player plays', async () => {
    Reflect.deleteProperty(navigator, 'wakeLock');
    render({});
    await flush();
    expect(openCount()).toBe(1);
  });
});

describe('the failure probe (#100, D3)', () => {
  const start = S + 3_600_000;
  const MISSING = "The recording's files are missing on the server: playback stopped. Press Play to try again.";
  const EXPIRED = 'The stream keeps failing: your Access session has expired. Reload the page to sign in.';
  const UP = 'The stream keeps failing, but the server has the recording: still retrying.';
  const ERROR = 'The stream keeps failing: the server answered with an error. Still retrying.';
  const settle = () => act(async () => {});
  /** Plays, then fails `n` times, each time waiting out the backoff but the last. */
  const failing = (n: number) => {
    render({ recording: ended, start });
    last().emit('snapshot', { t: start, state: {}, laps: [], stints: [] });
    for (let i = 0; i < n; i++) {
      if (i > 0) advance(1_000 * 2 ** (i - 1));
      last().emit('error');
    }
  };

  it("sends no fetch after 2 errors, one HEAD on the stream's URL after the 3rd, and none after the 4th or 5th", () => {
    failing(2);
    expect(fetchStub).not.toHaveBeenCalled();
    advance(2_000);
    const url = last().url;
    last().emit('error');
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(url).toBe(streamUrl({ recording: 7, at: start + 3_000, delay: 0 }));
    expect(fetchStub.mock.calls[0]?.[0]).toBe(url);
    expect(fetchStub.mock.calls[0]?.[1]).toMatchObject({ method: 'HEAD', redirect: 'error' });
    advance(4_000);
    last().emit('error');
    advance(8_000);
    last().emit('error');
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a 401', () => Promise.resolve({ status: 401 } as Response), EXPIRED],
    ['a TypeError', () => Promise.reject(new TypeError('Failed to fetch')), EXPIRED],
    ['a 200', () => Promise.resolve({ status: 200, ok: true } as Response), UP],
    ['a 503', () => Promise.resolve({ status: 503, ok: false } as Response), ERROR],
  ])('%s says its own text and keeps retrying', async (_name, answer, text) => {
    fetchStub.mockImplementation(answer);
    failing(3);
    await settle();
    expect($('p[role="status"]').textContent).toBe(text);
    for (const other of [EXPIRED, UP, ERROR, MISSING].filter((x) => x !== text))
      expect(host.textContent).not.toContain(other);
    const opened = FakeES.all.length;
    advance(4_000);
    expect(FakeES.all).toHaveLength(opened + 1);
    expect(openCount()).toBe(1);
    // A snapshot clears it.
    last().emit('snapshot', { t: start, state: {}, laps: [], stints: [] });
    expect(host.textContent).not.toContain(text);
  });

  it('offline, a TypeError says the page needs the network', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => onLine.mockRestore());
    fetchStub.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    failing(3);
    await settle();
    expect($('p[role="status"]').textContent).toBe('You are offline: this page needs the network.');
  });

  it.each([
    ['a 200', () => Promise.resolve({ status: 200 } as Response)],
    ['a 401', () => Promise.resolve({ status: 401 } as Response)],
  ])('offline wins over the probe answer (%s)', async (_name, answer) => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => onLine.mockRestore());
    fetchStub.mockImplementation(answer);
    failing(3);
    await settle();
    expect($('p[role="status"]').textContent).toBe(OFFLINE);
  });

  /** A probe answer that the test resolves itself, and the signal the player passed. */
  const deferred = () => {
    let resolve: (status: number) => void = () => {};
    fetchStub.mockImplementation(() => new Promise<Response>((r) => (resolve = (status) => r({ status } as Response))));
    return { answer: (status: number) => act(async () => resolve(status)) };
  };
  const signalOf = (call: number) => {
    const signal = (fetchStub.mock.calls[call]?.[1] as RequestInit | undefined)?.signal;
    if (!signal) throw new Error(`no probe ${call}`);
    return signal;
  };

  it('a snapshot while the probe is pending, then a 404: the player is not stopped and says nothing is missing', async () => {
    const probe = deferred();
    failing(3);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    advance(4_000); // the retry opens a stream
    last().emit('snapshot', { t: start + 5_000, state: {}, laps: [], stints: [] });
    expect(signalOf(0).aborted).toBe(true);
    await probe.answer(404);
    expect(host.textContent).not.toContain(MISSING);
    expect(openCount()).toBe(1);
    expect(host.querySelector('button.play')?.textContent).toBe('Pause');
  });

  it('Pause while the probe is pending, then a 404: no missing line; after Play the 3rd error of the new streak probes again', async () => {
    const probe = deferred();
    failing(3);
    button('Pause');
    expect(signalOf(0).aborted).toBe(true);
    await probe.answer(404);
    expect(host.textContent).not.toContain(MISSING);
    button('Play');
    for (let i = 0; i < 3; i++) {
      if (i > 0) advance(30_000); // the backoff has grown: wait out any of it
      last().emit('error');
    }
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('unmounting while the probe is pending aborts it', () => {
    deferred();
    failing(3);
    expect(signalOf(0).aborted).toBe(false);
    act(() => root.unmount());
    expect(signalOf(0).aborted).toBe(true);
    root = createRoot(host); // the afterEach unmounts it
  });

  it('a 404 stops at T: no new stream after the backoff, the line stays while paused, and Play tries again', async () => {
    fetchStub.mockImplementation(() => Promise.resolve({ status: 404 } as Response));
    failing(3);
    await settle();
    expect(host.textContent).toContain(MISSING);
    const opened = FakeES.all.length;
    advance(60_000);
    expect(FakeES.all).toHaveLength(opened);
    expect(openCount()).toBe(0);
    expect(host.textContent).toContain(MISSING);
    button('Play');
    expect(FakeES.all).toHaveLength(opened + 1);
    expect(atOf(last())).toBe(String(start + 3_000)); // where it stopped
    expect(host.textContent).not.toContain(MISSING);
  });
});

describe('the session query failed (#100)', () => {
  const T = S + 3_600_000;
  it.each([
    [500, 'API error'],
    [401, 'Your Access session may have expired: reload to sign in.'],
  ])('a %s shows its error under the tower, and no tabs', (status, text) => {
    render({ recording: ended, start: T, detailError: new HttpError(status) });
    last().emit('snapshot', { t: T, state: raceState(), laps: [], stints: [] });
    advance(250);
    expect(host.querySelector('fieldset[aria-label="View"]')).toBeNull();
    const alert = $('section.player').previousElementSibling;
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toBe(text);
    expect(alert?.previousElementSibling?.querySelector('table[aria-label="Timing tower"]')).not.toBeNull();
  });

  it('with the session loaded there is no error line', () => {
    render({ recording: ended, start: T, detail, detailError: new HttpError(500) });
    last().emit('snapshot', { t: T, state: raceState(), laps: [], stints: [] });
    advance(250);
    expect(host.textContent).not.toContain('API error');
    expect(host.querySelector('fieldset[aria-label="View"]')).not.toBeNull();
  });
});

describe('a tab that throws (#100)', () => {
  const T = S + 3_600_000;
  const BROKEN = 'Something went wrong: reload the page.';

  it('shows the boundary on its tab only: the bar and the stream stay, Laps renders, and a switch back resets it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => {
      error.mockRestore();
      towerMock.fail = false;
    });
    towerMock.fail = true;
    render({ recording: ended, start: T, detail });
    const es = last();
    es.emit('snapshot', { t: T, state: raceState(), laps: [lap(1, 1)], stints: [] });
    advance(250);
    expect(host.textContent).toContain(BROKEN);
    expect(host.querySelector('section.player')).not.toBeNull();
    expect(host.querySelector('.strip')).not.toBeNull();
    expect(es.closed).toBe(false);
    // The stream lives on: a later event still moves the clock.
    es.emit('delta', { t: T + 600_000, topic: 'LapCount', data: { CurrentLap: 13 } });
    advance(250);
    expect($('.clockline time').textContent).toBe(fmtClock(T + 600_000));
    button('Laps');
    expect(host.querySelector('table.laps')).not.toBeNull();
    expect(host.textContent).not.toContain(BROKEN);
    towerMock.fail = false;
    button('Tower');
    expect(host.querySelector('table[aria-label="Timing tower"]')).not.toBeNull();
    expect(host.textContent).not.toContain(BROKEN);
    expect(FakeES.all).toHaveLength(1);
  });
});

describe('the tab in the URL (#100)', () => {
  const T = S + 3_600_000;
  const pressed = () =>
    [...host.querySelectorAll('fieldset[aria-label="View"] button[aria-pressed="true"]')].map((b) => b.textContent);
  afterEach(() => history.replaceState(null, '', '/'));
  const play = (props: Partial<Parameters<typeof Player>[0]>) => {
    render({ recording: ended, start: T, detail, ...props });
    last().emit('snapshot', { t: T, state: raceState(), laps: [lap(1, 1)], stints: [] });
    advance(250);
  };

  it('?tab=weather opens the replay on Weather; a bad value is the tower', () => {
    history.replaceState(null, '', '/replay/7?tab=weather');
    play({ keepT: true });
    expect(pressed()).toEqual(['Weather']);
    act(() => root.unmount());
    root = createRoot(host);
    history.replaceState(null, '', '/replay/7?tab=LAPS');
    play({ keepT: true });
    expect(pressed()).toEqual(['Tower']);
  });

  it('a tab click writes &tab= next to t, a T write keeps it, and the tower drops it', () => {
    history.replaceState(null, '', '/replay/7');
    play({ keepT: true });
    button('Pause');
    expect(location.search).toBe('?t=21:00:00');
    button('Laps');
    expect(location.search).toBe('?t=21:00:00&tab=laps');
    button('Play');
    advance(15_000);
    expect(location.search).toBe('?t=21:00:15&tab=laps');
    button('Tower');
    expect(location.search).toBe('?t=21:00:15');
    expect(location.pathname).toBe('/replay/7');
  });

  it('/live neither reads nor writes the tab', () => {
    history.replaceState(null, '', '/live?tab=weather');
    play({ recording: open, start: 'live' });
    expect(pressed()).toEqual(['Tower']);
    button('Laps');
    expect(pressed()).toEqual(['Laps']);
    expect(location.pathname + location.search).toBe('/live?tab=weather');
  });
});
