/** Authored UNRUN: native synthetic fixture/source witnesses, NOT browser or real-authentication proof.
 * Uses the maintained installed journal only. No inline SQL installer, provider or business-row bypass. */
import {and,eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {client,withTenant,type Grant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {resolveEntitlementsTx} from '../core/entitlements';
import {assertAiPrincipalTx} from '../core/ai-principal';
import {readOwnLeaveActorTx} from '../core/assistant-actions/own-leave-actor';
import {readOwnLeaveSubmissionReferenceTx} from '../core/read';
import {readOwnLeaveCandidateTx} from '../core/assistant-actions/own-leave-candidate';
import {revokeAssistant} from '../core/assistant-grant';
import {createAiDeliveryFixtureContext} from '../scripts/fixtures/ai-delivery-fixture-factory';
import {populateAiDeliveryWorkforce} from '../scripts/fixtures/ai-delivery-workforce';
import {populateAiDeliveryScopeDenials} from '../scripts/fixtures/ai-delivery-scope-denial-fixture';
import {closeAll,migrateTestDb,owner,resetDb} from './harness';
let primary:Awaited<ReturnType<typeof createAiDeliveryFixtureContext>>,fixture:Awaited<ReturnType<typeof populateAiDeliveryScopeDenials>>;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-scope-fixture-master-key-123456');await resetDb();
 primary=await createAiDeliveryFixtureContext(owner);const workforce=await populateAiDeliveryWorkforce(primary);
 fixture=await populateAiDeliveryScopeDenials(primary,{annualTypeId:workforce.leave.annualTypeId,selfLeave:workforce.leave.self});
});
async function actualContext(userId:string){
 const [row]=await client<{tenant_id:string;person_id:string|null;grants:Grant[]}[]>`select tenant_id,person_id,grants from app.principal(${userId}::uuid)`;
 if(!row)throw Error('Actual fixture principal missing');const grants=row.grants.map(g=>({...g}));
 const ctx:SessionContext={tenantId:row.tenant_id,userId,personId:row.person_id,grants,roles:[...new Set(grants.map(g=>g.role))],entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,row.tenant_id))};
 await withTenant(ctx,tx=>assertAiPrincipalTx(tx,ctx));return ctx;
}
describe('native scope-denial browser prerequisites',()=>{
 it('creates real distinct people/companies/tenants and original-actor pending requests while leaving the primary target unchanged',async()=>{
  expect(fixture.state).toBe('scope_denial_prerequisites_not_experienced');
  expect(fixture.sameTenantOtherCompany.tenantId).toBe(primary.tenantId);expect(fixture.sameTenantOtherCompany.companyId).not.toBe(primary.companyId);
  expect(fixture.foreignTenant.tenantId).not.toBe(primary.tenantId);
  expect(fixture.revocable.companyId).toBe(fixture.sameTenantOtherCompany.companyId);expect(fixture.revocable.companyId).not.toBe(primary.companyId);
  const primaryIds=await owner.db.select({id:s.employment.id}).from(s.employment).where(and(eq(s.employment.tenantId,primary.tenantId),eq(s.employment.companyId,primary.companyId)));
  expect(primaryIds.map(row=>row.id).sort()).toEqual([primary.actors.operator,primary.actors.self,...primary.actors.reviewers,primary.actors.peer,primary.actors.manager].map(actor=>actor.employmentId).sort());
  const [revocableEmployment]=await owner.db.select({companyId:s.employment.companyId,personId:s.employment.personId}).from(s.employment).where(eq(s.employment.id,fixture.revocable.actor.employmentId));expect(revocableEmployment).toEqual({companyId:fixture.revocable.companyId,personId:fixture.revocable.actor.personId});
  const people=[primary.actors.self.personId,fixture.sameTenantOtherCompany.actor.personId,fixture.foreignTenant.actor.personId,fixture.revocable.actor.personId];expect(new Set(people).size).toBe(4);
  for(const scope of [fixture.sameTenantOtherCompany,fixture.foreignTenant]){
   const [employee]=await owner.db.select({personId:s.employment.personId,companyId:s.employment.companyId,tenantId:s.employment.tenantId}).from(s.employment).where(eq(s.employment.id,scope.actor.employmentId));
   expect(employee).toEqual({personId:scope.actor.personId,companyId:scope.companyId,tenantId:scope.tenantId});
   const ctx=await actualContext(scope.actor.userId),native=await withTenant(ctx,async tx=>{const actor=await readOwnLeaveActorTx(tx,ctx);if(!actor)throw Error('Actual legitimate actor unavailable');return readOwnLeaveSubmissionReferenceTx(tx,actor,scope.request.requestId,scope.request.submittedEventId);});
   expect(native).toMatchObject({request:{id:scope.request.requestId,employmentId:scope.actor.employmentId,personId:scope.actor.personId},event:{id:scope.request.submittedEventId,actorId:scope.actor.userId,eventType:'leave-request.submitted'}});
   expect(await withTenant(ctx,tx=>tx.select({status:s.leaveRequest.status}).from(s.leaveRequest).where(eq(s.leaveRequest.id,scope.request.requestId)))).toEqual([{status:'pending'}]);
  }
  expect(fixture.primaryBaseline.before.self).toEqual({requests:0,submittedEvents:0});expect(fixture.primaryBaseline.after.self).toEqual(fixture.primaryBaseline.before.self);
  expect(fixture.primaryBaseline.after.tenant).toEqual({requests:fixture.primaryBaseline.before.tenant.requests+1,submittedEvents:fixture.primaryBaseline.before.tenant.submittedEvents+1});
  const text=JSON.stringify(fixture);expect(text).not.toMatch(/"(?:ctx|bootstrapCtx|owner|grants|roles|password|activationUrl|accessToken|session)"\s*:/);expect(text).not.toMatch(/postgres(?:ql)?:\/\//i);
  expect(fixture.limits).toMatchObject({browserEffects:'not_executed',scopeDenial:'UNVERIFIED',revocation:'NOT_PERFORMED',productionAuthentication:'UNVERIFIED',provider:'NOT_CALLED'});
 });
 it('has valid positive native sources, refuses other-person/company/tenant references, and permits explicit later native Assistant revocation without effects',async()=>{
  for(const target of [fixture.sameTenantOtherCompany,fixture.foreignTenant])expect(await withTenant(primary.actors.self.ctx,tx=>readOwnLeaveSubmissionReferenceTx(tx,primary.actors.self.ctx,target.request.requestId,target.request.submittedEventId))).toBeNull();
  const r=fixture.revocable,ctx=await actualContext(r.actor.userId),human=r.human;
  const candidate=await withTenant(ctx,tx=>readOwnLeaveCandidateTx(tx,ctx,{action:'leave.apply',contractVersion:1,employmentId:r.actor.employmentId,leaveTypeId:human.leaveTypeId,date:human.date,durationType:'full_day'},{employmentId:r.actor.employmentId,leaveTypeId:human.leaveTypeId},human.humanText,'en'));expect(candidate.kind).toBe('candidate');
  expect(await withTenant(ctx,tx=>readOwnLeaveActorTx(tx,ctx))).not.toBeNull();
  const before=await owner.db.select().from(s.leaveRequest).where(eq(s.leaveRequest.tenantId,primary.tenantId));
  await revokeAssistant(primary.bootstrapCtx,{appUserId:r.actor.userId});
  expect(await withTenant(ctx,tx=>readOwnLeaveActorTx(tx,ctx))).toBeNull();
  expect(await owner.db.select().from(s.leaveRequest).where(eq(s.leaveRequest.tenantId,primary.tenantId))).toEqual(before);
  expect(await owner.db.select().from(s.leaveRequest).where(and(eq(s.leaveRequest.tenantId,primary.tenantId),eq(s.leaveRequest.employmentId,primary.actors.self.employmentId)))).toEqual([]);
 });
});
