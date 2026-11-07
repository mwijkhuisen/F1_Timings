import type { Lap, RaceControl } from '@f1/contracts';

// Synthetic rows for the lib and view tests: everything null or false unless given.

export const lap = (driver_number: number, lap_number: number, extra: Partial<Lap> = {}): Lap => ({
  driver_number,
  lap_number,
  date_start: null,
  lap_ms: null,
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
  ...extra,
});

export const rc = (
  lap_number: number | null,
  message: string | null,
  extra: Partial<RaceControl[number]> = {},
): RaceControl[number] => ({
  date: null,
  category: 'Other',
  flag: null,
  scope: null,
  sector: null,
  driver_number: null,
  lap_number,
  qualifying_phase: null,
  message,
  ...extra,
});
