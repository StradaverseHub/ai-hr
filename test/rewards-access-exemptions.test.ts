import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import {createRewardUnit,getRewardConfiguration,previewRewardAccessChange,saveRewardAccessChange,previewRewardAccessBatch,saveRewardAccessBatch,decideRewardAccessRequest,rewardAccessRequests,rewardAccessAdministration,rewardAccessCompanies} from '../packs/rewards/service';
import {migrateRewardMembershipFixture,establishRewardMembership} from './rewards-shared-policy-fixture';
import {owner,resetDb,seedBase,setModule,entitledCtx,createAppUser,closeAll,type Base} from './harness';
let b:Base,admin:SessionContext,unitId:string,bu:string;
const today=todayInKualaLumpur(),year=Number(today.slice(0,4)),reason='Reviewed fictional access request';
beforeAll(migrateRewardMembershipFixture);afterAll(closeAll);
async function user(name:string,role:'employee'|'hr_admin'|'super_admin'='employee'){
 const [p]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:name,primaryEmail:randomUUID()+'@rewards.test'}).returning();
 const id=await createAppUser(b.tenantId,p.id,role);return {...admin,userId:id,personId:p.id,roles:[role],grants:[{role,companyId:null}]} satisfies SessionContext;
}
async function seat(ctx:SessionContext,role:'gr'|'ctro'|'bg'|'pbp',unit=unitId){await owner.db.insert(s.rewardMember).values({tenantId:b.tenantId,unitId:unit,userId:ctx.userId!,role});}
async function revision(id=unitId){return (await getRewardConfiguration(admin,id)).unit.revision;}
async function change(ctx:SessionContext,target:SessionContext,role:'gr'|'ctro'|'pbp'='pbp'){
 const input={unitId,revision:await revision(),before:null,after:{userId:target.userId!,role},reason};
 const preview=await previewRewardAccessChange(ctx,input);return {input,preview,save:()=>saveRewardAccessChange(ctx,input,preview.digest)};
}
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'rewards','active');admin=await entitledCtx(b);
 const [unit]=await owner.db.insert(s.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'EXEMPT',name:'Fictional exemption scope'}).returning();bu=unit.id;
 await establishRewardMembership(admin,{tenantId:b.tenantId,companyId:b.companyId,businessUnitId:bu,departmentId:b.deptA,year});
 unitId=await createRewardUnit(admin,{name:'Exemption fixture',companyId:b.companyId,businessUnitId:bu,year,snapshotDate:today});
});
describe('Rewards authoritative immediate application and GR decisions',()=>{
 it.each(['gr','ctro','hr_admin'] as const)('applies %s immediately from current native authority, with no fabricated checker',async role=>{
  const actor=await user('Fictional access owner',role==='hr_admin'?'hr_admin':'employee'),target=await user('Fictional view recipient');
  if(role!=='hr_admin')await seat(actor,role);
  expect((await rewardAccessCompanies(actor)).map(c=>c.id)).toContain(b.companyId);
  expect((await rewardAccessAdministration(actor,[b.companyId])).reviews.map(r=>r.id)).toContain(unitId);
  const p=await change(actor,target);expect(p.preview.pending).toBe(false);
  const result=await p.save();expect(result).toMatchObject({pending:false,status:'applied_no_second_approval'});
  const [q]=await owner.db.select().from(s.rewardAccessRequest).where(eq(s.rewardAccessRequest.id,result.requestId));
  expect(q).toMatchObject({requestedBy:actor.userId,decidedBy:null,requestReason:reason,status:'applied_no_second_approval',exemptionBasis:{[unitId]:role}});
  expect(q.decidedAt).not.toBeNull();
  const members=await owner.db.select().from(s.rewardMember).where(and(eq(s.rewardMember.unitId,unitId),eq(s.rewardMember.userId,target.userId!)));expect(members).toHaveLength(1);
  await expect(decideRewardAccessRequest(actor,result.requestId,true)).rejects.toMatchObject({code:'changed'});
 });
 it('does not treat super-admin as an exemption and admits only independent current GR to decide',async()=>{
  const requester=await user('Non-exempt company administrator','super_admin'),hr=await user('HR administrator','hr_admin'),ctro=await user('CTRO reviewer'),gr=await user('GR checker'),target=await user('Recipient');
  await seat(ctro,'ctro');await seat(gr,'gr');
  const p=await change(requester,target),result=await p.save();expect(p.preview.pending).toBe(true);expect(result.pending).toBe(true);
  expect((await owner.db.select().from(s.rewardMember).where(eq(s.rewardMember.userId,target.userId!)))).toHaveLength(0);
  for(const actor of [requester,hr,ctro]){expect((await rewardAccessRequests(actor)).find(q=>q.id===result.requestId)?.canDecide).toBe(false);await expect(decideRewardAccessRequest(actor,result.requestId,true)).rejects.toMatchObject({code:'checker'});}
  expect((await rewardAccessRequests(gr)).find(q=>q.id===result.requestId)?.canDecide).toBe(true);
  const attempts=await Promise.allSettled([decideRewardAccessRequest(gr,result.requestId,true,'Reviewed terms and scope'),decideRewardAccessRequest(gr,result.requestId,true,'Reviewed terms and scope')]);
  expect(attempts.filter(a=>a.status==='fulfilled')).toHaveLength(1);
  const [q]=await owner.db.select().from(s.rewardAccessRequest).where(eq(s.rewardAccessRequest.id,result.requestId));expect(q).toMatchObject({status:'approved',decidedBy:gr.userId});
 });
 it('keeps person-level independence across alternate requester and affected-person logins',async()=>{
  const requester=await user('Requester with another login','super_admin'),target=await user('Affected person with another login'),independent=await user('Actually independent GR');
  const requesterAlternate={...requester,userId:await createAppUser(b.tenantId,requester.personId!,'employee'),roles:['employee'],grants:[{role:'employee',companyId:null}]} satisfies SessionContext;
  const affectedAlternate={...target,userId:await createAppUser(b.tenantId,target.personId!,'employee')} satisfies SessionContext;
  for(const actor of [requesterAlternate,affectedAlternate,independent])await seat(actor,'gr');
  const pending=await (await change(requester,target)).save();expect(pending.pending).toBe(true);
  for(const actor of [requesterAlternate,affectedAlternate]){
   expect((await rewardAccessRequests(actor)).find(q=>q.id===pending.requestId)?.canDecide).toBe(false);
   await expect(decideRewardAccessRequest(actor,pending.requestId,true,'Alternate account must not approve')).rejects.toMatchObject({code:'checker'});
   await expect(withTenant(actor,tx=>tx.execute(sql`select app.reward_access_request_decide(${pending.requestId}::uuid,true,'Alternate account direct native refusal')`))).rejects.toThrow();
  }
  expect((await owner.db.select().from(s.rewardAccessRequest).where(eq(s.rewardAccessRequest.id,pending.requestId)))[0].status).toBe('pending');
  await decideRewardAccessRequest(independent,pending.requestId,true,'Different person independently reviewed');
  expect((await owner.db.select().from(s.rewardAccessRequest).where(eq(s.rewardAccessRequest.id,pending.requestId)))[0]).toMatchObject({status:'approved',decidedBy:independent.userId});
 });
 it('cannot acquire its own exemption through a pending grant and preserves existing pending rows after the role changes',async()=>{
  const requester=await user('Non-exempt administrator','super_admin'),gr=await user('Independent Group Rewards');await seat(gr,'gr');
  const self=await change(requester,requester,'gr'),pending=await self.save();expect(pending.pending).toBe(true);
  await expect(decideRewardAccessRequest(requester,pending.requestId,true)).rejects.toMatchObject({code:'checker'});
  const target=await user('Another recipient'),waiting=await (await change(requester,target)).save();
  await seat(requester,'ctro');
  expect((await rewardAccessRequests(requester)).find(q=>q.id===waiting.requestId)?.status).toBe('lapsed');
  await expect(decideRewardAccessRequest(requester,waiting.requestId,true)).rejects.toMatchObject({code:'changed'});
 });
 it('keeps a mixed-scope batch wholly pending and prevents a GR holder approving changes to themselves',async()=>{
  const actor=await user('Mixed authority requester'),checker=await user('All-scope GR'),target=await user('View recipient');
  const [unit]=await owner.db.insert(s.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'OTHER',name:'Other review'}).returning();
  await establishRewardMembership(admin,{tenantId:b.tenantId,companyId:b.companyId,businessUnitId:unit.id,departmentId:b.deptA,year});
  const second=await createRewardUnit(admin,{name:'Second scope',companyId:b.companyId,businessUnitId:unit.id,year,snapshotDate:today});
  await seat(actor,'gr');await seat(actor,'pbp',second);await seat(checker,'gr');await seat(checker,'gr',second);
  const input={changes:[{unitId,revision:await revision(),before:null,after:{userId:target.userId!,role:'pbp' as const}},{unitId:second,revision:await revision(second),before:{userId:actor.userId!,role:'pbp' as const},after:null}],reason};
  const preview=await previewRewardAccessBatch(actor,input);expect(preview.pending).toBe(true);const pending=await saveRewardAccessBatch(actor,input,preview.digest);expect(pending.pending).toBe(true);
  expect(await owner.db.select().from(s.rewardMember).where(eq(s.rewardMember.userId,target.userId!))).toHaveLength(0);
  expect((await owner.db.select().from(s.rewardMember).where(and(eq(s.rewardMember.unitId,second),eq(s.rewardMember.userId,actor.userId!))))).toHaveLength(1);
  await expect(decideRewardAccessRequest(actor,pending.requestId!,true)).rejects.toMatchObject({code:'checker'});
  await decideRewardAccessRequest(checker,pending.requestId!,true);
  expect(await owner.db.select().from(s.rewardMember).where(eq(s.rewardMember.userId,target.userId!))).toHaveLength(1);
 });
 it('refuses expired/archived roles, unreasoned SQL and direct mutation; invalidates previews when role authority changes',async()=>{
  const gr=await user('Former GR'),target=await user('Recipient');await seat(gr,'gr');
  const p=await change(gr,target);
  await owner.db.update(s.rewardMember).set({validTo:'2000-01-01',validFrom:'1999-01-01'}).where(and(eq(s.rewardMember.unitId,unitId),eq(s.rewardMember.userId,gr.userId!)));
  await expect(p.save()).rejects.toThrow();
  await expect(withTenant(gr,tx=>tx.execute(sql`select app.reward_access_request_create(${JSON.stringify([p.input])}::jsonb)`))).rejects.toThrow();
  await expect(withTenant(admin,tx=>tx.insert(s.rewardMember).values({tenantId:b.tenantId,unitId,userId:target.userId!,role:'pbp'}))).rejects.toThrow();
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.reward_access_request_apply(${randomUUID()}::uuid,true,'Forged bypass attempt',true)`))).rejects.toThrow();
  await expect(saveRewardAccessChange(admin,{unitId,revision:await revision(),before:null,after:{userId:target.userId!,role:'pbp'}},'a'.repeat(64))).rejects.toThrow();
 });
 it('refuses last-GR loss and locked reviews and records rejection without granting access',async()=>{
  const target=await user('Recipient'),requester=await user('Non-exempt administrator','super_admin'),gr=await user('GR checker');
  const remove={unitId,revision:await revision(),before:{userId:admin.userId!,role:'gr' as const},after:null,reason};await expect(previewRewardAccessChange(admin,remove)).rejects.toMatchObject({code:'lastGr'});
  await seat(gr,'gr');const pending=await (await change(requester,target)).save();
  await expect(decideRewardAccessRequest(gr,pending.requestId,false,'tiny')).rejects.toMatchObject({code:'reason'});
  await decideRewardAccessRequest(gr,pending.requestId,false,'Not the approved reviewer');
  expect((await rewardAccessRequests(requester)).find(q=>q.id===pending.requestId)).toMatchObject({status:'rejected',reason:'Not the approved reviewer'});
  expect(await owner.db.select().from(s.rewardMember).where(eq(s.rewardMember.userId,target.userId!))).toHaveLength(0);
  await owner.db.update(s.rewardUnit).set({status:'bg'}).where(eq(s.rewardUnit.id,unitId));await expect(change(admin,target)).rejects.toMatchObject({code:'locked'});
 });
});
