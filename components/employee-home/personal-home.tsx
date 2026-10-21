import type {ReactNode} from 'react';
import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {HomeAccessError,readEmployeeHomeIdentity} from '@/core/employee-home';
import {listEmployeeHomeCards} from '@/core/dashboard-card-config';
import {getEmployeeHomePreferences} from '@/core/dashboard-prefs';
import {EmployeeHomeSurface} from './home-surface';
import {HomeGreetingCard} from './greeting-card';
import {HomeTimeOffCard} from './time-off-card';
import {HomeTasksCard} from './tasks-card';
import {HomeNoticesCard} from './notices-card';
import {HomeCalendarCard} from './calendar-card';
import {homeDisplayClock,type EmployeeHomeCard} from '@/lib/employee-home';

/** Personal landing composition only. Every card retrieves its own authorized facts independently. */
export async function EmployeePersonalHome({session,employmentId,teamWorkbench=false}:{session:SessionContext;employmentId?:string;teamWorkbench?:boolean}){
 const ownIdentity=readEmployeeHomeIdentity(session,employmentId).catch(error=>{
  if(error instanceof HomeAccessError&&error.code==='employmentUnavailable')notFound();
  throw error;
 });
 const [identity,catalogue,t]=await Promise.all([ownIdentity,listEmployeeHomeCards(session),getTranslations('employeeHome')]);
 const preferences=await getEmployeeHomePreferences(session,catalogue),selected=identity.selectedEmploymentId;
 const permitted=new Set(catalogue.map(card=>card.cardKey));
 const available:Partial<Record<EmployeeHomeCard,ReactNode>>=selected?{
  summary:<HomeGreetingCard employmentId={selected}/>,
  notices:<HomeNoticesCard employmentId={selected} timeZone={preferences.timeZone??'Asia/Kuala_Lumpur'}/>,
  tasks:<HomeTasksCard employmentId={selected}/>,
  timeOff:<HomeTimeOffCard employmentId={selected}/>,
  calendar:<HomeCalendarCard key={JSON.stringify([selected,preferences.timeZone,preferences.weekStartsOn])} employmentId={selected} initialMonth={homeDisplayClock(new Date(),preferences.timeZone??'Asia/Kuala_Lumpur').date.slice(0,7)}/>,
 }:{};
 const cards=Object.fromEntries(Object.entries(available).filter(([key])=>permitted.has(key)));
 return <div className="mx-auto max-w-7xl space-y-5">
  <nav className="flex flex-wrap justify-end gap-4" aria-label={t('homeOptions')}>
   {teamWorkbench&&<Link href="/?workspace=team" className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('teamWorkbench')}</Link>}
   <Link href="/me/home" className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('preferences.title')}</Link>
  </nav>
  <EmployeeHomeSurface identity={identity} preferences={preferences} cards={cards} labels={{title:t('title'),employment:t('employment'),chooseEmployment:t('chooseEmployment'),chooseHelp:t('chooseHelp'),showEmployment:t('showEmployment'),noEmployment:t('noEmployment'),companyUnavailable:t('companyUnavailable'),employeeCodeUnavailable:t('employeeCodeUnavailable')}}/>
 </div>;
}
