'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getBrowserCommandSession } from '@/lib/session';
import { AuthRequiredError } from '@/lib/auth-errors';
import { askAssistant, AssistantError } from '@/core/assistant';
import {assistantBrowserConversationScope} from './conversation-scope';
import { AssistantClarificationError } from '@/core/assistant-clarification';

/**
 * ADR-0082 slice 4 — ask one question.
 *
 * THE ERROR CODE IS CARRIED, NEVER THE MESSAGE. `AssistantError.code` is a closed set the screen has a
 * localised sentence for; the underlying provider text is deliberately not surfaced (§2.7) — it can carry
 * a model name, a quota detail or a raw SDK string, none of which an employee should read and all of
 * which would arrive untranslated in a six-locale product.
 *
 * Anything that is NOT an AssistantError is a bug rather than a refusal, and is reported as the generic
 * provider failure for the same reason.
 */
export async function askAssistantAction(formData: FormData) {
  const submittedQuestion = String(formData.get('question') ?? '');
  const clarificationExchangeId = formData.get('clarificationExchangeId');
  const clarificationAnswer = formData.get('clarificationAnswer');

  let exchangeId: string;
  try {
    const s = await getBrowserCommandSession();
    if(clarificationExchangeId!==null&&(typeof clarificationExchangeId!=='string'||typeof clarificationAnswer!=='string'))throw new AssistantClarificationError();
    const conversationScope=await assistantBrowserConversationScope(s);
    const res = await askAssistant(s, clarificationExchangeId===null?{question:submittedQuestion,conversationScope}
      : {question:clarificationAnswer as string,clarificationExchangeId:clarificationExchangeId as string,conversationScope});
    exchangeId = res.exchangeId;
  } catch (e) {
    const code = e instanceof AssistantClarificationError ? 'clarification_unavailable' : e instanceof AuthRequiredError ? 'ai_control' : e instanceof AssistantError ? e.code : 'provider_error';
    redirect(`/assistant?error=${encodeURIComponent(code)}`);
  }

  revalidatePath('/assistant');
  // `e` selects the recorded exchange. The screen reauthorizes its sealed tool plan and renders
  // current canonical cards; raw model prose remains audit-only.
  redirect(`/assistant?e=${encodeURIComponent(exchangeId)}`);
}
