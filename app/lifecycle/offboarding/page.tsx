import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button, Card, ErrorBanner, PageHeader, tableWrapCls, tbodyCls, theadCls, thCls } from '@/components/ui';
import { LEVEL, listCases } from '@/packs/lifecycle/service';
import { lifecycleSession } from '../_guard';
import { LifecycleTabs, Pill, ProgressBar, fmt } from '../_ui';

export default async function OffboardingList({ searchParams }: { searchParams: Promise<{ view?: string; error?: string }> }) {
  const { s, level } = await lifecycleSession(LEVEL.agent);
  const t = await getTranslations('lifecycle');
  const sp = await searchParams;
  const history = sp.view === 'history' && level >= LEVEL.manager;
  const rows = await listCases(s, 'offboarding', { history });
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('offboarding.title')} description={t('offboarding.subtitle')} actions={<Link href="/lifecycle/offboarding/new"><Button size="sm">{t('offboarding.new')}</Button></Link>} />
      <ErrorBanner message={sp.error} />
      <LifecycleTabs level={level} active="offboarding" />
      <div className="flex items-center gap-4 text-sm">
        <Link href="/lifecycle/offboarding" className={!history ? 'font-medium' : 'text-muted-foreground hover:text-foreground'}>{t('common.active')}</Link>
        {level >= LEVEL.manager && <Link href="/lifecycle/offboarding?view=history" className={history ? 'font-medium' : 'text-muted-foreground hover:text-foreground'}>{t('common.historyList')}</Link>}
        {level >= LEVEL.manager && <a className="ml-auto text-primary underline-offset-2 hover:underline" href="/lifecycle/export/offboarding">{t('common.exportCsv')}</a>}
      </div>
      <Card className={tableWrapCls}>
        <table className="w-full text-sm">
          <thead className={theadCls}><tr><th className={thCls}>{t('case.number')}</th><th className={thCls}>{t('case.name')}</th><th className={thCls}>{t('case.employeeNo')}</th><th className={thCls}>{t('offboarding.outcome')}</th><th className={thCls}>{t('offboarding.lastWorkingDay')}</th><th className={thCls}>{t('case.progress')}</th><th className={thCls}>{t('common.status')}</th></tr></thead>
          <tbody className={tbodyCls}>
            {rows.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">{t('offboarding.empty')}</td></tr>}
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="px-3 py-2"><Link href={`/lifecycle/offboarding/${c.number}`} className="text-primary underline-offset-2 hover:underline">{c.number}</Link></td>
                <td className="px-3 py-2">{c.fullName}</td>
                <td className="px-3 py-2">{c.employeeNo}</td>
                <td className="px-3 py-2"><Pill value={c.outcome} label={t(`outcome.${c.outcome}`)} /></td>
                <td className="px-3 py-2 tabular-nums">{fmt(c.lastWorkingDay)}</td>
                <td className="px-3 py-2"><ProgressBar percent={c.progress.percent} label={t('case.progress')} /></td>
                <td className="px-3 py-2"><Pill value={c.status} label={t(`status.${c.status}`)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
