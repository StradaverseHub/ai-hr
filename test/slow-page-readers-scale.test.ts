/** Slow-page readers at large-group scale: a fixture of about 4,760 employments (four companies of ~940 beside the
 * 71-company scale fixture), 32 processed runs with ~30,000 payslips, recalculation marks and stored outstanding
 * answers on every run, and 30,000 domain events. It times, under the group administrator and the single-company
 * administrator, every statement these readers send (EXPLAIN ANALYZE as the caller): the Payroll list's run list
 * (listBatches) and outstanding counts (payrollRunOutstandingCounts), Home's record readiness (recordReadiness) and
 * the Audit Trail's filter lists (auditAggregateTypes, auditActors). It prints SLOW_PAGE lines. All names are
 * invented. */
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {listBatches} from '../core/payroll';
import {payrollRunOutstandingCounts} from '../core/payroll-view';
import {recordReadiness} from '../core/record-readiness';
import {auditActors,auditAggregateTypes} from '../core/read';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {explainStatements,isIdentityStatement,observeStatements} from './helpers/statement-observer';
import {client} from '../db/client';

let b:Base,fixture:ScaleFixture;
const runIds:string[]=[];

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 await setModule(b.tenantId,'payroll','active');
 fixture=await buildScaleFixture(b,{employments:1000,events:30000});
 // Four large companies (the single-company administrator's is one of them): 940 more employments each.
 const big=[fixture.singleCompanyId,...fixture.operatingCompanyIds.filter(id=>id!==fixture.singleCompanyId).slice(0,3)];
 for(const [i,companyId] of big.entries())await owner.client`with p as (
   insert into person(tenant_id,full_name,primary_email)
   select ${b.tenantId}::uuid,'Fictional Large '||${i}||'-'||lpad(n::text,4,'0'),'large-'||${i}||'-'||n||'@fixture.test' from generate_series(1,940) n returning id)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
  select ${b.tenantId}::uuid,p.id,${companyId}::uuid,'LG'||${i}||'-'||lpad((row_number() over())::text,4,'0'),'2023-01-01' from p`;
 // Eight processed months per large company: 32 runs, a payslip for every employment, a recalculation mark naming 200
 // of them and a stored outstanding answer naming 50.
 for(const companyId of big)for(let m=1;m<=8;m++){
  const period=`2025-${String(m).padStart(2,'0')}`;
  const [pp]=await owner.db.insert(schema.payPeriod).values({tenantId:b.tenantId,companyId,period,status:'open'} as never).returning({id:schema.payPeriod.id});
  const [run]=await owner.db.insert(schema.payrollBatch).values({tenantId:b.tenantId,companyId,payPeriodId:pp.id,payPeriod:period,batchDate:`${period}-28`,status:'processed',employeeCount:940} as never)
   .returning({id:schema.payrollBatch.id});
  runIds.push(run.id);
  await owner.client`insert into payslip(tenant_id,batch_id,employment_id,basic_salary,gross_pay,statutory,total_deductions,net_pay,employer_cost)
   select ${b.tenantId}::uuid,${run.id}::uuid,e.id,3000,3000,'{}'::jsonb,0,3000,3300 from employment e where e.company_id=${companyId}::uuid and e.terminated_on is null`;
  await owner.client`update payroll_batch set needs_recalc_at=now(),recalc_employment_ids=(select jsonb_agg(e.id::text) from (select id from employment where company_id=${companyId}::uuid order by id limit 200) e) where id=${run.id}::uuid`;
  await owner.client`insert into payroll_run_outstanding(batch_id,tenant_id,employment_ids,refreshed_at)
   select ${run.id}::uuid,${b.tenantId}::uuid,(select jsonb_agg(e.id::text) from (select id from employment where company_id=${companyId}::uuid order by id desc limit 50) e),now()`;
 }
 await owner.client`analyze`;
},900_000);
afterAll(closeAll);

