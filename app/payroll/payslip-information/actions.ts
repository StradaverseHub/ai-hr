'use server';
import { requirePayrollAccess } from '@/lib/authz';
import { setPayslipInformationSettings } from '@/core/payslip-information-settings';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
export async function savePayslipInformation(_state: {error: string; saved: boolean}, form: FormData) {
  const ctx = await requirePayrollAccess();
  const companyId = String(form.get('companyId') ?? '');
  const t = await getTranslations('payroll.payslipInformation');
  try { await setPayslipInformationSettings(ctx, companyId, form.getAll('fields').map(String)); }
  catch { return {error: t('saveError'), saved: false}; }
  revalidatePath('/payroll/payslip-information');
  return {error: '', saved: true};
}
