/**
 * Selective per-employee reprocessing as a background job (core/payroll-reprocess-job.ts, draft migration 5056).
 * The request path ran every selected employee inside the web request; the job runs the same per-employee
 * transaction (`reprocessEmployeeTx`) one employee per chunk. On two identical tenants the job and the request path
 * leave the same payslips (money, statutory breakdown, version), run totals and headcount, recorded job result
 * (outcome per employee, classification, versions) and per-employee audit events. A job stopped by a run-level
 * refusal keeps the employees already committed and records the same stop code, as the request path did. Since ADR 0181
 * J2 the job recalculates ordinary employees in set-based groups (one engine pass per group); the equivalence at scale is
 * test/payroll-reprocess-set-equivalence.test.ts.
 */
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {createBatch,decodeReprocessEmployeeOutcomes,generatePayslips,getReprocessJob,reprocessSelectedEmployees} from '../core/payroll';
import {requestSelectiveReprocess,payrollReprocessJobHandler} from '../core/payroll-reprocess-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Tenant={base:Base;a:SessionContext;batchId:string;employees:Record<string,string>};
async function tenant(names:string[]):Promise<Tenant>{
 const base=await seedBase();await setModule(base.tenantId,'multi_cycle_payroll','active');const a=await entitledCtx(base);
 const employees:Record<string,string>={};
 for(const [i,name] of names.entries()){
  const e=await hireEmployee(a,{person:{fullName:name,primaryEmail:`${name.toLowerCase()}.${base.tenantId.slice(0,6)}@reprocess.test`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
  await setStatutoryProfileMY(a,{personId:e.personId,icNumber:`9001010110${String(i).padStart(2,'0')}`});
  await setCompensation(a,{employmentId:e.employmentId,basicSalary:3000+i*250,monthlyAllowance:0,effectiveFrom:'2026-01-01'});
  employees[name]=e.employmentId;
 }
 const {batchId}=await createBatch(a,{companyId:base.companyId,payPeriod:'2026-05'});
 await generatePayslips(a,{batchId});
 // Salary changes after processing: the selective reprocess recalculates exactly these employees.
 for(const [i,name] of names.entries())if(i%2===0)await setCompensation(a,{employmentId:employees[name],basicSalary:3500+i*250,monthlyAllowance:100,effectiveFrom:'2026-05-01'});
 return{base,a,batchId,employees};
}
async function drain(){for(let i=0;i<500;i++){if(!await runBulkJobTick(owner.client,{handlers:[payrollReprocessJobHandler]})){const [row]=await owner.client<{n:number}[]>`select count(*)::int as n from bulk_job where kind='payroll_reprocess' and (state not in ('completed','failed','cancelled') or notified_at is null)`;if(!row.n)return;await new Promise(r=>setTimeout(r,20));}}throw new Error('reprocess job did not finish');}
/** The run's reprocess-visible state with ids replaced by employee names. */
async function state(t:Tenant,jobId:string){
 const name=new Map(Object.entries(t.employees).map(([n,id])=>[id,n]));
 const slips=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,t.batchId));
 const [batch]=await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,t.batchId));
 const job=await getReprocessJob(t.a,jobId);
 const result=job?.result as {outcomes:Record<string,unknown>[]}&Record<string,unknown>;
 const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,t.batchId),eq(schema.domainEvent.eventType,'payroll-batch.employee-reprocess-outcome')));
 const strip=(o:Record<string,unknown>)=>Object.fromEntries(Object.entries(o).filter(([k])=>!['at','payslipId','historyId','employmentId','jobId','batchId','companyId'].includes(k)));
 const ids=new Map<string,string>([[t.base.companyId,'company'],[t.base.tenantId,'tenant'],...Object.entries(t.employees).map(([n,id])=>[id,n] as [string,string])]);
 const normalize=(v:unknown)=>JSON.parse(JSON.stringify(v).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,id=>ids.get(id)??'id'));
 return normalize({
  status:job?.status,stopCode:job?.stopCode,
  payslips:slips.map(s=>({who:name.get(s.employmentId),gross:s.grossPay,net:s.netPay,basic:s.basicSalary,allowance:s.allowance,version:s.version,statutory:s.statutory})).sort((x,y)=>String(x.who).localeCompare(String(y.who))),
  batch:{totals:batch.totals,employeeCount:batch.employeeCount,status:batch.status,recalc:batch.recalcEmploymentIds},
  // Both paths take the selection in its sorted id order; ids differ between the tenants, so compare by person.
  outcomes:(result?.outcomes??[]).map(o=>({who:name.get(o.employmentId as string),...strip(o)})).sort((x,y)=>String(x.who).localeCompare(String(y.who))),
  order:(result?.outcomes??[]).map(o=>o.employmentId)===undefined?null:(result?.outcomes??[]).map(o=>o.employmentId as string).join()===[...(job?.employmentIds??[])].filter(id=>(result?.outcomes??[]).some(o=>o.employmentId===id)).join(),
  counts:strip(Object.fromEntries(Object.entries(result??{}).filter(([k])=>!['outcomes','workerToken','totals'].includes(k)))),
  totals:result?.totals,
  events:events.map(e=>({who:name.get(e.subjectEmploymentId!),...strip(e.payload as Record<string,unknown>)})).sort((x,y)=>String(x.who).localeCompare(String(y.who))),
 });
}

