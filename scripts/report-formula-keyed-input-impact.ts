/**
 * NORMAL OT keyed-input fix — READ-ONLY IMPACT REPORT, to show the owner what the next process or reprocess will
 * change BEFORE anyone presses it. It never writes: every pricing call runs inside a READ ONLY database transaction.
 *
 * WHAT CHANGED IN THE CODE. A one-off row keyed as Hours, Days or Quantity on a Pay Item whose inline rule priced it
 * (method NULL, pricing marker `pay_item_rule`) is, once that Pay Item is linked to a saved Formula Builder formula,
 * re-priced at the next process or reprocess from its keyed quantity, exactly as entry prices a Formula Builder item,
 * and takes entry's marker (method 'formula', `saved_formula`, the formula revision). Before the fix, reprocess refused
 * it ("no longer calculates") and processing fed the stored amount into `{#Input}` (lib/pay-formula-input.ts).
 *
 * WHICH ROWS (one set-based read per tenant; open months only: not on or paid by a closed run, and an unattached row
 * not in a closed pay period). One-off earnings/deductions with input method NULL on a Pay Item whose CURRENT rule is a
 * Formula Builder formula, and either
 *   - marked `pay_item_rule`             → outcome `reprice` (saved vs new amount) or `refuse` with the reason the
 *                                          next process/reprocess will give (the run stays marked; nothing is paid);
 *   - unmarked with a positive Qty/Hours/Days/Units → outcome `unchanged`: its saved amount stays the formula input
 *                                          (documented historical raw input). `quantityPriced` is shown for the owner
 *                                          to judge whether any such row was in fact keyed by quantity.
 * The amounts come from the same deterministic pricing owner entry and reprocess use (priceIndividualTxnInputTx),
 * authorized as the named HR administrator, whose real grants the database re-verifies.
 *
 * Output names no person: employee code, Pay Item code, dates, quantities and amounts only.
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a \
 *     && node --import tsx scripts/report-formula-keyed-input-impact.ts --tenant <uuid> --actor-user <uuid> [--company <uuid>] [--json]
 */
import { and, eq, sql } from 'drizzle-orm';
import { createDb, type SessionContext } from '../db/client';
import { appUser, roleAssignment } from '../db/schema';
import { resolveEntitlementsTx } from '../core/entitlements';
import { priceIndividualTxnInputTx } from '../packs/payroll/service';
import { PayFormulaError } from '../lib/pay-formula-model';
import { payFormulaKeyedInput } from '../lib/pay-formula-input';

export type KeyedInputImpactRow = {
  transactionId: string; companyId: string; payPeriod: string;
  run: { batchId: string; runSeq: number; status: string } | null;
  employeeCode: string | null; payItemCode: string; txnDate: string;
  quantity: string | null; unit: string | null; savedAmount: string;
  marker: 'pay_item_rule' | null;
  outcome: 'reprice' | 'refuse' | 'unchanged';
  newAmount: string | null; difference: string | null; quantityPriced: string | null; reason: string | null;
};
export type KeyedInputImpactReport = {
  tenantId: string;
  groups: { companyId: string; payPeriod: string; reprice: number; refuse: number; unchanged: number; savedTotal: string; newTotal: string }[];
  rows: KeyedInputImpactRow[];
};

const OPEN_MONTH = sql`
  (b.id IS NULL OR b.status <> 'closed') AND (cb.id IS NULL OR cb.status <> 'closed')
  AND (t.batch_id IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM pay_period pp WHERE pp.tenant_id = t.tenant_id AND pp.company_id = t.company_id AND pp.period = t.pay_period AND pp.status = 'closed'))`;
const cents = (v: string | number) => Math.round(Number(v) * 100);
const money = (c: number) => (c / 100).toFixed(2);

