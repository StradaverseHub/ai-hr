'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { BatchNotDraftError, PayrollPermissionDeniedError, batchEditImpact } from '@/core/payroll';
import { listIndividualTxnsAcross, listUnattachedTxnSummary } from '@/core/payroll-view';
import { buildTxnPanel, type TxnPanel } from './existing-context';
import { deriveIndividualTxnAmount, TxnQuantityRequiredError } from '@/core/pay-components';
import { PayRuleEvalError } from '@/core/pay-rule';
import {
  addEmploymentToBatchScope,
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
  InvalidTxnCycleError,
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
  // 4b909202 — the only action on this screen that asks for a payroll permission is the add-to-run
  // below, and on a PROCESSED run it asks for the same one the Reprocess screen does. Refusing with
  // the generic key would tell the operator the transaction was wrong; it was not, their authority was.
  e instanceof PayrollPermissionDeniedError
    ? 'addToRunDenied'
    : e instanceof TxnDateOutOfPeriodError
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
                  : // c11e81aa — the chosen Pay Cycle is unknown, archived, another company's, or
                    // disagrees with the run the row is already on. One key: what the operator has to do
                    // is the same in all four cases — pick a cycle this entry can actually be paid under.
                    e instanceof InvalidTxnCycleError
                    ? 'cycleInvalid'
                    : e instanceof InvalidTxnKindError || e instanceof InvalidTxnUnitError
                    ? 'rowIncomplete'
                    : e instanceof InvalidPayPeriodError || e instanceof MissingTxnTargetError
                      ? 'periodInvalid'
                      : e instanceof TxnNotFoundError
                        ? 'txnNotFound'
                        : e instanceof BatchNotDraftError
                          ? 'notDraft'
                          : (e as Error).message;

/** 4b909202 — WHO to add and to WHICH run, for the offer the scope refusal now carries. Both ids come
 *  off the thrown error, so the screen cannot offer to widen a run the service did not actually refuse. */
export type TxnScopeFix = { batchId: string; employmentId: string };

/**
 * 4b909202 — TURN A THROWN SERVICE ERROR INTO THE SCREEN'S FAILURE.
 *
 * One place, so the two create paths and the edit/delete paths cannot drift on how a refusal reads. The
 * scope refusal is the only one that carries values (and the only one that carries an offer); everything
 * else resolves exactly as it did, through the same `txnErrorKey` chain and with no values at all.
 */
function txnFailure(e: unknown): Extract<TxnActionResult, { ok: false }> {
  if (e instanceof EmploymentNotInBatchScopeError) {
    return {
      ok: false,
      error: 'employeeNotInScope',
      errorValues: { employee: e.detail.employeeName, period: e.detail.payPeriod, scope: e.detail.reason },
      scopeFix: { batchId: e.batchId, employmentId: e.employmentId },
    };
  }
  return { ok: false, error: txnErrorKey(e) };
}

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
  | {
      ok: false;
      error: string;
      /**
       * 4b909202 — ICU values for `error`, when the key takes any. The screen resolves the key against
       * its OWN catalogue (the six locales), so what crosses this boundary is data — a person's name, an
       * ISO month, and a token — never a built sentence, which would be English in six languages.
       */
      errorValues?: Record<string, string>;
      /** Present only on the scope refusal: the run this employee could be added to. */
      scopeFix?: TxnScopeFix;
    };

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
  /**
   * c11e81aa — the CONFIGURED Pay Cycle the operator chose (payroll_cycle.id), or null when the company
   * has no cycle catalogue to choose from. Independent of `batchId`: when a run of that cycle's type
   * already exists the row attaches to it directly, and when none does the row is period-keyed and this
   * is what tells the eventual run it is theirs.
   */
  intendedCycleId: string | null;
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
    totals: {
      count: 0,
      total: '0.00',
      pendingCount: 0,
      pendingTotal: '0.00',
      processedCount: 0,
      processedTotal: '0.00',
      reprocessCount: 0,
      reprocessTotal: '0.00',
    },
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
 * 4e403268 — the same preview, for a WHOLE DAY-BY-DAY GRID, in ONE round trip.
 *
 * WHY THIS EXISTS RATHER THAN CALLING `previewTxnAmountAction` PER ROW. The single-value preview is fired
 * from a keyed effect on every change to the quantity box. Fanning that out to one request per grid row
 * would put five to thirty concurrent server actions in flight on every keystroke, each opening its own
 * transaction to resolve the same employee's same month — and the answers would land in an order nobody
 * controls, which is exactly the race the single-value version's store-the-key-with-the-answer guard
 * exists to survive. One request, one answer set, the same guard shape.
 *
 * IT TAKES DISTINCT QUANTITIES, NOT ROWS. The derived amount is a function of (item, employment, company,
 * month, quantity, unit) and of nothing else, so five days of 2.00 hours are five copies of one answer.
 * The client dedupes (`distinctQuantities` in day-lines.ts) and maps the figures back onto its rows.
 *
 * The evaluator is `deriveIndividualTxnAmount` — the same call the single preview makes and the same one
 * the SAVE makes. There is exactly one place in this system that prices a pay item, and this is not a
 * second one.
 *
 * Read-only: no write, no domain event.
 */
export type TxnAmountsPreview =
  | { ok: false; error: string }
  | {
      ok: true;
      derived: false;
    }
  | {
      ok: true;
      derived: true;
      /** One entry per requested quantity, keyed by the quantity as the client normalised it. */
      amounts: { quantity: string; amount: string }[];
      code: string;
      inputUnit: 'hours' | 'days' | null;
      /** Localised, exactly as the single-value preview does it. Null when nothing divided by zero. */
      zeroDivisor: string | null;
    };

export async function previewTxnAmountsAction(input: {
  componentId: string;
  employmentId: string;
  companyId: string;
  payPeriod: string;
  unit: string | null;
  /** Already deduplicated and normalised by the caller. Capped server-side regardless. */
  quantities: string[];
}): Promise<TxnAmountsPreview> {
  const { s, scopeIds } = await scopedAdmin();
  if (!input.companyId || !scopeIds.includes(input.companyId)) return { ok: false, error: 'outOfScope' };
  if (!input.componentId || !input.employmentId) return { ok: true, derived: false };
  if (!isPayPeriod(input.payPeriod)) return { ok: false, error: 'periodInvalid' };
  // A month has at most 31 days, so 31 DISTINCT quantities is already the ceiling a real grid can reach.
  // The cap is here rather than only on the client because the client is not the authority on request size.
  const quantities = [...new Set(input.quantities)].slice(0, 31);
  if (quantities.length === 0) return { ok: true, derived: false };
  try {
    const results: { quantity: string; amount: string }[] = [];
    let code = '';
    let inputUnit: 'hours' | 'days' | null = null;
    let zeroDivisor: { divisor: string; step: number } | null = null;
    let anyDerived = false;
    for (const q of quantities) {
      const n = Number(q);
      if (!Number.isFinite(n)) continue;
      const d = await deriveIndividualTxnAmount(s, {
        componentId: input.componentId,
        employmentId: input.employmentId,
        companyId: input.companyId,
        payPeriod: input.payPeriod,
        quantity: n,
        unit: input.unit,
      });
      if (!d.derived) continue;
      anyDerived = true;
      code = d.code;
      inputUnit = d.inputUnit;
      // The FIRST zero divisor wins: it is one explanation about this employee and this month, not a
      // per-line fault, so reporting it once is reporting it correctly.
      if (d.zeroDivisor && !zeroDivisor) zeroDivisor = d.zeroDivisor;
      // PER-DAY ROUNDING, and it happens HERE, once, in the same `toFixed(2)` the single-entry preview and
      // the write both use. This is why five days of a split can total a cent away from the same hours
      // keyed as one figure — the amount shown against a date is the amount that date is worth.
      results.push({ quantity: q, amount: d.amount.toFixed(2) });
    }
    if (!anyDerived) return { ok: true, derived: false };
    const tr = await getTranslations('payRule');
    return {
      ok: true,
      derived: true,
      amounts: results,
      code,
      inputUnit,
      zeroDivisor: zeroDivisor
        ? tr('previewZeroDivisor', { divisor: tr(`operand_${zeroDivisor.divisor}` as never), step: zeroDivisor.step })
        : null,
    };
  } catch (e) {
    return { ok: false, error: txnErrorKey(e) };
  }
}

/** One dated line as the day-by-day grid submits it. `amount` is the typed figure and is IGNORED whenever
 *  the pay item works its own out — exactly as the single-entry form's is. */
export type DayByDayLineInput = {
  txnDate: string;
  amount: number;
  quantity: number | null;
  notes: string | null;
};

/**
 * 4e403268 — SAVE A WHOLE DAY-BY-DAY GRID, ALL LINES OR NONE.
 *
 * This is not a new write path. `createIndividualTxnsBulk` has taken many rows since 1.2.2 and does the
 * whole set in ONE transaction with all its guards re-checked inside it (draft re-check, company match,
 * batch-scope membership, date-in-period per row, amount > 0 per row, the Phase-3 component rules, and the
 * byte-identical-row refusal). Day-by-day is many rows for ONE employment, which is the easier half of what
 * that service already does — the multi-EMPLOYEE half is what 44129979 took off the screen, not off the
 * service. So the atomicity the request asks for ("save all valid entries in one transaction") is not
 * built here; it is inherited, and this action's job is to hand that service a correctly priced set.
 *
 * EVERY LINE IS PRICED SERVER-SIDE, one at a time, before any of them is written — the same
 * `amountForWrite` the single create calls. The browser's figure never survives on a calculating item.
 *
 * `source` is left NULL rather than written as the string 'manual'. Null already means manual
 * (`txnSourceOf`), so a hand-keyed row saved by this grid is byte-identical to the 47 already on
 * production and no backfill can ever be needed. The column is for the modules that will write something
 * else into it.
 */
export async function createIndividualTxnDayGridAction(input: {
  employmentId: string;
  companyId: string;
  payPeriod: string;
  batchId: string;
  kind: string;
  componentId: string | null;
  unit: string | null;
  /** c11e81aa — the chosen Pay Cycle for the WHOLE grid; see TxnFormInput.intendedCycleId. */
  intendedCycleId: string | null;
  lines: DayByDayLineInput[];
}): Promise<TxnActionResult & { count?: number }> {
  const { s, scopeIds } = await scopedAdmin();
  if (!input.companyId || !scopeIds.includes(input.companyId)) return { ok: false, error: 'outOfScope' };
  if (!input.employmentId) return { ok: false, error: 'noEmployeesSelected' };
  if (!input.batchId && !isPayPeriod(input.payPeriod)) return { ok: false, error: 'periodInvalid' };
  if (input.lines.length === 0) return { ok: false, error: 'dayGridEmpty' };
  const targetImpact = input.batchId ? await batchEditImpact(s, { batchId: input.batchId }) : null;
  // The month the rules resolve against: the RUN's when there is one (the service does the same), so the
  // form field and the run can never price against different months.
  const payPeriod = input.batchId ? (targetImpact?.payPeriod ?? input.payPeriod) : input.payPeriod;
  try {
    const rows = [];
    for (const l of input.lines) {
      const amount = await amountForWrite(s, {
        componentId: input.componentId,
        employmentId: input.employmentId,
        companyId: input.companyId,
        payPeriod,
        quantity: l.quantity,
        unit: input.unit,
        typed: l.amount,
      });
      rows.push({
        kind: input.kind,
        txnDate: l.txnDate,
        amount,
        quantity: l.quantity,
        unit: input.unit,
        notes: l.notes,
        componentId: input.componentId,
        // See the doc above: null IS 'manual'.
        source: null,
        sourceRef: null,
      });
    }
    const { ids } = await createIndividualTxnsBulk(s, {
      ...(input.batchId ? { batchId: input.batchId } : { companyId: input.companyId, payPeriod: input.payPeriod }),
      employmentIds: [input.employmentId],
      rows,
      intendedCycleId: input.intendedCycleId,
    });
    revalidatePath('/payroll/transactions/individual');
    return {
      ok: true,
      id: ids[0],
      count: ids.length,
      ...(targetImpact?.status === 'processed' && input.batchId ? { recalcBatchId: input.batchId } : {}),
    };
  } catch (e) {
    return txnFailure(e);
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
      intendedCycleId: input.intendedCycleId,
    });
    revalidatePath('/payroll/transactions/individual');
    return {
      ok: true,
      id: ids[0],
      ...(targetImpact?.status === 'processed' && input.batchId ? { recalcBatchId: input.batchId } : {}),
    };
  } catch (e) {
    return txnFailure(e);
  }
}

