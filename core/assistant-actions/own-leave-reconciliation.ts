/** Read-only interpretation of a single action's receipt. No effect, retry or model call is possible
 * here. Persistence, locking and fresh authorization remain the command/read owner's responsibility. */
import {
  OwnLeaveConfirmation, OwnLeaveFinalReceipt, type OwnLeaveClientOutcome,
} from '../../lib/assistant-actions/own-leave-contract';
import { z } from 'zod';
import { checkOwnLeaveConfirmation, OwnLeaveBinding, OwnLeaveCustodyMetadata } from './own-leave-review';

/** Minimal server-only projections, not a posted capability or a replacement authorization policy.
 * The eventual read owner must obtain these from the current canonical leave reader and actual
 * event row under the caller's authority. Parsing cannot establish that provenance. No reason,
 * balance, event payload, request status or approver information belongs in this evidence. */
const uuid = z.guid();
const SubmissionReadEvidence = z.object({
  request: z.object({ id: uuid, tenantId: uuid, employmentId: uuid, personId: uuid, companyId: uuid }).strict(),
  event: z.object({ id: uuid, tenantId: uuid, aggregateType: z.literal('leave-request'), aggregateId: uuid,
    eventType: z.literal('leave-request.submitted'), actorType: z.literal('user'), actorId: uuid,
    subjectEmploymentId: uuid }).strict(),
}).strict();
export type OwnLeaveSubmissionReadEvidence = z.infer<typeof SubmissionReadEvidence>;

/** Call after current authorization, using metadata and receipt read together for the same action.
 * Receipt validation does not establish access to the referenced leave request: reopening must use
 * the canonical leave reader. Missing/corrupt/conflicting evidence never proves failure or success. */
export function reconcileOwnLeaveConfirmation(
  metadata: unknown, receiptValue: unknown, confirmationValue: unknown, binding: unknown, now: Date,
  sourceEvidenceValue?: unknown,
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
    case 'completed': {
      // UUID-shaped references in a detached receipt do not establish that the request is still
      // readable or that its submitted event belongs to this actor/subject. Fail closed when the
      // future read owner omits, substitutes or cannot obtain the canonical source projections.
      return reconcileRecordedOwnLeaveReceipt(metadata, receipt.data, binding, sourceEvidenceValue);
    }
    case 'refused':
      return { status: 'refused', actionId, code: receipt.data.code };
    case 'discarded':
      return { status: 'discarded', actionId };
    case 'expired':
      return { status: 'refused', actionId, code: 'expired' };
  }
}

/** Terminal replay requires fresh canonical evidence, never a retained hash of erased human text.
 * Metadata/receipt must be read together under current custody before calling this pure reader. */
export function reconcileRecordedOwnLeaveReceipt(metadata: unknown, receiptValue: unknown,
  binding: unknown, sourceEvidenceValue: unknown): OwnLeaveClientOutcome | { status: 'unavailable' } {
  const record = OwnLeaveCustodyMetadata.safeParse(metadata);
  const receipt = OwnLeaveFinalReceipt.safeParse(receiptValue);
  const current = OwnLeaveBinding.safeParse(binding);
  const source = SubmissionReadEvidence.safeParse(sourceEvidenceValue);
  if (!record.success || record.data.state !== 'completed' || !receipt.success || receipt.data.state !== 'completed'
    || !current.success || record.data.actionId !== receipt.data.actionId
    || Object.keys(record.data.binding).some(key => record.data.binding[key as keyof typeof record.data.binding]
      !== current.data[key as keyof typeof current.data])) return { status: 'unavailable' };
  if (!source.success) return { status: 'checking_submission', actionId: record.data.actionId };
  const { request, event } = source.data, owner = current.data;
  if (request.id !== receipt.data.leaveRequestId || request.tenantId !== owner.tenantId
    || request.employmentId !== owner.employmentId || request.personId !== owner.personId
    || request.companyId !== owner.companyId || event.id !== receipt.data.submissionEventId
    || event.tenantId !== owner.tenantId || event.aggregateId !== request.id
    || event.actorId !== owner.userId || event.subjectEmploymentId !== owner.employmentId)
    return { status: 'checking_submission', actionId: record.data.actionId };
  return { status: 'submission_recorded', actionId: record.data.actionId, leaveRequestId: receipt.data.leaveRequestId };
}
