/**
 * ADR 0181 payroll read addendum, change F (migration 7500): imported-history run summaries, inert behind the switch.
 *
 * Real history writers (fictional people): a processed and closed run, a history confirm that imports March records and
 * adopts February's processed payslip of one employee, then a correction. With P2 and P4 switched, the effective-run
 * view and the Payroll list (rows, employee counts, totals byte for byte, latest period, dashboard counts) are the same
 * with F legacy and with F switched:
 *  - before the worker projects (summaries absent), after it projects (served), after a history write moves the version
 *    (stale, so derived), after an employment company change of an employee with imported payslips, while a stage is
 *    in flight, for an employee who administers nothing, and for an untrusted tenant;
 *  - the served path derives no imported run (no call of payroll_history_batch_visible_totals for those runs);
 *  - the view is swapped only by the mode setter, guarded, and swapped back exactly; verify finds a tampered summary.
 */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {previewPayrollHistoryUpload,confirmPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {requestPayrollHistoryConfirm,payrollHistoryJobHandler} from '../core/payroll-history-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {runPayrollBatchSummaryTick} from '../core/payroll-batch-summary';
import {hireEmployee} from '../core/org';
import {createBatch,generatePayslips,closeBatch,listBatches,payrollDashboardCounts,latestPayrollDashboardPeriod} from '../core/payroll';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {historyRecordKey} from '../lib/payroll-history-revisions';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {asApp,calls,setStepMode} from './helpers/payroll-read-access';

const F='f_history_summary';
const year=2026,earlier=`${year}-03`,processed=`${year}-02`,CODES=['0007','0008','0009'];
const lines=(employee:string,period:string,amount:string)=>[[employee,period,'ME','BASIC','000AC',amount],[employee,period,'ME','EEEPF','000AC','0.00'],
 [employee,period,'ME','EESOCSO','000AC','0.00'],[employee,period,'ME','EEEIS','000AC','0.00'],[employee,period,'ME','PCB','000AC','0.00']];
const csv=(rows:string[][])=>Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows]));
const tick=()=>runBulkJobTick(owner.client,{handlers:[payrollHistoryJobHandler]});

