import { eq } from 'drizzle-orm';
import { employmentReview } from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {listReviews,submitManagerEvaluation,decideReview,ReviewError} from './employment-review';
import {isCurrentAssignedApproval} from './assigned-approval-focus';
import {myEmployment} from './read';
import {withMobileCommandReceipt} from './mobile-command-receipt';
import {decisionRefusal} from './mobile-approvals';
import {ReviewWorkspaceDecisionResult,type ReviewWorkspaceKind,type ReviewWorkspaceCommand,type ReviewWorkspaceResult} from '../lib/mobile-api/v2/review-workspaces';
const statusOf=(kind:ReviewWorkspaceKind)=>kind==='managerReview'?'pending_manager' as const:'pending_hr' as const;
const assigned=(ctx:SessionContext,kind:ReviewWorkspaceKind,id:string)=>isCurrentAssignedApproval(ctx,{kind,id},{attendance:false,claims:false});
export async function readReviewWorkspace(ctx:SessionContext,kind:ReviewWorkspaceKind,id:string):Promise<ReviewWorkspaceResult>{
 if(!await assigned(ctx,kind,id))return {outcome:'refused',code:'not_assigned'};
 const [r]=await listReviews(ctx,{status:statusOf(kind),requestId:id});
 if(!r||r.personId===ctx.personId)return {outcome:'refused',code:'not_assigned'};
 return {outcome:'found',workspace:{kind,id:r.id,subject:{name:r.employee,code:r.employeeCode},reviewType:r.reviewType as 'probation'|'contract'|'internship',endDate:r.endDate,dueDate:r.dueDate,managerRecommendation:r.managerRecommendation,managerComments:r.managerComments,expected:{status:statusOf(kind)}}};
}
class Refused extends Error {constructor(readonly code:'not_assigned'|'stale_step'|'self_approval'){super(code);}}
export async function decideReviewWorkspace(ctx:SessionContext,kind:ReviewWorkspaceKind,id:string,c:ReviewWorkspaceCommand){
 const me=await myEmployment(ctx);if(!me)return {outcome:'refused' as const,code:'employment_required' as const};
 try{return await withMobileCommandReceipt(ctx,{kind:'review.decision',requestId:c.requestId,actorEmploymentId:me.employmentId,response:ReviewWorkspaceDecisionResult,intent:{kind,id,action:c.action,comments:c.comments??null,extendToDate:c.extendToDate??null,terminationReason:c.terminationReason??null,expected:c.expected}},async tx=>{
  if(!await assigned(ctx,kind,id))throw new Refused('not_assigned');
  const [r]=await tx.select({status:employmentReview.status,personId:employmentReview.personId}).from(employmentReview).where(eq(employmentReview.id,id)).limit(1).for('update');
  if(!r)throw new Refused('not_assigned');if(r.personId===ctx.personId)throw new Refused('self_approval');
  if(r.status!==c.expected.status||r.status!==statusOf(kind))throw new Refused('stale_step');
  if(kind==='managerReview'){
   if(c.action!=='recommend_confirm'&&c.action!=='recommend_extend'&&c.action!=='recommend_terminate')throw new Refused('stale_step');
   await submitManagerEvaluation(ctx,{reviewId:id,recommendation:c.action,comments:c.comments},tx);
   return {outcome:'accepted' as const,status:'pending_hr' as const};
  }
  if(c.action!=='confirm'&&c.action!=='extend'&&c.action!=='terminate')throw new Refused('stale_step');
  await decideReview(ctx,{reviewId:id,decision:c.action,extendToDate:c.extendToDate,hrComments:c.action==='terminate'?c.terminationReason:c.comments,deciderEmploymentId:me.employmentId},tx);
  return {outcome:'accepted' as const,status:'completed' as const};
 });}catch(e){if(e instanceof Refused)return {outcome:'refused' as const,code:e.code};if(e instanceof ReviewError)return {outcome:'refused' as const,code:'decision_refused' as const};return decisionRefusal(e);}
}
