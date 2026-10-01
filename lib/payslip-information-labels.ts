import { getTranslations } from 'next-intl/server';
import { PAYSLIP_INFORMATION_FIELDS, type PayslipInformationField } from '../core/payslip-information';
export async function payslipInformationLabels(identityIsPassport = false): Promise<Record<PayslipInformationField, string>> {
  const t = await getTranslations('payroll.payslipInformation');
  return Object.fromEntries(PAYSLIP_INFORMATION_FIELDS.map(k => [k, t(k === 'identityNumber' && identityIsPassport ? 'passport' : k)])) as Record<PayslipInformationField, string>;
}
