/**
 * HOW AN EMPLOYEE IS PAID — the vocabulary and the one bank rule, CLIENT-SAFE (no DB imports).
 *
 * r393 (item 685d2380 step 2) moved these here from core/org.ts, which still re-exports them, because
 * three readers now need the SAME answer and one of them runs in the browser:
 *   - `setEmploymentPaymentMethod` (core/org.ts) — refuses Bank Transfer for an employee with no usable
 *     bank destination (`MissingBankForTransferError`);
 *   - `missingByTab` (lib/employee-draft-schema.ts) — names the same gap on a DRAFT's Payroll tab, so
 *     Activate stays switched off until the Bank & Statutory tab holds both values;
 *   - `completeEmployeeDraft` (core/employee-draft.ts) — refuses the same draft BEFORE `hireEmployee`,
 *     with the same typed error, so an activation never stops halfway with half an employee saved.
 * A second copy of the predicate on any of the three is how a draft would show nothing outstanding and
 * then be refused by the writer after the employee already exists.
 */

/** R46 79eb7151 — the disbursement channels an employee can be paid through. */
export const PAYMENT_METHODS = ['bank_transfer', 'cheque', 'cash'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function isPaymentMethod(v: string | null | undefined): v is PaymentMethod {
  return (PAYMENT_METHODS as readonly string[]).includes(v ?? '');
}

/**
 * TRUE when a Bank Transfer to this destination cannot be made: BOTH the bank name and the account number
 * are required, judged after trimming. Half a destination is not a payable one — it would surface as an
 * unroutable row in the bank file long after the person who set it moved on (R46 79eb7151).
 */
export function bankTransferLacksBank(bank: {
  bankName?: string | null;
  bankAccountNo?: string | null;
}): boolean {
  return !(bank.bankName ?? '').trim() || !(bank.bankAccountNo ?? '').trim();
}
