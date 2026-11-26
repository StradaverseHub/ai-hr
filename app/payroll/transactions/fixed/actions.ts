'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
import {
  FixedTransactionAmountError,
  FixedTransactionBackwardsError,
  FixedTransactionCycleError,
  FixedTransactionDateError,
  FixedTransactionMidMonthError,
  FixedTransactionNotFoundError,
  FixedTransactionOverlapError,
  FixedTransactionPaidError,
  UnsupportedFixedCurrencyError,
  archiveEmploymentPayComponent,
  addFixedTransaction,
} from '@/core/pay-components';
// cc8bd87f — the View / Edit pop-up's service entry point and its two refusals, through the pack facade.
import {
  FixedTransactionEndClosedMonthError,
  FixedTransactionEndSameMonthError,
  editFixedTransaction,
} from '@/packs/payroll/service';
import { FIXED_ERROR_KEYS, FIXED_ERROR_QS, type FixedErrorArgs } from './edit-model';

const back = (employmentId: string | null, qs: string) =>
  redirect(
    `/payroll/transactions/fixed${employmentId ? `?employmentId=${encodeURIComponent(employmentId)}&` : '?'}${qs}`,
  );

/**
 * Fixed Transaction (feedback b7fc8583) — create a recurring fixed pay component for the selected employee
 * from the self-contained screen. requireAdmin() FIRST (via scopedAdmin) — NOT getSession() — so a
 * non-admin gets a clean redirect, not a raw RLS violation. The employmentId is RE-VALIDATED against the
 * admin's scoped employee list (RLS isolates tenants, not company scope), so a URL-tampered out-of-scope id
 * is rejected. Typed service errors map to localised ?error= keys the page resolves.
 */
export async function createFixedTransactionAction(formData: FormData) {
  const { s, scopeIds } = await scopedAdmin();
  const employmentId = String(formData.get('employmentId') ?? '');

  // Scope-guard: the target employment must be in the admin's scoped list (mirror the page's guard).
  const employees = await listEmployees(s, scopeIds);
  if (!employmentId || !employees.some((e) => e.employmentId === employmentId)) {
    return back(null, 'error=outOfScope');
  }

  const componentId = String(formData.get('componentId') ?? '');
  const effectiveFrom = String(formData.get('effectiveFrom') ?? '');
  // 4fffe638 — the CONFIGURED Payroll Cycle (one of the employee's company's active cycles). The run type
  // is no longer posted: the service sets it from the cycle row, never from the client.
  const payrollCycleId = String(formData.get('payrollCycleId') ?? '');
  const amount = Number(formData.get('amount'));
  const effectiveTo = String(formData.get('effectiveTo') ?? '').trim() || null;
  const remarks = String(formData.get('remarks') ?? '').trim() || null;

  // Mandatory fields (pay item, cycle, start date, amount). Empty / bad values surface a friendly banner
  // rather than a raw throw. Amount>0 is enforced on the service too (both editors), but we short-circuit an
  // obviously-empty amount here for a cleaner message.
  if (!componentId || !payrollCycleId || !effectiveFrom || !(amount > 0)) {
    return back(employmentId, 'error=required');
  }

  try {
    await addFixedTransaction(s, {
      employmentId,
      componentId,
      amount,
      effectiveFrom,
      effectiveTo,
      remarks,
      // Validated inside the service against the EMPLOYMENT's company (missing / inactive / other-company
      // refused with FixedTransactionCycleError → `cycleInvalid`); the row's run type comes from the cycle.
      payrollCycleId,
    });
  } catch (e) {
    return back(employmentId, fixedErrorQs(e));
  }

  revalidatePath('/payroll/transactions/fixed');
  return back(employmentId, 'toast=saved');
}

