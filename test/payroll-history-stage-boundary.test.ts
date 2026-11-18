/** Fictional inputs; real worker capability, sealed steps, RLS and atomic visibility. */
import {afterAll,beforeEach,expect,it} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {createBatch} from '../core/payroll';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {previewPayrollHistoryUpload,confirmPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {requestPayrollHistoryConfirm,payrollHistoryJobHandler} from '../core/payroll-history-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {todayInKualaLumpur} from '../lib/hr-date';
import {owner,resetDb,seedBase,setModule,entitledCtx,closeAll,type Base} from './harness';
let b:Base,ctx:SessionContext,attemptId:string,jobId:string;
const period=String(Number(todayInKualaLumpur().slice(0,4))-2)+'-01';
async function tick(){await runBulkJobTick(owner.client,{handlers:[payrollHistoryJobHandler]});}
async function paused(){
 for(let n=0;n<50;n++){
  await tick();
  const rows=await owner.client<{id:string;record_id:string;ordinal:number;snapshot_id:string}[]>`select v.id,v.record_id,v.ordinal,v.snapshot_id from app.payroll_history_staged_row sr join public.payroll_history_import_revision v on v.id=sr.row_id where sr.stage_id=${jobId}::uuid and sr.relation='payroll_history_import_revision'`;
  if(rows.length)return rows[0];
 }
 throw Error('Expected a pending real history stage');
}
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');ctx=await entitledCtx(b);
 await owner.db.update(schema.company).set({companyLabel:'STAGE'}).where(eq(schema.company.id,b.companyId));await seedPayrollCycleCatalog(ctx,b.companyId);
 await owner.db.insert(schema.payComponent).values({tenantId:b.tenantId,code:'BASIC',name:'Fictional basic',kind:'allowance',displayCategory:'basic',pcbRemunerationType:'normal',pcbExemptionCode:'PCB_TAXABLE'});
 const rows:string[][]=[];
 for(let n=0;n<3;n++){
  const code='ST'+n;await hireEmployee(ctx,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:period+'-01',employeeCode:code,person:{fullName:'Fictional staged '+n,primaryEmail:'stage-'+n+'@fixture.invalid'}});
  for(const [item,amount] of [['BASIC','1000.00'],['EEEPF','0.00'],['EESOCSO','0.00'],['EEEIS','0.00'],['PCB','0.00']])rows.push([code,period,'ME',item,'STAGE',amount]);
 }
 const first=await previewPayrollHistoryUpload(ctx,{name:'fictional-original.csv',operationKey:randomUUID(),content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows]))});
 await confirmPayrollHistoryUpload(ctx,{attemptId:first.attemptId,previewHash:first.plan.previewHash,confirmReplacement:true});
 const changed=rows.map(row=>row[3]==='BASIC'?[...row.slice(0,5),'1200.00']:row);
 const preview=await previewPayrollHistoryUpload(ctx,{name:'fictional-stage.csv',operationKey:randomUUID(),content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...changed]))});attemptId=preview.attemptId;
 const job=await requestPayrollHistoryConfirm(ctx,{attemptId,previewHash:preview.plan.previewHash,confirmReplacement:true,acknowledgeWarnings:true});if(!('jobId' in job))throw Error('Expected staged job');jobId=job.jobId;
 process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS='1';
});
afterAll(async()=>{delete process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS;await closeAll();});
it('rejects stage lifecycle and selectors without the private worker capability, even with public job and attempt IDs',async()=>{
 for(const query of [sql`select app.payroll_history_stage_open(${jobId}::uuid,${attemptId}::uuid,'confirm')`,sql`select app.payroll_history_stage_join(${jobId}::uuid)`,sql`select app.payroll_history_stage_step(${jobId}::uuid,0)`,sql`select app.payroll_history_stage_release(${jobId}::uuid)`])await expect(withTenant(ctx,tx=>tx.execute(query))).rejects.toThrow();
 expect(await owner.client`select * from app.payroll_history_stage where stage_id=${jobId}::uuid`).toHaveLength(0);
});
it('forged GUCs cannot read, mutate, stamp or append an unstaged descendant of a real pending revision',async()=>{
 const staged=await paused();
 const [visible]=await withTenant(ctx,async tx=>{
  await tx.execute(sql`select set_config('app.payroll_history_stage',${jobId},true),set_config('app.bulk_job_seq','1',true)`);
  return tx.execute<{n:number}>(sql`select count(*)::int n from payroll_history_import_revision where id=${staged.id}::uuid`);
 });expect(visible.n).toBe(0);
 await expect(withTenant(ctx,async tx=>{
  await tx.execute(sql`select set_config('app.payroll_history_stage',${jobId},true)`);
  await tx.execute(sql`insert into payroll_history_import_revision(tenant_id,record_id,ordinal,attempt_id,snapshot_id,previous_revision_id,kind,cycle_name) values(${b.tenantId}::uuid,${staged.record_id}::uuid,${staged.ordinal+1},${attemptId}::uuid,${staged.snapshot_id}::uuid,${staged.id}::uuid,'correction','Monthly')`);
 })).rejects.toThrow();
 // No forged selector at all: physical immutable provenance must not become a published descendant.
 await expect(withTenant(ctx,tx=>tx.execute(sql`insert into payroll_history_import_revision(tenant_id,record_id,ordinal,attempt_id,snapshot_id,previous_revision_id,kind,cycle_name) values(${b.tenantId}::uuid,${staged.record_id}::uuid,${staged.ordinal+1},${attemptId}::uuid,${staged.snapshot_id}::uuid,${staged.id}::uuid,'correction','Monthly')`))).rejects.toThrow();
 const [batch]=await owner.client<{id:string}[]>`select row_id id from app.payroll_history_staged_row where stage_id=${jobId}::uuid and relation='payroll_batch' limit 1`;
 const updated=await withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.payroll_history_stage',${jobId},true)`);return tx.execute(sql`update payroll_batch set remarks='forged' where id=${batch.id}::uuid returning id`);});expect(updated).toHaveLength(0);
 const deleted=await withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.payroll_history_stage',${jobId},true)`);return tx.execute(sql`delete from payroll_batch where id=${batch.id}::uuid returning id`);});expect(deleted).toHaveLength(0);
 // Even the physical owner connection cannot mutate a staged row without the private held capability.
 await expect(owner.client`update public.payroll_batch set remarks='owner without capability' where id=${batch.id}::uuid`).rejects.toThrow();
 await expect(owner.client`delete from public.payroll_history_import_revision where id=${staged.id}::uuid`).rejects.toThrow();
 const native=await createBatch(ctx,{companyId:b.companyId,payPeriod:period.slice(0,4)+'-02'});
 expect(await owner.client`select * from app.payroll_history_staged_row where relation='payroll_batch' and row_id=${native.batchId}::uuid`).toHaveLength(0);
 await expect(withTenant(ctx,tx=>tx.execute(sql`select app.payroll_history_stage_release(${jobId}::uuid)`))).rejects.toThrow();
 const [state]=await owner.client<{state:string}[]>`select state from app.payroll_history_stage where stage_id=${jobId}::uuid`;expect(state.state).toBe('staged');
});
it('the actual sealed worker releases all rows together and remains idempotent after subsequent ticks',async()=>{
 await paused();expect(await withTenant(ctx,tx=>tx.select().from(schema.payrollHistoryImportRevision))).toHaveLength(3);
 for(let n=0;n<100;n++){await tick();const [job]=await owner.client<{state:string;error:string|null}[]>`select state,error from public.bulk_job where id=${jobId}::uuid`;if(job.state==='completed')break;if(job.state==='failed')throw Error(job.error??'History job failed');}
 const [job]=await owner.client<{state:string}[]>`select state from public.bulk_job where id=${jobId}::uuid`;expect(job.state).toBe('completed');
 const revisions=await withTenant(ctx,tx=>tx.select().from(schema.payrollHistoryImportRevision));expect(revisions).toHaveLength(6);
 for(let n=0;n<3;n++)await tick();expect(await withTenant(ctx,tx=>tx.select().from(schema.payrollHistoryImportRevision))).toEqual(revisions);
});
it('revoked creator permission cannot publish and genuine owner-capability discard removes the unpublished graph',async()=>{
 await paused();await owner.db.insert(schema.payrollPermissionGrant).values({tenantId:b.tenantId,companyId:b.companyId,permissionKey:'payroll.history.import',role:'hr_admin',allowed:false});
 for(let n=0;n<100;n++){await tick();const [job]=await owner.client<{state:string}[]>`select state from public.bulk_job where id=${jobId}::uuid`;if(job.state==='failed'||job.state==='cancelled')break;}
 const [stage]=await owner.client<{state:string}[]>`select state from app.payroll_history_stage where stage_id=${jobId}::uuid`;expect(stage.state).toBe('discarded');
 expect(await owner.client`select * from app.payroll_history_staged_row where stage_id=${jobId}::uuid`).toHaveLength(0);
 expect(await owner.client`select * from public.payroll_history_import_revision where attempt_id=${attemptId}::uuid`).toHaveLength(0);
});

