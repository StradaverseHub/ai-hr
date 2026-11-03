'use server';

import { revalidatePath } from 'next/cache';
import { authenticateOwnLeaveBrowserSession } from '@/core/assistant-actions/own-leave-server';
import { confirmLetterRequestProposal, editLetterRequestProposal, type LetterRequestConfirmResult } from '@/core/assistant-actions/letter-request-proposal-confirm';
import type { LetterRequestEditResult } from '@/core/proposals/letter-request';

/** AI v2 Phase 1 slice 3 — the two buttons of an own letter request card prepared in chat. The session comes from the
 * person's own cookie login (the same browser-session authenticator the leave card uses), never from the post; the posted
 * proposal is only data, verified for this caller inside the owner. */

/** Confirm: sends the request to HR through the letter request owner, which checks everything again. Nothing is sent
 * unless `confirm` is exactly true. */
export async function confirmLetterRequestProposalAction(input: { proposal: unknown; confirm: unknown }): Promise<LetterRequestConfirmResult> {
  let session: Awaited<ReturnType<typeof authenticateOwnLeaveBrowserSession>>;
  try { session = await authenticateOwnLeaveBrowserSession(); } catch { return { kind: 'refused', reason: 'unavailable' }; }
  const result = await confirmLetterRequestProposal(session.ctx, { proposal: input?.proposal, confirm: input?.confirm });
  if (result.kind === 'submitted') revalidatePath('/me/letters');
  return result;
}

/** Edit: the request form with the card's letter type chosen; the person adds any purpose and sends it there. */
export async function editLetterRequestProposalAction(input: { proposal: unknown }): Promise<LetterRequestEditResult> {
  let session: Awaited<ReturnType<typeof authenticateOwnLeaveBrowserSession>>;
  try { session = await authenticateOwnLeaveBrowserSession(); } catch { return { ok: false, reason: 'unavailable' }; }
  return editLetterRequestProposal(session.ctx, input?.proposal);
}