/**
 * Edit one existing transaction in place. The service re-validates everything (draft-or-unattached,
 * date-in-period, amount>0, component coherence), so this only fences the company scope first — an
 * out-of-scope id must not even reach the service, or the failure would leak that the row exists.
 */
export async function updateIndividualTxnAction(
  input: Omit<TxnFormInput, 'employmentId' | 'batchId' | 'payPeriod' | 'intendedCycleId'> & {
    id: string;
    /**
     * c11e81aa — OPTIONAL here where it is required on create, and the difference is meaningful. An edit
     * form that has no cycle catalogue to offer (a company with no configured Payroll Cycles) must leave
     * the stored choice ALONE rather than send null and clear it; omitting the field is how it says so.
     */
    intendedCycleId?: string | null;
  },
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
      ...(input.intendedCycleId !== undefined ? { intendedCycleId: input.intendedCycleId } : {}),
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
    return txnFailure(e);
  }
}

/** What the add-to-run offer did. `added: false` is a SUCCESS: the run already covered this employee
 *  (somebody else widened it first, or the run is whole-company), so the save the operator came to make
 *  will now go through — which is the only thing they asked for. */
export type TxnScopeAddResult =
  | { ok: true; added: boolean; markedForRecalc: boolean; payPeriod: string; recalcBatchId?: string }
  | { ok: false; error: string };

