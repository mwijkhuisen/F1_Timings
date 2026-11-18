import { merge, type Obj } from '@f1/contracts';
import { type FeedEvent, isObj } from './read.ts';

// Events → state (A§11.3): merge() and its rules live in @f1/contracts (the web merges the stream's deltas too).

const DUPLICATE_WINDOW_MS = 5 * 60_000;
/**
 * A Subscribe state is folded with the deltas of its topic received this long before its line (#223, A§11.3): they
 * came on the new connection with the state and can be newer than it. The recorder waits at least 1 s between a close
 * and the next connect (A§11.2), so no line of an earlier connection is this close.
 */
export const FOLD_MS = 1000;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']); // as in merge()
const empty = (): Obj => Object.create(null);

type Payload = NonNullable<unknown>;
type Recent = { topic: string; payload: Payload; r: number };

/** A full event's payload with the recent deltas of its topic merged into a copy, in order, by apply's own rules. */
function folded({ topic, t }: FeedEvent, payload: Payload, recent: readonly Recent[]): Payload {
  let value = payload;
  for (const d of recent) {
    if (d.topic !== topic || d.r < t - FOLD_MS) continue;
    if (!isObj(d.payload)) value = d.payload;
    else {
      if (value === payload || !isObj(value)) {
        const copy = empty(); // never the event's own payload: a caller may apply it again
        if (isObj(value)) merge(copy, value);
        value = copy;
      }
      merge(value as Obj, d.payload);
    }
  }
  return value;
}

/**
 * The feed state, topic → value. `apply` returns the delta for the lap builder: the raw payload of
 * a normal event, the effective delta of a `full` event (a reconnect's full state), and undefined
 * for an exact duplicate (the same topic, t and payload seen within 5 min of t: a reconnect replays
 * messages) or a `full` event that changes nothing. A full event is never deduplicated, and is first
 * folded with the deltas of its topic received up to FOLD_MS before it (their `r`), so it never rolls
 * them back. A null or undefined payload is ignored (undefined, no state change); any other payload
 * that is no object (a `.z` string) replaces the topic's value raw.
 */
export function createFeed(): { state: Obj; apply(ev: FeedEvent): unknown } {
  const state = empty();
  const seen = new Map<string, number>(); // key → t, in arrival order
  const recent: Recent[] = []; // the applied deltas of the last FOLD_MS of receive time
  return {
    state,
    apply(ev) {
      if (UNSAFE.has(ev.topic) || ev.payload === null || ev.payload === undefined) return undefined;
      let payload = ev.payload;
      if (!ev.full) {
        for (const [key, t] of seen) {
          if (t >= ev.t - DUPLICATE_WINDOW_MS) break;
          seen.delete(key);
        }
        const key = `${ev.topic}|${ev.t}|${JSON.stringify(ev.payload)}`;
        // The key holds t, so a hit is the same t; the loop above forgets keys older than the window.
        if (seen.has(key)) return undefined;
        seen.set(key, ev.t);
        if (ev.r !== undefined) {
          recent.push({ topic: ev.topic, payload: ev.payload, r: ev.r });
          while ((recent[0] as Recent).r < ev.r - FOLD_MS) recent.shift();
        }
      } else payload = folded(ev, payload, recent);
      const old = Object.hasOwn(state, ev.topic) ? state[ev.topic] : undefined;
      let effective: unknown;
      if (isObj(payload)) {
        if (!isObj(old)) state[ev.topic] = empty();
        effective = merge(state[ev.topic] as Obj, payload) ?? (isObj(old) ? undefined : empty());
      } else if (!Object.hasOwn(state, ev.topic) || old !== payload) {
        state[ev.topic] = payload;
        effective = payload;
      }
      return ev.full ? effective : ev.payload;
    },
  };
}
