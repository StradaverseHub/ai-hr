import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import type { WorkerDetail, WorkerRow } from '@/core/agent-registry/views';
import type { OutcomeSummary } from '@/core/agent-registry/export';
import { Card, SectionHeader, btnGhost } from '@/components/ui';
import { cn } from '@/lib/utils';
import { aiManagementHref } from './sections';
import { setAiFeatureAction } from './actions';

/** AI centre › Workers for a group administrator: the registered workers (ADR-0170 §3.13) as the step 5
 * registry reports them (core/agent-registry/views.ts listWorkers). Every value is read from the system;
 * an unmeasured rate is shown with its reason, never as 0. Every worker links to where its existing switch lives (a job-type worker links to its enablement control); the two
 * registry-controlled switches (approver recommendations, explainers) are changed here (see switchControl). Company administrators never
 * receive these rows: the service refuses them and the page shows the feature table only. */
const percent = (value: number) => `${Math.round(value * 100)}%`;
const known = (t: ReturnType<typeof useTranslations>, key: string, fallback: string) => (t.has(key) ? t(key) : fallback);

function switchControl(t: ReturnType<typeof useTranslations>, row: WorkerRow) {
  // A registry-controlled switch posts to the existing AI-feature switch action, whose closed worker branch
  // re-checks the group-administrator role; the step 5 service checks it again with the worker's module.
  if (row.switch.owner === 'worker_control') return (
    <form action={setAiFeatureAction} data-worker-switch={row.id}>
      <input type="hidden" name="worker" value={row.id} />
      <input type="hidden" name="enabled" value={String(!row.switch.on)} />
      {row.id === 'conversation' && !row.switch.on && (
        // Only needed for a direct upstream provider; an OpenRouter route sends zero-retention and no-training on every request.
        <label className="mb-2 flex max-w-xs items-start gap-2 text-xs text-muted-foreground">
          <input type="checkbox" name="attestDirectProvider" value="true" className="mt-0.5" />
          <span>{t('conversationAttest')}</span>
        </label>
      )}
      <button type="submit" className={btnGhost} aria-label={`${t(row.switch.on ? 'turnOff' : 'turnOn')} · ${known(t, `workers.${row.id}`, row.label)}`}>{t(row.switch.on ? 'turnOff' : 'turnOn')}</button>
      <p className="mt-1 text-xs text-muted-foreground">{t('switchOwner.worker_control')}</p>
    </form>
  );
  // Job-type enablement is managed here; each person still needs a valid mandate.
  if (row.switch.owner === 'job_type') return <Link href="#ai-centre-jobs" className="text-sm font-medium text-primary hover:underline">{t('switchOwner.job_type')}</Link>;
  const href = aiManagementHref('features', { anchor: '#ai-features' });
  return <Link href={href} className="text-sm font-medium text-primary hover:underline">{t(`switchOwner.${row.switch.owner}`)}</Link>;
}

