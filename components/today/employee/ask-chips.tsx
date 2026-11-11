'use client';

import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useTransition} from 'react';
import {ActionButton} from '@/components/ui/action-button';
import {ASK_PATH,storeAskHandoff} from '@/lib/today/ask-handoff';

/** Employee Today's Ask chips (Coming up panel). A chip with a question hands it to AI Centre Ask: the words travel in
 * this tab's session storage for the one navigation (lib/today/ask-handoff.ts), never in the address, and AI Centre
 * sends them through its own conversation command with its own checks. A chip with an `href` is a plain link to the
 * page that does it. Shown with questions only to someone the Assistant can answer; otherwise every chip is a link. */
export type AskChip=Readonly<{text:string;question?:string;href?:string}>;
const CHIP='inline-flex min-h-9 items-center rounded-full border border-border bg-card px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 pointer-coarse:min-h-11';
const sessionStore=()=>{try{return window.sessionStorage;}catch{return null;}};

export function AskChips({label,chips}:{label:string;chips:readonly AskChip[]}){
 const router=useRouter(),[pending,start]=useTransition();
 const ask=(question:string)=>{
  if(pending||!storeAskHandoff(sessionStore(),question))return;
  start(()=>router.push(ASK_PATH));
 };
 if(!chips.length)return null;
 return <div role="group" aria-label={label} data-today-ask-chips className="flex flex-wrap gap-2">
  {chips.map(chip=>chip.question
   ?<ActionButton key={chip.text} type="button" disabled={pending} aria-busy={pending} onClick={()=>ask(chip.question!)} data-today-ask-chip className={CHIP}>{chip.text}</ActionButton>
   :<Link key={chip.text} href={chip.href??ASK_PATH} data-today-ask-link className={CHIP}>{chip.text}</Link>)}
 </div>;
}
