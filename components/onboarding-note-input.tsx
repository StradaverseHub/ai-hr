'use client';

import { useId, useRef, useState } from 'react';
import { Field, inputCls } from '@/components/ui';
import { useOnboardingCopy } from '@/lib/onboarding-copy';

/** Mention IDs come only from the authorized directory, never from a typed display name. */
export function OnboardingNoteInput({ label, body, mentions, directory, onChange, onMentions }: {
  label:string; body:string; mentions:string[]; directory:{id:string;name:string}[];
  onChange:(value:string)=>void; onMentions:(value:string[])=>void;
}) {
  const copy=useOnboardingCopy(), id=useId(), input=useRef<HTMLTextAreaElement>(null);
  const [query,setQuery]=useState<{start:number;end:number;text:string}|null>(null),[active,setActive]=useState(0);
  const choices=query?directory.filter(u=>!mentions.includes(u.id)&&u.name.toLocaleLowerCase().includes(query.text.toLocaleLowerCase())).slice(0,8):[];
  const select=(user:{id:string;name:string})=>{
    if(!query)return;
    const inserted='@'+user.name+' ', next=body.slice(0,query.start)+inserted+body.slice(query.end);
    onChange(next);onMentions([...new Set([...mentions,user.id])]);setQuery(null);
    requestAnimationFrame(()=>{input.current?.focus();input.current?.setSelectionRange(query.start+inserted.length,query.start+inserted.length);});
  };
  return <div className="space-y-2"><Field label={label}><textarea ref={input} className={inputCls+' h-auto py-2'} rows={3} value={body} placeholder={copy('Write a note. Type @ to mention a colleague.')} aria-controls={query?id:undefined} aria-activedescendant={query&&choices.length?id+'-'+active:undefined} onChange={e=>{const value=e.target.value,end=e.target.selectionStart,match=/(?:^|\s)@([^@\n]{0,60})$/.exec(value.slice(0,end));onChange(value);setActive(0);setQuery(match?{start:end-match[1]!.length-1,end,text:match[1]!}:null);}} onKeyDown={e=>{if(!query)return;if(e.key==='Escape'){e.preventDefault();setQuery(null);}else if(choices.length&&(e.key==='ArrowDown'||e.key==='ArrowUp')){e.preventDefault();setActive((active+(e.key==='ArrowDown'?1:-1)+choices.length)%choices.length);}else if(choices.length&&e.key==='Enter'){e.preventDefault();select(choices[active]??choices[0]!);}}}/></Field>
    {query&&<div id={id} role="listbox" aria-label={copy('Mention colleagues')} className="rounded-md border border-border bg-popover p-1 text-popover-foreground">{choices.length?choices.map((u,index)=><button key={u.id} id={id+'-'+index} type="button" role="option" aria-selected={index===active} className={'block w-full rounded px-3 py-2 text-left text-sm '+(index===active?'bg-accent':'hover:bg-accent')} onClick={()=>select(u)}>{u.name}</button>):<p className="p-2 text-sm text-muted-foreground">{copy('No colleagues match this mention.')}</p>}</div>}
    {mentions.length>0&&<div className="flex flex-wrap gap-2" aria-label={copy('Mentioned colleagues')}>{mentions.map(userId=><button key={userId} type="button" className="rounded-full border border-border px-3 py-1 text-xs" aria-label={copy('Remove mention')+' '+(directory.find(u=>u.id===userId)?.name??copy('Colleague'))} onClick={()=>onMentions(mentions.filter(x=>x!==userId))}>@{directory.find(u=>u.id===userId)?.name??copy('Colleague')} ×</button>)}</div>}
  </div>;
}
