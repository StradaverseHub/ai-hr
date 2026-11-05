'use client';
import Link from 'next/link';
import {useEffect,useId,useState} from 'react';
import {Search} from 'lucide-react';
import {useTranslations} from 'next-intl';
import type {ProbationTrackerOptions} from '@/packs/probation/service';
import {cascadingTrackerChoices,type TrackerFilters} from './tracker-filters';

export function TrackerFilterPanel({options,filters,configure}:{options:ProbationTrackerOptions;filters:TrackerFilters;configure:boolean}){
 const t=useTranslations('probation'),id=useId(),[selected,setSelected]=useState(filters),[names,setNames]=useState<string[]>([]),[unavailable,setUnavailable]=useState(false);
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
 return <form className="v9-panel v9-stack" method="get">
  {filters.flag&&<input type="hidden" name="flag" value={filters.flag}/>}
  <div className="probation-filter-grid">
   <label className="v9-field"><span>{t('tracker.search')}</span><input name="search" maxLength={100} value={selected.search??''} list={id} autoComplete="off" onChange={event=>setSelected(current=>({...current,search:event.target.value}))}/><datalist id={id}>{names.map(name=><option key={name} value={name}/>)}</datalist>{unavailable&&<span className="v9-muted" role="status">{t('tracker.suggestionsUnavailable')}</span>}</label>
   {([['businessGroupId','businessGroup',choices.businessGroups],['businessUnitId','businessUnit',choices.businessUnits],['departmentId','department',choices.departments]] as const).map(([key,label,values])=><label className="v9-field" key={key}><span>{t('facts.'+label)}</span><select name={key} value={selected[key]??''} onChange={event=>change(key,event.target.value)}><option value="">{t('all')}</option>{values.map(value=><option key={value.id} value={value.id}>{value.name}</option>)}</select></label>)}
   <label className="v9-field"><span>{t('tracker.gradeAtStart')}</span><select name="grade" value={selected.grade??''} onChange={event=>change('grade',event.target.value)}><option value="">{t('all')}</option>{choices.grades.map(grade=><option key={grade} value={grade}>{grade}</option>)}</select></label>
  </div>
  <div className="probation-actions"><button type="submit" className="v9-button v9-button-primary"><Search size={16}/>{t('applyFilters')}</button><Link className="v9-button" href="/lifecycle/probation">{t('clearFilters')}</Link>{configure&&<Link className="v9-button" href="/lifecycle/probation/intake">{t('intake.title')}</Link>}</div>
 </form>;
}
