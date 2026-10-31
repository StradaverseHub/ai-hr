import { getTranslations } from 'next-intl/server';
import { Button, Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { LEVEL, getCompanyConfig, listMyCompanies } from '@/packs/lifecycle/service';
import { lifecycleSession } from '../../_guard';
import { ScopedFields } from '../../_scoped-fields';
import { createRequisitionAction } from '../../actions';

export default async function NewRequisitionPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { s } = await lifecycleSession(LEVEL.agent);
  const t = await getTranslations('lifecycle');
  const { error } = await searchParams;
  const companies = await listMyCompanies(s);
  const configs = await Promise.all(companies.map(async (c) => [c.id, (await getCompanyConfig(s, c.id)).accessSystems] as const));
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('requisitions.new')} description={t('requisitions.newHint')} back={{ href: '/lifecycle/requisitions', label: t('requisitions.title') }} />
      <ErrorBanner message={error} />
      <Card className="p-4">
        <form action={createRequisitionAction} className="grid gap-3 sm:grid-cols-2">
          <Field label={t('case.name')} required><input name="fullName" required className={inputCls} /></Field>
          <Field label={t('case.employeeNo')} required><input name="employeeNo" required className={inputCls} /></Field>
          <Field label={t('case.jobTitle')}><input name="jobTitle" className={inputCls} /></Field>
          <Field label={t('case.department')}><input name="department" className={inputCls} /></Field>
          <Field label={t('requisitions.workLocation')}><input name="workLocation" className={inputCls} /></Field>
          <Field label={t('requisitions.contact')}><input name="contact" className={inputCls} /></Field>
          <Field label={t('requisitions.username')}><input name="username" className={inputCls} /></Field>
          <Field label={t('case.deviceType')}><input name="deviceType" className={inputCls} /></Field>
          <ScopedFields companies={companies} systems={Object.fromEntries(configs)} fields={[]} showSystems />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="laptopRequired" defaultChecked className="size-4" />{t('case.laptopRequired')}</label>
          <Field label={t('requisitions.accessories')} className="col-span-full"><input name="accessories" className={inputCls} /></Field>
          <Field label={t('common.notes')} className="col-span-full"><textarea name="notes" rows={2} className={`${inputCls} h-auto py-2`} /></Field>
          <div className="col-span-full"><Button type="submit">{t('requisitions.create')}</Button></div>
        </form>
      </Card>
    </div>
  );
}
