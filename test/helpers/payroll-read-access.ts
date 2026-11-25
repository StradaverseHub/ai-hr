/** Shared helpers for the ADR 0181 payroll read access steps (migrations 7460 onwards): the payroll scale fixture,
 * application-role transactions with explicit reader settings, plan skeletons and per-row call counts. Fictional data
 * only; every count a test asserts is derived from the constants here. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {adminCtx,owner,resetDb,seedBase,setModule,type Base} from '../harness';

export const COMPANIES=70,N=1000,PERIODS=['2026-08','2026-09','2026-10','2026-11'] as const;
/** Employment n works for company (n-1)%70. Company 0's employments with an even k (n = 1 + 70k) moved to company 1
 * after they were paid; every tenth employee's slips carry an imported tax-basis stamp; employment 500 is voided. */
export const companyOf=(n:number)=>(n-1)%COMPANIES,moved=(n:number)=>companyOf(n)===0&&((n-1)/COMPANIES)%2===0;
export const stamped=(n:number)=>n%10===0;
export const VOIDED=500;
export const allSlips=N*PERIODS.length;

export type PayrollReadFixture={b:Base;companies:string[];emp:string[];users:Record<string,string>;selfPerson:string};
export type Actor='all'|'group'|'super'|'narrow'|'partner'|'self'|'stale';

export async function buildPayrollReadFixture():Promise<PayrollReadFixture>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'payroll','active');
 const T=b.tenantId;
 const f:PayrollReadFixture={b,companies:[],emp:[],users:{},selfPerson:''};
 await owner.client.begin(async tx=>{
  await tx`set local session_replication_role = replica`;
  const others=await tx<{id:string}[]>`insert into company(tenant_id,legal_name) select ${T}::uuid,'Payroll read company '||lpad(n::text,2,'0') from generate_series(1,${COMPANIES-1}::integer) n order by n returning id`;
  f.companies=[b.companyId,...others.map(row=>row.id)];
  await tx`with people as(insert into person(tenant_id,full_name,primary_email) select ${T}::uuid,'Payroll read person '||lpad(n::text,4,'0'),'payroll-read-'||n||'@fixture.invalid' from generate_series(1,${N}::integer) n returning id,full_name)
   insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${T}::uuid,id,(${f.companies}::uuid[])[1+((right(full_name,4)::int-1)%${COMPANIES}::integer)],'PRA-'||right(full_name,4),'2025-01-01'::date from people`;
  f.emp=(await tx<{id:string}[]>`select id from employment where tenant_id=${T}::uuid and employee_code like 'PRA-%' order by employee_code`).map(row=>row.id);
  await tx`insert into pay_period(tenant_id,company_id,period,status) select ${T}::uuid,c,p,'closed' from unnest(${f.companies}::uuid[]) c cross join unnest(${[...PERIODS]}::text[]) p`;
  await tx`insert into payroll_batch(tenant_id,company_id,pay_period_id,pay_period,batch_date,status,released_at,run_type,run_seq,employee_count,totals)
   select pp.tenant_id,pp.company_id,pp.id,pp.period,(pp.period||'-25')::date,'closed',now(),'regular',1,0,'{}'::jsonb from pay_period pp where pp.tenant_id=${T}::uuid and pp.company_id=any(${f.companies}::uuid[])`;
  await tx`insert into payslip(tenant_id,batch_id,employment_id,basic_salary,gross_pay,statutory,total_deductions,net_pay,employer_cost)
   select ${T}::uuid,pb.id,e.id,'3000.00','3000.00',
    case when right(e.employee_code,4)::int%10=0 then '{"importedTaxBasis":{"version":1,"source":"fictional"}}'::jsonb else '{}'::jsonb end,'0.00','3000.00','3000.00'
   from employment e join payroll_batch pb on pb.company_id=e.company_id and pb.tenant_id=e.tenant_id where e.tenant_id=${T}::uuid and e.employee_code like 'PRA-%'`;
  await tx`update employment set company_id=${f.companies[1]} where id=any(${f.emp.filter((_,i)=>moved(i+1))}::uuid[])`;
  // Voided as a rehire roll-back would void it (5695's completeness rule): code cleared, the rehire source recorded.
  await tx`update employment set voided_at=now(),voided_by=${b.adminUserId},void_reason='Fictional void',voided_employee_code=employee_code,employee_code=null,
   rehired_from_employment_id=${f.emp[VOIDED]} where id=${f.emp[VOIDED-1]}`;
  f.selfPerson=(await tx<{id:string}[]>`select person_id as id from employment where id=${f.emp[0]}`)[0].id;
  const users:Record<string,{person:string|null;grants:[string|null,string][]}>={
   group:{person:null,grants:[[null,'hr_admin']]},
   super:{person:null,grants:[[null,'super_admin']]},
   narrow:{person:null,grants:[[f.companies[0],'hr_admin']]},
   partner:{person:null,grants:[[f.companies[1],'payroll_partner']]},
   self:{person:f.selfPerson,grants:[[null,'employee']]},
   stale:{person:null,grants:[[null,'employee']]},
  };
  for(const [name,u] of Object.entries(users)){
   const id=randomUUID();f.users[name]=id;
   await tx`insert into app_user(id,tenant_id,workos_user_id,person_id) values(${id},${T},${'user_'+randomUUID()},${u.person})`;
   for(const [company,role] of u.grants)await tx`insert into role_assignment(tenant_id,app_user_id,company_id,role) values(${T},${id},${company},${role})`;
  }
 });
 // Fixed statistics before any baseline: an autovacuum analyse between the legacy and switched reads would change the
 // planner's estimates (and plans) for reasons unrelated to the rule text.
 await owner.client`analyze company,person,employment,pay_period,payroll_batch,payslip,app_user,role_assignment`;
 return f;
}
/** Plain JSON form, so a comparison sees values, not object identity or class. */
export const plain=<T>(value:T):T=>JSON.parse(JSON.stringify(value));

