'use client';
import { ActionButton } from '@/components/ui/action-button';
import {useOnboardingCopy} from '@/lib/onboarding-copy';
import {CaseSection} from '@/components/lifecycle-v9/case-layout';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { DocumentBody } from '@/components/lifecycle-v9/document-body';
import { EmailDialog } from './email-composer';
import { readV9Workflow } from './actions';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { dateTrigger, afterTrigger, workflowMatches, workflowWhen, caseMessageSteps, stepRecipientRoles, type Case, type Config, type Role, type Workflow } from '@/lib/lifecycle-v9-model';
import { RecipientPicker } from './recipient-picker';
import type { LifecycleV9Command } from '@/packs/lifecycle/service';
export function CaseWorkflows({ c,config,busy,command,onOpenWorkflow,users=[] }: { c:Case;config:Config;busy:boolean;command:(command:LifecycleV9Command)=>Promise<{ok:boolean;error?:string}>;onOpenWorkflow?:(id:string)=>void;users?:{id:string;name:string}[] }) {
  const copy=useOnboardingCopy();
  const [selected,select]=useState<string|null>(null),[email,selectEmail]=useState<{id:string;editing:boolean}|null>(null);
  const today=todayInKualaLumpur(),workflows=config.workflows.filter(workflow=>workflow.module===c.module&&(workflow.status==='published'&&workflowMatches(c,workflow,today)||c.runs.some(run=>run.workflowId===workflow.id)));
  return <CaseSection className="v9-stack" aria-label={copy("Workflows for this person")}><h2>{copy("Workflows")}</h2>
    {!workflows.length&&<p className="v9-muted">{copy("No live workflows match this case.")}</p>}
    <ul className="v9-list">{workflows.map(workflow=>{
      const repeating=workflow.trigger.repeat&&dateTrigger(workflow.trigger.event)&&!afterTrigger(workflow.trigger.event);
      const run=c.runs.filter(run=>run.workflowId===workflow.id).at(-1),waiting=run?.status==='waiting'||run?.status==='failed',done=run?.status==='done'&&(!repeating||run.date===today),live=workflow.status==='published',finishing=workflow.status==='retired';
      return <li key={workflow.id}><div className="v9-heading"><div><strong>{workflow.name}</strong><p className="v9-muted">{workflowWhen(workflow)}</p></div><span className={'v9-badge'+(run?.hold&&run.status==='waiting'?' v9-badge-warning':'')} data-email-held={run?.hold&&run.status==='waiting'?'':undefined}>{copy(!live&&!finishing?'Paused':run?.hold&&run.status==='waiting'?'Email held':run?({running:'Running',waiting:'Waiting',done:'Done',skipped:'Skipped',failed:'Needs review'} as const)[run.status]:'Not started')}</span></div>
      {run?.hold&&run.status==='waiting'?<div role="alert" className="v9-notice v9-warning" data-held-reasons><strong>{copy('Nobody was emailed. Missing recipients:')}</strong><ul>{run.hold.missing.map(entry=><li key={entry.role}>{entry.label}: {entry.reason}</li>)}</ul><p>{copy('Fix the record or change the recipients for this case, then press Continue.')}</p></div>:run?.reason&&<p className="v9-muted">{run.reason}</p>}
      <CaseRecipients c={c} config={config} workflow={workflow} busy={busy} command={command} users={users}/>
      <div className="v9-actions">{!finishing&&workflow.steps.some(step=>['email','notify','doc'].includes(step.type))&&<button type="button" className="v9-button" onClick={()=>{const step=workflow.steps.find(step=>step.type==='email');if(step?.type==='email')selectEmail({id:step.template,editing:false});else select(workflow.id);}}>{copy(workflow.steps.some(step=>step.type==='email'||step.type==='notify')?'Preview message':'Preview document')}</button>}{workflow.steps.find(step=>step.type==='email')&&<button type="button" className="v9-button" disabled={['cleared','cancelled'].includes(c.state)} onClick={()=>{const step=workflow.steps.find(step=>step.type==='email');if(step?.type==='email')selectEmail({id:step.template,editing:true});}}>{copy("Edit for this person")}</button>}<>{onOpenWorkflow?<button type="button" className="v9-button" onClick={()=>onOpenWorkflow(workflow.id)}>{copy("Open workflow")}</button>:<Link className="v9-button" href={`/lifecycle/v9?view=workflows&workflow=${encodeURIComponent(workflow.id)}`}>{copy("Open workflow")}</Link>}</>{!finishing&&workflow.steps.some(step=>step.type==='email'||step.type==='notify')&&<ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button" disabled={busy} onClick={()=>command({type:'testWorkflow',workflowId:workflow.id})}>{copy("Send test")}</ActionButton>}
      <ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button" disabled={busy||c.state!=='submitted'||(finishing?!waiting:!live||done||!workflowMatches(c,workflow,today))} onClick={()=>command({type:waiting?'retryWorkflow':'startWorkflow',workflowId:workflow.id})}>{copy(waiting?'Continue':'Start now')} {workflow.name}</ActionButton></div></li>;
    })}</ul>{selected&&<WorkflowPreview caseId={c.id} workflowId={selected} close={()=>select(null)}/>}
    {email&&<EmailDialog key={`${c.id}:${email.id}:${email.editing}:${c.revision}`} c={c} config={config} emailId={email.id} initialEditing={email.editing} busy={busy} command={command} close={()=>selectEmail(null)}/>}
  </CaseSection>;
}

function WorkflowPreview({caseId,workflowId,close}:{caseId:string;workflowId:string;close:()=>void}) {
 const dialog=useRef<HTMLDialogElement>(null),[result,setResult]=useState<Awaited<ReturnType<typeof readV9Workflow>>|null>(null);
 useEffect(()=>{let active=true;dialog.current?.showModal();void readV9Workflow(caseId,workflowId).then(result=>{if(active)setResult(result);}).catch(()=>{if(active)setResult({ok:false,error:'The workflow preview could not be loaded. Try again.'});});return()=>{active=false;};},[caseId,workflowId]);
 return <dialog ref={dialog} className="v9-dialog" aria-label="Workflow output preview" onCancel={close}><header><h2>{result?.ok?result.preview.workflow.name:'Workflow output preview'}</h2><button type="button" className="v9-button" onClick={close}>Close preview</button></header>{!result?<p role="status">Loading preview…</p>:!result.ok?<p role="alert">{result.error}</p>:<div className="v9-stack">{result.preview.messages.map(message=><section key={message.id}><p><strong>To:</strong> {message.to}</p><p><strong>CC:</strong> {message.cc||'No one'}</p><h3>{message.subject}</h3><p className="v9-prewrap">{message.body}</p></section>)}{!result.preview.messages.length&&result.preview.documents.map(document=><DocumentBody key={document.id} document={document}/>)}</div>}</dialog>;
}

/** Board 4a60b3ec: To and CC for this person and step only, before the step runs or while it is held. */
function CaseRecipients({ c, config, workflow, busy, command, users }: { c: Case; config: Config; workflow: Workflow; busy: boolean; command: (command: LifecycleV9Command) => Promise<{ ok: boolean; error?: string }>; users: { id: string; name: string }[] }) {
  const copy = useOnboardingCopy();
  const [editing, setEditing] = useState<string | null>(null), [draft, setDraft] = useState<{ to: Role[]; cc: Role[] }>({ to: [], cc: [] }), [error, setError] = useState('');
  const steps = caseMessageSteps(c, config, workflow.id), open = ['pending', 'submitted'].includes(c.state);
  if (!steps.length) return null;
  return <div className="v9-stack" data-case-recipients={workflow.id}>{steps.map(step => {
    const email = step.type === 'email' ? config.emails.find(candidate => candidate.id === step.template) : null, roles = stepRecipientRoles(c, workflow.id, step, email);
    const name = step.type === 'email' ? email?.name ?? copy('Email') : step.subject || copy('Notification');
    return <div key={step.id} className="v9-stack">
      <div className="v9-actions"><span>{name}</span>{roles.overridden && <span className="v9-badge" data-recipients-changed>{copy('Recipients changed for this case')}</span>}
        {open && editing !== step.id && <button type="button" className="v9-button" disabled={busy} onClick={() => { setDraft({ to: roles.to, cc: roles.cc }); setError(''); setEditing(step.id); }}>{copy('Edit recipients for this case')}</button>}</div>
      {editing === step.id && <div className="v9-panel v9-stack" aria-label={copy('Recipients for this case')}>
        <RecipientPicker module={c.module} groups={config.groups} users={users} label={`To · ${name}`} value={draft.to} disabled={busy} change={to => setDraft(value => ({ ...value, to }))}/>
        <RecipientPicker module={c.module} groups={config.groups} users={users} label={`CC · ${name}`} value={draft.cc} disabled={busy} change={cc => setDraft(value => ({ ...value, cc }))}/>
        {error && <p role="alert" className="v9-notice v9-error">{error}</p>}
        <div className="v9-actions">
          <ActionButton type="button" className="v9-button v9-button-primary" aria-busy={busy} disabled={busy || !draft.to.length} onClick={async () => { const result = await command({ type: 'recipientsOverride', workflowId: workflow.id, stepId: step.id, to: draft.to, cc: draft.cc }); if (result.ok) setEditing(null); else setError(result.error ?? copy('The recipients could not be saved.')); }}>{copy('Save recipients for this case')}</ActionButton>
          {roles.overridden && <ActionButton type="button" className="v9-button" aria-busy={busy} disabled={busy} onClick={async () => { const result = await command({ type: 'recipientsOverride', workflowId: workflow.id, stepId: step.id, clear: true }); if (result.ok) setEditing(null); else setError(result.error ?? copy('The recipients could not be saved.')); }}>{copy('Use the workflow recipients')}</ActionButton>}
          <button type="button" className="v9-button" onClick={() => setEditing(null)}>{copy('Cancel')}</button>
        </div>
      </div>}
    </div>;
  })}</div>;
}
