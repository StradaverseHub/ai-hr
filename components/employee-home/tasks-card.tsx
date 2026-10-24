'use client';

import * as React from 'react';
import Link from 'next/link';
import {useLocale,useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {IndependentHomeCard} from './home-card';
import {HOME_TASK_KINDS} from '@/lib/employee-home';
import {isCalendarDate} from '@/lib/calendar-date';
import type {EmployeeHomeTasks} from '@/lib/employee-home-tasks';

export function HomeTasksCard({employmentId}:{employmentId:string}){
 const t=useTranslations('employeeHome.tasks'),kind=useTranslations('employeeHome.taskNames'),locale=useLocale();
 const [page,setPage]=React.useState(1),[refresh,setRefresh]=React.useState(0);
 React.useEffect(()=>{
  // Navigation back from the real owner and a newly focused tab refresh current work. Concurrent
  // decisions are also reconciled while Home is visible; a sent request alone never removes a row.
  const update=()=>{if(document.visibilityState==='visible')setRefresh(value=>value+1);};
  window.addEventListener('focus',update);document.addEventListener('visibilitychange',update);
  const timer=window.setInterval(update,30000);
  return ()=>{window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',update);window.clearInterval(timer);};
 },[]);
 const read=React.useCallback(async(signal:AbortSignal):Promise<EmployeeHomeTasks>=>{
  const response=await fetch('/api/home/tasks?'+new URLSearchParams({employmentId,page:String(page)}),{signal,cache:'no-store',credentials:'same-origin'});
  if(!response.ok)throw Error('Assigned work unavailable');
  const value:EmployeeHomeTasks=await response.json(),count=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
  if(value.version!==1||value.employmentId!==employmentId||value.grain!=='account'||!isCalendarDate(value.asOf)
   ||![value.total,value.overdue,value.effortMinutes,value.unestimated,value.page,value.pages].every(count)
   ||value.overdue>value.total||value.unestimated>value.total||value.page<1||value.pages<value.page||value.pageSize!==12
   ||!Array.isArray(value.items)||value.items.length>12||value.items.length>value.total
   ||value.items.some(row=>!row||!HOME_TASK_KINDS.includes(row.kind)||typeof row.id!=='string'||!row.id
    ||row.subjectName!==null&&typeof row.subjectName!=='string'||!Number.isFinite(Date.parse(row.createdAt))
    ||typeof row.linkPath!=='string'||!row.linkPath.startsWith('/')||row.linkPath.startsWith('//')||/[\x00-\x20\\]/.test(row.linkPath)
    ||typeof row.overdue!=='boolean'||row.dueDate!==undefined&&!isCalendarDate(row.dueDate)))throw Error('Assigned work unavailable');
  return value;
 },[employmentId,page]);
 const date=(day:string)=>new Intl.DateTimeFormat(locale,{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(day+'T00:00:00Z'));
 return <IndependentHomeCard card="tasks" title={t('title')} labels={{loading:t('loading'),failed:t('failed'),timeout:t('timeout'),retry:t('retry'),refresh:t('refresh')}}
  requestKey={`${employmentId}:${locale}:${page}:${refresh}`} read={read}>{value=><div className="space-y-4">
   <p className="text-xs leading-relaxed text-muted-foreground">{t('accountScope')}</p>
   {value.total===0?<p role="status" className="text-sm leading-relaxed text-muted-foreground">{t('empty')}</p>:<>
    <div className="space-y-1"><p className="font-medium tabular-nums">{t('total',{count:value.total})}</p>
     {value.unestimated<value.total&&<p className="text-sm text-muted-foreground">{t('effort',{minutes:value.effortMinutes})}</p>}
     {value.unestimated>0&&<p className="text-sm text-muted-foreground">{t('unestimated',{count:value.unestimated})}</p>}
    </div>
    <ul className="divide-y divide-border">{value.items.map(item=><li key={item.kind+':'+item.id} className="flex flex-wrap items-start justify-between gap-3 py-4 first:pt-0">
     <div className="min-w-0 basis-full space-y-1 sm:basis-0 sm:flex-1">
      <p className="break-words text-sm font-medium">{kind(item.kind)}</p>
      {item.subjectName&&<p className="break-words text-sm text-muted-foreground">{item.subjectName}</p>}
      {item.dueDate&&<p className={'text-xs '+(item.overdue?'font-medium text-destructive':'text-muted-foreground')}>
       {item.overdue?t('overdue',{date:date(item.dueDate)}):t('due',{date:date(item.dueDate)})}
      </p>}
     </div>
     <Link href={item.linkPath} className="inline-flex min-h-11 max-w-full items-center rounded-md border bg-background px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
      {t(item.kind==='noticeAcknowledgement'?'acknowledge':item.kind==='feedback'?'feedback':item.kind==='onboarding'?'open':'review')}
     </Link>
    </li>)}</ul>
    {value.pages>1&&<nav aria-label={t('pagination')} className="flex flex-wrap items-center justify-between gap-3">
     <Button type="button" variant="outline" className="min-h-11" disabled={value.page<=1} onClick={()=>setPage(value.page-1)}>{t('previous')}</Button>
     <span className="text-xs tabular-nums text-muted-foreground">{t('page',{page:value.page,pages:value.pages})}</span>
     <Button type="button" variant="outline" className="min-h-11" disabled={value.page>=value.pages} onClick={()=>setPage(value.page+1)}>{t('next')}</Button>
    </nav>}
   </>}
  </div>}</IndependentHomeCard>;
}
