import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Check} from 'lucide-react';
import type {SessionContext} from '@/db/client';
import {cn} from '@/lib/utils';
import {formatDays} from '@/lib/day-format';
import {formatPayPeriodMonth} from '@/lib/hr-date';
import {calendarDaysBetween} from '@/lib/hr-date-calendar';
import {PAYROLL_READINESS_HREF} from '@/lib/pre-salary/items';
import {buildMonthCalendar,CALENDAR_MARKS,type CalendarFact,type CalendarMark} from '@/lib/today/month-calendar';
import {comingUp,isAllClear,nextStepsFrom,orderRequests,paydayView,trackSteps,waitingDays,weekHours,weekOf,
 type ModuleState,type NextStep,type TrackedRequest} from '@/lib/today/employee';
import {AskChips,type AskChip} from './ask-chips';
import {BUTTON,EYEBROW,LINK,Panel,PanelLink,PanelNote,hrDay} from './panel';
import {readAskAllowed,readManagersAway,readOwnCalendar,readOwnPassportCards,readOwnNotices,readOwnPayHints,readOwnReadiness,readOwnRequests,readOwnTimeOff,readOwnWeek,readWaitingForYou} from './reads';

/** Employee Today's panels (owner-approved EmployeeLight.dc.html / EmployeeDashboard.dc.html and AllClear.dc.html).
 * Each is its own async server component, rendered inside its own Suspense and error boundary by today-page.tsx, so a
 * slow or failing owner holds back or degrades only its own panel. Each reads through ./reads.ts as the person, for the
 * employment readOwnContext proved, and shows only what its owner returned. */

export type PanelContext=Readonly<{session:SessionContext;employmentId:string;locale:string;today:string;
 modules:Readonly<{payroll:ModuleState;leave:ModuleState;attendance:ModuleState;claims:ModuleState}>}>;
type T=Awaited<ReturnType<typeof getTranslations>>;
const attempt=async<V,>(read:()=>Promise<V>):Promise<{ok:true;value:V}|{ok:false}>=>{try{return {ok:true,value:await read()};}catch{return {ok:false};}};

// ── Next step and Then (and the all-clear state) ───────────────────────────────────────────────────────────────
/** Kinds whose wording on Today is Today's own (what the person SENDS); every other kind keeps the checklist's words. */
const OWN_WORDING:ReadonlySet<string>=new Set(['bank_missing','tax_number_missing','epf_number_missing','socso_number_missing','identity_missing','tp1_draft',
 'passport_renew','missed_clock_out','missed_clock_in','absent_no_leave']);
const FALLBACK:Readonly<Partial<Record<string,'leave'|'claim'>>>={leave_certificate_missing:'leave',claim_deadline:'claim',claim_receipt_missing:'claim',claim_draft:'claim'};
export function stepTitle(t:T,tr:T,locale:string,step:NextStep):string{
 if(OWN_WORDING.has(step.kind)){const day=step.kind==='passport_renew'?step.due:step.date??step.due;return t(`steps.${step.kind}`,{date:day?hrDay(locale,day,'long'):''});}
 const fallback=FALLBACK[step.kind],label=step.label?.trim()||(fallback?tr(`fallback.${fallback}`):'');
 const what=tr(`kinds.${step.kind}`,{label,name:label});
 if(!step.date)return what;
 return `${what} · ${step.endDate&&step.endDate!==step.date?tr('range',{from:hrDay(locale,step.date,'day'),to:hrDay(locale,step.endDate,'day')}):hrDay(locale,step.date,'day')}`;
}
const cta=(t:T,step:NextStep)=>t(step.decider==='hr'?'sendToHr':step.decider==='manager'?'sendRequest':'open');
const decider=(t:T,step:NextStep)=>step.decider==='hr'?t('deciderHr'):step.decider==='manager'?t('deciderManager'):null;
const dueLine=(t:T,locale:string,step:NextStep)=>step.due?t('dueOn',{date:hrDay(locale,step.due,'long')}):t('noDue');

