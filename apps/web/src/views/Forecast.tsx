import type { Forecast, SessionDetail } from '@f1/contracts';
import { useForecast } from '../lib/api.ts';
import { sessionHours, summary, upcoming, updatedWords } from '../lib/forecast.ts';
import { ext } from './RainMap.tsx';
import { Tile } from './Tiles.tsx';

// The weekend forecast (#120, A§13): an Open-Meteo model at the circuit's centre, never shown as a measurement. The
// credit is ADR-0008 §4 item 5, word for word.

/** The credit's sentence(s); the Met Office line only for Silverstone (item 4). */
export const ForecastCredit = ({ map_id }: { map_id: string }) => (
  <>
    Forecast: Weather data by {ext('https://open-meteo.com/', 'Open-Meteo.com')} (
    {ext('https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0')}). Modelled, not measured; hourly values rounded
    and summarised.
    {map_id === 'gb-1948' && (
      <>
        {' '}
        Includes UK Met Office model data ({ext('https://creativecommons.org/licenses/by-sa/4.0/', 'CC BY-SA 4.0')}).
      </>
    )}
  </>
);

type Session = SessionDetail['session'];

/** The card of one session's hours; nothing once it started, when it is cancelled or when it has no hours. */
export function ForecastView({ forecast, session, now }: { forecast: Forecast; session: Session; now: number }) {
  if (forecast === null || !upcoming(session, now)) return null;
  const rows = sessionHours(forecast.hours, session);
  if (rows.length === 0) return null;
  const s = summary(rows);
  return (
    <section className="card forecast">
      <div className="panel-title">
        <h2>Forecast (model)</h2>
        <p>{updatedWords(forecast.fetched_at, now)}</p>
      </div>
      <dl className="tiles" aria-label="Forecast">
        <Tile
          id="fc-chance"
          label="Rain chance"
          value={s.chance}
          who="highest"
          reason="No rain chance in the forecast"
        />
        <Tile id="fc-rain" label="Rain" value={s.rain} who="total" reason="No rain amount in the forecast" />
        <Tile id="fc-air" label="Air" value={s.air} who={null} reason="No air temperature in the forecast" />
        <Tile id="fc-wind" label="Wind" value={s.wind} who="highest" reason="No wind speed in the forecast" />
      </dl>
      <p className="foot fcsrc">
        <ForecastCredit map_id={forecast.map_id} />
      </p>
    </section>
  );
}

/** The Weather tab's forecast card for a session that has not started. */
export function ForecastCard({ detail, now }: { detail: SessionDetail; now: number }) {
  const forecast = useForecast(upcoming(detail.session, now) ? detail.meeting.meeting_key : null);
  return forecast.data ? <ForecastView forecast={forecast.data} session={detail.session} now={now} /> : null;
}
