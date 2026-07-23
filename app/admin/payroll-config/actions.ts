'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { setPayrollConfig } from '@/core/payroll-config';
import { packFor } from '@/localization/registry';
import type { HrdfStatus } from '@/localization/country-pack';

const PAGE = '/admin/payroll-config';
const back = (toast: string) => redirect(`${PAGE}?toast=${encodeURIComponent(toast)}`);
const fail = (e: unknown) => redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);

const str = (fd: FormData, k: string): string | undefined => {
  const v = String(fd.get(k) ?? '').trim();
  return v || undefined;
};

/** Save a company's payroll schedule (#17) + statutory identity / HRDF band (#7) in one submit. */
export async function savePayrollConfigAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const rawHrdf = String(formData.get('hrdfStatus') ?? 'not_registered');
  const hrdfStatus = (['not_registered', 'mandatory', 'optional'] as const).includes(rawHrdf as never)
    ? (rawHrdf as HrdfStatus)
    : 'not_registered';
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
      paymentBasis: str(formData, 'paymentBasis') ?? 'monthly',
      overtimeCutOffDay: str(formData, 'overtimeCutOffDay') ?? null,
      claimCutOffDay: str(formData, 'claimCutOffDay') ?? null,
      unpaidLeaveCutOffDay: str(formData, 'unpaidLeaveCutOffDay') ?? null,
      attendanceCutOffDay: str(formData, 'attendanceCutOffDay') ?? null,
      probationMonths: str(formData, 'probationMonths') ?? null,
      reviewReminderDays: str(formData, 'reviewReminderDays') ?? null,
      defaultPayrollPolicyId: str(formData, 'defaultPayrollPolicyId') ?? null,
      payslipRelease,
      // 297ae65a — company default salary currency; cleanCurrency clamps invalid/absent to 'MYR'.
      defaultCurrency: str(formData, 'defaultCurrency') ?? null,
    });
    // Rung 5c — the company statutory write goes through the pack registry (ADR-0080 D1), not a direct
    // import. requirePackFor would fail closed for a non-MY company; packFor + guard keeps this action's
    // MY-only reality explicit while removing the localization/my import.
    const pack = packFor('MY');
    if (!pack) throw new Error('No localization pack for MY');
    await pack.companyStatutory.set(s, {
      companyId,
      hrdfStatus,
      epfEmployerNo: str(formData, 'epfEmployerNo'),
      socsoEmployerCode: str(formData, 'socsoEmployerCode'),
      lhdnEmployerNo: str(formData, 'lhdnEmployerNo'),
      myinvoisTin: str(formData, 'myinvoisTin'),
      ssmRegistrationNo: str(formData, 'ssmRegistrationNo'),
    });
    revalidatePath(PAGE);
    back('Payroll config saved');
  } catch (e) {
    fail(e);
  }
}
