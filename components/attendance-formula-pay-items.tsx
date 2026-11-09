'use client';

import {useState,useTransition} from 'react';
import {useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {readAttendancePayItemAction} from '@/app/attendance/individual/[date]/formula-actions';
import type {listAttendanceFormulaResults,readAttendanceFormulaResult} from '@/packs/attendance/service';
import type {FormulaTraceEvent,FormulaValue} from '@/lib/pay-formula-language';

type Rows = Awaited<ReturnType<typeof listAttendanceFormulaResults>>;
type Detail = Awaited<ReturnType<typeof readAttendanceFormulaResult>>;
type FormulaRequest = {code:string;args:{value:unknown}[]};

export function AttendanceFormulaHistory({rows}:{rows:Rows}) {
 const t=useTranslations('attendanceFormula');
 const [pending,start]=useTransition();
 const [error,setError]=useState('');
 const [detail,setDetail]=useState<Detail|null>(null);
 function openEvidence(id:string) {
  setError('');
  start(async()=>{
   const response=await readAttendancePayItemAction(id);
   if(response.ok) setDetail(response.value);
   else setError(response.error);
  });
 }
 return (
  <section className="space-y-5 border-t border-border pt-6" aria-labelledby="attendance-formula-history">
   <h2 id="attendance-formula-history" className="text-lg font-semibold">{t('retiredHistory')}</h2>
   {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
   <div className="overflow-x-auto">
    <table className="w-full min-w-[48rem] text-left text-sm">
     <thead>
      <tr className="border-b border-border">
       {['payItem','code','period','quantity','rate','amount','status','actions'].map(key=>(
        <th key={key} scope="col" className="px-3 py-3 font-medium">{t(key)}</th>
       ))}
      </tr>
     </thead>
     <tbody>
      {rows.map(row=>(
       <tr key={row.result.id} className="border-b border-border align-top">
        <td className="px-3 py-3">{row.payCode}<span className="block text-muted-foreground">{row.payName}</span></td>
        <td className="px-3 py-3">{row.code}<span className="block text-muted-foreground">{t('versionNumber',{version:row.version})}</span>
         <span className="block max-w-64 text-muted-foreground">{row.definition.description}</span></td>
        <td className="px-3 py-3 tabular-nums">{row.result.periodFrom} – {row.result.periodTo}
         <span className="block text-muted-foreground">{t(row.definition.period.method)}</span></td>
        <td className="px-3 py-3 tabular-nums">{row.result.quantity} {t(row.result.unit)}</td>
        <td className="px-3 py-3 tabular-nums">{row.result.rate??'—'}</td>
        <td className="px-3 py-3 tabular-nums">RM {row.result.amount}</td>
        <td className="px-3 py-3">{t('resultStates.'+row.state)}</td>
        <td className="px-3 py-3"><Button type="button" size="sm" variant="ghost" disabled={pending}
         onClick={()=>openEvidence(row.result.id)}>{t('viewEvidence')}</Button></td>
       </tr>
      ))}
     </tbody>
    </table>
   </div>
   {detail&&<div className="space-y-3"><HistoricalEvidence proof={detail}/>
    <Button type="button" variant="ghost" onClick={()=>setDetail(null)}>{t('closeEvidence')}</Button>
   </div>}
  </section>
 );
}

function HistoricalEvidence({proof}:{proof:Pick<Detail,'payload'|'periodFrom'|'periodTo'>}){const t=useTranslations('attendanceFormula'),result=proof.payload.result as {amount?:string;trace?:{formula:string;event:FormulaTraceEvent;request?:FormulaRequest}[]},days=proof.payload.days as {date:string;values:Record<string,{state:string;value?:{value:unknown};source?:string;revision?:string;reason?:string}>}[];return <div className="space-y-4 rounded-xl border border-border p-4"><h3 className="font-semibold">{t('result',{amount:result.amount??'—'})}</h3><p className="text-sm tabular-nums">{proof.periodFrom} – {proof.periodTo}</p><details><summary className="cursor-pointer text-sm font-medium">{t('calculationTrace')}</summary><ol className="mt-3 space-y-2 text-sm">{result.trace?.map((step,index)=><li key={index} className="break-words"><p className="font-medium">{step.formula} · {t('traceLine',{line:step.event.loc.line})}</p><TraceStep event={step.event} request={step.request}/></li>)}</ol></details><details><summary className="cursor-pointer text-sm font-medium">{t('sourceEvidence')}</summary><div className="mt-3 space-y-3">{days?.map(day=><details key={day.date}><summary className="cursor-pointer text-sm tabular-nums">{day.date}</summary><dl className="mt-2 divide-y divide-border">{Object.entries(day.values).filter(([,fact])=>fact.state==='known').map(([key,fact])=><div key={key} className="grid gap-1 py-2 text-xs sm:grid-cols-2"><dt className="break-all font-mono">{key}</dt><dd className="break-all">{String(fact.value?.value)} · {fact.source}<span className="block text-muted-foreground">{fact.revision}</span></dd></div>)}</dl></details>)}</div></details></div>;}

function TraceStep({event,request}:{event:FormulaTraceEvent;request?:FormulaRequest}){
 const t=useTranslations('attendanceFormula'),value=(v:FormulaValue)=>v.type==='boolean'?t(v.value?'true':'false'):String(v.value);
 switch(event.kind){
  case 'read':return <p>{t('traceRead',{reference:request?request.code+'('+request.args.map(arg=>String(arg.value)).join(', ')+')':event.code,value:value(event.value)})}</p>;
  case 'arithmetic':return <p className="tabular-nums">{event.left} {event.operator} {event.right} = {event.result}</p>;
  case 'condition':return <p>{t('traceCondition',{value:t(event.value?'true':'false')})}</p>;
  case 'otherwise':return <p>{t('traceElse')}</p>;
  case 'set':return <p>{t('traceSet',{name:event.name,value:value(event.value)})}</p>;
  case 'return':return <p className="font-medium tabular-nums">{t('traceReturn',{value:value(event.value)})}</p>;
  case 'explain':return <p className="whitespace-pre-wrap">{event.text}</p>;
 }
}
