'use client';
import {ActionButton} from '@/components/ui/action-button';
import Link from 'next/link';
import {useState,useTransition,type ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {ArrowLeft,Check,FileText} from 'lucide-react';
import type {ProbationCaseView,ProbationPartView,ProbationAutomationHistoryRun} from '@/packs/probation/service';
import {probationDate,probationTimestamp} from '@/lib/probation-display';
import {CaseDateControls} from './case-date-controls';
import {LegacyReconciliationControls} from './legacy-reconciliation-controls';
import {addFollowup} from './actions';
import {LowResultActions} from './pbp-decisions';
import {AutomationHistory} from './automation-history';
import {PartEditor} from './part-editor';
import {probationCaseClosed,probationCurrentPart,probationDayDiff,probationOutcomeState,probationPartState,probationPartsByType,probationRouteSteps,probationWaitingOn,type ProbationCaseTab,type ProbationStepState} from './case-stage';

/**
 * The Probation case view (lane L, L1; prototype CaseView): a header with the employee's facts, the parts stepper and the
 * current part's signing route, then tabs Part 1 · Week 1 KPIs / Part 2 · Mid-Probation / Part 3 · Final / Outcome &
 * letters / Files / History. Each tab is its own address, so only the selected tab's data is read on the server; every
 * action keeps its own server-side check.
 */
export type ProbationCaseViewProps={view:ProbationCaseView;today:string;tab:ProbationCaseTab;part:ProbationPartView|null;actor:{id:string;name:string};signerCandidates?:{id:string;name:string}[];history?:ProbationAutomationHistoryRun[]};
const caseHref=(view:ProbationCaseView)=>'/lifecycle/probation/'+view.record.id;
export function probationTabHref(view:ProbationCaseView,tab:ProbationCaseTab):string{
 if(tab==='p1'||tab==='p2'||tab==='p3'){const part=probationPartsByType(view).find(p=>'p'+p.type===tab);return part?caseHref(view)+'/'+part.id:caseHref(view);}
 return caseHref(view)+'?tab='+tab;
}
function Step({state,children,dashed}:{state:ProbationStepState;children:ReactNode;dashed?:boolean}){
 const t=useTranslations('probation.caseView');
 return <li className="probation-step" data-state={state} data-dashed={dashed?'true':undefined} aria-current={state==='current'||state==='overdue'||state==='returned'?'step':undefined}>
  {state==='done'&&<Check size={14} aria-hidden="true"/>}<span>{children}</span><span className="sr-only"> ({t('stepState.'+state)})</span></li>;
}
export function ProbationCaseViewScreen({view,today,tab,part,actor,signerCandidates,history}:ProbationCaseViewProps){
 const t=useTranslations('probation'),c=useTranslations('probation.caseView');
 const name=(id:string|null|undefined)=>id?view.holderNames[id]??null:null;
 const role=(r:string)=>t.has('roles.'+r)?t('roles.'+r):/^(routing:|group:|people$)/.test(r)?t('roles.approver'):r;
 const shown=probationPartsByType(view),current=probationCurrentPart(view),closed=probationCaseClosed(view),waiting=probationWaitingOn(view);
 const partName=(p:ProbationPartView,kind:'stage'|'tabs')=>p.cycle>1&&p.type===3?c(kind+'.cycle',{part:c(kind+'.'+p.type),cycle:p.cycle}):c(kind+'.'+p.type);
 const stage=view.startStatus==='did_not_join'?t('caseStates.didNotJoin'):closed?t('caseStates.'+view.record.state):view.startStatus==='waiting_for_start'?t('caseStates.waitingForStart'):current?partName(current,'stage'):c('stage.outcome');
 const due=current&&current.state!=='not_issued'&&view.startStatus!=='waiting_for_start'?current.dueOn:null,left=due?probationDayDiff(today,due):0;
 const dueText=due?' · '+c('due',{date:probationDate(due)})+' ('+(left<0?c('daysOverdue',{count:-left}):left===0?c('dueToday'):c('daysLeft',{count:left}))+')':'';
 const waitingText=closed?c('closed'):!waiting?'':waiting.what==='opens'?c('opens',{date:probationDate(waiting.date)}):c('waitingOn',{who:(()=>{const who=name(waiting.holderId),roleLabel=waiting.label??role(waiting.role);return who?c('who',{role:roleLabel,name:who,what:c('what.'+waiting.what)}):c('whoNoName',{role:roleLabel,what:c('what.'+waiting.what)});})()});
 const routeSteps=current&&current.state!=='not_issued'&&view.startStatus!=='waiting_for_start'?probationRouteSteps(current):[];
 const stepLabel=(s:ReturnType<typeof probationRouteSteps>[number])=>['self','lmKpis','lmAssess','ack'].includes(s.kind)?c('steps.'+s.kind):c('steps.'+s.kind,{who:name(s.holderId)??s.label??role(s.role)});
 const f=view.record.facts,lm=name(f.holders.lm),pbp=name(f.holders.pbp);
 const tabs:[ProbationCaseTab,string][]=[...shown.map(p=>['p'+p.type as ProbationCaseTab,partName(p,'tabs')] as [ProbationCaseTab,string]),['outcome',c('tabs.outcome')],['files',c('tabs.files',{count:view.files.length})],['history',c('tabs.history')]];
 const currentTab:ProbationCaseTab|null=current?'p'+current.type as ProbationCaseTab:!closed&&view.startStatus!=='waiting_for_start'?'outcome':null;
 const statePill=view.record.state==='confirmed'?'v9-badge v9-badge-green':closed?'v9-badge v9-badge-red':'v9-badge v9-badge-indigo';
 return <main>
  <div><Link className="v9-button" href="/lifecycle/probation"><ArrowLeft size={16}/>{t('backTracker')}</Link></div>
  <section className="v9-panel v9-stack" aria-labelledby="probation-case-heading">
   <div className="v9-heading" style={{alignItems:'flex-start'}}>
    <div><h1 id="probation-case-heading">{c('heading',{stage})}</h1><p className="v9-muted" data-testid="probation-waiting">{waitingText}{!closed&&dueText}</p></div>
    <div className="probation-actions"><span className={statePill}>{closed?stage:t('title')}</span><span className="v9-muted">{f.employeeCode??'—'}</span></div>
   </div>
   <ol className="probation-stepper" aria-label={c('partsLabel')}>
    {shown.map(p=>{const state=probationPartState(view,p,today);return <Step key={p.id} state={state}>{c('short.'+p.type)}{p.state==='completed_offline'?' ('+t('partStates.completed_offline').toLowerCase()+')':''}</Step>;})}
    <Step state={probationOutcomeState(view)}>{c('short.outcome')}</Step>
   </ol>
   {routeSteps.length>0&&<ol className="probation-stepper" aria-label={c('routeLabel')}>{routeSteps.map(s=><Step key={s.id} state={s.state} dashed={!s.core}>{stepLabel(s)}</Step>)}</ol>}
   <dl className="probation-facts">
    <div><dt>{c('facts.employee')}</dt><dd>{f.employeeName} · {f.employeeCode??'—'}</dd></div>
    <div><dt>{c('facts.titleGrade')}</dt><dd>{f.title??'—'} · {view.record.gradeAtStart||f.grade||'—'}</dd></div>
    <div><dt>{c('facts.businessGroup')}</dt><dd>{f.businessGroup??'—'}<small>{f.companyName}</small></dd></div>
    <div><dt>{c('facts.businessUnit')}</dt><dd>{f.businessUnit??'—'}<small>{f.department??'—'}</small></dd></div>
    <div><dt>{c('facts.probation')}</dt><dd>{probationDate(view.record.startOn)} – {probationDate(view.record.endOn)}<small>{f.probationMonths?c('months',{months:f.probationMonths}):'—'}</small></dd></div>
    <div><dt>{c('facts.plan')}</dt><dd>{view.record.planMonths===6||view.record.planMonths===3?c('plan.'+view.record.planMonths):c('plan.other',{months:view.record.planMonths})}</dd></div>
    <div><dt>{c('facts.extensions')}</dt><dd>{t('extensionCount',{count:view.record.extensionCount,max:view.record.config.maxExtensions})}</dd></div>
    <div><dt>{c('facts.people')}</dt><dd>{c('peopleLm',{name:lm??'—'})}<small>{c('peoplePbp',{name:pbp??'—'})}</small></dd></div>
   </dl>
  </section>
  {view.startStatus==='waiting_for_start'&&<p className="v9-notice" role="status">{c('waitingStart',{date:probationDate(view.record.startOn)})}</p>}
  {view.startStatus==='did_not_join'&&<p className="v9-notice" role="status">{t('startStatus.didNotJoin')}</p>}
  {!view.runtimeEnabled&&<p className="v9-notice">{t(view.sourceMoved?'sourceMoved':'runtimePaused')}</p>}
  {view.parts.some(p=>p.override&&p.state!=='cancelled')&&<p className="v9-notice v9-warning" role="status"><span className="v9-badge v9-badge-amber">{t('tracker.flags.overridden')}</span> {t('overrideNotice')}</p>}
  {f.gradeId!==f.currentGradeId&&<p className="v9-notice v9-warning">{t('gradeChanged')}</p>}
  {view.record.planFlag&&<p className="v9-notice v9-warning">{t('planFlag')}</p>}
  <nav className="probation-tabs" aria-label={c('tabs.label')}>
   {tabs.map(([key,label])=><Link key={key} href={probationTabHref(view,key)} aria-current={tab===key?'page':undefined}>{label}{currentTab===key&&<span className="probation-tab-dot" title={c('tabs.current')}><span className="sr-only">{c('tabs.current')}</span></span>}</Link>)}
  </nav>
  {(tab==='p1'||tab==='p2'||tab==='p3')&&(part?<PartTab view={view} part={part} actor={actor} signerCandidates={signerCandidates}/>:<p className="v9-notice">{c('noPart')}</p>)}
  {tab==='outcome'&&<OutcomeTab view={view}/>}
  {tab==='files'&&<FilesTab view={view}/>}
  {tab==='history'&&<HistoryTab view={view} history={history}/>}
 </main>;
}
function PartTab({view,part,actor,signerCandidates}:{view:ProbationCaseView;part:ProbationPartView;actor:{id:string;name:string};signerCandidates?:{id:string;name:string}[]}){
 const t=useTranslations('probation'),c=useTranslations('probation.caseView');
 const cycles=view.parts.filter(p=>p.type===part.type&&p.id!==part.id);
 return <>
  {cycles.length>0&&<nav className="probation-actions" aria-label={c('earlierCycles')}><span className="v9-muted">{c('earlierCycles')}</span>{cycles.map(p=><Link key={p.id} className="v9-button" href={'/lifecycle/probation/'+view.record.id+'/'+p.id}>{c('cycleLink',{cycle:p.cycle,state:t('partStates.'+p.state)})}</Link>)}</nav>}
  <PartEditor embedded signerCandidates={signerCandidates} key={part.id+':'+part.storageRevision+':'+view.runtimeEnabled} view={view} part={part} actor={actor}/>
 </>;
}
function OutcomeTab({view}:{view:ProbationCaseView}){
 const t=useTranslations('probation'),c=useTranslations('probation.caseView');
 const operations=view.roles.includes('pbp')||view.roles.includes('gbs');
 return <div className="probation-tabpanel">
  <LowResultActions view={view}/>
  {!view.outcomes.length&&!view.letterTasks.length&&<p className="v9-panel v9-muted">{c('noOutcome')}</p>}
  {view.outcomes.length>0&&<section className="v9-panel v9-stack"><h2>{t('outcomeRecords')}</h2><ul className="v9-list">{view.outcomes.map(outcome=><li key={outcome.id}><strong>{t.has('outcomes.'+outcome.outcome)?t('outcomes.'+outcome.outcome):outcome.outcome}</strong> · {t.has('outcomeStates.'+outcome.state)?t('outcomeStates.'+outcome.state):outcome.state}{outcome.releasedAt&&<span className="v9-muted"> · {probationTimestamp(outcome.releasedAt)}</span>}{view.runtimeEnabled&&(outcome.state==='release_requested'||outcome.filingState==='pending')&&<p className="v9-notice">{t('letters.filingPending')}</p>}{outcome.failure&&<p role="alert">{t('outcomeFailed')}</p>}{operations&&view.runtimeEnabled&&<Link className="v9-button" href={'/lifecycle/probation/'+view.record.id+'/outcomes/'+outcome.id}>{t('manageOutcome')}</Link>}</li>)}</ul></section>}
  {view.letterTasks.length>0&&<section className="v9-panel v9-stack"><h2>{t('letters.tasks')}</h2><ul className="v9-list">{view.letterTasks.map(letter=><li key={letter.partId}><strong>{letter.label}</strong><p>{letter.waitingName??(letter.waitingRole?t('roles.'+letter.waitingRole):t('letters.waiting'))}</p><Link className="v9-button" href={'/lifecycle/probation/'+view.record.id+'/letters/'+letter.partId}>{t('letters.open')}</Link></li>)}</ul></section>}
 </div>;
}
function FilesTab({view}:{view:ProbationCaseView}){
 const t=useTranslations('probation'),c=useTranslations('probation.caseView');
 return <section className="v9-panel v9-stack"><h2>{t('files.title')}</h2>{!view.files.length?<p className="v9-muted">{c('filesEmpty')}</p>:<ul className="v9-list">{view.files.map(file=><li key={file.id}><FileText size={16} aria-hidden="true"/> <a href={'/lifecycle/probation/'+view.record.id+'/files/'+file.id} data-unsaved-guard="ignore" target="_blank" rel="noreferrer">{file.name}</a> · {t('version',{version:file.revision})}{file.filingState==='pending'&&<span className="v9-badge">{t('files.filingPending')}</span>}</li>)}</ul>}</section>;
}
function HistoryTab({view,history}:{view:ProbationCaseView;history?:ProbationAutomationHistoryRun[]}){
 const t=useTranslations('probation'),router=useRouter(),[busy,start]=useTransition(),[kind,setKind]=useState<'followup'|'development'|'extension_recommendation'|'nonconfirmation_recommendation'>('followup'),[note,setNote]=useState(''),[error,setError]=useState('');
 const operations=view.roles.includes('pbp')||view.roles.includes('gbs'),development=view.runtimeEnabled&&(operations||view.roles.includes('lm'));
 const save=()=>{setError('');start(async()=>{const result=await addFollowup({caseId:view.record.id,kind,note});if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}setNote('');router.refresh();});};
 return <div className="probation-tabpanel">
  {history&&<AutomationHistory runs={history}/>}
  <section className="v9-panel v9-stack"><h2>{t('followup.title')}</h2>{error&&<p className="v9-notice v9-error" role="alert">{error}</p>}
   {development&&<><label className="v9-field"><span>{t('followup.kind')}</span><select value={kind} disabled={busy} onChange={e=>setKind(e.target.value as typeof kind)}>{(['followup','development','extension_recommendation','nonconfirmation_recommendation'] as const).map(value=><option key={value} value={value}>{t('followup.'+value)}</option>)}</select></label><label className="v9-field"><span>{t('followup.note')}</span><textarea value={note} maxLength={10000} disabled={busy} onChange={e=>setNote(e.target.value)}/></label><div><ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button" disabled={busy||!note.trim()} onClick={save}>{t('followup.save')}</ActionButton></div></>}
   {!view.followups.length?<p className="v9-muted">{t('followup.empty')}</p>:<ol className="v9-list">{view.followups.map(followup=><li key={followup.id}><strong>{t.has('followup.'+followup.kind)?t('followup.'+followup.kind):followup.kind}</strong> · {probationTimestamp(followup.at)}<p className="probation-note">{followup.note}</p></li>)}</ol>}</section>
  {operations&&<CaseDateControls view={view}/>}
  <LegacyReconciliationControls view={view}/>
 </div>;
}
