import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, Field, PageHeader, btnGhost, btnPrimary } from '@/components/ui';
import {
  jobFormOptions, newPositionFromTemplate, positionTemplateChoices, requisitionJobPrefill, POSITION_ATTRIBUTES, RecruitmentError,
} from '@/packs/recruitment/service';
import { createJobFormAction } from '../../actions';
import { ActionForm, FieldProblem } from '../../action-form';
import { NoRecruitmentCompany, pickCompany, recruitmentAccess, recruitmentErrorText, selectCls } from '../../shared';
import { JobInfoFields } from '../job-fields';
import { CustomFieldInputs } from '../../custom-fields-ui';
import { InterviewPlanInputs, TemplateNotes } from '../interview-plan';

const soft = <T,>(p: Promise<T>): Promise<T | null> => p.catch((e) => { if (e instanceof RecruitmentError) return null; throw e; });

/**
 * Recruitment › Positions › New position. The company is chosen first; every list below is that company's.
 * "Create job" from a requisition (slice 4) arrives with ?requisition=<id>: the server reads the requisition (after
 * re-checking access) and pre-fills the form from it; the new job is associated with that requisition.
 * Slice 15: while the company's templates are on, "New position from template" (?template=<id>, with or without a requisition)
 * opens this same form pre-filled from the template — parts no longer usable are left empty with a note, and a requisition's
 * values win over the template's. Nothing is saved until the person saves; the job records the template it came from.
 */