/** Every statement the reader sends, EXPLAIN ANALYZE'd as the caller; one evidence line per statement. */
async function timed(label:string,ctx:SessionContext,read:()=>Promise<unknown>){
 const observed=await observeStatements(read);
 const explained=await explainStatements(observed.statements);
 let total=0;
 for(const e of explained){
  if(e.executionMs===null)continue;
  total+=e.executionMs+(e.planningMs??0);
  console.log('SLOW_PAGE_PAGE '+JSON.stringify({label,ordinal:e.ordinal,executionMs:e.executionMs,planningMs:e.planningMs,sql:e.sql.slice(0,120),
   hotspots:e.hotspots.slice(0,4).map(h=>({node:h.node,relation:h.relation,subplan:h.subplan,loops:h.loops,rows:h.rows,ms:h.totalMs}))}));
 }
 console.log('SLOW_PAGE_TOTAL '+JSON.stringify({label,statements:observed.statements.length,dbMs:Math.round(total),wallMs:Math.round(observed.ms)}));
 return observed.result;
}

/** The full plan of the outstanding-counts statement (nodes over 50 ms, with filters), for the diagnosis. */
async function fullPlan(label:string,ctx:SessionContext){
 const observed=await observeStatements(()=>payrollRunOutstandingCounts(ctx,runIds));
 const identity=observed.statements.find(s=>isIdentityStatement(s.sql))!;
 const statement=observed.statements.find(s=>s.sql.includes('with runs as materialized'))!;
 await client.begin(async tx=>{
  await tx.unsafe(identity.sql,identity.params as never[]);
  const [row]=await tx.unsafe(`explain (analyze, buffers, format json) ${statement.sql}`,statement.params as never[]);
  type N={'Node Type':string;'Relation Name'?:string;'Index Name'?:string;'Function Name'?:string;'Subplan Name'?:string;'CTE Name'?:string;'Actual Loops'?:number;'Actual Rows'?:number;'Actual Total Time'?:number;Filter?:string;'Index Cond'?:string;'Shared Hit Blocks'?:number;Plans?:N[]};
  const walk=(n:N,depth:number)=>{
   const ms=(n['Actual Total Time']??0)*(n['Actual Loops']??1);
   if(ms>=50)console.log('SLOW_PAGE_PLAN '+JSON.stringify({label,depth,node:n['Node Type'],rel:n['Relation Name']??n['Index Name']??n['Function Name']??n['CTE Name']??null,sub:n['Subplan Name']??null,
    loops:n['Actual Loops'],rows:n['Actual Rows'],ms:Math.round(ms),blocks:n['Shared Hit Blocks'],filter:(n.Filter??n['Index Cond']??'').slice(0,300)}));
   for(const c of n.Plans??[])walk(c,depth+1);
  };
  walk(((row as Record<string,unknown>)['QUERY PLAN'] as [{Plan:N}])[0].Plan,0);
  throw new Error('rolled back');
 }).catch(e=>{if(String(e).indexOf('rolled back')<0)throw e;});
}

describe('slow-page readers at large-group scale',()=>{
 it('prints the outstanding-counts plan for the single-company administrator',async()=>{
  await fullPlan('single outstanding',fixture.personas.single);
 },900_000);

 it('times the Payroll list, Home readiness and Audit filter readers for a group and a company administrator',async()=>{
  const [{payslips}]=await owner.client<{payslips:number}[]>`select count(*)::int as payslips from payslip`;
  const [{employments}]=await owner.client<{employments:number}[]>`select count(*)::int as employments from employment`;
  console.log('SLOW_PAGE_SHAPE '+JSON.stringify({employments,payslips,runs:runIds.length}));
  expect(payslips).toBeGreaterThan(25000);
  for(const [name,ctx] of [['group',fixture.personas.group],['single',fixture.personas.single]] as const){
   expect(await timed(`${name} listBatches`,ctx,()=>listBatches(ctx))).toBeTruthy();
   const outstanding=await timed(`${name} outstanding`,ctx,()=>payrollRunOutstandingCounts(ctx,runIds)) as Map<string,{count:number;held:number;known:boolean;marked:boolean}>;
   // Independent answer: every marked employee has a payslip on the run (owed), every stored one has a payslip (not
   // owed), nobody is held: 200 owed on every run the caller can see (all 32 for the group, 8 for the single company).
   expect(outstanding.size,name).toBe(name==='group'?32:8);
   for(const v of outstanding.values())expect(v,name).toMatchObject({count:200,held:0,known:true,marked:true});
   expect(await timed(`${name} readiness`,ctx,()=>recordReadiness(ctx))).toBeTruthy();
   expect(await timed(`${name} audit types`,ctx,()=>auditAggregateTypes(ctx))).toBeTruthy();
   expect(await timed(`${name} audit actors`,ctx,()=>auditActors(ctx))).toBeTruthy();
  }
 },900_000);
});