/** Map a typed pay-component error to a localised ?error= key the page resolves; else the raw message. */
function fixedErrorKey(e: unknown): string {
  return e instanceof FixedTransactionDateError
    ? 'dateError'
    : e instanceof UnsupportedFixedCurrencyError
      ? 'currencyUnsupported'
      : e instanceof FixedTransactionAmountError
        ? 'amountError'
        : // 2aed39d4 — the save would have covered days a live record for the same pay item already
          // covers. The clashing row's code and dates ride along in `fixedErrorQs` so the banner can
          // name it, which is the whole point of refusing here rather than letting Postgres 23P01 out.
          e instanceof FixedTransactionOverlapError
          ? 'overlap'
          : // 2aed39d4 — split out of dateError, which said "End date cannot be before the start date"
            // and named entirely the wrong field: nothing is wrong with the end date here.
            e instanceof FixedTransactionBackwardsError
            ? 'backwards'
            : // a3d485f6 — the change would take effect part-way through a month while a live record for
              // the same pay item still covers part of that month, which pays BOTH in full. The message
              // has to name a date the operator can use instead, so `nextFirstOfMonth` rides along in
              // `fixedErrorQs` exactly like the clash identity does.
              e instanceof FixedTransactionMidMonthError
              ? 'midMonth'
              : // Removal/edit refused because a CLOSED run covers the row's window (2aed39d4 changed this
              // from "paid on a processed payslip" — see FixedTransactionPaidError). Mapped to a
              // localised key rather than falling through to `(e as Error).message`, which would put the
              // service's raw English into the URL and onto the screen.
              e instanceof FixedTransactionPaidError
              ? 'paidOnPayslip'
              : e instanceof FixedTransactionNotFoundError
                ? 'notFound'
                : // 4fffe638 — the chosen Payroll Cycle is missing, inactive or another company's.
                  e instanceof FixedTransactionCycleError
                  ? 'cycleInvalid'
                  : // cc8bd87f — the pop-up's in-place end-date change refusals.
                    e instanceof FixedTransactionEndClosedMonthError
                    ? 'endClosedMonth'
                    : e instanceof FixedTransactionEndSameMonthError
                      ? 'endSameMonth'
                      : publicErrorMessage(e);
}

/**
 * The refusal as a key plus its ICU arguments. The messages for `overlap` / `backwards` / `paidOnPayslip` /
 * `midMonth` / `endClosedMonth` / `endSameMonth` take arguments; a key on its own would render "{code}"
 * literally, so the values travel with the key.
 *
 * Only ever built from a TYPED error's own fields (a catalog code, ISO dates and a pay period), never from
 * raw form input. cc8bd87f split this out of `fixedErrorQs` so the pop-up's value-returning actions and the
 * redirecting ones describe a refusal identically.
 */
function fixedErrorResult(e: unknown): { error: string; args: FixedErrorArgs } {
  const error = fixedErrorKey(e);
  const args: FixedErrorArgs = {};
  if (e instanceof FixedTransactionOverlapError || e instanceof FixedTransactionBackwardsError) {
    args.code = e.code;
    args.from = e.validFrom;
    if (e.validTo != null) args.to = e.validTo;
  }
  if (e instanceof FixedTransactionPaidError || e instanceof FixedTransactionEndClosedMonthError) {
    args.code = e.code;
    args.period = e.payPeriod;
  }
  // a3d485f6 — the mid-month refusal names the pay item AND the date to use instead (computed in core
  // from the tenant's MYT calendar day).
  if (e instanceof FixedTransactionMidMonthError) {
    args.code = e.code;
    args.nextFirst = e.nextFirstOfMonth;
  }
  // cc8bd87f — the next line's start and the latest end date that pays once.
  if (e instanceof FixedTransactionEndSameMonthError) {
    args.code = e.code;
    args.from = e.nextFrom;
    args.latestEnd = e.latestEnd;
  }
  return { error, args };
}

/**
 * The full `error=…` query fragment for a failed write: the key, then each argument under the name the
 * list page reads (FIXED_ERROR_QS). Every value is encoded; the page re-reads them as opaque strings and
 * passes them straight to next-intl.
 */
function fixedErrorQs(e: unknown): string {
  const { error, args } = fixedErrorResult(e);
  const qs = new URLSearchParams({ error });
  for (const name of Object.keys(FIXED_ERROR_QS) as (keyof FixedErrorArgs)[]) {
    const value = args[name];
    if (value != null) qs.set(FIXED_ERROR_QS[name], value);
  }
  return qs.toString();
}

/**
 * The admin's session when the supplied employmentId is in their company scope, else null. RLS isolates
 * tenants, not company scope — so a URL-tampered out-of-scope id must be rejected here, exactly like the
 * create action. Does not redirect: the pop-up's actions answer with a value, the archive action redirects.
 */
async function scopedEmploymentSession(employmentId: string) {
  const { s, scopeIds } = await scopedAdmin();
  const employees = await listEmployees(s, scopeIds);
  if (!employmentId || !employees.some((e) => e.employmentId === employmentId)) return null;
  return s;
}

/** Re-validate the employment's scope; on failure issue the out-of-scope redirect and return null. */
async function requireScopedEmployment(employmentId: string) {
  const s = await scopedEmploymentSession(employmentId);
  if (!s) {
    back(null, 'error=outOfScope');
    return null;
  }
  return s;
}

/**
 * cc8bd87f — what the View / Edit pop-up's two actions answer with. A refusal carries the localised key and
 * its ICU arguments (the island resolves them under payroll.transactions.fixed), or the public error text
 * when the key is not one the screen has a sentence for.
 */
export type FixedDialogResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: string; args: FixedErrorArgs };

const refused = (e: unknown): FixedDialogResult => {
  const { error, args } = fixedErrorResult(e);
  return { ok: false, error, args: FIXED_ERROR_KEYS.has(error) ? args : {} };
};

