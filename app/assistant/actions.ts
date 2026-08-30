'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { askAssistant, AssistantError } from '@/core/assistant';

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
  const s = await getSession();
  const question = String(formData.get('question') ?? '');

  let exchangeId: string;
  try {
    const res = await askAssistant(s, { question });
    exchangeId = res.exchangeId;
  } catch (e) {
    const code = e instanceof AssistantError ? e.code : 'provider_error';
    redirect(`/assistant?error=${encodeURIComponent(code)}`);
  }

  revalidatePath('/assistant');
  // `e` highlights the new exchange in the list; the ANSWER itself is read back from the audit row, so
  // the screen cannot show a sentence that differs from the one recorded.
  redirect(`/assistant?e=${encodeURIComponent(exchangeId)}`);
}
