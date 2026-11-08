import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fastestSoFar, LIGHT, type Light, raceControl, stripOf, withinASecond } from '../src/lib/pitwall.ts';
import { Panel, SessionLight, Strip } from '../src/views/PitWall.tsx';
import { practiceState, raceState } from './feed-state.ts';

// The pit wall's markup (A§13, P4d) on synthetic feed states.

const T = Date.parse('2026-01-11T14:20:00Z') + 65_500; // 65.5 s after the clock's Utc
const strip = (s = raceState()) => renderToStaticMarkup(<Strip strip={stripOf(s)} now={() => T} playing={false} />);
const panel = (s = raceState(), race = true) =>
  renderToStaticMarkup(<Panel rc={raceControl(s)} pairs={withinASecond(s)} fastest={fastestSoFar(s)} race={race} />);

describe('SessionLight', () => {
  it.each(Object.keys(LIGHT) as Light[])('%s: the word as text, the lamps hidden, the lit lamp a class', (key) => {
    const { lamp, word } = LIGHT[key];
    expect(renderToStaticMarkup(<SessionLight light={key} />)).toBe(
      `<span class="${lamp ? `light lamp-${lamp}` : 'light'}"><span class="lamps" aria-hidden="true">` +
        `<i class="r"></i><i class="y"></i><i class="g"></i></span><span class="lw">${word}</span></span>`,
    );
  });

  it('sets no style', () => {
    for (const key of Object.keys(LIGHT) as Light[])
      expect(renderToStaticMarkup(<SessionLight light={key} />)).not.toContain('style');
  });
});

describe('Strip', () => {
  it('shows the light, the lap, the time left at T, the weather and the latest message', () => {
    const html = strip(raceState({ track: '4', msgs: [[11, 'SafetyCar', 'SAFETY CAR DEPLOYED']] }));
    expect(html).toMatch(
      /^<dl class="strip" aria-label="Session state"><div><dt>Session<\/dt><dd><span class="light lamp-y">/,
    );
    expect(html).toContain('<span class="lw">Safety car</span>');
    expect(html).toContain('<div><dt>Lap</dt><dd class="v">12 / 57</dd></div>');
    expect(html).toContain('<div><dt>Left</dt><dd class="v">1:28:59</dd></div>'); // 1:30:05 − 65.5 s
    expect(html).toContain('<div><dt>Weather</dt><dd class="v">22.4° air · 43.1° track · dry</dd></div>');
    expect(html).toContain(
      '<div class="msg"><dt>Race control · L11</dt><dd class="v" title="SAFETY CAR DEPLOYED">SAFETY CAR DEPLOYED</dd></div>',
    );
  });

  it('leaves out the cells without data', () => {
    const html = strip(practiceState());
    expect(html).not.toContain('<dt>Lap</dt>');
    expect(html).not.toContain('<dt>Weather</dt>');
    expect(html).not.toContain('class="msg"');
    expect(html).toContain('<dt>Left</dt><dd class="v">59:59</dd>'); // frozen
    expect(renderToStaticMarkup(<Strip strip={stripOf({})} now={() => T} playing={false} />)).toBe(
      '<dl class="strip" aria-label="Session state"><div><dt>Session</dt><dd><span class="light"><span class="lamps" ' +
        'aria-hidden="true"><i class="r"></i><i class="y"></i><i class="g"></i></span><span class="lw">Not started</span>' +
        '</span></dd></div></dl>',
    );
  });
});

describe('Panel', () => {
  const s = raceState({
    msgs: [
      [1, 'Flag', 'GREEN LIGHT - PIT EXIT OPEN'],
      [5, 'SafetyCar', 'VIRTUAL SAFETY CAR DEPLOYED'],
      [9, 'Other', 'CAR 4 (DDD) TIME 1:22.214 DELETED - TRACK LIMITS AT TURN 7'],
      [10, 'Other', 'DRS ENABLED'],
    ],
  });
  const html = panel(s);

  it('offers the race-control kinds as pressed buttons with their counts, All pressed', () => {
    expect(html).toContain(
      '<fieldset class="chips" aria-label="Filter"><button type="button" aria-pressed="true">All 4</button>' +
        '<button type="button" aria-pressed="false">Flags 1</button><button type="button" aria-pressed="false">SC/VSC 1</button>' +
        '<button type="button" aria-pressed="false">Incidents 0</button><button type="button" aria-pressed="false">Track limits 1</button></fieldset>',
    );
  });

  it('lists the messages newest first in a named scroll box, with lap and tag', () => {
    expect(html).toContain(
      '<div class="scroll" tabindex="0" role="region" aria-label="Race control messages"><ol class="feed">',
    );
    expect(html).toContain(
      '<li><span class="lap">L10</span><span>DRS ENABLED</span></li><li><span class="lap">L9</span><span><span class="cat">LIMITS</span>CAR 4',
    );
    expect(html.indexOf('L5')).toBeLessThan(html.indexOf('L1<'));
  });

  it('pairs the cars within a second, and shows the fastest lap so far', () => {
    expect(html).toContain(
      '<li><span><span class="muted">P1</span> <b>AAA</b> <span class="muted">from</span> <b>BBB</b></span><span>+0.400</span></li>',
    );
    expect(html).toContain(
      '<span class="t-purple">1:20.500<span class="vh">, overall best</span></span> <b>BBB</b></span><span class="muted">L9</span>',
    );
  });

  it('says when there is nothing yet, and has no "within a second" outside races', () => {
    const empty = renderToStaticMarkup(<Panel rc={raceControl({})} pairs={[]} fastest={undefined} race={true} />);
    expect(empty).toContain('<p class="muted">No messages yet.</p>');
    expect(empty).toContain('No car within a second of the one ahead.');
    expect(empty).toContain('No lap time yet.');
    expect(empty).not.toContain('class="scroll"');
    expect(panel(practiceState(), false)).not.toContain('Within a second');
  });
});

describe('feed text as text', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const s = raceState({ msgs: [[3, 'Other', evil]], extra: { WeatherData: { AirTemp: evil, Rainfall: '0' } } });

  it('escapes a message in the strip and the panel', () => {
    for (const html of [strip(s), panel(s)]) {
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    }
    expect(strip(s)).toContain('title="&lt;img src=x onerror=alert(1)&gt;"');
    expect(strip(s)).toContain('<dd class="v">dry</dd>'); // a temperature that is no number is left out
  });
});
