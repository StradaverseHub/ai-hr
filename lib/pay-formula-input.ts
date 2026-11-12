/**
 * THE ONE OWNER of the value a Pay Item's own `{#Input}` reads, for every caller that builds a Pay Formula Builder
 * input: one-off entry pricing and its preview (packs/payroll/individual-calculation.ts), the re-pricing of an open
 * run's marked rows (same file), payroll generation (core/payroll.ts) and saved-formula simulation, which is also the
 * formula tester's snapshot of the employee's other Pay Items (core/pay-formula-runtime.ts). Dependency-free and pure:
 * it decides from the saved row only, never from a guess, a preview figure or a model.
 *
 * ROOT CAUSE IT CLOSES (production, NORMAL OT). A one-off row keyed as 9.00 hours on a Pay Item whose inline formula
 * priced it at 120.40 (method NULL, pricing marker `pay_item_rule`) was processed after the Pay Item was linked to a
 * saved Formula Builder formula ending `* {#Input}`. Entry prices a Formula Builder item with the keyed quantity, but
 * payroll built `{#Input}` from the stored amount, so the run paid 120.40 × the formula's hourly factor.
 *
 * THE RULE. The input is the keyed quantity when the row's amount is a FINAL figure some pricing owner worked out from
 * that quantity; otherwise it is the saved amount:
 *   - calculation_method 'formula'        → the keyed Qty, Hours, Days or Units (entry already priced it from them).
 *   - pricing_source 'pay_item_rule'      → the keyed quantity. The marker is written only when the Pay Item's rule
 *                                           derived exactly this amount from this quantity, so the amount is a price,
 *                                           and a price is never a formula input (ADR payroll-individual-entry-calculation).
 *   - calculation_method 'amount'         → the saved amount (an Amount-entered row; it bypasses its formula anyway).
 *   - everything else                     → the saved amount: recurring and fixed Pay Items, payroll batch components,
 *                                           and unmarked method-NULL rows, which the ledger documents as historical raw
 *                                           input ("NULL preserves every historical raw-input row").
 * A quantity-input row without a positive quantity in a quantity unit has no input (`value: null`): the caller refuses
 * it (`input_missing` on re-pricing, "current input unavailable" in a formula) instead of falling back to the amount.
 *
 * `{#PayItemInput}("CODE")` of another item is deliberately NOT decided here: it keeps the documented saved monetary
 * amount (lib/pay-formula-registry.ts), which `savedInput` carries unchanged.
 */
export const PAY_FORMULA_QUANTITY_UNITS = ['qty', 'hours', 'days', 'units'] as const;
export type PayFormulaQuantityUnit = (typeof PAY_FORMULA_QUANTITY_UNITS)[number];
export const isPayFormulaQuantityUnit = (unit: string | null | undefined): unit is PayFormulaQuantityUnit =>
  unit != null && (PAY_FORMULA_QUANTITY_UNITS as readonly string[]).includes(unit);

export type PayFormulaInputRow = {
  /** The saved amount: a recurring/batch figure, a historical raw input, or a final priced amount. */
  amount: string | number;
  quantity?: string | number | null;
  unit?: string | null;
  calculationMethod?: string | null;
  pricingSource?: string | null;
};
export type PayFormulaInputDecision =
  | { basis: 'amount'; value: string }
  | { basis: 'quantity'; value: string | null };

const text = (v: string | number) => (typeof v === 'number' ? String(v) : v);

/** Is this row's amount a price worked out from its keyed quantity (so the quantity is the input)? */
export function payFormulaInputIsKeyedQuantity(row: Pick<PayFormulaInputRow, 'calculationMethod' | 'pricingSource'>): boolean {
  if (row.calculationMethod === 'amount') return false;
  return row.calculationMethod === 'formula' || row.pricingSource === 'pay_item_rule';
}

/** The value `{#Input}` reads for this row. */
export function payFormulaKeyedInput(row: PayFormulaInputRow): PayFormulaInputDecision {
  if (!payFormulaInputIsKeyedQuantity(row)) return { basis: 'amount', value: text(row.amount) };
  const q = row.quantity;
  if (q == null || q === '' || !Number.isFinite(Number(q)) || !(Number(q) > 0) || !isPayFormulaQuantityUnit(row.unit)) return { basis: 'quantity', value: null };
  return { basis: 'quantity', value: text(q) };
}

/** The two inputs a payroll row hands the formula runtime: `formulaInput` (the saved monetary input that
 * `{#PayItemInput}` and unprorated rule-free figures read, unchanged) and `currentInput` (this row's own `{#Input}`). */
export function payFormulaRowInputs(row: PayFormulaInputRow): { formulaInput: string; currentInput: string | null } {
  return { formulaInput: text(row.amount), currentInput: payFormulaKeyedInput(row).value };
}
