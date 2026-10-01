import { requirePayrollAccess, canManagePayroll } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { getPayslipInformationSettings } from '@/core/payslip-information-settings';
import { PAYSLIP_INFORMATION_FIELDS } from '@/core/payslip-information';
import { PageHeader, Button, inputCls } from '@/components/ui';
import { getTranslations } from 'next-intl/server';
import { SettingsForm } from './settings-form';
import { settingsBack } from '@/app/payroll/setup/back';
export default async function PayslipInformationPage({searchParams}: {searchParams: Promise<{company?: string; saved?: string}>}) {
  const ctx = await requirePayrollAccess();
  const sp = await searchParams;
  const t = await getTranslations('payroll.payslipInformation');
  const companies = (await listCompanies(ctx)).filter(c => canManagePayroll(ctx, c.id));
  const selected = companies.find(c => c.id === sp.company) ?? companies[0];
  const fields = selected ? await getPayslipInformationSettings(ctx, selected.id) : [];
  return <div className="space-y-6"><PageHeader title={t('title')} description={t('description')} back={await settingsBack()} />
    <form method="get" className="flex flex-wrap items-end gap-3"><label>{t('company')}<select name="company" defaultValue={selected?.id} className={inputCls}>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><Button type="submit">{t('load')}</Button></form>
    {sp.saved === '1' && <p role="status" className="text-emerald-700 dark:text-emerald-400">{t('saved')}</p>}
    {selected && <SettingsForm key={selected.id} companyId={selected.id} fields={fields}
      labels={Object.fromEntries([...PAYSLIP_INFORMATION_FIELDS, 'heading','saved','save','saving','saveError','cancel'].map(k => [k,t(k)]))}/>}

  </div>;
}