export async function NextStepPanel(p:PanelContext){
 const [t,tr,readiness,passports]=await Promise.all([getTranslations('today.employee'),getTranslations('payrollReadiness'),
  attempt(()=>readOwnReadiness(p.session,p.employmentId,p.locale,p.today)),attempt(()=>readOwnPassportCards(p.session,p.today))]);
 const items=readiness.ok?readiness.value?.items??[]:[];
 const steps=nextStepsFrom(items,passports.ok?passports.value:[]);
 const failed=!readiness.ok||!passports.ok||(readiness.ok&&!!readiness.value?.failed);
 const cutOff=readiness.ok?readiness.value?.period.cutOff??null:null;
 if(isAllClear({steps,failed}))return <AllClearPanel {...p} t={t} cutOff={cutOff}/>;
 const [first,...rest]=steps;
 const later=rest.slice(0,3);
 return <Panel id="today-next-step" tone="lead" className="lg:col-span-5 lg:row-span-2" title={first?t('nextStepOf',{n:1,total:steps.length}):t('nextStep')}>
  {first?<>
   <div className="flex items-start justify-between gap-4">
    <h3 data-today-step={first.kind} className="m-0 text-xl font-semibold leading-snug tracking-tight text-balance">{stepTitle(t,tr,p.locale,first)}</h3>
    {first.due&&<DueBadge t={t} today={p.today} due={first.due}/>}
   </div>
   <p className="m-0 text-sm leading-relaxed text-muted-foreground">
    {[cutOff&&first.due===cutOff?t('payrollCloses',{date:hrDay(p.locale,cutOff,'long')}):null,decider(t,first)].filter(Boolean).join(' ')}
   </p>
   <div className="flex flex-wrap gap-2.5">
    <Link href={first.href} data-today-step-cta={first.decider} className={cn(BUTTON,'bg-primary text-primary-foreground hover:bg-primary/90')}>
     {cta(t,first)}<span className="sr-only"> · {stepTitle(t,tr,p.locale,first)}</span></Link>
    <Link href={PAYROLL_READINESS_HREF} className={cn(BUTTON,'border border-input bg-card text-foreground hover:bg-muted')}>{t('seeAll')}</Link>
   </div>
   <p className="m-0 text-xs text-muted-foreground">{dueLine(t,p.locale,first)}</p>
  </>:<p className="m-0 text-sm text-muted-foreground">{t('nothingToDo')}</p>}
  {later.length>0&&<div className="flex flex-col gap-2.5 border-t border-border pt-3">
   <p className={EYEBROW}>{t('then')}</p>
   <ol className="m-0 flex list-none flex-col gap-3 p-0">
    {later.map((step,index)=>{const title=stepTitle(t,tr,p.locale,step);return <li key={step.key} data-today-step={step.kind} className="flex items-center gap-3">
     <span aria-hidden className="flex size-7 flex-none items-center justify-center rounded-lg bg-muted font-mono text-xs tabular-nums">{index+2}</span>
     <div className="min-w-0 flex-1">
      <p className="m-0 break-words text-sm font-semibold">{title}</p>
      <p className="m-0 mt-0.5 text-xs text-muted-foreground">{[dueLine(t,p.locale,step),step.decider==='hr'?t('decidedByHr'):step.decider==='manager'?t('decidedByManager'):null].filter(Boolean).join(' · ')}</p>
     </div>
     <Link href={step.href} className={cn(LINK,'whitespace-nowrap')}>{cta(t,step)}<span className="sr-only"> · {title}</span></Link>
    </li>;})}
   </ol>
  </div>}
  {failed&&<PanelNote>{t('stepsUnavailable')}</PanelNote>}
 </Panel>;
}

/** Days until a step is due, in a quiet disc (the mock-up's ring), with its words for a screen reader. */
function DueBadge({t,today,due}:{t:T;today:string;due:string}){
 const days=calendarDaysBetween(today,due);
 return <div role="img" aria-label={days<0?t('overdue'):t('dueIn',{days})} data-today-due={due} className="flex size-16 flex-none flex-col items-center justify-center rounded-full border-4 border-primary/30 bg-card">
  <span aria-hidden className="font-mono text-lg font-semibold leading-none tabular-nums">{Math.max(0,days)}</span>
  <span aria-hidden className="text-[0.625rem] text-muted-foreground">{days<0?t('overdueShort'):t('daysUnit',{days})}</span>
 </div>;
}

