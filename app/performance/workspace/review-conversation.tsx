'use client';
import { useState, useTransition } from 'react';
import type { ConversationStage, ReviewMessage } from '@/packs/performance/service';
import { Button, inputCls } from '@/components/ui';
import { reviewConversationAction } from '../onehr-actions';
export function ReviewConversation({reviewId,stage,initial,aiEnabled,labels}:{reviewId:string;stage:ConversationStage;initial:{revision:number|null;messages:ReviewMessage[]};aiEnabled:boolean;labels:Record<string,string>}){
 const [conversation,setConversation]=useState(initial),[words,setWords]=useState(''),[error,setError]=useState(''),[pending,start]=useTransition();
 function send(intent:'guide'|'draft'){
  const text=words.trim()||labels.next;
  start(async()=>{
   const result=await reviewConversationAction(reviewId,stage,conversation.revision,crypto.randomUUID(),text,intent);
   if('error' in result){setError(result.error);return;}
   setConversation(result);setWords('');setError('');
  });
 }
 return <section className="border-t border-border" aria-label={labels.title}>
  <h3 className="px-5 pt-4 text-sm font-semibold">{labels.title}</h3>
  <div role="log" aria-live="polite" aria-relevant="additions" className="max-h-80 space-y-4 overflow-y-auto px-5 py-4">{conversation.messages.map(m=><article key={m.id} className={`max-w-3xl whitespace-pre-wrap text-sm leading-relaxed ${m.role==='user'?'ml-auto rounded-lg bg-muted p-3':'border-l-2 border-primary pl-3'}`}><span className="mb-1 block text-xs font-semibold text-muted-foreground">{m.role==='user'?labels.you:m.kind==='draft'?labels.draft:labels.guide}</span>{m.text}</article>)}</div>
  {error&&<p role="alert" className="px-5 text-sm text-destructive">{error}</p>}
  <form onSubmit={e=>{e.preventDefault();send('guide');}} className="space-y-3 px-5 pb-5"><label className="sr-only" htmlFor="review-assistant-message">{labels.message}</label><textarea id="review-assistant-message" value={words} onChange={e=>setWords(e.target.value)} maxLength={2500} className={inputCls} placeholder={labels.message}/><div className="flex flex-wrap justify-end gap-2"><Button type="submit" variant="secondary" disabled={pending}>{labels.next}</Button>{aiEnabled&&<Button type="button" disabled={pending||!words.trim()} onClick={()=>send('draft')}>{pending?labels.preparing:labels.draft}</Button>}</div><p className="text-xs text-muted-foreground">{labels.help}</p></form>
 </section>;
}
