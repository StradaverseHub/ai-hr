'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getBrowserCommandSession } from '@/lib/session';
import { recordOwnAgentFeedback, eraseOwnAgentFeedback, AGENT_FEEDBACK_OUTCOMES } from '@/core/module-agent-feedback';
export async function saveAgentFeedbackAction(form: FormData) {
  const ctx = await getBrowserCommandSession();
  const outcome = String(form.get('outcome') ?? '');
  if (!AGENT_FEEDBACK_OUTCOMES.some(value => value === outcome) || form.get('consented') !== 'yes') redirect('/assistant?error=feedback');
  try {
    await recordOwnAgentFeedback(ctx, { exchangeId: String(form.get('exchangeId') ?? ''),
      outcome: outcome as typeof AGENT_FEEDBACK_OUTCOMES[number], consented: true });
  } catch { redirect('/assistant?error=feedback'); }
  revalidatePath('/assistant'); redirect('/assistant');
}
export async function eraseAgentFeedbackAction() {
  const ctx = await getBrowserCommandSession();
  try { await eraseOwnAgentFeedback(ctx); } catch { redirect('/assistant?error=feedback'); }
  revalidatePath('/assistant'); redirect('/assistant');
}