/** `storage` MUST be the operator's owner connection. Reads only. */
export async function reportFormulaKeyedInputImpact(storage: ReturnType<typeof createDb>, p: { tenantId: string; actorUserId: string; companyId?: string }): Promise<KeyedInputImpactReport> {
  const [user] = await storage.db.select({ id: appUser.id, personId: appUser.personId }).from(appUser).where(and(eq(appUser.tenantId, p.tenantId), eq(appUser.id, p.actorUserId)));
  if (!user) throw new Error('The named operator is not a user of this tenant.');
  const grants = await storage.db.select({ role: roleAssignment.role, companyId: roleAssignment.companyId }).from(roleAssignment)
    .where(and(eq(roleAssignment.tenantId, p.tenantId), eq(roleAssignment.appUserId, user.id)));
  const entitlements = await storage.db.transaction((tx) => resolveEntitlementsTx(tx, p.tenantId));
  const ctx: SessionContext = { tenantId: p.tenantId, userId: user.id, personId: user.personId, roles: [...new Set(grants.map((g) => g.role))], grants, entitlements };

  const candidates = await storage.db.execute<{
    id: string; company_id: string; pay_period: string; batch_id: string | null; run_seq: number | null; batch_status: string | null; batch_cycle_id: string | null;
    intended_cycle_id: string | null; employment_id: string; employee_code: string | null; component_id: string; code: string; txn_date: string;
    quantity: string | null; unit: string | null; amount: string; pricing_source: string | null;
  }>(sql`
    SELECT t.id, coalesce(t.company_id, b.company_id) AS company_id, coalesce(t.pay_period, b.pay_period) AS pay_period,
           t.batch_id, b.run_seq, b.status::text AS batch_status, b.payroll_cycle_id AS batch_cycle_id, t.intended_cycle_id,
           t.employment_id, e.employee_code, pc.id AS component_id, pc.code, t.txn_date::text AS txn_date,
           t.quantity::text AS quantity, t.unit, t.amount::text AS amount, t.pricing_source
      FROM payroll_individual_txn t
      JOIN pay_component pc ON pc.id = t.component_id AND pc.tenant_id = t.tenant_id
      JOIN employment e ON e.id = t.employment_id AND e.tenant_id = t.tenant_id
      LEFT JOIN payroll_batch b ON b.id = t.batch_id
      LEFT JOIN payroll_batch cb ON cb.id = t.consumed_batch_id
     WHERE t.tenant_id = ${p.tenantId}::uuid
       AND t.kind IN ('earning', 'deduction') AND t.calculation_method IS NULL
       AND pc.rule ->> 'kind' = 'formula_builder'
       AND (t.pricing_source = 'pay_item_rule'
            OR (t.pricing_source IS NULL AND t.unit IN ('qty', 'hours', 'days', 'units') AND t.quantity > 0))
       ${p.companyId ? sql`AND coalesce(t.company_id, b.company_id) = ${p.companyId}::uuid` : sql``}
       AND ${OPEN_MONTH}
     ORDER BY company_id, pay_period, b.run_seq NULLS LAST, e.employee_code NULLS LAST, t.txn_date, t.id`);

  const rows: KeyedInputImpactRow[] = [];
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
        const input = payFormulaKeyedInput({ amount: c.amount, quantity: c.quantity, unit: c.unit, calculationMethod: null, pricingSource: 'pay_item_rule' });
        if (input.value == null) { out.push({ amount: null, error: 'input_missing: the transaction has no Hours, Days or Quantity the formula needs' }); continue; }
        try {
          const r = await tx.transaction((sp) => priceIndividualTxnInputTx(sp, ctx, {
            componentId: c.component_id, employmentId: c.employment_id, companyId: c.company_id, payPeriod: c.pay_period, txnDate: c.txn_date,
            quantity: Number(c.quantity), unit: c.unit, amount: Number(c.amount), cycleId: c.batch_cycle_id ?? c.intended_cycle_id, batchId: c.batch_id, method: 'formula',
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
      const marked = c.pricing_source === 'pay_item_rule';
      const { amount, error } = priced[i];
      const outcome: KeyedInputImpactRow['outcome'] = !marked ? 'unchanged' : amount != null ? 'reprice' : 'refuse';
      rows.push({
        transactionId: c.id, companyId: c.company_id, payPeriod: c.pay_period,
        run: c.batch_id ? { batchId: c.batch_id, runSeq: Number(c.run_seq), status: String(c.batch_status) } : null,
        employeeCode: c.employee_code, payItemCode: c.code, txnDate: c.txn_date, quantity: c.quantity, unit: c.unit, savedAmount: c.amount,
        marker: marked ? 'pay_item_rule' : null, outcome,
        newAmount: outcome === 'reprice' ? amount : outcome === 'unchanged' ? c.amount : null,
        difference: outcome === 'reprice' ? money(cents(amount!) - cents(c.amount)) : outcome === 'unchanged' ? '0.00' : null,
        quantityPriced: amount, reason: error,
      });
    });
  }
  // Totals in integer cents over the rows that will move.
  const summary = new Map<string, { companyId: string; payPeriod: string; reprice: number; refuse: number; unchanged: number; saved: number; next: number }>();
  for (const r of rows) {
    const key = r.companyId + '|' + r.payPeriod;
    const g = summary.get(key) ?? { companyId: r.companyId, payPeriod: r.payPeriod, reprice: 0, refuse: 0, unchanged: 0, saved: 0, next: 0 };
    g[r.outcome]++;
    if (r.outcome === 'reprice') { g.saved += cents(r.savedAmount); g.next += cents(r.newAmount!); }
    summary.set(key, g);
  }
  const groupList = [...summary.values()].map((g) => ({ companyId: g.companyId, payPeriod: g.payPeriod, reprice: g.reprice, refuse: g.refuse, unchanged: g.unchanged,
    savedTotal: money(g.saved), newTotal: money(g.next) }));
  return { tenantId: p.tenantId, groups: groupList, rows };
}

function arg(name: string) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }

