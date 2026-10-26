/** Candidate authenticated human browser binding; no model executor or posted session/identity. */
import 'server-only';
import {withTenant,type SessionContext} from '../../db/client';
import {appOrigin} from '../../lib/real-auth';
import {ToilRequestActionChoices,LifecycleAckActionAvailability,KnowledgeActionAvailability,OrgActionSearch,OrgActionChoices,TestingActionChoices,ClaimActionChoices,PerformanceActionChoices,createModuleActionBrowserHandler} from '../../lib/assistant-actions/module-action-http';
import {authenticateOwnLeaveBrowserSession} from './own-leave-server';
import {resolveOwnNotificationServerIdentity} from './own-notification-preferences-source';
import {prepareModuleActionReview,confirmModuleActionReview,reopenModuleActionReview,discardModuleActionReview,listModuleActionReviews,prepareProfileModuleActionReview,confirmProfileModuleActionReview,reopenProfileModuleActionReview,discardProfileModuleActionReview,listProfileModuleActionReviews,prepareReviewModuleActionReview,confirmReviewModuleActionReview,reopenReviewModuleActionReview,discardReviewModuleActionReview,listReviewModuleActionReviews,prepareOnehrModuleActionReview,confirmOnehrModuleActionReview,reopenOnehrModuleActionReview,discardOnehrModuleActionReview,listOnehrModuleActionReviews} from './module-action-review-store';
import {assertAiPrincipalTx} from '../ai-principal';
import {assertMayUseAssistant} from '../assistant-grant';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {resolveEntitlementsTx,assertModuleEnabled} from '../entitlements';
import {readOwnNotificationEmailChoiceSubjectsTx} from '../notification-email';
import {myOwnEmploymentSubjectsTx,pickName} from '../read';
import {readOwnProfileWorkspace} from '../profile-edit';
import {PERSONNEL_FIELDS} from '../../lib/personnel-field-registry';
import {ownPerformanceAcknowledgementChoicesTx} from '../../packs/performance/service';
import {ownClaimDraftChoicesTx,readOwnClaimDraftEditableTx} from '../../packs/claims/service';
import {prepareClaimModuleActionReview,confirmClaimModuleActionReview,reopenClaimModuleActionReview,discardClaimModuleActionReview,listClaimModuleActionReviews} from './module-action-review-store';
import {ownTestingWorkStatusesTx,readOwnTestingExecutionEditableTx} from '../system-testing-workspace';
import {prepareTestingModuleActionReview,confirmTestingModuleActionReview,reopenTestingModuleActionReview,discardTestingModuleActionReview,listTestingModuleActionReviews} from './module-action-review-store';
import {prepareClaimSubmissionModuleActionReview,confirmClaimSubmissionModuleActionReview,reopenClaimSubmissionModuleActionReview,discardClaimSubmissionModuleActionReview,listClaimSubmissionModuleActionReviews} from './module-action-review-store';
import {and,eq,sql} from 'drizzle-orm';
import {assertOwnToilReplacementActorTx,withOwnToilReplacementIntervalTx} from './own-toil-replacement-source';
import {prepareToilRequestReview,confirmToilRequestReview,reopenToilRequestReview,discardToilRequestReview,listToilRequestReviews} from './toil-request-review-store';
import {replacementRequestAvailability,leaveCreditOfferForEmployment,findReplacementLeaveTypeIdTx,lockLeaveDependencyReadConfigurationTx,lockLeaveDependenciesTx} from '../../packs/leave/service';
import {leaveType} from '../../db/schema';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {assertOwnLifecycleAcknowledgementActorTx} from './own-lifecycle-acknowledgement-source';
import {prepareLifecycleAckReview,confirmLifecycleAckReview,reopenLifecycleAckReview,discardLifecycleAckReview,listLifecycleAckReviews} from './lifecycle-ack-review-store';
import {assertKnowledgeArticleActorTx} from './knowledge-article-source';
import {visibleAudiencesFor} from '../knowledge-base';
import {prepareKnowledgeArticleReview,confirmKnowledgeArticleReview,reopenKnowledgeArticleReview,discardKnowledgeArticleReview,listKnowledgeArticleReviews} from './knowledge-article-review-store';
import {prepareOrgActionReview,confirmOrgActionReview,reopenOrgActionReview,discardOrgActionReview,listOrgActionReviews} from './org-action-review-store';
import {searchReviewedReportingLineChoicesTx,reviewedReportingLineLabelsTx} from '../workforce-commands';
import {z} from 'zod';
import {MODULE_REVIEW_ACK_ACTION} from '../../lib/assistant-actions/module-action-review-contract';
/** Minimal source choices only after fresh authority; this read does not prepare or execute effects. */
export async function readNotificationModuleActionChoices(supplied:SessionContext):Promise<{kind:'choices';employments:{employmentId:string;employeeCode:string|null;companyName:string}[]}|{kind:'unavailable'}>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};
  await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,'notifications');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');
  const employments=await readOwnNotificationEmailChoiceSubjectsTx(tx,fresh);if(employments.length>16)throw Error();return{kind:'choices',employments};
 });}catch{return{kind:'unavailable'};}
}
/** Actual canonical ESS workspace in THIS guarded Tx; only supported text-field IDs/labels and
 * opaque baselines leave this owner. No current values, full Person/statutory/register rows or
 * editable-but-unsupported fields are serialized. Those remain explicit manual workflow. */
