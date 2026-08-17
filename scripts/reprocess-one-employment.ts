/**
 * Reprocess ONE employment inside an already-processed payroll batch, in place.
 *
 *   node --import tsx scripts/reprocess-one-employment.ts --batch=<uuid> --employment=<uuid>
 *   …same with --apply to write.
 *
 * ⚠️ ON THE SERVER, `node --env-file=` DOES NOT WORK (node v18.19.1; the flag arrived in node 20).
 * Source the env instead — see AGENTS.md rule 21:
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && node --import tsx scripts/…
 *
 * WHY A SCRIPT AND NOT THE SCREEN. /payroll/[batchId]/reprocess exists and is the normal path, but the
 * app listens on 127.0.0.1:3000 with no nginx route (HANDOFF: "AI-HR IS NOT PUBLICLY EXPOSED"), so there
 * is no browser session to drive it from an operator's machine. This calls the SAME service the screen
 * calls — `reprocessSelectedEmployees` — and adds nothing: permission, batch-status, closed-period and
 * cross-company checks all still happen inside it. It is not a second engine.
 *
 * WHAT IT DOES, in the service's own words: a TRUE in-place recompute of exactly the selected employees
 * via generatePayslips' reprocessSubset path — their payslips are recomputed and version-bumped (OCC),
 * EVERYONE ELSE'S STAY PHYSICALLY UNTOUCHED, and batch totals/GL are updated BY DELTA. That is the whole
 * reason to use it rather than regenerating the run: batch 3b62dc57 holds 23 payslips and only one of
 * them is meant to move.
 *
 * REPORT-ONLY BY DEFAULT. Without --apply it prints the before-state and exits, writing nothing.
 */
import { createDb, type SessionContext } from '../db/client';
import { resolveEntitlementsTx } from '../core/entitlements';
import { reprocessSelectedEmployees } from '../core/payroll';
import { payslip, payrollBatch, employment, company, person } from '../db/schema';
import { and, eq } from 'drizzle-orm';

function loadEnv() {
  try {
    process.loadEnvFile('.env.production');
  } catch {
    try {
      process.loadEnvFile('.env.local');
    } catch {
      /* env supplied directly */
    }
  }
}

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

async function main() {
  loadEnv();
  const apply = process.argv.includes('--apply');
  const batchId = arg('batch');
  const employmentId = arg('employment');
  if (!batchId || !employmentId) {
    console.error('usage: --batch=<uuid> --employment=<uuid> [--apply]');
    process.exit(2);
  }

  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('MIGRATION_DATABASE_URL is not set — source .env.production first (AGENTS rule 21).');
    process.exit(2);
  }
  const owner = createDb(url);
  const db = owner.db;

  const [batch] = await db
    .select({ id: payrollBatch.id, tenantId: payrollBatch.tenantId, status: payrollBatch.status, period: payrollBatch.payPeriod, count: payrollBatch.employeeCount })
    .from(payrollBatch)
    .where(eq(payrollBatch.id, batchId))
    .limit(1);
  if (!batch) {
    console.error(`batch ${batchId} not found`);
    process.exit(1);
  }

  const before = await db
    .select({
      id: payslip.id, gross: payslip.grossPay, net: payslip.netPay, version: payslip.version,
      employer: company.legalName, code: employment.employeeCode, name: person.fullName,
    })
    .from(payslip)
    .innerJoin(employment, eq(employment.id, payslip.employmentId))
    .leftJoin(company, eq(company.id, employment.companyId))
    .leftJoin(person, eq(person.id, employment.personId))
    .where(and(eq(payslip.batchId, batchId), eq(payslip.employmentId, employmentId)));

  console.log(`\nreprocess-one-employment — mode=${apply ? 'APPLY' : 'REPORT ONLY'}`);
  console.log(`  batch ${batchId.slice(0, 8)}  period ${batch.period}  status ${batch.status}  employees ${batch.count}`);
  console.log(`  BEFORE — ${before.length} payslip(s) for this employment:`);
  for (const b of before) {
    console.log(`    ${b.code ?? '?'}  ${b.name ?? '?'}  ${b.employer ?? '?'}  gross ${b.gross}  net ${b.net}  v${b.version}`);
  }
  if (!apply) {
    console.log(`\n  Nothing written. Every OTHER payslip in this batch is untouched either way — the service\n  recomputes only the ids it is given and adjusts batch totals by delta. Re-run with --apply.`);
    await owner.client.end();
    process.exit(0);
  }

  // A REAL entitlement snapshot and the group-wide hr_admin role, exactly as anomaly-sweep.ts does.
  // A bare { tenantId } does NOT work: RLS correctly hides every batch from a principal with no
  // grants, and the service then reports 'batch not found' for a batch that plainly exists.
  const entitlements = await db.transaction((tx) => resolveEntitlementsTx(tx, batch.tenantId));
  const ctx: SessionContext = { tenantId: batch.tenantId, roles: ['hr_admin'], entitlements };

  const r = await reprocessSelectedEmployees(ctx, {
    batchId,
    employmentIds: [employmentId],
    reason: 'Entity transfer mid-month — recompute under the effective-dated company history (3c88d593 stage one).',
  });
  console.log(`\n  reprocessSelectedEmployees returned: ${JSON.stringify(r)}`);

  const after = await db
    .select({
      id: payslip.id, gross: payslip.grossPay, net: payslip.netPay, version: payslip.version,
      employer: company.legalName, code: employment.employeeCode,
    })
    .from(payslip)
    .innerJoin(employment, eq(employment.id, payslip.employmentId))
    .leftJoin(company, eq(company.id, employment.companyId))
    .where(and(eq(payslip.batchId, batchId), eq(payslip.employmentId, employmentId)));

  console.log(`  AFTER — ${after.length} payslip(s):`);
  for (const a of after) {
    console.log(`    ${a.code ?? '?'}  ${a.employer ?? '?'}  gross ${a.gross}  net ${a.net}  v${a.version}`);
  }
  await owner.client.end();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
