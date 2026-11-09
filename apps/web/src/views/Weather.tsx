import type { Laps, SessionDetail, Weather as WeatherRows } from '@f1/contracts';
import { useCallback, useMemo } from 'react';
import { useWeather } from '../lib/api.ts';
import { fmtRange, periodText, type RainPeriod, rainPeriods, type Summary, summarise } from '../lib/weather.ts';
import { Pending } from '../ui/ErrorView.tsx';
import { Note } from '../ui/Note.tsx';
import { Chart } from './Chart.tsx';
import type { ChartTokens } from './lap-chart-option.ts';
import { Tile } from './Tiles.tsx';
import { weatherChartOption } from './weather-chart-option.ts';

// The Weather tab (P5a, A§13): the tiles, the rain periods and the temperature chart of every sample OpenF1 lists for
// the session. The tiles and the rain periods are the chart's text alternative.

type Data = { detail: SessionDetail; laps: Laps | null };

/** Before the first fetch there is nothing to show yet; after it, no rows means OpenF1 has none. */
const NOT_FETCHED = new Set(['scheduled', 'due']);

export function WeatherTab({ session, ...data }: Data & { session: number }) {
  const weather = useWeather(session);
  if (!weather.data) return <Pending error={weather.error} />;
  return <WeatherView rows={weather.data} {...data} />;
}

const unit = (r: Summary['air'], digits: number, u: string) => r && `${fmtRange(r, digits)} ${u}`;

export function WeatherSummary({
  summary: s,
  periods,
  laps,
  type,
}: {
  summary: Summary;
  periods: readonly RainPeriod[];
  laps: Laps | null;
  type: string | null;
}) {
  const wind = s.wind && [`${s.wind.mean.toFixed(1)} m/s`, s.direction].filter(Boolean).join(' ');
  return (
    <dl className="tiles wx" aria-label="Weather">
      <Tile
        id="wx-air"
        label="Air"
        value={unit(s.air, 1, '°C')}
        who={null}
        reason="No air temperature in the OpenF1 data"
      />
      <Tile
        id="wx-track"
        label="Track"
        value={unit(s.track, 1, '°C')}
        who={null}
        reason="No track temperature in the OpenF1 data"
      />
      <Tile
        id="wx-humidity"
        label="Humidity"
        value={unit(s.humidity, 0, '%')}
        who={null}
        reason="No humidity in the OpenF1 data"
      />
      {/* OpenF1 reports mbar, the same as hPa. */}
      <Tile
        id="wx-pressure"
        label="Pressure"
        value={unit(s.pressure, 0, 'hPa')}
        who={null}
        reason="No air pressure in the OpenF1 data"
      />
      <Tile
        id="wx-wind"
        label="Wind"
        value={wind ?? (s.direction && `${s.direction}`)}
        who={s.wind && `mean · max ${s.wind.max.toFixed(1)} m/s`}
        reason="No wind reading in the OpenF1 data"
      />
      <div className={periods.length > 0 ? 'rain' : undefined}>
        <dt>Rain</dt>
        <dd className="v">
          {s.rain === null ? (
            <Note id="wx-rain" text="No rainfall reading in the OpenF1 data">
              —
            </Note>
          ) : s.rain === 'dry' ? (
            'Dry'
          ) : (
            'Rain at times'
          )}
        </dd>
        {periods.length > 0 && (
          <dd className="who">
            <ul aria-label="Rain periods">
              {periods.map((p) => (
                <li key={p.from}>{periodText(p, laps, type)}</li>
              ))}
            </ul>
          </dd>
        )}
      </div>
    </dl>
  );
}

export function WeatherView({ rows, detail, laps }: Data & { rows: WeatherRows }) {
  const type = detail.session.type;
  const summary = useMemo(() => summarise(rows), [rows]);
  const periods = useMemo(() => rainPeriods(rows), [rows]);
  const option = useCallback(
    (t: ChartTokens) => weatherChartOption(rows, t, { periods, laps, type }),
    [rows, periods, laps, type],
  );
  if (rows.length === 0)
    return (
      <p>
        {NOT_FETCHED.has(detail.session.ingest_state)
          ? 'Weather arrives with the laps, about 35 min after the session ends.'
          : 'No weather in the OpenF1 data.'}
      </p>
    );
  return (
    <>
      <WeatherSummary summary={summary} periods={periods} laps={laps} type={type} />
      <section className="card">
        <div className="panel-title">
          <h2>Air and track temperature</h2>
          <p>°C, Amsterdam time</p>
        </div>
        <p className="keys">
          <span aria-hidden="true">━</span> air · <span aria-hidden="true">╍</span> track
          {periods.length > 0 && (
            <>
              {' · '}
              <span className="rainkey" aria-hidden="true" /> rain
            </>
          )}
        </p>
        <Chart label="Air and track temperature" option={option} />
      </section>
    </>
  );
}
