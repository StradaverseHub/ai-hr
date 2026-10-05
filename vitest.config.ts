import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// One database is stamped per worker in test/global-setup.ts, which reads the same number from
// VITEST_MAX_WORKERS — keep the two in step. Two cores are left for Postgres itself, which is doing the
// real work during an integration suite.
const WORKERS = Number(process.env.VITEST_MAX_WORKERS ?? 0) || Math.max(2, availableParallelism() - 2);
process.env.VITEST_MAX_WORKERS = String(WORKERS);

/**
 * TWO PROJECTS, because they need opposite things from their environment.
 *
 * `node` is the integration suite that has always been here — 516 files against real Postgres, one
 * database per worker. It is reproduced below EXACTLY as it was before the split: same setupFiles, same
 * include, same worker count, same timeouts. If a future edit makes the node project and this comment
 * disagree, the node project is wrong — that suite is the thing guarding everything else.
 *
 * `dom` renders client components in jsdom. It needs no database and no env bootstrap and must not pay
 * for them. The include patterns cannot overlap: `test/**\/*.test.ts` never matches `*.dom.test.tsx`.
 *
 * `globalSetup` BELONGS TO THE NODE PROJECT, and putting it at the root instead is a trap worth naming.
 * It lives in the same options bag as `setupFiles`, so with `extends: true` each project INHERITS it and
 * runs it again — observed directly: a `--project dom` run printed the "10 worker DBs wiped" line TWICE,
 * for a project that touches no database at all. Two concurrent global setups wiping the same worker
 * databases is how this repo has corrupted test runs before. Scoped here, `--project dom` runs it zero
 * times and a full run runs it exactly once.
 *
 * The real-browser project is NOT here — see vitest.browser.config.ts and `pnpm test:browser`. It is
 * deliberately outside the default gate: a browser test that flakes must not be able to turn a
 * 6013-test suite red on the day it is introduced.
 */
export default defineConfig({
  // Mirror the tsconfig "@/*" → "./*" path alias so tests can import app/ modules that use it
  // (e.g. app/analytics/labels.ts imports '@/core/analytics').
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      // d75b0c11 — `server-only` is a Next BUILD-TIME poison pill, not a dependency: it is not in
      // node_modules (Next resolves it internally), so importing any app module that declares it — the
      // payroll run screen reaches lib/statutory-readiness.ts, which does — fails a vitest run outright
      // with "Cannot find package 'server-only'". Mapped to an empty module, which is precisely the real
      // package's SERVER entry. Inert for every pre-existing test: the specifier did not resolve at all
      // before, so nothing in the suite was importing it successfully.
      'server-only': fileURLToPath(new URL('./test/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          // AuthKit uses Next's extensionless subpaths. Transform it through Vite so real SDK
          // middleware/PKCE tests resolve them and the request-context mocks reach the SDK too.
          server: { deps: { inline: ['@workos-inc/authkit-nextjs'] } },
          setupFiles: ['./test/env.ts'],
          // Each worker gets its OWN database, stamped from a migrated template (test/global-setup.ts), so
          // files no longer share tables and can run in parallel. Previously this was pinned to a single
          // serial worker because every file hit one shared Postgres.
          globalSetup: ['./test/global-setup.ts'],
          fileParallelism: true,
          maxWorkers: WORKERS,
          testTimeout: 30_000,
          hookTimeout: 30_000,
          include: ['test/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          setupFiles: ['./test/dom-setup.ts'],
          include: ['test/**/*.dom.test.tsx'],
        },
      },
    ],
  },
});
