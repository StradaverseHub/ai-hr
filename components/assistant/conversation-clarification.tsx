"use client";
import {useContext} from 'react';
import {useFormStatus} from 'react-dom';
import {AssistantChatSubmitContext} from './chat-submit-context';
import {askAssistantAction} from '../../app/assistant/actions';
/** The native owned clarification path is retained; active chats provide only an in-place transport. */
export function ConversationClarification({exchangeId,replyLabel,continueLabel}:{exchangeId:string;replyLabel:string;continueLabel:string}){
 const chat=useContext(AssistantChatSubmitContext);
 return <form action={chat?undefined:askAssistantAction} onSubmit={chat?event=>{event.preventDefault();if(!chat.pending){const data=new FormData(event.currentTarget);void chat.clarify(exchangeId,String(data.get('clarificationAnswer')??''));}}:undefined} className="space-y-3">
  <input type="hidden" name="clarificationExchangeId" value={exchangeId}/>
  <Fields replyLabel={replyLabel} continueLabel={continueLabel} pending={chat?.pending}/>
 </form>;
}
function Fields({replyLabel,continueLabel,pending}:{replyLabel:string;continueLabel:string;pending?:boolean}){
 const form=useFormStatus(),busy=pending??form.pending;
 return <><label className="block text-sm">{replyLabel}<textarea name="clarificationAnswer" required readOnly={busy} maxLength={500} rows={2} className="mt-1 min-h-11 w-full rounded-md border bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"/></label>
 <button type="submit" disabled={busy} aria-busy={busy} className="min-h-11 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60">{continueLabel}</button></>;
}
