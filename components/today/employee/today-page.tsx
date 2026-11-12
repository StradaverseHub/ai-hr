import {Suspense,type ReactNode} from 'react';
import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getLocale,getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {HomeAccessError} from '@/core/employee-home';
import {dateTimeFormatter} from '@/lib/date-time-formatter';
import {HR_LOCAL_TZ,todayInKualaLumpur} from '@/lib/hr-date';
import {greetingFor} from '@/lib/today/audience';
import {employeePanels,nextStepsFrom} from '@/lib/today/employee';
import {GreetingWithName} from '../today-page';
import {TodayAsk} from '../today-ask';
import {LINK,PanelNote,PanelSkeleton} from './panel';
import {PanelBoundary} from './panel-boundary';
import {CalendarPanel,ComingUpPanel,HoursPanel,LeavePanel,NextStepPanel,NoticesPanel,PaydayPanel,RequestsPanel,WaitingPanel,type PanelContext} from './panels';
import {TodayPerformance} from '../performance-slot';
import {WorkspaceLinks} from '../workspace-links';
import {moduleState,readAskAllowed,readOwnContext,readOwnPassportCards,readOwnReadiness} from './reads';

/** Employee Today (owner decision, 11 Nov 2026): the bento one-pager for an employee, at `/`, in place of the old
 * personal dashboard. app/page.tsx draws it for everyone who is neither an administrator nor a manager
 * (lib/today/admin.ts todayLayoutFor), payroll and performance partners included (owner decision, 12 Nov 2026): a
 * partner's own payroll or performance pages are offered under "Your workspace" (components/today/workspace-links.tsx).
 *
 * The greeting and date render at once from the HR date owner. The person's own employment is proved first
 * (./reads.ts readOwnContext); then every panel streams inside its own Suspense and error boundary, so the slowest or
 * a failing owner holds back or replaces only its own panel. Panels for a module not in use for the person's company
 * are not drawn at all (lib/today/employee.ts employeePanels). Light and dark follow the app's theme tokens. */
