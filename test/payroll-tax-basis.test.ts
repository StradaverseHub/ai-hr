import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {client,withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {requestPayrollHistoryConfirm,payrollHistoryJobHandler} from '../core/payroll-history-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {draftTaxReadinessJobHandler, readDraftTaxReadiness, requestDraftTaxReadiness} from '../core/payroll-draft-tax-readiness';
import {createCompany} from '../core/admin';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {eaStatement} from '../localization/my/reports';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {createBatch,generatePayslips} from '../core/payroll';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {previewPayrollHistoryUpload,confirmPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {previewTaxBasisRecalculation,confirmTaxBasisRecalculation,taxBasisOptions,getTaxBasisBatch,listTaxBasisBatches,listTaxBasisHistory,continueTaxBasisBatch,recoverTaxBasisBatch} from '../core/payroll-tax-basis';
import {requestTaxBasisGroupPreview,requestTaxBasisGroupConfirmation,readTaxBasisGroupProgress,listQueuedTaxBasisRuns,taxBasisGroupJobHandler} from '../core/payroll-tax-basis-group';
import {taxBasisSourceRowsTx,hashTaxBasisSource,readEffectiveTaxBasesTx} from '../core/payroll-tax-basis-read';
import {lockPayrollHistoryWriteTx} from '../core/payroll-history-lock';
import {lockAccessConfigurationWriteTx} from '../core/access-configuration-lock';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {closeAll,entitledCtx,owner,resetDb,seedBase,setModule,createAppUser,type Base} from './harness';
// Two connections leave exactly one background permit, as on the installed staging worker.
vi.hoisted(()=>{
 vi.stubEnv('AIHR_DB_PROCESS_ROLE','worker');
 vi.stubEnv('AIHR_DB_POOL_MAX','2');
});
beforeAll(()=>vi.unstubAllEnvs());

let b:Base,ctx:SessionContext,employee:string,travel:string;
const rows=(employeeNo:string,amount='500')=>['01','02','03'].flatMap(month=>[
 [employeeNo,`2026-${month}`,'ME','BASIC','TAXCO','5000'],[employeeNo,`2026-${month}`,'ME','TRV','TAXCO',amount],
 [employeeNo,`2026-${month}`,'ME','EEEPF','TAXCO','0'],[employeeNo,`2026-${month}`,'ME','EESOCSO','TAXCO','0'],
 [employeeNo,`2026-${month}`,'ME','EEEIS','TAXCO','0'],[employeeNo,`2026-${month}`,'ME','PCB','TAXCO','0'],
]);
async function upload(employeeNo='0007',amount='500'){
 const draft=await previewPayrollHistoryUpload(ctx,{name:'source.csv',operationKey:randomUUID(),content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows(employeeNo,amount)]))});
 expect(draft.plan.counts.invalid).toBe(0);await confirmPayrollHistoryUpload(ctx,{attemptId:draft.attemptId,previewHash:draft.plan.previewHash,confirmReplacement:true});return draft;
}
const selection=()=>({companyId:b.companyId,year:2026,upToMonth:3,employmentIds:[employee]});
const confirm=(p:Awaited<ReturnType<typeof previewTaxBasisRecalculation>>)=>confirmTaxBasisRecalculation(ctx,{previewId:p.previewId,previewHash:p.previewHash});
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');ctx=await entitledCtx(b);
 await owner.db.update(schema.company).set({companyLabel:'TAXCO'}).where(eq(schema.company.id,b.companyId));await seedPayrollCycleCatalog(ctx,b.companyId);
 const [component]=await owner.db.insert(schema.payComponent).values({tenantId:b.tenantId,code:'TRV',name:'Travel allowance',kind:'allowance',displayCategory:'allowance',includedInPcb:false,pcbRemunerationType:'normal',pcbExemptionCode:'PCB_TAXABLE'}).returning({id:schema.payComponent.id});travel=component.id;
 employee=(await hireEmployee(ctx,{person:{fullName:'Fictional Aina',primaryEmail:'tax-fixture@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'0007',hiredOn:'2025-01-01'})).employmentId;
 await upload();await owner.db.update(schema.payComponent).set({includedInPcb:true}).where(eq(schema.payComponent.id,travel));
});
afterAll(closeAll);
describe('authorized immutable historical income tax corrections',()=>{
 it('reconstructs the original RM500 monthly input, preserves closed payroll and repeats safely',async()=>{
  const original=await owner.db.select().from(schema.payslip);
  const p=await previewTaxBasisRecalculation(ctx,selection());expect(p.eligibleCount).toBe(1);expect(p.recordCount).toBe(3);
  expect(p.employees[0].months.map(m=>m.taxable)).toEqual([5500,5500,5500]);expect(p.employees[0].months.map(m=>m.ytdTaxable)).toEqual([5500,11000,16500]);
  expect(p.employees[0].months[0].items.find(i=>i.code==='TRV')).toMatchObject({amount:500,taxable:500,previousTreatment:'Non-Taxable'});expect(p.totals.beforeTaxable).toBe(15000);
  const done=await confirm(p);expect((await getTaxBasisBatch(ctx,done.id))?.status).toBe('completed');
  expect(await owner.db.select().from(schema.payslip)).toEqual(original);
  const corrected=await withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,original.map(s=>s.id)));expect([...corrected.values()].map(c=>c.basis.pcb)).toEqual([5500,5500,5500]);
  for(const value of corrected.values())expect(value.statutory.pcb).toBe(0);
  expect(await confirm(p)).toEqual(done);expect(await continueTaxBasisBatch(ctx,done.id)).toEqual(done);
  const revisions=await owner.db.select().from(schema.payrollTaxBasisRevision);expect(revisions).toHaveLength(3);
  const repeated=await previewTaxBasisRecalculation(ctx,selection());expect(repeated.unchangedCount).toBe(1);expect(repeated.eligibleCount).toBe(0);
  await owner.db.update(schema.payComponent).set({includedInPcb:false}).where(eq(schema.payComponent.id,travel));
  const next=await previewTaxBasisRecalculation(ctx,selection());expect(next.eligibleCount).toBe(1);expect(next.employees[0].months[0].items.find(i=>i.code==='TRV')?.previousTreatment).toMatch(/Taxable/);expect(next.employees[0].months[0].taxable).toBe(5000);
 });
 it('previews from a read-only snapshot while a history writer and an Access editor hold their exclusive locks',async()=>{
  // Before, the preview took the history barrier and the exclusive Access lock for its whole computation (up to
  // 25 s), so it waited here and every payroll calculation queued behind it. Now it neither waits nor blocks.
  const preview=await withTenant(ctx,async tx=>{
   await lockPayrollHistoryWriteTx(tx,b.tenantId);await lockAccessConfigurationWriteTx(tx,b.tenantId);
   let timer:ReturnType<typeof setTimeout>|undefined;
   const waited=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('the preview waited for a tenant-wide lock')),20000);});
   try{return await Promise.race([previewTaxBasisRecalculation(ctx,selection()),waited]);}finally{clearTimeout(timer);}
  });
  expect(preview.eligibleCount).toBe(1);expect(preview.recordCount).toBe(3);
  // The saved preview is the one a confirmation recomputes and checks under the write locks.
  const batch=await confirm(preview);expect((await getTaxBasisBatch(ctx,batch.id))?.completedCount).toBe(1);
 });
 it('allows a selected employee without saved history alongside exact outcomes',async()=>{
  const missing=await hireEmployee(ctx,{person:{fullName:'Fictional No History',primaryEmail:'tax-no-history@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'0008',hiredOn:'2025-01-01'});
  const original=await owner.db.select().from(schema.payslip);
  const p=await previewTaxBasisRecalculation(ctx,{...selection(),employmentIds:[employee,missing.employmentId]});
  expect(p.eligibleCount).toBe(1);
  expect(p.skippedCount).toBe(1);
  expect(p.employees.find(row=>row.id===missing.employmentId)).toMatchObject({status:'skipped',recordCount:0,months:[]});
  const result=await confirm(p);
  expect((await getTaxBasisBatch(ctx,result.id))?.employees.find(row=>row.id===missing.employmentId)?.status).toBe('skipped');
  expect(await owner.db.select().from(schema.payslip)).toEqual(original);
 });

 it('queues one combined confirmation, retains company outcomes and retries idempotently',async()=>{
  const other=await createCompany(ctx,{legalName:'Fictional second employer',country:'MY',currency:'MYR'});
  const selections=[selection(),{...selection(),companyId:other.id,employmentIds:[]}];
  const singleCompany={...ctx,grants:[{role:'hr_admin',companyId:b.companyId}]};
  await expect(requestTaxBasisGroupPreview(singleCompany,selections,randomUUID())).rejects.toThrow(/unavailable/);
  const previewId=await requestTaxBasisGroupPreview(ctx,selections,randomUUID());
  async function finish(id:string){
   for(let n=0;n<14;n++){
    await runBulkJobTick(owner.client,{handlers:[taxBasisGroupJobHandler]});
    const result=await readTaxBasisGroupProgress(ctx,id);
    if(result.progress.state==='completed')return result;
    expect(result.progress.state,JSON.stringify(result.progress)).not.toBe('failed');
   }
   throw Error('Grouped recalculation did not finish.');
  }
  const p=await finish(previewId);
  expect(p.previews?.map(company=>[company.companyId,company.eligibleCount])).toEqual([[b.companyId,1],[other.id,0]]);
  expect(p.employees?.map(row=>[row.companyId,row.id])).toEqual([[b.companyId,employee]]);
  await expect(requestTaxBasisGroupConfirmation(singleCompany,previewId)).rejects.toThrow(/unavailable|access/);
  const job=await requestTaxBasisGroupConfirmation(ctx,previewId);
  expect(await requestTaxBasisGroupConfirmation(ctx,previewId)).toBe(job);
  // a16382b4 — before the worker reaches it, only the submitter sees the company queued; the company with no
  // eligible employee never gets a batch and is not listed. Another payroll administrator sees nothing yet.
  expect(await listQueuedTaxBasisRuns(ctx)).toEqual([expect.objectContaining({id:'queued:'+job+':'+b.companyId,kind:'queued',reference:null,
   companyId:b.companyId,status:'pending',year:2026,upToMonth:3,employeeCount:1,processedCount:0,batches:[]})]);
  const colleague=await createAppUser(b.tenantId,null,'hr_admin');
  expect(await listQueuedTaxBasisRuns({...ctx,userId:colleague})).toEqual([]);
  expect((await listTaxBasisHistory(ctx)).rows).toEqual([]);
  const after=await finish(job);
  expect(await listQueuedTaxBasisRuns(ctx)).toEqual([]);
  expect((await listTaxBasisHistory(ctx)).rows.map(row=>[row.id,row.status,row.processedCount])).toEqual([[job+':'+b.companyId,'completed',1]]);
  expect(after.batches).toEqual([expect.objectContaining({companyId:b.companyId,id:expect.any(String),error:null}),
    expect.objectContaining({companyId:other.id,id:null,error:null})]);
  expect(await requestTaxBasisGroupConfirmation(ctx,previewId)).toBe(job);
  expect(await owner.db.select().from(schema.payrollTaxBasisRevision)).toHaveLength(3);
 });
 it('previews one full company across worker steps and completes its reviewed corrections in the worker',async()=>{
  expect(client.options.max).toBe(2);
  const imported=[];
  for(let index=0;index<21;index++){
   const code='Q'+String(index).padStart(3,'0');
   await hireEmployee(ctx,{person:{fullName:'Fictional employee '+code,primaryEmail:code+'@example.test'},companyId:b.companyId,
    departmentId:b.deptA,employmentType:'full_time',employeeCode:code,hiredOn:'2025-01-01'});
   imported.push(...rows(code).slice(0,6));
  }
  const draft=await previewPayrollHistoryUpload(ctx,{name:'company.csv',operationKey:randomUUID(),
   content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...imported]))});
  expect(draft.plan.counts.invalid).toBe(0);
  await confirmPayrollHistoryUpload(ctx,{attemptId:draft.attemptId,previewHash:draft.plan.previewHash,confirmReplacement:true});
  await owner.db.update(schema.payComponent).set({includedInPcb:false}).where(eq(schema.payComponent.id,travel));
  const previewJob=await requestTaxBasisGroupPreview(ctx,[{...selection(),employmentIds:null}],randomUUID());
  // a16382b4 — every running read reports employee counts from recorded work: never above the total, never backwards.
  const seen:{processed:number;total:number;failures:number}[]=[];
  async function finish(id:string){
   seen.length=0;
   for(let attempt=0;attempt<20;attempt++){
    await runBulkJobTick(owner.client,{handlers:[taxBasisGroupJobHandler]});
    const result=await readTaxBasisGroupProgress(ctx,id);
    if(result.counts){
     expect(result.counts.processed).toBeLessThanOrEqual(result.counts.total);
     expect(result.counts.processed).toBeGreaterThanOrEqual(seen.at(-1)?.processed??0);
     expect(result.companies?.reduce((n,company)=>n+company.total,0)).toBe(result.counts.total);
     seen.push(result.counts);
    }
    if(result.progress.state==='completed')return result;
    expect(result.progress.state,JSON.stringify(result.progress)).not.toBe('failed');
   }
   throw Error('Full-company tax correction did not finish.');
  }
  const result=await finish(previewJob);
  expect(seen.filter(counts=>counts.total>0).map(counts=>counts.total)).toContain(22);
  expect(result.previews).toHaveLength(2);
  expect(result.previews?.every(preview=>preview.selection==='all')).toBe(true);
  expect(result.totalEmployees).toBe(22);
  expect(new Set(result.employees?.map(row=>row.id)).size).toBe(22);
  expect(result.previews?.reduce((count,preview)=>count+preview.eligibleCount,0)).toBe(21);
  const confirmation=await requestTaxBasisGroupConfirmation(ctx,previewJob);
  const outcomes=await finish(confirmation);
  expect(outcomes.batches).toHaveLength(2);
  for(const row of outcomes.batches??[]){
   expect(row.error).toBeNull();
   expect(row.id).toBeTruthy();
   if(row.id)expect((await getTaxBasisBatch(ctx,row.id))?.status).toBe('completed');
  }
  expect(seen.filter(counts=>counts.total>0).every(counts=>counts.total===21)).toBe(true);
  expect(await owner.db.select().from(schema.payrollTaxBasisRevision)).toHaveLength(21);
  // Both employee groups carry the confirmation job as their run, and history shows them as one company row.
  const stamped=await owner.db.select({id:schema.payrollTaxBasisBatch.id,runId:schema.payrollTaxBasisBatch.runId}).from(schema.payrollTaxBasisBatch);
  expect(stamped.map(row=>row.runId)).toEqual([confirmation,confirmation]);
  const history=await listTaxBasisHistory(ctx);
  expect(history).toEqual({next:null,rows:[expect.objectContaining({id:confirmation+':'+b.companyId,kind:'batch',companyId:b.companyId,status:'completed',
   employeeCount:21,processedCount:21,completedCount:21,failedCount:0,notIncludedCount:1,interrupted:false,completedAt:expect.any(String),
   batches:expect.arrayContaining(stamped.map(row=>({id:row.id,reference:'TAX-'+row.id.toUpperCase()})))})]});
  expect(history.rows[0].batches).toHaveLength(2);
  expect(await listQueuedTaxBasisRuns(ctx)).toEqual([]);
 },90000);
 it('adds the run link to populated batches without changing them and keeps a single-preview batch its own run (7120)',async()=>{
  const p=await previewTaxBasisRecalculation(ctx,selection());const {id}=await confirm(p);
  expect((await owner.db.select({runId:schema.payrollTaxBasisBatch.runId}).from(schema.payrollTaxBasisBatch))).toEqual([{runId:null}]);
  const rolledBack=Symbol('rollback');
  await expect(owner.client.begin(async tx=>{
   const before=await tx`select to_jsonb(b)-'run_id' as row from payroll_tax_basis_batch b order by id`;
   const [{owner:tableOwner}]=await tx`select tableowner as owner from pg_tables where schemaname='public' and tablename='payroll_tax_basis_batch'`;
   await tx.unsafe('alter table public.payroll_tax_basis_batch drop column run_id');
   // Apply the exact migration bytes as the table's owner, statement by statement, as the migrator does.
   await tx.unsafe(`set local role ${tableOwner}`);
   for(const statement of readFileSync('db/migrations/7120_payroll_tax_basis_run.sql','utf8').split('--> statement-breakpoint'))await tx.unsafe(statement);
   await tx.unsafe('reset role');
   const after=await tx`select to_jsonb(b) as row from payroll_tax_basis_batch b order by id`;
   expect(after).toHaveLength(1);
   expect(after.map(r=>Object.hasOwn(r.row,'run_id')&&r.row.run_id===null)).toEqual([true]);
   expect(after.map(r=>{const {run_id:_,...rest}=r.row;return rest;})).toEqual(before.map(r=>r.row));
   expect(await tx`select indexname from pg_indexes where tablename='payroll_tax_basis_batch' and indexname='payroll_tax_basis_batch_run'`).toHaveLength(1);
   throw rolledBack;
  })).rejects.toBe(rolledBack);
  expect((await listTaxBasisHistory(ctx)).rows.map(row=>[row.id,row.batches.map(batch=>batch.id)])).toEqual([[id+':'+b.companyId,[id]]]);
 });
 it('feeds the corrected prefix into a real future run while preserving prior issued money',async()=>{
  const original=await owner.db.select().from(schema.payslip),p=await previewTaxBasisRecalculation(ctx,selection());await confirm(p);
  const [subject]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,employee));
  await setCompensation(ctx,{employmentId:employee,basicSalary:5000,effectiveFrom:'2025-01-01'});
  await setStatutoryProfileMY(ctx,{personId:subject.personId,icNumber:'850202025555',taxCategory:1,numChildren:0});
  const run=await createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-04'});await generatePayslips(ctx,{batchId:run.batchId});
  const [future]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,run.batchId));
  const st=future.statutory as {pcbMeta:{ytdGross:number;ytdNet:number};taxBasisCorrections:unknown[];epfEmployee:number};
  expect(st.pcbMeta.ytdGross).toBe(16500);expect(st.pcbMeta.ytdNet).toBe(16500);expect(st.taxBasisCorrections).toHaveLength(3);
  expect(Number(future.grossPay)).toBe(5000);expect(st.epfEmployee).toBe(550);
  const after=await owner.db.select().from(schema.payslip);for(const row of original)expect(after.find(s=>s.id===row.id)).toEqual(row);
 });
 it('shows a draft tax blocker before processing and clears it after the historical inputs are corrected',async()=>{
  await setCompensation(ctx,{employmentId:employee,basicSalary:5000,effectiveFrom:'2025-01-01'});
  const {batchId}=await createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-11',scope:{employmentIds:[employee]}});
  const runCheck=async()=>{
   const jobId=await requestDraftTaxReadiness(ctx,batchId,randomUUID());
   for(let attempt=0;attempt<15;attempt++){
    await runBulkJobTick(owner.client,{handlers:[draftTaxReadinessJobHandler]});
    const result=await readDraftTaxReadiness(ctx,batchId,jobId,0);
    expect(result.state).not.toBe('failed');
    if(result.state==='done')return {jobId,result};
   }
   throw Error('Draft tax check did not finish');
  };
  const before=await owner.db.select().from(schema.payslip);
  const {jobId,result}=await runCheck();
  expect(result).toMatchObject({state:'done',blockers:1,rows:[{
   employmentId:employee,employeeCode:'0007',period:'2026-01',kind:'importedHistory',
  }]});
  await expect(readDraftTaxReadiness(ctx,randomUUID(),jobId,0)).rejects.toThrow(/unavailable/);
  await expect(requestDraftTaxReadiness({...ctx,grants:[]},batchId,randomUUID())).rejects.toThrow(/unavailable/);
  await confirm(await previewTaxBasisRecalculation(ctx,selection()));
  expect((await runCheck()).result).toMatchObject({state:'done',blockers:0,rows:[]});
  expect(await owner.db.select().from(schema.payslip)).toEqual(before);
  expect((await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId)))[0].status).toBe('draft');
 },90000);
 it('refuses stale settings and excludes nonselected employees and other assessment years',async()=>{
  const p=await previewTaxBasisRecalculation(ctx,selection());await owner.db.update(schema.payComponent).set({includedInPcb:false}).where(eq(schema.payComponent.id,travel));
  await expect(confirm(p)).rejects.toThrow(/changed/);expect(await owner.db.select().from(schema.payrollTaxBasisBatch)).toHaveLength(0);
  const other=await hireEmployee(ctx,{person:{fullName:'Fictional Daniel',primaryEmail:'tax-other@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'0008',hiredOn:'2025-01-01'});await upload('0008');
  const selected=await previewTaxBasisRecalculation(ctx,selection());expect(selected.employees.map(e=>e.id)).toEqual([employee]);
  const all=await previewTaxBasisRecalculation(ctx,{...selection(),employmentIds:null});expect(all.employees.map(e=>e.id)).toContain(other.employmentId);
  const old=await previewTaxBasisRecalculation(ctx,{...selection(),year:2025,employmentIds:null});expect(old.recordCount).toBe(0);
 });
 it('denies narrow and overridden permissions at direct service boundaries',async()=>{
  const narrowed={...ctx,grants:[]};await expect(taxBasisOptions(narrowed)).rejects.toThrow(/access/);await expect(previewTaxBasisRecalculation(narrowed,selection())).rejects.toThrow(/access/);
  const p=await previewTaxBasisRecalculation(ctx,selection());
  await owner.db.insert(schema.payrollPermissionGrant).values({tenantId:b.tenantId,companyId:b.companyId,permissionKey:'payroll.tax-basis.recalculate',role:'hr_admin',allowed:false});
  await expect(confirm(p)).rejects.toThrow(/access/);expect(await listTaxBasisBatches(narrowed)).toEqual([]);
  await expect(previewTaxBasisRecalculation(ctx,{...selection(),companyId:randomUUID()})).rejects.toThrow(/access|unavailable/);
 });
 // Updated deliberately for the owner decision of 26 November 2026 ("Automatic group TP3", board 4ce2c481). Live PCB now
 // takes the same person's EARLIER months at other group companies as a previous-employer opening, and the preview shows
 // them read-only. Correction authority is unchanged: the original employer still corrects only its own months, and a
 // company the person moved to LATER is never shown or used as earlier history.
 it('retains original employer scope after a transfer and never takes later destination history as an opening',async()=>{
  const other=await createCompany(ctx,{legalName:'Fictional destination employer',country:'MY',currency:'MYR'});
  await owner.db.update(schema.employment).set({companyId:other.id}).where(eq(schema.employment.id,employee));
  const originalCompanyOnly={...ctx,grants:[{role:'hr_admin',companyId:b.companyId}]};
  const options=await taxBasisOptions(originalCompanyOnly);expect(options.employees).toContainEqual(expect.objectContaining({id:employee,companyId:b.companyId}));
  const p=await previewTaxBasisRecalculation(originalCompanyOnly,selection());expect(p.employees[0].status).toBe('ready');expect(p.employees[0].groupOpening).toBeUndefined();const batch=await confirmTaxBasisRecalculation(originalCompanyOnly,{previewId:p.previewId,previewHash:p.previewHash});expect((await getTaxBasisBatch(ctx,batch.id))?.completedCount).toBe(1);
  await expect(previewTaxBasisRecalculation(originalCompanyOnly,{...selection(),companyId:other.id,employmentIds:null})).rejects.toThrow(/access|unavailable/);
  const destination=await previewTaxBasisRecalculation(ctx,{...selection(),companyId:other.id,employmentIds:null});expect(destination.employees).toEqual([]);
 });
 // Updated deliberately for the owner decision of 23 November 2026 (ADR-0167, board item 0af23331). Before it, a
 // year-matched statutory TP3 projection without saved payslip evidence held the employee. It is now the accepted-TP3
 // opening (the same projection live payroll applies) when no canonical employee_tp3 record exists. Uncapped
 // changes still never read a TP3, and annual exemptions are still consumed once.
 it('uses the year-matched statutory TP3 projection as the accepted opening without duplicating annual exemptions',async()=>{
  const [subject]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,employee));
  await owner.db.insert(schema.employeeStatutoryMy).values({tenantId:b.tenantId,personId:subject.personId,tp3Year:2026,tp3ExemptionUsed:{PCB_TRA_BUSINESS:5000}}).onConflictDoUpdate({target:schema.employeeStatutoryMy.personId,set:{tp3Year:2026,tp3ExemptionUsed:{PCB_TRA_BUSINESS:5000}}});
  const uncapped=await previewTaxBasisRecalculation(ctx,selection());expect(uncapped.eligibleCount).toBe(1);expect(uncapped.employees[0].openingExemption).toBeUndefined();expect(uncapped.employees[0].exemptionLedger).toEqual([]);
  await owner.db.update(schema.payComponent).set({pcbExemptionCode:'PCB_TRA_BUSINESS'}).where(eq(schema.payComponent.id,travel));
  const p=await previewTaxBasisRecalculation(ctx,selection()),who=p.employees[0];
  expect(who).toMatchObject({status:'ready',openingExemptionSource:'accepted_tp3',openingExemption:{source:'accepted_tp3',used:{PCB_TRA_BUSINESS:5000},tp3:{kind:'statutory_projection',id:null}}});
  // RM5,000 opening + RM500 a month against RM6,000: January and February exempt, March taxable.
  expect(who.months.map(month=>month.items.find(item=>item.code==='TRV')).map(item=>[item!.exempt,item!.taxable])).toEqual([[500,0],[500,0],[0,500]]);
  expect(who.exemptionLedger).toEqual([{code:'PCB_TRA_BUSINESS',cap:6000,openingUsed:5000,openingSource:'accepted_tp3',eligible:1500,exempt:1000,excess:500,usedAfter:6000,remaining:0,items:[{code:'TRV',name:'Travel allowance'}]}]);
  await owner.db.update(schema.employeeStatutoryMy).set({tp3ExemptionUsed:{}}).where(eq(schema.employeeStatutoryMy.personId,subject.personId));
  const cleared=await previewTaxBasisRecalculation(ctx,selection());expect(cleared.employees[0]).toMatchObject({status:'ready',exempt:1500,openingExemption:{source:'accepted_tp3',used:{}}});
  // A projection for another year is not this year's TP3: RM0, labelled as no accepted TP3.
  await owner.db.update(schema.employeeStatutoryMy).set({tp3Year:2025,tp3ExemptionUsed:{PCB_TRA_BUSINESS:6000}}).where(eq(schema.employeeStatutoryMy.personId,subject.personId));
  expect((await previewTaxBasisRecalculation(ctx,selection())).employees[0]).toMatchObject({status:'ready',exempt:1500,openingExemption:{source:'no_accepted_tp3'}});
 });
 it('records a failed employee outside its rolled-back transaction and requires a fresh preview to retry',async()=>{
  const p=await previewTaxBasisRecalculation(ctx,selection());const failedSlip=p.employees[0].months[1].payslipId;
  await owner.db.execute(sql.raw(`create function public.test_tax_basis_failure() returns trigger language plpgsql as $$ begin if new.payslip_id='${failedSlip}'::uuid then raise exception 'fixture failure';end if;return new;end $$;`));
  await owner.db.execute(sql.raw(`create trigger test_tax_basis_failure before insert on payroll_tax_basis_revision for each row execute function public.test_tax_basis_failure();`));
  try{
   const batch=await confirm(p);expect((await getTaxBasisBatch(ctx,batch.id))?.status).toBe('failed');expect(await owner.db.select().from(schema.payrollTaxBasisRevision)).toHaveLength(0);
   await owner.db.execute(sql.raw('drop trigger test_tax_basis_failure on payroll_tax_basis_revision;'));await owner.db.execute(sql.raw('drop function public.test_tax_basis_failure();'));
   expect(await confirm(p)).toEqual(batch);expect(await owner.db.select().from(schema.payrollTaxBasisRevision)).toHaveLength(0);
   const fresh=await previewTaxBasisRecalculation(ctx,selection());const done=await confirm(fresh);expect((await getTaxBasisBatch(ctx,done.id))?.completedCount).toBe(1);expect(await owner.db.select().from(schema.payrollTaxBasisRevision)).toHaveLength(3);
  }finally{await owner.db.execute(sql.raw('drop trigger if exists test_tax_basis_failure on payroll_tax_basis_revision;'));await owner.db.execute(sql.raw('drop function if exists public.test_tax_basis_failure();'));}
 });
 it('recovers an interrupted batch under current authority and requires a new preview',async()=>{
  const p=await previewTaxBasisRecalculation(ctx,selection()),batchId=randomUUID();
  await withTenant(ctx,async tx=>{
   await tx.execute(sql`insert into payroll_tax_basis_batch(id,tenant_id,company_id,preview_id,created_by,created_at) values(${batchId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${p.previewId}::uuid,${ctx.userId!}::uuid,now()-interval '10 minutes')`);
   await tx.execute(sql`insert into payroll_tax_basis_event(tenant_id,company_id,batch_id,actor_id,kind,created_at) values(${b.tenantId}::uuid,${b.companyId}::uuid,${batchId}::uuid,${ctx.userId!}::uuid,'pending',now()-interval '10 minutes')`);
  });
  expect((await getTaxBasisBatch(ctx,batchId))?.recoverable).toBe(true);
  expect(await recoverTaxBasisBatch(ctx,batchId)).toEqual({id:batchId});
  expect((await getTaxBasisBatch(ctx,batchId))?.status).toBe('failed');
  await continueTaxBasisBatch(ctx,batchId);expect(await owner.db.select().from(schema.payrollTaxBasisRevision)).toHaveLength(0);
  const fresh=await previewTaxBasisRecalculation(ctx,selection());await confirm(fresh);expect(await owner.db.select().from(schema.payrollTaxBasisRevision)).toHaveLength(3);
 });
 it('refuses legacy input readers after correction and keeps original payroll readable to the compatible reader',async()=>{
  const original=await withTenant(ctx,tx=>tx.select().from(schema.payslip).orderBy(schema.payslip.id));
  const legacyBefore=await withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.payroll_tax_basis_reader','',true)`);return tx.select().from(schema.payslip).orderBy(schema.payslip.id);});expect(legacyBefore).toEqual(original);
  const p=await previewTaxBasisRecalculation(ctx,selection());await confirm(p);
  expect(await withTenant(ctx,tx=>tx.select().from(schema.payslip).orderBy(schema.payslip.id))).toEqual(original);
  const error=await withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.payroll_tax_basis_reader','0',true)`);return tx.select().from(schema.payslip).orderBy(schema.payslip.id);}).catch(error=>error);
  expect(error.cause?.message??error.message).toMatch(/correction-aware income-tax reader/);
 });
 it('uses only the exact accepted replacement import and still guards changed settings without correction-log access',async()=>{
  const p=await previewTaxBasisRecalculation(ctx,selection());await confirm(p);await upload('0007','600');
  await owner.db.insert(schema.payrollPermissionGrant).values({tenantId:b.tenantId,companyId:b.companyId,permissionKey:'payroll.tax-basis.view',role:'hr_admin',allowed:false});
  expect(await listTaxBasisBatches(ctx)).toEqual([]);
  const current=await withTenant(ctx,tx=>tx.select().from(schema.payslip));expect(current).toHaveLength(3);
  const active=await withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,current.map(s=>s.id),{includeImported:true}));expect([...active.values()].map(value=>value.basis.pcb)).toEqual([5600,5600,5600]);expect([...active.values()].every(value=>value.correction===null)).toBe(true);
  await owner.db.update(schema.payComponent).set({includedInPcb:false}).where(eq(schema.payComponent.id,travel));
  await expect(withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,current.map(s=>s.id),{includeImported:true}))).rejects.toThrow(/Imported wage inputs require review/);
 });
 it('keeps immutable correction records tenant-bound and refuses active-batch recovery',async()=>{
  const p=await previewTaxBasisRecalculation(ctx,selection()),done=await confirm(p);
  await expect(withTenant(ctx,tx=>tx.execute(sql`update payroll_tax_basis_revision set ordinal=ordinal+1 where batch_id=${done.id}::uuid`))).rejects.toThrow();
  expect((await getTaxBasisBatch(ctx,done.id))?.employees[0].months).toHaveLength(3);
  expect(await recoverTaxBasisBatch(ctx,done.id)).toEqual(done);
  const foreign={...ctx,tenantId:randomUUID()};await expect(getTaxBasisBatch(foreign,done.id)).resolves.toBeNull();
 });
});

