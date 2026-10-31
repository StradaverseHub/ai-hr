import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { orchestrationQueue } from '@/core/hr-orchestrator';
import { ORCHESTRATION_STEP_IDS } from '@/core/orchestrator-harness';
import { Card } from '@/components/ui';
import { refreshOrchestrationAction } from './orchestrator-actions';
import { RefreshWorkButton } from './refresh-button';

export async function OrchestrationWorkQueue({ view, refresh, canViewRuns = false, returnTo = '/control-tower' }: {
  view: Awaited<ReturnType<typeof orchestrationQueue>>;
  refresh?: string;
  canViewRuns?: boolean;
  returnTo?: '/control-tower' | '/control-tower/agents';
}) {
  const t = await getTranslations('controlTower.orchestrator');
  const corrections = await getTranslations('controlTower.corrections');
  const gaps = await getTranslations('controlTower.readinessScreen.gap');
  const f = await getFormatter();
  const run = view.lastRun;
  const runOutcome = run?.failed === true ? 'failed' : run?.failed === false ? 'succeeded' : 'unknown';
  const incompleteRun = run && (run.failed === null || run.harnessVersion === null || Object.values(run.steps).includes('unknown'));
  // The owner picks the oldest open issues (core/hr-orchestrator.ts, oldest first, at most 50) and the
  // note below says so. Display order only, so each person's gaps sit together: company, then name, then gap.
  // The id tie-breaks keep two people with one name apart and the order deterministic.
  const gapLabel = (gap: string) => gaps.has(gap) ? gaps(gap) : gap;
  const rows = [...view.rows].sort((a, b) => (a.company ?? '').localeCompare(b.company ?? '') || (a.name ?? '').localeCompare(b.name ?? '')
    || a.employmentId.localeCompare(b.employmentId) || gapLabel(a.gap).localeCompare(gapLabel(b.gap)) || a.id.localeCompare(b.id));
  return <Card className="overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-3 p-5">
      <div><h2 className="text-lg font-semibold">{t('workTitle')}</h2><p className="mt-1 max-w-prose text-sm text-muted-foreground">{t('workDescription')}</p></div>
      <form action={refreshOrchestrationAction}><input type="hidden" name="returnTo" value={returnTo}/><RefreshWorkButton /></form>
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
    {view.scheduledRun && <p className="px-5 pt-3 text-xs text-muted-foreground">{t('scheduledScopeNote')}</p>}
    {run && <details className="mx-5 mt-3 border-y border-border">
      <summary className="min-h-11 cursor-pointer rounded py-3 text-sm focus-visible:outline-2 focus-visible:outline-ring">
        <span className="font-medium">{t('runDetails.title')}</span>
        <span className={`ml-3 inline-block ${run.failed === true ? 'text-destructive' : 'text-muted-foreground'}`}>{t(`runDetails.outcomes.${runOutcome}`)}</span>
      </summary>
      <div className="space-y-3 pb-4">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          <span>{t('runDetails.recorded', { date: f.dateTime(run.at, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }) })}</span>
          {run.harnessVersion && <span>{t('runDetails.version', { version: run.harnessVersion })}</span>}
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">{ORCHESTRATION_STEP_IDS.map(step => <div key={step}>
          <dt className="font-medium">{t(`runDetails.steps.${step}`)}</dt>
          <dd className={`mt-1 ${run.steps[step] === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{t(`runDetails.states.${run.steps[step]}`)}</dd>
        </div>)}</dl>
        {incompleteRun && <p className="text-sm text-muted-foreground">{t('runDetails.incomplete')}</p>}
        <p className="text-xs text-muted-foreground">{t('runDetails.receiptNote')}</p>
        <p className="text-xs text-muted-foreground">{t('runDetails.evidenceNote')}</p>
      </div>
    </details>}
    {view.rows.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{t(view.observedAt ? 'empty' : 'unobserved')}</p> : <>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead className="border-b border-border text-muted-foreground"><tr>
          {['employee', 'issue', 'next', 'owner'].map(k => <th key={k} scope="col" className="px-5 py-3 font-medium">{t(k)}</th>)}
        </tr></thead>
        <tbody className="divide-y divide-border">{rows.map(row => <tr key={row.id}>
          <td className="px-5 py-3"><Link className="font-medium text-primary hover:underline" href={`/admin/personnel/${row.employmentId}`}>{row.name}</Link><p className="mt-1 text-xs text-muted-foreground">{row.company}</p></td>
          <td className="px-5 py-3">{gapLabel(row.gap)}{row.reopenCount > 0 && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{t('reopened', { count: row.reopenCount })}</p>}</td>
          <td className="px-5 py-3">{view.actionsUnavailable ? corrections('actionUnavailable') : row.action?.type === 'review_submission'
            ? row.action.mayReview
              ? <Link href="/approvals" className="font-medium text-primary hover:underline">{corrections('review')}</Link>
              : corrections(row.action.approver === 'group_admin' ? 'waitingGroup' : 'waiting')
            : t((row.action?.audience ?? row.audience) === 'employee' ? 'collect' : 'review')}</td>
          <td className="px-5 py-3">{view.actionsUnavailable ? '—' : row.action?.type === 'review_submission' && row.action.approver === 'group_admin'
            ? corrections('groupHr') : t((row.action?.audience ?? row.audience) === 'employee' ? 'employee' : 'hr')}</td>
        </tr>)}</tbody>
      </table></div>
      {view.total > view.rows.length && <p className="px-5 py-3 text-xs text-muted-foreground">{t('shown', { shown: view.rows.length, total: view.total })} <Link href="/control-tower/readiness" className="text-primary hover:underline">{t('readiness')}</Link></p>}
    </>}
    <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">{t('verificationNote')}</p>
  </Card>;
}
