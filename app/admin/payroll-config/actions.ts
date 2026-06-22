'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { setPayrollConfig } from '@/core/payroll-config';
import { setCompanyStatutoryMY } from '@/localization/my/company-statutory';
import type { HrdfStatus } from '@/localization/my/statutory-tables';

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
  try {
    await setPayrollConfig(s, {
      companyId,
      cutOffDay: str(formData, 'cutOffDay') ?? null,
      payDay: str(formData, 'payDay') ?? null,
      paymentBasis: str(formData, 'paymentBasis') ?? 'monthly',
    });
    await setCompanyStatutoryMY(s, {
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
