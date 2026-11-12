import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {cn} from '@/lib/utils';
import {calendarDaysBetween} from '@/lib/hr-date-calendar';
import {formatPayPeriodMonth,todayInKualaLumpur} from '@/lib/hr-date';
import {PAYROLL_READINESS_HREF} from '@/lib/pre-salary/items';
import {withTodayOrigin} from '@/lib/ai-centre/inbox-origin';
import {ADMIN_ASK_PROMPTS,DECISIONS_SHOWN,NEEDS_SHOWN,TASKS_HREF,needsTag,readinessShares,type NeedsEntry} from '@/lib/today/admin';
import {nextStepsFrom,paydayView} from '@/lib/today/employee';
import {Panel,PanelLink,PanelNote,hrDay} from '../employee/panel';
import {AskChips,type AskChip} from '../employee/ask-chips';
import {stepTitle} from '../employee/panels';
import {moduleState,readAskAllowed,readOwnContext,readOwnPassportCards,readOwnPayHints,readOwnReadiness} from '../employee/reads';
import {readAdminNeeds,readExceptions,readHandled,readManagerQueue,readNeeds,readReadiness} from './reads';
import {DecisionRecommendation,RecommendationNote} from './recommendation';

/** HR administrator and manager Today's panels (owner-approved AdminToday.dc.html and ManagerToday.dc.html). Each is its
 * own async server component, rendered inside its own Suspense and error boundary by ./admin-page.tsx and
 * ./manager-page.tsx, so a slow or failing owner holds back or degrades only its own panel. Each reads through ./reads.ts
 * (or the Employee Today readers, for the viewer's own record) and shows only what its owner returned. Token classes
 * only, so both pages follow the app's theme in light and dark. */

export type RoleContext=Readonly<{session:SessionContext;scopeKey:string;locale:string;today:string;all?:boolean;
 /** The viewer's own employment chosen on Home (`?employmentId=`), for their own record. */employmentId?:string}>;
type T=Awaited<ReturnType<typeof getTranslations>>;
const attempt=async<V,>(read:()=>Promise<V>):Promise<{ok:true;value:V}|{ok:false}>=>{try{return {ok:true,value:await read()};}catch{return {ok:false};}};
const ROW='flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3.5 last:border-b-0 sm:flex-nowrap';
const QUIET_BUTTON='inline-flex min-h-9 items-center justify-center whitespace-nowrap rounded-lg border border-input bg-card px-3.5 text-sm font-semibold text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11';
const PRIMARY_BUTTON='inline-flex min-h-9 items-center justify-center whitespace-nowrap rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11';

// ── Heading lines ──────────────────────────────────────────────────────────────────────────────────────────────
/** "8 things need you · 3 overdue · payroll closes in 14 days", from the same ranked list Needs you draws. */
export async function AdminHeadline(p:RoleContext){
 const [t,needs,readiness]=await Promise.all([getTranslations('today.admin'),attempt(()=>readAdminNeeds(p.session,p.scopeKey,p.today,p.locale)),
  attempt(()=>readReadiness(p.session,p.scopeKey,p.today))]);
 if(!needs.ok)return null;
 const {total,overdue}=needs.value.ranked,cutOff=readiness.ok?readiness.value.nextCutOff:null;
 return <p data-today-needs-count={total} className="m-0 text-[0.9375rem]">
  <b className="font-semibold">{t('headline',{count:total})}</b>
  {[overdue>0?t('headlineOverdue',{count:overdue}):null,cutOff?t('headlineCutOff',{days:calendarDaysBetween(p.today,cutOff)}):null].filter(Boolean)
   .map(part=><span key={part} className="text-muted-foreground"> · {part}</span>)}
 </p>;
}

