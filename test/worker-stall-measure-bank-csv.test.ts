/**
 * MEASUREMENT ONLY — branch claude/worker-stall-measure-20261114, never merged into main/alpha (it is minutes long
 * and builds a 250,000-employee fixture, so it does not belong in the gate).
 *
 * Times the import worker's Bank & Statutory phases for a maximum-size CSV (250,000 rows, every template column,
 * just under 128 MiB) so the stall watchdog limit (lib/import-worker-watchdog.ts, default 1200 s) can be checked
 * against the longest legitimate single phase. Each measured call is exactly one `runBankImportTick`, the unit the
 * runner wraps in watchdog.enter('bank'). Assertions are sanity only, never a speed limit.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {eq} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {commitEmployeeImport} from '../core/import';
import {createBankImportJob,uploadBankImportChunk,bankImportCommand,getBankImportJob} from '../core/bank-import-job';
import {runBankImportTick} from '../core/bank-import-worker';
import {analyzeBankImportBatch} from '../core/import-sections';
import {BANK_IMPORT_CHUNK_BYTES,BANK_IMPORT_MAX_ROWS} from '../lib/bank-import-job';
import {parseCsvRecords} from '../lib/csv';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {TAG,clock,hostLine,summary,worstCaseCsv} from './helpers/worker-stall-measure';

let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);});afterAll(closeAll);
const ROWS=BANK_IMPORT_MAX_ROWS;

async function admit(bytes:Buffer,name:string){
 const admission=await createBankImportJob(ctx,{name,bytes:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')});
 for(let offset=0,part=0;offset<bytes.length;offset+=BANK_IMPORT_CHUNK_BYTES,part++)await uploadBankImportChunk(ctx,admission.job.id,part,bytes.subarray(offset,offset+BANK_IMPORT_CHUNK_BYTES));
 await bankImportCommand(ctx,admission.job.id,'validate');return admission.job.id;
}
async function exemplar(){
 const records=parseCsvRecords('full_name,email,department,hired_on,ic_number,basic_salary,employee_code\nImport Subject,import@example.test,Finance,2026-01-05,900101105555,5000,BANK001').records;
 const result=await commitEmployeeImport(ctx,{companyId:b.companyId,records});expect(result.imported,JSON.stringify(result.failed)).toBe(1);
 return (await owner.db.select().from(schema.employment).where(eq(schema.employment.employeeCode,'BANK001')))[0];
}
/** Same disposable fixture as test/bank-import-job.test.ts's 100,001-row case, at 250,000 employees. */
async function employees(personId:string){
 await owner.client.begin(async fixture=>{
  await fixture`set local session_replication_role='replica'`;
  await fixture`with people as (
   insert into person(tenant_id,full_name,primary_email)
   select ${b.tenantId}::uuid,'Large Import '||n,'large'||n||'@example.test' from generate_series(1,${ROWS}::int) n returning id,full_name
  ) insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
   select ${b.tenantId}::uuid,id,${b.companyId}::uuid,'SCALE'||substring(full_name from 14),'2026-01-05'::date from people`;
  await fixture`insert into employee_statutory_my
   select replacement.* from employment e
   cross join lateral jsonb_populate_record(null::employee_statutory_my,
    (select to_jsonb(s) from employee_statutory_my s where s.person_id=${personId}::uuid)
    ||jsonb_build_object('id',gen_random_uuid(),'person_id',e.person_id,'ic_number',null,'tax_number','TBASE')) replacement
   where e.tenant_id=${b.tenantId}::uuid and e.employee_code like 'SCALE%'`;
 });
 for(const table of ['person','employment','employee_statutory_my'])await owner.client.unsafe(`analyze ${table}`);
}
const job=async(id:string)=>(await getBankImportJob(ctx,id)).job;

describe('MEASUREMENT: import worker Bank & Statutory phases at the maximum CSV',()=>{
 it('times the queued, validation, attempt and import ticks of a 250,000-row, ~126 MiB CSV',async()=>{
  hostLine();
  const e=await exemplar();
  await clock('fixture: 250,000 employees with statutory rows',()=>employees(e.personId));
  const csv=worstCaseCsv(ROWS);
  const id=await clock('upload: 1 MiB chunks through the web service functions',()=>admit(csv,'bank-statutory.csv'));
  // PHASE OF CONCERN: one tick reads the chunks, checks the hash, decodes and inserts every row in one transaction.
  expect(await clock('bank tick 1: queued -> validating (fetch + decode + insert 250,000 rows)',()=>runBankImportTick(owner.client))).toBe(true);
  const staged=await job(id);
  if(staged.state!=='validating')console.info(`${TAG} queued tick ended in ${staged.state}: ${staged.error}`);
  expect(staged).toMatchObject({state:'validating',total:ROWS});
  // Direct probes of the canonical analyzer the validation tick calls, to show its per-row cost.
  for(const n of [10,100]){
   const sample=await owner.client<{record:Record<string,string>}[]>`select record from bank_import_row where job_id=${id}::uuid order by ordinal limit ${n}`;
   await clock(`probe: analyzeBankImportBatch on ${n} rows`,()=>analyzeBankImportBatch(ctx,sample.map(r=>r.record)));
  }
  let ticks=0;
  for(let i=1;i<=3;i++){
   const started=Date.now();
   expect(await clock(`bank validation tick ${i} (1,000 rows)`,()=>runBankImportTick(owner.client))).toBe(true);ticks++;
   if(Date.now()-started>90_000)break;
  }
  const validated=await getBankImportJob(ctx,id);
  console.info(`${TAG} after ${ticks} validation ticks: ${JSON.stringify({validated:validated.job.validated,valid:validated.job.valid,invalid:validated.job.invalid,unchanged:validated.job.unchanged})}`);
  const firstInvalid=validated.rows.find(row=>row.preview&&!row.preview.ok&&row.preview.errors.length);
  if(firstInvalid)console.info(`${TAG} first invalid row errors: ${JSON.stringify(firstInvalid.preview?.errors)}`);
  expect(validated.job.validated).toBe(ticks*1000);
  if(validated.job.valid>0){
   // Measurement shortcut, not product behavior: the remaining 247 validation ticks are the same bounded unit
   // as the three timed above, so the rest are marked unchanged to reach the confirmation phases in time.
   await owner.client.begin(async tx=>{
    await tx`set local session_replication_role='replica'`;
    const [{n}]=await tx<{n:number}[]>`with x as (update bank_import_row set state='unchanged' where job_id=${id}::uuid and state='pending' returning 1) select count(*)::int as n from x`;
    await tx`update bank_import_job set state='ready',validated=total,unchanged=unchanged+${n},updated_at=now() where id=${id}::uuid`;
   });
   await bankImportCommand(ctx,id,'confirm');
   expect(await clock('bank tick: create immutable history attempt (stores the ~126 MiB source)',()=>runBankImportTick(owner.client))).toBe(true);
   expect((await job(id)).attemptId).toBeTruthy();
   for(let i=1;i<=2;i++)expect(await clock(`bank import tick ${i} (100 rows, one transaction each)`,()=>runBankImportTick(owner.client))).toBe(true);
   const done=await job(id);
   console.info(`${TAG} after 2 import ticks: ${JSON.stringify({state:done.state,processed:done.processed,saved:done.saved,failed:done.failed,error:done.error})}`);
   expect(done.state).toBe('importing');
  }else console.info(`${TAG} no valid rows in the validated batches; attempt/import ticks not measured`);
  summary('bank-csv');
 },1_080_000);
});
