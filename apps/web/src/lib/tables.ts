// What the session tables remember (#237 D1): the lap table's metric, Times | Δ and orientation, the speed-trap
// phase, By phase | Every lap, Compare's window and the driver picks, in one `f1.tables` key. Storage is untrusted:
// each field is checked against its allowed values and anything else is dropped, so a throwing, empty or
// tampered storage gives the defaults. Read and written in try/catch as lib/theme.ts does.

import { useState } from 'react';

export type Tables = {
  metric: 'lap' | 's1' | 's2' | 's3';
  show: 'times' | 'delta';
  columns: boolean;
  phase: number;
  byPhase: boolean;
  window: 'fit' | '107';
  /** Driver numbers in pick order. */
  picks: number[];
};

const KEY = 'f1.tables';

const FIELDS: { [K in keyof Tables]: (v: unknown) => v is Tables[K] } = {
  metric: (v): v is Tables['metric'] => v === 'lap' || v === 's1' || v === 's2' || v === 's3',
  show: (v): v is Tables['show'] => v === 'times' || v === 'delta',
  columns: (v): v is boolean => typeof v === 'boolean',
  phase: (v): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 9,
  byPhase: (v): v is boolean => typeof v === 'boolean',
  window: (v): v is Tables['window'] => v === 'fit' || v === '107',
  picks: (v): v is number[] =>
    Array.isArray(v) && v.length <= 30 && v.every((n) => Number.isInteger(n) && n >= 1 && n <= 999),
};

/** The saved fields that pass their check; the rest are left out. */
export function readTables(): Partial<Tables> {
  const out: Record<string, unknown> = {};
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (typeof stored === 'object' && stored !== null)
      for (const [k, ok] of Object.entries(FIELDS)) {
        const v = (stored as Record<string, unknown>)[k];
        if (ok(v)) out[k] = v;
      }
  } catch {
    // Private mode, blocked storage or bad JSON: the defaults.
  }
  return out as Partial<Tables>;
}

/** Saves one field next to the others. */
export function saveTable<K extends keyof Tables>(key: K, value: Tables[K]) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readTables(), [key]: value }));
  } catch {
    // As the theme: not remembered.
  }
}

/** A remembered setting: the saved value on mount (undefined when there is none), and a setter that also saves it. */
export function useTable<K extends keyof Tables>(key: K): [Tables[K] | undefined, (v: Tables[K]) => void] {
  const [value, setValue] = useState(() => readTables()[key]);
  return [
    value,
    (v) => {
      setValue(v);
      saveTable(key, v);
    },
  ];
}

/** The saved picks that `order` has, in saved order; null unless two are left (one is no comparison: the caller's default). */
export function savedPicks(order: readonly { number: number }[]): number[] | null {
  const known = new Set(order.map((d) => d.number));
  const out = [...new Set(readTables().picks ?? [])].filter((n) => known.has(n));
  return out.length > 1 ? out : null;
}
