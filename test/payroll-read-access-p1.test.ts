/**
 * ADR 0181 payroll read addendum, step P1 (migration 7460): the payroll read switch, and the two restrictive payslip
 * reader guards restated so their reader setting is decided without a SECURITY DEFINER call per row.
 *
 * Fixture (the Transaction View scale shape, SCALE rules 2 and 3): 70 companies, 1,000 employments, four monthly runs
 * per company, employees who moved company after they were paid, and payslips carrying an imported tax-basis stamp.
 * Real grants for a group administrator, a one-company administrator, a one-company Payroll partner and an employee
 * reading as themself. Fictional people only. Counts are derived from the fixture constants.
 *
 * Proves, for every actor and in each mode:
 *  - installing changes nothing (every step 'legacy', policies exactly as before, owner-only tables and functions);
 *  - the same payslip rows, History rows and order, and the same plan shape (the planner's estimates do not move);
 *  - without the reader settings, the same rows raise the same error;
 *  - the every-user comparison finds no difference; a difference marks the tenant untrusted and the restated arm then
 *    calls the legacy function; re-trust needs a clean comparison;
 *  - the mode setter refuses a policy that differs from its recorded text;
 *  - P1 adds no maintenance to any payroll write (section 11.6: its save cost is nil by construction).
 */
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {adminCtx,closeAll,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {listProcessedPayslipsAcross} from '../core/payroll-view';

const STEP='p1_tax_reader_guards';
const COMPANIES=70,N=1000,PERIODS=['2026-08','2026-09','2026-10','2026-11'] as const;
const companyOf=(n:number)=>(n-1)%COMPANIES,moved=(n:number)=>companyOf(n)===0&&((n-1)/COMPANIES)%2===0;
const stamped=(n:number)=>n%10===0;
const employees=Array.from({length:N},(_,i)=>i+1);
const allSlips=N*PERIODS.length;
const stampedSlips=employees.filter(stamped).length;

let b:Base;
const f={companies:[] as string[],emp:[] as string[],users:{} as Record<'group'|'narrow'|'partner'|'self',string>,selfPerson:''};
const setMode=async(mode:'legacy'|'shadow'|'precomputed')=>{await owner.client`select app.payroll_read_access_set_mode(${STEP},${mode})`;};

beforeAll(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');
 const T=b.tenantId;
 await owner.client.begin(async tx=>{
  await tx`set local session_replication_role = replica`;
  const others=await tx<{id:string}[]>`insert into company(tenant_id,legal_name) select ${T}::uuid,'P1 shape company '||lpad(n::text,2,'0') from generate_series(1,${COMPANIES-1}::integer) n order by n returning id`;
  f.companies=[b.companyId,...others.map(row=>row.id)];
  await tx`with people as(insert into person(tenant_id,full_name,primary_email) select ${T}::uuid,'P1 shape person '||lpad(n::text,4,'0'),'p1-shape-'||n||'@fixture.invalid' from generate_series(1,${N}::integer) n returning id,full_name)
   insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${T}::uuid,id,(${f.companies}::uuid[])[1+((right(full_name,4)::int-1)%${COMPANIES}::integer)],'P1-'||right(full_name,4),'2025-01-01'::date from people`;
  f.emp=(await tx<{id:string}[]>`select id from employment where tenant_id=${T}::uuid and employee_code like 'P1-%' order by employee_code`).map(row=>row.id);
  await tx`insert into pay_period(tenant_id,company_id,period,status) select ${T}::uuid,c,p,'closed' from unnest(${f.companies}::uuid[]) c cross join unnest(${[...PERIODS]}::text[]) p`;
  await tx`insert into payroll_batch(tenant_id,company_id,pay_period_id,pay_period,batch_date,status,released_at,run_type,run_seq)
   select pp.tenant_id,pp.company_id,pp.id,pp.period,(pp.period||'-25')::date,'closed',now(),'regular',1 from pay_period pp where pp.tenant_id=${T}::uuid and pp.company_id=any(${f.companies}::uuid[])`;
  // Every tenth employee's slips carry an imported tax-basis stamp (6660), which the import guard inspects.
  await tx`insert into payslip(tenant_id,batch_id,employment_id,basic_salary,gross_pay,statutory,total_deductions,net_pay,employer_cost)
   select ${T}::uuid,pb.id,e.id,'3000.00','3000.00',
    case when right(e.employee_code,4)::int%10=0 then '{"importedTaxBasis":{"version":1,"source":"fictional"}}'::jsonb else '{}'::jsonb end,'0.00','3000.00','3000.00'
   from employment e join payroll_batch pb on pb.company_id=e.company_id and pb.tenant_id=e.tenant_id where e.tenant_id=${T}::uuid and e.employee_code like 'P1-%'`;
  await tx`update employment set company_id=${f.companies[1]} where id=any(${f.emp.filter((_,i)=>moved(i+1))}::uuid[])`;
  f.users={group:randomUUID(),narrow:randomUUID(),partner:randomUUID(),self:randomUUID()};
  f.selfPerson=(await tx<{id:string}[]>`select person_id as id from employment where id=${f.emp[0]}`)[0].id;
  await tx`insert into app_user(id,tenant_id,workos_user_id,person_id) values(${f.users.group},${T},${'user_'+randomUUID()},null),(${f.users.narrow},${T},${'user_'+randomUUID()},null),
   (${f.users.partner},${T},${'user_'+randomUUID()},null),(${f.users.self},${T},${'user_'+randomUUID()},${f.selfPerson})`;
  await tx`insert into role_assignment(tenant_id,app_user_id,company_id,role) values(${T},${f.users.group},null,'hr_admin'),(${T},${f.users.narrow},${f.companies[0]},'hr_admin'),
   (${T},${f.users.partner},${f.companies[1]},'payroll_partner'),(${T},${f.users.self},null,'employee')`;
 });
 // Fixed statistics before any baseline: an autovacuum analyse between the legacy and switched reads would change the
 // planner's estimates (and plans) for reasons unrelated to the rule text.
 await owner.client`analyze company,person,employment,pay_period,payroll_batch,payslip,app_user,role_assignment`;
},300_000);
afterAll(async()=>{try{await setMode('legacy');await owner.client`delete from payroll_read_access_tenant`;}finally{await closeAll();}});