/** AllClear.dc.html: nothing needs the person, and when payroll is in use, what comes next. */
async function AllClearPanel(p:PanelContext&{t:T;cutOff:string|null}){
 const hints=p.modules.payroll==='on'?await attempt(()=>readOwnPayHints(p.session,p.employmentId)):null;
 const next=paydayView(p.today,hints?.ok?hints.value.nextPayment?.date??null:null,p.cutOff);
 return <section aria-labelledby="today-all-clear" data-today-panel="today-all-clear" data-today-all-clear
  className="flex min-w-0 items-start gap-4 rounded-2xl border border-emerald-600/25 bg-emerald-500/5 p-6 lg:col-span-5 lg:row-span-2">
  <span aria-hidden className="flex size-11 flex-none items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"><Check className="size-5"/></span>
  <div className="flex min-w-0 flex-col gap-1.5">
   <h2 id="today-all-clear" className="m-0 text-xl font-semibold">{p.t('allClearTitle')}</h2>
   <p className="m-0 text-[0.9375rem] leading-relaxed">{[p.t('allClearBody'),p.cutOff?p.t('allClearRecord',{date:hrDay(p.locale,p.cutOff,'day')}):null].filter(Boolean).join(' ')}</p>
   {next&&<p className="m-0 mt-1 text-sm text-muted-foreground">{p.t(next.kind==='payday'?'allClearPayday':'allClearCutOff',{date:hrDay(p.locale,next.date,'short')})}</p>}
  </div>
 </section>;
}

// ── Payday ─────────────────────────────────────────────────────────────────────────────────────────────────────
export async function PaydayPanel(p:PanelContext){
 const [t,hints,readiness]=await Promise.all([getTranslations('today.employee'),attempt(()=>readOwnPayHints(p.session,p.employmentId)),
  attempt(()=>readOwnReadiness(p.session,p.employmentId,p.locale,p.today))]);
 const view=paydayView(p.today,hints.ok?hints.value.nextPayment?.date??null:null,readiness.ok?readiness.value?.period.cutOff??null:null);
 const latest=hints.ok?hints.value.payslips[0]:undefined;
 return <Panel id="today-payday" className="lg:col-span-3" title={t(view?.kind==='cutoff'?'cutOffTitle':'paydayTitle')}>
  {view?<div data-today-payday={view.kind} data-today-date={view.date} className="flex flex-col gap-2">
   <div className="flex items-baseline gap-2">
    <span className="font-mono text-5xl font-semibold leading-none tracking-tight tabular-nums">{view.daysAway}</span>
    <span className="text-sm text-muted-foreground">{t('daysToGo',{days:view.daysAway})}</span>
   </div>
   <p className="m-0 text-sm">{hrDay(p.locale,view.date,'long')}</p>
   {view.kind==='cutoff'&&<p className="m-0 text-xs leading-relaxed text-muted-foreground">{t('cutOffNote')}</p>}
  </div>:<p className="m-0 text-sm text-muted-foreground">{hints.ok&&readiness.ok?t('noPayday'):t('unavailable')}</p>}
  {hints.ok&&<p className="m-0 mt-auto text-xs text-muted-foreground">{latest
   ?<>{t('lastPayslip',{month:formatPayPeriodMonth(latest.period,p.locale)})} · <Link className="font-semibold text-primary hover:underline"
     href={`/me/payslip?${new URLSearchParams({year:latest.period.slice(0,4),month:latest.period.slice(5,7),payslipId:latest.id})}`}>{t('open')}</Link></>
   :t('noPayslip')}</p>}
 </Panel>;
}

