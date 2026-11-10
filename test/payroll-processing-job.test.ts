/**
 * Payroll processing as a background bulk job (core/payroll-processing-job.ts, draft 9950/9951): real PostgreSQL,
 * real RLS, real worker ticks.
 *
 * - Equivalence: the payroll wave's populated fictional fixture (test/payroll-lock-equivalence.test.ts) processed by
 *   the job in chunks of two employees produces the SAME canonical figure document (payslips, statutory breakdown,
 *   run totals, loan ledger and schedule, payroll inputs) as the synchronous path, whose digest was recorded on the
 *   exclusive-lock base, and the same audit events.
 * - Edits while processing: a salary change for an employee the job has already paid marks the run for
 *   recalculation; one for an employee not reached yet is in that employee's payslip. Neither waits for the run.
 * - The run is 'processing' (never visible as processed) until finalize; a failed chunk discards everything the job
 *   wrote and returns the run to draft.
 */
import {createHash} from 'node:crypto';
import {asc,eq,inArray,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {setCp38} from '../core/cp38';
import {createBatch,generatePayslips,resetProcessedBatch,setPayrollInput,BatchNotDraftError} from '../core/payroll';
import {createLoan,prefillLoansForBatch} from '../core/loans';
import {listPayComponents,seedPayComponentCatalog,setEmploymentPayComponent} from '../core/pay-components';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {payrollProcessJobHandler,payrollProcessingStatus,requestPayrollProcessing} from '../core/payroll-processing-job';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';

/** The synchronous path's digest for this fixture (test/payroll-lock-equivalence.test.ts, recorded on the base). */
const GOLDEN='13f356722b8a12c17c3f6c716f4f1760785e93172519bbeefa98318d3e2da142';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP=/^\d{4}-\d{2}-\d{2}T/;
const DROPPED=new Set(['id','createdAt','updatedAt','version','tenantId','batchId','reservedBatchId','appliedBatchId','appliedAt','loanId']);
function canonical(value:unknown,names:ReadonlyMap<string,string>):unknown{
 if(value instanceof Date)return '<timestamp>';
 if(typeof value==='string'){if(names.has(value))return names.get(value);if(UUID.test(value))return '<id>';if(TIMESTAMP.test(value))return '<timestamp>';return value;}
 if(Array.isArray(value))return value.map(entry=>canonical(entry,names));
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(key=>!DROPPED.has(key)).map(key=>[key,canonical((value as Record<string,unknown>)[key],names)]));
 return value;
}
const tick=()=>runBulkJobTick(owner.client,{handlers:[payrollProcessJobHandler]});
const jobState=async(id:string)=>(await owner.client<{state:string;notified:boolean;error:string|null;metrics:Record<string,number>}[]>`select state,notified_at is not null as notified,error,metrics from bulk_job where id=${id}::uuid`)[0];
async function runJob(id:string,max=400){
 for(let i=0;i<max;i++){
  const row=await jobState(id);
  if(['completed','failed','cancelled'].includes(row.state)&&row.notified)return row;
  if(!await tick())await new Promise(resolve=>setTimeout(resolve,40));
 }
 throw new Error('payroll processing job did not finish');
}
/** Tick until `done(steps applied)`; returns without finishing the job. */
async function runUntil(id:string,done:(applied:number)=>boolean,max=200){
 for(let i=0;i<max;i++){
  const [row]=await owner.client<{n:number;state:string}[]>`select (select count(*)::int from bulk_job_step where job_id=j.id and state='applied') as n,j.state from bulk_job j where j.id=${id}::uuid`;
  if(row.state==='running'&&done(row.n))return;
  if(!await tick())await new Promise(resolve=>setTimeout(resolve,40));
 }
 throw new Error('payroll processing job did not reach the step');
}

let base:Base;
beforeAll(async()=>{await migrateTestDb();});
beforeEach(async()=>{
 process.env.PAYROLL_PROCESS_CHUNK_EMPLOYEES='2';
 await resetDb();base=await seedBase();for(const module of ['payroll','typed_pay_components'])await setModule(base.tenantId,module,'active');await setSetting(base.tenantId,'payroll.reset_enabled',true);
});
afterEach(()=>{delete process.env.PAYROLL_PROCESS_CHUNK_EMPLOYEES;});
afterAll(async()=>{await closeAll();});

