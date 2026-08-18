'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { setPayrollConfig } from '@/core/payroll-config';
import { configCompanyHref, configEditHref } from './nav';

const PAGE = '/admin/payroll-config';

/**
 * 6df24751 — WHERE A SAVE LANDS, now that the screen is company-first.
 *
 * This action used to redirect to one page, because there WAS one page: every company's form was rendered
 * on it at once. There are three routes now (company listing · one company's settings · edit), so:
 *   • success ⇒ that company's read screen, where the saved values are what you now see;
 *   • failure ⇒ back to the edit form, so the rejection is shown on the fields it is about.
 * `q` is the listing's search term, threaded through the form as a hidden input so a save does not quietly
 * discard it.
 *
 * The COMPANY is taken from the form, exactly as before — it was never derived from the URL, and
 * setPayrollConfig + RLS (can_admin_payroll_for) remain the authority on whether the write is allowed.
 */
const withParam = (href: string, kind: 'toast' | 'error', value: string) =>
  `${href}${href.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(value)}`;

const str = (fd: FormData, k: string): string | undefined => {
  const v = String(fd.get(k) ?? '').trim();
  return v || undefined;
};

/**
 * Save a company's payroll schedule (#17).
 *
 * r79a (4fb8b75a step 4) — this action NO LONGER writes the company statutory block. That record has one
 * owner now: Organization → Statutory (app/admin/actions.ts → pack.companyStatutory.set). It used to be
 * written from both screens with no coordination, so an admin editing the payroll screen would silently
 * overwrite an Organization edit made minutes earlier with whatever this form happened to have rendered.
 * The fields are rendered read-only here, and the write is gone — a hand-crafted POST carrying
 * `hrdfStatus` or `epfEmployerNo` now changes nothing, which is the point: removing the field from the
 * form alone would not have closed the second writer.
 *
 * Step 3 also removed probationMonths / reviewReminderDays / defaultCurrency from this submit; they are
 * saved by /admin/personnel/settings and Organization → General respectively. setPayrollConfig is a
 * full-overwrite upsert, so the columns are gone from the input type rather than merely unread.
 */
export async function savePayrollConfigAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const q = String(formData.get('q') ?? '') || undefined;
  // Step 6 (f3148da1) — assemble the payslip-release blob from the mode + value; cleanPayslipRelease
  // validates + clamps (fixed_day → day, relative → offsetDays; 'immediate' or a blank value ⇒ null).
  const releaseMode = str(formData, 'payslipReleaseMode') ?? 'immediate';
  const releaseValueRaw = str(formData, 'payslipReleaseValue');
  const releaseValue = releaseValueRaw !== undefined ? Number(releaseValueRaw) : undefined;
  const payslipRelease =
    releaseMode === 'fixed_day'
      ? { mode: 'fixed_day' as const, day: releaseValue }
      : releaseMode === 'relative'
        ? { mode: 'relative' as const, offsetDays: releaseValue }
        : { mode: 'immediate' as const };
  let ok = false;
  let err = '';
  try {
    await setPayrollConfig(s, {
      companyId,
      cutOffDay: str(formData, 'cutOffDay') ?? null,
      payDay: str(formData, 'payDay') ?? null,
      overtimeCutOffDay: str(formData, 'overtimeCutOffDay') ?? null,
      claimCutOffDay: str(formData, 'claimCutOffDay') ?? null,
      unpaidLeaveCutOffDay: str(formData, 'unpaidLeaveCutOffDay') ?? null,
      attendanceCutOffDay: str(formData, 'attendanceCutOffDay') ?? null,
      defaultPayrollPolicyId: str(formData, 'defaultPayrollPolicyId') ?? null,
      payslipRelease,
    });
    ok = true;
  } catch (e) {
    err = (e as Error).message;
  }
  // The subtree, not just the listing: the saved values appear on three routes, two of them behind a
  // dynamic segment — hence the route PATTERN plus 'layout', the form Next 16 requires for one.
  revalidatePath(PAGE);
  revalidatePath('/admin/payroll-config/[companyId]', 'layout');
  // OUTSIDE the try, which is not a style choice: `redirect()` works by THROWING, and the Next 16 docs
  // say so explicitly ("redirect should be called outside the try block when using try/catch"). Called
  // inside, its own throw was caught by the catch below and re-reported as a failure — every successful
  // save redirected to `?error=NEXT_REDIRECT`. The sibling payroll-cycle actions have always used this
  // ok/err shape; this one had not.
  redirect(
    ok
      ? withParam(configCompanyHref(companyId, q), 'toast', 'Payroll config saved')
      : withParam(configEditHref(companyId, q), 'error', err),
  );
}
