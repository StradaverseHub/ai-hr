/** Authored UNRUN. New public composition-entry/private-manifest coverage in the maintained native
 * disposable DB harness. No SQL installation, model/native mocks, browser/SMTP/provider call or
 * production authentication/release claim. Passing prerequisites alone are not experience acceptance. */
import {and,asc,count,eq,isNull} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {resolveEntitlementsTx} from '../core/entitlements';
import {withAssistantRead} from '../core/assistant-read-session';
import {AGENT_MODULE_CODES} from '../lib/ai/module-agents';
import {populateAiDeliveryFullFixture} from '../scripts/fixtures/ai-delivery-full-fixture';
import {aiDeliveryFixturePhase} from '../scripts/fixtures/ai-delivery-fixture-factory';
import {migrateTestDb,resetDb,owner,closeAll} from './harness';
beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
function rows(data:unknown):Record<string,unknown>[] {if(!data||typeof data!=='object'||!Array.isArray((data as {rows?:unknown}).rows))throw Error('Actual native current-caller row projection required.');return(data as {rows:Record<string,unknown>[]}).rows;}
function assertPrivateJsonBoundary(value:unknown,path='manifest'){
 if(value===null||typeof value!=='object')return;
 for(const[key,child]of Object.entries(value)){
  expect(['ctx','bootstrapctx','owner','db','client','session','credentials','password','apikey','activationurl','accesstoken','refreshtoken','secret'],path+'.'+key).not.toContain(key.toLowerCase());
  expect(typeof child,path+'.'+key).not.toBe('function');expect(typeof child,path+'.'+key).not.toBe('bigint');assertPrivateJsonBoundary(child,path+'.'+key);
 }
}
describe('full native browser-fixture entry and private manifest',()=>{
 it('serializes exact native identities/results without capabilities and retains explicit human targets for the later browser',async()=>{
  const sessionsBefore=await owner.db.select({hash:s.appIdentitySession.tokenHash}).from(s.appIdentitySession);
  const manifest=await aiDeliveryFixturePhase('public populateAiDeliveryFullFixture entry',()=>populateAiDeliveryFullFixture(owner));
  const serialized=JSON.stringify(manifest),json=JSON.parse(serialized) as typeof manifest;
  expect(json).toMatchObject({format:1,state:'native_prerequisites_prepared_not_experienced',tenantId:manifest.tenantId,companyId:manifest.companyId,departmentId:manifest.departmentId,limits:{uiTargetEffects:'not_executed',browserExperience:'UNVERIFIED',productionAuthentication:'UNVERIFIED',providerCapability:'UNVERIFIED_NO_CALLS',notificationEmailConsent:'UNAVAILABLE_REQUIRES_ACTUAL_VERIFIED_PROVIDER_IDENTITY',governedEvaluationsAndPromotions:'not_created',releaseGate:'NOT_RUN'}});
  assertPrivateJsonBoundary(json);expect(serialized).not.toMatch(/postgres(?:ql)?:\/\//i);
  const actors=[json.actors.operator,json.actors.self,...json.actors.reviewers,json.actors.peer,json.actors.manager];
  expect(new Set(actors.map(actor=>actor.userId)).size).toBe(6);
  for(const actor of actors){
   expect(Object.keys(actor).sort()).toEqual(['employmentId','personId','userId']);
   const [login]=await owner.db.select({personId:s.appUser.personId,tenantId:s.appUser.tenantId}).from(s.appUser).where(eq(s.appUser.id,actor.userId));expect(login).toEqual({personId:actor.personId,tenantId:json.tenantId});
   const [employment]=await owner.db.select({personId:s.employment.personId,tenantId:s.employment.tenantId,companyId:s.employment.companyId}).from(s.employment).where(eq(s.employment.id,actor.employmentId));expect(employment).toEqual({personId:actor.personId,tenantId:json.tenantId,companyId:json.companyId});
  }
  expect(Object.keys(json.platform.prehire).sort()).toEqual(['caseId','employmentId','number','personId','userId']);expect(json.platform.prehire.employmentId).toBeNull();expect(json.platform.testing.standalone).toEqual({userId:manifest.platform.testing.standalone.userId,personId:null,employmentId:null});
  const [prehireEmployment]=await owner.db.select({n:count()}).from(s.employment).where(eq(s.employment.personId,json.platform.prehire.personId));expect(prehireEmployment.n).toBe(0);
  const evaluators=[json.actors.operator,...json.actors.reviewers];expect(json.finalNativePrerequisites.map(row=>row.userId)).toEqual(evaluators.map(actor=>actor.userId));
  for(const actor of evaluators){
   const recorded=json.finalNativePrerequisites.find(row=>row.userId===actor.userId)!;expect(recorded.modules.map(row=>row.module)).toEqual([...AGENT_MODULE_CODES]);
   for(const report of recorded.modules){expect(report).toMatchObject({state:'complete',nativeEvidence:'present',qualityFailures:0,securityFailures:0});expect(report.cases.length).toBeGreaterThan(0);expect(report.cases.every(row=>row.passed)).toBe(true);expect(report.cases).toContainEqual({id:report.module+':nonempty-business-evidence',category:'native',passed:true});}
   // Independent own-source checks prevent a manifest from borrowing the self person's evidence.
   const grants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(and(eq(s.roleAssignment.tenantId,json.tenantId),eq(s.roleAssignment.appUserId,actor.userId))).orderBy(asc(s.roleAssignment.id));
   const ctx:SessionContext={tenantId:json.tenantId,userId:actor.userId,personId:actor.personId,grants,roles:[...new Set(grants.map(grant=>grant.role))],entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,json.tenantId))};
   const employees=await withAssistantRead(ctx,'employees',read=>read.moduleWork('employees'));expect(rows(employees.data)).toContainEqual(expect.objectContaining({employmentId:actor.employmentId}));expect(rows(employees.data).some(row=>row.employmentId===json.actors.self.employmentId)).toBe(false);
   const baseline=json.workforce.approvals.ownApprovalBaselines.find(row=>row.userId===actor.userId)!;expect(baseline.employmentId).toBe(actor.employmentId);
   const approvals=await withAssistantRead(ctx,'approvals',read=>read.moduleWork('approvals'));expect(rows(approvals.data)).toContainEqual(expect.objectContaining({id:baseline.requestId,status:'pending'}));for(const other of json.workforce.approvals.ownApprovalBaselines.filter(row=>row.userId!==actor.userId))expect(rows(approvals.data).some(row=>row.id===other.requestId)).toBe(false);
  }
  // Independent persisted native reads, not the manifest's own 'unexecuted' flags, prove these targets.
  const [selfLeave]=await owner.db.select({n:count()}).from(s.leaveRequest).where(and(eq(s.leaveRequest.tenantId,json.tenantId),eq(s.leaveRequest.employmentId,json.actors.self.employmentId)));
  const [selfProfile]=await owner.db.select({n:count()}).from(s.profileChangeRequest).where(and(eq(s.profileChangeRequest.tenantId,json.tenantId),eq(s.profileChangeRequest.employmentId,json.actors.self.employmentId)));
  const [article]=await owner.db.select({n:count()}).from(s.kbDocument).where(and(eq(s.kbDocument.tenantId,json.tenantId),eq(s.kbDocument.title,json.workforce.knowledge.human.title)));
  expect(selfLeave.n).toBe(0);expect(selfProfile.n).toBe(0);expect(article.n).toBe(0);
  const [baselineArticle]=await owner.db.select({id:s.kbDocument.id}).from(s.kbDocument).where(and(eq(s.kbDocument.tenantId,json.tenantId),eq(s.kbDocument.id,json.workforce.knowledge.baselineArticleId)));expect(baselineArticle.id).toBe(json.workforce.knowledge.baselineArticleId);
  const [line]=await owner.db.select({id:s.reportingLine.id,manager:s.reportingLine.managerEmploymentId}).from(s.reportingLine).where(and(eq(s.reportingLine.id,json.workforce.org.originalReportingLineId),eq(s.reportingLine.subordinateEmploymentId,json.actors.self.employmentId),isNull(s.reportingLine.validTo),isNull(s.reportingLine.supersededAt)));expect(line).toEqual({id:json.workforce.org.originalReportingLineId,manager:json.actors.manager.employmentId});
  const [peerRequest]=await owner.db.select({status:s.leaveRequest.status,employmentId:s.leaveRequest.employmentId}).from(s.leaveRequest).where(eq(s.leaveRequest.id,json.workforce.approvals.requestId));expect(peerRequest).toEqual({status:'pending',employmentId:json.actors.peer.employmentId});
  const [closeBatch]=await owner.db.select({status:s.payrollBatch.status}).from(s.payrollBatch).where(eq(s.payrollBatch.id,json.financial.closeBatchId));expect(closeBatch.status).toBe('processed');expect(json.financialReady).toMatchObject({closeBatchId:json.financial.closeBatchId,state:'prepared_not_closed'});
  const [reward]=await owner.db.select({status:s.rewardUnit.status}).from(s.rewardUnit).where(eq(s.rewardUnit.id,json.financial.rewardUnitId));expect(reward.status).toBe('approved');
  for(const subject of json.financial.claims){const actor=actors.find(row=>row.userId===subject.userId)!;const [draft]=await owner.db.select({status:s.claimRequest.status,employmentId:s.claimRequest.employmentId}).from(s.claimRequest).where(eq(s.claimRequest.id,subject.draftId));expect(draft).toEqual({status:'draft',employmentId:actor.employmentId});}
  for(const subject of json.financial.performance){const [old]=await owner.db.select({ack:s.performanceReview.acknowledgedAt,employmentId:s.performanceReview.employmentId}).from(s.performanceReview).where(eq(s.performanceReview.id,subject.standardReviewId)),[modern]=await owner.db.select({ack:s.onehrPlan.acknowledgedAt,employmentId:s.onehrPlan.employmentId}).from(s.onehrPlan).where(eq(s.onehrPlan.id,subject.onehrPlanId));expect(old.ack).toBeNull();expect(modern.ack).toBeNull();const actor=actors.find(row=>row.userId===subject.userId)!;expect(old.employmentId).toBe(actor.employmentId);expect(modern.employmentId).toBe(actor.employmentId);}
  for(const subject of Object.values(json.platform.lifecycle)){const [native]=await owner.db.select({submitted:s.lcCase.daaSubmittedAt}).from(s.lcCase).where(eq(s.lcCase.id,subject.caseId));expect(native.submitted).toBeNull();}
  for(const assignment of Object.values(json.platform.testing.assignments)){const [native]=await owner.db.select({run:s.testExecution.currentRunId}).from(s.testExecution).where(eq(s.testExecution.id,assignment.executionId));expect(native.run).toBeNull();}
  expect(await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.tenantId,json.tenantId))).toEqual([]);expect(await owner.db.select().from(s.replacementLeaveRequest).where(eq(s.replacementLeaveRequest.tenantId,json.tenantId))).toEqual([]);
  const [leaveCount]=await owner.db.select({n:count()}).from(s.leaveRequest).where(eq(s.leaveRequest.tenantId,json.tenantId)),[eventCount]=await owner.db.select({n:count()}).from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,json.tenantId),eq(s.domainEvent.eventType,'leave-request.submitted')));expect(json.expectedNative).toMatchObject({baselineLeaveRequests:leaveCount.n,baselineSubmittedEvents:eventCount.n,selfLeaveRequests:0,selfProfileRequests:0,publicationTargets:0,closeTargetStatus:'processed'});
  expect(await owner.db.select().from(s.aiProviderConfig).where(eq(s.aiProviderConfig.tenantId,json.tenantId))).toEqual([]);expect(await owner.db.select().from(s.appExternalIdentity)).toEqual([]);expect(await owner.db.select({hash:s.appIdentitySession.tokenHash}).from(s.appIdentitySession)).toEqual(sessionsBefore);
  for(const [userId,id]of Object.entries(json.platform.notifications.inAppNotificationIds)){const actor=actors.find(row=>row.userId===userId)!;const [native]=await owner.db.select({recipient:s.notification.recipientEmploymentId}).from(s.notification).where(eq(s.notification.id,id));expect(native.recipient).toBe(actor.employmentId);}
  expect(json.platform.notifications.verifiedIdentity).toBe('unavailable_requires_real_provider_session');expect(Object.keys(json.platform.notifications.inAppNotificationIds)).toHaveLength(6);expect(json.platform.governance.candidatesCreated).toBe(false);expect(json.platform.governance.promotionsCreated).toBe(false);
 },480000);
});
