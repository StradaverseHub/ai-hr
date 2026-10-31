'use server';

import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { getBrowserCommandSession } from '@/lib/session';
import { AuthRequiredError } from '@/lib/auth-errors';
import {AssistantClarificationError} from '@/core/assistant-clarification';
import { askAssistant, AssistantError } from '@/core/assistant';
import { loadAiWorkspace } from '@/core/ai-workspace';
import {assistantBrowserConversationScope} from './conversation-scope';
import {listOwnAssistantChats,loadOwnAssistantChat} from '@/core/assistant-threads';
import {assistantConversationScopeDigest} from '@/core/assistant-conversation-context';
import type {ChatListSnapshot} from '@/components/assistant/chat-list-updates';
import { ExchangeReply } from '@/components/assistant/exchange-reply';

export type LauncherReply =
  | { ok: true; exchangeId: string; answer: ReactNode; conversationToken?:string; clarificationRequired?:true; chatList?:ChatListSnapshot }
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
    const { exchangeId, conversationToken } = await askAssistant(session, { question, conversationScope,...(input.clarificationExchangeId===undefined?{}:{clarificationExchangeId:input.clarificationExchangeId as string}), ...(input.previousExchangeId === undefined ? {} : {previousExchangeId: input.previousExchangeId as string,previousConversationToken: input.previousConversationToken as string}) });
    const workspace = await loadAiWorkspace(session, { selectedExchangeId: exchangeId, includeGovernance: false });
    const exchange = workspace.history.find(row => row.id === exchangeId);
    const answer = exchange ? await ExchangeReply({ exchange, ctx: session }) : t('workspace.conversation.unavailable');
    const conversation=exchange?.grounded?.conversation;
    const clarificationRequired=conversation?.plan.mode==='clarify'&&conversation.clarificationAllowed!==false;
    // The action already returns the fresh canonical reply. Revalidating the route here replaces
    // a selected saved conversation with its route loading fallback; update only its scoped list.
    const chatList=await listOwnAssistantChats(session,{},conversationScope).then(page=>({chats:page.chats.map(({threadId,exchangeId,title})=>({threadId,exchangeId,title})),nextCursor:page.nextCursor,scopeDigest:page.scopeDigest})).catch(()=>({chats:[],nextCursor:null,scopeDigest:assistantConversationScopeDigest(session,conversationScope)}));
    return { ok: true, exchangeId, answer, chatList, ...(conversationToken?{conversationToken}:{}),...(clarificationRequired?{clarificationRequired:true as const}:{}) };
  } catch (error) {
    if(error instanceof AssistantClarificationError)return {ok:false,message:t('workspace.conversation.unavailable')};
    const code = error instanceof AuthRequiredError ? 'ai_control' : error instanceof AssistantError ? error.code : 'provider_error';
    return { ok: false, message: t.has(`err_${code}`) ? t(`err_${code}`) : t('err_provider_error') };
  }
}

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
