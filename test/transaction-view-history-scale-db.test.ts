/**
 * Transaction View's History landing reads at the shape of a real group (SCALE rules 2 and 3), 24 November 2026.
 *
 * Staging measured the History tab at 19 to 28 s on a loaded box and about 2.5 s of its own database time on a quiet
 * one. Four statements carried it, each costing row security on every payslip or retained document in scope:
 *  - the latest period (live): every visible payslip ordered by period to keep one;
 *  - the latest period (retained): every retained document built to keep one;
 *  - the period's list (live): reached payslips through their employment, so the policies ran on every payslip;
 *  - the period's list (retained): app.information_payslip_documents planned without its argument values.
 *
 * This file proves, on 70 companies and 1,000 employments with transferred employees and retained documents:
 *  - the new readers return the same period, rows, order and counts as the previous ones, for every role, under
 *    "All companies" and under one company;
 *  - the row policies run on the period's payslips (the list) and on a handful of payslips (the latest period), not on
 *    every payslip in scope, counted with pg_stat_xact_user_functions;
 *  - the 7200 document function returns exactly what the 5129 body returned, in the same order.
 * Fictional fixtures only. Counts are derived from the fixture constants, never from the readers.
 */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {and,asc,desc,eq,inArray,like,sql} from 'drizzle-orm';
