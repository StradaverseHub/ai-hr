'use client';

import * as React from 'react';
import {useLocale,useTranslations} from 'next-intl';
import {IndependentHomeCard} from './home-card';
import {HomeKnowledgeSearch} from './knowledge-search';
import type {EmployeeHomeGreeting} from '@/core/employee-home-greeting';
import {isLocale} from '@/i18n/config';
import {isCalendarDate} from '@/lib/calendar-date';

/** One independently delivered personal greeting. Rule summary and quick actions compose here as
 * their own authorized projections; this component never loads a personnel record or invokes AI. */
export function HomeGreetingCard({employmentId,children}:{employmentId:string;children?:React.ReactNode}){
 const t=useTranslations('employeeHome.greeting'),search=useTranslations('employeeHome.knowledgeSearch'),locale=useLocale();
 const [refresh,setRefresh]=React.useState(0);
 React.useEffect(()=>{
  // Re-evaluate the server clock, live templates and saved preferences while this Home is visible.
  const update=()=>{if(document.visibilityState==='visible')setRefresh(value=>value+1);};
  window.addEventListener('focus',update);document.addEventListener('visibilitychange',update);
  const timer=window.setInterval(update,60000);
  return ()=>{window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',update);window.clearInterval(timer);};
 },[]);
 const read=React.useCallback(async(signal:AbortSignal):Promise<EmployeeHomeGreeting>=>{
  const response=await fetch('/api/home/greeting-message?'+new URLSearchParams({employmentId}),{signal,cache:'no-store',credentials:'same-origin'});
  if(!response.ok)throw Error('Home greeting unavailable');
  const value:EmployeeHomeGreeting=await response.json();
  if(value.version!==1||value.employmentId!==employmentId||!isCalendarDate(value.displayDate)||!Number.isFinite(Date.parse(value.serverNow))
   ||typeof value.timeZone!=='string'||value.message!==null&&(typeof value.message!=='string'||!value.message.trim()||value.message.length>2000)
   ||value.photoHref!==null&&(typeof value.photoHref!=='string'||!/^\/personnel\/photo\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.photoHref)))throw Error('Home greeting unavailable');
  new Intl.DateTimeFormat(locale,{timeZone:value.timeZone}).format(new Date(value.serverNow));
  return value;
 },[employmentId,locale]);
 return <IndependentHomeCard card="summary" title={t('title')} labels={{loading:t('loading'),failed:t('failed'),timeout:t('timeout'),retry:t('retry'),refresh:t('refresh')}}
  requestKey={`${employmentId}:${locale}:${refresh}`} read={read}>{value=><div className="space-y-6">
   <div className="flex min-w-0 items-start gap-4">
    {value.photoHref&&<img src={value.photoHref} alt="" width={56} height={56} className="size-14 shrink-0 rounded-full object-cover"/>}
    <div className="min-w-0 space-y-2"><p className="break-words text-2xl font-semibold leading-snug">{value.message??t('welcome')}</p>
     <p className="text-sm text-muted-foreground"><time dateTime={value.serverNow}>{new Intl.DateTimeFormat(locale,{dateStyle:'full',timeStyle:'short',timeZone:value.timeZone}).format(new Date(value.serverNow))}</time></p>
    </div>
   </div>
   {children}
   {isLocale(locale)&&<HomeKnowledgeSearch locale={locale} contextKey={employmentId} labels={{label:search('label'),hint:search('hint'),submit:search('submit'),loading:search('loading'),results:search('results'),noMatch:search('noMatch'),failed:search('failed'),timeout:search('timeout'),invalid:search('invalid'),descriptionFallback:search('descriptionFallback'),pageDescriptionFallback:search('pageDescriptionFallback')}}/>}
  </div>}</IndependentHomeCard>;
}
