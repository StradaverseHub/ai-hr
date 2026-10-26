/** UNRELEASED review custody and human-confirmation command. No route or model tool calls it.
 * Relevant source writers and security/concurrency/retention verification must be complete before exposure.

 * Requires the coordinated review-store and non-admitting-control migrations before runtime use.
 * One caller transaction owns authority, pause check, private row and retirement. No nested commit. */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant, type SessionContext, type Tx } from '../../db/client';
import { requestLeave, lockLeaveDependenciesTx } from '../../packs/leave/service';
import { assertAiActionUnpausedTx } from '../ai-governance';
import { OwnLeaveConfirmation, OwnLeaveFinalReceipt, OwnLeavePreparedReview,
  type OwnLeaveFinalReceipt as Receipt, type OwnLeavePreparedReview as Card } from '../../lib/assistant-actions/own-leave-contract';
import { readOwnLeaveActorTx } from './own-leave-actor';
import { readOwnLeaveCandidateTx, type OwnLeaveCandidateResult } from './own-leave-candidate';
import { OwnLeaveContentUnavailable, OwnLeaveSealedReview, sealOwnLeaveReview, unsealOwnLeaveReview } from './own-leave-content';
import { OwnLeavePreparedMetadata } from './own-leave-review';
import { ownLeaveReviewedDigest } from './own-leave-review-digest';
import { readOwnLeaveSubmissionReferenceTx } from '../read';
import { reconcileOwnLeaveConfirmation } from './own-leave-reconciliation';

const StoredReview = z.object({
  metadata: OwnLeavePreparedMetadata,
  sealed: OwnLeaveSealedReview.nullable(),
  receipt: OwnLeaveFinalReceipt.nullable(),
}).strict().refine(value => (value.metadata.state === 'awaiting_confirmation') === (value.sealed !== null))
  .refine(value => value.metadata.state === 'completed'
    ? value.receipt?.state === 'completed' && value.receipt.actionId === value.metadata.actionId
    : value.receipt === null);
type StoredReview = z.infer<typeof StoredReview>;
type PendingResult = { kind: 'prepared'; review: Card };
type CompletedResult = { kind: 'completed'; receipt: Extract<Receipt, { state: 'completed' }> };
type RetiredResult = { kind: 'retired'; receipt: Exclude<Receipt, { state: 'completed' }> };

function captureContext(ctx: SessionContext): SessionContext {
  return { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(g => ({ ...g })) };
}

/** Drizzle errors can retain query parameters. Never propagate an envelope/key-bearing query error
 * into telemetry; throw a bounded error without its cause and let the outer transaction abort. */
async function storedReviewTx(tx: Tx, query: SQL): Promise<StoredReview> {
  try {
    const [row] = await tx.execute<{ review: unknown }>(query);
    return StoredReview.parse(row?.review);
  } catch { throw new OwnLeaveContentUnavailable(); }
}

/** Map every public field explicitly. A spread of the encrypted content's server-side object would
 * reveal its private balance and identity bindings even when ESS intentionally hides those values. */