import type postgres from 'postgres';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {adminCtx,closeAll,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {company,employment,payrollBatch,payslip,person} from '../db/schema';
import {
 latestProcessedPayslipPeriod,latestProcessedPayslipPeriodTx,listProcessedPayslipsAcross,readProcessedPayslipsTx,
 type ProcessedPayslipFilters,
} from '../core/payroll-view';
import {informationDocumentRow,informationPayslipDocuments} from '../core/information-correction-history';

const COMPANIES=70,N=1000,PERIODS=['2026-08','2026-09','2026-10','2026-11'] as const,LATE='2026-12',CAP=201;
const bonusCompany=(k:number)=>k%7===0,bonusEmployee=(n:number)=>n%3===0,retainedVisible=(n:number)=>n%9===0;
/** Employment n works for company (n-1)%70. Company 0's employments with an even k (n = 1 + 70k) move to company 1
 * after they were paid, so company 0 keeps their history only as retained documents for its own administrators. */
const companyOf=(n:number)=>(n-1)%COMPANIES,moved=(n:number)=>companyOf(n)===0&&((n-1)/COMPANIES)%2===0;

let b:Base;
const f={companies:[] as string[],cycles:[] as string[],emp:[] as string[],users:{} as Record<'narrow'|'partner'|'self',string>,selfPerson:''};
beforeAll(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');
 const T=b.tenantId;
 await owner.client.begin(async tx=>{
  await tx`set local session_replication_role = replica`;
  const others=await tx<{id:string}[]>`insert into company(tenant_id,legal_name) select ${T}::uuid,'History shape company '||lpad(n::text,2,'0') from generate_series(1,${COMPANIES-1}::integer) n order by n returning id`;
  f.companies=[b.companyId,...others.map(row=>row.id)];
  await tx`insert into payroll_cycle(tenant_id,company_id,name,run_type) select ${T}::uuid,c,'Monthly','regular' from unnest(${f.companies}::uuid[]) c`;
  const cycleOf=new Map((await tx<{id:string;companyId:string}[]>`select id,company_id as "companyId" from payroll_cycle where tenant_id=${T}::uuid`).map(row=>[row.companyId,row.id]));
  f.cycles=f.companies.map(id=>cycleOf.get(id)!);
  await tx`with people as(insert into person(tenant_id,full_name,primary_email) select ${T}::uuid,'History shape person '||lpad(n::text,4,'0'),'history-shape-'||n||'@fixture.invalid' from generate_series(1,${N}::integer) n returning id,full_name)
   insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${T}::uuid,id,(${f.companies}::uuid[])[1+((right(full_name,4)::int-1)%${COMPANIES}::integer)],'TVH-'||right(full_name,4),'2025-01-01'::date from people`;
  f.emp=(await tx<{id:string}[]>`select id from employment where tenant_id=${T}::uuid and employee_code like 'TVH-%' order by employee_code`).map(row=>row.id);
  await tx`insert into pay_period(tenant_id,company_id,period,status) select ${T}::uuid,c,p,'closed' from unnest(${f.companies}::uuid[]) c cross join unnest(${[...PERIODS]}::text[]) p`;
  await tx`insert into pay_period(tenant_id,company_id,period,status) values(${T},${f.companies[0]},${LATE},'closed')`;
  // One regular run per company and period, on the company's Monthly cycle; a second (bonus) run in November for every
  // seventh company; and company 0's December run, which pays only the employees who later moved to company 1.
  await tx`insert into payroll_batch(tenant_id,company_id,pay_period_id,pay_period,batch_date,status,released_at,run_type,run_seq,payroll_cycle_id)
   select pp.tenant_id,pp.company_id,pp.id,pp.period,(pp.period||'-25')::date,'closed',now(),'regular',1,pc.id
   from pay_period pp join payroll_cycle pc on pc.company_id=pp.company_id where pp.tenant_id=${T}::uuid and pp.company_id=any(${f.companies}::uuid[])`;
  const bonusCompanies=f.companies.filter((_,k)=>bonusCompany(k));
  await tx`insert into payroll_batch(tenant_id,company_id,pay_period_id,pay_period,batch_date,status,released_at,run_type,run_seq)
   select pp.tenant_id,pp.company_id,pp.id,pp.period,(pp.period||'-28')::date,'closed',now(),'bonus',2
   from pay_period pp where pp.tenant_id=${T}::uuid and pp.period='2026-11' and pp.company_id=any(${bonusCompanies}::uuid[])`;
  await tx`insert into payslip(tenant_id,batch_id,employment_id,basic_salary,gross_pay,statutory,total_deductions,net_pay,employer_cost)
   select ${T}::uuid,pb.id,e.id,'3000.00','3000.00','{}'::jsonb,'0.00','3000.00','3000.00'
   from employment e join payroll_batch pb on pb.company_id=e.company_id and pb.tenant_id=e.tenant_id
   where e.tenant_id=${T}::uuid and e.employee_code like 'TVH-%' and (
    (pb.run_type='regular' and pb.pay_period<>${LATE})
    or (pb.run_type='bonus' and right(e.employee_code,4)::int%3=0)
    or (pb.pay_period=${LATE} and e.id=any(${f.emp.filter((_,i)=>moved(i+1))}::uuid[])))`;
  await tx`update employment set company_id=${f.companies[1]} where id=any(${f.emp.filter((_,i)=>moved(i+1))}::uuid[])`;
  // Retained documents (0698): every company-0 payslip of a moved employee, plus visible payslips of every ninth employee.
  const retainedEmployments=f.emp.filter((_,i)=>moved(i+1)||retainedVisible(i+1));
  await tx`insert into information_payslip_snapshot(payslip_id,tenant_id,employment_id,company_id,grade,employment_type,hired_on,join_date,document_metadata,recorded_by)
   select p.id,p.tenant_id,p.employment_id,pb.company_id,'G1','full_time','2025-01-01','2025-01-01',
    jsonb_build_object('employeeName',pe.full_name,'employeeCode',e.employee_code,'company','Retained','currency','MYR'),${b.adminUserId}::uuid
   from payslip p join payroll_batch pb on pb.id=p.batch_id join employment e on e.id=p.employment_id join person pe on pe.id=e.person_id
   where p.employment_id=any(${retainedEmployments}::uuid[])`;
  // Real grants for the narrower readers: company 0's HR administrator, company 1's payroll partner, and the first moved
  // employee reading as themself.
  f.users={narrow:randomUUID(),partner:randomUUID(),self:randomUUID()};
  f.selfPerson=(await tx<{id:string}[]>`select person_id as id from employment where id=${f.emp[0]}`)[0].id;
  await tx`insert into app_user(id,tenant_id,workos_user_id,person_id) values(${f.users.narrow},${T},${'user_'+randomUUID()},null),(${f.users.partner},${T},${'user_'+randomUUID()},null),(${f.users.self},${T},${'user_'+randomUUID()},${f.selfPerson})`;
  await tx`insert into role_assignment(tenant_id,app_user_id,company_id,role) values(${T},${f.users.narrow},${f.companies[0]},'hr_admin'),(${T},${f.users.partner},${f.companies[1]},'payroll_partner'),(${T},${f.users.self},null,'employee')`;
 });
},180_000);
afterAll(closeAll);

