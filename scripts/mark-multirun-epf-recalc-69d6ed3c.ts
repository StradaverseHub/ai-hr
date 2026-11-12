/**
 * 69d6ed3c — MARK OPEN MULTI-RUN MONTHS WHOSE LATER RUN COUNTED AN EARLIER RUN'S NON-EPF PAY AS EPF WAGES.
 *
 * NOT PART OF THE DEPLOY, AND NOT RUN BY THE BUILD. Before item 69d6ed3c a later payroll run in a month counted
 * the GROSS additional pay of the month's earlier runs as EPF wages, even where that pay item was not ticked for
 * EPF. The approved plan promised those runs would show "Reprocess Required". This one-off script sets the
 * EXISTING recalculation mark (`payroll_batch.needs_recalc_at` / `recalc_employment_ids`, the same pair
 * `markBatchNeedsRecalc` writes and the Payroll Process list shows as Reprocess Required). Run it and read its
 * report separately from the deployment:
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a \
 *     && node --import tsx scripts/mark-multirun-epf-recalc-69d6ed3c.ts          # report only
 *   …same, with --apply, to write.
 *
 * WHICH RUNS (one set-wise statement to find them, one to mark them — no per-company or per-row loop):
 *   - a run that is still PROCESSED or PROCESSING (never a draft, never a closed run, so a closed month is never
 *     touched), holding a payslip for the employment that was written BEFORE the trace (no `statutoryTrace`);
 *   - with an EARLIER run of the same company and month (lower run_seq) whose payslip for that employment also
 *     predates the trace and records, on its own `componentLines`, additional (bonus-bucket) pay on a pay item
 *     whose EPF box was NOT ticked. That is exactly the money the old code wrongly counted.
 *
 * It never changes an amount, a payslip or a status, recalculates nothing, and is idempotent: an employment
 * already in the set is not added twice, and a later run once reprocessed carries a trace and is not selected
 * again. Reprocessing the later run alone corrects it — the kernel reads a pre-trace earlier slip's own pay item
 * lines (core/statutory-trace.ts `readEarlierRunLiability`), so the order of reprocessing does not matter.
 */
import { sql } from 'drizzle-orm';
import { createDb } from '../db/client';

export type MultiRunRecalcTarget = { tenantId: string; companyId: string; batchId: string; payPeriod: string; runSeq: number; employmentIds: string[] };
export type MultiRunRecalcReport = { apply: boolean; targets: MultiRunRecalcTarget[]; marked: number };

/** An earlier slip, before the trace, paying additional pay on a line whose EPF box was not ticked. */
const NON_EPF_ADDITIONAL = sql`jsonb_path_exists(q.statutory, '$.componentLines[*] ? (@.epf == false).buckets[*] ? (@.bucket == "bonus" && @.amount > 0)')`;

