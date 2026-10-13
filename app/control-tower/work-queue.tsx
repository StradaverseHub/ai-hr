import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { orchestrationQueue } from '@/core/hr-orchestrator';
import { Card } from '@/components/ui';
import { refreshOrchestrationAction } from './orchestrator-actions';
import { RefreshWorkButton } from './refresh-button';

export async function OrchestrationWorkQueue({ view, refresh, canViewRuns = false }: {
  view: Awaited<ReturnType<typeof orchestrationQueue>>;
  refresh?: string;
  canViewRuns?: boolean;
}) {
  const t = await getTranslations('controlTower.orchestrator');
  const gaps = await getTranslations('controlTower.readinessScreen.gap');
  const f = await getFormatter();
  return <Card className="overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-3 p-5">
      <div><h2 className="text-lg font-semibold">{t('workTitle')}</h2><p className="mt-1 max-w-prose text-sm text-muted-foreground">{t('workDescription')}</p></div>
      <form action={refreshOrchestrationAction}><RefreshWorkButton /></form>
    </div>
    {refresh === 'failed' && <p role="alert" className="px-5 pb-3 text-sm text-destructive">{t('refreshFailed')}</p>}
    {refresh === 'complete' && <p role="status" className="px-5 pb-3 text-sm">{t('refreshed')}</p>}
    {view.lastRun?.failed && <p role="status" className="px-5 pb-3 text-sm text-amber-700 dark:text-amber-300">{t('runFailed')}</p>}
    <div className="flex flex-wrap gap-x-6 gap-y-2 border-y border-border px-5 py-3 text-sm">
      <span>{t('openCount', { count: view.total })}</span><span>{t('verifiedCount', { count: view.verified })}</span>
      <Link href="/control-tower/agents" className="text-primary hover:underline">{t('manage')}</Link>
      {canViewRuns && <Link href="/admin/scheduled-actions" className="text-primary hover:underline">{t('runs')}</Link>}
    </div>
    {view.observedAt && <p className="px-5 pt-3 text-xs text-muted-foreground">{t('observed', { date: f.dateTime(view.observedAt, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }) })}</p>}
    {view.rows.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{t(view.observedAt ? 'empty' : 'unobserved')}</p> : <>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead className="border-b border-border text-muted-foreground"><tr>
          {['employee', 'issue', 'next', 'owner'].map(k => <th key={k} scope="col" className="px-5 py-3 font-medium">{t(k)}</th>)}
        </tr></thead>
        <tbody className="divide-y divide-border">{view.rows.map(row => <tr key={row.id}>
          <td className="px-5 py-3"><Link className="font-medium text-primary hover:underline" href={`/admin/personnel/${row.employmentId}`}>{row.name}</Link><p className="mt-1 text-xs text-muted-foreground">{row.company}</p></td>
          <td className="px-5 py-3">{gaps.has(row.gap) ? gaps(row.gap) : row.gap}{row.reopenCount > 0 && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{t('reopened', { count: row.reopenCount })}</p>}</td>
          <td className="px-5 py-3">{t(row.state === 'needs_input' ? 'collect' : 'review')}</td>
          <td className="px-5 py-3">{t(row.audience === 'employee' ? 'employee' : 'hr')}</td>
        </tr>)}</tbody>
      </table></div>
      {view.total > view.rows.length && <p className="px-5 py-3 text-xs text-muted-foreground">{t('shown', { shown: view.rows.length, total: view.total })} <Link href="/control-tower/readiness" className="text-primary hover:underline">{t('readiness')}</Link></p>}
    </>}
    <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">{t('verificationNote')}</p>
  </Card>;
}