describe('selective reprocess as a background job',()=>{
 beforeAll(migrateTestDb);
 beforeEach(resetDb);
 afterAll(closeAll);

 it('reprocesses the selected employees exactly as the request path, off the request',async()=>{
  const names=['Aisyah','Bala','Chen','Devi'];
  const sync=await tenant(names),job=await tenant(names);
  const pick=(t:Tenant)=>[t.employees.Aisyah,t.employees.Chen,t.employees.Devi];
  const done=await reprocessSelectedEmployees(sync.a,{batchId:sync.batchId,employmentIds:pick(sync),reason:'salary change'});
  expect(done.status).toBe('completed');
  const requested=await requestSelectiveReprocess(job.a,{batchId:job.batchId,employmentIds:pick(job),reason:'salary change'});
  expect(requested.status).toBe('queued');
  // Nothing is recalculated in the request.
  expect((await getReprocessJob(job.a,requested.jobId))?.status).toBe('queued');
  await drain();
  expect(await state(job,requested.jobId)).toEqual(await state(sync,done.jobId));
  // ADR 0181 J2: the three ordinary recalculations were one engine pass, with its calculation/database split recorded.
  const [metrics]=await owner.client<{metrics:Record<string,number>}[]>`select metrics from bulk_job where kind='payroll_reprocess' and tenant_id=${job.base.tenantId}::uuid`;
  expect(metrics.metrics).toMatchObject({reprocessGroups:1,reprocessGroupEmployees:3,reprocessGroupMaxEmployees:3});
  expect(metrics.metrics.reprocessSingles).toBeUndefined();
  expect(metrics.metrics.reprocessCalcMs+metrics.metrics.reprocessDbMs).toBeGreaterThan(0);
  // A repeated submit of the finished selection returns its stored result, as before.
  expect(await requestSelectiveReprocess(job.a,{batchId:job.batchId,employmentIds:pick(job),reason:'salary change'})).toMatchObject({jobId:requested.jobId,status:'completed'});
 },240000);

 // a1a80747 — the request no longer carries a tax readiness answer (the job decides it per employee), and a job written
 // before that, whose result recorded the request's held employees, still runs, completes, decodes and replays.
 it('enqueues the ticked employees with no readiness answer; an older payload with held employees still decodes',async()=>{
  const t=await tenant(['Aisyah','Bala']);
  const ready=t.employees.Aisyah,held=t.employees.Bala;
  const request={batchId:t.batchId,employmentIds:[ready],idempotencyKey:'no-readiness-answer'};
  const queued=await requestSelectiveReprocess(t.a,request);
  const [row]=await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.id,queued.jobId));
  expect(row.result).toBeNull();
  // The shape an earlier release wrote at submit: the reviewed remainder on the result.
  await owner.db.update(schema.payrollReprocessJob).set({result:{outcomes:[],heldEmploymentIds:[held]}}).where(eq(schema.payrollReprocessJob.id,queued.jobId));
  await drain();
  const result=await getReprocessJob(t.a,queued.jobId);
  expect(result).toMatchObject({status:'completed',employmentIds:[ready],result:{
    outcomes:[{employmentId:ready,status:'reprocessed'}],heldEmploymentIds:[held],
  }});
  expect(decodeReprocessEmployeeOutcomes(result!.result,result!.employmentIds)).toHaveLength(1);
  expect(await requestSelectiveReprocess(t.a,request)).toMatchObject({jobId:queued.jobId,status:'completed'});
  const [heldPayslip]=await owner.db.select().from(schema.payslip).where(
    and(eq(schema.payslip.batchId,t.batchId),eq(schema.payslip.employmentId,held)));
  expect(heldPayslip.version).toBe(1);
  // Skip outcomes: the older NOTHING_PAYABLE shape and the two tax holds decode; an unknown skip reason does not.
  const id='11111111-1111-4111-8111-111111111111';
  const skip=(reasonCode:string)=>({outcomes:[{employmentId:id,name:'Fictional',employeeCode:null,status:'skipped',reasonCode,resultRetained:false,
   payslipId:null,versionBefore:null,versionAfter:null,historyId:null,at:'2026-05-31T10:00:00.000Z'}]});
  for(const code of ['NOTHING_PAYABLE','TAX_RECALC_REQUIRED','TAX_RECALC_IN_PROGRESS'])expect(decodeReprocessEmployeeOutcomes(skip(code),[id]),code).toHaveLength(1);
  expect(decodeReprocessEmployeeOutcomes(skip('TAX_SOMETHING_ELSE'),[id])).toBeNull();
 },240000);

 // ADR 0181 J2: PAYROLL_REPROCESS_GROUP_MAX=1 is one employee per chunk (the per-employee transaction only); 2 makes the
 // first chunk one set-based group of two employees. Either way the committed chunk stays and the next one refuses.
 it.each([['one employee per chunk','1',1],['a set-based group per chunk','2',2]] as const)('stops on a run-level refusal as the request path did, keeping the employees already committed (%s)',async(_label,groupMax,committed)=>{
  const previous=process.env.PAYROLL_REPROCESS_GROUP_MAX;process.env.PAYROLL_REPROCESS_GROUP_MAX=groupMax;
  try{
  const t=await tenant(['Aisyah','Bala','Chen']);
  const requested=await requestSelectiveReprocess(t.a,{batchId:t.batchId,employmentIds:Object.values(t.employees)});
  const outcomesOf=async()=>((await getReprocessJob(t.a,requested.jobId))?.result as {outcomes?:unknown[]}|null)?.outcomes?.length??0;
  for(let i=0;i<50&&await outcomesOf()<1;i++)await runBulkJobTick(owner.client,{handlers:[payrollReprocessJobHandler]});
  expect(await outcomesOf()).toBe(committed);
  // The run stops being processed before the next employee: that employee's own transaction refuses the run.
  await owner.db.update(schema.payrollBatch).set({status:'closed'}).where(eq(schema.payrollBatch.id,t.batchId));
  await drain();
  const job=await getReprocessJob(t.a,requested.jobId);
  // The request path's stop record: failed, the run-level code, the committed employee kept, no employee named
  // (the refusal came before any employee's identity was read).
  expect(job).toMatchObject({status:'failed',stopCode:'BATCH_NOT_PROCESSED'});
  expect((job?.result as {outcomes:unknown[]}).outcomes).toHaveLength(committed);
  expect((job?.result as {stoppedEmployee:unknown}).stoppedEmployee).toBeNull();
  // A request path refusal before any job (a run that is not processed) is unchanged.
  await expect(requestSelectiveReprocess(t.a,{batchId:t.batchId,employmentIds:Object.values(t.employees)})).rejects.toThrow();
  }finally{if(previous===undefined)delete process.env.PAYROLL_REPROCESS_GROUP_MAX;else process.env.PAYROLL_REPROCESS_GROUP_MAX=previous;}
 },240000);
});
