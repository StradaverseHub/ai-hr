'use client';
import {probationBusinessUnitMissing} from '@/lib/probation-reconciliation';
import {ActionButton} from '@/components/ui/action-button';
import Link from 'next/link';
import {useState,useTransition,type ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Check} from 'lucide-react';
import type {ProbationCaseView,ProbationPartView,ProbationAutomationHistoryRun,ProbationLetterView} from '@/packs/probation/service';
import {probationDate,probationTimestamp} from '@/lib/probation-display';
import {CaseDateControls} from './case-date-controls';
import {LegacyReconciliationControls} from './legacy-reconciliation-controls';
import {addFollowup} from './actions';
import {LowResultActions} from './pbp-decisions';
import {AutomationHistory} from './automation-history';
import {PartEditor} from './part-editor';
import {LetterView} from './letter-view';
import {useProbationWaitingLabel} from './case-labels';
import {probationCaseClosed,probationCurrentPart,probationDayDiff,probationOutcomeState,probationPartState,probationPartsByType,probationRouteSteps,probationWaitingOn,type ProbationCaseTab,type ProbationStepState} from './case-stage';

/**
 * The Probation case view (lane L, L1; prototype CaseView): a header with the employee's facts, the parts stepper and the
 * current part's signing route, then tabs Part 1 · Week 1 KPIs / Part 2 · Mid-Probation / Part 3 · Final / Outcome &
 * letters / Files / History. Each tab is its own address, so only the selected tab's data is read on the server; every
 * action keeps its own server-side check.
 */
