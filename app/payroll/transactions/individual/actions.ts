'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { setPayrollDeductionInput, BatchNotDraftError } from '@/core/payroll';
import { setPayrollBatchComponent, UnsupportedBatchComponentError } from '@/core/pay-components';
import {
  createIndividualTxn,
  updateIndividualTxn,
  deleteIndividualTxn,
  TxnDateOutOfPeriodError,
} from '@/core/payroll-individual-txn';

const back = (batchId: string, qs: string) =>
  redirect(`/payroll/transactions/individual?batchId=${encodeURIComponent(batchId)}&${qs}`);

/** Map a typed individual-transaction error to a friendly query key; otherwise its raw message. */
const txnErrorKey = (e: unknown): string =>
  e instanceof TxnDateOutOfPeriodError
    ? 'dateOutOfPeriod'
    : e instanceof BatchNotDraftError
      ? 'notDraft'
      : (e as Error).message;

const num = (v: FormDataEntryValue | null): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
};
const str = (v: FormDataEntryValue | null): string | undefined => {
  const s = (v as string) ?? '';
  return s.trim() === '' ? undefined : s;
};

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

/**
 * 1.2.2 Individual Transaction — record a dated one-off transaction (earning/deduction/overtime/unpaid/leave)
 * for one employee on the selected draft batch. The service validates draft-state + date-in-period and appends
 * a DomainEvent; we map its typed errors to friendly query keys (dateOutOfPeriod / notDraft).
 */
export async function createIndividualTxnAction(formData: FormData) {
  const s = await requireAdmin();
  const batchId = String(formData.get('batchId'));
  try {
    await createIndividualTxn(s, {
      batchId,
      employmentId: String(formData.get('employmentId')),
      kind: String(formData.get('kind')),
      txnDate: String(formData.get('txnDate')),
      amount: num(formData.get('amount')) ?? 0,
      quantity: num(formData.get('quantity')) ?? null,
      unit: str(formData.get('unit')) ?? null,
      notes: str(formData.get('notes')) ?? null,
    });
  } catch (e) {
    back(batchId, `error=${encodeURIComponent(txnErrorKey(e))}`);
  }
  revalidatePath('/payroll/transactions/individual');
  back(batchId, 'toast=added');
}

/** 1.2.2 — edit an existing dated one-off transaction (draft-only, re-validated against the batch period). */
export async function updateIndividualTxnAction(formData: FormData) {
  const s = await requireAdmin();
  const batchId = String(formData.get('batchId'));
  try {
    await updateIndividualTxn(s, {
      id: String(formData.get('id')),
      kind: String(formData.get('kind')),
      txnDate: String(formData.get('txnDate')),
      amount: num(formData.get('amount')) ?? 0,
      quantity: num(formData.get('quantity')) ?? null,
      unit: str(formData.get('unit')) ?? null,
      notes: str(formData.get('notes')) ?? null,
    });
  } catch (e) {
    back(batchId, `error=${encodeURIComponent(txnErrorKey(e))}`);
  }
  revalidatePath('/payroll/transactions/individual');
  back(batchId, 'toast=saved');
}

/** 1.2.2 — delete a dated one-off transaction (draft-only). */
export async function deleteIndividualTxnAction(formData: FormData) {
  const s = await requireAdmin();
  const batchId = String(formData.get('batchId'));
  try {
    await deleteIndividualTxn(s, { id: String(formData.get('id')) });
  } catch (e) {
    back(batchId, `error=${encodeURIComponent(txnErrorKey(e))}`);
  }
  revalidatePath('/payroll/transactions/individual');
  back(batchId, 'toast=deleted');
}
