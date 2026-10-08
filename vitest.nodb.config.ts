import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * r417 (ADR-0094) — THE NO-DATABASE HALF OF THE FULL GATE. `scripts/gate-chunked.sh` part (a).
 *
 * The SAME two projects as vitest.config.ts — same aliases, same setupFiles, same includes, same
 * timeouts — with exactly two differences, and nothing else may drift in here:
 *
 *   1. NO globalSetup. test/global-setup.ts connects to Postgres to stamp one database per worker, so
 *      keeping it would make every "no-DB" run require a cluster — the thing this config exists to avoid.
 *      Which files may run here is decided by scripts/gate-db-classify.ts, never by hand.
 *   2. maxWorkers = VITEST_MAX_WORKERS_NODB (default 6). These files cost CPU, not WAL, so they can take
 *      more workers than the DB chunks' VITEST_MAX_WORKERS.
 *
 * Derived from the base config rather than copied, so a change to an alias or a setup file there reaches
 * this half too. test/r417-nodb-closed-port.test.ts pins the two differences and runs a no-DB file
 * through this config with every database URL pointing at a closed port.
 */
const NODB_WORKERS = Number(process.env.VITEST_MAX_WORKERS_NODB ?? 0) || 6;

type Project = { test?: Record<string, unknown> } & Record<string, unknown>;
const baseTest = (base.test ?? {}) as { projects?: Project[] } & Record<string, unknown>;

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    projects: (baseTest.projects ?? []).map((p) => ({
      ...p,
      test: { ...p.test, globalSetup: [], maxWorkers: NODB_WORKERS },
    })),
  } as typeof base.test,
});
