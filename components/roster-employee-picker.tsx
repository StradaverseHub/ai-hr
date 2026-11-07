'use client';

import {useEffect,useMemo,useRef,useState} from 'react';
import {useTranslations} from 'next-intl';
import {inputCls} from '@/components/ui';
import type {RosterChoicePage} from '@/core/roster-presentation';

/** Only a bounded result window is mounted. Explicit selections survive search and page changes.
 * "All" captures complete minimal IDs on demand. Generate posts that exact reviewed set. */
export function RosterEmployeePicker({companyId,populationQuery}:{companyId:string;populationQuery:string}){
 const t=useTranslations('roster'),pt=useTranslations('pagination'),common=useTranslations('common');
 const [query,setQuery]=useState(()=>new URLSearchParams(populationQuery).get('q')??'');
 const [page,setPage]=useState<RosterChoicePage|null>(null),[error,setError]=useState(false),[loading,setLoading]=useState(false);
 const [selected,setSelected]=useState<Map<string,string>>(new Map()),[completeSelection,setCompleteSelection]=useState<string[]|null>(null);
 const [loadedQuery,setLoadedQuery]=useState(populationQuery);
 const selectedJson=useMemo(()=>JSON.stringify(completeSelection??[...selected.keys()]),[completeSelection,selected]);
 const completeIds=useMemo(()=>completeSelection===null?null:new Set(completeSelection),[completeSelection]);
 const controller=useRef<AbortController|null>(null),revision=useRef(0);
 useEffect(()=>()=>controller.current?.abort(),[]);
 useEffect(()=>{
  controller.current?.abort();revision.current++;setPage(null);setLoading(false);setError(false);
  setQuery(new URLSearchParams(populationQuery).get('q')??'');setLoadedQuery(populationQuery);
 },[populationQuery]);
 const parameters=(q:string)=>{const p=new URLSearchParams(populationQuery);p.set('companyId',companyId);if(q)p.set('q',q);else p.delete('q');return p;};
 const load=async(offset:number)=>{
  controller.current?.abort();const abort=new AbortController();controller.current=abort;const current=++revision.current;
  setLoading(true);setError(false);
  try{
   const params=parameters(query);params.set('offset',String(offset));
   const response=await fetch(`/roster/employee-choices?${params}`,{cache:'no-store',signal:abort.signal});
   if(!response.ok)throw new Error('Employee lookup failed');
   const result=await response.json() as RosterChoicePage;
   if(!Array.isArray(result.rows)||result.rows.length>25||!Number.isSafeInteger(result.total)||result.total<0||result.offset!==offset||result.limit!==25)throw new Error('Invalid employee response');
   if(current===revision.current){setPage(result);setLoadedQuery(parameters(query).toString());}
  }catch{if(!abort.signal.aborted&&current===revision.current){setError(true);setPage(null);}}
  finally{if(current===revision.current)setLoading(false);}
 };
 const selectMatching=async()=>{
  controller.current?.abort();const abort=new AbortController();controller.current=abort;const current=++revision.current;
  setLoading(true);setError(false);
  try{
   const params=new URLSearchParams(loadedQuery);params.set('complete','1');
   const response=await fetch(`/roster/employee-choices?${params}`,{cache:'no-store',signal:abort.signal});
   if(!response.ok)throw new Error('Employee lookup failed');
   const result=await response.json() as {ids:string[]};
   if(!Array.isArray(result.ids)||!result.ids.every(id=>typeof id==='string'))throw new Error('Invalid employee response');
   if(current===revision.current){setSelected(new Map());setCompleteSelection(result.ids);}
  }catch{if(!abort.signal.aborted&&current===revision.current)setError(true);}
  finally{if(current===revision.current)setLoading(false);}
 };
 return <div className="min-w-64 space-y-2 text-xs normal-case">
  <input type="hidden" name="selectionIds" value={selectedJson}/>
  <div className="flex items-center gap-2">
   <input className={inputCls} aria-label={t('filterEmployee')} placeholder={t('filterEmployeePlaceholder')} value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void load(0);}}}/>
   <button type="button" disabled={loading} onClick={()=>void load(0)}>{t('query')}</button>
  </div>
  {loading&&<p role="status">{common('loading')}</p>}
  {error&&<p role="alert">{t('pickerFailed')}</p>}
  <p aria-live="polite">{t('selectedCount',{n:completeSelection?.length??selected.size})}</p>
  {selected.size>0&&completeSelection===null&&<details><summary>{t('scopeEmployees')}</summary><ul className="max-h-32 overflow-auto">{[...selected].slice(0,25).map(([id,name])=><li key={id}><button type="button" onClick={()=>setSelected(previous=>{const next=new Map(previous);next.delete(id);return next;})}>{name} ×</button></li>)}</ul><p>{pt('range',{from:1,to:Math.min(25,selected.size),total:selected.size})}</p></details>}
  {completeSelection!==null&&<button type="button" onClick={()=>setCompleteSelection(null)}>{common('cancel')}</button>}
  {page&&!loading&&<>
   <div className="flex justify-between gap-2">
    <span>{page.rows.length?pt('range',{from:page.offset+1,to:page.offset+page.rows.length,total:page.total}):pt('rangeEmpty',{total:page.total})}</span>
    <button type="button" disabled={page.total===0} onClick={()=>void selectMatching()}>{t('pickerSelectMatching',{n:page.total})}</button>
   </div>
   <ul className="max-h-48 overflow-auto rounded-md border border-border p-2">{page.rows.map(row=><li key={row.employmentId}><label className="flex gap-2 py-1"><input type="checkbox" checked={completeIds!==null?completeIds.has(row.employmentId):selected.has(row.employmentId)} disabled={completeSelection!==null} onChange={()=>setSelected(previous=>{const next=new Map(previous);if(next.has(row.employmentId))next.delete(row.employmentId);else next.set(row.employmentId,row.name);return next;})}/><span>{row.name}{row.code?` (${row.code})`:''}</span></label>)}</ul>
   <div className="flex justify-between gap-2"><button type="button" disabled={!page.offset} onClick={()=>void load(Math.max(0,page.offset-25))}>{pt('previous')}</button><button type="button" disabled={page.offset+page.rows.length>=page.total} onClick={()=>void load(page.offset+25)}>{pt('next')}</button></div>
  </>}
 </div>;
}