const roles:Record<string,()=>SessionContext>={
 all:()=>adminCtx(b),
 group:()=>({...adminCtx(b),userId:f.users.group,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]}),
 narrow:()=>({...adminCtx(b),userId:f.users.narrow,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:f.companies[0]}]}),
 partner:()=>({...adminCtx(b),userId:f.users.partner,roles:['payroll_partner'],grants:[{role:'payroll_partner',companyId:f.companies[1]}]}),
 self:()=>({...adminCtx(b),userId:f.users.self,personId:f.selfPerson,roles:['employee'],grants:[{role:'employee',companyId:null}]}),
};
const visibleSlips=(ctx:SessionContext)=>withTenant(ctx,async tx=>(await tx.execute<{id:string}>(sql`select id::text from payslip order by id`)).map(row=>row.id));
const history=(ctx:SessionContext)=>listProcessedPayslipsAcross(ctx,{companyIds:f.companies,year:2026,month:11});

/** A transaction as the application role with the identity withTenant sets, the reader settings as given; always
 * rolled back. Returns the body's value or the error it raised. */
class Done{constructor(readonly value:unknown){}}
async function asApp<T>(ctx:SessionContext,readers:'1'|'',body:(tx:Tx)=>Promise<T>):Promise<{value?:T;error?:{code:string;message:string}}>{
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
 }catch(error){if(error instanceof Done)return error.value as {value?:T;error?:{code:string;message:string}};throw error;}
 throw new Error('the application-role transaction did not run');
}
const legacyGuardCalls=async(tx:Tx)=>Number((await tx.execute<{calls:number}>(sql`select coalesce(sum(calls),0)::int as calls from pg_stat_xact_user_functions
 where schemaname='app' and funcname in ('payroll_tax_basis_reader_compatible','payroll_import_tax_reader_compatible')`))[0]?.calls??0);

/** The main plan tree's node types, relations, join order and row estimates, without InitPlan subtrees or costs. */
type PlanNode={'Node Type':string;'Relation Name'?:string;'Plan Rows':number;'Parent Relationship'?:string;'Join Type'?:string;Plans?:PlanNode[]};
const skeleton=(node:PlanNode):unknown=>({type:node['Node Type'],rel:node['Relation Name']??null,join:node['Join Type']??null,rows:node['Plan Rows'],
 children:(node.Plans??[]).filter(child=>child['Parent Relationship']!=='InitPlan').map(skeleton)});
