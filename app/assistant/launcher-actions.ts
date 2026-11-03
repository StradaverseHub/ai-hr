'use server';

import type { ReactNode } from 'react';
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { getBrowserCommandSession } from '@/lib/session';
import { AuthRequiredError } from '@/lib/auth-errors';
import {assistantSocialIntent} from '@/lib/ai/assistant-answer-plan';
import {AssistantClarificationError} from '@/core/assistant-clarification';
import { askAssistant, AssistantError } from '@/core/assistant';
import { loadAiWorkspace } from '@/core/ai-workspace';
import { resolvePageContext } from '@/lib/ai/page-context';
import {assistantBrowserConversationScope} from './conversation-scope';
import {listOwnAssistantChats,loadOwnAssistantChat} from '@/core/assistant-threads';
import { ExchangeReply } from '@/components/assistant/exchange-reply';
import { getLocale } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import type { ConversationRoute } from '@/core/teras-wiring/switch';
import type { ConversationTurn } from '@/core/teras-wiring/turn';
import { chatImportFileInput, type ChatImportFile } from '@/lib/chat-import';

export type LauncherReply =
  /** chatId (AI Centre issue 18): the stored chat a harness turn was written to, which Ask reopens (/assistant?chat=). */
  | { ok: true; exchangeId: string; answer: ReactNode; conversationToken?:string; clarificationRequired?:true; chatId?:string }
  | { ok: false; message: string };

/** The floating Assistant's one command. The same askAssistant path as the Assistant page: grant, module,
 * pause, allowances and provider are all re-checked there. The page context is RE-DERIVED here from the
 * posted path through a closed list (an area, and at most one record id); posted labels are never used.
 * The context is appended to the question in plain view, so the person's history and the audit row show
 * exactly what was sent. The answer is the same server-rendered canonical card the Assistant shows. */
export async function askFromLauncherAction(input: { question: unknown; path: unknown; previousExchangeId?: unknown; previousConversationToken?:unknown; clarificationExchangeId?:unknown;
  /** AI v2 slice 3: a file attached in Ask for an import (lib/chat-import.ts), checked here and read only by the harness's
   * import preparer. The closed grammar never receives it. */
  importFile?: unknown }): Promise<LauncherReply> {
  const t = await getTranslations('assistant');
  const question = typeof input.question === 'string' ? input.question.trim() : '';
  // Page labels and record identifiers are presentation context, never part of human intent.
  const text=question;
  if (!question || text.length > 2000 || (input.previousExchangeId===undefined)!==(input.previousConversationToken===undefined) || input.previousExchangeId !== undefined && (typeof input.previousExchangeId !== 'string'||typeof input.previousConversationToken !== 'string')) return { ok: false, message: t('err_invalid_question') };
  if(input.clarificationExchangeId!==undefined&&(typeof input.clarificationExchangeId!=='string'||input.previousExchangeId!==undefined))return {ok:false,message:t('workspace.conversation.unavailable')};
  try {
    const session = await getBrowserCommandSession();
    const conversationScope=await assistantBrowserConversationScope(session);
    // ADR-0169 §5.1: the tenant's Noveri conversation switch (off by default) sends this caller's turn through the
    // Teras harness. Off, or unreadable, and everything below is the closed grammar exactly as before.
    // Loaded on demand: the closed grammar path loads only the switch reader, never the turn runner.
    const route:ConversationRoute=await import('@/core/teras-wiring/switch').then(owner=>owner.conversationRoute(session)).catch(():ConversationRoute=>({route:'closed'}));
    const importFile=input.importFile===undefined?undefined:chatImportFileInput(input.importFile)??undefined;
    if(route.route==='harness')return await askThroughHarness(session,route,{question,conversationScope,clarification:input.clarificationExchangeId!==undefined,continuation:input.previousConversationToken,importFile});
    const { exchangeId, conversationToken } = await askAssistant(session, { question, conversationScope,...(input.clarificationExchangeId===undefined?{}:{clarificationExchangeId:input.clarificationExchangeId as string}), ...(input.previousExchangeId === undefined ? {} : {previousExchangeId: input.previousExchangeId as string,previousConversationToken: input.previousConversationToken as string}) });
    revalidatePath('/assistant');
    const workspace = await loadAiWorkspace(session, { selectedExchangeId: exchangeId, includeGovernance: false });
    const exchange = workspace.history.find(row => row.id === exchangeId);
    const answer = exchange ? await ExchangeReply({ exchange, ctx: session }) : t('workspace.conversation.unavailable');
    const conversation=exchange?.grounded?.conversation;
    const clarificationRequired=conversation?.plan.mode==='clarify'&&conversation.clarificationAllowed!==false;
    return { ok: true, exchangeId, answer, ...(conversationToken?{conversationToken}:{}),...(clarificationRequired?{clarificationRequired:true as const}:{}) };
  } catch (error) {
    if(error instanceof AssistantClarificationError)return {ok:false,message:t('workspace.conversation.unavailable')};
    const code = error instanceof AuthRequiredError ? 'ai_control' : error instanceof AssistantError ? error.code : 'provider_error';
    return { ok: false, message: t.has(`err_${code}`) ? t(`err_${code}`) : t('err_provider_error') };
  }
}

