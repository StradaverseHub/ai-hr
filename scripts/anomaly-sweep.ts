/**
 * ADR-0076 slice 7 — the provisional dry-run. Evaluate every OPEN payroll run, every night.
 *
 * WHY A NIGHTLY SWEEP AND NOT AN ON-DEMAND BUTTON. ADR-0074's operating model is a continuously-running
 * loop, not a month-end scramble: the point of the control tower is that by the time a human looks at a
 * run, the exceptions are already found, already explained, and already sitting in a queue. A button that
 * an operator has to remember to press reproduces the month-end crunch it is meant to replace. This is
 * the "daily provisional dry-run" in §5 item 3 of ADR-0074.
 *
 *   node --env-file=.env.production --import tsx scripts/anomaly-sweep.ts
 *   node --env-file=.env.production --import tsx scripts/anomaly-sweep.ts --dry-run
 *
 * IT IS SAFE TO RUN AT ANY HOUR, ON ANY SCHEDULE, ANY NUMBER OF TIMES. The evaluator is read-only with
 * respect to money and idempotent by construction: a re-run supersedes the previous verdicts rather than
 * duplicating them. Nothing here can change a payslip, a batch total, or a statutory figure. The worst a
 * bug in this script can do is write a wrong opinion into a table nothing else reads.
 *
 * PROCESSED RUNS ONLY. A draft has no payslips to read, and a closed run is finished — re-opining on it
 * would churn verdicts nobody can act on. That leaves exactly the window where the queue is useful.
 *
 * ENV CONTRACT: MIGRATION_DATABASE_URL, like the other out-of-band runners. This is a cross-tenant sweep
 * and the app role must never gain the cross-tenant read it performs. It shares `loadSweepScope` with the
 * other sweeps so the "which tenants are in good standing" decision lives in one predicate — a suspended
 * tenant's writes would be refused by `withTenant` anyway, and skipping it is also the right answer:
 * there is no point queueing exceptions for a customer who is locked out.
 */
import { and, eq } from 'drizzle-orm';
import { createDb, type SessionContext } from '../db/client';
import { resolveEntitlementsTx } from '../core/entitlements';
import { payrollBatch } from '../db/schema';
import { describeSkips, loadSweepScope } from '../core/sweep-scope';
import { evaluateBatchAnomalies } from '../core/payroll-anomaly';
import { recordJobRun } from '../core/job-run';

function loadEnv() {
  try {
    process.loadEnvFile('.env.production');
  } catch {
    try {
      process.loadEnvFile('.env.local');
    } catch {
      // env supplied directly
    }
  }
}

export type SweepResult = {
  tenants: number;
  batches: number;
  autoClear: number;
  review: number;
  block: number;
  failures: number;
  skipped: number;
};

export async function anomalySweep(url: string, opts: { dryRun?: boolean } = {}): Promise<SweepResult> {
  const owner = createDb(url);
  const scope = await loadSweepScope(owner.db);
  console.log(
    `anomaly:sweep — ${scope.run.length} tenant(s) in scope` +
      (scope.skipped.length > 0 ? `, ${scope.skipped.length} skipped` : '') +
      (opts.dryRun ? ' [DRY RUN — nothing will be written]' : ''),
  );
  for (const line of describeSkips(scope)) console.log(line);

  const out: SweepResult = {
    tenants: 0,
    batches: 0,
    autoClear: 0,
    review: 0,
    block: 0,
    failures: 0,
    skipped: scope.skipped.length,
  };

  for (const t of scope.run) {
    // Cross-tenant read as the OWNER role, so the tenant predicate is explicit rather than left to RLS.
    // PROCESSED only: a draft has no payslips to read, and a closed run is finished.
    const todo = await owner.db
      .select({ id: payrollBatch.id, payPeriod: payrollBatch.payPeriod })
      .from(payrollBatch)
      .where(and(eq(payrollBatch.tenantId, t.id), eq(payrollBatch.status, 'processed')));
    if (todo.length === 0) continue;
    out.tenants += 1;

    // SYSTEM CONTEXT — no userId, so the domain events this writes record their actor as `system`, and
    // the group-wide hr_admin role is what lets RLS show the sweep this tenant's batches and payslips.
    // A bare { tenantId } does NOT work: RLS correctly hides every batch from a principal with no
    // grants, and the sweep reports "batch not found" for a batch that plainly exists. Measured, not
    // guessed — the first version of this script did exactly that.
    //
    // A REAL entitlement snapshot rather than an exempt marker, matching review-sweep.ts: the anomaly
    // layer is not module-gated today, but resolving once per tenant is cheap and keeps this loop honest
    // if it ever becomes gated.
    const entitlements = await owner.db.transaction((tx) => resolveEntitlementsTx(tx, t.id));
    const ctx: SessionContext = { tenantId: t.id, roles: ['hr_admin'], entitlements };

    for (const batch of todo) {
      if (opts.dryRun) {
        console.log(`  would evaluate ${batch.payPeriod} (${batch.id.slice(0, 8)})`);
        out.batches += 1;
        continue;
      }
      try {
        const run = await evaluateBatchAnomalies(ctx, { batchId: batch.id });
        out.batches += 1;
        out.autoClear += run.autoClear;
        out.review += run.review;
        out.block += run.block;
        console.log(
          `  ${t.name} ${batch.payPeriod}: ${run.total} slips — ${run.autoClear} clear, ${run.review} review, ` +
            `${run.block} block, coverage ${(run.coverage * 100).toFixed(1)}%`,
        );
      } catch (e) {
        out.failures += 1;
        // One bad batch must not end the sweep — the other tenants still need their queues filled.
        console.error(`  FAILED ${t.name} ${batch.payPeriod}: ${(e as Error).message}`);
      }
    }
  }

  console.log(
    `anomaly:sweep done — ${out.batches} run(s) across ${out.tenants} tenant(s): ` +
      `${out.autoClear} clear, ${out.review} review, ${out.block} block, ${out.failures} failure(s)`,
  );
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  loadEnv();
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('MIGRATION_DATABASE_URL is not set');
    process.exit(2);
  }
  const startedAt = Date.now();
  const dryRun = process.argv.includes('--dry-run');
  anomalySweep(url, { dryRun })
    .then(async (r) => {
      if (!dryRun) {
        const owner = createDb(url);
        await recordJobRun(owner.db, {
          jobKey: 'anomaly.sweep',
          startedAt,
          tenantsProcessed: r.tenants,
          tenantsFailed: r.failures,
          tenantsSkipped: r.skipped,
        });
      }
      process.exit(r.failures > 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(2);
    });
}
