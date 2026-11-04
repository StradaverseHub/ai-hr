'use client';

import {useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {Sparkles} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {ASK_PATH,storeAskHandoff} from '@/lib/today/ask-handoff';

const sessionStore=()=>{try{return window.sessionStorage;}catch{return null;}};

/** AI v2 W5 — "Ask AI Centre about this" under a "Why?" panel. It opens AI Centre Ask with the panel's question, through
 * the same one-navigation handoff Today's Ask bar uses (lib/today/ask-handoff.ts): the words never enter the address,
 * and Ask sends them through the existing conversation command under the Assistant's own checks. The question names
 * what the panel explains (the month, the deduction, the leave or claim type), never a figure. Rendered only for
 * someone the Assistant can answer. */
export function WhyAsk({question,label,openingLabel}:{question:string;label:string;openingLabel:string}){
 const router=useRouter(),[pending,start]=useTransition();
 return <Button type="button" variant="outline" size="sm" disabled={pending} aria-busy={pending} data-why-ask
  className="min-h-9 gap-1.5 pointer-coarse:min-h-11"
  onClick={()=>{if(pending)return;storeAskHandoff(sessionStore(),question);start(()=>router.push(ASK_PATH));}}>
  <Sparkles aria-hidden className="size-3.5"/>{pending?openingLabel:label}
 </Button>;
}
