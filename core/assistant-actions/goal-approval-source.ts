/** One native goal approval. No ratings, review locking, generated text or pay effects. */
import {createHash} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {performanceGoal} from '../../db/schema';
import {GoalApproval as C,type GoalApprovalHuman as Human} from '../../lib/assistant-actions/goal-approval-contract';
import {approveGoalTx,readGoalApprovalSourceTx} from '../../packs/performance/service';
import {assertCanDecide} from '../approvals';
import {lockAccessConfigurationTx} from '../access-configuration-lock';
import {withAgentActionGuard} from './agent-action-guard';
import type {AssignedSubject} from './generic-assigned-review-store';
export const goalApprovalUnavailable=():never=>{throw Error('Please reopen the goal approval review.');};
const fail=goalApprovalUnavailable,hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Subject=AssignedSubject&{revision:string};
async function subject(tx:Tx,ctx:SessionContext,id:string):Promise<Subject>{
 const [row]=await tx.execute<{scope:Subject|null}>(sql`select app.assistant_goal_approval_scope(${id}::uuid) as scope`);
 if(!row?.scope)return fail();await assertCanDecide(tx,ctx,row.scope.employmentId,'goal approval');
 if(ctx.personId!=null&&row.scope.subjectPersonId===ctx.personId)return fail();return row.scope;
}
export async function withGoalApprovalSubjectTx<T>(tx:Tx,ctx:SessionContext,id:string,_mode:'pending'|'recorded',work:(fresh:SessionContext,s:AssignedSubject)=>Promise<T>):Promise<T>{
 const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve');await lockAccessConfigurationTx(tx,fresh.tenantId);return work(fresh,await subject(tx,fresh,id));
}
async function review(tx:Tx,ctx:SessionContext,human:Human){
 const s=await subject(tx,ctx,human.subjectId);if(s.employmentId!==human.employmentId)return fail();
 const native=await readGoalApprovalSourceTx(tx,ctx,human.subjectId),g=native.goal;
 const item=C.Item.parse({subjectId:g.id,employmentId:g.employmentId,title:g.title,description:g.description,metric:g.metric,target:g.target,weight:g.weight,dueOn:g.dueOn,before:'proposed',after:'approved'});
 return{review:item,reviewedDigest:hash([1,C.action,s,human,native.reviewDigest,item]),nativeDigest:native.reviewDigest};
}
export async function prepareGoalApprovalSourceTx(tx:Tx,ctx:SessionContext,human:Human){return review(tx,ctx,human);}
export async function confirmGoalApprovalSourceTx(tx:Tx,ctx:SessionContext,human:Human,expected:string){
 const current=await review(tx,ctx,human);if(current.reviewedDigest!==expected)return fail();
 const effect=await approveGoalTx(tx,ctx,{goalId:human.subjectId},current.nativeDigest);
 return{eventId:effect.eventId,receipt:await reconcileGoalApprovalSourceTx(tx,ctx,{subjectId:effect.goalId,employmentId:effect.employmentId,eventId:effect.eventId})};
}
export async function reconcileGoalApprovalSourceTx(tx:Tx,ctx:SessionContext,reference:{subjectId:string;employmentId:string;eventId:string}){
 const s=await subject(tx,ctx,reference.subjectId);if(s.employmentId!==reference.employmentId)return fail();
 const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_goal_approval_receipt(${reference.subjectId}::uuid,${reference.eventId}::uuid) as receipt`);return C.Receipt.parse(row?.receipt);
}
export async function readGoalApprovalChoicesTx(tx:Tx,ctx:SessionContext,selection:unknown){
 const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve'),pick=C.Selection.parse(selection??{query:''});
 // The SQL predicate mirrors native visibility/direct-manager/delegation + absolute self-ban.
 // Limit before projection; no names, ratings, comments or other assessment work is read.
 const rows=await tx.select({subjectId:performanceGoal.id,employmentId:performanceGoal.employmentId,title:performanceGoal.title}).from(performanceGoal)
  .where(and(eq(performanceGoal.tenantId,fresh.tenantId),eq(performanceGoal.approvalStatus,'proposed'),sql`${performanceGoal.title} ilike ${'%'+pick.query.replace(/[\\%_]/g,'\\$&')+'%'}`,sql`app.assistant_goal_approval_choice_scope(${performanceGoal.id})`,...(pick.subjectId?[eq(performanceGoal.id,pick.subjectId)]:[])))
  .orderBy(performanceGoal.id).limit(26);
 return C.Choices.parse({kind:'choices',items:rows.slice(0,25),truncated:rows.length>25});
}
