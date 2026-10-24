'use client';

import * as React from 'react';
import type {EmployeeHomeCard} from '@/lib/employee-home';
import type {HomeCardInteraction} from '@/lib/employee-home-analytics';
let queued:HomeCardInteraction[]=[],timer:ReturnType<typeof setTimeout>|undefined;
function flush(){
 if(timer!==undefined){clearTimeout(timer);timer=undefined;}
 const events=queued;queued=[];if(events.length===0)return;
 // Best effort: no retries, identity, content inspection or effect on a business action.
 try{void fetch('/api/home/interactions',{method:'POST',credentials:'same-origin',cache:'no-store',keepalive:true,
  referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:1,events})}).catch(()=>{});}catch{}
}
function observe(card:EmployeeHomeCard,action:HomeCardInteraction['action']){
 if(queued.length>=16)return;
 queued.push({card,action});if(timer===undefined)timer=setTimeout(flush,250);
}
/** A view means a visible card shell, once per mount. Counts are observations, never unique people,
 * successful commands or audit evidence. No text, href, field value or selected subject is read. */
export function HomeCardUsage({card,children}:{card:EmployeeHomeCard;children:React.ReactNode}){
 const element=React.useRef<HTMLDivElement>(null),viewed=React.useRef(false);
 React.useEffect(()=>{
  const node=element.current;if(!node||typeof IntersectionObserver==='undefined')return;
  let visible=false;
  const record=()=>{if(visible&&!viewed.current&&document.visibilityState==='visible'){viewed.current=true;observe(card,'view');}};
  const observer=new IntersectionObserver(entries=>{visible=entries.some(entry=>entry.isIntersecting);record();},{threshold:0});
  observer.observe(node);document.addEventListener('visibilitychange',record);window.addEventListener('pagehide',flush);
  return()=>{observer.disconnect();document.removeEventListener('visibilitychange',record);window.removeEventListener('pagehide',flush);};
 },[card]);
 return <div ref={element} className="min-w-0" onClickCapture={event=>{
  if(event.target instanceof Element&&event.target.closest('a,button,input,select,textarea,summary,[role="button"]'))observe(card,'click');
 }}>{children}</div>;
}
