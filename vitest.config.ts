import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// One database is stamped per worker in test/global-setup.ts, which reads the same number from
// VITEST_MAX_WORKERS — keep the two in step. Two cores are left for Postgres itself, which is doing the
// real work during an integration suite.
const WORKERS = Number(process.env.VITEST_MAX_WORKERS ?? 0) || Math.max(2, availableParallelism() - 2);
process.env.VITEST_MAX_WORKERS = String(WORKERS);

export default defineConfig({
  // Mirror the tsconfig "@/*" → "./*" path alias so tests can import app/ modules that use it
  // (e.g. app/analytics/labels.ts imports '@/core/analytics').
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    setupFiles: ['./test/env.ts'],
    // Each worker gets its OWN database, stamped from a migrated template (test/global-setup.ts), so files
    // no longer share tables and can run in parallel. Previously this was pinned to a single serial worker
    // because every file hit one shared Postgres.
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: true,
    maxWorkers: WORKERS,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['test/**/*.test.ts'],
  },
});
