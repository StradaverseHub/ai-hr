/** ADR-0151 (amendment 2026-10-29): an HR administrator prepares and confirms a leave adjustment or an
 * assignment-only movement on ANOTHER person's employment through the wave 1b assigned-review store
 * (migrations 0671 + 0677). Real migrated database and the real native services; fictional fixtures only. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {createCompany,createDepartment} from '../core/admin';
import {grantAssistant} from '../core/assistant-grant';
import {applyLeaveAdjustmentBatchTx} from '../packs/leave/service';
import {createMovementEventTx} from '../core/movement';
import {leaveAdjustmentReviews,movementTransferReviews,readLeaveAdjustmentChoices,readMovementTransferChoices} from '../core/assistant-actions/hr-prepared-review-store';
import {readCompletedNativeOutcomeTx} from '../core/assistant-actions/completed-outcome-readers';
import {HR_LEAVE_ADJUSTMENT_ACTION,HR_MOVEMENT_TRANSFER_ACTION} from '../lib/assistant-actions/hr-prepared-contract';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Person={employmentId:string;personId:string};
type Role='employee'|'manager'|'hr_admin'|'super_admin';
type Store={
 prepare(ctx:SessionContext,input:unknown):Promise<{review:{actionId:string;reviewedDigest:string;review:unknown;consequence:string}}>;
 confirm(ctx:SessionContext,input:{actionId:string;reviewedDigest:string}):Promise<{kind:string;receipt:unknown}>;
 reopen(ctx:SessionContext,value:unknown):Promise<{kind:string}>;
 discard(ctx:SessionContext,input:{actionId:string}):Promise<{kind:string;receipt:{state:string}}>;
 list(ctx:SessionContext):Promise<{reviews:{actionId:string}[]}>;
};
type Kind={action:string;store:Store;choices:(ctx:SessionContext,selection?:unknown)=>Promise<unknown>;
 human(employmentId:string):Record<string,unknown>;
 /** Native effects on the subject: rows and events that the change writes. */
 effects(employmentId:string):Promise<{rows:number;events:{id:string;actor_id:string|null}[]}>;
 /** The native write in the caller's transaction, returning its event (no Assistant). */
 nativeTx(tx:Tx,who:SessionContext,employmentId:string):Promise<string>;
};

let b:Base,subject:Person,hrPerson:Person,outsider:Person,hr:SessionContext,stranger:SessionContext,otherCompanyHr:SessionContext;
const hiredOn=()=>`${Number(todayInKualaLumpur().slice(0,4))-2}-01-01`;
const groupOf=(base:Base)=>({...adminCtx(base),grants:[{role:'hr_admin' as const,companyId:null}]});
const group=()=>groupOf(b);
const hire=(name:string,base:Base=b,companyId=base.companyId,departmentId=base.deptB)=>hireEmployee(groupOf(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId,departmentId,employmentType:'full_time',hiredOn:hiredOn()});
async function login(personId:string,role:Role,base:Base=b,companyId:string|null=null):Promise<SessionContext>{
 const userId=await createAppUser(base.tenantId,personId,role);
 if(companyId)await owner.db.update(schema.roleAssignment).set({companyId}).where(eq(schema.roleAssignment.appUserId,userId));
 await grantAssistant(groupOf(base),{appUserId:userId});
 return {...await entitledCtx(base,[role]),userId,personId,grants:[{role,companyId}]};
}
beforeAll(async()=>{await migrateTestDb();const [installed]=await owner.db.execute<{ok:boolean}>(sql`select app._assistant_assigned_review_subject_kind('leave.adjustment.apply')='employment' as ok`);expect(installed.ok,'Migration 0677 must be installed.').toBe(true);});
afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-hr-prepared-custody-key-1234');
 await resetDb();b=await seedBase();for(const code of ['assistant'])await setModule(b.tenantId,code,'active');
 subject=await hire('Fictional Adjusted Employee');hrPerson=await hire('Fictional HR Administrator');outsider=await hire('Fictional Unrelated Colleague');
 hr=await login(hrPerson.personId,'hr_admin');stranger=await login(outsider.personId,'employee');
 // An HR administrator scoped to ANOTHER company of the same tenant (wrong company scope).
 const other=await createCompany(group(),{legalName:'Fictional other employer',country:'MY',currency:'MYR'} as never);
 const otherDept=await createDepartment(group(),{companyId:other.id,name:'Fictional other department'} as never);
 const otherPerson=await hire('Fictional Other-Company HR',b,other.id,(otherDept as {id:string}).id);
 otherCompanyHr=await login(otherPerson.personId,'hr_admin',b,other.id);
});

