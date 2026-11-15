import { Forecast } from '@f1/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { sessionHours, startRow, startWords, summary, upcoming, updatedWords } from '../src/lib/forecast.ts';
import { ForecastCard, ForecastCredit, ForecastView } from '../src/views/Forecast.tsx';
import { sessionDetail } from './laps.ts';

// The weekend forecast (#120, A§13): the lib's hour selection and words, and the Weather tab's card from props. Rows are
// dated by the END of their hour (C6).

const row = (date: string, p: number | null, mm: number | null, t: number | null, w: number | null) => ({
  date,
  precipitation_probability: p,
  precipitation: mm,
  temperature_2m: t,
  wind_speed_10m: w,
});
const hours = [
  row('2026-11-20T14:00:00.000Z', 10, 0, 20, 1),
  row('2026-11-20T15:00:00.000Z', 40, 0.24, 18.4, 3.04),
  row('2026-11-20T16:00:00.000Z', 70, 1.31, 17.6, 5.25),
  row('2026-11-20T17:00:00.000Z', 20, 0.05, 16.5, 2),
];
const forecast = (map_id = 'us-2023', fetched_at = '2026-11-20T09:10:00.000Z', rows = hours) =>
  Forecast.parse({ map_id, fetched_at, hours: rows }) as NonNullable<Forecast>;

// A session from 15:30Z to 16:15Z: it starts in the row dated 16:00Z and ends in the one dated 17:00Z.
const span = { date_start: '2026-11-20T15:30:00.000Z', date_end: '2026-11-20T16:15:00.000Z', is_cancelled: false };
const now = Date.parse('2026-11-20T09:30:00.000Z');
const session = (over: Partial<typeof span> = {}) => ({
  ...sessionDetail('Practice', 'Practice 1').session,
  ...span,
  ...over,
});
const textOf = (html: string) => html.replace(/<[^>]+>/g, '');

describe('the forecast hours', () => {
  const at = (date_start: string, date_end: string) => ({ date_start, date_end, is_cancelled: false });

  it("takes the rows in (floorHour(start), ceilHour(end)]: a row is dated by the hour's end", () => {
    expect(sessionHours(hours, span).map((h) => h.date)).toEqual([
      '2026-11-20T16:00:00.000Z',
      '2026-11-20T17:00:00.000Z',
    ]);
    // On the hour: 15:00-16:00 is the row dated 16:00, and 15:00 itself belongs to the hour before.
    const exact = at('2026-11-20T15:00:00.000Z', '2026-11-20T16:00:00.000Z');
    expect(sessionHours(hours, exact).map((h) => h.date)).toEqual(['2026-11-20T16:00:00.000Z']);
    expect(sessionHours(hours, at('2026-11-21T15:00:00.000Z', '2026-11-21T16:00:00.000Z'))).toEqual([]);
  });

  it('starts at the row dated floorHour(start) + 1 h, or none', () => {
    expect(startRow(hours, span)?.date).toBe('2026-11-20T16:00:00.000Z');
    expect(startRow(hours, at('2026-11-20T15:00:00.000Z', '2026-11-20T16:00:00.000Z'))?.date).toBe(
      '2026-11-20T16:00:00.000Z',
    );
    expect(startRow(hours, at('2026-11-20T17:30:00.000Z', '2026-11-20T18:00:00.000Z'))).toBeNull();
  });

  it('is shown only before the start and unless cancelled', () => {
    expect(upcoming(span, Date.parse('2026-11-20T15:29:59.000Z'))).toBe(true);
    expect(upcoming(span, Date.parse('2026-11-20T15:30:00.000Z'))).toBe(false);
    expect(upcoming({ ...span, is_cancelled: true }, now)).toBe(false);
  });
});

describe('the forecast words', () => {
  it('rounds to whole numbers and drops a null part', () => {
    expect(startWords(hours[1] ?? null)).toBe('rain 40 %, 18 °C');
    expect(startWords(row('x', 0, 0, 17.6, null))).toBe('rain 0 %, 18 °C');
    expect(startWords(row('x', 55, null, null, null))).toBe('rain 55 %');
    expect(startWords(row('x', null, 1, 9.5, null))).toBe('10 °C');
    expect(startWords(row('x', null, 1, null, 4))).toBeNull();
    expect(startWords(null)).toBeNull();
  });

  it('summarises a session: highest chance, rain total, air range and highest wind', () => {
    expect(summary(sessionHours(hours, span))).toEqual({
      chance: '70 %',
      rain: '1.4 mm',
      air: '17–18 °C',
      wind: '5.3 m/s',
    });
    expect(summary([row('x', null, null, 18.4, null), row('y', null, null, 18.2, null)])).toEqual({
      chance: null,
      rain: null,
      air: '18 °C',
      wind: null,
    });
  });

  it('says "updated HH:mm" in Amsterdam time, or the weekday form from another Amsterdam day', () => {
    // 09:10Z is 10:10 in Amsterdam (CET).
    expect(updatedWords('2026-11-20T09:10:00.000Z', now)).toBe('updated 10:10');
    // 23:30Z on the 19th is 00:30 on the 20th in Amsterdam: the same day as now.
    expect(updatedWords('2026-11-19T23:30:00.000Z', now)).toBe('updated 00:30');
    expect(updatedWords('2026-11-19T22:30:00.000Z', now)).toBe('updated Thu 19 Nov 2026, 23:30');
  });
});

