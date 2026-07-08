'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { setPayrollDeductionInput } from '@/core/payroll';

/**
 * TP1 Relief transaction screen (approved plan, ADR-0050 §0.4). The dedicated screen edits ONE deduction
 * field per employee and delegates to the existing read-modify-write setPayrollDeductionInput so siblings
 * (overtime/bonus/zakat) survive and the same payroll-batch.input-set event is appended.
 *
 * COPY TRAP avoided: a single-field screen must NOT coalesce every deduction to Number(...)||0 (that would
 * silently zero the sibling). saveTp1Action passes ONLY tp1Deduction via num() (undefined for empty/NaN),
 * leaving zakat undefined so the wrapper preserves it.
 *
 * NOTE (feedback d435673e): the sibling zakat write-screen action (saveZakatAction) was REMOVED when the
 * Zakat screen dropped its one-off per-batch override section — the Zakat screen no longer writes
 * payroll_input.zakat. The manual zakat tier survives only on the batch input grid / prefill / import.
 */

const num = (v: FormDataEntryValue | null): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
};

const backTo = (path: string, batchId: string, qs: string) =>
  redirect(`${path}?batchId=${encodeURIComponent(batchId)}&${qs}`);

/** Set ONLY TP1 relief for one employee on a draft batch — leaves zakat (and every earning) untouched. */
export async function saveTp1Action(formData: FormData) {
  const s = await requireAdmin();
  const batchId = String(formData.get('batchId'));
  const employmentId = String(formData.get('employmentId'));
  try {
    await setPayrollDeductionInput(s, {
      batchId,
      employmentId,
      // ONLY tp1Deduction — leave zakat undefined so the wrapper preserves it. num() returns undefined for
      // empty/NaN (NOT Number(...)||0 — that is the copy trap that would zero the field).
      tp1Deduction: num(formData.get('tp1Deduction')),
    });
  } catch (e) {
    backTo('/payroll/transactions/tp1', batchId, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll/transactions/tp1');
  backTo('/payroll/transactions/tp1', batchId, 'toast=saved');
}
