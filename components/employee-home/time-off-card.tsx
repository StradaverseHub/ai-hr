'use client';

import * as React from 'react';
import Link from 'next/link';
import {useLocale,useTranslations} from 'next-intl';
import {IndependentHomeCard} from './home-card';
import type {EmployeeHomeTimeOff} from '@/lib/employee-home-read-model';
import {formatDays} from '@/lib/day-format';

/** One independent read; every application uses the existing leave form and writer. Displaying the
 * available value never subtracts a pending commitment a second time or creates a leave allocation. */
export function HomeTimeOffCard({employmentId}:{employmentId:string}){
 const t=useTranslations('employeeHome.timeOff'),locale=useLocale();
 const read=React.useCallback(async(signal:AbortSignal):Promise<EmployeeHomeTimeOff>=>{
  const response=await fetch('/api/home/time-off?'+new URLSearchParams({employmentId}),{signal,cache:'no-store',credentials:'same-origin'});
  if(!response.ok)throw Error('Time Off unavailable');
  const value:EmployeeHomeTimeOff=await response.json();
  const figure=(n:unknown)=>n===null||typeof n==='number'&&Number.isFinite(n);
  if(value.version!==1||value.employmentId!==employmentId||!/^\d{4}-\d{2}-\d{2}$/.test(value.asOf)||typeof value.canApply!=='boolean'
   ||!Array.isArray(value.balances)||value.balances.length>100||value.balances.some(row=>!row||typeof row.id!=='string'||!row.id||typeof row.name!=='string'||!row.name.trim()||!figure(row.available)||!figure(row.pending))
   ||new Set(value.balances.map(row=>row.id)).size!==value.balances.length
   ||value.nextApproved!==null&&(!value.nextApproved||typeof value.nextApproved.requestId!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value.nextApproved.date)||!['full_day','part_day'].includes(value.nextApproved.duration)))throw Error('Time Off unavailable');
  return value;
 },[employmentId,locale]);
 const fmtDate=(date:string)=>new Intl.DateTimeFormat(locale,{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(date+'T00:00:00Z'));
 return <IndependentHomeCard card="timeOff" title={t('title')} labels={{loading:t('loading'),failed:t('failed'),timeout:t('timeout'),retry:t('retry'),refresh:t('refresh')}}
  requestKey={`${employmentId}:${locale}`} read={read}>{value=><div className="space-y-5">
   {value.balances.length===0?<p className="text-sm leading-relaxed text-muted-foreground">{t('empty')}</p>:
    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">{value.balances.slice(0,4).map(row=><div key={row.id} className="min-w-0 rounded-lg border p-4">
     <dt className="break-words text-sm font-medium">{row.name}</dt>
     <dd className="mt-2"><span className="block text-2xl font-semibold tabular-nums">{row.available===null?t('notShown'):formatDays(row.available)}</span>
      <span className="mt-1 block text-sm text-muted-foreground">{t('available')}</span>
      {row.pending!==null&&<span className="mt-2 block text-sm text-muted-foreground">{t('pending',{days:formatDays(row.pending)})}</span>}
     </dd>
    </div>)}</dl>}
   {value.balances.length>4&&<p className="text-sm text-muted-foreground">{t('moreTypes',{count:value.balances.length-4})}</p>}
   <p className="text-sm leading-relaxed">{value.nextApproved?t('next',{date:fmtDate(value.nextApproved.date),duration:t(value.nextApproved.duration)}):t('noNext')}</p>
   <div className="flex flex-wrap items-center justify-between gap-3">
    <p className="text-xs text-muted-foreground">{t('asOf',{date:fmtDate(value.asOf)})}</p>
    {value.canApply&&<Link className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" href={'/leave?'+new URLSearchParams({apply:'1',employmentId})}>{t('plan')}</Link>}
   </div>
  </div>}</IndependentHomeCard>;
}