const KINDS:Record<'leave'|'movement',Kind>={
 leave:{action:HR_LEAVE_ADJUSTMENT_ACTION,store:leaveAdjustmentReviews,choices:readLeaveAdjustmentChoices,
  human:employmentId=>({action:HR_LEAVE_ADJUSTMENT_ACTION,contractVersion:1,employmentId,subjectId:employmentId,leaveTypeId:b.annualLeaveTypeId,direction:'add',days:'1.5',effectiveOn:todayInKualaLumpur(),reason:'Fictional correction of a missed carry-forward'}),
  async effects(employmentId){
   const [rows]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.leave_ledger where employment_id=${employmentId}::uuid and entry_type='adjustment'`);
   const events=await owner.db.execute<{id:string;actor_id:string|null}>(sql`select d.id,d.actor_id from public.domain_event d join public.leave_adjustment_batch a on a.id=d.aggregate_id where d.event_type='leave.adjustment.applied'
    and exists(select 1 from public.leave_ledger l where l.adjustment_batch_id=a.id and l.employment_id=${employmentId}::uuid) order by d.sequence`);
   return {rows:rows.n,events:Array.from(events)};},
  async nativeTx(tx,who,employmentId){return (await applyLeaveAdjustmentBatchTx(tx,who,{targetMode:'individual',employmentIds:[employmentId],leaveTypeIds:[b.annualLeaveTypeId],days:1,effectiveOn:todayInKualaLumpur(),reason:'Fictional native adjustment'})).eventId;}},
 movement:{action:HR_MOVEMENT_TRANSFER_ACTION,store:movementTransferReviews,choices:readMovementTransferChoices,
  human:employmentId=>({action:HR_MOVEMENT_TRANSFER_ACTION,contractVersion:1,employmentId,subjectId:employmentId,kind:'transfer',effectiveDate:todayInKualaLumpur(),departmentId:b.deptA,positionId:null,businessUnitId:null,locationId:null,remarks:'Fictional team change'}),
  async effects(employmentId){
   const [rows]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.assignment where employment_id=${employmentId}::uuid and department_id=${b.deptA}::uuid and superseded_at is null`);
   const events=await owner.db.execute<{id:string;actor_id:string|null}>(sql`select id,actor_id from public.domain_event where subject_employment_id=${employmentId}::uuid and jsonb_typeof(payload->'movement')='object' and coalesce(payload->'movement'->>'secondary','false')<>'true' order by sequence`);
   return {rows:rows.n,events:Array.from(events)};},
  async nativeTx(tx,who,employmentId){await createMovementEventTx(tx,who,{employmentId,kind:'transfer',effectiveDate:todayInKualaLumpur(),departmentId:b.deptA});
   const [row]=await tx.execute<{id:string}>(sql`select id from public.domain_event where subject_employment_id=${employmentId}::uuid and jsonb_typeof(payload->'movement')='object' order by sequence desc limit 1`);return row.id;}},
};
const receiptOf=(done:{kind:string;receipt:unknown})=>(done.receipt as {receipt:unknown}).receipt as {eventId:string;employmentId:string;subjectId:string};
async function custody(id:string){const [row]=await owner.db.execute(sql`select r.action_kind,r.state,r.user_id,r.person_id,r.employment_id,r.company_id,r.decision_subject_person_id,r.receipt_subject_kind,r.receipt_subject_id,r.receipt_event_id,r.intent_digest,r.reviewed_digest,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where r.id=${id}::uuid`);return row;}

