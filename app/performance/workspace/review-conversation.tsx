'use client';
import { useState, useTransition, type ReactNode } from 'react';
import type { ConversationStage, ReviewMessage } from '@/packs/performance/service';
import { useRouter } from 'next/navigation';
import { flushAssessmentDrafts } from '../onehr/draft-form';
import { Button, inputCls } from '@/components/ui';
import { reviewConversationAction } from '../onehr-actions';
export function ReviewConversation({reviewId,stage,initial,aiEnabled,labels,children}:{children?:ReactNode;reviewId:string;stage:ConversationStage;initial:{revision:number|null;messages:ReviewMessage[]};aiEnabled:boolean;labels:Record<string,string>}){
 const router=useRouter();
 const [conversation,setConversation]=useState(initial),[words,setWords]=useState(''),[error,setError]=useState(''),[pending,start]=useTransition();
 function send(intent:'guide'|'draft'){
  const text=words.trim()||labels.next;
  start(async()=>{
   try{await flushAssessmentDrafts();}catch(e){setError(e instanceof Error?e.message:labels.help);return;}
   const result=await reviewConversationAction(reviewId,stage,conversation.revision,crypto.randomUUID(),text,intent);
   if('error' in result){setError(result.error);return;}
   setConversation(result);setWords('');setError('');if('draftUpdated' in result&&result.draftUpdated)router.refresh();
  });
 }
 return <section className="flex min-h-[32rem] flex-col lg:h-[max(32rem,calc(100dvh-18rem))]" aria-label={labels.title}>
  <h3 className="px-5 pt-4 text-sm font-semibold">{labels.title}</h3>
  <div data-review-scroll className="min-h-0 flex-1 lg:overflow-y-auto lg:[scrollbar-gutter:stable]"><div role="log" aria-live="polite" aria-relevant="additions" className="space-y-4 px-5 py-4">{conversation.messages.map(m=><article key={m.id} className={`max-w-3xl whitespace-pre-wrap text-sm leading-relaxed ${m.role==='user'?'ml-auto rounded-lg bg-muted p-3':'border-l-2 border-primary pl-3'}`}><span className="mb-1 block text-xs font-semibold text-muted-foreground">{m.role==='user'?labels.you:m.kind==='draft'?labels.draft:labels.guide}</span>{m.kind==='update'?labels.updated:m.text}</article>)}</div>
  <fieldset disabled={pending} className="min-w-0 border-0 p-0">{children}</fieldset></div>
  {error&&<p role="alert" className="px-5 text-sm text-destructive">{error}</p>}
  <form onSubmit={e=>{e.preventDefault();send('guide');}} className="sticky bottom-0 shrink-0 space-y-3 border-t border-border bg-card px-5 py-4"><label className="sr-only" htmlFor="review-assistant-message">{labels.message}</label><textarea id="review-assistant-message" disabled={pending} value={words} onChange={e=>setWords(e.target.value)} maxLength={2500} className={inputCls} placeholder={labels.message}/><div className="flex flex-wrap justify-end gap-2"><Button type="submit" variant="secondary" disabled={pending}>{words.trim()?labels.send:labels.next}</Button>{aiEnabled&&<Button type="button" disabled={pending||!words.trim()} onClick={()=>send('draft')}>{pending?labels.preparing:labels.draft}</Button>}</div><p className="text-xs text-muted-foreground">{labels.help}</p></form>
 </section>;
}