export type ProbationCaseViewProps={emailFiles?:ReactNode;letterCompletion?:ReactNode;view:ProbationCaseView;today:string;tab:ProbationCaseTab;part:ProbationPartView|null;actor:{id:string;name:string};signerCandidates?:{id:string;name:string}[];history?:ProbationAutomationHistoryRun[];
 /** Outcome & letters: the latest letter, read on the server (it authorizes and hides private content). */
 letter?:ProbationLetterView|null;letterSignerCandidates?:{id:string;name:string}[]};
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
export function ProbationCaseViewScreen({view,today,tab,part,actor,signerCandidates,history,letter,letterSignerCandidates,emailFiles,letterCompletion}:ProbationCaseViewProps){
 const t=useTranslations('probation'),c=useTranslations('probation.caseView');
 const name=(id:string|null|undefined)=>id?view.holderNames[id]??null:null;
 const role=(r:string)=>t.has('roles.'+r)?t('roles.'+r):/^(routing:|group:|people$)/.test(r)?t('roles.approver'):r;
 const shown=probationPartsByType(view),current=probationCurrentPart(view),closed=probationCaseClosed(view),waiting=probationWaitingOn(view);
 const partName=(p:ProbationPartView,kind:'stage'|'tabs')=>p.cycle>1&&p.type===3?c(kind+'.cycle',{part:c(kind+'.'+p.type),cycle:p.cycle}):c(kind+'.'+p.type);
 const stage=view.startStatus==='did_not_join'?t('caseStates.didNotJoin'):closed?t('caseStates.'+view.record.state):view.startStatus==='waiting_for_start'?t('caseStates.waitingForStart'):current?partName(current,'stage'):c('stage.outcome');
 const due=current&&current.state!=='not_issued'&&view.startStatus!=='waiting_for_start'?current.dueOn:null,left=due?probationDayDiff(today,due):0;
 const dueText=due?' · '+c('due',{date:probationDate(due)})+' ('+(left<0?c('daysOverdue',{count:-left}):left===0?c('dueToday'):c('daysLeft',{count:left}))+')':'';
 const waitingLabel=useProbationWaitingLabel(view),who=waiting&&waiting.what!=='opens'?waitingLabel(waiting):null,mine=!!waiting&&!!waiting.holderId&&waiting.holderId===actor.id;
 const routeSteps=current&&current.state!=='not_issued'&&view.startStatus!=='waiting_for_start'?probationRouteSteps(current):[];
 const stepLabel=(s:ReturnType<typeof probationRouteSteps>[number])=>['self','lmKpis','lmAssess','ack'].includes(s.kind)?c('steps.'+s.kind):c('steps.'+s.kind,{who:name(s.holderId)??s.label??role(s.role)});
 const f=view.record.facts,lm=name(f.holders.lm),pbp=name(f.holders.pbp);
 const tabs:[ProbationCaseTab,string][]=[...shown.map(p=>['p'+p.type as ProbationCaseTab,partName(p,'tabs')] as [ProbationCaseTab,string]),['outcome',c('tabs.outcome')],['files',c('tabs.files',{count:view.files.length})],['history',c('tabs.history')]];
 const currentTab:ProbationCaseTab|null=current?'p'+current.type as ProbationCaseTab:!closed&&view.startStatus!=='waiting_for_start'?'outcome':null;
 const statePill=view.record.state==='confirmed'?'pcc-pill pcc-pill-ok':closed?'pcc-pill pcc-pill-bad':'pcc-pill pcc-pill-acc';
 return <main className="pcc">
  <Link className="pcc-back" href="/lifecycle/probation"><span aria-hidden="true">‹ </span>{c('back')}</Link>
  <section className="pcc-card pcc-head" aria-labelledby="probation-case-heading">
   <div className="pcc-row pcc-between">
    <div><h1 id="probation-case-heading">{c('heading',{stage})}</h1>
     <p className="pcc-waiting" data-testid="probation-waiting">{closed?c('closed'):waiting?.what==='opens'?c('opens',{date:probationDate(waiting.date)}):who?<>{mine?<b>{c('yourStep')} </b>:c('waitingOnLabel')+' '}{who.text}</>:null}{!closed&&dueText}</p></div>
    <div className="pcc-row"><span className={statePill}>{closed?stage:c('pill')}</span></div>
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
    <div><dt>{c('facts.people')}</dt><dd style={{fontWeight:500}}>{c('peopleLm',{name:lm??'—'})}<small>{c('peoplePbp',{name:pbp??'—'})}</small></dd></div>
   </dl>
  </section>
  {view.startStatus==='waiting_for_start'&&<p className="pcc-wait" role="status"><b>{c('waitingStart',{date:probationDate(view.record.startOn)})}</b></p>}
  {view.startStatus==='did_not_join'&&<p className="pcc-banner" role="status">{t('startStatus.didNotJoin')}</p>}
  {!closed&&who&&!mine&&<p className="pcc-wait" data-testid="probation-next-action"><span>{c('nextAction')} <b>{who.text}</b>.</span></p>}
  {probationBusinessUnitMissing(view.record.facts)&&<p className="pcc-banner">{t('reconciliation.missingBu')}</p>}
  {!view.runtimeEnabled&&<p className="pcc-banner">{t(view.sourceMoved?'sourceMoved':'runtimePaused')}</p>}
  {view.parts.some(p=>p.override&&p.state!=='cancelled')&&<p className="pcc-banner pcc-banner-warn" role="status"><span className="pcc-pill pcc-pill-warn">{t('tracker.flags.overridden')}</span> {t('overrideNotice')}</p>}
  {f.gradeId!==f.currentGradeId&&<p className="pcc-banner pcc-banner-warn">{t('gradeChanged')}</p>}
  {view.record.planFlag&&<p className="pcc-banner pcc-banner-warn">{t('planFlag')}</p>}
  <nav className="probation-tabs" aria-label={c('tabs.label')}>
   {tabs.map(([key,label])=><Link key={key} href={probationTabHref(view,key)} aria-current={tab===key?'page':undefined}>{label}{currentTab===key&&<span className="probation-tab-dot" title={c('tabs.current')}><span className="sr-only">{c('tabs.current')}</span></span>}</Link>)}
  </nav>
  {(tab==='p1'||tab==='p2'||tab==='p3')&&(part?<PartTab view={view} part={part} actor={actor} signerCandidates={signerCandidates}/>:<p className="pcc-card pcc-empty">{c('noPart')}</p>)}
  {tab==='outcome'&&<OutcomeTab letterCompletion={letterCompletion} view={view} actor={actor} letter={letter??null} letterSignerCandidates={letterSignerCandidates}/>}
  {tab==='files'&&<><FilesTab view={view}/>{emailFiles}</>}
  {tab==='history'&&<HistoryTab view={view} history={history}/>}
 </main>;
}
function PartTab({view,part,actor,signerCandidates}:{view:ProbationCaseView;part:ProbationPartView;actor:{id:string;name:string};signerCandidates?:{id:string;name:string}[]}){
 const t=useTranslations('probation'),c=useTranslations('probation.caseView');
 const cycles=view.parts.filter(p=>p.type===part.type&&p.id!==part.id);
 return <>
  {cycles.length>0&&<nav className="pcc-row" aria-label={c('earlierCycles')}><span className="pcc-muted pcc-small">{c('earlierCycles')}</span>{cycles.map(p=><Link key={p.id} className="v9-button" href={'/lifecycle/probation/'+view.record.id+'/'+p.id}>{c('cycleLink',{cycle:p.cycle,state:t('partStates.'+p.state)})}</Link>)}</nav>}
  <PartEditor embedded signerCandidates={signerCandidates} key={part.id+':'+part.storageRevision+':'+view.runtimeEnabled} view={view} part={part} actor={actor}/>
 </>;
}
/** Outcome & letters (prototype OutcomeTab): low-result actions, the outcome records, the latest letter in full, earlier letters. */
function OutcomeTab({view,actor,letter,letterSignerCandidates,letterCompletion}:{letterCompletion?:ReactNode;view:ProbationCaseView;actor:{id:string;name:string};letter:ProbationLetterView|null;letterSignerCandidates?:{id:string;name:string}[]}){
 const t=useTranslations('probation'),c=useTranslations('probation.caseView');
 const operations=view.roles.includes('pbp')||view.roles.includes('gbs');
 const others=letter?view.letterTasks.filter(task=>task.partId!==letter.id):view.letterTasks;
 return <div className="probation-tabpanel">
  <LowResultActions view={view}/>
  {!view.outcomes.length&&!view.letterTasks.length&&<p className="pcc-card pcc-empty">{c('noOutcome')}</p>}
  {view.outcomes.length>0&&<section className="pcc-card" aria-labelledby="pcc-outcomes"><h2 id="pcc-outcomes">{t('outcomeRecords')}</h2><ul className="pcc-wl">{view.outcomes.map(outcome=><li className="pcc-wi" key={outcome.id}>
   <div><h4>{t.has('outcomes.'+outcome.outcome)?t('outcomes.'+outcome.outcome):outcome.outcome}</h4><p>{t.has('outcomeStates.'+outcome.state)?t('outcomeStates.'+outcome.state):outcome.state}{outcome.releasedAt&&<> · {probationTimestamp(outcome.releasedAt)}</>}</p>
    {view.runtimeEnabled&&(outcome.state==='release_requested'||outcome.filingState==='pending')&&<p className="pcc-small">{t('letters.filingPending')}</p>}{outcome.failure&&<p role="alert" className="pcc-small">{t('outcomeFailed')}</p>}</div>
   {operations&&view.runtimeEnabled&&<Link className="v9-button" href={'/lifecycle/probation/'+view.record.id+'/outcomes/'+outcome.id}>{t('manageOutcome')}</Link>}
  </li>)}</ul></section>}
  {letterCompletion}
  {letter&&<LetterView embedded key={letter.id+':'+letter.storageRevision+':'+letter.signing?.document.actions.length} letter={letter} actor={actor} signerCandidates={letterSignerCandidates}/>}
  {others.length>0&&<section className="pcc-card" aria-labelledby="pcc-letters"><h2 id="pcc-letters">{letter?c('earlierLetters'):t('letters.tasks')}</h2><ul className="pcc-wl">{others.map(task=><li className="pcc-wi" key={task.partId}>
   <div><h4>{task.label}</h4><p>{task.waitingName??(task.waitingRole?t('roles.'+task.waitingRole):t('letters.waiting'))}</p></div>
   <Link className="v9-button" href={'/lifecycle/probation/'+view.record.id+'/letters/'+task.partId}>{t('letters.open')}</Link>
  </li>)}</ul></section>}
 </div>;
}
/** Files (prototype): each filed document with what it is and a download link; access is checked by the file route. */
function FilesTab({view}:{view:ProbationCaseView}){
 const t=useTranslations('probation'),c=useTranslations('probation.caseView');
 return <section className="pcc-card" aria-label={t('files.title')}>{!view.files.length?<p className="pcc-empty">{c('filesEmpty')}</p>:<ul className="pcc-wl">{view.files.map(file=><li className="pcc-wi" key={file.id}>
  <div><h4>{file.name}</h4><p>{c.has('fileKinds.'+file.kind)?c('fileKinds.'+file.kind):file.kind} · {t('version',{version:file.revision})}{file.filingState==='pending'&&<> · <span className="pcc-pill pcc-pill-warn">{t('files.filingPending')}</span></>}</p></div>
  <a className="v9-button" href={'/lifecycle/probation/'+view.record.id+'/files/'+file.id} data-unsaved-guard="ignore" target="_blank" rel="noreferrer" aria-label={c('downloadFile',{name:file.name})}>{c('download')}</a>
 </li>)}</ul>}</section>;
}
function HistoryTab({view,history}:{view:ProbationCaseView;history?:ProbationAutomationHistoryRun[]}){
 const t=useTranslations('probation'),router=useRouter(),[busy,start]=useTransition(),[kind,setKind]=useState<'followup'|'development'|'extension_recommendation'|'nonconfirmation_recommendation'>('followup'),[note,setNote]=useState(''),[error,setError]=useState('');
 const operations=view.roles.includes('pbp')||view.roles.includes('gbs'),development=view.runtimeEnabled&&(operations||view.roles.includes('lm'));
 const save=()=>{setError('');start(async()=>{const result=await addFollowup({caseId:view.record.id,kind,note});if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}setNote('');router.refresh();});};
 const actor=(id:string)=>view.holderNames[id]??null;
 return <div className="probation-tabpanel">
  {history&&<AutomationHistory runs={history}/>}
  <section className="pcc-card" aria-labelledby="pcc-followups"><h2 id="pcc-followups">{t('followup.title')}</h2>{error&&<p className="pcc-banner pcc-banner-bad" role="alert">{error}</p>}
   {!view.followups.length?<p className="pcc-muted">{t('followup.empty')}</p>:<ol className="pcc-hist">{view.followups.map(followup=><li key={followup.id}><span className="pcc-muted pcc-num">{probationTimestamp(followup.at)}</span>
    <span><b>{actor(followup.actorId)??(t.has('followup.'+followup.kind)?t('followup.'+followup.kind):followup.kind)}</b>{actor(followup.actorId)?' · '+(t.has('followup.'+followup.kind)?t('followup.'+followup.kind):followup.kind):''}<span className="probation-note" style={{display:'block'}}>{followup.note}</span></span></li>)}</ol>}
   {development&&<div className="pcc-stack"><div className="pcc-grid2"><label className="pcc-field"><span>{t('followup.kind')}</span><select value={kind} disabled={busy} onChange={e=>setKind(e.target.value as typeof kind)}>{(['followup','development','extension_recommendation','nonconfirmation_recommendation'] as const).map(value=><option key={value} value={value}>{t('followup.'+value)}</option>)}</select></label></div><label className="pcc-field"><span>{t('followup.note')}</span><textarea value={note} maxLength={10000} disabled={busy} onChange={e=>setNote(e.target.value)}/></label><div><ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button" disabled={busy||!note.trim()} onClick={save}>{t('followup.save')}</ActionButton></div></div>}
  </section>
  {operations&&<CaseDateControls view={view}/>}
  <LegacyReconciliationControls view={view}/>
 </div>;
}
