'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { setPayrollDeductionInput, BatchNotDraftError } from '@/core/payroll';
import { setPayrollBatchComponent, UnsupportedBatchComponentError } from '@/core/pay-components';
import {
  createIndividualTxnsBulk,
  updateIndividualTxn,
  deleteIndividualTxn,
  TxnDateOutOfPeriodError,
  AmountNotPositiveError,
  CompanyMismatchError,
  EmploymentNotInBatchScopeError,
  InvalidTxnKindError,
  InvalidTxnUnitError,
  type BulkTxnRow,
} from '@/core/payroll-individual-txn';

const back = (batchId: string, qs: string) =>
  redirect(`/payroll/transactions/individual?batchId=${encodeURIComponent(batchId)}&${qs}`);

/** Map a typed individual-transaction error to a friendly query/result key; otherwise its raw message. The
 *  key set is mirrored in page.tsx (server) + the wizard (client) so the same message resolves everywhere. */
const txnErrorKey = (e: unknown): string =>
  e instanceof TxnDateOutOfPeriodError
    ? 'dateOutOfPeriod'
    : e instanceof AmountNotPositiveError
      ? 'amountNotPositive'
      : e instanceof CompanyMismatchError
        ? 'companyMismatch'
        : e instanceof EmploymentNotInBatchScopeError
          ? 'employeeNotInScope'
          : e instanceof InvalidTxnKindError || e instanceof InvalidTxnUnitError
            ? 'rowIncomplete'
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
 * Feature 1.2 — add a single one-off pay component to a draft batch for one employee (legacy "Other tools"
 * card, kept alongside the wizard). Routes through the event-logged setPayrollBatchComponent; the picker is
 * already filtered to supported components, but we still CATCH UnsupportedBatchComponentError so a stale
 * pick surfaces a friendly message rather than an opaque throw.
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
 * Feature 1.2 — set ONLY TP1 relief and zakat for one employee on a draft batch (legacy "Other tools" card).
 * DATA-LOSS FIX: setPayrollDeductionInput does a read-modify-write — it preserves the row's overtime/bonus
 * while updating tp1/zakat — so a TP1/zakat edit here never silently resets earnings.
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

export type SaveGridResult = { ok: true; count: number } | { ok: false; error: string };

/**
 * 1.2.2 — Save the whole Step-3 grid of one-off transactions for ONE employee against ONE draft batch, in a
 * SINGLE transaction (createIndividualTxnsBulk). Returns a plain result (NOT a redirect) so the client
 * wizard can PRESERVE the entered rows and show an inline error on failure — a stale-batch / company /
 * scope / date / amount failure must never discard a spreadsheet of work (C10). The grid rows arrive as a
 * JSON hidden field; the resolved batchId + employmentId come from the client's wizard state.
 */
export async function saveIndividualTxnGridAction(formData: FormData): Promise<SaveGridResult> {
  const s = await requireAdmin();
  const batchId = String(formData.get('batchId') ?? '');
  const employmentId = String(formData.get('employmentId') ?? '');
  if (!batchId || !employmentId) return { ok: false, error: 'rowIncomplete' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(formData.get('rows') ?? '[]'));
  } catch {
    return { ok: false, error: 'rowIncomplete' };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'rowIncomplete' };

  // Drop fully-empty trailing rows (no kind, no date, no amount, no notes). What remains must be complete —
  // the service re-validates each row, but a blank auto-added trailing row is expected and simply ignored.
  const rows: BulkTxnRow[] = [];
  for (const raw of parsed as Array<Record<string, unknown>>) {
    const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
    const txnDate = typeof raw.txnDate === 'string' ? raw.txnDate.trim() : '';
    const amountRaw = raw.amount;
    const hasAmount = amountRaw !== '' && amountRaw != null;
    const notes = typeof raw.notes === 'string' ? raw.notes.trim() : '';
    const isEmpty = !kind && !txnDate && !hasAmount && !notes;
    if (isEmpty) continue;
    const amount = Number(amountRaw);
    rows.push({
      kind,
      txnDate,
      amount: Number.isNaN(amount) ? -1 : amount, // -1 ⇒ fails amount>0 guard for an incomplete row
      notes: notes || null,
    });
  }
  if (rows.length === 0) return { ok: false, error: 'rowIncomplete' };

  try {
    const { ids } = await createIndividualTxnsBulk(s, { batchId, employmentId, rows });
    revalidatePath('/payroll/transactions/individual');
    return { ok: true, count: ids.length };
  } catch (e) {
    return { ok: false, error: txnErrorKey(e) };
  }
}

/** 1.2.2 — edit an existing dated one-off transaction (draft-only, re-validated; amount>0 enforced in the
 *  service so this retained edit path agrees with the bulk save's validity rule). */
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
