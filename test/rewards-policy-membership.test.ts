/** Actual effective People assignments, never catalogue ownership/availability, decide future Rewards pairs. */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {defaultPolicy,rewardPolicyMemberships,saveRewardPolicyGroup} from '../packs/rewards/service';
import {REWARD_POLICY_GRADES} from '../packs/rewards/policy-grid-validation';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';
const today=todayInKualaLumpur(),year=Number(today.slice(0,4));
let base:Base,admin:SessionContext,otherCompany:string,globalUnit:string,localUnit:string;
beforeAll(async()=>{
 await migrateTestDb();
 const [state]=await owner.db.execute<{present:boolean}>(sql`select to_regprocedure('app.reward_policy_memberships(uuid[])') is not null as present`);
 if(!state.present){
  const draft=readFileSync(new URL('../docs/migration-drafts/0690_rewards_policy_pair_membership.sql',import.meta.url),'utf8');
  await owner.db.transaction(async tx=>{for(const statement of draft.split('--> statement-breakpoint').filter(statement=>statement.trim()))await tx.execute(sql.raw(statement));});
 }
});afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();base=await seedBase();await setModule(base.tenantId,'rewards','active');admin=await entitledCtx(base);
 const [company]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Unassigned fixture company'}).returning();otherCompany=company.id;
 const units=await owner.withTenant(admin,tx=>tx.insert(schema.businessUnit).values([{tenantId:base.tenantId,companyId:base.companyId,code:'MEMBERSHIP-GLOBAL',name:'Global catalogue only',isGlobal:true},{tenantId:base.tenantId,companyId:base.companyId,code:'MEMBERSHIP-LOCAL',name:'Local creation ownership only'}]).returning());
 globalUnit=units.find(unit=>unit.isGlobal)!.id;localUnit=units.find(unit=>!unit.isGlobal)!.id;
});
const employee=(unit:string)=>hireEmployee(admin,{person:{fullName:'Membership fixture',primaryEmail:`${randomUUID()}@membership.test`},companyId:base.companyId,departmentId:base.deptA,businessUnitId:unit,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
const policy=()=>({...defaultPolicy(year),ranges:Object.fromEntries(REWARD_POLICY_GRADES.filter(grade=>grade!=='23').map(grade=>[grade,[10000,20000,30000] as [number,number,number]])),bonusMatrix:Object.fromEntries(REWARD_POLICY_GRADES.map(grade=>[grade,[0,10000,20000,30000,40000] as [number,number,number,number,number]]))});
describe('approved Rewards company and BU membership',()=>{
 it('accepts an empty company scope without broadening membership',async()=>{
  await employee(globalUnit);
  expect(await rewardPolicyMemberships(admin,[])).toEqual([]);
 });
 it('does not pair a global or locally-created catalogue entry without an actual People assignment',async()=>{
  expect(await rewardPolicyMemberships(admin,[base.companyId,otherCompany])).toEqual([]);
  await expect(saveRewardPolicyGroup(admin,{groupId:null,expectedRevision:0,name:'Forged global pair',policy:policy(),targets:[{companyId:otherCompany,businessUnitId:globalUnit}]})).rejects.toMatchObject({code:'scope'});
  await expect(saveRewardPolicyGroup(admin,{groupId:null,expectedRevision:0,name:'Creation ownership is not membership',policy:policy(),targets:[{companyId:base.companyId,businessUnitId:localUnit}]})).rejects.toMatchObject({code:'scope'});
 });
 it('admits only the assigned company, rejects other companies and expires the relation on its effective end date',async()=>{
  const hired=await employee(globalUnit);
  expect(await rewardPolicyMemberships(admin,[base.companyId,otherCompany])).toEqual([{companyId:base.companyId,businessUnitId:globalUnit}]);
  const saved=await saveRewardPolicyGroup(admin,{groupId:null,expectedRevision:0,name:'Assigned global pair',policy:policy(),targets:[{companyId:base.companyId,businessUnitId:globalUnit}]});
  expect(saved.targets).toEqual([{companyId:base.companyId,businessUnitId:globalUnit}]);
  await expect(saveRewardPolicyGroup(admin,{groupId:saved.groupId,expectedRevision:1,name:saved.name,policy:policy(),targets:[{companyId:otherCompany,businessUnitId:globalUnit}]})).rejects.toMatchObject({code:'scope'});
  await owner.db.update(schema.assignment).set({validTo:today}).where(and(eq(schema.assignment.employmentId,hired.employmentId),sql`${schema.assignment.supersededAt} is null`));
  expect(await rewardPolicyMemberships(admin,[base.companyId])).toEqual([]);
  const retained=await owner.db.select().from(schema.rewardPolicyGroupTarget).where(eq(schema.rewardPolicyGroupTarget.versionId,saved.versionId));expect(retained).toHaveLength(1);
 });
 it('does not leak foreign tenant membership and uses the KL business day even under another session timezone',async()=>{
  const hired=await employee(globalUnit),tomorrow=new Date(Date.parse(`${today}T00:00:00Z`)+86400000).toISOString().slice(0,10);
  await owner.db.update(schema.assignment).set({validFrom:today,validTo:tomorrow}).where(and(eq(schema.assignment.employmentId,hired.employmentId),sql`${schema.assignment.supersededAt} is null`));
  const foreign=await seedBase();await setModule(foreign.tenantId,'rewards','active');const outsider=await entitledCtx(foreign);
  expect(await rewardPolicyMemberships(outsider,[base.companyId])).toEqual([]);
  for(const zone of ['Pacific/Kiritimati','Etc/GMT+12']){
   const rows=await withTenant(admin,async tx=>{await tx.execute(sql`select set_config('TimeZone',${zone},true)`);return tx.execute<{company_id:string;business_unit_id:string}>(sql`select * from app.reward_policy_memberships(ARRAY[${base.companyId}::uuid]::uuid[])`);});
   expect(rows.map(row=>({companyId:row.company_id,businessUnitId:row.business_unit_id}))).toEqual([{companyId:base.companyId,businessUnitId:globalUnit}]);
  }
 });
 it('does not treat an ended lifecycle as a current membership merely because an old assignment remains open',async()=>{
  const hired=await employee(globalUnit);
  expect(await rewardPolicyMemberships(admin,[base.companyId])).toHaveLength(1);
  await owner.db.update(schema.employment).set({resignationDate:today}).where(eq(schema.employment.id,hired.employmentId));
  expect(await rewardPolicyMemberships(admin,[base.companyId])).toEqual([]);
 });

});
