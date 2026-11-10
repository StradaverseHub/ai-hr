/** The employee import Revert as a background job (draft migration 9932): real PostgreSQL, real RLS, real worker
 * ticks. Equivalence against the synchronous revert on an identical second tenant: the same voids, the same audit
 * events in the same order and the same Import History events. */
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {commitEmployeeImport} from '../core/import';
import {previewImportRevert,revertImport} from '../core/import-history';
import {employeeFullRevertHandler} from '../core/employee-import-history';
import {previewImportRevertForAttempt,revertImportForAttempt} from '../core/import-history-handlers';
import {getEmployeeImportRevertJob} from '../core/employee-import-revert-job';
import {verifyTenantChain} from '../core/audit-chain';
import {revertImportToOutcome} from './helpers/employee-import-revert';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

vi.hoisted(()=>{process.env.AUDIT_HASH_CHAIN_ENABLED='true';});
beforeAll(migrateTestDb);
beforeEach(resetDb);
afterAll(closeAll);

const ic=(n:number)=>`88${String(n).padStart(2,'0')}0101${String(n).padStart(4,'0')}`.slice(0,12);
type Fixture={b:Base;ctx:SessionContext;attemptId:string};
async function fixture(count=4):Promise<Fixture>{
 const b=await seedBase(),ctx=adminCtx(b);
 const records=Array.from({length:count},(_,i)=>({full_name:`Fictional Revert ${i}`,email:`revert-${i}-${b.tenantId.slice(0,8)}@fixture.test`,department:'Finance',
  hired_on:'2026-02-02',ic_number:ic(i+10),basic_salary:'4800',employee_code:`RV${String(i).padStart(3,'0')}`}));
 const content=Buffer.from(JSON.stringify(records));
 const result=await commitEmployeeImport(ctx,{companyId:b.companyId,records,fileName:'hires.csv',source:{name:'hires.csv',content}});
 expect(result.imported).toBe(count);
 return{b,ctx,attemptId:result.attemptId!};
}
/** Everything a revert changes, with identities replaced by employee codes and the attempt (ids and times differ). */
async function endState(f:Fixture){
 const code=new Map((await owner.client<{id:string;code:string}[]>`select id,coalesce(employee_code,voided_employee_code) as code from employment where tenant_id=${f.b.tenantId}::uuid`).map(r=>[r.id,r.code]));
 const employments=await owner.client<Record<string,unknown>[]>`select coalesce(employee_code,voided_employee_code) as code,employee_code,voided_employee_code,voided_at is not null as voided,
  voided_by=${f.ctx.userId!}::uuid as by_admin,void_reason,voided_import_attempt_id=${f.attemptId}::uuid as this_attempt from employment where tenant_id=${f.b.tenantId}::uuid order by 1`;
 const persons=await owner.client<Record<string,unknown>[]>`select p.full_name,p.voided_at is not null as voided,p.voided_ic_number,s.ic_number from person p left join employee_statutory_my s on s.person_id=p.id
  where p.tenant_id=${f.b.tenantId}::uuid and p.full_name like 'Fictional Revert%' order by 1`;
 const events=(await owner.client<{event_type:string;aggregate_id:string;subject_employment_id:string|null;actor_type:string;by_admin:boolean;payload:Record<string,unknown>;visible:boolean}[]>`
  select event_type,aggregate_id,subject_employment_id,actor_type::text,actor_id=${f.ctx.userId!}::uuid as by_admin,payload,import_pending_attempt_id is null as visible
  from domain_event where tenant_id=${f.b.tenantId}::uuid and event_type in ('employment.voided','import-attempt.reverted','import-attempt.revert-failed') order by sequence`)
  .map(e=>({...e,aggregate_id:code.get(e.aggregate_id)??(e.aggregate_id===f.attemptId?'attempt':e.aggregate_id),subject_employment_id:e.subject_employment_id?code.get(e.subject_employment_id):null,
   payload:{...e.payload,...(e.payload.importAttemptId?{importAttemptId:e.payload.importAttemptId===f.attemptId?'attempt':'other'}:{})}}));
 const history=await owner.client<Record<string,unknown>[]>`select kind,reason,detail,actor_id=${f.ctx.userId!}::uuid as by_admin from import_attempt_event where attempt_id=${f.attemptId}::uuid order by created_at,id`;
 return{employments,persons,events,history:history.map(h=>({...h,detail:{...(h.detail as object),...((h.detail as {blockers?:unknown[]}).blockers?{blockers:'present'}:{})}}))};
}
const tick=async()=>{const {runBulkJobTick}=await import('../core/bulk-job-worker');const {BULK_JOB_HANDLERS}=await import('../core/bulk-job-handlers');return runBulkJobTick(owner.client,{handlers:BULK_JOB_HANDLERS});};

