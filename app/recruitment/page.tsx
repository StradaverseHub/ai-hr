import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { PageHeader } from '@/components/ui';
import { recruitmentOverview } from '@/packs/recruitment/service';
import { NoRecruitmentCompany, RecruitmentTabs, recruitmentViewerAccess } from './shared';

/**
 * Recruitment › Overview (administrators). Every tile is one count query over the applications and interviews the
 * viewer administers. A job-team member has no Overview: they land on Candidates. A tile whose page the viewer
 * cannot open renders as text, not a link.
 */
export default async function RecruitmentOverviewPage() {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const access = await recruitmentViewerAccess(s, scopeIds);
  if (!access.isAdmin) redirect(access.companies.length ? '/recruitment/candidates' : '/recruitment/approvals');
  const companies = access.adminCompanies;
  const [t, nav] = await Promise.all([getTranslations('recruitment.overview'), getTranslations('nav')]);
  const value = await recruitmentOverview(s, companies.map((c) => c.id));
  const tiles: { key: string; label: string; value: number; href: string | null }[] = [
    { key: 'applicationsToday', label: t('applicationsToday'), value: value.applicationsToday, href: '/recruitment/candidates' },
    { key: 'toScreen', label: t('toScreen'), value: value.toScreen, href: '/recruitment/candidates' },
    { key: 'interview', label: t('interview'), value: value.interview, href: '/recruitment/candidates' },
    { key: 'interviewsToday', label: t('interviewsToday'), value: value.interviewsToday, href: '/recruitment/interviews' },
    { key: 'toBeScheduled', label: t('toBeScheduled'), value: value.toBeScheduled, href: '/recruitment/candidates' },
    { key: 'awaitingFeedback', label: t('awaitingFeedback'), value: value.awaitingFeedback, href: '/recruitment/interviews?status=awaiting_feedback' },
    { key: 'offer', label: t('offer'), value: value.offer, href: '/recruitment/candidates' },
    { key: 'onboarding', label: t('onboarding'), value: value.onboarding, href: '/recruitment/candidates' },
    { key: 'openJobs', label: t('openJobs'), value: value.openJobs, href: access.isAdmin ? '/recruitment/positions' : null },
  ];
  const tileCls = 'flex h-full flex-col gap-1 rounded-xl border border-border bg-card px-4 py-3';
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={t('purpose')} />
      <RecruitmentTabs active="overview" approvals={access.pendingApprovals} />
      {companies.length === 0 ? <NoRecruitmentCompany /> : (
        <>
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
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
            {t('scope', { count: companies.length, active: value.activeApplications })}
          </p>
        </>
      )}
    </div>
  );
}
