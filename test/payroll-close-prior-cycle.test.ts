/** Design review, 4 November 2026 (migration 2011 edited before application): the payroll close circuit's prior cycle, on
 * fictional data, over the real owners and the real database.
 *
 *  1. The prior cycle is the latest CLOSED run of the same run type in an earlier month. A draft (a reset run goes back to
 *     draft) or a processed run is unfinished and is never "last month": not in the anomaly context's prior
 *     (core/payroll-anomaly.ts gatherContext), not in the ordinary circuit evaluation, not in
 *     app.payroll_close_circuit_inputs, and app.payroll_close_source_people accepts only that prior.
 *  2. The two close functions are SECURITY DEFINER, so they bypass the restrictive payroll_history_effective_only policy on
 *     payslip (0602). A payslip a payroll-history import has superseded is excluded from their sums and their source people,
 *     exactly as the ordinary (row-level security) reader excludes it.
 * payroll_status is exactly draft, processed and closed (db/schema.ts); there is no cancelled value. Expected values are
 * written out from the fixtures or read independently from the stored rows. No model is called. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {createBatch,generatePayslips,closeBatch} from '../core/payroll';
import {evaluateCircuitBreakerForCloseTx,evaluateCircuitBreakerWithSourceTx,loadBatchContexts} from '../core/payroll-anomaly';
import {previewPayrollHistoryUpload,confirmPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {historyRecordKey} from '../lib/payroll-history-revisions';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,ctx:SessionContext,group:SessionContext;
/** A database refusal's text: the driver wraps the server's message in its own error's cause. */
const pgText=(error:unknown)=>{const parts:string[]=[];for(let cur=error as Record<string,unknown>|undefined,n=0;cur&&typeof cur==='object'&&n<5;cur=cur.cause as never,n++)
 for(const key of ['message','detail'])if(typeof cur[key]==='string')parts.push(cur[key] as string);return parts.join(' | ');};
const refused=async(work:Promise<unknown>)=>{const error=await work.then(()=>null,(caught:unknown)=>caught);
 expect(error,'the database refuses it').not.toBeNull();expect(pgText(error)).toMatch(/Payroll source unavailable/);};
type CloseInputs={prior_batch_id:string|null;current_net:number;prior_net:number;inputs_visible:boolean};
const closeInputs=async(batchId:string)=>(await withTenant(group,tx=>tx.execute(sql`select prior_batch_id,current_net,prior_net,inputs_visible from app.payroll_close_circuit_inputs(${batchId}::uuid)`)) as unknown as CloseInputs[])[0];
const sourcePeople=async(batchId:string,priorId:string|null)=>(await withTenant(group,tx=>tx.execute(sql`select app.payroll_close_source_people(${batchId}::uuid,${priorId}::uuid,array[]::uuid[]) as people`)) as unknown as {people:string[]}[])[0].people;
const evaluated=(batchId:string)=>withTenant(group,tx=>evaluateCircuitBreakerWithSourceTx(tx,b.tenantId,batchId));
const atClose=(batchId:string)=>withTenant(group,tx=>evaluateCircuitBreakerForCloseTx(tx,b.tenantId,batchId));

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 for(const module of ['payroll','multi_cycle_payroll'])await setModule(b.tenantId,module,'active');
 ctx=await entitledCtx(b);
 const userId=await createAppUser(b.tenantId,null,'hr_admin');
 group={...(await entitledCtx(b,['hr_admin'])),userId,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
});

