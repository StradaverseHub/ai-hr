import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {withTenant,type SessionContext} from '../db/client';
import {migrateTestDb,resetDb,seedBase,setModule,entitledCtx,owner,closeAll,type Base} from './harness';
import {createOffcycleReview,changeRewardCompanyExclusion,rewardCompanyExclusions,rewardPolicyHistory,rewardPolicyHiddenCount,saveRewardPolicyGroup,defaultPolicy,createRewardUnit,rewardSetupChoices} from '../packs/rewards/service';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base,admin:SessionContext,companyB:string,buA:string,buB:string;
const today=todayInKualaLumpur(),year=Number(today.slice(0,4));
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'rewards','active');admin=await entitledCtx(b);
 const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional company B'}).returning();companyB=company.id;
 const units=await owner.withTenant(admin,tx=>tx.insert(s.businessUnit).values([{tenantId:b.tenantId,companyId:b.companyId,code:'GOV-A',name:'Unit A',label:'Unit A'},{tenantId:b.tenantId,companyId:companyB,code:'GOV-B',name:'Unit B',label:'Unit B'}]).returning());
 buA=units.find(row=>row.code==='GOV-A')!.id;buB=units.find(row=>row.code==='GOV-B')!.id;
});
afterAll(closeAll);
const group=(targets=[{companyId:b.companyId,businessUnitId:buA}])=>saveRewardPolicyGroup(admin,{groupId:null,expectedRevision:0,name:`Fictional ${randomUUID()}`,policy:defaultPolicy(year),targets});
describe('shared Rewards company participation and history',()=>{
 it('records exclusion and ending reasons, denies new shared coverage/reviews, and leaves old reviews intact',async()=>{
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.reward_company_exclusion_change(${b.companyId}::uuid,${year},repeat(chr(12)||chr(160),12),NULL)`))).rejects.toBeDefined();
  const v=await group(),review=await createRewardUnit(admin,{name:'Fictional cycle',year,companyId:b.companyId,businessUnitId:buA,snapshotDate:today,sharedPolicyVersionId:v.versionId});
  const before=await owner.db.select().from(s.rewardUnit).where(eq(s.rewardUnit.id,review));
  const id=await changeRewardCompanyExclusion(admin,{companyId:b.companyId,year,reason:'No rewards cycle for this year',endId:null});
  const [exclusion]=await rewardCompanyExclusions(admin,year);expect(exclusion).toMatchObject({id,companyId:b.companyId,reason:'No rewards cycle for this year',endedAt:null});
  expect((await rewardSetupChoices(admin,[b.companyId],{sharedPolicy:true})).companies[0].excludedYears).toEqual([year]);
  await expect(saveRewardPolicyGroup(admin,{groupId:v.groupId,expectedRevision:1,name:v.name,policy:v.policy,targets:v.targets})).rejects.toMatchObject({code:'excluded'});
  await expect(createRewardUnit(admin,{name:'Refused cycle',year,companyId:b.companyId,businessUnitId:buA,snapshotDate:today,sharedPolicyVersionId:v.versionId})).rejects.toThrow('excluded');
  expect(await owner.db.select().from(s.rewardUnit).where(eq(s.rewardUnit.id,review))).toEqual(before);
  await changeRewardCompanyExclusion(admin,{companyId:b.companyId,year,reason:'Company is taking part again',endId:id});
  expect((await rewardCompanyExclusions(admin,year))[0]).toMatchObject({id,endReason:'Company is taking part again'});
  const events=await owner.db.select({type:s.domainEvent.eventType}).from(s.domainEvent).where(eq(s.domainEvent.aggregateId,id)).orderBy(s.domainEvent.createdAt,s.domainEvent.id);
  expect(events.map(row=>row.type).sort()).toEqual(['reward.company-excluded','reward.company-exclusion-ended']);
 });
 it('keeps scope, immutable versions, hidden counts and current-group authority separate',async()=>{
  const hired=await hireEmployee(admin,{person:{fullName:'Private creator in company B',primaryEmail:'private-creator@example.test'},companyId:companyB,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
  await owner.db.update(s.appUser).set({personId:hired.personId}).where(eq(s.appUser.id,admin.userId!));
  const v1=await group([{companyId:b.companyId,businessUnitId:buA},{companyId:companyB,businessUnitId:buB}]);
  await saveRewardPolicyGroup(admin,{groupId:v1.groupId,expectedRevision:1,name:v1.name,policy:v1.policy,targets:[{companyId:b.companyId,businessUnitId:buA}]});
  const [user]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:`gov_${randomUUID()}`}).returning();
  await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'hr_admin',companyId:b.companyId});
  const scoped={...admin,userId:user.id,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]} satisfies SessionContext;
  const history=await rewardPolicyHistory(scoped,v1.groupId);expect(history.map(row=>row.version.revision)).toEqual([2]);expect(history[0].current).toBe(true);expect(history[0].savedBy).toBeNull();
  await changeRewardCompanyExclusion(admin,{companyId:b.companyId,year,reason:'A company-year participation choice',endId:null});
  expect((await rewardCompanyExclusions(scoped,year))[0].createdBy).toBeNull();
  await group([{companyId:companyB,businessUnitId:buB}]);expect(await rewardPolicyHiddenCount(scoped)).toBe(1);
  await expect(changeRewardCompanyExclusion(scoped,{companyId:companyB,year,reason:'Unauthorized exclusion attempt',endId:null})).rejects.toBeDefined();
  expect((await rewardCompanyExclusions(scoped,year)).map(row=>row.companyId)).toEqual([b.companyId]);
  await expect(withTenant(scoped,tx=>tx.insert(s.domainEvent).values({tenantId:b.tenantId,aggregateType:'reward-company-exclusion',aggregateId:randomUUID(),eventType:'reward.company-excluded',actorType:'user',actorId:user.id,payload:{}}))).rejects.toBeDefined();
  await expect(withTenant(scoped,tx=>tx.execute(sql`update reward_company_exclusion set reason='Forbidden direct update'`))).rejects.toBeDefined();
 });
 it('waits for access/workforce custody before looking up an off-cycle parent',async()=>{
  let ready!:()=>void,release!:()=>void;
  const held=new Promise<void>(resolve=>{ready=resolve;}),finish=new Promise<void>(resolve=>{release=resolve;});
  const holder=owner.withTenant(admin,async tx=>{await tx.execute(sql`select app.access_workforce_write_lock()`);ready();await finish;});
  await held;
  const attempt=createOffcycleReview(admin,randomUUID(),{kind:'adhoc',entryIds:[randomUUID()],effectiveFrom:`${year+1}-02-01`,exceptionReason:''}).then(()=>({ok:true}),error=>({ok:false,error}));
  try{
   await expect.poll(async()=>{const [row]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and state='active' and wait_event_type='Lock' and query like '%select app.access_workforce_write_lock()%'`);return row.n;},{timeout:5000}).toBeGreaterThan(0);
  }finally{release();await holder;}
  expect((await attempt).ok).toBe(false);
 });
 it('orders versions newest first and derives archived and locked states from stored owners',async()=>{
  const v=await group();const review=await createRewardUnit(admin,{name:'Locked history cycle',year,companyId:b.companyId,businessUnitId:buA,snapshotDate:today,sharedPolicyVersionId:v.versionId});
  await owner.db.update(s.rewardUnit).set({status:'bg'}).where(eq(s.rewardUnit.id,review));
  expect((await rewardPolicyHistory(admin,v.groupId))[0]).toMatchObject({locked:true,usageCount:1});
  await saveRewardPolicyGroup(admin,{groupId:v.groupId,expectedRevision:1,name:v.name,policy:{...v.policy,standardPools:[600,100,100]},targets:[]});
  const history=await rewardPolicyHistory(admin,v.groupId);expect(history.map(row=>row.version.revision)).toEqual([2,1]);
  expect(history[0]).toMatchObject({current:true,locked:false,usageCount:0,version:{targets:[]}});expect(history[1].version.targets).toEqual(v.targets);
 });
});
