'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { authenticateOwnLeaveBrowserSession } from '@/core/assistant-actions/own-leave-server';
import { confirmMissedClockOut } from '@/core/loops/clock-out-confirm';
import { clockOutReasonText, type ClockOutConfirmResult } from '@/lib/today/clock-out-reasons';

/** AI v2 W8 — Confirm on Today's missed clock-out card. The session comes from the person's own cookie login (the
 * browser-session authenticator the chat cards use), never from the post. The post carries only the case, the reason
 * option the person picked and, for "Other", the words they typed: the option becomes its label in their own language
 * here, and the case's own date and proposed clock-out are read again in the owner. Nothing is submitted unless
 * `confirm` is exactly true. */
export async function confirmMissedClockOutAction(input: { caseId: unknown; reason: unknown; other?: unknown; confirm: unknown }): Promise<ClockOutConfirmResult> {
  let session: Awaited<ReturnType<typeof authenticateOwnLeaveBrowserSession>>;
  try { session = await authenticateOwnLeaveBrowserSession(); } catch { return { kind: 'refused', reason: 'unavailable' }; }
  const t = await getTranslations('today.loops');
  const reason = clockOutReasonText(input?.reason, input?.other, { forgot: t('clockOutReasonForgot'), device: t('clockOutReasonDevice') });
  if (!reason) return { kind: 'refused', reason: 'invalid' };
  const result = await confirmMissedClockOut(session.ctx, { caseId: input?.caseId, reason, confirm: input?.confirm });
  if (result.kind === 'submitted') {
    revalidatePath('/'); revalidatePath('/attendance/requests'); revalidatePath('/attendance/request-status'); revalidatePath('/attendance/my-records');
  }
  return result;
}
