import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, Field, PageHeader, btnGhost, btnPrimary } from '@/components/ui';
import { agencySubmissionReview, RecruitmentError, REVIEW_REASON_MAX, type AgencySubmissionReview } from '@/packs/recruitment/service';
import { acceptAgencySubmissionAction, rejectAgencySubmissionAction, removeAgencySubmissionDataAction } from '../../actions';
import { Notice, Pill, RecruitmentTabs, klDate, recruitmentAccess, recruitmentErrorText, textareaCls } from '../../shared';

/**
 * Recruitment › Agency submission (slice 10, recruitment administrators only — the service and row security refuse
 * everybody else): what the agency submitted, the company's candidates it matches (the slice 5 rule) with their jobs, and,
 * while it waits, Accept — onto one of the matched candidates or as a new candidate — or Reject with a reason (D-038).
 */
export default async function AgencySubmissionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ problem?: string; notice?: string }> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  await recruitmentAccess(s, scopeIds, false);
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  let r: AgencySubmissionReview;
  try {
    r = await agencySubmissionReview(s, id);
  } catch (e) {
    if (e instanceof RecruitmentError && (e.code === 'not_found' || e.code === 'forbidden')) notFound();
    throw e;
  }
  const [t, tc, locale] = await Promise.all([getTranslations('recruitment.agency'), getTranslations('recruitment.cand'), getLocale()]);
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const row = (label: string, value: string | null | undefined) => (
    <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-words">{value || '—'}</dd></div>
  );
  const money = (v: { amount: string; currency: string } | null) => (v ? `${v.currency} ${v.amount}` : null);
  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <PageHeader title={r.removed ? tc('removedLabel') : r.fullName ?? ''} description={<>{r.jobTitle} · <span className="font-mono">{r.jobNumber}</span></>}
        back={{ href: `/recruitment/candidates?job=${r.jobId}`, label: t('backToCandidates') }} />
      <RecruitmentTabs active="candidates" />
      <Notice text={sp.notice === 'saved' ? t('decidedNotice') : sp.notice === 'removed' ? t('removedNotice') : undefined} />
      <ErrorBanner message={await recruitmentErrorText(sp.problem)} />
      <section aria-labelledby="submitted-title" className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="submitted-title" className="text-sm font-semibold">{t('submittedTitle')}</h2>
          <span className="flex gap-2"><Pill tone="warn">{t(`matchKinds.${r.matchKind}`)}</Pill><Pill>{r.outcome === 'refused' && r.refusalReason ? t('refusal.protected') : t(`outcome.${r.outcome}`)}</Pill></span>
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          {row(t('agency'), r.agencyName)}{row(t('contract'), r.contractName)}{row(t('consultant'), r.consultantName)}
          {row(t('submittedOn'), klDate(locale, r.submittedOn))}{row(t('email'), r.email)}{row(t('mobile'), r.mobile)}
          {row(tc('idNumber'), r.idNumber && r.idType ? `${tc(`idTypes.${r.idType}`)} ${r.idNumber}` : null)}
          {row(t('currentSalary'), money(r.currentSalary))}{row(t('expectedSalary'), money(r.expectedSalary))}
        </dl>
        {r.comments && <p className="whitespace-pre-wrap text-sm"><span className="font-medium">{t('agencyComments')}:</span> {r.comments}</p>}
        {r.resume && <p className="text-xs text-muted-foreground">{t('resumeWaiting', { name: r.resume.name })}</p>}
        {r.reviewReason && <p className="text-sm"><span className="font-medium">{t('rejectReason')}:</span> {r.reviewReason}</p>}
        {r.applicationId && <Link href={`/recruitment/applications/${r.applicationId}`} className="text-sm font-medium text-primary hover:underline">{t('openApplication')}</Link>}
      </section>

      {(r.outcome === 'refused' || r.outcome === 'rejected') && !r.removed && (
        <form action={removeAgencySubmissionDataAction} className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
          {hidden('submissionId', r.id)}
          <p>{t('removeDataNote')}</p>
          <label className="flex items-start gap-2"><input type="checkbox" name="confirm" required className="mt-0.5" /><span>{t('removeDataConfirm')}</span></label>
          <button type="submit" className={btnGhost}>{t('removeData')}</button>
        </form>
      )}

      {r.outcome === 'waiting' && (
        <>
          <section aria-labelledby="matches-title" className="space-y-3 rounded-xl border border-border bg-card p-4">
            <div><h2 id="matches-title" className="text-sm font-semibold">{t('matchesTitle')}</h2><p className="text-sm text-muted-foreground">{t('matchesNote')}</p></div>
            <form action={acceptAgencySubmissionAction} className="space-y-3">
              {hidden('submissionId', r.id)}
              <fieldset className="space-y-2">
                <legend className="sr-only">{t('acceptAs')}</legend>
                {r.matches.map((m) => (
                  <label key={m.candidateId} className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm">
                    <input type="radio" name="target" value={m.candidateId} required className="mt-1" />
                    <span className="min-w-0">
                      <span className="font-medium">{m.fullName}</span>
                      <span className="block text-xs text-muted-foreground">{[m.email, m.phone].filter(Boolean).join(' · ')}</span>
                      <span className="block text-xs text-muted-foreground">{tc('dup.matchedOn')} {m.matchedOn.map((k) => tc(`match.${k}`)).join(', ')}</span>
                      <span className="block text-xs text-muted-foreground">{m.applications.length ? m.applications.map((a) => `${a.jobTitle} (${a.jobNumber}) · ${tc(`appStates.${a.state}`)}`).join('; ') : tc('dup.noApplications')}</span>
                      <span className="mt-1 block text-xs font-medium">{t('acceptOntoExisting')}</span>
                    </span>
                  </label>
                ))}
                {r.matches.length === 0 && <p className="text-sm text-muted-foreground">{t('noMatches')}</p>}
                <label className="flex items-center gap-3 rounded-lg border border-border p-3 text-sm">
                  <input type="radio" name="target" value="new" required defaultChecked={r.matches.length === 0} />{t('acceptAsNew')}
                </label>
              </fieldset>
              <button type="submit" className={btnPrimary}>{t('accept')}</button>
            </form>
          </section>
          <section aria-labelledby="reject-title" className="space-y-3 rounded-xl border border-border bg-card p-4">
            <h2 id="reject-title" className="text-sm font-semibold">{t('rejectTitle')}</h2>
            <form action={rejectAgencySubmissionAction} className="space-y-3">
              {hidden('submissionId', r.id)}
              <Field label={t('rejectReason')} required requiredAriaLabel={t('required')}>
                <textarea name="reason" required maxLength={REVIEW_REASON_MAX} rows={3} className={textareaCls} />
              </Field>
              <button type="submit" className={btnGhost}>{t('reject')}</button>
            </form>
          </section>
        </>
      )}
    </div>
  );
}