if (process.argv[1]?.endsWith('report-formula-keyed-input-impact.ts')) {
  const url = process.env.MIGRATION_DATABASE_URL, tenantId = arg('--tenant'), actorUserId = arg('--actor-user'), companyId = arg('--company');
  if (!url || !tenantId || !actorUserId) {
    console.error('Usage: MIGRATION_DATABASE_URL=… report-formula-keyed-input-impact.ts --tenant <uuid> --actor-user <hr-admin user uuid> [--company <uuid>] [--json]');
    process.exit(1);
  }
  const storage = createDb(url, { max: 1 });
  reportFormulaKeyedInputImpact(storage, { tenantId, actorUserId, companyId })
    .then((r) => {
      if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 1)); return; }
      console.log('READ ONLY. Nothing was written. Amounts apply at the next process or reprocess of each open run.');
      for (const g of r.groups) {
        console.log(`company ${g.companyId} · ${g.payPeriod}: reprice ${g.reprice} (saved ${g.savedTotal} → new ${g.newTotal}), refuse ${g.refuse}, unchanged ${g.unchanged}`);
        for (const v of r.rows.filter((x) => x.companyId === g.companyId && x.payPeriod === g.payPeriod)) {
          const run = v.run ? `run ${v.run.runSeq} ${v.run.status} ${v.run.batchId.slice(0, 8)}` : 'not yet on a run';
          console.log(`  ${v.outcome.padEnd(9)} ${run} · employee ${v.employeeCode ?? '(no code)'} · ${v.payItemCode} ${v.txnDate} · ${v.quantity ?? '-'} ${v.unit ?? ''} · saved ${v.savedAmount}`
            + (v.outcome === 'reprice' ? ` → new ${v.newAmount} (${v.difference})` : '')
            + (v.outcome === 'unchanged' && v.quantityPriced ? ` (if the quantity were the input: ${v.quantityPriced})` : '')
            + (v.reason ? ` · ${v.reason}` : '') + ` · txn ${v.transactionId}`);
        }
      }
      if (!r.groups.length) console.log('No open-month transaction is affected.');
    })
    .then(() => storage.client.end(), async (e) => { console.error(e); await storage.client.end(); process.exit(1); });
}
