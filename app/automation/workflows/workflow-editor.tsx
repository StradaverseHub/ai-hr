'use client';
import {useRef,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {mergeFieldsForTrigger,type AutomationModuleCatalogue} from '@/lib/automation/catalogue';
import {automationMergeWarnings,automationWorkflowProblems,setAutomationWorkflowStatus,type AutomationReferences,type AutomationStep,type AutomationWorkflow} from '@/lib/automation/workflow';
import {PROBATION_POSTING_EVENTS,probationStepParamProblems,probationStepParamWarnings} from '@/lib/automation/email';
import {WorkflowEditorShell,WorkflowField} from '../../lifecycle/workflow-editor-shell';
import {MultiSelect} from '../multi-select';
import {PeopleSearch} from '../people-search';
import {recipientKey,recipientOptions,recipientsFromKeys,type NamedOption} from '../recipients';
import {saveWorkflowAction} from '../actions';
import {ConditionRows} from './condition-rows';
import {DryRunPanel} from './dry-run-panel';
import {CONTRACT_POSTING_KINDS,contractStepParamProblems,contractWorkflowWarnings,type ContractApprovalLayer} from '@/lib/contract-automation';
import {ContractApprovalLayers} from './contract-approval-layers';

export type WorkflowEditorReferences = {
  routings: (NamedOption & { retired?: boolean })[];
  groups: NamedOption[];
  people: NamedOption[];
  emailTemplates: { id: string; name: string; active: boolean; retired: boolean; subject: string }[];
  /** Letter templates of one company the viewer configures; null when none could be read. */
  letterTemplates: NamedOption[] | null;
  /** Choices for condition fields whose values the module lists at run time. Organisation fields (business group, company,
   * department) store ids and show names; the runner still reads values saved earlier as names (aliases). */
  conditionValues: Record<string, ConditionChoice[]>;
};
export type ConditionChoice = { value: string; label: string };
type Message = { kind: 'error' | 'status'; text: string; problems?: string[] };
/** Organisation condition fields whose stored values are ids (F5). */
const ID_FIELDS = new Set(['businessGroup', 'company', 'department']);
/**
 * A condition saved before ids (a business group, company or department name) is shown and saved again as the id of the
 * one choice carrying that name. A name that matches no choice, or several, stays as it is (shown as not available).
 */
export function conditionsWithIds(workflow: AutomationWorkflow, choices: Readonly<Record<string, readonly ConditionChoice[]>>): AutomationWorkflow {
  const convert = (conditions: AutomationWorkflow['conditions']) => conditions.map(condition => {
    if (!ID_FIELDS.has(condition.field)) return condition;
    const options = choices[condition.field] ?? [];
    const values = condition.values.map(value => {
      if (options.some(option => option.value === value)) return value;
      const named = options.filter(option => option.label === value);
      return named.length === 1 ? named[0].value : value;
    });
    return values.every((value, i) => value === condition.values[i]) ? condition : {...condition, values: [...new Set(values)]};
  });
  const conditions = convert(workflow.conditions), steps = workflow.steps.map(step => { const own = convert(step.conditions); return own.every((c, i) => c === step.conditions[i]) ? step : {...step, conditions: own}; });
  return conditions.every((c, i) => c === workflow.conditions[i]) && steps.every((s, i) => s === workflow.steps[i]) ? workflow : {...workflow, conditions, steps};
}
const text = (value: unknown) => typeof value === 'string' ? value : '';

/** The shared workflow editor for a module on the shared engine (Probation first). Saves through the shared store. */
export function WorkflowEditor({catalogue,initial,revision:savedRevision,refs,onClose}:{catalogue:AutomationModuleCatalogue;initial:AutomationWorkflow;revision:number;refs:WorkflowEditorReferences;onClose:()=>void}){
 const t=useTranslations('automation'),router=useRouter(),[busy,start]=useTransition();
 const [converted]=useState(()=>conditionsWithIds(initial,refs.conditionValues));
 const [draft,setDraft]=useState(converted),[revision,setRevision]=useState(savedRevision),[dirty,setDirty]=useState(savedRevision===0||converted!==initial),[note,setNote]=useState(''),[message,setMessage]=useState<Message|null>(null),[people,setPeople]=useState(refs.people);
 const fields=useRef<Record<string,HTMLInputElement|HTMLTextAreaElement|null>>({});
 const readOnly=initial.status==='retired'||busy;
 const change=(edit:(workflow:AutomationWorkflow)=>void)=>{setDraft(current=>{const next=structuredClone(current);edit(next);return next;});setDirty(true);setMessage(null);};
 const setStep=(index:number,edit:(step:AutomationStep)=>void)=>change(w=>edit(w.steps[index]));
 const references:AutomationReferences={routingExists:id=>refs.routings.some(r=>r.id===id&&!r.retired),groupExists:id=>refs.groups.some(g=>g.id===id),personExists:id=>people.some(p=>p.id===id)};
 const stepReferences={emailTemplates:refs.emailTemplates,letterTemplateIds:refs.letterTemplates?.map(l=>l.id)??null};
 const problems=draft.status==='retired'?[]:[...automationWorkflowProblems(draft,catalogue,references),...probationStepParamProblems(draft,stepReferences),...contractStepParamProblems(draft,stepReferences,references)];
 const warnings=[...automationMergeWarnings(draft,catalogue),...probationStepParamWarnings(draft,stepReferences),...contractWorkflowWarnings(draft)];
 const trigger=catalogue.triggers.find(x=>x.id===draft.trigger.event);
 const recipients=recipientOptions(catalogue,{routings:refs.routings,groups:refs.groups,people},{routing:name=>t('recipients.routing',{name}),group:name=>t('recipients.group',{name})});
 const merge=mergeFieldsForTrigger(catalogue,draft.trigger.event),mergeGroups=[...new Set(merge.map(m=>m.group))];
 const valuesFor=(field:string)=>refs.conditionValues[field]??[];

 const save=(status:AutomationWorkflow['status'],reason:string)=>{
  if(status==='live'){const gate=setAutomationWorkflowStatus(draft,'live',problems);if(!gate.ok){setMessage({kind:'error',text:gate.reason,problems});return;}}
  const next={...draft,status};
  start(async()=>{
   const result=await saveWorkflowAction({workflow:next,expectedRevision:revision,reason:note.trim()||reason});
   if(!result.ok){setMessage({kind:'error',text:result.detail??t('errors.unavailable'),problems:result.problems});return;}
   setRevision(result.result.revision);setDraft(next);setDirty(false);setNote('');
   setMessage({kind:'status',text:status==='live'?t('editor.isLive',{name:next.name}):status==='retired'?t('editor.retired',{name:next.name}):draft.status==='live'&&status==='paused'?t('editor.paused',{name:next.name}):t('editor.saved')});
   router.refresh();if(status==='retired')onClose();
  });
 };
 const insertMerge=(index:number,param:'subject'|'body',key:string)=>{
  const element=fields.current[`${index}:${param}`],current=text(draft.steps[index].params[param]),token=`{{${key}}}`;
  const from=element?.selectionStart??current.length,to=element?.selectionEnd??current.length;
  setStep(index,step=>{step.params[param]=current.slice(0,from)+token+current.slice(to);});
  requestAnimationFrame(()=>{const target=fields.current[`${index}:${param}`];if(target){target.focus();target.setSelectionRange(from+token.length,from+token.length);}});
 };
 const picker=(index:number,param:'subject'|'body')=><select className="automation-merge-picker" aria-label={t('editor.insertMerge',{where:t(param==='subject'?'editor.subject':'editor.message'),step:index+1})} value="" disabled={readOnly} onChange={e=>e.target.value&&insertMerge(index,param,e.target.value)}>
  <option value="">{t('editor.insertMergeField')}</option>
  {mergeGroups.map(group=><optgroup key={group} label={group}>{merge.filter(m=>m.group===group).map(m=><option key={m.key} value={m.key}>{m.label}</option>)}</optgroup>)}
 </select>;
 const toCc=(index:number,step:AutomationStep)=><div className="v9-fields">
  <div className="v9-field"><span>{t('editor.to')}</span><MultiSelect label={t('editor.stepTo',{step:index+1})} value={step.to.map(recipientKey)} options={recipients} disabled={readOnly} onChange={keys=>setStep(index,s=>{s.to=recipientsFromKeys(keys);})}/></div>
  <div className="v9-field"><span>{t('editor.cc')}</span><MultiSelect label={t('editor.stepCc',{step:index+1})} value={step.cc.map(recipientKey)} options={recipients} disabled={readOnly} onChange={keys=>setStep(index,s=>{s.cc=recipientsFromKeys(keys);})}/></div>
 </div>;
 const newStep=(type:string):AutomationStep=>({id:crypto.randomUUID(),type,conditions:[],to:type==='sendEmail'||type==='notify'?[{kind:'role',role:'employee'}]:[],cc:[],
  params:type==='notify'?{subject:'',body:''}:type==='sendEmail'?{emailTemplateId:''}:type==='generateDocument'?{letterTemplateId:''}:type==='createPosting'?{eventType:''}:type==='startOffboarding'?{exitReason:'Non-confirmation'}:{}});
 const stepBody=(step:AutomationStep,index:number)=>{
  if(step.type==='requestApproval'&&draft.module==='contract_staff')return <ContractApprovalLayers disabled={readOnly}
   layers={Array.isArray(step.params.layers)?step.params.layers as ContractApprovalLayer[]:[]}
   options={recipients.filter(option=>option.value!=='pending')}
   onChange={layers=>setStep(index,s=>{s.params.layers=layers;})}/>;
  if(step.type==='notify')return <div className="v9-stack">{toCc(index,step)}
   <div className="v9-field"><div className="automation-row automation-between"><label htmlFor={`automation-subject-${index}`}>{t('editor.subject')}</label>{picker(index,'subject')}</div>
    <input id={`automation-subject-${index}`} ref={element=>{fields.current[`${index}:subject`]=element;}} value={text(step.params.subject)} maxLength={500} disabled={readOnly} aria-invalid={!text(step.params.subject).trim()} onChange={e=>setStep(index,s=>{s.params.subject=e.target.value;})}/></div>
   <div className="v9-field"><div className="automation-row automation-between"><label htmlFor={`automation-message-${index}`}>{t('editor.message')}</label>{picker(index,'body')}</div>
    <textarea id={`automation-message-${index}`} ref={element=>{fields.current[`${index}:body`]=element;}} value={text(step.params.body)} maxLength={5000} rows={4} disabled={readOnly} onChange={e=>setStep(index,s=>{s.params.body=e.target.value;})}/></div>
   <p className="v9-muted">{t('editor.mergeHelp',{example:'{{employee.name}}'})}</p>
  </div>;
  if(step.type==='sendEmail'){const chosen=refs.emailTemplates.find(e=>e.id===text(step.params.emailTemplateId));return <div className="v9-stack">{toCc(index,step)}
   <WorkflowField label={t('editor.emailTemplate')}><select value={text(step.params.emailTemplateId)} disabled={readOnly} onChange={e=>setStep(index,s=>{s.params.emailTemplateId=e.target.value;})}><option value="">{t('editor.choose')}</option>{refs.emailTemplates.filter(e=>!e.retired||e.id===chosen?.id).map(e=><option key={e.id} value={e.id}>{e.name}{e.active?'':' · '+t('templates.turnedOff')}</option>)}</select></WorkflowField>
   <p className="v9-muted">{chosen?t('editor.emailSubject',{subject:chosen.subject}):t('editor.emailFromTemplate')}</p>
  </div>;}
  if(step.type==='generateDocument')return <div className="v9-stack">{refs.letterTemplates
   ?<WorkflowField label={t('editor.letterTemplate')}><select value={text(step.params.letterTemplateId)} disabled={readOnly} onChange={e=>setStep(index,s=>{s.params.letterTemplateId=e.target.value;})}><option value="">{t('editor.choose')}</option>{[...refs.letterTemplates,...(text(step.params.letterTemplateId)&&!refs.letterTemplates.some(l=>l.id===step.params.letterTemplateId)?[{id:text(step.params.letterTemplateId),name:t('notAvailable',{value:text(step.params.letterTemplateId)})}]:[])].map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></WorkflowField>
   :<WorkflowField label={t('editor.letterTemplateId')}><input value={text(step.params.letterTemplateId)} disabled={readOnly} onChange={e=>setStep(index,s=>{s.params.letterTemplateId=e.target.value.trim();})}/></WorkflowField>}
   <p className="v9-muted">{t('editor.letterNote')}</p></div>;
  if(step.type==='createPosting')return <div className="v9-stack"><WorkflowField label={t('editor.postingEvent')}><select value={text(step.params.eventType)} disabled={readOnly} onChange={e=>setStep(index,s=>{s.params.eventType=e.target.value;})}><option value="">{t('editor.choose')}</option>{(draft.module==='contract_staff'?CONTRACT_POSTING_KINDS:PROBATION_POSTING_EVENTS).map(event=><option key={event} value={event}>{event}</option>)}</select></WorkflowField><p className="v9-muted">{t(draft.module==='contract_staff'?'contract.postingHelp':'editor.postingNote')}</p></div>;
  if(step.type==='startOffboarding'&&draft.module==='contract_staff')return <p className="v9-muted">{t('contract.offboardingHelp')}</p>;
  if(step.type==='startOffboarding')return <div className="v9-stack"><WorkflowField label={t('editor.exitReason')}><input value={text(step.params.exitReason)} maxLength={200} disabled={readOnly} onChange={e=>setStep(index,s=>{s.params.exitReason=e.target.value;})}/></WorkflowField><p className="v9-muted">{t('editor.offboardingNote')}</p></div>;
  return null;
 };

 return <div className="v9-stack">
  <WorkflowEditorShell title={draft.name||t('editor.untitled')} moduleLabel={catalogue.label} stateLabel={t('status.'+draft.status)} required={draft.required}
   description={<div className="v9-fields">
    <WorkflowField label={t('editor.name')}><input value={draft.name} maxLength={200} disabled={readOnly} aria-invalid={!draft.name.trim()} onChange={e=>change(w=>{w.name=e.target.value;})}/></WorkflowField>
    <label className="automation-check"><input type="checkbox" checked={draft.required} disabled={readOnly} onChange={e=>change(w=>{w.required=e.target.checked;})}/><span>{t('editor.required')}</span></label>
   </div>}
   when={<div className="v9-stack">
    <WorkflowField label={t('editor.whatStarts')}><select value={draft.trigger.event} disabled={readOnly} onChange={e=>{const next=catalogue.triggers.find(x=>x.id===e.target.value);change(w=>{w.trigger=next?.dated?{event:e.target.value,days:w.trigger.days||1,workdays:w.trigger.workdays,repeat:w.trigger.repeat}:{event:e.target.value,days:0,workdays:false,repeat:false};});}}>
     {!trigger&&<option value={draft.trigger.event}>{t('editor.chooseTrigger')}</option>}
     {catalogue.triggers.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}
    </select></WorkflowField>
    {trigger?.dated&&<div className="automation-row">
     <WorkflowField label={trigger.label}><input type="number" min={0} max={3660} step={1} value={draft.trigger.days} disabled={readOnly} onChange={e=>change(w=>{w.trigger.days=Math.max(0,Math.floor(Number(e.target.value)||0));})}/></WorkflowField>
     <label className="automation-check"><input type="checkbox" checked={draft.trigger.workdays} disabled={readOnly} onChange={e=>change(w=>{w.trigger.workdays=e.target.checked;})}/><span>{t('editor.workdays')}</span></label>
     <label className="automation-check"><input type="checkbox" checked={draft.trigger.repeat} disabled={readOnly} onChange={e=>change(w=>{w.trigger.repeat=e.target.checked;})}/><span>{t('editor.repeat')}</span></label>
    </div>}
    <WorkflowField label={t('editor.skipWhen')}><select value={draft.skipWhen} disabled={readOnly} onChange={e=>change(w=>{w.skipWhen=e.target.value;})}>{catalogue.skipWhen.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></WorkflowField>
   </div>}
   onlyIf={<div className="v9-stack"><p className="v9-muted">{t('editor.onlyIfHelp')}</p>
    <ConditionRows catalogue={catalogue} trigger={draft.trigger.event} conditions={draft.conditions} valuesFor={valuesFor} disabled={readOnly} label={t('editor.onlyIf')} addLabel={t('editor.addCondition')} hint={t('editor.multiHint')} onChange={next=>change(w=>{w.conditions=next;})}/></div>}
   then={<div className="v9-stack"><p className="v9-muted">{t('editor.thenHelp')}</p>
    <details className="automation-details"><summary>{t('people.title')}</summary><PeopleSearch known={people} disabled={readOnly} onAdd={person=>setPeople(list=>list.some(p=>p.id===person.id)?list:[...list,person])}/></details>
    <ol className="automation-steps">{draft.steps.map((step,index)=><li key={step.id} className="automation-step">
     <div className="automation-row automation-between"><b>{index+1}. {catalogue.stepTypes.find(s=>s.id===step.type)?.label??step.type}</b>
      <span className="automation-row">
       <button type="button" className="v9-button" aria-label={t('editor.moveUp',{step:index+1})} disabled={readOnly||index===0} onClick={()=>change(w=>{[w.steps[index-1],w.steps[index]]=[w.steps[index],w.steps[index-1]];})}>▲</button>
       <button type="button" className="v9-button" aria-label={t('editor.moveDown',{step:index+1})} disabled={readOnly||index===draft.steps.length-1} onClick={()=>change(w=>{[w.steps[index+1],w.steps[index]]=[w.steps[index],w.steps[index+1]];})}>▼</button>
       <button type="button" className="v9-button" aria-label={t('editor.removeStep',{step:index+1})} disabled={readOnly} onClick={()=>change(w=>{w.steps.splice(index,1);})}>{t('editor.remove')}</button>
      </span></div>
     {stepBody(step,index)}
     <div className="automation-step-conditions"><b>{t('editor.stepOnlyIf')}</b>
      <ConditionRows catalogue={catalogue} trigger={draft.trigger.event} conditions={step.conditions} valuesFor={valuesFor} disabled={readOnly} label={t('editor.stepConditions',{step:index+1})} addLabel={t('editor.addStepCondition')} hint={t('editor.stepConditionHint')} onChange={next=>setStep(index,s=>{s.conditions=next;})}/></div>
    </li>)}</ol>
    <WorkflowField label={t('editor.addStep')}><select value="" disabled={readOnly} onChange={e=>{const type=e.target.value;if(type)change(w=>{w.steps.push(newStep(type));});}}><option value="">{t('editor.chooseStep')}</option>{catalogue.stepTypes.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></WorkflowField>
   </div>}
   dryRun={<div className="v9-stack">
    {problems.length>0&&<section className="automation-issues" aria-label={t('editor.problems')}><b>{t('editor.problems')}</b><ul>{problems.map((p,i)=><li key={i}>{p}</li>)}</ul></section>}
    {warnings.length>0&&<section className="automation-notes" aria-label={t('editor.warnings')}><b>{t('editor.warnings')}</b><ul>{warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></section>}
    {draft.module==='probation'&&<DryRunPanel workflow={draft} catalogue={catalogue}/>}
   </div>}
   actions={<>
    {message&&<div className={message.kind==='error'?'v9-notice v9-error':'v9-notice'} role={message.kind==='error'?'alert':'status'}>{message.text}{message.problems?.length?<ul>{message.problems.map((p,i)=><li key={i}>{p}</li>)}</ul>:null}</div>}
    {initial.status!=='retired'&&<>
     <WorkflowField label={t('editor.note')}><input value={note} maxLength={500} disabled={readOnly} placeholder={t('editor.notePlaceholder')} onChange={e=>setNote(e.target.value)}/></WorkflowField>
     <div className="automation-row">
      {draft.status==='live'
       ?<button type="button" className="v9-button v9-button-primary" disabled={busy} onClick={()=>save('paused',t('editor.reasonPause'))}>{t('editor.pause')}</button>
       :<button type="button" className="v9-button v9-button-primary" disabled={busy||problems.length>0} title={problems.length?t('editor.fixFirst'):undefined} onClick={()=>save('live',t('editor.reasonLive'))}>{t('editor.makeLive')}</button>}
      <button type="button" className="v9-button" disabled={busy||!dirty||(draft.status==='live'&&problems.length>0)} onClick={()=>save(draft.status,t('editor.reasonSave'))}>{t('editor.save')}</button>
      {revision>0&&<button type="button" className="v9-button" disabled={busy} onClick={()=>{if(window.confirm(t('editor.retireConfirm')))save('retired',t('editor.reasonRetire'));}}>{t('editor.retire')}</button>}
      <button type="button" className="v9-button" disabled={busy} onClick={()=>{if(!dirty||window.confirm(t('editor.leaveUnsaved')))onClose();}}>{t('editor.back')}</button>
     </div>
     <p className="v9-muted">{t('editor.runsKeep')}</p>
    </>}
    {initial.status==='retired'&&<div className="automation-row"><p className="v9-muted">{t('editor.retiredReadOnly')}</p><button type="button" className="v9-button" onClick={onClose}>{t('editor.back')}</button></div>}
   </>}
  />
 </div>;
}
