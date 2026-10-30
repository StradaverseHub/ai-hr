import {assertAgentActionUnpausedTx} from '../agent-action-pause';
import {settleReviewCustodyTx} from './review-lifecycle';
import {assertHumanReviewedActionTier} from '../../lib/ai/agent-action-tier-guard';
import {captureNativeOutcomeTargetsTx} from '../module-native-outcome-targets';
import {boundNativeOutcomeTransactionTx} from '../module-native-outcome-bounds';
import {isModuleEnabled} from '../entitlements';
import {ownLeaveHumanIntentText} from '../../lib/assistant-actions/own-leave-human-intent';
/** UNRELEASED review custody and human-confirmation command. The human browser route calls it; no model tool does.
 * Relevant source writers and security/concurrency/retention verification must be complete before exposure.

 * Requires the coordinated review-store and non-admitting-control migrations before runtime use.
 * One caller transaction owns authority, pause check, private row and retirement. No nested commit. */
import { randomUUID, createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant, type SessionContext, type Tx } from '../../db/client';
import { requestLeave, lockLeaveDependenciesTx } from '../../packs/leave/service';
import { assertAiActionUnpausedTx } from '../ai-governance';
import { OwnLeaveConfirmation, OwnLeaveRetirementRequest, OwnLeaveFinalReceipt, OwnLeavePreparedReview,
  type OwnLeaveFinalReceipt as Receipt, type OwnLeavePreparedReview as Card } from '../../lib/assistant-actions/own-leave-contract';
import { assertAiPrincipalTx } from '../ai-principal';
import { OwnLeaveBusy, OwnLeaveReviewIndexResult, isOwnLeaveBusyRefusal } from '../../lib/assistant-actions/own-leave-http';
import { readOwnLeaveActorTx } from './own-leave-actor';
import { readOwnLeaveCandidateTx, type OwnLeaveCandidateResult } from './own-leave-candidate';
import { OwnLeaveContentUnavailable, OwnLeaveSealedReview, sealOwnLeaveReview, unsealOwnLeaveReview } from './own-leave-content';
import { OwnLeavePreparedMetadata, OwnLeaveCustodyMetadata } from './own-leave-review';
import { ownLeaveReviewedDigest } from './own-leave-review-digest';
import { readOwnLeaveSubmissionReferenceTx } from '../read';
import { reconcileRecordedOwnLeaveReceipt } from './own-leave-reconciliation';