export async function readProfileModuleActionChoices(supplied:SessionContext){
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};
  await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,'ess');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');
  const subjects=await myOwnEmploymentSubjectsTx(tx,fresh,{profileEdit:true});if(subjects.length>16)throw Error();
  const employments=[];
  for(const subject of subjects){const workspace=await readOwnProfileWorkspace(fresh,{employmentId:subject.employmentId},undefined,tx);
   if(workspace.employmentId!==subject.employmentId||workspace.personId!==fresh.personId)throw Error();
   const editable=new Set(workspace.editable),visible=new Set(workspace.visible);
   const permitted=PERSONNEL_FIELDS.filter(field=>editable.has(field.id)&&visible.has(field.id)&&field.ess.edit==='approval'&&field.ess.binding);
   const supported=permitted.filter(field=>field.type==='text'&&field.grain==='single'&&field.ess.binding?.owner==='person'&&!field.ess.masked&&!field.allowedValuesOwner);
   if(supported.length>32)throw Error();
   const fields=supported.map(field=>{const baseline=workspace.baselines[field.id];if(typeof baseline!=='string'||!/^sha256:[a-f0-9]{64}$/.test(baseline))throw Error();return {fieldId:field.id,baseline,type:'text' as const};});
   employments.push({employmentId:subject.employmentId,employeeCode:subject.employeeCode,companyName:subject.company,fields,manualPending:permitted.length!==supported.length||workspace.registers.length>0});
  }
  return {kind:'choices' as const,employments};
 });}catch{return {kind:'unavailable' as const};}
}
/** Current eligible OWN metadata only; no list locks, preparation calls or private review content. */
export async function readPerformanceModuleActionChoices(supplied:SessionContext):Promise<PerformanceActionChoices>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,'performance');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');const result=await ownPerformanceAcknowledgementChoicesTx(tx,fresh,25);return PerformanceActionChoices.parse({kind:'choices',items:result.items,truncated:result.truncated});});}catch{return{kind:'unavailable'};}
}
export async function readClaimModuleActionDraft(supplied:SessionContext,selection:{employmentId:string;draftId:string}){
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};selection={...selection};
 return withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const fresh={...ctx,entitlementsError:undefined,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,'claims');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');return{kind:'draft_edit' as const,draft:await readOwnClaimDraftEditableTx(tx,fresh,selection)};});
}
/** Canonical minimal own choices, no budget/rates or attachment content. */
export async function readClaimModuleActionChoices(supplied:SessionContext):Promise<ClaimActionChoices>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 try{return await withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);const fresh={...ctx,entitlementsError:undefined,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,'claims');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');return ClaimActionChoices.parse({kind:'choices',...await ownClaimDraftChoicesTx(tx,fresh)});});}catch{return{kind:'unavailable'};}
}
/** USER-owned Testing choices work for real standalone logins without person/employment. */
export async function readTestingModuleActionChoices(supplied:SessionContext):Promise<TestingActionChoices>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};try{return await withTenant(ctx,async tx=>{const result=await ownTestingWorkStatusesTx(tx,ctx,25);return TestingActionChoices.parse({kind:'choices',truncated:result.truncated,items:result.rows.map(({assignmentId,caseId,caseNo,title,versionId,ordinal,executionId,status})=>({assignmentId,caseId,caseNo,title,versionId,instructionOrdinal:ordinal,executionId,status}))});});}catch{return{kind:'unavailable'};}
}
export async function readTestingModuleActionExecution(supplied:SessionContext,id:string){
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};return withTenant(ctx,async tx=>({kind:'testing_execution_edit' as const,source:await readOwnTestingExecutionEditableTx(tx,ctx,id)}));
}
/** Native request eligibility/policy only, never banked credits or wage values. Complete own-subject
 * ownership precedes per-policy reads; genuine unconfigured catalogues retain native nullable target. */
