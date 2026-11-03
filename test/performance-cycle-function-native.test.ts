/** Real generic cycle writers, current and stored authority, and storage-owner publication. */
import {sql,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {publishActionCapabilityPackage} from '../deploy/access/publish-workforce-capabilities';
import * as s from '../db/schema';
import {createCycle,listCycles,openCycle} from '../core/performance';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();ctx=await entitledCtx(b);});
const cycleInput={name:'Fictional native cycle',periodStart:'2026-01-01',periodEnd:'2026-12-31'};
it('the actual generic cycle Add and Edit writers preserve native HR without inventing a Delete service',async()=>{
 const {cycleId}=await createCycle(ctx,{...cycleInput,companyId:b.companyId});
 expect((await listCycles(ctx)).map(row=>row.id)).toContain(cycleId);
 await openCycle(ctx,{cycleId});
 const [row]=await owner.db.select({status:s.reviewCycle.status}).from(s.reviewCycle).where(eq(s.reviewCycle.id,cycleId));expect(row.status).toBe('open');
 const [permissions]=await withTenant(ctx,tx=>tx.execute<{remove:boolean}>(sql`select app.performance_cycle_function_action(${b.companyId}::uuid,'delete') as remove`));expect(permissions.remove).toBe(false);
 await expect(withTenant(ctx,tx=>tx.delete(s.reviewCycle).where(eq(s.reviewCycle.id,cycleId)))).rejects.toThrow();
});
it('OneHR Partner cannot create a generic cycle or borrow its native authority to edit one',async()=>{
 const {cycleId}=await createCycle(ctx,{...cycleInput,companyId:b.companyId});
 const userId=await createAppUser(b.tenantId,null,'employee');
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:userId,role:'performance_partner',companyId:b.companyId});
 const partner={...ctx,userId,roles:['performance_partner'],grants:[{role:'performance_partner',companyId:b.companyId}]};
 await expect(createCycle(partner,{...cycleInput,companyId:b.companyId})).rejects.toThrow();
 const affected=await withTenant(partner,tx=>tx.update(s.reviewCycle).set({name:'Forbidden generic edit'}).where(eq(s.reviewCycle.id,cycleId)).returning({id:s.reviewCycle.id}));expect(affected).toEqual([]);
 const [row]=await owner.db.select({name:s.reviewCycle.name}).from(s.reviewCycle).where(eq(s.reviewCycle.id,cycleId));expect(row.name).toBe(cycleInput.name);
});
it('a current narrowed native carrier cannot widen an existing cycle through its independent eligibility company filter',async()=>{
 const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional other performance company'}).returning();
 const {cycleId}=await createCycle(ctx,{...cycleInput,companyId:b.companyId});
 const userId=await createAppUser(b.tenantId,null,'employee');
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:userId,role:'performance_comp_partner',companyId:null});
 const partner={...ctx,userId,roles:['performance_comp_partner'],grants:[{role:'performance_comp_partner',companyId:b.companyId}]};
 await expect(withTenant(partner,tx=>tx.update(s.reviewCycle).set({eligibilityRules:{companyIds:[other.id]}}).where(eq(s.reviewCycle.id,cycleId)))).rejects.toThrow();
 const [row]=await owner.db.select({rules:s.reviewCycle.eligibilityRules}).from(s.reviewCycle).where(eq(s.reviewCycle.id,cycleId));expect(row.rules).toBeNull();
});

it('publishes cycle administration and keeps View and Add available under Edit denial',async()=>{
 const cap='function.performance.cycles.edit';
 try{
  expect(await publishActionCapabilityPackage(owner.client,'performance_cycles')).toMatchObject({changed:true,capabilities:10});
  expect(await publishActionCapabilityPackage(owner.client,'performance_cycles')).toMatchObject({changed:false});
  const {cycleId}=await createCycle(ctx,{...cycleInput,companyId:b.companyId});
  await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect)
   values(${b.tenantId}::uuid,${ctx.userId!}::uuid,${cap},${b.companyId}::uuid,'deny')`;
  expect((await listCycles(ctx)).map(row=>row.id)).toContain(cycleId);
  await expect(openCycle(ctx,{cycleId})).rejects.toThrow();
  await expect(createCycle(ctx,{...cycleInput,name:'Fictional independent Add',companyId:b.companyId})).resolves.toMatchObject({cycleId:expect.any(String)});
 }finally{
  await owner.client`delete from access_user_override where tenant_id=${b.tenantId}::uuid and capability_id=${cap}`;
  await owner.client`update access_capability set supported=false,bindings='[]'::jsonb
   where id like any(array['performance_compensation.%','function.performance.cycles.%','function.performance.onehr.setup.%'])`;
 }
});
