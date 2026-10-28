import {requireNativeOutcomeTargetsTx} from '../module-native-outcome-targets';
/** Closed actual-source adapters only. Never calls prepare/confirm, decrypts pending content,
 * executes a service string, or interprets arbitrary native SQL/event payloads in a harness. */
import {boundNativeOutcomeTransactionTx} from '../module-native-outcome-bounds';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {NativeOutcomeReference,NativeOutcomeEvidence} from '../../lib/ai/module-native-outcomes';
import {readCompletedOwnLeaveOutcomeTx} from './own-leave-store';
import {readCompletedNotificationOutcomeTx,readCompletedProfileOutcomeTx,readCompletedClaimDraftOutcomeTx,readCompletedClaimSubmissionOutcomeTx,readCompletedStandardReviewOutcomeTx,readCompletedOnehrPlanOutcomeTx,readCompletedTestingOutcomeTx} from './module-action-review-store';
import {readCompletedOrgOutcomeTx} from './org-action-review-store';
import {readCompletedKnowledgeArticleOutcomeTx} from './knowledge-article-review-store';
import {readCompletedAttendanceCorrectionOutcomeTx} from './attendance-correction-review-store';
import {readCompletedCountryStatutoryOutcomeTx} from './country-statutory-review-store';
import {readCompletedLeaveDecisionOutcomeTx} from './leave-decision-review-store';
import {readCompletedLifecycleAckOutcomeTx} from './lifecycle-ack-review-store';
import {readCompletedToilRequestOutcomeTx} from './toil-request-review-store';
import {readCompletedClaimCancellationOutcomeTx} from './claim-cancellation-review-store';
import {leaveCancellationReviews,leaveEditReviews} from './leave-change-review-store';
import {overtimeRequestReviews} from './overtime-request-review-store';
import {claimDecisionReviews,attendanceDecisionReviews,toilDecisionReviews} from './assigned-decision-review-store';
import {leaveAdjustmentReviews,movementTransferReviews} from './hr-prepared-review-store';
import {readCompletedMultiCycleRunOutcomeTx} from './multi-cycle-run-review-store';
import {readCompletedPayComponentOutcomeTx} from './pay-component-review-store';
import {readCompletedPayrollCloseOutcomeTx} from './payroll-close-review-store';
import {readCompletedRewardsPostOutcomeTx} from './rewards-post-review-store';
import {readCompletedEmployeeImportOutcomeTx} from '../personnel-import-evaluation';
import type {OwnNotificationServerIdentity} from './own-notification-preferences-source';
export type NativeOutcomeServerContext=Readonly<{notificationIdentity?:OwnNotificationServerIdentity}>;
const unavailable=():never=>{throw Error('Native outcome unavailable.');};
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
/** Only existing native status codes are projected. Completed custody is NOT business approval. */
function currentStatus(completion:unknown){const outer=object(completion),receipt=object(outer?.receipt),native=object(receipt?.receipt)??receipt;const value=native?.currentStatus??native?.status;if(value===undefined||value===null)return null;return z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).parse(value);}
export async function readCompletedNativeOutcomeTx(tx:Tx,supplied:SessionContext,value:unknown,server:NativeOutcomeServerContext={}){
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))},capability=server.notificationIdentity;
 const reference=NativeOutcomeReference.parse(structuredClone(value));await boundNativeOutcomeTransactionTx(tx);
 if(reference.source==='employee_import'){
  const read=await readCompletedEmployeeImportOutcomeTx(tx,ctx,{attemptId:reference.attemptId,attemptVersion:reference.attemptVersion},reference.companyId);
  await requireNativeOutcomeTargetsTx(tx,ctx,{action:reference.action,sourceId:read.attemptId,eventId:read.eventId});
  return {evidence:NativeOutcomeEvidence.parse({action:reference.action,sourceId:read.attemptId,eventId:read.eventId,currentStatus:read.currentStatus}),sourceExpiresAt:read.expiresAt};
 }
 let result:{completion:unknown;eventId:string};const id=reference.actionId;
 switch(reference.action){
  case 'leave.apply':result=await readCompletedOwnLeaveOutcomeTx(tx,ctx,id);break;
  case 'ess.profile.request':result=await readCompletedProfileOutcomeTx(tx,ctx,id);break;
  case 'notifications.email_preferences.save':if(!capability)return unavailable();result=await readCompletedNotificationOutcomeTx(tx,ctx,id,capability);break;
  case 'claims.draft.save':result=await readCompletedClaimDraftOutcomeTx(tx,ctx,id);break;
  case 'claims.submit':result=await readCompletedClaimSubmissionOutcomeTx(tx,ctx,id);break;
  case 'claims.cancel':result=await readCompletedClaimCancellationOutcomeTx(tx,ctx,id);break;
  case 'leave.cancel':result=await leaveCancellationReviews.readCompletedOutcomeTx(tx,ctx,id);break;
  case 'leave.edit':result=await leaveEditReviews.readCompletedOutcomeTx(tx,ctx,id);break;
  case 'attendance.overtime.request':result=await overtimeRequestReviews.readCompletedOutcomeTx(tx,ctx,id);break;
  case 'approvals.claim.decide':result=await claimDecisionReviews.readCompletedOutcomeTx(tx,ctx,id);break;
  case 'approvals.attendance.decide':result=await attendanceDecisionReviews.readCompletedOutcomeTx(tx,ctx,id);break;
  case 'approvals.toil.decide':result=await toilDecisionReviews.readCompletedOutcomeTx(tx,ctx,id);break;
  case 'leave.adjustment.apply':result=await leaveAdjustmentReviews.readCompletedOutcomeTx(tx,ctx,id);break;
  case 'employees.movement.transfer':result=await movementTransferReviews.readCompletedOutcomeTx(tx,ctx,id);break;
  case 'performance.review.acknowledge':result=await readCompletedStandardReviewOutcomeTx(tx,ctx,id);break;
  case 'performance.onehr.plan.acknowledge':result=await readCompletedOnehrPlanOutcomeTx(tx,ctx,id);break;
  case 'system_testing.execution.save':result=await readCompletedTestingOutcomeTx(tx,ctx,id);break;
  case 'org.reporting.change':result=await readCompletedOrgOutcomeTx(tx,ctx,id);break;
  case 'knowledge_base.article.create':result=await readCompletedKnowledgeArticleOutcomeTx(tx,ctx,id);break;
  case 'attendance.correction.request':result=await readCompletedAttendanceCorrectionOutcomeTx(tx,ctx,id);break;
  case 'country-my.statutory.update':result=await readCompletedCountryStatutoryOutcomeTx(tx,ctx,id);break;
  case 'approvals.leave.decide':result=await readCompletedLeaveDecisionOutcomeTx(tx,ctx,id);break;
  case 'lifecycle.acknowledgement.submit':result=await readCompletedLifecycleAckOutcomeTx(tx,ctx,id);break;
  case 'toil.replacement.request':result=await readCompletedToilRequestOutcomeTx(tx,ctx,id);break;
  case 'multi_cycle_payroll.create_run':result=await readCompletedMultiCycleRunOutcomeTx(tx,ctx,id);break;
  case 'typed_pay_components.create':result=await readCompletedPayComponentOutcomeTx(tx,ctx,id);break;
  case 'payroll.close':result=await readCompletedPayrollCloseOutcomeTx(tx,ctx,id);break;
  case 'rewards.post':result=await readCompletedRewardsPostOutcomeTx(tx,ctx,id);break;
  default:{const never:never=reference;void never;return unavailable();}
 }
 const evidence=NativeOutcomeEvidence.parse({action:reference.action,sourceId:id,eventId:result.eventId,currentStatus:currentStatus(result.completion)});
 await requireNativeOutcomeTargetsTx(tx,ctx,{action:reference.action,sourceId:id,eventId:result.eventId});
 const [retention]=await tx.execute<{expires:Date|string|null}>(sql`select app.native_outcome_review_retention(${reference.action},${id}::uuid) as expires`);if(!retention?.expires)return unavailable();
 const expires=new Date(retention.expires);if(!Number.isFinite(expires.getTime()))return unavailable();return {evidence,sourceExpiresAt:expires.toISOString()};
}
