'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { scopedAdmin } from '@/lib/scope';
import { BatchNotDraftError } from '@/core/payroll';
import { listIndividualTxnsAcross, listUnattachedTxnSummary } from '@/core/payroll-view';
import { deriveExistingTxnContext, type ExistingTxnContextRow } from './existing-context';
import {
  createIndividualTxnsBulk,
  updateIndividualTxn,
  deleteIndividualTxn,
  TxnDateOutOfPeriodError,
  AmountNotPositiveError,
  CompanyMismatchError,
  ComponentRequiredError,
  EmploymentNotInBatchScopeError,
  EmptyEmployeeSelectionError,
  DuplicateTxnRowError,
  InvalidTxnComponentError,
  InvalidTxnKindError,
  InvalidTxnUnitError,
  InvalidPayPeriodError,
  MissingTxnTargetError,
  isPayPeriod,
  type BulkTxnRow,
} from '@/core/payroll-individual-txn';

const back = (batchId: string, qs: string) =>
  redirect(
    batchId
      ? `/payroll/transactions/individual?batchId=${encodeURIComponent(batchId)}&${qs}`
      : `/payroll/transactions/individual?${qs}`,
  );

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
          : e instanceof EmptyEmployeeSelectionError
            ? 'noEmployeesSelected'
            : e instanceof DuplicateTxnRowError
              ? 'duplicateRow'
              : e instanceof ComponentRequiredError
                ? 'componentRequired'
                : e instanceof InvalidTxnComponentError
                  ? 'componentInvalid'
                  : e instanceof InvalidTxnKindError || e instanceof InvalidTxnUnitError
                    ? 'rowIncomplete'
                    : e instanceof InvalidPayPeriodError || e instanceof MissingTxnTargetError
                      ? 'periodInvalid'
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

export type SaveGridResult = { ok: true; count: number } | { ok: false; error: string };

/**
 * 1.2.2 — Save the whole Step-3 grid of one-off transactions for ONE OR MANY employees, in a SINGLE
 * transaction (createIndividualTxnsBulk). The target is EITHER one draft batch (batchId) OR — since
 * f1564110 Phase 2 — a (companyId, payPeriod) month when no draft run exists yet: the rows are saved
 * UNATTACHED and picked up automatically when the month's regular run is generated. The same grid is
 * recorded for every selected employee. Returns a plain result (NOT a redirect) so the client wizard can
 * PRESERVE the entered rows and show an inline error on failure — a stale-batch / company / scope / date /
 * amount failure must never discard a spreadsheet of work (C10). The grid rows AND the selected
 * employmentIds arrive as JSON hidden fields; the resolved target comes from the client's wizard state.
 */
export async function saveIndividualTxnGridAction(formData: FormData): Promise<SaveGridResult> {
  const s = await requireAdmin();
  const batchId = String(formData.get('batchId') ?? '');
  const companyId = String(formData.get('companyId') ?? '');
  const payPeriod = String(formData.get('payPeriod') ?? '');

  let employmentIds: string[];
  try {
    const rawIds = JSON.parse(String(formData.get('employmentIds') ?? '[]'));
    employmentIds = Array.isArray(rawIds)
      ? rawIds.filter((x): x is string => typeof x === 'string' && x !== '')
      : [];
  } catch {
    return { ok: false, error: 'noEmployeesSelected' };
  }
  if (employmentIds.length === 0) return { ok: false, error: 'noEmployeesSelected' };
  // Target validation mirrors the service's MissingTxnTargetError, caught before parsing the grid.
  if (!batchId && !(companyId && isPayPeriod(payPeriod))) return { ok: false, error: 'periodInvalid' };

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
      // Phase 3 — the picked Payroll Item Master item (validated + required-when-flag-on in the service).
      componentId: typeof raw.componentId === 'string' && raw.componentId !== '' ? raw.componentId : null,
    });
  }
  if (rows.length === 0) return { ok: false, error: 'rowIncomplete' };

  try {
    const { ids } = await createIndividualTxnsBulk(
      s,
      batchId ? { batchId, employmentIds, rows } : { companyId, payPeriod, employmentIds, rows },
    );
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

/**
 * ec845c7d — "existing transactions for the selected employee visible while you enter a new one", and the
 * blind spot the approved plan insisted this redesign must not repeat: money keyed here that never reaches
 * a payslip.
 *
 * The unpaid figure is read through `listUnattachedTxnSummary` — the SAME read the Transaction View's
 * Outstanding tab uses (d0d2c9d1). That is deliberate and is the whole point: an entry screen that carried
 * its own idea of "unpaid" would eventually disagree with the screen the operator goes to when the number
 * looks wrong. Only the month's REGULAR run attaches these rows (core/payroll.ts, the `!subset &&
 * runType === 'regular'` guard), which is why an off-cycle or bonus run leaves them behind.
 *
 * Scale: one company, one month, then narrowed to the wizard's selected employees. Bounded by construction,
 * so it does not need the pagination framework — and deliberately does NOT load the company's whole
 * transaction set, which is the trap the plan called out for this screen.
 *
 * Read-only: no write, no domain event.
 */
export async function fetchExistingTxnContextAction(input: {
  companyId: string;
  payPeriod: string;
  employmentIds: string[];
}): Promise<ExistingTxnContextRow[]> {
  const { s, scopeIds } = await scopedAdmin();
  const companyId = input.companyId ?? '';
  // Scope fence: an out-of-scope companyId reads as "no company", never as a cross-company read. RLS
  // isolates tenants only; company scope is an application concern (same guard as the page).
  if (!companyId || !scopeIds.includes(companyId) || !isPayPeriod(input.payPeriod)) return [];
  const wanted = new Set((input.employmentIds ?? []).filter(Boolean));
  if (wanted.size === 0) return [];

  const [year, month] = input.payPeriod.split('-').map(Number);
  const [all, unattached] = await Promise.all([
    listIndividualTxnsAcross(s, { companyIds: [companyId], year, month }),
    listUnattachedTxnSummary(s, { companyIds: [companyId], year, month }),
  ]);

  // The join + the cent arithmetic live in a pure module so they are unit-testable without a session
  // (test/existing-txn-context.test.ts) — the same split as history-breakdown.ts.
  return deriveExistingTxnContext([...wanted], all, unattached);
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