it('stamps accepted imported wages separately from file statutory totals and requires reviewed changes before future use',async()=>{
 const original=await owner.db.select().from(schema.payslip);
 for(const slip of original){const st=slip.statutory as Record<string,unknown>;expect(st.pcb).toBe(0);expect(st).toMatchObject({bases:{pcb:5000},importedTaxBasis:{state:'ready',year:2026}});}
 await expect(withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,original.map(slip=>slip.id),{includeImported:true}))).rejects.toThrow(/Imported wage inputs require review/);
 const preview=await previewTaxBasisRecalculation(ctx,selection());expect(preview.employees[0].pcbComparison).toEqual({state:'unavailable',originalPaid:0,missingInputs:['originalStatutoryInputs','originalTaxCategoryAndReliefs','originalPriorEmployerIncome']});
 await confirm(preview);
 expect((await withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,original.map(slip=>slip.id),{includeImported:true}))).size).toBe(3);
 expect(await owner.db.select().from(schema.payslip)).toEqual(original);
});
it('replays capped imported items with zero when no accepted TP3 exists and saves the classification, provenance and ledger',async()=>{
 const original=await owner.db.select().from(schema.payslip).orderBy(schema.payslip.id);
 await owner.db.update(schema.payComponent).set({pcbExemptionCode:'PCB_TRA_BUSINESS'}).where(eq(schema.payComponent.id,travel));
 const preview=await previewTaxBasisRecalculation(ctx,selection());
 const subject=preview.employees[0];
 expect(subject).toMatchObject({status:'ready',openingExemptionSource:'no_accepted_tp3',openingExemption:{source:'no_accepted_tp3',used:{},previousEmployerDeclared:false},exempt:1500});
 expect(subject.months[0].items.find(item=>item.code==='TRV')).toMatchObject({amount:500,taxable:0,exempt:500});
 const saved=await confirm(preview);
 expect((await getTaxBasisBatch(ctx,saved.id))?.employees[0]).toMatchObject({status:'completed',openingExemptionSource:'no_accepted_tp3'});
 const values=await withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,original.map(row=>row.id),{includeImported:true}));
 expect([...values.values()].map(row=>row.basis.openingExemptionSource)).toEqual(Array(3).fill('no_accepted_tp3'));
 // The month-by-month ledger and opening provenance are persisted on the append-only revision.
 const revisions=await owner.db.select().from(schema.payrollTaxBasisRevision).orderBy(schema.payrollTaxBasisRevision.period);
 expect(revisions.map(row=>(row.basis as unknown as {exemptionLedger:{entries:{usedBefore:number;exempt:number;itemName:string}[]}}).exemptionLedger.entries.map(entry=>[entry.usedBefore,entry.exempt,entry.itemName]))).toEqual([[[0,500,'Travel allowance']],[[500,500,'Travel allowance']],[[1000,500,'Travel allowance']]]);
 expect(revisions.every(row=>(row.basis as unknown as {openingExemption:{source:string}}).openingExemption.source==='no_accepted_tp3')).toBe(true);
 expect(await owner.db.select().from(schema.payslip).orderBy(schema.payslip.id)).toEqual(original);
 const repeated=await previewTaxBasisRecalculation(ctx,selection());
 expect(repeated.unchangedCount).toBe(1);
 // The ledger is excluded from change detection: a display rename changes the fresh ledger but creates no revision.
 await owner.db.update(schema.payComponent).set({name:'Renamed travel'}).where(eq(schema.payComponent.id,travel));
 const renamed=await previewTaxBasisRecalculation(ctx,selection());
 expect(renamed.unchangedCount).toBe(1);expect(renamed.eligibleCount).toBe(0);
 expect(renamed.employees[0].exemptionLedger?.[0].items).toEqual([{code:'TRV',name:'Renamed travel'}]);
 await owner.db.update(schema.payComponent).set({pcbExemptionCode:'PCB_TAXABLE'}).where(eq(schema.payComponent.id,travel));
 const changed=await previewTaxBasisRecalculation(ctx,selection());
 expect(changed.employees[0].months[0].items.find(item=>item.code==='TRV')).toMatchObject({amount:500,taxable:500,exempt:0});
});

