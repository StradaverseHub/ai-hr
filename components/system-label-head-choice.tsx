'use client';

import {useEffect,useId,useState} from 'react';
import {useTranslations} from 'next-intl';
import {isLabelHeadChoicePage,labelHeadChoiceLabel,labelHeadChoiceRequestKey,type LabelHeadChoicePage} from '@/lib/system-label-head-choice';

/** A bounded navigation control inside the existing JS-owned atomic Grid draft. */
export function SystemLabelHeadChoice({companyId,value,label,noneLabel,unavailableLabel,selectedLabel,className,onChange}:{
 companyId:string;value:string|null;label:string;noneLabel:string;unavailableLabel:string;selectedLabel:string;className?:string;onChange:(value:string|null)=>void;
}){
 const t=useTranslations('employeePanel'),id=useId(),selectedId=value?.toLowerCase()??'';
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[offset,setOffset]=useState(0),[retry,setRetry]=useState(0);
 const [result,setResult]=useState<{key:string;data?:LabelHeadChoicePage;failed?:true}|null>(null);
 const [picked,setPicked]=useState<{companyId:string;id:string;label:string}|null>(null);
 const requestKey=labelHeadChoiceRequestKey(companyId,query,offset,selectedId),key=requestKey+':'+retry;
 const current=result?.key===key?result:null,rows=current?.data?.rows??[];
 useEffect(()=>{
  if(!open||!companyId)return;
  const controller=new AbortController();let active=true;
  const timer=setTimeout(()=>{
   void fetch('/admin/settings/system-labels/head-choices',{
    method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',credentials:'same-origin',signal:controller.signal,
    body:JSON.stringify({companyId,query,offset,...(selectedId?{selectedId}:{})}),
   }).then(async response=>{
    if(!response.ok)throw Error('Head choices unavailable');
    const page:unknown=await response.json();
    if(!isLabelHeadChoicePage(page)||labelHeadChoiceRequestKey(page.companyId,page.query,page.offset,selectedId)!==requestKey
      ||page.selected!==null&&page.selected.employmentId!==selectedId)throw Error('Head choices unavailable');
    if(active)setResult({key,data:page});
   }).catch(()=>{if(active&&!controller.signal.aborted)setResult({key,failed:true});});
  },query?180:0);
  return()=>{active=false;clearTimeout(timer);controller.abort();};
 },[open,companyId,query,offset,selectedId,requestKey,key]);
 const local=picked?.companyId===companyId&&picked.id===selectedId?picked.label:selectedLabel;
 const pinnedLabel=current?.data?(current.data.selected?labelHeadChoiceLabel(current.data.selected):unavailableLabel):local;
 return <div className="min-w-0 space-y-1">
  <select name="headEmploymentId" aria-label={label} value={selectedId} className={className}
   onChange={event=>{
    const next=event.target.value,option=rows.find(row=>row.employmentId===next);
    setPicked(option?{companyId,id:next,label:labelHeadChoiceLabel(option)}:null);onChange(next||null);
   }}>
   <option value="">{noneLabel}</option>
   {selectedId&&!rows.some(row=>row.employmentId===selectedId)&&<option value={selectedId}>{pinnedLabel}</option>}
   {rows.map(row=><option key={row.employmentId} value={row.employmentId}>{labelHeadChoiceLabel(row)}</option>)}
  </select>
  <details open={open} onToggle={event=>{setOpen(event.currentTarget.open);if(!event.currentTarget.open)setResult(null);}}>
   <summary className="cursor-pointer text-xs text-muted-foreground">{t('searchLabel')}</summary>
   <div className="space-y-1 rounded border border-border p-2">
    <label htmlFor={id} className="sr-only">{t('searchLabel')}</label>
    <input id={id} type="search" value={query} onChange={event=>{setQuery(event.target.value);setOffset(0);}}
     placeholder={t('searchPlaceholder')} className="w-full rounded border border-input bg-background px-2 py-1 text-xs"/>
    {!current&&<p role="status" className="text-xs">{t('loadingEmployees')}</p>}
    {current?.failed&&<div role="alert" className="text-xs"><p>{t('loadFailed')}</p><button type="button" onClick={()=>setRetry(n=>n+1)}>{t('retry')}</button></div>}
    {current?.data&&<div className="flex flex-wrap items-center justify-between gap-2 text-xs">
     <button type="button" disabled={offset===0} onClick={()=>setOffset(n=>Math.max(0,n-25))}>{t('previousPage')}</button>
     <span>{t('pageRange',{from:rows.length?offset+1:0,to:rows.length?offset+rows.length:0,total:current.data.total})}</span>
     <button type="button" disabled={offset+rows.length>=current.data.total} onClick={()=>setOffset(n=>n+25)}>{t('nextPage')}</button>
    </div>}
    {current?.data&&!rows.length&&<p className="text-xs">{t('noEmployees')}</p>}
   </div>
  </details>
 </div>;
}
