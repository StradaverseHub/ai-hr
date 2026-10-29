/** Disposable policy experiment only. No product SQL, allocation, live hint or throughput acceptance. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {commitEmployeeImport} from '../core/import';
import {createBankImportJob,uploadBankImportChunk,bankImportCommand,getBankImportJob} from '../core/bank-import-job';
import {processBankImportJob} from '../core/bank-import-worker';
import {applyBankImportRowTx} from '../core/import-sections';
import {agentContext,ensureAgentPrincipal} from '../core/agent-principal';
import {parseCsvRecords} from '../lib/csv';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase} from './harness';
import * as org from './r395-org';

const ROWS=100001,HINT='app.bank_import_point_read';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ids=(rows:Record<string,unknown>[])=>rows.map(row=>String(row.id));
type Variant='original'|'global-case'|'hint-case';
type Policy={policyname:string;permissive:string;roles:string[];cmd:string;qual:string;with_check:string|null};
async function policies(){return [...await owner.client<Policy[]>`select policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename='employment' order by policyname`];}
async function originalFunction(){return (await owner.client`select pg_get_functiondef('app.visible_employment_ids()'::regprocedure) as definition`)[0].definition as string;}
function candidate(original:Policy,variant:Variant){
 if(variant==='original')return original.qual;
 const fast=`CASE WHEN app.is_admin_for(company_id) THEN true ELSE (${original.qual}) END`;
 const path=variant==='global-case'?fast:`CASE WHEN (SELECT current_setting('${HINT}',true))='on' THEN ${fast} ELSE (${original.qual}) END`;
 return `((voided_at IS NULL) AND (tenant_id=app.current_tenant_id()) AND (${path}))`;
}
async function install(original:Policy,baseline:Policy[],variant:Variant){
 await owner.client.unsafe(`ALTER POLICY employment_rls ON public.employment USING (${candidate(original,variant)})`);
 const actual=await policies();expect(actual.map(row=>row.policyname)).toEqual(baseline.map(row=>row.policyname));
 for(const row of actual){const before=baseline.find(p=>p.policyname===row.policyname)!;
  expect(row.policyname==='employment_rls'?{...row,qual:before.qual}:row).toEqual(before);
 }
}
async function restore(original:Policy,baseline:Policy[],definition:string){
 await install(original,baseline,'original');expect(await policies()).toEqual(baseline);expect(await originalFunction()).toBe(definition);
}
beforeAll(migrateTestDb);afterAll(closeAll);
describe('same-visibility Bank point-read policy experiment',()=>{
 it('preserves all principals, forged hints, tenants, void and named-agent behavior',async()=>{
  expect(process.env.GITHUB_ACTIONS).toBe('true');await org.setupOrg();
  const [voidedPerson]=await owner.client`insert into person(tenant_id,full_name,primary_email) values(${org.b.tenantId}::uuid,'Policy void fixture','policy-void@example.test') returning id`;
  let voidId='';await owner.client.begin(async tx=>{
   await tx`set local session_replication_role='replica'`;
   const [row]=await tx`insert into employment(tenant_id,person_id,company_id,hired_on,voided_at,voided_by,void_reason,voided_import_attempt_id)
    values(${org.b.tenantId}::uuid,${voidedPerson.id}::uuid,${org.C.A}::uuid,'2026-01-05',now(),${org.b.adminUserId}::uuid,'Fictional policy experiment',${randomUUID()}::uuid) returning id`;
   voidId=row.id;
  });
  const baseline=await policies(),original=baseline.find(p=>p.policyname==='employment_rls')!,definition=await originalFunction();
  expect(original.qual).toContain('voided_at IS NULL');expect(original.qual).toContain('app.current_tenant_id()');expect(original.qual).toContain('app.visible_employment_ids()');
  const principalId=await ensureAgentPrincipal(owner.db,org.b.tenantId);
  const agent=agentContext(org.b.tenantId,principalId,harnessSnapshot(org.b.tenantId));
  const foreign=agentContext(org.T2,principalId,harnessSnapshot(org.T2));
  const humanExpected=new Map<string,string[]>(),agentExpected=new Map<string,string[]>();
  const connection=await owner.client.reserve();
  const [initial]=await connection`select pg_backend_pid() as pid,nullif(current_setting(${HINT},true),'') as hint`;
  const humanRead=async(context:org.Ctx,hint:'off'|'on',subset=false)=>{
   await connection.unsafe('BEGIN');
   try{
    await connection`select set_config('app.tenant_id',${context.tenantId},true),set_config('app.user_id',${context.userId},true),set_config('app.roles',${context.roles.join(',')},true),set_config('app.grants',${JSON.stringify(context.grants)},true),set_config('app.agent_principal_id','',true),set_config(${HINT},${hint},true)`;
    if(subset){
     const [outside]=await connection`select count(*)::int as rows from employment e where e.voided_at is null and e.tenant_id=app.current_tenant_id() and app.is_admin_for(e.company_id) and not(e.id=any((select app.visible_employment_ids())::uuid[]))`;
     expect(outside.rows,'Company-admin shortcut must be a subset of original visibility').toBe(0);
     if(context.roles.some(role=>role==='hr_admin'||role==='super_admin')){
      const [eligible]=await connection`select count(*)::int as rows from employment e where e.voided_at is null and e.tenant_id=app.current_tenant_id() and app.is_admin_for(e.company_id)`;
      expect(eligible.rows,'Administrator subset assertion must be nonvacuous').toBeGreaterThan(0);
     }
    }
    await connection.unsafe('SET LOCAL ROLE ai_hr_app');
    const [role]=await connection`select current_user as role,pg_backend_pid() as pid,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
    expect({...role}).toEqual({role:'ai_hr_app',pid:initial.pid,rolsuper:false,rolbypassrls:false});
    return ids([...await connection`select id from employment order by id`]);
   }finally{
    await connection.unsafe('ROLLBACK');
    const [after]=await connection`select pg_backend_pid() as pid,nullif(current_setting(${HINT},true),'') as hint`;
    expect({...after}).toEqual({...initial});
   }
  };
  const agentRead=async(context:SessionContext,hint:'off'|'on')=>withTenant(context,async tx=>{
   await tx.execute(sql`select set_config(${HINT},${hint},true)`);
   return (await tx.select({id:schema.employment.id}).from(schema.employment).orderBy(schema.employment.id)).map(row=>row.id);
  });
  let primary:unknown;
  try{
   for(const context of org.CONTEXTS){
    const value=await humanRead(context,'off',true);expect(value.includes(voidId),'Ordinary visibility must retain its void fence').toBe(false);
    humanExpected.set(context.name,value);expect(hash(await humanRead(context,'on'))).toBe(hash(value));
   }
   for(const [name,context]of [['agent',agent],['foreign-agent',foreign]] as const){
    const value=await agentRead(context,'off');agentExpected.set(name,value);
    expect(hash(await agentRead(context,'on'))).toBe(hash(value));
    if(name==='agent')expect(value.length).toBeGreaterThan(0);else expect(value).toHaveLength(0);
   }
   for(const variant of ['global-case','hint-case'] as const){
    await install(original,baseline,variant);
    for(const context of org.CONTEXTS)for(const hint of ['off','on'] as const){
     const actual=await humanRead(context,hint),expected=humanExpected.get(context.name)!;
     expect(actual.length===expected.length&&actual.every((id,i)=>id===expected[i]),'Exact human visibility must not change').toBe(true);
     console.info('[bank-policy-equivalence]',JSON.stringify({variant,hint,context:context.name,rows:actual.length,orderedIdSha256:hash(actual),exact:true,sameConnection:true,hintRestored:true}));
    }
    for(const [name,context]of [['agent',agent],['foreign-agent',foreign]] as const)for(const hint of ['off','on'] as const){
     const actual=await agentRead(context,hint),expected=agentExpected.get(name)!;
     expect(actual.length===expected.length&&actual.every((id,i)=>id===expected[i]),'Exact named-agent visibility must not change').toBe(true);
    }
   }
  }catch(error){primary=error;throw error;}finally{
   await connection.release();
   try{await restore(original,baseline,definition);}catch(error){if(primary)console.error('Policy restore failed after original error:',error);else throw error;}
  }
  console.info('[bank-policy-equivalence-summary]',JSON.stringify({contexts:org.CONTEXTS.length,variants:2,hintStates:2,namedAgentAndForeignAgent:true,ordinaryHumanVoidFence:true,namedAgentPreservesExactOriginalVoidBehavior:true,exactOriginalPolicyRestored:true,releaseAuthorized:false}));
 },900000);

 it('measures unchanged rollback native writes and broad reads on 100001 fictional subjects',async()=>{
  expect(process.env.GITHUB_ACTIONS).toBe('true');await resetDb();const base=await seedBase(),context=adminCtx(base);
  const records=parseCsvRecords('full_name,email,department,hired_on,ic_number,basic_salary,employee_code\nPolicy Exemplar,policy@example.test,Finance,2026-01-05,900101105555,5000,POLICY-EXEMPLAR').records;
  expect((await commitEmployeeImport(context,{companyId:base.companyId,records})).imported).toBe(1);
  const [exemplar]=await owner.db.select().from(schema.employment).where(eq(schema.employment.employeeCode,'POLICY-EXEMPLAR'));
  await owner.client.begin(async tx=>{
   await tx`set local session_replication_role='replica'`;
   await tx`with people as(insert into person(tenant_id,full_name,primary_email) select ${base.tenantId}::uuid,'Policy '||n,'policy-'||n||'@example.test' from generate_series(1,${ROWS}) n returning id,full_name)
    insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${base.tenantId}::uuid,id,${base.companyId}::uuid,'POL'||substring(full_name from 8),'2026-01-05'::date from people`;
   await tx`insert into employee_statutory_my select replacement.* from employment e cross join lateral jsonb_populate_record(null::employee_statutory_my,(select to_jsonb(s) from employee_statutory_my s where s.person_id=${exemplar.personId}::uuid)||jsonb_build_object('id',gen_random_uuid(),'person_id',e.person_id,'ic_number',null,'tax_number','TBASE')) replacement where e.tenant_id=${base.tenantId}::uuid and e.employee_code ~ '^POL[0-9]+$'`;
  });
  for(const table of ['person','employment','employee_statutory_my'])await owner.client.unsafe(`analyze "${table}"`);
  const people=await owner.client`select person_id,employee_code from employment where tenant_id=${base.tenantId}::uuid and employee_code in ('POL2','POL3') order by employee_code`;
  expect(people).toHaveLength(2);
  const selfUser=await createAppUser(base.tenantId,people[0].person_id,'employee'),managerUser=await createAppUser(base.tenantId,people[1].person_id,'manager');
  const self:SessionContext={...context,userId:selfUser,roles:['employee']},manager:SessionContext={...context,userId:managerUser,roles:['manager']};
  const bytes=Buffer.from('employee_code,tax_number\nPOL1,TPOLICY'),sourceHash=createHash('sha256').update(bytes).digest('hex');
  const id=(await createBankImportJob(context,{name:'policy.csv',bytes:bytes.length,hash:sourceHash})).job.id;
  await uploadBankImportChunk(context,id,0,bytes);await bankImportCommand(context,id,'validate');for(let i=0;i<4;i++)await processBankImportJob(context,id);
  expect((await getBankImportJob(context,id)).job).toMatchObject({state:'ready',valid:1});await bankImportCommand(context,id,'confirm');await processBankImportJob(context,id);
  const job=(await getBankImportJob(context,id)).job,[row]=await owner.client`select * from bank_import_row where job_id=${id}::uuid`;
  const baseline=await policies(),original=baseline.find(p=>p.policyname==='employment_rls')!,definition=await originalFunction();
  const result:{variant:Variant;kind:string;hint:string;context?:string;elapsedMs:number;rows?:number;timedOut?:boolean;idSha256?:string}[]=[];
  const unchanged=async()=>{
   const [subject]=await owner.client`select tax_number from employee_statutory_my where person_id=(select person_id from employment where id=${row.employment_id}::uuid)`;expect(subject.tax_number).toBe('TBASE');
   const [audit]=await owner.client`select count(*)::int as rows from import_attempt_item where attempt_id=${job.attemptId}::uuid`;expect(audit.rows).toBe(0);
   expect((await getBankImportJob(context,id)).job).toMatchObject({processed:0,saved:0,failed:0});
  };
  let primary:unknown;
  try{
   for(const variant of ['original','global-case','hint-case'] as const){
    await install(original,baseline,variant);
    for(const hint of ['off','on'] as const){
     // The original off/on pair quantifies whether the untrusted hint alone does anything.
     const rollback=Error('intentional candidate policy rollback');let elapsedMs=0;
     await expect(withTenant(context,async tx=>{
      await tx.execute(sql`select set_config(${HINT},${hint},true),set_config('statement_timeout','120s',true)`);
      const started=performance.now();expect(await applyBankImportRowTx(tx,context,{record:row.record,binding:row.binding,employmentId:row.employment_id,companyId:row.company_id,attemptId:job.attemptId!,ordinal:1})).toBe(true);
      elapsedMs=performance.now()-started;throw rollback;
     })).rejects.toBe(rollback);
     await unchanged();const observation={variant,kind:'native-rollback',hint,elapsedMs};result.push(observation);console.info('[bank-policy-cost]',JSON.stringify(observation));
    }
    for(const [name,actor]of [['hr-admin',context],['self-employee',self],['manager',manager]] as const)for(const hint of ['off','on'] as const){
     const started=performance.now();
     try{
      const visible=await withTenant(actor,async tx=>{
       await tx.execute(sql`select set_config(${HINT},${hint},true),set_config('statement_timeout','90s',true)`);
       return (await tx.select({id:schema.employment.id}).from(schema.employment).orderBy(schema.employment.id).limit(1000)).map(r=>r.id);
      });
      const observation={variant,kind:'broad-page-1000',hint,context:name,elapsedMs:performance.now()-started,rows:visible.length,idSha256:hash(visible)};result.push(observation);console.info('[bank-policy-cost]',JSON.stringify(observation));
     }catch(error){
      const code=(error as {cause?:{code?:string};code?:string}).cause?.code??(error as {code?:string}).code;expect(code).toBe('57014');
      const observation={variant,kind:'broad-page-1000',hint,context:name,elapsedMs:performance.now()-started,timedOut:true};result.push(observation);console.info('[bank-policy-cost]',JSON.stringify(observation));
     }
    }
   }
   for(const contextName of ['hr-admin','self-employee','manager']){
    const values=result.filter(r=>r.kind==='broad-page-1000'&&r.context===contextName&&!r.timedOut);
    expect(new Set(values.map(r=>r.idSha256)).size).toBeLessThanOrEqual(1);
   }
   const [after]=await withTenant(context,tx=>tx.execute<{hint:string|null}>(sql`select nullif(current_setting(${HINT},true),'') as hint`));expect(after.hint).toBeNull();
  }catch(error){primary=error;throw error;}finally{
   try{await restore(original,baseline,definition);}catch(error){if(primary)console.error('Policy restore failed after original error:',error);else throw error;}
  }
  console.info('[bank-policy-cost-summary]',JSON.stringify({catalogRows:ROWS,results:result,nativeSaved:0,originalPolicyRestored:true,hintRestored:true,releaseAuthorized:false}));
 },900000);
});
