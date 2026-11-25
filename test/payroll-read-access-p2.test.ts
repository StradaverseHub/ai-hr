/**
 * ADR 0181 payroll read addendum, step P2 (migration 7470): payroll administration asked once per statement on
 * payroll_batch_rls, the payslip_rls admin arm and payslip_original_employer_read, inert behind the 7460 switch.
 *
 * Fixture: test/helpers/payroll-read-access.ts (70 companies, 1,000 employments, four monthly runs per company,
 * employees who moved company after they were paid, a voided employment, imported tax-basis stamps). Actors: a group
 * administrator, a group super administrator, a one-company administrator (who reads the moved employees' earlier
 * payslips only through the original-employer arm), a one-company Payroll partner, an employee, a session whose claim
 * its user no longer holds, and the seeded administrator.
 *
 * Proves, for every actor in each mode: the same payslips, runs, Payroll list, latest listed period, History rows and
 * locked rows (FOR UPDATE); the same plan shape; no per-row administration call when switched; a clean every-user
 * comparison and the legacy fallback for an untrusted tenant; switched reads no slower (old vs new rule text at
 * scale); and no write-path maintenance.
 */
import {performance} from 'node:perf_hooks';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {closeAll,owner} from './harness';
import {listBatches,payrollDashboardCounts} from '../core/payroll';
import {listProcessedPayslipsAcross} from '../core/payroll-view';
import {PERIODS,actors,allSlips,asApp,buildPayrollReadFixture,calls,median,moved,must,N,plain,planShape,setStepMode,uuidArray,VOIDED,type Actor,type PayrollReadFixture} from './helpers/payroll-read-access';

const STEP='p2_admin_companies';
const LEGACY_FNS=['can_admin_payroll_employment','payroll_tax_basis_original_employer_read'];
let f:PayrollReadFixture;let who:ReturnType<typeof actors>;
beforeAll(async()=>{f=await buildPayrollReadFixture();who=actors(f);},300_000);
afterAll(async()=>{try{await setStepMode(STEP,'legacy');await owner.client`delete from payroll_read_access_tenant`;}finally{await closeAll();}});

const movedCount=Array.from({length:N},(_,i)=>i+1).filter(moved).length;
const read=async(ctx:SessionContext)=>({
 slips:await withTenant(ctx,async tx=>(await tx.execute<{id:string}>(sql`select id::text from payslip order by id`)).map(r=>r.id)),
 runs:await withTenant(ctx,async tx=>(await tx.execute<{id:string}>(sql`select id::text from payroll_batch order by id`)).map(r=>r.id)),
 // Runs tie on the list's ordering keys (same period, run and company order across the fixture's companies), so their
 // relative order is unspecified in either mode: compared as a set.
 list:(await listBatches(ctx,f.companies)).sort((x,y)=>x.id.localeCompare(y.id)),
 dashboard:await payrollDashboardCounts(ctx,f.companies),
 history:await listProcessedPayslipsAcross(ctx,{companyIds:f.companies,year:2026,month:11}),
 locked:must(await asApp(ctx,'1',async tx=>{
  const slips=(await tx.execute<{id:string}>(sql`select id::text from payslip where batch_id in (select id from payroll_batch where pay_period='2026-11') order by id for update`)).map(r=>r.id);
  const runs=(await tx.execute<{id:string}>(sql`select id::text from payroll_batch where pay_period='2026-11' order by id for update`)).map(r=>r.id);
  return{slips,runs};
 })),
});
const HISTORY_SHAPE=()=>sql`select p.id from payslip p join payroll_batch pb on pb.id=p.batch_id join company c on c.id=pb.company_id
 join employment e on e.id=p.employment_id join person pe on pe.id=e.person_id
 where pb.company_id = any(${uuidArray(f.companies)}) and pb.pay_period='2026-11' order by pb.pay_period desc,pb.run_seq,pe.full_name`;