const HISTORY_SHAPE=(companies:string[])=>sql`select p.id from payslip p join payroll_batch pb on pb.id=p.batch_id join company c on c.id=pb.company_id
 join employment e on e.id=p.employment_id join person pe on pe.id=e.person_id
 where pb.company_id = any(${'{'+companies.join(',')+'}'}::uuid[]) and pb.pay_period='2026-11' order by pb.pay_period desc,pb.run_seq,pe.full_name`;
/** The value of an application-role transaction, which must not have failed. */
const must=<T>(o:{value?:T;error?:{code:string;message:string}}):T=>{if(o.error)throw new Error(`application-role read failed: ${o.error.code} ${o.error.message}`);return o.value as T;};
const plan=async(ctx:SessionContext)=>must(await asApp(ctx,'1',async tx=>{
 const [row]=await tx.execute<{'QUERY PLAN':{Plan:PlanNode}[]}>(sql`explain (format json) ${HISTORY_SHAPE(f.companies)}`);
 return skeleton(row['QUERY PLAN'][0].Plan);
}));
const median=(xs:number[])=>[...xs].sort((x,y)=>x-y)[Math.floor(xs.length/2)];

describe('payroll read switch and P1 reader guards (7460)',()=>{
 it('installs inert: every step legacy, policies unchanged, owner-only tables and operator functions',async()=>{
  expect(await owner.client`select step,mode from payroll_read_access_control where step=${STEP}`).toEqual([{step:STEP,mode:'legacy'}]);
  const tables=await owner.client<{name:string;app:boolean;rls:boolean;forced:boolean}[]>`select c.relname as name,has_table_privilege('ai_hr_app',c.oid,'SELECT') as app,c.relrowsecurity as rls,c.relforcerowsecurity as forced
   from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' and c.relname like 'payroll\\_read\\_access\\_%' order by 1`;
  expect(tables).toEqual(['payroll_read_access_control','payroll_read_access_fragment','payroll_read_access_tenant'].map(name=>({name,app:false,rls:true,forced:true})));
  const policies=await owner.client<{name:string;qual:string}[]>`select polname as name,pg_get_expr(polqual,polrelid) as qual from pg_policy
   where polrelid='public.payslip'::regclass and polname in ('payroll_tax_basis_reader_guard','payroll_import_tax_basis_reader_guard') order by 1`;
  expect(policies).toEqual([
   {name:'payroll_import_tax_basis_reader_guard',qual:"app.payroll_import_tax_reader_compatible(employment_id, batch_id, (statutory -> 'importedTaxBasis'::text))"},
   {name:'payroll_tax_basis_reader_guard',qual:'app.payroll_tax_basis_reader_compatible(employment_id, batch_id)'},
  ]);
  const fns=await owner.client<{fn:string;app:boolean;pub:boolean;definer:boolean}[]>`select p.oid::regprocedure::text as fn,has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app,
   exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as pub,p.prosecdef as definer
   from pg_proc p where p.pronamespace='app'::regnamespace and (p.proname like 'payroll_read_access_%' or p.proname in ('payroll_tax_basis_reader_arm','payroll_import_tax_reader_arm')) order by 1`;
  expect(fns).toEqual([
   {fn:'app.payroll_import_tax_reader_arm(uuid,uuid,jsonb,boolean)',app:true,pub:false,definer:false},
   {fn:'app.payroll_read_access_compare(text,uuid)',app:false,pub:false,definer:true},
   {fn:'app.payroll_read_access_forced(text)',app:false,pub:false,definer:true},
   {fn:'app.payroll_read_access_installed_as(text,text,text)',app:false,pub:false,definer:true},
   {fn:'app.payroll_read_access_on(text)',app:true,pub:false,definer:true},
   {fn:'app.payroll_read_access_policy_text(text,text,jsonb)',app:false,pub:false,definer:true},
   {fn:'app.payroll_read_access_retrust(text,uuid)',app:false,pub:false,definer:true},
   {fn:'app.payroll_read_access_set_mode(text,text)',app:false,pub:false,definer:true},
   {fn:'app.payroll_tax_basis_reader_arm(uuid,uuid,boolean)',app:true,pub:false,definer:false},
  ]);
  // The arms keep the planner's view of the functions they stand for.
  const shape=await owner.client<{fn:string;cost:number;vol:string;par:string}[]>`select proname as fn,procost::int as cost,provolatile as vol,proparallel as par from pg_proc
   where pronamespace='app'::regnamespace and proname in ('payroll_tax_basis_reader_arm','payroll_import_tax_reader_arm','payroll_tax_basis_reader_compatible','payroll_import_tax_reader_compatible') order by 1`;
  expect(new Set(shape.map(row=>`${row.cost}/${row.vol}/${row.par}`))).toEqual(new Set(['100/s/u']));
 });

 it('the fixture has the shape the counts are derived from',async()=>{
  const [row]=await owner.client<{slips:number;stamped:number;companies:number}[]>`select count(*)::int as slips,count(*) filter (where statutory ? 'importedTaxBasis')::int as stamped,
   count(distinct (select company_id from payroll_batch pb where pb.id=batch_id))::int as companies from payslip where tenant_id=${b.tenantId}`;
  expect(row).toEqual({slips:allSlips,stamped:stampedSlips*PERIODS.length,companies:COMPANIES});
 });

 it('serves the same payslips, History rows and plan shape in every mode, for every actor, without per-row guard calls when switched',async()=>{
  const legacy:Record<string,{slips:string[];history:unknown;plan:unknown}>={};
  for(const [role,ctx] of Object.entries(roles))legacy[role]={slips:await visibleSlips(ctx()),history:await history(ctx()),plan:await plan(ctx())};
  // Independent expectations: the group administrator sees every payslip; the one-company readers a strict part.
  expect(legacy.group.slips).toHaveLength(allSlips);
  expect(legacy.narrow.slips.length).toBeGreaterThan(0);expect(legacy.narrow.slips.length).toBeLessThan(allSlips);
  expect(legacy.self.slips).toHaveLength(PERIODS.length);
  for(const mode of ['shadow','precomputed'] as const){
   await setMode(mode);
   for(const [role,ctx] of Object.entries(roles)){
    expect(await visibleSlips(ctx()),`${mode} / ${role} payslips`).toEqual(legacy[role].slips);
    expect(await history(ctx()),`${mode} / ${role} History`).toEqual(legacy[role].history);
    expect(await plan(ctx()),`${mode} / ${role} plan`).toEqual(legacy[role].plan);
   }
  }
  // Switched, a full read calls neither legacy guard; in legacy mode it calls them for every payslip read.
  const calls=async()=>must(await asApp(roles.group(),'1',async tx=>{const before=await legacyGuardCalls(tx);await tx.execute(sql`select count(*) from payslip`);return(await legacyGuardCalls(tx))-before;}));
  expect(await calls()).toBe(0);
  await setMode('legacy');
  expect(await calls()).toBeGreaterThanOrEqual(allSlips);
 },900_000);

 it('raises the same error on the same rows without the reader settings, in every mode',async()=>{
  const probe=async(ctx:SessionContext,stampedOnly:boolean)=>asApp(ctx,'',async tx=>(await tx.execute<{n:number}>(stampedOnly
   ?sql`select count(*)::int as n from payslip where statutory ? 'importedTaxBasis'`:sql`select count(*)::int as n from payslip where not (statutory ? 'importedTaxBasis')`))[0].n);
  const outcomes=async()=>{const out:Record<string,unknown>={};for(const [role,ctx] of Object.entries(roles))for(const s of [true,false])out[`${role}/${s}`]=await probe(ctx(),s);return out;};
  await setMode('legacy');
  const before=await outcomes();
  // Row security runs before the query's own filter, so a reader who can see a stamped payslip is refused whatever it
  // asks for; a reader who sees none is not. Employment n = 1 + 70k (company 0) is never a multiple of ten, so the
  // one-company administrator of company 0 sees no stamped payslip, and the employee (n = 1) none of their own.
  expect((before['group/true'] as {error?:{code:string}}).error?.code).toBe('55000');
  expect((before['group/false'] as {error?:{code:string}}).error?.code).toBe('55000');
  expect((before['narrow/true'] as {value?:number}).value).toBe(0);
  expect((before['self/false'] as {value?:number}).value).toBe(PERIODS.length);
  await setMode('precomputed');
  expect(await outcomes()).toEqual(before);
  await setMode('legacy');
 },600_000);

 it('the every-user comparison is clean; a difference falls back to the legacy function, and re-trust needs a clean comparison',async()=>{
  const [{users}]=await owner.client<{users:number}[]>`select count(*)::int as users from app_user where tenant_id=${b.tenantId}`;
  const [result]=await owner.client<{r:Record<string,unknown>}[]>`select app.payroll_read_access_compare(${STEP},${b.tenantId}::uuid) as r`;
  expect(result.r).toMatchObject({step:STEP,users,valuesDiffer:0,raisesDiffer:0,trusted:true});
  expect(Number(result.r.evaluations)).toBeGreaterThanOrEqual(users*2*allSlips);
  await setMode('precomputed');
  const calls=async()=>must(await asApp(roles.group(),'1',async tx=>{const before=await legacyGuardCalls(tx);await tx.execute(sql`select count(*) from payslip`);return(await legacyGuardCalls(tx))-before;}));
  expect(await calls()).toBe(0);
  // Untrusted: the restated arms call the legacy function, and the answer is unchanged.
  await owner.client`update payroll_read_access_tenant set trusted=false where tenant_id=${b.tenantId} and step=${STEP}`;
  expect(await calls()).toBeGreaterThanOrEqual(allSlips);
  expect(await visibleSlips(roles.group())).toHaveLength(allSlips);
  const [again]=await owner.client<{r:Record<string,unknown>}[]>`select app.payroll_read_access_compare(${STEP},${b.tenantId}::uuid) as r`;
  expect(again.r).toMatchObject({valuesDiffer:0,raisesDiffer:0,trusted:false});
  const [retrusted]=await owner.client<{r:Record<string,unknown>}[]>`select app.payroll_read_access_retrust(${STEP},${b.tenantId}::uuid) as r`;
  expect(retrusted.r).toMatchObject({valuesDiffer:0,raisesDiffer:0,trusted:true});
  expect(await calls()).toBe(0);
  await setMode('legacy');
 },1_800_000);

 it('refuses to switch over a policy that differs from its recorded text, and leaves it untouched',async()=>{
  const drifted=owner.client.begin(async tx=>{
   await tx`alter policy payroll_tax_basis_reader_guard on public.payslip using (true)`;
   await tx`select app.payroll_read_access_set_mode(${STEP},'precomputed')`;
  });
  await expect(drifted).rejects.toMatchObject({code:'55000'});
  expect(await owner.client`select mode from payroll_read_access_control where step=${STEP}`).toEqual([{mode:'legacy'}]);
  const [qual]=await owner.client<{q:string}[]>`select pg_get_expr(polqual,polrelid) as q from pg_policy where polrelid='public.payslip'::regclass and polname='payroll_tax_basis_reader_guard'`;
  expect(qual.q).toBe('app.payroll_tax_basis_reader_compatible(employment_id, batch_id)');
  await expect(owner.client`select app.payroll_read_access_set_mode(${STEP},'fast')`).rejects.toMatchObject({code:'22023'});
  await expect(owner.client`select app.payroll_read_access_set_mode('no_such_step','legacy')`).rejects.toMatchObject({code:'22023'});
 });

 it('reads at least as fast switched as legacy at 70 companies and 1,000 employments (old vs new rule text)',async()=>{
  const time=async(mode:'legacy'|'precomputed')=>{await setMode(mode);const out:number[]=[];
   for(let i=0;i<5;i++){const t=performance.now();must(await asApp(roles.group(),'1',async tx=>tx.execute(HISTORY_SHAPE(f.companies))));await visibleSlips(roles.partner());out.push(performance.now()-t);}
   return median(out);};
  await time('legacy');
  const legacy=await time('legacy'),switched=await time('precomputed');
  await setMode('legacy');
  console.info('PAYROLL_READ_P1_TIMING',JSON.stringify({legacyMs:Math.round(legacy),precomputedMs:Math.round(switched)}));
  expect(switched).toBeLessThanOrEqual(legacy*1.1+20);
 },600_000);

 it('adds no maintenance to any payroll write (save cost nil by construction)',async()=>{
  const triggers=await owner.client<{t:string}[]>`select tgrelid::regclass::text||'.'||tgname as t from pg_trigger t join pg_proc p on p.oid=t.tgfoid
   where not t.tgisinternal and (p.proname like 'payroll\\_read\\_access%' or p.proname in ('payroll_tax_basis_reader_arm','payroll_import_tax_reader_arm'))`;
  expect(triggers).toEqual([]);
 });
});
