import {requireNativeOutcomeTargetsTx} from '../module-native-outcome-targets';
/** Closed actual-source adapters only. Never calls prepare/confirm, decrypts pending content,
 * executes a service string, or interprets arbitrary native SQL/event payloads in a harness. */
import {boundNativeOutcomeTransactionTx} from '../module-native-outcome-bounds';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {NativeOutcomeReference,NativeOutcomeEvidence} from '../../lib/ai/module-native-outcomes';
import type {AgentReviewActionId} from '../../lib/ai/agent-action-registry';
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
import {compensationMaintenanceReviews} from './compensation-maintenance-review-store';
import {emergencyContactMaintenanceReviews} from './emergency-contact-maintenance-review-store';
import {qualificationMaintenanceReviews} from './qualification-maintenance-review-store';
import {leaveAdjustmentReviews,movementTransferReviews,leaveCreditReviews} from './hr-prepared-review-store';
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
/** WP7: one completed-outcome reader per registry action with a review store. The Record type makes a registry
 * entry without a reader (or a reader without an entry) a compile error. Each reader rechecks authority. */
type CompletedOutcomeReader=(tx:Tx,ctx:SessionContext,id:string,server:NativeOutcomeServerContext)=>Promise<{completion:unknown;eventId:string}>;
const COMPLETED_OUTCOME_READERS:Readonly<Record<AgentReviewActionId,CompletedOutcomeReader>>={
 'leave.apply':(tx,ctx,id)=>readCompletedOwnLeaveOutcomeTx(tx,ctx,id),
 'ess.profile.request':(tx,ctx,id)=>readCompletedProfileOutcomeTx(tx,ctx,id),
 'notifications.email_preferences.save':(tx,ctx,id,server)=>server.notificationIdentity?readCompletedNotificationOutcomeTx(tx,ctx,id,server.notificationIdentity):unavailable(),
 'claims.draft.save':(tx,ctx,id)=>readCompletedClaimDraftOutcomeTx(tx,ctx,id),
 'claims.submit':(tx,ctx,id)=>readCompletedClaimSubmissionOutcomeTx(tx,ctx,id),
 'claims.cancel':(tx,ctx,id)=>readCompletedClaimCancellationOutcomeTx(tx,ctx,id),
 'leave.cancel':(tx,ctx,id)=>leaveCancellationReviews.readCompletedOutcomeTx(tx,ctx,id),
 'leave.edit':(tx,ctx,id)=>leaveEditReviews.readCompletedOutcomeTx(tx,ctx,id),
 'attendance.overtime.request':(tx,ctx,id)=>overtimeRequestReviews.readCompletedOutcomeTx(tx,ctx,id),
 'approvals.claim.decide':(tx,ctx,id)=>claimDecisionReviews.readCompletedOutcomeTx(tx,ctx,id),
 'approvals.attendance.decide':(tx,ctx,id)=>attendanceDecisionReviews.readCompletedOutcomeTx(tx,ctx,id),
 'approvals.toil.decide':(tx,ctx,id)=>toilDecisionReviews.readCompletedOutcomeTx(tx,ctx,id),
 'leave.adjustment.apply':(tx,ctx,id)=>leaveAdjustmentReviews.readCompletedOutcomeTx(tx,ctx,id),
 'employees.compensation.maintain':(tx,ctx,id)=>compensationMaintenanceReviews.readCompletedOutcomeTx(tx,ctx,id),
 'employees.emergency_contact.maintain':(tx,ctx,id)=>emergencyContactMaintenanceReviews.readCompletedOutcomeTx(tx,ctx,id),
 'employees.qualification.maintain':(tx,ctx,id)=>qualificationMaintenanceReviews.readCompletedOutcomeTx(tx,ctx,id),
 'employees.movement.transfer':(tx,ctx,id)=>movementTransferReviews.readCompletedOutcomeTx(tx,ctx,id),
 'toil.credit.grant':(tx,ctx,id)=>leaveCreditReviews.readCompletedOutcomeTx(tx,ctx,id),
 'performance.review.acknowledge':(tx,ctx,id)=>readCompletedStandardReviewOutcomeTx(tx,ctx,id),
 'performance.onehr.plan.acknowledge':(tx,ctx,id)=>readCompletedOnehrPlanOutcomeTx(tx,ctx,id),
 'system_testing.execution.save':(tx,ctx,id)=>readCompletedTestingOutcomeTx(tx,ctx,id),
 'org.reporting.change':(tx,ctx,id)=>readCompletedOrgOutcomeTx(tx,ctx,id),
 'knowledge_base.article.create':(tx,ctx,id)=>readCompletedKnowledgeArticleOutcomeTx(tx,ctx,id),
 'attendance.correction.request':(tx,ctx,id)=>readCompletedAttendanceCorrectionOutcomeTx(tx,ctx,id),
 'country-my.statutory.update':(tx,ctx,id)=>readCompletedCountryStatutoryOutcomeTx(tx,ctx,id),
 'approvals.leave.decide':(tx,ctx,id)=>readCompletedLeaveDecisionOutcomeTx(tx,ctx,id),
 'lifecycle.acknowledgement.submit':(tx,ctx,id)=>readCompletedLifecycleAckOutcomeTx(tx,ctx,id),
 'toil.replacement.request':(tx,ctx,id)=>readCompletedToilRequestOutcomeTx(tx,ctx,id),
 'multi_cycle_payroll.create_run':(tx,ctx,id)=>readCompletedMultiCycleRunOutcomeTx(tx,ctx,id),
 'typed_pay_components.create':(tx,ctx,id)=>readCompletedPayComponentOutcomeTx(tx,ctx,id),
 'payroll.close':(tx,ctx,id)=>readCompletedPayrollCloseOutcomeTx(tx,ctx,id),
 'rewards.post':(tx,ctx,id)=>readCompletedRewardsPostOutcomeTx(tx,ctx,id),
};
export async function readCompletedNativeOutcomeTx(tx:Tx,supplied:SessionContext,value:unknown,server:NativeOutcomeServerContext={}){
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 const reference=NativeOutcomeReference.parse(structuredClone(value));await boundNativeOutcomeTransactionTx(tx);
 if(reference.source==='employee_import'){
  const read=await readCompletedEmployeeImportOutcomeTx(tx,ctx,{attemptId:reference.attemptId,attemptVersion:reference.attemptVersion},reference.companyId);
  await requireNativeOutcomeTargetsTx(tx,ctx,{action:reference.action,sourceId:read.attemptId,eventId:read.eventId});
  return {evidence:NativeOutcomeEvidence.parse({action:reference.action,sourceId:read.attemptId,eventId:read.eventId,currentStatus:read.currentStatus}),sourceExpiresAt:read.expiresAt};
 }
 const id=reference.actionId,result=await COMPLETED_OUTCOME_READERS[reference.action](tx,ctx,id,server);
 const evidence=NativeOutcomeEvidence.parse({action:reference.action,sourceId:id,eventId:result.eventId,currentStatus:currentStatus(result.completion)});
 await requireNativeOutcomeTargetsTx(tx,ctx,{action:reference.action,sourceId:id,eventId:result.eventId});
 const [retention]=await tx.execute<{expires:Date|string|null}>(sql`select app.native_outcome_review_retention(${reference.action},${id}::uuid) as expires`);if(!retention?.expires)return unavailable();
 const expires=new Date(retention.expires);if(!Number.isFinite(expires.getTime()))return unavailable();return {evidence,sourceExpiresAt:expires.toISOString()};
}