describe('the prior cycle is the latest closed run of the same run type',()=>{
 /** One run of `runType` in its own month, with `status`, paying the one fictional employee `net`. */
 async function run(employmentId:string,period:string,status:'draft'|'processed'|'closed',net:string,runType:'regular'|'bonus'='regular'){
  const [existing]=await owner.db.select({id:schema.payPeriod.id}).from(schema.payPeriod).where(eq(schema.payPeriod.period,period));
  const periodId=existing?.id??(await owner.db.insert(schema.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period,status:'open'}).returning({id:schema.payPeriod.id}))[0].id;
  const [batch]=await owner.db.insert(schema.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:periodId,payPeriod:period,
   runType,runSeq:runType==='regular'?1:2,batchDate:`${period}-28`,status}).returning({id:schema.payrollBatch.id});
  await owner.db.insert(schema.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId,basicSalary:net,grossPay:net,totalDeductions:'0.00',
   netPay:net,employerCost:net,daysWorked:'30.00',statutory:{}});
  return batch.id;
 }
 it('ignores a draft and a processed earlier month, uses the last closed one, and moves when a later month closes',async()=>{
  const hired=await hireEmployee(ctx,{person:{fullName:'Fictional prior-cycle employee',primaryEmail:`prior-${randomUUID()}@fixture.test`},companyId:b.companyId,
   departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
  const employmentId=hired.employmentId;
  const march=await run(employmentId,'2026-03','closed','4000.00');
  const april=await run(employmentId,'2026-04','draft','9000.00');
  const may=await run(employmentId,'2026-05','processed','8000.00');
  // A closed run of another type in a later earlier month: still not a regular run's prior (B2, unchanged).
  await run(employmentId,'2026-05','closed','7000.00','bonus');
  const june=await run(employmentId,'2026-06','processed','4100.00');

  const contextPrior=async()=>(await loadBatchContexts(group,{batchId:june}))?.find(c=>c.employmentId===employmentId)?.prior?.netPay??null;
  // The anomaly context, the ordinary circuit evaluation, the close inputs and the close-time evaluation all take March.
  expect(await contextPrior()).toBe(4000);
  const ordinary=await evaluated(june);
  expect([ordinary.source.priorBatchId,ordinary.verdict.priorNet,ordinary.verdict.currentNet]).toEqual([march,4000,4100]);
  expect(await closeInputs(june)).toMatchObject({prior_batch_id:march,current_net:4100,prior_net:4000,inputs_visible:true});
  const close=await atClose(june);
  expect([close.source.priorBatchId,close.verdict.priorNet]).toEqual([march,4000]);
  // The close source check accepts March and refuses the unfinished April and May runs.
  expect(await sourcePeople(june,march)).toEqual([hired.personId]);
  await refused(sourcePeople(june,april));
  await refused(sourcePeople(june,may));

  // May closes: it is now the last closed regular run, everywhere, and March is no longer accepted as the prior.
  await owner.db.update(schema.payrollBatch).set({status:'closed',closedAt:new Date()}).where(eq(schema.payrollBatch.id,may));
  expect(await contextPrior()).toBe(8000);
  expect((await evaluated(june)).source.priorBatchId).toBe(may);
  expect(await closeInputs(june)).toMatchObject({prior_batch_id:may,current_net:4100,prior_net:8000});
  expect((await atClose(june)).source.priorBatchId).toBe(may);
  expect(await sourcePeople(june,may)).toEqual([hired.personId]);
  await refused(sourcePeople(june,march));
 },120_000);

 it('has no prior at all when every earlier month of the run type is unfinished',async()=>{
  const hired=await hireEmployee(ctx,{person:{fullName:'Fictional first-close employee',primaryEmail:`first-${randomUUID()}@fixture.test`},companyId:b.companyId,
   departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
  const april=await run(hired.employmentId,'2026-04','draft','9000.00');
  await run(hired.employmentId,'2026-05','processed','8000.00');
  const june=await run(hired.employmentId,'2026-06','processed','4100.00');
  expect((await loadBatchContexts(group,{batchId:june}))?.[0]?.prior).toBeNull();
  const ordinary=await evaluated(june);
  expect([ordinary.source.priorBatchId,ordinary.verdict.skippedReason]).toEqual([null,'no prior cycle to compare against']);
  expect(await closeInputs(june)).toMatchObject({prior_batch_id:null,prior_net:0,current_net:4100});
  expect(await sourcePeople(june,null)).toEqual([hired.personId]);
  await refused(sourcePeople(june,april));
 },120_000);
});

describe('the close functions read only effective payslips',()=>{
 const year=Number(todayInKualaLumpur().slice(0,4))-2,january=`${year}-01`,february=`${year}-02`;
 const rows=(amount:string,employee:string)=>[
  [employee,january,'ME','BASIC','000AC',amount],[employee,january,'ME','EEEPF','000AC','0.00'],
  [employee,january,'ME','EESOCSO','000AC','0.00'],[employee,january,'ME','EEEIS','000AC','0.00'],[employee,january,'ME','PCB','000AC','0.00'],
 ];
 it('excludes a payslip a payroll-history import superseded from the close sums and the source people',async()=>{
  await owner.db.update(schema.company).set({companyLabel:'000AC'}).where(eq(schema.company.id,b.companyId));
  await seedPayrollCycleCatalog(ctx,b.companyId);
  await owner.db.insert(schema.payComponent).values({tenantId:b.tenantId,code:'BASIC',name:'Basic salary',kind:'allowance',displayCategory:'basic'});
  const people:{employmentId:string;personId:string}[]=[];
  for(const [i,code] of ['0007','0008'].entries()){
   const hired=await hireEmployee(ctx,{person:{fullName:`Fictional effective employee ${code}`,primaryEmail:`effective-${code}-${randomUUID()}@fixture.test`},companyId:b.companyId,
    departmentId:b.deptA,employmentType:'full_time',employeeCode:code,hiredOn:`${year-1}-01-01`});
   await setCompensation(ctx,{employmentId:hired.employmentId,basicSalary:4000+500*i,effectiveFrom:`${year-1}-01-01`});
   await setStatutoryProfileMY(ctx,{personId:hired.personId,icNumber:`85020202555${i}`,taxCategory:1,numChildren:0});
   people.push({employmentId:hired.employmentId,personId:hired.personId});
  }
  const [corrected,kept]=people;
  // January: an ordinary regular run, processed and closed, paying both.
  const jan=(await createBatch(ctx,{companyId:b.companyId,payPeriod:january})).batchId;
  await generatePayslips(ctx,{batchId:jan});await closeBatch(ctx,{batchId:jan});
  const janSlips=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,jan));
  const correctedSlip=janSlips.find(slip=>slip.employmentId===corrected.employmentId)!,keptSlip=janSlips.find(slip=>slip.employmentId===kept.employmentId)!;
  expect(correctedSlip&&keptSlip,'fixture: January pays both employees').toBeTruthy();
  // A payroll-history import overwrites the first employee's January: their January payslip is superseded (0602).
  const preview=await previewPayrollHistoryUpload(ctx,{name:'history.csv',content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows('6000.00','0007')])),operationKey:randomUUID()});
  const row=preview.plan.rows[0];
  expect(row).toMatchObject({operation:'replace',overwriteSource:'processed',expectedOrdinaryPayslipId:correctedSlip.id});
  await confirmPayrollHistoryUpload(ctx,{attemptId:preview.attemptId,previewHash:preview.plan.previewHash,confirmReplacement:true,selectedRecordKeys:[historyRecordKey(row)],acknowledgeWarnings:true});
  // The ordinary reader (row-level security) sees only the kept employee's January payslip; the stored rows are both still there.
  const visible=await withTenant(group,tx=>tx.select({id:schema.payslip.id}).from(schema.payslip).where(eq(schema.payslip.batchId,jan)));
  expect(visible.map(slip=>slip.id)).toEqual([keptSlip.id]);
  expect(await owner.db.select({id:schema.payslip.id}).from(schema.payslip).where(eq(schema.payslip.batchId,jan))).toHaveLength(2);

  // February: a regular run for the kept employee only. Its prior is January's closed regular run (the import's own
  // closed run is an adjustment run, so it is not a regular run's prior).
  const feb=(await createBatch(ctx,{companyId:b.companyId,payPeriod:february,scope:{employmentIds:[kept.employmentId]}})).batchId;
  await generatePayslips(ctx,{batchId:feb});
  const [febSlip]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,feb));
  expect(febSlip?.employmentId,'fixture: February pays the kept employee only').toBe(kept.employmentId);
  const keptNet=Number(keptSlip.netPay),supersededNet=Number(correctedSlip.netPay);
  expect(supersededNet,'fixture: the superseded payslip paid something').toBeGreaterThan(0);

  const inputs=await closeInputs(feb);
  expect(inputs).toMatchObject({prior_batch_id:jan,current_net:Number(febSlip.netPay),prior_net:keptNet,inputs_visible:true});
  // The same January the ordinary evaluation reads under row-level security, and the close-time evaluation.
  const ordinary=await evaluated(feb),close=await atClose(feb);
  expect([ordinary.source.priorBatchId,ordinary.verdict.priorNet]).toEqual([jan,keptNet]);
  expect([close.source.priorBatchId,close.verdict.priorNet]).toEqual([jan,keptNet]);
  // The superseded payslip's employee is not a source person of February's close.
  expect(await sourcePeople(feb,jan)).toEqual([kept.personId]);
 },180_000);
});
