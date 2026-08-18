/**
 * 417d4937 — MAKE THE LEDGER AGREE WITH THE PAYSLIP THAT ALREADY PRINTS THE LINE.
 *
 * ⚠️ THIS IS NOT PART OF THE DEPLOY. `deploy.sh` runs MIGRATIONS, not scripts (AGENTS rule 13). The
 * round is not finished when `deploy.sh` returns — it is finished when this has been RUN and the row
 * count it reports has been read.
 *
 * ⚠️ `node --env-file=` DOES NOT WORK ON THE SERVER (AGENTS rule 21). The box runs node v18.19.1 and
 * that flag arrived in node 20; it exits 9 with "bad option: --env-file". SOURCE the env instead, which
 * also keeps the credentials on the box:
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a \
 *     && node --import tsx scripts/backfill-consumed-batch-417d4937.ts
 *   …same, with --apply, to write.
 *
 * (The --env-file form is still correct for LOCAL runs against .env.local, where node is current.)
 *
 * REPORT-ONLY BY DEFAULT, like scripts/repair-january-bonus-double-import.ts and
 * scripts/repair-fixed-transaction-overlaps.ts. Without --apply it counts and lists what it would mark
 * and writes nothing at all.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS WRONG, AND WHY IT IS NOT THE DEFECT THE REPORTER OPENED
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `payroll_individual_txn.consumed_batch_id` (migration 0437) is the marker that stops a LATER payroll
 * run paying the same one-off a second time. `markIndividualTxnsConsumed` stamps it inside the same
 * transaction as the payslip inserts — but only from the moment 0437 shipped. Every row that reached a
 * payslip BEFORE that reads NULL forever, and db/schema.ts records that as at 2026-08-13 every
 * production row was in exactly that state.
 *
 * Measured read-only on production 2026-08-18: the SpaceX 2026-08 Director Fee row has `batch_id` set
 * and `consumed_batch_id` NULL while the payslip for that run prints the line. The ledger and the
 * payslip disagree about the same money.
 *
 * IT IS INVISIBLE ON SCREEN, which is why it is a SECOND defect beside the reporter's rather than the
 * one they are looking at: `core/individual-txn-status.ts` derives the Individual tab's status from the
 * batch status and the payslip timestamps and never reads this column. What it protects is the FUTURE:
 * an unmarked row is one a subsequent run may legitimately fold and pay again.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * THE FIVE CONDITIONS A ROW MUST MEET, AND WHY EACH ONE IS THERE
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * 1. `batch_id IS NOT NULL` — an unattached row has never been near a run.
 * 2. `consumed_batch_id IS NULL` — never overwrite an existing marker. This is also what makes the
 *    script IDEMPOTENT: a second run finds nothing left and says so.
 * 3. the batch is `processed` or `closed` — a draft has no payslips, and marking against one would be
 *    a claim about money nobody has calculated.
 * 4. a payslip exists for (batch, employment) — the row must actually have been ON a payslip. An
 *    employee excluded from the run has no payslip and therefore no claim to mark.
 * 5. `coalesce(txn.updated_at, txn.created_at) <= payslip.created_at` — THE STALENESS RULE, taken
 *    verbatim from `individualTxnReprocessRequired` (core/individual-txn-status.ts) rather than
 *    re-invented, so this script and that screen can never disagree about what "is in the payslip"
 *    means. A row keyed or edited AFTER the run was calculated is not in that payslip and must never
 *    be marked — doing so would strand real money that is still waiting to be paid. The `coalesce` is
 *    load-bearing: `updated_at` is NULL on a row that has never been edited.
 *
 * `consumed_at` IS SET TO THE PAYSLIP'S `created_at`, NOT TO NOW. The column means "when was this money
 * paid", and the honest answer is the instant the run that paid it was calculated. `now()` would date a
 * January payment to whenever somebody happened to run a repair script.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * THE TENANT GATE — AND WHY IT IS NOT OPTIONAL
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Gated on `payroll.individual_txn_pay_enabled`, the SAME flag both `markIndividualTxnsConsumed` call
 * sites are gated on (core/payroll.ts). With the fold off the ledger is RECORD-ONLY: no row ever
 * reached a payslip as money, so marking one would be a lie that PERMANENTLY STRANDS it the day the
 * tenant turns the flag on. Resolved from `tenant_setting`, with the catalogue default (false) for a
 * tenant that has no row — the same fallback `getSetting` applies. Every skipped tenant is REPORTED,
 * so a gate that looks wrong is visible rather than silent.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT NEVER DOES
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * It never touches a payslip, a batch, an amount or a status. It never clears a marker (that is
 * `releaseIndividualTxnsConsumed`'s job, and only a run whose payslips were destroyed may do it). It
 * never marks a row on a tenant whose fold is off. It writes one column pair on rows that already
 * satisfy all five conditions, and nothing else.
 */