/** The payroll wave's equivalence fixture, verbatim. */
async function fixture(){
 const admin=adminCtx(base);
 const people:{label:string;basic:number;hiredOn:string;ic:string}[]=[
  {label:'Aisha',basic:5200,hiredOn:'2025-03-01',ic:'880101145522'},
  {label:'Bala',basic:3100,hiredOn:'2024-07-01',ic:'900215105533'},
  {label:'Chen',basic:8800,hiredOn:'2023-01-01',ic:'850630085544'},
  {label:'Devi',basic:2400,hiredOn:'2026-05-15',ic:'010405145566'},
  {label:'Eng',basic:15000,hiredOn:'2022-11-01',ic:'780912105577'},
 ];
 const hired=new Map<string,{employmentId:string;personId:string}>(),names=new Map<string,string>();
 for(const p of people){
  const e=await hireEmployee(admin,{person:{fullName:`Fictional ${p.label}`,primaryEmail:`fictional-${p.label.toLowerCase()}@equivalence.test`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:p.hiredOn});
  await setCompensation(admin,{employmentId:e.employmentId,basicSalary:p.basic,monthlyAllowance:0,effectiveFrom:p.hiredOn});
  await setStatutoryProfileMY(admin,{personId:e.personId,icNumber:p.ic});
  hired.set(p.label,e);names.set(e.employmentId,p.label);names.set(e.personId,`${p.label} person`);
 }
 const a=await entitledCtx(base);
 await seedPayComponentCatalog(admin);
 const allowance=(await listPayComponents(admin)).find(c=>c.code==='ALLOWANCE');
 if(!allowance)throw new Error('Missing native ALLOWANCE item');
 await setEmploymentPayComponent(a,{employmentId:hired.get('Chen')!.employmentId,componentId:allowance.id,amount:350,effectiveFrom:'2026-01-01'});
 await setCp38(a,{employmentId:hired.get('Eng')!.employmentId,cp38Ref:'CP38/EQ',amount:500,validFrom:'2026-01-01'});
 const loan=await createLoan(a,{employmentId:hired.get('Bala')!.employmentId,loanType:'personal',principal:2400,interestRate:0,interestMethod:'none',durationMonths:12,startDate:'2026-01-01'});
 const {batchId}=await createBatch(a,{companyId:base.companyId,payPeriod:'2026-05'});
 await prefillLoansForBatch(a,{batchId});
 await setPayrollInput(a,{batchId,employmentId:hired.get('Chen')!.employmentId,overtimeAmount:120,bonusAmount:1000});
 const snapshot=async()=>{
  const slips=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));
  const [batch]=await owner.db.select({status:schema.payrollBatch.status,employeeCount:schema.payrollBatch.employeeCount,totals:schema.payrollBatch.totals}).from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId));
  const [ledger]=await owner.db.select({outstandingBalance:schema.employeeLoan.outstandingBalance,instalmentsPaid:schema.employeeLoan.instalmentsPaid,status:schema.employeeLoan.status}).from(schema.employeeLoan).where(eq(schema.employeeLoan.id,loan.id));
  const schedule=await owner.db.select({sequenceNo:schema.loanRepayment.sequenceNo,dueAmount:schema.loanRepayment.dueAmount,appliedAmount:schema.loanRepayment.appliedAmount,status:schema.loanRepayment.status}).from(schema.loanRepayment).where(eq(schema.loanRepayment.loanId,loan.id)).orderBy(asc(schema.loanRepayment.sequenceNo));
  const inputs=await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId,batchId));
  return canonical({
   payslips:[...slips].sort((x,y)=>names.get(x.employmentId)!.localeCompare(names.get(y.employmentId)!)),
   batch,ledger,schedule,
   inputs:[...inputs].sort((x,y)=>names.get(x.employmentId)!.localeCompare(names.get(y.employmentId)!)),
  },names);
 };
 /** The audit events a processing wrote after `since` (kernel bookkeeping excluded), canonical and ordered. */
 const eventsSince=async(since:number)=>{
  const rows=await owner.client<{event_type:string;aggregate_type:string;actor_type:string;subject_employment_id:string|null;payload:unknown}[]>`
   select event_type,aggregate_type,actor_type,subject_employment_id,payload from domain_event where tenant_id=${base.tenantId}::uuid and sequence>${since} and aggregate_type<>'bulk-job' order by sequence`;
  // The payroll audit loop's capture hashes whole owner rows, including every payslip's own id and timestamps, and
  // sits at a position in the run's audit chain: both differ between ANY two processings (two synchronous runs as
  // much as a synchronous and a job run). Its kind, run and period are compared; the hashes are not.
  const unchained=(r:typeof rows[number])=>r.aggregate_type==='payroll-audit'&&r.payload&&typeof r.payload==='object'
   ?{...r,payload:Object.fromEntries(Object.entries(r.payload as Record<string,unknown>).filter(([k])=>!['seq','prevHash','chainHash','contentHash'].includes(k)))}:r;
  return rows.map(r=>JSON.stringify(canonical(unchained(r),names))).sort();
 };
 const lastSequence=async()=>Number((await owner.client<{s:string|null}[]>`select max(sequence)::text as s from domain_event`)[0]?.s??0);
 return{a,hired,names,loan,batchId,snapshot,eventsSince,lastSequence};
}