export function actors(f:PayrollReadFixture):Record<Actor,()=>SessionContext>{
 const base=()=>adminCtx(f.b);
 return{
  all:base,
  group:()=>({...base(),userId:f.users.group,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]}),
  super:()=>({...base(),userId:f.users.super,roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]}),
  narrow:()=>({...base(),userId:f.users.narrow,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:f.companies[0]}]}),
  partner:()=>({...base(),userId:f.users.partner,roles:['payroll_partner'],grants:[{role:'payroll_partner',companyId:f.companies[1]}]}),
  self:()=>({...base(),userId:f.users.self,personId:f.selfPerson,roles:['employee'],grants:[{role:'employee',companyId:null}]}),
  // A session still carrying an administrator claim its user no longer holds (principal_snapshot_current is false).
  stale:()=>({...base(),userId:f.users.stale,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]}),
 };
}

export async function setStepMode(step:string,mode:'legacy'|'shadow'|'precomputed'){await owner.client`select app.payroll_read_access_set_mode(${step},${mode})`;}

class Done{constructor(readonly value:unknown){}}
export type Outcome<T>={value?:T;error?:{code:string;message:string}};
/** A transaction as the application role with the identity withTenant sets and the reader settings as given; always
 * rolled back. Returns the body's value or the error it raised. Function call counting is on. */
export async function asApp<T>(ctx:SessionContext,readers:'1'|'',body:(tx:Tx)=>Promise<T>):Promise<Outcome<T>>{
 try{
  await owner.db.transaction(async tx=>{
   await tx.execute(sql`set local track_functions = 'all'`);
   await tx.execute(sql`set local role ai_hr_app`);
   await tx.execute(sql`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId??''},true),set_config('app.roles',${(ctx.roles??[]).join(',')},true),
    set_config('app.grants',${JSON.stringify(ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null})))},true),set_config('app.agent_principal_id','',true),
    set_config('app.payroll_tax_basis_reader',${readers},true),set_config('app.payroll_import_tax_basis_reader',${readers},true),set_config('jit','off',true)`);
   let value:T;
   try{value=await body(tx as unknown as Tx);}
   catch(error){const e=error as {code?:string;message:string;cause?:{code?:string;message?:string}};throw new Done({error:{code:e.code??e.cause?.code??'',message:e.cause?.message??e.message}});}
   throw new Done({value});
  });
 }catch(error){if(error instanceof Done)return error.value as Outcome<T>;throw error;}
 throw new Error('the application-role transaction did not run');
}

/** Calls of the named app functions so far in this transaction (track_functions must be on). */
export async function calls(tx:Tx,names:string[]):Promise<number>{
 const rows=await tx.execute<{calls:number}>(sql`select coalesce(sum(calls),0)::int as calls from pg_stat_xact_user_functions where schemaname='app' and funcname in (${sql.join(names.map(name=>sql`${name}`),sql`,`)})`);
 return Number(rows[0]?.calls??0);
}

/** The main plan tree's node types, relations, join types and row estimates, without InitPlan subtrees or costs. */
type PlanNode={'Node Type':string;'Relation Name'?:string;'Plan Rows':number;'Parent Relationship'?:string;'Join Type'?:string;Plans?:PlanNode[]};
const skeleton=(node:PlanNode):unknown=>({type:node['Node Type'],rel:node['Relation Name']??null,join:node['Join Type']??null,rows:node['Plan Rows'],
 children:(node.Plans??[]).filter(child=>child['Parent Relationship']!=='InitPlan').map(skeleton)});
/** The value of an application-role transaction, which must not have failed. */
export function must<T>(o:Outcome<T>):T{
 if(o.error)throw new Error(`application-role read failed: ${o.error.code} ${o.error.message}`);
 return o.value as T;
}
/** A uuid set as one array value (drizzle's sql would expand a JS array into a parameter list). */
export const uuidArray=(ids:readonly string[])=>sql`${'{'+ids.join(',')+'}'}::uuid[]`;
export async function planShape(ctx:SessionContext,query:ReturnType<typeof sql>):Promise<unknown>{
 return must(await asApp(ctx,'1',async tx=>{
  const [row]=await tx.execute<{'QUERY PLAN':{Plan:PlanNode}[]}>(sql`explain (format json) ${query}`);
  return skeleton(row['QUERY PLAN'][0].Plan);
 }));
}
export const median=(xs:number[])=>[...xs].sort((x,y)=>x-y)[Math.floor(xs.length/2)];
