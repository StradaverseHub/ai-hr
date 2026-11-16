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
 return <section className="pcc-card" aria-label={t('automationHistory.title')}><h2>{t('automationHistory.title')}</h2>
  {!runs.length?<p className="pcc-muted">{t('automationHistory.empty')}</p>:<ol className="pcc-hist">{runs.map(run=><li key={run.id}>
   <span className="pcc-muted pcc-num">{probationTimestamp(run.startedAt)}</span>
   <div className="pcc-stack" style={{gap:6}}>
    <span><b>{run.triggerLabel}</b> · <span className={run.status==='failed'?'pcc-pill pcc-pill-warn':run.status==='done'?'pcc-pill pcc-pill-ok':'pcc-pill'}>{t('automationHistory.status.'+run.status)}</span></span>
    {run.failure&&<p role="status" className="pcc-banner pcc-banner-warn">{run.failure}</p>}
    {run.entries.length>0&&<ul className="pcc-wl">{run.entries.map((entry,index)=><li key={index} className="pcc-small"><span className="pcc-muted pcc-num">{probationTimestamp(entry.at)}</span> {entry.message}
     {entry.recipients>0&&<span className="pcc-muted"> · {t('automationHistory.recipients',{count:entry.recipients})}</span>}
     {entry.unresolved.map((item,i)=><p key={i} className="pcc-muted">{t('automationHistory.unresolved',{who:item.meantFor,reason:item.reason})}</p>)}</li>)}</ul>}
   </div>
  </li>)}</ol>}
 </section>;
}
