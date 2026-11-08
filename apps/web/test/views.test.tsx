import { Laps, Recordings, SessionDetail, Status, Stints } from '@f1/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Next, RecordingsList } from '../src/views/Live.tsx';
import { RecorderWarnings, StatusPanel } from '../src/views/Status.tsx';
import { StintBars, stintLayout } from '../src/views/Stints.tsx';

// The stints bars (D11) and the status panel (D12), on hand-built data.

const meeting = {
  official_name: null,
  location: 'Marina Bay',
  country_code: null,
  circuit_short_name: null,
  gmt_offset: null,
  date_start: null,
  date_end: null,
  is_cancelled: false,
};
const session = (session_key: number, name: string, date_start: string, is_cancelled = false) => ({
  session_key,
  type: 'Race',
  name,
  date_start,
  date_end: date_start,
  ingest_state: 'final',
  is_cancelled,
});

describe('the stints bars', () => {
  const lapsOf = (driver_number: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      driver_number,
      lap_number: i + 1,
      date_start: null,
      lap_ms: null,
      s1_ms: null,
      s2_ms: null,
      s3_ms: null,
      i1_kph: null,
      i2_kph: null,
      st_kph: null,
      is_pit_out: null,
      is_pit_in: false,
      seg1: null,
      seg2: null,
      seg3: null,
      deleted: false,
      deleted_reason: null,
      quali_phase: null,
      compound: null,
      colour: { lap: null, s1: null, s2: null, s3: null },
    }));
  const iso = '2026-10-11T12:00:00.000Z';
  const detail = SessionDetail.parse({
    session: { ...session(9965, 'Race', iso), meeting_key: 1290 },
    meeting: { ...meeting, meeting_key: 1290, name: 'Singapore Grand Prix', year: 2026 },
    drivers: [{ driver_number: 4, acronym: 'NOR', full_name: null, team_name: null, team_colour: 'F47600' }],
    results: [],
  });
  const stint = (
    driver_number: number,
    stint_number: number,
    lap_start: number | null,
    lap_end: number | null,
    compound: string | null,
    tyre_age_at_start: number | null = 0,
  ) => ({ driver_number, stint_number, lap_start, lap_end, compound, tyre_age_at_start });
  const nor = { number: 4, acronym: 'NOR', name: null, team: null };
  const layout = (n: number, rows: ReturnType<typeof stint>[], lapN = n) =>
    stintLayout([nor], Laps.parse(lapsOf(4, lapN)), Stints.parse(rows)).rows[0];

  describe('stintLayout', () => {
    it('puts a stint at its first lap over the total, and a used set apart from a new or unknown one', () => {
      const row = layout(40, [
        stint(4, 1, 1, 10, 'MEDIUM', 0),
        stint(4, 2, 11, 30, 'HARD', 3),
        stint(4, 3, 31, 40, 'SOFT', null),
      ]);
      expect(
        row?.segs.map(({ x, w, letter, compound, laps, used }) => ({ x, w, letter, compound, laps, used })),
      ).toEqual([
        { x: 0, w: 0.25, letter: 'M', compound: 'medium', laps: 10, used: false },
        { x: 0.25, w: 0.5, letter: 'H', compound: 'hard', laps: 20, used: true },
        { x: 0.75, w: 0.25, letter: 'S', compound: 'soft', laps: 10, used: false },
      ]);
      expect(row?.stops).toBe(2);
    });

    it('lets the track run to the last lap, so a hole after the last stint shows', () => {
      const row = layout(40, [stint(4, 1, 1, 10, 'MEDIUM'), stint(4, 2, 11, 30, 'HARD')]);
      expect(row?.track).toBe(1);
      expect(row?.segs.at(-1)).toMatchObject({ x: 0.25, w: 0.5 });
    });

    it('lists a stint without lap bounds and draws none for it', () => {
      const row = layout(40, [
        stint(4, 1, 1, 20, 'HARD'),
        stint(4, 2, null, null, 'MEDIUM'),
        stint(4, 3, 21, null, 'SOFT'),
      ]);
      expect(row?.segs).toHaveLength(1);
      expect(row?.unplaced.map((u) => [u.stint, u.compound, u.letter])).toEqual([
        [2, 'medium', 'M'],
        [3, 'soft', 'S'],
      ]);
      expect(row?.stops).toBe(2);
    });

    it('counts no stop for no stint or one', () => {
      expect(layout(10, [], 10)?.stops).toBe(0);
      expect(layout(10, [stint(4, 1, 1, 10, 'HARD')])?.stops).toBe(0);
    });

    it('letters I, W and ? for intermediate, wet and unknown compounds', () => {
      const row = layout(30, [
        stint(4, 1, 1, 10, 'INTERMEDIATE'),
        stint(4, 2, 11, 20, 'WET'),
        stint(4, 3, 21, 30, 'NEW'),
      ]);
      expect(row?.segs.map((s) => s.letter)).toEqual(['I', 'W', '?']);
    });

    it('ticks every 10 laps below the total, and the total, dropping one within 3 laps of it', () => {
      const ticks = (n: number) => stintLayout([nor], Laps.parse(lapsOf(4, n)), Stints.parse([])).ticks;
      expect(ticks(57)).toEqual([10, 20, 30, 40, 50, 57]);
      expect(ticks(60)).toEqual([10, 20, 30, 40, 50, 60]);
      // A tick within 3 laps of the total goes: its label would crowd the total's.
      expect(ticks(51)).toEqual([10, 20, 30, 40, 51]);
      expect(ticks(53)).toEqual([10, 20, 30, 40, 53]);
      expect(ticks(54)).toEqual([10, 20, 30, 40, 50, 54]);
    });
  });

  const html = renderToStaticMarkup(
    <StintBars
      detail={detail}
      laps={Laps.parse([...lapsOf(81, 40), ...lapsOf(4, 40)])}
      stints={Stints.parse([
        stint(4, 1, 1, 10, 'MEDIUM', 0),
        stint(4, 2, 11, 40, 'HARD', 3),
        stint(81, 1, 1, 30, 'x onclick', null),
        stint(81, 2, null, null, 'HARD', null),
      ])}
      periods={[
        { kind: 'sc', from: 12, to: 13 },
        { kind: 'vsc', from: 20, to: 20 },
      ]}
    />,
  );

  it('draws each stint at its place on the lap scale, with no title', () => {
    expect(html).toContain(
      '<span class="seg cmp-medium" style="--x:0.000%;--w:25.000%"><b>M</b><small>10</small></span>',
    );
    expect(html).toContain(
      '<span class="seg cmp-hard" style="--x:25.000%;--w:75.000%"><b>H</b><small>30<span class="used"> · used</span></small></span>',
    );
    expect(html).not.toContain('title=');
    expect(html).toContain('<span class="trackline" style="--w:100.000%">');
  });

  it('marks an unknown compound and orders the drivers as the lap table does', () => {
    expect(html).toContain('<span class="seg cmp-unknown"');
    // The API's raw compound never reaches a class name: only the five known ones or unknown, in the legend too.
    expect(html).toContain('<span class="cmp cmp-unknown" aria-hidden="true">?</span>unknown');
    expect(new Set([...html.matchAll(/cmp-([\w-]+)/g)].map(([, c]) => c))).toEqual(
      new Set(['medium', 'hard', 'unknown']),
    );
    expect(html).not.toContain('onclick');
    expect([...html.matchAll(/class="drv"[^>]*>(\w+)</g)].map(([, a]) => a)).toEqual(['NOR', '81']);
  });

  it('makes each row a button for its popover, named for a screen reader', () => {
    expect(html).toContain('popoverTarget="stints-4"');
    expect(html).toContain('popoverTarget="stints-81"');
    expect(html).toContain('aria-label="NOR, 1 stop: medium laps 1 to 10, hard laps 11 to 40"');
    expect(html).toContain('aria-label="81, 1 stop: unknown compound laps 1 to 30, hard laps unknown"');
    expect(html).toContain('<span class="stop">1 stop</span>');
  });

  it('lists the stints in the popover', () => {
    expect(html).toContain('<div popover="auto" id="stints-4" class="pop">');
    expect(html).toContain('<li>Medium, laps 1–10 (10 laps), new set</li>');
    expect(html).toContain(
      '<li>Hard, laps 11–40 (30 laps), used set, 3 laps old at the start (may be wrong for a used set)</li>',
    );
    expect(html).toContain('<li>Unknown compound, laps 1–30 (30 laps)</li>');
    expect(html).toContain('<li>Hard, laps unknown</li>');
  });

  it('draws the ticks, the SC and VSC lines and the legend', () => {
    expect(html).toContain('<span class="tick" style="--x:25.000%">10</span>');
    expect(html).toContain('<span class="tick tick-end" style="--x:100.000%">40</span>');
    expect(html).toContain('<i class="rule" style="--x:25.000%"></i>');
    expect(html).toContain('<i class="vscline" style="--x:27.500%;--w:5.000%"></i>');
    expect(html).toContain('<i class="vscline" style="--x:47.500%;--w:2.500%"></i>');
    expect(html).toContain('SC, laps 12–13');
    expect(html).toContain('VSC, lap 20');
    expect(html).not.toContain('RED');
    expect(html).toContain('number: laps in the stint');
    expect(html).toContain('<span class="cmp cmp-medium" aria-hidden="true">M</span>medium');
  });
});