const StoredReview = z.object({
  metadata: OwnLeaveCustodyMetadata,
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
    reviewedDigest: metadata.reviewedDigest,humanIntentDigest:createHash('sha256').update(ownLeaveHumanIntentText(review.nomination,{employmentId:review.nomination.employmentId,leaveTypeId:review.nomination.leaveTypeId},review.humanText)).digest('hex'), createdAt: metadata.createdAt, expiresAt: metadata.expiresAt,
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
  // Even a completed receipt is a Leave disclosure, not an exemption from a current module kill.
  if(!isModuleEnabled(actor,'leave'))throw new OwnLeaveContentUnavailable();
  const receipt = stored.receipt;
  if (stored.metadata.state !== 'completed' || receipt?.state !== 'completed') throw new OwnLeaveContentUnavailable();
  const source = await readOwnLeaveSubmissionReferenceTx(tx, actor, receipt.leaveRequestId, receipt.submissionEventId);
  const outcome = reconcileRecordedOwnLeaveReceipt(stored.metadata, receipt, stored.metadata.binding, source);
  if (outcome.status !== 'submission_recorded') throw new OwnLeaveContentUnavailable();
  return { kind: 'completed', receipt };
}

/** Inputs must be supplied by the eventual authenticated human-input owner. This creates only a
 * stored REVIEW, never a leave request or evidence that the human clicked to submit it. */
export async function prepareOwnLeaveReviewTx(tx: Tx, supplied: SessionContext,
  nomination: unknown, selection: unknown, humanText: unknown, locale?: string,
): Promise<PendingResult | Exclude<OwnLeaveCandidateResult, { kind: 'candidate' }>> {
  assertHumanReviewedActionTier(supplied,'leave.apply','confirm');
  const ctx = captureContext(supplied);
  const outcome = await readOwnLeaveCandidateTx(tx, ctx, nomination, selection, humanText, locale);
  if (outcome.kind !== 'candidate') return outcome;
  await assertAiActionUnpausedTx(tx, ctx, 'hr_assistant');await assertAgentActionUnpausedTx(tx,'leave.apply');
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

/** Fresh Assistant/source visibility before returning saved pending content; no model admission.
 * Any changed canonical review refuses rather than returning a formerly permitted balance.
 * Confirmation still repeats complete source/effect checks in its separate top-level transaction. */
export async function reopenOwnLeaveReviewTx(tx: Tx, supplied: SessionContext, actionIdValue: unknown, locale?:string): Promise<PendingResult | RetiredResult | CompletedResult> {
  const ctx = captureContext(supplied);
  const actionId = z.guid().safeParse(actionIdValue);
  if (!actionId.success) throw new OwnLeaveContentUnavailable();
  await boundNativeOutcomeTransactionTx(tx);
  const actor = await readOwnLeaveActorTx(tx, ctx);
  if (!actor || !isModuleEnabled(actor,'leave')) throw new OwnLeaveContentUnavailable();
  await assertAiActionUnpausedTx(tx, actor, 'hr_assistant');await assertAgentActionUnpausedTx(tx,'leave.apply');
  // The nomination helper deliberately refuses foreign custody at SQL level. Keep that refusal
  // on the same bounded content boundary as the subsequent encrypted read; caller must roll back.
  let subjectId:string;
  try{
    const [nominated]=await tx.execute<{subject:unknown}>(sql`select app.assistant_own_leave_review_subject(${actionId.data}::uuid) as subject`);
    subjectId=z.guid().parse(nominated?.subject);
  }catch{throw new OwnLeaveContentUnavailable();}
  const subject={data:subjectId};
  await lockLeaveDependenciesTx(tx,actor.tenantId,[subject.data]);
  const stored = await storedReviewTx(tx, sql`select app.assistant_own_leave_review_read(${actionId.data}::uuid) as review`);
  if (stored.metadata.actionId !== actionId.data
    || stored.metadata.binding.tenantId !== actor.tenantId || stored.metadata.binding.userId !== actor.userId
    || stored.metadata.binding.personId !== actor.personId || stored.metadata.binding.employmentId!==subject.data) throw new OwnLeaveContentUnavailable();
  return settleReviewCustodyTx(stored,{kind:'reopen'},{completed:row=>completed(tx,actor,row),retired,pending:async()=>{
    const saved=unsealOwnLeaveReview(stored.metadata,stored.sealed),intent=saved.review.nomination;
    // Saved visibility is not a permission. Rebuild the exact canonical permitted projection under
    // the same current authority/config/subject interval BEFORE returning any saved values.
    const fresh=await readOwnLeaveCandidateTx(tx,actor,intent,{employmentId:subject.data,leaveTypeId:intent.leaveTypeId},saved.review.humanText,locale);
    if(fresh.kind!=='candidate'||ownLeaveReviewedDigest(fresh.candidate)!==stored.metadata.reviewedDigest||fresh.candidate.intentDigest!==stored.metadata.intentDigest||fresh.privateAvailableBalance!==saved.availableBalance)throw new OwnLeaveContentUnavailable();
    return publicReview(stored);
  },unavailable:():never=>{throw new OwnLeaveContentUnavailable();}});
}

/** Privacy-only retirement for the SAME login, tenant AND person (ADR-0131), still available after
 * source/grant revocation or an AI pause. A relinked login cannot retire the former person's review:
 * the principal proof and the person-bound SQL refuse it exactly like an unknown action ID. No lost
 * digest, plaintext reopening or native permission is needed; completed refuses. */
export async function discardOwnLeaveReviewTx(tx: Tx, supplied: SessionContext, retirementValue: unknown): Promise<RetiredResult> {
 const ctx=captureContext(supplied),parsed=OwnLeaveRetirementRequest.safeParse(retirementValue);
 if(!parsed.success)throw new OwnLeaveContentUnavailable();
 try{
 await boundNativeOutcomeTransactionTx(tx);
 await assertAiPrincipalTx(tx,ctx);
 const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_legacy_review_retire(${parsed.data.actionId}::uuid,'leave.apply') as receipt`);
 const receipt=z.object({action:z.literal('leave.apply'),contractVersion:z.literal(1),actionId:z.guid(),state:z.enum(['discarded','expired','refused'])}).strict().parse(row?.receipt);
 if(receipt.actionId!==parsed.data.actionId)throw new OwnLeaveContentUnavailable();
 const final=OwnLeaveFinalReceipt.parse({actionId:receipt.actionId,contractVersion:receipt.contractVersion,state:receipt.state,...(receipt.state==='refused'?{code:'unavailable' as const}:{})});
 if(final.state==='completed')throw new OwnLeaveContentUnavailable();
 return {kind:'retired',receipt:final};
 }catch{throw new OwnLeaveContentUnavailable();}
}

/** Cleanup is privacy-only. Both SQL owners validate their actual current carrier/principal;
 * query failures never propagate encrypted parameters or raw driver diagnostics. */
async function expireReviewsTx(tx: Tx, limit: number, own: boolean): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new OwnLeaveContentUnavailable();
  try {
    await boundNativeOutcomeTransactionTx(tx);
    const [row] = await tx.execute<{ expired: number }>(own
      ? sql`select app.assistant_own_leave_reviews_expire_own(${limit}) as expired`
      : sql`select app.assistant_own_leave_reviews_expire(${limit}) as expired`);
    if (!row || !Number.isSafeInteger(row.expired) || row.expired < 0 || row.expired > limit)
      throw new OwnLeaveContentUnavailable();
    return row.expired;
  } catch (error) {
    // The Access lock or a review row was busy past the bounded lock_timeout (55P03): the statement
    // failed and the caller's transaction rolls back. Still bounded; no SQL or lock detail escapes.
    throw isOwnLeaveBusyRefusal(error) ? new OwnLeaveBusy() : new OwnLeaveContentUnavailable();
  }
}

/** Existing group-admin primitive; no synthetic system actor or anonymous maintenance grant. */
export function expireOwnLeaveReviewsTx(tx: Tx, limit = 100): Promise<number> {
  return expireReviewsTx(tx, limit, false);
}

/** Exact-login private retention; available without an Assistant grant, never another user's rows. */
export function expireOwnLeaveReviewsForCallerTx(tx: Tx, limit = 100): Promise<number> {
  return expireReviewsTx(tx, limit, true);
}

/** One bounded, committed maintenance batch for an already authenticated group administrator.
 * A full batch reports that more MAY remain, rather than claiming complete retention coverage.
 * Scheduling/credentials are not inferred here. No request or canonical event is created/deleted. */
export async function runOwnLeaveReviewRetention(supplied: SessionContext, limit = 100) {
  const ctx = captureContext(supplied);
  try {
    const expired = await withTenant(ctx, tx => expireOwnLeaveReviewsTx(tx, limit));
    return Object.freeze({ expired, limit, mayHaveMore: expired === limit });
  } catch { throw new OwnLeaveContentUnavailable(); }
}

/** Human-confirmation owner for the unreleased candidate. It owns the top-level transaction: a caught error outside
 * this function cannot commit a request without its receipt. No model/provider call, allowance
 * admission, posted source references or client-supplied business fields are accepted here.
 * This source command is NOT ready for endpoint/tool exposure until all relevant dependency writers,
 * authority/controls, storage/retention and actual security/concurrency/experience checks are verified. */
export async function confirmOwnLeaveReview(supplied: SessionContext, confirmationValue: unknown,
  locale?: string,
): Promise<CompletedResult | RetiredResult> {
  assertHumanReviewedActionTier(supplied,'leave.apply','confirm');
  const ctx = captureContext(supplied), parsed = OwnLeaveConfirmation.safeParse(confirmationValue);
  if (!parsed.success) throw new OwnLeaveContentUnavailable();
  const confirmation = parsed.data;
  try {
    return await withTenant(ctx, async tx => {
      await boundNativeOutcomeTransactionTx(tx);
      const actor = await readOwnLeaveActorTx(tx, ctx);
      if (!actor || !isModuleEnabled(actor,'leave')) throw new OwnLeaveContentUnavailable();
      await assertAiActionUnpausedTx(tx, actor, 'hr_assistant');await assertAgentActionUnpausedTx(tx,'leave.apply');
      const [nominated] = await tx.execute<{ subject: unknown }>(sql`select
        app.assistant_own_leave_review_subject(${confirmation.actionId}::uuid) as subject`);
      const subject = z.guid().safeParse(nominated?.subject);
      if (!subject.success) throw new OwnLeaveContentUnavailable();
      await lockLeaveDependenciesTx(tx, actor.tenantId, [subject.data]);
      const stored = await storedReviewTx(tx, sql`select app.assistant_own_leave_review_read(${confirmation.actionId}::uuid) as review`);
      const m = stored.metadata;
      if (m.actionId !== confirmation.actionId
        || m.binding.tenantId !== actor.tenantId || m.binding.userId !== actor.userId
        || m.binding.personId !== actor.personId || m.binding.employmentId !== subject.data)
        throw new OwnLeaveContentUnavailable();
      return settleReviewCustodyTx(stored,{kind:'confirm',expectedDigest:confirmation.reviewedDigest},{completed:row=>completed(tx,actor,row),retired,pending:async()=>{
      if(m.intentDigest===null)throw new OwnLeaveContentUnavailable();
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
      await captureNativeOutcomeTargetsTx(tx,actor,{action:'leave.apply',sourceId:m.actionId,eventId:written.submittedEventId,targets:[{kind:'employment',id:m.binding.employmentId}]});
       const recorded = await storedReviewTx(tx, sql`select app.assistant_own_leave_review_complete(
        ${m.actionId}::uuid,${m.reviewedDigest},${written.leaveRequestId}::uuid,${written.submittedEventId}::uuid) as review`);
      if (recorded.metadata.actionId !== m.actionId || recorded.receipt?.state !== 'completed'
        || recorded.receipt.leaveRequestId !== written.leaveRequestId
        || recorded.receipt.submissionEventId !== written.submittedEventId) throw new OwnLeaveContentUnavailable();
      return completed(tx, actor, recorded);
      },unavailable:():never=>{throw new OwnLeaveContentUnavailable();}});
    });
  } catch {
    // Source/Drizzle errors can retain private text or encrypted parameters. Bound every outward
    // error, after withTenant has rolled back; never expose a cause or commit a partial command.
    throw new OwnLeaveContentUnavailable();
  }
}

/** Own login's bounded metadata discovery, including after Assistant grant/pause revocation. This
 * grants no review-content, request/event or leave-effect access. Explicit reopen keeps its full gates.
 * Expired private-body cleanup is a separate caller transaction and is not hidden in this reader.
 * ADR-0131 binds own-leave custody to the same login, tenant AND person: the shared AI principal proof
 * refuses a mismatched or stale (relinked) person before any review row is read, with the same generic
 * refusal as every other failure, and the person-bound index lists only the CURRENT person's reviews.
 */
export async function listOwnLeaveReviewsTx(tx:Tx,supplied:SessionContext):Promise<z.infer<typeof OwnLeaveReviewIndexResult>>{
  const ctx=captureContext(supplied);
  try{
    await boundNativeOutcomeTransactionTx(tx);
    // Carrier tenant/login, read-committed isolation, live unblocked login, current roles/grants AND
    // u.person_id = ctx.personId, under the Access interval every relink/role writer joins.
    await assertAiPrincipalTx(tx,ctx);
    const rows=await tx.execute<{actionId:unknown;state:unknown;createdAt:unknown;expiresAt:unknown}>(sql`select action_id as "actionId",state,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
      to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt"
      from app.assistant_own_leave_reviews_index()`);
    return OwnLeaveReviewIndexResult.parse({kind:'review_index',reviews:Array.from(rows)});
  }catch{throw new OwnLeaveContentUnavailable();}
}

/** Completed-only actual-Tx evidence path. Never unseals/returns a pending body or retries a request. */
export async function readCompletedOwnLeaveOutcomeTx(tx:Tx,supplied:SessionContext,value:unknown){
 const ctx=captureContext(supplied),id=z.guid().parse(value);await boundNativeOutcomeTransactionTx(tx);const actor=await readOwnLeaveActorTx(tx,ctx);if(!actor||!isModuleEnabled(actor,'leave'))throw new OwnLeaveContentUnavailable();
 await assertAiActionUnpausedTx(tx,actor,'hr_assistant');await assertAgentActionUnpausedTx(tx,'leave.apply');
 const [terminal]=await tx.execute<{completed:boolean}>(sql`select app.native_outcome_review_completed('leave.apply',${id}::uuid) as completed`);if(terminal?.completed!==true)throw new OwnLeaveContentUnavailable();
 const [nomination]=await tx.execute<{subject:unknown}>(sql`select app.assistant_own_leave_review_subject(${id}::uuid) as subject`),subject=z.guid().parse(nomination?.subject);await lockLeaveDependenciesTx(tx,actor.tenantId,[subject]);
 const stored=await storedReviewTx(tx,sql`select app.assistant_own_leave_review_read(${id}::uuid) as review`);
 if(stored.metadata.actionId!==id||stored.metadata.binding.tenantId!==actor.tenantId||stored.metadata.binding.userId!==actor.userId||stored.metadata.binding.personId!==actor.personId||stored.metadata.binding.employmentId!==subject)throw new OwnLeaveContentUnavailable();
 const completion=await completed(tx,actor,stored);return{completion,eventId:completion.receipt.submissionEventId};
}
