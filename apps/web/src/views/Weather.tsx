import type { Laps, Live, SessionDetail, Weather as WeatherRows } from '@f1/contracts';
import { useCallback, useMemo } from 'react';
import { useWeather } from '../lib/api.ts';
import { sourceWords } from '../lib/session.ts';
import { fmtRange, periodText, type RainPeriod, rainPeriods, type Summary, summarise } from '../lib/weather.ts';
import { Pending } from '../ui/ErrorView.tsx';
import { NoData } from '../ui/NoData.tsx';
import { Note } from '../ui/Note.tsx';
import { Chart } from './Chart.tsx';
import type { ChartTokens } from './lap-chart-option.ts';
import { RainMapCard } from './RainMap.tsx';
import { Tile } from './Tiles.tsx';
import { weatherChartOption } from './weather-chart-option.ts';

// The Weather tab (P5a, A§13): the tiles, the rain periods and the temperature chart of every sample OpenF1 lists for
// the session. The tiles and the rain periods are the chart's text alternative. The player's Weather tab (P5b) shows
// the same panels from the feed's rows up to T. Both put the rain map (P5c, views/RainMap.tsx) under them.

type Data = { detail: SessionDetail; laps: Laps | null; live: Live | null };

/** `now`: the clock of the reason, epoch ms. */
export function WeatherTab({ session, ...data }: Data & { session: number; now: number }) {
  const weather = useWeather(session);
  return (
    <>
      {weather.data ? <WeatherView rows={weather.data} {...data} /> : <Pending error={weather.error} />}
      {/* The rain map comes from its own source (Open-Meteo, P5c), so it shows without OpenF1 rows too. */}
      <RainMapCard detail={data.detail} />
    </>
  );
}

const unit = (r: Summary['air'], digits: number, u: string) => r && `${fmtRange(r, digits)} ${u}`;

export function WeatherSummary({
  summary: s,
  periods,
  laps,
  type,
  source,
}: {
  summary: Summary;
  periods: readonly RainPeriod[];
  laps: Laps | null;
  type: string | null;
  /** Where the readings come from, for the reasons: "the OpenF1 data" or "the feed". */
  source: string;
}) {
  const wind = s.wind && [`${s.wind.mean.toFixed(1)} m/s`, s.direction].filter(Boolean).join(' ');
  return (
    <dl className="tiles wx" aria-label="Weather">
      <Tile
        id="wx-air"
        label="Air"
        value={unit(s.air, 1, '°C')}
        who={null}
        reason={`No air temperature in ${source}`}
      />
      <Tile
        id="wx-track"
        label="Track"
        value={unit(s.track, 1, '°C')}
        who={null}
        reason={`No track temperature in ${source}`}
      />
      <Tile
        id="wx-humidity"
        label="Humidity"
        value={unit(s.humidity, 0, '%')}
        who={null}
        reason={`No humidity in ${source}`}
      />
      {/* OpenF1 reports mbar, the same as hPa. */}
      <Tile
        id="wx-pressure"
        label="Pressure"
        value={unit(s.pressure, 0, 'hPa')}
        who={null}
        reason={`No air pressure in ${source}`}
      />
      <Tile
        id="wx-wind"
        label="Wind"
        value={wind ?? (s.direction && `${s.direction}`)}
        who={s.wind && `mean · max ${s.wind.max.toFixed(1)} m/s`}
        reason={`No wind reading in ${source}`}
      />
      <div className={periods.length > 0 ? 'rain' : undefined}>
        <dt>Rain</dt>
        <dd className="v">
          {s.rain === null ? (
            <Note id="wx-rain" text={`No rainfall reading in ${source}`}>
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

/** The tiles and the chart of `rows`; the chart's option is rebuilt only when `rows`, `laps` or `type` change. */
export function WeatherPanels({
  rows,
  laps,
  type,
  source,
}: {
  rows: WeatherRows;
  laps: Laps | null;
  type: string | null;
  source: string;
}) {
  const summary = useMemo(() => summarise(rows), [rows]);
  const periods = useMemo(() => rainPeriods(rows), [rows]);
  const option = useCallback(
    (t: ChartTokens) => weatherChartOption(rows, t, { periods, laps, type }),
    [rows, periods, laps, type],
  );
  return (
    <>
      <WeatherSummary summary={summary} periods={periods} laps={laps} type={type} source={source} />
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

/** Without rows it says why (`noDataText`); `now` is epoch ms. */
export function WeatherView({
  rows,
  detail,
  laps,
  live,
  now = Date.now(),
}: Data & { rows: WeatherRows; now?: number }) {
  if (rows.length === 0) return <NoData session={detail.session} live={live} what="weather" now={now} />;
  return (
    <WeatherPanels rows={rows} laps={laps} type={detail.session.type} source={sourceWords(detail.session.source)} />
  );
}
