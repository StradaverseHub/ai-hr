'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {useTranslations} from 'next-intl';

/**
 * Prototype GradeSelect (lane M3): a button that sums up the chosen job grades with an "n selected" pill and opens a
 * searchable checklist (Select all, Clear, Done). Options are the job grades Personnel Management knows; a saved
 * grade that is no longer listed stays visible so it can be removed.
 */
export function GradeSelect({value,options,disabled,onChange,label}:{value:readonly string[];options:readonly string[];disabled?:boolean;onChange:(value:string[])=>void;label:string}){
 const t=useTranslations('probationConfig'),[open,setOpen]=useState(false),[query,setQuery]=useState(''),box=useRef<HTMLDivElement>(null),listId=useId();
 useEffect(()=>{if(!open)return;
  const outside=(event:MouseEvent)=>{if(box.current&&!box.current.contains(event.target as Node))setOpen(false);};
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')setOpen(false);};
  document.addEventListener('mousedown',outside);document.addEventListener('keydown',escape);
  return()=>{document.removeEventListener('mousedown',outside);document.removeEventListener('keydown',escape);};
 },[open]);
 const all=[...options,...value.filter(grade=>!options.includes(grade))];
 const ordered=(next:readonly string[])=>all.filter(grade=>next.includes(grade));
 const needle=query.trim().toLocaleLowerCase();
 const shown=all.filter(grade=>!needle||grade.toLocaleLowerCase().includes(needle));
 const toggle=(grade:string)=>onChange(ordered(value.includes(grade)?value.filter(g=>g!==grade):[...value,grade]));
 return <div ref={box} className="pcg-gradeselect">
  <button type="button" className="pcg-gradeselect-button" disabled={disabled} aria-expanded={open} aria-controls={open?listId:undefined} aria-label={label+': '+(value.length?ordered(value).join(', '):t('form.noGrades'))} onClick={()=>setOpen(!open)}>
   <span>{value.length?ordered(value).join(', '):<span className="pcg-hint">{t('form.chooseGrades')}</span>}</span>
   <span className="pcg-row">{value.length>0&&<span className="pcg-pill pcg-pill-info">{t('form.selected',{count:value.length})}</span>}<span aria-hidden="true">▾</span></span>
  </button>
  {open&&<div className="pcg-gradeselect-list" id={listId} role="group" aria-label={label}>
   <input type="search" value={query} placeholder={t('form.searchGrades')} aria-label={t('form.searchGrades')} onChange={e=>setQuery(e.target.value)}/>
   <div className="pcg-row pcg-between"><button type="button" className="pcg-link" onClick={()=>onChange([...all])}>{t('form.selectAll')}</button><button type="button" className="pcg-link" onClick={()=>onChange([])}>{t('form.clear')}</button></div>
   <div className="pcg-gradeselect-options">
    {shown.map(grade=><label key={grade} className="pcg-check"><input type="checkbox" checked={value.includes(grade)} onChange={()=>toggle(grade)}/><span>{grade}</span></label>)}
    {!shown.length&&<p className="pcg-hint">{t('form.noGradeMatch',{query})}</p>}
   </div>
   <div className="pcg-row" style={{justifyContent:'flex-end'}}><button type="button" className="v9-button v9-button-primary" onClick={()=>setOpen(false)}>{t('form.done')}</button></div>
  </div>}
 </div>;
}