export async function readToilRequestModuleActionChoices(supplied:SessionContext,locale?:string){const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};try{return await withTenant(ctx,async tx=>{const fresh=await assertOwnToilReplacementActorTx(tx,ctx),today=todayInKualaLumpur();await lockLeaveDependencyReadConfigurationTx(tx,fresh.tenantId);const subjects=await myOwnEmploymentSubjectsTx(tx,fresh);if(subjects.length>16)throw Error('TOIL choices unavailable');if(subjects.length)await lockLeaveDependenciesTx(tx,fresh.tenantId,subjects.map(row=>row.employmentId));const currentSubjects=await myOwnEmploymentSubjectsTx(tx,fresh);if(JSON.stringify(currentSubjects)!==JSON.stringify(subjects))throw Error('TOIL choices changed');const typeId=await findReplacementLeaveTypeIdTx(tx,fresh.tenantId);let replacementType:{id:string;name:string}|null=null;if(typeId){const [type]=await tx.select({id:leaveType.id,name:leaveType.name,i18n:leaveType.i18n}).from(leaveType).where(and(eq(leaveType.id,typeId),eq(leaveType.tenantId,fresh.tenantId))).limit(1);if(!type)throw Error('TOIL choices unavailable');replacementType={id:type.id,name:pickName(type.name,type.i18n,locale)};}const employments:Extract<z.infer<typeof ToilRequestActionChoices>,{kind:'choices'}>['employments']=[];for(const subject of [...currentSubjects].sort((a,b)=>a.employmentId.localeCompare(b.employmentId))){await withOwnToilReplacementIntervalTx(tx,fresh,subject.employmentId,async current=>{const availability=await replacementRequestAvailability(current,subject.employmentId,today,tx);if(!availability.allowed)return;const offer=await leaveCreditOfferForEmployment(current,subject.employmentId,tx);if(!offer)throw Error('TOIL choices unavailable');employments.push({employmentId:subject.employmentId,employeeCode:subject.employeeCode,companyName:subject.company,requiresFirstScheduleConsent:availability.requiresFirstScheduleConsent===true,ordinaryDayAllowed:offer.ordinaryDayAllowed,replacementType});});}if(today!==todayInKualaLumpur())throw Error('TOIL choices changed');return ToilRequestActionChoices.parse({kind:'choices',today,employments});});}catch{return{kind:'unavailable' as const};}}
/** Pending-only native email-owned availability. No dummy human content or invented own employee;
 * completed reopen deliberately bypasses this pending gate and uses its separate custody owner. */
