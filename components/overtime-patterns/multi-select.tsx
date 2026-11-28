'use client';

import {useId,useMemo,useState} from 'react';
import {inputCls} from '@/components/ui';

export type MultiSelectOption={id:string;label:string};
type Labels={search:string;any:string;remove:(label:string)=>string;more:(count:number)=>string;noMatches:string};

/** Board 4197534a — a searchable multi-select: chosen values as removable chips, a search box and a filtered list of
 * checkboxes (at most 50 shown; type to narrow). Values never chosen from the list cannot be added. */
export function MultiSelect({label,options,value,onChange,labels,disabled=false,chipLimit=3,onSearch}:{label:string;options:readonly MultiSelectOption[];value:readonly string[];onChange:(next:string[])=>void;labels:Labels;disabled?:boolean;chipLimit?:number;onSearch?:(text:string)=>void}) {
  const id=useId();
  const [search,setSearch]=useState('');
  const [open,setOpen]=useState(false);
  const [expanded,setExpanded]=useState(false);
  const byId=useMemo(()=>new Map(options.map(option=>[option.id,option])),[options]);
  const filtered=useMemo(()=>{const text=search.trim().toLowerCase();return (text?options.filter(option=>option.label.toLowerCase().includes(text)):options).slice(0,50);},[options,search]);
  const chosen=value.map(item=>byId.get(item)??{id:item,label:item});
  const shown=expanded?chosen:chosen.slice(0,chipLimit);
  const toggle=(item:string)=>onChange(value.includes(item)?value.filter(entry=>entry!==item):[...value,item]);
  return <div className="space-y-1.5">
    <label htmlFor={id} className="block text-sm font-medium">{label}</label>
    <div className="rounded-lg border border-border bg-background p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {shown.map(option=><span key={option.id} className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs">
          {option.label}
          {!disabled?<button type="button" className="rounded-full px-1 text-muted-foreground hover:text-foreground" aria-label={labels.remove(option.label)} onClick={()=>toggle(option.id)}>×</button>:null}
        </span>)}
        {chosen.length>chipLimit&&!expanded?<button type="button" className="rounded-full border border-border px-2.5 py-1 text-xs" onClick={()=>setExpanded(true)}>{labels.more(chosen.length-chipLimit)}</button>:null}
        {!chosen.length?<span className="px-1 text-sm text-muted-foreground">{labels.any}</span>:null}
      </div>
      {!disabled?<input id={id} type="search" role="combobox" aria-expanded={open} aria-controls={`${id}-list`} autoComplete="off" className={`${inputCls} mt-2`} placeholder={labels.search} value={search}
        onFocus={()=>setOpen(true)} onChange={event=>{setSearch(event.target.value);setOpen(true);onSearch?.(event.target.value);}} onKeyDown={event=>{if(event.key==='Escape')setOpen(false);}}/>:null}
      {open&&!disabled?<ul id={`${id}-list`} role="listbox" aria-multiselectable="true" aria-label={label} className="mt-2 max-h-56 overflow-y-auto rounded-md border border-border">
        {filtered.length?filtered.map(option=><li key={option.id} role="option" aria-selected={value.includes(option.id)}>
          <label className="flex min-h-10 cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent"><input type="checkbox" checked={value.includes(option.id)} onChange={()=>toggle(option.id)}/>{option.label}</label>
        </li>):<li className="px-3 py-2 text-sm text-muted-foreground">{labels.noMatches}</li>}
      </ul>:null}
    </div>
  </div>;
}
