/** Authored UNRUN. Normal disposable native harness only; no inline migration/SQL installers,
 * provider transport, modelWork mocks, manufactured business rows or UI acceptance claims. */
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {MODULE_CATALOG,missingModuleDependencies} from '../packs/catalog';
import {isModuleEnabled} from '../core/entitlements';
import {assertAiPrincipalTx} from '../core/ai-principal';
import {assertMayUseAssistant} from '../core/assistant-grant';
import {withAssistantRead} from '../core/assistant-read-session';
import {AGENT_MODULE_CODES} from '../lib/ai/module-agents';
import {executeSpecialistHoldout} from '../core/module-specialist-harness';
import {getRewardUnit} from '../packs/rewards/service';
import {createAiDeliveryFixtureContext,aiDeliveryFixturePhase as phase} from '../scripts/fixtures/ai-delivery-fixture-factory';
import {populateAiDeliveryWorkforce} from '../scripts/fixtures/ai-delivery-workforce';
import {populateAiDeliveryFinancial,finalizeAiDeliveryFinancial} from '../scripts/fixtures/ai-delivery-financial';
import {populateAiDeliveryPlatform} from '../scripts/fixtures/ai-delivery-platform';
import {migrateTestDb,resetDb,owner,closeAll} from './harness';
beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
const participants=(c:Awaited<ReturnType<typeof createAiDeliveryFixtureContext>>)=>[c.actors.operator,c.actors.self,...c.actors.reviewers,c.actors.peer,c.actors.manager];
describe('actual complete AI browser native prerequisite composition',()=>{
 it('provisions the exact noncore catalogue and six native employed current callers without fake principals',async()=>{
  const c=await phase('factory normal provision and actors',()=>createAiDeliveryFixtureContext(owner));
  const expected=MODULE_CATALOG.filter(module=>!module.isCore).map(module=>module.code);expect(missingModuleDependencies(expected)).toEqual([]);
  const rows=await owner.db.select().from(s.tenantModule).where(eq(s.tenantModule.tenantId,c.tenantId));expect(rows.map(row=>row.moduleCode).sort()).toEqual([...expected].sort());expect(rows.every(row=>!MODULE_CATALOG.find(module=>module.code===row.moduleCode)?.isCore)).toBe(true);
  for(const module of MODULE_CATALOG)expect(isModuleEnabled(c.bootstrapCtx,module.code),module.code).toBe(true);
  const people=participants(c);expect(new Set(people.map(actor=>actor.userId)).size).toBe(6);expect(new Set(people.map(actor=>actor.personId)).size).toBe(6);expect(new Set(people.map(actor=>actor.employmentId)).size).toBe(6);
  for(const actor of people){
   const [actual]=await owner.db.select({personId:s.employment.personId,companyId:s.employment.companyId,hiredOn:s.employment.hiredOn}).from(s.employment).where(eq(s.employment.id,actor.employmentId));expect(actual).toEqual({personId:actor.personId,companyId:c.companyId,hiredOn:String(Number(c.today.slice(0,4))-1)+'-01-01'});
   const grants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(and(eq(s.roleAssignment.tenantId,c.tenantId),eq(s.roleAssignment.appUserId,actor.userId))).orderBy(s.roleAssignment.id);expect(actor.ctx.grants).toEqual(grants);expect(grants.some(row=>row.role==='super_admin')).toBe(false);
   await withTenant(actor.ctx,async tx=>{await assertAiPrincipalTx(tx,actor.ctx);await assertMayUseAssistant(actor.ctx,tx);});
  }
  for(const actor of [c.actors.operator,...c.actors.reviewers])expect(actor.ctx.grants).toEqual(expect.arrayContaining([{role:'hr_admin',companyId:null},{role:'payroll_partner',companyId:c.companyId}]));
  for(const actor of [c.actors.self,c.actors.peer])expect(actor.ctx.grants).toEqual([{role:'employee',companyId:null}]);
  expect(c.actors.manager.ctx.grants).toEqual(expect.arrayContaining([{role:'manager',companyId:null},{role:'hr_admin',companyId:c.companyId}]));
  expect(await owner.db.select().from(s.aiProviderConfig).where(eq(s.aiProviderConfig.tenantId,c.tenantId))).toEqual([]);expect(await owner.db.select().from(s.appExternalIdentity).where(eq(s.appExternalIdentity.appUserId,c.actors.self.userId))).toEqual([]);
 },180000);
 it('populates actual all-module prerequisites yet leaves the selected human target effects pending',async()=>{
  const c=await phase('factory normal provision and actors',()=>createAiDeliveryFixtureContext(owner));
  const workforce=await phase('canonical Workforce prerequisites',()=>populateAiDeliveryWorkforce(c));
  const financial=await phase('canonical Financial prerequisites',()=>populateAiDeliveryFinancial(c));
  const platform=await phase('canonical Platform prerequisites and initial nonempty holdouts',()=>populateAiDeliveryPlatform(c));
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