it('requires a fresh review when a TP3 for the year appears after a defaulted preview',async()=>{
 await owner.db.update(schema.payComponent).set({pcbExemptionCode:'PCB_TRA_BUSINESS'}).where(eq(schema.payComponent.id,travel));
 const preview=await previewTaxBasisRecalculation(ctx,selection());
 expect(preview.employees[0].openingExemptionSource).toBe('no_accepted_tp3');
 const [subject]=await owner.db.select({personId:schema.employment.personId}).from(schema.employment).where(eq(schema.employment.id,employee));
 await owner.db.insert(schema.employeeTp3).values({tenantId:b.tenantId,personId:subject.personId,assessmentYear:2026});
 await expect(confirm(preview)).rejects.toThrow(/Preview the recalculation again/);
 expect(await owner.db.select().from(schema.payrollTaxBasisRevision)).toHaveLength(0);
});

// Updated deliberately for the owner decision of 23 November 2026 (ADR-0167, board item 0af23331): an accepted TP3
// with no Section C records no prior exemption use, so it now opens at RM0 from that TP3 instead of holding. The
// held-detail coverage this test used to carry (item amounts visible, named missing evidence, not confirmable) moved
// to the saved-evidence conflict and insufficient-access tests below.
it('treats an accepted TP3 without Section C as no prior-employer exemption use',async()=>{
 const [subject]=await owner.db.select({personId:schema.employment.personId}).from(schema.employment).where(eq(schema.employment.id,employee));
 const [tp3]=await owner.db.insert(schema.employeeTp3).values({tenantId:b.tenantId,personId:subject.personId,assessmentYear:2026}).returning({id:schema.employeeTp3.id});
 await owner.db.update(schema.payComponent).set({pcbExemptionCode:'PCB_TRA_BUSINESS'}).where(eq(schema.payComponent.id,travel));
 const who=(await previewTaxBasisRecalculation(ctx,selection())).employees[0];
 expect(who).toMatchObject({status:'ready',exempt:1500,openingExemption:{source:'accepted_tp3',used:{},tp3:{kind:'form',id:tp3.id}}});
});

