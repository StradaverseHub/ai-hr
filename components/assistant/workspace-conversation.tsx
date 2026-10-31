"use client";
import {Fragment,useCallback,useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {useTranslations} from 'next-intl';
import {askFromWorkspaceAction,loadEarlierChatAction,type LauncherReply} from '../../app/assistant/launcher-actions';
import {AssistantChatBoundary} from './chat-reply-boundary';
import {WorkspaceComposer} from './workspace-composer';
import {ThinkingIndicator} from './thinking-indicator';
import {beginChatListUpdate,publishChatListUpdate} from './chat-list-updates';
import type {AiWorkspaceTaskId} from '../../lib/ai/workspace-tasks';
export type WorkspaceChatTurn={id:string;question:string;answer:ReactNode;clarificationRequired?:boolean};
type Turn={id:string;question:string;reply?:LauncherReply};
const restored=(turns:readonly WorkspaceChatTurn[]):Turn[]=>turns.map(turn=>({id:turn.id,question:turn.question,reply:{ok:true,exchangeId:turn.id,answer:turn.answer,...(turn.clarificationRequired?{clarificationRequired:true as const}:{})}}));
/** Local transcript holds only this open conversation. Every answer still comes from the authorized
 * server command; previousExchangeId is only a hint that its owner must validate, never a principal. */
export function WorkspaceConversation({initialTurn,initialTurns,initialResume,historyTailId,olderCursor,historyReadOnly=false,tasks,fileImport,composer,resetKey,fullHeight=false}:{initialTurn?:WorkspaceChatTurn;initialTurns?:readonly WorkspaceChatTurn[];initialResume?:{exchangeId:string;conversationToken:string};historyTailId?:string;olderCursor?:string|null;historyReadOnly?:boolean;tasks:readonly {id:AiWorkspaceTaskId;label:string;prompt:string}[];fileImport:boolean;resetKey?:string;fullHeight?:boolean;composer?:(props:{action:(data:FormData)=>Promise<void>;pending:boolean;question:string;setQuestion:(value:string)=>void;active:boolean})=>ReactNode}){
 const t=useTranslations('assistant'),c=useTranslations('assistant.workspace.chat');
 const seed=initialTurns??(initialTurn?[initialTurn]:[]),selectionKey=historyTailId??seed.at(-1)?.id;
 const [turns,setTurns]=useState<Turn[]>(()=>restored(seed));
 const [pending,setPending]=useState(false),[unseen,setUnseen]=useState(false),[generation,setGeneration]=useState(0),[draft,setDraft]=useState(''),[focusRequest,setFocusRequest]=useState(0),[readOnly,setReadOnly]=useState(historyReadOnly),[older,setOlder]=useState(olderCursor??null),[loadingOlder,setLoadingOlder]=useState(false),[historyError,setHistoryError]=useState<string|null>(null);
 const epoch=useRef(0),busy=useRef(false),sequence=useRef(0),log=useRef<HTMLDivElement>(null),composeBox=useRef<HTMLFieldSetElement>(null),follow=useRef(true),previous=useRef<{id:string;token:string}|undefined>(initialResume?{id:initialResume.exchangeId,token:initialResume.conversationToken}:undefined),awaitingClarification=useRef<string|undefined>(seed.at(-1)?.clarificationRequired?seed.at(-1)?.id:undefined);
 const prependAnchor=useRef<{height:number;top:number}|null>(null),didPrepend=useRef(false);
 const attachmentKey=String(selectionKey??'')+':'+String(resetKey??'')+':'+generation,attachmentOwner=useRef(attachmentKey);attachmentOwner.current=attachmentKey;
 const latestTurn=useRef<string|null>(null);latestTurn.current=turns.at(-1)?.id??null;
 const [attachment,setAttachment]=useState<{key:string;turn:WorkspaceChatTurn;afterId:string|null}|null>(null),[attachmentPending,setAttachmentPending]=useState<{key:string;busy:boolean}|null>(null);
 const attachmentTurn=attachment?.key===attachmentKey?attachment.turn:null,attachmentBusy=attachmentPending?.key===attachmentKey&&attachmentPending.busy;
 const publishAttachment=useCallback((turn:WorkspaceChatTurn|null)=>{if(attachmentOwner.current===attachmentKey)setAttachment(current=>turn?{key:attachmentKey,turn,afterId:current?.key===attachmentKey?current.afterId:latestTurn.current}:null);},[attachmentKey]);
 const publishAttachmentBusy=useCallback((value:boolean)=>{if(attachmentOwner.current===attachmentKey)setAttachmentPending({key:attachmentKey,busy:value});},[attachmentKey]);
 // A saved selection or scope reset is explicit; action revalidation alone never resets this thread.
 useEffect(()=>{epoch.current++;busy.current=false;setPending(false);setTurns(restored(seed));previous.current=initialResume?{id:initialResume.exchangeId,token:initialResume.conversationToken}:undefined;awaitingClarification.current=seed.at(-1)?.clarificationRequired?seed.at(-1)?.id:undefined;setReadOnly(historyReadOnly);setOlder(olderCursor??null);setLoadingOlder(false);setHistoryError(null);setDraft('');follow.current=true;setUnseen(false);},[selectionKey,resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
 async function earlier(){
  if(!historyTailId||!older||loadingOlder||pending||attachmentBusy)return;
  const at=epoch.current,height=log.current?.scrollHeight??0,top=log.current?.scrollTop??0;setLoadingOlder(true);setHistoryError(null);follow.current=false;
  try{const page=await loadEarlierChatAction({exchangeId:historyTailId,before:older});if(at!==epoch.current)return;
   if(!page.ok){setHistoryError(page.message);return;}
   prependAnchor.current={height,top};
   setTurns(rows=>[...restored(page.turns).filter(turn=>!rows.some(row=>row.id===turn.id)),...rows]);setOlder(page.olderCursor);
  }catch{if(at===epoch.current)setHistoryError(t('workspace.conversation.unavailable'));}finally{if(at===epoch.current)setLoadingOlder(false);}
 }
 useLayoutEffect(()=>{const anchor=prependAnchor.current;if(anchor&&log.current){log.current.scrollTop=anchor.top+log.current.scrollHeight-anchor.height;prependAnchor.current=null;didPrepend.current=true;}},[turns]);
 useEffect(()=>{if(didPrepend.current){didPrepend.current=false;return;}if(log.current&&follow.current){log.current.scrollTop=log.current.scrollHeight;setUnseen(false);}else if(turns.length||attachmentTurn)setUnseen(true);},[turns,attachmentTurn]);
 useEffect(()=>{if(focusRequest)composeBox.current?.querySelector<HTMLTextAreaElement>('textarea[name="question"]')?.focus();},[focusRequest]);
 async function send(data:FormData,clarificationExchangeId?:string){
  const question=String(data.get('question')??'').trim();if(!question||busy.current||readOnly||attachmentBusy)return;
  busy.current=true;setPending(true);setDraft('');follow.current=true;
  const clarification=clarificationExchangeId??awaitingClarification.current;
  const listTicket=beginChatListUpdate(),atEpoch=epoch.current,id=`local-${++sequence.current}`;setTurns(rows=>[...rows,{id,question}]);
  try{
   const reply=await askFromWorkspaceAction({question,...(clarification?{clarificationExchangeId:clarification}:previous.current?{previousExchangeId:previous.current.id,previousConversationToken:previous.current.token}:{})});
   if(atEpoch!==epoch.current)return;
   if(reply.ok&&reply.chatList)publishChatListUpdate(listTicket,reply.chatList);
   awaitingClarification.current=reply.ok&&reply.clarificationRequired?reply.exchangeId:undefined;
   if(!reply.ok||(!reply.conversationToken&&!reply.clarificationRequired))setReadOnly(true);
   if(reply.ok&&reply.conversationToken)previous.current={id:reply.exchangeId,token:reply.conversationToken};
   // Never silently continue past an uncertain request. The person can start a new conversation.
   else previous.current=undefined;
   setTurns(rows=>rows.map(row=>row.id===id?{...row,reply}:row));
  }catch{if(atEpoch!==epoch.current)return;setReadOnly(true);previous.current=undefined;awaitingClarification.current=undefined;setTurns(rows=>rows.map(row=>row.id===id?{...row,reply:{ok:false,message:t('err_provider_error')}}:row));}
  finally{if(atEpoch===epoch.current){busy.current=false;setPending(false);}}
 }
 const attachmentContent=attachmentTurn?<div className="space-y-4"><p className="ml-auto w-fit max-w-[90%] whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-3">{attachmentTurn.question}</p><fieldset disabled={readOnly} className="min-w-0 px-1">{attachmentTurn.answer}</fieldset></div>:null;
 return <AssistantChatBoundary value={{pending:pending||readOnly||Boolean(attachmentBusy),setQuestionDraft:answer=>{if(busy.current||readOnly||attachmentBusy)return;awaitingClarification.current=undefined;setDraft(answer);setFocusRequest(n=>n+1);},clarify:async(exchangeId,answer)=>{const data=new FormData();data.set('question',answer);await send(data,exchangeId);},setClarificationDraft:(exchangeId,answer)=>{if(busy.current||readOnly||attachmentBusy)return;awaitingClarification.current=exchangeId;setDraft(answer);setFocusRequest(n=>n+1);}}}><section aria-label={c('title')} className={fullHeight||turns.length||attachmentTurn?'flex h-[min(46rem,calc(100dvh-13rem))] min-h-80 flex-col':'space-y-4'}>
  {(fullHeight||turns.length>0||Boolean(attachmentTurn))&&<>
   <div className="flex shrink-0 items-center justify-between pb-3"><h2 className="text-sm font-medium">{c('title')}</h2><button type="button" disabled={pending||Boolean(attachmentBusy)||loadingOlder||(!turns.length&&!attachmentTurn&&!readOnly)} onClick={()=>{epoch.current++;setTurns([]);setReadOnly(false);setOlder(null);setHistoryError(null);setAttachment(null);setAttachmentPending(null);previous.current=undefined;awaitingClarification.current=undefined;setDraft('');setUnseen(false);follow.current=true;setGeneration(n=>n+1);setFocusRequest(n=>n+1);}} className="min-h-11 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60">{c('new')}</button></div>
   <div ref={log} role="log" aria-label={c('title')} aria-live="polite" aria-relevant="additions text" onScroll={()=>{const el=log.current;if(el){follow.current=el.scrollHeight-el.clientHeight-el.scrollTop<64;if(follow.current)setUnseen(false);}}} className="min-h-0 flex-1 space-y-8 overflow-y-auto overscroll-contain px-1 pb-4 text-sm leading-relaxed [overflow-anchor:none]">
    {older&&<button type="button" disabled={loadingOlder||pending||Boolean(attachmentBusy)} onClick={()=>void earlier()} className="mx-auto block min-h-11 rounded-md px-3 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60">{t('workspace.chat.older')}</button>}
    {historyError&&<p role="alert">{historyError}</p>}
    {readOnly&&<p role="status" className="text-xs text-muted-foreground">{t('workspace.chat.readOnlyHistory')}</p>}
    {turns.length===0&&!attachmentTurn&&<div className="flex min-h-full flex-col justify-center py-6"><p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{t('description')}</p>{tasks.length>0&&<div className="mt-5 flex max-w-xl flex-wrap gap-2">{tasks.slice(0,4).map(task=><button key={task.id} type="button" onClick={()=>{setDraft(task.prompt);setFocusRequest(n=>n+1);}} className="min-h-11 rounded-full border border-border px-3 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{task.label}</button>)}</div>}</div>}
    {attachment?.afterId===null&&attachmentContent}
    {turns.map(turn=><Fragment key={turn.id}><div className="space-y-4">
     <p className="ml-auto w-fit max-w-[90%] whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-3">{turn.question}</p>
     <fieldset disabled={readOnly} className="min-w-0 break-words px-1">{!turn.reply?<ThinkingIndicator label={c('thinking')}/>:turn.reply.ok?(turn.reply.answer??<p role="status">{t('workspace.conversation.unavailable')}</p>):<p role="alert">{turn.reply.message}</p>}</fieldset>
    </div>{attachment?.afterId===turn.id&&attachmentContent}</Fragment>)}
   </div>
   {unseen&&<button type="button" onClick={()=>{follow.current=true;if(log.current)log.current.scrollTop=log.current.scrollHeight;setUnseen(false);}} className="mx-auto block min-h-11 rounded-full border border-border px-4 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{c('latest')}</button>}
  </>}
  <fieldset disabled={readOnly} ref={composeBox} className={fullHeight||turns.length||attachmentTurn?'shrink-0 pt-3':undefined}>{composer?<div key={attachmentKey}>{composer({action:send,pending,question:draft,setQuestion:setDraft,active:turns.length>0})}</div>:<WorkspaceComposer key={attachmentKey} fileImport={fileImport} clearAfterSubmit clientSubmit pending={pending} question={draft} onQuestionChange={setDraft} onAttachmentTurn={publishAttachment} onAttachmentBusy={publishAttachmentBusy} layout="hero" action={send} tasks={fullHeight||turns.length||attachmentTurn?[]:tasks} labels={{tasks:t('workspace.tasks'),taskHint:t('workspace.taskHint'),question:t('workspace.question'),placeholder:t('placeholder'),ask:t('ask'),working:t('workspace.working'),scope:t('scopeNote')}}/>}</fieldset>
 <details className="shrink-0 pt-2 text-xs leading-relaxed text-muted-foreground"><summary className="min-h-8 w-fit cursor-pointer py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('home.privacy')}</summary><p className="pb-2">{c('privacy')}</p></details>
 </section></AssistantChatBoundary>;
}
