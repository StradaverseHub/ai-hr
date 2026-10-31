'use client';
import {useEffect,useRef,useState,useTransition} from 'react';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
import {askPerformanceGuideAction} from '../onehr-actions';
import type {PerformanceGuideReply} from '@/packs/performance/onehr/guide-service';
import {ThinkingIndicator} from '@/components/assistant/thinking-indicator';
import {inputCls} from '@/components/ui';
type Turn={question:string;reply?:PerformanceGuideReply;error?:string};
/** This conversation is component state only: it is cleared when the page is left. */
export function PerformanceGuide(){
 const t=useTranslations('onehr.ask'),dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLTextAreaElement>(null),bottom=useRef<HTMLDivElement>(null),[question,setQuestion]=useState(''),[turns,setTurns]=useState<Turn[]>([]),[pending,start]=useTransition();
 useEffect(()=>{bottom.current?.scrollIntoView({block:'nearest'});},[turns]);
 function send(raw=question){const value=raw.trim();if(!value||pending)return;
  const history=turns.flatMap(turn=>[{role:'user' as const,content:turn.question},...(turn.reply?[{role:'agent' as const,content:turn.reply.text.slice(0,600)}]:[])]).slice(-10);
  setQuestion('');setTurns(old=>[...old,{question:value}]);
  start(async()=>{const result=await askPerformanceGuideAction(value,history);setTurns(old=>old.map((turn,i)=>i===old.length-1?{...turn,...('error'in result?{error:result.error}:{reply:result})}:turn));input.current?.focus();});
 }
 return <><button type="button" onClick={()=>dialog.current?.showModal()} className="min-h-11 rounded-md border border-border bg-card px-4 text-sm font-medium hover:bg-muted">{t('title')}</button>
 <dialog ref={dialog} aria-label={t('title')} className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-lg border-l border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/30">
  <div className="flex h-full flex-col"><header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3"><h2 className="font-semibold">{t('title')}</h2><button type="button" onClick={()=>dialog.current?.close()} className="min-h-11 px-3 text-sm hover:bg-muted">{t('close')}</button></header>
  <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5"><p className="text-sm text-muted-foreground">{t('intro')}</p>
   {!turns.length&&<div className="grid gap-2">{['todo','dates','result','after'].map(k=><button key={k} type="button" onClick={()=>send(t(k))} className="min-h-11 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-muted">{t(k)}</button>)}</div>}
   <div role="log" aria-live="polite" aria-label={t('conversation')} className="space-y-5">{turns.map((turn,i)=><section key={i} className="space-y-3"><p className="rounded-lg bg-muted px-4 py-3 text-sm">{turn.question}</p>{turn.error?<p role="alert" className="text-sm text-destructive">{turn.error}</p>:turn.reply?<><p className="whitespace-pre-wrap text-sm leading-relaxed">{turn.reply.text}</p>{turn.reply.facts.map(fact=><Link key={fact.id} href={fact.href} className="block rounded-md border border-border px-3 py-3 text-sm hover:bg-muted"><span className="font-medium text-primary">{fact.label} →</span><span className="mt-1 block text-xs text-muted-foreground">{fact.source}</span>{turn.reply?.mode==='search'&&<span className="mt-2 block text-sm">{fact.text}</span>}</Link>)}{turn.reply.mode==='search'&&!turn.reply.facts.length&&<p className="text-sm text-muted-foreground">{t('noMatches')}</p>}</>:<ThinkingIndicator label={t('thinking')}/>}</section>)}<div ref={bottom}/></div>
  </div><form onSubmit={event=>{event.preventDefault();send();}} className="space-y-2 border-t border-border p-4"><label htmlFor="performance-guide-question" className="text-sm font-medium">{t('question')}</label><textarea ref={input} id="performance-guide-question" value={question} onChange={event=>setQuestion(event.target.value)} maxLength={600} rows={2} className={`${inputCls} resize-none`} disabled={pending}/><div className="flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{t('privacy')}</p><button disabled={pending||!question.trim()} className="min-h-11 rounded-md bg-primary px-4 text-sm text-primary-foreground disabled:opacity-50">{t('send')}</button></div></form></div>
 </dialog></>;
}