it('denies a rollback reader access to newly imported tax-input evidence',async()=>{
 const error=await withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.payroll_import_tax_basis_reader','0',true)`);return tx.select().from(schema.payslip);}).catch(error=>error);
 expect(error.cause?.code??error.code).toBe('55000');expect(error.cause?.message??error.message).toMatch(/import-aware income-tax reader/);
});

it('uses a proven later native opening for the earlier imported prefix without fabricating a historical zero',async()=>{
 await owner.db.update(schema.payComponent).set({pcbExemptionCode:'PCB_TRA_BUSINESS'}).where(eq(schema.payComponent.id,travel));
 const original=await owner.db.select().from(schema.payslip),sources=await withTenant(ctx,tx=>taxBasisSourceRowsTx(tx,original.map(slip=>slip.id)));
 const later=await createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-10'});
 const snapshot={pcb:10,lp:0,componentLines:[],taxBasisOpeningExemptionYear:2026,taxBasisOpeningExemptionUsed:{},taxBasisOpeningSource:{version:1,year:2026,employmentId:employee,companyId:b.companyId,prefix:sources.map(source=>({payslipId:source.id,sourceHash:hashTaxBasisSource(source)}))}};
 await owner.client`insert into payslip(tenant_id,batch_id,employment_id,basic_salary,gross_pay,other_deductions,total_deductions,net_pay,employer_cost,statutory) values(${b.tenantId}::uuid,${later.batchId}::uuid,${employee}::uuid,5000,5000,0,10,4990,5000,${JSON.stringify(snapshot)}::jsonb)`;
 await owner.client`update payroll_batch set status='processed',employee_count=1 where id=${later.batchId}::uuid`;
 const prefix=await previewTaxBasisRecalculation(ctx,selection());expect(prefix.employees[0].reason).toMatch(/Later saved months/);expect(prefix.employees[0].months.map(month=>month.taxable)).toEqual([5000,5000,5000]);expect(prefix.employees[0].missingEvidence).toBeUndefined();
 const complete=await previewTaxBasisRecalculation(ctx,{...selection(),upToMonth:10});expect(complete.eligibleCount).toBe(1);expect(complete.employees[0].months.map(month=>month.taxable)).toEqual([5000,5000,5000,5000]);expect(complete.employees[0].exempt).toBe(1500);
 await confirm(complete);const january=sources.find(source=>source.period==='2026-01')!.id;expect((await withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,[january],{includeImported:true}))).size).toBe(1);await expect(withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,[january],{includeImported:true,sameMonth:true}))).rejects.toThrow(/monthly exemption source ownership/);
 await owner.db.update(schema.payComponent).set({pcbRemunerationType:'additional'}).where(eq(schema.payComponent.id,travel));const additional=await previewTaxBasisRecalculation(ctx,{...selection(),upToMonth:10});await confirm(additional);await expect(withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,[january],{includeImported:true,sameMonth:true}))).rejects.toThrow(/monthly exemption source ownership/);
 for(const saved of original)expect((await owner.db.select().from(schema.payslip).where(eq(schema.payslip.id,saved.id)))[0]).toEqual(saved);
});
it('invalidates an eligible open run when only owned noncash taxability changes and preserves closed history',async()=>{
 await owner.db.insert(schema.payComponent).values({tenantId:b.tenantId,code:'BIK_OWNED',name:'Owned historical benefit',kind:'allowance',displayCategory:'bik',eaFormLine:'EA_B3',isNonPayable:true,includedInPcb:true,pcbRemunerationType:'normal',pcbExemptionCode:'PCB_TAXABLE'});
 const sourceRows=[...rows('0007'),...['01','02','03'].map(month=>['0007',`2026-${month}`,'ME','BIK_OWNED','TAXCO','400'])];
 const upload=await previewPayrollHistoryUpload(ctx,{name:'owned-benefits.csv',content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...sourceRows]))});expect(upload.plan.counts.invalid).toBe(0);await confirmPayrollHistoryUpload(ctx,{attemptId:upload.attemptId,previewHash:upload.plan.previewHash,confirmReplacement:true});
 const original=await owner.db.select().from(schema.payslip),open=await createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-10'});
 await owner.client`insert into payslip(tenant_id,batch_id,employment_id,basic_salary,gross_pay,other_deductions,total_deductions,net_pay,employer_cost,statutory) values(${b.tenantId}::uuid,${open.batchId}::uuid,${employee}::uuid,5000,5000,0,10,4990,5000,'{"pcb":10,"lp":0,"bases":{"pcb":5000},"componentLines":[]}'::jsonb)`;
 await owner.client`update payroll_batch set status='processed',employee_count=1 where id=${open.batchId}::uuid`;
 await owner.db.update(schema.payComponent).set({includedInPcb:false}).where(eq(schema.payComponent.code,'BIK_OWNED'));
 const preview=await previewTaxBasisRecalculation(ctx,selection());expect(preview.eligibleCount).toBe(1);
 // d9ded29c — the owned BIK 400.00 was taxable in each saved month and is now not subject to PCB: before = cash + 400.00, after = cash.
 expect(preview.employees[0].months.every(month=>month.payrollInputsChanged&&month.beforeBenefits===400&&month.benefits===0&&month.beforeTaxable===Math.round((month.taxable+400)*100)/100&&month.difference===-400)).toBe(true);
 await confirm(preview);const [marked]=await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,open.batchId));expect(marked.needsRecalcAt).not.toBeNull();expect(marked.recalcEmploymentIds).toContain(employee);
 for(const saved of original)expect((await owner.db.select().from(schema.payslip).where(eq(schema.payslip.id,saved.id)))[0]).toEqual(saved);
});

