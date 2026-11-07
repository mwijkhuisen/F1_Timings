// Writes out/data.json: the invented race and qualifying (synth.mjs) plus the tower's feed state at lap 43.
import { mkdirSync, writeFileSync } from 'node:fs';
import { build, feedStateAt, RACE } from './synth.mjs';

const data = build();
// Just after every car on the lead lap has crossed the line for lap 42.
const c = data.race.cum;
const lead = Object.keys(c).sort((a, b) => c[a][42] - c[b][42])[0];
const T =
  Math.max(
    ...Object.values(c)
      .filter((x) => x.length > 42 && x[42] < c[lead][43])
      .map((x) => x[42]),
  ) + 1500;
const { _laps, _stints, ...tower } = feedStateAt(data, RACE.start + T);
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
writeFileSync(new URL('./out/data.json', import.meta.url), JSON.stringify({ ...data, tower, towerT: RACE.start + T }));
console.log('out/data.json:', data.laps[RACE.key].length, 'race laps, tower at lap', tower.LapCount.CurrentLap);
