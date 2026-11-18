'use client';
import {useCallback,useEffect,useMemo,useState} from 'react';
import {resolveEmploymentSelection,type EmployeePickOption,type EmploymentSelection} from '@/lib/employment-selection';
export async function fetchBulkEmployeeSelection(picked:string[],raw:string,signal?:AbortSignal):Promise<{selection:EmploymentSelection;rows:EmployeePickOption[]}>{
 const response=await fetch('/api/bulk-employee-choices',{method:'POST',credentials:'same-origin',cache:'no-store',signal,
  headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'resolve',picked,raw})});
 if(!response.ok)throw Error('Unavailable');const value=await response.json();
 if(!value||!value.selection||!Array.isArray(value.selection.ids)||!Array.isArray(value.selection.unmatched)
  ||[...value.selection.ids,...value.selection.unmatched].some(id=>typeof id!=='string')||!Array.isArray(value.rows)||value.rows.length>25
  ||value.rows.some((row:EmployeePickOption)=>!row||typeof row.id!=='string'||typeof row.name!=='string'||row.employeeCode!==null&&typeof row.employeeCode!=='string'))throw Error('Unavailable');
 return value;
}
/** Legacy fixture callers keep local vocabulary; actual pages opt into native reads.
 * A stale resolution cannot enable Next/Save or claim a reviewed population. */
export function useBulkEmployeeVocabulary(remote:boolean,initial:EmployeePickOption[],picked:Set<string>,raw:string){
 const key=JSON.stringify([[...picked],raw]);
 const [result,setResult]=useState<{identity:object;selection:EmploymentSelection;rows:EmployeePickOption[]}|null>(null);
 const [failed,setFailed]=useState<object|null>(null),[retry,setRetry]=useState(0);
 const identity=useMemo(()=>({key}),[key,retry,remote]);
 const [cache,setCache]=useState(initial);
 const receiveRows=useCallback((rows:EmployeePickOption[])=>setCache(previous=>{
  const values=new Map(previous.filter(row=>picked.has(row.id)).map(row=>[row.id,row]));for(const row of rows)values.set(row.id,row);return [...values.values()];
 }),[picked]);
 useEffect(()=>{
  if(!remote)return;
  const controller=new AbortController();let active=true;
  const timer=setTimeout(()=>{void fetchBulkEmployeeSelection([...picked],raw,controller.signal).then(value=>{
   if(active)setResult({identity,...value});
  }).catch(()=>{if(active&&!controller.signal.aborted)setFailed(identity);});},raw?180:0);
  return()=>{active=false;clearTimeout(timer);controller.abort();};
 },[remote,identity]);
 const current=result?.identity===identity?result:null;
 const selection=useMemo(()=>remote?current?.selection??{ids:[],unmatched:[]}:resolveEmploymentSelection([...picked],raw,initial),[remote,current,picked,raw,initial]);
 const rows=remote?current?.rows??cache.filter(row=>picked.has(row.id)).slice(0,25):initial.filter(row=>picked.has(row.id));
 return {selection,rows,receiveRows,pending:remote&&!current,failed:remote&&failed===identity,retry:()=>{setFailed(null);setRetry(n=>n+1);}};
}
