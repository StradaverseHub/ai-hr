'use server';

import { revalidatePath } from 'next/cache';
import { authenticateOwnLeaveBrowserSession } from '@/core/assistant-actions/own-leave-server';
import {
  confirmAssignedDecisionProposal, editAssignedDecisionProposal,
  type AssignedDecisionConfirmResult, type AssignedDecisionEditResult,
} from '@/core/assistant-actions/assigned-decision-proposal-confirm';

/** AI v2 W2 (slice 3) — the two buttons of an assigned approver's claim or attendance decision card prepared in chat.
 * The session comes from the approver's own cookie login (the same browser-command authenticator the other chat cards
 * use), never from the post; the posted proposal is only data, verified for this caller inside the owner. */

/** Confirm: records the decision through the assigned-decision custody, which runs the existing decision path with all
 * its checks. Nothing is decided unless `confirm` is exactly true. */
export async function confirmAssignedDecisionProposalAction(input: { proposal: unknown; confirm: unknown }): Promise<AssignedDecisionConfirmResult> {
  let session: Awaited<ReturnType<typeof authenticateOwnLeaveBrowserSession>>;
  try { session = await authenticateOwnLeaveBrowserSession(); } catch { return { kind: 'refused', reason: 'unavailable' }; }
  const result = await confirmAssignedDecisionProposal(session.ctx, { proposal: input?.proposal, confirm: input?.confirm });
  if (result.kind === 'decided') { revalidatePath('/approvals'); revalidatePath(result.action === 'approvals.claim.decide' ? '/claims' : '/attendance/requests'); }
  return result;
}

/** Edit: the approvals review page on the card's own review, where the approver changes or confirms the decision. */
export async function editAssignedDecisionProposalAction(input: { proposal: unknown }): Promise<AssignedDecisionEditResult> {
  let session: Awaited<ReturnType<typeof authenticateOwnLeaveBrowserSession>>;
  try { session = await authenticateOwnLeaveBrowserSession(); } catch { return { ok: false, reason: 'unavailable' }; }
  return editAssignedDecisionProposal(session.ctx, input?.proposal);
}