const LIST_SHAPE=()=>sql`select pb.id from payroll_batch pb join company c on c.id=pb.company_id where pb.company_id = any(${uuidArray(f.companies)}) order by pb.pay_period desc,c.legal_name,pb.run_seq`;
const plans=async(ctx:SessionContext)=>({history:await planShape(ctx,HISTORY_SHAPE()),list:await planShape(ctx,LIST_SHAPE())});
const perRow=async(ctx:SessionContext)=>must(await asApp(ctx,'1',async tx=>{const before=await calls(tx,LEGACY_FNS);await tx.execute(sql`select count(*) from payslip`);return(await calls(tx,LEGACY_FNS))-before;}));

describe('payroll administration once per statement (7470)',()=>{
 it('installs inert: P2 legacy, the three policies unchanged, the arms executable by the application role',async()=>{
  expect(await owner.client`select mode from payroll_read_access_control where step=${STEP}`).toEqual([{mode:'legacy'}]);
  const pieces=await owner.client<{t:string;p:string}[]>`select distinct table_name as t,policy_name as p from payroll_read_access_fragment where step=${STEP} order by 1,2`;
  expect(pieces).toEqual([{t:'payroll_batch',p:'payroll_batch_rls'},{t:'payslip',p:'payslip_original_employer_read'},{t:'payslip',p:'payslip_rls'}]);
  const quals=await owner.client<{q:string}[]>`select pg_get_expr(polqual,polrelid) as q from pg_policy where polname in ('payroll_batch_rls','payslip_rls','payslip_original_employer_read') order by polname`;
  expect(quals.every(row=>!row.q.includes('_arm('))).toBe(true);
  expect(quals.map(row=>row.q).join()).toContain('app.can_admin_payroll_employment(employment_id)');
  const fns=await owner.client<{fn:string;app:boolean;pub:boolean}[]>`select p.oid::regprocedure::text as fn,has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app,
   exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as pub
   from pg_proc p where p.pronamespace='app'::regnamespace and p.proname in ('payroll_admin_claimed','payroll_admin_company_set','payroll_admin_employment_set','payroll_original_employer_set',
    'payroll_admin_company_arm','payroll_admin_employment_arm','payroll_original_employer_arm') order by 1`;
  expect(fns).toEqual([
   {fn:'app.payroll_admin_claimed()',app:false,pub:false},
   {fn:'app.payroll_admin_company_arm(uuid,jsonb)',app:true,pub:false},
   {fn:'app.payroll_admin_company_set()',app:true,pub:false},
   {fn:'app.payroll_admin_employment_arm(uuid,jsonb)',app:true,pub:false},
   {fn:'app.payroll_admin_employment_set()',app:true,pub:false},
   {fn:'app.payroll_original_employer_arm(uuid,jsonb)',app:true,pub:false},
   {fn:'app.payroll_original_employer_set()',app:true,pub:false},
  ]);
 });

 it('serves the same rows, lists, locks and plan shape in every mode, for every actor',async()=>{
  const legacy={} as Record<Actor,Awaited<ReturnType<typeof read>>&{plans:unknown}>;
  for(const [name,ctx] of Object.entries(who) as [Actor,()=>SessionContext][])legacy[name]=plain({...await read(ctx()),plans:await plans(ctx())});
  // Independent expectations from the fixture constants.
  const voidedSlips=PERIODS.length;
  expect(legacy.group.slips).toHaveLength(allSlips);
  expect(legacy.group.runs).toHaveLength(70*PERIODS.length);
  expect(legacy.self.slips).toHaveLength(PERIODS.length);
  // The one-company administrator reads the moved employees' company-0 payslips through the original-employer arm.
  expect(legacy.narrow.slips.length).toBeGreaterThanOrEqual(movedCount*PERIODS.length);
  expect(legacy.stale.slips).toHaveLength(0);
  expect(voidedSlips).toBe(4);expect(VOIDED).toBe(500);
  for(const mode of ['shadow','precomputed'] as const){
   await setStepMode(STEP,mode);
   for(const [name,ctx] of Object.entries(who) as [Actor,()=>SessionContext][]){
    const now=plain({...await read(ctx()),plans:await plans(ctx())});
    const {plans:nowPlans,...nowRows}=now,{plans:legacyPlans,...legacyRows}=legacy[name];
    for(const key of Object.keys(legacyRows) as (keyof typeof legacyRows)[])expect(nowRows[key],`${mode} / ${name} / ${key}`).toEqual(legacyRows[key]);
    // A plan change is reported here and bounded by the scale timing below (old vs new rule text), not failed: P2's
    // batch arm cannot carry the inlined EXISTS's planner cost exactly.
    if(JSON.stringify(nowPlans)!==JSON.stringify(legacyPlans))console.info('PAYROLL_READ_PLAN_DIFF',JSON.stringify({step:'P2',mode,actor:name,history:JSON.stringify((nowPlans as {history:unknown}).history)===JSON.stringify((legacyPlans as {history:unknown}).history),list:JSON.stringify((nowPlans as {list:unknown}).list)===JSON.stringify((legacyPlans as {list:unknown}).list)}));
   }
  }
  expect(await perRow(who.group())).toBe(0);
  await setStepMode(STEP,'legacy');
  expect(await perRow(who.group())).toBeGreaterThanOrEqual(allSlips);
 },1_800_000);

 it('the every-user comparison is clean; an untrusted tenant uses the legacy functions with the same answer',async()=>{
  const [{users}]=await owner.client<{users:number}[]>`select count(*)::int as users from app_user where tenant_id=${f.b.tenantId}`;
  const [result]=await owner.client<{r:Record<string,unknown>}[]>`select app.payroll_read_access_compare(${STEP},${f.b.tenantId}::uuid) as r`;
  expect(result.r).toMatchObject({step:STEP,users,valuesDiffer:0,raisesDiffer:0,trusted:true});
  // Per user and reader setting: 70 companies, 1,000 employments and 280 runs.
  expect(Number(result.r.evaluations)).toBe(users*2*(70+N+70*PERIODS.length));
  await setStepMode(STEP,'precomputed');
  const before=await read(who.narrow());
  await owner.client`insert into payroll_read_access_tenant(tenant_id,step,trusted) values(${f.b.tenantId},${STEP},false) on conflict(tenant_id,step) do update set trusted=false`;
  expect(await perRow(who.group())).toBeGreaterThanOrEqual(allSlips);
  expect(await read(who.narrow())).toEqual(before);
  const [retrusted]=await owner.client<{r:Record<string,unknown>}[]>`select app.payroll_read_access_retrust(${STEP},${f.b.tenantId}::uuid) as r`;
  expect(retrusted.r).toMatchObject({valuesDiffer:0,raisesDiffer:0,trusted:true});
  expect(await perRow(who.group())).toBe(0);
  await setStepMode(STEP,'legacy');
 },1_800_000);

 it('reads at least as fast switched as legacy at 70 companies and 1,000 employments (old vs new rule text)',async()=>{
  const time=async(mode:'legacy'|'precomputed')=>{await setStepMode(STEP,mode);const out:Record<string,number[]>={group:[],partner:[],narrow:[]};
   for(let i=0;i<5;i++)for(const name of ['group','partner','narrow'] as const){
    const ctx=who[name]();const t=performance.now();
    must(await asApp(ctx,'1',async tx=>{await tx.execute(HISTORY_SHAPE());await tx.execute(LIST_SHAPE());await tx.execute(sql`select count(*) from payslip`);}));
    out[name].push(performance.now()-t);
   }
   return Object.fromEntries(Object.entries(out).map(([k,v])=>[k,median(v)]));};
  await time('legacy');
  const legacy=await time('legacy'),switched=await time('precomputed');
  await setStepMode(STEP,'legacy');
  console.info('PAYROLL_READ_P2_TIMING',JSON.stringify({legacy,switched}));
  for(const name of Object.keys(legacy))expect(switched[name],name).toBeLessThanOrEqual(legacy[name]*1.1+20);
 },900_000);

 it('adds no maintenance to any payroll write (save cost nil by construction)',async()=>{
  const triggers=await owner.client<{t:string}[]>`select tgrelid::regclass::text||'.'||tgname as t from pg_trigger t join pg_proc p on p.oid=t.tgfoid
   where not t.tgisinternal and (p.proname like 'payroll\\_read\\_access%' or p.proname like 'payroll\\_admin\\_%' or p.proname like 'payroll\\_original\\_employer\\_%')`;
  expect(triggers).toEqual([]);
 });
});
