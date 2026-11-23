/**
 * Board 0ec0ee00, stage 2 — Individual Transaction uploads of up to 10,000 rows are written, and reverted, by the
 * background worker in steps of about 250 rows. Real PostgreSQL; fictional employees and amounts only.
 *
 * Pins: a 10,000-row file imports across steps (timed), 10,001 rows are refused as too many, a worker that dies
 * between steps resumes without writing a row twice, a step that keeps failing stops the batch, a stopped batch's
 * processed runs are marked for recalculation and Revert removes exactly its rows, a re-upload writes nothing, one
 * operation key is one job, Import Log pages are bounded, the outcome table is append-only, and the Fixed import keeps
 * its 2,000-row limit.
 */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {seedPayComponentCatalog} from '../core/pay-components';
import {createBatch} from '../core/payroll';
import {
 confirmIndividualImport,confirmIndividualImportStep,listIndividualImportRows,readIndividualImportSummary,requestIndividualImportRevert,validateIndividualImport,
} from '../core/individual-txn-import';
import {queueIndividualImportConfirmation,readIndividualImportJob,submitIndividualImportJob} from '../core/individual-import-job';
import {runIndividualImportTick,type IndividualImportTickOptions} from '../core/individual-import-worker';
import {analyzeTxnImport} from '../core/payroll-txn-import';
import {INDIVIDUAL_IMPORT_HEADERS} from '../lib/payroll-txn-import-schema';
import {INDIVIDUAL_IMPORT_MAX_RECORDS,INDIVIDUAL_IMPORT_PAGE_ROWS,INDIVIDUAL_IMPORT_STEP_ROWS} from '../lib/individual-import-job';
import {toCsv} from '../lib/csv';
import {buildXlsx} from '../lib/spreadsheet';