/**
 * 4b909202 — ADD THE REFUSED EMPLOYEE TO THE RUN, the way forward the scope refusal now offers.
 *
 * The ids are the ones the SERVICE put on the error it threw, round-tripped through the screen, so this
 * cannot be used to widen a run the operator was never refused on — and it is fenced to their own
 * companies regardless, exactly as every other action here is, before the service is reached at all.
 *
 * It deliberately does NOT save the transaction. Widening a run and posting money onto it are two
 * decisions, they have two different audit trails, and folding them into one click would mean an
 * operator who wanted to reconsider the amount had already changed the run. The screen re-submits the
 * form itself once this returns, from the values still on screen.
 */
export async function addEmployeeToRunAction(input: TxnScopeFix): Promise<TxnScopeAddResult> {
  const { s, scopeIds } = await scopedAdmin();
  if (!input.batchId || !input.employmentId) return { ok: false, error: 'periodInvalid' };
  // The run must live in a company this admin administers — the same fence, read the same way, as
  // `fetchBatchImpactAction`. A run outside it reads as absent rather than as a refusal, so this can
  // never confirm that some other tenant-mate company holds a run with that id.
  const impact = await batchEditImpact(s, { batchId: input.batchId });
  if (!impact || !scopeIds.includes(impact.companyId)) return { ok: false, error: 'txnNotFound' };
  try {
    const r = await addEmploymentToBatchScope(s, { batchId: input.batchId, employmentId: input.employmentId });
    revalidatePath('/payroll/transactions/individual');
    return {
      ok: true,
      added: r.added,
      markedForRecalc: r.markedForRecalc,
      payPeriod: r.payPeriod,
      // Same contract as a save: the run that now owes a recalculation, so the screen can link the
      // operator straight to it. Set from the SERVICE's own answer, never re-derived here.
      ...(r.markedForRecalc ? { recalcBatchId: input.batchId } : {}),
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
    return txnFailure(e);
  }
}
