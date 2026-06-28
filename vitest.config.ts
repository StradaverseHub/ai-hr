import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirror the tsconfig "@/*" → "./*" path alias so tests can import app/ modules that use it
  // (e.g. app/analytics/labels.ts imports '@/core/analytics').
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
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
