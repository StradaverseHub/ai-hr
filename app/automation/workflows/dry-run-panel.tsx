'use client';
import {useState,useTransition} from 'react';
import {useTranslations} from 'next-intl';
import {conditionFieldsForTrigger,type AutomationModuleCatalogue} from '@/lib/automation/catalogue';
import {describeAutomationCondition} from '@/lib/automation/conditions';
import type {AutomationDryRun,AutomationWorkflow} from '@/lib/automation/workflow';
import {dryRunWorkflowAction,searchProbationCasesAction,searchOffboardingCasesAction,dryRunOffboardingWorkflowAction} from '../actions';
import type {DryRunEventFacts} from '../types';

type CaseChoice = { id: string; name: string; detail: string };
const OUTCOMES = ['Confirm', 'Extend', 'Non-confirmation', 'Other'];

/**
 * Dry run (handoff A1): what would happen for one real Probation case the viewer may open. The event itself (which part,
 * which outcome, who is pending) is chosen here, as in the prototype; on a real case the system reads it when the
 * trigger fires. Nothing is sent and nothing is saved.
 */
export function DryRunPanel({workflow,catalogue}:{workflow:AutomationWorkflow;catalogue:AutomationModuleCatalogue}){
 const t=useTranslations('automation'),[busy,start]=useTransition(),[query,setQuery]=useState(''),[cases,setCases]=useState<CaseChoice[]|null>(null),[caseId,setCaseId]=useState('');
 const field=(id:string)=>catalogue.conditionFields.find(f=>f.id===id),choices=(id:string)=>[...(field(id)?.values??[])];
 const partCondition=workflow.conditions.find(c=>c.field==='part'&&c.op==='is');
 const [event,setEvent]=useState<DryRunEventFacts>({part:partCondition?.values[0]??choices('part')[0]??'',outcome:'Confirm',resultBand:'2',suggestionOverridden:'No',pendingStep:'Line Manager'});
 const [result,setResult]=useState<{employeeName:string;run:AutomationDryRun}|null>(null),[error,setError]=useState('');
 const available=new Set(conditionFieldsForTrigger(catalogue,workflow.trigger.event).map(f=>f.id));
 const label=(id:string)=>field(id)?.label??id,stepLabel=(type:string)=>catalogue.stepTypes.find(s=>s.id===type)?.label??type;
 const find=()=>{setError('');start(async()=>{const found=await (workflow.module==='off'?searchOffboardingCasesAction(query):searchProbationCasesAction(query));if(!found.ok){setError(found.detail??t('errors.unavailable'));return;}setCases(found.result);setCaseId(found.result[0]?.id??'');});};
 const run=()=>{if(!caseId)return;setError('');start(async()=>{const outcome=await (workflow.module==='off'?dryRunOffboardingWorkflowAction({workflow,caseId}):dryRunWorkflowAction({workflow,caseId,event}));if(!outcome.ok){setError(outcome.detail??t('errors.unavailable'));setResult(null);return;}setResult(outcome.result);});};
 const select=(key:keyof DryRunEventFacts,id:string,values:string[])=>available.has(id)&&<label className="v9-field" key={key}><span>{label(id)}</span><select value={event[key]} onChange={e=>{setEvent({...event,[key]:e.target.value});setResult(null);}}>{values.map(v=><option key={v} value={v}>{v}</option>)}</select></label>;
 return <section className="automation-dry v9-stack" aria-label={t('dry.title')}>
  <div><h3>{t('dry.title')}</h3><p className="v9-muted">{t('dry.intro')}</p></div>
  <div className="automation-row">
   <input aria-label={t('dry.searchCase')} placeholder={t('dry.searchPlaceholder')} value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();find();}}}/>
   <button type="button" className="v9-button" disabled={busy} onClick={find}>{t('dry.findCases')}</button>
  </div>
  {cases&&(cases.length?<label className="v9-field"><span>{t('dry.testCase')}</span><select value={caseId} onChange={e=>{setCaseId(e.target.value);setResult(null);}}>{cases.map(c=><option key={c.id} value={c.id}>{c.name}{c.detail?' · '+c.detail:''}</option>)}</select></label>:<p className="v9-muted">{t('dry.noCases')}</p>)}
  <div className="v9-fields">
   {select('part','part',choices('part'))}
   {select('outcome','outcome',OUTCOMES)}
   {select('resultBand','resultBand',choices('resultBand'))}
   {select('suggestionOverridden','suggestionOverridden',choices('suggestionOverridden'))}
   {select('pendingStep','pendingStep',choices('pendingStep'))}
  </div>
  {available.has('pendingStep')&&<p className="v9-muted">{t('dry.pendingNote')}</p>}
  <div><button type="button" className="v9-button" disabled={busy||!caseId} onClick={run}>{t('dry.run')}</button></div>
  {error&&<p className="v9-notice v9-error" role="alert">{error}</p>}
  {result&&<div className="v9-stack" role="status" aria-label={t('dry.result')}>
   {result.run.runDate&&<p>{t('dry.runDate',{date:result.run.runDate})}{result.run.repeats?' '+t('dry.repeats'):''}</p>}
   <p><span className={'automation-pill '+(result.run.wouldRun?'automation-pill-ok':'automation-pill-warn')}>{result.run.wouldRun?t('dry.wouldRun',{name:result.employeeName}):t('dry.wouldNotRun',{name:result.employeeName})}</span></p>
   <p>{result.run.reason}</p>
   {result.run.conditions.length>0&&<ul className="automation-plain-list">{result.run.conditions.map((c,i)=><li key={i}>{describeAutomationCondition(c.condition,label)} · {c.unavailable?t('dry.unavailable'):c.ok?'✓':t('dry.thisCase',{value:c.actual??t('dry.empty')})}</li>)}</ul>}
   <ol className="automation-plain-list">{result.run.steps.map(step=><li key={step.id}>
    {step.index}. {stepLabel(step.type)}{step.runs?(step.to.length||step.cc.length?' · '+t('dry.to',{names:step.to.join(', ')||t('dry.nobody')})+(step.cc.length?' · '+t('dry.cc',{names:step.cc.join(', ')}):''):''):' · '+t('dry.skipped',{why:step.conditions.filter(c=>!c.ok).map(c=>describeAutomationCondition(c.condition,label)).join('; ')})}
    {step.missing.length>0&&<span className="automation-warning"> · {step.missing.join('; ')}</span>}
   </li>)}</ol>
   <p className="v9-muted">{t('dry.nothingSent')}</p>
  </div>}
 </section>;
}
