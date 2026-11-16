'use client';
import type {ReactNode} from 'react';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {OFFBOARDING_AUTOMATION_CATALOGUE} from '@/lib/automation/catalogues/offboarding';
import {PROBATION_AUTOMATION_CATALOGUE} from '@/lib/automation/catalogues/probation';
import {automationWorkflowProblems,type AutomationWorkflow} from '@/lib/automation/workflow';
import {probationStepParamProblems} from '@/lib/automation/email';
import {FilterChips,LegacyBuilderCard} from '../filter-chips';
import {workflowListLines} from '../recipients';
import {ConfigBanner,ConfigHead} from '@/app/lifecycle/probation/settings/config-head';
import {installProbationDefaultsAction,installOffboardingDefaultsAction,moveProbationWorkflowsAction} from '../actions';
import type {ProbationWorkflowMoveResult} from '@/packs/probation/service';
import {LEGACY_BUILDERS,type AutomationFilter,type AutomationPageAccess} from '../types';
import {WorkflowEditor,type WorkflowEditorReferences} from './workflow-editor';

export type OffboardingWorkspace = {workflows:ListedWorkflow[];refs:WorkflowEditorReferences;editable:boolean};
export type ListedWorkflow = { workflow: AutomationWorkflow; revision: number };
const catalogue = PROBATION_AUTOMATION_CATALOGUE;
const blank = (): AutomationWorkflow => ({ id: crypto.randomUUID(), module: 'probation', name: '', description: '', status: 'paused', required: false, trigger: { event: catalogue.triggers[0].id, days: 0, workdays: false, repeat: false }, skipWhen: 'never', conditions: [], steps: [] });

