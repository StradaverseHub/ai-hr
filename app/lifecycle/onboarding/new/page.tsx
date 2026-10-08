import { getTranslations } from 'next-intl/server';
import { Button, Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { LEVEL, getCompanyConfig, listCustomFields, listMyCompanies } from '@/packs/lifecycle/service';
import { lifecycleSession } from '../../_guard';
import { ScopedFields } from '../../_scoped-fields';
import { createOnboardingAction } from '../../actions';

export default async function NewOnboardingPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { s } = await lifecycleSession(LEVEL.agent);
  const t = await getTranslations('lifecycle');
  const { error } = await searchParams;
  const companies = await listMyCompanies(s);
  const [fields, configs] = await Promise.all([
    listCustomFields(s, 'onboarding'),
    Promise.all(companies.map(async (c) => [c.id, (await getCompanyConfig(s, c.id)).accessSystems] as const)),
  ]);
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('onboarding.new')} description={t('onboarding.newHint')} back={{ href: '/lifecycle/onboarding', label: t('onboarding.title') }} />
      <ErrorBanner message={error} />
      <Card className="p-4">
        <form action={createOnboardingAction} className="grid gap-3 sm:grid-cols-2">
          <Field label={t('case.name')} required><input name="fullName" required className={inputCls} /></Field>
          <Field label={t('case.employeeNo')} required><input name="employeeNo" required className={inputCls} /></Field>
          <Field label={t('case.joinDate')} required><input name="joinDate" type="date" required className={inputCls} /></Field>
          <Field label={t('case.jobTitle')}><input name="jobTitle" className={inputCls} /></Field>
          <Field label={t('case.department')}><input name="department" className={inputCls} /></Field>
          <Field label={t('case.supervisor')}><input name="supervisor" className={inputCls} /></Field>
          <Field label={t('case.gbsTa')}><input name="gbsTa" className={inputCls} /></Field>
          <Field label={t('case.hireType')}>
            <select name="hireType" className={inputCls}><option value="new_hire">{t('case.hireTypes.new_hire')}</option><option value="replacement">{t('case.hireTypes.replacement')}</option></select>
          </Field>
          <Field label={t('case.replacedPerson')}><input name="replacedPerson" className={inputCls} /></Field>
          <Field label={t('case.newhireEmail')}><input name="newhireEmail" type="email" className={inputCls} /></Field>
          <ScopedFields companies={companies} systems={Object.fromEntries(configs)} fields={fields.filter((f) => f.active)} showSystems />
          <div className="col-span-full grid gap-3 sm:grid-cols-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="laptopRequired" defaultChecked className="size-4" />{t('case.laptopRequired')}</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="carparkRequired" className="size-4" />{t('case.carparkRequired')}</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="emailRequired" defaultChecked className="size-4" />{t('case.emailRequired')}</label>
          </div>
          <Field label={t('case.deviceType')}><input name="deviceType" className={inputCls} /></Field>
          <Field label={t('case.floorBuilding')}><input name="floorBuilding" className={inputCls} /></Field>
          <fieldset className="col-span-full grid gap-3 rounded-md border border-dashed border-border p-3 sm:grid-cols-2">
            <legend className="px-1 text-xs text-muted-foreground">{t('case.staffOnly')}</legend>
            <Field label={t('case.costCentre')}><input name="costCentre" className={inputCls} /></Field>
            <Field label={t('case.idNumber')}><input name="nricPassport" autoComplete="off" className={inputCls} /></Field>
          </fieldset>
          <Field label={t('common.notes')} className="col-span-full"><textarea name="notes" rows={2} className={`${inputCls} h-auto py-2`} /></Field>
          <div className="col-span-full"><Button type="submit">{t('onboarding.create')}</Button></div>
        </form>
      </Card>
    </div>
  );
}
