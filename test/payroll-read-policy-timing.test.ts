/** ADR 0181 access-rule timing evidence for the payroll read steps (docs/adr/0181-addendum-payroll-read-access-and-read-model.md,
 * PR 308): each step's old and new rule text, timed with explain (analyze, buffers) on the fictional 71-company /
 * 1,000-employment group fixture (buildScaleFixture, test/helpers/ai-centre-scale-fixture.ts) with four monthly payroll
 * runs added for every staffed company (about 4,000 payslips, every tenth carrying an imported tax-basis stamp).
 *
 * The steps install inert ('legacy') and change policy text only when an operator switches them
 * (app.payroll_read_access_set_mode). So for each step this test switches only that step (with the steps it needs),
 * reads, and switches it back:
 *  - 7460 (P1): the two payslip reader guards.
 * Later steps add their rows to STEPS below.
 *
 * Statements, each in the application role (ai_hr_app, row security on) under the persona's own identity statement, in
 * a rolled-back transaction: a Transaction View History period across all companies, a count of every visible payslip,
 * the Payroll list's run rows, and the effective-run view the list reads. Personas: the fixture's group administrator,
 * the administrator granted company by company on all 71 companies, and a single-company administrator.
 *
 * For every statement and persona it asserts the same row count old and new (non-vacuous for the administrators), and
 * that the new text is no slower than the old beyond runner noise (execution within 1.25x + 25 ms of the warm old
 * measure). Every pair is printed as one `POLICY_TIMING_<migration> {json}` line. All names are invented. */
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {SessionContext,Tx} from '../db/client';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';

type Step={migration:string;step:string;needs:readonly string[]};
const STEPS:readonly Step[]=[
 {migration:'7460',step:'p1_tax_reader_guards',needs:[]},
];
const PERIODS=['2025-09','2025-10','2025-11','2025-12'] as const;
const STATEMENTS:Record<string,ReturnType<typeof sql>>={
 history:sql`select p.id from payslip p join payroll_batch pb on pb.id=p.batch_id join company c on c.id=pb.company_id
  join employment e on e.id=p.employment_id join person pe on pe.id=e.person_id
  where pb.pay_period='2025-12' order by pb.pay_period desc,pb.run_seq,pe.full_name`,
 count:sql`select count(*) from payslip`,
 list:sql`select pb.id from payroll_batch pb join company c on c.id=pb.company_id order by pb.pay_period desc,c.legal_name,pb.run_seq`,
 view:sql`select id,employee_count,totals from payroll_history_effective_batch`,
};

let b:Base,fixture:ScaleFixture,slips=0;
beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 await setModule(b.tenantId,'payroll','active');
 fixture=await buildScaleFixture(b,{employments:1000,events:2000});
 const T=b.tenantId;
 await owner.client.begin(async tx=>{
  await tx`set local session_replication_role = replica`;
  const staffed=(await tx<{id:string}[]>`select distinct company_id::text as id from employment where tenant_id=${T}::uuid order by 1`).map(r=>r.id);
  await tx`insert into pay_period(tenant_id,company_id,period,status) select ${T}::uuid,c,p,'closed' from unnest(${staffed}::uuid[]) c cross join unnest(${[...PERIODS]}::text[]) p`;
  await tx`insert into payroll_batch(tenant_id,company_id,pay_period_id,pay_period,batch_date,status,released_at,run_type,run_seq,employee_count,totals)
   select pp.tenant_id,pp.company_id,pp.id,pp.period,(pp.period||'-25')::date,'closed',now(),'regular',1,0,'{}'::jsonb
   from pay_period pp where pp.tenant_id=${T}::uuid and pp.period=any(${[...PERIODS]}::text[])`;
  await tx`insert into payslip(tenant_id,batch_id,employment_id,basic_salary,gross_pay,statutory,total_deductions,net_pay,employer_cost)
   select ${T}::uuid,pb.id,e.id,'3000.00','3000.00',
    case when right(e.employee_code,1)='0' then '{"importedTaxBasis":{"version":1,"source":"fictional"}}'::jsonb else '{}'::jsonb end,'0.00','3000.00','3000.00'
   from employment e join payroll_batch pb on pb.company_id=e.company_id and pb.tenant_id=e.tenant_id
   where e.tenant_id=${T}::uuid and pb.pay_period=any(${[...PERIODS]}::text[])`;
 });
 slips=Number((await owner.client<{n:number}[]>`select count(*)::int as n from payslip where tenant_id=${b.tenantId}`)[0].n);
 await owner.client`analyze company,person,employment,pay_period,payroll_batch,payslip,app_user,role_assignment`;
},600_000);
afterAll(async()=>{
 try{for(const s of [...STEPS].reverse())await owner.client`select app.payroll_read_access_set_mode(${s.step},'legacy')`;}
 finally{await closeAll();}
});

