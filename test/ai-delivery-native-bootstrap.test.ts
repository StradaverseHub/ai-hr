/** Native bootstrap contract. Passing case moved unchanged from the full composition suite so
 * failed-only development runs can retain its existing authentic witness. */
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {MODULE_CATALOG,missingModuleDependencies} from '../packs/catalog';
import {isModuleEnabled} from '../core/entitlements';
import {assertAiPrincipalTx} from '../core/ai-principal';
import {assertMayUseAssistant} from '../core/assistant-grant';
import {createAiDeliveryFixtureContext,aiDeliveryFixturePhase as phase} from '../scripts/fixtures/ai-delivery-fixture-factory';
import {migrateTestDb,resetDb,owner,closeAll} from './harness';
beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
const participants=(c:Awaited<ReturnType<typeof createAiDeliveryFixtureContext>>)=>[c.actors.operator,c.actors.self,...c.actors.reviewers,c.actors.peer,c.actors.manager];
describe('actual complete AI browser native prerequisite composition',()=>{
 it('provisions the exact noncore catalogue and six native employed current callers without fake principals',async()=>{
  const c=await phase('factory normal provision and actors',()=>createAiDeliveryFixtureContext(owner));
  expect(c.bootstrapCtx.grants).toEqual([{role:'hr_admin',companyId:null}]);
  const bootstrapGrants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(and(eq(s.roleAssignment.tenantId,c.tenantId),eq(s.roleAssignment.appUserId,c.bootstrapCtx.userId!))).orderBy(s.roleAssignment.id);
  expect(bootstrapGrants).toEqual([{role:'hr_admin',companyId:null}]);
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
});
