// The proposed F1 Timings screens as static markup, from the invented data in out/data.json (node data.mjs). Mock-up only:
// every screen takes the frame variant, 'd' (desktop, 1280 px) or 'p' (phone, 390 px).
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('./out/data.json', import.meta.url), 'utf8'));
const RACE = 11399;
const QUALI = 11398;

export const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const pad = (n, w) => String(n).padStart(w, '0');
export const fmtLap = (ms) =>
  `${Math.floor(ms / 60000)}:${pad(Math.floor((ms % 60000) / 1000), 2)}.${pad(ms % 1000, 3)}`;
const fmtSec = (ms) => (ms < 60000 ? `${pad(Math.floor(ms / 1000), 2)}.${pad(ms % 1000, 3)}` : fmtLap(ms));
const fmtD = (ms, dp = 3) => `${ms < 0 ? '−' : '+'}${(Math.abs(ms) / 1000).toFixed(dp)}`;
const ams = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Amsterdam',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const amsClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Amsterdam',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const when = (iso) => ams.format(new Date(iso)).replace(',', '');
const hhmm = (t) => amsClock.format(t).slice(0, 5);

const raceDetail = data.detail[RACE];
const drivers = new Map(raceDetail.drivers.map((d) => [d.driver_number, d]));
const lum = (hex) =>
  hex
    .match(/\w\w/g)
    .map((h) => parseInt(h, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
const onWhite = (hex) => 1.05 / (lum(hex) + 0.05);
/** The team colour for UI on the light theme: darkened (hue kept) until it reaches 3:1 on white. */
export function clampLight(hex) {
  let rgb = hex.match(/\w\w/g).map((h) => parseInt(h, 16));
  let out = hex;
  while (onWhite(out) < 3) {
    rgb = rgb.map((v) => Math.round(v * 0.92));
    out = rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  return out;
}
const colourOf = (n) => drivers.get(n).team_colour;
const teamVar = (n) => `--team:#${colourOf(n)};--team-l:#${clampLight(colourOf(n))}`;
const tla = (n) => drivers.get(n).acronym;
const raceLaps = data.laps[RACE];
const lapOf = (laps, n, k) => laps.find((l) => l.driver_number === n && l.lap_number === k);
const compoundClass = (c) =>
  ({ SOFT: 'soft', MEDIUM: 'medium', HARD: 'hard', INTERMEDIATE: 'inter', WET: 'wet' })[c] ?? 'unknown';
const cmp = (c, used) =>
  `<span class="cmp cmp-${compoundClass(c)}" title="${esc(`${c ?? 'Unknown'}${used ? ', used set' : ', new set'}`)}" aria-hidden="true">${esc((c ?? '?')[0])}</span><span class="vh">${esc(`${(c ?? 'unknown').toLowerCase()} tyres, `)}</span>`;
const VSC = [34, 35];

// ---------------------------------------------------------------- the shell
const brand = `<a class="a-brand" href="#" aria-label="F1 Timings"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="3.2" rx="1.6" fill="currentColor"/><rect x="3" y="10.4" width="12" height="3.2" rx="1.6" fill="currentColor" opacity=".7"/><rect x="3" y="16.8" width="7" height="3.2" rx="1.6" fill="currentColor" opacity=".45"/><rect x="17.4" y="10.4" width="3.6" height="3.2" rx="1" fill="var(--purple)"/></svg><span>F1 Timings</span></a>`;

const right = (v) =>
  v === 'p'
    ? `<a href="#" class="pill" aria-label="Live: Practice 3 starts at 15:30"><span class="dot"></span>15:30</a>`
    : `<a href="#"><span class="pill"><span class="dot"></span>Next: FP3 15:30</span></a><a href="#">Replays</a><a href="#">Status <span class="pill ok"><span class="dot"></span>OK</span></a>`;

const top = (v, crumbs) =>
  `<header class="a-top">${brand}<nav class="a-crumbs" aria-label="Session">${crumbs}</nav><div class="a-links">${right(v)}</div></header>`;

const sessionCrumbs = (v, meeting, short, session) =>
  v === 'p'
    ? `<button class="step" aria-label="Previous session">‹</button><button class="grow"><span class="clip">${esc(short)} · ${esc(session)}</span> <span class="caret">▾</span></button><button class="step" aria-label="Next session">›</button>`
    : `<button class="step" aria-label="Previous session">‹</button><button>2026 <span class="caret">▾</span></button><span class="sep">/</span><button>${esc(meeting)} <span class="caret">▾</span></button><span class="sep">/</span><button>${esc(session)} <span class="caret">▾</span></button><button class="step" aria-label="Next session">›</button>`;

const weekendSessions = (active) =>
  `<nav class="wk" aria-label="This weekend's sessions">${['FP1', 'FP2', 'FP3', 'Quali', 'Race'].map((x) => `<a href="#"${x === active ? ' aria-current="page"' : ''}>${x}</a>`).join('')}</nav>`;

const tabs = (active) =>
  `<nav class="a-tabs" aria-label="Views">${['Laps', 'Compare', 'Mini-sectors', 'Stints'].map((t) => `<a href="#"${t === active ? ' aria-current="page"' : ''}>${t}</a>`).join('')}<a href="#" class="replay-link" aria-label="Replay this session"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg><span class="hide-s">&nbsp;Replay</span></a></nav>`;

// Session KPI tiles (after f1hub's stat tiles): the value in --fg, its holder and lap beneath.
function kpis(laps) {
  const valid = laps.filter((l) => !l.deleted && !l.is_pit_in && !l.is_pit_out);
  const best = (key) =>
    valid.filter((l) => l[key] !== null).reduce((m, l) => (m === null || l[key] < m[key] ? l : m), null);
  const fl = best('lap_ms');
  const s = ['s1_ms', 's2_ms', 's3_ms'].map(best);
  const st = laps.filter((l) => l.st_kph !== null).reduce((m, l) => (m === null || l.st_kph > m.st_kph ? l : m), null);
  const sob = s.reduce((a, l, i) => a + l[['s1_ms', 's2_ms', 's3_ms'][i]], 0);
  const tile = (k, val, who) => `<div><dt>${k}</dt><dd class="v num">${val}</dd><dd class="who">${who}</dd></div>`;
  return `<dl class="kpis" aria-label="Session bests">${tile('Fastest lap', fmtLap(fl.lap_ms), `${tla(fl.driver_number)} · L${fl.lap_number}`)}${s.map((l, i) => tile(`Best S${i + 1}`, fmtSec(l[['s1_ms', 's2_ms', 's3_ms'][i]]), `${tla(l.driver_number)} · L${l.lap_number}`)).join('')}${tile('Sum of best sectors', fmtLap(sob), `${fmtD(sob - fl.lap_ms)} to the fastest lap`)}${tile('Top speed', `${st.st_kph} km/h`, `${tla(st.driver_number)} · L${st.lap_number} · speed trap`)}</dl>`;
}

function head({ title, kind, meta, active }) {
  return `<div class="a-head"><div class="eyebrow">2026 · Round 19 · Mexico City</div><h1>${esc(title)} <span class="kind">${esc(kind)}</span></h1><p class="meta">${meta}</p>${weekendSessions(active)}</div>`;
}

const raceHead = () =>
  head({
    title: 'Mexico City Grand Prix',
    kind: 'Race',
    meta: `${when(raceDetail.session.date_start)} · Autódromo Hermanos Rodríguez · 71 laps · data final`,
    active: 'Race',
  });

const icon = {
  pause:
    '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  play: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>',
};

const raceOrder = raceDetail.results.map((r) => r.driver_number);
const resultPos = new Map(raceDetail.results.map((r) => [r.driver_number, r.position]));
const drvInner = (n, p) =>
  `<span class="drv" style="${teamVar(n)}"><span class="pos num">${p ?? ''}</span><span class="bar"></span><span class="tla">${tla(n)}</span><span class="no num">${n}</span></span>`;
const drvCell = (n, p = resultPos.get(n)) => `<th scope="row">${drvInner(n, p)}</th>`;
const bestOwn = (laps, n, field = 'lap') =>
  laps.find((l) => l.driver_number === n && (l.colour[field] === 'purple' || l.colour[field] === 'green'));

// ---------------------------------------------------------------- 1. the race lap table
function raceLapTable() {
  const max = 71;
  const stintAt = new Map(data.stints[RACE].map((s) => [`${s.driver_number}:${s.lap_start}`, s]));
  const head = `<tr><th scope="col">Driver</th><th scope="col" class="best">Best</th>${Array.from(
    { length: max },
    (_, i) => i + 1,
  )
    .map(
      (k) =>
        `<th scope="col"${VSC.includes(k) ? ' class="vsc" title="Virtual safety car"' : ''}><span class="vh">Lap </span>${k}${VSC.includes(k) ? '<small> VSC</small>' : ''}</th>`,
    )
    .join('')}</tr>`;
  const rows = raceOrder.map((n) => {
    const pb = bestOwn(raceLaps, n);
    const cells = [];
    for (let k = 1; k <= max; k++) {
      const l = lapOf(raceLaps, n, k);
      const cls = VSC.includes(k) ? ['vsc'] : [];
      if (!l) {
        cells.push(
          `<td class="${cls.join(' ')}">${n === 77 && k === 48 ? '<span class="muted" title="Retired on lap 48">RET</span>' : ''}</td>`,
        );
        continue;
      }
      const stint = stintAt.get(`${n}:${k}`);
      if (stint && k > 1) cls.push('st');
      const chip = stint ? cmp(l.compound, stint.tyre_age_at_start > 0) : '';
      let v;
      let d;
      let h = '';
      if (l.lap_ms === null) {
        v = `<span class="muted" title="Lap 1 starts from the grid: the data has no lap time">—</span>`;
        d = v;
      } else {
        const c = l.deleted
          ? 't-del'
          : l.is_pit_in || l.is_pit_out
            ? 't-io'
            : l.colour.lap === 'purple'
              ? 't-p'
              : l.colour.lap === 'green'
                ? 't-g'
                : '';
        const title = l.deleted
          ? `Deleted: ${l.deleted_reason}`
          : l.colour.lap === 'purple'
            ? 'Overall best'
            : l.colour.lap === 'green'
              ? 'Personal best'
              : '';
        // An out-lap that starts a stint already shows the new set's compound; IN marks the lap into the pits.
        const tag = l.is_pit_in
          ? '<span class="tag">IN</span>'
          : l.is_pit_out && !stint
            ? '<span class="tag">OUT</span>'
            : '';
        v = `<span class="${c}"${title ? ` title="${esc(title)}"` : ''}>${fmtLap(l.lap_ms)}${title ? `<span class="vh">, ${esc(title.toLowerCase())}</span>` : ''}</span>${tag}`;
        if (pb && !l.deleted && !l.is_pit_in && !l.is_pit_out && !VSC.includes(k)) {
          const diff = l.lap_ms - pb.lap_ms;
          h = diff < 400 ? '0' : diff < 900 ? '1' : diff < 1600 ? '2' : '3';
          d = diff === 0 ? `<span class="${c}">best</span>` : `<span class="num">${fmtD(diff, 2)}</span>`;
        } else
          d = `<span class="muted">${l.is_pit_in ? 'in' : l.is_pit_out ? 'out' : l.deleted ? 'deleted' : 'VSC'}</span>`;
      }
      cells.push(
        `<td class="${cls.join(' ')}"${h ? ` data-h="${h}"` : ''}>${chip}<span class="v">${v}</span><span class="d">${d}</span></td>`,
      );
    }
    return `<tr>${drvCell(n)}<td class="best"><span class="${pb?.colour.lap === 'purple' ? 't-p' : 't-g'} num">${pb ? fmtLap(pb.lap_ms) : '—'}</span><small>L${pb?.lap_number ?? '—'}</small></td>${cells.join('')}</tr>`;
  });
  return `<div class="scroll fill" data-scroll-to="22" tabindex="0" role="region" aria-label="Lap times, scrolls sideways"><table class="tt lt" aria-label="Lap times"><thead>${head}</thead><tbody>${rows.join('')}</tbody></table></div>`;
}

const lapLegend = `<ul class="legend" aria-label="Legend"><li><span class="t-p">1:20.529</span> overall best</li><li><span class="t-g">1:21.0</span> personal best</li><li>1:22.1 other</li><li><span class="t-io">1:24.9</span><span class="tag">IN</span> in-lap</li><li><span class="cmp cmp-hard" aria-hidden="true">H</span> new stint</li><li><span class="t-del">1:22.2</span> deleted</li></ul>`;

export function screenLaps(v) {
  return `${top(v, sessionCrumbs(v, 'Mexico City Grand Prix', 'Mexico City', 'Race'))}<div class="a-body">${raceHead()}${kpis(raceLaps)}${tabs('Laps')}<div class="a-tool"><fieldset class="seg" aria-label="Metric"><button aria-pressed="true">Lap</button><button>S1</button><button>S2</button><button>S3</button></fieldset><fieldset class="seg" aria-label="Show"><button aria-pressed="true" data-lt="v">Times</button><button aria-pressed="false" data-lt="d">Δ to own best</button></fieldset><button aria-label="Drivers as columns" title="Drivers as columns">⇄</button>${lapLegend}</div>${raceLapTable()}</div>`;
}

// ---------------------------------------------------------------- 2. compare
const A = 3;
const B = 63;
const series = (n) => Array.from({ length: 71 }, (_, i) => lapOf(raceLaps, n, i + 1));
const pairVars = () =>
  `--tA:#${colourOf(A)};--tA-l:#${clampLight(colourOf(A))};--tB:#${colourOf(B)};--tB-l:#${clampLight(colourOf(B))}`;

function lapChart(v) {
  const [w, h] = v === 'p' ? [358, 250] : [720, 300];
  const m = { l: 40, r: v === 'p' ? 34 : 44, t: 22, b: 24 };
  const sA = series(A);
  const sB = series(B);
  const valid = (l) => l?.lap_ms && !l.deleted && !l.is_pit_in && !l.is_pit_out && !VSC.includes(l.lap_number);
  const fastest = Math.min(...[...sA, ...sB].filter(valid).map((l) => l.lap_ms));
  // "Fit" window: the fastest valid lap − 1 s to + 3 s, whole seconds. Laps above it are marked on the top edge.
  const lo = Math.floor((fastest - 1000) / 1000) * 1000;
  const hi = lo + 4000;
  const x = (k) => m.l + ((k - 1) / 70) * (w - m.l - m.r);
  const y = (ms) => m.t + (1 - (ms - lo) / (hi - lo)) * (h - m.t - m.b);
  const out = [];
  for (let t = lo; t <= hi; t += 1000)
    out.push(
      `<line class="grid" x1="${m.l}" x2="${w - m.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text x="${m.l - 6}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${fmtLap(t).slice(0, 4)}</text>`,
    );
  out.push(
    `<rect class="band" x="${(x(VSC[0]) - 3).toFixed(1)}" y="${m.t}" width="${(x(VSC[1]) - x(VSC[0]) + 6).toFixed(1)}" height="${h - m.t - m.b}"/><text class="bandlabel" x="${((x(VSC[0]) + x(VSC[1])) / 2).toFixed(1)}" y="${m.t - 8}" text-anchor="middle">VSC</text>`,
  );
  out.push(`<line class="axis" x1="${m.l}" x2="${w - m.r}" y1="${h - m.b}" y2="${h - m.b}"/>`);
  for (const k of v === 'p' ? [1, 20, 40, 60, 71] : [1, 10, 20, 30, 40, 50, 60, 71])
    out.push(`<text x="${x(k).toFixed(1)}" y="${h - 8}" text-anchor="middle">${k}</text>`);
  const line = (s, cls) => {
    let d = '';
    let pen = false;
    for (const l of s) {
      if (!l?.lap_ms || l.lap_ms > hi) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${x(l.lap_number).toFixed(1)},${y(l.lap_ms).toFixed(1)}`;
      pen = true;
    }
    return `<path class="ser ${cls}" d="${d}"/>`;
  };
  out.push(line(sA, 'sA'), line(sB, 'sB'));
  // Off the top: a small triangle on the edge, so a clipped lap is never silently gone.
  for (const [s, cls] of [
    [sA, 'sA'],
    [sB, 'sB'],
  ])
    for (const l of s)
      if (l?.lap_ms > hi) {
        const cx = x(l.lap_number);
        out.push(
          `<path class="off ${cls}" d="M${(cx - 4).toFixed(1)},${m.t + 1} L${(cx + 4).toFixed(1)},${m.t + 1} L${cx.toFixed(1)},${m.t - 5} Z"><title>${tla(cls === 'sA' ? A : B)} lap ${l.lap_number}: ${fmtLap(l.lap_ms)}${l.is_pit_in ? ', in-lap' : l.is_pit_out ? ', out-lap' : ''} (above the window)</title></path>`,
        );
      }
  // Each driver's own best: a dot with a surface ring.
  for (const [n, cls] of [
    [A, 'sA'],
    [B, 'sB'],
  ]) {
    const b = bestOwn(raceLaps, n);
    out.push(
      `<circle class="pb ${cls}" cx="${x(b.lap_number).toFixed(1)}" cy="${y(b.lap_ms).toFixed(1)}" r="4"><title>${tla(n)} best: ${fmtLap(b.lap_ms)}, lap ${b.lap_number}</title></circle>`,
    );
  }
  // End labels: separated by at least 14 px, with a leader line back to the line's end.
  const ends = [
    [A, 'sA', sA],
    [B, 'sB', sB],
  ]
    .map(([n, cls, s]) => {
      const last = [...s].reverse().find((l) => l?.lap_ms && l.lap_ms <= hi);
      return { n, cls, x: x(last.lap_number), y: y(last.lap_ms) };
    })
    .sort((p, q) => p.y - q.y);
  if (ends[1].y - ends[0].y < 14) {
    const mid = (ends[0].y + ends[1].y) / 2;
    ends[0].ly = mid - 7;
    ends[1].ly = mid + 7;
  }
  for (const e of ends) {
    const ly = e.ly ?? e.y;
    out.push(
      `<path class="leader ${e.cls}" d="M${e.x + 3},${e.y.toFixed(1)} L${w - m.r + 6},${ly.toFixed(1)}"/><text class="lbl" x="${w - m.r + 9}" y="${(ly + 4).toFixed(1)}">${tla(e.n)}</text>`,
    );
  }
  const rows = Array.from({ length: 71 }, (_, i) => [
    i + 1,
    sA[i]?.lap_ms ?? null,
    sB[i]?.lap_ms ?? null,
    sA[i]?.compound ?? null,
    sB[i]?.compound ?? null,
    sA[i]?.is_pit_in || sA[i]?.is_pit_out ? 1 : 0,
    sB[i]?.is_pit_in || sB[i]?.is_pit_out ? 1 : 0,
  ]);
  const geo = { x0: m.l, x1: w - m.r, t: m.t, b: h - m.b, w, rows, names: [tla(A), tla(B)] };
  out.push(`<line class="hair" x1="0" x2="0" y1="${m.t}" y2="${h - m.b}" visibility="hidden"/>`);
  const legend = `<ul class="legend keys" aria-label="Legend"><li><i class="k sA"></i>${tla(A)} (reference)</li><li><i class="k sB"></i>${tla(B)}</li><li><i class="k pbk"></i>own best</li><li><i class="k offk"></i>above the window</li></ul>`;
  return `${legend}<svg class="chart lapchart" style="${pairVars()}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Lap times of ${tla(A)} and ${tla(B)} per lap, laps 1 to 71; table below" data-geo='${esc(JSON.stringify(geo))}'>${out.join('')}</svg><div class="tip" hidden></div>`;
}

// The gap at each line crossing, from the laps' own start times (no interpolation).
function crossings(n) {
  const s = series(n);
  return s.map((l, i) =>
    s[i + 1]?.date_start ? Date.parse(s[i + 1].date_start) : l?.lap_ms ? Date.parse(l.date_start) + l.lap_ms : null,
  );
}

function gapChart(v) {
  const [w, h] = v === 'p' ? [358, 200] : [440, 210];
  const m = { l: 34, r: 46, t: 18, b: 24 };
  const ca = crossings(A);
  const cb = crossings(B);
  const g = ca.map((t, i) => (t !== null && cb[i] !== null ? (cb[i] - t) / 1000 : null));
  const vals = g.filter((x) => x !== null);
  const lo = Math.floor(Math.min(...vals, 0) / 10) * 10;
  const hi = Math.ceil(Math.max(...vals, 0) / 10) * 10;
  const x = (k) => m.l + ((k - 1) / 70) * (w - m.l - m.r);
  const y = (s) => m.t + (1 - (s - lo) / (hi - lo)) * (h - m.t - m.b);
  const out = [];
  for (let s = lo; s <= hi; s += 10)
    out.push(
      `<line class="${s === 0 ? 'zero' : 'grid'}" x1="${m.l}" x2="${w - m.r}" y1="${y(s).toFixed(1)}" y2="${y(s).toFixed(1)}"/><text x="${m.l - 6}" y="${(y(s) + 4).toFixed(1)}" text-anchor="end">${s > 0 ? '+' : s < 0 ? '−' : ''}${Math.abs(s)}</text>`,
    );
  out.push(
    `<rect class="band" x="${(x(VSC[0]) - 2).toFixed(1)}" y="${m.t}" width="${(x(VSC[1]) - x(VSC[0]) + 4).toFixed(1)}" height="${h - m.t - m.b}"/>`,
  );
  for (const k of [1, 20, 40, 60, 71])
    out.push(`<text x="${x(k).toFixed(1)}" y="${h - 7}" text-anchor="middle">${k}</text>`);
  let d = '';
  g.forEach((s, i) => {
    if (s !== null) d += `${d ? 'L' : 'M'}${x(i + 1).toFixed(1)},${y(s).toFixed(1)}`;
  });
  const last = vals.at(-1);
  out.push(
    `<path class="ser sB" d="${d}"/><circle class="dotB" cx="${x(71).toFixed(1)}" cy="${y(last).toFixed(1)}" r="4"/><text class="lbl" x="${x(71) + 8}" y="${(y(last) + 4).toFixed(1)}">${fmtD(last * 1000, 1)}</text>`,
  );
  out.push(
    `<text x="${m.l + 4}" y="${m.t + 10}">${tla(B)} behind</text><text x="${m.l + 4}" y="${h - m.b - 6}">${tla(B)} ahead</text>`,
  );
  out.push(
    `<text x="${x(24) + 8}" y="${y(Math.min(...vals)) - 4}">${tla(A)} stops</text><text x="${x(39) + 4}" y="${m.t + 22}">${tla(B)} stops</text>`,
  );
  return `<svg class="chart" style="${pairVars()}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Gap of ${tla(B)} to ${tla(A)} at each line crossing, in seconds; ${fmtD(last * 1000, 1)} at the flag">${out.join('')}</svg>`;
}

function duel() {
  const pa = bestOwn(raceLaps, A);
  const pb = bestOwn(raceLaps, B);
  const rows = ['s1', 's2', 's3'].map((s) => {
    const dd = pb[`${s}_ms`] - pa[`${s}_ms`];
    const faster = dd < 0 ? B : A;
    const w = Math.min(50, (Math.abs(dd) / 300) * 50);
    return `<div><dt>${s.toUpperCase()}</dt><dd class="track"><span class="fill ${dd < 0 ? 'r' : 'l'}" style="${teamVar(faster)};--w:${w.toFixed(1)}%"></span></dd><dd class="val num">${fmtD(dd)}</dd></div>`;
  });
  return `<section class="card"><div class="panel-title"><h3>Best laps, sector by sector</h3><p>${tla(B)} L${pb.lap_number} ${fmtLap(pb.lap_ms)} vs ${tla(A)} L${pa.lap_number} ${fmtLap(pa.lap_ms)}</p></div><dl class="duel">${rows.join('')}</dl><div class="duelaxis"><span>◀ ${tla(A)} faster</span><span>${tla(B)} faster ▶</span></div><p class="foot num">Lap ${fmtD(pb.lap_ms - pa.lap_ms)} · the bar has the faster driver's colour</p></section>`;
}

function deltaTable() {
  const rows = [];
  const pa = bestOwn(raceLaps, A);
  const pb = bestOwn(raceLaps, B);
  const bar = (dd) =>
    `<i class="db ${dd < 0 ? 'neg' : 'pos'}" style="--w:${Math.min(50, (Math.abs(dd) / 500) * 50).toFixed(1)}%"></i>`;
  const cellOf = (a, b, s) => {
    if (!a || !b || a.deleted || b.deleted || a[`${s}_ms`] === null || b[`${s}_ms`] === null)
      return '<td class="muted" title="No value, or a deleted lap">—</td>';
    const dd = b[`${s}_ms`] - a[`${s}_ms`];
    return `<td class="dc num">${fmtD(dd)}${bar(dd)}</td>`;
  };
  rows.push(
    `<tr class="bestrow"><th scope="row">Best lap<small>L${pb.lap_number} vs L${pa.lap_number}</small></th>${['s1', 's2', 's3'].map((s) => cellOf(pa, pb, s)).join('')}<td class="dc num">${fmtD(pb.lap_ms - pa.lap_ms)}${bar(pb.lap_ms - pa.lap_ms)}</td></tr>`,
  );
  for (let k = 36; k <= 44; k++) {
    const a = lapOf(raceLaps, A, k);
    const b = lapOf(raceLaps, B, k);
    const note = b?.is_pit_in ? '<span class="tag">IN</span>' : b?.is_pit_out ? '<span class="tag">OUT</span>' : '';
    rows.push(
      `<tr><th scope="row" class="num">${k}${note}</th>${['s1', 's2', 's3'].map((s) => cellOf(a, b, s)).join('')}<td class="dc num">${a?.lap_ms && b?.lap_ms ? fmtD(b.lap_ms - a.lap_ms) + bar(b.lap_ms - a.lap_ms) : '—'}</td></tr>`,
    );
  }
  return `<div class="scroll fit" tabindex="0" role="region" aria-label="Sector deltas"><table class="tt deltas" aria-label="Sector deltas, ${tla(B)} minus ${tla(A)}"><thead><tr><th scope="col">Lap</th><th scope="col">Δ S1</th><th scope="col">Δ S2</th><th scope="col">Δ S3</th><th scope="col">Δ Lap</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

export function screenCompare(v) {
  const chip = (n, ref) =>
    `<span class="chip" style="${teamVar(n)}"><span class="bar"></span>${tla(n)}${ref ? ' <span class="ref">reference</span>' : ''}<button aria-label="Remove ${tla(n)}">×</button></span>`;
  return `${top(v, sessionCrumbs(v, 'Mexico City Grand Prix', 'Mexico City', 'Race'))}<div class="a-body">${raceHead()}${tabs('Compare')}<div class="picked" role="group" aria-label="Drivers">${chip(A, true)}${chip(B)}<button class="add">+ Add driver</button></div><div class="cgrid"><section class="card"><div class="panel-title"><h3>Lap times</h3><fieldset class="seg mini" aria-label="Window"><button aria-pressed="true">Fit</button><button aria-pressed="false">107%</button></fieldset></div>${lapChart(v)}</section><div class="side"><section class="card"><div class="panel-title"><h3>Gap ${tla(B)} to ${tla(A)}</h3><p>seconds, at each line crossing</p></div>${gapChart(v)}</section>${duel()}</div></div><div class="panel-title spaced"><h3>Sector deltas, ${tla(B)} − ${tla(A)}</h3><p>bar left: ${tla(B)} faster · laps 36–44 of 71</p></div>${deltaTable()}</div>`;
}

// ---------------------------------------------------------------- 3. the replay pit wall
const tower = data.tower;
const lines = Object.values(tower.TimingData.Lines).sort((a, b) => a.Line - b.Line);
const grid = data.race.grid;

const msCls = (s) => (s === 2051 ? 'p' : s === 2049 ? 'g' : s === 2064 ? 'l' : s === 0 || s === null ? 'n' : '');
const msSegs = (segs) =>
  `<span class="ms thin" aria-hidden="true">${Object.values(segs ?? {})
    .map((s) => `<i class="${msCls(s.Status)}"></i>`)
    .join('')}</span>`;

function towerTable() {
  const rows = lines.map((l) => {
    const n = Number(l.RacingNumber);
    const st = Object.values(tower.TimingAppData.Lines[n].Stints).at(-1);
    const change = grid.indexOf(n) + 1 - l.Line;
    const pc =
      change > 0
        ? `▲${change}`
        : change < 0
          ? `<span class="muted">▼${-change}</span>`
          : '<span class="muted">–</span>';
    const flag = (x) => (x?.OverallFastest ? 't-p' : x?.PersonalFastest ? 't-g' : '');
    const sec = (i) => {
      const s = l.Sectors[i];
      return `<td class="sec hide-s"><span class="${flag(s)} num">${s.Value || '—'}</span>${msSegs(s.Segments)}</td>`;
    };
    const leader = l.Line === 1;
    const iv = l.IntervalToPositionAhead.Value;
    const close = !leader && /^\+0\.\d+$/.test(iv);
    return `<tr class="${l.InPit ? 'pitting' : ''}${n === 63 ? ' focus' : ''}">${drvCell(n, l.Line)}<td class="pc hide-s" title="Places since the start">${pc}</td><td class="gap num">${leader ? '<span class="muted">Leader</span>' : esc(l.GapToLeader)}</td><td class="int num${close ? ' close' : ''}">${leader ? '' : esc(iv)}${close ? '<span class="vh">, within a second</span>' : ''}</td><td class="num"><span class="${flag(l.LastLapTime)}">${esc(l.LastLapTime.Value)}</span></td><td class="num hide-s">${esc(l.BestLapTime.Value)}</td>${sec(0)}${sec(1)}${sec(2)}<td class="tyre">${cmp(st.Compound, st.New !== 'true')}<span class="num">${st.TotalLaps}</span></td><td class="hide-s">${l.NumberOfPitStops}${l.InPit ? '<span class="tag">IN PIT</span>' : l.PitOut ? '<span class="tag">OUT</span>' : ''}</td></tr>`;
  });
  return `<div class="scroll" tabindex="0" role="region" aria-label="Timing tower"><table class="tt tower" aria-label="Timing tower at lap ${tower.LapCount.CurrentLap}"><thead><tr><th scope="col">Driver</th><th scope="col" class="hide-s" title="Places since the start">±</th><th scope="col">Gap</th><th scope="col">Int</th><th scope="col">Last</th><th scope="col" class="hide-s">Best</th><th scope="col" class="hide-s">S1</th><th scope="col" class="hide-s">S2</th><th scope="col" class="hide-s">S3</th><th scope="col">Tyre</th><th scope="col" class="hide-s">Pits</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function strip() {
  const latest = Object.values(tower.RaceControlMessages.Messages).at(-1);
  return `<dl class="strip" aria-label="Session state"><div><dt>LAP</dt><dd class="v num">${tower.LapCount.CurrentLap} / ${tower.LapCount.TotalLaps}</dd></div><div><dt>LEFT</dt><dd class="v num">${tower.ExtrapolatedClock.Remaining.replace(/^00:/, '')}</dd></div><div><dt>TRACK</dt><dd class="v"><span class="flag">Clear</span></dd></div><div class="hide-s"><dt>WEATHER</dt><dd class="v">${tower.WeatherData.AirTemp}° air · ${tower.WeatherData.TrackTemp}° track · dry</dd></div><div class="msg hide-s"><dt>RACE CONTROL · L${latest.Lap}</dt><dd class="v" title="${esc(latest.Message)}">${esc(latest.Message)}</dd></div></dl>`;
}

function side() {
  const msgs = Object.values(tower.RaceControlMessages.Messages).reverse();
  const cat = (m) =>
    m.Category === 'Flag'
      ? 'FLAG'
      : m.Category === 'SafetyCar'
        ? 'VSC'
        : /DELETED/.test(m.Message)
          ? 'LIMITS'
          : /INCIDENT/.test(m.Message)
            ? 'INCIDENT'
            : m.Category.toUpperCase();
  const feed = msgs
    .map(
      (m) =>
        `<li><span class="lap num">L${m.Lap}</span><span><span class="cat">${cat(m)}</span>${esc(m.Message)}</span></li>`,
    )
    .join('');
  const bestLine = lines
    .filter((l) => l.BestLapTime.Value)
    .sort((a, b) => (a.BestLapTime.Value < b.BestLapTime.Value ? -1 : 1))[0];
  const battles = lines
    .filter((l) => l.Line > 1 && /^\+0\.\d+$/.test(l.IntervalToPositionAhead.Value))
    .map((l) => {
      const ahead = lines.find((x) => x.Line === l.Line - 1);
      return `<div class="row"><span><span class="muted num">P${ahead.Line}</span> <b>${tla(Number(ahead.RacingNumber))}</b> <span class="muted">from</span> <b>${tla(Number(l.RacingNumber))}</b></span><span class="num">${l.IntervalToPositionAhead.Value}</span></div>`;
    });
  return `<aside class="side"><section class="card"><h3>Race control</h3><div class="chips" role="group" aria-label="Filter"><button aria-pressed="true">All 7</button><button aria-pressed="false">Flags</button><button aria-pressed="false">Incidents</button><button aria-pressed="false">Track limits</button></div><ol class="feed" reversed>${feed}</ol></section><section class="card hide-s"><h3>Within a second</h3>${battles.join('')}</section><section class="card hide-s"><h3>Fastest lap so far</h3><div class="row"><span><span class="t-p num">${bestLine.BestLapTime.Value}</span> ${tla(Number(bestLine.RacingNumber))}</span><span class="muted">L${bestLine.BestLapTime.Lap}</span></div></section></aside>`;
}

function player(v, { live = false } = {}) {
  const span = data.recordings.find((r) => r.id === 7);
  const lo = Date.parse(span.started_at);
  const hi = Date.parse(span.ended_at);
  const T = data.towerT;
  // The thumb's centre travels the track minus its own width, so every position is inset by half a thumb.
  const at = (t) =>
    `calc(${(((t - lo) / (hi - lo)) * 100).toFixed(2)}% - ${((16 * (t - lo)) / (hi - lo)).toFixed(1)}px)`;
  const width = (a, b) => `${(((b - a) / (hi - lo)) * 100).toFixed(2)}%`;
  const start = Date.parse(raceDetail.session.date_start);
  const c = data.race.cum;
  const vscOn = start + c[12][33] + 20e3;
  const vscOff = start + c[12][35] - 25e3;
  const pits = data.stints[RACE]
    .filter((s) => s.driver_number === 63 && s.stint_number > 1)
    .map((s) => start + c[63][s.lap_start - 1]);
  const marks = [`<span class="mk start" style="--x:${at(start)}" title="Start ${hhmm(start)}"></span>`];
  if (vscOn <= T)
    marks.push(
      `<span class="mk band" style="--x:${at(vscOn)};--w:${width(vscOn, Math.min(vscOff, T))}" title="VSC ${hhmm(vscOn)}"></span>`,
    );
  for (const t of pits.filter((p) => p <= T))
    marks.push(`<span class="mk pit" style="--x:${at(t)}" title="RUS pit stop"></span>`);
  const chips = [
    `<button>Start ${hhmm(start)}</button>`,
    vscOn <= T ? `<button>VSC ${hhmm(vscOn)}</button>` : '',
    pits.some((p) => p <= T) ? '<button>RUS stop L39</button>' : '',
  ].join('');
  const clock = `<div class="clockline"><b class="num">${amsClock.format(T)}</b><span class="num">${tower.ExtrapolatedClock.Remaining.replace(/^00:/, '')} left</span><span class="num">Lap ${tower.LapCount.CurrentLap}/${tower.LapCount.TotalLaps}</span>${live ? '<span class="pill live"><span class="dot"></span>LIVE, 8 s behind</span>' : '<span class="pill"><span class="dot"></span>Replay</span>'}</div>`;
  const key =
    v === 'p'
      ? ''
      : '<span class="mkkey"><i class="k1"></i>start <i class="k2"></i>VSC <i class="k3"></i>RUS stop</span>';
  return `<div class="player" role="group" aria-label="Player">${clock}<div class="transport"><button aria-label="30 seconds earlier">−30</button><button aria-label="5 seconds earlier">−5</button><button class="play" aria-label="Pause">${icon.pause}</button><button aria-label="5 seconds later">+5</button><button aria-label="30 seconds later">+30</button></div><div class="seekwrap"><div class="seekline" role="slider" tabindex="0" aria-label="Position" aria-valuetext="${hhmm(T)}, lap ${tower.LapCount.CurrentLap}"><span class="track"></span><span class="done" style="--w:${at(T)}"></span>${marks.join('')}<span class="thumb" style="--x:${at(T)}"></span></div><div class="seekmeta"><span>${hhmm(lo)}</span>${key}<span>${hhmm(hi)}</span></div></div><div class="jump" role="group" aria-label="Go back to"><span class="muted jl">Back to</span>${chips}${live ? '<span class="delay"><button aria-label="Less delay">−1</button><output>delay 8 s</output><button aria-label="More delay">+1</button></span>' : ''}</div></div>`;
}

export function screenReplay(v) {
  const crumbs =
    v === 'p'
      ? `<span class="pill">REPLAY</span><button class="grow"><span class="clip">Mexico City · Race</span> <span class="caret">▾</span></button>`
      : `<span class="pill">REPLAY</span><button>Mexico City Grand Prix · Race <span class="caret">▾</span></button>`;
  const since = `<p class="since"><b>Before this point</b><span>VSC laps 34–35 · 21 pit stops · 1 lap deleted (BEA, L18) · 1 incident noted (LAW, COL)</span><button aria-label="Dismiss">×</button></p>`;
  const msLegend = `<ul class="legend tower-legend" aria-label="Mini-sector legend"><li><span class="ms"><i class="p"></i></span>overall best</li><li><span class="ms"><i class="g"></i></span>personal best</li><li><span class="ms"><i></i></span>other</li><li><span class="ms"><i class="l"></i></span>pit lane</li><li><span class="ms"><i class="n"></i></span>no data</li><li>▲ places since the start</li></ul>`;
  return `${top(v, crumbs)}<div class="a-body scrollbody">${strip()}${since}<div class="pitwall"><div>${towerTable()}${msLegend}</div>${side()}</div></div>${player(v)}`;
}

// ---------------------------------------------------------------- 4. qualifying
export function screenQuali(v) {
  const det = data.detail[QUALI];
  const laps = data.laps[QUALI];
  const res = det.results;
  const pole = res[0].durations_ms[2];
  const cut = (phase, k) =>
    res
      .map((r) => r.durations_ms[phase - 1])
      .filter((x) => x !== null)
      .sort((a, b) => a - b)[k - 1];
  const cutQ1 = cut(1, 16);
  const cutQ2 = cut(2, 10);
  const purple = (phase) => Math.min(...res.map((r) => r.durations_ms[phase - 1] ?? Infinity));
  const cell = (r, phase, cutoff) => {
    const val = r.durations_ms[phase - 1];
    if (val === null) return '<td class="muted">—</td>';
    const flying = laps.filter(
      (l) => l.driver_number === r.driver_number && l.quali_phase === phase && !l.is_pit_in && !l.is_pit_out,
    );
    const del = flying.some((l) => l.deleted);
    const margin = cutoff ? val - cutoff : null;
    return `<td><span class="num ${val === purple(phase) ? 't-p' : ''}">${fmtLap(val)}</span>${del ? '<span class="tag" title="A lap in this phase was deleted">DEL</span>' : ''}${margin !== null ? `<small class="margin num">${margin <= 0 ? `${fmtD(margin)} inside` : `${fmtD(margin)} out`}</small>` : ''}</td>`;
  };
  const rows = [];
  res.forEach((r, i) => {
    const p = i + 1;
    const n = r.driver_number;
    const q3 = r.durations_ms[2];
    rows.push(
      `<tr class="${p === 10 || p === 16 ? 'cut' : ''}${p > 10 ? ' out' : ''}">${drvCell(n, p)}${cell(r, 1, cutQ1)}${cell(r, 2, p <= 16 ? cutQ2 : null)}${cell(r, 3, null)}<td class="num">${q3 !== null ? (p === 1 ? '<span class="muted">pole</span>' : fmtD(q3 - pole)) : '<span class="muted">—</span>'}</td><td class="num hide-s">${laps.filter((l) => l.driver_number === n && !l.is_pit_in && !l.is_pit_out).length}</td></tr>`,
    );
    if (p === 10)
      rows.push('<tr class="cutlabel"><td colspan="6"><span>Q3 above · knocked out in Q2 below</span></td></tr>');
    if (p === 16)
      rows.push('<tr class="cutlabel"><td colspan="6"><span>Q2 above · knocked out in Q1 below</span></td></tr>');
  });
  const tiles = `<dl class="kpis three" aria-label="Qualifying"><div><dt>Pole</dt><dd class="v num">${fmtLap(pole)}</dd><dd class="who">${tla(res[0].driver_number)} · Q3</dd></div><div><dt>Q1 cut-off (P16)</dt><dd class="v num">${fmtLap(cutQ1)}</dd><dd class="who">${tla(res[15].driver_number)}</dd></div><div><dt>Q2 cut-off (P10)</dt><dd class="v num">${fmtLap(cutQ2)}</dd><dd class="who">${tla(res[9].driver_number)}</dd></div></dl>`;
  return `${top(v, sessionCrumbs(v, 'Mexico City Grand Prix', 'Mexico City', 'Qualifying'))}<div class="a-body">${head({ title: 'Mexico City Grand Prix', kind: 'Qualifying', meta: `${when(det.session.date_start)} · Round 19 · data final`, active: 'Quali' })}${tiles}${tabs('Laps')}<div class="a-tool"><fieldset class="seg" aria-label="View"><button aria-pressed="true">By phase</button><button aria-pressed="false">Every lap</button></fieldset><ul class="legend"><li><span class="t-p">1:14.944</span> fastest of the phase</li><li><span class="muted num">−0.212 inside</span> margin to that phase's cut-off</li></ul></div><div class="scroll fit" tabindex="0" role="region" aria-label="Qualifying by phase"><table class="tt quali" aria-label="Qualifying by phase"><thead><tr><th scope="col">Driver</th><th scope="col">Q1</th><th scope="col">Q2</th><th scope="col">Q3</th><th scope="col">To pole</th><th scope="col" class="hide-s">Timed laps</th></tr></thead><tbody>${rows.join('')}</tbody></table></div></div>`;
}

// ---------------------------------------------------------------- 5. stints
export function screenStints(v) {
  const lapsMax = 71;
  const pct = (k) => `${(((k - 1) / lapsMax) * 100).toFixed(2)}%`;
  const wid = (a, b) => `${(((b - a + 1) / lapsMax) * 100).toFixed(2)}%`;
  const lastLap = (n) => Math.max(...raceLaps.filter((l) => l.driver_number === n).map((l) => l.lap_number));
  const ticks = [1, 10, 20, 30, 40, 50, 60, 71];
  const rules =
    ticks.map((k) => `<i class="rule" style="--x:${pct(k)}"></i>`).join('') +
    `<i class="vscline" style="--x:${pct(VSC[0])};--w:${wid(VSC[0], VSC[1])}"></i>`;
  const rows = raceOrder.map((n) => {
    const st = data.stints[RACE].filter((s) => s.driver_number === n);
    const segs = st
      .map(
        (s) =>
          `<span class="s cmp-${compoundClass(s.compound)}" style="--x:${pct(s.lap_start)};--w:${wid(s.lap_start, s.lap_end)}" title="${esc(`${s.compound} · laps ${s.lap_start}–${s.lap_end} · ${s.lap_end - s.lap_start + 1} laps · ${s.tyre_age_at_start ? `used set, ${s.tyre_age_at_start} laps old` : 'new set'}`)}"><b>${s.compound[0]}</b><small>${s.lap_end - s.lap_start + 1}${s.tyre_age_at_start ? ' · used' : ''}</small></span>`,
      )
      .join('');
    const stops = st.length - 1;
    return `<li><button class="rowbtn" aria-label="${tla(n)}: ${st.map((s) => `${s.compound.toLowerCase()} laps ${s.lap_start} to ${s.lap_end}`).join(', ')}">${drvInner(n, resultPos.get(n))}</button><div class="lane"><span class="trackline" style="--w:${wid(1, lastLap(n))}"></span>${segs}</div><span class="stop">${n === 77 ? 'out L48' : `${stops} stop${stops === 1 ? '' : 's'}`}</span></li>`;
  });
  const legend = `<ul class="legend" aria-label="Legend"><li>${cmp('SOFT')} soft</li><li>${cmp('MEDIUM')} medium</li><li>${cmp('HARD')} hard</li><li><span class="flag vsc">VSC, laps 34–35</span></li><li>number: laps on that set</li></ul>`;
  return `${top(v, sessionCrumbs(v, 'Mexico City Grand Prix', 'Mexico City', 'Race'))}<div class="a-body">${raceHead()}${tabs('Stints')}<div class="a-tool">${legend}</div><div class="stintbox"><div class="laxis"><span></span><div class="ticks">${ticks.map((k) => `<span style="--x:${pct(k)}">${k}</span>`).join('')}</div><span></span></div><div class="lanes"><div class="rules" aria-hidden="true">${rules}</div><ol class="stints">${rows.join('')}</ol></div></div></div>`;
}

// ---------------------------------------------------------------- 6. season
export function screenSeason(v) {
  const now = data.now;
  const mtg = data.season;
  const sp = mtg[2];
  const fp3 = sp.sessions[2];
  const hours = (Date.parse(fp3.date_start) - now) / 3600e3;
  const rec = new Set(data.recordings.map((r) => r.session_key));
  const state = (s) =>
    Date.parse(s.date_end) < now
      ? rec.has(s.session_key)
        ? '<span class="state rec">recorded · <a href="#">Replay</a></span>'
        : '<span class="state final">laps ready</span>'
      : `<span class="state">${s === fp3 ? 'next' : 'scheduled'}</span>`;
  const local = (iso, off) => {
    const d = new Date(Date.parse(iso) + Number(off.slice(0, 3)) * 3600e3);
    return `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}`;
  };
  const sessList = (m, full) =>
    `<ul class="sess${full ? ' full' : ''}">${m.sessions.map((s) => `<li><a href="#">${esc(s.name)}</a><span class="when num">${full ? `${when(s.date_start)} <span class="muted">· ${local(s.date_start, m.gmt_offset)} at the track</span>` : `${when(s.date_start).split(' ')[0]} ${hhmm(Date.parse(s.date_start))}`}</span>${full ? state(s) : ''}</li>`).join('')}</ul>`;
  const range = (m) =>
    `${when(m.date_start).split(' ').slice(1, 3).join(' ')} – ${when(m.date_end).split(' ').slice(1, 3).join(' ')}`;
  const others = [
    [mtg[1], 19, 'done'],
    [mtg[0], 18, 'done'],
    [mtg[3], 21, 'next weekend'],
  ]
    .map(
      ([m, r, st]) =>
        `<article class="meeting"><div class="eyebrow">ROUND ${r} · ${esc(m.country_code)} · ${st.toUpperCase()}</div><h3>${esc(m.name)}</h3><p class="muted">${esc(m.circuit_short_name)} · ${range(m)}</p>${sessList(m, false)}</article>`,
    )
    .join('');
  return `${top(v, '<button>2026 <span class="caret">▾</span></button>')}<div class="a-body"><section class="weekend" aria-label="This weekend"><div><div class="eyebrow">THIS WEEKEND · ROUND 20 OF 23 · BRA</div><h2>São Paulo Grand Prix</h2><p class="muted">Interlagos · ${range(sp)} · Amsterdam time, track time beside it · no results shown</p>${sessList(sp, true)}</div><div class="next"><div class="eyebrow">UP NEXT</div><div class="count num">${Math.floor(hours)} h ${Math.round((hours % 1) * 60)} min</div><div>Practice 3 · ${when(fp3.date_start)}</div><div class="muted">The recorder starts by itself 15 minutes before.</div><a class="btnlink" href="#"><span class="dot"></span>Open Live</a></div></section><h2 class="eyebrow sect">THE REST OF 2026</h2><div class="meetings">${others}</div></div>`;
}

export const SCREENS = [
  { id: 'replay', title: 'Replay: the pit wall', render: screenReplay },
  { id: 'laps', title: 'Race: lap table', render: screenLaps },
  { id: 'compare', title: 'Race: compare two drivers', render: screenCompare },
  { id: 'quali', title: 'Qualifying: by phase', render: screenQuali },
  { id: 'stints', title: 'Race: stints', render: screenStints },
  { id: 'season', title: 'Season: this weekend first', render: screenSeason },
];
