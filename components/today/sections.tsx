import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {CalendarCheck,ClipboardCheck,FileCheck2,ListChecks,Wand2} from 'lucide-react';
import type {SessionContext} from '@/db/client';
import type {PendingTaskItem} from '@/core/approvals-inbox';
import {ProposalCard} from '@/components/ai-centre/proposal-card';
import {LeaveRecommendationLink,RecommendationPanel} from '@/components/ai-centre/leave-recommendation';
import {FocusOnMount} from '@/components/ai-centre/focus-on-mount';
import {readLeaveRecommendation} from '@/app/assistant/centre/recommendation';
import {TODAY_HREF,withTodayOrigin} from '@/lib/ai-centre/inbox-origin';
import {LEAVE_APPLY_TITLE_DATE,leaveApplyCardTitle} from '@/lib/ai-centre/leave-apply-title';
import {HR_LOCAL_TZ,formatPayPeriodMonth} from '@/lib/hr-date';
import {formatDays} from '@/lib/day-format';
import type {TodayAudience} from '@/lib/today/audience';
import {TodayNote,TodaySection} from './today-ui';
import {readAtAGlance,readDoneForYou,readNeedsYou,readWatching,type Finding,type PreparedItem} from './reads';
import {WhyLink} from '@/components/why/why-panel';
import {LeaveBalanceWhy} from '@/components/why/sections';
import {LoopCards} from './loop-cards';

/** Today (AI v2 Phase 1, W3): the four sections. Each is its own async server component, rendered by
 * components/today/today-page.tsx inside its own Suspense boundary, so the slowest owner holds back only its
 * own section. Each reads through components/today/reads.ts as the viewer and shows only what that read
 * returned: no placeholder figure, no invented card, an empty state when there is nothing. */

/** Cards shown before "See all", which lists every one here (`/?needs=all`; the AI Centre Inbox that listed them
 * is retired, AI v2 Phase 1). */
export const TASK_LIMIT=5;
export const NEEDS_ALL_HREF=`${TODAY_HREF}?needs=all`;

type Common=Readonly<{session:SessionContext;scopeIds:readonly string[];audience:TodayAudience;today:string;locale:string}>;

