/**
 * 7b5b1665 — READ-ONLY REPORT of imported Formula Builder lines saved without their Input Type, for HR to correct
 * by hand. It never writes: every pricing call runs inside a READ ONLY database transaction. No backfill exists or
 * is intended (docs/adr/payroll-individual-entry-calculation.md: existing rows acquire intent only through an
 * intentional entry edit).
 *
 * THE DEFECT. Before 7b5b1665 the One Total for the Month import never wrote `calculation_method`. A row typed as
 * Amount 105.40 on a Pay Item linked to a Formula Builder formula (NORMAL OT, ONOR) was stored as amount 105.40 with
 * no method, and payroll fed that stored amount to the formula as `{#Input}` (lib/pay-formula-input.ts), so it paid
 * the formula of 105.40 (MYR 2,468.79 in the reported case) instead of MYR 105.40. The Edit screen shows such a line
 * as Qty 105.40; HR corrects it there by choosing Amount.
 *
 * WHICH ROWS (one set-based read; open months only: not on or paid by a closed run, and an unattached row not in a
 * closed pay period). Imported (`source = 'import'`) one-off earnings/deductions with input method NULL, no pricing
 * marker, unit 'amount' or blank, on a Pay Item whose CURRENT rule is a Formula Builder formula.
 *   - `paysNow`   what the next process or reprocess pays: the saved formula priced with the saved amount as its
 *                 input, by the same deterministic pricing owner entry and reprocess use (priceIndividualTxnInputTx).
 *   - `asAmount`  what the line pays once HR sets it to Amount: the saved amount itself.
 * A row the formula cannot price is listed with the reason (the next process refuses it; nothing is paid).
 * Authorised as the named HR administrator, whose real grants the database re-verifies.
 *
 * Output names no person: employee code, Pay Item code, dates and amounts only. Do not run it against an
 * installation without the owner's permission for that installation.
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a \
 *     && node --import tsx scripts/report-formula-builder-amount-imports-7b5b1665.ts --tenant <uuid> --actor-user <uuid> [--company <uuid>] [--json]
 */
import { and, eq, sql } from 'drizzle-orm';
import { createDb, type SessionContext } from '../db/client';
import { appUser, roleAssignment } from '../db/schema';
import { resolveEntitlementsTx } from '../core/entitlements';
import { priceIndividualTxnInputTx } from '../packs/payroll/service';
import { PayFormulaError } from '../lib/pay-formula-model';

export type FormulaAmountImportRow = {
  transactionId: string; companyId: string; payPeriod: string;
  run: { batchId: string; runSeq: number; status: string } | null;
  employeeCode: string | null; payItemCode: string; txnDate: string; unit: string | null;
  savedAmount: string; paysNow: string | null; asAmount: string; difference: string | null; reason: string | null;
};
export type FormulaAmountImportReport = {
  tenantId: string;
  groups: { companyId: string; payPeriod: string; rows: number; refused: number; paysNowTotal: string; asAmountTotal: string }[];
  rows: FormulaAmountImportRow[];
};

const OPEN_MONTH = sql`
  (b.id IS NULL OR b.status <> 'closed') AND (cb.id IS NULL OR cb.status <> 'closed')
  AND (t.batch_id IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM pay_period pp WHERE pp.tenant_id = t.tenant_id AND pp.company_id = t.company_id AND pp.period = t.pay_period AND pp.status = 'closed'))`;
const cents = (v: string | number) => Math.round(Number(v) * 100);
const money = (c: number) => (c / 100).toFixed(2);

