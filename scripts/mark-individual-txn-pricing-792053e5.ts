/**
 * 792053e5 — MARK THE ONE-OFF TRANSACTIONS ALREADY ON OPEN MONTHS WHOSE AMOUNT A PAY ITEM FORMULA PRODUCED.
 *
 * NOT PART OF THE DEPLOY. Migration 9730 (draft) adds `payroll_individual_txn.pricing_source / pricing_ref /
 * priced_at`, NULL on every existing row, and payroll processing only re-prices a row that carries a marker. New rows
 * are marked by their writer. This one-off script marks rows that already exist, and it must be RUN and its report
 * read separately from the deployment:
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a \
 *     && node --import tsx scripts/mark-individual-txn-pricing-792053e5.ts          # report only
 *   …same, with --apply, to write.
 *
 * WHICH ROWS (set-wise statements, no per-company or per-row loop):
 *   - only rows in a month that is still OPEN: not attached to or paid by a closed run, and (unattached) not in a
 *     closed pay period. A closed month is never marked, so it is never re-priced.
 *   - Pay Formula Builder rows keyed with Qty, Hours, Days or Units (calculation_method 'formula'): marked
 *     'saved_formula' with the formula revision their own created/updated event recorded. A row whose event names no
 *     revision is left unmarked and listed.
 *   - legacy derived rows (calculation_method NULL) on a Pay Item whose CURRENT rule works out the amount (per hour,
 *     per day, Calculated by Formula), with the input that rule needs present and positive, and NO `pay-component.updated`
 *     event changing that item's rule since the row was last written. Then the rule that priced the row is the current
 *     one, so the stored amount was worked out by it. Marked 'pay_item_rule' with the sha256 of that rule.
 *   - everything else whose origin is uncertain (rule changed since the row was written, input missing or of another
 *     unit) stays as entered and is LISTED for HR to review.
 *
 * It never changes an amount, a payslip, a run or a status, never touches a row that already has a marker (so it is
 * idempotent), and writes `priced_at` as the instant the row was last written, not now.
 */
import { sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { payRuleInputUnit, type PayRule } from '../packs/payroll/service';

export type PricingMarkerRow = { id: string; tenantId: string; companyId: string | null; payPeriod: string | null; code: string | null; source: 'pay_item_rule' | 'saved_formula'; ref: string | null; reason: string | null };
export type PricingMarkerReport = { apply: boolean; marked: { companyId: string | null; source: string; rows: number }[]; review: PricingMarkerRow[]; written: number };

const OPEN_MONTH = sql`
  (b.id IS NULL OR b.status <> 'closed') AND (cb.id IS NULL OR cb.status <> 'closed')
  AND (t.batch_id IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM pay_period pp WHERE pp.tenant_id = t.tenant_id AND pp.company_id = t.company_id AND pp.period = t.pay_period AND pp.status = 'closed'))`;

export async function runPricingMarkerBackfill(url: string, opts: { apply: boolean } = { apply: false }): Promise<PricingMarkerReport> {
  const owner = createDb(url);
  const rows = await owner.db.execute<{
    id: string; tenant_id: string; company_id: string | null; pay_period: string | null; code: string | null; calculation_method: string | null;
    quantity: string | null; unit: string | null; amount: string; rule: PayRule | null; rule_hash: string | null; rule_changed: boolean; revision_id: string | null;
  }>(sql`
    SELECT t.id, t.tenant_id, coalesce(t.company_id, b.company_id) AS company_id, coalesce(t.pay_period, b.pay_period) AS pay_period,
           pc.code, t.calculation_method, t.quantity::text AS quantity, t.unit, t.amount::text AS amount, pc.rule,
           encode(sha256(convert_to(pc.rule::text, 'UTF8')), 'hex') AS rule_hash,
           EXISTS (SELECT 1 FROM domain_event e
                    WHERE e.tenant_id = t.tenant_id AND e.aggregate_type = 'pay-component' AND e.aggregate_id = t.component_id
                      AND e.event_type = 'pay-component.updated' AND e.payload -> 'changed' ? 'rule'
                      AND e.occurred_at > coalesce(t.updated_at, t.created_at)) AS rule_changed,
           (SELECT e.payload ->> 'formulaRevisionId' FROM domain_event e
             WHERE e.tenant_id = t.tenant_id AND e.aggregate_type = 'payroll-individual-txn' AND e.aggregate_id = t.id
               AND e.event_type IN ('payroll.individual-txn.created', 'payroll.individual-txn.updated') AND e.payload ? 'formulaRevisionId'
             ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1) AS revision_id
      FROM payroll_individual_txn t
      JOIN pay_component pc ON pc.id = t.component_id
      LEFT JOIN payroll_batch b ON b.id = t.batch_id
      LEFT JOIN payroll_batch cb ON cb.id = t.consumed_batch_id
     WHERE t.pricing_source IS NULL AND t.amount > 0
       AND (t.calculation_method = 'formula' OR (t.calculation_method IS NULL AND pc.rule ->> 'kind' IN ('per_hour', 'per_day', 'formula')))
       AND ${OPEN_MONTH}
     ORDER BY t.tenant_id, company_id, pay_period, t.id`);

  const mark: PricingMarkerRow[] = [], review: PricingMarkerRow[] = [];
  for (const r of rows) {
    const base = { id: r.id, tenantId: r.tenant_id, companyId: r.company_id, payPeriod: r.pay_period, code: r.code };
    if (r.calculation_method === 'formula') {
      (r.revision_id ? mark : review).push({ ...base, source: 'saved_formula', ref: r.revision_id, reason: r.revision_id ? null : 'no formula revision recorded' });
      continue;
    }
    const inputUnit = payRuleInputUnit(r.rule);
    const reason = r.rule_changed ? 'Pay Item rule changed since the row was written'
      : inputUnit != null && (r.unit !== inputUnit || !(Number(r.quantity) > 0)) ? `no ${inputUnit} input on the row` : null;
    (reason ? review : mark).push({ ...base, source: 'pay_item_rule', ref: reason ? null : 'rule:' + r.rule_hash, reason });
  }

  const counts = new Map<string, { companyId: string | null; source: string; rows: number }>();
  for (const m of mark) {
    const key = `${m.companyId}:${m.source}`;
    counts.set(key, { companyId: m.companyId, source: m.source, rows: (counts.get(key)?.rows ?? 0) + 1 });
  }
  let written = 0;
  if (opts.apply && mark.length) {
    const updated = await owner.db.execute<{ id: string }>(sql`
      UPDATE payroll_individual_txn t SET pricing_source = m.source, pricing_ref = m.ref, priced_at = coalesce(t.updated_at, t.created_at)
        FROM jsonb_to_recordset(${JSON.stringify(mark.map(({ id, source, ref }) => ({ id, source, ref })))}::jsonb) AS m(id uuid, source text, ref text)
       WHERE t.id = m.id AND t.pricing_source IS NULL
      RETURNING t.id`);
    written = updated.length;
  }
  return { apply: opts.apply, marked: [...counts.values()], review, written };
}

if (process.argv[1]?.endsWith('mark-individual-txn-pricing-792053e5.ts')) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('mark-individual-txn-pricing-792053e5 requires MIGRATION_DATABASE_URL (owner role).');
    process.exit(1);
  }
  runPricingMarkerBackfill(url, { apply: process.argv.includes('--apply') })
    .then(async (r) => {
      console.log(r.apply ? 'Marked:' : 'Would mark (report only):');
      for (const c of r.marked) console.log(`  company ${c.companyId ?? '(none)'} · ${c.source}: ${c.rows}`);
      console.log(`Left as entered for HR review: ${r.review.length}`);
      for (const v of r.review) console.log(`  ${v.id} company ${v.companyId ?? '(none)'} ${v.payPeriod ?? ''} ${v.code ?? ''}: ${v.reason}`);
      console.log(r.apply ? `Wrote ${r.written} row(s).` : 'Nothing was written. Re-run with --apply to write.');
      await createDb(url).client.end();
      process.exit(0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
