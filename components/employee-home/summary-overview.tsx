'use client';

import * as React from 'react';
import Link from 'next/link';
import {useLocale,useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {useNavIndex} from '@/components/nav-index-context';
import {deliverHomeCard,type HomeCardDelivery} from '@/lib/employee-home-delivery';
import {homeQuickActionHref,homeSummaryHref,validateEmployeeHomeSummary,type EmployeeHomeSummary} from '@/lib/employee-home-summary';

/** An independently delivered subsection: a greeting failure cannot prevent these reads, and a
 * summary failure cannot replace the greeting/search or assert a calm day. No write on mount. */
export function HomeSummaryOverview({employmentId}:{employmentId:string}){
 const t=useTranslations('employeeHome.summary'),actions=useTranslations('employeeHome.quickActions'),locale=useLocale();
 const {entries}=useNavIndex(),titleId=React.useId(),quickId=React.useId();
 const [attempt,setAttempt]=React.useState(0),[refresh,setRefresh]=React.useState(0);
 const key=JSON.stringify([employmentId,locale,attempt,refresh]);
 const [view,setView]=React.useState<{key:string;result:HomeCardDelivery<EmployeeHomeSummary>|{state:'loading'}}>({key,result:{state:'loading'}});
 const result=view.key===key?view.result:{state:'loading' as const};
 React.useEffect(()=>{
  const update=()=>{if(document.visibilityState==='visible')setRefresh(value=>value+1);};
  window.addEventListener('focus',update);document.addEventListener('visibilitychange',update);
  const timer=window.setInterval(update,60000);
  return ()=>{window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',update);window.clearInterval(timer);};
 },[]);
 React.useEffect(()=>{
  const controller=new AbortController();let current=true;
  void deliverHomeCard(async signal=>{
   const response=await fetch('/api/home/summary?'+new URLSearchParams({employmentId}),{signal,cache:'no-store',credentials:'same-origin'});
   if(!response.ok)throw Error('Home summary unavailable');
   return validateEmployeeHomeSummary(await response.json(),employmentId);
  },{signal:controller.signal}).then(result=>{if(current&&result.state!=='cancelled')setView({key,result});});
  return ()=>{current=false;controller.abort();};
 },[key,employmentId]);
 const routes=new Set(entries.map(row=>row.href.split('?')[0]));
 // The rail is the owner of visible navigation. Calendar/payslip/profile are own-profile children;
 // they additionally require the server's current subject/module/field/publication capability.
 const visible=(key:string)=>routes.has(key==='leave'?'/leave':key==='claim'?'/claims':key==='notices'?'/notices':'/me');
 return <section aria-labelledby={titleId} aria-busy={result.state==='loading'} className="space-y-4 border-t border-border pt-5">
  <div className="flex flex-wrap items-center justify-between gap-3"><h3 id={titleId} className="text-sm font-semibold">{t('title')}</h3>
   <Button type="button" variant="outline" className="min-h-11" disabled={result.state==='loading'} onClick={()=>setAttempt(value=>value+1)}
    aria-label={`${result.state==='failed'?t('retry'):t('refresh')}: ${t('title')}`}>{result.state==='failed'?t('retry'):t('refresh')}</Button>
  </div>
  {result.state==='loading'?<p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>:
   result.state==='failed'?<p role="alert" className="text-sm">{t(result.reason==='timeout'?'timeout':'failed')}</p>:
   result.state==='ready'?<>
    {result.value.items.length>0&&<ul className="space-y-2 text-sm leading-relaxed">{result.value.items.map(item=>{
     const href=homeSummaryHref(item.destination,employmentId);
     return <li key={item.key} className="break-words">{href?<Link href={href} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{item.message}</Link>:item.message}</li>;
    })}</ul>}
    {result.value.calm&&<p className="text-sm leading-relaxed text-muted-foreground">{result.value.calm}</p>}
    {result.value.quickActions.some(row=>visible(row.key))&&<nav aria-labelledby={quickId} className="space-y-3">
     <h3 id={quickId} className="text-sm font-semibold">{t('quickTitle')}</h3>
     <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{result.value.quickActions.filter(row=>visible(row.key)).map(row=>{
      const reasonId=quickId+'-'+row.key;
      return <div key={row.key} className="min-w-0">{row.reason?<>
       <Button type="button" variant="outline" className="min-h-11 w-full whitespace-normal" disabled aria-describedby={reasonId}>{actions(row.key)}</Button>
       <p id={reasonId} className="mt-1 text-xs leading-relaxed text-muted-foreground">{t(row.reason)}</p>
      </>:<Link href={homeQuickActionHref(row.key,employmentId)} className="flex min-h-11 items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-center text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{actions(row.key)}</Link>}</div>;
     })}</div>
    </nav>}
   </>:null}
 </section>;
}