// ── Leave rings ────────────────────────────────────────────────────────────────────────────────────────────────
const RING_TONES=['text-emerald-600 dark:text-emerald-400','text-sky-600 dark:text-sky-400','text-violet-600 dark:text-violet-400'];
const RING_LIMIT=3;
export async function LeavePanel(p:PanelContext){
 const [t,timeOff]=await Promise.all([getTranslations('today.employee'),attempt(()=>readOwnTimeOff(p.session,p.employmentId,p.locale))]);
 const balances=timeOff.ok?[...timeOff.value.balances].sort((a,b)=>Number(b.annualLeave)-Number(a.annualLeave)).slice(0,RING_LIMIT):[];
 return <Panel id="today-leave" className="lg:col-span-4" title={t('leaveTitle')}
  action={timeOff.ok&&timeOff.value.canApply?<PanelLink href="/leave">{t('applyLeave')}</PanelLink>:<PanelLink href="/leave">{t('seeLeave')}</PanelLink>}>
  {!timeOff.ok?<PanelNote>{t('unavailable')}</PanelNote>:balances.length===0?<p className="m-0 text-sm text-muted-foreground">{t('noLeave')}</p>:
  <ul className="m-0 grid list-none grid-cols-3 gap-2 p-0">
   {balances.map((row,index)=>{
    const label=row.available===null?t('ringHidden',{name:row.name}):t('ringLeft',{name:row.name,days:formatDays(row.available)});
    return <li key={row.id} data-today-ring={row.id} className="flex min-w-0 flex-col items-center gap-1.5">
     {/* The year's total is not part of the Home leave projection yet, so the ring is drawn whole in the type's colour
         when there is time left and empty when there is none: it never claims a share it was not given. */}
     <div role="img" aria-label={label} className={cn('relative size-[4.75rem]',RING_TONES[index%RING_TONES.length])}>
      <svg viewBox="0 0 76 76" className="size-full" aria-hidden>
       <circle cx="38" cy="38" r="31" fill="none" strokeWidth="7" className={row.available!==null&&row.available>0?'stroke-current':'stroke-muted'}/>
      </svg>
      <span aria-hidden className="absolute inset-0 flex items-center justify-center font-mono text-base font-semibold text-foreground tabular-nums">{row.available===null?'—':formatDays(row.available)}</span>
     </div>
     <span aria-hidden className="max-w-full truncate text-center text-xs">{row.name}</span>
    </li>;})}
  </ul>}
 </Panel>;
}

// ── Month calendar ─────────────────────────────────────────────────────────────────────────────────────────────
const MARK_DOT:Readonly<Record<CalendarMark,string>>={payday:'bg-emerald-600 dark:bg-emerald-400',cutoff:'bg-foreground',due:'bg-primary',
 fix:'bg-amber-500 dark:bg-amber-400',leave:'bg-sky-600 dark:bg-sky-400',holiday:'bg-violet-600 dark:bg-violet-400'};
