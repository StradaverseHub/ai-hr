'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getBrowserCommandSession } from '@/lib/session';
import { recordOwnAgentFeedback, eraseOwnAgentFeedback, AGENT_FEEDBACK_OUTCOMES } from '@/core/module-agent-feedback';
export async function saveAgentFeedbackAction(form: FormData) {
  const outcome = String(form.get('outcome') ?? ''), exchangeId=String(form.get('exchangeId')??''),consented=form.get('consented')==='yes';
  if (!AGENT_FEEDBACK_OUTCOMES.some(value => value === outcome) || !consented) redirect('/assistant?error=feedback');
  try {
    const ctx = await getBrowserCommandSession();
    await recordOwnAgentFeedback(ctx, { exchangeId,
      outcome: outcome as typeof AGENT_FEEDBACK_OUTCOMES[number], consented: true });
  } catch { redirect('/assistant?error=feedback'); }
  revalidatePath('/assistant'); redirect('/assistant');
}
export async function eraseAgentFeedbackAction() {
  try { const ctx = await getBrowserCommandSession(); await eraseOwnAgentFeedback(ctx); } catch { redirect('/assistant?ownClear=unavailable'); }
  revalidatePath('/assistant'); redirect('/assistant?ownClear=feedback');
}
