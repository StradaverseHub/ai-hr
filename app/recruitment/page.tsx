import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { PageHeader } from '@/components/ui';
import { recruitmentOverview } from '@/packs/recruitment/service';
import { NoRecruitmentCompany, RecruitmentTabs, recruitmentAccess } from './shared';

/** Recruitment › Overview. Every tile is one count query over the applications the viewer administers. */
export default async function RecruitmentOverviewPage() {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const companies = await recruitmentAccess(s, scopeIds);
  const [t, nav] = await Promise.all([getTranslations('recruitment.overview'), getTranslations('nav')]);
  const value = await recruitmentOverview(s, companies.map((c) => c.id));
  const tiles = [
    { key: 'applicationsToday', label: t('applicationsToday'), value: value.applicationsToday, href: '/recruitment/candidates' },
    { key: 'toScreen', label: t('toScreen'), value: value.toScreen, href: '/recruitment/candidates' },
    { key: 'interview', label: t('interview'), value: value.interview, href: '/recruitment/candidates' },
    { key: 'offer', label: t('offer'), value: value.offer, href: '/recruitment/candidates' },
    { key: 'onboarding', label: t('onboarding'), value: value.onboarding, href: '/recruitment/candidates' },
    { key: 'openJobs', label: t('openJobs'), value: value.openJobs, href: '/recruitment/positions' },
  ];
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={t('purpose')} />
      <RecruitmentTabs active="overview" />
      {companies.length === 0 ? <NoRecruitmentCompany /> : (
        <>
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {tiles.map((tile) => (
              <li key={tile.key}>
                <Link href={tile.href} className="flex h-full flex-col gap-1 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:bg-accent/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                  <span className="text-xs font-medium text-muted-foreground">{tile.label}</span>
                  <span className="text-2xl font-semibold tabular-nums">{tile.value}</span>
                </Link>
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
