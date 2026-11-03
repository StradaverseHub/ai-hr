import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {formatPayPeriodMonth} from '@/lib/hr-date';
import {cn} from '@/lib/utils';
import {LoopCards} from '@/components/today/loop-cards';
import {PAYROLL_READINESS_HREF,type GroupStatus,type PayrollItem,type PayrollItemGroup,type PayrollReadiness} from '@/lib/pre-salary/items';

/** AI v2 Phase 2, P2-3 — the "Before payroll" checklist, as Today's card and as AI Centre › Insights' "My payroll
 * readiness" (owner decisions 7 and 8, 3 November 2026). Server components; every value is the person's own, read by
 * core/pre-salary/person-items.ts as them. No pay figure is ever passed in. Each row has one action: the missed
 * clock-out loop's own Confirm card where it exists (on Today it waits in Needs you; on Insights it is drawn here),
 * otherwise a link to the owner's page. Status is always words beside its colour. */

/** An HR calendar date (yyyy-mm-dd) is a day, not an instant: format it as UTC so no offset moves it. */
const hrDay=(locale:string,iso:string)=>new Intl.DateTimeFormat(locale,{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(`${iso}T00:00:00Z`));
const LINK='inline-flex min-h-9 flex-none items-center justify-center rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11';
const PILL='inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium before:size-1.5 before:rounded-full before:bg-current';
const TONE:Readonly<Record<GroupStatus|'check',string>>={done:'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',todo:'bg-amber-500/10 text-amber-800 dark:text-amber-300',
 waiting:'bg-sky-500/10 text-sky-800 dark:text-sky-300',check:'bg-muted text-muted-foreground',unknown:'bg-muted text-muted-foreground',off:'bg-muted text-muted-foreground'};

type T=Awaited<ReturnType<typeof getTranslations>>;
/** The row's title: what is pending, with the person's own leave or claim type (or, for an approval, the requester),
 * then its day or days. */
const FALLBACK:Readonly<Partial<Record<PayrollItemGroup,'leave'|'claim'|'someone'>>>={leave:'leave',claims:'claim',approvals:'someone'};
function titleOf(t:T,locale:string,row:PayrollItem):string{
 const fallback=FALLBACK[row.group],label=row.label?.trim()||(fallback?t(`fallback.${fallback}`):'');
 const what=t(`kinds.${row.kind}`,{label,name:label});
 if(!row.date)return what;
 const days=row.endDate&&row.endDate!==row.date?t('range',{from:hrDay(locale,row.date),to:hrDay(locale,row.endDate)}):hrDay(locale,row.date);
 return `${what} · ${days}`;
}
function metaOf(t:T,locale:string,row:PayrollItem):string[]{
 return [t(`state.${row.state}`),...(row.due?[t('due',{date:hrDay(locale,row.due)})]:[])];
}

/** One checklist row. `todayConfirm`: on Today the clock-out Confirm card is already in Needs you, so the row points there. */
function ItemRow({t,locale,row,todayConfirm}:{t:T;locale:string;row:PayrollItem;todayConfirm:boolean}){
 const title=titleOf(t,locale,row);
 const href=row.action.kind==='confirm'&&todayConfirm?'#today-needs-you':row.action.href;
 const cta=row.action.kind==='confirm'?t('confirm'):t(row.group==='approvals'?'review':'open');
 return <li data-payroll-item={row.kind} data-payroll-state={row.state} data-payroll-action={row.action.kind} className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5">
  <div className="min-w-0 flex-1">
   <p className="break-words text-sm font-medium leading-snug">{title}</p>
   <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">{metaOf(t,locale,row).map((line,index)=><span key={index}>{line}</span>)}</p>
  </div>
  <Link href={href} className={cn(LINK,row.state==='todo'||row.action.kind==='confirm'?'bg-primary text-primary-foreground hover:bg-primary/90':'border border-input bg-card hover:bg-accent')}>
   {cta}<span className="sr-only"> · {title}</span></Link>
 </li>;
}

/** Today: "Before payroll on <date>", the first few items and "See all". Nothing pending and nothing waiting on the
 * person: no card (Today shows only what needs them). */
export const TODAY_ITEM_LIMIT=3;
export async function BeforePayrollCard({readiness,locale}:{readiness:PayrollReadiness|null;locale:string}){
 if(!readiness)return null;
 const rows=[...readiness.items.filter(row=>row.state!=='waiting'),...readiness.approvals];
 const waiting=readiness.items.filter(row=>row.state==='waiting').length;
 if(!rows.length&&!waiting)return null;
 const t=await getTranslations('payrollReadiness');
 const title=readiness.period.cutOff?t('todayTitle',{date:hrDay(locale,readiness.period.cutOff)}):t('todayTitleNoDate');
 const shown=rows.slice(0,TODAY_ITEM_LIMIT);
 return <section aria-labelledby="today-before-payroll" data-today-section="today-before-payroll" className="min-w-0 space-y-3">
  <div className="flex items-baseline gap-2">
   <h2 id="today-before-payroll" className="text-[0.9375rem] font-semibold">{title}</h2>
   {rows.length>0&&<span data-today-count className="text-xs font-medium tabular-nums text-muted-foreground">{rows.length}</span>}
  </div>
  <div className="rounded-xl border border-border bg-card px-4 py-1">
   {shown.length>0&&<ul className="divide-y divide-border">{shown.map(row=><ItemRow key={row.key} t={t} locale={locale} row={row} todayConfirm/>)}</ul>}
   {waiting>0&&<p data-payroll-waiting className={cn('py-2.5 text-sm text-muted-foreground',shown.length>0&&'border-t border-border')}>{t('waitingCount',{count:waiting})}</p>}
  </div>
  {readiness.failed&&<p role="status" className="text-xs text-muted-foreground">{t('unavailable')}</p>}
  <Link href={PAYROLL_READINESS_HREF} className="inline-flex min-h-9 items-center text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11">
   {t('seeAll')}</Link>
 </section>;
}

const OWN_GROUPS:readonly PayrollItemGroup[]=['attendance','overtime','leave','claims','toil','details','acknowledge'];
/** Insights: "My payroll readiness", every item grouped, each group done or not for the month, and what waits on the
 * person as an approver. The missed clock-out Confirm card is drawn in its group. */
export async function MyPayrollReadiness({readiness,locale}:{readiness:PayrollReadiness|null;locale:string}){
 const t=await getTranslations('payrollReadiness');
 if(!readiness)return <section id="my-payroll-readiness" aria-labelledby="my-payroll-readiness-heading" data-payroll-readiness="none" className="space-y-2">
  <h2 id="my-payroll-readiness-heading" className="text-base font-semibold">{t('insightsTitle')}</h2>
  <p className="text-sm text-muted-foreground">{t('notInUse')}</p>
 </section>;
 const month=formatPayPeriodMonth(readiness.period.payPeriod,locale);
 const status=new Map(readiness.groups.map(row=>[row.group,row.status]));
 const groups=OWN_GROUPS.filter(group=>status.get(group)!=='off');
 const approvals=status.get('approvals')!=='off'&&(readiness.approvals.length>0||status.get('approvals')==='unknown');
 const pending=readiness.items.some(row=>row.state==='todo');
 return <section id="my-payroll-readiness" aria-labelledby="my-payroll-readiness-heading" data-payroll-readiness="ready" className="scroll-mt-4 space-y-4">
  <div className="space-y-1">
   <h2 id="my-payroll-readiness-heading" className="text-base font-semibold">{t('insightsTitle')}</h2>
   <p data-payroll-period={readiness.period.payPeriod} data-payroll-cutoff={readiness.period.cutOff??'unknown'} className="text-sm text-muted-foreground">
    {readiness.period.cutOff?t('period',{month,date:hrDay(locale,readiness.period.cutOff)}):t('periodNoCutOff',{month})}</p>
   {!pending&&<p data-payroll-all-done className="text-sm">{t('allDone')}</p>}
   {readiness.failed&&<p role="status" className="text-sm text-muted-foreground">{t('unavailable')}</p>}
  </div>
  <ul className="grid gap-3 lg:grid-cols-2">
   {groups.map(group=>{const rows=readiness.items.filter(row=>row.group===group),groupStatus=status.get(group)??'unknown';
    const cards=rows.flatMap(row=>row.action.kind==='confirm'?[{kind:'clockOut' as const,caseId:row.action.caseId,date:row.action.date,checkIn:row.action.checkIn,proposedCheckOut:row.action.proposedCheckOut,href:row.action.href}]:[]);
    return <li key={group} data-payroll-group={group} data-payroll-status={groupStatus} className="min-w-0 rounded-xl border border-border bg-card p-4">
     <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{t(`groups.${group}`)}</h3>
      <span className={cn(PILL,TONE[groupStatus])}>{t(`status.${groupStatus}`)}</span>
     </div>
     {rows.length===0?<p className="mt-2 text-sm text-muted-foreground">{t(groupStatus==='unknown'?'groupUnknown':'groupDone')}</p>
      :<ul className="mt-1 divide-y divide-border">{rows.filter(row=>row.action.kind!=='confirm').map(row=><ItemRow key={row.key} t={t} locale={locale} row={row} todayConfirm={false}/>)}</ul>}
     {cards.length>0&&<ul className="mt-2 space-y-2"><LoopCards cards={cards} locale={locale}/></ul>}
    </li>;})}
  </ul>
  {approvals&&<section aria-labelledby="payroll-approvals-heading" data-payroll-group="approvals" data-payroll-status={status.get('approvals')} className="rounded-xl border border-border bg-card p-4">
   <div className="flex flex-wrap items-center justify-between gap-2">
    <h3 id="payroll-approvals-heading" className="text-sm font-semibold">{t('groups.approvals')}</h3>
    <span className={cn(PILL,TONE[status.get('approvals')??'unknown'])}>{t(`status.${status.get('approvals')??'unknown'}`)}</span>
   </div>
   <p className="mt-1 text-xs text-muted-foreground">{t('approvalsHelp')}</p>
   {readiness.approvals.length>0&&<ul className="mt-1 divide-y divide-border">{readiness.approvals.map(row=><ItemRow key={row.key} t={t} locale={locale} row={row} todayConfirm={false}/>)}</ul>}
  </section>}
  <p className="text-xs text-muted-foreground">{t('notCovered')}</p>
 </section>;
}