export async function EmployeeTodayPage({session,scopeIds,employmentId,notice,now=new Date()}:{session:SessionContext;scopeIds?:readonly string[];employmentId?:string;notice?:ReactNode;now?:Date}){
 const [t,tHome,locale]=await Promise.all([getTranslations('today'),getTranslations('employeeHome'),getLocale()]);
 const today=todayInKualaLumpur(now);
 const hour=Number(dateTimeFormatter('en-GB',{hour:'2-digit',hourCycle:'h23',timeZone:HR_LOCAL_TZ}).format(now));
 const dateLine=dateTimeFormatter(locale,{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${today}T00:00:00Z`));
 // The access refusal (a foreign or stale employment choice) is a not-found page, as before. Any other failure to read
 // the person's own context is not the person's fault and not a reason for an error page: the header still draws, with
 // one plain note in place of the panels (pageUnavailable below).
 const own=await readOwnContext(session,employmentId).catch(error=>{
  if(error instanceof HomeAccessError&&error.code==='employmentUnavailable')notFound();
  return null;
 });
 const selected=own?.identity.selectedEmploymentId??null;
 const greeting=t(greetingFor(hour));
 const header=<header className="flex flex-wrap items-center justify-between gap-5">
  <div className="flex min-w-0 flex-col gap-1">
   <p data-today-date={today} className="m-0 text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{dateLine}</p>
   <h1 className="m-0 text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
    <Suspense fallback={greeting}><GreetingWithName session={session} employmentId={selected??undefined} period={greetingFor(hour)}/></Suspense>
   </h1>
   {selected&&<Suspense fallback={null}><StepCount session={session} employmentId={selected} locale={locale} today={today}/></Suspense>}
  </div>
  <div className="w-full min-w-0 sm:w-auto sm:min-w-[18rem] sm:flex-[0_1_28rem]"><Suspense fallback={null}><AskBar session={session}/></Suspense></div>
 </header>;
 const [te,tNotices]=await Promise.all([getTranslations('today.employee'),getTranslations('notices')]);
 const pageUnavailable=(key:string)=><div data-today="employee" data-today-page-unavailable={key} className="mx-auto w-full max-w-[72rem] min-w-0 space-y-6">
  {notice}{header}<PanelNote>{te('pageUnavailable')}</PanelNote>
 </div>;
 if(!own)return pageUnavailable('context');
 // Your workspace: team pages for someone whose own employment manages people, and a partner's own payroll or
 // performance pages (the old team workbench and the old personal Home under a partner's Today are retired).
 const options=<Suspense fallback={null}><WorkspaceLinks session={session} team={own.identity.role==='manager'}/></Suspense>;
 if(!selected)return <div data-today="employee" className="mx-auto w-full max-w-[72rem] min-w-0 space-y-6">
  {notice}{header}{options}
  {own.identity.employmentState==='choose'?<section aria-labelledby="today-choose" className="space-y-3 rounded-2xl border border-border bg-card p-5">
   <h2 id="today-choose" className="m-0 text-base font-semibold">{tHome('chooseEmployment')}</h2>
   <p className="m-0 text-sm text-muted-foreground">{tHome('chooseHelp')}</p>
   <ul className="m-0 flex list-none flex-col gap-1 p-0">{own.identity.employments.map(row=><li key={row.employmentId}>
    <Link href={`/?${new URLSearchParams({employmentId:row.employmentId})}`} className={LINK}>{[row.company||tHome('companyUnavailable'),row.employeeCode].filter(Boolean).join(' · ')}</Link>
   </li>)}</ul>
  </section>:<PanelNote>{tHome('noEmployment')}</PanelNote>}
 </div>;
 let modules:PanelContext['modules'];
 try{
  modules={payroll:moduleState(session,'payroll',own.companyId),leave:moduleState(session,'leave',own.companyId),
   attendance:moduleState(session,'attendance',own.companyId),claims:moduleState(session,'claims',own.companyId)};
 }catch{return pageUnavailable('modules');}
 const visible=employeePanels(modules);
 const p:PanelContext={session,employmentId:selected,locale,today,modules};
 const failed=<PanelNote>{te('unavailable')}</PanelNote>;
 /** One panel: its own error boundary around its own Suspense boundary. */
 const slot=(key:string,title:string,className:string,node:ReactNode)=><PanelBoundary key={key} fallback={<div className={className}>{failed}</div>}>
  <Suspense fallback={<PanelSkeleton title={title} className={className}/>}>{node}</Suspense>
 </PanelBoundary>;
 const unavailable=(key:string,title:string,className:string)=><section key={key} aria-label={title} className={className}>{failed}</section>;
 const gated=(key:string,state:'show'|'hide'|'unavailable',title:string,className:string,node:ReactNode)=>
  state==='hide'?null:state==='unavailable'?unavailable(key,title,className):slot(key,title,className,node);
 return <div data-today="employee" className="mx-auto w-full max-w-[80rem] min-w-0 space-y-4">
  {notice}{header}{options}
  <TodayPerformance session={session} scopeIds={scopeIds}/>
  <PanelBoundary fallback={failed}><Suspense fallback={null}><WaitingPanel session={session} locale={locale}/></Suspense></PanelBoundary>
  <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
   {slot('next',te('nextStep'),'lg:col-span-5 lg:row-span-2',<NextStepPanel {...p}/>)}
   {gated('payday',visible.payday,te('paydayTitle'),'lg:col-span-3',<PaydayPanel {...p}/>)}
   {gated('leave',visible.leave,te('leaveTitle'),'lg:col-span-4',<LeavePanel {...p}/>)}
   {slot('calendar',te('yourMonth'),visible.hours==='hide'?'lg:col-span-7':'lg:col-span-4',<CalendarPanel {...p} wide={visible.hours==='hide'}/>)}
   {gated('hours',visible.hours,te('hoursTitle'),'lg:col-span-3',<HoursPanel {...p}/>)}
   {slot('requests',te('requestsTitle'),'lg:col-span-8',<RequestsPanel {...p}/>)}
   {slot('coming',te('comingUpTitle'),'lg:col-span-4',<ComingUpPanel {...p}/>)}
   {slot('notices',tNotices('cardTitle'),'lg:col-span-12',<NoticesPanel {...p}/>)}
  </div>
 </div>;
}

/** "2 things need you", from the same checklist read the Next step panel makes (read once per render). */
async function StepCount({session,employmentId,locale,today}:{session:SessionContext;employmentId:string;locale:string;today:string}){
 const [t,readiness,passports]=await Promise.all([getTranslations('today.employee'),readOwnReadiness(session,employmentId,locale,today).catch(()=>undefined),
  readOwnPassportCards(session,today).catch(()=>undefined)]);
 if(readiness===undefined||passports===undefined)return null;
 const count=nextStepsFrom(readiness?.items??[],passports).length;
 return <p data-today-step-count={count} className="m-0 text-sm text-muted-foreground">{t('needsYouCount',{count})}</p>;
}

/** The Ask bar, offered only to someone the Assistant can answer (the gate AI Centre Ask uses). Its suggestion chips
 * are in the Coming up panel, so the bar itself has none. */
async function AskBar({session}:{session:SessionContext}){
 if(!await readAskAllowed(session))return null;
 const t=await getTranslations('today');
 return <TodayAsk label={t('askLabel')} placeholder={t('askPlaceholderPersonal')} submitLabel={t('askSubmit')} openingLabel={t('askOpening')} suggestionsLabel={t('suggestions')}/>;
}
