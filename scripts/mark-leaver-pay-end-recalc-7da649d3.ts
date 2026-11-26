/**
 * 7da649d3 — MARK OPEN PROCESSED RUNS THAT PAID A LEAVER ONLY TO THE LAST WORKING DAY.
 *
 * NOT PART OF THE DEPLOY, AND NOT RUN BY THE BUILD. Owner decision 2026-11-25: payroll pays up to the employment
 * end date, least(terminated_on, resignation_date), and the Last Working Day counts only when both are empty
 * (core/payroll-employment-eligibility.ts `payrollEmploymentEnd`). Before this release payroll stopped at the
 * earliest of all three dates, so an employee whose Last Working Day is EARLIER than their end date (annual leave
 * cleared after the last physical day) was prorated short. This one-off script sets the EXISTING recalculation mark
 * through `markBatchNeedsRecalc` (the Payroll Process list's "Reprocess Required") so HR reviews and reprocesses.
 * It recalculates nothing. Run it, and record its count in the release evidence, separately from the deployment:
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a \
 *     && AIHR_DB_PROCESS_ROLE=worker node --conditions=react-server --import tsx scripts/mark-leaver-pay-end-recalc-7da649d3.ts   # read-only count (default)
 *   …same, with --apply, to mark. (react-server: the payroll service graph imports `server-only`.)
 *
 * WHICH ROWS (one set-wise read finds them; no per-company or per-employee query loop):
 *   - an employment whose last_working_date is earlier than least(terminated_on, resignation_date): the only shape
 *     whose payroll end moved (the new end is never earlier than the old one);
 *   - holding a payslip in a REGULAR run that is still PROCESSED or PROCESSING (never a draft, never a closed run,
 *     never an imported history run), so closed payroll, payslips and statutory records are never touched;
 *   - for a pay month the change reaches: it starts on or before the new end and ends after the last working day;
 *   - whose payslip is still the old calculation: its recorded proration stamp (statutory.reportContext.proration)
 *     is missing (calculated before the stamp existed) or ends exactly on the last working day;
 *   - and that is not already in the run's recalculation set.
 * The last two conditions make it idempotent: a second run before reprocessing finds the employee already marked,
 * and after reprocessing the payslip's proration ends on the new end date, so nothing is selected again.
 *
 * Leavers whose new end reaches an open processed regular run of their company in which they have NO payslip are
 * LISTED (never marked), because a run that did not pay them is not stale; HR decides whether to add them.
 */
import { sql } from 'drizzle-orm';
import { createDb, type Db, type SessionContext } from '../db/client';
import { markBatchNeedsRecalc } from '../packs/payroll/service';

export type LeaverPayEndTarget = {
  tenantId: string; companyId: string; batchId: string; payPeriod: string; runSeq: number; batchStatus: string; employmentIds: string[];
};
export type LeaverPayEndAbsent = { tenantId: string; companyId: string; batchId: string; payPeriod: string; employmentId: string; lastWorkingDate: string; payrollEnd: string };
export type LeaverPayEndReport = {
  apply: boolean;
  /** Runs and the employments in each that would be (or were) marked. */
  targets: LeaverPayEndTarget[];
  /** Distinct (run, employment) pairs selected. This is the count for the release evidence. */
  count: number;
  /** Runs whose recalculation set was extended. 0 in count mode. */
  marked: number;
  /** Listed only: open processed regular runs of the employee's company that hold no payslip for them. */
  absent: LeaverPayEndAbsent[];
};

/** Payroll's new last day, written over raw columns exactly as payrollEmploymentEnd is. */
const NEW_END = sql`least(e.terminated_on, e.resignation_date)`;
/** The pay month's first and last day from payroll_batch.pay_period ('YYYY-MM'). */
const PERIOD_START = sql`to_date(b.pay_period || '-01', 'YYYY-MM-DD')`;
const PERIOD_END = sql`(to_date(b.pay_period || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date`;
const SHAPE = sql`e.last_working_date IS NOT NULL AND ${NEW_END} IS NOT NULL AND e.last_working_date < ${NEW_END}`;
const OPEN_REGULAR = sql`b.status IN ('processed', 'processing') AND b.run_type = 'regular' AND b.history_import_attempt_id IS NULL`;
const REACHED = sql`${PERIOD_START} <= ${NEW_END} AND ${PERIOD_END} > e.last_working_date`;

