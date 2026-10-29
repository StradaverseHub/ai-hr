/** Human-reviewed non-own-subject assigned-work source. Parent command MUST own a top-level Tx and
 * governed review custody before exposure. Models cannot call confirm or supply a SessionContext. */
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {withAgentActionGuard} from './agent-action-guard';
import {assertModuleEnabled} from '../entitlements';
import {lockReviewedLeaveDecisionSourceTx,prepareReviewedLeaveDecisionTx,decideReviewedLeaveTx,readReviewedLeaveDecisionReferenceTx} from '../../packs/leave/service';
import {ReviewedLeaveDecisionHumanContent as Human,ReviewedLeaveDecisionConfirmation as Confirmation,ReviewedLeaveDecisionPreparedSource as Prepared,ReviewedLeaveDecisionSourceReceipt as Receipt} from '../../lib/assistant-actions/reviewed-leave-decision-contract';
export class ReviewedLeaveDecisionUnavailable extends Error{constructor(){super('That leave decision needs another look. Please reopen your assigned task.');this.name='ReviewedLeaveDecisionUnavailable';}}
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
export async function assertReviewedLeaveDecisionActorTx(tx:Tx,supplied:SessionContext){const fresh=await withAgentActionGuard(tx,capture(supplied),'approvals.leave.decide','approve');assertModuleEnabled(fresh,'leave');return fresh;}
const selection=(p:z.infer<typeof Human>)=>({leaveRequestId:p.leaveRequestId,currentStepId:p.currentStepId,decision:p.decision,rejectReason:p.rejectReason});
export async function prepareReviewedLeaveDecisionSourceTx(tx:Tx,supplied:SessionContext,value:unknown):Promise<z.infer<typeof Prepared>>{
 const ctx=capture(supplied);try{const content=Human.parse(structuredClone(value)),fresh=await assertReviewedLeaveDecisionActorTx(tx,ctx),{reviewedDigest,...review}=await prepareReviewedLeaveDecisionTx(tx,fresh,selection(content));if(Buffer.byteLength(review.applicantReason??'','utf8')>16000||Buffer.byteLength(review.employeeRemark??'','utf8')>16000||Buffer.byteLength(JSON.stringify(review),'utf8')>49152)throw new ReviewedLeaveDecisionUnavailable();return Prepared.parse({kind:'prepared_source',content,review,reviewedDigest,consequence:'assigned_decision_request_may_remain_pending'});}catch{throw new ReviewedLeaveDecisionUnavailable();}
}
/** Any error requires rollback of the WHOLE caller Tx: step, ledger, request, Payroll and event. */
export async function confirmReviewedLeaveDecisionSourceTx(tx:Tx,supplied:SessionContext,storedHumanValue:unknown,confirmationValue:unknown):Promise<z.infer<typeof Receipt>>{
 const ctx=capture(supplied);try{const content=Human.parse(structuredClone(storedHumanValue)),expected=Confirmation.parse(structuredClone(confirmationValue)),fresh=await assertReviewedLeaveDecisionActorTx(tx,ctx),native=await decideReviewedLeaveTx(tx,fresh,selection(content),expected.reviewedDigest);return Receipt.parse({kind:'decision_recorded',...native,semantics:'recorded_decision_current_request_status',replayed:false});}catch{throw new ReviewedLeaveDecisionUnavailable();}
}
export async function reconcileReviewedLeaveDecisionSourceTx(tx:Tx,supplied:SessionContext,value:unknown):Promise<z.infer<typeof Receipt>>{
 const ctx=capture(supplied);try{const reference=z.union([Receipt.pick({leaveRequestId:true,decisionEventId:true,decisionStepId:true}).strict(),Receipt]).parse(structuredClone(value)),fresh=await assertReviewedLeaveDecisionActorTx(tx,ctx),native=await readReviewedLeaveDecisionReferenceTx(tx,fresh,reference);if(!native)throw new ReviewedLeaveDecisionUnavailable();return Receipt.parse({kind:'decision_recorded',...native,semantics:'recorded_decision_current_request_status',replayed:true});}catch{throw new ReviewedLeaveDecisionUnavailable();}
}

/** Actual native source ownership, never a speculative decision or validation rehearsal. */
export async function withReviewedLeaveDecisionIntervalTx<T>(tx:Tx,supplied:SessionContext,reference:{leaveRequestId:string;currentStepId:string|null},mode:'pending'|'recorded',work:(fresh:SessionContext,binding:{employmentId:string;companyId:string;subjectPersonId:string})=>Promise<T>):Promise<T>{
 const ctx=capture(supplied),p=z.object({leaveRequestId:z.guid(),currentStepId:z.guid().nullable()}).strict().parse(structuredClone(reference));try{const fresh=await assertReviewedLeaveDecisionActorTx(tx,ctx),owned=await lockReviewedLeaveDecisionSourceTx(tx,fresh,p,mode);return await work(fresh,{employmentId:owned.req.employmentId,companyId:owned.subject.companyId,subjectPersonId:owned.subject.personId});}catch{throw new ReviewedLeaveDecisionUnavailable();}
}
