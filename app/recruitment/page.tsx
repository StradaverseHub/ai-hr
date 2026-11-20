import Link from 'next/link';
import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import type { SessionContext } from '@/db/client';
import { ErrorBanner, PageHeader } from '@/components/ui';
import { parseTaskTab, parseUpdatesPage, recruitmentOverview } from '@/packs/recruitment/service';
import { NoRecruitmentCompany, Notice, RecruitmentTabs, recruitmentErrorText, recruitmentViewerAccess } from './shared';
import { RecruitmentTasksPanel } from './tasks-panel';

/**
 * Recruitment › Overview. Administrators see aggregate tiles over the applications and
 * interviews the viewer administers. Everyone with Recruitment access also sees the
 * Tasks panel: their live to-do list and the updates of the companies in the current selection.
 */
export default async function RecruitmentOverviewPage({ searchParams }: {
  searchParams: Promise<{ tasks?: string; page?: string; after?: string; problem?: string; notice?: string }>;
}) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const access = await recruitmentViewerAccess(s, scopeIds);
  const sp = await searchParams;
  const companyIds = access.adminCompanies.map(company => company.id);
  const [t, tt, nav, common] = await Promise.all([
    getTranslations('recruitment.overview'), getTranslations('recruitment.tasks'), getTranslations('nav'), getTranslations('common'),
  ]);
  const loading = common('loading');
  const panel = (
    <Suspense fallback={<section id="tasks" role="status" className="min-h-40 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">{loading}</section>}>
      <RecruitmentTasksPanel s={s} scopeIds={scopeIds} companyIds={access.companies.map((c) => c.id)}
        tab={parseTaskTab(sp.tasks)} page={parseUpdatesPage(sp.page)} after={sp.after} />
    </Suspense>
  );
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={access.isAdmin ? t('purpose') : tt('purpose')} />
      <RecruitmentTabs active="overview" admin={access.isAdmin} approvals={access.pendingApprovals} reports={access.reportCompanies.length > 0}  screening={access.pendingScreening} pools={access.poolCompanies.length > 0} />
      <Notice text={sp.notice === 'saved' ? tt('markedNotice') : undefined} />
      <ErrorBanner message={await recruitmentErrorText(sp.problem)} />
      {!access.isAdmin ? <div className="max-w-3xl">{panel}</div> : companyIds.length === 0 ? <NoRecruitmentCompany /> : (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <Suspense fallback={<p role="status" className="min-h-80 text-sm text-muted-foreground md:min-h-52">{loading}</p>}>
            <RecruitmentOverviewTiles s={s} companyIds={companyIds} />
          </Suspense>
          {panel}
        </div>
      )}
    </div>
  );
}

async function RecruitmentOverviewTiles({ s, companyIds }: { s: SessionContext; companyIds: readonly string[] }) {
  const [value, t] = await Promise.all([
    recruitmentOverview(s, companyIds),
    getTranslations('recruitment.overview'),
  ]);
  const tiles = [
    { key: 'applicationsToday', label: t('applicationsToday'), value: value.applicationsToday, href: '/recruitment/candidates' },
    { key: 'toScreen', label: t('toScreen'), value: value.toScreen, href: '/recruitment/candidates' },
    { key: 'interview', label: t('interview'), value: value.interview, href: '/recruitment/candidates' },
    { key: 'interviewsToday', label: t('interviewsToday'), value: value.interviewsToday, href: '/recruitment/interviews' },
    { key: 'toBeScheduled', label: t('toBeScheduled'), value: value.toBeScheduled, href: '/recruitment/candidates' },
    { key: 'awaitingFeedback', label: t('awaitingFeedback'), value: value.awaitingFeedback, href: '/recruitment/interviews?status=awaiting_feedback' },
    { key: 'offer', label: t('offer'), value: value.offer, href: '/recruitment/candidates' },
    { key: 'onboarding', label: t('onboarding'), value: value.onboarding, href: '/recruitment/candidates' },
    { key: 'openJobs', label: t('openJobs'), value: value.openJobs, href: '/recruitment/positions' },
  ];
  const tileCls = 'flex h-full flex-col gap-1 rounded-xl border border-border bg-card px-4 py-3';
  return (
    <div className="space-y-3">
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {tiles.map(tile => (
          <li key={tile.key}>
            <Link href={tile.href} className={`${tileCls} transition-colors hover:bg-accent/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring`}>
              <span className="text-xs font-medium text-muted-foreground">{tile.label}</span>
              <span className="text-2xl font-semibold tabular-nums">{tile.value}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        {t('scope', { count: companyIds.length, active: value.activeApplications })}
      </p>
    </div>
  );
}