const instant=(locale:string)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone:HR_LOCAL_TZ});
const instantWithTime=(locale:string)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:HR_LOCAL_TZ});
/** An HR calendar date (yyyy-mm-dd) is a day, not an instant: format it as UTC so no offset moves it. */
const hrDay=(locale:string,iso:string,style:'short'|'medium'='medium')=>new Intl.DateTimeFormat(locale,
 style==='short'?{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'}:{dateStyle:'medium',timeZone:'UTC'}).format(new Date(`${iso}T00:00:00Z`));

/** The approved employee mock-up names the first section "Ready for you to confirm"; administrators and managers,
 * whose list is mostly decisions on other people's requests, keep "Needs you". */
export const needsYouHeading=(audience:TodayAudience)=>audience.layout==='personal'&&!audience.manager?'readyToConfirm' as const:'needsYou' as const;

/** `all`: every waiting decision, not only the first TASK_LIMIT ("See all"). `recommend`: the leave request whose
 * approver recommendation the person asked to open (LeaveRecommendationLink); read only when the recommender may
 * run and the id is a leave request in this viewer's own queue, exactly as the AI Centre Inbox did. */
export async function NeedsYouSection(p:Common&Readonly<{all?:boolean;recommend?:string}>){
 const [t,tTask,tCard,data]=await Promise.all([getTranslations('today'),getTranslations('notifications.task'),getTranslations('aiCentre.conversation'),
  readNeedsYou(p.session,{scopeIds:p.scopeIds,audience:p.audience,today:p.today,locale:p.locale})]);
 const cardDate=new Intl.DateTimeFormat(p.locale,LEAVE_APPLY_TITLE_DATE);
 /** Issue 16: a prepared card names its leave the way the chat card does (lib/ai-centre/leave-apply-title.ts:
  * "Annual Leave, Thu, Nov 5 (1 day)"), from the facts its owner returned; the formatter is used for that leave
  * phrase for all three kinds, and the kind itself is the card's first line. No facts: the generic title. */
 const leavePhrase=(item:PreparedItem)=>item.leave?leaveApplyCardTitle({what:{action:'leave.apply',selectors:item.leave.durationType?{durationType:item.leave.durationType}:{}},
  facts:{leaveType:item.leave.leaveType,startDate:item.leave.startDate,endDate:item.leave.endDate,days:item.leave.days}},(key,values)=>tCard(key,values),date=>cardDate.format(date)):null;
 const asked=p.recommend&&data.recommender?data.tasks.findIndex(task=>task.kind==='leave'&&task.id===p.recommend):-1;
 const opened=asked>=0?{id:data.tasks[asked].id,view:await readLeaveRecommendation(p.session,data.tasks[asked].id)}:null;
 const shown=p.all||asked>=TASK_LIMIT?data.tasks:data.tasks.slice(0,TASK_LIMIT),f=instant(p.locale),fTime=instantWithTime(p.locale);
 const taskTitle=(task:PendingTaskItem)=>{
  const label=tTask.has(task.kind)?tTask(task.kind):t('tasks.review');
  return task.subjectName?`${label} · ${task.subjectName}`:label;
 };
 const preparedCard=(item:PreparedItem)=>{const named=leavePhrase(item);return <li key={`${item.kind}:${item.actionId}`} data-today-prepared={item.kind}>
  <ProposalCard tone="prepared" icon={<FileCheck2/>} title={named??t(`prepared.${item.kind}`)} awaitingLabel={t('prepared.awaiting')}
   meta={[...(named?[t(`prepared.${item.kind}`)]:[]),t('prepared.meta',{date:fTime.format(new Date(item.createdAt))}),t('prepared.note')]}
   href={item.href} cta={t('prepared.cta')} expires={t('prepared.expires',{date:fTime.format(new Date(item.expiresAt))})}/>
 </li>;};
 const findingCard=(finding:Finding)=><li key={finding.key} data-today-finding={finding.key}>
  <ProposalCard tone="finding" icon={finding.key==='proposals'?<Wand2/>:<ClipboardCheck/>} title={t(`findings.${finding.key}Title`,{count:finding.count})}
   meta={[t(`findings.${finding.key}Source`)]} href={finding.href} cta={t(`findings.${finding.key}Cta`)}/>
 </li>;
 const count=data.tasks.length+data.prepared.length+data.findings.length+data.loops.length;
 return <TodaySection id="today-needs-you" title={t(needsYouHeading(p.audience))} count={count} empty={count===0} emptyText={t('needsYouEmpty')}
  unavailable={data.failed?t('unavailable'):null}
  footer={data.tasks.length>shown.length?<Link href={NEEDS_ALL_HREF} className="inline-flex min-h-9 items-center text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11">
   {t('tasks.seeAll',{count:data.tasks.length})}</Link>:null}>
  {data.prepared.map(preparedCard)}
  {/* AI v2 W8: what the loops prepared for this person, before the decisions waiting on them. */}
  <LoopCards cards={data.loops} locale={p.locale}/>
  {shown.map(task=><li key={`${task.kind}:${task.id}`} data-today-task={task.kind}>
   <ProposalCard tone="decide" icon={task.kind==='noticeAcknowledgement'?<ListChecks/>:<CalendarCheck/>} title={taskTitle(task)} awaitingLabel={t('prepared.awaiting')}
    meta={[t('tasks.from'),t('tasks.received',{date:f.format(new Date(task.createdAt))})]} href={withTodayOrigin(task.linkPath)} cta={t('tasks.open')}/>
   {task.kind==='leave'&&(opened?.id===task.id
    ?<><RecommendationPanel id={`recommendation-${task.id}`} view={opened.view}/><FocusOnMount targetId={`recommendation-${task.id}`}/></>
    :data.recommender?<LeaveRecommendationLink leaveRequestId={task.id}/>:null)}
  </li>)}
  {data.findings.map(findingCard)}
 </TodaySection>;
}

export async function DoneForYouSection(p:Common){
 const [t,result]=await Promise.all([getTranslations('today'),readDoneForYou(p.session,{scopeIds:p.scopeIds,today:p.today})]);
 const summary=result.ok?result.value:null;
 const notes:{kind:string;label:string;title:string;body:string}[]=[];
 // Other people's questions are visible only to a group administrator (RLS); a figure that is zero is no card.
 if(summary&&summary.answeredForOthers>0)notes.push({kind:'answeredOthers',label:t('done.answeredLabel'),title:t('done.answeredOthersTitle',{count:summary.answeredForOthers}),body:t('done.answeredOthersBody')});
 if(summary&&summary.answeredForYou>0)notes.push({kind:'answeredYou',label:t('done.answeredLabel'),title:t('done.answeredYouTitle',{count:summary.answeredForYou}),body:t('done.answeredYouBody')});
 if(summary&&summary.leaveChecks>0)notes.push({kind:'leaveChecks',label:t('done.checkedLabel'),title:t('done.leaveChecksTitle',{count:summary.leaveChecks}),body:t('done.leaveChecksBody')});
 if(summary&&summary.preparedForYou>0)notes.push({kind:'prepared',label:t('done.preparedLabel'),title:t('done.preparedTitle',{count:summary.preparedForYou}),body:t('done.preparedBody')});
 return <TodaySection id="today-done-for-you" title={t('doneForYou')} empty={notes.length===0} emptyText={t('doneForYouEmpty')}
  unavailable={result.ok?null:t('unavailable')}>
  {notes.map(note=><TodayNote key={note.kind} {...note}/>)}
 </TodaySection>;
}

export async function WatchingSection(p:Common){
 const [t,data]=await Promise.all([getTranslations('today'),readWatching(p.session,{scopeIds:p.scopeIds,today:p.today})]);
 const notes:{kind:string;label:string;title:string;body:string;href:string;cta:string}[]=[];
 if(data.deadlines){
  const d=data.deadlines;
  notes.push({kind:'deadlines',label:t('watch.deadlineLabel'),title:t('watch.deadlineTitle',{count:d.overdue+d.dueSoon}),
   body:[d.overdue>0?t('watch.deadlineOverdue',{count:d.overdue}):null,t('watch.deadlineBody'),
    d.checked<d.inScope?t('watch.deadlinePartial',{n:d.checked,total:d.inScope}):null].filter(Boolean).join(' '),
   href:'/payroll/statutory-forms',cta:t('watch.deadlineCta')});
 }
 if(data.exceptions)notes.push({kind:'exceptions',label:t('watch.exceptionsLabel'),title:t('watch.exceptionsTitle',{count:data.exceptions.total}),
  body:t('watch.exceptionsBlocking',{count:data.exceptions.blocking}),href:'/control-tower/exceptions',cta:t('watch.exceptionsCta')});
 if(data.passports)notes.push({kind:'passports',label:t('watch.expiryLabel'),title:t('watch.passportTitle',{count:data.passports.count}),
  body:t('watch.passportBody',{date:hrDay(p.locale,data.passports.first)}),href:'/personnel',cta:t('watch.passportCta')});
 return <TodaySection id="today-watching" title={t('watching')} count={notes.length} empty={notes.length===0} emptyText={t('watchingEmpty')}
  unavailable={data.failed?t('unavailable'):null}>
  {notes.map(note=><TodayNote key={note.kind} {...note}/>)}
 </TodaySection>;
}

const rowCls='flex min-h-11 items-center justify-between gap-3 py-2 text-sm';
const linkCls='inline-flex min-h-9 items-center font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11';

/** The personal "Watching": the At a glance panel of the employee mock-up. */
export async function AtAGlanceSection(p:Common&Readonly<{employmentId?:string;why?:string}>){
 const [t,data]=await Promise.all([getTranslations('today'),readAtAGlance(p.session,{employmentId:p.employmentId,locale:p.locale,today:p.today})]);
 const balances=(data.balances??[]).slice(0,4);
 // AI v2 W5: each balance's "Why?" opens its explanation in place under the row (`?why=leave:<leave type id>`), read
 // from the same leave dashboard card the figure came from, only when asked for.
 const home=(why?:string)=>{const query=new URLSearchParams({...(p.employmentId?{employmentId:p.employmentId}:{}),...(why?{why}:{})});return query.size?`/?${query}`:'/';};
 const openLeave=p.why?.startsWith('leave:')?p.why.slice('leave:'.length):null;
 const empty=balances.length===0&&data.payslip===undefined&&data.away===null;
 return <section aria-labelledby="today-at-a-glance" data-today-section="today-at-a-glance" className="min-w-0 space-y-3">
  <h2 id="today-at-a-glance" className="text-[0.9375rem] font-semibold">{t('atAGlance')}</h2>
  {data.failed&&<p role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm text-muted-foreground">{t('unavailable')}</p>}
  {empty?<p data-today-empty className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">{t('atAGlanceEmpty')}</p>:
  <div className="space-y-4 rounded-xl border border-border bg-card p-4">
   {(balances.length>0||data.payslip!==undefined)&&<dl data-today-glance="figures" className="divide-y divide-border">
    {balances.map(row=><div key={row.id} data-today-balance className={`${rowCls} flex-wrap`}>
     <dt className="min-w-0 break-words">{row.name}</dt>
     <dd className="flex shrink-0 items-center gap-3">
      <b className="font-semibold tabular-nums">{row.available===null?t('glance.notShown'):t('glance.daysValue',{days:formatDays(row.available)})}</b>
      <WhyLink href={openLeave===row.id?home():home(`leave:${row.id}`)} text={t('glance.why')} label={t('glance.whyLabel',{leaveType:row.name})}
       expanded={openLeave===row.id} controls={`today-why-${row.id}`}/>
     </dd>
     {openLeave===row.id&&<dd data-today-why className="basis-full">
      <LeaveBalanceWhy session={p.session} id={`today-why-${row.id}`} closeHref={home()} leaveTypeId={row.id} employmentId={p.employmentId}/>
     </dd>}
    </div>)}
    {data.payslip&&<div data-today-payslip className={rowCls}>
     <dt>{t('glance.payslipTitle',{date:formatPayPeriodMonth(data.payslip.period,p.locale)})}</dt>
     <dd><Link href={`/me/payslip?${new URLSearchParams({year:data.payslip.period.slice(0,4),month:data.payslip.period.slice(5,7),payslipId:data.payslip.id})}`} className={linkCls}>{t('glance.openPayslip')}</Link></dd>
    </div>}
    {data.payslip===null&&<div data-today-payslip="none" className={rowCls}><dt className="text-muted-foreground">{t('glance.noPayslip')}</dt><dd/></div>}
   </dl>}
   {data.away!==null&&<div data-today-glance="coming-up" className="space-y-1.5 border-t border-border pt-3 first:border-t-0 first:pt-0">
    <h3 className="text-sm font-semibold">{t('glance.comingUp')}</h3>
    {data.away.length===0?<p className="text-sm text-muted-foreground">{t('glance.nothingComingUp')}</p>:
     <ul className="space-y-1 text-sm text-muted-foreground">{data.away.map(run=><li key={`${run.employmentId}:${run.from}`} data-today-away>
      {run.name===null?(run.from===run.to?t('glance.managerAwayDayUnnamed',{date:hrDay(p.locale,run.from,'short')})
        :t('glance.managerAwayRangeUnnamed',{start:hrDay(p.locale,run.from,'short'),end:hrDay(p.locale,run.to,'short')}))
       :run.from===run.to?t('glance.managerAwayDay',{name:run.name,date:hrDay(p.locale,run.from,'short')})
       :t('glance.managerAwayRange',{name:run.name,start:hrDay(p.locale,run.from,'short'),end:hrDay(p.locale,run.to,'short')})}
     </li>)}</ul>}
   </div>}
  </div>}
 </section>;
}
