import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, PageHeader, btnPrimary } from '@/components/ui';
import { suggestedArchiveList, RecruitmentError, SUGGESTED_LIST_LIMIT, WAITING_SCAN_LIMIT, type SuggestedArchiveList } from '@/packs/recruitment/service';
import { archiveSuggestedAction } from '../actions';
import { Pill, RecruitmentTabs, klDate, recruitmentErrorText, recruitmentViewerAccess, selectCls } from '../shared';
import { SuggestedArchiveForm } from './archive-form';

type Search = { job?: string; problem?: string };

/**
 * Recruitment › Suggested to archive (slice 17, D-057): a job's active applications that have waited in their stage past the stage's
 * "suggest archiving" limit, longest first. The job's recruiters, assistants and administrators tick the ones to archive, choose an
 * archive reason and archive them in one action through the normal reject path; nothing is archived any other way. An application
 * under a blocked-list hold cannot be ticked: the administrator's review decides it first.
 */
export default async function SuggestedArchivePage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const access = await recruitmentViewerAccess(s, scopeIds);
  const sp = await searchParams;
  const [t, tc, nav, locale] = await Promise.all([getTranslations('recruitment.waiting'), getTranslations('recruitment.cand'), getTranslations('nav'), getLocale()]);
  let list: SuggestedArchiveList | null = null;
  let problem = await recruitmentErrorText(sp.problem);
  if (sp.job) {
    try { list = await suggestedArchiveList(s, sp.job); } catch (e) {
      if (!(e instanceof RecruitmentError)) throw e;
      problem = await recruitmentErrorText(e.code);
    }
  }
  const name = (r: SuggestedArchiveList['rows'][number]) => (r.candidateRemoved ? tc('removedLabel') : r.candidateName ?? tc('removedLabel'));
  const selectable = list ? list.rows.filter((r) => !r.needsReview) : [];
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={t('suggestedPurpose')}
        back={{ href: list ? `/recruitment/candidates?job=${list.job.id}` : '/recruitment/candidates', label: t('back') }} />
      <RecruitmentTabs active="candidates" admin={access.isAdmin} approvals={access.pendingApprovals} reports={access.reportCompanies.length > 0}
        screening={access.pendingScreening} pools={access.poolCompanies.length > 0} />
      <ErrorBanner message={problem} />
      {!list ? (
        !problem && <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('chooseJob')}{' '}
          <Link href="/recruitment/candidates" className="font-medium text-primary hover:underline">{t('back')}</Link></p>
      ) : (
        <section aria-labelledby="suggested-title" className="space-y-4">
          <div>
            <h2 id="suggested-title" className="text-base font-semibold">{t('suggestedTitle', { job: list.job.title, number: list.job.jobNumber })}</h2>
            <p className="text-sm text-muted-foreground">{list.hasRules ? t('suggestedNote') : t('noArchiveRules')}</p>
          </div>
          {/* The form wraps the empty state too, so the result of archiving the last suggested application stays on screen. */}
          <SuggestedArchiveForm action={archiveSuggestedAction} jobId={list.job.id}
            names={Object.fromEntries(list.rows.map((r) => [r.applicationId, name(r)]))}
            labels={{ refusedTitle: t('refusedTitle'), unknown: t('unknownApplication'), working: t('archiving') }}>
            {list.rows.length === 0 ? (<>
              <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('suggestedEmpty')}</p>
              {/* The scan stopped at its bound: there may be more applications past the limit than it found. */}
              {list.truncated && <p className="text-xs text-muted-foreground">{t('truncated', { count: SUGGESTED_LIST_LIMIT, scan: WAITING_SCAN_LIMIT })}</p>}
            </>) : (<>
              <ul className="divide-y divide-border rounded-xl border border-border bg-card">
                {list.rows.map((r) => (
                  <li key={r.applicationId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <label className="flex min-w-0 items-start gap-3">
                      <input type="checkbox" name="applicationIds" value={r.applicationId} disabled={r.needsReview} className="mt-1 accent-primary"
                        aria-label={t('selectNamed', { name: name(r) })} />
                      <span className="min-w-0">
                        <span className="block font-medium">{name(r)}</span>
                        <span className="block text-xs text-muted-foreground">{t('enteredOn', { stage: r.stageName, date: klDate(locale, `${r.enteredOn}T00:00:00+08:00`) })}</span>
                      </span>
                    </label>
                    <span className="flex flex-wrap items-center gap-2">
                      <Pill tone="warn">{t('badge', { days: r.days, stage: r.stageName })}</Pill>
                      {r.needsReview && <Pill tone="bad">{t('heldForReview')}</Pill>}
                      <Link href={`/recruitment/applications/${r.applicationId}`} className="text-sm text-primary hover:underline">{t('open')}</Link>
                    </span>
                  </li>
                ))}
              </ul>
              {list.truncated && <p className="text-xs text-muted-foreground">{t('truncated', { count: SUGGESTED_LIST_LIMIT, scan: WAITING_SCAN_LIMIT })}</p>}
              {selectable.length > 0 && (
                <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
                  <label className="min-w-64 space-y-1 text-sm">
                    <span className="block text-xs font-medium text-muted-foreground">{t('reason')}<span className="ml-0.5 text-destructive" aria-label={t('fieldRequired')}>*</span></span>
                    <select name="archiveReasonId" required defaultValue="" className={selectCls}>
                      <option value="" disabled>{t('chooseReason')}</option>
                      {list.reasons.map((x) => <option key={x.id} value={x.id}>{x.internal}</option>)}
                    </select>
                  </label>
                  <button type="submit" className={btnPrimary}>{t('archiveSelected')}</button>
                  <p className="w-full text-xs text-muted-foreground">{t('archiveSelectedNote')}</p>
                </div>
              )}
            </>)}
          </SuggestedArchiveForm>
        </section>
      )}
    </div>
  );
}