/** "4 decisions for your team": the decisions /approvals lists, from the same queue read the Decide panel draws. */
export async function ManagerHeadline(p:RoleContext){
 const [t,queue]=await Promise.all([getTranslations('today.manager'),attempt(()=>readManagerQueue(p.session,p.scopeKey))]);
 if(!queue.ok)return null;
 const total=queue.value.approvalTotal;
 return <p data-today-decision-count={total} className="m-0 text-[0.9375rem]"><b className="font-semibold">{t('headline',{count:total})}</b></p>;
}

// ── Needs you (administrator) ──────────────────────────────────────────────────────────────────────────────────
const TAG_TONE={overdue:'bg-destructive/10 text-destructive',blocksPayroll:'bg-destructive/10 text-destructive',
 dueIn:'bg-amber-500/15 text-amber-800 dark:text-amber-300',waiting:'bg-amber-500/15 text-amber-800 dark:text-amber-300',none:'bg-muted text-muted-foreground'} as const;
export async function AdminNeedsPanel(p:RoleContext){
 const [t,tToday,tTask,tLoop,data]=await Promise.all([getTranslations('today.admin'),getTranslations('today'),getTranslations('notifications.task'),
  getTranslations('today.loops'),attempt(()=>readAdminNeeds(p.session,p.scopeKey,p.today,p.locale))]);
 if(!data.ok)return <Panel id="today-needs" title={t('needsTitle')}><PanelNote>{t('unavailable')}</PanelNote></Panel>;
 const {entries,total}=data.value.ranked;
 const shown=p.all?entries:entries.slice(0,NEEDS_SHOWN);
 const text=(entry:NeedsEntry)=>entryText({t,tToday,tTask,tLoop,locale:p.locale,entry});
 return <Panel id="today-needs" title={<>{t('needsTitle')} <span className="font-normal normal-case tracking-normal">· {t('needsOrder')}</span></>}
  action={total>NEEDS_SHOWN?(p.all?<PanelLink href="/">{t('showFewer')}</PanelLink>:<PanelLink href="/?needs=all">{t('seeAll',{count:total})}</PanelLink>):null}>
  {entries.length===0?<p data-today-empty className="m-0 text-sm text-muted-foreground">{t('needsEmpty')}</p>:
  <ol data-today-needs-list className="-mx-5 m-0 list-none border-y border-border p-0">
   {shown.map(entry=>{const tag=needsTag(entry,p.today),words=text(entry);
    return <li key={entry.key} data-today-need={entry.key} data-today-tag={tag.kind} className={ROW}>
     {tag.kind!=='none'&&<span className={cn('whitespace-nowrap rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold',TAG_TONE[tag.kind])}>{tagText(t,tag)}</span>}
     <div className="min-w-0 flex-1 basis-56">
      <p className="m-0 break-words text-sm font-semibold">{words.title}</p>
      {words.detail&&<p className="m-0 mt-0.5 text-[0.8125rem] text-muted-foreground">{words.detail}</p>}
     </div>
     <Link href={entry.href} className={tag.kind==='overdue'?PRIMARY_BUTTON:QUIET_BUTTON}>{words.cta}<span className="sr-only"> · {words.title}</span></Link>
    </li>;})}
  </ol>}
  {data.value.failed&&<PanelNote>{t('needsPartial')}</PanelNote>}
 </Panel>;
}
function tagText(t:T,tag:ReturnType<typeof needsTag>):string{
 return tag.kind==='overdue'?t('tag.overdue',{days:tag.days}):tag.kind==='blocksPayroll'?t('tag.blocksPayroll')
  :tag.kind==='dueIn'?t('tag.dueIn',{days:tag.days}):tag.kind==='waiting'?t('tag.waiting',{days:tag.days}):'';
}
/** An entry's words: its title, one line of detail and its action, each from the catalogue and the entry's own facts. */
export function entryText({t,tToday,tTask,tLoop,locale,entry}:{t:T;tToday:T;tTask:T;tLoop:T;locale:string;entry:NeedsEntry}):{title:string;detail:string|null;cta:string}{
 const s=entry.source,day=(iso:string|null)=>iso?hrDay(locale,iso,'day'):'';
 switch(s.kind){
  case 'statutory':return {title:t('entry.statutory',{count:entry.count}),detail:[t('entry.statutoryDetail',{overdue:s.overdue,soon:s.dueSoon}),entry.due?t('entry.firstDue',{date:day(entry.due)}):null].filter(Boolean).join(' '),cta:t('cta.statutory')};
  case 'exceptions':return {title:t('entry.exceptions',{count:entry.count}),detail:t('entry.exceptionsDetail'),cta:t('cta.exceptions')};
  case 'tasks':{
   const label=tTask.has(s.task as never)?tTask(s.task as never):tToday('tasks.review');
   return {title:t('entry.task',{label,count:entry.count}),detail:[entry.since?t('entry.oldest',{date:day(entry.since)}):null,entry.due?t('entry.beforeCutOff',{date:day(entry.due)}):null].filter(Boolean).join(' · ')||null,
    cta:t('cta.review')};
  }
  case 'prepared':return {title:t(`entry.prepared.${s.prepared}`,{count:entry.count}),detail:t('entry.preparedDetail'),cta:t('cta.open')};
  case 'finding':return {title:tToday(`findings.${s.finding}Title`,{count:entry.count}),detail:tToday(`findings.${s.finding}Source`),cta:tToday(`findings.${s.finding}Cta`)};
  case 'probation':return {title:t('entry.probation',{count:entry.count}),detail:entry.due?t('entry.probationDetail',{date:day(entry.due)}):null,cta:t('cta.open')};
  case 'payrollInputs':return {title:t('entry.payrollInputs',{count:entry.count}),detail:[t('entry.payrollInputsBlockers',{count:s.blockers}),entry.due?t('entry.cutOff',{date:day(entry.due)}):null].filter(Boolean).join(' '),cta:t('cta.open')};
  case 'passports':return {title:t('entry.passports',{count:entry.count}),detail:entry.due?t('entry.passportsDetail',{date:day(entry.due)}):null,cta:t('cta.open')};
  case 'autonomy':{
   const loop=tLoop.has(`names.${s.workerId}` as never)?tLoop(`names.${s.workerId}` as never):t('entry.aLoop');
   return {title:t(`entry.autonomy.${s.card}`,{loop}),detail:t('entry.companies',{count:entry.count}),cta:t('cta.check')};
  }
 }
}

