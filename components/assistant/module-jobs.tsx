/** Canonical typed facts only. A model answer, copied receipt or arbitrary JSON cannot render here. */
import {randomUUID} from 'node:crypto';
import {saveGovernedJobFeedbackAction,eraseGovernedJobFeedbackAction} from '../../app/assistant/job-feedback-actions';
import {runGovernedPlanAction} from '../../app/assistant/governed-job-actions';
import type {GovernedWorkspaceJobView} from '../../core/workspace-module-jobs';
import {getLocale,getTranslations} from 'next-intl/server';
import {Card} from '../ui';
import type {SessionContext} from '../../db/client';
import {assertCanonicalModuleJobView,type CanonicalModuleJobView} from '../../core/workspace-module-jobs';
import type {AgentModuleCode} from '../../lib/ai/module-agents';
import type {JobFact,JobCard} from '../../lib/ai/module-jobs';
import type {GroundedWorkspaceAnswer} from '../../core/workspace-grounded-answers';
import {MODULE_JOBS} from '../../lib/ai/module-jobs';
const knownStates=new Set(['active','probation','resigned','terminated','pending','approved','rejected','cancelled','draft','paid','closed','completed','in_progress','not_tested','passed','failed','skipped','annual','offcycle','regular','day','hour','not_started','self_review','manager_review','submitted','acknowledged','present','absent','late','half_day','active_serving_notice','blacklisted','withhold','full_day','half_day_am','half_day_pm','hourly','administrative','functional','taken','converted_to_pay','lapsed','reversed','pass','fail','blocked','partial','manager','report']);
export async function ModuleJobChooser({modules,selected}:{modules:readonly AgentModuleCode[];selected?:string}){
 const t=await getTranslations('assistant.workspace.jobs');
 return <section aria-labelledby="assistant-canonical-jobs" className="space-y-3">
  <div><h2 id="assistant-canonical-jobs" className="text-base font-semibold">{t('title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('intro')}</p></div>
  <div className="grid gap-2 sm:grid-cols-2">{MODULE_JOBS.filter(([module])=>modules.includes(module)).map(([module])=><a
   key={module} href={'/assistant?job='+encodeURIComponent(module)} aria-current={selected===module?'page':undefined}
   className={`min-h-20 rounded-lg border p-3 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none ${selected===module?'border-primary bg-primary/5':'border-border bg-card'}`}>
   <span className="block text-sm font-medium">{t(`module_${module}`)}</span><span className="mt-1 block text-xs text-muted-foreground">{t(`help_${module}`)}</span>
  </a>)}</div>
 </section>;
}
export async function CanonicalModuleJob({view,ctx}:{view:CanonicalModuleJobView;ctx:SessionContext}){
 const t=await getTranslations('assistant.workspace.jobs'),answers=await getTranslations('assistant.workspace.answers'),gap=await getTranslations('controlTower.readinessScreen.gap'),rewardStage=await getTranslations('rewards.stages'),rewardKind=await getTranslations('rewards.kinds');
 const locale=await getLocale(),safeLocale=['en','ms','zh','ta','th','vi'].includes(locale)?locale:'en';
 try{assertCanonicalModuleJobView(view,ctx);}catch{return <Card className="p-5"><p role="status" className="text-sm text-muted-foreground">{t('unavailable')}</p></Card>;}
 if(view.state==='unavailable')return <Card className="p-5"><p role="status" className="text-sm text-muted-foreground">{t('unavailable')}</p></Card>;
 const presentation=view.presentation,headingId='assistant-job-'+view.viewId;
 const display=(fact:JobFact)=>{
  if(fact.value===null)return t('unknown');
  if(fact.format==='boolean'&&typeof fact.value==='boolean')return t(fact.value?'yes':'no');
  if(fact.format==='module'&&typeof fact.value==='string'&&MODULE_JOBS.some(([module])=>module===fact.value))return t(`module_${fact.value}`);
  if(fact.format==='blocks'&&typeof fact.value==='string')return t(`blocks_${fact.value}`);
  if(presentation.module==='rewards'&&fact.field==='status'&&typeof fact.value==='string'&&['draft','bg','gr','ctro','ec','approved','posted','rejected','withdrawn'].includes(fact.value))return rewardStage(fact.value);
  if(presentation.module==='rewards'&&fact.field==='rewardKind'&&typeof fact.value==='string'&&['annual','adhoc','midyear'].includes(fact.value))return rewardKind(fact.value);
  if(fact.format==='status'&&typeof fact.value==='string'&&knownStates.has(fact.value))return t(`state_${fact.value}`);
  if(fact.format==='date'&&typeof fact.value==='string'){
   const date=new Date(fact.value.length===10?fact.value+'T00:00:00Z':fact.value);
   if(Number.isFinite(date.getTime()))return new Intl.DateTimeFormat(safeLocale,{dateStyle:'medium',timeZone:fact.value.length===10?'UTC':'Asia/Kuala_Lumpur'}).format(date);
  }
  // Monetary decimals are copied verbatim: no currency substitution, arithmetic or display rounding.
  return String(fact.value);
 };
 const heading=(card:JobCard)=>card.title.kind==='text'?card.title.value:card.title.kind==='gap'?gap(card.title.code):card.title.kind==='module'?t(`module_${card.title.module}`):t('record',{n:card.title.number});
 return <section aria-labelledby={headingId} className="space-y-3">
  <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 id={headingId} className="text-lg font-semibold">{view.toolName?answers(`tool_${view.toolName}`):t(`module_${presentation.module}`)}</h2>
   <p className="mt-1 text-xs text-muted-foreground">{t('canonicalNote')}</p></div><form action="/assistant" method="get"><input type="hidden" name="job" value={presentation.module}/><button type="submit" className="min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('refresh')}</button></form></header>
  <p className="text-xs text-muted-foreground">{t('checkedAt',{time:new Intl.DateTimeFormat(safeLocale,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(view.checkedAt))})}</p>
  {presentation.cards.length===0&&<Card className="p-5"><p className="text-sm text-muted-foreground">{t(presentation.hasEmployment===false?'noEmployment':'noData')}</p></Card>}
  <div className="grid gap-3 sm:grid-cols-2">{presentation.cards.map((card,index)=><Card key={index} className="min-w-0 p-4">
   <h3 className="break-words text-sm font-semibold">{heading(card)}</h3>
   {card.title.kind==='module'&&<p className="mt-2 text-xs text-muted-foreground">{t(`help_${card.title.module}`)}</p>}
   {card.facts.length>0&&<dl className="mt-3 space-y-2">{card.facts.map((fact,i)=><div key={i} className="flex items-start justify-between gap-4 text-sm">
    <dt className="min-w-0 text-muted-foreground">{t(`field_${fact.field}`)}</dt><dd className="max-w-[65%] break-words text-right tabular-nums">{display(fact)}</dd>
   </div>)}</dl>}
   {card.withheld&&<p className="mt-3 text-xs text-muted-foreground">{t('withheld')}</p>}
   {card.title.kind==='module'&&<a href={'/assistant?job='+card.title.module} className="mt-3 inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('open')}</a>}
   {card.href&&<a href={card.href} className="mt-3 inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('original')}</a>}
  </Card>)}</div>
  {presentation.truncated&&<p className="text-sm text-muted-foreground">{t('truncated')}</p>}
  {['payroll','typed_pay_components'].includes(presentation.module)&&<p className="text-xs text-muted-foreground">{t('moneyNote')}</p>}
  {presentation.module==='notifications'&&<p className="text-xs text-muted-foreground">{t('notificationNote')}</p>}
 </section>;
}

/** The only answer input is a trusted canonical view; raw model prose has no rendering slot. */
export async function GroundedWorkspaceReply({reply,ctx}:{reply:GroundedWorkspaceAnswer;ctx:SessionContext}){
 const t=await getTranslations('assistant.workspace.answers');
 return <div className="mt-3 space-y-4">
  {reply.mode==='grounded'?<><p className="text-sm text-muted-foreground">{t('grounded')}</p>
   {reply.views.map(view=><CanonicalModuleJob key={view.viewId} view={view} ctx={ctx}/>)}
   {reply.partial&&<p className="text-xs text-muted-foreground">{t('partial')}</p>}</>:
   <p className="text-sm text-muted-foreground">{t(reply.mode==='generic'?'generic':'unavailable')}</p>}
  {reply.fallbackModules.filter(module=>MODULE_JOBS.some(([code])=>code===module)).map(module=><a key={module} href={'/assistant?job='+encodeURIComponent(module)}
   className="mr-3 inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('openTask')}</a>)}
 </div>;
}

/** The GET chooser stays read-only. Only an explicit human POST can consume a governed job permit. */
export async function GovernedModuleJobComposer({modules}:{modules:readonly AgentModuleCode[]}){
 const t=await getTranslations('assistant.workspace.governed'),jobs=await getTranslations('assistant.workspace.jobs');
 return <Card className="p-5"><h2 className="text-base font-semibold">{t('title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('intro')}</p>
  <form action={runGovernedPlanAction} className="mt-4 space-y-3"><input type="hidden" name="commandNonce" value={randomUUID()}/>
   <div className="grid gap-3 sm:grid-cols-2">{[0,1,2,3].map(index=><label key={index} className="text-sm">{t('task',{n:index+1})}
    <select name="module" required={index===0} defaultValue="" className="mt-1 min-h-11 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
     <option value="">{t(index===0?'choose':'optional')}</option>{MODULE_JOBS.filter(([module])=>modules.includes(module)).map(([module])=><option key={module} value={module}>{jobs(`module_${module}`)}</option>)}
    </select></label>)}</div>
   <button type="submit" className="min-h-11 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('run')}</button>
  </form></Card>;
}
export async function GovernedWorkspaceJob({view,ctx}:{view:GovernedWorkspaceJobView;ctx:SessionContext}){
 const t=await getTranslations('assistant.workspace.governed');
 if(view.state!=='ready')return <Card className="p-5"><p role="status" className="text-sm text-muted-foreground">{t('unavailable')}</p></Card>;
 return <section className="space-y-4" aria-label={t('result')}><p className="text-sm text-muted-foreground">{t(view.mode==='promoted'?'promoted':'baseline')}</p>
  {view.changedSinceRun&&<p role="status" className="text-xs text-muted-foreground">{t('changed')}</p>}
  {view.views.map(row=><CanonicalModuleJob key={row.viewId} view={row} ctx={ctx}/>)}
  {view.feedbackOutcome&&<p role="status" className="text-xs text-muted-foreground">{t('signalSaved',{rating:t(`signal_${view.feedbackOutcome}`)})}</p>}
  {!view.changedSinceRun?<form action={saveGovernedJobFeedbackAction} className="space-y-3 rounded-lg border p-4"><input type="hidden" name="jobId" value={view.jobId}/>
   <label className="flex items-start gap-2 text-xs"><input type="checkbox" name="consented" value="yes" required className="mt-0.5"/><span>{t('signalConsent')}</span></label>
   <div className="flex flex-wrap gap-2">{(['helpful','needs_correction','incorrect'] as const).map(outcome=><button key={outcome} type="submit" name="outcome" value={outcome}
    className="min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t(`signal_${outcome}`)}</button>)}</div>
  </form>:<p className="text-xs text-muted-foreground">{t('signalChanged')}</p>}
  <form action={eraseGovernedJobFeedbackAction}><button type="submit" className="min-h-11 text-xs underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('eraseSignals')}</button></form>
 </section>;
}
