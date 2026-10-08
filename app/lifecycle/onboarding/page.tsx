import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button, Card, ErrorBanner, PageHeader, tableWrapCls, tbodyCls, theadCls, thCls } from '@/components/ui';
import { LEVEL, listCases } from '@/packs/lifecycle/service';
import { lifecycleSession } from '../_guard';
import { LifecycleTabs, Pill, ProgressBar, fmt } from '../_ui';

export default async function OnboardingList({ searchParams }: { searchParams: Promise<{ view?: string; error?: string }> }) {
  const { s, level } = await lifecycleSession(LEVEL.agent);
  const t = await getTranslations('lifecycle');
  const sp = await searchParams;
  const history = sp.view === 'history' && level >= LEVEL.manager;
  const rows = await listCases(s, 'onboarding', { history });
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('onboarding.title')} description={t('onboarding.subtitle')}
        actions={<><Link href="/lifecycle/onboarding/import"><Button size="sm" variant="outline">{t('onboarding.import')}</Button></Link><Link href="/lifecycle/onboarding/new"><Button size="sm">{t('onboarding.new')}</Button></Link></>} />
      <ErrorBanner message={sp.error} />
      <LifecycleTabs level={level} active="onboarding" />
      <div className="flex items-center gap-4 text-sm">
        <Link href="/lifecycle/onboarding" className={!history ? 'font-medium' : 'text-muted-foreground hover:text-foreground'}>{t('common.active')}</Link>
        {level >= LEVEL.manager && <Link href="/lifecycle/onboarding?view=history" className={history ? 'font-medium' : 'text-muted-foreground hover:text-foreground'}>{t('common.historyList')}</Link>}
        {level >= LEVEL.manager && <a className="ml-auto text-primary underline-offset-2 hover:underline" href="/lifecycle/export/onboarding">{t('common.exportCsv')}</a>}
      </div>
      <Card className={tableWrapCls}>
        <table className="w-full text-sm">
          <thead className={theadCls}><tr><th className={thCls}>{t('case.number')}</th><th className={thCls}>{t('case.name')}</th><th className={thCls}>{t('case.employeeNo')}</th><th className={thCls}>{t('case.joinDate')}</th><th className={thCls}>{t('case.progress')}</th><th className={thCls}>{t('case.requisition')}</th><th className={thCls}>{t('common.status')}</th></tr></thead>
          <tbody className={tbodyCls}>
            {rows.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">{t('onboarding.empty')}</td></tr>}
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="px-3 py-2"><Link href={`/lifecycle/onboarding/${c.number}`} className="text-primary underline-offset-2 hover:underline">{c.number}</Link></td>
                <td className="px-3 py-2"><div>{c.fullName}</div><div className="text-xs text-muted-foreground">{c.jobTitle ?? ''}</div></td>
                <td className="px-3 py-2">{c.employeeNo}</td>
                <td className="px-3 py-2 tabular-nums">{fmt(c.joinDate)}</td>
                <td className="px-3 py-2"><ProgressBar percent={c.progress.percent} label={t('case.progress')} /></td>
                <td className="px-3 py-2">{c.requisitionNumber ? <Link href={`/lifecycle/requisitions/${c.requisitionNumber}`} className="text-primary underline-offset-2 hover:underline">{c.requisitionNumber}</Link> : '—'}</td>
                <td className="px-3 py-2"><Pill value={c.status} label={t(`status.${c.status}`)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