describe('employee import revert job',()=>{
 it('voids exactly as the synchronous revert: rows, audit events in order, Import History, chain',async()=>{
  const sync=await fixture(),job=await fixture();
  const syncPreview=await previewImportRevert(sync.ctx,sync.attemptId,employeeFullRevertHandler);
  expect(await revertImport(sync.ctx,sync.attemptId,employeeFullRevertHandler,{previewHash:syncPreview.previewHash,reason:'Wrong company in this file'})).toEqual({attemptId:sync.attemptId,restored:4});
  const preview=await previewImportRevertForAttempt(job.ctx,job.attemptId);
  // The lock-free review is the same review: same eligibility, items and hash as the locked one.
  const locked=await previewImportRevert(job.ctx,job.attemptId,employeeFullRevertHandler);
  expect(preview).toEqual(locked);
  const before=await endState(job);
  const started=await revertImportForAttempt(job.ctx,job.attemptId,{previewHash:preview.previewHash,reason:'Wrong company in this file'});
  expect('job' in started).toBe(true);
  expect(await endState(job)).toEqual(before); // nothing happens in the request
  for(let i=0;i<200;i++){const [r]=await owner.client<{state:string}[]>`select state from bulk_job where id=${(started as {job:{id:string}}).job.id}::uuid`;if(['completed','failed'].includes(r.state))break;if(!await tick())await new Promise(r2=>setTimeout(r2,40));}
  const first=await getEmployeeImportRevertJob(job.ctx,(started as {job:{id:string}}).job.id);
  expect(first).toMatchObject({state:'completed',restored:4,error:null});
  // Once only, refused and recorded in the same words on both sides.
  await expect(revertImport(sync.ctx,sync.attemptId,employeeFullRevertHandler,{previewHash:syncPreview.previewHash,reason:'Again please'})).rejects.toThrow('already been reverted');
  await expect(revertImportToOutcome(job.ctx,job.attemptId,{previewHash:preview.previewHash,reason:'Again please'})).rejects.toThrow('already been reverted');
  const after=await endState(job);
  expect(after).toEqual(await endState(sync));
  expect(after.events.filter(e=>e.event_type==='employment.voided').map(e=>e.aggregate_id)).toEqual(['RV000','RV001','RV002','RV003']);
  expect(after.employments.every(e=>e.voided&&e.this_attempt&&e.by_admin&&e.employee_code===null)).toBe(true);
  expect(after.persons.every(p=>p.voided&&p.ic_number===null&&p.voided_ic_number)).toBe(true);
  expect((await verifyTenantChain(job.ctx)).valid).toBe(true);
  const [metrics]=await owner.client<{metrics:Record<string,number>}[]>`select metrics from bulk_job where id=${(started as {job:{id:string}}).job.id}::uuid`;
  expect(metrics.metrics.releaseTxMs).toBeGreaterThan(0);
 });

 it('refuses, as a whole and in the synchronous words, an import with records attached since, and records the failure',async()=>{
  const job=await fixture(2);
  const preview=await previewImportRevertForAttempt(job.ctx,job.attemptId);
  // Attached after the review: the revert's own re-check finds it under its locks.
  const [e]=await owner.client<{id:string}[]>`select id from employment where tenant_id=${job.b.tenantId}::uuid and employee_code='RV001'`;
  await owner.client`insert into leave_ledger(tenant_id,employment_id,leave_type_id,entry_type,days,effective_on) values(${job.b.tenantId}::uuid,${e.id}::uuid,${job.b.annualLeaveTypeId}::uuid,'debit',-1,'2026-03-02')`;
  const before=await endState(job);
  await expect(revertImportToOutcome(job.ctx,job.attemptId,{previewHash:preview.previewHash,reason:'Undo the file'})).rejects.toThrow('cannot be reverted');
  const after=await endState(job);
  expect(after.employments).toEqual(before.employments);
  expect(after.history.map(h=>h.kind)).toContain('revert_failed');
 });

 it('re-checks under its locks: a blocker that appears after the review stops the revert with nothing voided',async()=>{
  const job=await fixture(2);
  const preview=await previewImportRevertForAttempt(job.ctx,job.attemptId);
  const started=await revertImportForAttempt(job.ctx,job.attemptId,{previewHash:preview.previewHash,reason:'Undo the file'}) as {job:{id:string}};
  for(let i=0;i<100;i++){const [r]=await owner.client<{state:string}[]>`select state from bulk_job where id=${started.job.id}::uuid`;if(r.state==='finalizing')break;await tick();}
  const [e]=await owner.client<{id:string}[]>`select id from employment where tenant_id=${job.b.tenantId}::uuid and employee_code='RV000'`;
  await owner.client`insert into leave_ledger(tenant_id,employment_id,leave_type_id,entry_type,days,effective_on) values(${job.b.tenantId}::uuid,${e.id}::uuid,${job.b.annualLeaveTypeId}::uuid,'debit',-1,'2026-03-02')`;
  for(let i=0;i<100;i++){const [r]=await owner.client<{state:string}[]>`select state from bulk_job where id=${started.job.id}::uuid`;if(['completed','failed'].includes(r.state))break;if(!await tick())await new Promise(r2=>setTimeout(r2,40));}
  const progress=await getEmployeeImportRevertJob(job.ctx,started.job.id);
  expect(progress).toMatchObject({state:'failed',error:'This import cannot be reverted because some records changed after it.'});
  expect(progress.blockers.map(b=>b.label)).toEqual(['RV000 · Fictional Revert 0']);
  expect((await owner.client`select id from employment where tenant_id=${job.b.tenantId}::uuid and voided_at is not null`)).toHaveLength(0);
 });

 it('refuses a stale review, keeps the release owner-only, and refuses a caller without maintain at the door',async()=>{
  const job=await fixture(1);
  await expect(revertImportToOutcome(job.ctx,job.attemptId,{previewHash:'0'.repeat(64),reason:'Undo the file'})).rejects.toThrow('has changed. Review it again');
  await expect(withTenant(job.ctx,tx=>tx.execute(sql`select app.employee_import_revert_release(gen_random_uuid(),false)`))).rejects.toThrow();
  const viewer={...job.ctx,grants:[{role:'employee',companyId:null}],roles:['employee']} as SessionContext;
  await expect(revertImportForAttempt(viewer,job.attemptId,{previewHash:'0'.repeat(64),reason:'Undo the file'})).rejects.toThrow();
  expect((await owner.client`select id from employment where tenant_id=${job.b.tenantId}::uuid and voided_at is not null`)).toHaveLength(0);
 });
});
