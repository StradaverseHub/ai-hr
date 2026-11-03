'use server';

import { revalidatePath } from 'next/cache';
import { authenticateOwnLeaveBrowserSession } from '@/core/assistant-actions/own-leave-server';
import { confirmToilRequestProposal, editToilRequestProposal, type ToilRequestConfirmResult } from '@/core/assistant-actions/toil-request-proposal-confirm';
import type { ToilEditResult } from '@/core/proposals/toil-request';

/** AI v2 W2 (slice 2) — the two buttons of a Leave Credit request (time off in lieu) card prepared in chat. The session
 * comes from the person's own cookie login (the same browser-session authenticator the leave card uses), never from the
 * post; the posted proposal is only data, verified for this caller inside the owner. */

/** Confirm: submits the card through the TOIL review custody, which re-runs the leave service's own checks. Nothing is
 * submitted unless `confirm` is exactly true. For a First Schedule employee, `firstScheduleConsent` is the box the
 * person ticked on the card themselves; it must be exactly true, and the server checks it again here. */
export async function confirmToilRequestProposalAction(input: { proposal: unknown; confirm: unknown; firstScheduleConsent?: unknown }): Promise<ToilRequestConfirmResult> {
  let session: Awaited<ReturnType<typeof authenticateOwnLeaveBrowserSession>>;
  try { session = await authenticateOwnLeaveBrowserSession(); } catch { return { kind: 'refused', reason: 'unavailable' }; }
  const result = await confirmToilRequestProposal(session.ctx, { proposal: input?.proposal, confirm: input?.confirm, firstScheduleConsent: input?.firstScheduleConsent });
  if (result.kind === 'submitted') { revalidatePath('/leave'); revalidatePath('/leave/credit'); }
  return result;
}

/** Edit: the Leave Credit request dialog on My Leave, opened on the card's date and window as validated for the caller;
 * the person completes, ticks any agreement themselves and submits it there. */
export async function editToilRequestProposalAction(input: { proposal: unknown }): Promise<ToilEditResult> {
  let session: Awaited<ReturnType<typeof authenticateOwnLeaveBrowserSession>>;
  try { session = await authenticateOwnLeaveBrowserSession(); } catch { return { ok: false, reason: 'unavailable' }; }
  return editToilRequestProposal(session.ctx, input?.proposal);
}