/** One Noveri conversation turn (core/teras-wiring/turn.ts) for the floating chat and the Ask page. The reply is
 * rendered like the AI centre (components/ai-centre/conversation-reply.tsx). The continuation the browser holds is
 * the signed model-side transcript, sent back as `previousConversationToken`; the exchange id is a display key only.
 * A harness reply never asks for the closed grammar's clarification form, so the next question always carries the
 * continuation. */
async function askThroughHarness(session:SessionContext,route:Extract<ConversationRoute,{route:'harness'}>,input:{question:string;conversationScope:string;clarification:boolean;continuation:unknown;importFile?:ChatImportFile}):Promise<LauncherReply>{
 const t=await getTranslations('aiCentre.conversation');
 const [{ConversationTurnError,runConversationTurn},{ConversationReply}]=await Promise.all([import('@/core/teras-wiring/turn'),import('@/components/ai-centre/conversation-reply')]);
 try{
  if(input.clarification)throw new ConversationTurnError('continuation_invalid');
  const companyId=(JSON.parse(input.conversationScope) as unknown[]).find((id):id is string=>typeof id==='string')??'';
  const continuation=await withoutDeletedChat(session,input.continuation);
  const turn=await runConversationTurn(session,route,{question:input.question,companyId,locale:await getLocale(),...(continuation===undefined?{}:{continuation}),...(input.importFile?{importFile:input.importFile}:{})});
  // AI v2 W11: the case route's form is linkable on its own turn, so a spec case clause naming it renders as a link.
  // An approver's decision card names the applicant, read now from its review for this approver: never in the card's
  // facts, the stored turn or anything the model sees.
  const applicants=await decisionApplicants(session,turn);
  const answer=await ConversationReply({turn,links:await replyLinksFor(session,turn.suggestion?.reviewRoute,turn.caseRoute),...(applicants.size?{applicants}:{})});
  // Stored only once the reply could be shown, so a reopened chat holds no turn the person never saw.
  const chatId=await storeTurn(session,{question:input.question,conversationScope:input.conversationScope,companyId,turn});
  await learnFromTurn(session,{question:input.question,companyId,turn});
  return {ok:true,exchangeId:'teras-'+turn.turnId,answer,conversationToken:turn.continuation,...(chatId?{chatId}:{})};
 }catch(error){
  const code=error instanceof ConversationTurnError?error.code:'provider_error';
  // A failure the turn did not classify (staging, 2 November 2026: a missing TERAS_PROPOSAL_SECRET made every reply
  // provider_error with nothing logged). Logged by kind only: never the question, the reply or provider text.
  if(!(error instanceof ConversationTurnError))console.error('[noveri conversation turn] unclassified failure',unclassifiedFailure(error));
  return {ok:false,message:t.has(`errors.${code}`)?t(`errors.${code}`):t('errors.provider_error')};
 }
}
const unclassifiedFailure=(error:unknown)=>{const code=(error as {code?:unknown}|null)?.code;
 return {name:error instanceof Error?error.name:typeof error,code:typeof code==='string'&&/^[A-Z0-9_]{1,40}$/.test(code)?code:null,supportId:randomUUID()};};

/** AI v2 W2 slice 3: the applicant's name for each approver decision card this turn, by proposal id, read through the
 * decision custody as this approver (core/assistant-actions/assigned-decision-proposal-confirm.ts). A card whose name
 * cannot be read keeps its title without one. */
async function decisionApplicants(session:SessionContext,turn:ConversationTurn):Promise<ReadonlyMap<string,string>>{
 const decisions=(Array.isArray(turn.proposals)?turn.proposals:[]).filter(proposal=>proposal.body.what.action==='approvals.claim.decide'||proposal.body.what.action==='approvals.attendance.decide');
 if(!decisions.length)return new Map();
 try{
  const {assignedDecisionApplicantName}=await import('@/core/assistant-actions/assigned-decision-proposal-confirm');
  const named=await Promise.all(decisions.map(async proposal=>[proposal.body.id,await assignedDecisionApplicantName(session,proposal)] as const));
  return new Map(named.flatMap(([id,name])=>name?[[id,name] as const]:[]));
 }catch{return new Map();}
}

