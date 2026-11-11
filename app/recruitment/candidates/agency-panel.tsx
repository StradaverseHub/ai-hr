import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Field, Input, btnPrimary } from '@/components/ui';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  agencyReviewQueue, agencySubmissionOptions, jobAgencySubmissions, CANDIDATE_FILE_ACCEPT, COMMENTS_MAX, ID_TYPES, RecruitmentError, type SubmissionOutcome,
} from '@/packs/recruitment/service';
import { recordAgencySubmissionAction } from '../actions';
import { Pill, klDate, selectCls, textareaCls } from '../shared';

const OUTCOME_TONE: Record<SubmissionOutcome, 'good' | 'bad' | 'warn' | 'neutral'> = { accepted: 'good', refused: 'bad', waiting: 'warn', rejected: 'neutral' };

/**
 * Candidates › Add agency submission (slice 10): for the selected job's recruiter, assistants and administrators, a
 * submission recorded on the agency's behalf from a contract released to the job and usable today, with one of its active
 * consultants. The outcome comes back as a notice only — added, refused as protected by an earlier application, or waiting
 * for an administrator; never who matched. Below it, the job's recent agency submissions and what became of them.
 */
export async function AgencySubmissionPanel({ s, jobId, here }: { s: SessionContext; jobId: string; here: string }) {
  const soft = <T,>(work: Promise<T>) => work.catch((e) => { if (e instanceof RecruitmentError) return null; throw e; });
  const [options, recent] = await Promise.all([soft(agencySubmissionOptions(s, jobId)), soft(jobAgencySubmissions(s, jobId))]);
  if (!options || !recent) return null;
  const [t, tc, locale] = await Promise.all([getTranslations('recruitment.agency'), getTranslations('recruitment.cand'), getLocale()]);
  const usable = options.filter((o) => o.consultants.length > 0);
  const today = todayInKualaLumpur();
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-labelledby="agency-add-title">
      <h2 id="agency-add-title" className="text-sm font-semibold">{t('addSubmission')}</h2>
      {usable.length === 0 ? <p className="text-sm text-muted-foreground">{t('noUsableContracts')}</p> : (
        <form action={recordAgencySubmissionAction} className="space-y-3">
          <input type="hidden" name="jobId" value={jobId} />
          <input type="hidden" name="returnTo" value={here} />
          <Field label={t('consultantAndContract')} required requiredAriaLabel={t('required')}>
            <select name="consultant" required defaultValue="" className={selectCls}>
              <option value="" disabled>{t('choose')}</option>
              {usable.map((o) => (
                <optgroup key={o.contractId} label={o.label}>
                  {o.consultants.map((k) => <option key={k.id} value={`${o.contractId}|${k.id}`}>{k.name}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          {usable.some((o) => o.requirements) && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">{t('requirementsShown')}</summary>
              {usable.filter((o) => o.requirements).map((o) => <p key={o.contractId} className="mt-1 whitespace-pre-wrap"><span className="font-medium">{o.label}:</span> {o.requirements}</p>)}
            </details>
          )}
          <Field label={t('fullName')} required requiredAriaLabel={t('required')}><Input name="fullName" maxLength={200} required autoComplete="off" /></Field>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <Field label={t('email')}><Input type="email" name="email" maxLength={254} autoComplete="off" /></Field>
            <Field label={t('mobile')}><Input name="mobile" maxLength={40} autoComplete="off" /></Field>
          </div>
          <p className="text-xs text-muted-foreground">{t('emailOrMobile')}</p>
          <div className="grid grid-cols-[8rem_1fr] gap-2">
            <Field label={tc('idType')}>
              <select name="idType" defaultValue="" className={selectCls}>
                <option value="">{tc('idNone')}</option>
                {ID_TYPES.map((v) => <option key={v} value={v}>{tc(`idTypes.${v}`)}</option>)}
              </select>
            </Field>
            <Field label={tc('idNumber')}><Input name="idNumber" maxLength={40} autoComplete="off" /></Field>
          </div>
          <div className="grid grid-cols-[1fr_5rem] gap-2">
            <Field label={t('currentSalary')}><Input name="currentSalaryAmount" inputMode="decimal" maxLength={20} /></Field>
            <Field label={t('currency')}><Input name="currentSalaryCurrency" maxLength={3} placeholder="MYR" /></Field>
            <Field label={t('expectedSalary')}><Input name="expectedSalaryAmount" inputMode="decimal" maxLength={20} /></Field>
            <Field label={t('currency')}><Input name="expectedSalaryCurrency" maxLength={3} placeholder="MYR" /></Field>
          </div>
          <Field label={t('submittedOn')}><Input type="date" name="submittedOn" defaultValue={today} max={today} /></Field>
          <Field label={t('agencyComments')}><textarea name="comments" maxLength={COMMENTS_MAX} rows={3} className={textareaCls} /></Field>
          <Field label={t('resume')}>
            <input name="resume" type="file" accept={CANDIDATE_FILE_ACCEPT} className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-sm" />
          </Field>
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" name="permissionConfirmed" className="mt-0.5" />{t('resumePermission')}</label>
          <button type="submit" className={btnPrimary}>{t('record')}</button>
          <p className="text-xs text-muted-foreground">{t('recordNote')}</p>
        </form>
      )}
      {recent.length > 0 && (
        <div className="space-y-2 border-t border-border pt-3">
          <h3 className="text-xs font-semibold text-muted-foreground">{t('recentTitle')}</h3>
          <ul className="space-y-2 text-sm">
            {recent.slice(0, 10).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  {r.applicationId ? <Link href={`/recruitment/applications/${r.applicationId}`} className="font-medium hover:underline">{r.removed ? tc('removedLabel') : r.fullName}</Link>
                    : <span className="font-medium">{r.removed ? tc('removedLabel') : r.fullName}</span>}
                  <span className="block text-xs text-muted-foreground">{r.agencyName} · {r.consultantName} · {klDate(locale, r.submittedOn)}</span>
                </span>
                <Pill tone={OUTCOME_TONE[r.outcome]}>{r.outcome === 'refused' && r.refusalReason ? t('refusal.protected') : t(`outcome.${r.outcome}`)}</Pill>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** The administrators' list of agency submissions waiting for review in the companies on screen (oldest first). */
export async function AgencyReviewList({ s, companyIds }: { s: SessionContext; companyIds: string[] }) {
  const rows = await agencyReviewQueue(s, companyIds);
  if (!rows.length) return null;
  const [t, locale] = await Promise.all([getTranslations('recruitment.agency'), getLocale()]);
  return (
    <section className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4" aria-labelledby="agency-review-title">
      <h2 id="agency-review-title" className="text-sm font-semibold">{t('reviewTitle')} <span className="tabular-nums text-muted-foreground">({rows.length})</span></h2>
      <ul className="divide-y divide-border text-sm">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="min-w-0">
              <Link href={`/recruitment/agency-submissions/${r.id}`} className="font-medium text-primary hover:underline">{r.fullName}</Link>
              <span className="block text-xs text-muted-foreground">{r.jobTitle} · <span className="font-mono">{r.jobNumber}</span> · {r.agencyName} · {klDate(locale, r.submittedOn)}</span>
            </span>
            <Pill tone="warn">{t(`matchKinds.${r.matchKind}`)}</Pill>
          </li>
        ))}
      </ul>
    </section>
  );
}
