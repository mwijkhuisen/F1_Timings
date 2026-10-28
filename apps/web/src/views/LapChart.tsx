import type { Laps } from '@f1/contracts';
import { useEffect, useRef, useState } from 'react';
import type { Driver } from '../lib/session.ts';
import { Pending } from '../ui/ErrorView.tsx';
import { type ChartTokens, lapChartOption } from './lap-chart-option.ts';

type Chart = ReturnType<typeof import('../lib/echarts.ts')['init']>;

/** An ECharts line chart on a canvas. The library is a lazy chunk, loaded on first render (D3). */
export function LapChart({ drivers, laps }: { drivers: readonly Driver[]; laps: Laps }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<Chart | null>(null);
  const [state, setState] = useState<'loading' | 'failed' | ChartTokens>('loading');

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let gone = false;
    let observer: ResizeObserver | undefined;
    // Any failure, the import or the set-up after it, shows the failure line instead of "Loading…".
    import('../lib/echarts.ts')
      .then(({ init }) => {
        if (gone) return;
        const c = init(el, undefined, { renderer: 'canvas' });
        chart.current = c;
        observer = new ResizeObserver(() => c.resize());
        observer.observe(el);
        // ponytail: the theme is read once; a live prefers-color-scheme switch needs a reload (A§13 follow-up).
        const css = getComputedStyle(el);
        const token = (name: string) => css.getPropertyValue(`--${name}`).trim();
        setState({ fg: token('fg'), muted: token('muted'), line: token('line'), bg: token('bg') });
      })
      .catch(() => {
        if (!gone) setState('failed');
      });
    return () => {
      gone = true;
      observer?.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (typeof state === 'object') chart.current?.setOption(lapChartOption(drivers, laps, state), { notMerge: true });
  }, [state, drivers, laps]);

  return (
    <>
      {state === 'loading' && <Pending error={null} />}
      {state === 'failed' && <p role="alert">Chart failed to load: reload the page.</p>}
      <div
        ref={box}
        className="chart"
        role="img"
        aria-label={`Lap times: ${drivers.map((d) => d.acronym).join(', ')}`}
        hidden={state === 'failed'}
      />
    </>
  );
}
