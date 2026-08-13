/**
 * 0db616f3 — THE ONE-OFF TIDY-UP for January 2026's double-imported bonus file.
 *
 * ⚠️ `node --env-file=` DOES NOT WORK ON THE SERVER. The box runs node v18.19.1 and --env-file arrived
 * in node 20 — it exits 9 with "bad option: --env-file". Twenty-three scripts in this directory document
 * that invocation and none of them can be run as written on production. SOURCE THE ENV INSTEAD, which
 * also keeps the credentials on the box:
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a \
 *     && node --import tsx scripts/repair-january-bonus-double-import.ts
 *   …same, with --apply, to write.
 *
 * (The --env-file form is still correct for LOCAL runs against .env.local, where node is current.)
 *
 * REPORT-ONLY BY DEFAULT, like scripts/repair-fixed-transaction-overlaps.ts and
 * scripts/correct-hrdf-opt-outs.ts. Without --apply it prints every row it would delete and every row it
 * would move, and writes nothing.
 *
 * ⚠️ THIS IS NOT PART OF THE DEPLOY. `deploy.sh` runs MIGRATIONS, not scripts. It is run BY HAND after
 * the release that carries migration 0437, and the release is not finished until it has been run and its
 * output read. Take a fresh backup first — and note the pg_dump trap on this database: ai_provider_config,
 * leave_adjustment_batch and platform_user are FORCE-RLS and the dump exits 1 without
 * `--exclude-table-data` for those three (all hold 0 rows, so the dump stays complete).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT HAPPENED, MEASURED READ-ONLY ON PRODUCTION 2026-08-13
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Batch 368c67fc — 2026-01, run_type regular, run_seq 1, processed, 19 payslips written 14:53:38.
 * Batch fc9e5309 — 2026-01, run_type bonus,   run_seq 2, processed, 19 payslips written 15:35:54, ALL
 *                  at gross 0.00 / net 0.00.
 *
 * A bonus file was uploaded at 15:27 and again at 15:30. Both landed on the REGULAR batch, because the
 * importer pinned `runType === 'regular'` and the file had no way to say otherwise. The bonus run folds
 * its own batch id, found nothing, and produced nineteen zero payslips — which is exactly why the
 * operator concluded the first upload had failed and uploaded it again.
 *
 *   payroll_individual_txn on 368c67fc: 41 rows — 17 hand-keyed (RM7,997.75, keyed 10 Aug, NOT TOUCHED
 *   BY THIS SCRIPT) and 24 with source='import' (RM106,073.31).
 *   Grouped by (employment_id, component_id, amount): 11 groups of two. Distinct: 13 rows, RM62,524.51.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY "DELETE THE SECOND IMPORT" IS WRONG, AND WHAT IS DONE INSTEAD
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE TWO WAVES ARE NOT THE SAME FILE. The set difference each way returns exactly one row:
 *   only in wave 1 (15:27): employment 14adac83 (A0001) BONUS 1,650.71
 *   only in wave 2 (15:30): employment 99e97e85 (A0014) BONUS 17,325.00
 * So deleting "the later import" would silently drop RM17,325.00 owed to a real person, and deleting the
 * earlier one would drop RM1,650.71 owed to another. The keep-set is the DISTINCT
 * (employment_id, component_id, amount) union — 13 rows — not either wave.
 *
 * Within each duplicated group the EARLIEST row is kept, on the same principle: the first arrival is the
 * one the operator meant, and the second is the accident.
 *
 * The 13 survivors are then re-pointed to the BONUS run, which is where they were always meant to go and
 * where the money actually gets paid.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * THE FOUR THINGS IT REFUSES TO DO
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * 1. It refuses if the keep-set is not exactly 13 rows totalling RM62,524.51 — before AND after. Those
 *    are the plan's own figures and the reporter's; a script that quietly repaired a different set of
 *    rows than the one that was approved is worse than one that stops.
 * 2. It refuses if any row it is about to move has already been PAID (`consumed_batch_id` not null,
 *    migration 0437). Moving a paid line is how money gets paid twice, which is the whole point of the
 *    marker; if this ever fires, the data has changed since the plan was approved and a human must look.
 * 3. It refuses if the source and target batches are not the same tenant, company and pay period, or if
 *    the target is not the month's bonus run.
 * 4. It never touches the 17 hand-keyed rows, and it never touches a payslip. Re-issuing the bonus run
 *    is a separate, deliberate act by an operator.
 *
 * SAFE TO RE-RUN. A second run finds no duplicate groups and nothing left on the regular batch, verifies
 * the same 13 rows / RM62,524.51 are on the bonus batch, and reports "already correct".
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { createDb } from '../db/client';
import { appendEvent } from '../db/events';
import { employment, payComponent, payrollBatch, payrollIndividualTxn, person } from '../db/schema';

/** The two runs, measured on production 2026-08-13. Overridable so the script can be rehearsed against a
 *  restored copy without editing it — but the defaults are the audited ones. */