/**
 * cc8bd87f — SAVE from the View / Edit pop-up (app/payroll/transactions/fixed/edit-fixed-dialog.tsx). It
 * replaces the old page's two forms, Edit (updateFixedTransactionAction) and Stop
 * (endFixedTransactionAction), which both wrote the same stored end date. `editFixedTransaction` decides how:
 * nothing changed writes nothing; only the End Date (Last Date to Pay) changed updates the same row; anything
 * else versions it exactly as Edit did.
 *
 * VALUE-RETURNING, not redirecting: a refused save must leave the pop-up open with the typing intact and the
 * message inside it. The scope guard is the create action's, repeated here.
 */
export async function saveFixedTransactionDialogAction(
  _prev: FixedDialogResult | null,
  formData: FormData,
): Promise<FixedDialogResult> {
  const employmentId = String(formData.get('employmentId') ?? '');
  const s = await scopedEmploymentSession(employmentId);
  if (!s) return { ok: false, error: 'outOfScope', args: {} };

  const id = String(formData.get('id') ?? '');
  const effectiveFrom = String(formData.get('effectiveFrom') ?? '');
  // 4fffe638 — THE SELECT IS ALWAYS SUBMITTED, so its presence says nothing about whether the operator
  // changed it (CLAUDE.md §8). The hidden `cycleTouched` flag is flipped to '1' by the select's onChange;
  // only then is the cycle sent. Untouched, the service keeps the row's own payroll_cycle_id and run_type —
  // including a link to a cycle since made inactive.
  const cycleTouched = String(formData.get('cycleTouched') ?? '') === '1';
  const payrollCycleId = String(formData.get('payrollCycleId') ?? '');
  const amount = Number(formData.get('amount'));
  const effectiveTo = String(formData.get('effectiveTo') ?? '').trim() || null;
  const remarks = String(formData.get('remarks') ?? '').trim() || null;

  if (!id || !effectiveFrom || !(amount > 0)) return { ok: false, error: 'required', args: {} };

  let changed: boolean;
  try {
    ({ changed } = await editFixedTransaction(s, {
      id,
      employmentId,
      amount,
      effectiveFrom,
      effectiveTo,
      remarks,
      ...(cycleTouched && payrollCycleId ? { payrollCycleId } : {}),
    }));
  } catch (e) {
    return refused(e);
  }

  // Saving with nothing changed wrote nothing, so there is nothing to re-read.
  if (changed) revalidatePath('/payroll/transactions/fixed');
  return { ok: true, changed };
}

/**
 * cc8bd87f — REMOVE from inside the View / Edit pop-up, behind the same confirmation question as before
 * (ConfirmSubmit). The same service as archiveFixedTransactionAction, answering with a value so a refusal
 * (a CLOSED run covers the item) shows inside the pop-up.
 */
export async function removeFixedTransactionDialogAction(
  _prev: FixedDialogResult | null,
  formData: FormData,
): Promise<FixedDialogResult> {
  const employmentId = String(formData.get('employmentId') ?? '');
  const s = await scopedEmploymentSession(employmentId);
  if (!s) return { ok: false, error: 'outOfScope', args: {} };
  const id = String(formData.get('id') ?? '');
  if (!id) return { ok: false, error: 'required', args: {} };
  try {
    await archiveEmploymentPayComponent(s, { id, employmentId });
  } catch (e) {
    return refused(e);
  }
  revalidatePath('/payroll/transactions/fixed');
  return { ok: true, changed: true };
}

/**
 * Enhancement (feedback 1e2704f2) — REMOVE/ARCHIVE (void) a fixed transaction: it is dropped from the list
 * and excluded from payroll entirely. Confirmation is enforced in the UI (ConfirmSubmit). Scope-guarded.
 */
export async function archiveFixedTransactionAction(formData: FormData) {
  const employmentId = String(formData.get('employmentId') ?? '');
  const s = await requireScopedEmployment(employmentId);
  if (!s) return;

  const id = String(formData.get('id') ?? '');
  if (!id) {
    return back(employmentId, 'error=required');
  }

  try {
    await archiveEmploymentPayComponent(s, { id, employmentId });
  } catch (e) {
    // f1123afd — a REFUSED removal goes back to the item, not to a bare list: the message tells the
    // operator to end it from a date instead, and that field is on the item. cc8bd87f — the item is a
    // pop-up over the list now, so `edit=<id>` reopens it with the message inside.
    return back(employmentId, `edit=${encodeURIComponent(id)}&${fixedErrorQs(e)}`);
  }

  revalidatePath('/payroll/transactions/fixed');
  // A successful removal goes to the list without `edit`: the item no longer exists to show (the read
  // excludes superseded rows).
  return back(employmentId, 'toast=deleted');
}
