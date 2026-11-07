// Invented F1 timing data for the design mock-up. NOT real results: made-up lap times on a 2026-like grid,
// deterministic (seeded). Shapes follow packages/contracts (A§10), colours the historical rules of A§9, and the
// tower's feed state the topics of A§11 (synthetic, like every parser fixture: never feed or archive data).

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261101);
const gauss = () => {
  let u = 0,
    v = 0;
  while (!u) u = rnd();
  while (!v) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const iso = (ms) => new Date(ms).toISOString();

export const TEAMS = {
  mercedes: ['Mercedes', '00D7B6'],
  mclaren: ['McLaren', 'F47600'],
  redbull: ['Red Bull Racing', '4781D7'],
  ferrari: ['Ferrari', 'ED1131'],
  williams: ['Williams', '1868DB'],
  rb: ['Racing Bulls', '6C98FF'],
  aston: ['Aston Martin', '229971'],
  haas: ['Haas F1 Team', '9C9FA2'],
  alpine: ['Alpine', '00A1E8'],
  audi: ['Audi', 'F50537'],
  cadillac: ['Cadillac', 'AAAAAD'],
};
// number, acronym, full name (OpenF1 style), team, race pace offset (s)
export const DRIVERS = [
  [12, 'ANT', 'Kimi ANTONELLI', 'mercedes', 0.0],
  [63, 'RUS', 'George RUSSELL', 'mercedes', 0.06],
  [1, 'NOR', 'Lando NORRIS', 'mclaren', 0.04],
  [81, 'PIA', 'Oscar PIASTRI', 'mclaren', 0.12],
  [3, 'VER', 'Max VERSTAPPEN', 'redbull', 0.02],
  [6, 'HAD', 'Isack HADJAR', 'redbull', 0.38],
  [16, 'LEC', 'Charles LECLERC', 'ferrari', 0.14],
  [44, 'HAM', 'Lewis HAMILTON', 'ferrari', 0.21],
  [55, 'SAI', 'Carlos SAINZ', 'williams', 0.5],
  [23, 'ALB', 'Alexander ALBON', 'williams', 0.58],
  [30, 'LAW', 'Liam LAWSON', 'rb', 0.62],
  [41, 'LIN', 'Arvid LINDBLAD', 'rb', 0.7],
  [14, 'ALO', 'Fernando ALONSO', 'aston', 0.6],
  [18, 'STR', 'Lance STROLL', 'aston', 0.86],
  [31, 'OCO', 'Esteban OCON', 'haas', 0.74],
  [87, 'BEA', 'Oliver BEARMAN', 'haas', 0.66],
  [10, 'GAS', 'Pierre GASLY', 'alpine', 0.78],
  [43, 'COL', 'Franco COLAPINTO', 'alpine', 0.92],
  [27, 'HUL', 'Nico HULKENBERG', 'audi', 0.8],
  [5, 'BOR', 'Gabriel BORTOLETO', 'audi', 0.72],
  [11, 'PER', 'Sergio PEREZ', 'cadillac', 1.08],
  [77, 'BOT', 'Valtteri BOTTAS', 'cadillac', 1.14],
];
const SEGS = [7, 9, 6];
const SPLIT = [0.33, 0.437];
const CMP = { SOFT: [-0.55, 0.085], MEDIUM: [-0.25, 0.05], HARD: [0, 0.03] };

// ---------------------------------------------------------------- colours (A§9, historical semantics)
function colour(laps) {
  const valid = (l) => !l.deleted && !l.is_pit_out && !l.is_pit_in;
  for (const f of ['lap', 's1', 's2', 's3']) {
    const key = f === 'lap' ? 'lap_ms' : `${f}_ms`;
    const own = new Map();
    for (const l of laps) {
      if (l[key] === null || !valid(l)) continue;
      const b = own.get(l.driver_number);
      if (!b || l[key] < b[key] || (l[key] === b[key] && l.lap_number < b.lap_number)) own.set(l.driver_number, l);
    }
    let purple = null;
    for (const l of own.values())
      if (
        !purple ||
        l[key] < purple[key] ||
        (l[key] === purple[key] && Date.parse(l.date_start) < Date.parse(purple.date_start))
      )
        purple = l;
    for (const l of laps)
      l.colour[f] =
        l[key] === null ? null : l === purple ? 'purple' : own.get(l.driver_number) === l ? 'green' : 'yellow';
  }
}

function segments(c, n, pit) {
  if (c === null) return null;
  const out = [];
  for (let i = 0; i < n; i++) {
    if (pit === 'start' && i < 3) out.push(2064);
    else if (pit === 'end' && i >= n - 2) out.push(2064);
    else if (rnd() < 0.004) out.push(0);
    else {
      const r = rnd();
      out.push(
        c === 'purple'
          ? r < 0.3
            ? 2051
            : r < 0.9
              ? 2049
              : 2048
          : c === 'green'
            ? r < 0.05
              ? 2051
              : r < 0.6
                ? 2049
                : 2048
            : r < 0.12
              ? 2049
              : 2048,
      );
    }
  }
  return out;
}

function splitSectors(total, cold) {
  const s1 = Math.round(total * SPLIT[0] + gauss() * 45 + (cold ?? 0));
  const s2 = Math.round(total * SPLIT[1] + gauss() * 55);
  return [s1, s2, total - s1 - s2];
}

const speeds = () => [
  Math.round(297 + gauss() * 4),
  Math.round(279 + gauss() * 4),
  Math.round(338 + gauss() * 5 + (rnd() < 0.3 ? 9 : 0)),
];

// ---------------------------------------------------------------- the race
export const RACE = { key: 11399, meeting: 1298, laps: 71, start: Date.UTC(2026, 10, 1, 20, 0, 0), vsc: [34, 35] };
const STRATS = [
  [
    ['MEDIUM', 0, 0],
    ['HARD', 27, 0],
  ],
  [
    ['MEDIUM', 0, 0],
    ['HARD', 30, 0],
  ],
  [
    ['HARD', 0, 0],
    ['MEDIUM', 41, 0],
  ],
  [
    ['MEDIUM', 0, 0],
    ['HARD', 22, 0],
    ['SOFT', 55, 0],
  ],
  [
    ['SOFT', 0, 3],
    ['HARD', 18, 0],
  ],
  [
    ['MEDIUM', 0, 0],
    ['HARD', 25, 0],
  ],
];
const DELETED = { '87:18': 'TRACK LIMITS AT TURN 7', '30:52': 'TRACK LIMITS AT TURN 12' };
const RETIRED = { 77: 48 };

function buildRace() {
  const grid = DRIVERS.map((d) => ({ d, q: d[4] + gauss() * 0.15 }))
    .sort((a, b) => a.q - b.q)
    .map((x) => x.d[0]);
  const laps = [],
    stints = [],
    cum = new Map();
  DRIVERS.forEach(([num, , , , pace], idx) => {
    const strat = STRATS[(idx * 5 + 3) % STRATS.length].map(([c, stop, age], i) => [
      c,
      i === 0 ? 0 : stop + Math.round(gauss() * 1.5),
      age,
    ]);
    const gridPos = grid.indexOf(num);
    const last = RETIRED[num] ? RETIRED[num] - 1 : RACE.laps;
    const stops = strat.slice(1).map((s) => s[1]);
    let t = 0;
    const c = [0];
    strat.forEach(([compound, stop, age], i) => {
      const start = i === 0 ? 1 : stop + 1;
      const end = i + 1 < strat.length ? strat[i + 1][1] : last;
      if (start <= last)
        stints.push({
          driver_number: num,
          stint_number: i + 1,
          lap_start: start,
          lap_end: Math.min(end, last),
          compound,
          tyre_age_at_start: age,
        });
    });
    for (let L = 1; L <= last; L++) {
      const stint = [...stints].reverse().find((s) => s.driver_number === num && s.lap_start <= L);
      const [off, deg] = CMP[stint.compound];
      const ageNow = stint.tyre_age_at_start + (L - stint.lap_start);
      let lt = 80.6 + pace + (RACE.laps - L) * 0.035 + off + deg * ageNow + gauss() * 0.16;
      const pitIn = stops.includes(L),
        pitOut = stops.includes(L - 1);
      let cold = 0;
      if (RACE.vsc.includes(L)) lt *= 1.31;
      if (pitIn) lt += 1.1;
      if (pitOut) {
        lt += 20.9;
        cold = 19600;
      }
      if (L === 1) lt += 3.9 + gridPos * 0.21;
      const total = Math.round(lt * 1000);
      let [s1, s2, s3] = splitSectors(total, cold);
      if (pitIn) {
        s3 += 900;
        s2 -= 900;
      }
      const [i1, i2, st] = speeds();
      const del = DELETED[`${num}:${L}`] ?? null;
      laps.push({
        driver_number: num,
        lap_number: L,
        date_start: iso(RACE.start + t),
        lap_ms: L === 1 ? null : total,
        s1_ms: L === 1 ? null : s1,
        s2_ms: s2,
        s3_ms: s3,
        i1_kph: L === 1 ? null : i1,
        i2_kph: i2,
        st_kph: st,
        is_pit_out: pitOut,
        is_pit_in: pitIn,
        seg1: null,
        seg2: null,
        seg3: null,
        deleted: del !== null,
        deleted_reason: del,
        quali_phase: null,
        compound: stint.compound,
        colour: { lap: null, s1: null, s2: null, s3: null },
      });
      t += total;
      c.push(t);
    }
    cum.set(num, c);
  });
  colour(laps);
  for (const l of laps) {
    l.seg1 =
      l.lap_number === 1 ? segments('yellow', SEGS[0]) : segments(l.colour.s1, SEGS[0], l.is_pit_out ? 'start' : null);
    l.seg2 = segments(l.colour.s2, SEGS[1]);
    l.seg3 = segments(l.colour.s3, SEGS[2], l.is_pit_in ? 'end' : null);
  }
  const finish = DRIVERS.map(([n]) => ({ n, k: cum.get(n).length - 1, t: cum.get(n).at(-1) })).sort(
    (a, b) => b.k - a.k || a.t - b.t,
  );
  const lead = finish[0].t;
  const results = finish.map((f, i) => ({
    driver_number: f.n,
    position: i + 1,
    laps: f.k,
    dnf: f.k < RACE.laps,
    dns: false,
    dsq: false,
    durations_ms: [f.k < RACE.laps ? null : f.t],
    gaps_ms: [f.k < RACE.laps ? null : f.t - lead],
  }));
  return { laps, stints, cum, results, grid };
}

// ---------------------------------------------------------------- qualifying
export const QUALI = { key: 11398, start: Date.UTC(2026, 9, 31, 22, 0, 0) };
function buildQuali() {
  const laps = [],
    phaseStart = [0, 0, 24 * 60e3, 43 * 60e3],
    out = { 2: [], 3: [] };
  const pace = new Map(DRIVERS.map((d) => [d[0], d[4] + gauss() * 0.12]));
  let alive = DRIVERS.map((d) => d[0]);
  const best = new Map();
  for (const phase of [1, 2, 3]) {
    for (const num of alive) {
      let t = phaseStart[phase] + Math.round(rnd() * 5 * 60e3);
      let n = laps.filter((l) => l.driver_number === num).length;
      for (let run = 0; run < 2; run++) {
        const flying = 76.1 + pace.get(num) - phase * 0.22 - run * 0.14 + gauss() * 0.09;
        for (const [kind, sec] of [
          ['out', 104 + rnd() * 6],
          ['fly', flying],
          ['in', 112 + rnd() * 8],
        ]) {
          n += 1;
          const total = Math.round(sec * 1000);
          const [s1, s2, s3] = splitSectors(total, 0);
          const [i1, i2, st] = speeds();
          const del =
            kind === 'fly' && ((num === 43 && phase === 1 && run === 1) || (num === 81 && phase === 3 && run === 0))
              ? 'TRACK LIMITS AT TURN 6'
              : null;
          laps.push({
            driver_number: num,
            lap_number: n,
            date_start: iso(QUALI.start + t),
            lap_ms: total,
            s1_ms: s1,
            s2_ms: s2,
            s3_ms: s3,
            i1_kph: i1 + 4,
            i2_kph: i2 + 4,
            st_kph: st + 3,
            is_pit_out: kind === 'out',
            is_pit_in: kind === 'in',
            seg1: null,
            seg2: null,
            seg3: null,
            deleted: del !== null,
            deleted_reason: del,
            quali_phase: phase,
            compound: 'SOFT',
            colour: { lap: null, s1: null, s2: null, s3: null },
          });
          if (kind === 'fly' && !del)
            best.set(`${phase}:${num}`, Math.min(best.get(`${phase}:${num}`) ?? Infinity, total));
          t += total + (kind === 'in' ? 6 * 60e3 : 0);
        }
      }
    }
    const order = alive
      .slice()
      .sort((a, b) => (best.get(`${phase}:${a}`) ?? Infinity) - (best.get(`${phase}:${b}`) ?? Infinity));
    if (phase < 3) {
      alive = order.slice(0, phase === 1 ? 16 : 10);
      out[phase + 1] = order.slice(phase === 1 ? 16 : 10);
    } else alive = order;
  }
  colour(laps);
  for (const l of laps) {
    l.seg1 = segments(l.colour.s1, SEGS[0], l.is_pit_out ? 'start' : null);
    l.seg2 = segments(l.colour.s2, SEGS[1]);
    l.seg3 = segments(l.colour.s3, SEGS[2], l.is_pit_in ? 'end' : null);
  }
  const order = [...alive, ...out[3], ...out[2]];
  const results = order.map((n, i) => {
    const q = [1, 2, 3].map((p) => best.get(`${p}:${n}`) ?? null);
    return {
      driver_number: n,
      position: i + 1,
      laps: laps.filter((l) => l.driver_number === n).length,
      dnf: false,
      dns: false,
      dsq: false,
      durations_ms: q,
      gaps_ms: q.map((v, p) => (v === null ? null : v - (best.get(`${p + 1}:${order[0]}`) ?? v))),
    };
  });
  const stints = DRIVERS.map(([n]) => ({
    driver_number: n,
    stint_number: 1,
    lap_start: 1,
    lap_end: laps.filter((l) => l.driver_number === n).length,
    compound: 'SOFT',
    tyre_age_at_start: 0,
  }));
  return { laps, stints, results };
}

// ---------------------------------------------------------------- season, detail, status, live
const MEET = [
  [
    1297,
    'United States Grand Prix',
    'Austin',
    'USA',
    'Austin',
    '-05:00:00',
    Date.UTC(2026, 9, 23),
    [
      [11385, 'Practice', 'Practice 1', 23, 17, 30],
      [11386, 'Qualifying', 'Sprint Qualifying', 23, 21, 30],
      [11387, 'Race', 'Sprint', 24, 17, 0],
      [11388, 'Qualifying', 'Qualifying', 24, 21, 0],
      [11389, 'Race', 'Race', 25, 19, 0],
    ],
  ],
  [
    1298,
    'Mexico City Grand Prix',
    'Mexico City',
    'MEX',
    'Mexico City',
    '-06:00:00',
    Date.UTC(2026, 9, 30),
    [
      [11395, 'Practice', 'Practice 1', 30, 18, 30],
      [11396, 'Practice', 'Practice 2', 30, 22, 0],
      [11397, 'Practice', 'Practice 3', 31, 17, 30],
      [11398, 'Qualifying', 'Qualifying', 31, 21, 0],
      [11399, 'Race', 'Race', 32, 20, 0],
    ],
  ],
  [
    1299,
    'São Paulo Grand Prix',
    'São Paulo',
    'BRA',
    'Interlagos',
    '-03:00:00',
    Date.UTC(2026, 10, 6),
    [
      [11405, 'Practice', 'Practice 1', 6, 14, 30],
      [11406, 'Practice', 'Practice 2', 6, 18, 0],
      [11407, 'Practice', 'Practice 3', 7, 14, 30],
      [11408, 'Qualifying', 'Qualifying', 7, 18, 0],
      [11409, 'Race', 'Race', 8, 17, 0],
    ],
  ],
  [
    1300,
    'Las Vegas Grand Prix',
    'Las Vegas',
    'USA',
    'Las Vegas',
    '-08:00:00',
    Date.UTC(2026, 10, 19),
    [
      [11415, 'Practice', 'Practice 1', 20, 0, 30],
      [11416, 'Practice', 'Practice 2', 20, 4, 0],
      [11417, 'Practice', 'Practice 3', 21, 0, 30],
      [11418, 'Qualifying', 'Qualifying', 21, 4, 0],
      [11419, 'Race', 'Race', 22, 4, 0],
    ],
  ],
];
const NOW = Date.UTC(2026, 10, 7, 11, 0, 0);

export function build() {
  const race = buildRace();
  const quali = buildQuali();
  const season = MEET.map(([key, name, loc, cc, circuit, gmt, d0, ss]) => {
    const month = new Date(d0).getUTCMonth();
    const sessions = ss.map(([sk, type, sname, day, h, m]) => {
      const start = Date.UTC(2026, month, day, h, m);
      const dur = type === 'Race' && sname === 'Race' ? 2 * 3600e3 : 3600e3;
      return {
        session_key: sk,
        type,
        name: sname,
        date_start: iso(start),
        date_end: iso(start + dur),
        ingest_state: start + dur < NOW ? 'final' : 'scheduled',
        is_cancelled: false,
      };
    });
    return {
      meeting_key: key,
      name,
      official_name: `FORMULA 1 ${name.toUpperCase()} 2026`,
      location: loc,
      country_code: cc,
      circuit_short_name: circuit,
      gmt_offset: gmt,
      date_start: sessions[0].date_start,
      date_end: sessions.at(-1).date_end,
      is_cancelled: false,
      sessions,
    };
  });
  const drivers = DRIVERS.map(([n, a, f, t]) => ({
    driver_number: n,
    acronym: a,
    full_name: f,
    team_name: TEAMS[t][0],
    team_colour: TEAMS[t][1],
  }));
  const detailOf = (key) => {
    const m = season.find((x) => x.sessions.some((s) => s.session_key === key));
    if (!m) return null;
    const s = m.sessions.find((x) => x.session_key === key);
    const { sessions, ...meeting } = m;
    const results = key === RACE.key ? race.results : key === QUALI.key ? quali.results : [];
    return { session: { ...s, meeting_key: m.meeting_key }, meeting: { ...meeting, year: 2026 }, drivers, results };
  };
  const sessionKeys = season.flatMap((m) => m.sessions.map((s) => s.session_key));
  const raceEnd = RACE.start + Math.max(...[...race.cum.values()].map((c) => c.at(-1)));
  const recordings = [
    {
      id: 8,
      session_key: 11406,
      year: 2026,
      meeting_name: 'São Paulo Grand Prix',
      session_name: 'Practice 2',
      session_type: 'Practice',
      date_start: season[2].sessions[1].date_start,
      started_at: iso(Date.parse(season[2].sessions[1].date_start) - 20 * 60e3),
      ended_at: iso(Date.parse(season[2].sessions[1].date_end) + 15 * 60e3),
      complete: true,
    },
    {
      id: 7,
      session_key: RACE.key,
      year: 2026,
      meeting_name: 'Mexico City Grand Prix',
      session_name: 'Race',
      session_type: 'Race',
      date_start: iso(RACE.start),
      started_at: iso(RACE.start - 25 * 60e3),
      ended_at: iso(raceEnd + 20 * 60e3),
      complete: true,
    },
    {
      id: 6,
      session_key: QUALI.key,
      year: 2026,
      meeting_name: 'Mexico City Grand Prix',
      session_name: 'Qualifying',
      session_type: 'Qualifying',
      date_start: iso(QUALI.start),
      started_at: iso(QUALI.start - 20 * 60e3),
      ended_at: iso(QUALI.start + 75 * 60e3),
      complete: false,
    },
  ];
  const fp3 = season[2].sessions[2];
  return {
    now: NOW,
    seasons: [{ year: 2026, meetings: season.length, sessions: sessionKeys.length }],
    season,
    detail: Object.fromEntries(sessionKeys.map((k) => [k, detailOf(k)])),
    laps: { [RACE.key]: race.laps, [QUALI.key]: quali.laps },
    stints: { [RACE.key]: race.stints, [QUALI.key]: quali.stints },
    status: {
      states: { scheduled: 9, due: 0, fetched: 1, final: 10, failed: 0 },
      cancelled: 0,
      failed: [],
      recorder: {
        state: 'idle',
        session_key: null,
        meeting_name: null,
        session_name: null,
        token_expires_at: iso(NOW + 9 * 86400e3),
        last_error: null,
        warning: null,
        stale: false,
        updated_at: iso(NOW - 40e3),
      },
    },
    live: {
      session: {
        session_key: fp3.session_key,
        meeting_name: 'São Paulo Grand Prix',
        session_name: 'Practice 3',
        date_start: fp3.date_start,
        date_end: fp3.date_end,
      },
      recording: null,
    },
    recordings,
    race: { cum: Object.fromEntries(race.cum), grid: race.grid, end: raceEnd },
  };
}

// ---------------------------------------------------------------- the feed state of the race at time t (for the tower)
const fmtLap = (ms) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
const fmtSec = (ms) => (ms / 1000).toFixed(3);
const fmtGap = (ms) => `+${(ms / 1000).toFixed(3)}`;

export function feedStateAt(data, t) {
  const laps = data.laps[RACE.key];
  const cum = data.race.cum;
  const el = t - RACE.start;
  const done = new Map(DRIVERS.map(([n]) => [n, Math.max(0, cum[n].filter((x, i) => i > 0 && x <= el).length)]));
  // Line-crossing order: laps done, then the time the car crossed the line for the last of them.
  const order = DRIVERS.map(([n]) => n).sort(
    (a, b) =>
      done.get(b) - done.get(a) ||
      cum[a][done.get(a)] - cum[b][done.get(b)] ||
      data.race.grid.indexOf(a) - data.race.grid.indexOf(b),
  );
  const leader = order[0],
    lk = done.get(leader);
  const lapOf = (n, k) => laps.find((l) => l.driver_number === n && l.lap_number === k);
  const sofar = laps.filter((l) => cum[l.driver_number][l.lap_number] <= el);
  const best = (n, key) =>
    sofar
      .filter((l) => l.driver_number === n && l[key] !== null && !l.deleted && !l.is_pit_out && !l.is_pit_in)
      .reduce((m, l) => (m === null || l[key] < m[key] ? l : m), null);
  const overall = (key) =>
    sofar
      .filter((l) => l[key] !== null && !l.deleted && !l.is_pit_out && !l.is_pit_in)
      .reduce((m, l) => (m === null || l[key] < m[key] ? l : m), null);
  const Lines = {},
    Apps = {},
    List = {};
  order.forEach((n, i) => {
    const k = done.get(n);
    const d = DRIVERS.find((x) => x[0] === n);
    const last = k > 0 ? lapOf(n, k) : undefined;
    const pb = best(n, 'lap_ms');
    const ahead = order[i - 1];
    const behind = (m) => {
      const k2 = Math.min(k, done.get(m));
      return Math.max(0, cum[n][k2] - cum[m][k2]);
    };
    // Laps down: the other car's line crossings after lap k that came before this car crossed lap k.
    const down = (m) => cum[m].filter((x, j) => j > k && x < cum[n][k]).length;
    const gap = i === 0 ? `LAP ${lk + 1}` : down(leader) >= 1 ? `${down(leader)}L` : fmtGap(behind(leader));
    const int = i === 0 ? `LAP ${lk + 1}` : down(ahead) >= 1 ? `${down(ahead)}L` : fmtGap(behind(ahead));
    const flag = (l, key) => ({
      OverallFastest: !!l && overall(key) === l,
      PersonalFastest: !!l && best(n, key) === l,
    });
    const sec = (key, segKey) =>
      last && last[key] !== null
        ? {
            Value: fmtSec(last[key]),
            ...flag(last, key),
            Segments: Object.fromEntries((last[segKey] ?? []).map((s, j) => [String(j), { Status: s ?? 0 }])),
          }
        : { Value: '', Segments: {} };
    const stops = sofar.filter((l) => l.driver_number === n && l.is_pit_in).length;
    const retired = !!RETIRED[n] && k >= RETIRED[n] - 1 && el > cum[n][k] + 60e3;
    Lines[n] = {
      RacingNumber: String(n),
      Line: i + 1,
      Position: String(i + 1),
      NumberOfLaps: k,
      NumberOfPitStops: stops,
      LastLapTime:
        last && last.lap_ms !== null ? { Value: fmtLap(last.lap_ms), ...flag(last, 'lap_ms') } : { Value: '' },
      BestLapTime: pb ? { Value: fmtLap(pb.lap_ms), Lap: pb.lap_number } : { Value: '' },
      Sectors: { 0: sec('s1_ms', 'seg1'), 1: sec('s2_ms', 'seg2'), 2: sec('s3_ms', 'seg3') },
      InPit: !!last?.is_pit_in && !retired,
      PitOut: !!last?.is_pit_out,
      GapToLeader: retired ? '' : gap,
      IntervalToPositionAhead: { Value: retired ? '' : int, Catching: false },
      Retired: retired,
      Stopped: retired,
      KnockedOut: false,
    };
    const st = data.stints[RACE.key].filter((s) => s.driver_number === n && s.lap_start <= Math.max(1, k + 1));
    Apps[n] = {
      RacingNumber: String(n),
      GridPos: String(data.race.grid.indexOf(n) + 1),
      Stints: Object.fromEntries(
        st.map((s, j) => [
          String(j),
          {
            Compound: s.compound,
            New: s.tyre_age_at_start === 0 ? 'true' : 'false',
            TotalLaps: s.tyre_age_at_start + Math.max(0, Math.min(k, s.lap_end) - s.lap_start + 1),
            StartLaps: s.tyre_age_at_start,
          },
        ]),
      ),
    };
    List[n] = {
      RacingNumber: String(n),
      BroadcastName: d[2].split(' ').at(-1),
      FullName: d[2],
      Tla: d[1],
      Line: i + 1,
      TeamName: TEAMS[d[3]][0],
      TeamColour: TEAMS[d[3]][1],
    };
  });
  const lapNow = Math.min(RACE.laps, lk + 1);
  const msgs = [
    [0, 1, 'Flag', 'GREEN', 'Track', 'GREEN LIGHT - PIT EXIT OPEN'],
    [180e3, 3, 'Drs', null, null, 'DRS ENABLED'],
    [
      cum[87][18] - 2e3,
      18,
      'Other',
      null,
      null,
      'CAR 87 (BEA) TIME 1:22.214 DELETED - TRACK LIMITS AT TURN 7 LAP 18 21:24:37',
    ],
    [cum[12][33] + 20e3, 34, 'SafetyCar', null, null, 'VIRTUAL SAFETY CAR DEPLOYED'],
    [cum[12][35] - 25e3, 35, 'SafetyCar', null, null, 'VIRTUAL SAFETY CAR ENDING'],
    [cum[12][35] + 5e3, 36, 'Flag', 'GREEN', 'Track', 'TRACK CLEAR'],
    [
      cum[12][40],
      41,
      'Other',
      null,
      null,
      'TURN 4 INCIDENT INVOLVING CARS 30 (LAW) AND 43 (COL) NOTED - CAUSING A COLLISION',
    ],
  ].filter((m) => m[0] <= el);
  return {
    SessionInfo: {
      Key: RACE.key,
      Type: 'Race',
      Name: 'Race',
      Path: '2026/2026-11-01_Mexico_City_Grand_Prix/2026-11-01_Race/',
      StartDate: '2026-11-01T14:00:00',
      EndDate: '2026-11-01T16:00:00',
      GmtOffset: '-06:00:00',
      Meeting: {
        Key: RACE.meeting,
        Name: 'Mexico City Grand Prix',
        OfficialName: 'FORMULA 1 MEXICO CITY GRAND PRIX 2026',
        Location: 'Mexico City',
      },
    },
    SessionStatus: { Status: el < 0 ? 'Inactive' : 'Started', Started: el < 0 ? 'Inactive' : 'Started' },
    TrackStatus: lk >= 33 && lk < 35 ? { Status: '6', Message: 'VSCDeployed' } : { Status: '1', Message: 'AllClear' },
    LapCount: { CurrentLap: lapNow, TotalLaps: RACE.laps },
    ExtrapolatedClock: {
      Utc: iso(t),
      Remaining: new Date(Math.max(0, 2 * 3600e3 - Math.max(0, el))).toISOString().slice(11, 19),
      Extrapolating: el > 0,
    },
    SessionData: {
      Series: { 0: { Utc: iso(RACE.start), Lap: 1 } },
      StatusSeries: el >= 0 ? { 0: { Utc: iso(RACE.start), SessionStatus: 'Started' } } : {},
    },
    RaceControlMessages: {
      Messages: Object.fromEntries(
        msgs.map(([dt, lap, cat, fl, sc, m], i) => [
          String(i),
          { Utc: iso(RACE.start + dt), Lap: lap, Category: cat, ...(fl ? { Flag: fl, Scope: sc } : {}), Message: m },
        ]),
      ),
    },
    WeatherData: {
      AirTemp: '22.4',
      Humidity: '37.0',
      Pressure: '781.2',
      Rainfall: '0',
      TrackTemp: '43.1',
      WindDirection: '203',
      WindSpeed: '1.8',
    },
    DriverList: List,
    TimingData: { Lines },
    TimingAppData: { Lines: Apps },
    _laps: sofar,
    _stints: data.stints[RACE.key].filter((s) => cum[s.driver_number][Math.max(0, s.lap_start - 1)] <= el),
  };
}
