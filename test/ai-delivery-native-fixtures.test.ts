/** Full composition contract. Normal disposable native harness only; no inline migration/SQL installers,
 * provider transport, modelWork mocks, manufactured business rows or UI acceptance claims. */
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as s from '../db/schema';
import {withAssistantRead} from '../core/assistant-read-session';
import {AGENT_MODULE_CODES} from '../lib/ai/module-agents';
import {executeSpecialistHoldout} from '../core/module-specialist-harness';
import {getRewardUnit} from '../packs/rewards/service';
import {createAiDeliveryFixtureContext,aiDeliveryFixturePhase as phase} from '../scripts/fixtures/ai-delivery-fixture-factory';
import {populateAiDeliveryWorkforce} from '../scripts/fixtures/ai-delivery-workforce';
import {populateAiDeliveryFinancial,finalizeAiDeliveryFinancial} from '../scripts/fixtures/ai-delivery-financial';
import {populateAiDeliveryPlatform} from '../scripts/fixtures/ai-delivery-platform';
import {aiDeliveryFixtureCalendar} from '../scripts/fixtures/ai-delivery-fixture-context';
import {migrateTestDb,resetDb,owner,closeAll} from './harness';
beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
describe('actual complete AI browser native prerequisite composition',()=>{
 it('populates actual all-module prerequisites yet leaves the selected human target effects pending',async()=>{
  // The same calendar used by the actual Financial/Platform entry points must keep their facts
  // disjoint across a new month, a new year and February, without changing the real clock.
  for(const [today,correctionDate,workedDate,releasedPeriod] of [
   ['2026-11-01','2026-10-30','2026-10-25','2026-09'],
   ['2027-01-01','2026-12-30','2026-12-27','2026-11'],
   ['2026-03-01','2026-02-27','2026-02-22','2026-01'],
   ['2028-03-01','2028-02-28','2028-02-27','2028-01'],
   ['2026-11-09','2026-11-07','2026-11-08','2026-10'],
  ])expect(aiDeliveryFixtureCalendar(today)).toEqual({correctionDate,workedDate,releasedPeriod});
  const c=await phase('factory normal provision and actors',()=>createAiDeliveryFixtureContext(owner));
  const workforce=await phase('canonical Workforce prerequisites',()=>populateAiDeliveryWorkforce(c));
  const financial=await phase('canonical Financial prerequisites',()=>populateAiDeliveryFinancial(c));
  const platform=await phase('canonical Platform prerequisites and initial nonempty holdouts',()=>populateAiDeliveryPlatform(c));
  const [released]=await owner.db.select({status:s.payrollBatch.status,period:s.payrollBatch.payPeriod}).from(s.payrollBatch).where(and(eq(s.payrollBatch.tenantId,c.tenantId),eq(s.payrollBatch.id,financial.releasedBatchId)));
  expect(released).toEqual({status:'closed',period:aiDeliveryFixtureCalendar(c.today).releasedPeriod});
  for(const item of Object.values(platform.attendance.subjects))for(const date of [item.date,item.workedDate]){expect(date<c.today).toBe(true);expect(released.period<date.slice(0,7)).toBe(true);}
  const closable=await phase('canonical Financial refresh after platform inputs',()=>finalizeAiDeliveryFinancial(c,financial));expect(closable.state).toBe('prepared_not_closed');
  // Fresh final native reads after the last changed inputs, never a hand-built moduleWork result.
  for(const actor of [c.actors.operator,...c.actors.reviewers])for(const module of AGENT_MODULE_CODES){
   const report=await phase('final native specialist '+actor.userId+':'+module,()=>withAssistantRead(actor.ctx,module,read=>executeSpecialistHoldout({kind:'canonical_specialist_v1',module,playbook:'canonical_domain_v1'},read)));
   expect(report).toMatchObject({module,state:'complete',nativeEvidence:'present',qualityFailures:0,securityFailures:0});expect(report.cases.every(row=>row.passed)).toBe(true);expect(report.cases).toContainEqual({id:module+':nonempty-business-evidence',category:'native',passed:true});
  }
  expect(platform.governance.prerequisites).toHaveLength(3);for(const actor of platform.governance.prerequisites)expect(actor.modules.map(row=>row.module)).toEqual([...AGENT_MODULE_CODES]);
  expect(platform.governance.candidatesCreated).toBe(false);expect(platform.governance.promotionsCreated).toBe(false);expect(platform.notifications.verifiedIdentity).toBe('unavailable_requires_real_provider_session');expect(Object.keys(platform.notifications.inAppNotificationIds)).toHaveLength(6);
  // Explicit baseline requests belong to other actual users. The SELF browser application is unsubmitted.
  expect(await owner.db.select().from(s.leaveRequest).where(and(eq(s.leaveRequest.tenantId,c.tenantId),eq(s.leaveRequest.employmentId,c.actors.self.employmentId)))).toEqual([]);
  const baselineRequestIds=[workforce.approvals.requestId,...workforce.approvals.ownApprovalBaselines.map(row=>row.requestId)];for(const id of baselineRequestIds){const [request]=await owner.db.select({status:s.leaveRequest.status}).from(s.leaveRequest).where(eq(s.leaveRequest.id,id));expect(request.status).toBe('pending');}
  expect(await owner.db.select().from(s.profileChangeRequest).where(eq(s.profileChangeRequest.tenantId,c.tenantId))).toEqual([]);
  expect(await owner.db.select().from(s.kbDocument).where(and(eq(s.kbDocument.tenantId,c.tenantId),eq(s.kbDocument.title,workforce.knowledge.human.title)))).toEqual([]);
  expect(await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.tenantId,c.tenantId))).toEqual([]);expect(await owner.db.select().from(s.replacementLeaveRequest).where(eq(s.replacementLeaveRequest.tenantId,c.tenantId))).toEqual([]);
  const [closeTarget]=await owner.db.select({status:s.payrollBatch.status}).from(s.payrollBatch).where(eq(s.payrollBatch.id,financial.closeBatchId));expect(closeTarget.status).toBe('processed');expect((await getRewardUnit(c.bootstrapCtx,financial.rewardUnitId)).unit.status).toBe('approved');
  for(const item of financial.claims){const [draft]=await owner.db.select({status:s.claimRequest.status}).from(s.claimRequest).where(eq(s.claimRequest.id,item.draftId));expect(draft.status).toBe('draft');}
  for(const item of financial.performance){const [standard]=await owner.db.select({ack:s.performanceReview.acknowledgedAt}).from(s.performanceReview).where(eq(s.performanceReview.id,item.standardReviewId));const [modern]=await owner.db.select({ack:s.onehrPlan.acknowledgedAt}).from(s.onehrPlan).where(eq(s.onehrPlan.id,item.onehrPlanId));expect(standard.ack).toBeNull();expect(modern.ack).toBeNull();}
  for(const ownCase of Object.values(platform.lifecycle))expect(ownCase.acknowledgementSubmitted).toBe(false);expect(platform.testing.humanObservationRecorded).toBe(false);expect(workforce.uiTargetsExecuted).toBe(false);
 },480000);
});
