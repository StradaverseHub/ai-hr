'use client';
import {useEffect,useRef,useState} from 'react';
import {useTranslations} from 'next-intl';
import {Combobox} from './ui/combobox';
import type {WorkforceChoice,WorkforceChoicePage} from '@/lib/workforce-choice';
export type WorkforcePickerProps={subjectId:string;companyId?:string;name?:string;value?:string|null;retained?:WorkforceChoice[];placeholder?:string;onValueChange?:(id:string,row:WorkforceChoice|null)=>void;namesOnly?:boolean;ariaLabel?:string;allowClear?:boolean;required?:boolean};
/** Bounded navigation only. Command services independently recheck the submitted id.
 * Retained choices are server-disclosed relationship/current facts, never client authorization. */
export function WorkforcePicker(props:WorkforcePickerProps){
 return <Picker key={`${props.subjectId}:${props.companyId??''}`} {...props}/>;
}
function Picker({subjectId,companyId,name,value,retained=[],placeholder,onValueChange,namesOnly,ariaLabel,allowClear,required}:WorkforcePickerProps){
 const t=useTranslations('people.detail');
 const [selected,setSelected]=useState(value??''),[known,setKnown]=useState(retained);
 const [search,setSearch]=useState({query:'',offset:0,version:0}),[page,setPage]=useState<WorkforceChoicePage|null>(null);
 const [state,setState]=useState<'idle'|'loading'|'ready'|'error'>('idle');
 const sequence=useRef(0),root=useRef<HTMLDivElement>(null),previousSelected=useRef(selected);
 useEffect(()=>{
  if(previousSelected.current===selected)return;previousSelected.current=selected;
  // Hidden inputs do not emit native input events when React updates their value. Notify form dirty owners.
  const input=root.current?.querySelector('input[type="hidden"]');
  input?.dispatchEvent(new Event('input',{bubbles:true}));
  input?.dispatchEvent(new Event('change',{bubbles:true}));
 },[selected]);
 useEffect(()=>{
  if(!search.version)return;
  const controller=new AbortController(),ticket=++sequence.current;
  setState('loading');setPage(null);
  const timer=setTimeout(async()=>{
   try{
    const response=await fetch('/api/workforce-choices',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({subjectId,companyId,query:search.query,offset:search.offset,selectedIds:selected?[selected]:[]}),signal:controller.signal});
    if(!response.ok)throw new Error('Workforce choices unavailable');
    const result=await response.json() as WorkforceChoicePage;
    if(!Array.isArray(result.rows)||!Array.isArray(result.selected)||result.rows.length>25||result.offset!==search.offset||!Number.isSafeInteger(result.total))throw new Error('Invalid Workforce page');
    if(controller.signal.aborted||ticket!==sequence.current)return;
    setPage(result);setKnown(previous=>{
     const chosen=result.selected.find(row=>row.employmentId===selected)??previous.find(row=>row.employmentId===selected);
     return chosen?[chosen]:[];
    });setState('ready');
   }catch(error){if(!controller.signal.aborted&&ticket===sequence.current)setState('error');}
  },search.query?180:0);
  return()=>{clearTimeout(timer);controller.abort();};
 },[subjectId,companyId,search,selected]);
 const rows=[...known,...(page?.rows??[])].filter((row,index,all)=>all.findIndex(other=>other.employmentId===row.employmentId)===index);
 const change=(id:string)=>{const row=rows.find(row=>row.employmentId===id)??null;setSelected(id);setKnown(row?[row]:[]);onValueChange?.(id,row);};
 return <div ref={root}><Combobox ariaLabel={ariaLabel??t('directSuperiorTitle')} name={name} value={value} options={rows.map(row=>({value:row.employmentId,label:!namesOnly&&row.employeeCode?`${row.employeeCode} – ${row.name}`:row.name,disabled:state==='loading'&&row.employmentId!==selected}))}
  placeholder={placeholder??t('directSuperiorNone')} searchPlaceholder={t('directSuperiorSearch')} noResultsLabel={t('directSuperiorNoResults')} legacySuffix="" onValueChange={change}
  remote={{allowClear:allowClear??!required,onOpen:()=>setSearch({query:'',offset:0,version:Date.now()}),onQuery:query=>{setPage(null);setState('loading');setSearch(previous=>({query,offset:0,version:previous.version+1}));},footer:<div className="flex items-center justify-between gap-2 border-t p-2 text-xs" aria-live="polite">
   {state==='loading'?t('workforcePickerLoading'):state==='error'?<><span role="alert">{t('workforcePickerError')}</span><button type="button" onClick={()=>setSearch(previous=>({...previous,version:previous.version+1}))}>{t('workforcePickerRetry')}</button></>:page?<><span>{t('workforcePickerCount',{count:page.total})}</span><button type="button" disabled={!page.offset} onClick={()=>setSearch(previous=>({...previous,offset:Math.max(0,previous.offset-25)}))}>{t('workforcePickerPrevious')}</button><button type="button" disabled={page.offset+25>=page.total} onClick={()=>setSearch(previous=>({...previous,offset:previous.offset+25}))}>{t('workforcePickerNext')}</button></>:null}
  </div>}}/></div>;
}