describe.each(['leave','movement'] as const)('ADR-0151 HR-prepared %s custody',name=>{
 const k=()=>KINDS[name];
 const prepare=async(who:SessionContext,value:unknown)=>(await k().store.prepare(who,value)).review;
 const confirm=(r:{actionId:string;reviewedDigest:string},who:SessionContext)=>k().store.confirm(who,{actionId:r.actionId,reviewedDigest:r.reviewedDigest});

 it('applies exactly once across duplicate deliveries and completes with that native event',async()=>{
  const before=await k().effects(subject.employmentId);expect(before.events).toEqual([]);
  expect(await k().choices(hr,{query:'Adjusted'})).toMatchObject({kind:'choices',employees:[{employmentId:subject.employmentId,employeeName:'Fictional Adjusted Employee'}]});
  const r=await prepare(hr,k().human(subject.employmentId));expect(await k().effects(subject.employmentId)).toEqual(before);
  expect(await custody(r.actionId)).toMatchObject({action_kind:k().action,state:'awaiting_confirmation',user_id:hr.userId,person_id:hrPerson.personId,employment_id:subject.employmentId,company_id:b.companyId,
   decision_subject_person_id:subject.personId,receipt_subject_kind:'employment',receipt_subject_id:subject.employmentId,receipt_event_id:null,bodies:1});
  const [first,second]=await Promise.all([confirm(r,hr),confirm(r,hr)]);
  expect(first).toEqual(second);expect(first.kind).toBe('completed');
  const after=await k().effects(subject.employmentId);expect(after.rows).toBe(before.rows+1);expect(after.events).toHaveLength(1);expect(after.events[0].actor_id).toBe(hr.userId);
  expect(receiptOf(first)).toMatchObject({subjectId:subject.employmentId,employmentId:subject.employmentId,eventId:after.events[0].id});
  expect(await custody(r.actionId)).toMatchObject({state:'completed',receipt_event_id:after.events[0].id,intent_digest:null,reviewed_digest:null,bodies:0});
  // A later identical confirmation and a reopen read the canonical receipt and never apply again.
  expect(await confirm(r,hr)).toEqual(first);expect(await k().store.reopen(hr,r.actionId)).toEqual(first);
  await expect(k().store.discard(hr,{actionId:r.actionId})).rejects.toThrow();expect(await k().effects(subject.employmentId)).toEqual(after);
 });

 it('refuses a stale source: the employee left after the review, writing nothing, and still allows discard',async()=>{
  const r=await prepare(hr,k().human(subject.employmentId)),before=await k().effects(subject.employmentId);
  await owner.db.update(schema.employment).set({terminatedOn:todayInKualaLumpur()}).where(eq(schema.employment.id,subject.employmentId));
  await expect(confirm(r,hr)).rejects.toThrow();await expect(k().store.reopen(hr,r.actionId)).rejects.toThrow();
  expect(await k().effects(subject.employmentId)).toEqual(before);expect(await custody(r.actionId)).toMatchObject({state:'awaiting_confirmation',receipt_event_id:null,bodies:1});
  expect((await k().store.discard(hr,{actionId:r.actionId})).receipt.state).toBe('discarded');expect(await custody(r.actionId)).toMatchObject({state:'discarded',bodies:0});
 });

 it('refuses the wrong company scope, a non-administrator, a mismatched subject, another login and a foreign tenant',async()=>{
  const before=await k().effects(subject.employmentId);
  // Wrong company scope: an administrator of another company of this tenant.
  expect(await k().choices(otherCompanyHr,{query:'Adjusted'})).toMatchObject({kind:'choices',employees:[]});
  await expect(prepare(otherCompanyHr,k().human(subject.employmentId))).rejects.toThrow();
  // Not an administrator at all.
  expect(await k().choices(stranger,{query:''})).toEqual({kind:'unavailable'});
  await expect(prepare(stranger,k().human(subject.employmentId))).rejects.toThrow();
  await expect(prepare(hr,{...k().human(subject.employmentId),subjectId:outsider.employmentId})).rejects.toThrow();
  await expect(prepare(hr,k().human(randomUUID()))).rejects.toThrow();
  const r=await prepare(hr,k().human(subject.employmentId));
  await expect(confirm({actionId:r.actionId,reviewedDigest:'0'.repeat(64)},hr)).rejects.toThrow();
  const second=await login(hrPerson.personId,'hr_admin');
  await expect(confirm(r,second)).rejects.toThrow();await expect(k().store.discard(second,{actionId:r.actionId})).rejects.toThrow();expect((await k().store.list(second)).reviews).toEqual([]);
  const foreign=await seedBase();for(const code of ['assistant'])await setModule(foreign.tenantId,code,'active');
  const foreignHr=await login((await hire('Fictional Foreign HR',foreign)).personId,'hr_admin',foreign);
  await expect(confirm(r,foreignHr)).rejects.toThrow();await expect(prepare(foreignHr,k().human(subject.employmentId))).rejects.toThrow();
  expect((await k().store.list(foreignHr)).reviews).toEqual([]);
  expect(await k().effects(subject.employmentId)).toEqual(before);expect(await custody(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});
 });

 it('never lets HR act on their own employment, even as super_admin, in the adapter or in SQL',async()=>{
  const self=await login(hrPerson.personId,'super_admin'),before=await k().effects(hrPerson.employmentId);
  expect(await k().choices(self,{query:'Fictional HR Administrator'})).toMatchObject({kind:'choices',employees:[]});
  await expect(prepare(self,k().human(hrPerson.employmentId))).rejects.toThrow();expect((await k().store.list(self)).reviews).toEqual([]);
  const call=(who:SessionContext,person:string|null,subjectPerson:string,employmentId:string,subjectId=employmentId)=>withTenant(who,tx=>tx.execute(sql`select app.assistant_assigned_review_prepare(${k().action},${randomUUID()}::uuid,${person}::uuid,${employmentId}::uuid,${b.companyId}::uuid,${subjectPerson}::uuid,${subjectId}::uuid,${'a'.repeat(64)},${'b'.repeat(64)},${'0123456789abcdef'},${'fictional-wrapped-key'},${'fictional-ciphertext'}) as review`));
  await expect(call(self,hrPerson.personId,hrPerson.personId,hrPerson.employmentId)).rejects.toThrow();
  // An 'employment' subject must be the bound employment itself.
  await expect(call(hr,hrPerson.personId,subject.personId,subject.employmentId,outsider.employmentId)).rejects.toThrow();
  // Control: the same call shape is accepted for another employee, so the refusals above are the rules.
  await expect(call(hr,hrPerson.personId,subject.personId,subject.employmentId)).resolves.toBeDefined();
  const [held]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from app.assistant_own_leave_review where user_id=${self.userId}::uuid`);expect(held.n).toBe(0);
  expect(await k().effects(hrPerson.employmentId)).toEqual(before);
 });

 it('refuses an effect committed in an earlier transaction as completion proof',async()=>{
  const r=await prepare(hr,k().human(subject.employmentId)),eventId=await withTenant(hr,tx=>k().nativeTx(tx,hr,subject.employmentId));
  await expect(withTenant(hr,tx=>tx.execute(sql`select app.assistant_assigned_review_complete(${r.actionId}::uuid,${k().action},${r.reviewedDigest},${eventId}::uuid)`))).rejects.toThrow();
  await expect(withTenant(hr,tx=>tx.execute(sql`select app.assistant_generic_review_complete(${r.actionId}::uuid,${k().action},${r.reviewedDigest},${eventId}::uuid)`))).rejects.toThrow();
  expect(await custody(r.actionId)).toMatchObject({state:'awaiting_confirmation',receipt_event_id:null,bodies:1});
 });

 it('links the completed review to its native outcome only for the administrator who confirmed it',async()=>{
  const r=await prepare(hr,k().human(subject.employmentId)),done=await confirm(r,hr);expect(done.kind).toBe('completed');
  const reference={source:'review',action:k().action,actionId:r.actionId};
  const outcome=await withTenant(hr,tx=>readCompletedNativeOutcomeTx(tx,hr,reference));
  expect(outcome.evidence).toMatchObject({action:k().action,sourceId:r.actionId,eventId:receiptOf(done).eventId});
  await expect(withTenant(stranger,tx=>readCompletedNativeOutcomeTx(tx,stranger,reference))).rejects.toThrow();
 });
});

describe('ADR-0151 HR-prepared movement scope',()=>{
 it('records a future-dated transfer as pending and never touches grade, pay or company',async()=>{
  const future=new Date(todayInKualaLumpur()+'T12:00:00Z');future.setUTCDate(future.getUTCDate()+30);
  const human={...KINDS.movement.human(subject.employmentId),effectiveDate:future.toISOString().slice(0,10)};
  const r=(await movementTransferReviews.prepare(hr,human)).review;expect(r.review).toMatchObject({scheduled:true,department:expect.any(String)});
  const done=await movementTransferReviews.confirm(hr,{actionId:r.actionId,reviewedDigest:r.reviewedDigest});
  expect(receiptOf(done)).toMatchObject({employmentId:subject.employmentId});expect((done.receipt as {receipt:{recorded:string}}).receipt.recorded).toBe('scheduled');
  const [employment]=await owner.db.select({companyId:schema.employment.companyId}).from(schema.employment).where(eq(schema.employment.id,subject.employmentId));expect(employment.companyId).toBe(b.companyId);
  // The contract has no grade, pay or company field; an extra key is refused before anything is prepared.
  for(const extra of [{gradeId:randomUUID()},{companyId:randomUUID()},{basicSalary:9000},{kind:'termination'}])await expect(movementTransferReviews.prepare(hr,{...KINDS.movement.human(subject.employmentId),...extra})).rejects.toThrow();
 });
});