function publicReview(stored: StoredReview): PendingResult {
  const { metadata } = stored;
  const { review } = unsealOwnLeaveReview(metadata, stored.sealed);
  const card = OwnLeavePreparedReview.safeParse({
    actionId: metadata.actionId, contractVersion: metadata.contractVersion,
    reviewedDigest: metadata.reviewedDigest, createdAt: metadata.createdAt, expiresAt: metadata.expiresAt,
    companyName: review.companyName, employeeCode: review.employeeCode, leaveTypeName: review.leaveTypeName,
    date: review.nomination.date, durationType: review.nomination.durationType, deductionDays: review.deductionDays,
    availableBalance: review.availableBalance, estimatedAvailableAfter: review.estimatedAvailableAfter,
    holidayWarnings: review.holidayWarnings, approvalRouting: review.approvalRouting, humanText: review.humanText,
  });
  if (!card.success) throw new OwnLeaveContentUnavailable();
  return { kind: 'prepared', review: card.data };
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

/** A stored marker is not provenance. Reopen only after the actual canonical own-source reader
 * confirms both references under the current actor. Never infer approval or retry an effect here. */
async function completed(tx: Tx, actor: SessionContext, stored: StoredReview): Promise<CompletedResult> {
  const receipt = stored.receipt;
  if (stored.metadata.state !== 'completed' || receipt?.state !== 'completed') throw new OwnLeaveContentUnavailable();
  const source = await readOwnLeaveSubmissionReferenceTx(tx, actor, receipt.leaveRequestId, receipt.submissionEventId);
  const outcome = reconcileOwnLeaveConfirmation(stored.metadata, receipt, {
    actionId: stored.metadata.actionId, contractVersion: stored.metadata.contractVersion,
    reviewedDigest: stored.metadata.reviewedDigest,
  }, stored.metadata.binding, new Date(), source);
  if (outcome.status !== 'submission_recorded') throw new OwnLeaveContentUnavailable();
  return { kind: 'completed', receipt };
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
  const stored = await storedReviewTx(tx, sql`select app.assistant_own_leave_review_prepare(
    ${metadata.actionId}::uuid,${candidate.binding.personId}::uuid,${candidate.binding.employmentId}::uuid,
    ${candidate.binding.companyId}::uuid,${metadata.intentDigest},${metadata.reviewedDigest},
    ${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);
  if (stored.metadata.actionId !== metadata.actionId) throw new OwnLeaveContentUnavailable();
  return publicReview(stored);
}

/** Fresh Assistant/source access before reopening; no new model admission. This is a frozen saved
 * review, not a current eligibility assertion. Confirmation will need a separate complete recheck. */
export async function reopenOwnLeaveReviewTx(tx: Tx, supplied: SessionContext, actionIdValue: unknown): Promise<PendingResult | RetiredResult | CompletedResult> {
  const ctx = captureContext(supplied);
  const actionId = z.string().uuid().safeParse(actionIdValue);
  if (!actionId.success) throw new OwnLeaveContentUnavailable();
  const actor = await readOwnLeaveActorTx(tx, ctx);
  if (!actor) throw new OwnLeaveContentUnavailable();
  await assertAiActionUnpausedTx(tx, actor, 'hr_assistant');
  const stored = await storedReviewTx(tx, sql`select app.assistant_own_leave_review_read(${actionId.data}::uuid) as review`);
  if (stored.metadata.actionId !== actionId.data
    || stored.metadata.binding.tenantId !== actor.tenantId || stored.metadata.binding.userId !== actor.userId
    || stored.metadata.binding.personId !== actor.personId) throw new OwnLeaveContentUnavailable();
  return stored.metadata.state === 'awaiting_confirmation' ? publicReview(stored)
    : stored.metadata.state === 'completed' ? completed(tx, actor, stored) : retired(stored);
}

/** Discard is private-content retirement, not an HR effect. It remains available when AI is paused
 * or its grant was removed. SQL still requires current same-login/person/source custody, a fresh
 * principal and the exact reviewed digest. It can never return private content or execute leave. */
export async function discardOwnLeaveReviewTx(tx: Tx, confirmationValue: unknown): Promise<RetiredResult> {
  const confirmation = OwnLeaveConfirmation.safeParse(confirmationValue);
  if (!confirmation.success) throw new OwnLeaveContentUnavailable();
  const stored = await storedReviewTx(tx, sql`select app.assistant_own_leave_review_read(
    ${confirmation.data.actionId}::uuid,true,${confirmation.data.reviewedDigest}) as review`);
  if (stored.metadata.actionId !== confirmation.data.actionId
    || stored.metadata.reviewedDigest !== confirmation.data.reviewedDigest) throw new OwnLeaveContentUnavailable();
  return retired(stored);
}

/** Bounded administrative retention primitive; no scheduled caller is wired yet. It retires only
 * expired pending reviews and returns a count, never employee identities or protected content. */
export async function expireOwnLeaveReviewsTx(tx: Tx, limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new OwnLeaveContentUnavailable();
  const [row] = await tx.execute<{ expired: number }>(sql`select app.assistant_own_leave_reviews_expire(${limit}) as expired`);
  if (!row || !Number.isSafeInteger(row.expired) || row.expired < 0 || row.expired > limit)
    throw new OwnLeaveContentUnavailable();
  return row.expired;
}

/** UNMOUNTED human-confirmation owner. It owns the top-level transaction: a caught error outside
 * this function cannot commit a request without its receipt. No model/provider call, allowance
 * admission, posted source references or client-supplied business fields are accepted here.
 * This source command is NOT ready for endpoint/tool exposure until all relevant dependency writers,
 * authority/controls, storage/retention and actual security/concurrency/experience checks are verified. */
export async function confirmOwnLeaveReview(supplied: SessionContext, confirmationValue: unknown,
  locale?: string,
): Promise<CompletedResult | RetiredResult> {
  const ctx = captureContext(supplied), parsed = OwnLeaveConfirmation.safeParse(confirmationValue);
  if (!parsed.success) throw new OwnLeaveContentUnavailable();
  const confirmation = parsed.data;
  try {
    return await withTenant(ctx, async tx => {
      const actor = await readOwnLeaveActorTx(tx, ctx);
      if (!actor) throw new OwnLeaveContentUnavailable();
      await assertAiActionUnpausedTx(tx, actor, 'hr_assistant');
      const [nominated] = await tx.execute<{ subject: unknown }>(sql`select
        app.assistant_own_leave_review_subject(${confirmation.actionId}::uuid) as subject`);
      const subject = z.string().uuid().safeParse(nominated?.subject);
      if (!subject.success) throw new OwnLeaveContentUnavailable();
      await lockLeaveDependenciesTx(tx, actor.tenantId, [subject.data]);
      const stored = await storedReviewTx(tx, sql`select app.assistant_own_leave_review_read(${confirmation.actionId}::uuid) as review`);
      const m = stored.metadata;
      if (m.actionId !== confirmation.actionId || m.reviewedDigest !== confirmation.reviewedDigest
        || m.binding.tenantId !== actor.tenantId || m.binding.userId !== actor.userId
        || m.binding.personId !== actor.personId || m.binding.employmentId !== subject.data)
        throw new OwnLeaveContentUnavailable();
      if (m.state === 'completed') return completed(tx, actor, stored);
      if (m.state !== 'awaiting_confirmation') return retired(stored);
      const saved = unsealOwnLeaveReview(m, stored.sealed), intent = saved.review.nomination;
      const fresh = await readOwnLeaveCandidateTx(tx, actor, intent,
        { employmentId: m.binding.employmentId, leaveTypeId: intent.leaveTypeId }, saved.review.humanText, locale);
      if (fresh.kind !== 'candidate' || ownLeaveReviewedDigest(fresh.candidate) !== m.reviewedDigest
        || fresh.candidate.intentDigest !== m.intentDigest || fresh.privateAvailableBalance !== saved.availableBalance)
        throw new OwnLeaveContentUnavailable();
      const candidate = fresh.candidate;
      const written = await requestLeave(actor, {
        employmentId: m.binding.employmentId, leaveTypeId: intent.leaveTypeId,
        startDate: intent.date, endDate: intent.date, durationType: 'full_day', ...saved.review.humanText,
      }, tx, { employmentId: m.binding.employmentId, companyId: m.binding.companyId,
        leaveTypeId: intent.leaveTypeId, date: intent.date, days: candidate.deductionDays,
        availableBalance: fresh.privateAvailableBalance, holidayWarnings: candidate.holidayWarnings });
      if (!written.submittedEventId || written.days !== candidate.deductionDays)
        throw new OwnLeaveContentUnavailable();
      const recorded = await storedReviewTx(tx, sql`select app.assistant_own_leave_review_complete(
        ${m.actionId}::uuid,${m.reviewedDigest},${written.requestId}::uuid,${written.submittedEventId}::uuid) as review`);
      if (recorded.metadata.actionId !== m.actionId || recorded.receipt?.state !== 'completed'
        || recorded.receipt.leaveRequestId !== written.requestId
        || recorded.receipt.submissionEventId !== written.submittedEventId) throw new OwnLeaveContentUnavailable();
      return completed(tx, actor, recorded);
    });
  } catch {
    // Source/Drizzle errors can retain private text or encrypted parameters. Bound every outward
    // error, after withTenant has rolled back; never expose a cause or commit a partial command.
    throw new OwnLeaveContentUnavailable();
  }
}
