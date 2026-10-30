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
import {allowedCompanies} from '@/core/read';
import {getScopeIds} from '@/lib/scope';
import { ExchangeReply } from '@/components/assistant/exchange-reply';

export type LauncherReply =
  | { ok: true; exchangeId: string; answer: ReactNode; conversationToken?:string }
  | { ok: false; message: string };

/** The floating Assistant's one command. The same askAssistant path as the Assistant page: grant, module,
 * pause, allowances and provider are all re-checked there. The page context is RE-DERIVED here from the
 * posted path through a closed list (an area, and at most one record id); posted labels are never used.
 * The context is appended to the question in plain view, so the person's history and the audit row show
 * exactly what was sent. The answer is the same server-rendered canonical card the Assistant shows. */
export async function askFromLauncherAction(input: { question: unknown; path: unknown; previousExchangeId?: unknown; previousConversationToken?:unknown; clarificationExchangeId?:unknown }): Promise<LauncherReply> {
  const t = await getTranslations('assistant');
  const question = typeof input.question === 'string' ? input.question.trim() : '';
  const context = resolvePageContext(input.path);
  let text = question;
  if (context && input.clarificationExchangeId===undefined && !assistantSocialIntent(question)) {
    const areas = await getTranslations('assistant.launcher.areas');
    text = `${question}\n\n[${t('launcher.contextNote', { area: areas(context.area) })}${context.recordId ? ` · ${context.recordId}` : ''}]`;
  }
  if (!question || text.length > 2000 || (input.previousExchangeId===undefined)!==(input.previousConversationToken===undefined) || input.previousExchangeId !== undefined && (typeof input.previousExchangeId !== 'string'||typeof input.previousConversationToken !== 'string')) return { ok: false, message: t('err_invalid_question') };
  if(input.clarificationExchangeId!==undefined&&(typeof input.clarificationExchangeId!=='string'||input.previousExchangeId!==undefined))return {ok:false,message:t('workspace.conversation.unavailable')};
  try {
    const session = await getBrowserCommandSession();
    const conversationScope=JSON.stringify((await getScopeIds((await allowedCompanies(session)).map(company=>company.id))).sort());
    const { exchangeId, conversationToken } = await askAssistant(session, { question: text, conversationScope,...(input.clarificationExchangeId===undefined?{}:{clarificationExchangeId:input.clarificationExchangeId as string}), ...(input.previousExchangeId === undefined ? {} : {previousExchangeId: input.previousExchangeId as string,previousConversationToken: input.previousConversationToken as string}) });
    revalidatePath('/assistant');
    const workspace = await loadAiWorkspace(session, { selectedExchangeId: exchangeId, includeGovernance: false });
    const exchange = workspace.history.find(row => row.id === exchangeId);
    const answer = exchange ? await ExchangeReply({ exchange, ctx: session }) : t('workspace.conversation.unavailable');
    return { ok: true, exchangeId, answer, ...(conversationToken?{conversationToken}:{}) };
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
