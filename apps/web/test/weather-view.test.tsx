import type { SessionDetail } from '@f1/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WeatherRow } from '../src/lib/weather.ts';
import { SessionHead } from '../src/views/SessionHead.tsx';
import { WeatherView } from '../src/views/Weather.tsx';
import { lap, sessionDetail } from './laps.ts';

// The Weather tab and the session head's line (P5a, A§13), rendered to markup with the data as props.

const T0 = Date.parse('2024-11-03T15:30:00Z'); // 16:30 in Amsterdam (CET)
const MIN = 60_000;
const w = (m: number, over: Partial<WeatherRow> = {}): WeatherRow => ({
  date: new Date(T0 + m * MIN).toISOString(),
  air_temperature: 22.2 + m / 10,
  track_temperature: 27.3 + m / 10,
  humidity: 86,
  pressure: 927.4,
  rainfall: 0,
  wind_direction: 191,
  wind_speed: 0.4 + m / 10,
  ...over,
});
const dry = [w(0), w(1), w(2)];
const wet = [w(-5, { rainfall: 1 }), w(-4, { rainfall: 1 }), w(0), w(5, { rainfall: 1 }), w(6, { rainfall: 1 }), w(7)];
// Laps 1 and 2 start at +2 and +5 min.
const laps = [
  lap(1, 1, { date_start: new Date(T0 + 2 * MIN).toISOString() }),
  lap(1, 2, { date_start: new Date(T0 + 5 * MIN).toISOString() }),
];
const withState = (d: SessionDetail, ingest_state: SessionDetail['session']['ingest_state']): SessionDetail => ({
  ...d,
  session: { ...d.session, ingest_state },
});
const race = sessionDetail('Race', 'Race');
const practice = sessionDetail('Practice', 'Practice 1');
const view = (rows: WeatherRow[], detail = race, l: typeof laps | null = laps) =>
  renderToStaticMarkup(<WeatherView rows={rows} detail={detail} laps={l} />);

describe('the Weather tab', () => {
  it('shows the tiles: air and track min–max, humidity, pressure in hPa, and wind in m/s with its point', () => {
    const html = view(dry);
    expect(html).toContain('<dl class="tiles wx" aria-label="Weather">');
    expect(html).toContain('<dt>Air</dt><dd class="v">22.2–22.4 °C</dd>');
    expect(html).toContain('<dt>Track</dt><dd class="v">27.3–27.5 °C</dd>');
    expect(html).toContain('<dt>Humidity</dt><dd class="v">86 %</dd>');
    expect(html).toContain('<dt>Pressure</dt><dd class="v">927 hPa</dd>');
    expect(html).toContain('<dt>Wind</dt><dd class="v">0.5 m/s S</dd><dd class="who">mean · max 0.6 m/s</dd>');
    expect(html).toContain('<dt>Rain</dt><dd class="v">Dry</dd>');
  });

  it('shows — with a reason behind a tap for a value that is null in every sample', () => {
    const html = view(
      dry.map((r) => ({ ...r, humidity: null, rainfall: null, wind_speed: null, wind_direction: null })),
    );
    const note = (dt: string, id: string, reason: string) =>
      `<dt>${dt}</dt><dd class="v"><button type="button" class="note" popoverTarget="${id}" aria-describedby="${id}" title="${reason}">—</button>`;
    expect(html).toContain(note('Humidity', 'wx-humidity', 'No humidity in the OpenF1 data'));
    expect(html).toContain(note('Wind', 'wx-wind', 'No wind reading in the OpenF1 data'));
    expect(html).toContain(note('Rain', 'wx-rain', 'No rainfall reading in the OpenF1 data'));
    expect(html).toContain('<dt>Air</dt><dd class="v">22.2–22.4 °C</dd>');
  });

  it('lists each rain period in Amsterdam time, with the leader’s laps in a race', () => {
    const html = view(wet);
    expect(html).toContain('<div class="rain"><dt>Rain</dt><dd class="v">Rain at times</dd>');
    expect(html).toContain(
      '<ul aria-label="Rain periods"><li>16:25–16:26 · before the start</li><li>16:35–16:36 · lap 2</li></ul>',
    );
    expect(view(wet, practice)).toContain('<li>16:25–16:26</li><li>16:35–16:36</li>');
    expect(view(wet, race, null)).toContain('<li>16:35–16:36</li>');
  });

  it('names the chart for a screen reader and keys its lines and bands in words', () => {
    const html = view(wet);
    expect(html).toContain('<h2>Air and track temperature</h2>');
    expect(html).toContain('role="img" aria-label="Air and track temperature"');
    expect(html).toMatch(
      /air · <span aria-hidden="true">╍<\/span> track · <span class="rainkey" aria-hidden="true"><\/span> rain/,
    );
    expect(view(dry)).not.toContain('rainkey');
  });

  it('says the weather is still to come before the first fetch, and that OpenF1 has none after it', () => {
    for (const state of ['scheduled', 'due'] as const)
      expect(view([], withState(race, state))).toBe(
        '<p>Weather arrives with the laps, about 35 min after the session ends.</p>',
      );
    for (const state of ['fetched', 'final', 'failed'] as const)
      expect(view([], withState(race, state))).toBe('<p>No weather in the OpenF1 data.</p>');
  });
});

describe('the session head’s weather line', () => {
  const head = (weather: WeatherRow[] | null) =>
    renderToStaticMarkup(<SessionHead detail={race} season={null} recordings={null} weather={weather} view="laps" />);

  it('reads "Air · Track · Dry", rounded, or "Rain at times"', () => {
    // Dry: air 22.2–22.4, track 27.3–27.5; wet: air 21.7–22.9, track 26.8–28.0.
    expect(head(dry)).toContain('<p class="muted wxline">Air 22 °C · Track 27–28 °C · Dry</p>');
    expect(head(wet)).toContain('<p class="muted wxline">Air 22–23 °C · Track 27–28 °C · Rain at times</p>');
  });

  it('is absent while there are no rows, and when no sample has a temperature or rain reading', () => {
    expect(head(null)).not.toContain('wxline');
    expect(head([])).not.toContain('wxline');
    expect(head([w(0, { air_temperature: null, track_temperature: null, rainfall: null })])).not.toContain('wxline');
  });
});