it('preserves original imported EA working when current PCB settings change without a reviewed correction',async()=>{
 const [subject]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,employee));await setStatutoryProfileMY(ctx,{personId:subject.personId,icNumber:'850202025555',taxCategory:1,numChildren:0});
 const before=await eaStatement(ctx,{employmentId:employee,year:'2026'});expect(before).not.toBeNull();expect(before!.partB.gross).toBe(16500);expect(before!.partD.mtd).toBe(0);
 await owner.db.update(schema.payComponent).set({includedInPcb:false}).where(eq(schema.payComponent.id,travel));
 expect(await eaStatement(ctx,{employmentId:employee,year:'2026'})).toEqual(before);
});

it('binds import source hashes identically for authorized administrators and self readers without opening import logs',async()=>{
 const [subject]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,employee));
 const self={...ctx,userId:await createAppUser(b.tenantId,subject.personId,'employee'),personId:subject.personId,roles:['employee'],grants:undefined};
 const slips=await withTenant(ctx,tx=>tx.select({id:schema.payslip.id}).from(schema.payslip)),adminSources=await withTenant(ctx,tx=>taxBasisSourceRowsTx(tx,slips.map(slip=>slip.id))),ownSources=await withTenant(self,tx=>taxBasisSourceRowsTx(tx,slips.map(slip=>slip.id)));
 expect(ownSources).toHaveLength(3);expect(ownSources.map(hashTaxBasisSource)).toEqual(adminSources.map(hashTaxBasisSource));expect(ownSources.every(source=>source.importRevision!==null)).toBe(true);
 expect(await withTenant(self,tx=>tx.select().from(schema.payrollHistoryImportAttempt))).toEqual([]);
});