describe('the status panel', () => {
  const recorder = {
    state: 'recording',
    session_key: 9965,
    meeting_name: 'Singapore Grand Prix',
    session_name: 'Race',
    token_expires_at: '2026-10-11T12:00:00.000Z',
    last_error: null,
    warning: null,
    stale: false,
    updated_at: '2026-10-11T11:00:00.000Z',
  };
  const render = (r: Record<string, unknown> | null) =>
    renderToStaticMarkup(
      <StatusPanel
        status={Status.parse({
          states: { scheduled: 25, due: 0, fetched: 1, final: 454, failed: 1 },
          cancelled: 15,
          failed: [
            {
              session_key: 9965,
              year: 2026,
              meeting_name: 'Singapore Grand Prix',
              session_name: 'Race',
              fail_count: 3,
              last_error: '<b>http_500</b>',
              next_fetch_at: '2026-10-11T12:00:00.000Z',
            },
          ],
          recorder: r && { ...recorder, ...r },
        })}
      />,
    );
  const html = render(null);

  it('counts sessions per state and the cancelled ones', () => {
    expect(html).toContain('<h1 tabindex="-1">Status</h1><h2>Ingest</h2>');
    expect(html).toContain('<dt>final</dt><dd>454</dd>');
    expect(html).toContain('<dt>cancelled</dt><dd>15</dd>');
  });

  it('lists failed sessions with the error as text, in a focusable, named scroll region', () => {
    expect(html).toContain(
      '<div class="scroll" tabindex="0" role="region" aria-label="Last fetch failed"><table class="list" aria-label="Last fetch failed">',
    );
    expect(html).toContain('<td>&lt;b&gt;http_500&lt;/b&gt;</td><td>Sun 11 Oct 2026, 14:00</td>');
  });

  it('the recorder: nothing yet', () => {
    expect(html).toContain('<h2>Recorder</h2><p>The recorder has not reported yet.</p>');
    expect(html).not.toContain('role="alert"');
  });

  it('the recorder: state, session, token expiry and last report', () => {
    const r = render({});
    expect(r).toContain('<dt>state</dt><dd>recording</dd>');
    expect(r).toContain('<dt>session</dt><dd>Singapore Grand Prix Race</dd>');
    expect(r).toContain('<dt>token expires</dt><dd>Sun 11 Oct 2026, 14:00</dd>');
    expect(r).toContain('<dt>last error</dt><dd>None</dd>');
    expect(r).toContain('<dt>last report</dt><dd>Sun 11 Oct 2026, 13:00</dd>');
    expect(r).not.toContain('role="alert"');
  });

  it('the recorder: connecting names the session it waits for', () => {
    expect(render({ state: 'connecting' })).toContain('<dt>session</dt><dd>Singapore Grand Prix Race</dd>');
  });

  it('the recorder: idle without a session or token, and the last error code', () => {
    const r = render({
      state: 'idle',
      session_key: null,
      meeting_name: null,
      session_name: null,
      token_expires_at: null,
      last_error: 'feed_timeout',
    });
    expect(r).toContain('<dt>state</dt><dd>idle</dd>');
    expect(r).toContain('<dt>session</dt><dd>—</dd>');
    expect(r).toContain('<dt>token expires</dt><dd>—</dd>');
    expect(r).toContain('<dt>last error</dt><dd>feed_timeout</dd>');
  });

  it.each([
    ['token_expiring', 'The F1 TV token expires within 24 h and a session is due.'],
    ['login_failed', 'The F1 TV login failed. Recording continues without a token; paste a token if it keeps failing.'],
    ['disk_low', 'Less than 5 GB free for recordings.'],
  ])('the recorder: warning %s', (warning, text) => {
    expect(render({ warning })).toContain(`<p role="alert">${text}</p>`);
  });

  it('the recorder: stale, alone and with a warning', () => {
    const stale = 'The recorder has not reported for over 5 minutes.';
    expect(render({ stale: true })).toContain(`<p role="alert">${stale}</p>`);
    const both = render({ stale: true, warning: 'disk_low' });
    expect(both).toContain(`<p role="alert">Less than 5 GB free for recordings.</p><p role="alert">${stale}</p>`);
  });
});

