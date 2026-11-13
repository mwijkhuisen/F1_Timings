import { formOf, isUnmatched, type RaceControl } from '@f1/contracts';

// Safety-car, VSC and red-flag periods from the race-control rows (A§6.1), as
// lap ranges for the lap table's header bands. The forms are the ones
// `scripts/race-control-forms.sql` found in 2023–2026 races, with its exact
// regexes: SAFETY CAR DEPLOYED / IN THIS LAP; VIRTUAL SAFETY CAR or (2026) VSC
// DEPLOYED / ENDING; Flag RED or a message starting RED FLAG (2026 sends
// "RED FLAG - RACE SUSPENDED" as Other without a flag); RACE WILL RESUME;
// Flag CHEQUERED. A period's end is often implicit (SC → RED, VSC → SC, CHQ). The forms live in
// @f1/contracts (race-control.ts); `unmatched` counts the rows that look like a period but match none (#105).

export type Kind = 'sc' | 'vsc' | 'red';
/** Lap numbers, inclusive. */
export type Period = { kind: Kind; from: number; to: number };
/** `unplaced`: rows in a period form without a lap number, listed instead of banded. */
export type Track = { periods: Period[]; unplaced: RaceControl; unmatched: number };

/** Most severe first. */
const KINDS: readonly Kind[] = ['red', 'sc', 'vsc'];

export const KIND_NAME: Record<Kind, string> = { sc: 'Safety car', vsc: 'Virtual safety car', red: 'Red flag' };
export const KIND_LABEL: Record<Kind, string> = { sc: 'SC', vsc: 'VSC', red: 'RED' };

/** Reads the rows in the given order (the API's: by date). */
export function trackPeriods(rows: RaceControl): Track {
  const periods: Period[] = [];
  const unplaced: RaceControl = [];
  const open = new Map<Kind, number>();
  let unmatched = 0;
  const close = (kind: Kind, at: number) => {
    const from = open.get(kind);
    if (from === undefined) return;
    periods.push({ kind, from, to: Math.max(from, at) });
    open.delete(kind);
  };
  const start = (kind: Kind, at: number) => {
    if (!open.has(kind)) open.set(kind, at); // a repeated DEPLOYED keeps the first
  };

  let last = 0;
  for (const row of rows) {
    const form = formOf(row);
    if (isUnmatched(row)) unmatched++;
    const n = row.lap_number;
    if (n !== null) last = Math.max(last, n);
    if (form === null) continue;
    if (n === null) {
      unplaced.push(row);
      continue;
    }
    switch (form) {
      case 'sc+':
        close('red', n - 1); // a restart behind the safety car, without RACE WILL RESUME
        close('vsc', n);
        start('sc', n);
        break;
      case 'sc-':
        close('sc', n);
        break;
      case 'vsc+':
        start('vsc', n);
        break;
      case 'vsc-':
        close('vsc', n);
        break;
      case 'red':
        close('sc', n);
        close('vsc', n);
        start('red', n);
        break;
      case 'resume':
        close('red', n - 1); // the restart lap is green
        break;
      case 'end':
        for (const kind of KINDS) close(kind, n);
    }
  }
  for (const kind of KINDS) close(kind, last);

  return {
    periods: periods.sort((a, b) => a.from - b.from || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)),
    unplaced,
    unmatched,
  };
}

/** The kinds covering a lap, most severe first: red, sc, vsc. */
export const kindsAt = (periods: readonly Period[], lap: number): Kind[] =>
  KINDS.filter((kind) => periods.some((p) => p.kind === kind && p.from <= lap && lap <= p.to));
