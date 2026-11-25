/**
 * ADR 0181 payroll read addendum, step P3 (migration 7480): the payslip_rls own-payslip arm asked once per statement,
 * inert behind the 7460 switch. P2 and P3 both edit payslip_rls, so every combination of their modes is compared.
 *
 * Fixture: test/helpers/payroll-read-access.ts (70 companies, 1,000 employments, four monthly runs per company,
 * employees who moved company after they were paid, a voided employment, imported tax-basis stamps). Actors: as P2's
 * test; the own-payslip arm decides most rows for the employee and for the one-company readers.
 *
 * Proves, for every actor in each mode: the same payslips, runs, Payroll list, latest listed period, History rows and
 * locked rows (FOR UPDATE); the same plan shape; no per-row own-payslip probe when switched; a clean every-user
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
import {PERIODS,actors,allSlips,asApp,buildPayrollReadFixture,median,moved,must,N,plain,planShape,setStepMode,uuidArray,VOIDED,type Actor,type PayrollReadFixture} from './helpers/payroll-read-access';

const STEP='p3_own_payslips',P2='p2_admin_companies';
let f:PayrollReadFixture;let who:ReturnType<typeof actors>;
beforeAll(async()=>{f=await buildPayrollReadFixture();who=actors(f);},300_000);
afterAll(async()=>{try{await setStepMode(STEP,'legacy');await setStepMode(P2,'legacy');await owner.client`delete from payroll_read_access_tenant`;}finally{await closeAll();}});

const movedCount=Array.from({length:N},(_,i)=>i+1).filter(moved).length;
const read=async(ctx:SessionContext)=>({
 slips:await withTenant(ctx,async tx=>(await tx.execute<{id:string}>(sql`select id::text from payslip order by id`)).map(r=>r.id)),
 runs:await withTenant(ctx,async tx=>(await tx.execute<{id:string}>(sql`select id::text from payroll_batch order by id`)).map(r=>r.id)),
 // Runs tie on the list's ordering keys, so their relative order is unspecified in either mode: compared as a set.
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
/** Whether payslip_rls carries the restated own-payslip arm (the step is switched for every tenant). */
const switchedText=async()=>(await owner.client<{q:string}[]>`select pg_get_expr(polqual,polrelid) as q from pg_policy where polrelid='public.payslip'::regclass and polname='payslip_rls'`)[0].q.includes('payroll_self_person_arm');

