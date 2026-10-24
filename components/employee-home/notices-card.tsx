'use client';

import * as React from 'react';
import Link from 'next/link';
import {useLocale,useTranslations} from 'next-intl';
import {IndependentHomeCard} from './home-card';
import type {EmployeeHomeNotices} from '@/lib/employee-home-read-model';

export function HomeNoticesCard({employmentId,timeZone='Asia/Kuala_Lumpur'}:{employmentId:string;timeZone?:string}){
 const t=useTranslations('employeeHome.notices'),n=useTranslations('notices'),locale=useLocale();
 const [refresh,setRefresh]=React.useState(0);
 React.useEffect(()=>{
  const update=()=>{if(document.visibilityState==='visible')setRefresh(value=>value+1);};
  window.addEventListener('focus',update);document.addEventListener('visibilitychange',update);
  const timer=window.setInterval(update,30000);
  return ()=>{window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',update);window.clearInterval(timer);};
 },[]);
 const read=React.useCallback(async(signal:AbortSignal):Promise<EmployeeHomeNotices>=>{
  const response=await fetch('/api/home/notices?'+new URLSearchParams({employmentId}),{signal,cache:'no-store',credentials:'same-origin'});
  if(!response.ok)throw Error('Notice Board unavailable');
  const value:EmployeeHomeNotices=await response.json();
  const count=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
  const text=(value:unknown,max:number)=>typeof value==='string'&&value.length<=max;
  const date=(value:unknown)=>value===null||typeof value==='string'&&Number.isFinite(Date.parse(value));
  if(value.version!==1||value.employmentId!==employmentId||![value.total,value.unread,value.acknowledgementRequired].every(count)
   ||value.unread>value.total||value.acknowledgementRequired>value.total||!Array.isArray(value.items)
   ||value.items.length>5||value.items.length>value.total||new Set(value.items.map(row=>row?.id)).size!==value.items.length
   ||value.items.some(row=>!row||typeof row.id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.id)
    ||!text(row.title,500)||!row.title.trim()||!text(row.summary,500)||row.category!==null&&!text(row.category,80)
    ||row.publishedBy!==null&&!text(row.publishedBy,500)||typeof row.pinned!=='boolean'||typeof row.requiresAcknowledgement!=='boolean'
    ||![row.publishedAt,row.firstViewedAt,row.acknowledgedAt].every(date)))throw Error('Notice Board unavailable');
  return value;
 },[employmentId]);
 const date=(instant:string)=>new Intl.DateTimeFormat(locale,{day:'numeric',month:'short',year:'numeric',timeZone}).format(new Date(instant));
 const stamp=(instant:string)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone}).format(new Date(instant));
 return <IndependentHomeCard card="notices" title={n('myTitle')} labels={{loading:t('loading'),failed:t('failed'),timeout:t('timeout'),retry:t('retry'),refresh:t('refresh')}}
  requestKey={`${employmentId}:${locale}:${timeZone}:${refresh}`} read={read}>{value=><div className="space-y-4">
   <p role="status" className="text-sm text-muted-foreground">{n('matchingCounts',{total:value.total,unread:value.unread,required:value.acknowledgementRequired})}</p>
   {value.total===0?<p className="text-sm leading-relaxed text-muted-foreground">{n('myEmpty')}</p>:
    <ul className="divide-y divide-border">{value.items.map(item=>{
     const href=`/notices/${item.id}?${new URLSearchParams({employmentId})}`;
     return <li key={item.id} className="space-y-2 py-4 first:pt-0">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
       {item.pinned&&<span className="font-medium text-foreground">{n('pinnedBadge')}</span>}
       <span>{item.category??n('generalCategory')}</span>
       {item.firstViewedAt===null&&<span className="rounded-full bg-primary/10 px-2 py-1 text-primary">{n('newBadge')}</span>}
       {item.requiresAcknowledgement&&<span>{n(item.acknowledgedAt?'acknowledgedBadge':'acknowledgementRequiredBadge')}</span>}
      </div>
      <Link href={href} className="flex min-h-11 items-center break-words text-base font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{item.title}</Link>
      {item.summary&&<p className="truncate text-sm text-muted-foreground">{item.summary}</p>}
      <p className="text-xs leading-relaxed text-muted-foreground">{n('publishedByOn',{date:item.publishedAt?date(item.publishedAt):'—',by:item.publishedBy??n('senderUnavailable')})}</p>
      {item.requiresAcknowledgement&&(item.acknowledgedAt?<p className="text-xs text-muted-foreground">{n('acknowledgedOn',{date:stamp(item.acknowledgedAt)})}</p>:
       <Link href={href} className="inline-flex min-h-11 max-w-full items-center rounded-md border bg-background px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('reviewAcknowledge')}</Link>)}
     </li>;
    })}</ul>}
   <Link href={'/notices?'+new URLSearchParams({employmentId})} className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('seeAll')}</Link>
  </div>}</IndependentHomeCard>;
}