export async function runMultiRunEpfRecalcMark(url: string, opts: { apply: boolean } = { apply: false }): Promise<MultiRunRecalcReport> {
  const owner = createDb(url);
  try {
    const rows = await owner.db.execute<{ tenant_id: string; company_id: string; batch_id: string; pay_period: string; run_seq: number; employment_ids: string[] }>(sql`
      SELECT b.tenant_id, b.company_id, b.id AS batch_id, b.pay_period, b.run_seq,
             jsonb_agg(DISTINCT p.employment_id ORDER BY p.employment_id) AS employment_ids
        FROM payroll_batch b
        JOIN payslip p ON p.batch_id = b.id
       WHERE b.status IN ('processed', 'processing')
         AND NOT (p.statutory ? 'statutoryTrace')
         AND EXISTS (
           SELECT 1 FROM payroll_batch eb
             JOIN payslip q ON q.batch_id = eb.id AND q.employment_id = p.employment_id
            WHERE eb.tenant_id = b.tenant_id AND eb.company_id = b.company_id AND eb.pay_period = b.pay_period
              AND eb.run_seq < b.run_seq
              AND NOT (q.statutory ? 'statutoryTrace')
              AND ${NON_EPF_ADDITIONAL})
       GROUP BY b.tenant_id, b.company_id, b.id, b.pay_period, b.run_seq
       ORDER BY b.tenant_id, b.company_id, b.pay_period, b.run_seq`);
    const targets: MultiRunRecalcTarget[] = rows.map((r) => ({
      tenantId: r.tenant_id, companyId: r.company_id, batchId: r.batch_id, payPeriod: r.pay_period, runSeq: Number(r.run_seq), employmentIds: r.employment_ids,
    }));
    let marked = 0;
    if (opts.apply && targets.length) {
      const payload = JSON.stringify(targets.map((t) => ({ batch_id: t.batchId, ids: t.employmentIds })));
      await owner.db.transaction(async (tx) => {
        // Merge into the existing set (never drop an employment someone else marked), keep the first mark's
        // instant, and record the same `payroll-batch.recalc-required` event the in-app writer records,
        // category 'statutory', references only.
        const updated = await tx.execute<{ id: string; tenant_id: string; next: string[]; added: string[] }>(sql`
          WITH m AS (SELECT * FROM jsonb_to_recordset(${payload}::jsonb) AS m(batch_id uuid, ids jsonb)),
          cur AS (
            SELECT b.id, b.tenant_id, m.ids AS wanted, coalesce(b.recalc_employment_ids, '[]'::jsonb) AS have
              FROM payroll_batch b JOIN m ON m.batch_id = b.id
             WHERE b.status IN ('processed', 'processing')
             FOR UPDATE OF b),
          calc AS (
            SELECT c.id, c.tenant_id,
                   (SELECT jsonb_agg(DISTINCT x ORDER BY x) FROM jsonb_array_elements_text(c.have || c.wanted) x) AS next,
                   (SELECT coalesce(jsonb_agg(x ORDER BY x), '[]'::jsonb) FROM jsonb_array_elements_text(c.wanted) x WHERE NOT c.have ? x) AS added
              FROM cur c)
          UPDATE payroll_batch b SET needs_recalc_at = coalesce(b.needs_recalc_at, now()), recalc_employment_ids = calc.next
            FROM calc
           WHERE b.id = calc.id AND jsonb_array_length(calc.added) > 0
          RETURNING b.id, b.tenant_id, calc.next, calc.added`);
        marked = updated.length;
        if (updated.length) {
          await tx.execute(sql`
            INSERT INTO domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
            SELECT u.tenant_id, 'payroll-batch', u.id, 'payroll-batch.recalc-required', 'system', NULL,
                   jsonb_build_object('employmentIds', u.next, 'addedEmploymentIds', u.added, 'changeCategory', 'statutory',
                                      'reason', 'multi_run_epf_69d6ed3c')
              FROM jsonb_to_recordset(${JSON.stringify(updated.map((u) => ({ id: u.id, tenant_id: u.tenant_id, next: u.next, added: u.added })))}::jsonb)
                AS u(id uuid, tenant_id uuid, next jsonb, added jsonb)`);
        }
      });
    }
    return { apply: opts.apply, targets, marked };
  } finally {
    await owner.client.end();
  }
}

if (process.argv[1]?.endsWith('mark-multirun-epf-recalc-69d6ed3c.ts')) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('mark-multirun-epf-recalc-69d6ed3c requires MIGRATION_DATABASE_URL (owner role).');
    process.exit(1);
  }
  runMultiRunEpfRecalcMark(url, { apply: process.argv.includes('--apply') })
    .then((r) => {
      console.log(r.apply ? 'Marked Reprocess Required:' : 'Would mark Reprocess Required (report only):');
      for (const t of r.targets) console.log(`  company ${t.companyId} ${t.payPeriod} run #${t.runSeq} (${t.batchId}): ${t.employmentIds.length} employee(s)`);
      console.log(r.apply ? `Wrote ${r.marked} run(s).` : 'Nothing was written. Re-run with --apply to write.');
      process.exit(0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