const SOURCE_BATCH_ID = '368c67fc-d82d-4eaf-abce-9d2d399dff6c';
const TARGET_BATCH_ID = 'fc9e5309-51e8-4842-8354-5cbc671bc703';

/** The approved shape of the answer. Both are asserted before and after the write. */
export const EXPECTED_KEEP_ROWS = 13;
export const EXPECTED_KEEP_TOTAL = '62524.51';

type TxnRow = {
  id: string;
  tenantId: string;
  batchId: string | null;
  employmentId: string;
  componentId: string | null;
  amount: string;
  payPeriod: string | null;
  companyId: string | null;
  source: string | null;
  createdAt: Date;
  consumedBatchId: string | null;
  code: string | null;
  employeeCode: string | null;
  fullName: string | null;
};

export type JanuaryRepairReport = {
  apply: boolean;
  /** True when there was nothing left to do — the repair has already been applied. */
  alreadyCorrect: boolean;
  /** Rows to delete: the later member of each duplicated group. */
  surplus: TxnRow[];
  /** Rows to move to the bonus run (or already on it). */
  keep: TxnRow[];
  keepTotal: string;
  /** Every reason the script is refusing to write. Non-empty ⇒ nothing was written. */
  refusals: string[];
};

const money = (rows: { amount: string }[]): string =>
  rows.reduce((t, r) => t + Math.round(Number(r.amount) * 100), 0) === 0
    ? '0.00'
    : (rows.reduce((t, r) => t + Math.round(Number(r.amount) * 100), 0) / 100).toFixed(2);

const groupKey = (r: TxnRow) => `${r.employmentId}|${r.componentId ?? ''}|${Number(r.amount).toFixed(2)}`;

const label = (r: TxnRow) =>
  `${(r.employeeCode ?? r.fullName ?? '?').padEnd(10)} ${(r.code ?? '-').padEnd(10)} ` +
  `${Number(r.amount).toFixed(2).padStart(11)}  keyed ${r.createdAt.toISOString()}  id=${r.id}`;

