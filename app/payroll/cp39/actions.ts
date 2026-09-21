'use server';

import { revalidatePath } from 'next/cache';
import { scopedAdmin } from '@/lib/scope';
import { recordPcbPayment, PcbPaymentError, type PcbPaymentKind } from '@/core/pcb-payment';

/**
 * 72b100cd — record what was paid to LHDN for one month and one stream.
 *
 * ⚠️ THE COMPANY IS RE-GUARDED HERE, not trusted from the form. The posted companyId is a hidden input
 * and a hidden input is a suggestion; `scopedAdmin` resolves the caller's own authorised companies and
 * the id is checked against them before anything is written. The screen already narrows the picker to
 * that set, which is a courtesy — this is the gate.
 */
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
  revalidatePath('/payroll/cp39/preview');
}
