'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {PROBATION_AUTOMATION_CATALOGUE} from '@/lib/automation/catalogues/probation';
import {automationWorkflowProblems,type AutomationWorkflow} from '@/lib/automation/workflow';
import {probationStepParamProblems} from '@/lib/automation/email';
import {FilterChips,LegacyBuilderCard} from '../filter-chips';
import {workflowSummary} from '../recipients';
import {installProbationDefaultsAction} from '../actions';
import {LEGACY_BUILDERS,type AutomationFilter,type AutomationPageAccess} from '../types';
import {WorkflowEditor,type WorkflowEditorReferences} from './workflow-editor';

export type ListedWorkflow = { workflow: AutomationWorkflow; revision: number };
const catalogue = PROBATION_AUTOMATION_CATALOGUE;
const blank = (): AutomationWorkflow => ({ id: crypto.randomUUID(), module: 'probation', name: '', description: '', status: 'paused', required: false, trigger: { event: catalogue.triggers[0].id, days: 0, workdays: false, repeat: false }, skipWhen: 'never', conditions: [], steps: [] });

/** HR Automation › Workflows (prototype WorkflowsPage; mockups 12 and 13). Probation is on the shared engine; the other modules link to their builders. */
export function WorkflowsWorkspace({filter,access,workflows,refs,defaultsMissing}:{filter:AutomationFilter;access:AutomationPageAccess;workflows:ListedWorkflow[];refs:WorkflowEditorReferences;defaultsMissing:number}){
 const t=useTranslations('automation'),router=useRouter(),[busy,start]=useTransition();
 const [editing,setEditing]=useState<ListedWorkflow|null>(null),[notice,setNotice]=useState<{kind:'error'|'status';text:string}|null>(null);
 const people=refs.people,references={routingExists:(id:string)=>refs.routings.some(r=>r.id===id&&!r.retired),groupExists:(id:string)=>refs.groups.some(g=>g.id===id),personExists:(id:string)=>people.some(p=>p.id===id)};
 const needsAttention=(w:AutomationWorkflow)=>w.status!=='retired'&&(automationWorkflowProblems(w,catalogue,references).length>0||probationStepParamProblems(w,{emailTemplates:refs.emailTemplates,letterTemplateIds:refs.letterTemplates?.map(l=>l.id)??null}).length>0);
 const showProbation=filter==='all'||filter==='probation',legacy=(['onb','off','contract_staff'] as const).filter(m=>filter==='all'||filter===m);
 const install=()=>{if(!window.confirm(t('defaults.confirm')))return;setNotice(null);start(async()=>{const result=await installProbationDefaultsAction();if(!result.ok){setNotice({kind:'error',text:result.detail??t('errors.unavailable')});return;}
  setNotice({kind:'status',text:t('defaults.done',{workflows:result.result.installed.workflows,emails:result.result.installed.emailTemplates,routings:result.result.installed.routings})});router.refresh();});};
 if(editing)return <main className="v9-stack"><p className="automation-crumb">{t('crumb')} / {t('workflows.title')}</p>
  <WorkflowEditor key={editing.workflow.id} catalogue={catalogue} initial={editing.workflow} revision={editing.revision} refs={refs} onClose={()=>setEditing(null)}/></main>;
 const active=workflows.filter(w=>w.workflow.status!=='retired'),retired=workflows.filter(w=>w.workflow.status==='retired');
 const requiredNotLive=active.filter(w=>w.workflow.required&&w.workflow.status!=='live');
 return <main className="v9-stack">
  <p className="automation-crumb">{t('crumb')} / {t('workflows.title')}</p>
  <header className="v9-heading"><div><h1>{t('workflows.title')}</h1><p className="v9-muted">{t('workflows.intro')}</p></div></header>
  <FilterChips path="/automation/workflows" current={filter}/>
  {notice&&<p className={notice.kind==='error'?'v9-notice v9-error':'v9-notice'} role={notice.kind==='error'?'alert':'status'}>{notice.text}</p>}
  {showProbation&&(access.probation?<section className="v9-panel v9-stack" aria-label={t('modules.probation')}>
   <div className="automation-row automation-between"><h2>{t('modules.probation')}</h2>
    <span className="automation-row">
     {defaultsMissing>0&&<button type="button" className="v9-button" disabled={busy} onClick={install}>{t('defaults.install')}</button>}
     <button type="button" className="v9-button v9-button-primary" disabled={busy} onClick={()=>setEditing({workflow:{...blank(),name:t('workflows.newName')},revision:0})}>{t('workflows.new')}</button>
    </span></div>
   <p className="v9-muted">{t('workflows.probationIntro')}</p>
   {requiredNotLive.length>0&&<p className="v9-notice" role="note">{t('workflows.requiredBanner',{names:requiredNotLive.map(w=>w.workflow.name).join(', '),count:requiredNotLive.length})}</p>}
   {active.length===0&&<p className="v9-muted">{t('workflows.empty')}</p>}
   <ul className="automation-list">{[...active,...retired].map(item=>{const w=item.workflow;return <li key={w.id} className="automation-item">
    <div className="automation-item-text"><h3>{t('modules.probation')} · {w.name}</h3><p>{workflowSummary(w,catalogue)}</p></div>
    <div className="automation-row">
     <span className={'automation-pill '+(w.status==='live'?'automation-pill-ok':w.status==='paused'?'automation-pill-warn':'')}>{t('status.'+w.status)}</span>
     {w.required&&<span className="automation-pill automation-pill-info">{t('status.required')}</span>}
     {needsAttention(w)&&<span className="automation-pill automation-pill-warn">{t('status.attention')}</span>}
     <button type="button" className="v9-button" aria-label={t('workflows.editNamed',{name:w.name})} onClick={()=>setEditing(item)}>{w.status==='retired'?t('workflows.view'):t('workflows.edit')}</button>
    </div>
   </li>;})}</ul>
  </section>:filter==='probation'&&<p className="v9-notice">{t('workflows.probationNotAllowed')}</p>)}
  {legacy.map(module=><LegacyBuilderCard key={module} module={module} kind="workflows" href={LEGACY_BUILDERS.workflows[module]} allowed={module==='contract_staff'?access.contractStaff:access.legacy}/>)}
 </main>;
}