// ── Fixture shape, from the constants ─────────────────────────────────────────────────────────────────────────────
const employees=Array.from({length:N},(_,i)=>i+1);
const bonusSlips=employees.filter(n=>bonusCompany(companyOf(n))&&bonusEmployee(n)).length;
const movedCount=employees.filter(moved).length;
const novemberSlips=N+bonusSlips;
const allSlips=N*PERIODS.length+bonusSlips+movedCount;

const roles:Record<string,()=>SessionContext>={
 all:()=>adminCtx(b),
 narrow:()=>({...adminCtx(b),userId:f.users.narrow,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:f.companies[0]}]}),
 partner:()=>({...adminCtx(b),userId:f.users.partner,roles:['payroll_partner'],grants:[{role:'payroll_partner',companyId:f.companies[1]}]}),
 self:()=>({...adminCtx(b),userId:f.users.self,personId:f.selfPerson,roles:['employee'],grants:[{role:'employee',companyId:null}]}),
};
const cases=():(ProcessedPayslipFilters&{label:string})[]=>[
 {label:'all companies',companyIds:f.companies},
 {label:'company 0',companyIds:[f.companies[0]]},
 {label:'company 1',companyIds:[f.companies[1]]},
 {label:'November',companyIds:f.companies,year:2026,month:11},
 {label:'2026',companyIds:f.companies,year:2026},
 {label:'every October',companyIds:f.companies,month:10},
 {label:'bonus runs',companyIds:f.companies,cycle:'bonus'},
 {label:'company 0 Monthly cycle',companyIds:[f.companies[0]],payrollCycleId:f.cycles[0]},
 {label:'company 0 December',companyIds:[f.companies[0]],year:2026,month:12},
 {label:'a moved employee',companyIds:f.companies,employmentId:f.emp[0]},
 {label:'an employee of company 5',companyIds:f.companies,employmentId:f.emp[5]},
];