it('keeps import source identities and scoped subject pages stable while a replacement is staged',async()=>{
 const [subject]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,employee)),self={...ctx,userId:await createAppUser(b.tenantId,subject.personId,'employee'),personId:subject.personId,roles:['employee'],grants:undefined};
 const ids=(await withTenant(ctx,tx=>tx.select({id:schema.payslip.id}).from(schema.payslip))).map(slip=>slip.id);
 const source=(who:SessionContext)=>withTenant(who,async tx=>(await taxBasisSourceRowsTx(tx,ids)).map(hashTaxBasisSource));
 const before=await source(ctx);expect(await source(self)).toEqual(before);
 const draft=await previewPayrollHistoryUpload(ctx,{name:'staged-correction.csv',content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows('0007','600')]))});
 process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS='1';
 try{
  const request=await requestPayrollHistoryConfirm(ctx,{attemptId:draft.attemptId,previewHash:draft.plan.previewHash,confirmReplacement:true,acknowledgeWarnings:true});if(!('jobId' in request))throw new Error('Expected staged history job');
  let staged=false;
  for(let tick=0;tick<50;tick++){await runBulkJobTick(owner.client,{handlers:[payrollHistoryJobHandler]});const [count]=await owner.client<{n:number}[]>`select count(*)::int as n from app.payroll_history_staged_row where stage_id=${request.jobId}::uuid and relation='payroll_history_import_revision'`;if(count.n){staged=true;break;}}
  expect(staged).toBe(true);expect(await source(ctx)).toEqual(before);expect(await source(self)).toEqual(before);expect((await taxBasisOptions(ctx)).employees.map(person=>person.id)).toEqual([employee]);
  let completed=false;
  for(let tick=0;tick<100;tick++){await runBulkJobTick(owner.client,{handlers:[payrollHistoryJobHandler]});const [job]=await owner.client<{state:string}[]>`select state from bulk_job where id=${request.jobId}::uuid`;if(job.state==='completed'){completed=true;break;}if(job.state==='failed')throw new Error('History stage failed');}
  expect(completed).toBe(true);expect(await source(ctx)).toEqual([]);expect(await source(self)).toEqual([]);
  const current=(await withTenant(ctx,tx=>tx.select({id:schema.payslip.id}).from(schema.payslip))).map(slip=>slip.id);expect(current).toHaveLength(3);expect(current.every(id=>!ids.includes(id))).toBe(true);
  const currentSource=(who:SessionContext)=>withTenant(who,async tx=>(await taxBasisSourceRowsTx(tx,current)).map(hashTaxBasisSource)),accepted=await currentSource(ctx);
  const discarded=await previewPayrollHistoryUpload(ctx,{name:'discarded-correction.csv',content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows('0007','700')]))});
  const second=await requestPayrollHistoryConfirm(ctx,{attemptId:discarded.attemptId,previewHash:discarded.plan.previewHash,confirmReplacement:true,acknowledgeWarnings:true});if(!('jobId' in second))throw new Error('Expected second staged history job');
  for(let tick=0;tick<50;tick++){await runBulkJobTick(owner.client,{handlers:[payrollHistoryJobHandler]});const [count]=await owner.client<{n:number}[]>`select count(*)::int as n from app.payroll_history_staged_row where stage_id=${second.jobId}::uuid and relation='payroll_history_import_revision'`;if(count.n)break;}
  expect(await currentSource(ctx)).toEqual(accepted);expect(await currentSource(self)).toEqual(accepted);
  await owner.db.update(schema.payComponent).set({name:'Changed after staged plan'}).where(eq(schema.payComponent.id,travel));
  let failed=false;
  for(let tick=0;tick<100;tick++){await runBulkJobTick(owner.client,{handlers:[payrollHistoryJobHandler]});const [job]=await owner.client<{state:string;notified:boolean}[]>`select state,notified_at is not null as notified from bulk_job where id=${second.jobId}::uuid`;if(job.state==='failed'&&job.notified){failed=true;break;}}
  expect(failed).toBe(true);expect(await currentSource(ctx)).toEqual(accepted);expect(await currentSource(self)).toEqual(accepted);expect(await owner.client`select 1 from app.payroll_history_staged_row where stage_id=${second.jobId}::uuid`).toHaveLength(0);
 }finally{delete process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS;}
},90000);
it('rejects null and oversized SQL subject pages before reading historical subjects',async()=>{
 for(const query of [sql`select * from app.payroll_tax_basis_subject_page(array[${b.companyId}::uuid],0,null)`,sql`select * from app.payroll_tax_basis_subject_page(array[${b.companyId}::uuid],null,500)`,sql`select * from app.payroll_tax_basis_subject_page(array[${b.companyId}::uuid],0,501)`]){const error=await withTenant(ctx,tx=>tx.execute(query)).catch(error=>error);expect(error.cause?.code??error.code).toBe('22023');expect(error.cause?.message??error.message).toMatch(/Invalid historical subject page/);}
});
it('owns imported BIK once across two historical cycles and reconstructs the complete month baseline',async()=>{
 await owner.db.insert(schema.payComponent).values({tenantId:b.tenantId,code:'BIK_CYCLE',name:'Cycle-owned benefit',kind:'allowance',displayCategory:'bik',eaFormLine:'EA_B3',isNonPayable:true,includedInPcb:true,pcbRemunerationType:'normal',pcbExemptionCode:'PCB_TAXABLE'});
 const cycleRows=(cycle:string,basic:string,benefit:string)=>[['0007','2026-01',cycle,'BASIC','TAXCO',basic],['0007','2026-01',cycle,'BIK_CYCLE','TAXCO',benefit],...['EEEPF','EESOCSO','EEEIS','PCB'].map(code=>['0007','2026-01',cycle,code,'TAXCO','0'])];
 const draft=await previewPayrollHistoryUpload(ctx,{name:'two-cycles.csv',content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...cycleRows('ME','5000','300'),...cycleRows('BO','0','200')]))});expect(draft.plan.counts.invalid).toBe(0);await confirmPayrollHistoryUpload(ctx,{attemptId:draft.attemptId,previewHash:draft.plan.previewHash,confirmReplacement:true});
 const sources=await withTenant(ctx,tx=>tx.execute<{id:string}>(sql`select p.id from payslip p join payroll_batch b on b.id=p.batch_id where p.employment_id=${employee}::uuid and b.pay_period='2026-01' order by b.batch_date,b.payroll_cycle_id,b.run_seq,b.id,p.id`));expect(sources).toHaveLength(2);
 const effective=await withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,sources.map(source=>source.id),{includeImported:true}));
 const snapshots=sources.map(source=>effective.get(source.id)!.basis.pcbNonCash as {owned:{bik:number};cumulative:{bik:number};before:{bik:number};ownedEntries:{sourceId:string}[]});
 expect(snapshots.map(snapshot=>snapshot.owned.bik).sort((a,b)=>a-b)).toEqual([200,300]);expect(snapshots[0].before.bik).toBe(0);expect(snapshots[1].before.bik).toBe(snapshots[0].owned.bik);expect(snapshots[1].cumulative.bik).toBe(500);expect(new Set(snapshots.flatMap(snapshot=>snapshot.ownedEntries.map(entry=>entry.sourceId))).size).toBe(2);
 const preview=await previewTaxBasisRecalculation(ctx,selection());expect(preview.employees[0].months.filter(month=>month.period==='2026-01').map(month=>(month.basis.pcbNonCash as {owned:{bik:number}}).owned.bik).sort((a,b)=>a-b)).toEqual([200,300]);
 await expect(withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,sources.map(source=>source.id),{includeImported:true,sameMonth:true}))).rejects.toThrow(/monthly noncash source ownership/);
 // Confirmed imports close the immutable statutory month. Exercise that real endpoint boundary;
 // the same-month reader refusal above is independently required without bypassing a closed period.
 const closed=await owner.db.select().from(schema.payslip);await expect(createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-01'})).rejects.toThrow(/pay period is closed/);expect(await owner.db.select().from(schema.payslip)).toEqual(closed);

});

