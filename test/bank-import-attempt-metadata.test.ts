/** Real PostgreSQL column privileges prove that Bank row saves never fetch the source payload. */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {eq,getTableColumns,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import * as history from '../core/import-history';
import {commitEmployeeImport} from '../core/import';
import {createBankImportJob,uploadBankImportChunk,bankImportCommand,getBankImportJob} from '../core/bank-import-job';
import {processBankImportJob} from '../core/bank-import-worker';
import {parseCsvRecords} from '../lib/csv';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

// On the before-change commit this deliberately exercises the old full-payload lock, giving a
// real permission failure rather than a missing-export failure. The repaired source exports headerLock.
type HeaderLock=(...args:Parameters<typeof history.lockImportAttemptTx>)=>Promise<{id:string;kind:string}>;
const headerLock=(history as typeof history&{lockImportAttemptHeaderTx?:HeaderLock}).lockImportAttemptHeaderTx??history.lockImportAttemptTx;
let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);});afterAll(closeAll);
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function attempt(content=Buffer.from('fictional source')){
 const plan=history.sealImportPlan({version:1 as const,previewHash:'',counts:{total:1,valid:1,invalid:0},issues:[]});
 return (await withTenant(ctx,tx=>history.createImportAttemptTx(tx,ctx,{kind:'bank_statutory',sourceName:'fictional.csv',content,companyIds:[b.companyId],plan}))).attemptId;
}
async function withoutSourceSelect<T>(fn:()=>Promise<T>){
 const columns=Object.values(getTableColumns(schema.importAttempt)).filter(column=>column.name!=='source_content').map(column=>sql.identifier(column.name));
 try{
  // Privileges belong to this worker's disposable database tables; tests in this file are sequential.
  await owner.db.execute(sql`revoke select on public.import_attempt from ai_hr_app`);
  await owner.db.execute(sql`grant select (${sql.join(columns,sql`,`)}) on public.import_attempt to ai_hr_app`);
  const [proof]=await withTenant(ctx,tx=>tx.execute(sql`select has_column_privilege(current_user,'public.import_attempt','source_content','SELECT') as source,has_column_privilege(current_user,'public.import_attempt','id','SELECT') as header`));
  expect(proof).toMatchObject({source:false,header:true});
  return await fn();
 }finally{
  try{await owner.db.execute(sql`revoke select (${sql.join(columns,sql`,`)}) on public.import_attempt from ai_hr_app`);}
  finally{await owner.db.execute(sql`grant select on public.import_attempt to ai_hr_app`);}
 }
}
describe('bounded Bank import attempt locks',()=>{
 it('locks a large-source attempt using only identity and kind; full-source readers retain exact bytes',async()=>{
  const source=Buffer.from('fictional large source\n'.repeat(100000)),id=await attempt(source);
  await withoutSourceSelect(async()=>{
   const row=await withTenant(ctx,tx=>headerLock(tx,ctx,id,'bank_statutory'));
   expect(row).toEqual({id,kind:'bank_statutory'});
  });
  const full=await withTenant(ctx,tx=>history.lockImportAttemptTx(tx,ctx,id,'bank_statutory'));
  expect(full.sourceContent.length).toBe(source.length);expect(hash(full.sourceContent)).toBe(hash(source));
 });
 it('saves through the native Bank writer with audit and checkpoint while source_content SELECT is forbidden',async()=>{
  const records=parseCsvRecords('full_name,email,department,hired_on,ic_number,basic_salary,employee_code\nMetadata Fixture,metadata@example.test,Finance,2026-01-05,900101105555,5000,META001').records;
  expect((await commitEmployeeImport(ctx,{companyId:b.companyId,records})).imported).toBe(1);
  const bytes=Buffer.from('employee_code,tax_number\nMETA001,TMETADATA'),admitted=await createBankImportJob(ctx,{name:'metadata.csv',bytes:bytes.length,hash:hash(bytes)}),id=admitted.job.id;
  await uploadBankImportChunk(ctx,id,0,bytes);await bankImportCommand(ctx,id,'validate');
  for(let i=0;i<4;i++)await processBankImportJob(ctx,id);
  expect((await getBankImportJob(ctx,id)).job).toMatchObject({state:'ready',valid:1});
  await bankImportCommand(ctx,id,'confirm');await processBankImportJob(ctx,id);
  await withoutSourceSelect(async()=>{
   await processBankImportJob(ctx,id);
   const {job}=await getBankImportJob(ctx,id);expect(job).toMatchObject({state:'completed',processed:1,saved:1,failed:0});
   const [audit]=await owner.client`select count(*)::int as rows from import_attempt_item where attempt_id=${job.attemptId}::uuid and status='applied' and ordinal=1`;
   expect(audit.rows).toBe(1);
   const [stored]=await owner.client`select s.tax_number from employment e join employee_statutory_my s on s.person_id=e.person_id where e.tenant_id=${b.tenantId}::uuid and e.employee_code='META001'`;
   expect(stored.tax_number).toBe('TMETADATA');
  });
 });
 it('retains the same principal, kind and tenant access checks',async()=>{
  const id=await attempt(),other=adminCtx(await seedBase());
  await expect(withTenant(other,tx=>headerLock(tx,other,id,'bank_statutory'))).rejects.toThrow('unavailable');
  await expect(withTenant(ctx,tx=>headerLock(tx,ctx,id,'cost_allocations'))).rejects.toThrow('unavailable');
  await expect(withTenant(ctx,tx=>headerLock(tx,ctx,'invalid','bank_statutory'))).rejects.toThrow('unavailable');
  await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,ctx.userId!));
  await expect(withTenant(ctx,tx=>headerLock(tx,ctx,id,'bank_statutory'))).rejects.toThrow('Access changed');
 });
 it('still serializes another real writer through the same FOR UPDATE row lock',async()=>{
  const id=await attempt();let signal!:()=>void,release!:()=>void;
  const acquired=new Promise<void>(resolve=>{signal=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const first=withTenant(ctx,async tx=>{await headerLock(tx,ctx,id,'bank_statutory');signal();await gate;});
  void first.catch(()=>signal());
  try{
   await acquired;
   await expect(withTenant(ctx,async tx=>{await tx.execute(sql`set local lock_timeout='150ms'`);return headerLock(tx,ctx,id,'bank_statutory');})).rejects.toMatchObject({cause:{code:'55P03'}});
  }finally{release();await first;}
 });
});
