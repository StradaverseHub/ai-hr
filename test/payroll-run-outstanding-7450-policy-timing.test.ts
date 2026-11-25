/** ADR 0181 access-rule timing evidence for migration 7450 (db/migrations/7450_payroll_run_outstanding.sql, a1a80747 r2):
 * the four row-security policies of the new table payroll_run_outstanding, timed with explain (analyze, buffers) on the
 * fictional 71-company / 1,000-employment group fixture (buildScaleFixture, test/helpers/ai-centre-scale-fixture.ts).
 *
 * OLD RULE TEXT: none. 7450 creates a new table with new policies; it changes no existing table, policy or function.
 * So there is no old text to time against; this test times the new text alone and holds it to absolute bounds.
 *
 * The rules: read where the run is (`tenant_id = app.current_tenant_id() AND EXISTS (payroll_batch b WHERE b.id =
 * batch_id AND b.tenant_id = tenant_id)`, the EXISTS reading payroll_batch under the reader's own row security); insert,
 * update and delete only for a payroll administrator of the run's company (the same EXISTS with
 * app.can_admin_payroll_for(b.company_id), a LANGUAGE sql function, not a definer). Each statement below is the
 * product's own text, run in the application role (ai_hr_app, row security on, no bypass) under the persona's own
 * identity statement, in a transaction that is rolled back:
 *  - the list's read: core/payroll-view.ts payrollRunOutstandingCounts, as captured by observeStatements, for the group
 *    administrator asking for all 70 processed runs and for a company-scoped administrator asking for the same 70
 *    (row security narrows it to their company's 10);
 *  - the list's claim: core/payroll-run-outstanding.ts requestPayrollRunOutstandingRefresh's one insert ... on conflict
 *    do update (insert and update rules), captured the same way, for both administrators, with every run due;
 *  - the refresh job's write: refreshRunOutstandingTx's upsert of a run's answer (insert and update rules), built with
 *    the same Drizzle builder the job uses, for both administrators on a run of their company;
 *  - the run's own state change: forgetRunOutstandingTx's delete by primary key (delete rule).
 * For every plan it asserts: the rows are the authorised ones (non-vacuous), no plan node over payroll_run_outstanding
 * or payroll_batch loops more often than there are stored answers (the policy's EXISTS runs at most once per stored
 * row, never once per employee or per element of the stored id lists), and execution time and shared buffers stay
 * within PLAN_LIMITS. Every plan is printed as one `POLICY_TIMING_7450 {json}` line. All names are invented. */
