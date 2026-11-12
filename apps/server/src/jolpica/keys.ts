// The derived keys of Jolpica's 1950–2017 rows (P3c, A§7): no other source has keys for those years. `1YYYYRR` for a
// meeting and `1YYYYRRTT` for a session: 9 digits at most, int4- and `^\d{1,9}$`-safe, far above every OpenF1 and
// archive key. P3f reuses the TT table.

export const FIRST_YEAR = 1950;
export const LAST_YEAR = 2017;

/** The session part of a key. */
export const TT = { FP1: 1, FP2: 2, FP3: 3, Qualifying: 4, Race: 5 } as const;
export type SessionType = keyof typeof TT;

/** `1_000_000 + year*100 + round` for 1950–2017 and rounds 1–99, else undefined (`bad_key`). */
export function meetingKey(year: number, round: number): number | undefined {
  const ok = Number.isInteger(year) && Number.isInteger(round) && year >= FIRST_YEAR && year <= LAST_YEAR;
  return ok && round >= 1 && round <= 99 ? 1_000_000 + year * 100 + round : undefined;
}

export const sessionKey = (meeting: number, type: SessionType) => meeting * 100 + TT[type];
