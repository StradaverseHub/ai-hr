/**
 * The two statements that still made Transaction View and the Payroll Process dashboard slow on staging after the
 * History fix (24 November 2026; SCALE rules 2 and 3), at the shape of a real group: 70 companies, 1,000 employments,
 * 40 departments shared across companies, and three imported payroll-history months for every company.
 *
 *  - Employee choice Department options: the first-witness cross join proved each ABSENT (company, department) pair by
 *    reading every current Assignment of that department, once per company (staging: 2,151 ms for 74 x 98 pairs). With
 *    more than one represented company the reader now probes each authorized member's Assignment once. Same rows,
 *    compared with the first-witness statement; Assignment tuples read are counted with pg_stat_xact_user_tables.
 *  - Payroll dashboard latest period and empty state: `max(pay_period)` / `count(*)` over the effective view derived
 *    every imported run's employee_count (staging: 3.95 s and 2.8 s for 567 imported runs). The readers now walk the
 *    runs newest first and derive only what they reach. Same answers as the previous statements (kept below verbatim),
 *    for every scope and role; derivations are counted with pg_stat_xact_user_functions.
 * Fictional fixtures only. Expected values come from the fixture constants, never from the readers.
 */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {PgDialect} from 'drizzle-orm/pg-core';
import {and,eq,gt,inArray,isNull,or,sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {adminCtx,closeAll,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {company,payrollBatch,payrollCycle,payrollHistoryEffectiveBatch,roleAssignment} from '../db/schema';
import {latestListedBatchPeriodTx,latestPayrollDashboardPeriod,listBatches,payrollDashboardCounts,payrollDashboardCountsTx} from '../core/payroll';
import {readEmployeeChoicesTx} from '../core/employee-choice';
import {firstWitnessDepartmentFacet,isDepartmentFacet,isSparseDepartmentFacet} from './performance/employee-choice-department-pair-probe';

const COMPANIES=70,N=1000,DEPARTMENTS=40,IMPORTED=['2026-08','2026-09','2026-10'] as const;
const companyOf=(n:number)=>(n-1)%COMPANIES,departmentOf=(n:number)=>(n-1)%DEPARTMENTS;
/** Company 5 also has an EMPTY imported 2026-11 run (no payslips, so listBatches leaves it out); company 3 has a
 * processed native 2026-07 run (unpublished) and company 4 a draft one (not unpublished); emptyCompany has only an
 * empty imported 2026-11 run. */
const EMPTY_RUN_COMPANY=5,PROCESSED_COMPANY=3,DRAFT_COMPANY=4;

let b:Base;
const f={companies:[] as string[],emptyCompany:'',departments:[] as string[],emp:[] as string[],scopedUser:''};
const id=()=>randomUUID();

beforeAll(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');
 const T=b.tenantId;
 f.companies=[b.companyId,...Array.from({length:COMPANIES-1},id)];f.emptyCompany=id();
 f.departments=Array.from({length:DEPARTMENTS},id);
 const persons=Array.from({length:N},id);f.emp=Array.from({length:N},id);
 const empCompany=f.emp.map((_,i)=>f.companies[companyOf(i+1)]),empDepartment=f.emp.map((_,i)=>f.departments[departmentOf(i+1)]);
 await owner.client.begin(async tx=>{
  await tx`set local session_replication_role = replica`;
  const extra=[...f.companies.slice(1),f.emptyCompany];
  await tx`insert into company(id,tenant_id,legal_name) select c,${T}::uuid,'Fictional scale company '||o from unnest(${extra}::uuid[]) with ordinality as x(c,o)`;
  await tx`insert into department(id,tenant_id,company_id,name) select d,${T}::uuid,${b.companyId}::uuid,'Fictional department '||lpad(o::text,2,'0')
   from unnest(${f.departments}::uuid[]) with ordinality as x(d,o)`;
  await tx`insert into person(id,tenant_id,full_name,primary_email) select p,${T}::uuid,'Fictional scale employee '||lpad(o::text,4,'0'),p::text||'@fixture.test'
   from unnest(${persons}::uuid[]) with ordinality as x(p,o)`;
  await tx`insert into employment(id,tenant_id,person_id,company_id,hired_on,employee_code)
   select e,${T}::uuid,p,c,'2020-01-01','SCALE'||lpad(o::text,4,'0') from unnest(${f.emp}::uuid[],${persons}::uuid[],${empCompany}::uuid[]) with ordinality as x(e,p,c,o)`;
  await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
   select ${T}::uuid,e,c,d,'full_time','2020-01-01' from unnest(${f.emp}::uuid[],${empCompany}::uuid[],${empDepartment}::uuid[]) as x(e,c,d)`;

  // Payroll: a Monthly cycle per company, one history import per company, an imported run per company and month with
  // one payslip per employee, each the effective snapshot of its own import record (as the importer writes them).
  const all=[...f.companies,f.emptyCompany],cycles=all.map(id),attempts=all.map(id);
  await tx`insert into payroll_cycle(id,tenant_id,company_id,name,run_type) select y,${T}::uuid,c,'Monthly','regular' from unnest(${cycles}::uuid[],${all}::uuid[]) as x(y,c)`;
  await tx`insert into payroll_history_import_attempt(tenant_id,id,created_by,operation_key,source_name,mime_type,source_hash,source_content,company_ids,plan)
   select ${T}::uuid,a,${b.adminUserId}::uuid,a::text,'history.csv','text/csv',encode(sha256(a::text::bytea),'hex'),a::text::bytea,array[c],
    jsonb_build_object('rows',jsonb_build_array(),'sourceHash',encode(sha256(a::text::bytea),'hex'))
   from unnest(${attempts}::uuid[],${all}::uuid[]) as x(a,c)`;
  type Run={id:string;company:number;period:string;attempt:string|null;status:string};
  const runs:Run[]=[];
  for(let c=0;c<COMPANIES;c++)for(const period of IMPORTED)runs.push({id:id(),company:c,period,attempt:attempts[c],status:'closed'});
  runs.push({id:id(),company:EMPTY_RUN_COMPANY,period:'2026-11',attempt:attempts[EMPTY_RUN_COMPANY],status:'closed'});
  runs.push({id:id(),company:COMPANIES,period:'2026-11',attempt:attempts[COMPANIES],status:'closed'});
  runs.push({id:id(),company:PROCESSED_COMPANY,period:'2026-07',attempt:null,status:'processed'});
  runs.push({id:id(),company:DRAFT_COMPANY,period:'2026-07',attempt:null,status:'draft'});
  const periodIds=runs.map(id);
  await tx`insert into pay_period(id,tenant_id,company_id,period,status)
   select p,${T}::uuid,c,per,'closed' from unnest(${periodIds}::uuid[],${runs.map(r=>all[r.company])}::uuid[],${runs.map(r=>r.period)}::text[]) as x(p,c,per)`;
  await tx`insert into payroll_batch(id,tenant_id,company_id,pay_period,batch_date,status,employee_count,totals,remarks,run_seq,run_type,pay_period_id,payroll_cycle_id,history_import_attempt_id,history_import_cycle_name,closed_at)
   select r,${T}::uuid,c,per,'2026-10-01',st::payroll_status,0,'{}'::jsonb,case when a is null then null else 'Imported payroll history' end,1,
    (case when a is null then 'regular' else 'adjustment' end)::payroll_run_type,pp,y,a,case when a is null then null else 'Monthly' end,case when st='closed' then now() end
   from unnest(${runs.map(r=>r.id)}::uuid[],${runs.map(r=>all[r.company])}::uuid[],${runs.map(r=>r.period)}::text[],${runs.map(r=>r.status)}::text[],
    ${runs.map(r=>r.attempt)}::uuid[],${periodIds}::uuid[],${runs.map(r=>cycles[r.company])}::uuid[]) as x(r,c,per,st,a,pp,y)`;
  const slips:{id:string;batch:string;emp:string;company:number;period:string;record:string;revision:string}[]=[];
  for(const run of runs.slice(0,COMPANIES*IMPORTED.length))for(let n=1;n<=N;n++)if(companyOf(n)===run.company)
   slips.push({id:id(),batch:run.id,emp:f.emp[n-1],company:run.company,period:run.period,record:id(),revision:id()});
  const col=<K extends keyof typeof slips[number]>(k:K)=>slips.map(s=>s[k]);
  await tx`insert into payslip(id,tenant_id,batch_id,employment_id,basic_salary,allowance,gross_pay,statutory,other_deductions,total_deductions,net_pay,employer_cost)
   select s,${T}::uuid,bt,e,4000,300,4300,'{"version":"2026.1","epfEmployee":473,"epfEmployer":559,"socsoEmployee":21.25,"socsoEmployer":74.35,"eisEmployee":8.5,"eisEmployer":8.5,"pcb":120}'::jsonb,0,622.75,3677.25,4942.1
   from unnest(${col('id')}::uuid[],${col('batch')}::uuid[],${col('emp')}::uuid[]) as x(s,bt,e)`;
  await tx`insert into payroll_history_import_record(id,tenant_id,company_id,employment_id,period,cycle_id)
   select r,${T}::uuid,c,e,per,y from unnest(${col('record')}::uuid[],${slips.map(s=>all[s.company])}::uuid[],${col('emp')}::uuid[],${col('period')}::text[],${slips.map(s=>cycles[s.company])}::uuid[]) as x(r,c,e,per,y)`;
  await tx`insert into payroll_history_import_snapshot(id,tenant_id,record_id,value_hash,"values")
   select s,${T}::uuid,r,encode(sha256(s::text::bytea),'hex'),'{"fixture":true}'::jsonb from unnest(${col('id')}::uuid[],${col('record')}::uuid[]) as x(s,r)`;
  await tx`insert into payroll_history_import_revision(id,tenant_id,record_id,ordinal,attempt_id,snapshot_id,previous_revision_id,kind,cycle_name)
   select v,${T}::uuid,r,1,a,s,null,'import','Monthly' from unnest(${col('revision')}::uuid[],${col('record')}::uuid[],${slips.map(s=>attempts[s.company])}::uuid[],${col('id')}::uuid[]) as x(v,r,a,s)`;
  // A payroll administrator of company 2 only (a real grant, checked by the principal snapshot).
  f.scopedUser=id();
  await tx`insert into app_user(id,tenant_id,workos_user_id,person_id) values(${f.scopedUser},${T},${'user_'+f.scopedUser},null)`;
  await tx`insert into role_assignment(tenant_id,app_user_id,company_id,role) values(${T},${f.scopedUser},${f.companies[2]},'hr_admin')`;
 });
 for(const table of ['company','department','person','employment','assignment','payroll_batch','payslip','payroll_history_import_record',
  'payroll_history_import_snapshot','payroll_history_import_revision'])await owner.client.unsafe('analyze '+table);
},600000);
afterAll(closeAll);

const root=()=>adminCtx(b);
const scoped=():SessionContext=>({...adminCtx(b),userId:f.scopedUser,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:f.companies[2]}]});

/** Runs `read` as ai_hr_app with withTenant's settings inside an owner transaction that is always rolled back, and
 * returns the result with the counter's change. */
async function counted<T>(ctx:SessionContext,counter:SQL,read:(tx:Tx)=>Promise<T>):Promise<{value:T;count:number}>{
 class Done{constructor(readonly value:T,readonly count:number){}}
 try{
  await owner.db.transaction(async tx=>{
   await tx.execute(sql`set local track_functions = 'all'`);
   await tx.execute(sql`set local role ai_hr_app`);
   await tx.execute(sql`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId??''},true),set_config('app.roles',${(ctx.roles??[]).join(',')},true),
    set_config('app.grants',${JSON.stringify(ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null})))},true),set_config('app.agent_principal_id','',true),
    set_config('app.payroll_tax_basis_reader','1',true),set_config('app.payroll_import_tax_basis_reader','1',true),set_config('jit','off',true)`);
   const read0=async()=>Number((await tx.execute<{n:number}>(counter))[0]?.n??0);
   const before=await read0(),value=await read(tx as unknown as Tx);
   throw new Done(value,(await read0())-before);
  });
 }catch(error){if(error instanceof Done)return {value:error.value,count:error.count};throw error;}
 throw new Error('the counting transaction did not run');
}
const derivations=sql`select coalesce(sum(calls),0)::int as n from pg_stat_xact_user_functions
 where schemaname='app' and funcname in ('payroll_history_batch_visible_totals','payroll_history_batch_totals')`;
const assignmentReads=sql`select coalesce(sum(seq_tup_read+coalesce(idx_tup_fetch,0)),0)::int as n from pg_stat_xact_user_tables where relname='assignment'`;

// ---- The previous dashboard statements, verbatim (core/payroll.ts before this change). ----
function previousLatest(tx:Tx,companyIds?:string[]){
 return tx.select({period:sql<string|null>`max(${payrollBatch.payPeriod})`}).from(payrollHistoryEffectiveBatch)
  .innerJoin(company,eq(company.id,payrollBatch.companyId))
  .where(and(companyIds&&companyIds.length?inArray(payrollBatch.companyId,companyIds):undefined,
   or(isNull(payrollBatch.historyImportAttemptId),gt(payrollBatch.employeeCount,0)))).then(([row])=>row?.period??null);
}
function previousCounts(tx:Tx,companyIds?:string[]){
 return tx.select({totalCount:sql<number>`count(*)`.mapWith(Number),
  unpublishedCount:sql<number>`count(*) filter (where ${payrollBatch.historyImportAttemptId} is null and ${payrollBatch.status} not in ('draft','closed'))`.mapWith(Number),
 }).from(payrollHistoryEffectiveBatch).innerJoin(company,eq(company.id,payrollBatch.companyId))
  .leftJoin(payrollCycle,eq(payrollCycle.id,payrollBatch.payrollCycleId))
  .where(and(companyIds&&companyIds.length?inArray(payrollBatch.companyId,companyIds):undefined,
   or(isNull(payrollBatch.historyImportAttemptId),gt(payrollBatch.employeeCount,0)))).then(([row])=>row??{totalCount:0,unpublishedCount:0});
}

describe('Payroll Process dashboard: latest period and empty state',()=>{
 it('has the fixture shape the readers are measured on',async()=>{
  const [shape]=await owner.client<{imported:number;slips:number;empty:number}[]>`select
   (select count(*)::int from payroll_batch where tenant_id=${b.tenantId} and history_import_attempt_id is not null) as imported,
   (select count(*)::int from payslip where tenant_id=${b.tenantId}) as slips,
   (select count(*)::int from payroll_batch bt where bt.tenant_id=${b.tenantId} and not exists(select 1 from payslip s where s.batch_id=bt.id)) as empty`;
  expect(shape).toEqual({imported:COMPANIES*IMPORTED.length+2,slips:N*IMPORTED.length,empty:4});
 });

 it('answers as the previous statements did, and as the fixture says, for every scope and role',async()=>{
  const scopes:[string,string[]|undefined,string|null,boolean,number][]=[
   // label, company filter, expected latest, expected hasRuns, expected unpublished (root)
   ['no filter',undefined,'2026-10',true,1],['empty filter',[],'2026-10',true,1],['every company',[...f.companies,f.emptyCompany],'2026-10',true,1],
   ['company with an empty newer run',[f.companies[EMPTY_RUN_COMPANY]],'2026-10',true,0],['only an empty run',[f.emptyCompany],null,false,0],
   ['processed native run',[f.companies[PROCESSED_COMPANY]],'2026-10',true,1],['draft native run',[f.companies[DRAFT_COMPANY]],'2026-10',true,0],
   ['unknown company',[randomUUID()],null,false,0],
  ];
  for(const [label,scope,latest,hasRuns,unpublished] of scopes){
   const now={latest:await latestPayrollDashboardPeriod(root(),scope),counts:await payrollDashboardCounts(root(),scope)};
   const before=await withTenant(root(),async tx=>({latest:await previousLatest(tx,scope),counts:await previousCounts(tx,scope)}));
   expect({label,...now}).toEqual({label,latest:before.latest,counts:{hasRuns:before.counts.totalCount>0,unpublishedCount:before.counts.unpublishedCount}});
   expect({label,...now}).toEqual({label,latest,counts:{hasRuns,unpublishedCount:unpublished}});
   expect(now.counts.hasRuns).toBe((await listBatches(root(),scope)).length>0);
  }
  for(const scope of [undefined,[f.companies[2]],[f.companies[3]],[f.emptyCompany]]){
   const now={latest:await latestPayrollDashboardPeriod(scoped(),scope),counts:await payrollDashboardCounts(scoped(),scope)};
   const before=await withTenant(scoped(),async tx=>({latest:await previousLatest(tx,scope),counts:await previousCounts(tx,scope)}));
   expect(now).toEqual({latest:before.latest,counts:{hasRuns:before.counts.totalCount>0,unpublishedCount:before.counts.unpublishedCount}});
   // Company 2's administrator sees only company 2's runs, whatever the filter names.
   const own=scope===undefined||scope.includes(f.companies[2]);
   expect(now).toEqual({latest:own?'2026-10':null,counts:{hasRuns:own,unpublishedCount:0}});
  }
 },300000);

 it('derives the imported runs it reaches, not every imported run in scope',async()=>{
  const scope=[...f.companies,f.emptyCompany];
  const latest=await counted(root(),derivations,tx=>latestListedBatchPeriodTx(tx,scope));
  const counts=await counted(root(),derivations,tx=>payrollDashboardCountsTx(tx,scope));
  const previous=await counted(root(),derivations,tx=>previousLatest(tx,scope));
  const previousAll=await counted(root(),derivations,tx=>previousCounts(tx,scope));
  expect(latest.value).toBe('2026-10');expect(previous.value).toBe('2026-10');
  // 2026-11 holds two empty imported runs, then the first 2026-10 run qualifies.
  expect(latest.count).toBeLessThanOrEqual(3);
  // A processed native run answers hasRuns without deriving anything.
  expect(counts.value).toEqual({hasRuns:true,unpublishedCount:1});expect(counts.count).toBe(0);
  expect(previous.count).toBeGreaterThanOrEqual(COMPANIES*IMPORTED.length);
  expect(previousAll.count).toBeGreaterThanOrEqual(COMPANIES*IMPORTED.length);
  console.log('PAYROLL_DASHBOARD_DERIVATIONS',JSON.stringify({latest:latest.count,counts:counts.count,previousLatest:previous.count,previousCounts:previousAll.count,importedRuns:COMPANIES*IMPORTED.length+2}));
 },300000);
});

describe('Employee choice Department options across many companies',()=>{
 const dialect=new PgDialect();
 type Pair=Record<string,unknown>;
 /** Reads the employee choices, captures the product's Department statement (rows and Assignment tuples read), then
  * runs the first-witness statement in the same transaction for comparison. */
 async function department(ctx:SessionContext,companyIds:string[]){
  const input={companyIds,labelMode:'labels' as const};
  return (await counted(ctx,sql`select 0 as n`,async tx=>{
   const product:{form?:'per-member'|'cross';rows?:Pair[];reads?:number}={};
   const reads=async()=>Number((await tx.execute<{n:number}>(assignmentReads))[0]?.n??0);
   const proxy=new Proxy(tx,{get(target,key,receiver){
    if(key==='execute')return async(query:SQL)=>{
     const text=dialect.sqlToQuery(query).sql.trimStart(),sparse=isSparseDepartmentFacet(text);
     if(!sparse&&!isDepartmentFacet(text))return target.execute(query);
     const before=await reads(),rows=await target.execute<Pair>(query);
     Object.assign(product,{form:sparse?'per-member':'cross',rows:[...rows],reads:(await reads())-before});return rows;
    };
    const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
   }});
   const page=await readEmployeeChoicesTx(proxy as Tx,ctx,input);
   const before=await reads(),reference=[...await tx.execute<Pair>(firstWitnessDepartmentFacet(ctx.tenantId,input))],referenceReads=(await reads())-before;
   return {page,product,reference,referenceReads};
  })).value;
 }

 it('returns the first-witness rows, reading each member Assignment once instead of once per company',async()=>{
  const all=await department(root(),[...f.companies]);
  // Employment n is in company (n-1)%70 and department (n-1)%40: 280 distinct (company, department) pairs.
  const expectedPairs=new Set(Array.from({length:N},(_,i)=>companyOf(i+1)+'/'+departmentOf(i+1))).size;
  expect(expectedPairs).toBe(280);
  expect(all.product.form).toBe('per-member');
  expect(all.product.rows).toEqual(all.reference);expect(all.reference).toHaveLength(expectedPairs);
  expect(all.page.allDepartmentOptions).toHaveLength(DEPARTMENTS);expect(all.page.companyOptions).toHaveLength(COMPANIES);
  expect(all.product.reads).toBeLessThanOrEqual(2*N);
  expect(all.referenceReads).toBeGreaterThan(10*all.product.reads!);

  // One represented company keeps the first-witness statement (the 50k one-company fixture's shape).
  const one=await department(root(),[f.companies[2]]);
  expect(one.product.form).toBe('cross');expect(one.product.rows).toEqual(one.reference);
  expect(one.reference).toHaveLength(new Set(Array.from({length:N},(_,i)=>i+1).filter(n=>companyOf(n)===2).map(departmentOf)).size);

  // A one-company administrator asking for every company is narrowed by row security to company 2.
  const narrow=await department(scoped(),[...f.companies]);
  expect(narrow.page.companyOptions.map(option=>option.id)).toEqual([f.companies[2]]);
  expect(narrow.product.form).toBe('cross');expect(narrow.product.rows).toEqual(narrow.reference);expect(narrow.product.rows).toEqual(one.reference);
  console.log('EMPLOYEE_CHOICE_DEPARTMENT_READS',JSON.stringify({allCompanies:{product:all.product.reads,firstWitness:all.referenceReads,pairs:all.reference.length},
   oneCompany:{product:one.product.reads,firstWitness:one.referenceReads}}));
 },300000);

 it('keeps the grant the fixture gave the one-company administrator',async()=>{
  const grants=await owner.db.select({companyId:roleAssignment.companyId,role:roleAssignment.role}).from(roleAssignment).where(eq(roleAssignment.appUserId,f.scopedUser));
  expect(grants).toEqual([{companyId:f.companies[2],role:'hr_admin'}]);
 });
});
