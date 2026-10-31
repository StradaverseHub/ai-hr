"use client";
import {useContext} from 'react';
import {CornerDownRight} from 'lucide-react';
import {AssistantChatSubmitContext} from './chat-submit-context';
/** Source-owned optional prompts. A click fills the person's composer; it never reads or writes. */
export function ConversationSuggestions({suggestions,label}:{suggestions:readonly {label:string;prompt:string}[];label:string}){
 const chat=useContext(AssistantChatSubmitContext);
 if(!chat?.setQuestionDraft||!suggestions.length)return null;
 return <div aria-label={label} className="space-y-1 pt-2">{suggestions.slice(0,2).map(item=><button key={item.prompt} type="button" disabled={chat.pending} onClick={()=>chat.setQuestionDraft?.(item.prompt)} className="flex min-h-11 max-w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"><CornerDownRight aria-hidden className="mt-0.5 size-4 shrink-0"/><span>{item.label}</span></button>)}</div>;
}
