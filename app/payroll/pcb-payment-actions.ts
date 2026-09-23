'use server';

import { revalidatePath } from 'next/cache';
import { scopedAdmin } from '@/lib/scope';
import { recordPcbPayment, PcbPaymentError, type PcbPaymentKind } from '@/core/pcb-payment';

/**
 * 72b100cd — THE ONE WRITER OF `pcb_payment`, and it lives here so that BOTH screens import the same one.
 *
 * ⚠️ WHY IT MOVED (r331). It was `app/payroll/cp39/actions.ts`, because for r321 the CP39 review screen
 * was the only place a receipt could be keyed. r331 adds a second door — the PCB 2(II) receipts screen,
 * where a whole year is maintained at once — and the obvious way to build that screen is to give it its
 * own action beside its own page. That would be TWO writers of a money-adjacent record: two places to
 * re-guard the company, two places to trim, two places to revalidate, and the day one of them is changed
 * the two screens disagree about what was paid to a tax authority. So the action moved UP to the payroll
 * root, where both screens import it, and `test/72b100cd-pcb2ii-receipts.test.ts` asserts that no second
 * module under `app/` writes `pcb_payment` — the guard shape 8cd601d0 used a week earlier.
 *
 * ⚠️ THE COMPANY IS RE-GUARDED HERE, not trusted from the form. The posted companyId is a hidden input
 * and a hidden input is a suggestion; `scopedAdmin` resolves the caller's own authorised companies and
 * the id is checked against them before anything is written. Both screens already narrow their picker to
 * that set, which is a courtesy — this is the gate.
 *
 * BOTH SCREENS ARE REVALIDATED, NOT JUST THE ONE THAT SUBMITTED. The two paths below are the two doors
 * onto one record. If only the caller's own path were revalidated, keying October on the receipts screen
 * would leave a stale October sitting in the CP39 screen's cache — the exact "two screens disagree"
 * failure this module exists to prevent, arriving through the cache instead of through a second writer.
 * Both are literals: nothing from the form reaches `revalidatePath`.
 */
const WRITTEN_PATHS = ['/payroll/cp39/preview', '/payroll/statutory-forms/pcb2ii/receipts'] as const;

export async function recordPcbPaymentAction(formData: FormData) {
  const { s, scopeIds } = await scopedAdmin();
  const companyId = String(formData.get('companyId') ?? '');
  if (!companyId || !scopeIds.includes(companyId)) {
    // Silently doing nothing would look like a save. An out-of-scope company is a refusal.
    throw new Error('That company is not one you may record a payment for.');
  }
  const periodKey = String(formData.get('periodKey') ?? '');
  const kind = String(formData.get('kind') ?? '') as PcbPaymentKind;
  const receiptRef = String(formData.get('receiptRef') ?? '');
  const paidOn = String(formData.get('paidOn') ?? '') || undefined;

  try {
    await recordPcbPayment(s, { companyId, periodKey, kind, receiptRef, paidOn });
  } catch (e) {
    // The service's refusals are already operator-readable sentences; surface them rather than a 500.
    if (e instanceof PcbPaymentError) throw new Error(e.message);
    throw e;
  }
  for (const p of WRITTEN_PATHS) revalidatePath(p);
}