/** A continuation of a stored chat its owner has deleted (a stale client, such as the side panel, still holding it) is
 * dropped, so the turn starts a new conversation and so a new chat id; the deleted chat's words are not sent on. The
 * store refuses the deleted id in any case (core/teras-chats.ts tombstones). Anything the check cannot read is left to
 * the turn's own verification, which refuses a bad continuation. */
async function withoutDeletedChat(session:SessionContext,continuation:unknown):Promise<unknown>{
 if(continuation===undefined)return undefined;
 try{
  const [{verifyConversationContinuation},{isDeletedOwnChat}]=await Promise.all([import('@/core/teras-wiring/history'),import('@/core/teras-chats')]);
  const {conversationId}=verifyConversationContinuation(session,continuation);
  return await isDeletedOwnChat(session,conversationId)?undefined:continuation;
 }catch{return continuation;}
}

/** AI Centre issue 8: the answered turn joins the caller's stored chat, keyed by the conversation it ran under, so the
 * panel and Ask continue one chat. A routed or refused turn (a sensitive topic, a crisis, a workplace-harms request)
 * stores no words, only that it happened. Storage never changes the reply: when it is unavailable the person still
 * gets the answer, without a chat to reopen, and the failure is logged by kind only. */
async function storeTurn(session:SessionContext,input:{question:string;conversationScope:string;companyId:string;turn:ConversationTurn}):Promise<string|null>{
 const turn=input.turn;
 try{
  const {recordChatTurn}=await import('@/core/teras-chats');
  return await recordChatTurn(session,{conversationId:turn.trace.conversationId,conversationScope:input.conversationScope,companyId:input.companyId,
   question:input.question,reply:turn.reply,modelRows:turn.modelTurn.map(row=>({role:row.role,content:row.content})),withheld:turn.sensitive||turn.refused});
 }catch(error){console.error('[noveri conversation turn] chat not stored',unclassifiedFailure(error));return null;}
}

/** AI v2 Phase 2 P2-6: a turn AI Centre could not answer or do joins the company's gap backlog, its question redacted
 * (core/learning/signals.ts recordGapFromTurn). A routed or refused turn is never a gap and stores nothing; neither does a
 * turn that answered. Learning never changes the reply: a failure is logged by kind only. */
async function learnFromTurn(session:SessionContext,input:{question:string;companyId:string;turn:ConversationTurn}):Promise<void>{
 try{
  // Classified first, with no database and no model: only a gap goes further.
  const {gapKindOf,gapTurnOf}=await import('@/core/learning/gaps');
  const turn=gapTurnOf(input.turn);
  if(!gapKindOf(turn))return;
  const [{recordGapFromTurn},locale]=await Promise.all([import('@/core/learning/signals'),getLocale()]);
  await recordGapFromTurn(session,{turnId:input.turn.turnId,turn,question:input.question,companyId:input.companyId,locale});
 }catch(error){console.error('[noveri conversation turn] gap not recorded',unclassifiedFailure(error));}
}

export type StoredChatReply=
 | {ok:true;chatId:string;turns:readonly {id:string;question:string;answer:ReactNode}[];conversationToken?:string}
 | {ok:false;message:string};
/** Reopens one of the caller's stored chats for Ask (/assistant?chat=<id>), the panel's "Open in AI Centre". The caller,
 * their Assistant access and the scope the chat started under are re-checked by the owner (core/teras-chats.ts). The
 * chat continues only while the tenant's Noveri conversation switch admits this caller: then its stored model-side rows
 * become a fresh signed continuation (core/teras-wiring/history.ts) and the next question goes on in the same chat;
 * otherwise it opens read-only. A withheld turn has no words to show and is left out. */
export async function openStoredChatAction(input:{chatId:unknown}):Promise<StoredChatReply>{
 const t=await getTranslations('assistant');
 try{
  const session=await getBrowserCommandSession(),conversationScope=await assistantBrowserConversationScope(session);
  const [{reopenOwnChat},{ReplyMarkdown}]=await Promise.all([import('@/core/teras-chats'),import('@/components/ai-centre/reply-markdown')]);
  const chat=await reopenOwnChat(session,input.chatId,conversationScope);
  const route:ConversationRoute=await import('@/core/teras-wiring/switch').then(owner=>owner.conversationRoute(session)).catch(():ConversationRoute=>({route:'closed'}));
  let conversationToken:string|undefined;
  if(route.route==='harness'){
   const {issueConversationContinuation}=await import('@/core/teras-wiring/history');
   try{conversationToken=issueConversationContinuation(session,chat.chatId,chat.history.map(row=>({role:row.role,content:row.content,side:'model' as const})));}catch{conversationToken=undefined;}
  }
  const links=await replyLinksFor(session);
  const turns=chat.turns.flatMap(turn=>turn.withheld?[]:[{id:`teras-chat-${chat.chatId}-${turn.seq}`,question:turn.question,answer:ReplyMarkdown({text:turn.reply,links})}]);
  return {ok:true,chatId:chat.chatId,turns,...(conversationToken?{conversationToken}:{})};
 }catch{return {ok:false,message:t('workspace.conversation.unavailable')};}
}

