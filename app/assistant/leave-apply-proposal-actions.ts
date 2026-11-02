'use server';

import { revalidatePath } from 'next/cache';
import { authenticateOwnLeaveBrowserSession } from '@/core/assistant-actions/own-leave-server';
import { confirmLeaveApplyProposal, editLeaveApplyProposal, type LeaveApplyConfirmResult } from '@/core/assistant-actions/leave-apply-proposal-confirm';
import type { LeaveApplyEditResult } from '@/core/proposals/leave-apply';

/** Issue 10 — the two buttons of a leave application card prepared in chat. The session and locale come from the
 * person's own cookie login (the own-leave review route's authenticator), never from the post; the posted proposal
 * is only data, verified for this caller inside the owner. The card's look comes with the AI Centre revamp. */

/** Confirm: submits a one-day review card through the review command, which re-checks everything; a form card answers
 * with the prefilled Request Leave form instead. Nothing is submitted unless `confirm` is exactly true. */
export async function confirmLeaveApplyProposalAction(input: { proposal: unknown; confirm: unknown }): Promise<LeaveApplyConfirmResult> {
  let session: Awaited<ReturnType<typeof authenticateOwnLeaveBrowserSession>>;
  try { session = await authenticateOwnLeaveBrowserSession(); } catch { return { kind: 'refused', reason: 'unavailable' }; }
  const result = await confirmLeaveApplyProposal(session.ctx, { proposal: input?.proposal, confirm: input?.confirm }, session.locale);
  if (result.kind === 'submitted') { revalidatePath('/leave'); revalidatePath('/leave/history'); }
  return result;
}

/** Edit: the Request Leave form on /leave, opened on the card's leave type, dates and duration (validated as the
 * caller); the person completes and submits it there. */
export async function editLeaveApplyProposalAction(input: { proposal: unknown }): Promise<LeaveApplyEditResult> {
  let session: Awaited<ReturnType<typeof authenticateOwnLeaveBrowserSession>>;
  try { session = await authenticateOwnLeaveBrowserSession(); } catch { return { ok: false, reason: 'unavailable' }; }
  return editLeaveApplyProposal(session.ctx, input?.proposal, session.locale);
}