export default async function NewRecruitmentPositionPage({ searchParams }: { searchParams: Promise<{ company?: string; problem?: string; requisition?: string; template?: string }> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const companies = await recruitmentAccess(s, scopeIds, false);
  const sp = await searchParams;
  const t = await getTranslations('recruitment.job');
  const tt = await getTranslations('recruitment.templates');
  // A template that cannot be opened keeps its own refusal: template_unavailable (disabled, deleted, templates off, or a company
  // outside the current scope) or the requisition's (a closed requisition stays requisition_terminal).
  const opened = sp.template
    ? await newPositionFromTemplate(s, sp.template, { requisitionId: sp.requisition, scopeCompanyIds: companies.map((c) => c.id) })
      .then((v) => ({ v, refusal: null }), (e) => { if (e instanceof RecruitmentError) return { v: null, refusal: e.code }; throw e; })
    : { v: null, refusal: null };
  const fromTemplate = opened.v;
  const prefill = !fromTemplate && sp.requisition ? await soft(requisitionJobPrefill(s, sp.requisition)) : null;
  const company = pickCompany(companies, fromTemplate?.companyId ?? prefill?.companyId ?? sp.company);
  const back = { href: '/recruitment/positions', label: t('backToPositions') };
  if (!company) return <div className="w-full space-y-5"><PageHeader title={t('newTitle')} back={back} /><NoRecruitmentCompany /></div>;
  const [options, locale, choices] = await Promise.all([jobFormOptions(s, company.id), getLocale(), soft(positionTemplateChoices(s, company.id))]);
  const requisition = fromTemplate?.requisition ?? (prefill ? { id: prefill.requisitionId, reqNumber: prefill.reqNumber, recruiterUserId: prefill.recruiterUserId } : null);
  const values = fromTemplate?.draft ?? prefill?.values;
  // A template that could not be opened says why; the blank form stays usable.
  const error = (await recruitmentErrorText(sp.problem)) ?? (opened.refusal ? await recruitmentErrorText(opened.refusal) : undefined);
  const enabledProcesses = options.processes.filter((p) => p.enabled);
  const startHidden = (name: string, value: string | undefined) => (value ? <input type="hidden" name={name} value={value} /> : null);
  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <PageHeader title={t('newTitle')} description={t('newPurpose')} back={back} />
      <ErrorBanner message={error} />
      {companies.length > 1 && !requisition && !fromTemplate && (
        <form method="get" className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-4">
          <Field label={t('company')} required requiredAriaLabel={t('required')} className="min-w-64">
            <select name="company" defaultValue={company.id} className={selectCls}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <button type="submit" className={btnGhost}>{t('switchCompany')}</button>
        </form>
      )}
      {choices?.on && choices.templates.length > 0 && (
        <form method="get" className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-4" aria-labelledby="from-template-title">
          {startHidden('company', company.id)}{startHidden('requisition', requisition?.id)}
          <div className="w-full">
            <h2 id="from-template-title" className="text-sm font-semibold">{tt('fromTemplateTitle')}</h2>
            <p className="text-xs text-muted-foreground">{requisition ? tt('fromTemplateRequisitionNote') : tt('fromTemplateNote')}</p>
          </div>
          <Field label={tt('chooseTemplate')} className="min-w-64">
            <select name="template" defaultValue={fromTemplate?.templateId ?? ''} className={selectCls} required>
              <option value="" disabled>{tt('choose')}</option>
              {choices.templates.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.title}</option>)}
            </select>
          </Field>
          <button type="submit" className={btnGhost}>{tt('useTemplate')}</button>
          {fromTemplate && (
            <Link href={`/recruitment/positions/new?${new URLSearchParams({ company: company.id, ...(requisition ? { requisition: requisition.id } : {}) })}`}
              className="pb-2 text-sm text-primary hover:underline">{tt('startBlank')}</Link>
          )}
        </form>
      )}
      {requisition && <p className="text-sm text-muted-foreground">{t('fromRequisition', { number: requisition.reqNumber })}</p>}
      {fromTemplate && <p className="text-sm text-muted-foreground">{tt('fromTemplate', { name: fromTemplate.templateName })}</p>}
      {fromTemplate && <TemplateNotes notes={fromTemplate.notes} fields={options.customFields} locale={locale} />}
      {/* A refused save keeps everything typed (custom fields and the interview plan included) and the company; each refused field
          says so beside it. Only a successful save leaves this page. */}
      <ActionForm action={createJobFormAction} className="space-y-5">
        <input type="hidden" name="companyId" value={company.id} />
        {requisition && <input type="hidden" name="requisitionId" value={requisition.id} />}
        {fromTemplate && <input type="hidden" name="templateId" value={fromTemplate.templateId} />}
        <section className="space-y-4 rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">{t('infoSection')} <span className="font-normal text-muted-foreground">· {company.name}</span></h2>
          <JobInfoFields options={options} values={values} />
          <CustomFieldInputs fields={fromTemplate?.custom ?? options.customFields} locale={locale} />
        </section>
        <section className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-2">
          <h2 className="text-sm font-semibold sm:col-span-2">{t('settingsSection')}</h2>
          <Field label={t('positionAttribute')}>
            <select name="positionAttribute" defaultValue="regular" className={selectCls}>
              {POSITION_ATTRIBUTES.map((v) => <option key={v} value={v}>{t(`positionAttributes.${v}`)}</option>)}
            </select>
            <span className="text-xs text-muted-foreground">{t('positionAttributeNote')}</span>
            <FieldProblem name="positionAttribute" required={t('fieldRequired')} invalid={t('fieldInvalid')} />
          </Field>
          <Field label={t('process')}>
            <select name="processId" defaultValue={fromTemplate?.draft.processId ?? enabledProcesses[0]?.id ?? ''} className={selectCls}>
              {enabledProcesses.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <FieldProblem name="processId" required={t('fieldRequired')} invalid={t('fieldInvalid')} />
          </Field>
          <Field label={t('recruiter')}>
            <select name="recruiterUserId" defaultValue={requisition?.recruiterUserId ?? s.userId ?? ''} className={selectCls}>
              <option value="">{t('none')}</option>
              {options.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
          <label className="flex items-center gap-2 self-end text-sm">
            <input type="checkbox" name="autoArchiveAfterReject" />{t('autoArchive')}
          </label>
          <InterviewPlanInputs forms={options.forms} plan={fromTemplate?.draft.interviewPlan ?? []} />
        </section>
        <div className="flex gap-2">
          <button type="submit" className={btnPrimary}>{t('create')}</button>
          <Link href="/recruitment/positions" className={btnGhost}>{t('cancel')}</Link>
        </div>
      </ActionForm>
    </div>
  );
}
