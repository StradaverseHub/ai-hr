'use client';
import {useTranslations} from 'next-intl';
import type {ProbationAutomationHistoryRun} from '@/packs/probation/service';
import {probationTimestamp} from '@/lib/probation-display';

/**
 * The case History of shared workflow runs (I5): each run with its trigger and status, skipped steps with the reason,
 * failures, and recipients nobody resolved for (the fallback group received it). Bounded by the reader; people are counts.
 */
export function AutomationHistory({runs}:{runs:ProbationAutomationHistoryRun[]}){
 const t=useTranslations('probation');
 return <section className="v9-panel v9-stack" aria-label={t('automationHistory.title')}><h2>{t('automationHistory.title')}</h2>
  {!runs.length?<p className="v9-muted">{t('automationHistory.empty')}</p>:<ol className="v9-list">{runs.map(run=><li key={run.id}>
   <strong>{run.triggerLabel}</strong> · <span className={run.status==='failed'?'v9-badge v9-badge-amber':'v9-badge'}>{t('automationHistory.status.'+run.status)}</span> · {probationTimestamp(run.startedAt)}
   {run.failure&&<p role="status" className="v9-notice v9-warning">{run.failure}</p>}
   <ul className="v9-list">{run.entries.map((entry,index)=><li key={index}><span className="v9-muted">{probationTimestamp(entry.at)}</span> {entry.message}
    {entry.recipients>0&&<span className="v9-muted"> · {t('automationHistory.recipients',{count:entry.recipients})}</span>}
    {entry.unresolved.map((item,i)=><p key={i} className="v9-muted">{t('automationHistory.unresolved',{who:item.meantFor,reason:item.reason})}</p>)}</li>)}</ul>
  </li>)}</ol>}
 </section>;
}
