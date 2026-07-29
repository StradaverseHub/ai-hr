'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { setPayrollConfig } from '@/core/payroll-config';

const PAGE = '/admin/payroll-config';
const back = (toast: string) => redirect(`${PAGE}?toast=${encodeURIComponent(toast)}`);
const fail = (e: unknown) => redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);

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
    revalidatePath(PAGE);
    back('Payroll config saved');
  } catch (e) {
    fail(e);
  }
}
