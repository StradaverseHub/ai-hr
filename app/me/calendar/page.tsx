import Link from 'next/link';
import {Suspense} from 'react';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import type {SessionContext} from '@/db/client';
import {HomeAccessError,readEmployeeHomeIdentity} from '@/core/employee-home';
import {readEmployeeHomeCalendar} from '@/core/employee-home-calendar';
import {getEmployeeHomePreferences} from '@/core/dashboard-prefs';
import {listEmployeeHomeCards} from '@/core/dashboard-card-config';
import {homeDisplayClock} from '@/lib/employee-home';
import {homeCalendarMonth,validateHomeCalendar} from '@/lib/employee-home-calendar';
import {HomeCalendarCard} from '@/components/employee-home/calendar-card';
import {EmployeeHomeSurface} from '@/components/employee-home/home-surface';
import {calendarProjection} from '@/app/api/home/personal-projections';
import {runCappedHomeCardRead,startHomeCardReadCap} from '@/app/api/home/read-cap';

async function PersonalCalendar({session,employmentId,month}:{session:SessionContext;employmentId:string;month:string}){
 const cap=startHomeCardReadCap();
 const initialCalendar=await runCappedHomeCardRead(cap.signal,cap.signal,async()=>{
  const value=await readEmployeeHomeCalendar(session,employmentId,month,undefined,cap.signal);
  return {state:'ready',value:validateHomeCalendar(calendarProjection(value),employmentId,month)} as const;
 }).catch(()=>({state:'failed',reason:cap.signal.aborted?'timeout':'unavailable'} as const)).finally(cap.stop);
 return <HomeCalendarCard employmentId={employmentId} initialMonth={month} full initialCalendar={initialCalendar}/>;
}

export default async function MyCalendarPage({searchParams}:{searchParams:Promise<{employmentId?:string|string[];month?:string|string[]}>}){
 const {s}=await scopedSession(),query=await searchParams;
 if(Array.isArray(query.employmentId)||Array.isArray(query.month))notFound();
 if(query.month!==undefined){try{homeCalendarMonth(query.month);}catch{notFound();}}
 const t=await getTranslations('employeeHome');
 const identity=await readEmployeeHomeIdentity(s,query.employmentId).catch(error=>{
  if(error instanceof HomeAccessError&&error.code==='employmentUnavailable')notFound();
  throw error;
 });
 const cards=await listEmployeeHomeCards(s),preferences=await getEmployeeHomePreferences(s,cards);
 const selected=identity.selectedEmploymentId,month=query.month??homeDisplayClock(new Date(),preferences.timeZone??'Asia/Kuala_Lumpur').date.slice(0,7);
 return <div className="mx-auto max-w-5xl space-y-5">
  <Link className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4" href={selected?'/?'+new URLSearchParams({employmentId:selected}):'/'}>{t('calendar.back')}</Link>
  <EmployeeHomeSurface identity={identity} preferences={preferences} cards={{}} labels={{title:t('calendar.title'),employment:t('employment'),chooseEmployment:t('chooseEmployment'),chooseHelp:t('chooseHelp'),showEmployment:t('showEmployment'),noEmployment:t('noEmployment'),companyUnavailable:t('companyUnavailable'),employeeCodeUnavailable:t('employeeCodeUnavailable')}} selectionPath="/me/calendar" selectionMonth={month}/>
  {selected&&<Suspense key={JSON.stringify([selected,month,preferences.timeZone,preferences.weekStartsOn])}
   fallback={<p role="status" className="min-h-24 text-sm">{t('calendar.loading')}</p>}>
   <PersonalCalendar session={s} employmentId={selected} month={month}/>
  </Suspense>}
 </div>;
}
