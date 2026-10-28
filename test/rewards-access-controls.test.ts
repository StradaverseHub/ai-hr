import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {createRewardUnit,getRewardConfiguration,getRewardUnit,previewRewardAccessChange,saveRewardAccessChange,decideRewardAccessRequest,rewardAccessRequests,rewardAccessAdministration,setRewardMember} from '../packs/rewards/service';
import {migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,closeAll,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base,admin:SessionContext,checker:SessionContext,target:SessionContext,unitId:string,bu:string,employmentId:string;
const today=todayInKualaLumpur(),year=Number(today.slice(0,4));
beforeAll(migrateTestDb);afterAll(closeAll);
async function account(name:string,role:'hr_admin'|'employee'='employee'){
 const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:name,primaryEmail:randomUUID()+'@access.test'}).returning();
 const userId=await createAppUser(b.tenantId,person.id,role);
 return {...admin,userId,personId:person.id,roles:[role],grants:[{role,companyId:null}]} satisfies SessionContext;
}
const revision=async()=>(await getRewardConfiguration(admin,unitId)).unit.revision;
async function request(after:Record<string,unknown>|null,before:Record<string,unknown>|null=null,actor=admin){
 const p=await previewRewardAccessChange(actor,{unitId,revision:await revision(),before,after}),{digest,...input}=p;
 return saveRewardAccessChange(actor,input,digest);
}
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'rewards','active');admin=await entitledCtx(b);
 const [unit]=await owner.db.insert(s.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'ACCESS',name:'Fictional access unit'}).returning();bu=unit.id;
 unitId=await createRewardUnit(admin,{name:'Fictional access controls',year,companyId:b.companyId,businessUnitId:bu,snapshotDate:today});
 checker=await account('Independent checker','hr_admin');
 const hire=await hireEmployee(admin,{person:{fullName:'Fictional BU reviewer',primaryEmail:randomUUID()+'@access.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:`${year-1}-01-01`});employmentId=hire.employmentId;
 const [employee]=await owner.db.select().from(s.employment).where(eq(s.employment.id,employmentId));
 await owner.db.update(s.assignment).set({businessUnitId:bu}).where(eq(s.assignment.employmentId,employmentId));
 const userId=await createAppUser(b.tenantId,employee.personId,'employee');target={...admin,userId,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
});
describe('Rewards two-person access and live People eligibility',()=>{
 it('saves a pending request, refuses self/affected-user approval, and commits only the independent decision',async()=>{
  const initial=await revision(),pending=await request({userId:target.userId!,role:'bu'});
  expect(await revision()).toBe(initial);
  expect((await rewardAccessAdministration(admin,[b.companyId])).members.some(m=>m.userId===target.userId)).toBe(false);
  await expect(decideRewardAccessRequest(admin,pending.requestId,true)).rejects.toMatchObject({code:'checker'});
  await expect(decideRewardAccessRequest(target,pending.requestId,true)).rejects.toMatchObject({code:'scope'});
  expect(await decideRewardAccessRequest(checker,pending.requestId,true)).toEqual({status:'approved'});
  expect(await revision()).toBe(initial+1);expect((await getRewardUnit(target,unitId)).roles).toContain('bu');
  const events=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,pending.requestId),eq(s.domainEvent.eventType,'reward-access.approved')));
  expect(events).toHaveLength(1);expect(events[0].actorId).toBe(checker.userId);expect(events[0].payload).toMatchObject({requestedBy:admin.userId});
 });
 it('prevents an administrator from approving a request that changes their own access',async()=>{
  const pending=await request({userId:checker.userId!,role:'gr'});
  await expect(decideRewardAccessRequest(checker,pending.requestId,true)).rejects.toMatchObject({code:'checker'});
  const third=await account('Third independent checker','hr_admin');expect(await decideRewardAccessRequest(third,pending.requestId,true)).toEqual({status:'approved'});
 });
 it('records rejection with a reason and lapses requests after a real review revision change',async()=>{
  const one=await request({userId:target.userId!,role:'bu'});
  await expect(decideRewardAccessRequest(checker,one.requestId,false,'short')).rejects.toMatchObject({code:'reason'});
  expect(await decideRewardAccessRequest(checker,one.requestId,false,'Not the nominated reviewer')).toEqual({status:'rejected'});
  const two=await request({userId:target.userId!,role:'bu'});
  await owner.db.update(s.rewardUnit).set({revision:(await revision())+1}).where(eq(s.rewardUnit.id,unitId));
  expect((await rewardAccessRequests(admin)).find(q=>q.id===two.requestId)?.status).toBe('lapsed');
  await expect(decideRewardAccessRequest(checker,two.requestId,true)).rejects.toMatchObject({code:'changed'});
 });
 it('keeps legacy setters pending and denies direct application-role membership writes',async()=>{
  const pending=await setRewardMember(admin,unitId,await revision(),target.userId!,'bu');expect(pending.pending).toBe(true);
  await expect(withTenant(admin,tx=>tx.insert(s.rewardMember).values({tenantId:b.tenantId,unitId,userId:target.userId!,role:'bu'}))).rejects.toThrow();
  expect((await rewardAccessAdministration(admin,[b.companyId])).members.some(m=>m.userId===target.userId)).toBe(false);
 });
 it('uses inclusive access windows and removes coverage as soon as People records notice',async()=>{
  const pending=await request({userId:target.userId!,role:'bu',validFrom:today,validTo:today});await decideRewardAccessRequest(checker,pending.requestId,true);
  expect((await getRewardUnit(target,unitId)).roles).toContain('bu');
  await owner.db.update(s.employment).set({tenderResignationDate:today}).where(eq(s.employment.id,employmentId));
  await expect(getRewardUnit(target,unitId)).rejects.toThrow(/assign your Reward Desk role/);
  const value=await rewardAccessAdministration(admin,[b.companyId]);expect(value.members.find(m=>m.userId===target.userId)?.suspension).toEqual({reason:'notice',on:today});
  expect(value.reviews[0].coverage.missing).toContain('bu');
  await expect(getRewardUnit(target,unitId)).rejects.toThrow();
  const observed=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,unitId),eq(s.domainEvent.eventType,'reward-access.suspended')));expect(observed).toHaveLength(1);
 });
 it('suspends a transferred BU seat while preserving group authority, and an approved restore expires on the next People change',async()=>{
  let pending=await request({userId:target.userId!,role:'bu'});await decideRewardAccessRequest(checker,pending.requestId,true);
  pending=await request({userId:target.userId!,role:'bg'});await decideRewardAccessRequest(checker,pending.requestId,true);
  const [other]=await owner.db.insert(s.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'OTHER',name:'Fictional other unit'}).returning();
  await owner.db.update(s.assignment).set({businessUnitId:other.id}).where(eq(s.assignment.employmentId,employmentId));
  expect((await getRewardUnit(target,unitId)).roles).toEqual(['bg']);
  pending=await request({userId:target.userId!,role:'bu',restoreReason:'Approved temporary continuity exception'},{userId:target.userId!,role:'bu'});
  expect((await getRewardUnit(target,unitId)).roles).toEqual(['bg']);
  await decideRewardAccessRequest(checker,pending.requestId,true);expect((await getRewardUnit(target,unitId)).roles.sort()).toEqual(['bg','bu']);
  await owner.db.update(s.employment).set({tenderResignationDate:today}).where(eq(s.employment.id,employmentId));
  await expect(getRewardUnit(target,unitId)).rejects.toThrow();
 });
 it('lapses approval when the affected People source changes while the request waits',async()=>{
  const pending=await request({userId:target.userId!,role:'bu'});
  await owner.db.update(s.employment).set({tenderResignationDate:today}).where(eq(s.employment.id,employmentId));
  expect(await decideRewardAccessRequest(checker,pending.requestId,true)).toEqual({status:'lapsed'});
  expect((await rewardAccessAdministration(admin,[b.companyId])).members.some(m=>m.userId===target.userId)).toBe(false);
 });
 it('enforces tenant scope on the request reader and decision owner',async()=>{
  const pending=await request({userId:target.userId!,role:'bu'}),foreign=await seedBase();await setModule(foreign.tenantId,'rewards','active');const outsider=await entitledCtx(foreign);
  expect(await rewardAccessRequests(outsider)).toEqual([]);await expect(decideRewardAccessRequest(outsider,pending.requestId,true)).rejects.toMatchObject({code:'scope'});
  expect((await rewardAccessRequests(admin)).find(q=>q.id===pending.requestId)?.status).toBe('pending');
 });
});