// ── Payroll readiness (administrator) ──────────────────────────────────────────────────────────────────────────
export async function ReadinessPanel(p:RoleContext){
 const [t,data]=await Promise.all([getTranslations('today.admin'),attempt(()=>readReadiness(p.session,p.scopeKey,p.today))]);
 if(!data.ok)return <Panel id="today-readiness" title={t('readinessTitle')}><PanelNote>{t('unavailable')}</PanelNote></Panel>;
 const r=data.value;
 if(r.companies===0)return <Panel id="today-readiness" title={t('readinessTitle')}><p className="m-0 text-sm text-muted-foreground">{t('readinessNone')}</p></Panel>;
 const share=readinessShares(r);
 const heading=r.nextCutOff&&r.nextPeriod?t('readinessNext',{period:formatPayPeriodMonth(r.nextPeriod,p.locale),date:hrDay(p.locale,r.nextCutOff,'long')}):t('readinessTitle');
 return <Panel id="today-readiness" title={t('readinessTitle')} action={<PanelLink href="/payroll">{t('readinessOpen')}</PanelLink>}>
  <h3 data-today-cut-off={r.nextCutOff??undefined} className="m-0 text-base font-semibold">{heading}</h3>
  {r.checking?<>
   <div role="img" aria-label={t('readinessBar',{ready:r.ready,companies:r.companies})} data-today-readiness-bar className="flex h-2.5 overflow-hidden rounded-full bg-muted">
    <span className="bg-emerald-600 dark:bg-emerald-400" style={{width:`${share.ready}%`}}/>
    <span className="bg-amber-500 dark:bg-amber-400" style={{width:`${share.waiting}%`}}/>
   </div>
   <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1 p-0 text-[0.8125rem]">
    {([['ready',r.ready,'bg-emerald-600 dark:bg-emerald-400'],['waiting',r.waiting,'bg-amber-500 dark:bg-amber-400'],['notStarted',r.notStarted,'bg-muted-foreground/40']] as const)
     .map(([key,n,dot])=><li key={key} data-today-readiness={key} className="flex items-center gap-1.5">
      <span aria-hidden className={cn('size-2 rounded-full',dot)}/><b className="font-semibold tabular-nums">{n}</b> <span className="text-muted-foreground">{t(`readiness.${key}`,{count:n})}</span>
     </li>)}
   </ul>
  </>:<p data-today-readiness="off" className="m-0 text-sm text-muted-foreground">{t('readinessOff',{count:r.companies})}</p>}
 </Panel>;
}

