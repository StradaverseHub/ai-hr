'use server';

import { revalidatePath } from 'next/cache';
import { scopedAdmin } from '@/lib/scope';
import { BatchNotDraftError } from '@/core/payroll';
import { listIndividualTxnsAcross, listUnattachedTxnSummary } from '@/core/payroll-view';
import { buildTxnPanel, type TxnPanel } from './existing-context';
import {
  createIndividualTxnsBulk,
  getIndividualTxn,
  updateIndividualTxn,
  deleteIndividualTxn,
  TxnDateOutOfPeriodError,
  TxnNotFoundError,
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
  type IndividualTxnDetail,
} from '@/core/payroll-individual-txn';

/**
 * 44129979 — the server half of the redesigned Individual Transaction screen.
 *
 * Every action here returns a PLAIN RESULT rather than redirecting. The screen is one page with an
 * employee list on the left and that employee's transactions on the right, and the request was explicit
 * that saving, editing or deleting must refresh the listing "without reloading the entire page" — a
 * redirect would throw away the operator's place in the list, their filters, and the form they are
 * halfway through. The previous shape (redirect back with ?error=) belonged to a wizard that had nowhere
 * to put an inline error.
 *
 * Scope fencing is the same rule on every one of them: `scopedAdmin` gives the companies this admin may
 * act in, and a row or a target outside that set reads as "not found" / "out of scope" — never as a
 * cross-company read or write. RLS isolates TENANTS; company scope is an application concern, so it is
 * enforced here rather than assumed.
 */

/** Map a typed individual-transaction error to a friendly key the client resolves against its catalog. */
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
                      : e instanceof TxnNotFoundError
                        ? 'txnNotFound'
                        : e instanceof BatchNotDraftError
                          ? 'notDraft'
                          : (e as Error).message;

export type TxnActionResult = { ok: true; id?: string } | { ok: false; error: string };

/** One transaction as the create/edit form submits it. `quantity`/`unit` are descriptive (the request's
 *  "Input Type" + "Quantity / Value"); `amount` is the figure that is actually paid. */
export type TxnFormInput = {
  employmentId: string;
  companyId: string;
  payPeriod: string;
  /** A resolved draft run for that (company, month), or '' to key the row against the month itself. */
  batchId: string;
  kind: string;
  componentId: string | null;
  txnDate: string;
  amount: number;
  quantity: number | null;
  unit: string | null;
  notes: string | null;
};

/**
 * Every one-off transaction already recorded for ONE employee, itemised, plus the totals of exactly those
 * rows and any month whose money has already missed its payroll run.
 *
 * ON DEMAND, PER EMPLOYEE — which is the performance half of the request. The screen never loads every
 * employee's transactions; it loads the selected employee's, narrowed further to one month when a month
 * filter is set. `listIndividualTxnsAcross` is the SAME read the Transaction View's History tab uses and
 * already takes `employmentId`, so this is a narrowing of an existing query, not a new one.
 *
 * The stranded-money read is `listUnattachedTxnSummary` — d0d2c9d1's population, unchanged. This screen
 * consumes it to warn, and deliberately does not restate it as a status; see existing-context.ts.
 *
 * Read-only: no write, no domain event.
 */
export async function fetchEmployeeTxnPanelAction(input: {
  employmentId: string;
  companyId: string;
  /** 'YYYY-MM', or '' for every month this employee has. */
  payPeriod?: string;
}): Promise<TxnPanel> {
  const empty: TxnPanel = {
    rows: [],
    totals: { count: 0, total: '0.00', pendingCount: 0, pendingTotal: '0.00', processedCount: 0, processedTotal: '0.00' },
    stranded: [],
  };
  const { s, scopeIds } = await scopedAdmin();
  const companyId = input.companyId ?? '';
  if (!companyId || !scopeIds.includes(companyId) || !input.employmentId) return empty;
  // A malformed month narrows to nothing rather than silently widening to every month.
  const period = input.payPeriod ?? '';
  if (period !== '' && !isPayPeriod(period)) return empty;
  const [year, month] = period ? period.split('-').map(Number) : [undefined, undefined];

  const [rows, stranded] = await Promise.all([
    listIndividualTxnsAcross(s, { companyIds: [companyId], employmentId: input.employmentId, year, month }),
    listUnattachedTxnSummary(s, { companyIds: [companyId], employmentId: input.employmentId, year, month }),
  ]);
  // The join, the status rule and the cent arithmetic live in a pure module so they are unit-testable
  // without a session (test/existing-txn-context.test.ts) — the same split as history-breakdown.ts.
  return buildTxnPanel(rows, stranded);
}

