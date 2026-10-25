/** SOURCE-ONLY pending-review custody. No route, model tool or execution command is wired here.
 * Requires the coordinated review-store and non-admitting-control migrations before runtime use.
 * One caller transaction owns authority, pause check, private row and retirement. No nested commit. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext, Tx } from '../../db/client';
import { assertAiActionUnpausedTx } from '../ai-governance';
import { OwnLeaveConfirmation, OwnLeaveFinalReceipt, OwnLeavePreparedReview,
  type OwnLeaveFinalReceipt as Receipt, type OwnLeavePreparedReview as Card } from '../../lib/assistant-actions/own-leave-contract';
import { readOwnLeaveActorTx } from './own-leave-actor';
import { readOwnLeaveCandidateTx, type OwnLeaveCandidateResult } from './own-leave-candidate';
import { OwnLeaveContentUnavailable, OwnLeaveSealedReview, sealOwnLeaveReview, unsealOwnLeaveReview } from './own-leave-content';
import { OwnLeavePreparedMetadata } from './own-leave-review';
import { ownLeaveReviewedDigest } from './own-leave-review-digest';

const StoredReview = z.object({
  metadata: OwnLeavePreparedMetadata.refine(m => m.state !== 'completed'),
  sealed: OwnLeaveSealedReview.nullable(),
}).strict().refine(value => (value.metadata.state === 'awaiting_confirmation') === (value.sealed !== null));
type StoredReview = z.infer<typeof StoredReview>;
type PendingResult = { kind: 'prepared'; review: Card };
type RetiredResult = { kind: 'retired'; receipt: Exclude<Receipt, { state: 'completed' }> };

function captureContext(ctx: SessionContext): SessionContext {
  return { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(g => ({ ...g })) };
}

/** Map every public field explicitly. A spread of the encrypted content's server-side object would
 * reveal its private balance and identity bindings even when ESS intentionally hides those values. */
function publicReview(stored: StoredReview): PendingResult {
  const { metadata } = stored;
  const { review } = unsealOwnLeaveReview(metadata, stored.sealed);
  return { kind: 'prepared', review: OwnLeavePreparedReview.parse({
    actionId: metadata.actionId, contractVersion: metadata.contractVersion,
    reviewedDigest: metadata.reviewedDigest, createdAt: metadata.createdAt, expiresAt: metadata.expiresAt,
    companyName: review.companyName, employeeCode: review.employeeCode, leaveTypeName: review.leaveTypeName,
    date: review.nomination.date, durationType: review.nomination.durationType, deductionDays: review.deductionDays,
    availableBalance: review.availableBalance, estimatedAvailableAfter: review.estimatedAvailableAfter,
    holidayWarnings: review.holidayWarnings, approvalRouting: review.approvalRouting, humanText: review.humanText,
  }) };
}

function retired(stored: StoredReview): RetiredResult {
  const m = stored.metadata;
  if (m.state === 'awaiting_confirmation' || m.state === 'completed' || stored.sealed !== null)
    throw new OwnLeaveContentUnavailable();
  const receipt = OwnLeaveFinalReceipt.parse({ actionId: m.actionId, contractVersion: m.contractVersion,
    state: m.state, ...(m.state === 'refused' ? { code: 'unavailable' } : {}) });
  if (receipt.state === 'completed') throw new OwnLeaveContentUnavailable();
  return { kind: 'retired', receipt };
}

/** Inputs must be supplied by the eventual authenticated human-input owner. This creates only a
 * stored REVIEW, never a leave request or evidence that the human clicked to submit it. */
export async function prepareOwnLeaveReviewTx(tx: Tx, supplied: SessionContext,
  nomination: unknown, selection: unknown, humanText: unknown, locale?: string,
): Promise<PendingResult | Exclude<OwnLeaveCandidateResult, { kind: 'candidate' }>> {
  const ctx = captureContext(supplied);
  const outcome = await readOwnLeaveCandidateTx(tx, ctx, nomination, selection, humanText, locale);
  if (outcome.kind !== 'candidate') return outcome;
  await assertAiActionUnpausedTx(tx, ctx, 'hr_assistant');
  const candidate = outcome.candidate;
  const now = new Date();
  // SQL owns actual creation/expiry. The cipher binds owner/id/digests, not these provisional times.
  const metadata = OwnLeavePreparedMetadata.parse({ actionId: randomUUID(), action: 'leave.apply', contractVersion: 1,
    binding: candidate.binding, intentDigest: candidate.intentDigest, reviewedDigest: ownLeaveReviewedDigest(candidate),
    state: 'awaiting_confirmation', createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString() });
  const sealed = sealOwnLeaveReview(metadata, { review: candidate, availableBalance: outcome.privateAvailableBalance });
  const [row] = await tx.execute<{ review: unknown }>(sql`select app.assistant_own_leave_review_prepare(
    ${metadata.actionId}::uuid,${candidate.binding.personId}::uuid,${candidate.binding.employmentId}::uuid,
    ${candidate.binding.companyId}::uuid,${metadata.intentDigest},${metadata.reviewedDigest},
    ${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);
  const stored = StoredReview.safeParse(row?.review);
  if (!stored.success || stored.data.metadata.actionId !== metadata.actionId) throw new OwnLeaveContentUnavailable();
  return publicReview(stored.data);
}

/** Fresh Assistant/source access before reopening; no new model admission. This is a frozen saved
 * review, not a current eligibility assertion. Confirmation will need a separate complete recheck. */
export async function reopenOwnLeaveReviewTx(tx: Tx, supplied: SessionContext, actionIdValue: unknown): Promise<PendingResult | RetiredResult> {
  const ctx = captureContext(supplied);
  const actionId = z.string().uuid().safeParse(actionIdValue);
  if (!actionId.success) throw new OwnLeaveContentUnavailable();
  const actor = await readOwnLeaveActorTx(tx, ctx);
  if (!actor) throw new OwnLeaveContentUnavailable();
  await assertAiActionUnpausedTx(tx, actor, 'hr_assistant');
  const [row] = await tx.execute<{ review: unknown }>(sql`select app.assistant_own_leave_review_read(${actionId.data}::uuid) as review`);
  const stored = StoredReview.safeParse(row?.review);
  if (!stored.success || stored.data.metadata.actionId !== actionId.data
    || stored.data.metadata.binding.tenantId !== actor.tenantId || stored.data.metadata.binding.userId !== actor.userId
    || stored.data.metadata.binding.personId !== actor.personId) throw new OwnLeaveContentUnavailable();
  return stored.data.metadata.state === 'awaiting_confirmation' ? publicReview(stored.data) : retired(stored.data);
}

/** Discard is private-content retirement, not an HR effect. It remains available when AI is paused
 * or its grant was removed. SQL still requires current same-login/person/source custody, a fresh
 * principal and the exact reviewed digest. It can never return private content or execute leave. */
export async function discardOwnLeaveReviewTx(tx: Tx, confirmationValue: unknown): Promise<RetiredResult> {
  const confirmation = OwnLeaveConfirmation.safeParse(confirmationValue);
  if (!confirmation.success) throw new OwnLeaveContentUnavailable();
  const [row] = await tx.execute<{ review: unknown }>(sql`select app.assistant_own_leave_review_read(
    ${confirmation.data.actionId}::uuid,true,${confirmation.data.reviewedDigest}) as review`);
  const stored = StoredReview.safeParse(row?.review);
  if (!stored.success || stored.data.metadata.actionId !== confirmation.data.actionId
    || stored.data.metadata.reviewedDigest !== confirmation.data.reviewedDigest) throw new OwnLeaveContentUnavailable();
  return retired(stored.data);
}