describe('the forecast card', () => {
  const card = (f = forecast(), s = session(), at = now) =>
    renderToStaticMarkup(<ForecastView forecast={f} session={s} now={at} />);

  it('labels the model forecast and when it was updated', () => {
    const html = card();
    expect(html).toContain('<section class="card forecast">');
    expect(html).toContain('<div class="panel-title"><h2>Forecast (model)</h2><p>updated 10:10</p></div>');
    expect(card(forecast('us-2023', '2026-11-19T09:10:00.000Z'))).toContain('<p>updated Thu 19 Nov 2026, 10:10</p>');
  });

  it('shows the four tiles over the session hours', () => {
    const html = card();
    expect(html).toContain('<dl class="tiles" aria-label="Forecast">');
    expect(html).toContain('<dt>Rain chance</dt><dd class="v">70 %</dd><dd class="who">highest</dd>');
    expect(html).toContain('<dt>Rain</dt><dd class="v">1.4 mm</dd>');
    expect(html).toContain('<dt>Air</dt><dd class="v">17–18 °C</dd>');
    expect(html).toContain('<dt>Wind</dt><dd class="v">5.3 m/s</dd>');
  });

  it('gives a fixed reason for a missing value', () => {
    const html = card(
      forecast('us-2023', '2026-11-20T09:10:00.000Z', [row('2026-11-20T16:00:00.000Z', null, null, null, null)]),
    );
    for (const reason of [
      'No rain chance in the forecast',
      'No rain amount in the forecast',
      'No air temperature in the forecast',
      'No wind speed in the forecast',
    ])
      expect(html).toContain(reason);
    expect(html).not.toContain('class="v">—</dd><dd class="who"');
  });

  it("credits Open-Meteo, word for word, and Silverstone's Met Office data only there", () => {
    const html = card();
    expect(textOf(html)).toContain(
      'Weather data by Open-Meteo.com (CC BY 4.0). Modelled, not measured; hourly values rounded and summarised.',
    );
    expect(html).toContain('<a href="https://open-meteo.com/" rel="noreferrer">Open-Meteo.com</a>');
    expect(html).toContain('<a href="https://creativecommons.org/licenses/by/4.0/" rel="noreferrer">CC BY 4.0</a>');
    expect(html).not.toContain('Met Office');
    const uk = card(forecast('gb-1948'));
    expect(textOf(uk)).toContain('Includes UK Met Office model data (CC BY-SA 4.0).');
    expect(uk).toContain('<a href="https://creativecommons.org/licenses/by-sa/4.0/" rel="noreferrer">CC BY-SA 4.0</a>');
    expect(renderToStaticMarkup(<ForecastCredit map_id="us-2023" />)).not.toContain('Met Office');
  });

  it('is absent once the session started, when it is cancelled, without hours or without a forecast', () => {
    expect(card(forecast(), session(), Date.parse('2026-11-20T15:30:00.000Z'))).toBe('');
    expect(card(forecast(), session({ is_cancelled: true }))).toBe('');
    expect(card(forecast('us-2023', '2026-11-20T09:10:00.000Z', []))).toBe('');
    expect(card(forecast('us-2023', '2026-11-20T09:10:00.000Z', [hours[0] as (typeof hours)[number]]))).toBe('');
    expect(renderToStaticMarkup(<ForecastView forecast={null} session={session()} now={now} />)).toBe('');
  });

  it('renders from the query cache, and not at all while the query has no answer', () => {
    const detail = { ...sessionDetail('Practice', 'Practice 1'), session: session() };
    const render = (data?: Forecast) => {
      const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
      if (data) client.setQueryData(['forecast', detail.meeting.meeting_key], data);
      return renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <ForecastCard detail={detail} now={now} />
        </QueryClientProvider>,
      );
    };
    expect(render()).toBe('');
    expect(render(forecast())).toContain('<h2>Forecast (model)</h2>');
  });
});
