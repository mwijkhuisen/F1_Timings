import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

// Global for every test file: any HTTP request or WebSocket without a handler
// fails the test. Tests run offline; fixtures replace OpenF1 and F1 (A§12.1 invariant 4).
export const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
