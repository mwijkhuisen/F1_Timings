// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RaceControl } from '@f1/contracts';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RaceControlLog } from '../src/views/RaceControlLog.tsx';
import { lap, rc, sessionDetail } from './laps.ts';

// The race-control log (#111, A§13) on the race_control-normal and race_control-quali goldens. The counts come from an
// independent count of the fixtures (python3 -I over the goldens).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Under happy-dom `import.meta.url` loses the workspace root, so the path starts at the root vitest runs in.
const golden = (name: string) =>
  RaceControl.parse(
    (
      JSON.parse(
        readFileSync(join(process.cwd(), 'apps/server/src/openf1/fixtures', `${name}.golden.json`), 'utf8'),
      ) as (Record<string, unknown> & { date: string | null })[]
    ).map(({ session_key: _, date, ...row }) => ({ ...row, date: date && new Date(date).toISOString() })),
  );

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const drivers: [number, string][] = [
  [81, 'PIA'],
  [4, 'NOR'],
];
const show = (type: string, name: string, rows: RaceControl, phases = 0) =>
  act(() =>
    root.render(
      <RaceControlLog
        detail={sessionDetail(type, name, drivers)}
        laps={[
          lap(81, 1, { quali_phase: phases || null }),
          ...[1, 2, 3].slice(0, phases).map((p) => lap(4, p, { quali_phase: p })),
        ]}
        rows={rows}
      />,
    ),
  );
const chips = () => [...host.querySelectorAll('fieldset.chips button')].map((b) => b.textContent);
const click = (label: string, within = 'fieldset.chips') =>
  act(() =>
    [...host.querySelectorAll<HTMLElement>(`${within} button`)].find((b) => b.textContent?.startsWith(label))?.click(),
  );
const listed = () => host.querySelectorAll('ol.feed li').length;

describe('RaceControlLog', () => {
  it('counts the race rows per kind', () => {
    show('Race', 'Race', golden('race_control-normal'));
    expect(chips()).toEqual(['All 155', 'Flags 95', 'SC/VSC 4', 'Incidents 10', 'Track limits 30']);
    expect(listed()).toBe(155);
    expect(host.querySelector('.rclog')).not.toBeNull();
    // Oldest first, each row with its clock time and lap.
    expect(host.querySelector('ol.feed li')?.textContent).toContain('TRACK SURFACE SLIPPERY IN TRACK SECTOR 3');
    expect(host.querySelector('ol.feed li .time')?.textContent).toMatch(/^\d\d:\d\d:\d\d$/);
    click('Track limits');
    expect(listed()).toBe(30);
  });

  it('counts the qualifying rows per kind and filters by phase (carried, D3)', () => {
    show('Qualifying', 'Qualifying', golden('race_control-quali'), 3);
    expect(chips()).toEqual(['All 39', 'Flags 14', 'SC/VSC 0', 'Incidents 6', 'Track limits 8']);
    const counts = [1, 2, 3].map((p) => {
      click(`Q${p}`, 'fieldset.segmented');
      return chips()[0];
    });
    expect(counts).toEqual(['All 11', 'All 11', 'All 15']);
    click('All', 'fieldset.segmented');
    expect(chips()[0]).toBe('All 39');
  });

  it('names the phases SQ in sprint qualifying', () => {
    show('Qualifying', 'Sprint Qualifying', golden('race_control-quali'), 3);
    expect([...host.querySelectorAll('fieldset.segmented button')].map((b) => b.textContent)).toEqual([
      'All',
      'SQ1',
      'SQ2',
      'SQ3',
    ]);
  });

  it('offers no phase filter outside qualifying', () => {
    show('Race', 'Race', golden('race_control-normal'));
    expect(host.querySelector('fieldset.segmented')).toBeNull();
  });

  it('filters by driver: the rows that name 81 (PIA) or carry its number', () => {
    show('Qualifying', 'Qualifying', golden('race_control-quali'), 3);
    const select = host.querySelector('select[aria-label="Driver"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['All drivers', 'NOR', 'PIA']);
    act(() => {
      select.value = '81';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(chips()[0]).toBe('All 6');
    expect(listed()).toBe(6);
  });

  it('says so without rows', () => {
    show('Race', 'Race', []);
    expect(host.textContent).toBe('No race-control messages in the OpenF1 data.');
  });

  it('renders a message holding markup as text', () => {
    const bad = '<img src=x onerror=alert(1)>';
    show('Race', 'Race', [rc(1, bad)]);
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('ol.feed li')?.textContent).toContain(bad);
    expect(host.querySelector('[title]')).toBeNull();
  });
});
