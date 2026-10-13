'use client';

import { readSettingScoring } from '@/packs/performance/onehr/setting-form-model';
import { settingNumbersComplete } from '@/packs/performance/onehr/setting-default-model';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

export type NavigatorItem={id:string;title:string;meta:string;done:boolean;fields:string[];setting?:boolean};
export function ItemNavigator({title,items}:{title:string;items:NavigatorItem[]}) {
 const t=useTranslations('onehr'),[entries,setEntries]=useState(items);
 useEffect(()=>{
  const synchronize=(forms:HTMLFormElement[])=>{
   setEntries(previous=>previous.map(entry=>{
    const form=forms.find(form=>entry.setting?Array.from(form.querySelectorAll<HTMLInputElement>('input[name="kpiId"]')).some(input=>input.value===entry.id.slice(4)):entry.fields.length>0&&entry.fields.every(name=>form.elements.namedItem(name)));
    if(!form)return entry;
    if(entry.setting){
     const id=entry.id.slice(4),data=new FormData(form);let done=false;try{done=settingNumbersComplete(readSettingScoring(data,id));}catch{}
     return {...entry,done,title:String(data.get(`${id}.title`)??entry.title),meta:`${String(data.get(`${id}.weight`)??'0')}%`};
    }
    if(!entry.fields.length)return entry;
    const controls=entry.fields.map(name=>form.elements.namedItem(name));
    if(controls.some(control=>!(control instanceof HTMLInputElement||control instanceof HTMLTextAreaElement||control instanceof HTMLSelectElement)))return entry;
    const done=controls.every(control=>!!(control as HTMLInputElement).value.trim());
    return entry.done===done?entry:{...entry,done};
   }));
  };
  const update=(event:Event)=>{
   const target=event.target;if(!(target instanceof Element))return;
   const form=target.closest('form');if(!form?.hasAttribute('data-assessment-draft'))return;
   synchronize([form]);
  };
  setEntries(items);
  // The phone drawer mounts after editing; initialize it from the live form too.
  synchronize(Array.from(document.querySelectorAll<HTMLFormElement>('form[data-assessment-draft]')));
  document.addEventListener('input',update);document.addEventListener('change',update);
  return()=>{document.removeEventListener('input',update);document.removeEventListener('change',update);};
 },[items]);
 const progress=entries.filter(entry=>!['assessment-overall-remark','assessment-submit-results'].includes(entry.id));
 return <><div className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold">{title}</h2><p className="mt-1 text-xs text-muted-foreground">{t('workspace.progress',{done:progress.filter(n=>n.done).length,total:progress.length})}</p></div>{[false,true].map(complete=><details key={String(complete)} open={!complete} className="border-b border-border"><summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-muted-foreground">{t(complete?'workspace.states.done':'workspace.toDo')} <span className="float-right">{entries.filter(n=>n.done===complete).length}</span></summary><ul className="space-y-1 p-2">{entries.filter(n=>n.done===complete).map(n=><li key={n.id}><a href={`#${n.id}`} onClick={event=>{
  const target=document.getElementById(n.id);if(!target)return;
  event.preventDefault();const viewport=target.closest<HTMLElement>('[data-review-scroll]');if(viewport)viewport.scrollTo({top:viewport.scrollTop+target.getBoundingClientRect().top-viewport.getBoundingClientRect().top});else target.scrollIntoView({block:'start'});target.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('input:not([type="hidden"]),textarea,select')?.focus({preventScroll:true});
 }} className="block min-h-11 rounded-md px-3 py-2 text-sm hover:bg-muted"><span className="line-clamp-2">{n.title}</span>{n.meta&&<span className="mt-1 block text-xs text-muted-foreground">{n.meta}</span>}</a></li>)}</ul></details>)}</>;
}