// ── The previous readers, verbatim from core/payroll-view.ts before this change ───────────────────────────────────
const previousRunType=sql`app.payroll_filter_run_type(${payrollBatch.historyImportAttemptId},${payrollBatch.runType}::text,(select pc.run_type::text from payroll_cycle pc where pc.id=${payrollBatch.payrollCycleId}))`;
function previousPeriod(year?:number,month?:number){
 const mm=month!=null?String(month).padStart(2,'0'):null;
 if(year!=null&&mm)return eq(payrollBatch.payPeriod,`${year}-${mm}`);
 if(year!=null)return like(payrollBatch.payPeriod,`${year}-%`);
 if(mm)return like(payrollBatch.payPeriod,`%-${mm}`);
 return undefined;
}
function previousFilters(p:ProcessedPayslipFilters){
 const cycle=p.payrollCycleId?undefined:p.cycle;
 return and(inArray(payrollBatch.companyId,p.companyIds),previousPeriod(p.year,p.month),
  p.employmentId?eq(payslip.employmentId,p.employmentId):undefined,
  p.payrollCycleId?eq(payrollBatch.payrollCycleId,p.payrollCycleId):undefined,
  cycle?sql`${previousRunType} = ${cycle}`:undefined);
}
async function previousLatestTx(tx:Tx,p:ProcessedPayslipFilters){
 const [live]=await tx.select({payPeriod:payrollBatch.payPeriod}).from(payslip)
  .innerJoin(payrollBatch,eq(payrollBatch.id,payslip.batchId)).innerJoin(company,eq(company.id,payrollBatch.companyId))
  .innerJoin(employment,eq(employment.id,payslip.employmentId)).innerJoin(person,eq(person.id,employment.personId))
  .where(previousFilters(p)).orderBy(desc(payrollBatch.payPeriod)).limit(1);
 const retained=await informationPayslipDocuments(tx,{...p,cycle:p.payrollCycleId?undefined:p.cycle,intendedCycle:true,limit:1});
 const periods=[live?.payPeriod,...retained.map(doc=>informationDocumentRow(doc).payPeriod)];
 return periods.filter((period):period is string=>!!period).sort().at(-1)??null;
}
type Row={id:string;payPeriod:string;runSeq:number;employeeName:string;companyId:string;employmentId:string};
async function previousListTx(tx:Tx,p:ProcessedPayslipFilters&{limit?:number}):Promise<Row[]>{
 const q=tx.select({id:payslip.id,payPeriod:payrollBatch.payPeriod,runSeq:payrollBatch.runSeq,employeeName:person.fullName,companyId:payrollBatch.companyId,employmentId:payslip.employmentId})
  .from(payslip).innerJoin(payrollBatch,eq(payrollBatch.id,payslip.batchId)).innerJoin(company,eq(company.id,payrollBatch.companyId))
  .innerJoin(employment,eq(employment.id,payslip.employmentId)).innerJoin(person,eq(person.id,employment.personId))
  .where(previousFilters(p)).orderBy(desc(payrollBatch.payPeriod),asc(payrollBatch.runSeq),asc(person.fullName)).$dynamic();
 const rows:Row[]=await (p.limit?q.limit(p.limit):q);
 const retained=await informationPayslipDocuments(tx,{...p,cycle:p.payrollCycleId?undefined:p.cycle,intendedCycle:true,limit:p.limit});
 const seen=new Set(rows.map(row=>row.id));
 for(const document of retained){const r=informationDocumentRow(document);if(seen.has(r.id))continue;
  rows.push({id:r.id,payPeriod:r.payPeriod,runSeq:r.runSeq,employeeName:r.employeeName,companyId:r.companyId,employmentId:r.employmentId});}
 if(retained.length)rows.sort((x,y)=>y.payPeriod.localeCompare(x.payPeriod)||x.runSeq-y.runSeq||x.employeeName.localeCompare(y.employeeName));
 return p.limit?rows.slice(0,p.limit):rows;
}
const shape=(rows:Row[])=>rows.map(r=>({id:r.id,payPeriod:r.payPeriod,runSeq:r.runSeq,employeeName:r.employeeName,companyId:r.companyId,employmentId:r.employmentId}));