export async function CalendarPanel(p:PanelContext&{wide?:boolean}){
 const month=p.today.slice(0,7);
 const [t,readiness,calendar]=await Promise.all([getTranslations('today.employee'),attempt(()=>readOwnReadiness(p.session,p.employmentId,p.locale,p.today)),
  attempt(()=>readOwnCalendar(p.session,p.employmentId,month))]);
 const facts:CalendarFact[]=[];
 if(readiness.ok&&readiness.value){
  if(readiness.value.period.cutOff)facts.push({date:readiness.value.period.cutOff,mark:'cutoff'});
  for(const step of nextStepsFrom(readiness.value.items)){
   if(step.due)facts.push({date:step.due,mark:'due'});
   if(step.date&&step.decider==='manager')facts.push({date:step.date,mark:'fix'});
  }
 }
 if(calendar.ok)for(const day of calendar.value.days)for(const entry of day.entries)
  facts.push({date:day.date,mark:entry.kind==='payday'?'payday':entry.kind==='leave'?'leave':'holiday'});
 const grid=buildMonthCalendar(p.today,facts);
 const shown=new Set(grid.weeks.flat().flatMap(cell=>cell.marks));
 const weekdays=weekOf(p.today);
 const markLabel=(mark:CalendarMark)=>t(`marks.${mark}`);
 return <Panel id="today-calendar" className={p.wide?'lg:col-span-7':'lg:col-span-4'} title={formatPayPeriodMonth(month,p.locale)}
  action={<span className="text-xs text-muted-foreground">{t('yourMonth')}</span>}>
  <table className="w-full table-fixed border-separate border-spacing-1 text-center" data-today-month={month}>
   <thead><tr>{weekdays.map(date=><th key={date} scope="col" className="pb-0.5 text-[0.625rem] font-semibold text-muted-foreground">
    <abbr title={hrDay(p.locale,date,'weekday')} className="no-underline">{hrDay(p.locale,date,'narrow')}</abbr></th>)}</tr></thead>
   <tbody>{grid.weeks.map((week,i)=><tr key={i}>{week.map((cell,j)=>cell.date===null?<td key={j}/>:
    <td key={cell.date} data-today-day={cell.date} data-today-marks={cell.marks.join(' ')||undefined}
     aria-label={[hrDay(p.locale,cell.date,'long'),...cell.marks.map(markLabel)].join(', ')}
     aria-current={cell.today?'date':undefined}
     className={cn('h-9 rounded-lg align-middle font-mono text-xs tabular-nums',
      cell.today?'bg-primary font-bold text-primary-foreground':cell.marks[0]==='payday'?'bg-emerald-500/15 font-semibold text-emerald-800 dark:text-emerald-300':cell.marks.length?'bg-muted':'',
      !cell.today&&(cell.past?'text-muted-foreground/70':cell.weekend?'text-muted-foreground':''))}>
     <span aria-hidden className="flex flex-col items-center gap-0.5">{cell.day}
      <span className={cn('size-1.5 rounded-full',!cell.today&&cell.marks[0]?MARK_DOT[cell.marks[0]]:'bg-transparent')}/></span>
    </td>)}</tr>)}</tbody>
  </table>
  {shown.size>0&&<ul aria-label={t('legend')} className="m-0 flex list-none flex-wrap gap-x-3.5 gap-y-1.5 p-0 text-[0.6875rem] text-muted-foreground">
   {CALENDAR_MARKS.filter(mark=>shown.has(mark)).map(mark=><li key={mark} className="flex items-center gap-1.5"><span aria-hidden className={cn('size-2 rounded-full',MARK_DOT[mark])}/>{markLabel(mark)}</li>)}
  </ul>}
  {(!readiness.ok||!calendar.ok)&&<PanelNote>{t('calendarPartial')}</PanelNote>}
 </Panel>;
}

// ── This week's hours ──────────────────────────────────────────────────────────────────────────────────────────
const hm=(t:T,minutes:number)=>t('hoursMinutes',{hours:Math.floor(minutes/60),minutes:String(minutes%60).padStart(2,'0')});
export async function HoursPanel(p:PanelContext){
 const [t,rows]=await Promise.all([getTranslations('today.employee'),attempt(()=>readOwnWeek(p.session,p.employmentId,p.today))]);
 if(!rows.ok)return <Panel id="today-hours" className="lg:col-span-3" title={t('hoursTitle')}><PanelNote>{t('unavailable')}</PanelNote></Panel>;
 const week=weekHours(p.today,rows.value);
 const top=Math.max(week.shiftMinutes??0,...week.bars.map(bar=>bar.workedMinutes??0),1);
 const value=(bar:(typeof week.bars)[number])=>bar.state==='worked'&&bar.workedMinutes!==null?hm(t,bar.workedMinutes):bar.state==='running'?t('running'):'—';
 const summary=week.bars.map(bar=>`${hrDay(p.locale,bar.date,'weekday')} ${value(bar)}`).join(', ');
 return <Panel id="today-hours" className="lg:col-span-3" title={t('hoursTitle')} action={<span data-today-hours-total className="font-mono text-xs tabular-nums">{hm(t,week.workedMinutes)}</span>}>
  <div role="img" aria-label={t('hoursChart',{items:summary})} className="relative grid h-28 items-end gap-2" style={{gridTemplateColumns:`repeat(${Math.max(week.bars.length,1)},minmax(0,1fr))`}}>
   {week.shiftMinutes!==null&&<div aria-hidden className="absolute inset-x-0 border-t border-dashed border-border" style={{bottom:`${(week.shiftMinutes/top)*100}%`}}/>}
   {week.bars.map(bar=><div key={bar.date} aria-hidden data-today-bar={bar.state} className="flex h-full items-end justify-center">
    <div className={cn('w-full max-w-7 rounded-t-md rounded-b-sm',bar.state==='worked'?'bg-emerald-600/80 dark:bg-emerald-400/80':bar.state==='running'?'h-1/4 bg-primary/60':'h-1 bg-muted')}
     style={bar.state==='worked'&&bar.workedMinutes?{height:`${Math.max(4,(bar.workedMinutes/top)*100)}%`}:undefined}/>
   </div>)}
  </div>
  <div aria-hidden className="grid gap-2 text-center text-[0.6875rem]" style={{gridTemplateColumns:`repeat(${Math.max(week.bars.length,1)},minmax(0,1fr))`}}>
   {week.bars.map(bar=><div key={bar.date}><p className="m-0 font-semibold">{hrDay(p.locale,bar.date,'weekday')}</p><p className="m-0 mt-0.5 font-mono text-muted-foreground">{value(bar)}</p></div>)}
  </div>
  <p className="m-0 text-xs text-muted-foreground">{[week.shiftMinutes!==null?t('shiftLine',{time:hm(t,week.shiftMinutes)}):null,
   week.bars.some(bar=>bar.state==='running')?t('todayRunning'):null].filter(Boolean).join(' · ')||<PanelLink href="/attendance/my-records">{t('openRecords')}</PanelLink>}</p>
 </Panel>;
}

