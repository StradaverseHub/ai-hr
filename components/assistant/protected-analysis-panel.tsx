'use client';

import {useEffect,useId,useRef,useState} from 'react';
import {protectedAnalysisAction,type ProtectedAnalysisDomain,type ProtectedAnalysisNotice} from '@/app/analytics/ai-actions';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {previousPayrollComparisonPeriod} from '@/lib/payroll-period-comparison';
import {ThinkingIndicator} from './thinking-indicator';

export type ProtectedAnalysisLabels={title:string;description:string;companyScope:string;domain:string;month:string;compareWindow:string;snapshotWindow:string;run:string;thinking:string;result:string;
 domains:Record<ProtectedAnalysisDomain,string>;notices:Record<ProtectedAnalysisNotice,string>};
/** scopeKey is the sorted server-selected company IDs serialized as JSON, matching the action result.
 * The parent changes it whenever the current company context changes. It is display custody only. */
export function ProtectedAnalysisPanel({labels,scopeKey,defaultMonth}:{labels:ProtectedAnalysisLabels;scopeKey:string;defaultMonth?:string}){
 const id=useId(),[domain,setDomain]=useState<ProtectedAnalysisDomain>('workforce');
 const [month,setMonth]=useState(()=>defaultMonth??previousPayrollComparisonPeriod(todayInKualaLumpur().slice(0,7)));
 const [pending,setPending]=useState(false),[text,setText]=useState(''),[notice,setNotice]=useState<ProtectedAnalysisNotice|null>(null);
 const current=useRef({scopeKey,domain,month}),sequence=useRef(0),busy=useRef(false);
 current.current={scopeKey,domain,month};
 const monthly=domain==='workforce'||domain==='attendance'||domain==='payroll';
 useEffect(()=>{sequence.current++;busy.current=false;setPending(false);setText('');setNotice(null);},[scopeKey,domain,month]);
 useEffect(()=>()=>{sequence.current++;},[]);
 async function run(){
  if(busy.current)return;busy.current=true;setPending(true);setText('');setNotice(null);
  const request=++sequence.current,captured={scopeKey,domain,month};
  try{
   const result=await protectedAnalysisAction({domain,...(monthly?{month}:{})});
   if(request!==sequence.current||captured.scopeKey!==current.current.scopeKey||captured.domain!==current.current.domain||captured.month!==current.current.month)return;
   if(result.ok){if(result.scopeKey!==captured.scopeKey)setNotice('unavailable');else setText(result.text);}
   else setNotice(result.notice);
  }catch{
   if(request===sequence.current)setNotice('failed');
  }finally{if(request===sequence.current){busy.current=false;setPending(false);}}
 }
 return <section aria-labelledby={`${id}-title`} className="space-y-4 rounded-xl border bg-card p-5">
  <div className="space-y-1.5"><h2 id={`${id}-title`} className="text-lg font-semibold">{labels.title}</h2><p className="text-sm text-muted-foreground">{labels.description}</p></div>
  <p className="text-sm font-medium">{labels.companyScope}</p>
  <div className="flex flex-wrap items-end gap-3">
   <label className="grid gap-1.5 text-sm" htmlFor={`${id}-domain`}>{labels.domain}<select id={`${id}-domain`} value={domain} disabled={pending} onChange={event=>setDomain(event.target.value as ProtectedAnalysisDomain)} className="min-h-10 rounded-md border bg-background px-3">
    {(Object.keys(labels.domains) as ProtectedAnalysisDomain[]).map(value=><option key={value} value={value}>{labels.domains[value]}</option>)}
   </select></label>
   {monthly&&<label className="grid gap-1.5 text-sm" htmlFor={`${id}-month`}>{labels.month}<input id={`${id}-month`} type="month" value={month} max={previousPayrollComparisonPeriod(todayInKualaLumpur().slice(0,7))} disabled={pending} onChange={event=>setMonth(event.target.value)} className="min-h-10 rounded-md border bg-background px-3"/></label>}
   <button type="button" disabled={pending||!scopeKey} onClick={run} className="min-h-10 rounded-md border px-4 text-sm font-medium disabled:opacity-50">{labels.run}</button>
  </div>
  <p className="text-xs text-muted-foreground">{domain==='workforce'||domain==='payroll'?labels.compareWindow:labels.snapshotWindow}</p>
  {pending&&<ThinkingIndicator label={labels.thinking}/>}
  {notice&&<p role="status" className="text-sm text-muted-foreground">{labels.notices[notice]}</p>}
  {text&&<div aria-label={labels.result} className="whitespace-pre-wrap text-sm leading-relaxed">{text}</div>}
 </section>;
}