/** HR Automation › Workflows (prototype WorkflowsPage; mockups 12 and 13). Probation is on the shared engine; the other modules link to their builders. */
export function WorkflowsWorkspace({filter,access,workflows,refs,defaultsMissing,offboarding,onboardingSection,contractSection}:{contractSection?:ReactNode;onboardingSection?:ReactNode;offboarding?:OffboardingWorkspace;filter:AutomationFilter;access:AutomationPageAccess;workflows:ListedWorkflow[];refs:WorkflowEditorReferences;defaultsMissing:number}){
 const t=useTranslations('automation'),router=useRouter(),[busy,start]=useTransition();
 const [editing,setEditing]=useState<ListedWorkflow|null>(null),[notice,setNotice]=useState<{kind:'error'|'status';text:string}|null>(null);
 const [moveReason,setMoveReason]=useState(''),[moveResult,setMoveResult]=useState<ProbationWorkflowMoveResult|null>(null);
 // G2: move the notify-only Probation workflows whose conversion is proven exact; the rest stay, with the reason.
 const move=()=>{if(!window.confirm(t('move.confirm')))return;setNotice(null);start(async()=>{const result=await moveProbationWorkflowsAction({reason:moveReason});if(!result.ok){setNotice({kind:'error',text:result.detail??t('errors.unavailable')});return;}
  setMoveResult(result.result);setMoveReason('');setNotice({kind:'status',text:t('move.done',{moved:result.result.moved.length,kept:result.result.kept.length,already:result.result.alreadyMoved})});router.refresh();});};
 const people=refs.people,references={routingExists:(id:string)=>refs.routings.some(r=>r.id===id&&!r.retired),groupExists:(id:string)=>refs.groups.some(g=>g.id===id),personExists:(id:string)=>people.some(p=>p.id===id)};
 const needsAttention=(w:AutomationWorkflow)=>w.status!=='retired'&&(automationWorkflowProblems(w,catalogue,references).length>0||probationStepParamProblems(w,{emailTemplates:refs.emailTemplates,letterTemplateIds:refs.letterTemplates?.map(l=>l.id)??null}).length>0);
 const showProbation=filter==='all'||filter==='probation',legacy=(['onb','off','contract_staff'] as const).filter(m=>(filter==='all'||filter===m)&&(!offboarding||m!=='off')&&(!onboardingSection||m!=='onb')&&(!contractSection||m!=='contract_staff'));
 const install=()=>{if(!window.confirm(t('defaults.confirm')))return;setNotice(null);start(async()=>{const result=await installProbationDefaultsAction();if(!result.ok){setNotice({kind:'error',text:result.detail??t('errors.unavailable')});return;}
  setNotice({kind:'status',text:t('defaults.done',{workflows:result.result.installed.workflows,emails:result.result.installed.emailTemplates,routings:result.result.installed.routings})});router.refresh();});};
 const installOffboarding=()=>{setNotice(null);start(async()=>{const result=await installOffboardingDefaultsAction();if(!result.ok){setNotice({kind:'error',text:result.detail??t('errors.unavailable')});return;}setNotice({kind:'status',text:`Resignation defaults ready: ${result.result.workflows} workflows, ${result.result.templates} document templates and ${result.result.emails} emails. Review the Draft workflows before making them live.`});router.refresh();});};
 if(editing)return <main className="v9-stack pcg"><p className="pcg-crumb">{t('crumb')} / {t('workflows.title')}</p>
  <WorkflowEditor key={editing.workflow.id} catalogue={editing.workflow.module==='off'?OFFBOARDING_AUTOMATION_CATALOGUE:catalogue} editable={editing.workflow.module!=='off'||offboarding?.editable===true} initial={editing.workflow} revision={editing.revision} refs={editing.workflow.module==='off'&&offboarding?offboarding.refs:refs} onClose={()=>setEditing(null)}/></main>;
 const active=workflows.filter(w=>w.workflow.status!=='retired'),retired=workflows.filter(w=>w.workflow.status==='retired');
 const requiredNotLive=active.filter(w=>w.workflow.required&&w.workflow.status!=='live');
 // Prototype WorkflowsPage (lane M3): head, module chips, the required-not-live banner, then one card with the intro row
 // and one row per workflow (trigger line, step chain, module/status/Required pills, Edit).
 return <main className="v9-stack pcg">
  <ConfigHead crumb={t('crumb')+' / '+t('workflows.title')} title={t('workflows.title')} sub={t('workflows.intro')}/>
  <FilterChips path="/automation/workflows" current={filter}/>
  {notice&&<p className={notice.kind==='error'?'v9-notice v9-error':'v9-notice'} role={notice.kind==='error'?'alert':'status'}>{notice.text}</p>}
  {showProbation&&access.probation&&requiredNotLive.length>0&&<ConfigBanner tone="warn" role="note" lead={t('workflows.requiredBanner',{names:requiredNotLive.map(w=>w.workflow.name).join(', '),count:requiredNotLive.length})}/>}
  {showProbation&&(access.probation?<section className="pcg-card pcg-card-flush" aria-label={t('modules.probation')}>
   <div className="pcg-wi"><span className="pcg-hint">{t('workflows.cardIntro')}</span>
    <span className="pcg-row">
     {defaultsMissing>0&&<button type="button" className="v9-button" disabled={busy} onClick={install}>{t('defaults.install')}</button>}
     <button type="button" className="v9-button v9-button-primary" disabled={busy} onClick={()=>setEditing({workflow:{...blank(),name:t('workflows.newName')},revision:0})}>{t('workflows.new')}</button>
    </span></div>
   <div className="pcg-card-extra">
   <p className="pcg-hint">{t('workflows.probationIntro')}</p>
   <details className="v9-stack" data-legacy-move><summary>{t('move.title')}</summary>
    <p className="v9-muted">{t('move.help')}</p>
    <label className="v9-field"><span>{t('move.reason')}</span><textarea value={moveReason} maxLength={500} disabled={busy} onChange={e=>setMoveReason(e.target.value)}/></label>
    <div><button type="button" className="v9-button" disabled={busy||moveReason.trim().length<3} onClick={move}>{t('move.button')}</button></div>
    {moveResult&&<div className="v9-stack" role="region" aria-label={t('move.result')}>
     {moveResult.moved.length>0&&<><h3>{t('move.moved')}</h3><ul className="v9-list">{moveResult.moved.map(m=><li key={m.definitionId}>{m.name} · {m.companyName}</li>)}</ul></>}
     {moveResult.kept.length>0&&<><h3>{t('move.kept')}</h3><ul className="v9-list">{moveResult.kept.map(k=><li key={k.definitionId}><strong>{k.name} · {k.companyName}</strong><p className="v9-muted">{k.reason}</p></li>)}</ul></>}
     {!moveResult.moved.length&&!moveResult.kept.length&&<p className="v9-muted">{t('move.none')}</p>}
    </div>}
   </details>
   {active.length===0&&<p className="v9-muted">{t('workflows.empty')}</p>}
   </div>
   <ul className="pcg-wl">{[...active,...retired].map(item=>{const w=item.workflow,lines=workflowListLines(w,catalogue);return <li key={w.id} className="pcg-wi">
    <div className="pcg-wi-text"><h3>{t('modules.probation')} · {w.name}</h3><p>{lines.trigger}</p><p className="pcg-wi-steps">{lines.steps}</p></div>
    <div className="pcg-row">
     <span className="pcg-pill">{t('modules.probation')}</span>
     <span className={'pcg-pill '+(w.status==='live'?'pcg-pill-ok':w.status==='paused'?'pcg-pill-warn':'')}>{t('status.'+w.status)}</span>
     {w.required&&<span className="pcg-pill pcg-pill-info">{t('status.required')}</span>}
     {needsAttention(w)&&<span className="pcg-pill pcg-pill-warn">{t('status.attention')}</span>}
     <button type="button" className="v9-button" aria-label={t('workflows.editNamed',{name:w.name})} onClick={()=>setEditing(item)}>{w.status==='retired'?t('workflows.view'):t('workflows.edit')}</button>
    </div>
   </li>;})}</ul>
  </section>:filter==='probation'&&<p className="v9-notice">{t('workflows.probationNotAllowed')}</p>)}
  {onboardingSection}
  {offboarding&&<section className="pcg-card pcg-card-flush" aria-label="Offboarding">
   <div className="pcg-wi"><div><h2>Offboarding</h2><p className="pcg-hint">Resignation workflows request decisions, route letters and create approved Personnel postings.</p></div><div className="v9-actions"><button type="button" className="v9-button" disabled={busy||!offboarding.editable} onClick={installOffboarding}>Set up resignation defaults</button><button type="button" className="v9-button v9-button-primary" disabled={busy||!offboarding.editable} onClick={()=>setEditing({workflow:{...blank(),module:'off',name:'New Offboarding workflow',trigger:{event:'submitted',days:0,workdays:false,repeat:false}},revision:0})}>New workflow</button></div></div>
   {!offboarding.workflows.length&&<p className="pcg-card-extra v9-muted">No Offboarding workflows yet. Configure the resignation defaults before accepting employee submissions.</p>}
   <ul className="pcg-wl">{offboarding.workflows.map(item=>{const w=item.workflow,lines=workflowListLines(w,OFFBOARDING_AUTOMATION_CATALOGUE);return <li className="pcg-wi" key={w.id}><div className="pcg-wi-text"><h3>{w.name}</h3><p>{lines.trigger}</p><p className="pcg-wi-steps">{lines.steps}</p></div><div className="pcg-row"><span className="pcg-pill">Offboarding</span><span className={'pcg-pill '+(w.status==='live'?'pcg-pill-ok':w.status==='paused'?'pcg-pill-warn':'')}>{w.status==='paused'?'Draft':t('status.'+w.status)}</span><button type="button" className="v9-button" aria-label={'Edit '+w.name} onClick={()=>setEditing(item)}>{w.status==='retired'?'View':'Edit'}</button></div></li>;})}</ul>
  </section>}
  {contractSection}
  {legacy.map(module=><LegacyBuilderCard key={module} module={module} kind="workflows" href={LEGACY_BUILDERS.workflows[module]} allowed={module==='contract_staff'?access.contractStaff:access.legacy}/>)}
 </main>;
}