type Measure={executionMs:number;planningMs:number;rows:number;buffers:number};
type PlanNode={'Actual Rows':number;'Shared Hit Blocks'?:number;'Shared Read Blocks'?:number};
/** One analysed statement as the application role under the persona's identity, rolled back. */
async function analyse(ctx:SessionContext,query:ReturnType<typeof sql>):Promise<Measure>{
 class Done{constructor(readonly value:Measure){}}
 try{
  await owner.db.transaction(async tx=>{
   await tx.execute(sql`set local role ai_hr_app`);
   await tx.execute(sql`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId??''},true),set_config('app.roles',${(ctx.roles??[]).join(',')},true),
    set_config('app.grants',${JSON.stringify(ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null})))},true),set_config('app.agent_principal_id','',true),
    set_config('app.payroll_tax_basis_reader','1',true),set_config('app.payroll_import_tax_basis_reader','1',true),set_config('jit','off',true)`);
   const [row]=await (tx as unknown as Tx).execute<{'QUERY PLAN':{Plan:PlanNode;'Execution Time':number;'Planning Time':number}[]}>(sql`explain (analyze, buffers, format json) ${query}`);
   const p=row['QUERY PLAN'][0];
   throw new Done({executionMs:p['Execution Time'],planningMs:p['Planning Time'],rows:p.Plan['Actual Rows'],buffers:(p.Plan['Shared Hit Blocks']??0)+(p.Plan['Shared Read Blocks']??0)});
  });
 }catch(error){if(error instanceof Done)return error.value;throw error;}
 throw new Error('the analysed transaction did not run');
}
const setMode=async(step:string,mode:'legacy'|'precomputed')=>{await owner.client`select app.payroll_read_access_set_mode(${step},${mode})`;};

describe('payroll read steps: old vs new rule text at 71 companies and 1,000 employments',()=>{
 it('the fixture holds the payroll the reads walk',async()=>{
  expect(slips).toBeGreaterThanOrEqual(3900);
  expect(fixture.personas.group.grants).toEqual([{role:'hr_admin',companyId:null}]);
 });

 for(const s of STEPS)it(`${s.migration} (${s.step}): the same rows, no slower`,async()=>{
  const personas=Object.entries(fixture.personas) as [string,SessionContext][];
  for(const need of s.needs)await setMode(need,'precomputed');
  try{
   for(const [persona,ctx] of personas)for(const [label,query] of Object.entries(STATEMENTS)){
    // Warm both texts first, then measure old and new back to back.
    await setMode(s.step,'legacy');await analyse(ctx,query);const before=await analyse(ctx,query);
    await setMode(s.step,'precomputed');await analyse(ctx,query);const after=await analyse(ctx,query);
    await setMode(s.step,'legacy');
    console.info(`POLICY_TIMING_${s.migration}`,JSON.stringify({step:s.step,persona,statement:label,old:before,new:after}));
    expect(after.rows,`${s.migration} ${persona} ${label} rows`).toBe(before.rows);
    if(persona!=='single'&&label!=='view')expect(before.rows,`${s.migration} ${persona} ${label} non-vacuous`).toBeGreaterThan(0);
    expect(after.executionMs,`${s.migration} ${persona} ${label} execution`).toBeLessThanOrEqual(before.executionMs*1.25+25);
   }
  }finally{
   await setMode(s.step,'legacy');
   for(const need of [...s.needs].reverse())await setMode(need,'legacy');
  }
 },1_800_000);
});