// ── Request tracker ────────────────────────────────────────────────────────────────────────────────────────────
const STEP_DOT={done:'bg-emerald-600 dark:bg-emerald-400',current:'bg-amber-500 ring-4 ring-amber-500/20',todo:'border-[1.5px] border-muted-foreground/60',declined:'bg-destructive'} as const;
function requestTitle(t:T,row:TrackedRequest){
 return row.kind==='claim'?t('request.claim',{label:row.label}):row.label;
}
function requestDetail(t:T,locale:string,row:TrackedRequest){
 if(row.kind==='leave'&&row.startDate)return row.endDate&&row.endDate!==row.startDate?t('request.dates',{from:hrDay(locale,row.startDate,'short'),to:hrDay(locale,row.endDate,'short')}):hrDay(locale,row.startDate,'short');
 return t('request.sentOn',{date:hrDay(locale,row.sent,'day')});
}
const stepLabel=(t:T,row:TrackedRequest,step:'sent'|'decide'|'outcome')=>step==='sent'?t('request.sent')
 :step==='decide'?t(row.kind==='letter'?'request.withHr':'request.withApprover')
 :row.stage==='declined'?t('request.declined'):t(row.kind==='letter'?'request.ready':row.kind==='claim'?'request.paidWithSalary':'request.approved');
/** The Notice Board (owner decision, 12 Nov 2026): the newest notices sent to the person, unread ones marked in words,
 * each opening its own page, and the full board one click away. */