it('keeps reviewed receipts current for later calculations without treating display-name edits as tax changes',async()=>{
 await confirm(await previewTaxBasisRecalculation(ctx,selection()));
 await owner.db.update(schema.payComponent).set({name:'Renamed travel display'}).where(eq(schema.payComponent.id,travel));
 const ids=(await withTenant(ctx,tx=>tx.select({id:schema.payslip.id}).from(schema.payslip))).map(slip=>slip.id);
 expect((await withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,ids,{includeImported:true}))).size).toBe(3);expect((await previewTaxBasisRecalculation(ctx,selection())).unchangedCount).toBe(1);
 await owner.db.update(schema.payComponent).set({includedInPcb:false}).where(eq(schema.payComponent.id,travel));
 await expect(withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,ids,{includeImported:true}))).rejects.toThrow(/Imported wage inputs require review/);
 const refreshed=await previewTaxBasisRecalculation(ctx,selection());expect(refreshed.eligibleCount).toBe(1);await confirm(refreshed);
 expect([...((await withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,ids,{includeImported:true}))).values())].map(value=>value.basis.pcb)).toEqual([5000,5000,5000]);
});
it('retains available imported item detail when the original relief split cannot be proved',async()=>{
 const source=[...rows('0007'),...['01','02','03'].map(month=>['0007',`2026-${month}`,'ME','LP','TAXCO','100'])];
 const draft=await previewPayrollHistoryUpload(ctx,{name:'unknown-relief-split.csv',content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...source]))});expect(draft.plan.counts.invalid).toBe(0);await confirmPayrollHistoryUpload(ctx,{attemptId:draft.attemptId,previewHash:draft.plan.previewHash,confirmReplacement:true});
 const preview=await previewTaxBasisRecalculation(ctx,selection()),subject=preview.employees[0];expect(subject.status).toBe('blocked');expect(subject.taxable).toBeNull();expect(subject.partialMonths).toHaveLength(3);expect(subject.partialMonths![0].items.find(item=>item.code==='TRV')?.amount).toBe(500);expect(subject.missingEvidence).toMatchObject([{field:'optionalDeductionOwnership',affects:['optionalDeductions','pcbComparison']}]);
 const current=await withTenant(ctx,tx=>tx.select().from(schema.payslip));expect(current.map(slip=>(slip.statutory as {lp:number}).lp)).toEqual([100,100,100]);expect(current.map(slip=>(slip.statutory as {pcb:number}).pcb)).toEqual([0,0,0]);
});

