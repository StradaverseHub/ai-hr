'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {useTranslations} from 'next-intl';
import {ChevronDown} from 'lucide-react';

export type MultiSelectOption = { value: string; label: string; group?:string };
/** A compact multi-value picker (prototype MultiSelect): a button that opens a list of checkboxes. Order follows the options. */
export function MultiSelect({label,value,options,onChange,disabled=false,emptyLabel}:{label:string;value:readonly string[];options:readonly MultiSelectOption[];onChange:(next:string[])=>void;disabled?:boolean;emptyLabel?:string}){
 const t=useTranslations('automation'),[open,setOpen]=useState(false),box=useRef<HTMLDivElement>(null),listId=useId();
 useEffect(()=>{if(!open)return;const away=(event:MouseEvent)=>{if(box.current&&!box.current.contains(event.target as Node))setOpen(false);};const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')setOpen(false);};
  document.addEventListener('mousedown',away);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('mousedown',away);document.removeEventListener('keydown',escape);};},[open]);
 // Values that are no longer offered (a removed group, an unavailable choice) stay visible so they can be removed.
 const all:MultiSelectOption[]=[...options,...value.filter(v=>!options.some(o=>o.value===v)).map(v=>({value:v,label:t('notAvailable',{value:v})}))];
 const text=value.length?all.filter(o=>value.includes(o.value)).map(o=>o.label).join(', '):emptyLabel??t('none');
 const toggle=(item:string)=>onChange(value.includes(item)?value.filter(v=>v!==item):all.map(o=>o.value).filter(v=>value.includes(v)||v===item));
 return <div ref={box} className="automation-multiselect">
  <button type="button" className="automation-multiselect-button" aria-label={label} aria-expanded={open} aria-controls={open?listId:undefined} disabled={disabled} onClick={()=>setOpen(!open)}>
   <span>{text}</span><ChevronDown size={16} aria-hidden/>
  </button>
  {open&&<div id={listId} className="automation-multiselect-list" role="group" aria-label={label}>
   {all.length===0&&<p className="v9-muted">{t('noChoices')}</p>}
   {all.map((option,index)=><div key={option.value}>{option.group&&option.group!==all[index-1]?.group&&<h4 className="v9-muted">{option.group}</h4>}<label className="automation-check"><input type="checkbox" checked={value.includes(option.value)} onChange={()=>toggle(option.value)}/><span>{option.label}</span></label></div>)}
   <div className="automation-multiselect-done"><button type="button" className="v9-button v9-button-primary" onClick={()=>setOpen(false)}>{t('done')}</button></div>
  </div>}
 </div>;
}
