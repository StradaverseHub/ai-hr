/** Native salary commands and encrypted existing-ledger review; fictional source values only. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {createCompany,createDepartment} from '../core/admin';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {setCompensation,updateCompensation,supersedeCompensation} from '../core/comp';
import {createBatch} from '../packs/payroll/service';
import {compensationMaintenanceReviews as store,readCompensationMaintenanceChoices} from '../core/assistant-actions/compensation-maintenance-review-store';
import {CompensationMaintenance as C} from '../lib/assistant-actions/compensation-maintenance-contract';
import {readCompletedNativeOutcomeTx} from '../core/assistant-actions/completed-outcome-readers';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,subject:{employmentId:string;personId:string},hrPerson:{employmentId:string;personId:string},other:{employmentId:string;personId:string},hr:SessionContext;
const group=(base:Base=b)=>({...adminCtx(base),grants:[{role:'hr_admin' as const,companyId:null}]});
const hire=(name:string,base:Base=b,companyId=base.companyId,departmentId=base.deptA)=>hireEmployee(group(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId,departmentId,employmentType:'full_time',hiredOn:'2025-01-01'});
async function login(personId:string,role:'hr_admin'|'super_admin'|'employee'|'manager'='hr_admin',base:Base=b,companyId:string|null=null):Promise<SessionContext>{const userId=await createAppUser(base.tenantId,personId,role);if(companyId)await owner.db.update(s.roleAssignment).set({companyId}).where(eq(s.roleAssignment.appUserId,userId));await grantAssistant(group(base),{appUserId:userId});return{...await entitledCtx(base,[role]),userId,personId,grants:[{role,companyId}]};}
const fields=()=>({basicSalary:'2750.29',currency:'SGD',payMode:'monthly' as const,paymentTerm:'monthly' as const,rateAmount:null,remarks:'Fictional human salary change',effectiveFrom:'2026-06-01'});
const human=(operation:'set'|'edit'|'supersede'='set',id:string|null=null)=>C.Human.parse({action:C.action,contractVersion:1,employmentId:subject.employmentId,subjectId:subject.employmentId,operation,compensationId:id,fields:operation==='supersede'?null:fields()});
async function snapshot(){
 const history=await owner.db.select().from(s.compensation).where(eq(s.compensation.tenantId,b.tenantId)).orderBy(s.compensation.id),events=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.sequence),batches=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.tenantId,b.tenantId)).orderBy(s.payrollBatch.id);
 const queues=await owner.db.execute<{schema:string;name:string}>(sql`select n.nspname as schema,c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app') and c.relkind='r' and c.relname ~ '(outbox|notification|delivery_queue)' order by n.nspname,c.relname`);
 const counts=[];for(const queue of queues){const [count]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from ${sql.identifier(queue.schema)}.${sql.identifier(queue.name)}`);counts.push([queue.schema,queue.name,count.n]);}
 return{history,events,batches,counts};
}
async function seededSalary(){return setCompensation(hr,{employmentId:subject.employmentId,basicSalary:2000.17,currency:'MYR',monthlyAllowance:123.45,effectiveFrom:'2026-01-01',remarks:'Fictional original salary'});}
async function paidPeriod(status:'processed'|'closed'='processed'){
 const {batchId}=await createBatch(group(),{companyId:b.companyId,payPeriod:'2026-05'});
 await owner.db.insert(s.payslip).values({tenantId:b.tenantId,batchId,employmentId:subject.employmentId,basicSalary:'2000.17',grossPay:'2000.17',statutory:{},totalDeductions:'0.00',netPay:'2000.17',employerCost:'2000.17'});
 await owner.db.update(s.payrollBatch).set({status}).where(eq(s.payrollBatch.id,batchId));return batchId;
}
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-compensation-custody-secret');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');subject=await hire('Fictional Salary Employee');hrPerson=await hire('Fictional Salary HR');other=await hire('Fictional Unrelated Employee');hr=await login(hrPerson.personId);});

describe('Human compensation maintenance',()=>{
 it.each(['set','edit','supersede'] as const)('%s prepares through the native command without persisting history, events, stale marks or outgoing work',async operation=>{
  const original=await seededSalary();await paidPeriod();const before=await snapshot();
  const input=human(operation,operation==='set'?null:original.compensationId);if(operation!=='supersede')input.fields!.effectiveFrom='2026-06-01';
  const r=(await store.prepare(hr,input)).review;expect(await snapshot()).toEqual(before);expect(r.content).toEqual(input);expect(r.review.changes.length).toBeGreaterThan(0);expect(r.review.recalculationPeriods).toEqual(operation==='set'?[]:['2026-05']);
  const [first,duplicate]=await Promise.all([store.confirm(hr,{actionId:r.actionId,reviewedDigest:r.reviewedDigest}),store.confirm(hr,{actionId:r.actionId,reviewedDigest:r.reviewedDigest})]);
  expect(first).toEqual(duplicate);if(first.kind!=='completed')throw Error('Expected canonical salary receipt');
  expect(await store.reopen(hr,r.actionId)).toEqual(first);expect(await store.confirm(hr,{actionId:r.actionId,reviewedDigest:r.reviewedDigest})).toEqual(first);
  const done=await snapshot(),nativeEvents=done.events.filter(event=>['compensation.set','compensation.updated','compensation.superseded'].includes(event.eventType));
  expect(nativeEvents).toHaveLength(2);expect(nativeEvents.filter(event=>event.id===first.receipt.receipt.eventId)).toHaveLength(1);
  expect(nativeEvents.find(event=>event.id===first.receipt.receipt.eventId)).toMatchObject({actorId:hr.userId,subjectEmploymentId:subject.employmentId,aggregateId:first.receipt.receipt.compensationId});
  const [custody]=await owner.db.execute<{state:string;bodies:number}>(sql`select state,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where id=${r.actionId}::uuid`);expect(custody).toEqual({state:'completed',bodies:0});
  const outcome=await withTenant(hr,tx=>readCompletedNativeOutcomeTx(tx,hr,{source:'review',action:C.action,actionId:r.actionId}));expect(outcome.evidence.eventId).toBe(first.receipt.receipt.eventId);
 });

 it('reviews exact currency, amount and adjacent history consequences for revision, date correction and removal',async()=>{
  const previous=await seededSalary(),r=(await store.prepare(hr,human())).review;
  expect(r.review.changes).toEqual(expect.arrayContaining([expect.objectContaining({id:previous.compensationId,before:expect.objectContaining({validTo:null,basicSalary:'2000.17',currency:'MYR'}),after:expect.objectContaining({validTo:'2026-06-01'})}),expect.objectContaining({id:null,before:null,after:expect.objectContaining({basicSalary:'2750.29',currency:'SGD',monthlyAllowance:'123.45',validFrom:'2026-06-01'})})]));
  const done=await store.confirm(hr,{actionId:r.actionId,reviewedDigest:r.reviewedDigest});if(done.kind!=='completed')throw Error('Expected completion');
  const edit=human('edit',done.receipt.receipt.compensationId);edit.fields!.effectiveFrom='2026-07-01';const correction=(await store.prepare(hr,edit)).review;
  expect(correction.review.changes).toEqual(expect.arrayContaining([expect.objectContaining({id:previous.compensationId,after:expect.objectContaining({validTo:'2026-07-01'})})]));
  await store.discard(hr,{actionId:correction.actionId});
  const removal=(await store.prepare(hr,human('supersede',done.receipt.receipt.compensationId))).review;
  expect(removal.review.changes).toEqual(expect.arrayContaining([expect.objectContaining({id:previous.compensationId,after:expect.objectContaining({validTo:null})}),expect.objectContaining({id:done.receipt.receipt.compensationId,after:expect.objectContaining({superseded:true})})]));
 });

 it('refuses changed salary history or changed payroll evidence after review and keeps pending custody intact',async()=>{
  const original=await seededSalary(),r=(await store.prepare(hr,human('edit',original.compensationId))).review;
  await updateCompensation(hr,{employmentId:subject.employmentId,compensationId:original.compensationId,remarks:'Fictional changed native record'});const changed=await snapshot();
  await expect(store.confirm(hr,{actionId:r.actionId,reviewedDigest:r.reviewedDigest})).rejects.toThrow();expect(await snapshot()).toEqual(changed);
  await store.discard(hr,{actionId:r.actionId});const second=(await store.prepare(hr,human('supersede',original.compensationId))).review;await paidPeriod('closed');const closed=await snapshot();
  await expect(store.confirm(hr,{actionId:second.actionId,reviewedDigest:second.reviewedDigest})).rejects.toThrow();expect(await snapshot()).toEqual(closed);
  const [pending]=await owner.db.execute(sql`select state,receipt_event_id from app.assistant_own_leave_review where id=${second.actionId}::uuid`);expect(pending).toMatchObject({state:'awaiting_confirmation',receipt_event_id:null});
 });

 it('preserves native failure rules for historical edit, closed removal, mode boundary and zero-basic remark, with rollback',async()=>{
  const original=await seededSalary();await setCompensation(hr,{employmentId:subject.employmentId,basicSalary:2500,effectiveFrom:'2026-06-01'});const before=await snapshot();
  await expect(store.prepare(hr,human('edit',original.compensationId))).rejects.toThrow();
  const invalid=human();invalid.fields={...fields(),payMode:'daily',rateAmount:'100.00',effectiveFrom:'2026-07-15'};await expect(store.prepare(hr,invalid)).rejects.toThrow();
  const zero=human();zero.fields={...fields(),basicSalary:'0.00',remarks:null};await expect(store.prepare(hr,zero)).rejects.toThrow();expect(await snapshot()).toEqual(before);
  await paidPeriod('closed');const closed=await snapshot();await expect(supersedeCompensation(hr,{employmentId:subject.employmentId,compensationId:original.compensationId})).rejects.toThrow();await expect(store.prepare(hr,human('supersede',original.compensationId))).rejects.toThrow();expect(await snapshot()).toEqual(closed);
 });

 it('refuses forged authority/subject and money payloads, another company or tenant, and self even as super admin',async()=>{
  const before=await snapshot();for(const extra of [{service:'erasePersonPii'},{decision:'approved'},{basicSalary:'999.00'},{fields:{...fields(),basicSalary:'NaN'}},{fields:{...fields(),basicSalary:'1e6'}},{fields:{...fields(),basicSalary:'-1.00'}},{fields:{...fields(),currency:'BAD'}}])await expect(store.prepare(hr,{...human(),...extra})).rejects.toThrow();
  const self=await login(subject.personId,'super_admin');await expect(store.prepare(self,human())).rejects.toThrow();const employee=await login(other.personId,'employee');await expect(store.prepare(employee,human())).rejects.toThrow();
  const company=await createCompany(group(),{legalName:'Other Salary Company'}),department=await createDepartment(group(),{companyId:company.id,name:'Other'}),companyHr=await login((await hire('Other Salary HR',b,company.id,department.id)).personId,'hr_admin',b,company.id);
  await expect(store.prepare(companyHr,human())).rejects.toThrow();expect(await readCompensationMaintenanceChoices(companyHr,{query:'',employmentId:subject.employmentId})).toEqual({kind:'unavailable'});
  const foreign=await seedBase();await setModule(foreign.tenantId,'assistant','active');const foreignHr=await login((await hire('Foreign Salary HR',foreign)).personId,'hr_admin',foreign);await expect(store.prepare(foreignHr,human())).rejects.toThrow();
  const now=await snapshot();expect(now.history).toEqual(before.history);expect(now.events.filter(event=>event.aggregateType==='compensation')).toEqual([]);
 });

 it('refuses a wrong digest, another login and revoked grant or role before effects',async()=>{
  const r=(await store.prepare(hr,human())).review,before=await snapshot(),second=await login(hrPerson.personId);
  await expect(store.confirm(hr,{actionId:r.actionId,reviewedDigest:'0'.repeat(64)})).rejects.toThrow();await expect(store.confirm(second,{actionId:r.actionId,reviewedDigest:r.reviewedDigest})).rejects.toThrow();
  await revokeAssistant(group(),{appUserId:hr.userId!});await expect(store.confirm(hr,{actionId:r.actionId,reviewedDigest:r.reviewedDigest})).rejects.toThrow();await grantAssistant(group(),{appUserId:hr.userId!});await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,hr.userId!));await expect(store.confirm(hr,{actionId:r.actionId,reviewedDigest:r.reviewedDigest})).rejects.toThrow();
  const after=await snapshot();expect(after.history).toEqual(before.history);expect(after.events.filter(event=>event.aggregateType==='compensation')).toEqual([]);
 });

 it('refuses an earlier native transaction as SQL completion proof',async()=>{
  const r=(await store.prepare(hr,human())).review,native=await setCompensation(hr,{employmentId:subject.employmentId,basicSalary:2750.29,currency:'SGD',effectiveFrom:'2026-06-01'});
  const [event]=await owner.db.execute<{id:string}>(sql`select id from public.domain_event where aggregate_id=${native.compensationId}::uuid and event_type='compensation.set'`);
  await expect(withTenant(hr,tx=>tx.execute(sql`select app.assistant_assigned_review_complete(${r.actionId}::uuid,${C.action},${r.reviewedDigest},${event.id}::uuid)`))).rejects.toThrow();
 });

 it('refuses a busy exclusive payroll-history owner without waiting or writing',async()=>{
  const before=await snapshot();await owner.db.transaction(async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'payroll-history:'+b.tenantId},0))`);
   await expect(store.prepare(hr,human())).rejects.toThrow();
  });expect(await snapshot()).toEqual(before);
 });

 it('preserves the public edit default while joining an explicit enclosing transaction',async()=>{
  const original=await seededSalary();const before=await snapshot();
  await expect(withTenant(hr,async tx=>{await updateCompensation(hr,{employmentId:subject.employmentId,compensationId:original.compensationId,basicSalary:3000},tx);throw Error('fictional outer rollback');})).rejects.toThrow('fictional outer rollback');expect(await snapshot()).toEqual(before);
  await updateCompensation(hr,{employmentId:subject.employmentId,compensationId:original.compensationId,basicSalary:3000});expect((await snapshot()).history[0].basicSalary).toBe('3000.00');
 });
});