import {and,eq,inArray,isNull,sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {client,withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {payrollRunOutstandingCounts,requestPayrollRunOutstandingRefresh} from '../packs/payroll/service';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {isIdentityStatement,observeStatements,type Captured} from './helpers/statement-observer';

/** Ceilings per statement kind: execution time (ms, CI runner, EXPLAIN ANALYZE overhead included) and shared buffers
 * (hit + read) of the whole statement. Recorded from the measured plans with headroom for runner variance; a per-row
 * explosion of the policy's EXISTS over 1,000 employees or 700 stored ids would exceed both. */
const PLAN_LIMITS={
 read:{executionMs:150,buffers:6000},
 claim:{executionMs:150,buffers:6000},
 upsert:{executionMs:50,buffers:600},
 delete:{executionMs:50,buffers:600},
} as const;
type Kind=keyof typeof PLAN_LIMITS;
/** Stored answers: every processed run holds this many employee ids of its company (fewer where it has fewer). */
const IDS_PER_RUN=10;

let b:Base,fixture:ScaleFixture,companyId:string,companyRuns:string[],allRuns:string[],group:SessionContext,single:SessionContext;
const runCompany=new Map<string,string>();
const staffOf=new Map<string,string[]>();

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 await setModule(b.tenantId,'payroll','active');
 fixture=await buildScaleFixture(b,{employments:1000,events:2000});
 group=fixture.personas.group;single=fixture.personas.single;companyId=fixture.singleCompanyId;
 // Ten processed runs for the company-scoped administrator's company, written as the fixture writes its runs.
 companyRuns=[];
 for(let month=1;month<=10;month++){
  const period=`2026-${String(month).padStart(2,'0')}`;
  const [pp]=await owner.db.insert(schema.payPeriod).values({tenantId:b.tenantId,companyId,period,status:'open'} as never).returning({id:schema.payPeriod.id});
  const [run]=await owner.db.insert(schema.payrollBatch).values({tenantId:b.tenantId,companyId,payPeriodId:pp.id,payPeriod:period,batchDate:`${period}-28`,status:'processed',employeeCount:10} as never)
   .returning({id:schema.payrollBatch.id});
  companyRuns.push(run.id);
 }
 const runs=await owner.db.select({id:schema.payrollBatch.id,companyId:schema.payrollBatch.companyId}).from(schema.payrollBatch)
  .where(and(eq(schema.payrollBatch.tenantId,b.tenantId),eq(schema.payrollBatch.status,'processed'))).orderBy(schema.payrollBatch.id);
 allRuns=runs.map(r=>r.id);
 for(const r of runs)runCompany.set(r.id,r.companyId);
 const staff=await owner.db.select({id:schema.employment.id,companyId:schema.employment.companyId}).from(schema.employment)
  .where(and(inArray(schema.employment.companyId,[...new Set(runs.map(r=>r.companyId))]),isNull(schema.employment.terminatedOn))).orderBy(schema.employment.employeeCode);
 for(const e of staff)(staffOf.get(e.companyId)??staffOf.set(e.companyId,[]).get(e.companyId)!).push(e.id);
 // Every run's stored answer, written through the rules as the group administrator (as the refresh job would).
 await withTenant(group,tx=>tx.insert(schema.payrollRunOutstanding).values(runs.map(r=>({batchId:r.id,tenantId:b.tenantId,
  employmentIds:(staffOf.get(r.companyId)??[]).slice(0,IDS_PER_RUN),refreshedAt:new Date()}))));
 await owner.client.unsafe('analyze public.payroll_run_outstanding, public.payroll_batch, public.pay_period, public.employment');
},300_000);
afterAll(closeAll);

type PlanNode={'Node Type':string;'Relation Name'?:string;'Index Name'?:string;'Subplan Name'?:string;'Parent Relationship'?:string;
 'Actual Rows'?:number;'Actual Loops'?:number;'Shared Hit Blocks'?:number;'Shared Read Blocks'?:number;Filter?:string;Plans?:PlanNode[]};
type Explained={plan:PlanNode;executionMs:number;planningMs:number;triggers:unknown};
const nodes=(n:PlanNode):PlanNode[]=>[n,...(n.Plans??[]).flatMap(nodes)];
const ROLLBACK=new Error('rolled back on purpose');

/** The persona's identity statement as the product sends it (it also turns JIT off, as every app transaction does). */
async function identityOf(ctx:SessionContext):Promise<Captured>{
 const observed=await observeStatements(()=>withTenant(ctx,tx=>tx.execute(sql`select 1`)));
 const identity=observed.statements.find(s=>isIdentityStatement(s.sql));
 expect(identity,'identity statement').toBeTruthy();
 return identity!;
}
/** EXPLAIN (ANALYZE, BUFFERS) of one statement in the application role, after the identity statement, rolled back. */
async function explainRolledBack(identity:Captured,statement:{sql:string;params:readonly unknown[]}):Promise<Explained&{profile:{role:string;bypass:boolean;rowSecurity:string;jit:string}}>{
 let out:(Explained&{profile:{role:string;bypass:boolean;rowSecurity:string;jit:string}})|undefined;
 await client.begin(async tx=>{
  await tx.unsafe(identity.sql,identity.params as never[]);
  const [profile]=await tx.unsafe(`select current_user as role,(select rolbypassrls from pg_roles where rolname=current_user) as bypass,
   current_setting('row_security') as "rowSecurity",current_setting('jit') as jit`) as unknown as {role:string;bypass:boolean;rowSecurity:string;jit:string}[];
  const rows=await tx.unsafe(`explain (analyze, buffers, format json) ${statement.sql}`,statement.params as never[]);
  const plan=(rows[0] as Record<string,unknown>)['QUERY PLAN'] as [{Plan:PlanNode;'Execution Time':number;'Planning Time':number;Triggers?:unknown}];
  out={plan:plan[0].Plan,executionMs:plan[0]['Execution Time'],planningMs:plan[0]['Planning Time'],triggers:plan[0].Triggers??null,profile};
  throw ROLLBACK;
 }).catch(error=>{if(error!==ROLLBACK)throw error;});
 return out!;
}

