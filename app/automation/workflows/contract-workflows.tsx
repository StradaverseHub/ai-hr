'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {CONTRACT_AUTOMATION_CATALOGUE} from '@/lib/automation/catalogues/contracts';
import {automationWorkflowProblems,type AutomationWorkflow} from '@/lib/automation/workflow';
import {contractStepParamProblems} from '@/lib/contract-automation';
import {workflowListLines} from '../recipients';
import {WorkflowEditor,type WorkflowEditorReferences} from './workflow-editor';
import type {ListedWorkflow} from './workflows-workspace';

/** Contract's definitions in the same builder; legacy in-flight runs keep their previous engine/version. */
export function ContractWorkflows({workflows,refs}:{workflows:ListedWorkflow[];refs:WorkflowEditorReferences}){
 const t=useTranslations('automation'),[editing,setEditing]=useState<ListedWorkflow|null>(null);
 const catalogue=CONTRACT_AUTOMATION_CATALOGUE;
 const references={routingExists:(id:string)=>refs.routings.some(r=>r.id===id&&!r.retired),groupExists:(id:string)=>refs.groups.some(g=>g.id===id),personExists:(id:string)=>refs.people.some(p=>p.id===id)};
 if(editing)return <WorkflowEditor key={editing.workflow.id} catalogue={catalogue} initial={editing.workflow} revision={editing.revision} refs={refs} onClose={()=>setEditing(null)}/>;
 const create=()=>setEditing({revision:0,workflow:{id:crypto.randomUUID(),module:'contract_staff',name:t('workflows.newName'),description:'',status:'paused',required:false,trigger:{event:'decisionSubmitted',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[]}});
 return <section className="pcg-card pcg-card-flush" aria-label={t('modules.contract_staff')}>
  <div className="pcg-wi"><div><h2>{t('modules.contract_staff')}</h2><p className="pcg-hint">{t('contract.listHelp')}</p></div><button type="button" className="v9-button v9-button-primary" onClick={create}>{t('workflows.new')}</button></div>
  {!workflows.length&&<p className="pcg-card-extra v9-muted">{t('workflows.empty')}</p>}
  <ul className="pcg-wl">{workflows.filter(item=>item.workflow.status!=='retired').map(item=>{
   const w=item.workflow,lines=workflowListLines(w,catalogue);
   const problems=w.status==='retired'?[]:[...automationWorkflowProblems(w,catalogue,references),...contractStepParamProblems(w,{emailTemplates:refs.emailTemplates,letterTemplateIds:refs.letterTemplates?.map(l=>l.id)??null},references)];
   return <li className="pcg-wi" key={w.id}><div className="pcg-wi-text"><h3>{t('modules.contract_staff')} · {w.name}</h3><p>{lines.trigger}</p><p className="pcg-wi-steps">{lines.steps}</p></div><div className="pcg-row">
    <span className="pcg-pill">{t('modules.contract_staff')}</span><span className={'pcg-pill '+(w.status==='live'?'pcg-pill-ok':'pcg-pill-warn')}>{t('status.'+w.status)}</span>
    {problems.length>0&&<span className="pcg-pill pcg-pill-warn">{t('status.attention')}</span>}
    <button type="button" className="v9-button" onClick={()=>setEditing(item)}>{t(w.status==='retired'?'workflows.view':'workflows.edit')}</button>
   </div></li>;
  })}</ul>
 </section>;
}