/**
 * One row by id, for Edit and for Duplicate — the only place the picked Payroll Item Master component is
 * read back, because the listing projection does not carry it (see getIndividualTxn's doc comment).
 *
 * Fenced to the caller's company scope: a row in a company this admin does not administer reads as absent.
 */
export async function fetchTxnDetailAction(input: { id: string }): Promise<IndividualTxnDetail | null> {
  const { s, scopeIds } = await scopedAdmin();
  if (!input.id) return null;
  const row = await getIndividualTxn(s, { id: input.id });
  if (!row || !scopeIds.includes(row.companyId)) return null;
  return row;
}

/**
 * Create ONE one-off transaction — the Add form, and equally the save of a Duplicate (a copy is an
 * ordinary create of a row whose fields were prefilled from another; nothing about the write differs).
 *
 * It goes through `createIndividualTxnsBulk` with a single employee and a single row rather than
 * `createIndividualTxn`, so the screen's writes run the SAME guard sequence as the bulk path it replaces:
 * draft re-check inside the transaction, company match, batch-scope membership, date-in-period, amount>0,
 * and the Phase-3 component rules. One create path, one set of rules.
 *
 * NOTE ON THE NAME: `DuplicateTxnRowError` below is the byte-for-byte duplicate ROW validation, not this
 * screen's Duplicate action. They are unrelated — one rejects a double paste, the other copies a row on
 * purpose — and the reader who conflates them will assume Duplicate is blocked.
 */
export async function createIndividualTxnAction(input: TxnFormInput): Promise<TxnActionResult> {
  const { s, scopeIds } = await scopedAdmin();
  if (!input.companyId || !scopeIds.includes(input.companyId)) return { ok: false, error: 'outOfScope' };
  if (!input.employmentId) return { ok: false, error: 'noEmployeesSelected' };
  if (!input.batchId && !isPayPeriod(input.payPeriod)) return { ok: false, error: 'periodInvalid' };
  try {
    const { ids } = await createIndividualTxnsBulk(s, {
      ...(input.batchId ? { batchId: input.batchId } : { companyId: input.companyId, payPeriod: input.payPeriod }),
      employmentIds: [input.employmentId],
      rows: [
        {
          kind: input.kind,
          txnDate: input.txnDate,
          amount: input.amount,
          quantity: input.quantity,
          unit: input.unit,
          notes: input.notes,
          componentId: input.componentId,
        },
      ],
    });
    revalidatePath('/payroll/transactions/individual');
    return { ok: true, id: ids[0] };
  } catch (e) {
    return { ok: false, error: txnErrorKey(e) };
  }
}

/**
 * Edit one existing transaction in place. The service re-validates everything (draft-or-unattached,
 * date-in-period, amount>0, component coherence), so this only fences the company scope first — an
 * out-of-scope id must not even reach the service, or the failure would leak that the row exists.
 */
export async function updateIndividualTxnAction(
  input: Omit<TxnFormInput, 'employmentId' | 'batchId' | 'payPeriod'> & { id: string },
): Promise<TxnActionResult> {
  const { s, scopeIds } = await scopedAdmin();
  const existing = input.id ? await getIndividualTxn(s, { id: input.id }) : null;
  if (!existing || !scopeIds.includes(existing.companyId)) return { ok: false, error: 'txnNotFound' };
  try {
    await updateIndividualTxn(s, {
      id: input.id,
      kind: input.kind,
      txnDate: input.txnDate,
      amount: input.amount,
      quantity: input.quantity,
      unit: input.unit,
      notes: input.notes,
      componentId: input.componentId,
    });
    revalidatePath('/payroll/transactions/individual');
    return { ok: true, id: input.id };
  } catch (e) {
    return { ok: false, error: txnErrorKey(e) };
  }
}

/** Delete one transaction (allowed while unattached or on a draft run — the service enforces it). */
export async function deleteIndividualTxnAction(input: { id: string }): Promise<TxnActionResult> {
  const { s, scopeIds } = await scopedAdmin();
  const existing = input.id ? await getIndividualTxn(s, { id: input.id }) : null;
  if (!existing || !scopeIds.includes(existing.companyId)) return { ok: false, error: 'txnNotFound' };
  try {
    await deleteIndividualTxn(s, { id: input.id });
    revalidatePath('/payroll/transactions/individual');
    return { ok: true, id: input.id };
  } catch (e) {
    return { ok: false, error: txnErrorKey(e) };
  }
}
