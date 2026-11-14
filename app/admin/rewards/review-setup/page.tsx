import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { Field, PageHeader, inputCls, tableWrapCls, tbodyCls, thCls, theadCls } from '@/components/ui';
import { RewardSubmit } from '@/app/rewards/submit-button';
import { rewardReviewSetupList, type RewardSetupListFilters } from '@/packs/rewards/service';
import { REWARD_PREPARATION_STEPS } from '@/packs/rewards/preparation-model';

type Search = { cycle?: string; unit?: string; status?: string; page?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 70d5e7c5 — Configuration › Review Set-up: one row per annual unit review, for Group Rewards (edit) and CTRO
 * and EC (view). Everyone else sees "You don't have access". The service filters, counts and pages in SQL.
 */
export default async function ReviewSetupList({ searchParams }: { searchParams: Promise<Search> }) {
  await requireModule('rewards');
  const { s } = await scopedSession(), sp = await searchParams;
  const t = await getTranslations('rewardsPreparation'), nav = await getTranslations('nav');
  const filters: RewardSetupListFilters & { page: number } = { ...(sp.cycle && uuid.test(sp.cycle) ? { cycle: sp.cycle } : {}), ...(sp.unit && uuid.test(sp.unit) ? { unit: sp.unit } : {}),
    ...(sp.status === 'preparing' || sp.status === 'ready' || sp.status === 'released' ? { status: sp.status as RewardSetupListFilters['status'] } : {}), page: Math.max(0, Math.min(10000, Math.trunc(Number(sp.page) || 0))) };
  const list = await rewardReviewSetupList(s, filters);
  if (!list.allowed) return <div className="space-y-3"><PageHeader title={nav('rewardsReviewSetup')} /><p role="status">{t('list.noAccess')}</p></div>;
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const href = (page: number) => { const q = new URLSearchParams({ ...(filters.cycle ? { cycle: filters.cycle } : {}), ...(filters.unit ? { unit: filters.unit } : {}), ...(filters.status ? { status: filters.status } : {}), ...(page ? { page: String(page) } : {}) }).toString(); return `/admin/rewards/review-setup${q ? `?${q}` : ''}`; };
  return <div className="space-y-5">
    <PageHeader title={nav('rewardsReviewSetup')} description={list.editor ? t('list.help') : t('list.viewHelp')} />
    <form className="flex flex-wrap items-end gap-3">
      <Field label={t('list.cycle')}><select name="cycle" defaultValue={filters.cycle ?? ''} className={inputCls}><option value="">{t('list.all')}</option>{list.cycles.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <Field label={t('list.unit')}><select name="unit" defaultValue={filters.unit ?? ''} className={inputCls}><option value="">{t('list.all')}</option>{list.units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
      <Field label={t('list.status')}><select name="status" defaultValue={filters.status ?? ''} className={inputCls}><option value="">{t('list.all')}</option>{(['preparing', 'ready', 'released'] as const).map(x => <option key={x} value={x}>{t(`list.statuses.${x}`)}</option>)}</select></Field>
      <RewardSubmit type="submit" variant="secondary">{t('list.filter')}</RewardSubmit>
    </form>
    <div className={tableWrapCls}><table className="w-full text-sm">
      <thead className={theadCls}><tr>{(['company', 'unit', 'cycle', 'snapshot', 'progress', 'status', 'expected', 'updatedBy'] as const).map(k => <th key={k} scope="col" className={thCls}>{t(`list.columns.${k}`)}</th>)}</tr></thead>
      <tbody className={tbodyCls}>{list.rows.map(row => <tr key={row.unitId}>
        <td className="px-3 py-3">{row.company}</td>
        <td className="px-3 py-3"><Link href={`/admin/rewards/review-setup/${row.unitId}`} className="font-medium text-primary hover:underline">{row.unit}</Link>{row.windowOutsideYear && <span className="mt-1 block text-xs text-destructive">{t('window.outsideShort')}</span>}</td>
        <td className="px-3 py-3">{row.cycle}</td>
        <td className="px-3 py-3 tabular-nums">{row.snapshotDate}</td>
        <td className="px-3 py-3">{row.legacy ? t('list.beforeTracking') : t('list.progress', { done: row.stepsDone, total: REWARD_PREPARATION_STEPS.length })}</td>
        <td className="px-3 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${row.status === 'released' ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100' : row.status === 'ready' ? 'bg-primary/10 text-primary' : 'bg-muted text-foreground'}`}>{t(`list.statuses.${row.status}`)}</span></td>
        <td className="px-3 py-3 tabular-nums">{row.expectedRelease ?? '—'}</td>
        <td className="px-3 py-3">{row.lastUpdatedBy ?? '—'}</td>
      </tr>)}</tbody>
    </table>{!list.rows.length && <p className="p-6 text-sm text-muted-foreground">{t('list.empty')}</p>}</div>
    {pages > 1 && <nav aria-label={t('list.pages')} className="flex flex-wrap items-center gap-3 text-sm">
      {list.page > 0 ? <Link href={href(list.page - 1)} className="text-primary hover:underline">← {t('list.previous')}</Link> : <span className="text-muted-foreground">← {t('list.previous')}</span>}
      <span className="tabular-nums">{t('list.pageOf', { page: list.page + 1, pages, total: list.total })}</span>
      {list.page < pages - 1 ? <Link href={href(list.page + 1)} className="text-primary hover:underline">{t('list.next')} →</Link> : <span className="text-muted-foreground">{t('list.next')} →</span>}
    </nav>}
  </div>;
}