// ── AI Centre handled (administrator) ──────────────────────────────────────────────────────────────────────────
export async function HandledPanel(p:RoleContext){
 const [t,tLoop,data]=await Promise.all([getTranslations('today.admin'),getTranslations('today.loops'),attempt(()=>readHandled(p.session,p.scopeKey,p.today))]);
 const cards:{key:string;value:number;label:string;detail?:string}[]=[];
 if(data.ok&&data.value.summary){
  const s=data.value.summary,answered=s.answeredForOthers+s.answeredForYou;
  if(answered>0)cards.push({key:'answered',value:answered,label:t('handled.answered',{count:answered})});
  if(s.leaveChecks>0)cards.push({key:'leaveChecks',value:s.leaveChecks,label:t('handled.leaveChecks',{count:s.leaveChecks})});
  if(s.preparedForYou>0)cards.push({key:'prepared',value:s.preparedForYou,label:t('handled.prepared',{count:s.preparedForYou})});
 }
 if(data.ok&&data.value.loops)for(const loop of data.value.loops){
  const name=tLoop.has(`names.${loop.workerId}` as never)?tLoop(`names.${loop.workerId}` as never):t('entry.aLoop');
  cards.push({key:`loop:${loop.workerId}`,value:loop.opened,label:t('handled.loopFound',{loop:name,count:loop.opened}),detail:t('handled.loopResolved',{count:loop.done})});
 }
 const partial=!data.ok||data.value.summary===null||data.value.loops===null;
 return <Panel id="today-handled" title={t('handledTitle')}>
  {cards.length===0?<p data-today-empty className="m-0 text-sm text-muted-foreground">{t('handledEmpty')}</p>:
  <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-3">
   {cards.map(card=><li key={card.key} data-today-handled={card.key} className="rounded-xl border border-border bg-card p-4">
    <p className="m-0 font-mono text-2xl font-semibold tabular-nums">{card.value}</p>
    <p className="m-0 mt-0.5 text-[0.8125rem] text-muted-foreground">{card.label}</p>
    {card.detail&&<p className="m-0 mt-0.5 text-xs text-muted-foreground">{card.detail}</p>}
   </li>)}
  </ul>}
  <p className="m-0 text-xs text-muted-foreground">{t('handledNote')}</p>
  {partial&&<PanelNote>{t('handledPartial')}</PanelNote>}
 </Panel>;
}