describe('own payslips once per statement (7480)',()=>{
 it('installs inert: P3 legacy, payslip_rls unchanged, its pieces split around the own-payslip arm',async()=>{
  expect(await owner.client`select mode from payroll_read_access_control where step=${STEP}`).toEqual([{mode:'legacy'}]);
  const pieces=await owner.client<{o:number;s:string|null}[]>`select ordinal as o,step as s from payroll_read_access_fragment where table_name='payslip' and policy_name='payslip_rls' order by 1`;
  expect(pieces).toEqual([{o:1,s:null},{o:2,s:P2},{o:3,s:null},{o:4,s:STEP},{o:5,s:null}]);
  const [qual]=await owner.client<{q:string}[]>`select pg_get_expr(polqual,polrelid) as q from pg_policy where polrelid='public.payslip'::regclass and polname='payslip_rls'`;
  expect(qual.q).toContain('app.is_self_person(e.person_id)');expect(qual.q).not.toContain('_arm(');
  const fns=await owner.client<{fn:string;app:boolean;pub:boolean;definer:boolean}[]>`select p.oid::regprocedure::text as fn,has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app,
   exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as pub,p.prosecdef as definer
   from pg_proc p where p.pronamespace='app'::regnamespace and p.proname in ('payroll_self_person_ids','payroll_self_person_arm') order by 1`;
  expect(fns).toEqual([
   {fn:'app.payroll_self_person_arm(uuid,uuid[])',app:true,pub:false,definer:false},
   {fn:'app.payroll_self_person_ids()',app:true,pub:false,definer:true},
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
  for(const [p2,p3] of [['legacy','shadow'],['legacy','precomputed'],['precomputed','legacy'],['precomputed','precomputed']] as const){
   await setStepMode(P2,p2);await setStepMode(STEP,p3);
   for(const [name,ctx] of Object.entries(who) as [Actor,()=>SessionContext][]){
    const now=plain({...await read(ctx()),plans:await plans(ctx())});
    const {plans:nowPlans,...nowRows}=now,{plans:legacyPlans,...legacyRows}=legacy[name];
    expect(nowRows,`P2 ${p2} / P3 ${p3} / ${name}`).toEqual(legacyRows);
    // P3 alone keeps the legacy sub-plan, so its plans must not move; with P2 switched too, P2's own plan changes are
    // reported (and bounded by the scale timing below), not failed here.
    if(p2==='legacy')expect(nowPlans,`plans: P3 ${p3} / ${name}`).toEqual(legacyPlans);
    else if(JSON.stringify(nowPlans)!==JSON.stringify(legacyPlans))console.info('PAYROLL_READ_PLAN_DIFF',JSON.stringify({step:'P2+P3',actor:name}));
   }
  }
  // The switch is real: precomputed installs the restated arm, legacy removes it.
  await setStepMode(P2,'legacy');
  expect(await switchedText()).toBe(true);
  await setStepMode(STEP,'legacy');
  expect(await switchedText()).toBe(false);
 },1_800_000);

 it('the every-user comparison is clean; an untrusted tenant uses the legacy functions with the same answer',async()=>{
  const [{users}]=await owner.client<{users:number}[]>`select count(*)::int as users from app_user where tenant_id=${f.b.tenantId}`;
  const [result]=await owner.client<{r:Record<string,unknown>}[]>`select app.payroll_read_access_compare(${STEP},${f.b.tenantId}::uuid) as r`;
  expect(result.r).toMatchObject({step:STEP,users,valuesDiffer:0,raisesDiffer:0,trusted:true});
  // Per user and reader setting: the 1,000 employments with payslips.
  expect(Number(result.r.evaluations)).toBe(users*2*N);
  await setStepMode(STEP,'precomputed');
  const before=await read(who.narrow());
  await owner.client`insert into payroll_read_access_tenant(tenant_id,step,trusted) values(${f.b.tenantId},${STEP},false) on conflict(tenant_id,step) do update set trusted=false`;
  expect(await switchedText()).toBe(true);
  expect(await read(who.narrow())).toEqual(before);
  const [retrusted]=await owner.client<{r:Record<string,unknown>}[]>`select app.payroll_read_access_retrust(${STEP},${f.b.tenantId}::uuid) as r`;
  expect(retrusted.r).toMatchObject({valuesDiffer:0,raisesDiffer:0,trusted:true});
  await setStepMode(STEP,'legacy');
 },1_800_000);

 it('reads at least as fast switched as legacy at 70 companies and 1,000 employments (old vs new rule text)',async()=>{
  const time=async(mode:'legacy'|'precomputed')=>{await setStepMode(STEP,mode);const out:Record<string,number[]>={group:[],partner:[],narrow:[],self:[]};
   for(let i=0;i<5;i++)for(const name of ['group','partner','narrow','self'] as const){
    const ctx=who[name]();const t=performance.now();
    must(await asApp(ctx,'1',async tx=>{await tx.execute(HISTORY_SHAPE());await tx.execute(LIST_SHAPE());await tx.execute(sql`select count(*) from payslip`);}));
    out[name].push(performance.now()-t);
   }
   return Object.fromEntries(Object.entries(out).map(([k,v])=>[k,median(v)]));};
  await time('legacy');
  const legacy=await time('legacy'),switched=await time('precomputed');
  await setStepMode(STEP,'legacy');
  console.info('PAYROLL_READ_P3_TIMING',JSON.stringify({legacy,switched}));
  // Diagnostic for the scale comparison: the partner's three reads, analysed, in each mode (no data values printed).
  for(const mode of ['legacy','precomputed'] as const){
   await setStepMode(STEP,mode);
   for(const [label,query] of [['history',HISTORY_SHAPE()],['list',LIST_SHAPE()],['count',sql`select count(*) from payslip`]] as const){
    const plan=must(await asApp(who.partner(),'1',async tx=>(await tx.execute<{'QUERY PLAN':string}>(sql`explain (analyze, costs off, timing on, summary on) ${query}`)).map(r=>r['QUERY PLAN']).join('\n')));
    console.info(`PAYROLL_READ_P3_PLAN ${mode} ${label}\n${plan}`);
   }
  }
  await setStepMode(STEP,'legacy');
  for(const name of Object.keys(legacy))expect(switched[name],name).toBeLessThanOrEqual(legacy[name]*1.1+20);
 },900_000);

 it('adds no maintenance to any payroll write (save cost nil by construction)',async()=>{
  const triggers=await owner.client<{t:string}[]>`select tgrelid::regclass::text||'.'||tgname as t from pg_trigger t join pg_proc p on p.oid=t.tgfoid
   where not t.tgisinternal and (p.proname like 'payroll\\_read\\_access%' or p.proname like 'payroll\\_self\\_%')`;
  expect(triggers).toEqual([]);
 });
});
