"use client";
import {useContext,useState} from 'react';
import {useFormStatus} from 'react-dom';
import {AssistantChatSubmitContext} from './chat-submit-context';
import {askAssistantAction} from '../../app/assistant/actions';
/** The native owned clarification path is retained; active chats provide only an in-place transport. */
export function ConversationClarification({exchangeId,replyLabel,continueLabel,choices,choicesVisible=false}:{exchangeId:string;replyLabel:string;continueLabel:string;choices?:readonly {label:string;prompt:string}[];choicesVisible?:boolean}){
 const chat=useContext(AssistantChatSubmitContext);
 // In an active chat, the one main composer owns the next answer. Keep the native standalone form
 // for reopened records outside a chat; optional shortcuts only fill that same composer.
 if(chat?.setClarificationDraft){
  if(!choices?.length)return null;
  const options=<div role="group" aria-label={replyLabel} className="flex flex-wrap gap-2">{choices.map(choice=><button key={choice.prompt} type="button" disabled={chat.pending} onClick={()=>chat.setClarificationDraft?.(exchangeId,choice.prompt)} className="min-h-11 max-w-full break-words rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60">{choice.label}</button>)}</div>;
  return choicesVisible?options:<details className="text-xs text-muted-foreground"><summary className="w-fit min-h-11 cursor-pointer py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{replyLabel}</summary>{options}</details>;
 }
 return <form action={chat?undefined:askAssistantAction} onSubmit={chat?event=>{event.preventDefault();if(!chat.pending){const data=new FormData(event.currentTarget);void chat.clarify(exchangeId,String(data.get('clarificationAnswer')??''));}}:undefined} className="space-y-3">
  <input type="hidden" name="clarificationExchangeId" value={exchangeId}/>
  <Fields replyLabel={replyLabel} continueLabel={continueLabel} pending={chat?.pending} choices={choices}/>
 </form>;
}
function Fields({replyLabel,continueLabel,pending,choices}:{replyLabel:string;continueLabel:string;pending?:boolean;choices?:readonly {label:string;prompt:string}[]}){
 const [value,setValue]=useState('');
 const form=useFormStatus(),busy=pending??form.pending;
 return <>{choices&&choices.length>0&&<div className="flex flex-wrap gap-2">{choices.map(choice=><button key={choice.prompt} type="button" disabled={busy} onClick={()=>setValue(choice.prompt)} className="min-h-11 rounded-full border px-3 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60">{choice.label}</button>)}</div>}<label className="block text-sm">{replyLabel}<textarea name="clarificationAnswer" value={value} onChange={event=>setValue(event.target.value)} required readOnly={busy} maxLength={500} rows={2} className="mt-1 min-h-11 w-full rounded-md border bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"/></label>
 <button type="submit" disabled={busy} aria-busy={busy} className="min-h-11 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60">{continueLabel}</button></>;
}
