import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,asc,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {dispatchNotifications} from '../core/notifications';
import {agentContext,ensureAgentPrincipal} from '../core/agent-principal';
import {resolveEntitlementsTx} from '../core/entitlements';
import {pgSqlState} from '../lib/db-error';
import {hireEmployee} from '../core/org';
import {createRewardUnit,getRewardConfiguration,getRewardUnit,previewRewardAccessChange,saveRewardAccessChange,decideRewardAccessRequest,rewardAccessRequests,rewardAccessAdministration,rewardAccessSuspensionRecipients,setRewardMember} from '../packs/rewards/service';
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
/** Use the canonical owner-created principal and real tenant entitlements, not a fictional user UUID. */
async function namedAgent(){
 const principalId=await ensureAgentPrincipal(owner.db,b.tenantId);
 const entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,b.tenantId));
 const ctx=agentContext(b.tenantId,principalId,entitlements);
 const [proof]=await withTenant(ctx,tx=>tx.execute<{principal:string|null;admin:boolean;reward_admin:boolean;roles:string[]}>(sql`select app.current_agent_principal() as principal,app.is_admin() as admin,app.reward_admin(${b.companyId}::uuid) as reward_admin,array(select app.reward_roles(${unitId}::uuid)) as roles`));
 expect(proof).toEqual({principal:principalId,admin:false,reward_admin:false,roles:[]});
 expect(await owner.db.select({id:s.appUser.id}).from(s.appUser).where(eq(s.appUser.id,principalId))).toEqual([]);
 return ctx;
}
/** Owner reads prove refusals leave the real pending request, membership and audit stream unchanged. */
async function securityState(){
 return {
  requests:await owner.db.select().from(s.rewardAccessRequest).where(eq(s.rewardAccessRequest.tenantId,b.tenantId)).orderBy(asc(s.rewardAccessRequest.id)),
  members:await owner.db.select().from(s.rewardMember).where(eq(s.rewardMember.unitId,unitId)).orderBy(asc(s.rewardMember.id)),
  events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(asc(s.domainEvent.sequence)),
  observations:await owner.db.select().from(s.rewardAccessObservation).where(eq(s.rewardAccessObservation.tenantId,b.tenantId)).orderBy(asc(s.rewardAccessObservation.memberId),asc(s.rewardAccessObservation.stateKey)),
  epochs:await owner.db.select().from(s.rewardAccessSourceEpoch).where(eq(s.rewardAccessSourceEpoch.tenantId,b.tenantId)).orderBy(asc(s.rewardAccessSourceEpoch.sourceKind),asc(s.rewardAccessSourceEpoch.sourceId)),
  notices:await owner.db.select().from(s.notification).where(eq(s.notification.tenantId,b.tenantId)).orderBy(asc(s.notification.id)),
  unit:await owner.db.select().from(s.rewardUnit).where(eq(s.rewardUnit.id,unitId)),
 };
}
async function nativeRefused(promise:Promise<unknown>,state:string){
 const error=await promise.then(()=>null,(error:unknown)=>error);
 expect(error,'native authority must refuse this operation').not.toBeNull();expect(pgSqlState(error)).toBe(state);
}
describe('Rewards two-person access and live People eligibility',()=>{
 it('refuses a real named agent as access requester, independent checker or Group Rewards holder without effects',async()=>{
  const pending=await request({userId:target.userId!,role:'bu'}),agent=await namedAgent();
  const before=await securityState();expect(before.requests).toHaveLength(1);expect(before.requests[0]).toMatchObject({id:pending.requestId,status:'pending'});expect(before.members).toHaveLength(1);expect(before.events.length).toBeGreaterThan(0);
  // Reuse the canonical human-created request's exact valid changes: failure must be actor authority.
  await nativeRefused(withTenant(agent,tx=>tx.execute(sql`select app.reward_access_request_create(${JSON.stringify(before.requests[0].changes)}::jsonb)`)),'23514');
  await nativeRefused(withTenant(agent,tx=>tx.execute(sql`select app.reward_access_request_decide(${pending.requestId}::uuid,true,'')`)),'42501');
  await expect(decideRewardAccessRequest(agent,pending.requestId,true)).rejects.toMatchObject({code:'scope'});
  await nativeRefused(withTenant(agent,tx=>tx.insert(s.rewardMember).values({tenantId:b.tenantId,unitId,userId:agent.agent!.principalId,role:'gr'})),'42501');
  expect(await securityState()).toEqual(before);
  // The unchanged pending request remains executable by its real independent human checker.
  expect(await decideRewardAccessRequest(checker,pending.requestId,true)).toEqual({status:'approved'});
 });
 it('refuses hybrid agent contexts carrying a human identity or administrator grants before Rewards effects',async()=>{
  const pending=await request({userId:target.userId!,role:'bu'}),agent=await namedAgent(),before=await securityState();
  expect(before.requests).toHaveLength(1);expect(before.requests[0]).toMatchObject({id:pending.requestId,status:'pending'});
  const hybrids:SessionContext[]=[{...agent,userId:checker.userId},{...agent,personId:checker.personId},{...agent,roles:['hr_admin'],grants:undefined},{...agent,grants:[{role:'hr_admin',companyId:null}]},{...checker,agent:agent.agent}];
  for(const hybrid of hybrids){
   await expect(withTenant(hybrid,tx=>tx.execute(sql`select app.reward_access_request_create(${JSON.stringify(before.requests[0].changes)}::jsonb)`))).rejects.toThrow('An agent context cannot also carry a login or a grant.');
   await expect(decideRewardAccessRequest(hybrid,pending.requestId,true)).rejects.toThrow('An agent context cannot also carry a login or a grant.');
   await expect(withTenant(hybrid,tx=>tx.execute(sql`select app.reward_roles(${unitId}::uuid)`))).rejects.toThrow('An agent context cannot also carry a login or a grant.');
  }
  expect(await securityState()).toEqual(before);
 });
 it('refuses a named principal as a GR beneficiary and refuses its projection of a real suspension event',async()=>{
  const pending=await request({userId:target.userId!,role:'bu'});await decideRewardAccessRequest(checker,pending.requestId,true);
  await owner.db.update(s.employment).set({tenderResignationDate:today}).where(eq(s.employment.id,employmentId));await expect(getRewardUnit(target,unitId)).rejects.toThrow();
  const [event]=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,unitId),eq(s.domainEvent.eventType,'reward-access.suspended')));expect(event).toBeTruthy();
  const agent=await namedAgent(),before=await securityState();expect(before.members).toHaveLength(2);expect(before.observations).toHaveLength(1);
  const changes=[{unitId,revision:(await revision()),before:null,after:{userId:agent.agent!.principalId,role:'gr'}}];
  // Even a human administrator cannot turn the non-login principal into a role-bearing app_user.
  await nativeRefused(withTenant(admin,tx=>tx.execute(sql`select app.reward_access_request_create(${JSON.stringify(changes)}::jsonb)`)),'42501');
  await nativeRefused(withTenant(agent,tx=>tx.execute(sql`select app.reward_access_project_account_suspension(${event.id}::uuid)`)),'42501');
  expect(await securityState()).toEqual(before);
 });
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
  await expect(withTenant(checker,tx=>tx.execute(sql`select app.reward_access_request_decide(${one.requestId}::uuid,false,NULL)`))).rejects.toThrow();
  await expect(withTenant(checker,tx=>tx.execute(sql`select app.reward_access_request_decide(${one.requestId}::uuid,false,repeat(chr(12)||chr(160),12))`))).rejects.toThrow();
  expect((await rewardAccessRequests(admin)).find(request=>request.id===one.requestId)?.status).toBe('pending');
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
 it('does not reactivate bootstrap authority by forging a review timestamp in a later transaction',async()=>{
  await owner.db.delete(s.rewardMember).where(eq(s.rewardMember.unitId,unitId));
  await withTenant(admin,tx=>tx.update(s.rewardUnit).set({createdAt:new Date('2200-01-01')}).where(eq(s.rewardUnit.id,unitId)));
  await expect(withTenant(admin,tx=>tx.insert(s.rewardMember).values({tenantId:b.tenantId,unitId,userId:admin.userId!,role:'gr'}))).rejects.toThrow();
 });
 it('uses inclusive access windows and removes coverage as soon as People records notice',async()=>{
  const pending=await request({userId:target.userId!,role:'bu',validFrom:today,validTo:today});await decideRewardAccessRequest(checker,pending.requestId,true);
  expect((await getRewardUnit(target,unitId)).roles).toContain('bu');
  await owner.db.update(s.employment).set({tenderResignationDate:today}).where(eq(s.employment.id,employmentId));
  await expect(getRewardUnit(target,unitId)).rejects.toThrow(/access has been removed|assign your Reward Desk role/);
  const value=await rewardAccessAdministration(admin,[b.companyId]);expect(value.members.find(m=>m.userId===target.userId)?.suspension).toEqual({reason:'notice',on:today});
  expect(value.reviews[0].coverage.missing).toContain('bu');
  await expect(getRewardUnit(target,unitId)).rejects.toThrow();
  const observed=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,unitId),eq(s.domainEvent.eventType,'reward-access.suspended')));expect(observed).toHaveLength(1);
 });
 it('bounds a named proxy by its own access dates and refuses a cover identity without that role',async()=>{
  let pending=await request({userId:target.userId!,role:'bu'});await decideRewardAccessRequest(checker,pending.requestId,true);
  const hire=await hireEmployee(admin,{person:{fullName:'Fictional temporary proxy',primaryEmail:randomUUID()+'@access.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:`${year-1}-01-01`});
  const [employee]=await owner.db.select().from(s.employment).where(eq(s.employment.id,hire.employmentId));await owner.db.update(s.assignment).set({businessUnitId:bu}).where(eq(s.assignment.employmentId,hire.employmentId));
  const proxyId=await createAppUser(b.tenantId,employee.personId,'employee'),proxy={...target,userId:proxyId,personId:employee.personId};
  await expect(request({userId:proxyId,role:'bu',validFrom:today,validTo:today,coversUserId:checker.userId})).rejects.toMatchObject({code:'proxy'});
  pending=await request({userId:proxyId,role:'bu',validFrom:today,validTo:today,coversUserId:target.userId});await decideRewardAccessRequest(checker,pending.requestId,true);
  expect((await getRewardUnit(proxy,unitId)).roles).toContain('bu');
  const yesterday=new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10);
  await owner.db.update(s.rewardMember).set({validFrom:yesterday,validTo:yesterday}).where(and(eq(s.rewardMember.unitId,unitId),eq(s.rewardMember.userId,proxyId)));
  await expect(getRewardUnit(proxy,unitId)).rejects.toThrow();
  expect((await rewardAccessAdministration(admin,[b.companyId])).members.find(m=>m.userId===proxyId)?.suspension).toEqual({reason:'expired',on:yesterday});
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
  const tomorrow=new Date(Date.parse(today+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  await owner.db.update(s.employment).set({hiredOn:tomorrow}).where(eq(s.employment.id,employmentId));expect((await getRewardUnit(target,unitId)).roles).toEqual(['bg']);
  await owner.db.update(s.employment).set({hiredOn:`${year-1}-01-01`}).where(eq(s.employment.id,employmentId));
  // Reversing a People correction does not resurrect the previous restoration approval.
  expect((await getRewardUnit(target,unitId)).roles).toEqual(['bg']);
  await owner.db.update(s.employment).set({tenderResignationDate:today}).where(eq(s.employment.id,employmentId));
  await expect(getRewardUnit(target,unitId)).rejects.toThrow();
 });
 it('lapses a waiting request when a People correction changes the hire-date eligibility source',async()=>{
  const pending=await request({userId:target.userId!,role:'bu'}),tomorrow=new Date(Date.parse(today+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  await owner.db.update(s.employment).set({hiredOn:tomorrow}).where(eq(s.employment.id,employmentId));
  expect(await decideRewardAccessRequest(checker,pending.requestId,true)).toEqual({status:'lapsed'});
 });
 it('notifies a Group Rewards holder through their active HQ employment for a subsidiary review',async()=>{
  const [hq]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional group HQ'}).returning();
  const [department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:hq.id,name:'Fictional HQ Rewards'}).returning();
  const hire=await hireEmployee(admin,{person:{fullName:'Fictional HQ Rewards lead',primaryEmail:randomUUID()+'@access.test'},companyId:hq.id,departmentId:department.id,employmentType:'full_time',hiredOn:`${year-1}-01-01`});
  const [employee]=await owner.db.select().from(s.employment).where(eq(s.employment.id,hire.employmentId));
  await owner.db.update(s.appUser).set({personId:employee.personId}).where(eq(s.appUser.id,admin.userId!));admin={...admin,personId:employee.personId};
  expect(hq.id).not.toBe(b.companyId);
  expect(await withTenant(admin,tx=>rewardAccessSuspensionRecipients(tx,unitId))).toEqual([hire.employmentId]);
 });
 it('lapses approval when the affected People source changes while the request waits',async()=>{
  const pending=await request({userId:target.userId!,role:'bu'});
  await owner.db.update(s.employment).set({tenderResignationDate:today}).where(eq(s.employment.id,employmentId));
  expect(await decideRewardAccessRequest(checker,pending.requestId,true)).toEqual({status:'lapsed'});
  expect((await rewardAccessAdministration(admin,[b.companyId])).members.some(m=>m.userId===target.userId)).toBe(false);
 });
 it('does not let an unrelated same-tenant login inspect a retained member eligibility identifier',async()=>{
  const pending=await request({userId:target.userId!,role:'bu'});await decideRewardAccessRequest(checker,pending.requestId,true);
  const member=(await rewardAccessAdministration(admin,[b.companyId])).members.find(m=>m.userId===target.userId)!;
  const unrelated=await account('Unrelated same-tenant login');
  const [own]=await withTenant(target,tx=>tx.execute<{ok:boolean}>(sql`select app.reward_member_eligible(${member.id}::uuid) as ok`));expect(own.ok).toBe(true);
  const [hidden]=await withTenant(unrelated,tx=>tx.execute<{ok:boolean}>(sql`select app.reward_member_eligible(${member.id}::uuid) as ok`));expect(hidden.ok).toBe(false);
  await expect(withTenant(unrelated,tx=>tx.execute(sql`select app.reward_member_eligible_internal(${member.id}::uuid)`))).rejects.toThrow();
 });
 it('refuses forged access-decision and last-change audit events from the application role',async()=>{
  const pending=await request({userId:target.userId!,role:'bu'});
  for(const [aggregateType,aggregateId,eventType] of [['reward-access-request',pending.requestId,'reward-access.approved'],['reward-unit',unitId,'reward-unit.access-changed'],['reward-unit',unitId,'reward-access.suspended']]){
   await expect(withTenant(admin,tx=>tx.insert(s.domainEvent).values({tenantId:b.tenantId,aggregateType,aggregateId,eventType,actorType:'user',actorId:admin.userId!,payload:{after:{userId:target.userId,role:'bu'}}}))).rejects.toThrow();
  }
  expect((await rewardAccessRequests(admin)).find(request=>request.id===pending.requestId)?.status).toBe('pending');
  expect(await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,pending.requestId),eq(s.domainEvent.eventType,'reward-access.approved')))).toEqual([]);
 });
 it('projects an idempotent user-only GR bell warning from the exact native suspension event',async()=>{
  await setModule(b.tenantId,'notifications','active');
  const external=await account('Fictional account-only Group Rewards');
  let pending=await request({userId:target.userId!,role:'bu'});await decideRewardAccessRequest(checker,pending.requestId,true);
  pending=await request({userId:external.userId!,role:'gr'});await decideRewardAccessRequest(checker,pending.requestId,true);
  await owner.db.update(s.employment).set({tenderResignationDate:today}).where(eq(s.employment.id,employmentId));await expect(getRewardUnit(target,unitId)).rejects.toThrow();
  const [event]=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,unitId),eq(s.domainEvent.eventType,'reward-access.suspended')));expect(event).toBeTruthy();
  const activeAdmin=await entitledCtx(b);await dispatchNotifications(activeAdmin);
  const own=await withTenant(external,tx=>tx.select().from(s.notification).where(eq(s.notification.sourceEventId,event.id)));
  expect(own).toHaveLength(1);expect(own[0]).toMatchObject({recipientUserId:external.userId,recipientEmploymentId:null,kind:'rewards.access-suspended',linkPath:`/rewards/${unitId}?view=approvals`});
  const [again]=await withTenant(admin,tx=>tx.execute<{created:number}>(sql`select app.reward_access_project_account_suspension(${event.id}::uuid) as created`));expect(again.created).toBe(0);
  let denied:unknown;try{await withTenant(admin,tx=>tx.insert(s.notification).values({tenantId:b.tenantId,recipientUserId:external.userId,companyId:b.companyId,kind:'rewards.access-suspended',title:'Rewards access suspended',body:'People records changed. Check approval-role coverage and ask a Rewards administrator to review suspended access.',linkPath:`/rewards/${unitId}?view=approvals`,severity:'warning',sourceEventId:event.id}));}catch(error){denied=error;}expect(pgSqlState(denied)).toBe('42501');
  const [wrong]=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,unitId),eq(s.domainEvent.eventType,'reward-unit.created')));expect(wrong).toBeTruthy();
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.reward_access_project_account_suspension(${wrong.id}::uuid)`))).rejects.toThrow();
  const foreign=await seedBase(),foreignActor=await entitledCtx(foreign);await expect(withTenant(foreignActor,tx=>tx.execute(sql`select app.reward_access_project_account_suspension(${event.id}::uuid)`))).rejects.toThrow();
  const unrelated=await account('Fictional unrelated notice recipient');
  await expect(withTenant(admin,tx=>tx.insert(s.notification).values({tenantId:b.tenantId,recipientUserId:unrelated.userId,companyId:b.companyId,kind:'rewards.access-suspended',title:'Rewards access suspended',body:'Forged',linkPath:`/rewards/${unitId}?view=approvals`,severity:'warning',sourceEventId:event.id}))).rejects.toThrow();
 });
 it('enforces tenant scope on the request reader and decision owner',async()=>{
  const pending=await request({userId:target.userId!,role:'bu'}),foreign=await seedBase();await setModule(foreign.tenantId,'rewards','active');const outsider=await entitledCtx(foreign);
  expect(await rewardAccessRequests(outsider)).toEqual([]);await expect(decideRewardAccessRequest(outsider,pending.requestId,true)).rejects.toMatchObject({code:'scope'});
  expect((await rewardAccessRequests(admin)).find(q=>q.id===pending.requestId)?.status).toBe('pending');
 });
});