it('binds the current fenced job and exact pending sealed step, and rejects a replaced lease capability',async()=>{
 await paused();const token=randomUUID(),cap=randomBytes(32).toString('hex');
 await owner.client`update public.bulk_job set lease_token=${token}::uuid where id=${jobId}::uuid`;
 await owner.client`select app.bulk_job_lease_capability(${jobId}::uuid,${token}::uuid,${cap})`;
 const [pending]=await owner.client<{seq:number}[]>`select min(seq)::int seq from public.bulk_job_step where job_id=${jobId}::uuid and state='pending'`;
 const fenced=(seq:number)=>withTenant(ctx,async tx=>{
  const [fence]=await tx.execute<{status:string}>(sql`select app.bulk_job_fence(${jobId}::uuid,${cap}) status`);expect(fence.status).toBe('held');
  await tx.execute(sql`select app.payroll_history_stage_step(${jobId}::uuid,${seq})`);
 });
 await expect(fenced(pending.seq+1)).rejects.toThrow();await fenced(pending.seq);
 await expect(withTenant(ctx,async tx=>{await tx.execute(sql`select app.bulk_job_fence(${jobId}::uuid,${cap})`);await tx.execute(sql`select app.payroll_history_stage_join(${randomUUID()}::uuid)`);})).rejects.toThrow();
 // Altering a source step without its private seal cannot be admitted, even with the correct lease.
 await owner.client`update public.bulk_job_step set payload=payload||' {"forged":true}'::jsonb where job_id=${jobId}::uuid and seq=${pending.seq}`;
 await expect(fenced(pending.seq)).rejects.toThrow();
 const nextToken=randomUUID();await owner.client`update public.bulk_job set lease_token=${nextToken}::uuid where id=${jobId}::uuid`;
 await owner.client`select app.bulk_job_lease_capability(${jobId}::uuid,${nextToken}::uuid,${randomBytes(32).toString('hex')})`;
 await expect(withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.bulk_job_capability',${cap},true)`);await tx.execute(sql`select app.payroll_history_stage_join(${jobId}::uuid)`);})).rejects.toThrow();
});
