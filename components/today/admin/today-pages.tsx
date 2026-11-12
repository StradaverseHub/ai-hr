import {Suspense,type ReactNode} from 'react';
import {getLocale,getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {dateTimeFormatter} from '@/lib/date-time-formatter';
import {HR_LOCAL_TZ,todayInKualaLumpur} from '@/lib/hr-date';
import {greetingFor} from '@/lib/today/audience';
import {GreetingWithName} from '../today-page';
import {TodayAsk} from '../today-ask';
import {PanelNote,PanelSkeleton} from '../employee/panel';
import {PanelBoundary} from '../employee/panel-boundary';
import {readAskAllowed} from '../employee/reads';
import {AdminAskPanel,AdminHeadline,AdminNeedsPanel,DecidePanel,HandledPanel,ManagerHeadline,OwnRecordPanel,ReadinessPanel,TeamComingUpPanel,WatchingPanel,
 type RoleContext} from './panels';
import {scopeKey} from './reads';
import Link from 'next/link';
import {TodayPerformance} from '../performance-slot';
import {LINK} from '../employee/panel';

/** HR administrator and manager Today (owner decision, 11 Nov 2026; AdminToday.dc.html and ManagerToday.dc.html), at
 * `/`, in place of Today over the old dashboard for these two audiences. app/page.tsx chooses by lib/today/admin.ts
 * todayLayoutFor: an administrator always gets the administrator page (the earlier dashboard opens on its own only at
 * `?workspace=dashboard`); a manager gets the team page unless they ask for the team workbench (`?workspace=team`);
 * anyone holding a partner role who is not an administrator keeps the earlier Today, even if they also manage a team.
 *
 * The greeting and date render at once from the HR date owner. Every panel then streams inside its own Suspense and
 * error boundary, so the slowest or a failing owner holds back or replaces only its own panel; the heading's count
 * waits on its own boundary and reads the very list Needs you (or Decide) draws. Light and dark follow the app's theme
 * tokens. No panel decides anything: each links to the owner's page where the person decides. */

type PageProps=Readonly<{session:SessionContext;scopeIds:readonly string[];allCompanies:boolean;notice?:ReactNode;all?:boolean;now?:Date;
 /** The viewer's own employment chosen on Home (`?employmentId=`), for their own record panel. */employmentId?:string;
 /** Manager Today: the leave request whose recommendation the person asked to open (`?recommend=`). */recommend?:string}>;

/** The date, the greeting, the heading's count line (its own Suspense boundary) and the Ask bar. */
async function pageHeader(p:PageProps,kind:'administrator'|'manager',count:(c:RoleContext)=>ReactNode){
 const [t,tAdmin,locale]=await Promise.all([getTranslations('today'),getTranslations('today.admin'),getLocale()]);
 const now=p.now??new Date(),today=todayInKualaLumpur(now);
 const hour=Number(dateTimeFormatter('en-GB',{hour:'2-digit',hourCycle:'h23',timeZone:HR_LOCAL_TZ}).format(now));
 const dateLine=dateTimeFormatter(locale,{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${today}T00:00:00Z`));
 const scope=kind==='administrator'?(p.allCompanies?tAdmin('scopeAll'):tAdmin('scopeSome',{count:p.scopeIds.length})):null;
 const c:RoleContext={session:p.session,scopeKey:scopeKey(p.scopeIds),locale,today,all:p.all,employmentId:p.employmentId};
 return {c,node:<header className="flex flex-wrap items-end justify-between gap-4">
  <div className="flex min-w-0 flex-col gap-1.5">
   <p data-today-date={today} className="m-0 text-[0.8125rem] text-muted-foreground">{[dateLine,scope].filter(Boolean).join(' · ')}</p>
   <h1 className="m-0 text-2xl font-semibold tracking-tight text-balance sm:text-[1.625rem]">
    <Suspense fallback={t(greetingFor(hour))}><GreetingWithName session={p.session} period={greetingFor(hour)}/></Suspense>
   </h1>
   <PanelBoundary fallback={null}><Suspense fallback={null}>{count(c)}</Suspense></PanelBoundary>
  </div>
  <div className="w-full min-w-0 sm:w-auto sm:min-w-[18rem] sm:flex-[0_1_26rem]"><Suspense fallback={null}><AskBar session={p.session}/></Suspense></div>
 </header>};
}

/** One panel: its own error boundary around its own Suspense boundary. */
async function slots(){
 const t=await getTranslations('today.admin');
 return (key:string,title:string,node:ReactNode,rows=2)=><PanelBoundary key={key} fallback={<PanelNote>{t('unavailable')}</PanelNote>}>
  <Suspense fallback={<PanelSkeleton title={title} rows={rows}/>}>{node}</Suspense>
 </PanelBoundary>;
}

export async function AdminTodayPage(p:PageProps){
 const [t,top,slot]=await Promise.all([getTranslations('today.admin'),pageHeader(p,'administrator',c=><AdminHeadline {...c}/>),slots()]);
 const c=top.c;
 return <div data-today="administrator" className="mx-auto w-full max-w-[68rem] min-w-0 space-y-6">
  {p.notice}{top.node}
  <TodayPerformance session={p.session} scopeIds={p.scopeIds}/>
  <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
   <div className="flex min-w-0 flex-col gap-6">
    {slot('readiness',t('readinessTitle'),<ReadinessPanel {...c}/>,1)}
    {slot('needs',t('needsTitle'),<AdminNeedsPanel {...c}/>,4)}
    {slot('handled',t('handledTitle'),<HandledPanel {...c}/>,1)}
   </div>
   <aside aria-label={t('sideLabel')} className="flex min-w-0 flex-col gap-4">
    {slot('watching',t('watchingTitle'),<WatchingPanel {...c}/>,1)}
    {slot('own',t('ownTitle'),<OwnRecordPanel {...c} title="own"/>,1)}
    {slot('ask',t('askTitle'),<AdminAskPanel {...c}/>,1)}
   </aside>
  </div>
 </div>;
}

export async function ManagerTodayPage(p:PageProps){
 const [t,tAdmin,tHome,top,slot]=await Promise.all([getTranslations('today.manager'),getTranslations('today.admin'),getTranslations('employeeHome'),pageHeader(p,'manager',c=><ManagerHeadline {...c}/>),slots()]);
 const c=top.c;
 return <div data-today="manager" className="mx-auto w-full max-w-[66rem] min-w-0 space-y-6">
  {p.notice}{top.node}
  {/* The team workbench (the earlier manager dashboard), on request. */}
  <nav aria-label={tHome('homeOptions')} className="flex flex-wrap justify-end gap-4">
   <Link href={'/?'+new URLSearchParams({workspace:'team',...(p.employmentId?{employmentId:p.employmentId}:{})})} data-today-workbench className={LINK}>{tHome('teamWorkbench')}</Link>
  </nav>
  <TodayPerformance session={p.session} scopeIds={p.scopeIds}/>
  <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
   <div className="flex min-w-0 flex-col gap-6">
    {slot('decide',t('decideTitle'),<DecidePanel {...c} highlight={p.recommend}/>,4)}
    {slot('own',tAdmin('forYouTitle'),<OwnRecordPanel {...c} title="forYou"/>,1)}
   </div>
   <aside aria-label={t('sideLabel')} className="flex min-w-0 flex-col gap-4">
    {slot('team',t('comingUpTitle'),<TeamComingUpPanel {...c}/>,2)}
   </aside>
  </div>
 </div>;
}

/** The Ask bar, offered only to someone the Assistant can answer (the gate AI Centre Ask uses). The administrator's
 * prompts are in the side panel, so the bar has none. */
async function AskBar({session}:{session:SessionContext}){
 if(!await readAskAllowed(session))return null;
 const t=await getTranslations('today');
 return <TodayAsk label={t('askLabel')} placeholder={t('askPlaceholderAdmin')} submitLabel={t('askSubmit')} openingLabel={t('askOpening')} suggestionsLabel={t('suggestions')}/>;
}
