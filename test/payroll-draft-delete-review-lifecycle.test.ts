/** Native draft deletion must remain available after Assistant reset/reopen custody.
 * Fictional real encrypted reviews; desired native outcome, no accepted FK failure.
 * Reproduction-only checkpoint: no migration or production repair is included. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {erasePersonPii} from '../core/pdpa';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {requirePackFor} from '../localization/registry';
import {grantAssistant} from '../core/assistant-grant';
import {createBatch,generatePayslips,closeBatch,resetProcessedBatch,deleteDraftBatch,createAdditionalRun} from '../packs/payroll/service';
import {preparePayrollResetReview,confirmPayrollResetReview,discardPayrollResetReview,reopenPayrollResetReview} from '../core/assistant-actions/payroll-reset-review-store';
import {preparePayrollReopenReview,confirmPayrollReopenReview} from '../core/assistant-actions/payroll-reopen-review-store';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';
let b:Base,ctx:SessionContext,batchId:string,periodId:string,period:string,employmentId:string;
const reason='Fictional native lifecycle correction';
const resetHuman=()=>({action:'payroll.reset' as const,contractVersion:1 as const,batchId,reason,confirmResetProcessedRun:true,acknowledgePayslipLoanClaimConsequences:true});
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-payroll-lifecycle-key-123456');await resetDb();b=await seedBase();
 for(const code of ['assistant','payroll','multi_cycle_payroll'] as const)await setModule(b.tenantId,code,'active');
 ctx={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};await grantAssistant(ctx,{appUserId:b.adminUserId});
 const year=Number(todayInKualaLumpur().slice(0,4));period=String(year-1)+'-08';
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional lifecycle employee',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:String(year-2)+'-01-01'});
 employmentId=hired.employmentId;
 await setCompensation(ctx,{employmentId:hired.employmentId,basicSalary:5000,effectiveFrom:String(year-2)+'-01-01'});
 await requirePackFor('MY').statutory.set(ctx,{personId:hired.personId,icNumber:'900101019885'});
 batchId=(await createBatch(ctx,{companyId:b.companyId,payPeriod:period})).batchId;await generatePayslips(ctx,{batchId});
 await setSetting(b.tenantId,'payroll.reset_enabled',true);await setSetting(b.tenantId,'payroll.unlock_enabled',true);
 ctx={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};
 const [batch]=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId));periodId=batch.payPeriodId;
});
async function prepareReset(){const r=await preparePayrollResetReview(ctx,resetHuman());if(r.kind!=='prepared')throw Error('Expected real encrypted reset review');return r.review;}
async function deletionState(){return{
 batch:await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId)),
 parent:await owner.db.select().from(s.payPeriod).where(eq(s.payPeriod.id,periodId)),
 slips:await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,batchId)).orderBy(s.payslip.id),
 history:await owner.db.select().from(s.payrollStatusHistory).where(eq(s.payrollStatusHistory.batchId,batchId)).orderBy(s.payrollStatusHistory.id),
 events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id),
 reviews:await owner.db.execute(sql`select to_jsonb(r) as row from app.assistant_own_leave_review r where tenant_id=${b.tenantId}::uuid order by id`),
 bodies:await owner.db.execute(sql`select to_jsonb(c) as row from app.assistant_own_leave_review_content c join app.assistant_own_leave_review r on r.id=c.action_id where r.tenant_id=${b.tenantId}::uuid order by c.action_id`),
};}
async function deleteAndAssert(parentSurvives=false){
 const before=await deletionState();
 // Preserve the actual SQLSTATE/constraint in hosted logs if the desired native operation fails.
 try{expect(await deleteDraftBatch(ctx,{batchId})).toEqual({id:batchId});}catch(error){
  const e=error as {code?:string;constraint_name?:string;cause?:{code?:string;constraint_name?:string}};
  console.error('Fictional lifecycle deletion failure',e.cause?.code??e.code,e.cause?.constraint_name??e.constraint_name);expect(await deletionState(),'failed native deletion must roll back teardown, events and review changes').toEqual(before);throw error;
 }
 expect(await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId))).toEqual([]);
 expect(await owner.db.select().from(s.payPeriod).where(eq(s.payPeriod.id,periodId))).toEqual(parentSurvives?before.parent:[]);
 const events=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId,batchId));expect(events.filter(e=>e.eventType==='payroll-batch.deleted')).toHaveLength(1);
 const [body]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from app.assistant_own_leave_review_content c join app.assistant_own_leave_review r on r.id=c.action_id where r.tenant_id=${b.tenantId}::uuid and (r.payroll_reset_batch_id=${batchId}::uuid or r.payroll_reopen_batch_id=${batchId}::uuid)`);expect(body.n).toBe(0);
}
describe('Native draft deletion after encrypted Payroll reviews',()=>{
 it.each(['pending','completed','discarded','expired','refused'] as const)('preserves native deletion after a %s reset review',async(state)=>{
  const r=await prepareReset();
  if(state==='completed'){const result=await confirmPayrollResetReview(ctx,{action:'payroll.reset',contractVersion:1,actionId:r.actionId,reviewedDigest:r.reviewedDigest});expect(result.kind).toBe('completed');}
  else{
   if(state==='discarded')await discardPayrollResetReview(ctx,{action:'payroll.reset',contractVersion:1,actionId:r.actionId});
   if(state==='expired'){await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 second' where id=${r.actionId}::uuid`);expect((await reopenPayrollResetReview(ctx,r.actionId)).kind).toBe('retired');}
   if(state==='refused')await erasePersonPii(ctx,{subjectEmploymentId:employmentId,scope:'contact',requestRef:'FICTIONAL-DELETE-REVIEW-ERASURE',reason:'Fictional lifecycle erasure'});
   await resetProcessedBatch(ctx,{batchId,reason});
  }
  const [before]=await owner.db.execute<{state:string}>(sql`select state from app.assistant_own_leave_review where id=${r.actionId}::uuid`);expect(before.state).toBe(state==='pending'?'awaiting_confirmation':state);
  await deleteAndAssert();
 });
 it('deletes the reviewed draft while retaining its sibling and shared parent',async()=>{
  const sibling=(await createAdditionalRun(ctx,{companyId:b.companyId,payPeriod:period,runType:'bonus'})).batchId;
  const siblingBefore=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,sibling));
  await prepareReset();await resetProcessedBatch(ctx,{batchId,reason});await deleteAndAssert(true);
  expect(await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,sibling))).toEqual(siblingBefore);
 });
 it('preserves native deletion after completed reopening followed by native reset',async()=>{
  await closeBatch(ctx,{batchId});
  const r=await preparePayrollReopenReview(ctx,{action:'payroll.reopen',contractVersion:1,batchId,reason,confirmReopenClosedRun:true,acknowledgeRecordedDownstreamWarnings:true});if(r.kind!=='prepared')throw Error('Expected real encrypted reopening review');
  const done=await confirmPayrollReopenReview(ctx,{action:'payroll.reopen',contractVersion:1,actionId:r.review.actionId,reviewedDigest:r.review.reviewedDigest});expect(done.kind).toBe('completed');
  await resetProcessedBatch(ctx,{batchId,reason});await deleteAndAssert();
 });
});
