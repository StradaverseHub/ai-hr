import {rewardEligibilitySummary} from '../packs/rewards/policy-eligibility';
import {completeSharedRewardPolicy,establishRewardMembership,migrateRewardMembershipFixture} from './rewards-shared-policy-fixture';
/** Real owners/RLS/rollback cases, prepared but not run until the complete resource handover. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {rewardPolicyTaken,defaultPolicy,createRewardUnit,listRewardUnits,saveRewardPolicy,listRewardPolicyGroups,rewardSharedPolicyChoices,saveRewardPolicyGroup,rewardPolicyGroupUsage,getRewardConfiguration} from '../packs/rewards/service';
import type {RewardPolicy} from '../packs/rewards/model';
import {todayInKualaLumpur} from '../lib/hr-date';
import {pgSqlState} from '../lib/db-error';
let b:Base,admin:SessionContext,companyB:string,buA:string,buB:string,globalBu:string,policy:RewardPolicy;
const today=todayInKualaLumpur(),year=Number(today.slice(0,4));
beforeAll(migrateRewardMembershipFixture);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'rewards','active');admin=await entitledCtx(b);policy=completeSharedRewardPolicy(year);
 const [c]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional reward company B'}).returning({id:schema.company.id});companyB=c.id;
 const units=await owner.withTenant({...admin,grants:[{role:'hr_admin',companyId:null}]},tx=>tx.insert(schema.businessUnit).values([
  {tenantId:b.tenantId,companyId:b.companyId,code:'B25-REWARD-A',label:'Fictional Unit A',name:'Different legacy A'},
  {tenantId:b.tenantId,companyId:companyB,code:'B25-REWARD-B',label:'Fictional Unit B',name:'Different legacy B'},
  {tenantId:b.tenantId,companyId:b.companyId,code:'B25-REWARD-GLOBAL',label:'Fictional global unit',name:'Different legacy global',isGlobal:true},
 ]).returning({id:schema.businessUnit.id,code:schema.businessUnit.code}));
 buA=units.find(u=>u.code==='B25-REWARD-A')!.id;buB=units.find(u=>u.code==='B25-REWARD-B')!.id;globalBu=units.find(u=>u.code==='B25-REWARD-GLOBAL')!.id;
 await establishRewardMembership(admin,{tenantId:b.tenantId,companyId:b.companyId,businessUnitId:buA,departmentId:b.deptA,year});
 await establishRewardMembership(admin,{tenantId:b.tenantId,companyId:companyB,businessUnitId:buB,year});
 await establishRewardMembership(admin,{tenantId:b.tenantId,companyId:b.companyId,businessUnitId:globalBu,departmentId:b.deptA,year});
});
afterAll(closeAll);
const targets=()=>[{companyId:b.companyId,businessUnitId:buA},{companyId:companyB,businessUnitId:buB}];
const createGroup=()=>saveRewardPolicyGroup(admin,{groupId:null,expectedRevision:0,name:'Fictional shared rewards',policy,targets:targets()});
const unit=(companyId:string,businessUnitId:string,versionId?:string)=>createRewardUnit(admin,{name:`Fictional review ${randomUUID()}`,year,companyId,businessUnitId,snapshotDate:today,sharedPolicyVersionId:versionId});
async function scopeActor(){
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:`fictional_shared_${randomUUID()}`}).returning({id:schema.appUser.id});
 const [role]=await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'hr_admin',companyId:b.companyId}).returning({id:schema.roleAssignment.id});
 return {grantId:role.id,ctx:{...admin,userId:user.id,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]} satisfies SessionContext};
}
async function sqlRefusal(run:()=>Promise<unknown>,expected:string){let error:unknown;try{await run();}catch(e){error=e;}expect(error).toBeDefined();expect(pgSqlState(error)).toBe(expected);}
describe('shared reward configuration versions',()=>{
 it('saves exact pairs and creates independent unit snapshots; later versions leave the existing unit byte-identical',async()=>{
  const v1=await createGroup();expect(v1.targets).toHaveLength(2);
  const a=await unit(b.companyId,buA,v1.versionId),c=await unit(companyB,buB,v1.versionId);expect(a).not.toBe(c);
  const before=await owner.db.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id,a));
  const v2=await saveRewardPolicyGroup(admin,{groupId:v1.groupId,expectedRevision:v1.revision,name:v1.name,policy:{...policy,standardPools:[600,100,100]},targets:targets()});
  expect(v2.versionId).not.toBe(v1.versionId);expect(v2.revision).toBe(2);
  expect(await owner.db.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id,a))).toEqual(before);
  const d=await unit(b.companyId,buA,v2.versionId),configuration=await getRewardConfiguration(admin,d);
  expect(configuration.unit.policy.standardPools).toEqual([600,100,100]);expect(configuration.unit.policyGroupVersionId).toBe(v2.versionId);
  expect(configuration.policyOrigin).toMatchObject({name:v2.name,revision:2,changed:false});
  expect((await rewardPolicyGroupUsage(admin,v1.groupId)).map(row=>row.unitId).sort()).toEqual([a,c,d].sort());
 });
 it('refuses a stale or omitted version for an assigned pair without leaving a cycle behind',async()=>{
  const v1=await createGroup();await saveRewardPolicyGroup(admin,{groupId:v1.groupId,expectedRevision:1,name:v1.name,policy,targets:targets()});
  const before=await owner.db.select({id:schema.rewardCycle.id}).from(schema.rewardCycle).orderBy(schema.rewardCycle.id);
  await expect(unit(b.companyId,buA,v1.versionId)).rejects.toMatchObject({code:'changed'});
  await expect(unit(b.companyId,buA)).rejects.toMatchObject({code:'changed'});
  expect(await owner.db.select({id:schema.rewardCycle.id}).from(schema.rewardCycle).orderBy(schema.rewardCycle.id)).toEqual(before);
 });
 it('does not multiply global units into unselected companies and refuses incompatible or overlapping pairs',async()=>{
  const v=await saveRewardPolicyGroup(admin,{groupId:null,expectedRevision:0,name:'Fictional global pair',policy,targets:[{companyId:b.companyId,businessUnitId:globalBu}]});
  expect(v.targets).toEqual([{companyId:b.companyId,businessUnitId:globalBu}]);
  expect(await rewardSharedPolicyChoices(admin,[companyB])).toEqual([]);
  await expect(saveRewardPolicyGroup(admin,{groupId:null,expectedRevision:0,name:'Fictional overlap',policy,targets:v.targets})).rejects.toMatchObject({code:'overlap',conflicts:[{companyId:b.companyId,businessUnitId:globalBu,groupId:v.groupId,name:v.name}]});
  await expect(saveRewardPolicyGroup(admin,{groupId:null,expectedRevision:0,name:'Fictional invalid pair',policy,targets:[{companyId:b.companyId,businessUnitId:buB}]})).rejects.toMatchObject({code:'scope'});
 });
 it('allows an authorised company to consume its own pair while hiding other companies and refusing partial edits of the group',async()=>{
  const v=await createGroup(),actor=await scopeActor();
  expect(await listRewardPolicyGroups(actor.ctx)).toEqual([]);
  const choices=await rewardSharedPolicyChoices(actor.ctx,[b.companyId,companyB]);expect(choices).toHaveLength(1);expect(choices[0]).toMatchObject({companyId:b.companyId,businessUnitId:buA});
  await expect(saveRewardPolicyGroup(actor.ctx,{groupId:v.groupId,expectedRevision:1,name:'Never saved',policy,targets:[{companyId:b.companyId,businessUnitId:buA}]})).rejects.toMatchObject({code:'scope'});
  const own=await createRewardUnit(actor.ctx,{name:'Fictional own review',year,companyId:b.companyId,businessUnitId:buA,snapshotDate:today,sharedPolicyVersionId:v.versionId});expect(own).toBeTruthy();
  await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.id,actor.grantId));
  expect(await rewardSharedPolicyChoices(actor.ctx,[b.companyId])).toEqual([]);
  await expect(saveRewardPolicyGroup(actor.ctx,{groupId:null,expectedRevision:0,name:'Revoked actor cannot save',policy,targets:[{companyId:b.companyId,businessUnitId:globalBu}]})).rejects.toMatchObject({code:'scope'});
 });
 it('reads current taken pairs by reward year and company authority, including partially administered groups',async()=>{
  const v=await createGroup(),actor=await scopeActor();
  expect(await rewardPolicyTaken(actor.ctx,[b.companyId,companyB],year)).toEqual([{companyId:b.companyId,businessUnitId:buA,groupId:v.groupId,name:v.name}]);
  expect(await rewardPolicyTaken(actor.ctx,[b.companyId,companyB],year+1)).toEqual([]);
  await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.id,actor.grantId));
  expect(await rewardPolicyTaken(actor.ctx,[b.companyId],year)).toEqual([]);
 });
 it('serializes racing overlapping creations and returns the winning configuration name to the loser',async()=>{
  const create=(name:string)=>saveRewardPolicyGroup(admin,{groupId:null,expectedRevision:0,name,policy,targets:[{companyId:b.companyId,businessUnitId:buA}]});
  const results=await Promise.allSettled([create('Race A'),create('Race B')]);
  const winner=results.find(row=>row.status==='fulfilled'),loser=results.find(row=>row.status==='rejected');
  expect(winner?.status).toBe('fulfilled');expect(loser?.status).toBe('rejected');
  if(winner?.status==='fulfilled'&&loser?.status==='rejected')expect(loser.reason).toMatchObject({code:'overlap',conflicts:[{companyId:b.companyId,businessUnitId:buA,name:winner.value.name,groupId:winner.value.groupId}]});
  expect(await listRewardPolicyGroups(admin)).toHaveLength(1);
 });
 it('keeps versions/targets private and immutable and refuses rewriting unit lineage',async()=>{
  const v=await createGroup(),reviewId=await unit(b.companyId,buA,v.versionId);
  await sqlRefusal(()=>withTenant(admin,tx=>tx.execute(sql`select * from reward_policy_group_version`)),'42501');
  await sqlRefusal(()=>owner.db.update(schema.rewardPolicyGroupVersion).set({name:'Forbidden rewrite'}).where(eq(schema.rewardPolicyGroupVersion.id,v.versionId)),'23514');
  await sqlRefusal(()=>withTenant(admin,tx=>tx.update(schema.rewardUnit).set({policyGroupVersionId:null}).where(eq(schema.rewardUnit.id,reviewId))),'23514');
  await sqlRefusal(()=>withTenant(admin,tx=>tx.update(schema.rewardUnit).set({companyId:companyB,businessUnitId:buB}).where(eq(schema.rewardUnit.id,reviewId))),'23514');
  await sqlRefusal(()=>withTenant(admin,tx=>tx.update(schema.rewardUnit).set({policy:{...policy,year:year+1}}).where(eq(schema.rewardUnit.id,reviewId))),'23514');
 });
 it('archives future assignment without rewriting old snapshots and refuses a stale pre-archive review',async()=>{
  const v=await createGroup(),reviewId=await unit(b.companyId,buA,v.versionId);
  const before=await owner.db.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id,reviewId));
  const archived=await saveRewardPolicyGroup(admin,{groupId:v.groupId,expectedRevision:1,name:v.name,policy,targets:[]});
  expect(archived.targets).toEqual([]);expect(archived.revision).toBe(2);
  expect(await listRewardPolicyGroups(admin)).toContainEqual(archived);
  expect(await rewardSharedPolicyChoices(admin,[b.companyId,companyB])).toEqual([]);
  await expect(unit(b.companyId,buA,v.versionId)).rejects.toMatchObject({code:'changed'});
  expect(await owner.db.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id,reviewId))).toEqual(before);
  const actor=await scopeActor();expect(await listRewardPolicyGroups(actor.ctx)).toEqual([]);
  await expect(saveRewardPolicyGroup(actor.ctx,{groupId:v.groupId,expectedRevision:2,name:v.name,policy,targets:[]})).rejects.toMatchObject({code:'scope'});
  const restored=await saveRewardPolicyGroup(admin,{groupId:v.groupId,expectedRevision:2,name:v.name,policy,targets:targets()});
  expect(restored.revision).toBe(3);expect(restored.targets).toHaveLength(2);
 });
 it('refuses archived units and incompatible company currency without changing the current group',async()=>{
  const v=await createGroup();
  await owner.db.update(schema.businessUnit).set({archivedAt:new Date()}).where(eq(schema.businessUnit.id,buA));
  await expect(saveRewardPolicyGroup(admin,{groupId:v.groupId,expectedRevision:1,name:v.name,policy,targets:targets()})).rejects.toMatchObject({code:'scope'});
  await owner.db.update(schema.company).set({currency:'USD'}).where(eq(schema.company.id,companyB));
  await expect(saveRewardPolicyGroup(admin,{groupId:null,expectedRevision:0,name:'Incompatible currency',policy,targets:[{companyId:companyB,businessUnitId:globalBu}]})).rejects.toMatchObject({code:'scope'});
  expect((await listRewardPolicyGroups(admin)).find(g=>g.groupId===v.groupId)).toEqual(v);
  // Existing retained history can be detached even after its setup becomes unavailable.
  const archived=await saveRewardPolicyGroup(admin,{groupId:v.groupId,expectedRevision:1,name:v.name,policy,targets:[]});expect(archived.targets).toEqual([]);
 });
 it('does not reveal another real tenant or accept its company, unit or version references',async()=>{
  const v=await createGroup(),foreign=await seedBase();
  await setModule(foreign.tenantId,'rewards','active');const foreignCtx=await entitledCtx(foreign);
  const [foreignUnit]=await owner.db.insert(schema.businessUnit).values({tenantId:foreign.tenantId,companyId:foreign.companyId,code:'FOREIGN-BU',label:'Unrelated unit',name:'Unrelated legacy'}).returning({id:schema.businessUnit.id});
  await establishRewardMembership(foreignCtx,{tenantId:foreign.tenantId,companyId:foreign.companyId,businessUnitId:foreignUnit.id,departmentId:foreign.deptA,year});
  expect(await listRewardPolicyGroups(foreignCtx)).toEqual([]);
  expect(await rewardPolicyGroupUsage(foreignCtx,v.groupId)).toEqual([]);
  expect(await rewardSharedPolicyChoices(foreignCtx,[b.companyId])).toEqual([]);
  await expect(saveRewardPolicyGroup(admin,{groupId:null,expectedRevision:0,name:'Foreign company refused',policy,targets:[{companyId:foreign.companyId,businessUnitId:foreignUnit.id}]})).rejects.toMatchObject({code:'scope'});
  await expect(saveRewardPolicyGroup(admin,{groupId:null,expectedRevision:0,name:'Foreign unit refused',policy,targets:[{companyId:b.companyId,businessUnitId:foreignUnit.id}]})).rejects.toMatchObject({code:'scope'});
  await expect(createRewardUnit(foreignCtx,{name:'Foreign version refused',year,companyId:foreign.companyId,businessUnitId:foreignUnit.id,snapshotDate:today,sharedPolicyVersionId:v.versionId})).rejects.toMatchObject({code:'changed'});
 });
 it('refuses a raw runtime append pretending to be a canonical shared policy audit event',async()=>{
  const v=await createGroup();
  await sqlRefusal(()=>withTenant(admin,tx=>tx.insert(schema.domainEvent).values({tenantId:b.tenantId,aggregateType:'reward-policy-group',aggregateId:v.groupId,eventType:'reward-policy-group.version-saved',actorType:'user',actorId:admin.userId!,payload:{revision:999}})),'42501');
  expect((await listRewardPolicyGroups(admin)).find(g=>g.groupId===v.groupId)?.revision).toBe(1);
 });
 it('serialises two saves from one revision so only one new immutable version is committed',async()=>{
  const v=await createGroup(),edit={groupId:v.groupId,expectedRevision:1,name:v.name,policy,targets:targets()};
  const results=await Promise.allSettled([saveRewardPolicyGroup(admin,{...edit,name:'Fictional concurrent A'}),saveRewardPolicyGroup(admin,{...edit,name:'Fictional concurrent B'})]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);const failed=results.find(r=>r.status==='rejected');expect(failed?.status==='rejected'?failed.reason.code:null).toBe('changed');
  expect(await owner.db.select({id:schema.rewardPolicyGroupVersion.id}).from(schema.rewardPolicyGroupVersion).where(eq(schema.rewardPolicyGroupVersion.groupId,v.groupId))).toHaveLength(2);
 });
 it('rolls back group/version/membership changes if the actual audit append fails',async()=>{
  const v=await createGroup();await owner.db.execute(sql.raw("CREATE FUNCTION app.test_reward_shared_audit_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='reward-policy-group.version-saved' THEN RAISE EXCEPTION 'fictional shared audit refusal' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$"));
  await owner.db.execute(sql.raw('CREATE TRIGGER test_reward_shared_audit_refusal BEFORE INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION app.test_reward_shared_audit_refusal()'));
  try{await sqlRefusal(()=>saveRewardPolicyGroup(admin,{groupId:v.groupId,expectedRevision:1,name:'Not committed',policy,targets:targets()}),'P0001');}
  finally{await owner.db.execute(sql.raw('DROP TRIGGER test_reward_shared_audit_refusal ON domain_event'));await owner.db.execute(sql.raw('DROP FUNCTION app.test_reward_shared_audit_refusal()'));}
  expect((await listRewardPolicyGroups(admin)).find(g=>g.groupId===v.groupId)).toEqual(v);
  const events=await owner.db.select({id:schema.domainEvent.id}).from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,v.groupId),eq(schema.domainEvent.eventType,'reward-policy-group.version-saved')));expect(events).toHaveLength(1);
 });
 it('56595838: offers the version contents read-only and shows the origin and a later review edit in the list',async()=>{
  const v=await createGroup();
  const [choice]=await rewardSharedPolicyChoices(admin,[b.companyId]);
  expect(choice).toMatchObject({versionId:v.versionId,policy:{effectiveFrom:policy.effectiveFrom,standardPools:policy.standardPools,hPools:policy.hPools,eligibility:rewardEligibilitySummary(policy)}});
  // Summary only: no salary ranges or profit figures reach the create form.
  expect(Object.keys(choice.policy!).sort()).toEqual(['bonusMatrix','effectiveFrom','eligibility','hPools','meritMatrix','standardPools']);
  const id=await unit(b.companyId,buA,v.versionId);
  const origin=async()=>(await listRewardUnits(admin,[b.companyId])).find(r=>r.id===id)!.policyOrigin;
  expect(await origin()).toMatchObject({versionId:v.versionId,revision:1,name:v.name,changed:false});
  const c=await getRewardConfiguration(admin,id);
  await saveRewardPolicy(admin,id,c.unit.revision,{...c.unit.policy,standardPools:[700,100,100]});
  expect(await origin()).toMatchObject({revision:1,changed:true});
 });
});
