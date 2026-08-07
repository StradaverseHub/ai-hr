'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { BatchNotDraftError, batchEditImpact } from '@/core/payroll';
import { listIndividualTxnsAcross, listUnattachedTxnSummary } from '@/core/payroll-view';
import { buildTxnPanel, type TxnPanel } from './existing-context';
import { deriveIndividualTxnAmount, TxnQuantityRequiredError } from '@/core/pay-components';
import { PayRuleEvalError } from '@/core/pay-rule';
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
    : // 2da9937a — a pay item that works its amount out from a keyed quantity, saved without one. Two keys
      // rather than one interpolated sentence: the screen resolves an error key with no values, and the
      // operator needs to be told WHICH box, not that a box is missing.
      e instanceof TxnQuantityRequiredError
      ? e.unit === 'hours'
        ? 'quantityRequiredHours'
        : 'quantityRequiredDays'
      : // A corrupted stored rule resolved to a non-finite figure. Fail closed and say so — writing the
        // typed amount instead would pay a number the configured item did not produce.
        e instanceof PayRuleEvalError
        ? 'derivedAmountUnavailable'
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

export type TxnActionResult =
  | {
      ok: true;
      id?: string;
      /**
       * 49e7e0a2 — the PROCESSED run this write just made stale, or undefined when nothing became stale
       * (an unattached row, or a draft run, which recalculates by being generated).
       *
       * The screen uses it to link the operator straight to that run's selective reprocess. It is the
       * ACTION's report of what it did, not a second derivation: the service marked the run inside the
       * same transaction as the write, so this is never set for a write that did not land.
       */
      recalcBatchId?: string;
    }
  | { ok: false; error: string };

/**
 * 49e7e0a2 — what a save onto THIS run is about to make out of date, read on demand when the form
 * resolves a processed run as its target.
 *
 * The three downstream facts come from `batchDownstreamWarnings`, which is the derivation
 * `unlockClosedBatch` has used since 9bc442bc for the same question — deliberately shared rather than
 * re-implemented, so the warning before an edit and the warning before an unlock cannot disagree.
 *
 * Fenced to the caller's company scope; a run in a company this admin does not administer reads as absent.
 * Read-only: no write, no DomainEvent.
 */
export async function fetchBatchImpactAction(input: { batchId: string }): Promise<TxnBatchImpact | null> {
  const { s, scopeIds } = await scopedAdmin();
  if (!input.batchId) return null;
  const impact = await batchEditImpact(s, { batchId: input.batchId });
  if (!impact || !scopeIds.includes(impact.companyId)) return null;
  return {
    batchId: input.batchId,
    status: impact.status,
    payPeriod: impact.payPeriod,
    needsRecalc: impact.needsRecalcAt != null,
    recalcCount: impact.employmentIds.length,
    paymentDisbursed: impact.paymentDisbursed,
    statutoryFiled: impact.statutoryFiled,
    statutoryReportCount: impact.statutoryReportCount,
  };
}

/** Plain-data projection of `batchEditImpact` for the client component (no Date, no service types). */
export type TxnBatchImpact = {
  batchId: string;
  status: 'draft' | 'processed' | 'closed';
  payPeriod: string;
  needsRecalc: boolean;
  recalcCount: number;
  paymentDisbursed: boolean;
  statutoryFiled: boolean;
  statutoryReportCount: number;
};

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
 * 2da9937a — THE AMOUNT THIS SAVE WILL ACTUALLY WRITE.
 *
 * The gap this closes is that the write path never consulted the picked pay item's rule. It asked for an
 * Amount and asserted it was positive, so an item configured "RM x per hour" was arithmetic the operator
 * had to do by hand and the configured rule never ran. Here the rule runs, through the same evaluator the
 * payslip uses, and the figure it produces REPLACES whatever amount arrived from the browser — the client
 * shows the derived amount, it does not get a vote on it.
 *
 * For a null or `fixed` rule (and for a generic kind with no pay item at all) this returns the typed amount
 * unchanged, so those saves are byte-identical to before.
 *
 * The magnitude rule is deliberately NOT re-implemented here. `createIndividualTxnsBulk` /
 * `updateIndividualTxn` still assert amount > 0 — they now assert it on the DERIVED figure, which is
 * exactly the narrowing the plan asked for: the rule survives, it just stops firing on a box the operator
 * is no longer allowed to fill.
 */
