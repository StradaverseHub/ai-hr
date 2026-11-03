"use client";
import {Fragment,useCallback,useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {useTranslations} from 'next-intl';
import {askFromWorkspaceAction,loadEarlierChatAction,type LauncherReply} from '../../app/assistant/launcher-actions';
import {AssistantChatBoundary} from './chat-reply-boundary';
import {WorkspaceComposer} from './workspace-composer';
import {ThinkingIndicator} from './thinking-indicator';
import type {AiWorkspaceTaskId} from '../../lib/ai/workspace-tasks';
import {takeAskHandoff} from '../../lib/today/ask-handoff';
import {ASK_AI_CENTRE_EVENT,unclaimedAskQuestion} from '../../lib/command-bar-events';
import {useAskChatsLink} from '../ai-centre/ask-chats-context';
import {AttachedFileChip,TurnImportFile} from '../ai-centre/chat-import-attach';
import {chatImportFileInput,type ChatImportFile} from '../../lib/chat-import';
export type WorkspaceChatTurn={id:string;question:string;answer:ReactNode;clarificationRequired?:boolean};
type Turn={id:string;question:string;reply?:LauncherReply;
 /** AI v2 slice 3: the file the person sent with this question: its chip, and the file itself for this turn's card. */
 file?:{name:string;rows:number};importFile?:ChatImportFile};
/** The chip a sent file shows, read back from the composer's form data; anything malformed shows none. */
function fileChipOf(data:FormData):{name:string;rows:number}|undefined{
 try{const value=JSON.parse(String(data.get('importFileChip')??''));return value&&typeof value.name==='string'&&Number.isInteger(value.rows)?{name:value.name.slice(0,255),rows:value.rows}:undefined;}catch{return undefined;}
}
function importFileOf(data:FormData):ChatImportFile|undefined{
 const raw=data.get('importFile');if(typeof raw!=='string'||!raw)return undefined;
 try{return chatImportFileInput(JSON.parse(raw))??undefined;}catch{return undefined;}
}
const restored=(turns:readonly WorkspaceChatTurn[]):Turn[]=>turns.map(turn=>({id:turn.id,question:turn.question,reply:{ok:true,exchangeId:turn.id,answer:turn.answer,...(turn.clarificationRequired?{clarificationRequired:true as const}:{})}}));
/** Local transcript holds only this open conversation. Every answer still comes from the authorized
 * server command; previousExchangeId is only a hint that its owner must validate, never a principal. */
export function WorkspaceConversation({initialTurn,initialTurns,initialResume,historyTailId,olderCursor,historyReadOnly=false,tasks,fileImport,chatImport=false,composer,resetKey,fullHeight=false,acceptHandoff=false,fill=false,acceptCommandBar=false}:{initialTurn?:WorkspaceChatTurn;initialTurns?:readonly WorkspaceChatTurn[];initialResume?:{exchangeId:string;conversationToken:string};historyTailId?:string;olderCursor?:string|null;historyReadOnly?:boolean;tasks:readonly {id:AiWorkspaceTaskId;label:string;prompt:string}[];fileImport:boolean;resetKey?:string;fullHeight?:boolean;
 /** Today's Ask bar (lib/today/ask-handoff.ts): on a fresh Ask page, send the question typed there, once. */
 acceptHandoff?:boolean;
 /** AI v2 W4 (issue 14): Ask's chat-only layout. The conversation fills its column (it scrolls on its own, the composer
  * is pinned); the title, New chat and Delete live in the Chats column and its header (components/ai-centre/ask-chats.tsx),
  * and the privacy notes moved to Your data and privacy. */
 fill?:boolean;
 /** AI v2 W4: on Ask, a question typed in the command bar (lib/command-bar-events.ts) is sent here, in this chat. */
 acceptCommandBar?:boolean;
 /** AI v2 slice 3 (issue 16b): the composer attaches a file to import with the next question (harness callers who may import). */
 chatImport?:boolean;composer?:(props:{action:(data:FormData)=>Promise<void>;pending:boolean;question:string;setQuestion:(value:string)=>void;active:boolean})=>ReactNode}){
 const t=useTranslations('assistant'),c=useTranslations('assistant.workspace.chat'),askChats=useAskChatsLink();
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
  const importFile=importFileOf(data),file=importFile?fileChipOf(data):undefined;
  const atEpoch=epoch.current,id=`local-${++sequence.current}`;setTurns(rows=>[...rows,{id,question,...(file&&importFile?{file,importFile}:{})}]);
  try{
   const reply=await askFromWorkspaceAction({question,...(importFile===undefined?{}:{importFile}),...(clarification?{clarificationExchangeId:clarification}:previous.current?{previousExchangeId:previous.current.id,previousConversationToken:previous.current.token}:{})});
   if(atEpoch!==epoch.current)return;
   awaitingClarification.current=reply.ok&&reply.clarificationRequired?reply.exchangeId:undefined;
   if(!reply.ok||(!reply.conversationToken&&!reply.clarificationRequired))setReadOnly(true);
   if(reply.ok&&reply.conversationToken)previous.current={id:reply.exchangeId,token:reply.conversationToken};
   // Never silently continue past an uncertain request. The person can start a new conversation.
   else previous.current=undefined;
   setTurns(rows=>rows.map(row=>row.id===id?{...row,reply}:row));
   if(reply.ok&&reply.chatId)askChats?.storedChat(reply.chatId);
  }catch{if(atEpoch!==epoch.current)return;setReadOnly(true);previous.current=undefined;awaitingClarification.current=undefined;setTurns(rows=>rows.map(row=>row.id===id?{...row,reply:{ok:false,message:t('err_provider_error')}}:row));}
  finally{if(atEpoch===epoch.current){busy.current=false;setPending(false);}}
 }
 // Today's Ask bar hands its question over in this tab's storage; it is read once, removed, and sent through the
 // same command as a typed question. Only a fresh Ask page accepts it (takeAskHandoff checks the address).
 useEffect(()=>{if(!acceptHandoff)return;let store:Storage|null=null;try{store=window.sessionStorage;}catch{/* No storage: nothing was handed over. */}
  const question=takeAskHandoff(store,window.location);if(!question)return;const data=new FormData();data.set('question',question);void send(data);},[]); // eslint-disable-line react-hooks/exhaustive-deps
 // The command bar on Ask (lib/command-bar-events.ts): the question joins this chat exactly as if typed here. While a
 // reply is pending the bar is told 'busy'; a conversation that cannot continue leaves it unclaimed, so the bar opens
 // a new Ask chat instead.
 const sendRef=useRef(send);sendRef.current=send;
 const claimState=useRef({readOnly,attachmentBusy});claimState.current={readOnly,attachmentBusy:Boolean(attachmentBusy)};
 useEffect(()=>{if(!acceptCommandBar)return;
  const onAsk=(event:Event)=>{const claim=unclaimedAskQuestion(event);if(!claim||claimState.current.readOnly)return;
   if(busy.current||claimState.current.attachmentBusy){claim.detail.result='busy';return;}
   claim.detail.result='sent';const data=new FormData();data.set('question',claim.question);void sendRef.current(data);};
  window.addEventListener(ASK_AI_CENTRE_EVENT,onAsk);return()=>window.removeEventListener(ASK_AI_CENTRE_EVENT,onAsk);},[acceptCommandBar]);
 const tall=fullHeight||fill||turns.length>0||Boolean(attachmentTurn);
 const attachmentContent=attachmentTurn?<div className="space-y-4"><p className="ml-auto w-fit max-w-[90%] whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-3">{attachmentTurn.question}</p><fieldset disabled={readOnly} className="min-w-0 px-1">{attachmentTurn.answer}</fieldset></div>:null;
 return <AssistantChatBoundary value={{pending:pending||readOnly||Boolean(attachmentBusy),setQuestionDraft:answer=>{if(busy.current||readOnly||attachmentBusy)return;awaitingClarification.current=undefined;setDraft(answer);setFocusRequest(n=>n+1);},clarify:async(exchangeId,answer)=>{const data=new FormData();data.set('question',answer);await send(data,exchangeId);},setClarificationDraft:(exchangeId,answer)=>{if(busy.current||readOnly||attachmentBusy)return;awaitingClarification.current=exchangeId;setDraft(answer);setFocusRequest(n=>n+1);}}}><section aria-label={c('title')} className={fill?'flex h-full min-h-0 flex-1 flex-col':fullHeight||turns.length||attachmentTurn?'flex h-[min(46rem,calc(100dvh-13rem))] min-h-80 flex-col':'space-y-4'}>
  {tall&&<>
   {!fill&&<div className="flex shrink-0 items-center justify-between pb-3"><h2 className="text-sm font-medium">{c('title')}</h2><button type="button" disabled={pending||Boolean(attachmentBusy)||loadingOlder||(!turns.length&&!attachmentTurn&&!readOnly)} onClick={()=>{epoch.current++;setTurns([]);setReadOnly(false);setOlder(null);setHistoryError(null);setAttachment(null);setAttachmentPending(null);previous.current=undefined;awaitingClarification.current=undefined;setDraft('');setUnseen(false);follow.current=true;setGeneration(n=>n+1);setFocusRequest(n=>n+1);}} className="min-h-11 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60">{c('new')}</button></div>}
   <div ref={log} role="log" aria-label={c('title')} aria-live="polite" aria-relevant="additions text" onScroll={()=>{const el=log.current;if(el){follow.current=el.scrollHeight-el.clientHeight-el.scrollTop<64;if(follow.current)setUnseen(false);}}} className={`min-h-0 flex-1 space-y-8 overflow-y-auto overscroll-contain px-1 pb-4 text-sm leading-relaxed [overflow-anchor:none]${fill?' pt-4':''}`}>
    {older&&<button type="button" disabled={loadingOlder||pending||Boolean(attachmentBusy)} onClick={()=>void earlier()} className="mx-auto block min-h-11 rounded-md px-3 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60">{t('workspace.chat.older')}</button>}
    {historyError&&<p role="alert">{historyError}</p>}
    {readOnly&&<p role="status" className="text-xs text-muted-foreground">{t('workspace.chat.readOnlyHistory')}</p>}
    {turns.length===0&&!attachmentTurn&&<div className="flex min-h-full flex-col justify-center py-6"><p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{t('description')}</p>{tasks.length>0&&<div className="mt-5 flex max-w-xl flex-wrap gap-2">{tasks.slice(0,4).map(task=><button key={task.id} type="button" onClick={()=>{setDraft(task.prompt);setFocusRequest(n=>n+1);}} className="min-h-11 rounded-full border border-border px-3 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{task.label}</button>)}</div>}</div>}
    {attachment?.afterId===null&&attachmentContent}
    {turns.map(turn=><Fragment key={turn.id}><div className="space-y-4">
     <p className="ml-auto w-fit max-w-[90%] whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-3">{turn.question}{turn.file&&<span className="mt-1.5 flex"><AttachedFileChip file={turn.file}/></span>}</p>
     <fieldset disabled={readOnly} className="min-w-0 break-words px-1"><TurnImportFile.Provider value={turn.importFile??null}>{!turn.reply?<ThinkingIndicator label={c('thinking')}/>:turn.reply.ok?(turn.reply.answer??<p role="status">{t('workspace.conversation.unavailable')}</p>):<p role="alert">{turn.reply.message}</p>}</TurnImportFile.Provider></fieldset>
    </div>{attachment?.afterId===turn.id&&attachmentContent}</Fragment>)}
   </div>
   {unseen&&<button type="button" onClick={()=>{follow.current=true;if(log.current)log.current.scrollTop=log.current.scrollHeight;setUnseen(false);}} className="mx-auto block min-h-11 rounded-full border border-border px-4 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{c('latest')}</button>}
  </>}
  <fieldset disabled={readOnly} ref={composeBox} className={tall?'shrink-0 pt-3':undefined}>{composer?<div key={attachmentKey}>{composer({action:send,pending,question:draft,setQuestion:setDraft,active:turns.length>0})}</div>:<WorkspaceComposer key={attachmentKey} fileImport={fileImport&&!chatImport} chatImport={chatImport} clearAfterSubmit clientSubmit pending={pending} question={draft} onQuestionChange={setDraft} onAttachmentTurn={publishAttachment} onAttachmentBusy={publishAttachmentBusy} layout="hero" action={send} tasks={tall?[]:tasks} labels={{tasks:t('workspace.tasks'),taskHint:t('workspace.taskHint'),question:t('workspace.question'),placeholder:t('placeholder'),ask:t('ask'),working:t('workspace.working'),scope:t('scopeNote')}}/>}</fieldset>
 {!fill&&<details className="shrink-0 pt-2 text-xs leading-relaxed text-muted-foreground"><summary className="min-h-8 w-fit cursor-pointer py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('home.privacy')}</summary><p className="pb-2">{c('privacy')}</p></details>}
 </section></AssistantChatBoundary>;
}
