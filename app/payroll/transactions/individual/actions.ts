'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { setPayrollDeductionInput } from '@/core/payroll';
import { setPayrollBatchComponent, UnsupportedBatchComponentError } from '@/core/pay-components';

const back = (batchId: string, qs: string) =>
  redirect(`/payroll/transactions/individual?batchId=${encodeURIComponent(batchId)}&${qs}`);

/**
 * Feature 1.2 — add a single one-off pay component to a draft batch for one employee.
 * Routes through the existing event-logged setPayrollBatchComponent; the picker is already filtered to
 * supported components, but we still CATCH UnsupportedBatchComponentError so a stale/edge pick surfaces a
 * friendly message rather than an opaque throw (the service is the backstop, the picker the front line).
 */
export async function addBatchComponentAction(formData: FormData) {
  const s = await requireAdmin();
  const batchId = String(formData.get('batchId'));
  const employmentId = String(formData.get('employmentId'));
  const componentId = String(formData.get('componentId'));
  const amount = Number(formData.get('amount')) || 0;
  const notes = (formData.get('notes') as string) || undefined;
  try {
    await setPayrollBatchComponent(s, { batchId, employmentId, componentId, amount, notes });
  } catch (e) {
    const msg =
      e instanceof UnsupportedBatchComponentError ? 'unsupportedComponent' : (e as Error).message;
    back(batchId, `error=${encodeURIComponent(msg)}`);
  }
  revalidatePath('/payroll/transactions/individual');
  back(batchId, 'toast=added');
}

/**
 * Feature 1.2 — set ONLY TP1 relief and zakat for one employee on a draft batch.
 * DATA-LOSS FIX: setPayrollInput is a full-row overwrite that zeroes omitted fields. setPayrollDeductionInput
 * does a read-modify-write — it preserves the row's overtime/bonus while updating tp1/zakat — so a TP1/zakat
 * edit here never silently resets earnings. Same event shape (payroll-batch.input-set).
 */
export async function setDeductionInputAction(formData: FormData) {
  const s = await requireAdmin();
  const batchId = String(formData.get('batchId'));
  const employmentId = String(formData.get('employmentId'));
  try {
    await setPayrollDeductionInput(s, {
      batchId,
      employmentId,
      tp1Deduction: Number(formData.get('tp1Deduction')) || 0,
      zakat: Number(formData.get('zakat')) || 0,
    });
  } catch (e) {
    back(batchId, `error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll/transactions/individual');
  back(batchId, 'toast=saved');
}