// ── Watching (administrator, side) ─────────────────────────────────────────────────────────────────────────────
export async function WatchingPanel(p:RoleContext){
 const [t,data]=await Promise.all([getTranslations('today.admin'),attempt(()=>readExceptions(p.session,p.scopeKey))]);
 const notBlocking=data.ok?Math.max(0,data.value.total-data.value.blocking):0;
 return <Panel id="today-watching" title={t('watchingTitle')}>
  {!data.ok?<PanelNote>{t('unavailable')}</PanelNote>:notBlocking===0?<p className="m-0 text-sm text-muted-foreground">{t('watchingEmpty')}</p>:
   <p data-today-watch="exceptions" className="m-0 text-[0.8125rem]">{t('watchingExceptions',{count:notBlocking})} <Link href="/control-tower/exceptions" className="font-semibold text-primary hover:underline">{t('cta.exceptions')}</Link></p>}
 </Panel>;
}

// ── Your own record (both) ─────────────────────────────────────────────────────────────────────────────────────
/** The viewer's own steps before payroll and their next payday, as Employee Today reads them for the person's own
 * selected employment. Nothing for a login with no employment of its own. Changes are always sent to HR. */
export async function OwnRecordPanel(p:RoleContext&{title:'own'|'forYou'}){
 const [t,te,tr]=await Promise.all([getTranslations('today.admin'),getTranslations('today.employee'),getTranslations('payrollReadiness')]);
 // The person's own selected employment (`?employmentId=`), proved by the Home identity owner; a foreign or stale
 // choice is refused there and this panel says it could not load, nothing else on the page changes.
 const own=await attempt(()=>readOwnContext(p.session,p.employmentId));
 const title=t(p.title==='own'?'ownTitle':'forYouTitle');
 if(!own.ok)return <Panel id="today-own" title={title}><PanelNote>{t('unavailable')}</PanelNote></Panel>;
 const employmentId=own.value.identity.selectedEmploymentId;
 if(!employmentId){
  // Several own employments and none chosen yet: offer the choice, as Employee Today does. None at all: no panel.
  if(own.value.identity.employmentState!=='choose')return null;
  const tHome=await getTranslations('employeeHome');
  return <Panel id="today-own" title={title}>
   <p className="m-0 text-sm">{tHome('chooseEmployment')}</p>
   <ul data-today-own-choose className="m-0 flex list-none flex-col gap-1 p-0">{own.value.identity.employments.map(row=><li key={row.employmentId}>
    <PanelLink href={`/?${new URLSearchParams({employmentId:row.employmentId})}`}>{[row.company||tHome('companyUnavailable'),row.employeeCode].filter(Boolean).join(' · ')}</PanelLink>
   </li>)}</ul>
  </Panel>;
 }
 const payroll=moduleState(p.session,'payroll',own.value.companyId);
 const [readiness,passports,hints]=await Promise.all([attempt(()=>readOwnReadiness(p.session,employmentId,p.locale,p.today)),
  attempt(()=>readOwnPassportCards(p.session,p.today)),payroll==='on'?attempt(()=>readOwnPayHints(p.session,employmentId)):Promise.resolve(null)]);
 const steps=nextStepsFrom(readiness.ok?readiness.value?.items??[]:[],passports.ok?passports.value:[]);
 const next=paydayView(p.today,hints?.ok?hints.value.nextPayment?.date??null:null,readiness.ok?readiness.value?.period.cutOff??null:null);
 const failed=!readiness.ok||!passports.ok||(hints!==null&&!hints.ok);
 return <Panel id="today-own" title={title}>
  {steps.length===0?<>
   <p data-today-own="clear" className="m-0 text-sm font-semibold">{failed?te('stepsUnavailable'):t('ownClear')}</p>
  </>:<>
   <p data-today-own={steps.length} className="m-0 text-sm font-semibold">{t('ownSteps',{count:steps.length})}</p>
   <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
    {steps.slice(0,3).map(step=>{const words=stepTitle(te,tr,p.locale,step);return <li key={step.key} data-today-step={step.kind}>
     <Link href={step.href} className="text-[0.8125rem] text-primary hover:underline">{words}</Link>
    </li>;})}
   </ul>
   <PanelLink href={PAYROLL_READINESS_HREF}>{te('seeAll')}</PanelLink>
  </>}
  {next&&<p data-today-own-next={next.kind} className="m-0 text-[0.8125rem] text-muted-foreground">{t(next.kind==='payday'?'ownPayday':'ownCutOff',{date:hrDay(p.locale,next.date,'short')})}</p>}
  {failed&&steps.length>0&&<PanelNote>{te('stepsUnavailable')}</PanelNote>}
 </Panel>;
}