export function WorkerRegistry({ rows, summary, detail }: { rows: readonly WorkerRow[]; summary: OutcomeSummary | null; detail: WorkerDetail | null }) {
  const t = useTranslations('aiCentre.registry');
  const tw = useTranslations('aiCentre.workers');
  const f = useFormatter();
  const when = (date: Date | null) => (date ? f.dateTime(date, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }) : t('never'));
  return (
    <>
      <Card id="ai-registry" className="scroll-mt-4 overflow-hidden">
        <div className="p-5"><SectionHeader title={t('title')} /><p className="mt-1 max-w-4xl text-sm text-muted-foreground">{t('help')}</p></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm"><caption className="sr-only">{t('title')}</caption>
            <thead className="border-y border-border bg-muted/40"><tr>{(['worker', 'runsUnder', 'switch', 'lastRun', 'response'] as const).map(key => <th key={key} scope="col" className="px-5 py-3 font-medium">{t(`columns.${key}`)}</th>)}</tr></thead>
            <tbody className="divide-y divide-border">{rows.map(row => {
              const name = known(t, `workers.${row.id}`, row.label);
              return <tr key={row.id} id={`worker-${row.id}`} className="scroll-mt-4 align-top">
                <td className="px-5 py-4">
                  <p className="font-medium">{name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{tw(`families.${row.family}`)} · {t(`trigger.${row.trigger.kind}`)} · {t(`effect.${row.effect}`)}</p>
                  <Link href={`${aiManagementHref('features')}?worker=${encodeURIComponent(row.id)}#worker-detail`} className="mt-1 inline-flex min-h-9 items-center text-xs font-medium text-primary hover:underline" aria-label={`${t('details')} · ${name}`}>{t('details')}</Link>
                </td>
                <td className="px-5 py-4 text-xs">
                  <p>{row.authority.kind === 'mandate' ? t('authority.mandate') : t(`authority.${row.authority.actsAs}`)}</p>
                  {row.mandates && <p className="mt-1 text-muted-foreground">{t('mandates', { active: row.mandates.active, total: row.mandates.total })}</p>}
                </td>
                <td className="px-5 py-4">
                  <p className={cn('text-sm', row.gate.run ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground')}>{row.stopped ? t('stopped') : row.switch.on ? t('on') : t('off')}</p>
                  {row.switch.detail === 'unattributed' && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{t('unattributed')}</p>}
                  {!row.stopHonoured && <p className="mt-1 text-xs text-muted-foreground">{t('stopPending')}</p>}
                  <div className="mt-2">{switchControl(t, row)}</div>
                </td>
                <td className="px-5 py-4 text-xs tabular-nums">{when(row.lastRunAt)}</td>
                <td className="px-5 py-4 text-xs">
                  {row.metrics.measured && row.metrics.acceptanceRate !== null
                    ? <><p>{t('accepted', { rate: percent(row.metrics.acceptanceRate) })}</p>{row.metrics.reversalRate !== null && <p className="text-muted-foreground">{t('reversed', { rate: percent(row.metrics.reversalRate) })}</p>}<p className="text-muted-foreground">{t('decided', { count: row.metrics.decided })}</p></>
                    : <p className="text-muted-foreground">{t('notMeasured', { count: row.metrics.decided })}</p>}
                </td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      </Card>
      {detail && <Card id="worker-detail" className="scroll-mt-4 p-5">
        <SectionHeader title={t('detailTitle', { name: known(t, `workers.${detail.worker.id}`, detail.worker.label) })} />
        <h3 className="mt-3 text-sm font-medium">{t('recentRuns')}</h3>
        {detail.recentRuns.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">{t('noRuns')}</p>
          : <ul className="mt-2 divide-y divide-border text-sm">{detail.recentRuns.map((run, index) => <li key={run.runId ?? index} className="flex flex-wrap justify-between gap-2 py-2">
            <span className="tabular-nums">{when(run.at)}</span>
            <span className="text-muted-foreground">{[run.outcomeKind && known(t, `outcome.${run.outcomeKind}`, run.outcomeKind), run.humanInvolvement && known(t, `involvement.${run.humanInvolvement}`, run.humanInvolvement), run.decision && known(t, `decision.${run.decision}`, run.decision)].filter(Boolean).join(' · ')}</span>
          </li>)}</ul>}
        {detail.mandates.length > 0 && <>
          <h3 className="mt-4 text-sm font-medium">{t('mandateList')}</h3>
          <ul className="mt-2 divide-y divide-border text-sm">{detail.mandates.map(mandate => <li key={mandate.id} className="flex flex-wrap justify-between gap-2 py-2">
            <span>{known(t, `mandateState.${mandate.state}`, mandate.state)}{mandate.revokedBy && ` · ${t(`revokedBy.${mandate.revokedBy}`)}`}</span>
            <span className="tabular-nums text-muted-foreground">{t('validUntil', { date: f.dateTime(mandate.validUntil, { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' }) })}</span>
          </li>)}</ul>
          <p className="mt-2 text-xs text-muted-foreground">{t('mandateGrantors')}</p>
        </>}
        <Link href={aiManagementHref('features', { anchor: `#worker-${detail.worker.id}` })} className="mt-3 inline-flex min-h-9 items-center text-sm font-medium text-primary hover:underline">{t('closeDetail')}</Link>
      </Card>}
      {summary && <Card id="ai-outcomes" className="scroll-mt-4 p-5">
        <SectionHeader title={t('summaryTitle')} /><p className="mt-1 max-w-4xl text-sm text-muted-foreground">{t('summaryHelp', { count: summary.records })}</p>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">{(['watcher', 'chaser', 'preparer', 'decider', 'explainer'] as const).map(family => (
          <div key={family} className="rounded-lg border border-border p-3"><dt className="text-xs text-muted-foreground">{tw(`families.${family}`)}</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{summary.byFamily[family] ?? 0}</dd></div>
        ))}</dl>
      </Card>}
    </>
  );
}
