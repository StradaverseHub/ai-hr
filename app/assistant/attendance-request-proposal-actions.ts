'use server';

import { revalidatePath } from 'next/cache';
import { authenticateOwnLeaveBrowserSession } from '@/core/assistant-actions/own-leave-server';
import { confirmAttendanceRequestProposal, editAttendanceRequestProposal, type AttendanceRequestConfirmResult } from '@/core/assistant-actions/attendance-request-proposal-confirm';
import type { AttendanceEditResult } from '@/core/proposals/attendance-request';

/** AI v2 W2 — the two buttons of an attendance correction or overtime card prepared in chat. The session comes from the
 * person's own cookie login (the same browser-session authenticator the leave card uses), never from the post; the
 * posted proposal is only data, verified for this caller inside the owner. */

/** Confirm: submits the card through its review store, which re-runs the attendance service's own checks. Nothing is
 * submitted unless `confirm` is exactly true. */
export async function confirmAttendanceRequestProposalAction(input: { proposal: unknown; confirm: unknown }): Promise<AttendanceRequestConfirmResult> {
  let session: Awaited<ReturnType<typeof authenticateOwnLeaveBrowserSession>>;
  try { session = await authenticateOwnLeaveBrowserSession(); } catch { return { kind: 'refused', reason: 'unavailable' }; }
  const result = await confirmAttendanceRequestProposal(session.ctx, { proposal: input?.proposal, confirm: input?.confirm });
  if (result.kind === 'submitted') {
    revalidatePath('/attendance/requests'); revalidatePath('/attendance/request-status');
    revalidatePath('/attendance/my-records'); revalidatePath('/attendance/plan-ot');
  }
  return result;
}

/** Edit: the existing form (the person's attendance day, or Plan Overtime), opened on the card's date and times as
 * validated for the caller; the person completes and submits it there. */
export async function editAttendanceRequestProposalAction(input: { proposal: unknown }): Promise<AttendanceEditResult> {
  let session: Awaited<ReturnType<typeof authenticateOwnLeaveBrowserSession>>;
  try { session = await authenticateOwnLeaveBrowserSession(); } catch { return { ok: false, reason: 'unavailable' }; }
  return editAttendanceRequestProposal(session.ctx, input?.proposal);
}
