# P7a screenshots: the player's Map tab (evidence for the P7a PR, not for main)

Local harness, not committed to the code branch: the real `api` (Access bypassed, 127.0.0.1 only) on a dev database, the built web app behind the production CSP, Edge headless.

**Every car here is invented.** Car positions decoded from F1 TV recordings are F1 data (A§12.1 invariant 3), so the public shots replay a synthetic recording instead:
- session 990001, "Synthetic Test Grand Prix", Practice 1;
- six invented drivers (ALD, BIR, CED, ELM, FIR, HAZ) on the P5c outline `br-1940` (bacinger/f1-circuits, MIT);
- built with `apps/server/test/track.ts`.

The api fits the frame from the synthetic recording's first complete lap, exactly as for a real one. The same Map tab on the real 11408 recording was checked locally and the shots stay private.

| Shot | What |
| --- | --- |
| `syn-map-{390,1280}-{dark,light}` | The Map tab, paused at 11:04:00 (Amsterdam time) |
| `syn-seekback-390-dark` | After a seek back to 11:01:00: every car is redrawn at the new T, and nothing after it is drawn |
| `syn-seekfwd-390-dark` | After a seek forward to 11:05:00 |

Each `.txt` is the page's own report of its shot:
- CSP violations and page errors (`errs`, all `[]`);
- horizontal overflow (`scrollWidth` = `clientWidth`);
- the cars drawn (`mapCars` 6), the outline (`mapOutline` 1) and the map's accessible name;
- T (`position`, epoch ms).

Circuit outline: bacinger/f1-circuits (MIT), simplified.
