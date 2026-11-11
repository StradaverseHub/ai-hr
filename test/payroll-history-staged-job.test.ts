/**
 * Payroll history confirm and revert as staged all-or-nothing jobs (core/payroll-history-job.ts, draft migration 5055).
 *
 *  - Equivalence: the same file confirmed (and then reverted) through the single transaction on one tenant and through
 *    the job on an identical tenant leaves the same pay periods, batches, payslips, records, snapshots, revisions,
 *    history events and audit events (ids mapped to their business identities).
 *  - Invisibility: while the job's rows are staged no ordinary session, effective-payslip reader or audited definer
 *    sees any of them, and the ordinary payslip the import adopts stays effective; the release shows all at once.
 *  - All-or-nothing: a release whose plan changed meanwhile refuses exactly as the single transaction refused, deletes
 *    every staged row and records the attempt's failure once.
 *  - One history writer per tenant: a second job waits for the open stage instead of being refused.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {createHash,randomUUID} from 'node:crypto';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {previewPayrollHistoryUpload,confirmPayrollHistoryUpload,previewPayrollHistoryRevert,revertPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {requestPayrollHistoryConfirm,requestPayrollHistoryRevert,payrollHistoryJobHandler,payrollHistoryJobStatus} from '../core/payroll-history-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {hireEmployee} from '../core/org';
import {createBatch,generatePayslips,closeBatch} from '../core/payroll';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {historyRecordKey} from '../lib/payroll-history-revisions';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

// `earlier` is imported new (after the processed month, so nothing processed depends on it and it can be reverted);
// `processed` holds a closed processed run the file overwrites.
const year=Number(todayInKualaLumpur().slice(0,4))-2,earlier=`${year}-03`,processed=`${year}-02`;
const CODES=['0007','0008','0009'];
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
const tick=()=>runBulkJobTick(owner.client,{handlers:[payrollHistoryJobHandler]});
async function drain(jobId:string,until:(state:string)=>boolean=state=>['completed','failed','cancelled'].includes(state),max=5000){
 for(let i=0;i<max;i++){
  const [row]=await owner.client<{state:string;notified:boolean}[]>`select state,notified_at is not null as notified from bulk_job where id=${jobId}::uuid`;
  if(until(row.state)&&(!['completed','failed','cancelled'].includes(row.state)||row.notified))return row.state;
  if(!await tick())await new Promise(resolve=>setTimeout(resolve,25));
 }
 throw new Error('history job did not reach the wanted state');
}
type Tenant={b:Base;ctx:SessionContext;employments:Record<string,string>;ordinary:string};
async function tenant():Promise<Tenant>{
 const b=await seedBase();await setModule(b.tenantId,'payroll','active');const ctx=await entitledCtx(b);
 await owner.db.update(schema.company).set({companyLabel:'000AC'}).where(eq(schema.company.id,b.companyId));
 await seedPayrollCycleCatalog(ctx,b.companyId);
 await owner.db.insert(schema.payComponent).values({tenantId:b.tenantId,code:'BASIC',name:'Basic salary',kind:'allowance',displayCategory:'basic'});
 const employments:Record<string,string>={};
 for(const [i,code] of CODES.entries()){
  const hired=await hireEmployee(ctx,{person:{fullName:`Fictional history employee ${code}`,primaryEmail:`history-${code}-${randomUUID().slice(0,6)}@fixture.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:code,hiredOn:`${year-1}-01-01`});
  employments[code]=hired.employmentId;
  const [e]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,hired.employmentId));
  await setCompensation(ctx,{employmentId:hired.employmentId,basicSalary:4000+i*100,effectiveFrom:`${year-1}-01-01`});
  await setStatutoryProfileMY(ctx,{personId:e.personId,icNumber:`85020202555${i}`,taxCategory:1,numChildren:0});
 }
 // A processed, closed ordinary run the file overwrites (adoption) for one employee.
 const run=await createBatch(ctx,{companyId:b.companyId,payPeriod:processed});
 await generatePayslips(ctx,{batchId:run.batchId});await closeBatch(ctx,{batchId:run.batchId});
 return{b,ctx,employments,ordinary:run.batchId};
}
const lines=(employee:string,period:string,amount:string)=>[[employee,period,'ME','BASIC','000AC',amount],[employee,period,'ME','EEEPF','000AC','0.00'],
 [employee,period,'ME','EESOCSO','000AC','0.00'],[employee,period,'ME','EEEIS','000AC','0.00'],[employee,period,'ME','PCB','000AC','0.00']];
const file=()=>Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...CODES.flatMap((code,i)=>lines(code,earlier,(5000+i).toFixed(2))),...lines('0007',processed,'6100.00')]));
async function validated(t:Tenant){
 const preview=await previewPayrollHistoryUpload(t.ctx,{name:'history.csv',content:file(),operationKey:randomUUID()});
 expect(preview.plan.counts).toEqual({created:3,replaced:1,unchanged:0,invalid:0});
 const replace=preview.plan.rows.find(r=>r.operation==='replace')!;
 return{preview,input:{attemptId:preview.attemptId,previewHash:preview.plan.previewHash,confirmReplacement:true,selectedRecordKeys:[historyRecordKey(replace)],acknowledgeWarnings:true}};
}

/** The tenant's payroll history state with every id replaced by the business identity it stands for. */
async function state(t:Tenant,attemptId:string){
 const q=(text:ReturnType<typeof sql>)=>owner.db.execute<Record<string,unknown>>(text);
 const code=new Map(Object.entries(t.employments).map(([c,id])=>[id,c]));
 const batches=await q(sql`select b.id,b.pay_period,b.run_type,b.run_seq,b.status::text as status,b.employee_count,b.totals,b.remarks,b.history_import_cycle_name,b.batch_date::text as batch_date,
   b.history_import_attempt_id is not null as history,c.code as cycle,p.period as parent,b.scope,b.closed_at is not null as closed_at,b.released_at is not null as released_at,b.needs_recalc_at
  from payroll_batch b left join payroll_cycle c on c.id=b.payroll_cycle_id left join pay_period p on p.id=b.pay_period_id where b.tenant_id=${t.b.tenantId}::uuid`);
 const batchKey=new Map(batches.map(b=>[b.id as string,`${b.pay_period}#${b.run_seq}${b.history?'h':''}`]));
 const slips=await q(sql`select id,batch_id,employment_id,basic_salary,allowance,overtime_pay,bonus,gross_pay,statutory,other_deductions,total_deductions,net_pay,employer_cost from payslip where tenant_id=${t.b.tenantId}::uuid`);
 const slipKey=new Map(slips.map(s=>[s.id as string,`${batchKey.get(s.batch_id as string)}/${code.get(s.employment_id as string)}`]));
 const records=await q(sql`select r.id,r.employment_id,r.period,c.code as cycle from payroll_history_import_record r join payroll_cycle c on c.id=r.cycle_id where r.tenant_id=${t.b.tenantId}::uuid`);
 const recordKey=new Map(records.map(r=>[r.id as string,`${code.get(r.employment_id as string)}@${r.period}/${r.cycle}`]));
 const revisions=await q(sql`select id,record_id,ordinal,kind,cycle_name,snapshot_id,previous_revision_id from payroll_history_import_revision where tenant_id=${t.b.tenantId}::uuid`);
 const revisionKey=new Map(revisions.map(r=>[r.id as string,`${recordKey.get(r.record_id as string)}#${r.ordinal}`]));
 const snapshots=await q(sql`select id,record_id,value_hash,values from payroll_history_import_snapshot where tenant_id=${t.b.tenantId}::uuid`);
 const change=(c:Record<string,string|null>)=>({record:recordKey.get(c.recordId!),revision:revisionKey.get(c.revisionId!),previous:c.previousRevisionId?revisionKey.get(c.previousRevisionId):null,snapshot:c.snapshotId?slipKey.get(c.snapshotId):null});
 const events=await q(sql`select kind,changes,detail from payroll_history_import_event where attempt_id=${attemptId}::uuid order by created_at,kind`);
 const audit=await q(sql`select event_type,actor_type,payload from domain_event where aggregate_id=${attemptId}::uuid order by sequence nulls last,occurred_at,event_type`);
 const periods=await q(sql`select period,status::text as status,statutory_version from pay_period where tenant_id=${t.b.tenantId}::uuid`);
 // Ids that differ between two otherwise identical tenants, replaced by what they stand for (statutory JSON and audit
 // payloads carry some of them).
 const [person]=[await q(sql`select e.id,e.person_id from employment e where e.tenant_id=${t.b.tenantId}::uuid`)];
 const cycles=await q(sql`select id,code from payroll_cycle where tenant_id=${t.b.tenantId}::uuid`);
 const selections=await q(sql`select id,employment_id from employment_tax_selection_my where tenant_id=${t.b.tenantId}::uuid`);
 const salaries=await q(sql`select id,employment_id from compensation where tenant_id=${t.b.tenantId}::uuid`);
 const names=new Map<string,string>([[t.b.tenantId,'tenant'],[t.b.companyId,'company'],[t.b.adminUserId,'admin'],[t.ordinary,'ordinary-run'],
  ...Object.entries(t.employments).map(([c,id])=>[id,'employment:'+c] as [string,string]),
  ...person.map(r=>[r.person_id as string,'person:'+code.get(r.id as string)] as [string,string]),
  ...cycles.map(c=>[c.id as string,'cycle:'+c.code] as [string,string]),
  ...selections.map(r=>[r.id as string,'tax-selection:'+code.get(r.employment_id as string)] as [string,string]),
  ...salaries.map(r=>[r.id as string,'compensation:'+code.get(r.employment_id as string)] as [string,string])]);
 const sort=<T,>(rows:T[])=>rows.map(r=>JSON.stringify(r).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,id=>names.get(id)??id)).sort();
 return{
  periods:sort(periods),
  batches:sort(batches.map(b=>Object.fromEntries(Object.entries(b).filter(([k])=>k!=='id')))),
  payslips:sort(slips.map(s=>({key:slipKey.get(s.id as string),...Object.fromEntries(Object.entries(s).filter(([k])=>!['id','batch_id','employment_id'].includes(k)))}))),
  records:sort([...recordKey.values()]),
  // value_hash is the planner's canonical hash of the values (compared through the values themselves).
  snapshots:sort(snapshots.map(s=>({payslip:slipKey.get(s.id as string),record:recordKey.get(s.record_id as string),hashOfValues:s.value_hash===createHash('sha256').update(canonical(s.values)).digest('hex'),values:s.values}))),
  revisions:sort(revisions.map(r=>({key:revisionKey.get(r.id as string),kind:r.kind,cycle:r.cycle_name,snapshot:r.snapshot_id?slipKey.get(r.snapshot_id as string):null,previous:r.previous_revision_id?revisionKey.get(r.previous_revision_id as string):null}))),
  events:sort(events.map(e=>({kind:e.kind,changes:(e.changes as Record<string,string|null>[]).map(change),detail:e.detail}))),
  audit:sort(audit.map(e=>({type:e.event_type,actor:e.actor_type,payload:{...(e.payload as Record<string,unknown>),...((e.payload as {changes?:Record<string,string|null>[]}).changes?{changes:(e.payload as {changes:Record<string,string|null>[]}).changes.map(change)}:{})}}))),
 };
}

