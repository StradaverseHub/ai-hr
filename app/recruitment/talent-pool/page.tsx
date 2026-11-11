import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, Input, PageHeader, btnGhost, btnPrimary } from '@/components/ui';
import { cn } from '@/lib/utils';
import { talentPool } from '@/packs/recruitment/service';
import { addPoolCandidateToJobAction } from '../actions';
import { NoRecruitmentCompany, Notice, RecruitmentTabs, klDate, recruitmentAccess, recruitmentErrorText, selectCls } from '../shared';

type Search = { job?: string; reason?: string; since?: string; tag?: string; problem?: string; notice?: string };

/**
 * Recruitment › Talent pool (administrators): one public pool per company — the latest archived application of
 * each candidate, with the stage it left and the reason. Totals are count queries. "Add to job" opens a NEW
 * application at the first stage of an open job; the archived application stays archived.
 */
export default async function TalentPoolPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const companies = await recruitmentAccess(s, scopeIds);
  const sp = await searchParams;
  const [t, nav, locale, tc] = await Promise.all([getTranslations('recruitment.pool'), getTranslations('nav'), getLocale(), getTranslations('recruitment.cand')]);
  const pool = await talentPool(s, companies.map((c) => c.id), { jobId: sp.job, reasonId: sp.reason, since: sp.since, tagId: sp.tag });
  const here = `/recruitment/talent-pool?${new URLSearchParams(Object.entries({ job: sp.job ?? '', reason: sp.reason ?? '', since: sp.since ?? '', tag: sp.tag ?? '' }).filter(([, v]) => v))}`;
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={t('purpose')} />
      <RecruitmentTabs active="talentPool" />
      <Notice text={sp.notice === 'saved' ? t('addedNotice') : undefined} />
      <ErrorBanner message={await recruitmentErrorText(sp.problem)} />
      {companies.length === 0 ? <NoRecruitmentCompany /> : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:max-w-md">
            <div className="rounded-xl border border-border bg-card px-4 py-3"><dt className="text-xs text-muted-foreground">{t('today')}</dt><dd className="text-2xl font-semibold tabular-nums">{pool.totals.today}</dd></div>
            <div className="rounded-xl border border-border bg-card px-4 py-3"><dt className="text-xs text-muted-foreground">{t('total')}</dt><dd className="text-2xl font-semibold tabular-nums">{pool.totals.total}</dd></div>
          </dl>
          <form method="get" className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-5">
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('filterPosition')}
              <select name="job" defaultValue={sp.job ?? ''} className={selectCls}>
                <option value="">{t('any')}</option>
                {pool.jobs.map((j) => <option key={j.id} value={j.id}>{j.title} · {j.jobNumber}</option>)}
              </select></label>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('filterReason')}
              <select name="reason" defaultValue={sp.reason ?? ''} className={selectCls}>
                <option value="">{t('any')}</option>
                {pool.reasons.map((r) => <option key={r.id} value={r.id}>{r.internal}</option>)}
              </select></label>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('filterSince')}
              <Input name="since" type="date" defaultValue={sp.since ?? ''} /></label>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{tc('tagFilter')}
              <select name="tag" defaultValue={sp.tag ?? ''} className={selectCls}>
                <option value="">{tc('anyTag')}</option>
                {pool.tags.map((g) => <option key={g.id} value={g.id}>{g.groupName} · {g.name}</option>)}
              </select></label>
            <div className="flex items-end gap-2">
              <button type="submit" className={btnPrimary}>{t('apply')}</button>
              <Link href="/recruitment/talent-pool" className={btnGhost}>{t('reset')}</Link>
            </div>
          </form>
          {pool.cards.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('empty')}</p> : (
            <ul className="grid gap-3 lg:grid-cols-2">
              {pool.cards.map((c) => (
                <li key={c.applicationId} className="space-y-3 rounded-xl border border-border bg-card p-4">
                  <div>
                    <p className="font-medium">{c.removed ? tc('removedLabel') : c.candidateName}</p>
                    <p className="text-xs text-muted-foreground">{[c.email, c.phone].filter(Boolean).join(' · ') || t('noContact')}</p>
                    {c.tags.length > 0 && (
                      <ul aria-label={tc('tags')} className="mt-1 flex flex-wrap gap-1">
                        {c.tags.map((tag) => <li key={tag.id} className="rounded-full border border-border px-2 py-0.5 text-xs">{tag.name}</li>)}
                      </ul>
                    )}
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-xs">
                    <div><dt className="text-muted-foreground">{t('position')}</dt><dd>{c.jobTitle} <span className="font-mono">{c.jobNumber}</span></dd></div>
                    <div><dt className="text-muted-foreground">{t('applied')}</dt><dd>{klDate(locale, c.appliedAt)}</dd></div>
                    <div><dt className="text-muted-foreground">{t('archived')}</dt><dd>{klDate(locale, c.archivedAt)}</dd></div>
                    <div><dt className="text-muted-foreground">{t('stageLeft')}</dt><dd>{c.stageLeft}</dd></div>
                    <div className="col-span-2"><dt className="text-muted-foreground">{t('reason')}</dt><dd>{c.reason}</dd></div>
                  </dl>
                  {c.addable.length > 0 ? (
                    <form action={addPoolCandidateToJobAction} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="applicationId" value={c.applicationId} />
                      <input type="hidden" name="returnTo" value={here} />
                      <label className="sr-only" htmlFor={`job-${c.applicationId}`}>{t('addToJob')}</label>
                      <select id={`job-${c.applicationId}`} name="jobId" required defaultValue="" className={cn(selectCls, 'h-9 w-56')}>
                        <option value="" disabled>{t('chooseJob')}</option>
                        {c.addable.map((j) => <option key={j.id} value={j.id}>{j.title} · {j.jobNumber}</option>)}
                      </select>
                      <button type="submit" className={btnPrimary}>{t('addToJob')}</button>
                    </form>
                  ) : <p className="text-xs text-muted-foreground">{c.removed ? tc('removedNote') : t('noOpenJob')}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
