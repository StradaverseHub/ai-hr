'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {useTranslations} from 'next-intl';
import {Button,inputCls} from '@/components/ui';
import {typeLabelCls} from '@/components/ui/section-card';
export type CriteriaEmployee={id:string;name:string;employeeCode?:string|null;company?:string;terminatedOn?:string|null};
export const criteriaEmployeeLabel=(person:Pick<CriteriaEmployee,'name'|'employeeCode'>)=>person.employeeCode?`${person.employeeCode} · ${person.name}`:person.name;
/** Board 03cb9b74: the Employee / Employees criterion as a search (Employee ID or name, 50 a page) instead of a list of
 * every employment in scope. The selected ids are the same `employeeIds` values as before; labels of a saved
 * selection arrive with the page, others are learnt from the search and reported to the group summary. */
export function EmployeeCriteriaPicker({name,label,value,known,companyIds,onChange,onLearn}:{name:string;label:string;value:string[];known:ReadonlyMap<string,CriteriaEmployee>;companyIds:string[];onChange:(ids:string[])=>void;onLearn:(rows:CriteriaEmployee[])=>void}){
 const t=useTranslations('attendanceWorkflow'),v4=useTranslations('attendanceWorkflow.v4'),choices=useTranslations('admin.leave');
 const id=useId(),labelId=id+'-label',root=useRef<HTMLDivElement>(null),companyKey=companyIds.join(',');
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[cursors,setCursors]=useState<({name:string;id:string}|null)[]>([null]);
 const [rows,setRows]=useState<CriteriaEmployee[]>([]),[more,setMore]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 const learn=useRef(onLearn);learn.current=onLearn;
 const after=cursors[cursors.length-1];
 useEffect(()=>{if(!open||!companyKey)return;let current=true;setPending(true);const timer=setTimeout(async()=>{try{const {searchAttendanceWorkflowEmployeesAction}=await import('./actions');const response=await searchAttendanceWorkflowEmployeesAction({companyIds:companyKey.split(','),query,after});if(!current)return;if(response.ok){setRows(response.value.rows);setMore(response.value.more);learn.current(response.value.rows);setError('');}else{setRows([]);setMore(false);setError(response.error);}}catch{if(current){setRows([]);setError(t('requestFailed'));}}finally{if(current)setPending(false);}},200);return()=>{current=false;clearTimeout(timer);};},[companyKey,query,after,open,retry,t]);
 useEffect(()=>{const close=(event:MouseEvent)=>{if(root.current&&!root.current.contains(event.target as Node))setOpen(false);};document.addEventListener('mousedown',close);return()=>document.removeEventListener('mousedown',close);},[]);
 const text=(key:string)=>{const person=known.get(key);return person?criteriaEmployeeLabel(person):t('unavailable',{value:key});};
 return <div ref={root} className="space-y-2" onKeyDown={event=>{if(event.key==='Escape'&&open){setOpen(false);root.current?.querySelector<HTMLButtonElement>('button')?.focus();}}}>
  <span id={labelId} className={'block '+typeLabelCls}>{label}</span>
  {value.map(key=><input key={key} type="hidden" name={name} value={key}/>)}
  <Button type="button" variant="outline" className="min-h-11 w-full justify-start font-normal text-muted-foreground" aria-labelledby={labelId} aria-expanded={open} aria-controls={id} onClick={()=>setOpen(!open)}>{v4('searchEmployees')}</Button>
  {!!value.length&&<div className="flex flex-wrap gap-2">{value.map(key=><span key={key} className="inline-flex max-w-full items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-sm text-primary"><span className="min-w-0 break-words">{text(key)}</span><button type="button" className="min-h-6 rounded px-1 hover:bg-primary/20" aria-label={choices('chipRemoveAria',{name:text(key)})} onClick={()=>onChange(value.filter(item=>item!==key))}>×</button></span>)}</div>}
  {open&&<div id={id} className="space-y-3 rounded-lg border border-border bg-card p-3"><label className="block text-sm">{v4('searchEmployees')}<input autoFocus type="search" className={inputCls} value={query} maxLength={100} onChange={event=>{setQuery(event.target.value);setCursors([null]);}}/></label>
   {pending?<p role="status" className="text-sm text-muted-foreground">{t('loadingEmployees')}</p>:error?<div role="alert"><p>{error}</p><Button type="button" variant="secondary" onClick={()=>setRetry(r=>r+1)}>{t('retryEmployees')}</Button></div>:<>
    <ul className="max-h-72 overflow-y-auto">{rows.map(person=><li key={person.id}><button type="button" role="checkbox" aria-checked={value.includes(person.id)} className="min-h-11 w-full rounded-md p-2 text-left text-sm hover:bg-muted" onClick={()=>onChange(value.includes(person.id)?value.filter(item=>item!==person.id):[...value,person.id])}><svg aria-hidden="true" viewBox="0 0 16 16" className="mr-2 inline-block size-4 fill-none stroke-current"><rect x="1" y="1" width="14" height="14" rx="2"/>{value.includes(person.id)&&<path d="m4 8 3 3 5-6"/>}</svg>{criteriaEmployeeLabel(person)}{person.company&&<span className="ml-1 text-xs text-muted-foreground">· {person.company}</span>}</button></li>)}</ul>
    {!rows.length&&<p role="status" className="text-sm text-muted-foreground">{t('noEmployeeMatches')}</p>}
    <div className="flex gap-3"><Button type="button" variant="secondary" disabled={cursors.length<2} onClick={()=>setCursors(old=>old.slice(0,-1))}>{t('previousEmployees')}</Button><Button type="button" variant="secondary" disabled={!more||!rows.length} onClick={()=>{const last=rows[rows.length-1];setCursors(old=>[...old,{name:last.name,id:last.id}]);}}>{t('nextEmployees')}</Button></div>
   </>}
  </div>}
 </div>;
}
