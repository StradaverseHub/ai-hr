import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {commitEmployeeImport} from '../core/import';
import {createBankImportJob,uploadBankImportChunk,bankImportCommand,getBankImportJob,listBankImportJobs} from '../core/bank-import-job';
import {processBankImportJob,runBankImportTick} from '../core/bank-import-worker';
import {applyBankImportRowTx} from '../core/import-sections';
import {BANK_IMPORT_CHUNK_BYTES} from '../lib/bank-import-job';
import {parseCsvRecords} from '../lib/csv';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,createAppUser,type Base} from './harness';
let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);});afterAll(closeAll);
const content=(rows:string[])=>Buffer.from('employee_code,tax_number\n'+rows.join('\n'));
async function admit(bytes:Buffer,actor=ctx){const admission=await createBankImportJob(actor,{name:'bank.csv',bytes:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')});for(let offset=0,part=0;offset<bytes.length;offset+=BANK_IMPORT_CHUNK_BYTES,part++)await uploadBankImportChunk(actor,admission.job.id,part,bytes.subarray(offset,offset+BANK_IMPORT_CHUNK_BYTES));await bankImportCommand(actor,admission.job.id,'validate');return admission.job.id;}
async function ready(id:string){for(let i=0;i<10;i++){await processBankImportJob(ctx,id);const {job}=await getBankImportJob(ctx,id);if(job.state==='ready')return job;}throw Error('Validation did not finish');}
async function employee(){
 const records=parseCsvRecords('full_name,email,department,hired_on,ic_number,basic_salary,employee_code\nImport Subject,import@example.test,Finance,2026-01-05,900101105555,5000,BANK001').records;
 const result=await commitEmployeeImport(ctx,{companyId:b.companyId,records});expect(result.imported,JSON.stringify(result.failed)).toBe(1);
 return (await owner.db.select().from(schema.employment).where(eq(schema.employment.employeeCode,'BANK001')))[0];
}
describe('durable Bank & Statutory jobs',()=>{
 it('atomically joins concurrent identical uploads and keeps data tenant/creator scoped',async()=>{
  const bytes=content(['BANK001,T1']),input={name:'one.csv',bytes:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')};
  const results=await Promise.all([createBankImportJob(ctx,input),createBankImportJob(ctx,{...input,name:'renamed.csv'})]);
  expect(new Set(results.map(r=>r.job.id)).size).toBe(1);expect(results.filter(r=>r.existing)).toHaveLength(1);
  const other=await seedBase();expect(await listBankImportJobs(adminCtx(other))).toHaveLength(0);
  await expect(getBankImportJob(adminCtx(other),results[0].job.id)).rejects.toThrow('unavailable');
  const [person]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Other admin',primaryEmail:'other-admin@example.test'}).returning();
  const userId=await createAppUser(b.tenantId,person.id,'hr_admin');
  await expect(createBankImportJob({...ctx,userId},input)).rejects.toThrow('already has an active import');
 });
 it('does not expose cached preview data after the creator resolves a weaker role',async()=>{
  const id=await admit(content(['BANK001,T1']));
  await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,ctx.userId!));
  const weaker={...ctx,roles:[],grants:[]};
  expect(await listBankImportJobs(weaker)).toEqual([]);
  await expect(getBankImportJob(weaker,id)).rejects.toThrow('unavailable');
 });
 it('keeps the bounded subject projection closed to another tenant, a weaker role and oversized lookups',async()=>{
  await employee();const other=adminCtx(await seedBase());
  expect(await withTenant(other,tx=>tx.execute(sql`select * from app.bank_import_subjects('["BANK001"]'::jsonb)`))).toHaveLength(0);
  expect(await withTenant({...ctx,roles:[],grants:[]},tx=>tx.execute(sql`select * from app.bank_import_subjects('["BANK001"]'::jsonb)`))).toHaveLength(0);
  await expect(withTenant(ctx,tx=>tx.execute(sql`select * from app.bank_import_subjects(${JSON.stringify(Array(1001).fill('BANK001'))}::jsonb)`))).rejects.toThrow();
 });
 it('makes upload retries idempotent and refuses mismatched parts or premature completion',async()=>{
  const bytes=content(['BANK001,T1']),job=(await createBankImportJob(ctx,{name:'one.csv',bytes:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')})).job;
  await expect(bankImportCommand(ctx,job.id,'validate')).rejects.toThrow('every part');
  await uploadBankImportChunk(ctx,job.id,0,bytes);await uploadBankImportChunk(ctx,job.id,0,bytes);
  expect((await getBankImportJob(ctx,job.id)).job.uploadedBytes).toBe(bytes.length);
  await expect(uploadBankImportChunk(ctx,job.id,0,Buffer.alloc(bytes.length))).rejects.toThrow('differs');
 });
 it('runs the actual standalone worker process against a queued job',async()=>{
  await employee();const id=await admit(content(['BANK001,TCLI']));
  const result=spawnSync(process.execPath,['--import','tsx','scripts/bank-import-runner.ts','--once'],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:process.env.DATABASE_URL,MIGRATION_DATABASE_URL:process.env.MIGRATION_DATABASE_URL},encoding:'utf8',timeout:30000});
  expect(result.status,result.stderr).toBe(0);
  expect((await getBankImportJob(ctx,id)).job).toMatchObject({state:'validating',total:1,saved:0});
 });
 it('previews without changes, then saves via the canonical writer with atomic progress and history',async()=>{
  const e=await employee(),id=await admit(content(['BANK001,TNEW']));
  expect((await ready(id))).toMatchObject({valid:1,total:1,processed:0,saved:0});
  await expect(withTenant(ctx,tx=>tx.execute(sql`update bank_import_job set company_ids='{}'::uuid[] where id=${id}::uuid`))).rejects.toThrow();
  expect((await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId,e.personId)))[0].taxNumber).not.toBe('TNEW');
  await bankImportCommand(ctx,id,'confirm');await bankImportCommand(ctx,id,'confirm');
  await processBankImportJob(ctx,id);await processBankImportJob(ctx,id);
  const done=(await getBankImportJob(ctx,id)).job;expect(done).toMatchObject({state:'completed',saved:1,processed:1,failed:0});
  expect((await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId,e.personId)))[0].taxNumber).toBe('TNEW');
  expect(await owner.db.select().from(schema.importAttemptItem).where(eq(schema.importAttemptItem.attemptId,done.attemptId!))).toHaveLength(1);
  await processBankImportJob(ctx,id);expect((await getBankImportJob(ctx,id)).job.saved).toBe(1);
  expect((await createBankImportJob(ctx,{name:'again.csv',bytes:content(['BANK001,TNEW']).length,hash:createHash('sha256').update(content(['BANK001,TNEW'])).digest('hex')})).existing).toBe(false);
 });
 it('rolls back the domain change and audit item together if a row transaction crashes, then resumes once',async()=>{
  const e=await employee(),id=await admit(content(['BANK001,TRECOVER']));await ready(id);await bankImportCommand(ctx,id,'confirm');await processBankImportJob(ctx,id);
  const job=(await getBankImportJob(ctx,id)).job;
  const [row]=await owner.client`select * from bank_import_row where job_id=${id}::uuid`;
  await expect(withTenant(ctx,async tx=>{
   await applyBankImportRowTx(tx,ctx,{record:row.record,binding:row.binding,employmentId:row.employment_id,companyId:row.company_id,attemptId:job.attemptId!,ordinal:1});throw Error('worker crash');
  })).rejects.toThrow('worker crash');
  expect((await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId,e.personId)))[0].taxNumber).not.toBe('TRECOVER');
  expect(await owner.db.select().from(schema.importAttemptItem).where(eq(schema.importAttemptItem.attemptId,job.attemptId!))).toHaveLength(0);
  expect((await getBankImportJob(ctx,id)).job.processed).toBe(0);
  await processBankImportJob(ctx,id);expect((await getBankImportJob(ctx,id)).job).toMatchObject({saved:1,processed:1,state:'completed'});
 });
 it('detects duplicate employee IDs across separate batches and paginates previews',async()=>{
  await employee();const id=await admit(content([...Array.from({length:101},(_,i)=>`${i===0?'BANK001':'UNKNOWN'+i},T${i}`),'BANK001,TNEW']));
  const job=await ready(id);expect(job).toMatchObject({total:102,validated:102,valid:1,invalid:101});
  const first=await getBankImportJob(ctx,id),second=await getBankImportJob(ctx,id,1);
  expect(first.rows).toHaveLength(100);expect(second.rows).toHaveLength(2);expect(second.rows[1].preview?.errors).toEqual(expect.arrayContaining([expect.stringContaining('Duplicate Employee ID')]));
 });
 it('refuses changed data at commit and counts the failure without overwriting the concurrent edit',async()=>{
  const e=await employee(),id=await admit(Buffer.from('employee_code,bank_name,bank_account_no\nBANK001,Maybank,000123'));
  await ready(id);await owner.db.update(schema.employeeStatutoryMy).set({enableCustomHolderName:true,customHolderName:'CONCURRENT'}).where(eq(schema.employeeStatutoryMy.personId,e.personId));
  await bankImportCommand(ctx,id,'confirm');await processBankImportJob(ctx,id);await processBankImportJob(ctx,id);
  expect((await getBankImportJob(ctx,id)).job).toMatchObject({state:'completed',saved:0,failed:1});
  expect((await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId,e.personId)))[0].customHolderName).toBe('CONCURRENT');
 });
 it('the actual runner rejects a revoked submitting principal and releases its coordination lock',async()=>{
  await employee();const id=await admit(content(['BANK001,TREVOKED']));await ready(id);await bankImportCommand(ctx,id,'confirm');
  await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,ctx.userId!));
  expect(await runBankImportTick(owner.client)).toBe(true);
  const [job]=await owner.client`select state,saved from bank_import_job where id=${id}::uuid`;expect(job).toMatchObject({state:'failed',saved:0});
  const [lock]=await owner.client`select pg_try_advisory_lock(hashtextextended('bank-import-worker',0)) as ok`;expect(lock.ok).toBe(true);await owner.client`select pg_advisory_unlock(hashtextextended('bank-import-worker',0))`;
 });
 it('stages and validates 100,001 distinct employees, with real updates at the first, middle and last row',async()=>{
  const startedAt=Date.now(),checkpoint=(stage:string)=>console.info('[bank-import-capacity]',stage,`${Date.now()-startedAt}ms`);
  const exemplar=await employee();
  // Disposable fixture rows only: use the real canonical statutory setup as the template.
  await owner.client.begin(async fixture=>{
  // Fixture construction only: avoid replaying unrelated employment-insert workflows 100,001 times.
  // The setting is transaction-local; all validation and canonical writes below use normal triggers.
  await fixture`set local session_replication_role='replica'`;
  await fixture`with people as (
   insert into person(tenant_id,full_name,primary_email)
   select ${b.tenantId}::uuid,'Large Import '||n,'large'||n||'@example.test' from generate_series(1,100001) n returning id,full_name
  ) insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
   select ${b.tenantId}::uuid,id,${b.companyId}::uuid,'SCALE'||substring(full_name from 14),'2026-01-05'::date from people`;
  await fixture`insert into employee_statutory_my
   select replacement.* from employment e
   cross join lateral jsonb_populate_record(null::employee_statutory_my,
    (select to_jsonb(s) from employee_statutory_my s where s.person_id=${exemplar.personId}::uuid)
    ||jsonb_build_object('id',gen_random_uuid(),'person_id',e.person_id,'ic_number',null,'tax_number','TBASE')) replacement
   where e.tenant_id=${b.tenantId}::uuid and e.employee_code like 'SCALE%'`;
  });
  await owner.client`analyze person`;await owner.client`analyze employment`;await owner.client`analyze employee_statutory_my`;
  checkpoint('100001 employee fixture ready');
  const indexes=new Set([1,50001,100001]);
  const csv=content(Array.from({length:100001},(_,i)=>`SCALE${i+1},${indexes.has(i+1)?'TCHANGED':'TBASE'}`));
  const id=await admit(csv);await processBankImportJob(ctx,id);
  checkpoint('100001 source rows staged');
  const staged=await getBankImportJob(ctx,id);expect(staged.job).toMatchObject({state:'validating',total:100001});
  expect(staged.rows).toHaveLength(100);
  for(let batch=0;batch<1002;batch++){await processBankImportJob(ctx,id);if(batch%100===99)checkpoint(`${(batch+1)*100} rows validated`);}
  expect((await getBankImportJob(ctx,id)).job).toMatchObject({state:'ready',validated:100001,valid:3,invalid:0,unchanged:99998});
  await bankImportCommand(ctx,id,'confirm');await processBankImportJob(ctx,id);await processBankImportJob(ctx,id);
  checkpoint('canonical first/middle/last writes complete');
  const done=(await getBankImportJob(ctx,id)).job;expect(done).toMatchObject({state:'completed',total:100001,processed:100001,saved:3,failed:0});
  const changed=await owner.client`select e.employee_code from employee_statutory_my s join employment e on e.person_id=s.person_id where e.tenant_id=${b.tenantId}::uuid and s.tax_number='TCHANGED' order by e.employee_code`;
  expect(changed.map(row=>row.employee_code)).toEqual(['SCALE1','SCALE100001','SCALE50001']);
  expect(await owner.db.select().from(schema.importAttemptItem).where(eq(schema.importAttemptItem.attemptId,done.attemptId!))).toHaveLength(3);
 },600000);
 it('cancels a preview without changing HR data and releases the active-file reservation',async()=>{
  await employee();const bytes=content(['BANK001,TCANCEL']),id=await admit(bytes);await ready(id);await bankImportCommand(ctx,id,'cancel');
  expect((await getBankImportJob(ctx,id)).job.state).toBe('cancelled');expect((await createBankImportJob(ctx,{name:'bank.csv',bytes:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')})).existing).toBe(false);
 });
});
