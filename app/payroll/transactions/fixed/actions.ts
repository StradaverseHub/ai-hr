'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
import {
  FixedTransactionAmountError,
  FixedTransactionDateError,
  UnsupportedFixedCurrencyError,
  setEmploymentPayComponent,
  type FixedTransactionCycle,
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
  const runType = String(formData.get('runType') ?? '');
  const amount = Number(formData.get('amount'));
  const effectiveTo = String(formData.get('effectiveTo') ?? '').trim() || null;
  const remarks = String(formData.get('remarks') ?? '').trim() || null;

  // Mandatory fields (pay item, cycle, start date, amount). Empty / bad values surface a friendly banner
  // rather than a raw throw. Amount>0 is enforced on the service too (both editors), but we short-circuit an
  // obviously-empty amount here for a cleaner message.
  if (!componentId || !runType || !effectiveFrom || !(amount > 0)) {
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
      // Cleaned to the enum (or null) inside the service; an unknown value never persists.
      runType: runType as FixedTransactionCycle,
    });
  } catch (e) {
    const key =
      e instanceof FixedTransactionDateError
        ? 'dateError'
        : e instanceof UnsupportedFixedCurrencyError
          ? 'currencyUnsupported'
          : e instanceof FixedTransactionAmountError
            ? 'amountError'
            : (e as Error).message;
    return back(employmentId, `error=${encodeURIComponent(key)}`);
  }

  revalidatePath('/payroll/transactions/fixed');
  return back(employmentId, 'toast=saved');
}
