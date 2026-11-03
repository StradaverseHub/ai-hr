'use client';

import {useId,useRef,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {ArrowUp,Sparkles} from 'lucide-react';
import {ASK_PATH,MAX_HANDOFF_CHARS,storeAskHandoff} from '@/lib/today/ask-handoff';

const sessionStore=()=>{try{return window.sessionStorage;}catch{return null;}};

/** Today's Ask bar. It is the door to AI Centre Ask, not a second assistant: pressing Ask opens /assistant and
 * the question is sent there through the existing conversation command, under the Assistant's own checks
 * (lib/today/ask-handoff.ts says how the words travel without entering the address). Suggestion chips only
 * fill the box; nothing is sent until the person presses Ask. Rendered only for someone the Assistant can
 * answer (components/today/today-page.tsx). */
export function TodayAsk({label,placeholder,submitLabel,openingLabel,suggestionsLabel,suggestions=[]}:{
 label:string;placeholder:string;submitLabel:string;openingLabel:string;suggestionsLabel:string;suggestions?:readonly string[];
}){
 const router=useRouter(),id=useId(),box=useRef<HTMLInputElement>(null);
 const [value,setValue]=useState(''),[pending,start]=useTransition();
 const send=()=>{
  const question=value.trim();
  if(!question||pending)return;
  storeAskHandoff(sessionStore(),question);
  start(()=>router.push(ASK_PATH));
 };
 return <div data-today-ask className="space-y-3">
  <form onSubmit={event=>{event.preventDefault();send();}}
   className="flex items-center gap-2 rounded-xl border border-input bg-card px-3 py-1.5 shadow-sm focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/20">
   <Sparkles aria-hidden className="size-4 shrink-0 text-primary"/>
   <label htmlFor={id} className="sr-only">{label}</label>
   <input ref={box} id={id} name="question" type="text" autoComplete="off" maxLength={MAX_HANDOFF_CHARS} value={value} readOnly={pending}
    onChange={event=>setValue(event.target.value)} placeholder={placeholder}
    className="min-h-11 min-w-0 flex-1 bg-transparent text-[0.9375rem] outline-none placeholder:text-muted-foreground"/>
   <button type="submit" disabled={!value.trim()||pending} aria-busy={pending} aria-label={pending?openingLabel:submitLabel} title={submitLabel}
    className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60">
    <ArrowUp aria-hidden className="size-4"/>
   </button>
  </form>
  {suggestions.length>0&&<div role="group" aria-label={suggestionsLabel} className="flex flex-wrap gap-2">
   {suggestions.map(text=><button key={text} type="button" disabled={pending} onClick={()=>{setValue(text);box.current?.focus();}}
    className="min-h-9 rounded-full border border-border bg-card px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 pointer-coarse:min-h-11">{text}</button>)}
  </div>}
 </div>;
}
