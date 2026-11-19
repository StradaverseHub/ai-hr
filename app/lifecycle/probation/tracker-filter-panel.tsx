'use client';
import Link from 'next/link';
import {useEffect,useId,useState} from 'react';
import {Search} from 'lucide-react';
import {useTranslations} from 'next-intl';
import type {ProbationTrackerOptions} from '@/packs/probation/service';
import {cascadingTrackerChoices,type TrackerFilters} from './tracker-filters';

/**
 * The tracker's filter card (lane M1; prototype Tracker): five Personnel Management filters, each with its source hint,
 * Apply filters, Clear filters and Show closed cases. A GET form, so the URL holds the filters for the list and Export.
 */
export function TrackerFilterPanel({options,filters}:{options:ProbationTrackerOptions;filters:TrackerFilters}){
 const t=useTranslations('probation'),id=useId(),[selected,setSelected]=useState(filters),[names,setNames]=useState<string[]>([]),[unavailable,setUnavailable]=useState(false);
 const [showClosed,setShowClosed]=useState(!filters.hideClosed);
 const choices=cascadingTrackerChoices(options,selected);
 useEffect(()=>{
  setNames([]);setUnavailable(false);if((selected.search??'').trim().length<2)return;
  const controller=new AbortController();
  const timer=setTimeout(async()=>{
   const query=new URLSearchParams();for(const key of ['search','businessGroupId','businessUnitId','departmentId','grade'] as const)if(selected[key])query.set(key,selected[key]!);
   try{
    const response=await fetch('/lifecycle/probation/suggestions?'+query,{signal:controller.signal,cache:'no-store'});
    if(!response.ok)throw new Error('unavailable');const result=await response.json();
    if(!Array.isArray(result.names)||result.names.length>10||result.names.some((name:unknown)=>typeof name!=='string'||name.length>500))throw new Error('unavailable');
    if(!controller.signal.aborted)setNames(result.names);
   }catch{if(!controller.signal.aborted)setUnavailable(true);}
  },250);
  return()=>{clearTimeout(timer);controller.abort();};
 },[selected.search,selected.businessGroupId,selected.businessUnitId,selected.departmentId,selected.grade]);
 const change=(key:'businessGroupId'|'businessUnitId'|'departmentId'|'grade',value:string)=>setSelected(current=>({...current,[key]:value||undefined,...(key==='businessGroupId'?{businessUnitId:undefined,departmentId:undefined,grade:undefined}:key==='businessUnitId'?{departmentId:undefined,grade:undefined}:key==='departmentId'?{grade:undefined}:{})}));
 const field=(key:string)=>({input:id+'-'+key,hint:id+'-'+key+'-hint'});
 const hint=(key:string)=><span className="pct-h" id={field(key).hint}>{t('tracker.hints.'+key)}</span>;
 return <form className="pct-card pct-filters" method="get">
  {filters.flag&&<input type="hidden" name="flag" value={filters.flag}/>}
  {!showClosed&&<input type="hidden" name="hideClosed" value="1"/>}
  <div className="pct-filter-grid">
   <div className="pct-f"><label htmlFor={field('search').input}>{t('tracker.search')}</label><input id={field('search').input} aria-describedby={field('search').hint} name="search" maxLength={100} placeholder={t('tracker.namePlaceholder')} value={selected.search??''} list={id} autoComplete="off" onChange={event=>setSelected(current=>({...current,search:event.target.value}))}/><datalist id={id}>{names.map(name=><option key={name} value={name}/>)}</datalist>{hint('search')}{unavailable&&<span className="pct-h" role="status">{t('tracker.suggestionsUnavailable')}</span>}</div>
   {([['businessGroupId','businessGroup',choices.businessGroups],['businessUnitId','businessUnit',choices.businessUnits],['departmentId','department',choices.departments]] as const).map(([key,label,values])=><div className="pct-f" key={key}><label htmlFor={field(label).input}>{t('facts.'+label)}</label><select id={field(label).input} aria-describedby={field(label).hint} name={key} value={selected[key]??''} onChange={event=>change(key,event.target.value)}><option value="">{t('all')}</option>{values.map(value=><option key={value.id} value={value.id}>{value.name}</option>)}</select>{hint(label)}</div>)}
   <div className="pct-f"><label htmlFor={field('grade').input}>{t('tracker.gradeAtStart')}</label><select id={field('grade').input} aria-describedby={field('grade').hint} name="grade" value={selected.grade??''} onChange={event=>change('grade',event.target.value)}><option value="">{t('all')}</option>{choices.grades.map(grade=><option key={grade} value={grade}>{grade}</option>)}</select>{hint('grade')}</div>
  </div>
  <div className="pct-row">
   <button type="submit" className="pct-btn pct-btn-pri"><Search size={16} aria-hidden="true"/>{t('applyFilters')}</button>
   <Link className="pct-btn pct-btn-ghost" href="/lifecycle/probation">{t('clearFilters')}</Link>
   <label className="pct-chk"><input type="checkbox" checked={showClosed} onChange={event=>setShowClosed(event.target.checked)}/>{t('tracker.showClosed')}</label>
  </div>
 </form>;
}
