import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, PageHeader, btnGhost, btnPrimary, tableWrapCls, tbodyCls, thCls, theadCls } from '@/components/ui';
import { cn } from '@/lib/utils';
import { listRequisitions, REQUISITION_APPROVAL_STATUSES, REQUISITION_TABS } from '@/packs/recruitment/service';
import { NoRecruitmentCompany, Pill, RecruitmentTabs, SubTabs, klDate, recruitmentAccess, recruitmentErrorText, selectCls } from '../shared';

type Search = { tab?: string; department?: string; manager?: string; creator?: string; hasJob?: string; approval?: string; problem?: string };

/**
 * Recruitment › Positions › Job requisitions (administrators): status tabs with counts, filters (department, hiring
 * manager, creator, has associated job, approval status) and the vacancy figures, which are count queries.
 */
export default async function RecruitmentRequisitionsPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const companies = await recruitmentAccess(s, scopeIds);
  const sp = await searchParams;
  const [t, nav, locale] = await Promise.all([getTranslations('recruitment.req'), getTranslations('nav'), getLocale()]);
  const list = await listRequisitions(s, companies.map((c) => c.id), {
    tab: sp.tab, departmentId: sp.department, hiringManagerUserId: sp.manager, creatorUserId: sp.creator, hasJob: sp.hasJob, approvalStatus: sp.approval,
  });
  const keep = (next: Record<string, string>) => {
    const q = new URLSearchParams(Object.entries({ department: sp.department ?? '', manager: sp.manager ?? '', creator: sp.creator ?? '', hasJob: sp.hasJob ?? '', approval: sp.approval ?? '', ...next }).filter(([, v]) => v));
    return `/recruitment/requisitions${q.size ? `?${q}` : ''}`;
  };
  const filter = (name: string, label: string, value: string | undefined, choices: { id: string; name: string }[]) => (
    <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{label}
      <select name={name} defaultValue={value ?? ''} className={selectCls}>
        <option value="">{t('any')}</option>
        {choices.map((c) => <option key={c.id} value={c.id}>{c.name || t('unnamedUser')}</option>)}
      </select></label>
  );
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={t('purpose')}
        actions={companies.length ? <Link href="/recruitment/requisitions/new" className={btnPrimary}>{t('new')}</Link> : undefined} />
      <RecruitmentTabs active="positions" />
      <SubTabs label={t('areaTabs')} items={[
        { key: 'positions', href: '/recruitment/positions', text: t('positionsTab'), current: false },
        { key: 'requisitions', href: '/recruitment/requisitions', text: t('requisitionsTab'), current: true },
      ]} />
      <ErrorBanner message={await recruitmentErrorText(sp.problem)} />
      {companies.length === 0 ? <NoRecruitmentCompany /> : (
        <>
          <div role="tablist" aria-label={t('statusTabs')} className="flex flex-wrap gap-2">
            <Link role="tab" aria-selected={!sp.tab} href={keep({})} className={cn('rounded-full border px-3 py-1 text-sm', !sp.tab ? 'border-primary bg-primary/10' : 'border-border text-muted-foreground hover:bg-accent')}>
              {t('all')} <span className="tabular-nums">({Object.values(list.counts).reduce((a, b) => a + b, 0)})</span></Link>
            {REQUISITION_TABS.map((key) => (
              <Link key={key} role="tab" aria-selected={sp.tab === key} href={keep({ tab: key })}
                className={cn('rounded-full border px-3 py-1 text-sm', sp.tab === key ? 'border-primary bg-primary/10' : 'border-border text-muted-foreground hover:bg-accent')}>
                {t(`status.${key}`)} <span className="tabular-nums">({list.counts[key]})</span>
              </Link>
            ))}
          </div>
          <form method="get" className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-3 lg:grid-cols-6">
            {sp.tab && <input type="hidden" name="tab" value={sp.tab} />}
            {filter('department', t('filterDepartment'), sp.department, list.departments)}
            {filter('manager', t('hiringManager'), sp.manager, list.hiringManagers)}
            {filter('creator', t('filterCreator'), sp.creator, list.creators)}
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('filterHasJob')}
              <select name="hasJob" defaultValue={sp.hasJob ?? ''} className={selectCls}>
                <option value="">{t('any')}</option><option value="yes">{t('yes')}</option><option value="no">{t('no')}</option>
              </select></label>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('filterApproval')}
              <select name="approval" defaultValue={sp.approval ?? ''} className={selectCls}>
                <option value="">{t('any')}</option>
                {REQUISITION_APPROVAL_STATUSES.map((a) => <option key={a} value={a}>{t(`approvalStatus.${a}`)}</option>)}
              </select></label>
            <div className="flex items-end gap-2">
              <button type="submit" className={btnPrimary}>{t('apply')}</button>
              <Link href="/recruitment/requisitions" className={btnGhost}>{t('reset')}</Link>
            </div>
          </form>
          {list.rows.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('empty')}</p> : (
            <div className={tableWrapCls}>
              <table className="w-full text-sm">
                <thead className={theadCls}><tr>
                  <th className={thCls}>{t('colBasic')}</th><th className={thCls}>{t('colStatus')}</th><th className={thCls}>{t('hiringManager')}</th>
                  <th className={cn(thCls, 'text-right')}>{t('vacancies')}</th><th className={cn(thCls, 'text-right')}>{t('remainingOffers')}</th>
                  <th className={cn(thCls, 'text-right')}>{t('remainingOnboarding')}</th><th className={thCls}>{t('targetOnboardDate')}</th>
                </tr></thead>
                <tbody className={tbodyCls}>
                  {list.rows.map((r) => (
                    <tr key={r.id} className="hover:bg-accent/40">
                      <td className="px-3 py-2"><Link href={`/recruitment/requisitions/${r.id}`} className="font-medium hover:underline">{r.title}</Link>
                        <div className="text-xs text-muted-foreground"><span className="font-mono">{r.reqNumber}</span> · {r.companyName}{r.departmentName ? ` · ${r.departmentName}` : ''} · {t('jobsCount', { n: r.jobs })}</div></td>
                      <td className="px-3 py-2"><div className="flex flex-col items-start gap-1">
                        <Pill tone={r.status === 'expired' ? 'warn' : r.status === 'completed' ? 'good' : r.status === 'cancelled' ? 'neutral' : 'info'}>{t(`status.${r.status}`)}</Pill>
                        {r.approvalStatus !== 'not_submitted' && <span className="text-xs text-muted-foreground">{t(`approvalStatus.${r.approvalStatus}`)}</span>}</div></td>
                      <td className="px-3 py-2">{r.hiringManagerName ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.vacancies}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.remainingOffers}{r.overFilled && <span className="ml-1 text-xs text-amber-700 dark:text-amber-400">{t('overFilled')}</span>}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.remainingOnboarding}</td>
                      <td className="px-3 py-2">{r.targetOnboardDate ? klDate(locale, `${r.targetOnboardDate}T00:00:00+08:00`) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
