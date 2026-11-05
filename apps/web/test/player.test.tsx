// @vitest-environment happy-dom
import { Lap, SessionDetail, view } from '@f1/contracts';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markers, streamUrl } from '../src/lib/stream.ts';
import { Player, type PlayerRecording } from '../src/views/Player.tsx';

// `view` (a zod parse of a topic) counts what the tower, the clock line's info and the markers derive from the state.
vi.mock('@f1/contracts', async (load) => {
  const m = await load<typeof import('@f1/contracts')>();
  return { ...m, view: vi.fn(m.view) };
});

// The player (A§13, A§15): a real React tree in happy-dom, a fake EventSource, fake timers, no fetch.

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

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  FakeES.all = [];
  vi.stubGlobal('EventSource', FakeES);
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

const render = (props: Partial<Parameters<typeof Player>[0]>) =>
  act(() => root.render(<Player recording={open} start="live" detail={undefined} {...props} />));
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
const openCount = () => FakeES.all.filter((e) => !e.closed).length;

describe('streamUrl', () => {
  it('builds live and replay URLs', () => {
    expect(streamUrl({ recording: 7, at: 'live', delay: 12 })).toBe('/api/v1/playback/7/stream?at=live&delay=12');
    expect(streamUrl({ recording: 7, at: 1234, delay: 12 })).toBe('/api/v1/playback/7/stream?at=1234');
  });
});

describe('markers', () => {
  it('comes from the status series alone: start (not the 2 s blip), TrackStatus Red, Finished', () => {
    const state = {
      SessionData: {
        StatusSeries: {
          '0': { Utc: '2026-10-25T20:00:00', TrackStatus: 'AllClear' },
          '1': { Utc: '2026-10-25T20:00:00', SessionStatus: 'Started' },
          '2': { Utc: '2026-10-25T20:00:02', SessionStatus: 'Aborted' },
          '3': { Utc: '2026-10-25T20:05:00.000Z', SessionStatus: 'Started' },
          '4': { Utc: '2026-10-25T20:05:50', TrackStatus: 'Yellow' }, // not a SessionStatus: the start stays
          '5': { Utc: '2026-10-25T20:30:00', TrackStatus: 'Red' },
          '6': { Utc: '2026-10-25T21:30:00', SessionStatus: 'Finished' },
        },
      },
    };
    expect(markers(state)).toEqual([
      { kind: 'start', t: Date.parse('2026-10-25T20:05:00Z') },
      { kind: 'red', t: Date.parse('2026-10-25T20:30:00Z') },
      { kind: 'chequered', t: Date.parse('2026-10-25T21:30:00Z') },
    ]);
    expect(markers({})).toEqual([]);
  });

  it('a RaceControl RED or CHEQUERED alone gives no marker', () => {
    const Messages = {
      '0': { Utc: '2026-10-25T20:30:00', Category: 'Flag', Flag: 'RED' },
      '1': { Utc: '2026-10-25T21:30:00', Category: 'Flag', Flag: 'CHEQUERED' },
    };
    expect(markers({ RaceControlMessages: { Messages } })).toEqual([]);
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
    click('Delay −30 s');
    click('Delay −1 s');
    expect(delayShown()).toBe(0);
    click('Delay +5 s');
    click('Delay +1 s');
    expect(delayShown()).toBe(6);
    slide('Delay', 118);
    expect(delayShown()).toBe(118);
    expect(host.textContent).toContain('Delay 118 s');
    click('Delay +30 s');
    expect(delayShown()).toBe(120);
    click('Delay +1 s');
    expect(delayShown()).toBe(120);
    click('Delay −1 s');
    expect(delayShown()).toBe(119);
  });

  it('delay is remembered per device, and defaults to 0 when storage throws', () => {
    localStorage.setItem('f1.delay', '45');
    render({});
    expect(delayShown()).toBe(45);
    expect(last().url).toContain('delay=45');
    click('Delay +5 s');
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
    click('Delay +5 s'); // the write throws; the value still shows
    expect(delayShown()).toBe(5);
  });

  it('a delay change closes the old stream and opens one with the new delay', () => {
    render({});
    expect(FakeES.all).toHaveLength(1);
    const first = last();
    expect(first.url).toBe('/api/v1/playback/7/stream?at=live&delay=0');
    click('Delay +1 s');
    advance(100);
    click('Delay +5 s');
    advance(300);
    slide('Delay', 9);
    advance(399);
    expect(FakeES.all).toHaveLength(1);
    expect(first.closed).toBe(false);
    advance(1);
    expect(FakeES.all).toHaveLength(2);
    expect(first.closed).toBe(true);
    expect(last().url).toBe('/api/v1/playback/7/stream?at=live&delay=9');
    expect(openCount()).toBe(1);
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

    click('Position +5 s');
    click('Position +5 s');
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

    // A nudge past the end clamps to it.
    click('Position +30 s');
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

    // Data that fails its contract is an error too.
    last().emit('delta', { t: 'x' });
    expect(last().closed).toBe(true);
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
      state: { SessionData: { StatusSeries }, TimingData: { Lines: { '1': { Line: 1, Position: '1' } } } },
      laps: [],
      stints: [],
    });
    advance(250);
    const clockText = () => host.querySelector('.clock time')?.textContent;
    const before = clockText();
    const calls = vi.mocked(view).mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    advance(5_000);
    expect(clockText()).not.toBe(before); // the clock ticked
    expect(vi.mocked(view).mock.calls.length).toBe(calls);
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
        TimingData: {
          Lines: {
            '1': { Line: 1, Position: '1', GapToLeader: 'LAP 3', LastLapTime: { Value: '1:20.000' } },
            '44': { Line: 2, Position: '2', GapToLeader: '+1.234', IntervalToPositionAhead: { Value: '+1.234' } },
          },
        },
        LapCount: { CurrentLap: 3, TotalLaps: 71 },
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
    expect(host.textContent).toContain('AllClear');

    last().emit('delta', {
      t: t + 1_000,
      topic: 'TimingData',
      data: { Lines: { '1': { Line: 2 }, '44': { Line: 1 } } },
    });
    last().emit('delta', { t: t + 1_500, topic: 'TrackStatus', data: { Status: '2', Message: 'Yellow' } });
    expect(tower()).toEqual(['VER', 'HAM']); // throttled
    advance(250);
    expect(tower()).toEqual(['HAM', 'VER']);
    expect(host.textContent).toContain('Yellow');

    button('Laps');
    const lapHeads = () => [...host.querySelectorAll('table.laps thead th')].map((x) => x.textContent);
    expect(lapHeads()).toEqual(['Driver', '1']);
    last().emit('laps', { t: t + 2_000, laps: [lap(1, 2), lap(44, 1)], stints: [] });
    advance(250);
    expect(lapHeads()).toEqual(['Driver', '1', '2']);
    // Drivers come from the stream's DriverList, ordered by its TimingData positions.
    expect([...host.querySelectorAll('table.laps tbody th')].map((x) => x.textContent)).toEqual(['VER', 'HAM']);
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
