/**
 * 5129 — payroll history reads at production size, with every reader's visible result unchanged.
 *
 * One fictional tenant holds every history shape the effective rule distinguishes: imported months, a correction that
 * supersedes two payslips, an ordinary closed run adopted and corrected by an import, a revert to "no snapshot", an
 * employment corrected to another company after its history was imported, an open stage of another session (a staged
 * correction and its new batch) and a released stage whose registry rows are not yet cleared. Rows are written as the
 * importer writes them (record, snapshot = payslip id, revision chain, stage registry); triggers are off only for the
 * insert, because this test is about readers.
 *
 *  - The set-wise effective owner answers as 5055's body did for every payslip and for ids that are not payslips, as an
 *    ordinary session, as the stage's own session and for another tenant.
 *  - The effective-batch view shows a global payroll administrator, a company-scoped administrator who is also an
 *    employee elsewhere, a self-service employee and the stage's own session exactly the totals and counts the
 *    per-payslip read (0602's invoker function under the reader's row security) showed them, to the numeric scale.
 *  - The view computes each history batch once and runs no payslip policy function per payslip (function-call counts).
 *  - app.can_admin_payroll_employment and app.information_payslip_documents answer as their predecessors did.
 */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import type postgres from 'postgres';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {adminCtx,closeAll,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Row=Record<string,unknown>;
const PERIODS=['2024-01','2024-02','2024-03'] as const;
const id=()=>randomUUID();
let b:Base;
const f={} as {
 companies:Record<'A'|'B'|'C',string>;cycles:Record<string,string>;emp:Record<string,string>;person:Record<string,string>;
 batch:Record<string,string>;slip:Record<string,string>;stage:string;released:string;foreignTenant:string;
 scopedUser:string;selfUser:string;
};
const statutory=(i:number,missingEis=false)=>({version:'2026.1',epfEmployee:500+i,epfEmployer:600+i,socsoEmployee:24.75,socsoEmployer:86.65,
 eisEmployee:9.9,...(missingEis?{}:{eisEmployer:9.9}),pcb:150.05+i,importedLines:[{code:'A010',name:'Meal allowance',amount:300}]});
const sha=(n:number)=>n.toString(16).padStart(64,'0');

async function seed(){
 b=await seedBase();await setModule(b.tenantId,'payroll','active');
 const T=b.tenantId;
 f.companies={A:b.companyId,B:id(),C:id()};f.cycles={};f.emp={};f.person={};f.batch={};f.slip={};
 f.stage=id();f.released=id();f.scopedUser=id();f.selfUser=id();
 const [foreign]=await owner.client<{id:string}[]>`insert into tenant(workos_org_id,name) values(${'org_'+id()},'Other Group') returning id`;f.foreignTenant=foreign.id;
 await owner.client.begin(async tx=>{
  await tx`set local session_replication_role = replica`;
  for(const c of ['B','C'] as const)await tx`insert into company(id,tenant_id,legal_name) values(${f.companies[c]},${T},${'Fictional '+c+' Sdn Bhd'})`;
  for(const c of ['A','B','C'] as const){
   f.cycles[c]=id();await tx`insert into payroll_cycle(id,tenant_id,company_id,name,run_type) values(${f.cycles[c]},${T},${f.companies[c]},'Monthly','regular')`;
   for(let n=1;n<=4;n++){
    const key=c+n;f.person[key]=id();f.emp[key]=id();
    await tx`insert into person(id,tenant_id,full_name,primary_email) values(${f.person[key]},${T},${'Fictional '+key},${key.toLowerCase()+'-'+f.person[key].slice(0,6)+'@fixture.test'})`;
    await tx`insert into employment(id,tenant_id,person_id,company_id,hired_on,employee_code) values(${f.emp[key]},${T},${f.person[key]},${f.companies[c]},'2020-01-01',${key+'-'+f.emp[key].slice(0,4)})`;
   }
  }
  // A company-A administrator who is also employee B1; a self-service employee C2.
  await tx`insert into app_user(id,tenant_id,workos_user_id,person_id) values(${f.scopedUser},${T},${'user_'+id()},${f.person.B1}),(${f.selfUser},${T},${'user_'+id()},${f.person.C2})`;
  await tx`insert into role_assignment(tenant_id,app_user_id,company_id,role) values(${T},${f.scopedUser},${f.companies.A},'hr_admin'),(${T},${f.selfUser},null,'employee')`;
  const attempt=async(key:string,companies:string[])=>{
   const content=Buffer.from('fictional history '+key);const hash=(await tx<{h:string}[]>`select encode(sha256(${content}),'hex') as h`)[0].h;
   const [row]=await tx<{id:string}[]>`insert into payroll_history_import_attempt(tenant_id,created_by,operation_key,source_name,mime_type,source_hash,source_content,company_ids,plan)
    values(${T},${b.adminUserId},${id()},${key+'.csv'},'text/csv',${hash},${content},${companies}::uuid[],${JSON.stringify({rows:[],sourceHash:hash})}::jsonb) returning id`;
   return row.id;
  };
  const period=async(c:string,p:string)=>{const pid=id();await tx`insert into pay_period(id,tenant_id,company_id,period,status) values(${pid},${T},${f.companies[c as 'A']},${p},'closed')`;return pid;};
  const periodIds:Record<string,string>={};
  for(const c of ['A','B','C'])for(const p of [...PERIODS,'2024-04'])periodIds[c+p]=await period(c,p);
  const batch=async(key:string,c:string,p:string,attemptId:string|null,seq:number,status='closed',count=0)=>{
   f.batch[key]=id();
   await tx`insert into payroll_batch(id,tenant_id,company_id,pay_period,batch_date,status,employee_count,totals,remarks,run_seq,run_type,pay_period_id,payroll_cycle_id,history_import_attempt_id,history_import_cycle_name,closed_at)
    values(${f.batch[key]},${T},${f.companies[c as 'A']},${p},'2026-10-01',${status},${count},${JSON.stringify(attemptId?{gross:1}:{gross:21600,net:17000})}::jsonb,${attemptId?'Imported payroll history':null},${seq},
     ${attemptId?'adjustment':'regular'},${periodIds[c+p]},${f.cycles[c]},${attemptId},${attemptId?'Monthly':null},now())`;
  };
  let money=0;
  const slip=async(key:string,batchKey:string,empKey:string,missingEis=false)=>{
   money+=1;const basic=4000+money*7,gross=basic+300.5;f.slip[key]=id();
   await tx`insert into payslip(id,tenant_id,batch_id,employment_id,basic_salary,allowance,gross_pay,statutory,other_deductions,total_deductions,net_pay,employer_cost)
    values(${f.slip[key]},${T},${f.batch[batchKey]},${f.emp[empKey]},${basic},300.50,${gross},${JSON.stringify(statutory(money,missingEis))}::jsonb,0,684.70,${gross-684.7},${gross+700})`;
  };
  const records:Record<string,string>={},revisions:Record<string,{id:string;ordinal:number}>={};
  const record=async(empKey:string,p:string)=>{
   const key=empKey+p;if(records[key])return records[key];records[key]=id();
   await tx`insert into payroll_history_import_record(id,tenant_id,company_id,employment_id,period,cycle_id) values(${records[key]},${T},${f.companies[empKey[0] as 'A']},${f.emp[empKey]},${p},${f.cycles[empKey[0]]})`;
   return records[key];
  };
  const revise=async(empKey:string,p:string,attemptId:string,snapshot:string|null,kind:string)=>{
   const rec=await record(empKey,p),prev=revisions[empKey+p],rid=id();
   if(snapshot)await tx`insert into payroll_history_import_snapshot(id,tenant_id,record_id,value_hash,"values") values(${snapshot},${T},${rec},${sha(Object.keys(revisions).length+1)},${JSON.stringify({fixture:true})}::jsonb) on conflict do nothing`;
   await tx`insert into payroll_history_import_revision(id,tenant_id,record_id,ordinal,attempt_id,snapshot_id,previous_revision_id,kind,cycle_name)
    values(${rid},${T},${rec},${(prev?.ordinal??0)+1},${attemptId},${snapshot},${prev?.id??null},${kind},'Monthly')`;
   revisions[empKey+p]={id:rid,ordinal:(prev?.ordinal??0)+1};
   return rid;
  };
  // Imported months: three companies x three months, four employees each.
  for(const c of ['A','B','C']){
   const a=await attempt('initial-'+c,[f.companies[c as 'A']]);
   for(const p of PERIODS){
    await batch(c+p,c,p,a,1);
    for(let n=1;n<=4;n++){await slip(c+n+p,c+p,c+n,c==='B'&&n===4);await revise(c+n,p,a,f.slip[c+n+p],'import');}
   }
  }
  // A correction of A1 and A2 in 2024-02 (a second batch); the first payslips are no longer effective.
  const correction=await attempt('correction-A',[f.companies.A]);await batch('A2024-02x','A','2024-02',correction,2);
  for(const n of [1,2]){await slip('A'+n+'2024-02x','A2024-02x','A'+n);await revise('A'+n,'2024-02',correction,f.slip['A'+n+'2024-02x'],'correction');}
  // An ordinary closed B run for 2024-04, adopted for B1 and B2 and corrected by an import.
  await batch('B2024-04','B','2024-04',null,1,'closed',4);
  for(let n=1;n<=4;n++)await slip('B'+n+'2024-04','B2024-04','B'+n);
  const adoption=await attempt('adoption-B',[f.companies.B]);await batch('B2024-04x','B','2024-04',adoption,2);
  for(const n of [1,2]){
   await revise('B'+n,'2024-04',adoption,f.slip['B'+n+'2024-04'],'adopted');
   await slip('B'+n+'2024-04x','B2024-04x','B'+n);await revise('B'+n,'2024-04',adoption,f.slip['B'+n+'2024-04x'],'correction');
  }
  // C4's 2024-03 import reverted to no snapshot.
  const revert=await attempt('revert-C',[f.companies.C]);await revise('C4','2024-03',revert,null,'revert');
  // Another session's open stage: a correction of C1 2024-01 in a new draft batch, every row registered.
  const staged=await attempt('staged-C',[f.companies.C]);await batch('C2024-01x','C','2024-01',staged,2,'draft');
  await slip('C12024-01x','C2024-01x','C1');const stagedRevision=await revise('C1','2024-01',staged,f.slip['C12024-01x'],'correction');
  await tx`insert into app.payroll_history_stage(stage_id,tenant_id,job_id,attempt_id,operation,state,created_by) values(${f.stage},${T},${id()},${staged},'confirm','staged',${b.adminUserId}),
   (${f.released},${T},${id()},${correction},'confirm','released',${b.adminUserId})`;
  await tx`insert into app.payroll_history_staged_row(stage_id,relation,row_id) values
   (${f.stage},'payroll_batch',${f.batch['C2024-01x']}),(${f.stage},'payslip',${f.slip['C12024-01x']}),
   (${f.stage},'payroll_history_import_snapshot',${f.slip['C12024-01x']}),(${f.stage},'payroll_history_import_revision',${stagedRevision}),
   (${f.released},'payslip',${f.slip['A12024-02x']}),(${f.released},'payroll_history_import_snapshot',${f.slip['A12024-02x']})`;
  // A3 was corrected to company C after its company-A history was imported.
  await tx`update employment set company_id=${f.companies.C} where id=${f.emp.A3}`;
  // Retained information documents (0698) for A1's and C2's payslips.
  await tx`insert into information_payslip_snapshot(payslip_id,tenant_id,employment_id,company_id,grade,employment_type,hired_on,join_date,document_metadata,recorded_by)
   select p.id,p.tenant_id,p.employment_id,bt.company_id,'G1','full_time','2020-01-01','2020-01-01',jsonb_build_object('employeeName','Fictional'),${b.adminUserId}::uuid
   from payslip p join payroll_batch bt on bt.id=p.batch_id where p.employment_id in (${f.emp.A1},${f.emp.C2})`;
 });
}

/** Owner-session work that leaves nothing behind (reference functions live in pg_temp, settings are local). */
class Rollback{constructor(readonly value:unknown){}}
async function rolledBack<T>(body:(tx:postgres.TransactionSql)=>Promise<T>):Promise<T>{
 try{await owner.client.begin(async tx=>{throw new Rollback(await body(tx));});}
 catch(error){if(error instanceof Rollback)return error.value as T;throw error;}
 throw new Error('the owner transaction did not run');
}
const admin=():SessionContext=>adminCtx(b);
const scoped=():SessionContext=>({...adminCtx(b),userId:f.scopedUser,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:f.companies.A}]});
const self=():SessionContext=>({...adminCtx(b),userId:f.selfUser,roles:['employee'],grants:[{role:'employee',companyId:null}]});
type Tx=Parameters<Parameters<typeof withTenant>[1]>[0];
const inStage=<T,>(ctx:SessionContext,body:(tx:Tx)=>Promise<T>)=>withTenant(ctx,async tx=>{
 await tx.execute(sql`select set_config('app.payroll_history_stage',${f.stage},true)`);return body(tx);
});
/** The view's rows, and the 0602/0660 projection computed per payslip under the same reader's row security. */
async function bothReads(tx:Tx){
 const view=await tx.execute<Row>(sql`select id,employee_count,totals::text as totals from payroll_history_effective_batch order by id`);
 const reference=await tx.execute<Row>(sql`select b.id,
  case when b.history_import_attempt_id is null and not app.payroll_history_batch_adopted(b.id) then b.employee_count else (app.payroll_history_batch_totals(b.id)->>'employeeCount')::integer end as employee_count,
  (case when b.history_import_attempt_id is null and not app.payroll_history_batch_adopted(b.id) then b.totals else app.payroll_history_batch_totals(b.id) end)::text as totals
  from payroll_batch b order by b.id`);
 return {view:[...view],reference:[...reference]};
}
const countOf=(rows:Row[],batchKey:string)=>rows.find(row=>row.id===f.batch[batchKey])?.employee_count;
const grossOf=(rows:Row[],batchKey:string)=>JSON.parse(String(rows.find(row=>row.id===f.batch[batchKey])?.totals)).gross;