// ── Try asking (administrator, side) ───────────────────────────────────────────────────────────────────────────
/** Questions only, handed to AI Centre Ask through lib/today/ask-handoff.ts; offered only to someone it can answer. */
export async function AdminAskPanel(p:RoleContext){
 const [t,tToday,allowed]=await Promise.all([getTranslations('today.admin'),getTranslations('today'),readAskAllowed(p.session)]);
 if(!allowed)return null;
 const chips:AskChip[]=ADMIN_ASK_PROMPTS.map(key=>({text:t(`ask.${key}`),question:t(`ask.${key}`)}));
 return <Panel id="today-ask-prompts" title={t('askTitle')}><AskChips label={tToday('suggestions')} chips={chips}/></Panel>;
}

// ── Decide (manager) ───────────────────────────────────────────────────────────────────────────────────────────
type QueueRow=Readonly<{id:string;kind:string;subjectName:string|null;createdAt:string;linkPath:string}>;
/** The decisions waiting for the manager that /approvals lists, oldest first; its heading and "See all" both count
 * exactly those. Work another page owns (a profile change, a performance or rewards task) follows as its own rows,
 * each with its own link. A leave request shows the leave recommendation inline, under its own Suspense boundary
 * (./recommendation.tsx); the decision itself is made on the request's own page. `highlight`: the leave request whose
 * recommendation the person asked to open (`?recommend=`), shown even when it is past the first rows. */
export async function DecidePanel(p:RoleContext&{highlight?:string}){
 const [t,tToday,tTask,queue]=await Promise.all([getTranslations('today.manager'),getTranslations('today'),getTranslations('notifications.task'),
  attempt(()=>readManagerQueue(p.session,p.scopeKey))]);
 if(!queue.ok)return <Panel id="today-decide" title={t('decideTitle')}><PanelNote>{t('decidePartial')}</PanelNote></Panel>;
 const {decisions,approvalTotal,other}=queue.value;
 const first=decisions.slice(0,DECISIONS_SHOWN),asked=p.highlight?decisions.find(task=>task.id===p.highlight&&task.kind==='leave'):undefined;
 const shown=asked&&!first.includes(asked)?[...first,asked]:first;
 const leaveIds=shown.filter(task=>task.kind==='leave').map(task=>task.id);
 const title=(task:QueueRow)=>{const label=tTask.has(task.kind as never)?tTask(task.kind as never):tToday('tasks.review');return task.subjectName?`${label} · ${task.subjectName}`:label;};
 const row=(task:QueueRow,recommend:boolean)=>{const name=title(task),focused=task.id===p.highlight;
  return <li key={`${task.kind}:${task.id}`} data-today-task={task.kind} data-today-focus={focused||undefined} className={cn(ROW,'items-start',focused&&'bg-primary/5')}>
   <div className="min-w-0 flex-1 basis-56">
    <p className="m-0 break-words text-sm font-semibold">{name}</p>
    <p className="m-0 mt-0.5 text-[0.8125rem] text-muted-foreground">{t('sent',{date:hrDay(p.locale,dayOfInstant(task.createdAt),'day')})}</p>
    {recommend&&task.kind==='leave'&&<DecisionRecommendation session={p.session} leaveRequestId={task.id} leaveIds={leaveIds} checking={t('checking')}/>}
   </div>
   <Link href={withTodayOrigin(task.linkPath)} className={QUIET_BUTTON}>{t('open')}<span className="sr-only"> · {name}</span></Link>
  </li>;};
 return <Panel id="today-decide" title={<>{t('decideTitle')} <span className="font-normal normal-case tracking-normal">· {t('decideOrder')}</span></>}
  action={approvalTotal>first.length?<PanelLink href="/approvals">{t('seeAll',{count:approvalTotal})}</PanelLink>:null}>
  {shown.length===0&&other.length===0?<p data-today-empty className="m-0 text-sm text-muted-foreground">{t('decideEmpty')}</p>:null}
  {shown.length>0&&<ul data-today-decisions className="-mx-5 m-0 list-none border-y border-border p-0">{shown.map(task=>row(task,true))}</ul>}
  {leaveIds.length>0&&<RecommendationNote session={p.session} leaveIds={leaveIds} note={t('recommendationNote')}/>}
  {other.length>0&&<>
   <p className="m-0 mt-1 text-[0.8125rem] font-semibold">{t('otherWork',{count:other.length})}</p>
   <ul data-today-other-work className="-mx-5 m-0 list-none border-y border-border p-0">{other.slice(0,DECISIONS_SHOWN).map(task=>row(task,false))}</ul>
   {other.length>DECISIONS_SHOWN&&<PanelLink href={TASKS_HREF}>{t('seeAllWork',{count:other.length})}</PanelLink>}
  </>}
  {queue.value.failed&&<PanelNote>{t('decidePartial')}</PanelNote>}
 </Panel>;
}
/** The Malaysian calendar day of an owner's instant (the HR date owner's conversion). */
const dayOfInstant=(iso:string)=>todayInKualaLumpur(new Date(iso));