/** The bounds every 7450 plan meets, and its evidence line. */
function expectBounded(kind:Kind,label:string,explained:Explained&{profile:{role:string;bypass:boolean;rowSecurity:string;jit:string}},storedRows:number){
 expect(explained.profile,`${label} runs as the application role under row security`).toEqual({role:'ai_hr_app',bypass:false,rowSecurity:'on',jit:'off'});
 const all=nodes(explained.plan);
 const policyNodes=all.filter(n=>n['Relation Name']==='payroll_run_outstanding'||n['Relation Name']==='payroll_batch');
 const maxLoops=Math.max(0,...policyNodes.map(n=>n['Actual Loops']??0));
 const buffers=(explained.plan['Shared Hit Blocks']??0)+(explained.plan['Shared Read Blocks']??0);
 const subplans=all.filter(n=>n['Subplan Name']).map(n=>({name:n['Subplan Name'],relation:n['Relation Name']??null,loops:n['Actual Loops']??0,rows:n['Actual Rows']??0}));
 const row={kind,label,executionMs:Math.round(explained.executionMs*100)/100,planningMs:Math.round(explained.planningMs*100)/100,buffers,
  maxPolicyNodeLoops:maxLoops,storedRows,subplans,
  nodes:all.map(n=>({node:n['Node Type'],relation:n['Relation Name']??n['Index Name']??null,subplan:n['Subplan Name']??null,rows:n['Actual Rows']??0,loops:n['Actual Loops']??0,
   filter:n.Filter?n.Filter.slice(0,200):null})),triggers:explained.triggers};
 console.log('POLICY_TIMING_7450 '+JSON.stringify(row));
 expect(policyNodes.length,`${label}: the plan reads payroll_run_outstanding or payroll_batch`).toBeGreaterThan(0);
 expect(maxLoops,`${label}: a node over payroll_run_outstanding / payroll_batch loops at most once per stored answer`).toBeLessThanOrEqual(storedRows);
 expect(explained.executionMs,`${label}: execution ms`).toBeLessThanOrEqual(PLAN_LIMITS[kind].executionMs);
 expect(buffers,`${label}: shared buffers`).toBeLessThanOrEqual(PLAN_LIMITS[kind].buffers);
 return row;
}

/** The one statement of `observed` that matches, with its own transaction's identity statement before it. */
function statementOf(observed:{statements:Captured[]},match:RegExp):{identity:Captured;statement:Captured}{
 const index=observed.statements.findIndex(s=>match.test(s.sql));
 expect(index,`a statement matching ${match}`).toBeGreaterThan(0);
 const identity=[...observed.statements.slice(0,index)].reverse().find(s=>isIdentityStatement(s.sql));
 expect(identity,'its identity statement').toBeTruthy();
 return {identity:identity!,statement:observed.statements[index]};
}
/** Every run due again (answers and claims older than the freshness window), as the group administrator. */
const allDue=()=>withTenant(group,tx=>tx.update(schema.payrollRunOutstanding)
 .set({refreshedAt:new Date(Date.now()-600_000),requestedAt:new Date(Date.now()-600_000)}));