describe('payroll history confirm and revert as staged jobs',()=>{
 beforeAll(migrateTestDb);
 beforeEach(resetDb);
 afterAll(closeAll);

 it('confirms and reverts to the same end state as the single transaction, with the same events',async()=>{
  const sync=await tenant(),job=await tenant();
  const a=await validated(sync),bv=await validated(job);
  const done=await confirmPayrollHistoryUpload(sync.ctx,a.input);
  expect(done.changes).toHaveLength(4);
  const request=await requestPayrollHistoryConfirm(job.ctx,bv.input);
  if(!('jobId' in request))throw new Error('expected a job');
  // Nothing is written in the request.
  expect(await owner.db.select().from(schema.payrollHistoryImportRecord).where(eq(schema.payrollHistoryImportRecord.tenantId,job.b.tenantId))).toHaveLength(0);
  expect(await drain(request.jobId)).toBe('completed');
  const status=await payrollHistoryJobStatus(job.ctx,request.jobId);
  expect(status?.job.result).toMatchObject({attemptId:bv.preview.attemptId,changes:4,skippedReplacements:0,alreadyCommitted:false,importedRows:done.importedRows});
  expect(await state(job,bv.preview.attemptId)).toEqual(await state(sync,a.preview.attemptId));
  // The registry was cleared after the release; the stage is closed.
  expect(await owner.client`select 1 from app.payroll_history_staged_row`).toHaveLength(0);
  expect((await owner.client<{state:string}[]>`select state from app.payroll_history_stage where stage_id=${request.jobId}::uuid`)[0].state).toBe('released');
  // A repeated request for a committed attempt reports it, as before.
  expect(await requestPayrollHistoryConfirm(job.ctx,bv.input)).toMatchObject({alreadyCommitted:true});

  const syncReview=await previewPayrollHistoryRevert(sync.ctx,a.preview.attemptId),jobReview=await previewPayrollHistoryRevert(job.ctx,bv.preview.attemptId);
  expect(jobReview.count).toBe(syncReview.count);
  await revertPayrollHistoryUpload(sync.ctx,a.preview.attemptId,syncReview.previewHash);
  const revert=await requestPayrollHistoryRevert(job.ctx,bv.preview.attemptId,jobReview.previewHash);
  expect(await drain(revert.jobId)).toBe('completed');
  expect(await state(job,bv.preview.attemptId)).toEqual(await state(sync,a.preview.attemptId));
 },240000);

 it('refuses a revert exactly as the single transaction does, recording the same failure',async()=>{
  const sync=await tenant(),job=await tenant();
  for(const t of [sync,job]){
   const v=await validated(t);await confirmPayrollHistoryUpload(t.ctx,v.input);
   // A later month is processed: restoring the imported basis would change what it was worked out from.
   const run=await createBatch(t.ctx,{companyId:t.b.companyId,payPeriod:`${year}-04`});await generatePayslips(t.ctx,{batchId:run.batchId});
   Object.assign(t,{attemptId:v.preview.attemptId});
  }
  const hash='0'.repeat(64);
  const refusal=await revertPayrollHistoryUpload(sync.ctx,(sync as Tenant&{attemptId:string}).attemptId,hash).then(()=>null,(error:Error)=>error.message);
  expect(refusal).toMatch(/Normally processed payroll already depends/);
  const request=await requestPayrollHistoryRevert(job.ctx,(job as Tenant&{attemptId:string}).attemptId,hash);
  expect(await drain(request.jobId)).toBe('failed');
  expect((await owner.client<{error:string}[]>`select error from bulk_job where id=${request.jobId}::uuid`)[0].error).toBe(refusal);
  expect(await state(job,(job as Tenant&{attemptId:string}).attemptId)).toEqual(await state(sync,(sync as Tenant&{attemptId:string}).attemptId));
 },240000);

 it('keeps every staged row invisible until the release, then shows the whole attempt at once',async()=>{
  const t=await tenant();const v=await validated(t);
  process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS='1';
  try{
   const request=await requestPayrollHistoryConfirm(t.ctx,v.input);if(!('jobId' in request))throw new Error('expected a job');
   const visible=()=>withTenant(t.ctx,async tx=>({
    records:(await tx.select().from(schema.payrollHistoryImportRecord)).length,
    revisions:(await tx.select().from(schema.payrollHistoryImportRevision)).length,
    snapshots:(await tx.select().from(schema.payrollHistoryImportSnapshot)).length,
    batches:(await tx.select().from(schema.payrollBatch)).length,
    payslips:(await tx.select().from(schema.payslip)).length,
    runEarlier:(await tx.execute<{e:boolean}>(sql`select app.payroll_run_exists_for_periods(array[${earlier}]) as e`))[0].e,
    effective:(await tx.execute<{n:number}>(sql`select count(*)::int as n from payslip p where app.payroll_history_effective(p.id)`))[0].n,
   }));
   const before=await visible();
   // Run until the job has staged its batches and at least two records, but not released.
   for(let i=0;i<2000;i++){
    const [row]=await owner.client<{n:number;state:string}[]>`select (select count(*)::int from app.payroll_history_staged_row r where r.stage_id=${request.jobId}::uuid and r.relation='payroll_history_import_revision') as n,(select state from bulk_job where id=${request.jobId}::uuid) as state`;
    if(row.n>=3||row.state!=='running'&&row.state!=='queued'&&row.state!=='preparing')break;
    await tick();
   }
   expect((await owner.client<{state:string}[]>`select state from bulk_job where id=${request.jobId}::uuid`)[0].state).toBe('running');
   const staged=await owner.client<{relation:string;n:number}[]>`select relation,count(*)::int as n from app.payroll_history_staged_row where stage_id=${request.jobId}::uuid group by relation order by relation`;
   expect(staged.find(r=>r.relation==='payslip')!.n).toBeGreaterThan(0);
   expect(staged.find(r=>r.relation==='payroll_batch')!.n).toBeGreaterThanOrEqual(1);
   // Physically present, invisible to the payroll operator and to the effective-payslip and run readers.
   expect(await visible()).toEqual(before);
   expect(before.runEarlier).toBe(false);
   // The adopted ordinary payslip is still the effective one.
   const [adopted]=await owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.batchId,t.ordinary),eq(schema.payslip.employmentId,t.employments['0007'])));
   expect((await withTenant(t.ctx,tx=>tx.select().from(schema.payslip).where(eq(schema.payslip.id,adopted.id)))).length).toBe(1);
   // Another session cannot change a staged row either.
   const stagedBatch=(await owner.client<{row_id:string}[]>`select row_id from app.payroll_history_staged_row where stage_id=${request.jobId}::uuid and relation='payroll_batch' limit 1`)[0].row_id;
   expect(await withTenant(t.ctx,tx=>tx.update(schema.payrollBatch).set({remarks:'tampered'}).where(eq(schema.payrollBatch.id,stagedBatch)).returning({id:schema.payrollBatch.id}))).toEqual([]);
   expect(await drain(request.jobId)).toBe('completed');
   const after=await visible();
   // Four imported payslips appear; the overwritten processed payslip is set aside for every ordinary reader.
   expect(after).toMatchObject({records:4,batches:before.batches+2,payslips:before.payslips+3,runEarlier:true});
   expect(after.effective).toBe(before.effective+3);
  }finally{delete process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS;}
 },240000);

 it('refuses a release whose plan changed, deletes every staged row and records the failure once',async()=>{
  const t=await tenant();const v=await validated(t);
  process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS='1';
  try{
   const counts=async()=>Number((await owner.client<{n:number}[]>`select (select count(*) from payslip where tenant_id=${t.b.tenantId}::uuid)+(select count(*) from payroll_batch where tenant_id=${t.b.tenantId}::uuid)
     +(select count(*) from payroll_history_import_record where tenant_id=${t.b.tenantId}::uuid)+(select count(*) from payroll_history_import_snapshot where tenant_id=${t.b.tenantId}::uuid)
     +(select count(*) from payroll_history_import_revision where tenant_id=${t.b.tenantId}::uuid) as n`)[0].n);
   const before=await counts();
   const request=await requestPayrollHistoryConfirm(t.ctx,v.input);if(!('jobId' in request))throw new Error('expected a job');
   for(let i=0;i<50;i++){await tick();const [r]=await owner.client<{n:number}[]>`select count(*)::int as n from app.payroll_history_staged_row where stage_id=${request.jobId}::uuid`;if(r.n>2)break;}
   // Meanwhile an operator opens a run for the earlier month: the single transaction's re-plan refuses that month.
   await createBatch(t.ctx,{companyId:t.b.companyId,payPeriod:earlier});
   expect(await drain(request.jobId)).toBe('failed');
   const [job]=await owner.client<{error:string;state:string}[]>`select error,state from bulk_job where id=${request.jobId}::uuid`;
   expect(job.error).toBe('The source, master data, permissions or target revisions changed. Validate a new attempt.');
   // Every staged row is gone (the new draft run is the only addition), the stage is closed as discarded.
   expect(await counts()).toBe(before+1);
   expect(await owner.client`select 1 from app.payroll_history_staged_row where stage_id=${request.jobId}::uuid`).toHaveLength(0);
   expect((await owner.client<{state:string}[]>`select state from app.payroll_history_stage where stage_id=${request.jobId}::uuid`)[0].state).toBe('discarded');
   // The attempt's failure is recorded once, with the single transaction's reason and audit event.
   const failures=await owner.db.select().from(schema.payrollHistoryImportEvent).where(eq(schema.payrollHistoryImportEvent.attemptId,v.preview.attemptId));
   expect(failures.map(e=>[e.kind,e.detail])).toEqual([['failed',{reason:job.error}]]);
   const audit=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,v.preview.attemptId),eq(schema.domainEvent.eventType,'payroll-history-import.failed')));
   expect(audit.map(e=>e.payload)).toEqual([{reason:job.error}]);
   // The record is the creator's own (no job attribution: it is not owner work); its once-marker is on the job's plan,
   // written by the settle's owner transaction through the kernel's sealed job update.
   expect((await owner.client<{recorded:boolean|null}[]>`select (plan->>'failureRecorded')::boolean as recorded from bulk_job where id=${request.jobId}::uuid`)[0].recorded).toBe(true);
  }finally{delete process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS;}
 },240000);

 it('a batch without a pay period exists only while staged: a discard deletes every one, and no other can commit',async()=>{
  const t=await tenant();const v=await validated(t);
  const periodless=async()=>Number((await owner.client<{n:number}[]>`select count(*)::int as n from payroll_batch where tenant_id=${t.b.tenantId}::uuid and pay_period_id is null`)[0].n);
  expect(await periodless()).toBe(0);
  let draft='';
  process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS='1';
  try{
   const request=await requestPayrollHistoryConfirm(t.ctx,v.input);if(!('jobId' in request))throw new Error('expected a job');
   // Until the job has staged its batches: each has no pay period yet, and each is registered to the open stage.
   const stagedPeriodless=()=>owner.client<{id:string}[]>`select b.id::text from payroll_batch b join app.payroll_history_staged_row r on r.relation='payroll_batch' and r.row_id=b.id
    join app.payroll_history_stage s on s.stage_id=r.stage_id where s.stage_id=${request.jobId}::uuid and s.state='staged' and b.pay_period_id is null`;
   for(let i=0;i<2000&&(await stagedPeriodless()).length<2;i++)await tick();
   expect((await stagedPeriodless()).length).toBe(2);
   expect(await periodless()).toBe(2);
   // Meanwhile an operator opens a run for the earlier month: the release refuses and the job discards its stage.
   draft=(await createBatch(t.ctx,{companyId:t.b.companyId,payPeriod:earlier})).batchId;
   expect(await drain(request.jobId)).toBe('failed');
   expect((await owner.client<{state:string}[]>`select state from app.payroll_history_stage where stage_id=${request.jobId}::uuid`)[0].state).toBe('discarded');
   expect(await owner.client`select 1 from app.payroll_history_staged_row where stage_id=${request.jobId}::uuid`).toHaveLength(0);
   expect(await periodless()).toBe(0);
  }finally{delete process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS;}
  // Outside a staged history import no batch may be left without one, whoever writes it: the deferred check refuses
  // the commit (23502) and the operator's draft run keeps its period.
  const [before]=await owner.client<{pay_period_id:string}[]>`select pay_period_id::text from payroll_batch where id=${draft}::uuid`;
  expect(before.pay_period_id).toBeTruthy();
  await expect(owner.client.begin(async tx=>{await tx`update payroll_batch set pay_period_id=null where id=${draft}::uuid`;})).rejects.toMatchObject({code:'23502'});
  expect((await owner.client<{pay_period_id:string}[]>`select pay_period_id::text from payroll_batch where id=${draft}::uuid`)[0].pay_period_id).toBe(before.pay_period_id);
 },240000);

 it('re-derives a staged revert whose dependencies changed, and refuses it exactly as the single transaction would',async()=>{
  const t=await tenant();const v=await validated(t);
  const confirm=await requestPayrollHistoryConfirm(t.ctx,v.input);if(!('jobId' in confirm))throw new Error('expected a job');
  expect(await drain(confirm.jobId)).toBe('completed');
  const review=await previewPayrollHistoryRevert(t.ctx,v.preview.attemptId);
  process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS='1';
  try{
   const revert=await requestPayrollHistoryRevert(t.ctx,v.preview.attemptId,review.previewHash);
   for(let i=0;i<50;i++){await tick();const [r]=await owner.client<{n:number}[]>`select count(*)::int as n from app.payroll_history_staged_row where stage_id=${revert.jobId}::uuid`;if(r.n>=1)break;}
   // A later month is processed while the revert is staged: the restored basis would change what it was worked from.
   const run=await createBatch(t.ctx,{companyId:t.b.companyId,payPeriod:`${year}-04`});await generatePayslips(t.ctx,{batchId:run.batchId});
   expect(await drain(revert.jobId)).toBe('failed');
   const [job]=await owner.client<{error:string;rechecks:number}[]>`select error,(plan->>'rechecks')::int as rechecks from bulk_job where id=${revert.jobId}::uuid`;
   expect(job).toEqual({error:'Normally processed payroll already depends on this period or a later period in the same year.',rechecks:1});
   // Nothing of the revert remains; the import stays effective; the failure is recorded once.
   expect(await owner.client`select 1 from payroll_history_import_revision where tenant_id=${t.b.tenantId}::uuid and kind='revert'`).toHaveLength(0);
   const events=await owner.db.select().from(schema.payrollHistoryImportEvent).where(eq(schema.payrollHistoryImportEvent.attemptId,v.preview.attemptId));
   expect(events.map(e=>[e.kind,e.detail])).toEqual([['confirmed',expect.anything()],['revert_failed',{reason:job.error}]]);
  }finally{delete process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS;}
 },240000);

 it('waits for the open stage instead of refusing a second history job, and refuses a single-transaction writer meanwhile',async()=>{
  const t=await tenant();const v=await validated(t);
  const second=await previewPayrollHistoryUpload(t.ctx,{name:'other.csv',content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...lines('0008',`${year}-05`,'4321.00')])),operationKey:randomUUID()});
  process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS='1';
  try{
   const first=await requestPayrollHistoryConfirm(t.ctx,v.input);if(!('jobId' in first))throw new Error('expected a job');
   await drain(first.jobId,state=>state==='running');
   const next=await requestPayrollHistoryConfirm(t.ctx,{attemptId:second.attemptId,previewHash:second.plan.previewHash,confirmReplacement:false});
   if(!('jobId' in next))throw new Error('expected a job');
   await expect(confirmPayrollHistoryUpload(t.ctx,{attemptId:second.attemptId,previewHash:second.plan.previewHash,confirmReplacement:false})).rejects.toThrow(/being committed/);
   for(let i=0;i<20;i++)await tick();
   expect((await owner.client<{state:string;retries:number}[]>`select state,transient_retries as retries from bulk_job where id=${next.jobId}::uuid`)[0]).toMatchObject({state:'preparing',retries:0});
   expect(await drain(first.jobId)).toBe('completed');
   expect(await drain(next.jobId)).toBe('completed');
  }finally{delete process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS;}
 },240000);
});
