/** Authored UNRUN: actual fictional Payroll CLOSE/native custody. Coordinated drafts required.
 * No fixture represents production data, a model capability test, or a passing security gate. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import * as vault from '../lib/pii/vault';
import {hireEmployee,changeEmploymentCompany} from '../core/org';
import {createMovementEvent} from '../core/movement';
import {assignRole,revokeRole} from '../core/admin';
import {setCompensation} from '../core/comp';
import {requirePackFor} from '../localization/registry';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {payslipReleaseAt} from '../core/payroll-policy-config';
import {setPayrollConfig} from '../core/payroll-config';
import {erasePersonPii} from '../core/pdpa';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {createBatch,createAdditionalRun,generatePayslips,setPayrollInput,unlockClosedBatch,setPayrollPermissionGrant} from '../packs/payroll/service';
import {prepareReviewedPayrollCloseSourceTx,confirmReviewedPayrollCloseSourceTx} from '../core/assistant-actions/reviewed-payroll-close-source';
import {preparePayrollCloseReview,confirmPayrollCloseReview,reopenPayrollCloseReview,discardPayrollCloseReview,listPayrollCloseReviews} from '../core/assistant-actions/payroll-close-review-store';
import {PayrollClosePreparedReview,PayrollCloseReviewConfirmation,PayrollCloseReviewRetirement} from '../lib/assistant-actions/payroll-close-review-contract';
import {REVIEWED_PAYROLL_CLOSE_ACTION as action} from '../lib/assistant-actions/reviewed-payroll-close-contract';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';
let b:Base,ctx:SessionContext,outsider:SessionContext,employmentId:string,personId:string,batchId:string,period:string;
const uuidArray=(ids:readonly string[])=>sql`ARRAY[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
const human=()=>({action,contractVersion:1,batchId,confirmCloseProcessedRun:true});
const confirmation=(r:{actionId:string;reviewedDigest:string})=>({action,contractVersion:1,actionId:r.actionId,reviewedDigest:r.reviewedDigest});
const retirement=(r:{actionId:string})=>({action,contractVersion:1,actionId:r.actionId});
async function prepare(){const result=await preparePayrollCloseReview(ctx,human());if(result.kind!=='prepared')throw Error('Expected prepared fictional review');return result.review;}
const confirm=(r:{actionId:string;reviewedDigest:string},who=ctx)=>confirmPayrollCloseReview(who,confirmation(r));
async function custody(id:string){const [row]=await owner.db.execute<Record<string,unknown>>(sql`select r.*,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where r.id=${id}::uuid`);return row;}
async function financial(){return{batches:await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.tenantId,b.tenantId)).orderBy(s.payrollBatch.id),periods:await owner.db.select().from(s.payPeriod).where(eq(s.payPeriod.tenantId,b.tenantId)).orderBy(s.payPeriod.id),slips:await owner.db.select().from(s.payslip).where(eq(s.payslip.tenantId,b.tenantId)).orderBy(s.payslip.id),events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id)};}
beforeAll(async()=>{await migrateTestDb();const [installed]=await owner.db.execute<{ok:boolean}>(sql`select to_regprocedure('app.assistant_payroll_close_review_complete(uuid,text,uuid)') is not null and to_regprocedure('app.payroll_close_source_people(uuid,uuid,uuid[])') is not null as ok`);expect(installed.ok,'Coordinated Payroll close custody/source drafts must be installed.').toBe(true);});afterAll(closeAll);afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();});beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-payroll-close-custody-key-1234');await resetDb();b=await seedBase();for(const code of ['assistant','payroll','multi_cycle_payroll'] as const)await setModule(b.tenantId,code,'active');const [actor]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional Payroll close actor',primaryEmail:randomUUID()+'@fixture.test'}).returning();await owner.db.update(s.appUser).set({personId:actor.id}).where(eq(s.appUser.id,b.adminUserId));ctx={...await entitledCtx(b,['hr_admin']),personId:actor.id,grants:[{role:'hr_admin',companyId:null}]};await grantAssistant(ctx,{appUserId:b.adminUserId});const [year,month]=todayInKualaLumpur().split('-').map(Number);period=new Date(Date.UTC(year,month-2,1)).toISOString().slice(0,7);const hiredOn=String(year-2)+'-01-01',hired=await hireEmployee(ctx,{person:{fullName:'PRIVATE fictional Payroll employee',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn});employmentId=hired.employmentId;personId=hired.personId;await setCompensation(ctx,{employmentId,basicSalary:5000,effectiveFrom:hiredOn});await requirePackFor('MY').statutory.set(ctx,{personId,icNumber:'900101019885'});batchId=(await createBatch(ctx,{companyId:b.companyId,payPeriod:period})).batchId;await generatePayslips(ctx,{batchId});const [other]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional separate login',primaryEmail:randomUUID()+'@fixture.test'}).returning(),userId=await createAppUser(b.tenantId,other.id,'employee');outsider={...await entitledCtx(b,['employee']),userId,personId:other.id,grants:[{role:'employee',companyId:null}]};await grantAssistant(ctx,{appUserId:userId});});
describe('failed-only Payroll close custody fixture regressions',()=>{
it.each(['confirm','erase'] as const)('preserves both actual source people through encrypted preparation/reopen and %s retirement',async mode=>{
  const hiredOn=String(Number(period.slice(0,4))-1)+'-01-01',second=await hireEmployee(ctx,{person:{fullName:'PRIVATE fictional second Payroll source',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn});
  await setCompensation(ctx,{employmentId:second.employmentId,basicSalary:3500,effectiveFrom:hiredOn});
  await requirePackFor('MY').statutory.set(ctx,{personId:second.personId,icNumber:'900101019886'});
  batchId=(await createAdditionalRun(ctx,{companyId:b.companyId,payPeriod:period,runType:'bonus'})).batchId;
  for(const id of [employmentId,second.employmentId])await setPayrollInput(ctx,{batchId,employmentId:id,overtimeAmount:0,bonusAmount:100});
  await generatePayslips(ctx,{batchId});
  const before=await financial(),r=await prepare(),people=[personId,second.personId].sort();
  expect(r.review.visiblePayslipCount).toBe(2);
  expect(await custody(r.actionId)).toMatchObject({state:'awaiting_confirmation',payroll_review_person_ids:people,bodies:1});
  expect((await reopenPayrollCloseReview(ctx,r.actionId)).kind).toBe('prepared');
  expect(await financial()).toEqual(before);
  if(mode==='confirm'){
   const done=await confirm(r);if(done.kind!=='completed')throw Error('Expected completed two-person close');
   const after=await financial(),events=after.events.filter(row=>!before.events.some(old=>old.id===row.id)&&row.eventType==='payroll-batch.closed');
   expect(events).toHaveLength(1);expect(events[0].id).toBe(done.receipt.receipt.closedEventId);
   expect(after.slips).toEqual(before.slips);
   expect(await custody(r.actionId)).toMatchObject({state:'completed',bodies:0,payroll_review_person_ids:null});
   expect((await reopenPayrollCloseReview(ctx,r.actionId)).kind).toBe('completed');
   expect((await confirm(r)).kind).toBe('completed');expect(await financial()).toEqual(after);
  }else{
   await erasePersonPii(ctx,{subjectEmploymentId:second.employmentId,scope:'contact',requestRef:'FICTIONAL-SECOND-PAYROLL-SOURCE',reason:'Fictional second source-person erasure'});
   const after=await financial(),event=after.events.find(row=>!before.events.some(old=>old.id===row.id)&&row.eventType==='pii.erased')!;
   const [intent]=await owner.db.execute<{ids:string[]}>(sql`select review_ids as ids from app.assistant_review_erasure_intent where event_id=${event.id}::uuid`);
   expect(intent.ids).toContain(r.actionId);
   expect(await custody(r.actionId)).toMatchObject({state:'refused',bodies:0,payroll_review_person_ids:null,intent_digest:null,reviewed_digest:null});
   expect(after.batches).toEqual(before.batches);expect(after.periods).toEqual(before.periods);expect(after.slips).toEqual(before.slips);
  }
 });
it('retains the actually hidden transferred-out payee association for erasure without disclosing that person in the scoped partner review',async()=>{const [actor]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional outgoing Payroll caller',primaryEmail:randomUUID()+'@fixture.test'}).returning(),userId=await createAppUser(b.tenantId,actor.id,'employee');await assignRole(ctx,{appUserId:userId,role:'payroll_partner',companyId:b.companyId});await grantAssistant(ctx,{appUserId:userId});await setPayrollPermissionGrant(ctx,{companyId:b.companyId,permissionKey:'payroll.close',role:'payroll_partner',allowed:true});const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional actual transfer destination',companyLabel:'FIC_PRIV_DEST'}).returning(),[department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:other.id,name:'Fictional transferred department'}).returning();await createMovementEvent(ctx,{employmentId,kind:'entityTransfer',effectiveDate:todayInKualaLumpur(),companyId:other.id,departmentId:department.id});const who={...await entitledCtx(b,['employee','payroll_partner']),userId,personId:actor.id,grants:[{role:'employee' as const,companyId:null},{role:'payroll_partner' as const,companyId:b.companyId}]},result=await preparePayrollCloseReview(who,human());if(result.kind!=='prepared')throw Error('Expected outgoing scoped review');expect(result.review.review).toMatchObject({recordedEmployeeCount:1,visiblePayslipCount:0});expect(JSON.stringify(result)).not.toContain(personId);expect((await custody(result.review.actionId)).payroll_review_person_ids).toEqual([personId]);const before=await financial();await erasePersonPii(ctx,{subjectEmploymentId:employmentId,scope:'contact',requestRef:'FICTIONAL-HIDDEN-PAYROLL-ERASURE',reason:'Fictional transferred payee erasure'});expect(await custody(result.review.actionId)).toMatchObject({state:'refused',bodies:0,payroll_review_person_ids:null});const after=await financial();expect(after.batches).toEqual(before.batches);expect(after.slips).toEqual(before.slips);});
it('source-person projection rejects duplicate/unsorted/unrelated actual source IDs rather than accepting arbitrary tenant people',async()=>{const hiredOn=String(Number(todayInKualaLumpur().slice(0,4))-2)+'-01-01',unrelated=await hireEmployee(ctx,{person:{fullName:'Fictional unrelated current employee',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn});const [row]=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId));for(const ids of [[employmentId,employmentId],[randomUUID()],[unrelated.employmentId]])await expect(withTenant(ctx,tx=>tx.execute(sql`select app.payroll_close_source_people(${batchId}::uuid,NULL::uuid,${uuidArray(ids)})`))).rejects.toThrow();const [projection]=await withTenant(ctx,tx=>tx.execute<{people:string[]}>(sql`select app.payroll_close_source_people(${batchId}::uuid,NULL::uuid,${uuidArray([employmentId])}) as people`));expect(projection.people).toEqual([personId]);expect(row.status).toBe('processed');});
// Exact millisecond timestamps plus deliberate tied pairs make the public ISO order comparable;
// unconstrained clock_timestamp microseconds must not be reinterpreted as millisecond UUID ties.
it('metadata index is own/login-only, stable newest25, and has no native run/company/person/token selectors',async()=>{const [batch]=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId)),ids=Array.from({length:27},()=>randomUUID()),createdBase=Date.now()-3600000;for(const [index,id] of ids.entries())await owner.db.execute(sql`insert into app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,payroll_close_batch_id,payroll_close_period_id,state,created_at,expires_at) values('payroll.close',${id}::uuid,${b.tenantId}::uuid,${ctx.userId}::uuid,${ctx.personId}::uuid,NULL,${b.companyId}::uuid,${batchId}::uuid,${batch.payPeriodId}::uuid,'discarded',${new Date(createdBase+Math.floor(index/2)*10).toISOString()}::timestamptz,clock_timestamp()+interval '1 hour')`);const index=await listPayrollCloseReviews(ctx);expect(index.reviews).toHaveLength(25);for(const row of index.reviews)expect(Object.keys(row).sort()).toEqual(['action','actionId','contractVersion','createdAt','expiresAt','state']);const sorted=[...index.reviews].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.actionId.localeCompare(a.actionId));expect(index.reviews).toEqual(sorted);const nativeOrder=await owner.db.execute<{id:string}>(sql`select id from app.assistant_own_leave_review where tenant_id=${b.tenantId}::uuid and user_id=${ctx.userId}::uuid and action_kind='payroll.close' order by created_at desc,id desc limit 25`);expect(index.reviews.map(row=>row.actionId)).toEqual(nativeOrder.map(row=>row.id));expect((await listPayrollCloseReviews(outsider)).reviews).toEqual([]);});
});
