/** Import-safe native fixture composition only. The parent CLI/harness must independently prove
 * disposable target, resource admission, clean source and preservation. No automatic invocation,
 * provider call, manifest write, server lifecycle, browser observation or release acceptance. */
import {and,count,eq} from 'drizzle-orm';
import type {createDb} from '../../db/client';
import * as s from '../../db/schema';
import {withAssistantRead} from '../../core/assistant-read-session';
import {executeSpecialistHoldout} from '../../core/module-specialist-harness';
import {AGENT_MODULE_CODES} from '../../lib/ai/module-agents';
import {createAiDeliveryFixtureContext,aiDeliveryFixturePhase as phase} from './ai-delivery-fixture-factory';
import {populateAiDeliveryWorkforce} from './ai-delivery-workforce';
import {populateAiDeliveryScopeDenials} from './ai-delivery-scope-denial-fixture';
import {populateAiDeliveryFinancial,finalizeAiDeliveryFinancial} from './ai-delivery-financial';
import {populateAiDeliveryPlatform} from './ai-delivery-platform';
import type {AiDeliveryFixtureActor} from './ai-delivery-fixture-context';
const actorReference=(actor:AiDeliveryFixtureActor)=>({userId:actor.userId,personId:actor.personId,employmentId:actor.employmentId});
/** These records are private fixture evidence, never a browser/provider capability packet. */
export async function populateAiDeliveryFullFixture(owner:ReturnType<typeof createDb>){
 const c=await phase('full fixture factory',()=>createAiDeliveryFixtureContext(owner));
 const workforce=await phase('full fixture Workforce',()=>populateAiDeliveryWorkforce(c));
 // New denied/revocable identities belong to their separate company; create them before any
 // primary payroll is closed, then derive all final baselines from actual native state.
 const scopeDenials=await phase('full fixture scope denials',()=>populateAiDeliveryScopeDenials(c,{annualTypeId:workforce.leave.annualTypeId,selfLeave:workforce.leave.self}));
 const financial=await phase('full fixture Financial',()=>populateAiDeliveryFinancial(c));
 const platform=await phase('full fixture Platform',()=>populateAiDeliveryPlatform(c));
 const financialReady=await phase('full fixture Financial after platform inputs',()=>finalizeAiDeliveryFinancial(c,financial));
 // Re-read actual native sources AFTER the last changed inputs, independently for each actual user.
 // Never borrow the self actor's facts or persist a governed evaluation/promotion as fixture setup.
 const finalPrerequisites=[];
 for(const actor of [c.actors.operator,...c.actors.reviewers]){
  const modules=[];
  for(const module of AGENT_MODULE_CODES){
   const report=await phase('full fixture final native '+actor.userId+':'+module,()=>withAssistantRead(actor.ctx,module,read=>executeSpecialistHoldout({kind:'canonical_specialist_v1',module,playbook:'canonical_domain_v1'},read)));
   if(report.state!=='complete'||report.nativeEvidence!=='present'||report.qualityFailures!==0||report.securityFailures!==0||!report.cases.length||!report.cases.every(row=>row.passed)||!report.cases.some(row=>row.category==='native'&&row.id===module+':nonempty-business-evidence'&&row.passed))throw Error('Current nonempty fixture prerequisite unavailable for '+module);
   modules.push({module:report.module,state:report.state,nativeEvidence:report.nativeEvidence,qualityFailures:report.qualityFailures,securityFailures:report.securityFailures,cases:report.cases});
  }
  finalPrerequisites.push({userId:actor.userId,modules});
 }
 // Detect accidental target pre-execution; these are direct canonical reads, not invented receipts.
 const [selfRequests]=await owner.db.select({n:count()}).from(s.leaveRequest).where(and(eq(s.leaveRequest.tenantId,c.tenantId),eq(s.leaveRequest.employmentId,c.actors.self.employmentId)));
 const [profileRequests]=await owner.db.select({n:count()}).from(s.profileChangeRequest).where(and(eq(s.profileChangeRequest.tenantId,c.tenantId),eq(s.profileChangeRequest.employmentId,c.actors.self.employmentId)));
 const [publicationTargets]=await owner.db.select({n:count()}).from(s.kbDocument).where(and(eq(s.kbDocument.tenantId,c.tenantId),eq(s.kbDocument.title,workforce.knowledge.human.title)));
 const [closeTarget]=await owner.db.select({status:s.payrollBatch.status}).from(s.payrollBatch).where(and(eq(s.payrollBatch.tenantId,c.tenantId),eq(s.payrollBatch.id,financial.closeBatchId)));
 if(selfRequests.n!==0||profileRequests.n!==0||publicationTargets.n!==0||closeTarget?.status!=='processed'||financialReady.state!=='prepared_not_closed'||platform.notifications.verifiedIdentity!=='unavailable_requires_real_provider_session')throw Error('Selected browser target effects were not retained for explicit human review.');
 const [baselineLeaveRequests]=await owner.db.select({n:count()}).from(s.leaveRequest).where(eq(s.leaveRequest.tenantId,c.tenantId));
 const [baselineSubmittedEvents]=await owner.db.select({n:count()}).from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,c.tenantId),eq(s.domainEvent.eventType,'leave-request.submitted')));
 const manifest={format:1 as const,state:'native_prerequisites_prepared_not_experienced' as const,tenantId:c.tenantId,companyId:c.companyId,departmentId:c.departmentId,today:c.today,period:c.period,
  actors:{operator:actorReference(c.actors.operator),self:actorReference(c.actors.self),reviewers:c.actors.reviewers.map(actorReference),peer:actorReference(c.actors.peer),manager:actorReference(c.actors.manager)},
  workforce,scopeDenials,financial,financialReady,
  // Explicit projections prevent the prehire/tester SessionContext from escaping the helper.
  platform:{attendance:platform.attendance,lifecycle:platform.lifecycle,
   prehire:{userId:platform.prehire.userId,personId:platform.prehire.personId,employmentId:null,caseId:platform.prehire.caseId,number:platform.prehire.number},
   testing:{standalone:{userId:platform.testing.standalone.userId,personId:null,employmentId:null},assignments:platform.testing.assignments,humanObservationRecorded:platform.testing.humanObservationRecorded},
   explorer:platform.explorer,governance:platform.governance,notifications:platform.notifications,financialFollowup:platform.financialFollowup},
  finalNativePrerequisites:finalPrerequisites,
  expectedNative:{baselineLeaveRequests:baselineLeaveRequests.n,baselineSubmittedEvents:baselineSubmittedEvents.n,selfLeaveRequests:selfRequests.n,selfProfileRequests:profileRequests.n,publicationTargets:publicationTargets.n,closeTargetStatus:closeTarget.status},
  limits:{uiTargetEffects:'not_executed' as const,browserExperience:'UNVERIFIED' as const,productionAuthentication:'UNVERIFIED' as const,providerCapability:'UNVERIFIED_NO_CALLS' as const,notificationEmailConsent:'UNAVAILABLE_REQUIRES_ACTUAL_VERIFIED_PROVIDER_IDENTITY' as const,governedEvaluationsAndPromotions:'not_created' as const,releaseGate:'NOT_RUN' as const},
 };
 // Verify JSON serialization and fail on accidentally added owner/session/credential properties.
 // This is a final containment assertion, not a generic serializer that silently removes evidence.
 JSON.stringify(manifest,(key,value)=>{
  if(/^(ctx|bootstrapCtx|owner|db|client|session|activationUrl|apiKey|password|secret|credentials|accessToken|refreshToken)$/i.test(key)||typeof value==='function'||typeof value==='bigint')throw Error('Private fixture manifest contains a nonserializable or forbidden capability field.');return value;
 });
 return manifest;
}