/** `db` is an OWNER-role connection; the caller owns its lifetime (the CLI below opens and closes one). */
export async function runLeaverPayEndRecalcMark(db: Db, opts: { apply: boolean } = { apply: false }): Promise<LeaverPayEndReport> {
  const rows = await db.execute<{ tenant_id: string; company_id: string; batch_id: string; pay_period: string; run_seq: number; status: string; employment_ids: string[] }>(sql`
    SELECT b.tenant_id, b.company_id, b.id AS batch_id, b.pay_period, b.run_seq, b.status,
           jsonb_agg(DISTINCT p.employment_id ORDER BY p.employment_id) AS employment_ids
      FROM payroll_batch b
      JOIN payslip p ON p.batch_id = b.id
      JOIN employment e ON e.id = p.employment_id AND e.tenant_id = b.tenant_id
     WHERE ${OPEN_REGULAR}
       AND ${SHAPE}
       AND ${REACHED}
       AND ((p.statutory #> '{reportContext,proration}') IS NULL
            OR (p.statutory #>> '{reportContext,proration,to}')::date = e.last_working_date)
       AND NOT (coalesce(b.recalc_employment_ids, '[]'::jsonb) ? p.employment_id::text)
     GROUP BY b.tenant_id, b.company_id, b.id, b.pay_period, b.run_seq, b.status
     ORDER BY b.tenant_id, b.company_id, b.pay_period, b.run_seq, b.id`);
  const targets: LeaverPayEndTarget[] = rows.map((r) => ({
    tenantId: r.tenant_id, companyId: r.company_id, batchId: r.batch_id, payPeriod: r.pay_period, runSeq: Number(r.run_seq),
    batchStatus: r.status, employmentIds: r.employment_ids,
  }));
  const absentRows = await db.execute<{ tenant_id: string; company_id: string; batch_id: string; pay_period: string; employment_id: string; last_working_date: string; payroll_end: string }>(sql`
    SELECT b.tenant_id, b.company_id, b.id AS batch_id, b.pay_period, e.id AS employment_id,
           e.last_working_date::text AS last_working_date, (${NEW_END})::text AS payroll_end
      FROM payroll_batch b
      JOIN employment e ON e.tenant_id = b.tenant_id AND e.company_id = b.company_id
     WHERE ${OPEN_REGULAR}
       AND ${SHAPE}
       AND ${REACHED}
       AND NOT EXISTS (SELECT 1 FROM payslip p WHERE p.batch_id = b.id AND p.employment_id = e.id)
     ORDER BY b.tenant_id, b.company_id, b.pay_period, e.id`);
  const absent: LeaverPayEndAbsent[] = absentRows.map((r) => ({
    tenantId: r.tenant_id, companyId: r.company_id, batchId: r.batch_id, payPeriod: r.pay_period, employmentId: r.employment_id,
    lastWorkingDate: r.last_working_date, payrollEnd: r.payroll_end,
  }));
  const count = targets.reduce((sum, t) => sum + t.employmentIds.length, 0);
  let marked = 0;
  if (opts.apply && targets.length) {
    // One transaction. markBatchNeedsRecalc locks each run row, merges into its existing set (never dropping an
    // employment someone else marked), keeps the first mark's instant, skips a run that is no longer processed,
    // and records the same `payroll-batch.recalc-required` event as the in-app writers, as a system actor.
    await db.transaction(async (tx) => {
      for (const target of targets) {
        const ctx: SessionContext = { tenantId: target.tenantId };
        await markBatchNeedsRecalc(tx, ctx, { batchId: target.batchId, employmentIds: target.employmentIds, category: 'termination' });
        marked++;
      }
    });
  }
  return { apply: opts.apply, targets, count, marked, absent };
}

if (process.argv[1]?.endsWith('mark-leaver-pay-end-recalc-7da649d3.ts')) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('mark-leaver-pay-end-recalc-7da649d3 requires MIGRATION_DATABASE_URL (owner role).');
    process.exit(1);
  }
  const owner = createDb(url);
  runLeaverPayEndRecalcMark(owner.db, { apply: process.argv.includes('--apply') })
    .then(async (r) => {
      console.log(`7da649d3 leaver pay-end recalculation mark — mode=${r.apply ? 'APPLY' : 'COUNT ONLY'}`);
      console.log(`${r.apply ? 'Marked' : 'Would mark'} ${r.count} employee(s) in ${r.targets.length} open processed run(s):`);
      for (const t of r.targets) console.log(`  tenant ${t.tenantId} company ${t.companyId} ${t.payPeriod} run #${t.runSeq} (${t.batchId}, ${t.batchStatus}): ${t.employmentIds.join(', ')}`);
      console.log(`Listed only — leavers not on an open processed run their new end reaches: ${r.absent.length}`);
      for (const a of r.absent) console.log(`  tenant ${a.tenantId} company ${a.companyId} ${a.payPeriod} (${a.batchId}): ${a.employmentId} last working ${a.lastWorkingDate}, pays to ${a.payrollEnd}`);
      console.log(r.apply ? `Updated ${r.marked} run(s).` : 'Nothing was written. Re-run with --apply to mark.');
      await owner.client.end();
      process.exit(0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
