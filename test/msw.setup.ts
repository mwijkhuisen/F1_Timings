import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { offline } from './offline.ts';

// Global for every test file: any HTTP request or WebSocket without a handler
// fails the test. Tests run offline; fixtures replace OpenF1 and F1 (A§12.1 invariant 4),
// and test/offline.ts fails any test that tries to reach past loopback.
export const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  offline.check();
});
afterAll(() => {
  server.close();
  offline.check();
});