export async function NoticesPanel(p:PanelContext){
 const [t,board]=await Promise.all([getTranslations('notices'),readOwnNotices(p.session,p.employmentId)]);
 return <Panel id="today-notices" className="lg:col-span-12" title={t('cardTitle')}
  action={board.unread>0?<span data-today-notices-unread={board.unread} className="text-[0.8125rem] font-medium text-primary">{t('cardNewCount',{count:board.unread})}</span>:undefined}>
  {board.items.length===0?<p className="m-0 text-sm text-muted-foreground">{t('cardEmpty')}</p>:
  <ul className="m-0 flex list-none flex-col gap-2 p-0">
   {board.items.map(item=><li key={item.id} data-today-notice={item.id} className="flex items-center justify-between gap-3 text-sm">
    <Link href={`/notices/${item.id}`} className="min-w-0 truncate hover:underline">{item.title}</Link>
    {item.firstViewedAt===null&&<span className="shrink-0 text-[0.8125rem] font-medium text-primary">{t('cardUnreadWord')}</span>}
   </li>)}
  </ul>}
  <PanelLink href="/notices">{t('cardViewAll')}</PanelLink>
 </Panel>;
}
export async function RequestsPanel(p:PanelContext){
 const [t,data]=await Promise.all([getTranslations('today.employee'),attempt(()=>readOwnRequests(p.session,p.employmentId,{leave:p.modules.leave==='on',claims:p.modules.claims==='on'}))]);
 const rows=data.ok?orderRequests(data.value.requests):[];
 // Each kind of request is listed on its own page; "See all" opens them, for the modules in use.
 const lists=[...(p.modules.leave==='on'?[{key:'leave',href:'/leave',label:t('requestsLeave')}]:[]),...(p.modules.claims==='on'?[{key:'claims',href:'/claims',label:t('requestsClaims')}]:[]),
  {key:'letters',href:'/me/letters',label:t('requestsLetters')}];
 return <Panel id="today-requests" className="lg:col-span-8" title={t('requestsTitle')}
  action={<nav aria-label={t('requestsSeeAll')} data-today-requests-all className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
   <span aria-hidden>{t('requestsSeeAll')}</span>{lists.map(list=><Link key={list.key} href={list.href} className={LINK}>{list.label}</Link>)}</nav>}>
  {!data.ok?<PanelNote>{t('unavailable')}</PanelNote>:rows.length===0?<p className="m-0 text-sm text-muted-foreground">{t('noRequests')}</p>:
  <ul className="m-0 flex list-none flex-col gap-3.5 p-0">
   {rows.map(row=>{const title=requestTitle(t,row),steps=trackSteps(row.stage);
    return <li key={row.key} data-today-request={row.kind} data-today-stage={row.stage} className="grid items-center gap-x-4 gap-y-2 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto]">
     <div className="min-w-0"><p className="m-0 break-words text-sm font-semibold">{title}</p><p className="m-0 mt-0.5 text-xs text-muted-foreground">{requestDetail(t,p.locale,row)}</p></div>
     <ol aria-label={t('request.progress',{item:title})} className="m-0 flex min-w-0 list-none flex-wrap items-center gap-2 p-0 text-xs">
      {steps.map((step,index)=><li key={step.step} data-today-track={step.state} className="flex items-center gap-2">
       {index>0&&<span aria-hidden className={cn('h-0.5 w-4 rounded-full sm:w-8',step.state==='todo'?'bg-border':'bg-emerald-600/70 dark:bg-emerald-400/70')}/>}
       <span className={cn('flex items-center gap-1.5 whitespace-nowrap',step.state==='current'&&'font-medium text-amber-800 dark:text-amber-300',step.state==='todo'&&'text-muted-foreground')}>
        <span aria-hidden className={cn('size-2 flex-none rounded-full',STEP_DOT[step.state])}/>{stepLabel(t,row,step.step)}
        <span className="sr-only"> ({t(`request.state.${step.state}`)})</span></span>
      </li>)}
     </ol>
     <p className="m-0 text-xs text-muted-foreground sm:text-right">
      {row.stage==='waiting'?t('request.waiting',{days:waitingDays(p.today,row.sent)}):row.stage==='preparing'?t('request.preparing')
       :<Link href={row.href} className="font-semibold text-primary hover:underline">{t(row.stage==='ready'?'request.openLetter':'open')}<span className="sr-only"> · {title}</span></Link>}
     </p>
    </li>;})}
  </ul>}
  {data.ok&&data.value.failed&&<PanelNote>{t('requestsPartial')}</PanelNote>}
 </Panel>;
}