export async function runJanuaryRepair(
  url: string,
  opts: { apply: boolean; sourceBatchId?: string; targetBatchId?: string },
): Promise<JanuaryRepairReport> {
  const owner = createDb(url);
  const sourceBatchId = opts.sourceBatchId ?? SOURCE_BATCH_ID;
  const targetBatchId = opts.targetBatchId ?? TARGET_BATCH_ID;
  const refusals: string[] = [];

  // ── The two runs. Owner connection: RLS is bypassed on purpose, and every batch id is checked rather
  //    than assumed, because a wrong batch id here moves real money to the wrong run. ──
  const batches = await owner.db
    .select({
      id: payrollBatch.id,
      tenantId: payrollBatch.tenantId,
      companyId: payrollBatch.companyId,
      payPeriod: payrollBatch.payPeriod,
      runType: payrollBatch.runType,
      status: payrollBatch.status,
    })
    .from(payrollBatch)
    .where(inArray(payrollBatch.id, [sourceBatchId, targetBatchId]));
  const source = batches.find((b) => b.id === sourceBatchId);
  const target = batches.find((b) => b.id === targetBatchId);
  if (!source) refusals.push(`source batch ${sourceBatchId} does not exist`);
  if (!target) refusals.push(`target batch ${targetBatchId} does not exist`);
  if (source && target) {
    if (source.tenantId !== target.tenantId) refusals.push('the two runs are not on the same tenant');
    if (source.companyId !== target.companyId) refusals.push('the two runs are not for the same company');
    if (source.payPeriod !== target.payPeriod) refusals.push('the two runs are not for the same pay period');
    if (target.runType !== 'bonus') refusals.push(`target run is '${target.runType}', not the month's bonus run`);
    if (source.runType !== 'regular') refusals.push(`source run is '${source.runType}', not the month's regular run`);
  }

  // ── The imported rows on EITHER run. Reading both is what makes a re-run idempotent rather than
  //    merely harmless: after the repair the rows are on the target, and the same keep-set assertions
  //    must still hold. The 17 hand-keyed rows are excluded by `source = 'import'` and never read. ──
  const rows: TxnRow[] = await owner.db
    .select({
      id: payrollIndividualTxn.id,
      tenantId: payrollIndividualTxn.tenantId,
      batchId: payrollIndividualTxn.batchId,
      employmentId: payrollIndividualTxn.employmentId,
      componentId: payrollIndividualTxn.componentId,
      amount: payrollIndividualTxn.amount,
      payPeriod: payrollIndividualTxn.payPeriod,
      companyId: payrollIndividualTxn.companyId,
      source: payrollIndividualTxn.source,
      createdAt: payrollIndividualTxn.createdAt,
      consumedBatchId: payrollIndividualTxn.consumedBatchId,
      code: payComponent.code,
      employeeCode: employment.employeeCode,
      fullName: person.fullName,
    })
    .from(payrollIndividualTxn)
    .leftJoin(payComponent, eq(payComponent.id, payrollIndividualTxn.componentId))
    .leftJoin(employment, eq(employment.id, payrollIndividualTxn.employmentId))
    .leftJoin(person, eq(person.id, employment.personId))
    .where(
      and(
        inArray(payrollIndividualTxn.batchId, [sourceBatchId, targetBatchId]),
        eq(payrollIndividualTxn.source, 'import'),
      ),
    )
    // EARLIEST FIRST, then id — the keeper of each group is the first arrival, and the tie-break makes a
    // re-run pick the same row as the run that reported.
    .orderBy(asc(payrollIndividualTxn.createdAt), asc(payrollIndividualTxn.id));

  // ── The plan: one keeper per (person, pay item, amount); everything else is surplus. ──
  const keep: TxnRow[] = [];
  const surplus: TxnRow[] = [];
  const seen = new Map<string, TxnRow>();
  for (const r of rows) {
    const k = groupKey(r);
    const first = seen.get(k);
    if (first) surplus.push(r);
    else {
      seen.set(k, r);
      keep.push(r);
    }
  }
  const keepTotal = money(keep);

  // ── THE ASSERTIONS. Exactly the figures the approved plan carries. ──
  if (keep.length !== EXPECTED_KEEP_ROWS) {
    refusals.push(`keep-set is ${keep.length} rows, expected ${EXPECTED_KEEP_ROWS}`);
  }
  if (keepTotal !== EXPECTED_KEEP_TOTAL) {
    refusals.push(`keep-set totals RM${keepTotal}, expected RM${EXPECTED_KEEP_TOTAL}`);
  }
  // A row that has already been PAID must not be moved — that is how money gets paid twice, and it is
  // the exact thing migration 0437 exists to prevent.
  for (const r of [...keep, ...surplus]) {
    if (r.consumedBatchId != null) {
      refusals.push(`row ${r.id} (${r.employeeCode ?? r.fullName}) has already been paid by run ${r.consumedBatchId}`);
    }
  }

  const alreadyCorrect = surplus.length === 0 && keep.every((r) => r.batchId === targetBatchId);

  if (opts.apply && refusals.length === 0 && !alreadyCorrect) {
    // ONE ROW AT A TIME, BY ID, EACH IN ITS OWN TRANSACTION WITH ITS OWN EVENT. Never a predicate
    // UPDATE/DELETE: the whole point is that afterwards it can be said exactly which rows moved and why.
    for (const r of surplus) {
      await owner.db.transaction(async (tx) => {
        const done = await tx
          .delete(payrollIndividualTxn)
          .where(eq(payrollIndividualTxn.id, r.id))
          .returning({ id: payrollIndividualTxn.id });
        if (done.length !== 1) throw new Error(`row ${r.id} was not in the state the scan saw it in — aborting`);
        await appendEvent(tx, {
          tenantId: r.tenantId,
          aggregateType: 'payroll-individual-txn',
          aggregateId: r.id,
          eventType: 'payroll.individual-txn.deleted',
          actor: { type: 'system' },
          subjectEmploymentId: r.employmentId,
          // ADR-0030 Layer 0: references and a reason, never the amount.
          payload: {
            batchId: r.batchId,
            payPeriod: r.payPeriod,
            employmentId: r.employmentId,
            componentId: r.componentId,
            reason: '0db616f3-duplicate-import',
          },
        });
      });
    }
    for (const r of keep) {
      if (r.batchId === targetBatchId) continue; // already moved by an earlier run
      await owner.db.transaction(async (tx) => {
        const done = await tx
          .update(payrollIndividualTxn)
          .set({ batchId: targetBatchId, updatedAt: sql`now()` })
          .where(and(eq(payrollIndividualTxn.id, r.id), eq(payrollIndividualTxn.batchId, sourceBatchId)))
          .returning({ id: payrollIndividualTxn.id });
        if (done.length !== 1) throw new Error(`row ${r.id} was not in the state the scan saw it in — aborting`);
        await appendEvent(tx, {
          tenantId: r.tenantId,
          aggregateType: 'payroll-individual-txn',
          aggregateId: r.id,
          eventType: 'payroll.individual-txn.attached',
          actor: { type: 'system' },
          subjectEmploymentId: r.employmentId,
          payload: {
            batchId: targetBatchId,
            fromBatchId: sourceBatchId,
            payPeriod: r.payPeriod,
            employmentId: r.employmentId,
            componentId: r.componentId,
            reason: '0db616f3-bonus-run-misrouted',
          },
        });
      });
    }
  }

  // ── VERIFY AFTER, from the database rather than from the plan. ──
  if (opts.apply && refusals.length === 0) {
    const after = await owner.db
      .select({ id: payrollIndividualTxn.id, amount: payrollIndividualTxn.amount, batchId: payrollIndividualTxn.batchId })
      .from(payrollIndividualTxn)
      .where(and(eq(payrollIndividualTxn.batchId, targetBatchId), eq(payrollIndividualTxn.source, 'import')));
    if (after.length !== EXPECTED_KEEP_ROWS) {
      refusals.push(`AFTER: bonus run holds ${after.length} imported rows, expected ${EXPECTED_KEEP_ROWS}`);
    }
    if (money(after) !== EXPECTED_KEEP_TOTAL) {
      refusals.push(`AFTER: bonus run holds RM${money(after)}, expected RM${EXPECTED_KEEP_TOTAL}`);
    }
    const left = await owner.db
      .select({ id: payrollIndividualTxn.id })
      .from(payrollIndividualTxn)
      .where(and(eq(payrollIndividualTxn.batchId, sourceBatchId), eq(payrollIndividualTxn.source, 'import')));
    if (left.length !== 0) refusals.push(`AFTER: ${left.length} imported rows still on the regular run`);
  }

  return { apply: opts.apply, alreadyCorrect, surplus, keep, keepTotal, refusals };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────
// The same guard scripts/repair-fixed-transaction-overlaps.ts uses, and for the same reason:
// `runJanuaryRepair` is importable by a rehearsal test without the CLI firing process.exit inside vitest.
if (process.argv[1]?.endsWith('repair-january-bonus-double-import.ts')) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('repair-january-bonus-double-import requires MIGRATION_DATABASE_URL (owner role).');
    process.exit(1);
  }
  const argOf = (flag: string): string | null => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? (process.argv[i + 1] ?? null) : null;
  };
  runJanuaryRepair(url, {
    apply: process.argv.includes('--apply'),
    sourceBatchId: argOf('--source') ?? undefined,
    targetBatchId: argOf('--target') ?? undefined,
  })
    .then(async (r) => {
      await createDb(url).client.end();
      return r;
    })
    .then((r) => {
      console.log(`\n0db616f3 January bonus double-import repair — mode=${r.apply ? 'APPLY' : 'REPORT ONLY'}`);
      if (r.alreadyCorrect) {
        console.log('Nothing to do: the repair has already been applied.');
      }
      console.log(`\nKEEP — ${r.keep.length} row(s), RM${r.keepTotal}, on the BONUS run:`);
      for (const k of r.keep) console.log(`  keep   ${label(k)}${k.batchId === TARGET_BATCH_ID ? '  (already moved)' : ''}`);
      console.log(`\nDELETE — ${r.surplus.length} duplicate row(s):`);
      for (const s of r.surplus) console.log(`  delete ${label(s)}`);

      if (r.refusals.length > 0) {
        console.error(`\n✗ REFUSED — nothing was written:`);
        for (const m of r.refusals) console.error(`    ${m}`);
        process.exit(1);
      }
      console.log(
        `\n${r.apply ? 'Applied' : 'Would apply'}: delete ${r.surplus.length}, move ${r.keep.length} to the bonus run. ` +
          `No payslip is touched — re-issuing the bonus run is a separate, deliberate act.` +
          (r.apply ? '' : ' Re-run with --apply to write.'),
      );
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
