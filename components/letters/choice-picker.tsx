'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {inputCls} from '@/components/ui';
import type {LetterChoice,LetterChoices,LetterChoiceKind} from '@/lib/letter-choice';
export type LetterChoiceLabels={search:string;find:string;more:string;choose:string;loading:string;empty:string;error:string};
/** Searches do not navigate or submit the surrounding draft form. Selection is always explicit. */
export function LetterChoicePicker({companyId,kind,labels,onChoose}:{companyId:string;kind:LetterChoiceKind;labels:LetterChoiceLabels;onChoose:(choice:LetterChoice)=>void}){
 const id=useId(),[query,setQuery]=useState(''),[searched,setSearched]=useState(''),[result,setResult]=useState<LetterChoices|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(false),controller=useRef<AbortController|null>(null);
 useEffect(()=>{setResult(null);setError(false);setLoading(false);setQuery('');setSearched('');return()=>controller.current?.abort();},[companyId,kind]);
 async function search(more=false){
  controller.current?.abort();const request=new AbortController();controller.current=request;setLoading(true);setError(false);
  const value=more?searched:query,params=new URLSearchParams({companyId,kind,q:value});if(more&&result?.nextCursor)params.set('after',result.nextCursor);
  try{const response=await fetch('/letters/templates/options?'+params,{cache:'no-store',signal:request.signal});if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))throw new Error('choice');const page=await response.json() as LetterChoices;
   if(!Array.isArray(page.rows)||page.rows.length>25||page.rows.some(row=>typeof row.id!=='string'||typeof row.label!=='string')||page.nextCursor!==null&&typeof page.nextCursor!=='string')throw new Error('choice');
   if(request.signal.aborted)return;setSearched(value);setResult(previous=>({rows:more&&previous?[...new Map([...previous.rows,...page.rows].map(row=>[row.id,row])).values()]:page.rows,nextCursor:page.nextCursor}));
  }catch{if(!request.signal.aborted)setError(true);}finally{if(controller.current===request)setLoading(false);}
 }
 return <div className="space-y-3 rounded-md border p-3"><div className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 space-y-1 text-sm" htmlFor={id}><span>{labels.search}</span><input id={id} className={`${inputCls} min-h-11`} maxLength={200} value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();void search();}}}/></label><button type="button" className="min-h-11 rounded border px-3 text-sm disabled:opacity-50" disabled={loading} onClick={()=>void search()}>{loading?labels.loading:labels.find}</button></div>{error&&<p role="alert" className="text-sm text-destructive">{labels.error}</p>}{result&&<div aria-live="polite" className="space-y-2">{!result.rows.length&&<p className="text-sm text-muted-foreground">{labels.empty}</p>}{result.rows.map(row=><div key={row.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-2 text-sm"><span className="min-w-0 break-words">{row.label}{row.field&&<span className="ml-2 font-mono text-xs">v{row.field.ordinal}</span>}</span><button type="button" className="min-h-11 rounded border px-3" disabled={loading} aria-label={labels.choose+': '+row.label} onClick={()=>onChoose(row)}>{labels.choose}</button></div>)}{result.nextCursor&&<button type="button" className="min-h-11 rounded border px-3 text-sm" disabled={loading} onClick={()=>void search(true)}>{labels.more}</button>}</div>}</div>;
}
