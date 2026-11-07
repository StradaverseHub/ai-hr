'use client';

import {useEffect, useId, useState} from 'react';
import {useTranslations} from 'next-intl';
import {EMPLOYEE_CHOICE_PAGE_SIZE, employeeChoiceKey, isEmployeeChoicePage, type EmployeeChoicePage} from '@/lib/employee-choice';

/** A form-GET field: loading navigation options never submits the report or changes its filters.
 * The first list is requested only when opened. The selected label is an independent server read,
 * so a deep selection remains visible without serializing the whole workforce into the form. */
export function EmployeeChoiceField({name, label, allLabel, selectedId, selected}: {
  name:string;
  label:string;
  allLabel:string;
  selectedId?:string;
  selected:{employmentId:string;name:string}|null;
}) {
  const t=useTranslations('employeePanel'), id=useId();
  const [open,setOpen]=useState(false), [query,setQuery]=useState(''), [offset,setOffset]=useState(0), [retry,setRetry]=useState(0);
  const [value,setValue]=useState(selectedId??'');
  const [result,setResult]=useState<{key:string;data?:EmployeeChoicePage;failed?:true}|null>(null);
  const filters={query,companyId:'',businessUnitId:'',departmentId:'',status:''};
  const key=employeeChoiceKey(filters,offset,'names')+':'+retry;
  const current=result?.key===key?result:null;
  const loading=open&&!current;
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();let active=true;
    const timer=setTimeout(()=>{
      void fetch('/api/employee-choices',{
        method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',credentials:'same-origin',signal:controller.signal,
        body:JSON.stringify({query,offset,limit:EMPLOYEE_CHOICE_PAGE_SIZE,selectedId:selectedId||undefined,labelMode:'names'}),
      }).then(async response=>{
        if(!response.ok)throw Error('Employee choices unavailable');
        const data:unknown=await response.json();
        if(!isEmployeeChoicePage(data)||data.limit!==EMPLOYEE_CHOICE_PAGE_SIZE
          ||employeeChoiceKey(data.filters,data.offset,data.labelMode)!==employeeChoiceKey(filters,offset,'names')
          ||data.selected!==null&&data.selected.employmentId!==selectedId)throw Error('Employee choices unavailable');
        if(active)setResult({key,data});
      }).catch(()=>{if(active&&!controller.signal.aborted)setResult({key,failed:true});});
    },query?180:0);
    return()=>{active=false;clearTimeout(timer);controller.abort();};
  },[open,key,query,offset,selectedId]);
  const rows=current?.data?.rows??[];
  const selectedChoice=current?.data?.selected??selected;
  const selectedOutsidePage=value&&!rows.some(row=>row.employmentId===value);
  return <details className="space-y-1" open={open} onToggle={event=>{
    const next=event.currentTarget.open;
    if(!next)setResult(null);
    setOpen(next);
  }}>
    <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{label}: {selectedChoice?.name??(value?'—':allLabel)}</summary>
    <div className="space-y-2 rounded-md border border-border p-2">
      <label htmlFor={id+'-search'} className="block text-xs text-muted-foreground">{t('searchLabel')}</label>
      <input id={id+'-search'} type="search" value={query} onChange={event=>{setQuery(event.target.value);setOffset(0);}}
        placeholder={t('searchPlaceholder')} className="h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm" />
      {loading&&<p role="status" className="text-xs text-muted-foreground">{t('loadingEmployees')}</p>}
      {current?.failed&&<div role="alert" className="text-xs"><p>{t('loadFailed')}</p><button type="button" onClick={()=>setRetry(n=>n+1)}>{t('retry')}</button></div>}
      <label htmlFor={id+'-select'} className="sr-only">{label}</label>
      <select id={id+'-select'} name={name} value={value} className="h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm"
        onChange={event=>{setValue(event.target.value);event.currentTarget.form?.requestSubmit();}}>
        <option value="">{allLabel}</option>
        {selectedOutsidePage&&<option value={value}>{selectedChoice?.name??'—'}</option>}
        {rows.map(row=><option key={row.employmentId} value={row.employmentId}>{row.name}</option>)}
      </select>
      {current?.data&&<div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <button type="button" disabled={offset===0} onClick={()=>setOffset(n=>Math.max(0,n-EMPLOYEE_CHOICE_PAGE_SIZE))}>{t('previousPage')}</button>
        <span>{t('pageRange',{from:rows.length?offset+1:0,to:rows.length?offset+rows.length:0,total:current.data.total})}</span>
        <button type="button" disabled={offset+rows.length>=current.data.total} onClick={()=>setOffset(n=>n+EMPLOYEE_CHOICE_PAGE_SIZE)}>{t('nextPage')}</button>
      </div>}
      {current?.data&&rows.length===0&&<p className="text-xs text-muted-foreground">{t('noEmployees')}</p>}
    </div>
  </details>;
}
