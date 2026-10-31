"use client";
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {useTranslations} from 'next-intl';
import {askFromWorkspaceAction,type LauncherReply} from '../../app/assistant/launcher-actions';
import {AssistantChatBoundary} from './chat-reply-boundary';
import {WorkspaceComposer} from './workspace-composer';
import {ThinkingIndicator} from './thinking-indicator';
import type {AiWorkspaceTaskId} from '../../lib/ai/workspace-tasks';
export type WorkspaceChatTurn={id:string;question:string;answer:ReactNode;clarificationRequired?:boolean};
type Turn={id:string;question:string;reply?:LauncherReply};
/** Local transcript holds only this open conversation. Every answer still comes from the authorized
 * server command; previousExchangeId is only a hint that its owner must validate, never a principal. */
export function WorkspaceConversation({initialTurn,tasks,fileImport,composer,resetKey,fullHeight=false}:{initialTurn?:WorkspaceChatTurn;tasks:readonly {id:AiWorkspaceTaskId;label:string;prompt:string}[];fileImport:boolean;resetKey?:string;fullHeight?:boolean;composer?:(props:{action:(data:FormData)=>Promise<void>;pending:boolean;question:string;setQuestion:(value:string)=>void;active:boolean})=>ReactNode}){
 const t=useTranslations('assistant'),c=useTranslations('assistant.workspace.chat');
 const [turns,setTurns]=useState<Turn[]>(()=>initialTurn?[{id:initialTurn.id,question:initialTurn.question,reply:{ok:true,exchangeId:initialTurn.id,answer:initialTurn.answer,...(initialTurn.clarificationRequired?{clarificationRequired:true as const}:{})}}]:[]);
 const [pending,setPending]=useState(false),[unseen,setUnseen]=useState(false),[generation,setGeneration]=useState(0),[draft,setDraft]=useState(''),[focusRequest,setFocusRequest]=useState(0);
 const epoch=useRef(0),busy=useRef(false),sequence=useRef(0),log=useRef<HTMLDivElement>(null),composeBox=useRef<HTMLDivElement>(null),follow=useRef(true),previous=useRef<{id:string;token:string}|undefined>(undefined),awaitingClarification=useRef<string|undefined>(initialTurn?.clarificationRequired?initialTurn.id:undefined);
 // A deep-link selection is an explicit new conversation selection, unlike action revalidation.
 useEffect(()=>{epoch.current++;busy.current=false;setPending(false);setTurns(initialTurn?[{id:initialTurn.id,question:initialTurn.question,reply:{ok:true,exchangeId:initialTurn.id,answer:initialTurn.answer,...(initialTurn.clarificationRequired?{clarificationRequired:true as const}:{})}}]:[]);previous.current=undefined;awaitingClarification.current=initialTurn?.clarificationRequired?initialTurn.id:undefined;setDraft('');follow.current=true;setUnseen(false);},[initialTurn?.id,resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
 useEffect(()=>{if(log.current&&follow.current){log.current.scrollTop=log.current.scrollHeight;setUnseen(false);}else if(turns.length)setUnseen(true);},[turns]);
 useEffect(()=>{if(focusRequest)composeBox.current?.querySelector<HTMLTextAreaElement>('textarea[name="question"]')?.focus();},[focusRequest]);
 async function send(data:FormData,clarificationExchangeId?:string){
  const question=String(data.get('question')??'').trim();if(!question||busy.current)return;
  busy.current=true;setPending(true);setDraft('');follow.current=true;
  const clarification=clarificationExchangeId??awaitingClarification.current;
  const atEpoch=epoch.current,id=`local-${++sequence.current}`;setTurns(rows=>[...rows,{id,question}]);
  try{
   const reply=await askFromWorkspaceAction({question,...(clarification?{clarificationExchangeId:clarification}:previous.current?{previousExchangeId:previous.current.id,previousConversationToken:previous.current.token}:{})});
   if(atEpoch!==epoch.current)return;
   awaitingClarification.current=reply.ok&&reply.clarificationRequired?reply.exchangeId:undefined;
   if(reply.ok&&reply.conversationToken)previous.current={id:reply.exchangeId,token:reply.conversationToken};
   // Never silently continue past an uncertain request. The person can start a new conversation.
   else previous.current=undefined;
   setTurns(rows=>rows.map(row=>row.id===id?{...row,reply}:row));
  }catch{if(atEpoch!==epoch.current)return;previous.current=undefined;awaitingClarification.current=undefined;setTurns(rows=>rows.map(row=>row.id===id?{...row,reply:{ok:false,message:t('err_provider_error')}}:row));}
  finally{if(atEpoch===epoch.current){busy.current=false;setPending(false);}}
 }
 return <AssistantChatBoundary value={{pending,clarify:async(exchangeId,answer)=>{const data=new FormData();data.set('question',answer);await send(data,exchangeId);},setClarificationDraft:(exchangeId,answer)=>{if(busy.current)return;awaitingClarification.current=exchangeId;setDraft(answer);setFocusRequest(n=>n+1);}}}><section aria-label={c('title')} className={fullHeight||turns.length?'flex h-[min(46rem,calc(100dvh-13rem))] min-h-80 flex-col':'space-y-4'}>
  {(fullHeight||turns.length>0)&&<>
   <div className="flex shrink-0 items-center justify-between pb-3"><h2 className="text-sm font-medium">{c('title')}</h2><button type="button" disabled={pending||turns.length===0} onClick={()=>{epoch.current++;setTurns([]);previous.current=undefined;awaitingClarification.current=undefined;setDraft('');setUnseen(false);follow.current=true;setGeneration(n=>n+1);setFocusRequest(n=>n+1);}} className="min-h-11 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60">{c('new')}</button></div>
   <div ref={log} role="log" aria-label={c('title')} aria-live="polite" aria-relevant="additions text" onScroll={()=>{const el=log.current;if(el){follow.current=el.scrollHeight-el.clientHeight-el.scrollTop<64;if(follow.current)setUnseen(false);}}} className="min-h-0 flex-1 space-y-8 overflow-y-auto overscroll-contain px-1 pb-4 text-sm leading-relaxed [overflow-anchor:none]">
    {turns.length===0&&<div className="flex min-h-full flex-col justify-center py-6"><p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{t('description')}</p>{tasks.length>0&&<div className="mt-5 flex max-w-xl flex-wrap gap-2">{tasks.slice(0,4).map(task=><button key={task.id} type="button" onClick={()=>{setDraft(task.prompt);setFocusRequest(n=>n+1);}} className="min-h-11 rounded-full border border-border px-3 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{task.label}</button>)}</div>}</div>}
    {turns.map(turn=><div key={turn.id} className="space-y-4">
     <p className="ml-auto w-fit max-w-[90%] whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-3">{turn.question}</p>
     <div className="min-w-0 break-words px-1">{!turn.reply?<ThinkingIndicator label={c('thinking')}/>:turn.reply.ok?(turn.reply.answer??<p role="status">{t('workspace.conversation.unavailable')}</p>):<p role="alert">{turn.reply.message}</p>}</div>
    </div>)}
   </div>
   {unseen&&<button type="button" onClick={()=>{follow.current=true;if(log.current)log.current.scrollTop=log.current.scrollHeight;setUnseen(false);}} className="mx-auto block min-h-11 rounded-full border border-border px-4 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{c('latest')}</button>}
  </>}
  <div ref={composeBox} className={fullHeight||turns.length?'shrink-0 pt-3':undefined}>{composer?<div key={generation}>{composer({action:send,pending,question:draft,setQuestion:setDraft,active:turns.length>0})}</div>:<WorkspaceComposer key={generation} fileImport={fileImport} clearAfterSubmit clientSubmit pending={pending} question={draft} onQuestionChange={setDraft} layout="hero" action={send} tasks={fullHeight||turns.length?[]:tasks} labels={{tasks:t('workspace.tasks'),taskHint:t('workspace.taskHint'),question:t('workspace.question'),placeholder:t('placeholder'),ask:t('ask'),working:t('workspace.working'),scope:t('scopeNote')}}/>}</div>
 <details className="shrink-0 pt-2 text-xs leading-relaxed text-muted-foreground"><summary className="min-h-8 w-fit cursor-pointer py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('home.privacy')}</summary><p className="pb-2">{c('privacy')}</p></details>
 </section></AssistantChatBoundary>;
}