describe('7450 payroll_run_outstanding rules at group scale (71 companies, 1,000 employments, 70 processed runs)',()=>{
 it('the list read is bounded for a group and a company-scoped administrator',async()=>{
  expect(allRuns.length).toBe(70);
  const stored=allRuns.length;
  const cases:[string,SessionContext,number][]=[['group administrator, all 70 runs',group,70],['company-scoped administrator, the same 70 runs asked',single,10]];
  for(const [label,ctx,visible] of cases){
   await payrollRunOutstandingCounts(ctx,allRuns);
   const observed=await observeStatements(()=>payrollRunOutstandingCounts(ctx,allRuns));
   // Non-vacuous: exactly the runs this administrator may see, each with its stored answer.
   expect(observed.result.size,label).toBe(visible);
   expect([...observed.result.values()].every(v=>v.known),label).toBe(true);
   if(ctx===single)expect([...observed.result.keys()].sort(),label).toEqual([...companyRuns].sort());
   const {identity,statement}=statementOf(observed,/payroll_run_outstanding/);
   const explained=await explainRolledBack(identity,statement);
   expect(explained.plan['Actual Rows'],label).toBe(visible);
   expectBounded('read',`read | ${label}`,explained,stored);
  }
 },300_000);

 it('the list claim (insert and update rules) is bounded for a group and a company-scoped administrator',async()=>{
  const stored=allRuns.length;
  const cases:[string,SessionContext,string[]][]=[['group administrator, all 70 runs',group,allRuns],['company-scoped administrator, the same 70 runs asked',single,companyRuns]];
  for(const [label,ctx,claimable] of cases){
   await allDue();
   const observed=await observeStatements(()=>requestPayrollRunOutstandingRefresh(ctx,allRuns));
   expect(observed.result.jobId,label).toBeTruthy();
   expect([...observed.result.batchIds].sort(),label).toEqual([...claimable].sort());
   const {identity,statement}=statementOf(observed,/insert into "?payroll_run_outstanding"?/i);
   // Replayed with every run due again, so the plan claims (updates) exactly the authorised runs.
   await allDue();
   const explained=await explainRolledBack(identity,statement);
   expect(explained.plan['Actual Rows'],label).toBe(claimable.length);
   expectBounded('claim',`claim | ${label}`,explained,stored);
  }
 },300_000);

 it('the refresh job write and the run state change delete (insert, update and delete rules) are bounded',async()=>{
  const stored=allRuns.length;
  const groupRun=allRuns.find(id=>runCompany.get(id)===b.companyId)!;
  const cases:[string,SessionContext,string][]=[['group administrator',group,groupRun],['company-scoped administrator',single,companyRuns[0]]];
  for(const [label,ctx,batchId] of cases){
   const identity=await identityOf(ctx);
   const pending=(staffOf.get(runCompany.get(batchId)!)??[]).slice(0,IDS_PER_RUN).sort();
   // refreshRunOutstandingTx's upsert, built with the same Drizzle builder as the job (core/payroll-run-outstanding.ts).
   const upsert=owner.db.insert(schema.payrollRunOutstanding)
    .values({batchId,tenantId:ctx.tenantId,employmentIds:pending,refreshedAt:sql`now()`})
    .onConflictDoUpdate({target:schema.payrollRunOutstanding.batchId,set:{employmentIds:pending,refreshedAt:sql`now()`}}).toSQL();
   const written=await explainRolledBack(identity,upsert);
   expectBounded('upsert',`job upsert | ${label}`,written,stored);
   // forgetRunOutstandingTx's delete by primary key.
   const forget=owner.db.delete(schema.payrollRunOutstanding).where(eq(schema.payrollRunOutstanding.batchId,batchId)).toSQL();
   const deleted=await explainRolledBack(identity,forget);
   expectBounded('delete',`forget delete | ${label}`,deleted,stored);
  }
  // Non-vacuous refusal: the company-scoped administrator's write on another company's run is refused by the rules.
  const foreignRun=allRuns.find(id=>runCompany.get(id)===b.companyId)!;
  const pgText=(e:unknown)=>`${String(e)} ${String((e as {cause?:unknown})?.cause??'')}`;
  await expect(withTenant(single,tx=>tx.insert(schema.payrollRunOutstanding).values({batchId:foreignRun,tenantId:b.tenantId,employmentIds:[],refreshedAt:new Date()})
   .onConflictDoUpdate({target:schema.payrollRunOutstanding.batchId,set:{employmentIds:[],refreshedAt:new Date()}})))
   .rejects.toSatisfy((e:unknown)=>/row-level security/i.test(pgText(e)));
  const deletedForeign=await withTenant(single,tx=>tx.delete(schema.payrollRunOutstanding).where(eq(schema.payrollRunOutstanding.batchId,foreignRun)).returning({id:schema.payrollRunOutstanding.batchId}));
  expect(deletedForeign).toEqual([]);
 },300_000);
});