describe('payroll processing background job',()=>{
 it('processes the run in chunks to the synchronous path’s exact figures and audit events',async()=>{
  const f=await fixture();
  // The synchronous oracle first (its digest is the base commit's), then reset and process through the job. The
  // audit comparison uses a second synchronous run after a reset, so both sides start from the same history.
  await generatePayslips(f.a,{batchId:f.batchId});
  const sync=await f.snapshot();
  expect(createHash('sha256').update(JSON.stringify(sync)).digest('hex')).toBe(GOLDEN);
  await resetProcessedBatch(f.a,{batchId:f.batchId,reason:'Fictional job equivalence reset'});
  const before=await f.lastSequence();
  await generatePayslips(f.a,{batchId:f.batchId});
  const syncEvents=await f.eventsSince(before);
  expect(await f.snapshot()).toEqual(sync);
  await resetProcessedBatch(f.a,{batchId:f.batchId,reason:'Fictional job equivalence reset'});

  const started=await f.lastSequence();
  const {jobId,existing}=await requestPayrollProcessing(f.a,{batchId:f.batchId});
  expect(existing).toBe(false);
  expect(await requestPayrollProcessing(f.a,{batchId:f.batchId})).toEqual({jobId,existing:true});
  const [processing]=await owner.db.select({status:schema.payrollBatch.status,processingJobId:schema.payrollBatch.processingJobId}).from(schema.payrollBatch).where(eq(schema.payrollBatch.id,f.batchId));
  expect(processing).toEqual({status:'processing',processingJobId:jobId});
  // Run inputs are frozen while processing, with the existing draft-only refusal (never a wait).
  await expect(setPayrollInput(f.a,{batchId:f.batchId,employmentId:f.hired.get('Aisha')!.employmentId,overtimeAmount:0,bonusAmount:1})).rejects.toBeInstanceOf(BatchNotDraftError);

  const done=await runJob(jobId);
  expect(done).toMatchObject({state:'completed',error:null});
  // begin + three chunks of two employees.
  expect(Number(done.metrics.chunks)).toBeGreaterThanOrEqual(4);
  const viaJob=await f.snapshot();
  expect(viaJob).toEqual(sync);
  expect(createHash('sha256').update(JSON.stringify(viaJob)).digest('hex')).toBe(GOLDEN);
  // The same audit events (the reset's own events precede `started`; the job's notice is kernel bookkeeping).
  expect(await f.eventsSince(started)).toEqual(syncEvents);
  const status=await payrollProcessingStatus(f.a,f.batchId);
  expect(status).toMatchObject({status:'processed',job:{id:jobId,state:'completed',result:{payslips:5}}});
 },300000);

 it('lets salary edits land while processing: included for employees not reached yet, marked for employees already paid',async()=>{
  const f=await fixture();
  const {jobId}=await requestPayrollProcessing(f.a,{batchId:f.batchId});
  // prepare + begin + the first chunk of two employees.
  await runUntil(jobId,applied=>applied>=2);
  const chunks=await owner.client<{ids:string[]}[]>`select array(select jsonb_array_elements_text(payload->'employmentIds')) as ids from bulk_job_step where job_id=${jobId}::uuid and kind='employees' order by seq`;
  const [paidId]=chunks[0].ids,[laterId]=chunks[2].ids;
  const [paidBefore]=await owner.db.select({basic:schema.payslip.basicSalary}).from(schema.payslip).where(eq(schema.payslip.employmentId,paidId));
  expect(paidBefore).toBeDefined();
  // Both edits commit at once: the job holds the company's inputs key only for one chunk, never between chunks.
  const t0=performance.now();
  await setCompensation(adminCtx(base),{employmentId:paidId,basicSalary:9100,monthlyAllowance:0,effectiveFrom:'2026-05-01'});
  await setCompensation(adminCtx(base),{employmentId:laterId,basicSalary:9200,monthlyAllowance:0,effectiveFrom:'2026-05-01'});
  expect(performance.now()-t0).toBeLessThan(5000);
  expect(await runJob(jobId)).toMatchObject({state:'completed'});
  const [batch]=await owner.db.select({status:schema.payrollBatch.status,needsRecalcAt:schema.payrollBatch.needsRecalcAt,ids:schema.payrollBatch.recalcEmploymentIds}).from(schema.payrollBatch).where(eq(schema.payrollBatch.id,f.batchId));
  expect(batch.status).toBe('processed');
  expect(batch.needsRecalcAt).not.toBeNull();
  expect(batch.ids).toEqual([paidId]);
  const slips=await owner.db.select({employmentId:schema.payslip.employmentId,basic:schema.payslip.basicSalary}).from(schema.payslip).where(inArray(schema.payslip.employmentId,[paidId,laterId]));
  expect(slips.find(s=>s.employmentId===laterId)?.basic).toBe('9200.00');
  expect(slips.find(s=>s.employmentId===paidId)?.basic).toBe(paidBefore.basic);
 },300000);

 it('discards a failed run back to draft: no payslips, inputs and ledger as they were',async()=>{
  const f=await fixture();
  const inputsBefore=await owner.client`select to_jsonb(i)-'updated_at' as row from payroll_input i where batch_id=${f.batchId}::uuid order by employment_id`;
  const {jobId}=await requestPayrollProcessing(f.a,{batchId:f.batchId});
  await runUntil(jobId,applied=>applied>=2);
  const chunks=await owner.client<{ids:string[]}[]>`select array(select jsonb_array_elements_text(payload->'employmentIds')) as ids from bulk_job_step where job_id=${jobId}::uuid and kind='employees' order by seq`;
  // An employee the job has not reached loses their salary record: their chunk's readiness gate refuses the run.
  await owner.client`delete from compensation where employment_id=${chunks[2].ids[0]}::uuid`;
  const done=await runJob(jobId);
  expect(done.state).toBe('failed');
  expect(done.error).toBeTruthy();
  const [batch]=await owner.db.select({status:schema.payrollBatch.status,processingJobId:schema.payrollBatch.processingJobId,needsRecalcAt:schema.payrollBatch.needsRecalcAt}).from(schema.payrollBatch).where(eq(schema.payrollBatch.id,f.batchId));
  expect(batch).toEqual({status:'draft',processingJobId:null,needsRecalcAt:null});
  expect(await owner.db.select({id:schema.payslip.id}).from(schema.payslip).where(eq(schema.payslip.batchId,f.batchId))).toEqual([]);
  const [ledger]=await owner.db.select({outstandingBalance:schema.employeeLoan.outstandingBalance,instalmentsPaid:schema.employeeLoan.instalmentsPaid}).from(schema.employeeLoan).where(eq(schema.employeeLoan.id,f.loan.id));
  expect(ledger).toEqual({outstandingBalance:'2400.00',instalmentsPaid:0});
  expect(await owner.client`select to_jsonb(i)-'updated_at' as row from payroll_input i where batch_id=${f.batchId}::uuid order by employment_id`).toEqual(inputsBefore);
  const [discarded]=await owner.client<{payload:{jobId:string}}[]>`select payload from domain_event where aggregate_id=${f.batchId}::uuid and event_type='payroll-batch.processing-discarded'`;
  expect(discarded.payload.jobId).toBe(jobId);
  expect((await owner.db.execute(sql`select count(*)::int as n from domain_event where aggregate_id=${f.batchId}::uuid and event_type='payroll-batch.processed'`))[0]).toMatchObject({n:0});
 },300000);
});