import { sql } from 'drizzle-orm';

import { createDb } from '../db/client';

/** The setting that gates the fold, and its catalogue default (packs/catalog.ts SETTING_CATALOG). */
const PAY_SETTING_KEY = 'payroll.individual_txn_pay_enabled';
const PAY_SETTING_DEFAULT = false;

export type ConsumedBackfillRow = {
  id: string;
  tenantId: string;
  batchId: string;
  employmentId: string;
  employeeCode: string | null;
  employeeName: string | null;
  payPeriod: string | null;
  runType: string | null;
  batchStatus: string;
  code: string | null;
  amount: string;
  txnDate: string;
  payslipCalculatedAt: string;
};

export type ConsumedBackfillReport = {
  apply: boolean;
  /** Tenants whose fold is ON — the only ones any row was considered for. */
  eligibleTenantIds: string[];
  /** Tenants SKIPPED because the fold is off, with the count of rows that were therefore left alone. */
  skippedTenants: { tenantId: string; unmarkedRows: number }[];
  /** Rows that meet all five conditions. In report-only mode this is what WOULD be marked. */
  candidates: ConsumedBackfillRow[];
  /** Rows written. 0 in report-only mode. */
  marked: number;
  /** True when there was nothing to do — every eligible row already carries a marker. */
  alreadyCorrect: boolean;
  /** Rows still disagreeing after the write. Non-empty ⇒ read the output before believing the run. */
  remainingAfter: number;
};

/**
 * The five conditions, as ONE predicate expressed once and reused by the count, the listing and the
 * update. Written out rather than assembled from parts so the three can never drift — the whole class of
 * bug this script exists to repair is two places disagreeing about the same row.
 */
const ELIGIBLE = (tenantIds: string[]) => sql`
  t.batch_id IS NOT NULL
  AND t.consumed_batch_id IS NULL
  AND b.status IN ('processed', 'closed')
  AND ps.id IS NOT NULL
  AND coalesce(t.updated_at, t.created_at) <= ps.created_at
  AND t.tenant_id IN (${sql.join(
    tenantIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})
`;

