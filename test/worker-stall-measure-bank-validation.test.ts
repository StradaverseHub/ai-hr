/**
 * MEASUREMENT ONLY — branch claude/worker-stall-measure-20261114, never merged (see
 * test/worker-stall-measure-bank-csv.test.ts). The CSV run showed analyzeBankImportBatch costing about 1 s per row
 * in a 250,000-employee tenant. This attributes it (which columns, which tenant size) and times a validation tick and
 * the import ticks on a small job in the same large tenant. Assertions are sanity only.
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
import {BANK_IMPORT_CHUNK_BYTES} from '../lib/bank-import-job';
import {parseCsvRecords} from '../lib/csv';
import {buildPersonnelCsv} from '../lib/personnel-csv';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {BANK_CAPTIONS,BANK_COLUMNS,TAG,bankRow,clock,hostLine,summary} from './helpers/worker-stall-measure';

let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);});afterAll(closeAll);
const RESIDENCY=['tax_residency','is_resident','tax_circumstance','tax_category','epf_citizenship'];

async function employees(personId:string,from:number,to:number){
 await owner.client.begin(async fixture=>{
  await fixture`set local session_replication_role='replica'`;
  await fixture`with people as (
   insert into person(tenant_id,full_name,primary_email)
   select ${b.tenantId}::uuid,'Large Import '||n,'large'||n||'@example.test' from generate_series(${from}::int,${to}::int) n returning id,full_name
  ) insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
   select ${b.tenantId}::uuid,id,${b.companyId}::uuid,'SCALE'||substring(full_name from 14),'2026-01-05'::date from people`;
  await fixture`insert into employee_statutory_my
   select replacement.* from employment e
   cross join lateral jsonb_populate_record(null::employee_statutory_my,
    (select to_jsonb(s) from employee_statutory_my s where s.person_id=${personId}::uuid)
    ||jsonb_build_object('id',gen_random_uuid(),'person_id',e.person_id,'ic_number',null,'tax_number','TBASE')) replacement
   where e.tenant_id=${b.tenantId}::uuid and e.employee_code like 'SCALE%'
    and not exists (select 1 from employee_statutory_my x where x.person_id=e.person_id)`;
 });
 for(const table of ['person','employment','employee_statutory_my'])await owner.client.unsafe(`analyze ${table}`);
}
const record=(n:number,keep:(column:string)=>boolean)=>{const row=bankRow(n,40);return Object.fromEntries(BANK_COLUMNS.map((c,i)=>[c,row[i]]).filter(([c])=>c==='employee_code'||keep(c)));};
async function probes(size:string,base:number){
 const variants:[string,(c:string)=>boolean][]=[
  ['every template column',()=>true],
  ['without the five residency columns',c=>!RESIDENCY.includes(c)],
  ['employee_code + tax_residency only',c=>c==='tax_residency'],
  ['employee_code + bank_name/bank_account_no only',c=>c==='bank_name'||c==='bank_account_no'],
 ];
 for(const [name,keep] of variants){
  const records=Array.from({length:20},(_,i)=>record(base+i,keep));
  const result=await clock(`probe @${size} employees: analyze 20 rows, ${name}`,()=>analyzeBankImportBatch(ctx,records));
  expect(result.rows).toHaveLength(20);
 }
}

describe('MEASUREMENT: Bank & Statutory validation cost by column set and tenant size',()=>{
 it('attributes the per-row validation cost and times validation/import ticks in a 250,000-employee tenant',async()=>{
  hostLine();
  const recs=parseCsvRecords('full_name,email,department,hired_on,ic_number,basic_salary,employee_code\nImport Subject,import@example.test,Finance,2026-01-05,900101105555,5000,BANK001').records;
  expect((await commitEmployeeImport(ctx,{companyId:b.companyId,records:recs})).imported).toBe(1);
  const e=(await owner.db.select().from(schema.employment).where(eq(schema.employment.employeeCode,'BANK001')))[0];
  await clock('fixture: 2,000 employees',()=>employees(e.personId,1,2000));
  await probes('2,001',1);
  await clock('fixture: grow to 250,000 employees',()=>employees(e.personId,2001,250000));
  await probes('250,001',100);
  // A small real job in the large tenant: one validation tick (100 rows) and one import tick (100 rows).
  const csv=Buffer.from(buildPersonnelCsv('employee',[BANK_CAPTIONS,...Array.from({length:100},(_,i)=>bankRow(200001+i,40))]));
  const admission=await createBankImportJob(ctx,{name:'small.csv',bytes:csv.length,hash:createHash('sha256').update(csv).digest('hex')});
  for(let offset=0,part=0;offset<csv.length;offset+=BANK_IMPORT_CHUNK_BYTES,part++)await uploadBankImportChunk(ctx,admission.job.id,part,csv.subarray(offset,offset+BANK_IMPORT_CHUNK_BYTES));
  await bankImportCommand(ctx,admission.job.id,'validate');
  const id=admission.job.id;
  expect(await clock('bank tick: queued (100 rows)',()=>runBankImportTick(owner.client))).toBe(true);
  expect(await clock('bank validation tick (100 rows, every template column, 250,001 employees)',()=>runBankImportTick(owner.client))).toBe(true);
  expect(await clock('bank validation tick (no pending rows -> ready)',()=>runBankImportTick(owner.client))).toBe(true);
  const ready=(await getBankImportJob(ctx,id));
  console.info(`${TAG} small job after validation: ${JSON.stringify({state:ready.job.state,valid:ready.job.valid,invalid:ready.job.invalid,unchanged:ready.job.unchanged,errors:ready.rows.find(r=>r.preview&&!r.preview.ok)?.preview?.errors})}`);
  if(ready.job.state==='ready'&&ready.job.valid>0){
   await bankImportCommand(ctx,id,'confirm');
   expect(await clock('bank tick: create history attempt (small source)',()=>runBankImportTick(owner.client))).toBe(true);
   expect(await clock(`bank import tick (${ready.job.valid} valid rows, one transaction each)`,()=>runBankImportTick(owner.client))).toBe(true);
   const done=(await getBankImportJob(ctx,id)).job;
   console.info(`${TAG} small job after import tick: ${JSON.stringify({state:done.state,processed:done.processed,saved:done.saved,failed:done.failed,error:done.error})}`);
  }
  summary('bank-validation');
 },1_080_000);
});