describe('0ec0ee00 — Individual Transaction import written in steps',()=>{
 let base:Base,codes:string[]=[];
 const scopeIds=()=>[base.companyId];
 beforeAll(migrateTestDb);
 beforeEach(async()=>{
  await resetDb();base=await seedBase();const a=adminCtx(base);codes=[];
  await seedPayComponentCatalog(a);
  // A typed-amount pay item: no pricing rule, so every row stores exactly the amount the file gives.
  await owner.db.update(schema.payComponent).set({rule:null}).where(and(eq(schema.payComponent.tenantId,base.tenantId),eq(schema.payComponent.code,'BONUS')));
  await owner.db.insert(schema.payrollCycle).values({tenantId:base.tenantId,companyId:base.companyId,name:'Fictional Monthly',code:'IMP',runType:'regular'});
  for(let i=0;i<20;i++){
   const e=await hireEmployee(a,{person:{fullName:`Fictional Person ${i}`,primaryEmail:`steps-${i}-${randomUUID()}@example.invalid`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
   const [row]=await owner.db.select({code:schema.employment.employeeCode}).from(schema.employment).where(eq(schema.employment.id,e.employmentId));codes.push(row.code!);
  }
 },120_000);
 afterAll(closeAll);

 /** `count` distinct fictional rows: each (employee, amount) pair is unique, so none is a duplicate of another. */
 const rows=(count:number,salt=0)=>Array.from({length:count},(_,i)=>{
  const employee=i%codes.length,amount=(Math.floor(i/codes.length)+1+salt*10_000)/100+1;
  return [codes[employee],`Fictional Person ${employee}`,'2026-08','IMP','BONUS','2026-08-15','amount','',amount.toFixed(2),`row ${i}`];
 });
 const workbook=async(data:string[][])=>Buffer.from(await buildXlsx([...INDIVIDUAL_IMPORT_HEADERS.monthly],data));
 const tick=(options?:IndividualImportTickOptions)=>runIndividualImportTick(owner.client,async session=>({...session,entitlements:adminCtx(base).entitlements}),{retryDelayMs:1,...options});
 const imported=async()=>(await owner.client<{n:number}[]>`select count(*)::int as n from payroll_individual_txn where tenant_id=${base.tenantId} and source='import'`)[0].n;
 const duplicates=async()=>owner.client`select source_ref,count(*)::int as n from payroll_individual_txn where tenant_id=${base.tenantId} and source_ref is not null group by source_ref having count(*)>1`;
 async function upload(data:string[][],id=randomUUID()){
  const ctx=adminCtx(base);
  await submitIndividualImportJob(ctx,{id,name:'individual-monthly.xlsx',content:await workbook(data),method:'monthly',scopeIds:scopeIds()});
  return id;
 }
 async function untilState(id:string,states:string[],options?:IndividualImportTickOptions,limit=200){
  for(let i=0;i<limit;i++){
   const job=await readIndividualImportJob(adminCtx(base),id,scopeIds());
   if(job&&states.includes(job.state))return job;
   await tick(options);
  }
  throw new Error('The queue did not reach '+states.join('/'));
 }

 it('imports 10,000 rows across steps through the worker, and reverts them in steps (timed)',async()=>{
  const id=await upload(rows(INDIVIDUAL_IMPORT_MAX_RECORDS));
  const t0=performance.now();await tick();const validate=performance.now()-t0;
  const ready=await readIndividualImportJob(adminCtx(base),id,scopeIds());
  expect(ready).toMatchObject({state:'ready',total:10_000,failed_rows:0});
  expect(await queueIndividualImportConfirmation(adminCtx(base),id,scopeIds())).toBe(true);
  const steps:number[]=[];let job=ready!;
  const c0=performance.now();
  while(job.state!=='completed'){
   const s0=performance.now();await tick();steps.push(performance.now()-s0);
   job=(await readIndividualImportJob(adminCtx(base),id,scopeIds()))!;
   expect(['importing','completed']).toContain(job.state);
   expect(steps.length).toBeLessThanOrEqual(Math.ceil(10_000/INDIVIDUAL_IMPORT_STEP_ROWS)+1);
  }
  const confirm=performance.now()-c0;
  expect(steps).toHaveLength(Math.ceil(10_000/INDIVIDUAL_IMPORT_STEP_ROWS));
  expect(job).toMatchObject({state:'completed',processed:10_000,written:10_000,failed_rows:0});
  expect(await imported()).toBe(10_000);expect(await duplicates()).toEqual([]);
  const summary=await readIndividualImportSummary(adminCtx(base),job.attempt_id!,scopeIds());
  expect(summary).toMatchObject({state:'completed',total:10_000,processed:10_000,written:10_000,failed:0,periods:['2026-08'],cycles:['IMP']});
  // The last page holds the last 100 rows, read in SQL.
  const last=await listIndividualImportRows(adminCtx(base),job.attempt_id!,scopeIds(),99);
  expect(last.rows.map(row=>row.rowNum)).toEqual(Array.from({length:100},(_,i)=>9_902+i));
  expect(last.rows.every(row=>row.outcome==='imported')).toBe(true);
  const r0=performance.now();
  expect(await requestIndividualImportRevert(adminCtx(base),{id:job.attempt_id!,scopeIds:scopeIds(),confirmProcessed:false})).toEqual({state:'reverting',queued:true});
  const reverted=await untilState(id,['reverted','stopped','completed']);
  const revert=performance.now()-r0;
  expect(reverted.state).toBe('reverted');expect(await imported()).toBe(0);
  console.log('[0ec0ee00 timing]',JSON.stringify({rows:10_000,validateMs:Math.round(validate),confirmMs:Math.round(confirm),
   steps:steps.length,maxStepMs:Math.round(Math.max(...steps)),meanStepMs:Math.round(steps.reduce((a,b)=>a+b,0)/steps.length),revertMs:Math.round(revert)}));
 },900_000);

 it('refuses 10,001 rows as too many, and keeps the Fixed import at 2,000',async()=>{
  const csv=toCsv([[...INDIVIDUAL_IMPORT_HEADERS.monthly],...rows(INDIVIDUAL_IMPORT_MAX_RECORDS+1)]);
  const attempt=await validateIndividualImport(adminCtx(base),{operationId:randomUUID(),sourceName:'too-many.xlsx',csv,method:'monthly',scopeIds:scopeIds()});
  expect(attempt.preview).toMatchObject({fileError:'tooManyRows',total:0});
  const fixed=Array.from({length:2001},()=>({employee_id:codes[0],pay_item_code:'BONUS'}));
  expect((await analyzeTxnImport(adminCtx(base),{kind:'fixed',scopeIds:scopeIds(),records:fixed})).preview.fileError).toBe('tooManyRows');
  expect((await analyzeTxnImport(adminCtx(base),{kind:'fixed',scopeIds:scopeIds(),records:fixed.slice(0,2000)})).preview.fileError).not.toBe('tooManyRows');
 },120_000);

 it('resumes after a worker dies between steps without writing any row twice, and a second runner never doubles a step',async()=>{
  const id=await upload(rows(600));
  await tick();await queueIndividualImportConfirmation(adminCtx(base),id,scopeIds());
  await tick();
  const first=(await readIndividualImportJob(adminCtx(base),id,scopeIds()))!;
  expect(first).toMatchObject({state:'importing',processed:INDIVIDUAL_IMPORT_STEP_ROWS});
  // The worker died after the step committed but before the queue row recorded it.
  await owner.client`update payroll_individual_import_job set processed=0 where id=${id}`;
  // Two runners at once: the attempt row lock lets one write the step; the other sees it moved and writes nothing.
  const both=await Promise.all([1,2].map(()=>confirmIndividualImportStep(adminCtx(base),{id:first.attempt_id!,scopeIds:scopeIds()})));
  expect(Math.max(...both.map(step=>step.processed))).toBe(2*INDIVIDUAL_IMPORT_STEP_ROWS);
  const done=await untilState(id,['completed','stopped']);
  expect(done).toMatchObject({state:'completed',processed:600,written:600});
  expect(await imported()).toBe(600);expect(await duplicates()).toEqual([]);
  // Re-uploading the same file writes nothing twice.
  const again=await upload(rows(600));await tick();
  const refused=(await readIndividualImportJob(adminCtx(base),again,scopeIds()))!;
  expect(refused).toMatchObject({state:'failed',error:'noValidRows',failed_rows:600});
  expect(await imported()).toBe(600);
  // The same operation key is one job.
  const [{source}]=await owner.client<{source:Buffer}[]>`select source from payroll_individual_import_job where id=${id}`;
  expect(await submitIndividualImportJob(adminCtx(base),{id,name:'individual-monthly.xlsx',content:Buffer.from(source),method:'monthly',scopeIds:scopeIds()})).toBe(id);
  expect(await owner.client`select id from payroll_individual_import_job where id=${id}`).toHaveLength(1);
  expect(await owner.client`select id from payroll_individual_import_job where tenant_id=${base.tenantId}`).toHaveLength(2);
 },300_000);

 it('stops a batch whose step keeps failing, marks its processed run for recalculation, and Revert removes exactly its rows',async()=>{
  const a=adminCtx(base);
  const [cycle]=await owner.db.select({id:schema.payrollCycle.id}).from(schema.payrollCycle).where(and(eq(schema.payrollCycle.tenantId,base.tenantId),eq(schema.payrollCycle.code,'IMP')));
  const {batchId}=await createBatch(a,{companyId:base.companyId,payPeriod:'2026-08',payrollCycleId:cycle.id});
  await owner.db.update(schema.payrollBatch).set({status:'processed'}).where(eq(schema.payrollBatch.id,batchId));
  const [component]=await owner.db.select({id:schema.payComponent.id}).from(schema.payComponent).where(and(eq(schema.payComponent.tenantId,base.tenantId),eq(schema.payComponent.code,'BONUS')));
  const [manual]=await owner.db.insert(schema.payrollIndividualTxn).values({tenantId:base.tenantId,companyId:base.companyId,payPeriod:'2026-08',employmentId:(await owner.db.select({id:schema.employment.id}).from(schema.employment).where(and(eq(schema.employment.tenantId,base.tenantId),eq(schema.employment.employeeCode,codes[0]))))[0].id,kind:'earning',componentId:component.id,txnDate:'2026-08-03',amount:'999.99',source:'manual'}).returning();
  const id=await upload(rows(600));
  await tick();await queueIndividualImportConfirmation(a,id,scopeIds());
  await tick();
  let calls=0;
  // From the second step on, every attempt fails for a reason that is not the rows' own data.
  const stopped=await untilState(id,['stopped','completed'],{beforeStep:()=>{calls++;throw new Error('fictional database outage');}});
  expect(calls).toBe(3);
  expect(stopped).toMatchObject({state:'stopped',processed:INDIVIDUAL_IMPORT_STEP_ROWS,written:INDIVIDUAL_IMPORT_STEP_ROWS,error:'importFailed'});
  const summary=await readIndividualImportSummary(a,stopped.attempt_id!,scopeIds());
  expect(summary).toMatchObject({state:'stopped',processed:250,written:250,total:600});
  expect(summary.events.map(event=>event.type)).toContain('stopped');
  const [attempt]=await owner.db.select().from(schema.payrollTxnImportAttempt).where(eq(schema.payrollTxnImportAttempt.id,stopped.attempt_id!));
  expect(attempt.recalcBatchIds).toEqual([batchId]);
  const [run]=await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId));expect(run.needsRecalcAt).not.toBeNull();
  expect(await imported()).toBe(250);
  // Rows not yet reached show as not imported; a page never exceeds its size.
  const page=await listIndividualImportRows(a,stopped.attempt_id!,scopeIds(),5);
  expect(page).toMatchObject({total:600,page:5,pages:6});expect(page.rows).toHaveLength(100);
  expect(page.rows.every(row=>row.outcome==='pending')).toBe(true);
  expect((await listIndividualImportRows(a,stopped.attempt_id!,scopeIds(),0)).rows).toHaveLength(INDIVIDUAL_IMPORT_PAGE_ROWS);
  expect((await listIndividualImportRows(a,stopped.attempt_id!,scopeIds(),999)).page).toBe(5);
  // A processed run needs the acknowledgement; the refusal removes nothing.
  await expect(requestIndividualImportRevert(a,{id:stopped.attempt_id!,scopeIds:scopeIds(),confirmProcessed:false})).rejects.toThrow('confirmProcessedRevert');
  expect(await imported()).toBe(250);
  expect(await requestIndividualImportRevert(a,{id:stopped.attempt_id!,scopeIds:scopeIds(),confirmProcessed:true})).toEqual({state:'reverting',queued:true});
  const reverted=await untilState(id,['reverted','stopped','completed']);
  expect(reverted.state).toBe('reverted');
  expect(await imported()).toBe(0);
  expect(await owner.db.select({id:schema.payrollIndividualTxn.id}).from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.tenantId,base.tenantId))).toEqual([{id:manual.id}]);
  expect(await readIndividualImportSummary(a,stopped.attempt_id!,scopeIds())).toMatchObject({state:'reverted',revertedCount:250,written:250});
 },300_000);

 it('keeps step outcomes append-only and refuses a transition the import did not make',async()=>{
  const a=adminCtx(base);
  const csv=toCsv([[...INDIVIDUAL_IMPORT_HEADERS.monthly],...rows(3)]);
  const input=await validateIndividualImport(a,{operationId:randomUUID(),sourceName:'small.xlsx',csv,method:'monthly',scopeIds:scopeIds()});
  const saved=await confirmIndividualImport(a,{id:input.id,scopeIds:scopeIds()});
  expect(saved).toMatchObject({state:'completed',written:3,processed:3});expect(saved.outcomes.map(o=>o.row.rowNum)).toEqual([2,3,4]);
  const denied=(statement:ReturnType<typeof sql>)=>withTenant(a,tx=>tx.execute(statement)).then(()=>'allowed',(e:{code?:string;cause?:{code?:string}})=>e.code??e.cause?.code??'error');
  expect(await denied(sql`update payroll_txn_import_outcome set state='failed' where attempt_id=${input.id}::uuid`)).toBe('42501');
  expect(await denied(sql`delete from payroll_txn_import_outcome where attempt_id=${input.id}::uuid`)).toBe('42501');
  expect(await denied(sql`insert into payroll_txn_import_outcome(attempt_id,row_num,tenant_id,state,outcome) values(${input.id}::uuid,99,${base.tenantId}::uuid,'invalid','{}'::jsonb)`)).toBe('42501');
  expect(await denied(sql`update payroll_txn_import_attempt set state='importing' where id=${input.id}::uuid`)).toBe('23514');
  expect(await denied(sql`update payroll_txn_import_attempt set processed=2 where id=${input.id}::uuid`)).toBe('23514');
 },120_000);
});
