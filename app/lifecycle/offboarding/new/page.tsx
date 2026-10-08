import { getTranslations } from 'next-intl/server';
import { Button, Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { LEVEL, listCustomFields, listMyCompanies } from '@/packs/lifecycle/service';
import { lifecycleSession } from '../../_guard';
import { ScopedFields } from '../../_scoped-fields';
import { createOffboardingAction } from '../../actions';

export default async function NewOffboardingPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { s } = await lifecycleSession(LEVEL.agent);
  const t = await getTranslations('lifecycle');
  const { error } = await searchParams;
  const [companies, fields] = await Promise.all([listMyCompanies(s), listCustomFields(s, 'offboarding')]);
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('offboarding.new')} description={t('offboarding.newHint')} back={{ href: '/lifecycle/offboarding', label: t('offboarding.title') }} />
      <ErrorBanner message={error} />
      <Card className="p-4">
        <form action={createOffboardingAction} className="grid gap-3 sm:grid-cols-2">
          <Field label={t('case.name')} required><input name="fullName" required className={inputCls} /></Field>
          <Field label={t('case.employeeNo')} required><input name="employeeNo" required className={inputCls} /></Field>
          <Field label={t('offboarding.resignationDate')} required><input name="resignationDate" type="date" required className={inputCls} /></Field>
          <Field label={t('offboarding.lastWorkingDay')}><input name="lastWorkingDay" type="date" className={inputCls} /></Field>
          <Field label={t('case.jobTitle')}><input name="jobTitle" className={inputCls} /></Field>
          <Field label={t('case.department')}><input name="department" className={inputCls} /></Field>
          <Field label={t('case.supervisor')}><input name="supervisor" className={inputCls} /></Field>
          <Field label={t('case.gbsTa')}><input name="gbsTa" className={inputCls} /></Field>
          <Field label={t('offboarding.workLocation')}><input name="workLocation" className={inputCls} /></Field>
          <Field label={t('offboarding.balanceLeave')}><input name="balanceLeave" type="number" step="0.5" className={inputCls} /></Field>
          <ScopedFields companies={companies} systems={{}} fields={fields.filter((f) => f.active)} showSystems={false} />
          <Field label={t('common.notes')} className="col-span-full"><textarea name="notes" rows={2} className={`${inputCls} h-auto py-2`} /></Field>
          <p className="col-span-full text-xs text-muted-foreground">{t('offboarding.outcomeHint')}</p>
          <div className="col-span-full"><Button type="submit">{t('offboarding.create')}</Button></div>
        </form>
      </Card>
    </div>
  );
}
