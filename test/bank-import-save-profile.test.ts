/** GHA-only fictional scale diagnosis; timings are observations, never a throughput acceptance. */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {client,withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {commitEmployeeImport} from '../core/import';
import {createBankImportJob,uploadBankImportChunk,bankImportCommand,getBankImportJob} from '../core/bank-import-job';
import {processBankImportJob} from '../core/bank-import-worker';
import {applyBankImportRowTx} from '../core/import-sections';
import {parseCsvRecords} from '../lib/csv';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const ROWS=100001,sha=(text:string)=>createHash('sha256').update(text).digest('hex');
let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);});afterAll(closeAll);
type Span={sql:string;parameters:unknown[];interStatementMs:number};
type Observation={mode:'on'|'off';elapsedMs:number;spans:Span[]};
const compactSql=(text:string)=>text.replace(/\s+/g,' ').trim();
function safePlan(value:Record<string,unknown>,budget={nodes:80}):Record<string,unknown>{
 if(budget.nodes--<=0)return {truncated:true};
 const keys=['Node Type','Relation Name','Index Name','Subplan Name','Join Type','Actual Startup Time','Actual Total Time','Actual Rows','Actual Loops','Rows Removed by Filter','Shared Hit Blocks','Shared Read Blocks'];
 const out=Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));
 if(Array.isArray(value.Plans))out.Plans=value.Plans.map(child=>safePlan(child,budget));
 return out;
}
describe('native Bank save cost in a fictional 100001 employee catalog',()=>{
 it('measures identical rollback-only writes and read plans with transaction-local JIT on and off',async()=>{
  expect(process.env.GITHUB_ACTIONS,'Diagnostic runs in disposable GitHub Actions only').toBe('true');
  const records=parseCsvRecords('full_name,email,department,hired_on,ic_number,basic_salary,employee_code\nProfile Exemplar,profile@example.test,Finance,2026-01-05,900101105555,5000,PROFILE-EXEMPLAR').records;
  expect((await commitEmployeeImport(ctx,{companyId:b.companyId,records})).imported).toBe(1);
  const [exemplar]=await owner.db.select().from(schema.employment).where(eq(schema.employment.employeeCode,'PROFILE-EXEMPLAR'));
  await owner.client.begin(async tx=>{
   // Disposable fixture setup only; measured transactions keep every normal trigger and RLS rule.
   await tx`set local session_replication_role='replica'`;
   await tx`with people as (insert into person(tenant_id,full_name,primary_email)
    select ${b.tenantId}::uuid,'Profile '||n,'profile-'||n||'@example.test' from generate_series(1,${ROWS}) n returning id,full_name)
    insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
    select ${b.tenantId}::uuid,id,${b.companyId}::uuid,'PROF'||substring(full_name from 9),'2026-01-05'::date from people`;
   await tx`insert into employee_statutory_my select replacement.* from employment e
    cross join lateral jsonb_populate_record(null::employee_statutory_my,
     (select to_jsonb(s) from employee_statutory_my s where s.person_id=${exemplar.personId}::uuid)
     ||jsonb_build_object('id',gen_random_uuid(),'person_id',e.person_id,'ic_number',null,'tax_number','TBASE')) replacement
    where e.tenant_id=${b.tenantId}::uuid and e.employee_code ~ '^PROF[0-9]+$'`;
  });
  for(const table of ['person','employment','employee_statutory_my'])await owner.client.unsafe(`analyze "${table}"`);
  const bytes=Buffer.from('employee_code,tax_number\nPROF1,TPROFILE'),hash=createHash('sha256').update(bytes).digest('hex');
  const id=(await createBankImportJob(ctx,{name:'profile.csv',bytes:bytes.length,hash})).job.id;
  await uploadBankImportChunk(ctx,id,0,bytes);await bankImportCommand(ctx,id,'validate');
  for(let i=0;i<4;i++)await processBankImportJob(ctx,id);
  expect((await getBankImportJob(ctx,id)).job).toMatchObject({state:'ready',valid:1,total:1});
  await bankImportCommand(ctx,id,'confirm');await processBankImportJob(ctx,id);
  const job=(await getBankImportJob(ctx,id)).job;
  const [row]=await owner.client`select * from bank_import_row where job_id=${id}::uuid and ordinal=1`;
  expect(job.attemptId).toBeTruthy();expect(row.state).toBe('valid');
  const [environment]=await withTenant(ctx,tx=>tx.execute<{jit:string;available:boolean;super:boolean;bypass:boolean}>(sql`select current_setting('jit') as jit,pg_jit_available() as available,r.rolsuper as super,r.rolbypassrls as bypass from pg_roles r where r.rolname=current_user`));
  expect(environment.super).toBe(false);expect(environment.bypass).toBe(false);
  console.info('[bank-save-profile]',JSON.stringify({kind:'DISPOSABLE_SCALE_DIAGNOSTIC_NOT_THROUGHPUT',catalogRows:ROWS,environment}));
  const unchanged=async()=>{
   const [value]=await owner.client`select s.tax_number from employee_statutory_my s where s.person_id=(select person_id from employment where id=${row.employment_id}::uuid)`;
   expect(value.tax_number).toBe('TBASE');
   const [audit]=await owner.client`select count(*)::int as rows from import_attempt_item where attempt_id=${job.attemptId}::uuid`;expect(audit.rows).toBe(0);
   expect((await getBankImportJob(ctx,id)).job).toMatchObject({processed:0,saved:0,failed:0,state:'importing'});
  };
  const observations:Observation[]=[],debugClient=client as unknown as {options:{debug?:unknown}};
  for(const mode of ['on','off','on','off'] as const){
   const rollback=Error('intentional profile rollback');
   const spans:Span[]=[];let elapsedMs=0;
   await expect(withTenant(ctx,async tx=>{
    await tx.execute(sql`select set_config('jit',${mode},true)`);
    const [setting]=await tx.execute<{mode:string}>(sql`select current_setting('jit') as mode`);expect(setting.mode).toBe(mode);
    const previous=debugClient.options.debug;let pending:{sql:string;parameters:unknown[];started:number}|null=null;
    const finish=()=>{if(pending)spans.push({sql:pending.sql,parameters:pending.parameters,interStatementMs:performance.now()-pending.started});};
    debugClient.options.debug=(_connection:number,text:string,parameters:unknown[])=>{finish();pending={sql:text,parameters:[...parameters],started:performance.now()};};
    const started=performance.now();
    try{expect(await applyBankImportRowTx(tx,ctx,{record:row.record,binding:row.binding,employmentId:row.employment_id,companyId:row.company_id,attemptId:job.attemptId!,ordinal:1})).toBe(true);}
    finally{elapsedMs=performance.now()-started;finish();debugClient.options.debug=previous;}
    throw rollback;
   })).rejects.toBe(rollback);
   await unchanged();observations.push({mode,elapsedMs,spans});
   console.info('[bank-save-profile]',JSON.stringify({mode,elapsedMs,statementCount:spans.length,interStatementTimingIncludesClientWork:true,slowest:spans.slice().sort((a,b)=>b.interStatementMs-a.interStatementMs).slice(0,10).map(span=>({sqlHash:sha(span.sql),shape:compactSql(span.sql).slice(0,320),interStatementMs:span.interStatementMs}))}));
  }
  // Explain the three slowest distinct ordinary table reads as the SAME app principal and tenant.
  // Parameters remain bound; no literal values or predicates appear in the printed plan summary.
  const seen=new Set<string>(),reads=observations[0].spans.slice().sort((a,b)=>b.interStatementMs-a.interStatementMs).filter(span=>{
   const key=sha(span.sql),read=/^\s*select\b/i.test(span.sql)&&/\bfrom\s+"(?:employee_statutory_my|person|employment)"/i.test(span.sql);
   if(!read||seen.has(key))return false;seen.add(key);return true;
  }).slice(0,3);
  expect(reads.length).toBeGreaterThan(0);
  for(const read of reads)for(const mode of ['on','off'] as const){
   await withTenant(ctx,async tx=>{
    await tx.execute(sql`select set_config('jit',${mode},true)`);
    const pieces=read.sql.split(/(\$[1-9][0-9]*)/g).map(part=>{
     if(!/^\$[1-9][0-9]*$/.test(part))return sql.raw(part);
     const index=Number(part.slice(1))-1;expect(index).toBeLessThan(read.parameters.length);return sql`${read.parameters[index]}`;
    });
    const explained=await tx.execute<Record<string,unknown>>(sql`explain (analyze,buffers,format json) ${sql.join(pieces,sql``)}`);
    const raw=explained[0]['QUERY PLAN'],documents=typeof raw==='string'?JSON.parse(raw):raw;
    const plan=(documents as Record<string,unknown>[])[0];
    console.info('[bank-save-plan]',JSON.stringify({mode,sqlHash:sha(read.sql),shape:compactSql(read.sql).slice(0,200),planningMs:plan['Planning Time'],executionMs:plan['Execution Time'],jit:plan.JIT??null,plan:safePlan(plan.Plan as Record<string,unknown>)}));
   });
   await unchanged();
  }
  const [after]=await withTenant(ctx,tx=>tx.execute<{jit:string}>(sql`select current_setting('jit') as jit`));expect(after.jit).toBe(environment.jit);
  console.info('[bank-save-profile-summary]',JSON.stringify({catalogRows:ROWS,nativeSaved:0,intentionalRollbacks:observations.length,jitRestored:true,measurements:observations.map(({mode,elapsedMs,spans})=>({mode,elapsedMs,statements:spans.length})),releaseAuthorized:false}));
 },900000);
});