// ── Coming up for your team (manager, side) ────────────────────────────────────────────────────────────────────
export async function TeamComingUpPanel(p:RoleContext){
 const [t,data,own]=await Promise.all([getTranslations('today.manager'),attempt(()=>readNeeds(p.session,p.scopeKey,p.today,p.locale)),
  attempt(()=>readOwnContext(p.session,undefined))]);
 const employmentId=own.ok?own.value.identity.selectedEmploymentId:null;
 const readiness=employmentId&&own.ok&&moduleState(p.session,'payroll',own.value.companyId)==='on'?await attempt(()=>readOwnReadiness(p.session,employmentId,p.locale,p.today)):null;
 const cutOff=readiness?.ok?readiness.value?.period.cutOff??null:null;
 const probation=(data.ok?data.value.loops:[]).flatMap(card=>card.kind==='probation'?[card]:[]).sort((a,b)=>a.endDate.localeCompare(b.endDate));
 const prepared=data.ok?data.value.prepared.length:0;
 const lines:{key:string;text:string;href?:string}[]=[
  ...probation.map(card=>({key:`probation:${card.caseId}`,href:card.href,text:card.name?t('probation',{name:card.name,date:hrDay(p.locale,card.endDate,'day')}):t('probationUnnamed',{date:hrDay(p.locale,card.endDate,'day')})})),
  ...(cutOff&&cutOff>=p.today?[{key:'cutoff',text:t('cutOff',{date:hrDay(p.locale,cutOff,'day')})}]:[]),
  ...(prepared>0?[{key:'prepared',text:t('preparedNote',{count:prepared}),href:'/assistant/approvals'}]:[]),
 ];
 return <Panel id="today-team-coming-up" title={t('comingUpTitle')}>
  {lines.length===0?<p className="m-0 text-sm text-muted-foreground">{t('comingUpEmpty')}</p>:
  <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-[0.8125rem]">
   {lines.map(line=><li key={line.key} data-today-team-line={line.key.split(':')[0]}>{line.href?<Link href={line.href} className="hover:underline">{line.text}</Link>:line.text}</li>)}
  </ul>}
  {(!data.ok||(data.ok&&data.value.failed))&&<PanelNote>{t('comingUpPartial')}</PanelNote>}
 </Panel>;
}

