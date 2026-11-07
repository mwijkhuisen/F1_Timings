import { defineConfig } from 'vitest/config';

// Anchored to the workspace, so nested checkouts (.claude/worktrees/*) are never picked up.
const testFiles = ['test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'];
const integrationFiles = testFiles.map((glob) => glob.replace(/\.test\.ts$/, '.int.test.ts'));
// Component tests (react-dom/server in the node environment, no DOM) are unit tests only.
const componentFiles = ['apps/*/test/**/*.test.tsx'];

export default defineConfig({
  test: {
    // Every project inherits this: no test ever reaches the network (msw
    // fails on any unhandled request or WebSocket).
    setupFiles: ['test/msw.setup.ts'],
    passWithNoTests: false,
    // Node 26 enables Web Storage by default and warns in every worker; tests never use it.
    execArgv: ['--no-experimental-webstorage'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [...testFiles, ...componentFiles],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        extends: true,
        // One file at a time on the shared PostgreSQL 18 server; every file creates its own database.
        test: {
          name: 'integration',
          include: integrationFiles,
          exclude: ['**/node_modules/**'],
          fileParallelism: false,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
