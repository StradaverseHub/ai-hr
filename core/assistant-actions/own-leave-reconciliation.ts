/** Read-only interpretation of a single action's receipt. No effect, retry or model call is possible
 * here. Persistence, locking and fresh authorization remain the command/read owner's responsibility. */
import {
  OwnLeaveConfirmation, OwnLeaveFinalReceipt, type OwnLeaveClientOutcome,
} from '../../lib/assistant-actions/own-leave-contract';
import { checkOwnLeaveConfirmation } from './own-leave-review';

/** Call after current authorization, using metadata and receipt read together for the same action.
 * Receipt validation does not establish access to the referenced leave request: reopening must use
 * the canonical leave reader. Missing/corrupt/conflicting evidence never proves failure or success. */
export function reconcileOwnLeaveConfirmation(
  metadata: unknown, receiptValue: unknown, confirmationValue: unknown, binding: unknown, now: Date,
): OwnLeaveClientOutcome | { status: 'unavailable' } {
  const confirmation = OwnLeaveConfirmation.safeParse(confirmationValue);
  if (!confirmation.success) return { status: 'unavailable' };
  const { actionId } = confirmation.data;
  const preflight = checkOwnLeaveConfirmation(metadata, confirmation.data, binding, now);
  if (preflight.kind === 'refused') {
    return { status: 'refused', actionId, code: preflight.code };
  }
  // An awaiting action can only resume via the locked command, with its full live revalidation.
  // The read path must never trust a detached receipt or start another submission.
  if (preflight.kind === 'revalidate') return { status: 'checking_submission', actionId };
  const receipt = OwnLeaveFinalReceipt.safeParse(receiptValue);
  if (!receipt.success || receipt.data.actionId !== actionId || receipt.data.state !== preflight.state) {
    return { status: 'checking_submission', actionId };
  }
  switch (receipt.data.state) {
    case 'completed':
      return { status: 'submission_recorded', actionId, leaveRequestId: receipt.data.leaveRequestId };
    case 'refused':
      return { status: 'refused', actionId, code: receipt.data.code };
    case 'discarded':
      return { status: 'discarded', actionId };
    case 'expired':
      return { status: 'refused', actionId, code: 'expired' };
  }
}
