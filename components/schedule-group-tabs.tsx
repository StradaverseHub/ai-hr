'use client';
import { useEffect, useState, type ReactNode } from 'react';
type Tab = {id:string;label:string;body:ReactNode};
/** Keep every independent form mounted: switching a tab never discards its draft. */
export function ScheduleGroupTabs({tabs,initial,ariaLabel}:{tabs:Tab[];initial?:string|null;ariaLabel:string}) {
 const [active,setActive]=useState(initial??'general');
 useEffect(()=>{const key=new URLSearchParams(window.location.search).get('section')??window.location.hash.replace('#section-','');if(tabs.some(t=>t.id===key))setActive(key);},[tabs]);
 const select=(id:string)=>{setActive(id);const url=new URL(window.location.href);url.searchParams.set('section',id);url.hash=`section-${id}`;window.history.replaceState(window.history.state,'',url);};
 return <div><div role="tablist" aria-label={ariaLabel} className="mb-6 flex gap-1 overflow-x-auto border-b border-border">{tabs.map((tab,i)=><button key={tab.id} id={`tab-${tab.id}`} role="tab" type="button" aria-selected={active===tab.id} aria-controls={`section-${tab.id}`} tabIndex={active===tab.id?0:-1} onClick={()=>select(tab.id)} onKeyDown={e=>{const next=e.key==='ArrowRight'?(i+1)%tabs.length:e.key==='ArrowLeft'?(i+tabs.length-1)%tabs.length:e.key==='Home'?0:e.key==='End'?tabs.length-1:null;if(next!=null){e.preventDefault();select(tabs[next].id);document.getElementById(`tab-${tabs[next].id}`)?.focus();}}} className={`shrink-0 border-b-2 px-3 py-3 text-sm ${active===tab.id?'border-primary font-medium text-foreground':'border-transparent text-muted-foreground hover:text-foreground'}`}>{tab.label}</button>)}</div>{tabs.map(tab=><section key={tab.id} id={`section-${tab.id}`} role="tabpanel" aria-labelledby={`tab-${tab.id}`} hidden={active!==tab.id} tabIndex={0} className="space-y-6 focus:outline-none">{tab.body}</section>)}</div>;
}
