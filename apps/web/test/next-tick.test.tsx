// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Next } from '../src/views/Live.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('Next ticks its own countdown every minute when it gets no `now`', () => {
  vi.setSystemTime(Date.parse('2026-10-11T11:48:00.000Z'));
  const session = {
    session_key: 1,
    meeting_name: 'Singapore Grand Prix',
    session_name: 'Race',
    date_start: '2026-10-11T12:00:00.000Z',
    date_end: '2026-10-11T14:00:00.000Z',
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => root.render(<Next live={{ session, recording: null } as never} />));
  expect(host.textContent).toContain('in 12 min');
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(host.textContent).toContain('in 11 min');
  act(() => root.unmount());
});
