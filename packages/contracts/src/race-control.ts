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
  if (/^RACE WILL (BE )?RESUME/.test(m)) return 'resume';
  if (row.flag === 'CHEQUERED') return 'end';
  return null;
}

/**
 * Messages that look like a period. A plain alternation of PostgreSQL-safe pieces (no `\b`, which is a backspace
 * there), so the server and race-control-forms.sql use `.source` as a `~` pattern. `SC` counts as a word.
 */
export const PERIOD_LIKE = /SAFETY CAR|VSC|RED FLAG|RESUME|SUSPENDED|(^|[^A-Z])SC([^A-Z]|$)/;
/**
 * Rows that mention a period without being one, in two halves: stewards' notes ("INCIDENT INVOLVING CAR(S) …",
 * "FIA STEWARDS: …", the F1 archive's "# SECOND TIME PENALTY FOR CAR …" without the prefix; a period line that merely
 * mentions an incident still counts), then the known procedural wording of a safety-car start or restart (D4 of #105):
 * the archive's older "OVERTAKE SAFETY CAR" and "START PROCEDURE SUSPENDED", and "RACE WILL NOT RESUME" (a red flag
 * that ends the race: the open red period closes at the last lap seen, and it is not a resume form).
 */
export const IGNORED =
  /INCIDENT INVOLVING|STEWARDS|PENALTY FOR CAR|LIGHTS (ON|OFF)|OVERTAKE (THE )?SAFETY CAR|THROUGH THE PIT LANE|FORMATION LAP|START\/FINISH STRAIGHT|WILL ENTER PITS|START BEHIND THE SAFETY CAR|WILL STAY OUT|COVERS ON|START(ING)? PROCEDURE SUSPENDED|WILL NOT RESUME/;

/** A period-like row that matches no form and is ignored (a note or procedure): a wording the bands would miss. */
export const isUnmatched = (row: Row): boolean => {
  const m = row.message ?? '';
  return formOf(row) === null && PERIOD_LIKE.test(m) && !IGNORED.test(m);
};
