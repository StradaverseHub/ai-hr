import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/env.ts'],
    // One shared Postgres → run serially in a single worker.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['test/**/*.test.ts'],
  },
});
