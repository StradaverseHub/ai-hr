'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { setPayrollDeductionInput } from '@/core/payroll';

/**
 * Separated TP1 Relief / Zakat transaction screens (approved plan, ADR-0050 §0.4).
 * Each dedicated screen edits ONE deduction field per employee. Both delegate to the existing
 * read-modify-write setPayrollDeductionInput so siblings (overtime/bonus/the OTHER deduction) survive and
 * the same payroll-batch.input-set event is appended.
 *
 * COPY TRAP avoided: individual/actions.ts's setDeductionInputAction coalesces BOTH tp1Deduction AND zakat
 * to Number(...)||0 — a single-field screen that copied that would silently zero the sibling. Here each
 * action passes ONLY its own field via num() (undefined for empty/NaN), leaving the other undefined so the
 * wrapper preserves it AND (for zakat) preserves the untouched TP1's provenance.
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

/** Set ONLY zakat for one employee on a draft batch — leaves TP1 relief (and its provenance) untouched. */
export async function saveZakatAction(formData: FormData) {
  const s = await requireAdmin();
  const batchId = String(formData.get('batchId'));
  const employmentId = String(formData.get('employmentId'));
  try {
    await setPayrollDeductionInput(s, {
      batchId,
      employmentId,
      // ONLY zakat — leave tp1Deduction undefined so the wrapper preserves the TP1 value AND (ADR-0050 §0.4)
      // its 'tp1_self' provenance, keeping the relief auto-tracked.
      zakat: num(formData.get('zakat')),
    });
  } catch (e) {
    backTo('/payroll/transactions/zakat', batchId, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll/transactions/zakat');
  backTo('/payroll/transactions/zakat', batchId, 'toast=saved');
}
