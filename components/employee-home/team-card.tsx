'use client';

import * as React from 'react';
import {useLocale,useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {IndependentHomeCard} from './home-card';
import {useHomeInitialSharing} from './sharing-cohort';
import {validateHomeTeamResponse} from '@/lib/employee-home-sharing';

/** A different subject, day or page has its own delivery key. Permission changes and stale cursors
 * cannot keep an earlier peer page visible under a new heading. Nothing here creates attendance. */
export function HomeTeamCard({employmentId,date,onlyLeave=false}:{employmentId:string;date?:string;onlyLeave?:boolean}){
 const t=useTranslations('employeeHome.team'),locale=useLocale();
 const subscribe=useHomeInitialSharing();
 const [hasPaged,setHasPaged]=React.useState(false);
 const [pages,setPages]=React.useState<(string|undefined)[]>([undefined]);
 const region=React.useRef<HTMLDivElement>(null);
 function changePage(next:(string|undefined)[]){setHasPaged(true);setPages(next);region.current?.focus();}
 const after=pages.at(-1);
 const readResponse=React.useCallback(async(signal:AbortSignal):Promise<unknown>=>{
  const query=new URLSearchParams({employmentId});if(date)query.set('date',date);if(after)query.set('after',after);if(onlyLeave)query.set('view','leave');
  const response=await fetch('/api/home/team?'+query,{signal,cache:'no-store',credentials:'same-origin'});
  if(!response.ok)throw Error('Shared team unavailable');
  return response.json() as Promise<unknown>;
 },[employmentId,date,after,onlyLeave]);
 const parse=React.useCallback((value:unknown)=>validateHomeTeamResponse(value,employmentId,date).page,[employmentId,date]);
 const read=React.useCallback(async(signal:AbortSignal)=>parse(await readResponse(signal)),[parse,readResponse]);
 const initialRead=React.useCallback(async(signal:AbortSignal)=>{
  if(!subscribe)return read(signal);
  return parse(await subscribe('team',signal,()=>readResponse(signal)));
 },[subscribe,read,parse,readResponse]);
 const formatDate=(value:string)=>new Intl.DateTimeFormat(locale,{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(value+'T00:00:00Z'));
 const footer=after?<Button type="button" variant="outline" className="min-h-11 whitespace-normal" onClick={()=>changePage([undefined])}>{t('firstPage')}</Button>:undefined;
 return <IndependentHomeCard card="team" title={t(onlyLeave?'leaveTitle':'title')}
  labels={{loading:t('loading'),failed:t('failed'),timeout:t('timeout'),retry:t('retry'),refresh:t('refresh')}}
  requestKey={JSON.stringify([employmentId,date,after,onlyLeave,locale])} read={read} initialRead={!hasPaged&&!date&&!onlyLeave?initialRead:undefined} footer={footer} regionRef={region}>
  {value=><div className="space-y-4">
   {value.scope==='off'?<p className="text-sm leading-relaxed text-muted-foreground">{t('off')}</p>:<>
    <p className="text-sm text-muted-foreground">{t('context',{date:formatDate(value.date),scope:t(value.scope)})}</p>
    {value.items.length===0?<p className="text-sm leading-relaxed text-muted-foreground">{t(onlyLeave?'noLeave':'empty')}</p>:
     <ul className="divide-y">{value.items.map(member=><li key={member.employmentId} className="py-3 text-sm leading-relaxed [overflow-wrap:anywhere]">
      {t(member.presence==='leave'?'onLeave':'unknown',{name:member.name??t('unnamed')})}
     </li>)}</ul>}
    <div className="flex flex-wrap items-center justify-between gap-3">
     <p className="text-xs text-muted-foreground">{t('total',{count:value.totalPeople})}</p>
     <nav className="flex flex-wrap gap-2" aria-label={t('pagination')}>
      {pages.length>1&&<Button type="button" variant="outline" className="min-h-11 whitespace-normal" onClick={()=>changePage(pages.slice(0,-1))}>{t('previous')}</Button>}
      {value.nextCursor&&<Button type="button" variant="outline" className="min-h-11 whitespace-normal" onClick={()=>changePage([...pages,value.nextCursor!])}>{t('next')}</Button>}
     </nav>
    </div>
   </>}
  </div>}
 </IndependentHomeCard>;
}
