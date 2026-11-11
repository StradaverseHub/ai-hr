import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, PageHeader } from '@/components/ui';
import { parseTaskTab, parseUpdatesPage, recruitmentOverview } from '@/packs/recruitment/service';
import { NoRecruitmentCompany, Notice, RecruitmentTabs, recruitmentErrorText, recruitmentViewerAccess } from './shared';
import { RecruitmentTasksPanel } from './tasks-panel';

/**
 * Recruitment › Overview. Administrators see the tiles: every tile is one count query over the applications and
 * interviews the viewer administers, and a tile whose page the viewer cannot open renders as text, not a link. Since
 * slice 9 everyone with Recruitment access (administrators, job-team members, interviewers and approvers) also sees the
 * Tasks panel: their live to-do list and the updates of the companies in the current selection.
 */
export default async function RecruitmentOverviewPage({ searchParams }: {
  searchParams: Promise<{ tasks?: string; page?: string; after?: string; error?: string; notice?: string }>;
}) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const access = await recruitmentViewerAccess(s, scopeIds);
  const sp = await searchParams;
  const companies = access.adminCompanies;
  const [t, tt, nav] = await Promise.all([getTranslations('recruitment.overview'), getTranslations('recruitment.tasks'), getTranslations('nav')]);
  const value = access.isAdmin ? await recruitmentOverview(s, companies.map((c) => c.id)) : null;
  const tiles: { key: string; label: string; value: number; href: string | null }[] = value ? [
    { key: 'applicationsToday', label: t('applicationsToday'), value: value.applicationsToday, href: '/recruitment/candidates' },
    { key: 'toScreen', label: t('toScreen'), value: value.toScreen, href: '/recruitment/candidates' },
    { key: 'interview', label: t('interview'), value: value.interview, href: '/recruitment/candidates' },
    { key: 'interviewsToday', label: t('interviewsToday'), value: value.interviewsToday, href: '/recruitment/interviews' },
    { key: 'toBeScheduled', label: t('toBeScheduled'), value: value.toBeScheduled, href: '/recruitment/candidates' },
    { key: 'awaitingFeedback', label: t('awaitingFeedback'), value: value.awaitingFeedback, href: '/recruitment/interviews?status=awaiting_feedback' },
    { key: 'offer', label: t('offer'), value: value.offer, href: '/recruitment/candidates' },
    { key: 'onboarding', label: t('onboarding'), value: value.onboarding, href: '/recruitment/candidates' },
    { key: 'openJobs', label: t('openJobs'), value: value.openJobs, href: access.isAdmin ? '/recruitment/positions' : null },
  ] : [];
  const tileCls = 'flex h-full flex-col gap-1 rounded-xl border border-border bg-card px-4 py-3';
  const panel = (
    <RecruitmentTasksPanel s={s} scopeIds={scopeIds} companyIds={access.companies.map((c) => c.id)}
      tab={parseTaskTab(sp.tasks)} page={parseUpdatesPage(sp.page)} after={sp.after} />
  );
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={access.isAdmin ? t('purpose') : tt('purpose')} />
      <RecruitmentTabs active="overview" admin={access.isAdmin} approvals={access.pendingApprovals} reports={access.reportCompanies.length > 0} />
      <Notice text={sp.notice === 'saved' ? tt('markedNotice') : undefined} />
      <ErrorBanner message={await recruitmentErrorText(sp.error)} />
      {!access.isAdmin ? <div className="max-w-3xl">{panel}</div> : companies.length === 0 ? <NoRecruitmentCompany /> : (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <div className="space-y-3">
            <ul className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {tiles.map((tile) => (
                <li key={tile.key}>
                  {tile.href ? (
                    <Link href={tile.href} className={`${tileCls} transition-colors hover:bg-accent/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring`}>
                      <span className="text-xs font-medium text-muted-foreground">{tile.label}</span>
                      <span className="text-2xl font-semibold tabular-nums">{tile.value}</span>
                    </Link>
                  ) : (
                    <div className={tileCls}>
                      <span className="text-xs font-medium text-muted-foreground">{tile.label}</span>
                      <span className="text-2xl font-semibold tabular-nums">{tile.value}</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              {t('scope', { count: companies.length, active: value?.activeApplications ?? 0 })}
            </p>
          </div>
          {panel}
        </div>
      )}
    </div>
  );
}
