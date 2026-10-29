'use client';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { dateTrigger, afterTrigger, workflowMatches, workflowWhen, type Case, type Config } from '@/lib/lifecycle-v9-model';
import type { LifecycleV9Command } from '@/packs/lifecycle/service';
export function CaseWorkflows({ c,config,busy,command }: { c:Case;config:Config;busy:boolean;command:(command:LifecycleV9Command)=>void }) {
  const today=todayInKualaLumpur(),workflows=config.workflows.filter(workflow=>workflow.module===c.module&&(workflow.status==='published'&&workflowMatches(c,workflow,today)||c.runs.some(run=>run.workflowId===workflow.id)));
  return <section className="v9-panel v9-stack" aria-label="Workflows for this person"><h2>Workflows</h2>
    {!workflows.length&&<p className="v9-muted">No live workflows match this case.</p>}
    <ul className="v9-list">{workflows.map(workflow=>{
      const repeating=workflow.trigger.repeat&&dateTrigger(workflow.trigger.event)&&!afterTrigger(workflow.trigger.event);
      const run=c.runs.filter(run=>run.workflowId===workflow.id).at(-1),waiting=run?.status==='waiting'||run?.status==='failed',done=run?.status==='done'&&(!repeating||run.date===today),live=workflow.status==='published';
      return <li key={workflow.id}><div className="v9-heading"><div><strong>{workflow.name}</strong><p className="v9-muted">{workflowWhen(workflow)}</p></div><span className="v9-badge">{!live?'Paused':run?({running:'Running',waiting:'Waiting',done:'Done',skipped:'Skipped',failed:'Needs review'} as const)[run.status]:'Not started'}</span></div>
      {run?.reason&&<p className="v9-muted">{run.reason}</p>}
      <button type="button" className="v9-button" disabled={busy||c.state!=='submitted'||!live||done||!workflowMatches(c,workflow,today)} onClick={()=>command({type:waiting?'retryWorkflow':'startWorkflow',workflowId:workflow.id})}>{waiting?'Continue':'Start now'} {workflow.name}</button></li>;
    })}</ul>
  </section>;
}