describe('the recorder warnings on /live', () => {
  const recorder = (r: Record<string, unknown>) =>
    Status.parse({
      states: { scheduled: 0, due: 0, fetched: 0, final: 0, failed: 0 },
      cancelled: 0,
      failed: [],
      recorder: r,
    }).recorder;
  const base = {
    state: 'idle',
    session_key: null,
    meeting_name: null,
    session_name: null,
    token_expires_at: null,
    last_error: null,
    warning: null,
    stale: false,
    updated_at: '2026-10-11T11:00:00.000Z',
  };

  it('renders nothing without a recorder, a warning or a stale report', () => {
    expect(renderToStaticMarkup(<RecorderWarnings recorder={null} />)).toBe('');
    expect(renderToStaticMarkup(<RecorderWarnings recorder={recorder(base)} />)).toBe('');
  });

  it('renders the warning and the stale notice as alerts', () => {
    const html = renderToStaticMarkup(
      <RecorderWarnings recorder={recorder({ ...base, warning: 'disk_low', stale: true })} />,
    );
    expect(html).toBe(
      '<p role="alert">Less than 5 GB free for recordings.</p>' +
        '<p role="alert">The recorder has not reported for over 5 minutes.</p>',
    );
  });
});

describe('the recordings list', () => {
  const rec = (id: number, ended_at: string | null, complete: boolean) => ({
    id,
    session_key: 9965,
    year: 2026,
    meeting_name: 'Singapore Grand Prix',
    session_name: 'Race',
    session_type: 'Race',
    date_start: '2026-10-11T12:00:00.000Z',
    started_at: '2026-10-11T11:00:00.000Z',
    ended_at,
    complete,
  });
  const html = renderToStaticMarkup(
    <RecordingsList
      recordings={Recordings.parse([
        rec(3, null, false),
        rec(2, '2026-10-11T14:00:00.000Z', false),
        rec(1, '2026-10-11T14:00:00.000Z', true),
      ])}
    />,
  );

  it('links each recording to its replay with the start in Amsterdam time', () => {
    expect(html).toContain('<a href="/replay/2">Singapore Grand Prix · Race</a>');
    expect(html).toContain('<time dateTime="2026-10-11T11:00:00.000Z">Sun 11 Oct 2026, 13:00</time>');
  });

  it('tags a recording as recording, incomplete or complete', () => {
    expect(html.match(/<span class="badge">[a-z]+<\/span>/g)).toEqual([
      '<span class="badge">recording</span>',
      '<span class="badge">incomplete</span>',
      '<span class="badge">complete</span>',
    ]);
  });

  it('says so when there are none', () => {
    expect(renderToStaticMarkup(<RecordingsList recordings={[]} />)).toBe('<p class="muted">No recordings yet.</p>');
  });
});

describe('the next session on /live', () => {
  const session = {
    session_key: 9965,
    meeting_name: 'Singapore Grand Prix',
    session_name: 'Race',
    date_start: '2026-10-11T12:00:00.000Z',
    date_end: '2026-10-11T14:00:00.000Z',
  };

  it('names it with its start, and links the replay when a recording exists', () => {
    const none = renderToStaticMarkup(<Next live={{ session, recording: null }} />);
    expect(none).toContain(
      'Next: Singapore Grand Prix · Race starts <time dateTime="2026-10-11T12:00:00.000Z">Sun 11 Oct 2026, 14:00</time>',
    );
    expect(none).not.toContain('/replay/');
    const recording = { id: 4, started_at: session.date_start, ended_at: session.date_end, complete: true };
    expect(renderToStaticMarkup(<Next live={{ session, recording }} />)).toContain('<a href="/replay/4">Replay</a>');
  });

  it('says so when no session is scheduled', () => {
    expect(renderToStaticMarkup(<Next live={{ session: null, recording: null }} />)).toBe(
      '<p>No session is scheduled.</p>',
    );
  });
});