async function amountForWrite(
  s: Awaited<ReturnType<typeof scopedAdmin>>['s'],
  p: {
    componentId: string | null;
    employmentId: string;
    companyId: string;
    payPeriod: string;
    quantity: number | null;
    unit: string | null;
    typed: number;
  },
): Promise<number> {
  if (!p.componentId) return p.typed;
  // The month bounds the attendance and recurring-item reads the rule resolves against, so it has to be a
  // real month. It always is by the time we get here (a batch supplies its own; a period-keyed write is
  // rejected above without one) — this refuses rather than quietly falling back to the typed amount, which
  // would pay a hand-typed figure for an item whose amount the operator was not allowed to type.
  if (!isPayPeriod(p.payPeriod)) throw new InvalidPayPeriodError(p.payPeriod);
  const d = await deriveIndividualTxnAmount(s, {
    componentId: p.componentId,
    employmentId: p.employmentId,
    companyId: p.companyId,
    payPeriod: p.payPeriod,
    quantity: p.quantity,
    unit: p.unit,
  });
  return d.derived ? d.amount : p.typed;
}

/** What the entry form is told about the picked pay item: whether the Amount box is its to fill, and — when
 *  it is not — the figure the item produces for the quantity keyed so far. */
export type TxnAmountPreview =
  | { ok: true; derived: false }
  | {
      ok: true;
      derived: true;
      /** Money, already at two decimals so the form shows the figure that will be stored. */
      amount: string;
      code: string;
      inputUnit: 'hours' | 'days' | null;
      /** The figure is 0 because a live divisor was zero for this employee — an explanation, not an error.
       *  Already LOCALISED here, exactly as previewPayRuleAction does it: the divisor is an internal
       *  operand token (`hours`, `fixed_allowances`, …) and the operator must read the same words the
       *  pay-item screen shows, not the token. Null when nothing divided by zero. */
      zeroDivisor: string | null;
    }
  | { ok: false; error: string };

/**
 * 2da9937a — show the operator the amount BEFORE they save it.
 *
 * Same call the save makes (`deriveIndividualTxnAmount`), so the number on screen and the number written
 * cannot disagree — a preview computed a second way is a preview that will eventually lie. Read-only.
 */
