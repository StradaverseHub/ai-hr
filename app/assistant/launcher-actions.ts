'use server';

import type { ReactNode } from 'react';
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

export type LauncherReply =
  | { ok: true; exchangeId: string; answer: ReactNode; conversationToken?:string; clarificationRequired?:true }
  | { ok: false; message: string };

/** The floating Assistant's one command. The same askAssistant path as the Assistant page: grant, module,
 * pause, allowances and provider are all re-checked there. The page context is RE-DERIVED here from the
 * posted path through a closed list (an area, and at most one record id); posted labels are never used.
 * The context is appended to the question in plain view, so the person's history and the audit row show
 * exactly what was sent. The answer is the same server-rendered canonical card the Assistant shows. */
export async function askFromLauncherAction(input: { question: unknown; path: unknown; previousExchangeId?: unknown; previousConversationToken?:unknown; clarificationExchangeId?:unknown }): Promise<LauncherReply> {
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
    if(route.route==='harness')return await askThroughHarness(session,route,{question,conversationScope,clarification:input.clarificationExchangeId!==undefined,continuation:input.previousConversationToken});
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
async function askThroughHarness(session:SessionContext,route:Extract<ConversationRoute,{route:'harness'}>,input:{question:string;conversationScope:string;clarification:boolean;continuation:unknown}):Promise<LauncherReply>{
 const t=await getTranslations('aiCentre.conversation');
 const [{ConversationTurnError,runConversationTurn},{ConversationReply}]=await Promise.all([import('@/core/teras-wiring/turn'),import('@/components/ai-centre/conversation-reply')]);
 try{
  if(input.clarification)throw new ConversationTurnError('continuation_invalid');
  const companyId=(JSON.parse(input.conversationScope) as unknown[]).find((id):id is string=>typeof id==='string')??'';
  const turn=await runConversationTurn(session,route,{question:input.question,companyId,locale:await getLocale(),...(input.continuation===undefined?{}:{continuation:input.continuation})});
  return {ok:true,exchangeId:'teras-'+turn.turnId,answer:await ConversationReply({turn}),conversationToken:turn.continuation};
 }catch(error){
  const code=error instanceof ConversationTurnError?error.code:'provider_error';
  // A failure the turn did not classify (staging, 2 November 2026: a missing TERAS_PROPOSAL_SECRET made every reply
  // provider_error with nothing logged). Logged by kind only: never the question, the reply or provider text.
  if(!(error instanceof ConversationTurnError))console.error('[noveri conversation turn] unclassified failure',unclassifiedFailure(error));
  return {ok:false,message:t.has(`errors.${code}`)?t(`errors.${code}`):t('errors.provider_error')};
 }
}
const unclassifiedFailure=(error:unknown)=>{const code=(error as {code?:unknown}|null)?.code;
 return {name:error instanceof Error?error.name:typeof error,code:typeof code==='string'&&/^[A-Z0-9_]{1,40}$/.test(code)?code:null};};

/** Home chat has no posted page context. It uses exactly the same command and authoritative replay. */
export async function askFromWorkspaceAction(input: {question:unknown;previousExchangeId?:unknown;previousConversationToken?:unknown;clarificationExchangeId?:unknown}):Promise<LauncherReply>{
 return askFromLauncherAction({question:input.question,path:'/assistant',...(input.clarificationExchangeId===undefined?{}:{clarificationExchangeId:input.clarificationExchangeId}),...(input.previousExchangeId===undefined?{}:{previousExchangeId:input.previousExchangeId,previousConversationToken:input.previousConversationToken})});
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
