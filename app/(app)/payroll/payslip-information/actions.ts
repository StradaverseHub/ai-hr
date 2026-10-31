'use server';
import { requirePayrollAccess } from '@/lib/authz';
import {
  setPayslipInformationSettings,
  copyPayslipInformationSettings,
  payslipInformationCopyRefusal,
} from '@/core/payslip-information-settings';
import { publicErrorMessage } from '@/lib/public-error';
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

/**
 * r389 (23bd49d9) — Copy to Companies. The core copies the source's SAVED setting all-or-nothing; its two
 * refusals are put into the reader's language here (naming the company when it is one of this tenant's),
 * and anything else goes through publicErrorMessage so a database failure never reaches the screen as SQL.
 */
export async function copyPayslipInformation(_state: {error: string; copiedTo: string[]}, form: FormData) {
  const ctx = await requirePayrollAccess();
  const companyId = String(form.get('companyId') ?? '');
  const t = await getTranslations('payroll.payslipInformation');
  let copiedTo: string[];
  try {
    copiedTo = (await copyPayslipInformationSettings(ctx, companyId, form.getAll('targetCompanyIds').map(String))).targetCompanyIds;
  } catch (e) {
    const refused = payslipInformationCopyRefusal(e);
    if (refused?.code === 'payslipCopyNoTargets') return {error: t('copyNoTargets'), copiedTo: []};
    if (refused?.code === 'payslipCopyTargetForbidden') {
      return {error: refused.companyName ? t('copyForbiddenNamed', {company: refused.companyName}) : t('copyForbidden'), copiedTo: []};
    }
    return {error: publicErrorMessage(e), copiedTo: []};
  }
  revalidatePath('/payroll/payslip-information');
  return {error: '', copiedTo};
}