export async function runConsumedBackfill(
  url: string,
  opts: { apply: boolean } = { apply: false },
): Promise<ConsumedBackfillReport> {
  const owner = createDb(url);

  // ── Which tenants may be touched at all ──────────────────────────────────────────────────────────
  // `tenant_setting` holds the tenant's own answer; a tenant with no row takes the catalogue default,
  // which is exactly what `getSetting` does. Anything that is not literally `true` is OFF.
  const tenantRows = await owner.db.execute<{ tenant_id: string; enabled: boolean }>(sql`
    SELECT tn.id AS tenant_id,
           coalesce((ts.value #>> '{}') = 'true', ${PAY_SETTING_DEFAULT}) AS enabled
      FROM tenant tn
      LEFT JOIN tenant_setting ts ON ts.tenant_id = tn.id AND ts.key = ${PAY_SETTING_KEY}
  `);
  // postgres-js drizzle returns an ARRAY from `execute`, not a { rows } envelope (core/platform-usage.ts).
  const eligibleTenantIds = tenantRows.filter((r) => r.enabled === true).map((r) => r.tenant_id);
  const offTenantIds = tenantRows.filter((r) => r.enabled !== true).map((r) => r.tenant_id);

  // What the gate is holding back, per skipped tenant — reported so an unexpected gate is VISIBLE.
  const skippedTenants: { tenantId: string; unmarkedRows: number }[] = [];
  for (const tenantId of offTenantIds) {
    const c = await owner.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n
        FROM payroll_individual_txn t
        JOIN payroll_batch b ON b.id = t.batch_id
        LEFT JOIN payslip ps ON ps.batch_id = b.id AND ps.employment_id = t.employment_id
       WHERE t.consumed_batch_id IS NULL
         AND b.status IN ('processed', 'closed')
         AND ps.id IS NOT NULL
         AND t.tenant_id = ${tenantId}::uuid
    `);
    skippedTenants.push({ tenantId, unmarkedRows: Number(c[0]?.n ?? 0) });
  }

  if (eligibleTenantIds.length === 0) {
    return {
      apply: opts.apply,
      eligibleTenantIds: [],
      skippedTenants,
      candidates: [],
      marked: 0,
      alreadyCorrect: true,
      remainingAfter: 0,
    };
  }

  const listSql = sql`
    SELECT t.id, t.tenant_id, t.batch_id, t.employment_id,
           e.employee_code, p.full_name,
           b.pay_period, b.run_type, b.status AS batch_status,
           pc.code, t.amount::text AS amount, t.txn_date::text AS txn_date,
           to_char(ps.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS payslip_calculated_at
      FROM payroll_individual_txn t
      JOIN payroll_batch b ON b.id = t.batch_id
      LEFT JOIN payslip ps ON ps.batch_id = b.id AND ps.employment_id = t.employment_id
      LEFT JOIN pay_component pc ON pc.id = t.component_id
      LEFT JOIN employment e ON e.id = t.employment_id
      LEFT JOIN person p ON p.id = e.person_id
     WHERE ${ELIGIBLE(eligibleTenantIds)}
     ORDER BY b.pay_period, e.employee_code, t.txn_date
  `;

  const before = await owner.db.execute<{
    id: string; tenant_id: string; batch_id: string; employment_id: string;
    employee_code: string | null; full_name: string | null;
    pay_period: string | null; run_type: string | null; batch_status: string;
    code: string | null; amount: string; txn_date: string; payslip_calculated_at: string;
  }>(listSql);

  const candidates: ConsumedBackfillRow[] = before.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    batchId: r.batch_id,
    employmentId: r.employment_id,
    employeeCode: r.employee_code,
    employeeName: r.full_name,
    payPeriod: r.pay_period,
    runType: r.run_type,
    batchStatus: r.batch_status,
    code: r.code,
    amount: r.amount,
    txnDate: r.txn_date,
    payslipCalculatedAt: r.payslip_calculated_at,
  }));

  let marked = 0;
  let remainingAfter = candidates.length;

  if (opts.apply && candidates.length > 0) {
    // ONE statement, the same predicate. `consumed_at` takes the payslip's own instant — the moment the
    // run that paid this line was calculated — never `now()`.
    const written = await owner.db.execute<{ id: string }>(sql`
      UPDATE payroll_individual_txn t
         SET consumed_batch_id = t.batch_id,
             consumed_at = ps.created_at
        FROM payroll_batch b
        JOIN payslip ps ON ps.batch_id = b.id
       WHERE b.id = t.batch_id
         AND ps.employment_id = t.employment_id
         AND ${ELIGIBLE(eligibleTenantIds)}
      RETURNING t.id
    `);
    marked = written.length;
    const after = await owner.db.execute<{ id: string }>(listSql);
    remainingAfter = after.length;
  }

  return {
    apply: opts.apply,
    eligibleTenantIds,
    skippedTenants,
    candidates,
    marked,
    alreadyCorrect: candidates.length === 0,
    remainingAfter,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────
// Guarded exactly as scripts/repair-january-bonus-double-import.ts is, and for the same reason:
// `runConsumedBackfill` stays importable by a rehearsal test without process.exit firing inside vitest.
if (process.argv[1]?.endsWith('backfill-consumed-batch-417d4937.ts')) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('backfill-consumed-batch-417d4937 requires MIGRATION_DATABASE_URL (owner role).');
    process.exit(1);
  }
  runConsumedBackfill(url, { apply: process.argv.includes('--apply') })
    // The pooled client is shared per connection string, so it is closed HERE — by the CLI that owns
    // the process — and never inside the function, which a rehearsal test calls on a live harness pool.
    .then(async (r) => {
      await createDb(url).client.end();
      return r;
    })
    .then((r) => {
      console.log(`\n417d4937 consumed-marker backfill — mode=${r.apply ? 'APPLY' : 'REPORT ONLY'}`);
      console.log(`Tenants with the one-off fold ON: ${r.eligibleTenantIds.length}`);
      for (const s of r.skippedTenants) {
        console.log(
          `  SKIPPED tenant ${s.tenantId}: fold is OFF, ${s.unmarkedRows} unmarked row(s) left alone ` +
            `(marking them would strand the money the day the flag is turned on).`,
        );
      }
      if (r.alreadyCorrect) {
        console.log('\nNothing to do: every eligible row already carries a consumed marker.');
        process.exit(0);
      }
      console.log(`\n${r.apply ? 'MARKED' : 'WOULD MARK'} ${r.candidates.length} row(s):`);
      for (const c of r.candidates) {
        console.log(
          `  ${c.payPeriod ?? '?'} ${c.runType ?? '?'} ${c.employeeCode ?? c.employmentId} ` +
            `${c.code ?? '(no pay item)'} RM${c.amount} on ${c.txnDate} ` +
            `(payslip calculated ${c.payslipCalculatedAt})`,
        );
      }
      if (r.apply) {
        console.log(`\nWrote ${r.marked} row(s). Still disagreeing afterwards: ${r.remainingAfter}.`);
        if (r.remainingAfter !== 0) {
          console.error('✗ Some rows still have no marker after the write — read the list above.');
          process.exit(1);
        }
      } else {
        console.log('\nNothing was written. Re-run with --apply to write.');
      }
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
