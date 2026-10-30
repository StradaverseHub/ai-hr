/** Authored for exact-SHA GitHub Actions only. Real native owners and migrated custody. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {createEmployeeDraftWithReservedCode,saveEmployeeDraft,saveAndCompleteEmployeeDraft,getEmployeeDraft,previewSavedEmployeeDraftActivationTx} from '../core/employee-draft';
import {hireEmployee} from '../core/org';
import {grantAssistant} from '../core/assistant-grant';
import {employeeDraftActivationReviews as store,readEmployeeDraftActivationChoices} from '../core/assistant-actions/employee-draft-activation-review-store';
import {EmployeeDraftActivation as C} from '../lib/assistant-actions/employee-draft-activation-contract';
import {createEntitlementTemplate,createEligibilityRule} from '../core/entitlement-template';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,hr:SessionContext;
const group=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-draft-activation-custody-key-1234');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');const person=await hireEmployee(group(),{person:{fullName:'Fictional Draft HR',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',hiredOn:todayInKualaLumpur()}),userId=await createAppUser(b.tenantId,person.personId,'hr_admin');await grantAssistant(group(),{appUserId:userId});hr={...await entitledCtx(b,['hr_admin']),userId,personId:person.personId,grants:[{role:'hr_admin',companyId:null}]};});
async function draft(){const out=await createEmployeeDraftWithReservedCode(hr,{companyId:b.companyId,fullName:'Fictional Saved Draft',primaryEmail:randomUUID()+'@fixture.test',employeeIdMode:'manual',employeeCode:'DRAFT-'+randomUUID().slice(0,8).toUpperCase()});const data={profile:{fullName:'Fictional Saved Draft',primaryEmail:randomUUID()+'@fixture.test',employeeCode:out.employeeCode,employeeIdMode:'manual',phone:'000123'},employment:{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()},payroll:{basicSalary:'3000',monthlyAllowance:'100',payMode:'monthly',paymentTerm:'monthly',remarks:'Human entered initial pay'}};await saveEmployeeDraft(hr,{id:out.id,data,currentStep:4});return{...out,data};}
const human=(id:string)=>({action:C.action,contractVersion:1,draftId:id,companyId:b.companyId});
const confirmation=(r:{actionId:string;reviewedDigest:string})=>({action:C.action,contractVersion:1,actionId:r.actionId,reviewedDigest:r.reviewedDigest});
async function snapshot(id:string){const [row]=await owner.db.execute<{draft:unknown;people:number;employments:number;events:number}>(sql`select (select to_jsonb(d) from employee_draft d where d.id=${id}::uuid) as draft,(select count(*)::int from person where tenant_id=${b.tenantId}::uuid) as people,(select count(*)::int from employment where tenant_id=${b.tenantId}::uuid) as employments,(select count(*)::int from domain_event where tenant_id=${b.tenantId}::uuid) as events`);return row;}
describe('saved employee draft human activation',()=>{
 it('fully releases the rollback-only preview before actual native rows and completion event are written',async()=>{
  const d=await draft(),before=await snapshot(d.id);
  await withTenant(hr,async tx=>{
   const preview=await previewSavedEmployeeDraftActivationTx(tx,hr,{id:d.id,data:d.data,currentStep:4});expect(preview.compensation.basicSalary).toBe('3000.00');expect(await snapshot(d.id)).toEqual(before);
   const done=await saveAndCompleteEmployeeDraft(hr,{id:d.id,data:d.data,currentStep:4},tx);
   const [proof]=await tx.execute<{sameXmin:boolean}>(sql`select e.xmin=pg_current_xact_id()::xid and p.xmin=pg_current_xact_id()::xid and event.xmin=pg_current_xact_id()::xid as "sameXmin" from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join domain_event event on event.subject_employment_id=e.id and event.tenant_id=e.tenant_id where e.id=${done.employmentId}::uuid and event.event_type='employee-draft.completed' and event.aggregate_id=${d.id}::uuid`);expect(proof).toEqual({sameXmin:true});
  });
 });
 it('reviews every supported captured value, performs native hire once, and recovers its original receipt',async()=>{
  const d=await draft(),before=await snapshot(d.id),r=(await store.prepare(hr,human(d.id))).review;expect(r.review.reservedEmployeeCode).toBe(d.employeeCode);expect(Object.fromEntries(r.review.fields.map(row=>[row.section+'.'+row.key,row.value]))).toEqual(Object.fromEntries(Object.entries(d.data).flatMap(([section,fields])=>Object.entries(fields).map(([key,value])=>[section+'.'+key,value]))));expect(r.review.initialBasicSalary).toBe('3000.00');expect(await snapshot(d.id)).toEqual(before);
  const done=await store.confirm(hr,confirmation(r));expect(done.kind).toBe('completed');if(done.kind!=='completed')throw Error('Missing receipt');expect(done.receipt.receipt).toMatchObject({draftId:d.id,companyId:b.companyId,employeeCode:d.employeeCode});expect(await getEmployeeDraft(hr,d.id)).toBeNull();expect(await store.reopen(hr,r.actionId)).toEqual(done);expect(await store.confirm(hr,confirmation(r))).toEqual(done);
  const after=await snapshot(d.id);expect(after.people).toBe(before.people+1);expect(after.employments).toBe(before.employments+1);
  const rows=await owner.db.select({code:s.employment.employeeCode}).from(s.employment).where(eq(s.employment.id,done.receipt.receipt.employmentId));expect(rows).toEqual([{code:d.employeeCode}]);
  const pay=await owner.db.select({basic:s.compensation.basicSalary,allowance:s.compensation.monthlyAllowance}).from(s.compensation).where(eq(s.compensation.employmentId,done.receipt.receipt.employmentId));expect(pay).toEqual([{basic:'3000.00',allowance:'100.00'}]);
  // The completed custody row is written in the top-level command transaction. Native witnesses
  // must share that xmin; an inner activation savepoint cannot masquerade as the same transaction.
  const [proof]=await owner.db.execute<{sameXmin:boolean}>(sql`select r.xmin=e.xmin and r.xmin=p.xmin and r.xmin=d.xmin as "sameXmin" from app.assistant_own_leave_review r join employment e on e.id=r.employment_id join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join domain_event d on d.id=r.receipt_event_id where r.id=${r.actionId}::uuid`);expect(proof).toEqual({sameXmin:true});
 });
 it('rejects changed draft, wrong digest and changed company policy without a native write',async()=>{
  const d=await draft(),r=(await store.prepare(hr,human(d.id))).review,before=await snapshot(d.id);await expect(store.confirm(hr,{...confirmation(r),reviewedDigest:'0'.repeat(64)})).rejects.toThrow();expect(await snapshot(d.id)).toEqual(before);
  await saveEmployeeDraft(hr,{id:d.id,data:{...d.data,profile:{...d.data.profile,phone:'changed'}},currentStep:4});const changed=await snapshot(d.id);await expect(store.confirm(hr,confirmation(r))).rejects.toThrow();expect(await snapshot(d.id)).toEqual(changed);
  await store.discard(hr,{action:C.action,contractVersion:1,actionId:r.actionId});const fresh=(await store.prepare(hr,human(d.id))).review;await owner.db.update(s.company).set({currency:'USD'}).where(eq(s.company.id,b.companyId));const policy=await snapshot(d.id);await expect(store.confirm(hr,confirmation(fresh))).rejects.toThrow();expect(await snapshot(d.id)).toEqual(policy);
 });
 it('keeps bank, family, unknown profile fields and unreserved drafts in the native workflow',async()=>{
  const d=await draft();await saveEmployeeDraft(hr,{id:d.id,data:{...d.data,statutory:{bankName:'Private Bank',bankAccountNo:'00123'}},currentStep:3});const before=await snapshot(d.id);await expect(store.prepare(hr,human(d.id))).rejects.toThrow();expect(await snapshot(d.id)).toEqual(before);expect(await readEmployeeDraftActivationChoices(hr,{})).toMatchObject({kind:'choices',drafts:[{draftId:d.id,supported:false,unsupportedReason:'captured_shape',route:'/admin/personnel/new'}]});
  await saveEmployeeDraft(hr,{id:d.id,data:{...d.data,family:[{fullName:'Fictional Child',relationship:'child'}]},currentStep:5});await expect(store.prepare(hr,human(d.id))).rejects.toThrow();
  await saveEmployeeDraft(hr,{id:d.id,data:{...d.data,profile:{...d.data.profile,preferredName:'Captured additional field'}},currentStep:1});await expect(store.prepare(hr,human(d.id))).rejects.toThrow();
 });
 it('rolls back the entire Assistant command after a late native activation failure while retaining pending custody',async()=>{
  const d=await draft(),r=(await store.prepare(hr,human(d.id))).review,before=await snapshot(d.id);
  // The first completion event is rollback-only source preview; fail the second, real activation.
  await owner.client.unsafe("create sequence public.ai_draft_activation_fail_attempt");await owner.client.unsafe("create function public.ai_draft_activation_fail() returns trigger language plpgsql as $$begin if new.event_type='employee-draft.completed' then if nextval('public.ai_draft_activation_fail_attempt')%2=0 then raise exception 'fictional late failure' using errcode='23514';end if;end if;return new;end$$");await owner.client.unsafe('create trigger ai_draft_activation_fail before insert on domain_event for each row execute function public.ai_draft_activation_fail()');
  try{await expect(store.confirm(hr,confirmation(r))).rejects.toThrow();expect(await snapshot(d.id)).toEqual(before);const [review]=await owner.db.execute<{state:string;bodies:number}>(sql`select r.state,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where r.id=${r.actionId}::uuid`);expect(review).toEqual({state:'awaiting_confirmation',bodies:1});}finally{await owner.client.unsafe('drop trigger ai_draft_activation_fail on domain_event');await owner.client.unsafe('drop function public.ai_draft_activation_fail()');await owner.client.unsafe('drop sequence public.ai_draft_activation_fail_attempt');}
  expect((await store.confirm(hr,confirmation(r))).kind).toBe('completed');
 });
 it('preserves the default wizard savepoint behavior: attempted input is saved after native activation refusal',async()=>{
  const d=await draft(),attempt={...d.data,profile:{...d.data.profile,fullName:'Human attempted update'},employment:{...d.data.employment,departmentId:''}},before=await snapshot(d.id);await expect(saveAndCompleteEmployeeDraft(hr,{id:d.id,data:attempt,currentStep:2})).rejects.toThrow();const reopened=await getEmployeeDraft(hr,d.id);expect(reopened?.data.profile?.fullName).toBe('Human attempted update');expect(reopened?.data.employment?.departmentId).toBe('');const after=await snapshot(d.id);expect(after.people).toBe(before.people);expect(after.employments).toBe(before.employments);expect(after.events).toBe(before.events+1);
 });
 it('rejects forged model data and missing current role before exposing source or confirming',async()=>{
  const d=await draft();await expect(store.prepare(hr,{...human(d.id),data:d.data})).rejects.toThrow();const r=(await store.prepare(hr,human(d.id))).review,before=await snapshot(d.id);await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,hr.userId!));await expect(store.confirm(hr,confirmation(r))).rejects.toThrow();expect(await readEmployeeDraftActivationChoices(hr,{})).toEqual({kind:'unavailable'});expect(await snapshot(d.id)).toEqual(before);
 });
 it('requires current-transaction native event, matching created person/employment and removed exact Draft',async()=>{
  const d=await draft(),r=(await store.prepare(hr,human(d.id))).review;const native=await saveAndCompleteEmployeeDraft(hr,{id:d.id,data:d.data,currentStep:4});const [event]=await owner.db.execute<{id:string}>(sql`select id from domain_event where aggregate_id=${d.id}::uuid and event_type='employee-draft.completed'`);await expect(withTenant(hr,tx=>tx.execute(sql`select app.assistant_employee_draft_activation_command('complete',${r.actionId}::uuid,NULL,NULL,NULL,NULL,${r.reviewedDigest},NULL,NULL,NULL,${native.employmentId}::uuid,${event.id}::uuid)`))).rejects.toThrow();
 });
});

it('serializes duplicate human confirmations and retires expired preparation without a hire',async()=>{
 const d=await draft(),r=(await store.prepare(hr,human(d.id))).review;const [a,both]=await Promise.all([store.confirm(hr,confirmation(r)),store.confirm(hr,confirmation(r))]);expect(a).toEqual(both);if(a.kind!=='completed')throw Error('Expected completion');const events=await owner.db.select({id:s.domainEvent.id}).from(s.domainEvent).where(sql`${s.domainEvent.aggregateId}=${d.id}::uuid and ${s.domainEvent.eventType}='employee-draft.completed'`);expect(events).toHaveLength(1);
 const second=await draft(),expired=(await store.prepare(hr,human(second.id))).review,before=await snapshot(second.id);await owner.db.execute(sql`update app.assistant_own_leave_review set expires_at=clock_timestamp()-interval '1 second' where id=${expired.actionId}::uuid`);expect(await store.confirm(hr,confirmation(expired))).toMatchObject({kind:'retired',receipt:{state:'expired'}});expect(await snapshot(second.id)).toEqual(before);
});
it('keeps SQL helper access private and null or forged operations closed',async()=>{
 await expect(withTenant(hr,tx=>tx.execute(sql`select app.assistant_employee_draft_activation_command(NULL)`))).rejects.toThrow();
 await expect(withTenant(hr,tx=>tx.execute(sql`select app.assistant_employee_draft_activation_command('approve')`))).rejects.toThrow();
 await expect(withTenant(hr,tx=>tx.execute(sql`select app._assistant_employee_draft_activation_json(${randomUUID()}::uuid)`))).rejects.toThrow();
});

it('previews native compensation currency and normalized decimal inputs without changing native creation semantics',async()=>{
 const d=await draft();await owner.db.update(s.company).set({currency:'SGD'}).where(eq(s.company.id,b.companyId));const data={...d.data,payroll:{...d.data.payroll,basicSalary:'3,000.129',monthlyAllowance:'1_0.126'}};await saveEmployeeDraft(hr,{id:d.id,data,currentStep:4});const before=await snapshot(d.id),r=(await store.prepare(hr,human(d.id))).review;
 expect(r.review.currency).toBe('MYR');expect(r.review.initialBasicSalary).toBe('3000.13');expect(r.review.initialMonthlyAllowance).toBe('10.13');expect(await snapshot(d.id)).toEqual(before);
 const done=await store.confirm(hr,confirmation(r));if(done.kind!=='completed')throw Error('Missing receipt');const [pay]=await owner.db.select({currency:s.compensation.currency,basic:s.compensation.basicSalary,allowance:s.compensation.monthlyAllowance}).from(s.compensation).where(eq(s.compensation.employmentId,done.receipt.receipt.employmentId));expect(pay).toEqual({currency:r.review.currency,basic:r.review.initialBasicSalary,allowance:r.review.initialMonthlyAllowance});
});
it.each(['template','eligibility'] as const)('binds the exact opening grants and refuses a changed %s source after review',async kind=>{
 const template=await createEntitlementTemplate(hr,{leaveTypeId:b.annualLeaveTypeId,name:'Fictional native opening table',serviceBands:[{fromYears:0,toYears:null,days:18}],validFrom:'2026-01-01'});const rule=await createEligibilityRule(hr,{name:'Fictional native opening population',templateLineageId:template.lineageId,criteria:{companyIds:[b.companyId]},validFrom:'2026-01-01'});const d=await draft(),before=await snapshot(d.id),r=(await store.prepare(hr,human(d.id))).review;
 expect(await snapshot(d.id)).toEqual(before);expect(r.review.openingLeaveGrants).toHaveLength(1);expect(Number(r.review.openingLeaveGrants[0].days)).toBeGreaterThan(0);expect(r.review.openingLeaveGrants.every(g=>g.days.match(/^\d+\.\d{2}$/)&&g.effectiveOn===d.data.employment.hiredOn)).toBe(true);
 if(kind==='template')await owner.db.update(s.entitlementTemplate).set({serviceBands:[{fromYears:0,toYears:null,days:25}]}).where(eq(s.entitlementTemplate.id,template.id));else await owner.db.update(s.entitlementEligibilityRule).set({criteria:{companyIds:[b.companyId],employmentTypes:['contract']}}).where(eq(s.entitlementEligibilityRule.id,rule.id));
 const changed=await snapshot(d.id);await expect(store.confirm(hr,confirmation(r))).rejects.toThrow();expect(await snapshot(d.id)).toEqual(changed);
 await store.discard(hr,{action:C.action,contractVersion:1,actionId:r.actionId});const fresh=(await store.prepare(hr,human(d.id))).review,done=await store.confirm(hr,confirmation(fresh));if(done.kind!=='completed')throw Error('Missing receipt');const ledger=await owner.db.execute<{leaveTypeId:string;code:string;name:string;entryType:string;days:string;effectiveOn:string}>(sql`select l.leave_type_id as "leaveTypeId",t.code,t.name,l.entry_type::text as "entryType",l.days,l.effective_on::text as "effectiveOn" from leave_ledger l join leave_type t on t.id=l.leave_type_id and t.tenant_id=l.tenant_id where l.employment_id=${done.receipt.receipt.employmentId}::uuid order by l.leave_type_id,l.entry_type,l.effective_on,l.days`);expect(Array.from(ledger)).toEqual(fresh.review.openingLeaveGrants);
});
it('hands active configured onboarding synchronization to the native workflow before preview or preparation',async()=>{
 const d=await draft();await setModule(b.tenantId,'lifecycle','active');const {defaultConfig}=await import('../lib/onboarding-model');await owner.db.insert(s.lcOnboardingConfig).values({tenantId:b.tenantId,revision:1,data:defaultConfig(hr.userId!)});const fresh={...hr,...await entitledCtx(b,['hr_admin']),userId:hr.userId,personId:hr.personId,grants:hr.grants},before=await snapshot(d.id);
 expect(await readEmployeeDraftActivationChoices(fresh,{})).toMatchObject({kind:'choices',drafts:[{draftId:d.id,supported:false,unsupportedReason:'configured_onboarding'}]});await expect(store.prepare(fresh,human(d.id))).rejects.toThrow();expect(await snapshot(d.id)).toEqual(before);
});
it('does not list the previous person’s review after this login is relinked to another person',async()=>{
 const d=await draft(),r=(await store.prepare(hr,human(d.id))).review,other=await hireEmployee(group(),{person:{fullName:'Fictional new linked person',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',hiredOn:todayInKualaLumpur()});await owner.db.update(s.appUser).set({personId:other.personId}).where(eq(s.appUser.id,hr.userId!));const fresh={...hr,personId:other.personId};expect((await store.list(fresh)).reviews).toEqual([]);await expect(store.reopen(fresh,r.actionId)).rejects.toThrow();
});
