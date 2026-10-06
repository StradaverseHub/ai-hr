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
  endEmploymentPayComponent,
  setEmploymentPayComponent,
  updateEmploymentPayComponent,
} from '@/core/pay-components';

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
    await setEmploymentPayComponent(s, {
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
                  : publicErrorMessage(e);
}

/**
 * The full `error=…` query fragment for a failed write, including the clashing row's identity when the
 * error carries one. The banner messages for `overlap` / `backwards` / `paidOnPayslip` take ICU
 * arguments; a key on its own would render "{code}" literally, so the values travel with the key.
 *
 * Only ever built from a TYPED error's own fields (a catalog code and two ISO dates), never from raw
 * form input, and every value is encoded — the page re-reads them as opaque strings and passes them
 * straight to next-intl.
 */
function fixedErrorQs(e: unknown): string {
  const key = fixedErrorKey(e);
  const qs = new URLSearchParams({ error: key });
  if (e instanceof FixedTransactionOverlapError || e instanceof FixedTransactionBackwardsError) {
    qs.set('clashCode', e.code);
    qs.set('clashFrom', e.validFrom);
    if (e.validTo != null) qs.set('clashTo', e.validTo);
  }
  if (e instanceof FixedTransactionPaidError) qs.set('clashPeriod', e.payPeriod);
  // a3d485f6 — the mid-month refusal names the pay item AND the date to use instead. `clashCode` is
  // reused for the code (the banner already passes it to every key) and `nextFirst` is its own argument,
  // an ISO date computed in core from the tenant's MYT calendar day.
  if (e instanceof FixedTransactionMidMonthError) {
    qs.set('clashCode', e.code);
    qs.set('nextFirst', e.nextFirstOfMonth);
  }
  return qs.toString();
}

/**
 * Re-validate that the supplied employmentId is in the admin's company scope (RLS isolates tenants, not
 * company scope — so a URL-tampered out-of-scope id must be rejected here, exactly like the create action).
 * Returns the session on success; on failure returns null after issuing the redirect (caller returns early).
 */
async function requireScopedEmployment(employmentId: string) {
  const { s, scopeIds } = await scopedAdmin();
  const employees = await listEmployees(s, scopeIds);
  if (!employmentId || !employees.some((e) => e.employmentId === employmentId)) {
    back(null, 'error=outOfScope');
    return null;
  }
  return s;
}

/**
 * Enhancement (feedback 1e2704f2) — EDIT an existing fixed transaction by versioning (see
 * updateEmploymentPayComponent). Repeats the scope-guard, maps typed errors to the localised keys, and
 * re-reads the list on success. Additive: the Add form and its action are untouched.
 */
export async function updateFixedTransactionAction(formData: FormData) {
  const employmentId = String(formData.get('employmentId') ?? '');
  const s = await requireScopedEmployment(employmentId);
  if (!s) return;

  const id = String(formData.get('id') ?? '');
  const effectiveFrom = String(formData.get('effectiveFrom') ?? '');
  // 4fffe638 — THE SELECT IS ALWAYS SUBMITTED, so its presence says nothing about whether the operator
  // changed it (CLAUDE.md §8). The hidden `cycleTouched` flag is flipped to '1' by the select's onChange
  // (fixed/cycle-select.tsx); only then is the cycle sent. Untouched, the service carries the edited
  // row's own payroll_cycle_id and run_type forward — including a link to a cycle since made inactive.
  const cycleTouched = String(formData.get('cycleTouched') ?? '') === '1';
  const payrollCycleId = String(formData.get('payrollCycleId') ?? '');
  const amount = Number(formData.get('amount'));
  const effectiveTo = String(formData.get('effectiveTo') ?? '').trim() || null;
  const remarks = String(formData.get('remarks') ?? '').trim() || null;

  if (!id || !effectiveFrom || !(amount > 0)) {
    return back(employmentId, 'error=required');
  }

  try {
    await updateEmploymentPayComponent(s, {
      id,
      employmentId,
      amount,
      effectiveFrom,
      effectiveTo,
      remarks,
      ...(cycleTouched && payrollCycleId ? { payrollCycleId } : {}),
    });
  } catch (e) {
    return back(employmentId, fixedErrorQs(e));
  }

  revalidatePath('/payroll/transactions/fixed');
  return back(employmentId, 'toast=saved');
}

/**
 * Enhancement (feedback 1e2704f2) — STOP a fixed transaction from a date (end-date it). The row keeps paying
 * through the end date, then drops out of the payroll calculation. Scope-guarded, error-mapped.
 */
export async function endFixedTransactionAction(formData: FormData) {
  const employmentId = String(formData.get('employmentId') ?? '');
  const s = await requireScopedEmployment(employmentId);
  if (!s) return;

  const id = String(formData.get('id') ?? '');
  const effectiveTo = String(formData.get('effectiveTo') ?? '').trim();
  if (!id || !effectiveTo) {
    return back(employmentId, 'error=required');
  }

  try {
    await endEmploymentPayComponent(s, { id, employmentId, effectiveTo });
  } catch (e) {
    return back(employmentId, fixedErrorQs(e));
  }

  revalidatePath('/payroll/transactions/fixed');
  return back(employmentId, 'toast=saved');
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
    // f1123afd — a REFUSED removal goes back to the item's own page, not to the list. The message tells
    // the operator to end it from a date instead, and that form is on that page; bouncing them to the
    // list would make them find their way back to the thing they were told to do.
    return redirect(
      `/payroll/transactions/fixed/${encodeURIComponent(id)}?employmentId=${encodeURIComponent(employmentId)}&${fixedErrorQs(e)}`,
    );
  }

  revalidatePath('/payroll/transactions/fixed');
  // A successful removal DOES go to the list: the item's page no longer has an item to show (the read
  // excludes superseded rows), so returning to it would be a 404.
  return back(employmentId, 'toast=deleted');
}