beforeAll(async()=>{await resetDb();await seed();});
afterAll(closeAll);

describe('5129 payroll history effective reads',()=>{
 it('the set-wise effective owner answers as 5055 did for every id, session and stage',async()=>{
  const body=readFileSync('db/migrations/5055_payroll_history_staged_job.sql','utf8')
   .match(/CREATE OR REPLACE FUNCTION app\.payroll_history_effective\(subject uuid\)[\s\S]*?\n\$\$;/)![0]
   .replace('app.payroll_history_effective(subject uuid)','pg_temp.reference_effective_5055(subject uuid)');
  const sessions=[{tenant:b.tenantId,stage:''},{tenant:b.tenantId,stage:f.stage},{tenant:b.tenantId,stage:f.released},{tenant:f.foreignTenant,stage:''}];
  const results=await rolledBack(async tx=>{
   await tx.unsafe(body);
   const out:{tenant:string;stage:string;n:number;bad:number;effective:number}[]=[];
   for(const s of sessions){
    await tx`select set_config('app.tenant_id',${s.tenant},true),set_config('app.payroll_history_stage',${s.stage},true)`;
    const [row]=await tx<{n:number;bad:number;effective:number}[]>`select count(*)::int as n,
      count(*) filter (where app.payroll_history_effective(x.id) is distinct from pg_temp.reference_effective_5055(x.id))::int as bad,
      count(*) filter (where app.payroll_history_effective(x.id))::int as effective
     from (select id from payslip union all select gen_random_uuid() from generate_series(1,5) union all select null::uuid) x`;
    out.push({...s,...row});
   }
   await tx`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.payroll_history_stage',${f.stage},true)`;
   const [own]=await tx<{first:boolean;staged:boolean}[]>`select app.payroll_history_effective(${f.slip['C12024-01']}::uuid) as first,app.payroll_history_effective(${f.slip['C12024-01x']}::uuid) as staged`;
   await tx`select set_config('app.payroll_history_stage','',true)`;
   const [ordinary]=await tx<{first:boolean;staged:boolean}[]>`select app.payroll_history_effective(${f.slip['C12024-01']}::uuid) as first,app.payroll_history_effective(${f.slip['C12024-01x']}::uuid) as staged`;
   return {out,own,ordinary};
  });
  expect(results.out).toHaveLength(4);
  for(const row of results.out)expect(row.bad,JSON.stringify(row)).toBe(0);
  // Independent expectations: 45 payslips (36 imported, 2 corrections, 4 ordinary, 2 adoptions, 1 staged), 5 random ids, one null.
  expect(results.out[0].n).toBe(51);
  // Outside the stage C1's first payslip stays effective and the staged one is not; inside the stage it is the reverse.
  expect(results.ordinary).toEqual({first:true,staged:false});
  expect(results.own).toEqual({first:false,staged:true});
  // Another tenant's session treats none of these snapshots as its own: every id is effective there.
  expect(results.out[3].effective).toBe(51);
 });

 it('shows every reader exactly the per-payslip totals and counts, to the numeric scale',async()=>{
  const readers:[string,SessionContext][]=[['admin',admin()],['scoped',scoped()],['self',self()]];
  for(const [name,ctx] of readers){
   const {view,reference}=await withTenant(ctx,bothReads);
   expect(view.length,name).toBeGreaterThan(0);
   expect(view,name).toEqual(reference);
  }
  const stage=await inStage(admin(),bothReads);
  expect(stage.view).toEqual(stage.reference);
  // Independent expectations per reader.
  const a=(await withTenant(admin(),bothReads)).view,s=(await withTenant(scoped(),bothReads)).view,e=(await withTenant(self(),bothReads)).view;
  expect(countOf(a,'A2024-01')).toBe(4);
  expect(countOf(a,'A2024-02')).toBe(2);                 // A1, A2 superseded by the correction
  expect(countOf(a,'A2024-02x')).toBe(2);
  expect(countOf(a,'C2024-01')).toBe(4);                 // the staged correction is invisible outside its stage
  expect(countOf(a,'C2024-01x')).toBeUndefined();        // and so is its batch
  expect(countOf(a,'C2024-03')).toBe(3);                 // C4 reverted to no snapshot
  expect(countOf(a,'B2024-04')).toBe(2);                 // adopted ordinary run: B3, B4 remain
  expect(countOf(s,'A2024-01')).toBe(3);                 // A3 now belongs to company C, which this administrator does not run
  expect(countOf(s,'B2024-01')).toBe(1);                 // their own B1 payslip only
  const [own]=await owner.client<{gross:string}[]>`select gross_pay::text as gross from payslip where id=${f.slip['B12024-01']}`;
  expect(grossOf(s,'B2024-01')).toBe(Number(own.gross));
  expect(grossOf(a,'B2024-01')).toBeGreaterThan(Number(own.gross));
  expect(s.some(row=>row.id===f.batch['C2024-01'])).toBe(false);
  expect(e.map(row=>row.employee_count)).toEqual(e.map(()=>1));
  expect(e.length).toBe(3);                              // C2's three imported months
  expect(countOf(stage.view,'C2024-01')).toBe(3);
  expect(countOf(stage.view,'C2024-01x')).toBe(1);
 });

 it('computes each history batch once and runs no payslip policy function per payslip',async()=>{
  const calls=async(ctx:SessionContext,reader:'view'|'reference')=>rolledBack(async tx=>{
   await tx`set local track_functions = 'all'`;await tx`set local role ai_hr_app`;
   await tx`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId!},true),set_config('app.roles',${(ctx.roles??[]).join(',')},true),
    set_config('app.grants',${JSON.stringify(ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null})))},true),set_config('app.payroll_tax_basis_reader','1',true),set_config('jit','off',true)`;
   // Function counters are per backend and flushed lazily, so a reading is the difference across this statement.
   const counters=async()=>Object.fromEntries((await tx<{funcname:string;calls:number}[]>`select funcname::text,sum(calls)::int as calls from pg_stat_xact_user_functions
    where schemaname='app' and funcname in ('payroll_history_effective','payroll_history_batch_totals','payroll_history_batch_admin_totals','can_admin_payroll_employment','payroll_tax_basis_reader_compatible')
    group by funcname`).map(row=>[row.funcname,row.calls])) as Record<string,number>;
   const before=await counters();
   const rows=reader==='view'
    ?await tx`select id,employee_count,totals from payroll_history_effective_batch where employee_count>0`
    :await tx`select b.id,app.payroll_history_batch_totals(b.id) t,app.payroll_history_batch_totals(b.id) u from payroll_batch b where b.history_import_attempt_id is not null`;
   const after=await counters();
   const counted=Object.keys(after).map(funcname=>({funcname,calls:after[funcname]-(before[funcname]??0)})).filter(row=>row.calls>0);
   return {rows:rows.length,calls:Object.fromEntries(counted.map(row=>[row.funcname,row.calls]))};
  });
  // Visible history batches (the staged one is hidden) plus the adopted ordinary run, and their visible payslips.
  const visibleBatches=Number((await owner.client`select count(*)::int as n from payroll_batch where tenant_id=${b.tenantId}
   and (history_import_attempt_id is not null or id=${f.batch['B2024-04']}) and id<>${f.batch['C2024-01x']}`)[0].n);
  const visibleHistoryPayslips=Number((await owner.client`select count(*)::int as n from payslip p join payroll_batch bt on bt.id=p.batch_id
   where bt.tenant_id=${b.tenantId} and bt.history_import_attempt_id is not null and bt.id<>${f.batch['C2024-01x']}`)[0].n);
  expect([visibleBatches,visibleHistoryPayslips]).toEqual([12,40]);
  const payslips=Number((await owner.client`select count(*)::int as n from payslip where tenant_id=${b.tenantId}`)[0].n);
  const fast=await calls(admin(),'view');
  expect(fast.rows).toBeGreaterThan(0);
  // One aggregate per visible history or adopted batch (the staged batch is hidden), never the per-payslip function.
  expect(fast.calls.payroll_history_batch_admin_totals).toBe(visibleBatches);
  expect(fast.calls.payroll_history_batch_totals??0).toBe(0);
  // Payslip row security runs at most once per payslip per statement (payroll_batch's own policy may probe payslips
  // for the reader's employments), independent of how many batches are read.
  for(const fn of ['payroll_history_effective','can_admin_payroll_employment','payroll_tax_basis_reader_compatible'])
   expect(fast.calls[fn]??0,fn).toBeLessThanOrEqual(payslips);
  // What the per-payslip read cost: every visible history payslip's policy functions in both calls of each batch.
  const slow=await calls(admin(),'reference');
  expect(slow.calls.payroll_history_batch_totals).toBe(2*(visibleBatches-1));
  expect(slow.calls.payroll_history_effective).toBeGreaterThanOrEqual((fast.calls.payroll_history_effective??0)+2*visibleHistoryPayslips);
  expect(slow.calls.can_admin_payroll_employment).toBeGreaterThanOrEqual((fast.calls.can_admin_payroll_employment??0)+visibleHistoryPayslips);
  // An administrator who is also an employee adds only their own payslips' checks.
  const mixed=await calls(scoped(),'view');
  expect(mixed.calls.payroll_history_batch_totals??0).toBe(0);
  expect(mixed.calls.payroll_history_effective??0).toBeLessThanOrEqual(payslips+4);
 });

 it('keeps the payroll-administration test for one employment',async()=>{
  const body=readFileSync('db/migrations/2100_employment_helper_tenant_pin.sql','utf8')
   .match(/CREATE OR REPLACE FUNCTION app\.can_admin_payroll_employment\(emp_id uuid\)[\s\S]*?\n\$\$;/)![0]
   .replace('app.can_admin_payroll_employment(emp_id uuid)','pg_temp.reference_can_admin_payroll_employment(emp_id uuid)');
  const grants=[[{role:'hr_admin',companyId:null}],[{role:'hr_admin',companyId:f.companies.A}],[{role:'payroll_partner',companyId:f.companies.B}],
   [{role:'super_admin',companyId:null}],[{role:'employee',companyId:null}],[{role:'manager',companyId:f.companies.C}],[]];
  const results=await rolledBack(async tx=>{
   await tx.unsafe(body);const out:{bad:number;yes:number}[]=[];
   for(const [tenant,grant] of [...grants.map(g=>[b.tenantId,g] as const),[f.foreignTenant,grants[0]] as const]){
    await tx`select set_config('app.tenant_id',${tenant},true),set_config('app.grants',${JSON.stringify(grant)},true)`;
    const [row]=await tx<{bad:number;yes:number}[]>`select count(*) filter (where app.can_admin_payroll_employment(x.id) is distinct from pg_temp.reference_can_admin_payroll_employment(x.id))::int as bad,
      count(*) filter (where app.can_admin_payroll_employment(x.id))::int as yes
     from (select id from employment union all select gen_random_uuid() union all select null::uuid) x`;
    out.push(row);
   }
   return out;
  });
  for(const row of results)expect(row.bad).toBe(0);
  expect(results.map(row=>row.yes).slice(0,2)).toEqual([12,3]);  // all twelve; company A without the moved A3
  expect(results.at(-1)!.yes).toBe(0);                           // another tenant's session administers none of them
 });

 it('returns the same retained documents, in the same order',async()=>{
  const body=readFileSync('db/migrations/0698_information_only_corrections.sql','utf8')
   .match(/CREATE FUNCTION app\.information_payslip_documents\([\s\S]*?\n\$\$;/)![0]
   .replace('CREATE FUNCTION app.information_payslip_documents(','CREATE FUNCTION pg_temp.reference_documents_0698(');
  const ctx=admin();
  const [now,before]=await rolledBack(async tx=>{
   await tx.unsafe(body);
   await tx`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId!},true),set_config('app.roles','hr_admin',true),set_config('app.grants',${JSON.stringify([{role:'hr_admin',companyId:null}])},true)`;
   const companies=Object.values(f.companies);
   const read=async(fn:string,args:[number|null,number|null,string|null,string|null])=>(await tx.unsafe(
    `select string_agg(d.doc::text,'|' order by d.ord) as docs,count(*)::int as n from ${fn}($1::uuid[],$2::integer,$3::integer,$4::text,$5::uuid,true) with ordinality as d(doc,ord)`,[companies,...args] as never[]))[0] as {docs:string|null;n:number};
   const cases:[number|null,number|null,string|null,string|null][]=[[null,null,null,null],[2024,2,null,null],[null,null,'regular',null],[null,null,null,f.emp.A1]];
   const a:{docs:string|null;n:number}[]=[],c:{docs:string|null;n:number}[]=[];for(const args of cases){a.push(await read('app.information_payslip_documents',args));c.push(await read('pg_temp.reference_documents_0698',args));}
   return [a,c] as const;
  });
  expect(now).toEqual(before);
  expect(now[0].n).toBeGreaterThan(0);
 });
});