let b:Base;let ctx:SessionContext;let self:SessionContext;const employments:Record<string,string>={};
beforeAll(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');ctx=await entitledCtx(b);
 await owner.db.update(schema.company).set({companyLabel:'000AC'}).where(eq(schema.company.id,b.companyId));
 await seedPayrollCycleCatalog(ctx,b.companyId);
 await owner.db.insert(schema.payComponent).values({tenantId:b.tenantId,code:'BASIC',name:'Basic salary',kind:'allowance',displayCategory:'basic',pcbRemunerationType:'normal',pcbExemptionCode:'PCB_TAXABLE'});
 let selfPerson='';
 for(const [i,code] of CODES.entries()){
  const hired=await hireEmployee(ctx,{person:{fullName:`Fictional summary employee ${code}`,primaryEmail:`summary-${code}-${randomUUID().slice(0,6)}@fixture.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:code,hiredOn:`${year-1}-01-01`});
  employments[code]=hired.employmentId;if(code==='0007')selfPerson=hired.personId;
  await setCompensation(ctx,{employmentId:hired.employmentId,basicSalary:4000+i*100,effectiveFrom:`${year-1}-01-01`});
  await setStatutoryProfileMY(ctx,{personId:hired.personId,icNumber:`85020202555${i}`,taxCategory:1,numChildren:0});
 }
 const run=await createBatch(ctx,{companyId:b.companyId,payPeriod:processed});
 await generatePayslips(ctx,{batchId:run.batchId});await closeBatch(ctx,{batchId:run.batchId});
 const preview=await previewPayrollHistoryUpload(ctx,{name:'history.csv',content:csv([...CODES.flatMap((code,i)=>lines(code,earlier,(5000+i).toFixed(2))),...lines('0007',processed,'6100.00')]),operationKey:randomUUID()});
 const replace=preview.plan.rows.find(r=>r.operation==='replace')!;
 await confirmPayrollHistoryUpload(ctx,{attemptId:preview.attemptId,previewHash:preview.plan.previewHash,confirmReplacement:true,selectedRecordKeys:[historyRecordKey(replace)],acknowledgeWarnings:true});
 const selfUser=await createAppUser(b.tenantId,selfPerson,'employee');
 self={tenantId:b.tenantId,userId:selfUser,personId:selfPerson,roles:['employee'],grants:[{role:'employee',companyId:null}],entitlements:ctx.entitlements};
 await setStepMode('p2_admin_companies','precomputed');await setStepMode('p4_history_filter','precomputed');
},600_000);
afterAll(async()=>{
 try{for(const step of [F,'p4_history_filter','p2_admin_companies'])await setStepMode(step,'legacy');await owner.client`delete from payroll_read_access_tenant`;}
 finally{await closeAll();}
});

const VIEW=sql`select id::text as id,employee_count,totals from payroll_history_effective_batch order by id`;
/** Everything the Payroll list and its dashboard show, for one reader. */
async function shown(viewer:SessionContext){
 const view=(await asApp(viewer,'1',async tx=>tx.execute<{id:string;employee_count:number;totals:unknown}>(VIEW))).value;
 return{
  view,
  list:(await listBatches(viewer,[b.companyId])).sort((x,y)=>x.id.localeCompare(y.id)),
  latest:await latestPayrollDashboardPeriod(viewer,[b.companyId]),
  dashboard:await payrollDashboardCounts(viewer,[b.companyId]),
 };
}
/** Calls of the per-run derivation while reading the view, for the imported runs only. */
async function derivations(viewer:SessionContext){
 return(await asApp(viewer,'1',async tx=>{
  const before=await calls(tx,['payroll_history_batch_visible_totals']);
  await tx.execute(sql`select id,totals from payroll_history_effective_batch where history_import_attempt_id is not null`);
  return(await calls(tx,['payroll_history_batch_visible_totals']))-before;
 })).value!;
}
async function same(label:string){
 await setStepMode(F,'legacy');const legacy={admin:await shown(ctx),self:await shown(self)};
 await setStepMode(F,'precomputed');const switched={admin:await shown(ctx),self:await shown(self)};
 expect(switched,label).toEqual(legacy);
 return legacy;
}
const imported=async()=>Number((await owner.client<{n:number}[]>`select count(*)::int as n from payroll_batch where tenant_id=${b.tenantId} and history_import_attempt_id is not null`)[0].n);
const version=async()=>(await owner.client<{v:string;p:string}[]>`select version::text as v,projected_version::text as p from payroll_batch_summary_state where tenant_id=${b.tenantId}`)[0];

describe('imported-history run summaries (7500)',()=>{
 it('installs inert: F legacy, the view unchanged, the summary owner only',async()=>{
  expect(await owner.client`select mode from payroll_read_access_control where step=${F}`).toEqual([{mode:'legacy'}]);
  const [def]=await owner.client<{d:string}[]>`select pg_get_viewdef('public.payroll_history_effective_batch'::regclass,true) as d`;
  expect(def.d).not.toContain('payroll_batch_summary');
  const [table]=await owner.client<{app:boolean}[]>`select has_table_privilege('ai_hr_app','public.payroll_batch_summary','SELECT') as app`;
  expect(table.app).toBe(false);
  // The worker does nothing while the step is legacy.
  expect(await runPayrollBatchSummaryTick(owner.client)).toBe(false);
  expect(await owner.client`select 1 from payroll_batch_summary where tenant_id=${b.tenantId}`).toHaveLength(0);
 });

 it('serves projected summaries with the same answers, and derives again whenever a summary is stale',async()=>{
  expect(await imported()).toBeGreaterThanOrEqual(1);
  // Not projected yet: derived, same answers.
  await same('unprojected');
  await setStepMode(F,'precomputed');
  expect(await derivations(ctx)).toBeGreaterThanOrEqual(await imported());
  // Projected: served, same answers, no derivation of an imported run for the administrator.
  expect(await runPayrollBatchSummaryTick(owner.client)).toBe(true);
  const v=await version();expect(v.p).toBe(v.v);
  expect(await owner.client`select 1 from payroll_batch_summary where tenant_id=${b.tenantId}`).toHaveLength(await imported());
  const served=await same('projected');
  expect((served.admin.view??[]).length).toBeGreaterThan(0);
  await setStepMode(F,'precomputed');
  expect(await derivations(ctx)).toBe(0);
  // The employee administers nothing: always derived.
  expect(await derivations(self)).toBeGreaterThanOrEqual(0);
  // A correction moves the version: stale, so derived, with the same answers; projecting serves again.
  const correction=await previewPayrollHistoryUpload(ctx,{name:'correction.csv',content:csv(lines('0008',earlier,'5300.00')),operationKey:randomUUID()});
  await confirmPayrollHistoryUpload(ctx,{attemptId:correction.attemptId,previewHash:correction.plan.previewHash,confirmReplacement:true,
   selectedRecordKeys:correction.plan.rows.filter(r=>r.operation==='replace').map(historyRecordKey),acknowledgeWarnings:true});
  const after=await version();expect(BigInt(after.v)).toBeGreaterThan(BigInt(after.p));
  await setStepMode(F,'precomputed');
  expect(await derivations(ctx)).toBeGreaterThanOrEqual(await imported());
  await same('stale after a correction');
  await runPayrollBatchSummaryTick(owner.client);
  await setStepMode(F,'precomputed');
  expect(await derivations(ctx)).toBe(0);
  await same('reprojected');
  // An employment company change of an employee with imported payslips moves the version.
  const [other]=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name) values(${b.tenantId}::uuid,'Fictional Summary Other Sdn Bhd') returning id`;
  const beforeMove=await version();
  await owner.client`update employment set company_id=${other.id} where id=${employments['0009']}`;
  expect(BigInt((await version()).v)).toBeGreaterThan(BigInt(beforeMove.v));
  await same('employee moved');
  await runPayrollBatchSummaryTick(owner.client);
  await same('employee moved, reprojected');
  await owner.client`update employment set company_id=${b.companyId} where id=${employments['0009']}`;
  await runPayrollBatchSummaryTick(owner.client);
  await setStepMode(F,'legacy');
 },900_000);

 it('derives while a stage is in flight, and for an untrusted tenant; verify finds a tampered summary',async()=>{
  await runPayrollBatchSummaryTick(owner.client);
  process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS='1';
  try{
   const staged=await previewPayrollHistoryUpload(ctx,{name:'staged.csv',content:csv(lines('0009',earlier,'5400.00')),operationKey:randomUUID()});
   const request=await requestPayrollHistoryConfirm(ctx,{attemptId:staged.attemptId,previewHash:staged.plan.previewHash,confirmReplacement:true,
    selectedRecordKeys:staged.plan.rows.filter(r=>r.operation==='replace').map(historyRecordKey),acknowledgeWarnings:true});
   if(!('jobId' in request))throw new Error('expected a job');
   for(let i=0;i<2000;i++){
    const [row]=await owner.client<{n:number;state:string}[]>`select (select count(*)::int from app.payroll_history_staged_row r where r.stage_id=${request.jobId}::uuid) as n,(select state from bulk_job where id=${request.jobId}::uuid) as state`;
    if(row.n>=1||!['running','queued','preparing'].includes(row.state))break;
    await tick();
   }
   expect(await owner.client`select 1 from app.payroll_history_stage where tenant_id=${b.tenantId} and state='staged'`).toHaveLength(1);
   await same('stage in flight');
   expect(await owner.client<{n:number}[]>`select app.payroll_batch_summary_project(${b.tenantId}::uuid) as n`).toEqual([{n:-1}]);
   for(let i=0;i<5000;i++){const [row]=await owner.client<{state:string;notified:boolean}[]>`select state,notified_at is not null as notified from bulk_job where id=${request.jobId}::uuid`;
    if(['completed','failed','cancelled'].includes(row.state)&&row.notified)break;if(!await tick())await new Promise(resolve=>setTimeout(resolve,25));}
  }finally{delete process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS;}
  await runPayrollBatchSummaryTick(owner.client);
  const [clean]=await owner.client<{r:{checked:number;differ:number;trusted:boolean}}[]>`select app.payroll_batch_summary_verify(${b.tenantId}::uuid) as r`;
  expect(clean.r).toMatchObject({differ:0,trusted:true});expect(Number(clean.r.checked)).toBe(await imported());
  // Tampered: verify marks the tenant untrusted, and every reader derives again with the right answer.
  await owner.client`update payroll_batch_summary set effective_totals=effective_totals||'{"gross":1}'::jsonb where batch_id=(select batch_id from payroll_batch_summary where tenant_id=${b.tenantId} order by batch_id limit 1)`;
  const [bad]=await owner.client<{r:{differ:number;trusted:boolean}}[]>`select app.payroll_batch_summary_verify(${b.tenantId}::uuid) as r`;
  expect(bad.r).toMatchObject({differ:1,trusted:false});
  await same('untrusted');
  await setStepMode(F,'precomputed');
  expect(await derivations(ctx)).toBeGreaterThanOrEqual(await imported());
  await setStepMode(F,'legacy');
 },900_000);

 it('the view is swapped only by the mode setter, guarded, and swapped back exactly',async()=>{
  const def=async()=>(await owner.client<{d:string}[]>`select pg_get_viewdef('public.payroll_history_effective_batch'::regclass,true) as d`)[0].d;
  const legacy=await def();
  await setStepMode(F,'precomputed');
  expect(await def()).toContain('payroll_batch_summary_served');
  await setStepMode(F,'legacy');
  expect(await def()).toBe(legacy);
  // A view that no longer matches its recorded text is never swapped over.
  const drifted=owner.client.begin(async tx=>{
   await tx.unsafe(`create or replace view public.payroll_history_effective_batch with (security_invoker=true) as ${legacy.replace(/;\s*$/,'').replace('THEN app.payroll_history_batch_visible_totals(b.id)','THEN app.payroll_history_batch_totals(b.id)')}`);
   await tx`select app.payroll_read_access_set_mode(${F},'precomputed')`;
  });
  await expect(drifted).rejects.toMatchObject({code:'55000'});
  expect(await def()).toBe(legacy);
  expect(await owner.client`select mode from payroll_read_access_control where step=${F}`).toEqual([{mode:'legacy'}]);
  await setStepMode(F,'legacy');
 },300_000);
});
