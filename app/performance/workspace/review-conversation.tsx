'use client';
import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import type { ConversationStage, ReviewMessage } from '@/packs/performance/service';
import { useRouter } from 'next/navigation';
import { flushAssessmentDrafts } from '../onehr/draft-form';
import { Sparkles } from 'lucide-react';
import { Button, inputCls } from '@/components/ui';
import { calibrationConversationAction,reviewConversationAction } from '../onehr-actions';
export function ReviewConversation({reviewId,stage,initial,aiEnabled,labels,children,contextId,axis}:{axis?:'performance'|'potential'|'both';contextId?:string;children?:ReactNode;reviewId:string;stage:ConversationStage|'calibration';initial:{revision:number|null;messages:ReviewMessage[];settingQuota?:{remaining:number;limit:number}};aiEnabled:boolean;labels:Record<string,string>}){
 const router=useRouter(),frame=useRef<HTMLElement>(null);
 const [availableHeight,setAvailableHeight]=useState<number>();
 useEffect(()=>{
  const update=()=>{
   if(!frame.current)return;
   let boundary:HTMLElement|null=frame.current.parentElement;
   while(boundary&&!(boundary.tagName==='MAIN'&&getComputedStyle(boundary).overflowY==='auto'))boundary=boundary.parentElement;
   const bottom=boundary?.getBoundingClientRect().bottom??window.innerHeight-16,top=frame.current.getBoundingClientRect().top+(boundary?.scrollTop??0);
   setAvailableHeight(Math.max(200,bottom-top-8));
  };
  update();window.addEventListener('resize',update);
  const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(update):null;if(frame.current?.parentElement)observer?.observe(frame.current.parentElement);
  return()=>{window.removeEventListener('resize',update);observer?.disconnect();};
 },[]);
 const [conversation,setConversation]=useState(initial),[words,setWords]=useState(''),[error,setError]=useState(''),[pending,start]=useTransition();
 function send(intent:'guide'|'draft'|'starter'){
  const text=words.trim()||(intent==='starter'?labels.starter:labels.next);
  start(async()=>{
   try{await flushAssessmentDrafts();}catch(e){setError(e instanceof Error?e.message:labels.help);return;}
   try{
   const result=stage==='calibration'?await calibrationConversationAction(contextId??reviewId,axis??'both',conversation.revision,crypto.randomUUID(),text):await reviewConversationAction(reviewId,stage,conversation.revision,crypto.randomUUID(),text,intent,contextId);
   if('error' in result){setError(result.error);return;}
   setConversation(result);setWords('');setError('');if('draftUpdated' in result&&result.draftUpdated)router.refresh();
   }catch(e){setError(e instanceof Error?e.message:labels.help);}
  });
 }
 return <section ref={frame} style={{height:availableHeight}} className="flex min-h-64 flex-col" aria-label={labels.title}>
  <h3 className="sr-only">{labels.title}</h3>
  <div data-review-scroll className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"><div role="log" aria-live="polite" aria-relevant="additions" className={conversation.messages.length?'space-y-4 px-5 py-4':''}>{conversation.messages.map(m=><article key={m.id} className={`max-w-3xl whitespace-pre-wrap text-sm leading-relaxed ${m.role==='user'?'ml-auto rounded-lg bg-muted p-3':'border-l-2 border-primary pl-3'}`}><span className="mb-1 block text-xs font-semibold text-muted-foreground">{m.role==='user'?labels.you:m.kind==='action'?labels.action:m.kind==='draft'?labels.draft:labels.guide}</span>{m.kind==='update'?labels.updated:m.text}</article>)}</div>
  <fieldset disabled={pending} className="min-w-0 border-0 p-0">{children}</fieldset></div>
  {error&&<p role="alert" className="px-5 text-sm text-destructive">{error}</p>}
  <form onSubmit={e=>{e.preventDefault();send('guide');}} className="sticky bottom-0 shrink-0 space-y-2 border-t border-border bg-card px-4 py-3"><div className="flex items-end gap-2"><label className="sr-only" htmlFor="review-assistant-message">{labels.message}</label><textarea id="review-assistant-message" rows={1} disabled={pending} value={words} onChange={e=>{setWords(e.target.value);e.target.style.height='auto';e.target.style.height=`${Math.min(e.target.scrollHeight,160)}px`;}} maxLength={2500} className={`${inputCls} min-h-11 flex-1 resize-none`} placeholder={labels.message}/>{aiEnabled&&stage!=='setting'&&<Button type="button" variant="secondary" disabled={pending||!words.trim()} onClick={()=>send('draft')} aria-label={pending?labels.preparing:labels.draft} title={labels.draft} className="size-11 shrink-0 px-0"><Sparkles size={17} aria-hidden/></Button>}<Button type="submit" variant="secondary" disabled={pending} aria-label={words.trim()?labels.send:labels.next} className="size-11 shrink-0 px-0"><span aria-hidden="true" className="text-xl">↑</span></Button></div>{aiEnabled&&stage==='setting'&&<div className="flex flex-wrap items-center justify-end gap-3">{stage==='setting'&&<><Button type="button" variant="secondary" disabled={pending||conversation.settingQuota?.remaining===0} onClick={()=>send('starter')}>{labels.starter}</Button>{conversation.settingQuota&&<span className="text-xs text-muted-foreground">{labels.starterQuota.replace('{remaining}',String(conversation.settingQuota.remaining)).replace('{limit}',String(conversation.settingQuota.limit))}</span>}</>}</div>}<p className={stage==='setting'&&aiEnabled?"text-xs text-muted-foreground":"sr-only"}>{stage==='setting'&&aiEnabled?labels.starterHelp:labels.help}</p></form>

 </section>;
}
