/** Reviewed consumed-marker repair, report-only by default.
 * Current tenant settings and row timestamps nominate candidates; they do not prove that an old
 * run folded an individual transaction. Apply requires an independently reviewed evidence reference
 * and an exact report fingerprint for each selected row. Never infer historical payment from a
 * setting enabled today. Ambiguous rows remain unmarked for reconciliation.
 * This is an operator repair, never a deployment step. It does not change payslip money or versions.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lockNativePayrollPeriodsTx } from '../core/payroll-period-lock';
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
  /** Hash of exact transaction, payslip and batch values; not proof of payment by itself. */
  fingerprint: string;
  companyId: string;
};

export type ReviewedConsumedRow = { id: string; fingerprint: string; evidenceRef: string };
export type ConsumedBackfillReport = {
  apply: boolean;
  /** Tenants whose fold is ON — the only ones any row was considered for. */
  eligibleTenantIds: string[];
  /** Tenants SKIPPED because the fold is off, with the count of rows that were therefore left alone. */
  skippedTenants: { tenantId: string; unmarkedRows: number }[];
  /** Candidate inventory. Only independently reviewed exact witnesses may be marked. */
  candidates: ConsumedBackfillRow[];
  /** Rows written. 0 in report-only mode. */
  marked: number;
  /** True when there was nothing to do — every eligible row already carries a marker. */
  alreadyCorrect: boolean;
  /** Rows still disagreeing after the write. Non-empty ⇒ read the output before believing the run. */
  remainingAfter: number;
  /** Eligible rows without an approved exact witness, or whose witness became stale. */
  unreviewed: number;
  /** Operator references for rows actually changed, suitable for retaining with the repair receipt. */
  appliedReviews: ReviewedConsumedRow[];
};

/**
 * Candidate predicate only. Current eligibility is distinct from the reviewed historical witness.
 */
const ELIGIBLE = (tenantIds: string[]) => sql`
  t.batch_id IS NOT NULL
  AND t.consumed_batch_id IS NULL
  AND b.status IN ('processed', 'closed')
  AND ps.id IS NOT NULL
  AND coalesce(t.updated_at, t.created_at) <= ps.created_at
  AND EXISTS (SELECT 1 FROM tenant_setting ts WHERE ts.tenant_id=t.tenant_id AND ts.key=${PAY_SETTING_KEY} AND ts.value='true'::jsonb)
  AND t.tenant_id IN (${sql.join(
    tenantIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})
`;

export async function runConsumedBackfill(
  url: string,
  opts: { apply: boolean; reviewedRows?: readonly ReviewedConsumedRow[] } = { apply: false },
): Promise<ConsumedBackfillReport> {
  const reviewed = opts.reviewedRows ?? [];
  if (!Array.isArray(reviewed) || reviewed.length > 5000 ||
      reviewed.some(r => !r || typeof r !== 'object' || !/^[0-9a-f-]{36}$/i.test(r.id) || !/^[0-9a-f]{64}$/.test(r.fingerprint) ||
        typeof r.evidenceRef !== 'string' || !r.evidenceRef.trim() || r.evidenceRef.length > 1000) ||
      new Set(reviewed.map(r => r.id)).size !== reviewed.length) {
    throw new Error('Provide unique reviewed row IDs, report fingerprints and independent evidence references.');
  }
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
      unreviewed: 0,
      appliedReviews: [],
    };
  }

  const listSql = sql`
    SELECT t.id, t.tenant_id, t.batch_id, t.employment_id, b.company_id,
           (to_jsonb(t)::text || to_jsonb(ps)::text || to_jsonb(b)::text) AS witness,
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
    code: string | null; amount: string; txn_date: string; payslip_calculated_at: string; company_id: string; witness: string;
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
    companyId: r.company_id,
    fingerprint: createHash('sha256').update(r.witness).digest('hex'),
  }));

  let marked = 0;
  const appliedReviews: ReviewedConsumedRow[] = [];
  let remainingAfter = candidates.length;

  const approved = new Map(reviewed.map(row => [row.id, row]));
  if (opts.apply && candidates.length > 0) {
    // Native payroll writers share Access -> company/month ownership. Re-read exact row content
    // after that wait, then lock the candidate sources. A changed witness is left for a fresh review.
    await owner.db.transaction(async tx => {
      for (const tenantId of [...new Set(candidates.map(row => row.tenantId))].sort()) {
        await lockNativePayrollPeriodsTx(tx, { tenantId }, candidates.filter(row => row.tenantId === tenantId && row.payPeriod)
          .map(row => ({ companyId: row.companyId, payPeriod: row.payPeriod! })));
      }
      const current = await tx.execute<{ id: string; witness: string }>(sql`${listSql} FOR UPDATE OF t, b`);
      for (const row of current) {
        if (!candidates.some(candidate => candidate.id === row.id)) continue;
        const review = approved.get(row.id);
        if (!review || review.fingerprint !== createHash('sha256').update(row.witness).digest('hex')) continue;
        const written = await tx.execute<{ id: string }>(sql`
          UPDATE payroll_individual_txn t SET consumed_batch_id=t.batch_id, consumed_at=ps.created_at
          FROM payslip ps WHERE t.id=${row.id}::uuid AND t.consumed_batch_id IS NULL
            AND ps.batch_id=t.batch_id AND ps.employment_id=t.employment_id RETURNING t.id
        `);
        marked += written.length;
        if (written.length) appliedReviews.push({...review});
      }
    });
    remainingAfter = (await owner.db.execute<{ id: string }>(listSql)).length;
  }

  return {
    apply: opts.apply,
    eligibleTenantIds,
    skippedTenants,
    candidates,
    marked,
    alreadyCorrect: candidates.length === 0,
    remainingAfter,
    unreviewed: remainingAfter,
    appliedReviews,
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
  const manifestArg = process.argv.find(arg => arg.startsWith('--reviewed-rows='));
  const reviewedRows = manifestArg ? JSON.parse(readFileSync(manifestArg.slice('--reviewed-rows='.length), 'utf8')) as ReviewedConsumedRow[] : undefined;
  runConsumedBackfill(url, { apply: process.argv.includes('--apply'), reviewedRows })
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
      console.log(`\n${r.candidates.length} candidate row(s); ${r.marked} marked with exact reviewed evidence:`);
      for (const c of r.candidates) {
        console.log(
          `  ${c.payPeriod ?? '?'} ${c.runType ?? '?'} ${c.employeeCode ?? c.employmentId} ` +
            `${c.code ?? '(no pay item)'} RM${c.amount} on ${c.txnDate} ` +
            `(payslip calculated ${c.payslipCalculatedAt}; fingerprint ${c.fingerprint}; id ${c.id})`,
        );
      }
      if (r.apply) {
        for (const review of r.appliedReviews) console.log(`  REVIEW ${review.id}: ${review.evidenceRef}`);
        console.log(`\nWrote ${r.marked} row(s). Still disagreeing afterwards: ${r.remainingAfter}.`);
        if (r.remainingAfter !== 0) {
          console.error('✗ Some rows still have no marker after the write — read the list above.');
          process.exit(1);
        }
      } else {
        console.log('\nNothing was written. Independently reconcile candidates, then provide --apply --reviewed-rows=/path/to/reviewed.json. Each JSON row requires id, fingerprint and evidenceRef.');
      }
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
