import { merge, type Obj } from '@f1/contracts';
import { type FeedEvent, isObj } from './read.ts';

// Events → state (A§11.3): merge() and its rules live in @f1/contracts (the web merges the stream's deltas too).

const DUPLICATE_WINDOW_MS = 5 * 60_000;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']); // as in merge()
const empty = (): Obj => Object.create(null);

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