describe('Transaction View History reads at 70 companies and 1,000 employments', ()=>{
 it('the fixture has the shape the counts below are derived from', async()=>{
  const [row]=await owner.client<{companies:number;employments:number;slips:number;retained:number}[]>`select
   (select count(*)::int from company where tenant_id=${b.tenantId}) as companies,
   (select count(*)::int from employment where tenant_id=${b.tenantId} and employee_code like 'TVH-%') as employments,
   (select count(*)::int from payslip where tenant_id=${b.tenantId}) as slips,
   (select count(*)::int from information_payslip_snapshot where tenant_id=${b.tenantId}) as retained`;
  expect(row.companies).toBe(COMPANIES);
  expect(row.employments).toBe(N);
  expect(row.slips).toBe(allSlips);
  expect(movedCount).toBe(8);
  expect(row.retained).toBeGreaterThan(movedCount*PERIODS.length);
 });

 it('returns the same latest period as the previous reader, for every role and scope', async()=>{
  for(const [role,ctx] of Object.entries(roles))for(const c of cases()){
   const {label,...p}=c;
   const before=await withTenant(ctx(),tx=>previousLatestTx(tx,p));
   const now=await latestProcessedPayslipPeriod(ctx(),p);
   expect(now,`${role} / ${label}`).toBe(before);
  }
  // Independent expectations. Every company was paid through November; only company 0 ran December, and only for
  // the employees who later moved to company 1.
  expect(await latestProcessedPayslipPeriod(roles.all(),{companyIds:f.companies})).toBe(LATE);
  expect(await latestProcessedPayslipPeriod(roles.all(),{companyIds:f.companies.slice(2)})).toBe('2026-11');
  // Company 0's administrator no longer sees the moved employees' payslips live; December comes from their retained
  // documents, which is the branch that still asks the document function.
  expect(await latestProcessedPayslipPeriod(roles.narrow(),{companyIds:[f.companies[0]]})).toBe(LATE);
  expect(await latestProcessedPayslipPeriod(roles.all(),{companyIds:f.companies,cycle:'bonus'})).toBe('2026-11');
 },180_000);

 it('returns the same History rows, order and counts as the previous reader, for every role and scope', async()=>{
  for(const [role,ctx] of Object.entries(roles))for(const c of cases())for(const limit of [CAP,undefined]){
   const {label,...p}=c;
   const before=await withTenant(ctx(),tx=>previousListTx(tx,{...p,limit}));
   const now=await listProcessedPayslipsAcross(ctx(),{...p,limit});
   expect(shape(now as Row[]),`${role} / ${label} / ${limit??'uncapped'}`).toEqual(before);
  }
  // Independent expectations for the landing view: November across 70 companies holds every employee's regular slip
  // and the bonus slips, newest period first, regular run before bonus run, then by name.
  const november=await listProcessedPayslipsAcross(roles.all(),{companyIds:f.companies,year:2026,month:11});
  expect(november).toHaveLength(novemberSlips);
  expect(november.slice(0,N).every(r=>r.runSeq===1)&&november.slice(N).every(r=>r.runSeq===2)).toBe(true);
  expect(november.slice(0,3).map(r=>r.employeeName)).toEqual(['History shape person 0001','History shape person 0002','History shape person 0003']);
  const capped=await listProcessedPayslipsAcross(roles.all(),{companyIds:f.companies,year:2026,month:11,limit:CAP});
  expect(capped.map(r=>r.id)).toEqual(november.slice(0,CAP).map(r=>r.id));
  // One company, one administrator: company 0's own employees still paid there, plus the moved employees' retained slips.
  const companyZeroNov=await listProcessedPayslipsAcross(roles.narrow(),{companyIds:[f.companies[0]],year:2026,month:11});
  const zeroEmployees=employees.filter(n=>companyOf(n)===0);
  expect(companyZeroNov).toHaveLength(zeroEmployees.length+zeroEmployees.filter(bonusEmployee).length);
 },300_000);

 it('runs the payslip row policies on the period and a handful of batches, not on every payslip in scope', async()=>{
  const p={companyIds:f.companies};
  const november={...p,year:2026,month:11,limit:CAP};
  const reads={
   latest:(tx:Tx)=>latestProcessedPayslipPeriodTx(tx,p),
   previousLatest:(tx:Tx)=>previousLatestTx(tx,p),
   list:(tx:Tx)=>readProcessedPayslipsTx(tx,november),
   previousList:(tx:Tx)=>previousListTx(tx,november),
  };
  const counted:Record<string,number>={};
  for(const [name,read] of Object.entries(reads))counted[name]=await policyCalls(roles.all(),read);
  console.info('TRANSACTION_VIEW_HISTORY_POLICY_CALLS',JSON.stringify({...counted,allSlips,novemberSlips}));
  // One probe per batch walked, newest period first; the first batch holds a visible payslip.
  expect(counted.latest).toBeGreaterThan(0);
  expect(counted.latest).toBeLessThanOrEqual(50);
  // Only November's payslips are evaluated, not the other three months'.
  expect(counted.list).toBeGreaterThan(0);
  expect(counted.list).toBeLessThanOrEqual(novemberSlips);
  expect(counted.list).toBeLessThan(allSlips/2);
 },180_000);

 it('the 7200 document function returns what the 5129 body returned, in the same order', async()=>{
  const reference=readFileSync('db/migrations/5129_payroll_history_effective_reads.sql','utf8')
   .match(/CREATE OR REPLACE FUNCTION app\.information_payslip_documents\([\s\S]*?\n\$\$;/)![0]
   .replace('CREATE OR REPLACE FUNCTION app.information_payslip_documents(','CREATE FUNCTION pg_temp.reference_documents_5129(');
  const args:[string[],number|null,number|null,string|null,string|null][]=[
   [f.companies,null,null,null,null],[[f.companies[0]],null,null,null,null],[f.companies,2026,11,null,null],[f.companies,2026,null,null,null],
   [f.companies,null,10,null,null],[f.companies,null,null,'bonus',null],[f.companies,null,null,'regular',null],[[f.companies[0]],2026,12,null,null],
   [f.companies,null,null,null,f.emp[0]],[f.companies,null,null,null,f.emp[8]],
  ];
  for(const [role,ctx] of Object.entries(roles)){
   const [now,before]=await rolledBack(async tx=>{
    await tx.unsafe(reference);
    await settings(tx,ctx());
    const read=async(fn:string,a:typeof args[number],intended:boolean)=>(await tx.unsafe(
     `select string_agg(d.doc::text,'|' order by d.ord) as docs,count(*)::int as n from ${fn}($1::uuid[],$2::integer,$3::integer,$4::text,$5::uuid,$6::boolean) with ordinality as d(doc,ord)`,
     [...a,intended] as never[]))[0] as unknown as {docs:string|null;n:number};
    const x:{docs:string|null;n:number}[]=[],y:{docs:string|null;n:number}[]=[];
    for(const a of args)for(const intended of [true,false]){x.push(await read('app.information_payslip_documents',a,intended));y.push(await read('pg_temp.reference_documents_5129',a,intended));}
    return [x,y] as const;
   });
   expect(now,role).toEqual(before);
   if(role==='all'||role==='narrow')expect(now[0].n,role).toBeGreaterThan(0);
  }
 },180_000);
});

/** Owner-session work that leaves nothing behind (reference functions live in pg_temp, settings are local). */
class Rollback{constructor(readonly value:unknown){}}
async function rolledBack<T>(body:(tx:postgres.TransactionSql)=>Promise<T>):Promise<T>{
 try{await owner.client.begin(async tx=>{throw new Rollback(await body(tx));});}
 catch(error){if(error instanceof Rollback)return error.value as T;throw error;}
 throw new Error('the owner transaction did not run');
}
/** The identity withTenant's bootstrap sets, transaction-local (db/client.ts bootstrapTenantTx). */
async function settings(tx:postgres.TransactionSql,ctx:SessionContext){
 await tx`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId??''},true),set_config('app.roles',${(ctx.roles??[]).join(',')},true),
  set_config('app.grants',${JSON.stringify(ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null})))},true),set_config('app.agent_principal_id','',true),
  set_config('app.payroll_tax_basis_reader','1',true),set_config('app.payroll_import_tax_basis_reader','1',true),set_config('jit','off',true)`;
}
/** Payslip rows the per-row policy functions ran on during `read`, as the application role. Function counters are per
 * backend and flushed lazily, so a reading is the difference across the read inside one transaction. */
async function policyCalls(ctx:SessionContext,read:(tx:Tx)=>Promise<unknown>):Promise<number>{
 class Done{constructor(readonly calls:number){}}
 try{
  await owner.db.transaction(async tx=>{
   await tx.execute(sql`set local track_functions = 'all'`);
   await tx.execute(sql`set local role ai_hr_app`);
   await tx.execute(sql`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId??''},true),set_config('app.roles',${(ctx.roles??[]).join(',')},true),
    set_config('app.grants',${JSON.stringify(ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null})))},true),set_config('app.agent_principal_id','',true),
    set_config('app.payroll_tax_basis_reader','1',true),set_config('app.payroll_import_tax_basis_reader','1',true),set_config('jit','off',true)`);
   const counter=async()=>{const rows=await tx.execute<{calls:number}>(sql`select coalesce(max(calls),0)::int as calls from pg_stat_xact_user_functions
    where schemaname='app' and funcname in ('can_admin_payroll_employment','payroll_tax_basis_reader_compatible')`);return Number(rows[0]?.calls??0);};
   const before=await counter();
   await read(tx as unknown as Tx);
   throw new Done((await counter())-before);
  });
 }catch(error){if(error instanceof Done)return error.calls;throw error;}
 throw new Error('the counting transaction did not run');
}
