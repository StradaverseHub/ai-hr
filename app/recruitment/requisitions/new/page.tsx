import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, Field, PageHeader, btnGhost, btnPrimary } from '@/components/ui';
import { requisitionFormOptions } from '@/packs/recruitment/service';
import { createRequisitionAction } from '../../actions';
import { NoRecruitmentCompany, pickCompany, recruitmentAccess, recruitmentErrorText, selectCls } from '../../shared';
import { RequisitionFields } from '../requisition-fields';

/** Recruitment › Job requisitions › New. Saved as a Draft; the HC number is given automatically. */
export default async function NewRequisitionPage({ searchParams }: { searchParams: Promise<{ company?: string; problem?: string; fields?: string }> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const companies = await recruitmentAccess(s, scopeIds, false);
  const sp = await searchParams;
  const t = await getTranslations('recruitment.req');
  const company = pickCompany(companies, sp.company);
  const back = { href: '/recruitment/requisitions', label: t('back') };
  if (!company) return <div className="w-full space-y-5"><PageHeader title={t('newTitle')} back={back} /><NoRecruitmentCompany /></div>;
  const options = await requisitionFormOptions(s, company.id);
  const error = await recruitmentErrorText(sp.problem);
  const fields = (sp.fields ?? '').split(',').filter(Boolean);
  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <PageHeader title={t('newTitle')} description={t('newPurpose')} back={back} />
      <ErrorBanner message={error && fields.length ? `${error} ${fields.filter((f) => t.has(`fieldNames.${f}`)).map((f) => t(`fieldNames.${f}`)).join(', ')}` : error} />
      {companies.length > 1 && (
        <form method="get" className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-4">
          <Field label={t('company')} className="min-w-64">
            <select name="company" defaultValue={company.id} className={selectCls}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <button type="submit" className={btnGhost}>{t('switchCompany')}</button>
        </form>
      )}
      <form action={createRequisitionAction} className="space-y-5">
        <input type="hidden" name="companyId" value={company.id} />
        <section className="space-y-4 rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">{t('detailsSection')} <span className="font-normal text-muted-foreground">· {company.name}</span></h2>
          <RequisitionFields options={options} />
        </section>
        <div className="flex gap-2">
          <button type="submit" className={btnPrimary}>{t('saveDraft')}</button>
          <Link href="/recruitment/requisitions" className={btnGhost}>{t('cancel')}</Link>
        </div>
      </form>
    </div>
  );
}