export async function readLifecycleAckModuleActionAvailability(supplied:SessionContext){const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};try{return await withTenant(ctx,async tx=>{await assertOwnLifecycleAcknowledgementActorTx(tx,ctx);const [row]=await tx.execute<{source:unknown}>(sql`select app.lc_my_daa_review_source() as source`),source=z.object({caseId:z.uuid(),caseNumber:z.string().min(1).max(100),caseRevision:z.string().regex(/^\d+$/),distributionRevision:z.string().regex(/^\d+$/)}).strict().parse(row?.source);return LifecycleAckActionAvailability.parse({kind:'available',currentCase:{caseId:source.caseId,caseNumber:source.caseNumber}});});}catch{return{kind:'unavailable' as const};}}
/** Form availability never reads a private article or creates a prepared review. */
export async function readKnowledgeModuleActionAvailability(supplied:SessionContext){const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};try{return await withTenant(ctx,async tx=>{const fresh=await assertKnowledgeArticleActorTx(tx,ctx);return KnowledgeActionAvailability.parse({kind:'available',audiences:visibleAudiencesFor(fresh)});});}catch{return{kind:'unavailable' as const};}}
/** Every Org choice/label read repeats current real HR admission. No own-employment prerequisite. */
async function orgActor(tx:Parameters<typeof assertAiPrincipalTx>[0],ctx:SessionContext){await assertAiPrincipalTx(tx,ctx);const fresh={...ctx,entitlementsError:undefined,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,'org');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');return fresh;}
export async function readOrgModuleActionAvailability(supplied:SessionContext){const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};try{return await withTenant(ctx,async tx=>{await orgActor(tx,ctx);return{kind:'available' as const};});}catch{return{kind:'unavailable' as const};}}
export async function readOrgModuleActionChoices(supplied:SessionContext,value:z.infer<typeof OrgActionSearch>){const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))},selection=OrgActionSearch.parse(value);return withTenant(ctx,async tx=>{const fresh=await orgActor(tx,ctx);return OrgActionChoices.parse({kind:'org_choices',selection,...await searchReviewedReportingLineChoicesTx(tx,fresh,selection)});});}
async function orgLabels(supplied:SessionContext,selection:Parameters<typeof reviewedReportingLineLabelsTx>[2]){const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))},p={...selection};return withTenant(ctx,async tx=>reviewedReportingLineLabelsTx(tx,await orgActor(tx,ctx),p));}
/** Exact trusted native references become human labels only after fresh purpose checks. A failure
 * after an already committed confirmation remains transport uncertainty, never evidence of rollback. */
async function presentOrgResult(ctx:SessionContext,result:Awaited<ReturnType<typeof reopenOrgActionReview>>){if(result.kind==='prepared'){const r=result.review;return{...result,review:{...r,labels:await orgLabels(ctx,{subordinateEmploymentId:r.content.subordinateEmploymentId,managerEmploymentId:r.content.managerEmploymentId,previousManagerEmploymentId:r.review.before?.managerEmploymentId??null})}};}if(result.kind==='completed'){const r=result.receipt.receipt,{subordinate,manager}=await orgLabels(ctx,{subordinateEmploymentId:r.subordinateEmploymentId,managerEmploymentId:r.managerEmploymentId,previousManagerEmploymentId:null});return{...result,receipt:{...result.receipt,labels:{subordinate,manager}}};}return result;}
/** Resolve verified identity outside EACH effect/reopen transaction, never from a packet, cached
 * tenant config or encrypted body. Listing/retirement requires no provider-identity admission. */
