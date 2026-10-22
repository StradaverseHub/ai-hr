'use client';

import * as React from 'react';
import {useLocale,useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {IndependentHomeCard} from './home-card';
import {validateHomeCelebrationResponse,type HomeCelebrationPage} from '@/lib/employee-home-sharing';

/** Occurrences, not dates of birth. Each page repeats live policy and person-wide privacy checks.
 * Greeting composition/delivery has a separate command owner; this reader has no write side effect. */
export function HomeCelebrationsCard({employmentId}:{employmentId:string}){
 const t=useTranslations('employeeHome.celebrations'),locale=useLocale();
 const [pages,setPages]=React.useState<(string|undefined)[]>([undefined]);
 const region=React.useRef<HTMLDivElement>(null),after=pages.at(-1);
 function changePage(next:(string|undefined)[]){setPages(next);region.current?.focus();}
 const read=React.useCallback(async(signal:AbortSignal):Promise<HomeCelebrationPage>=>{
  const query=new URLSearchParams({employmentId});if(after)query.set('after',after);
  const response=await fetch('/api/home/celebrations?'+query,{signal,cache:'no-store',credentials:'same-origin'});
  if(!response.ok)throw Error('Celebrations unavailable');
  return validateHomeCelebrationResponse(await response.json(),employmentId).page;
 },[employmentId,after]);
 const formatDate=(value:string)=>new Intl.DateTimeFormat(locale,{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(value+'T00:00:00Z'));
 return <IndependentHomeCard card="celebrations" title={t('title')}
  labels={{loading:t('loading'),failed:t('failed'),timeout:t('timeout'),retry:t('retry'),refresh:t('refresh')}}
  requestKey={JSON.stringify([employmentId,after,locale])} read={read} regionRef={region}
  footer={after?<Button type="button" variant="outline" className="min-h-11 whitespace-normal" onClick={()=>changePage([undefined])}>{t('firstPage')}</Button>:undefined}>
  {value=><div className="space-y-4">
   {value.scope==='off'?<p className="text-sm leading-relaxed text-muted-foreground">{t('off')}</p>:<>
    <p className="text-sm leading-relaxed text-muted-foreground">{t('window',{from:formatDate(value.from),to:formatDate(value.to)})}</p>
    {value.items.length===0?<p className="text-sm leading-relaxed text-muted-foreground">{t('empty')}</p>:
     <ul className="divide-y">{value.items.map(item=><li key={JSON.stringify([item.date,item.kind,item.employmentId])} className="space-y-1 py-3 text-sm leading-relaxed [overflow-wrap:anywhere]">
      <p className="font-medium">{item.name??t('unnamed')}</p>
      <p>{t(item.kind==='birthday'?'birthday':item.years===null?'anniversary':'anniversaryYears',item.years===null?{}:{count:item.years})}</p>
      <time dateTime={item.date} className="block text-xs text-muted-foreground">{formatDate(item.date)}</time>
     </li>)}</ul>}
    <div className="flex flex-wrap items-center justify-between gap-3">
     <p className="text-xs text-muted-foreground">{t('total',{count:value.total})}</p>
     <nav className="flex flex-wrap gap-2" aria-label={t('pagination')}>
      {pages.length>1&&<Button type="button" variant="outline" className="min-h-11 whitespace-normal" onClick={()=>changePage(pages.slice(0,-1))}>{t('previous')}</Button>}
      {value.nextCursor&&<Button type="button" variant="outline" className="min-h-11 whitespace-normal" onClick={()=>changePage([...pages,value.nextCursor!])}>{t('next')}</Button>}
     </nav>
    </div>
   </>}
  </div>}
 </IndependentHomeCard>;
}