// Board item 0af23331, owner decision 23 November 2026 (ADR-0167): the accepted TP3 opens historical recalculation;
// without one the opening is RM0. Fictional fixtures; expected money is worked from the RM6,000 travel limit by hand.
describe('accepted TP3 prior-employer exemption opening',()=>{
 const tp3Payload=(travelUsed:number):schema.Tp3Payload=>({form:'tp3-2026',sectionC:{c2:{amount:travelUsed,subItems:{i:travelUsed}}},sectionD:{}});
 const personOf=async()=>(await owner.db.select({personId:schema.employment.personId}).from(schema.employment).where(eq(schema.employment.id,employee)))[0].personId;
 async function capped(amount='500'){
  if(amount!=='500'){await owner.db.update(schema.payComponent).set({includedInPcb:false}).where(eq(schema.payComponent.id,travel));await upload('0007',amount);await owner.db.update(schema.payComponent).set({includedInPcb:true}).where(eq(schema.payComponent.id,travel));}
  await owner.db.update(schema.payComponent).set({pcbExemptionCode:'PCB_TRA_BUSINESS'}).where(eq(schema.payComponent.id,travel));
 }
 const travelSplit=(who:{months:{items:{code:string;exempt:number;taxable:number}[]}[]})=>who.months.map(month=>month.items.find(item=>item.code==='TRV')!).map(item=>[item.exempt,item.taxable]);
 async function laterNativeOpening(used:Record<string,number>){
  const original=await owner.db.select().from(schema.payslip),sources=await withTenant(ctx,tx=>taxBasisSourceRowsTx(tx,original.map(slip=>slip.id)));
  const later=await createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-10'});
  const snapshot={pcb:10,lp:0,componentLines:[],taxBasisOpeningExemptionYear:2026,taxBasisOpeningExemptionUsed:used,taxBasisOpeningSource:{version:1,year:2026,employmentId:employee,companyId:b.companyId,prefix:sources.map(source=>({payslipId:source.id,sourceHash:hashTaxBasisSource(source)}))}};
  await owner.client`insert into payslip(tenant_id,batch_id,employment_id,basic_salary,gross_pay,other_deductions,total_deductions,net_pay,employer_cost,statutory) values(${b.tenantId}::uuid,${later.batchId}::uuid,${employee}::uuid,5000,5000,0,10,4990,5000,${JSON.stringify(snapshot)}::jsonb)`;
  await owner.client`update payroll_batch set status='processed',employee_count=1 where id=${later.batchId}::uuid`;
  return original;
 }

 it('applies the accepted TP3: RM5,500 already used plus RM800 Travel Allowance gives RM500 exempt and RM300 taxable',async()=>{
  await capped('800');
  const personId=await personOf();
  const [tp3]=await owner.db.insert(schema.employeeTp3).values({tenantId:b.tenantId,personId,assessmentYear:2026,payload:tp3Payload(5500)}).returning({id:schema.employeeTp3.id});
  // A differing hand-kept projection for the same year does not override the canonical accepted form.
  await owner.db.insert(schema.employeeStatutoryMy).values({tenantId:b.tenantId,personId,tp3Year:2026,tp3ExemptionUsed:{PCB_TRA_BUSINESS:100}}).onConflictDoUpdate({target:schema.employeeStatutoryMy.personId,set:{tp3Year:2026,tp3ExemptionUsed:{PCB_TRA_BUSINESS:100}}});
  const preview=await previewTaxBasisRecalculation(ctx,selection()),who=preview.employees[0];
  expect(who).toMatchObject({status:'ready',openingExemptionSource:'accepted_tp3',openingExemption:{source:'accepted_tp3',used:{PCB_TRA_BUSINESS:5500},tp3:{kind:'form',id:tp3.id}}});
  expect(travelSplit(who)).toEqual([[500,300],[0,800],[0,800]]);
  expect(who.months.map(month=>month.taxable)).toEqual([5300,5800,5800]);
  expect(who.exemptionLedger).toEqual([{code:'PCB_TRA_BUSINESS',cap:6000,openingUsed:5500,openingSource:'accepted_tp3',eligible:2400,exempt:500,excess:1900,usedAfter:6000,remaining:0,items:[{code:'TRV',name:'Travel allowance'}]}]);
  // A TP3 correction after the preview invalidates it; nothing is saved from the stale review.
  await owner.db.update(schema.employeeTp3).set({payload:tp3Payload(6000),updatedAt:new Date()}).where(eq(schema.employeeTp3.id,tp3.id));
  await expect(confirm(preview)).rejects.toThrow(/Preview the recalculation again/);
  expect(await owner.db.select().from(schema.payrollTaxBasisRevision)).toHaveLength(0);
  const fresh=await previewTaxBasisRecalculation(ctx,selection());
  expect(travelSplit(fresh.employees[0])).toEqual([[0,800],[0,800],[0,800]]);
  const done=await confirm(fresh);expect((await getTaxBasisBatch(ctx,done.id))?.status).toBe('completed');
  const revisions=await owner.db.select().from(schema.payrollTaxBasisRevision);
  expect(revisions.map(row=>(row.basis as unknown as {openingExemption:{source:string;tp3:{id:string}}}).openingExemption)).toEqual(Array(3).fill(expect.objectContaining({source:'accepted_tp3',tp3:expect.objectContaining({kind:'form',id:tp3.id})})));
 });

 it('never reads a draft or unsubmitted TP3',async()=>{
  await capped();
  await owner.db.insert(schema.employeeTp3Draft).values({tenantId:b.tenantId,personId:await personOf(),employmentId:employee,assessmentYear:2026,previousEmployers:[],payload:tp3Payload(6000),declarationAccepted:true});
  const who=(await previewTaxBasisRecalculation(ctx,selection())).employees[0];
  expect(who).toMatchObject({status:'ready',exempt:1500,openingExemption:{source:'no_accepted_tp3',used:{},previousEmployerDeclared:false}});
  expect(travelSplit(who)).toEqual([[500,0],[500,0],[500,0]]);
 });

 // Updated rule (owner, 23 November 2026): before it, an affirmative previous-employer answer kept the hold.
 it('uses RM0 with a declared-previous-employer warning when no accepted TP3 is on file',async()=>{
  await capped();
  await owner.client`insert into payroll_tp3_previous_employer_answer(tenant_id,person_id,employment_id,assessment_year,had_previous_employer,answered_by_user_id) values(${b.tenantId}::uuid,${await personOf()}::uuid,${employee}::uuid,2026,true,${ctx.userId!}::uuid)`;
  const preview=await previewTaxBasisRecalculation(ctx,selection()),who=preview.employees[0];
  expect(who).toMatchObject({status:'ready',exempt:1500,openingExemptionSource:'no_accepted_tp3',openingExemption:{source:'no_accepted_tp3',used:{},previousEmployerDeclared:true}});
  expect(who.exemptionLedger?.[0]).toMatchObject({openingUsed:0,openingSource:'no_accepted_tp3',remaining:4500});
  await confirm(preview);
  expect((await owner.db.select().from(schema.payrollTaxBasisRevision)).every(row=>(row.basis as unknown as {openingExemption:{previousEmployerDeclared:boolean}}).openingExemption.previousEmployerDeclared)).toBe(true);
 });

 it('keeps saved payslip opening evidence ahead of an accepted TP3',async()=>{
  await capped();
  await owner.db.insert(schema.employeeTp3).values({tenantId:b.tenantId,personId:await personOf(),assessmentYear:2026,payload:tp3Payload(6000)});
  await laterNativeOpening({});
  const who=(await previewTaxBasisRecalculation(ctx,{...selection(),upToMonth:10})).employees[0];
  expect(who).toMatchObject({status:'ready',exempt:1500,openingExemptionSource:'saved_payslip',openingExemption:{source:'saved_payslip',used:{}}});
 });

 it('still holds conflicting saved evidence, shows only certain ranges and cannot be confirmed',async()=>{
  await capped();
  await owner.db.insert(schema.employeeTp3).values({tenantId:b.tenantId,personId:await personOf(),assessmentYear:2026,payload:tp3Payload(1000)});
  const original=await laterNativeOpening({PCB_TRA_BUSINESS:-1});
  const preview=await previewTaxBasisRecalculation(ctx,selection()),who=preview.employees[0];
  expect(who).toMatchObject({status:'blocked',holdReason:'saved_evidence_conflict',taxable:null,exempt:null,months:[]});
  expect(who.openingExemption).toBeUndefined();
  expect(who.partialMonths?.map(month=>month.period)).toEqual(['2026-01','2026-02','2026-03']);
  expect(who.partialMonths?.[0].items.find(item=>item.code==='TRV')).toMatchObject({amount:500,includedInPcb:true,exemptionCode:'PCB_TRA_BUSINESS'});
  expect(who.missingEvidence).toMatchObject([{field:'priorEmployerExemptionUsage',affects:['taxableWages','exemptWages','optionalDeductions','pcbComparison']}]);
  expect(who.bounds?.codes).toEqual([{code:'PCB_TRA_BUSINESS',cap:6000,eligible:1500,exemptMax:1500,certainExcess:0}]);
  expect(who.bounds?.months.map(month=>month.items.find(item=>item.code==='TRV'))).toEqual(Array(3).fill(expect.objectContaining({exact:false,exemptMax:500,taxableMin:0})));
  expect(who.bounds?.months[0].items.find(item=>item.code==='BASIC')).toMatchObject({exact:true,taxableMin:5000});
  expect(preview.eligibleCount).toBe(0);
  await expect(confirm(preview)).rejects.toThrow(/eligible/);
  expect(await owner.db.select().from(schema.payrollTaxBasisRevision)).toHaveLength(0);
  for(const saved of original)expect((await owner.db.select().from(schema.payslip).where(eq(schema.payslip.id,saved.id)))[0]).toEqual(saved);
 });

 it('still holds when the caller cannot see the employee\'s TP3 and applied opening',async()=>{
  await capped();
  await owner.db.insert(schema.employeeTp3).values({tenantId:b.tenantId,personId:await personOf(),assessmentYear:2026,payload:tp3Payload(1000)});
  const other=await createCompany(ctx,{legalName:'Fictional destination employer',country:'MY',currency:'MYR'});
  await owner.db.update(schema.employment).set({companyId:other.id}).where(eq(schema.employment.id,employee));
  const originalCompanyOnly={...ctx,grants:[{role:'hr_admin',companyId:b.companyId}]};
  const preview=await previewTaxBasisRecalculation(originalCompanyOnly,selection()),who=preview.employees[0];
  expect(who).toMatchObject({status:'skipped',holdReason:'access_insufficient',taxable:null,months:[]});
  expect(who.reason).toMatch(/not allowed to see/);expect(who.openingExemption).toBeUndefined();
  expect(who.bounds?.codes).toEqual([{code:'PCB_TRA_BUSINESS',cap:6000,eligible:1500,exemptMax:1500,certainExcess:0}]);
  await expect(confirmTaxBasisRecalculation(originalCompanyOnly,{previewId:preview.previewId,previewHash:preview.previewHash})).rejects.toThrow(/eligible/);
  // With the employment administered by this employer again, the same TP3 is read and the employee finishes.
  await owner.db.update(schema.employment).set({companyId:b.companyId}).where(eq(schema.employment.id,employee));
  const full=(await previewTaxBasisRecalculation(ctx,selection())).employees[0];
  expect(full).toMatchObject({status:'ready',openingExemption:{source:'accepted_tp3',used:{PCB_TRA_BUSINESS:1000}}});
 });
});
