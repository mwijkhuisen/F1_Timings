import type { EChartsCoreOption } from 'echarts/core';
import { useEffect, useRef, useState } from 'react';
import { Pending } from '../ui/ErrorView.tsx';

type Chart = ReturnType<typeof import('../lib/echarts.ts')['init']>;

/** An ECharts line chart on a canvas. The library is a lazy chunk, loaded on first render (D3). */
export function LapChart({ option, label }: { option: EChartsCoreOption; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<Chart | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let gone = false;
    let observer: ResizeObserver | undefined;
    import('../lib/echarts.ts').then(
      ({ init }) => {
        if (gone) return;
        const c = init(el, undefined, { renderer: 'canvas' });
        chart.current = c;
        observer = new ResizeObserver(() => c.resize());
        observer.observe(el);
        setState('ready');
      },
      () => !gone && setState('failed'),
    );
    return () => {
      gone = true;
      observer?.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (state === 'ready') chart.current?.setOption(option, { notMerge: true });
  }, [state, option]);

  return (
    <>
      {state === 'loading' && <Pending error={null} />}
      {state === 'failed' && <p role="alert">Chart failed to load: reload the page.</p>}
      <div ref={box} className="chart" role="img" aria-label={label} hidden={state === 'failed'} />
    </>
  );
}
