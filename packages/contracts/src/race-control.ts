// The race-control wording the SC/VSC/red bands read (A§6.1), shared by the web (trackPeriods) and the server
// (/status and the ingest log list the rows that look like a period but match no form). No zod here.

export type Form = 'sc+' | 'sc-' | 'vsc+' | 'vsc-' | 'red' | 'resume' | 'end';
// Optional keys: an Insertable race_control row (the ingest) may omit them.
type Row = { message?: string | null; flag?: string | null };

/** The S0 classification, in its order. */
export function formOf(row: Row): Form | null {
  const m = row.message ?? '';
  if (/^(VIRTUAL SAFETY CAR|VSC) DEPLOYED/.test(m)) return 'vsc+';
  if (/^(VIRTUAL SAFETY CAR|VSC) ENDING/.test(m)) return 'vsc-';
  if (/^SAFETY CAR DEPLOYED/.test(m)) return 'sc+';
  if (/^SAFETY CAR IN THIS LAP/.test(m)) return 'sc-';
  if (row.flag === 'RED' || /^RED FLAG/.test(m)) return 'red';
  if (/^RACE WILL RESUME/.test(m)) return 'resume';
  if (row.flag === 'CHEQUERED') return 'end';
  return null;
}

/** Messages that look like a period. Plain alternation, so the server also uses `.source` as a PostgreSQL `~` pattern. */
export const PERIOD_LIKE = /SAFETY CAR|VSC|RED FLAG|RESUME/;
/** Stewards' notes, which mention a period without being one. */
export const NOTES = /INCIDENT|STEWARDS|INFRINGEMENT/;

/** A period-like row that matches no form and is not a stewards' note: a wording the bands would miss. */
export const isUnmatched = (row: Row): boolean => {
  const m = row.message ?? '';
  return formOf(row) === null && PERIOD_LIKE.test(m) && !NOTES.test(m);
};
