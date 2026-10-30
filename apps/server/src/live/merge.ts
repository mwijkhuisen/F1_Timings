import type { FeedEvent } from './read.ts';

// Topic deltas → state (A§11.3). Pure apart from mutating the state it is given.
//
// Objects merge key by key. An array in a delta is an index-keyed object ([a, b] ≡ {"0": a, "1": b}),
// so the state holds no arrays and a full state equals the merged deltas. A leaf (string, number,
// boolean, null) replaces, and so does an object replacing a leaf or the other way round. Merge input
// is untrusted: the state's objects have no prototype, reads are own-property only, the keys
// __proto__, constructor and prototype are dropped, and objects nested deeper than MAX_DEPTH are dropped.

export type Obj = { [key: string]: unknown };

export const MAX_DEPTH = 32;
const DUPLICATE_WINDOW_MS = 5 * 60_000;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

const isObj = (v: unknown): v is object => typeof v === 'object' && v !== null;
const empty = (): Obj => Object.create(null);

// `target` sits at nesting level `depth` (the root is 1); a child object would be at depth + 1.
function into(target: Obj, delta: object, depth: number): Obj | undefined {
  let effective: Obj | undefined;
  for (const [key, value] of Object.entries(delta)) {
    if (UNSAFE.has(key)) continue;
    const old = Object.hasOwn(target, key) ? target[key] : undefined;
    let changed: unknown;
    if (isObj(value)) {
      if (depth >= MAX_DEPTH) continue;
      if (isObj(old)) changed = into(old as Obj, value, depth + 1);
      else {
        // A new object counts as changed even when it is empty, so the effective deltas rebuild it.
        const fresh = empty();
        target[key] = fresh;
        changed = into(fresh, value, depth + 1) ?? empty();
      }
    } else {
      if (Object.hasOwn(target, key) && old === value) continue;
      target[key] = value;
      changed = value;
    }
    if (changed === undefined) continue;
    effective ??= empty();
    effective[key] = changed;
  }
  return effective;
}

/**
 * Merges `delta` into `target` (mutated) and returns the effective delta: only what changed, as
 * fresh objects that never alias the state. Undefined when nothing changed or `delta` is no object.
 */
export function merge(target: Obj, delta: unknown): Obj | undefined {
  return isObj(delta) ? into(target, delta, 1) : undefined;
}

/**
 * The feed state, topic → value. `apply` returns the delta for the lap builder: the raw payload of
 * a normal event, the effective delta of a `full` event (a reconnect's full state), and undefined
 * for an exact duplicate (the same topic, t and payload seen within 5 min of t: a reconnect replays
 * messages) or a `full` event that changes nothing. A full event is never deduplicated. A null or
 * undefined payload is ignored (undefined, no state change); any other payload that is no object
 * (a `.z` string) replaces the topic's value raw.
 */
export function createFeed(): { state: Obj; apply(ev: FeedEvent): unknown } {
  const state = empty();
  const seen = new Map<string, number>(); // key → t, in arrival order
  return {
    state,
    apply(ev) {
      if (UNSAFE.has(ev.topic) || ev.payload === null || ev.payload === undefined) return undefined;
      if (!ev.full) {
        for (const [key, t] of seen) {
          if (t >= ev.t - DUPLICATE_WINDOW_MS) break;
          seen.delete(key);
        }
        const key = `${ev.topic}|${ev.t}|${JSON.stringify(ev.payload)}`;
        // The key holds t, so a hit is the same t; the loop above forgets keys older than the window.
        if (seen.has(key)) return undefined;
        seen.set(key, ev.t);
      }
      const old = Object.hasOwn(state, ev.topic) ? state[ev.topic] : undefined;
      let effective: unknown;
      if (isObj(ev.payload)) {
        if (!isObj(old)) state[ev.topic] = empty();
        effective = merge(state[ev.topic] as Obj, ev.payload) ?? (isObj(old) ? undefined : empty());
      } else if (!Object.hasOwn(state, ev.topic) || old !== ev.payload) {
        state[ev.topic] = ev.payload;
        effective = ev.payload;
      }
      return ev.full ? effective : ev.payload;
    },
  };
}