export async function handleConfiguredModuleActionBrowserCommand(request:Request):Promise<Response>{
 let publicOrigin:string|undefined;try{publicOrigin=appOrigin();}catch{publicOrigin=undefined;}
 return createModuleActionBrowserHandler({authenticate:authenticateOwnLeaveBrowserSession,
  toil:{list:session=>listToilRequestReviews(session.ctx),prepare:(session,input)=>prepareToilRequestReview(session.ctx,input),reopen:(session,id)=>reopenToilRequestReview(session.ctx,id),confirm:(session,input)=>confirmToilRequestReview(session.ctx,input),discard:(session,input)=>discardToilRequestReview(session.ctx,input)},
  lifecycleAck:{list:session=>listLifecycleAckReviews(session.ctx),prepare:(session,input)=>prepareLifecycleAckReview(session.ctx,input),reopen:(session,id)=>reopenLifecycleAckReview(session.ctx,id),confirm:(session,input)=>confirmLifecycleAckReview(session.ctx,input),discard:(session,input)=>discardLifecycleAckReview(session.ctx,input)},
  knowledge:{list:session=>listKnowledgeArticleReviews(session.ctx),prepare:(session,input)=>prepareKnowledgeArticleReview(session.ctx,input),reopen:(session,id)=>reopenKnowledgeArticleReview(session.ctx,id),confirm:(session,input)=>confirmKnowledgeArticleReview(session.ctx,input),discard:(session,input)=>discardKnowledgeArticleReview(session.ctx,input)},
  org:{choices:(session,selection)=>readOrgModuleActionChoices(session.ctx,selection),list:session=>listOrgActionReviews(session.ctx),prepare:async(session,input)=>presentOrgResult(session.ctx,await prepareOrgActionReview(session.ctx,input)),reopen:async(session,id)=>presentOrgResult(session.ctx,await reopenOrgActionReview(session.ctx,id)),confirm:async(session,input)=>presentOrgResult(session.ctx,await confirmOrgActionReview(session.ctx,input)),discard:(session,input)=>discardOrgActionReview(session.ctx,input)},
  testing:{list:session=>listTestingModuleActionReviews(session.ctx),readExecution:(session,id)=>readTestingModuleActionExecution(session.ctx,id),prepare:(session,input)=>prepareTestingModuleActionReview(session.ctx,input),reopen:(session,id)=>reopenTestingModuleActionReview(session.ctx,id),confirm:(session,input)=>confirmTestingModuleActionReview(session.ctx,input),discard:(session,input)=>discardTestingModuleActionReview(session.ctx,input)},
  claimSubmission:{list:session=>listClaimSubmissionModuleActionReviews(session.ctx),prepare:(session,input)=>prepareClaimSubmissionModuleActionReview(session.ctx,input),reopen:(session,id)=>reopenClaimSubmissionModuleActionReview(session.ctx,id),confirm:(session,input)=>confirmClaimSubmissionModuleActionReview(session.ctx,input),discard:(session,input)=>discardClaimSubmissionModuleActionReview(session.ctx,input)},
  claims:{readDraft:(session,input)=>readClaimModuleActionDraft(session.ctx,input),list:session=>listClaimModuleActionReviews(session.ctx),prepare:(session,input)=>prepareClaimModuleActionReview(session.ctx,input),reopen:(session,id)=>reopenClaimModuleActionReview(session.ctx,id),confirm:(session,input)=>confirmClaimModuleActionReview(session.ctx,input),discard:(session,input)=>discardClaimModuleActionReview(session.ctx,input)},
  performance:{list:(session,action)=>action===MODULE_REVIEW_ACK_ACTION?listReviewModuleActionReviews(session.ctx):listOnehrModuleActionReviews(session.ctx),prepare:(session,input)=>input.action===MODULE_REVIEW_ACK_ACTION?prepareReviewModuleActionReview(session.ctx,input):prepareOnehrModuleActionReview(session.ctx,input),reopen:(session,action,id)=>action===MODULE_REVIEW_ACK_ACTION?reopenReviewModuleActionReview(session.ctx,id):reopenOnehrModuleActionReview(session.ctx,id),confirm:(session,input)=>input.action===MODULE_REVIEW_ACK_ACTION?confirmReviewModuleActionReview(session.ctx,input):confirmOnehrModuleActionReview(session.ctx,input),discard:(session,input)=>input.action===MODULE_REVIEW_ACK_ACTION?discardReviewModuleActionReview(session.ctx,input):discardOnehrModuleActionReview(session.ctx,input)},
  profile:{list:session=>listProfileModuleActionReviews(session.ctx),prepare:(session,input)=>prepareProfileModuleActionReview(session.ctx,input),reopen:(session,id)=>reopenProfileModuleActionReview(session.ctx,id),confirm:(session,input)=>confirmProfileModuleActionReview(session.ctx,input),discard:(session,input)=>discardProfileModuleActionReview(session.ctx,input)},
  list:session=>listModuleActionReviews(session.ctx),
  prepare:async(session,input)=>prepareModuleActionReview(session.ctx,input,await resolveOwnNotificationServerIdentity()),
  reopen:async(session,id)=>reopenModuleActionReview(session.ctx,id,await resolveOwnNotificationServerIdentity()),
  confirm:async(session,input)=>confirmModuleActionReview(session.ctx,input,await resolveOwnNotificationServerIdentity()),
  discard:(session,input)=>discardModuleActionReview(session.ctx,input),
 },{publicOrigin})(request);
}