/** `storage` MUST be the operator's owner connection. Reads only. */
export async function reportFormulaBuilderAmountImports(storage: ReturnType<typeof createDb>, p: { tenantId: string; actorUserId: string; companyId?: string }): Promise<FormulaAmountImportReport> {
  const [user] = await storage.db.select({ id: appUser.id, personId: appUser.personId }).from(appUser).where(and(eq(appUser.tenantId, p.tenantId), eq(appUser.id, p.actorUserId)));
  if (!user) throw new Error('The named operator is not a user of this tenant.');
  const grants = await storage.db.select({ role: roleAssignment.role, companyId: roleAssignment.companyId }).from(roleAssignment)
    .where(and(eq(roleAssignment.tenantId, p.tenantId), eq(roleAssignment.appUserId, user.id)));
  const entitlements = await storage.db.transaction((tx) => resolveEntitlementsTx(tx, p.tenantId));
  const ctx: SessionContext = { tenantId: p.tenantId, userId: user.id, personId: user.personId, roles: [...new Set(grants.map((g) => g.role))], grants, entitlements };

  const candidates = await storage.db.execute<{
    id: string; company_id: string; pay_period: string; batch_id: string | null; run_seq: number | null; batch_status: string | null; batch_cycle_id: string | null;
    intended_cycle_id: string | null; employment_id: string; employee_code: string | null; component_id: string; code: string; txn_date: string;
    unit: string | null; amount: string;
  }>(sql`
    SELECT t.id, coalesce(t.company_id, b.company_id) AS company_id, coalesce(t.pay_period, b.pay_period) AS pay_period,
           t.batch_id, b.run_seq, b.status::text AS batch_status, b.payroll_cycle_id AS batch_cycle_id, t.intended_cycle_id,
           t.employment_id, e.employee_code, pc.id AS component_id, pc.code, t.txn_date::text AS txn_date,
           t.unit, t.amount::text AS amount
      FROM payroll_individual_txn t
      JOIN pay_component pc ON pc.id = t.component_id AND pc.tenant_id = t.tenant_id
      JOIN employment e ON e.id = t.employment_id AND e.tenant_id = t.tenant_id
      LEFT JOIN payroll_batch b ON b.id = t.batch_id
      LEFT JOIN payroll_batch cb ON cb.id = t.consumed_batch_id
     WHERE t.tenant_id = ${p.tenantId}::uuid
       AND t.source = 'import' AND t.kind IN ('earning', 'deduction')
       AND t.calculation_method IS NULL AND t.pricing_source IS NULL
       AND (t.unit = 'amount' OR t.unit IS NULL)
       AND pc.rule ->> 'kind' = 'formula_builder'
       ${p.companyId ? sql`AND coalesce(t.company_id, b.company_id) = ${p.companyId}::uuid` : sql``}
       AND ${OPEN_MONTH}
     ORDER BY company_id, pay_period, b.run_seq NULLS LAST, e.employee_code NULLS LAST, t.txn_date, t.id`);

  const rows: FormulaAmountImportRow[] = [];
  // One READ ONLY transaction per company and month; a savepoint per row keeps one refusal from aborting the rest.
  const groups = new Map<string, (typeof candidates)[number][]>();
  for (const c of candidates) {
    const key = c.company_id + '|' + c.pay_period;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  for (const group of groups.values()) {
    const priced = await storage.withTenant(ctx, async (tx) => {
      const out: { amount: string | null; error: string | null }[] = [];
      for (const c of group) {
        // Payroll reads a method-less, unmarked row's saved amount as {#Input} (lib/pay-formula-input.ts), so the
        // figure it pays is the formula priced with that amount as the keyed quantity.
        try {
          const r = await tx.transaction((sp) => priceIndividualTxnInputTx(sp, ctx, {
            componentId: c.component_id, employmentId: c.employment_id, companyId: c.company_id, payPeriod: c.pay_period, txnDate: c.txn_date,
            quantity: Number(c.amount), unit: 'qty', amount: 0, cycleId: c.batch_cycle_id ?? c.intended_cycle_id, batchId: c.batch_id, method: 'formula',
          }));
          out.push({ amount: money(cents(r.amount)), error: null });
        } catch (e) {
          if (!(e instanceof PayFormulaError)) throw e;
          out.push({ amount: null, error: 'formula_failed: ' + e.message });
        }
      }
      return out;
    }, { readOnlySnapshot: true });
    group.forEach((c, i) => {
      const { amount, error } = priced[i];
      rows.push({
        transactionId: c.id, companyId: c.company_id, payPeriod: c.pay_period,
        run: c.batch_id ? { batchId: c.batch_id, runSeq: Number(c.run_seq), status: String(c.batch_status) } : null,
        employeeCode: c.employee_code, payItemCode: c.code, txnDate: c.txn_date, unit: c.unit, savedAmount: c.amount,
        paysNow: amount, asAmount: money(cents(c.amount)), difference: amount == null ? null : money(cents(c.amount) - cents(amount)), reason: error,
      });
    });
  }
  const summary = new Map<string, { companyId: string; payPeriod: string; rows: number; refused: number; now: number; asAmount: number }>();
  for (const r of rows) {
    const key = r.companyId + '|' + r.payPeriod;
    const g = summary.get(key) ?? { companyId: r.companyId, payPeriod: r.payPeriod, rows: 0, refused: 0, now: 0, asAmount: 0 };
    g.rows++;
    if (r.paysNow == null) g.refused++;
    else { g.now += cents(r.paysNow); g.asAmount += cents(r.asAmount); }
    summary.set(key, g);
  }
  return {
    tenantId: p.tenantId,
    groups: [...summary.values()].map((g) => ({ companyId: g.companyId, payPeriod: g.payPeriod, rows: g.rows, refused: g.refused, paysNowTotal: money(g.now), asAmountTotal: money(g.asAmount) })),
    rows,
  };
}

function arg(name: string) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }

if (process.argv[1]?.endsWith('report-formula-builder-amount-imports-7b5b1665.ts')) {
  const url = process.env.MIGRATION_DATABASE_URL, tenantId = arg('--tenant'), actorUserId = arg('--actor-user'), companyId = arg('--company');
  if (!url || !tenantId || !actorUserId) {
    console.error('Usage: MIGRATION_DATABASE_URL=… report-formula-builder-amount-imports-7b5b1665.ts --tenant <uuid> --actor-user <hr-admin user uuid> [--company <uuid>] [--json]');
    process.exit(1);
  }
  const storage = createDb(url, { max: 1 });
  reportFormulaBuilderAmountImports(storage, { tenantId, actorUserId, companyId })
    .then((r) => {
      if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 1)); return; }
      console.log('READ ONLY. Nothing was written. Each line pays "now" at the next process or reprocess unless HR sets it to Amount with Edit.');
      for (const g of r.groups) {
        console.log(`company ${g.companyId} · ${g.payPeriod}: ${g.rows} line(s), pays now ${g.paysNowTotal}, as Amount ${g.asAmountTotal}, cannot price ${g.refused}`);
        for (const v of r.rows.filter((x) => x.companyId === g.companyId && x.payPeriod === g.payPeriod)) {
          const run = v.run ? `run ${v.run.runSeq} ${v.run.status} ${v.run.batchId.slice(0, 8)}` : 'not yet on a run';
          console.log(`  ${run} · employee ${v.employeeCode ?? '(no code)'} · ${v.payItemCode} ${v.txnDate} · saved ${v.savedAmount}`
            + (v.paysNow != null ? ` · pays now ${v.paysNow} · as Amount ${v.asAmount} (${v.difference})` : ` · as Amount ${v.asAmount}`)
            + (v.reason ? ` · ${v.reason}` : '') + ` · txn ${v.transactionId}`);
        }
      }
      if (!r.groups.length) console.log('No open-month imported line is affected.');
    })
    .then(() => storage.client.end(), async (e) => { console.error(e); await storage.client.end(); process.exit(1); });
}
