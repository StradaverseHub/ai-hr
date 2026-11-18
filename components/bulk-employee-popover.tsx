'use client';
import {useCallback,useMemo} from 'react';
import {useTranslations} from 'next-intl';
import {MultiSelectPopover,type MultiSelectPopoverOption} from './ui/multi-select-popover';
import type {ComponentProps} from 'react';
import type {EmployeePickOption} from '@/lib/employment-selection';
export function BulkEmployeePopover({onRows,...props}:Omit<ComponentProps<typeof MultiSelectPopover>,'remote'>&{onRows:(rows:EmployeePickOption[])=>void}){
 const t=useTranslations('employeePanel');
 const load=useCallback(async(query:string,offset:number,all:boolean,signal:AbortSignal)=>{
  const response=await fetch('/api/bulk-employee-choices',{method:'POST',credentials:'same-origin',cache:'no-store',signal,
   headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:all?'all':'page',query,offset})});
  if(!response.ok)throw Error('Unavailable');
  const data=await response.json();
  if(!data||data.query!==query||data.offset!==offset||!Number.isSafeInteger(data.total)||data.total<0||!Array.isArray(data.rows)||data.rows.length>25
   ||data.rows.length!==Math.min(25,Math.max(0,data.total-offset))||new Set(data.rows.map((row:EmployeePickOption)=>row.id)).size!==data.rows.length
   ||data.rows.some((row:EmployeePickOption)=>!row||typeof row.id!=='string'||typeof row.name!=='string'||row.employeeCode!==null&&typeof row.employeeCode!=='string')
   ||all&&(!Array.isArray(data.ids)||data.ids.length!==data.total||data.ids.some((id:unknown)=>typeof id!=='string')||new Set(data.ids).size!==data.total))throw Error('Unavailable');
  if(!signal.aborted)onRows(data.rows);
  return {options:data.rows.map((row:EmployeePickOption):MultiSelectPopoverOption=>({id:row.id,name:row.employeeCode?`${row.name} · ${row.employeeCode}`:row.name})),total:data.total,ids:data.ids as string[]|undefined};
 },[onRows]);
 const remote=useMemo(()=>({load,loadingLabel:t('loadingEmployees'),failedLabel:t('loadFailed'),retryLabel:t('retry'),previousLabel:t('previousPage'),nextLabel:t('nextPage'),range:(from:number,to:number,total:number)=>t('pageRange',{from,to,total})}),[load,t]);
 return <MultiSelectPopover {...props} remote={remote}/>;
}

export function BulkEmployeeSelectionStatus({pending,failed,retry}:{pending:boolean;failed:boolean;retry:()=>void}){
 const t=useTranslations('employeePanel');
 return failed?<div role="alert" className="text-xs"><p>{t('loadFailed')}</p><button type="button" onClick={retry}>{t('retry')}</button></div>
  :pending?<p role="status" className="text-xs text-muted-foreground">{t('loadingEmployees')}</p>:null;
}
