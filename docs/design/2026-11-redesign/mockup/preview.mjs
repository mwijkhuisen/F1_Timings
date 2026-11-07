// All screens on one page (out/preview.html), one device-sized frame per screen and width, for render.cjs.
import { readFileSync, writeFileSync } from 'node:fs';
import { SCREENS } from './screens.mjs';

export const FRAMES = { d: { w: 1280, h: 820 }, p: { w: 390, h: 844 } };
const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
const frames = [];
for (const s of SCREENS)
  for (const [v, f] of Object.entries(FRAMES))
    frames.push(
      `<section class="frame ${v}" id="${s.id}-${v}" style="width:${f.w}px"><div class="app" data-app-theme="dark" style="--fh:${f.h}px">${s.render(v)}</div></section>`,
    );

export const RUNTIME = `
for (const el of document.querySelectorAll('[data-scroll-to]')) {
  const ths = el.querySelectorAll('thead th');
  const target = ths[Number(el.dataset.scrollTo) + 1];
  el.scrollLeft = 0;
  el.scrollLeft = target.getBoundingClientRect().left - ths[1].getBoundingClientRect().right;
}
`;
const js = `${RUNTIME}
const q = new URLSearchParams(location.search);
if (q.get('theme')) for (const a of document.querySelectorAll('.app')) a.dataset.appTheme = q.get('theme');
if (q.get('delta')) for (const t of document.querySelectorAll('.lt')) t.classList.add('show-d');
`;
if (process.argv[1]?.endsWith('preview.mjs')) {
  writeFileSync(
    new URL('./out/preview.html', import.meta.url),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>preview</title><style>body{margin:0;background:#888;display:grid;gap:24px;padding:24px;justify-items:start}${css}</style></head><body>${frames.join('')}<script>${js}</script></body></html>`,
  );
  console.log('frames', frames.length);
}
