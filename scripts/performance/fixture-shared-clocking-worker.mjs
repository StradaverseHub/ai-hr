import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const env = process.env;
assert(env.GITHUB_ACTIONS === 'true' && env.CI === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted');
assert(env.GITHUB_REPOSITORY === 'StradaverseHub/ai-hr' && env.GITHUB_EVENT_NAME === 'workflow_dispatch');
assert(env.GITHUB_WORKFLOW === 'alpha-focused-checks' && env.GITHUB_JOB === 'selected-tests');
assert.equal(env.AIHR_BROWSER_SHELL_PERMISSION_VARIANT, 'contract-optimized-clocking-shared');
assert.equal(env.AIHR_BROWSER_REPLACEMENT_CATALOGUE, 'present');
assert.equal(env.AIHR_DB_PROCESS_ROLE, 'worker');
assert.equal(env.DATABASE_URL, 'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev?application_name=aihr-fixture-mixed-worker');
assert.equal(env.MIGRATION_DATABASE_URL, 'postgres://postgres@127.0.0.1:5433/ai_hr_dev?application_name=aihr-fixture-mixed-worker');
assert(env.RUNNER_TEMP && env.PERF_PRIVATE_DIR === join(env.RUNNER_TEMP, 'system-performance-private'));

const source = path => pathToFileURL(join(process.cwd(), path)).href;
await import(source('scripts/lib/stub-server-only.ts'));
const { clockingImportJobHandler } = await import(source('core/attendance-clocking-import-job.ts'));
const { accessLockModeHeldTx, lockAccessConfigurationTx } = await import(source('core/access-configuration-lock.ts'));
const { lockLeaveDependencyReadConfigurationTx } = await import(source('core/leave-dependency-lock.ts'));
const { assertModuleGate } = await import(source('core/module-gate.ts'));
const { findReplacementLeaveTypeIdTx } = await import(source('core/toil.ts'));
const { BULK_JOB_HANDLERS } = await import(source('core/bulk-job-handlers.ts'));
assert(BULK_JOB_HANDLERS.includes(clockingImportJobHandler));

let observed = false;
// Replace only the chunk's configuration locks in this disposable fixture.
// Native writers, per-employment locks and all other worker handlers still run.
clockingImportJobHandler.beginChunkTx = async (tx, ctx) => {
  assertModuleGate(ctx, 'attendance');
  await lockAccessConfigurationTx(tx, ctx.tenantId);
  await lockLeaveDependencyReadConfigurationTx(tx, ctx.tenantId);
  assert(await findReplacementLeaveTypeIdTx(tx, ctx.tenantId), 'Expected established Replacement Leave catalogue');
  if (!observed) {
    assert.equal(await accessLockModeHeldTx(tx, ctx.tenantId), 'S');
    writeFileSync(join(env.PERF_PRIVATE_DIR, 'shared-clocking-chunk-observed'), 'shared', { mode: 0o600, flag: 'wx' });
    observed = true;
  }
};

await import(source('scripts/bank-import-runner.ts'));
