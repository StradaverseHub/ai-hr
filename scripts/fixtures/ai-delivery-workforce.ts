/** Fictional canonical prerequisite setup ONLY. Caller owns guarded disposable-target/admission.
 * No inline SQL installation, raw business inserts, identity creation, provider calls or UI-target
 * confirmation. Partial failure retains native facts; parent must preserve rather than reset/retry. */
import {and,eq} from 'drizzle-orm';
import {withTenant} from '../../db/client';
import {withAssistantRead} from '../../core/assistant-read-session';
import * as s from '../../db/schema';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {setLeaveTypeRules,updateLeaveType} from '../../core/admin';
import {setReportingLine} from '../../core/workforce-commands';
import {createEntitlementTemplate,setLeaveTypeDefaultTemplate,setLeaveApprovalPolicy,openLeaveYear,requestLeave,pendingLeaveDecisionChoiceMetadataTx} from '../../packs/leave/service';
import {readOwnLeaveCandidateTx} from '../../core/assistant-actions/own-leave-candidate';
import {prepareReviewedReportingLineSourceTx} from '../../core/assistant-actions/reviewed-reporting-line-source';
import {prepareReviewedLeaveDecisionSourceTx} from '../../core/assistant-actions/reviewed-leave-decision-source';
import {REVIEWED_LEAVE_DECISION_ACTION} from '../../lib/assistant-actions/reviewed-leave-decision-contract';
import {REVIEWED_REPORTING_LINE_ACTION} from '../../lib/assistant-actions/reviewed-reporting-line-contract';
import {saveProfileEditPolicy} from '../../core/profile-edit-policy';
import {readOwnProfileWorkspace} from '../../core/profile-edit';
import {prepareOwnProfileChangeSourceTx} from '../../core/assistant-actions/own-profile-change-source';
import {OWN_PROFILE_CHANGE_ACTION} from '../../lib/assistant-actions/own-profile-change-contract';
import {createArticle} from '../../core/knowledge-base';
import {prepareKnowledgeArticleSourceTx} from '../../core/assistant-actions/knowledge-article-source';
import {KNOWLEDGE_ARTICLE_ACTION} from '../../lib/assistant-actions/knowledge-article-contract';
import type {AiDeliveryFixtureContext,AiDeliveryFixtureActor} from './ai-delivery-fixture-context';
const unavailable=()=>new Error('Fictional Workforce prerequisites are incomplete; preserve target and inspect actual native setup.');
const fields={preferred:'profile.personal_details.preferredname'} as const;
function actorsOf(c:AiDeliveryFixtureContext){return[c.actors.operator,c.actors.self,...c.actors.reviewers,c.actors.peer,c.actors.manager];}
function identityBound(c:AiDeliveryFixtureContext,a:AiDeliveryFixtureActor){return a.ctx.tenantId===c.tenantId&&a.ctx.userId===a.userId&&a.ctx.personId===a.personId;}
async function suitableDate(c:AiDeliveryFixtureContext,actor:AiDeliveryFixtureActor,typeId:string,offset:number){
 const date=new Date(c.today+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+offset);
 const humanText={reason:'Fictional human browser personal appointment',employeeRemark:'Fictional human browser remark'};
 for(let n=0;n<31;n++){date.setUTCDate(date.getUTCDate()+1);const requestedDate=date.toISOString().slice(0,10),nomination={action:'leave.apply',contractVersion:1,employmentId:actor.employmentId,leaveTypeId:typeId,date:requestedDate,durationType:'full_day'},selection={employmentId:actor.employmentId,leaveTypeId:typeId};
  const checked=await withTenant(actor.ctx,tx=>readOwnLeaveCandidateTx(tx,actor.ctx,nomination,selection,humanText,'en'));
  if(checked.kind==='candidate'&&checked.candidate.deductionDays===1&&typeof checked.candidate.availableBalance==='number'&&Number.isFinite(checked.candidate.availableBalance)&&checked.candidate.availableBalance>=1)return{date:requestedDate,humanText,availableBalance:checked.candidate.availableBalance,deductionDays:checked.candidate.deductionDays};
 }throw unavailable();
}
export async function populateAiDeliveryWorkforce(c:AiDeliveryFixtureContext){
 const actors=actorsOf(c);if(c.today!==todayInKualaLumpur()||c.period!==c.today.slice(0,7)||c.bootstrapCtx.tenantId!==c.tenantId||actors.some(a=>!identityBound(c,a))||new Set(actors.map(a=>a.employmentId)).size!==actors.length)throw unavailable();
 // The context contract cannot substitute for actual current employment/company/person facts.
 for(const a of actors){const [row]=await c.owner.db.select({personId:s.employment.personId,companyId:s.employment.companyId,hiredOn:s.employment.hiredOn,terminatedOn:s.employment.terminatedOn}).from(s.employment).where(and(eq(s.employment.tenantId,c.tenantId),eq(s.employment.id,a.employmentId)));if(!row||row.personId!==a.personId||row.companyId!==c.companyId||row.hiredOn>c.today||row.terminatedOn!==null)throw unavailable();}
 const year=Number(c.today.slice(0,4)),yearStart=String(year)+'-01-01';
 const [annual]=await c.owner.db.select().from(s.leaveType).where(and(eq(s.leaveType.tenantId,c.tenantId),eq(s.leaveType.code,'ANNUAL'))).limit(1);if(!annual)throw unavailable();
 await updateLeaveType(c.bootstrapCtx,{id:annual.id,name:annual.name,employeeRemarkRequired:true});
 const template=await createEntitlementTemplate(c.bootstrapCtx,{leaveTypeId:annual.id,name:'Fictional Full AI Browser Annual 20',validFrom:yearStart,serviceBands:[{fromYears:0,toYears:null,days:20,carryForwardDays:0,maxBalanceDays:20}]});
 const bound=await setLeaveTypeDefaultTemplate(c.bootstrapCtx,{leaveTypeId:annual.id,templateLineageId:template.lineageId});if(bound.defaultTemplateLineageId!==template.lineageId)throw unavailable();
 await setLeaveTypeRules(c.bootstrapCtx,{id:annual.id,accrualMethod:'lump_sum'});
 const opened=await openLeaveYear(c.bootstrapCtx,{year,leaveTypeIds:[annual.id],employmentIds:actors.map(a=>a.employmentId)});if(opened.packBlocked.length)throw unavailable();
 const reportingLines=[];
 for(const actor of [c.actors.operator,c.actors.self,...c.actors.reviewers,c.actors.peer]){const made=await setReportingLine(c.bootstrapCtx,{subordinateEmploymentId:actor.employmentId,managerEmploymentId:c.actors.manager.employmentId,lineType:'administrative',validFrom:yearStart});reportingLines.push({employmentId:actor.employmentId,reportingLineId:made.reportingLineId});}
 const original=reportingLines.find(row=>row.employmentId===c.actors.self.employmentId);if(!original)throw unavailable();
 for(const actor of [c.actors.operator,c.actors.self,...c.actors.reviewers,c.actors.peer]){
  const native=await withAssistantRead(actor.ctx,'org',read=>read.moduleWork('org')),data=native.data as {rows?:unknown};
  if(!data||!Array.isArray(data.rows)||!data.rows.some(row=>row&&typeof row==='object'&&row.employmentId===actor.employmentId&&Array.isArray(row.reportingLines)&&row.reportingLines.length>0))throw unavailable();
 }
 const orgHuman={action:REVIEWED_REPORTING_LINE_ACTION,contractVersion:1 as const,subordinateEmploymentId:c.actors.self.employmentId,managerEmploymentId:c.actors.reviewers[0].employmentId,lineType:'administrative' as const,validFrom:c.today,confirmReportingChange:true as const};
 const orgReview=await withTenant(c.actors.operator.ctx,tx=>prepareReviewedReportingLineSourceTx(tx,c.actors.operator.ctx,orgHuman));if(orgReview.review.before?.reportingLineId!==original.reportingLineId||orgReview.review.after.managerEmploymentId!==c.actors.reviewers[0].employmentId)throw unavailable();
 await setLeaveApprovalPolicy(c.bootstrapCtx,{companyId:c.companyId,levels:['direct_manager','hr_admin'],reason:'Fictional full browser manager then HR workflow'});
 const ownLeave=await suitableDate(c,c.actors.self,annual.id,0),peerLeave=await suitableDate(c,c.actors.peer,annual.id,7);
 // Different person's request is an explicit prerequisite for the decision UI, not the self action target.
 const pending=await requestLeave(c.actors.peer.ctx,{employmentId:c.actors.peer.employmentId,leaveTypeId:annual.id,startDate:peerLeave.date,endDate:peerLeave.date,durationType:'full_day',...peerLeave.humanText});
 const choice=await withTenant(c.actors.manager.ctx,tx=>pendingLeaveDecisionChoiceMetadataTx(tx,c.actors.manager.ctx)),task=choice.tasks.find(row=>row.leaveRequestId===pending.leaveRequestId);if(!task)throw unavailable();
 const decisionHuman={action:REVIEWED_LEAVE_DECISION_ACTION,contractVersion:1 as const,leaveRequestId:pending.leaveRequestId,currentStepId:task.currentStepId,decision:'approved' as const,rejectReason:null,confirmAssignedDecision:true as const};
 const decision=await withTenant(c.actors.manager.ctx,tx=>prepareReviewedLeaveDecisionSourceTx(tx,c.actors.manager.ctx,decisionHuman));if(decision.content.leaveRequestId!==pending.leaveRequestId)throw unavailable();
 // The Approvals specialist's current-caller read is OWN request history, not the assigned inbox.
 // Separate baseline requests provide actual evidence for each evaluator; SELF remains unsubmitted.
 const ownApprovalBaselines=[];
 for(const actor of [c.actors.operator,...c.actors.reviewers]){
  const selected=await suitableDate(c,actor,annual.id,14),request=await requestLeave(actor.ctx,{employmentId:actor.employmentId,leaveTypeId:annual.id,startDate:selected.date,endDate:selected.date,durationType:'full_day',reason:'Fictional independent evaluator baseline leave request',employeeRemark:'Fixture prerequisite, not the self browser action target'});
  const [record]=await c.owner.db.select({id:s.leaveRequest.id,status:s.leaveRequest.status,employmentId:s.leaveRequest.employmentId}).from(s.leaveRequest).where(and(eq(s.leaveRequest.tenantId,c.tenantId),eq(s.leaveRequest.id,request.leaveRequestId)));
  if(record?.status!=='pending'||record.employmentId!==actor.employmentId||request.days<=0)throw unavailable();
  const native=await withAssistantRead(actor.ctx,'approvals',read=>read.moduleWork('approvals')),data=native.data as {rows?:unknown};
  if(!data||!Array.isArray(data.rows)||!data.rows.some(row=>row&&typeof row==='object'&&row.id===record.id&&row.status==='pending'))throw unavailable();
  ownApprovalBaselines.push({userId:actor.userId,employmentId:actor.employmentId,requestId:record.id,status:record.status,date:selected.date,nativeDays:request.days});
 }

 await saveProfileEditPolicy(c.bootstrapCtx,{keys:[fields.preferred],withdrawnReason:'Fictional browser preferred-name request policy'});
 const profile=await readOwnProfileWorkspace(c.actors.self.ctx,{employmentId:c.actors.self.employmentId}),baseline=profile.baselines[fields.preferred];if(!baseline)throw unavailable();
 const profileHuman={action:OWN_PROFILE_CHANGE_ACTION,contractVersion:1 as const,employmentId:c.actors.self.employmentId,proposal:{v:2 as const,fields:[{fieldId:fields.preferred,before:baseline,value:'Fictional Human Preferred Browser Name'}],registers:[]}};
 const profileReview=await withTenant(c.actors.self.ctx,tx=>prepareOwnProfileChangeSourceTx(tx,c.actors.self.ctx,profileHuman));
 // Baseline reference article is distinct from the publication target, which remains uncreated.
 const baselineArticle=await createArticle(c.bootstrapCtx,{title:'Fictional Existing Browser Reference',body:'This is an invented fixture reference, not company HR policy.',category:'fictional-browser',audience:'employee'});
 const articleHuman={action:KNOWLEDGE_ARTICLE_ACTION,contractVersion:1 as const,title:'Fictional Human Browser Publication Target',body:'Human-authored fictional browser content. This is not HR policy.',category:'fictional-browser',audience:'employee' as const};
 const articleReview=await withTenant(c.actors.operator.ctx,tx=>prepareKnowledgeArticleSourceTx(tx,c.actors.operator.ctx,articleHuman));
 const [pendingRow]=await c.owner.db.select({id:s.leaveRequest.id,status:s.leaveRequest.status}).from(s.leaveRequest).where(and(eq(s.leaveRequest.tenantId,c.tenantId),eq(s.leaveRequest.id,pending.leaveRequestId)));if(pendingRow?.status!=='pending'||pending.days<=0)throw unavailable();
 return {org:{reportingLines,originalReportingLineId:original.reportingLineId,human:orgReview.content,review:orgReview.review},leave:{annualTypeId:annual.id,templateLineageId:template.lineageId,year,opened:{granted:opened.granted,skipped:opened.skipped,forfeits:opened.forfeits},self:ownLeave},ess:{human:profileReview.content,consequence:profileReview.consequence},approvals:{ownApprovalBaselines,requestId:pending.leaveRequestId,currentStepId:task.currentStepId,assignedManagerUserId:c.actors.manager.userId,nativeDays:pending.days,currentStatus:pendingRow.status,human:decision.content},knowledge:{baselineArticleId:baselineArticle.id,human:articleReview.content,consequence:articleReview.consequence},employeeImport:{route:'/admin/personnel/import' as const,source:'synthetic_client_local_only' as const,messyCsv:'Employee ID,Full Name,Personal Email,Join Date,Unresolved Heading\nAI-IMPORT-NEW,Fictional Imported Human,fictional-import@example.test,,human must map or exclude\n',pastedText:'Employee ID: AI-IMPORT-PASTE\nFull Name: Fictional Pasted Human\nPersonal Email: fictional-paste@example.test\nJoin Date: [human must supply actual fictional fixture date]\n',requiresHumanResolution:true as const,providerTransfer:'headings_only_after_separate_explicit_consent' as const},uiTargetsExecuted:false as const};
}
