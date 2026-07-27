// Vitest setup — point the app singleton at the TEST database before anything imports it.
import process from 'node:process';
import { workerDb } from './db-names';

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
  // From the SAME helper global-setup stamps the databases with, rather than the third hardcoded
  // spelling of the name that used to live here. Called after `loadEnvFile` above, so TEST_DB_NAMESPACE
  // set in .env.local is honoured — see test/db-names.ts on why these are functions and not constants.
  const dbName = workerDb(poolId);
  const swap = (url: string) => {
    const u = new URL(url);
    u.pathname = `/${dbName}`;
    return u.toString();
  };
  process.env.TEST_DATABASE_URL = swap(process.env.TEST_DATABASE_URL);
  process.env.TEST_MIGRATION_DATABASE_URL = swap(process.env.TEST_MIGRATION_DATABASE_URL);
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.MIGRATION_DATABASE_URL = process.env.TEST_MIGRATION_DATABASE_URL;

// Feature gates are DEPLOYMENT config — they may be ON in .env.local for the dev app (this file calls
// `process.loadEnvFile('.env.local')` above, and .env.example itself ships PAYROLL_RESET_ENABLED and
// PAYROLL_UNLOCK_ENABLED uncommented). Tests are hermetic: default them OFF here so the legacy path is
// exercised; the multi-cycle / typed-component / group-PCB / reset tests opt in explicitly per-test.
//
// ALL NINE TRACKED GATES, NOT FIVE, as of ADR-0077 slice 3. This list used to stop after five, which
// was survivable while the gates were read straight from env by the feature under test — a stray
// NOTIFICATIONS_ENABLED in someone's .env.local switched one feature on and the tests that cared set
// it themselves. Slice 3 made it structural: `test/harness.ts` seedBase now derives BOTH the tenant's
// `tenant_module` / `tenant_setting` rows AND `adminCtx`'s snapshot from
// `legacyEnabledModulesIn(process.env)` / `legacyEnabledSettingsIn(process.env)`. Any tracked gate
// left in the environment therefore changes the ENTITLEMENT BASELINE of all ~247 harness files at
// once — differently on a developer's machine than in CI, which is the same "passes for a reason
// nobody stated" shape as the defects this slice already fixed. Deleting the whole set makes that
// baseline deterministically EMPTY, and `test/module-catalog-drift.test.ts` asserts it rather than
// describing it, so this list cannot silently fall behind the gate map again.
delete process.env.MULTI_CYCLE_PAYROLL_ENABLED;
delete process.env.TYPED_PAY_COMPONENTS_ENABLED;
delete process.env.GROUP_PCB_COORDINATION_ENABLED;
delete process.env.AUDIT_HASH_CHAIN_ENABLED; // ADR-0030 Layer 2 gate; the hash-chain test opts in per-run
delete process.env.PAYROLL_RESET_ENABLED; // a03b2d9b Payroll Reset gate; payroll-reset.test.ts opts in per-test
delete process.env.NOTIFICATIONS_ENABLED; // ADR-0034; .env.local commonly sets it, CI does not
delete process.env.TOIL_ENABLED; // ADR-0033
delete process.env.PAYROLL_UNLOCK_ENABLED; // 9bc442bc — .env.example ships this one uncommented
delete process.env.INDIVIDUAL_TXN_PAY_ENABLED; // f1564110 Phase 3
delete process.env.FEEDBACK_AI_PLANNING_ENABLED; // ADR-0043 FB-3 operator tooling
