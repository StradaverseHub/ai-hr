import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, PageHeader } from '@/components/ui';
import { myScreeningRequests } from '@/packs/recruitment/service';
import { Notice, RecruitmentTabs, klDateTime, recruitmentErrorText, recruitmentViewerAccess } from '../shared';
import { ScreeningAnswerForm, ScreeningAnswers } from '../screening-ui';

/**
 * Recruitment › To screen (slice 11): the hiring manager's open screening requests — job, candidate, who sent it and when,
 * the note — each with the company screening form. Row security returns only the viewer's own requests while they are a
 * hiring manager of the job; a Pending answer keeps the request here for another answer.
 */
export default async function RecruitmentScreeningPage({ searchParams }: { searchParams: Promise<{ problem?: string; notice?: string }> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const access = await recruitmentViewerAccess(s, scopeIds);
  const sp = await searchParams;
  const [t, nav, locale] = await Promise.all([getTranslations('recruitment.screening'), getTranslations('nav'), getLocale()]);
  const requests = await myScreeningRequests(s, access.companies.map((c) => c.id));
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={t('toScreenPurpose')} />
      <RecruitmentTabs active="screening" admin={access.isAdmin} approvals={access.pendingApprovals} reports={access.reportCompanies.length > 0} screening={access.pendingScreening} />
      <Notice text={sp.notice === 'screening-answered' ? t('answeredNotice') : undefined} />
      <ErrorBanner message={await recruitmentErrorText(sp.problem)} />
      {requests.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('toScreenEmpty')}</p>
      ) : (
        <ul className="grid max-w-4xl gap-4">
          {requests.map((r) => (
            <li key={r.requestId} id={`request-${r.requestId}`} className="scroll-mt-20 space-y-4 rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="font-medium">
                    <Link href={`/recruitment/applications/${r.applicationId}`} className="hover:underline">{r.candidateRemoved ? t('removedCandidate') : r.candidateName ?? t('candidateFallback')}</Link>
                  </h2>
                  <p className="text-sm text-muted-foreground">{[r.jobTitle, r.jobNumber].filter(Boolean).join(' · ')}</p>
                </div>
                <p className="text-xs text-muted-foreground">{t('sentBy', { name: r.sentBy ?? t('unnamedUser'), time: klDateTime(locale, r.sentAt) })}</p>
              </div>
              {r.note && (
                <p className="whitespace-pre-wrap rounded-md bg-muted/60 px-3 py-2 text-sm"><span className="font-medium">{t('noteFromRecruiter')}:</span> {r.note}</p>
              )}
              {r.answers.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground">{t('yourEarlierAnswers')}</h3>
                  <ScreeningAnswers answers={r.answers} locale={locale} showName={false} />
                </div>
              )}
              <ScreeningAnswerForm requestId={r.requestId} returnTo="/recruitment/screening" idPrefix={`answer-${r.requestId}`} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
