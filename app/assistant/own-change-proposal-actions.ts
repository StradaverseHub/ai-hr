'use server';

import { revalidatePath } from 'next/cache';
import { authenticateOwnLeaveBrowserSession } from '@/core/assistant-actions/own-leave-server';
import { confirmOwnChangeProposal, editOwnChangeProposal, type OwnChangeConfirmResult, type OwnChangeEditResult } from '@/core/assistant-actions/own-change-proposal-confirm';

/** AI v2 W2 — the two buttons of an own claim or own profile change card prepared in chat (claims.submit, claims.cancel,
 * ess.profile.request). The session comes from the person's own cookie login (the same browser-command authenticator as
 * the leave card), never from the post; the posted proposal is only data, verified for this caller inside the owner.
 * The card's buttons come with the AI Centre revamp. */

/** Confirm: confirms the card's sealed review through its custody and the owning service, which check everything again.
 * Nothing happens unless `confirm` is exactly true. */
export async function confirmOwnChangeProposalAction(input: { proposal: unknown; confirm: unknown }): Promise<OwnChangeConfirmResult> {
  let session: Awaited<ReturnType<typeof authenticateOwnLeaveBrowserSession>>;
  try { session = await authenticateOwnLeaveBrowserSession(); } catch { return { kind: 'refused', reason: 'unavailable' }; }
  const result = await confirmOwnChangeProposal(session.ctx, { proposal: input?.proposal, confirm: input?.confirm });
  if (result.kind === 'submitted' || result.kind === 'draft_saved' || result.kind === 'cancelled' || (result.kind === 'refused' && result.reason === 'service_refused')) revalidatePath('/claims');
  if (result.kind === 'requested') { revalidatePath('/me'); revalidatePath('/approvals'); }
  return result;
}

/** Edit: the page where the person changes it themselves (the claim review page, the saved draft, or the profile tab),
 * after the sealed review is reopened and validated as the caller. */
export async function editOwnChangeProposalAction(input: { proposal: unknown }): Promise<OwnChangeEditResult> {
  let session: Awaited<ReturnType<typeof authenticateOwnLeaveBrowserSession>>;
  try { session = await authenticateOwnLeaveBrowserSession(); } catch { return { ok: false, reason: 'unavailable' }; }
  return editOwnChangeProposal(session.ctx, input?.proposal);
}
