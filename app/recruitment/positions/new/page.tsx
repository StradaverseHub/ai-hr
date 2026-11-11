import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, Field, PageHeader, btnGhost, btnPrimary } from '@/components/ui';
import { jobFormOptions, requisitionJobPrefill, POSITION_ATTRIBUTES, RecruitmentError } from '@/packs/recruitment/service';
import { createJobAction } from '../../actions';
import { NoRecruitmentCompany, pickCompany, recruitmentAccess, recruitmentErrorText, selectCls } from '../../shared';
import { JobInfoFields } from '../job-fields';

/**
 * Recruitment › Positions › New position. The company is chosen first; every list below is that company's.
 * "Create job" from a requisition (slice 4) arrives with ?requisition=<id>: the server reads the requisition (after
 * re-checking access) and pre-fills the form from it; the new job is associated with that requisition.
 */
export default async function NewRecruitmentPositionPage({ searchParams }: { searchParams: Promise<{ company?: string; problem?: string; fields?: string; requisition?: string }> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const companies = await recruitmentAccess(s, scopeIds, false);
  const sp = await searchParams;
  const t = await getTranslations('recruitment.job');
  const prefill = sp.requisition ? await requisitionJobPrefill(s, sp.requisition).catch((e) => { if (e instanceof RecruitmentError) return null; throw e; }) : null;
  const company = pickCompany(companies, prefill?.companyId ?? sp.company);
  const back = { href: '/recruitment/positions', label: t('backToPositions') };
  if (!company) return <div className="w-full space-y-5"><PageHeader title={t('newTitle')} back={back} /><NoRecruitmentCompany /></div>;
  const options = await jobFormOptions(s, company.id);
  const missing = (sp.fields ?? '').split(',').filter(Boolean);
  const error = await recruitmentErrorText(sp.problem);
  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <PageHeader title={t('newTitle')} description={t('newPurpose')} back={back} />
      <ErrorBanner message={error && missing.length ? `${error} ${missing.map((f) => t(`fieldNames.${f}`)).join(', ')}` : error} />
      {companies.length > 1 && !prefill && (
        <form method="get" className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-4">
          <Field label={t('company')} required requiredAriaLabel={t('required')} className="min-w-64">
            <select name="company" defaultValue={company.id} className={selectCls}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <button type="submit" className={btnGhost}>{t('switchCompany')}</button>
        </form>
      )}
      {prefill && <p className="text-sm text-muted-foreground">{t('fromRequisition', { number: prefill.reqNumber })}</p>}
      <form action={createJobAction} className="space-y-5">
        <input type="hidden" name="companyId" value={company.id} />
        {prefill && <input type="hidden" name="requisitionId" value={prefill.requisitionId} />}
        <section className="space-y-4 rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">{t('infoSection')} <span className="font-normal text-muted-foreground">· {company.name}</span></h2>
          <JobInfoFields options={options} values={prefill?.values} />
        </section>
        <section className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-2">
          <h2 className="text-sm font-semibold sm:col-span-2">{t('settingsSection')}</h2>
          <Field label={t('positionAttribute')}>
            <select name="positionAttribute" defaultValue="regular" className={selectCls}>
              {POSITION_ATTRIBUTES.map((v) => <option key={v} value={v}>{t(`positionAttributes.${v}`)}</option>)}
            </select>
            <span className="text-xs text-muted-foreground">{t('positionAttributeNote')}</span>
          </Field>
          <Field label={t('process')}>
            <select name="processId" defaultValue={options.processes.find((p) => p.enabled)?.id ?? ''} className={selectCls}>
              {options.processes.filter((p) => p.enabled).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label={t('recruiter')}>
            <select name="recruiterUserId" defaultValue={prefill?.recruiterUserId ?? s.userId ?? ''} className={selectCls}>
              <option value="">{t('none')}</option>
              {options.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
          <label className="flex items-center gap-2 self-end text-sm">
            <input type="checkbox" name="autoArchiveAfterReject" />{t('autoArchive')}
          </label>
        </section>
        <div className="flex gap-2">
          <button type="submit" className={btnPrimary}>{t('create')}</button>
          <Link href="/recruitment/positions" className={btnGhost}>{t('cancel')}</Link>
        </div>
      </form>
    </div>
  );
}
