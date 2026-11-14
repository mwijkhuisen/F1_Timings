import { useEffect, useRef, useState } from 'react';
import { currentTheme, subscribeTheme } from '../lib/theme.ts';
import { Pending } from '../ui/ErrorView.tsx';
import type { ChartTokens } from './lap-chart-option.ts';

type EChart = ReturnType<typeof import('../lib/echarts.ts')['init']>;

/**
 * An ECharts chart on a canvas, drawn from `option(tokens)`; pass a memoised builder, as each new one redraws.
 * The library is a lazy chunk, loaded on first render (D3), and the only importer of lib/echarts.ts. A redraw replaces
 * the whole option, so the legend's toggles are kept here and set on the next option's object `legend` (#112).
 */
export function Chart({ label, option }: { label: string; option: (t: ChartTokens) => object }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<EChart | null>(null);
  const selected = useRef<Record<string, boolean>>({});
  const [state, setState] = useState<'loading' | 'failed' | ChartTokens>('loading');

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let gone = false;
    let observer: ResizeObserver | undefined;
    let unsubscribe: (() => void) | undefined;
    // Any failure, the import or the set-up after it, shows the failure line instead of "Loading…".
    import('../lib/echarts.ts')
      .then(({ init }) => {
        if (gone) return;
        const c = init(el, undefined, { renderer: 'canvas' });
        chart.current = c;
        c.on('legendselectchanged', (e) => {
          selected.current = (e as { selected: Record<string, boolean> }).selected;
        });
        observer = new ResizeObserver(() => c.resize());
        observer.observe(el);
        // The tokens are read again whenever the header's moon switches the theme (data-theme on <html>).
        const read = () => {
          const css = getComputedStyle(el);
          const token = (name: string) => css.getPropertyValue(`--${name}`).trim();
          setState({
            fg: token('fg'),
            muted: token('muted'),
            line: token('line'),
            bg: token('bg'),
            amber: token('amber'),
            live: token('live'),
            rain: token('rain'),
            light: currentTheme() === 'light',
          });
        };
        read();
        unsubscribe = subscribeTheme(read);
      })
      .catch(() => {
        if (!gone) setState('failed');
      });
    return () => {
      gone = true;
      observer?.disconnect();
      unsubscribe?.();
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (typeof state !== 'object') return;
    const o: { legend?: unknown } = option(state);
    const drawn =
      typeof o.legend === 'object' && o.legend !== null
        ? { ...o, legend: { ...o.legend, selected: selected.current } }
        : o;
    chart.current?.setOption(drawn as Parameters<EChart['setOption']>[0], { notMerge: true });
  }, [state, option]);

  return (
    <>
      {state === 'loading' && <Pending error={null} />}
      {state === 'failed' && <p role="alert">Chart failed to load: reload the page.</p>}
      <div ref={box} className="chart" role="img" aria-label={label} hidden={state === 'failed'} />
    </>
  );
}
