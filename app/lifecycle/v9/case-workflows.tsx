'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { DocumentBody } from '@/components/lifecycle-v9/document-body';
import { EmailDialog } from './email-composer';
import { readV9Workflow } from './actions';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { dateTrigger, afterTrigger, workflowMatches, workflowWhen, type Case, type Config } from '@/lib/lifecycle-v9-model';
import type { LifecycleV9Command } from '@/packs/lifecycle/service';
export function CaseWorkflows({ c,config,busy,command }: { c:Case;config:Config;busy:boolean;command:(command:LifecycleV9Command)=>Promise<{ok:boolean;error?:string}> }) {
  const [selected,select]=useState<string|null>(null),[email,selectEmail]=useState<string|null>(null);
  const today=todayInKualaLumpur(),workflows=config.workflows.filter(workflow=>workflow.module===c.module&&(workflow.status==='published'&&workflowMatches(c,workflow,today)||c.runs.some(run=>run.workflowId===workflow.id)));
  return <section className="v9-panel v9-stack" aria-label="Workflows for this person"><h2>Workflows</h2>
    {!workflows.length&&<p className="v9-muted">No live workflows match this case.</p>}
    <ul className="v9-list">{workflows.map(workflow=>{
      const repeating=workflow.trigger.repeat&&dateTrigger(workflow.trigger.event)&&!afterTrigger(workflow.trigger.event);
      const run=c.runs.filter(run=>run.workflowId===workflow.id).at(-1),waiting=run?.status==='waiting'||run?.status==='failed',done=run?.status==='done'&&(!repeating||run.date===today),live=workflow.status==='published';
      return <li key={workflow.id}><div className="v9-heading"><div><strong>{workflow.name}</strong><p className="v9-muted">{workflowWhen(workflow)}</p></div><span className="v9-badge">{!live?'Paused':run?({running:'Running',waiting:'Waiting',done:'Done',skipped:'Skipped',failed:'Needs review'} as const)[run.status]:'Not started'}</span></div>
      {run?.reason&&<p className="v9-muted">{run.reason}</p>}
      <div className="v9-actions">{workflow.steps.some(step=>['email','notify','doc'].includes(step.type))&&<button type="button" className="v9-button" onClick={()=>select(workflow.id)}>Preview {workflow.steps.some(step=>step.type==='email'||step.type==='notify')?'message':'document'}</button>}{workflow.steps.find(step=>step.type==='email')&&<button type="button" className="v9-button" disabled={c.state!=='submitted'} onClick={()=>{const step=workflow.steps.find(step=>step.type==='email');if(step?.type==='email')selectEmail(step.template);}}>Edit for this person</button>}<Link className="v9-button" href={`/lifecycle/v9?view=workflows&workflow=${encodeURIComponent(workflow.id)}`}>Open workflow</Link>{workflow.steps.some(step=>step.type==='email'||step.type==='notify')&&<button type="button" className="v9-button" disabled={busy||c.state!=='submitted'} onClick={()=>void command({type:'testWorkflow',workflowId:workflow.id})}>Send test</button>}
      <button type="button" className="v9-button" disabled={busy||c.state!=='submitted'||!live||done||!workflowMatches(c,workflow,today)} onClick={()=>command({type:waiting?'retryWorkflow':'startWorkflow',workflowId:workflow.id})}>{waiting?'Continue':'Start now'} {workflow.name}</button></div></li>;
    })}</ul>{selected&&<WorkflowPreview caseId={c.id} workflowId={selected} close={()=>select(null)}/>}
    {email&&<EmailDialog key={`${c.id}:${email}:${c.revision}`} c={c} config={config} emailId={email} busy={busy} command={command} close={()=>selectEmail(null)}/>}
  </section>;
}

function WorkflowPreview({caseId,workflowId,close}:{caseId:string;workflowId:string;close:()=>void}) {
 const dialog=useRef<HTMLDialogElement>(null),[result,setResult]=useState<Awaited<ReturnType<typeof readV9Workflow>>|null>(null);
 useEffect(()=>{let active=true;dialog.current?.showModal();void readV9Workflow(caseId,workflowId).then(result=>{if(active)setResult(result);}).catch(()=>{if(active)setResult({ok:false,error:'The workflow preview could not be loaded. Try again.'});});return()=>{active=false;};},[caseId,workflowId]);
 return <dialog ref={dialog} className="v9-dialog" aria-label="Workflow output preview" onCancel={close}><header><h2>{result?.ok?result.preview.workflow.name:'Workflow output preview'}</h2><button type="button" className="v9-button" onClick={close}>Close preview</button></header>{!result?<p role="status">Loading preview…</p>:!result.ok?<p role="alert">{result.error}</p>:<div className="v9-stack">{result.preview.messages.map(message=><section key={message.id}><h3>{message.subject}</h3><p className="v9-prewrap">{message.body}</p></section>)}{!result.preview.messages.length&&result.preview.documents.map(document=><DocumentBody key={document.id} document={document}/>)}</div>}</dialog>;
}