/** AI v2 slice 3 (issue 16b): whether Ask offers the paperclip. True only when this caller's chat runs through the harness
 * (the conversation switch, read here like every turn) and the capability catalogue lists an import they may prepare in
 * chat (core/chat-import/kinds.ts). Any failure is false: no paperclip. Grants nothing; each turn and Confirm re-check. */
export async function chatImportOfferedAction():Promise<boolean>{
 try{
  const session=await getBrowserCommandSession();
  const route:ConversationRoute=await import('@/core/teras-wiring/switch').then(owner=>owner.conversationRoute(session));
  if(route.route!=='harness')return false;
  return (await import('@/core/chat-import/kinds').then(owner=>owner.chatImportKindsFor(session))).length>0;
 }catch{return false;}
}

/** Home chat has no posted page context. It uses exactly the same command and authoritative replay. */
export async function askFromWorkspaceAction(input: {question:unknown;previousExchangeId?:unknown;previousConversationToken?:unknown;clarificationExchangeId?:unknown;importFile?:unknown}):Promise<LauncherReply>{
 return askFromLauncherAction({question:input.question,path:'/assistant',...(input.importFile===undefined?{}:{importFile:input.importFile}),...(input.clarificationExchangeId===undefined?{}:{clarificationExchangeId:input.clarificationExchangeId}),...(input.previousExchangeId===undefined?{}:{previousExchangeId:input.previousExchangeId,previousConversationToken:input.previousConversationToken})});
}

/** Read one earlier page of this exact selected own branch. Scope and canonical answers are rederived. */
export async function loadEarlierChatAction(input:{exchangeId:unknown;before:unknown}):Promise<{ok:true;turns:readonly {id:string;question:string;answer:ReactNode;clarificationRequired?:boolean}[];olderCursor:string|null}|{ok:false;message:string}>{
 const t=await getTranslations('assistant');
 try{
  if(typeof input.exchangeId!=='string'||typeof input.before!=='string')throw Error();
  const session=await getBrowserCommandSession(),scope=await assistantBrowserConversationScope(session);
  const page=await loadOwnAssistantChat(session,{exchangeId:input.exchangeId,before:input.before},scope);
  const turns=await Promise.all(page.turns.map(async exchange=>({id:exchange.id,question:exchange.question,answer:await ExchangeReply({exchange,ctx:session}),clarificationRequired:exchange.grounded?.conversation?.plan.mode==='clarify'&&exchange.grounded?.conversation?.clarificationAllowed!==false})));
  return{ok:true,turns,olderCursor:page.olderCursor};
 }catch{return{ok:false,message:t('workspace.conversation.unavailable')};}
}

/** Paginate actual own chat summaries. No posted principal, scope or thread metadata is accepted. */
export async function loadMoreChatsAction(input:{cursor:unknown}):Promise<{ok:true;chats:readonly {threadId:string;exchangeId:string;title:string}[];nextCursor:string|null;scopeDigest:string}|{ok:false;message:string}>{
 const t=await getTranslations('assistant');
 try{if(typeof input.cursor!=='string')throw Error();const session=await getBrowserCommandSession(),scope=await assistantBrowserConversationScope(session);const page=await listOwnAssistantChats(session,{cursor:input.cursor},scope);return{ok:true,chats:page.chats.map(({threadId,exchangeId,title})=>({threadId,exchangeId,title})),nextCursor:page.nextCursor,scopeDigest:page.scopeDigest};}
 catch{return{ok:false,message:t('workspace.conversation.unavailable')};}
}

/** The destinations this caller's reply may link to, the same set the runner's link check allows (linkablePathsFor,
 * plus this turn's suggestion route and, on a routed turn, its case route), each with the registry's localised title where it has one. */
async function replyLinksFor(session:SessionContext,...turnRoutes:(string|null|undefined)[]){
 const [{destinationsFor,linkablePathsFor},{visibleModuleCodes},{linkKey}]=await Promise.all([import('@/lib/product-context/destinations'),import('@/lib/nav-entitlements'),import('@/components/ai-centre/reply-markdown')]);
 const nav=await getTranslations('nav'),modules=visibleModuleCodes(session)??undefined,links=new Map<string,string|null>();
 for(const path of linkablePathsFor(session,modules))links.set(linkKey(path),null);
 for(const row of destinationsFor(session,modules))links.set(linkKey(row.href),nav.has(row.labelKey)?nav(row.labelKey):null);
 for(const route of turnRoutes)if(route)links.set(linkKey(route),links.get(linkKey(route))??null);
 return links;
}
