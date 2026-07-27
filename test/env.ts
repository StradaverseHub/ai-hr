// Vitest setup — point the app singleton at the TEST database before anything imports it.
import process from 'node:process';
import { workerDbPrefix } from './db-names';

try {
  process.loadEnvFile('.env.local');
} catch {
  // env provided directly (CI)
}

if (!process.env.TEST_DATABASE_URL || !process.env.TEST_MIGRATION_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL / TEST_MIGRATION_DATABASE_URL must be set for tests');
}

// Point this worker at its OWN database (stamped from the template in test/global-setup.ts) so files can
// run in parallel without sharing tables. Rewriting the env here — before any test file imports the
// harness — is what keeps the change invisible to the 247 files that already call into test/harness.ts.
//
// Escape hatch: WORKER_DB=0 keeps the old single shared database, for debugging a suspected isolation bug.
const poolId = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID;
if (poolId && process.env.WORKER_DB !== '0') {
  // Derived from the SAME helper global-setup creates the databases with. This line used to spell the
  // prefix out itself, which meant the creator and the connector each carried their own copy of the
  // name — the shape where a change to one silently points the workers at databases that do not exist.
  // (global-setup also `provide()`s the prefix, but nothing ever consumed it, so it was decoration.)
  // Called here, after loadEnvFile above, so a namespace set in .env.local is visible.
  const workerDb = `${workerDbPrefix()}${poolId}`;
  const swap = (url: string) => {
    const u = new URL(url);
    u.pathname = `/${workerDb}`;
    return u.toString();
  };
  process.env.TEST_DATABASE_URL = swap(process.env.TEST_DATABASE_URL);
  process.env.TEST_MIGRATION_DATABASE_URL = swap(process.env.TEST_MIGRATION_DATABASE_URL);
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.MIGRATION_DATABASE_URL = process.env.TEST_MIGRATION_DATABASE_URL;

// Payroll feature gates are DEPLOYMENT config — they may be ON in .env.local for the dev app. Tests are
// hermetic: default them OFF here so the legacy path is exercised; the multi-cycle / typed-component /
// group-PCB tests opt in explicitly per-test.
delete process.env.MULTI_CYCLE_PAYROLL_ENABLED;
delete process.env.TYPED_PAY_COMPONENTS_ENABLED;
delete process.env.GROUP_PCB_COORDINATION_ENABLED;
delete process.env.AUDIT_HASH_CHAIN_ENABLED; // ADR-0030 Layer 2 gate; the hash-chain test opts in per-run
delete process.env.PAYROLL_RESET_ENABLED; // a03b2d9b Payroll Reset gate; payroll-reset.test.ts opts in per-test