export async function previewTxnAmountAction(input: {
  componentId: string;
  employmentId: string;
  companyId: string;
  payPeriod: string;
  quantity: number | null;
  unit: string | null;
}): Promise<TxnAmountPreview> {
  const { s, scopeIds } = await scopedAdmin();
  if (!input.companyId || !scopeIds.includes(input.companyId)) return { ok: false, error: 'outOfScope' };
  if (!input.componentId || !input.employmentId) return { ok: true, derived: false };
  if (!isPayPeriod(input.payPeriod)) return { ok: false, error: 'periodInvalid' };
  try {
    const d = await deriveIndividualTxnAmount(s, {
      componentId: input.componentId,
      employmentId: input.employmentId,
      companyId: input.companyId,
      payPeriod: input.payPeriod,
      quantity: input.quantity,
      unit: input.unit,
    });
    if (!d.derived) return { ok: true, derived: false };
    const tr = await getTranslations('payRule');
    return {
      ok: true,
      derived: true,
      amount: d.amount.toFixed(2),
      code: d.code,
      inputUnit: d.inputUnit,
      zeroDivisor: d.zeroDivisor
        ? tr('previewZeroDivisor', { divisor: tr(`operand_${d.zeroDivisor.divisor}` as never), step: d.zeroDivisor.step })
        : null,
    };
  } catch (e) {
    return { ok: false, error: txnErrorKey(e) };
  }
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
  // 49e7e0a2 — read the target run's status BEFORE the write, so a successful save can report whether it
  // landed on a processed run without re-reading (and possibly re-deciding) afterwards.
  const targetImpact = input.batchId ? await batchEditImpact(s, { batchId: input.batchId }) : null;
  try {
    // 2da9937a — the pay item decides the amount when it has a rule that works one out. Resolved BEFORE
    // the write so the service's amount > 0 assertion lands on the figure that will be stored.
    const amount = await amountForWrite(s, {
      componentId: input.componentId,
      employmentId: input.employmentId,
      companyId: input.companyId,
      // A batch-attached write takes the month from the RUN (the service does the same), not from the form
      // field, so the two can never resolve the rule against different months.
      payPeriod: input.batchId ? (targetImpact?.payPeriod ?? input.payPeriod) : input.payPeriod,
      quantity: input.quantity,
      unit: input.unit,
      typed: input.amount,
    });
    const { ids } = await createIndividualTxnsBulk(s, {
      ...(input.batchId ? { batchId: input.batchId } : { companyId: input.companyId, payPeriod: input.payPeriod }),
      employmentIds: [input.employmentId],
      rows: [
        {
          kind: input.kind,
          txnDate: input.txnDate,
          amount,
          quantity: input.quantity,
          unit: input.unit,
          notes: input.notes,
          componentId: input.componentId,
        },
      ],
    });
    revalidatePath('/payroll/transactions/individual');
    return {
      ok: true,
      id: ids[0],
      ...(targetImpact?.status === 'processed' && input.batchId ? { recalcBatchId: input.batchId } : {}),
    };
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
    // 2da9937a — an edit re-derives too. The operator may have changed the hours, or moved the row onto a
    // pay item that calculates; either way the stored amount must be what the item produces NOW, not what
    // the browser sent.
    const amount = await amountForWrite(s, {
      componentId: input.componentId,
      employmentId: existing.employmentId,
      // The ROW's company, already checked against the caller's scope above — not the client's field.
      companyId: existing.companyId,
      // The row's own stamped month — an edit cannot move a transaction between months.
      payPeriod: existing.payPeriod,
      quantity: input.quantity,
      unit: input.unit,
      typed: input.amount,
    });
    await updateIndividualTxn(s, {
      id: input.id,
      kind: input.kind,
      txnDate: input.txnDate,
      amount,
      quantity: input.quantity,
      unit: input.unit,
      notes: input.notes,
      componentId: input.componentId,
    });
    revalidatePath('/payroll/transactions/individual');
    // `recalcOnEdit` is the SERVICE's own answer, read on the row that was about to be edited — not a
    // second rule this file invents about which runs are stale.
    return {
      ok: true,
      id: input.id,
      ...(existing.recalcOnEdit && existing.batchId ? { recalcBatchId: existing.batchId } : {}),
    };
  } catch (e) {
    return { ok: false, error: txnErrorKey(e) };
  }
}

/** Delete one transaction (allowed while unattached, or on a draft or processed run — the service
 *  enforces it, and marks a processed run for recalculation as it goes). */
export async function deleteIndividualTxnAction(input: { id: string }): Promise<TxnActionResult> {
  const { s, scopeIds } = await scopedAdmin();
  const existing = input.id ? await getIndividualTxn(s, { id: input.id }) : null;
  if (!existing || !scopeIds.includes(existing.companyId)) return { ok: false, error: 'txnNotFound' };
  try {
    await deleteIndividualTxn(s, { id: input.id });
    revalidatePath('/payroll/transactions/individual');
    return {
      ok: true,
      id: input.id,
      ...(existing.recalcOnEdit && existing.batchId ? { recalcBatchId: existing.batchId } : {}),
    };
  } catch (e) {
    return { ok: false, error: txnErrorKey(e) };
  }
}