// ── Coming up, and the Ask chips ───────────────────────────────────────────────────────────────────────────────
/** My Letters with its request form open (app/me/letters/page.tsx `request=1`), as Today's Ask bar offers it. */
const LETTER_REQUEST_FORM='/me/letters?request=1';
export async function ComingUpPanel(p:PanelContext){
 const month=p.today.slice(0,7);
 const [t,tToday,readiness,calendar,away,hints,ask]=await Promise.all([getTranslations('today.employee'),getTranslations('today'),
  attempt(()=>readOwnReadiness(p.session,p.employmentId,p.locale,p.today)),attempt(()=>readOwnCalendar(p.session,p.employmentId,month)),
  attempt(()=>readManagersAway(p.session,p.employmentId,p.today)),
  p.modules.payroll==='on'?attempt(()=>readOwnPayHints(p.session,p.employmentId)):Promise.resolve(null),readAskAllowed(p.session)]);
 const days=calendar.ok?calendar.value.days:[];
 const items=comingUp(p.today,{
  cutOff:readiness.ok?readiness.value?.period.cutOff??null:null,
  payday:hints?.ok?hints.value.nextPayment?.date??null:null,
  leaveDates:days.filter(day=>day.entries.some(entry=>entry.kind==='leave')).map(day=>day.date),
  holidays:days.flatMap(day=>day.entries.flatMap(entry=>entry.kind==='holiday'&&!entry.replacement?[{date:day.date,name:entry.name}]:[])),
  managerAway:away.ok?away.value:[],
 });
 const text=(item:(typeof items)[number])=>item.kind==='cutoff'?t('upcoming.cutoff'):item.kind==='payday'?t('upcoming.payday')
  :item.kind==='leave'?t('upcoming.leave'):item.kind==='managerAway'?(item.name?t('upcoming.managerAway',{name:item.name}):t('upcoming.managerAwayUnnamed'))
  :item.name?t('upcoming.holiday',{name:item.name}):t('upcoming.holidayUnnamed');
 const when=(item:(typeof items)[number])=>item.endDate!==item.date?t('request.dates',{from:hrDay(p.locale,item.date,'day'),to:hrDay(p.locale,item.endDate,'day')}):hrDay(p.locale,item.date,'day');
 const chips:AskChip[]=[
  ...(p.modules.leave==='on'?[ask?{text:tToday('suggestLeave'),question:tToday('suggestLeave')}:{text:tToday('suggestLeave'),href:'/leave'}]:[]),
  ...(p.modules.claims==='on'?[ask?{text:tToday('suggestClaim'),question:tToday('suggestClaim')}:{text:tToday('suggestClaim'),href:'/claims'}]:[]),
  ...(p.modules.payroll==='on'?[ask?{text:tToday('suggestPay'),question:tToday('suggestPay')}:{text:tToday('suggestPay'),href:'/me/payslip'}]:[]),
  {text:tToday('suggestLetter'),href:LETTER_REQUEST_FORM},
 ];
 return <Panel id="today-coming-up" className="lg:col-span-4" title={t('comingUpTitle')}>
  {items.length===0?<p className="m-0 text-sm text-muted-foreground">{t('nothingComingUp')}</p>:
  <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-[0.8125rem]">
   {items.map(item=><li key={`${item.kind}:${item.date}:${item.name??''}`} data-today-upcoming={item.kind} className="flex items-baseline gap-3">
    <span className="w-24 flex-none font-mono text-xs text-muted-foreground">{when(item)}</span><span className="min-w-0 break-words">{text(item)}</span>
   </li>)}
  </ul>}
  {(!readiness.ok||!calendar.ok||!away.ok||(hints!==null&&!hints.ok))&&<PanelNote>{t('comingUpPartial')}</PanelNote>}
  <div className="mt-auto pt-1"><AskChips label={tToday('suggestions')} chips={chips}/></div>
 </Panel>;
}

// ── Waiting for your decision ──────────────────────────────────────────────────────────────────────────────────
const WAITING_SHOWN=3;
/** Work assigned to the person (a named participant, a profile-change assignee, a reviewer, a rewards approver), from
 * the Tasks page's own read. Drawn only when something is waiting; its count is the count the Tasks page lists. */
export async function WaitingPanel(p:{session:SessionContext;locale:string}){
 const [t,tTask,tToday,data]=await Promise.all([getTranslations('today.employee'),getTranslations('notifications.task'),getTranslations('today'),
  attempt(()=>readWaitingForYou(p.session))]);
 if(!data.ok)return <Panel id="today-waiting" title={t('waitingTitle')}><PanelNote>{t('unavailable')}</PanelNote></Panel>;
 const {items,total}=data.value;
 if(total<=0)return null;
 const label=(kind:string)=>tTask.has(kind as never)?tTask(kind as never):tToday('tasks.review');
 return <Panel id="today-waiting" title={t('waitingTitle')} action={<PanelLink href="/tasks">{t('waitingSeeAll',{count:total})}</PanelLink>}>
  <p data-today-waiting={total} className="m-0 text-sm font-semibold">{t('waitingCount',{count:total})}</p>
  <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
   {items.slice(0,WAITING_SHOWN).map(item=>{const title=item.subjectName?`${label(item.kind)} · ${item.subjectName}`:label(item.kind);
    return <li key={`${item.kind}:${item.id}`} data-today-waiting-item={item.kind}><Link href={item.linkPath} className="text-[0.8125rem] text-primary hover:underline">{title}</Link></li>;})}
  </ul>
 </Panel>;
}
