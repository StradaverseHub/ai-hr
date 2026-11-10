import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, Input, PageHeader, StatusBadge, btnGhost, btnPrimary, tableWrapCls, tbodyCls, thCls, theadCls } from '@/components/ui';
import { cn } from '@/lib/utils';
import { listJobs } from '@/packs/recruitment/service';
import { NoRecruitmentCompany, RecruitmentTabs, recruitmentAccess, recruitmentErrorText, selectCls } from '../shared';

type Search = { tab?: string; title?: string; jobNumber?: string; department?: string; recruiter?: string; error?: string };

/** Recruitment › Positions: Opening (Open + On hold) and Closed, with filters. */
export default async function RecruitmentPositionsPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const companies = await recruitmentAccess(s, scopeIds);
  const sp = await searchParams;
  const tab = sp.tab === 'closed' ? 'closed' : 'opening';
  const [t, nav, list] = await Promise.all([
    getTranslations('recruitment.positions'), getTranslations('nav'),
    listJobs(s, companies.map((c) => c.id), { tab, title: sp.title, jobNumber: sp.jobNumber, departmentId: sp.department, recruiterUserId: sp.recruiter }),
  ]);
  const status = await getTranslations('recruitment.status');
  const keep = (next: Record<string, string>) => {
    const q = new URLSearchParams(Object.entries({ title: sp.title ?? '', jobNumber: sp.jobNumber ?? '', department: sp.department ?? '', recruiter: sp.recruiter ?? '', ...next }).filter(([, v]) => v));
    return `/recruitment/positions${q.size ? `?${q}` : ''}`;
  };
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={t('purpose')}
        actions={companies.length ? <Link href="/recruitment/positions/new" className={btnPrimary}>{t('new')}</Link> : undefined} />
      <RecruitmentTabs active="positions" />
      <ErrorBanner message={await recruitmentErrorText(sp.error)} />
      {companies.length === 0 ? <NoRecruitmentCompany /> : (
        <>
          <div role="tablist" aria-label={t('statusTabs')} className="flex gap-2">
            {(['opening', 'closed'] as const).map((key) => (
              <Link key={key} role="tab" aria-selected={tab === key} href={keep({ tab: key === 'closed' ? 'closed' : '' })}
                className={cn('rounded-full border px-3 py-1 text-sm', tab === key ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent')}>
                {key === 'opening' ? t('opening') : t('closed')} <span className="tabular-nums">({list.counts[key]})</span>
              </Link>
            ))}
          </div>
          <form method="get" className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-5">
            {tab === 'closed' && <input type="hidden" name="tab" value="closed" />}
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('filterTitle')}
              <Input name="title" defaultValue={sp.title ?? ''} /></label>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('filterJobNumber')}
              <Input name="jobNumber" defaultValue={sp.jobNumber ?? ''} placeholder="MJ000001" /></label>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('filterDepartment')}
              <select name="department" defaultValue={sp.department ?? ''} className={selectCls}>
                <option value="">{t('any')}</option>
                {list.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select></label>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('filterRecruiter')}
              <select name="recruiter" defaultValue={sp.recruiter ?? ''} className={selectCls}>
                <option value="">{t('any')}</option>
                {list.recruiters.map((r) => <option key={r.id} value={r.id}>{r.name || t('unnamedUser')}</option>)}
              </select></label>
            <div className="flex items-end gap-2">
              <button type="submit" className={btnPrimary}>{t('apply')}</button>
              <Link href={tab === 'closed' ? '/recruitment/positions?tab=closed' : '/recruitment/positions'} className={btnGhost}>{t('reset')}</Link>
            </div>
          </form>
          {list.rows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{tab === 'closed' ? t('emptyClosed') : t('emptyOpening')}</p>
          ) : (
            <div className={tableWrapCls}>
              <table className="w-full text-sm">
                <thead className={theadCls}>
                  <tr><th className={thCls}>{t('colBasic')}</th><th className={thCls}>{t('colStatus')}</th><th className={thCls}>{t('colRecruiter')}</th>
                    <th className={cn(thCls, 'text-right')}>{t('colCandidates')}</th><th className={cn(thCls, 'text-right')}>{t('colOnboardedHired')}</th></tr>
                </thead>
                <tbody className={tbodyCls}>
                  {list.rows.map((row) => (
                    <tr key={row.id} className="hover:bg-accent/40">
                      <td className="px-3 py-2">
                        <Link href={`/recruitment/positions/${row.id}`} className="font-medium text-foreground hover:underline">{row.title}</Link>
                        <div className="text-xs text-muted-foreground"><span className="font-mono">{row.jobNumber}</span> · {row.companyName}{row.departmentName ? ` · ${row.departmentName}` : ''} · {row.workLocation}</div>
                      </td>
                      <td className="px-3 py-2"><StatusBadge status={row.status} label={status(row.status)} /></td>
                      <td className="px-3 py-2">{row.recruiterName ?? <span className="text-muted-foreground">{t('noRecruiter')}</span>}</td>
                      <td className="px-3 py-2 text-right tabular-nums"><Link href={`/recruitment/candidates?job=${row.id}`} className="hover:underline">{row.candidates}</Link></td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.onboarding} / {row.hired}</td>
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
