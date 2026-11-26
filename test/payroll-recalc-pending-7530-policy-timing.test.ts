/** ADR 0181 access-rule timing evidence for migration 7530 (db/migrations/7530_payroll_recalc_pending.sql, board 124a979e
 * plan item 9): the three row-security policies of the new table payroll_recalc_pending, timed with explain (analyze,
 * buffers) on the fictional 71-company / 1,000-employment group fixture (buildScaleFixture,
 * test/helpers/ai-centre-scale-fixture.ts).
 *
 * OLD RULE TEXT: none. 7530 creates a new table with new policies and changes no existing table, policy or function, so
 * the new text is timed alone and held to absolute bounds.
 *
 * The rules: insert by the saver, as itself, for an employment it can see (`EXISTS (employment e WHERE e.id =
 * employment_id ...)` under the saver's own row security); read and delete only for a payroll administrator of the
 * employee's current company (the same EXISTS with app.can_admin_payroll_for(e.company_id), a LANGUAGE sql function, not
 * a definer). Each statement is the product's own text, captured with observeStatements, run in the application role
 * under the persona's own identity statement, in a transaction that is rolled back:
 *  - the save's record (core/payroll.ts recordRecalcPendingTx, via markRunsAffectedByEmploymentChangeTx for 50
 *    employments): one INSERT ... SELECT that inserts nothing for a payroll administrator;
 *  - a single-row insert through the insert rule (the shape a saver without payroll administration writes);
 *  - the refresh job's consume (consumeRecalcPendingTx): one DELETE ... RETURNING of at most 500 rows, for the group
 *    administrator (500 of 1,000 stored rows) and a company-scoped administrator (their company's rows only).
 * For every plan it asserts the rows are the authorised ones (non-vacuous), no node over payroll_recalc_pending or
 * employment loops more often than there are stored rows (the rule's EXISTS runs at most once per stored row), and
 * execution, planning and shared buffers stay within PLAN_LIMITS. Every plan is printed as one `POLICY_TIMING_7530
 * {json}` line. All names are invented. */
import {and,eq,inArray,sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {client,withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {consumeRecalcPendingTx,markRunsAffectedByEmploymentChangeTx} from '../packs/payroll/service';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {isIdentityStatement,observeStatements,type Captured} from './helpers/statement-observer';

/** Ceilings per statement kind (ms on the CI runner, EXPLAIN ANALYZE overhead included; shared buffers of the whole
 * statement). First measured by this test's own POLICY_TIMING_7530 lines; set wide enough for runner variance while a
 * per-employee probe of the whole table (1,000 rows x the employment policy) would still exceed the buffers. */
const PLAN_LIMITS={
 record:{executionMs:300,planningMs:400,buffers:6000},
 insert:{executionMs:100,planningMs:300,buffers:1500},
 consume:{executionMs:600,planningMs:400,buffers:20000},
} as const;
type Kind=keyof typeof PLAN_LIMITS;

let b:Base,fixture:ScaleFixture,group:SessionContext,single:SessionContext,companyId:string;
let staff:{id:string;companyId:string}[]=[];

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 await setModule(b.tenantId,'payroll','active');
 fixture=await buildScaleFixture(b,{employments:1000,events:2000});
 group=fixture.personas.group;single=fixture.personas.single;companyId=fixture.singleCompanyId;
 staff=await owner.db.select({id:schema.employment.id,companyId:schema.employment.companyId}).from(schema.employment)
  .where(eq(schema.employment.tenantId,b.tenantId)).orderBy(schema.employment.id);
 await owner.client.unsafe('analyze public.payroll_recalc_pending, public.employment, public.payroll_batch, public.payslip');
},300_000);
afterAll(closeAll);

type PlanNode={'Node Type':string;'Relation Name'?:string;'Index Name'?:string;'Subplan Name'?:string;
 'Actual Rows'?:number;'Actual Loops'?:number;'Shared Hit Blocks'?:number;'Shared Read Blocks'?:number;Filter?:string;Plans?:PlanNode[]};
type Explained={plan:PlanNode;executionMs:number;planningMs:number;profile:{role:string;bypass:boolean;rowSecurity:string;jit:string}};
const nodes=(n:PlanNode):PlanNode[]=>[n,...(n.Plans??[]).flatMap(nodes)];
const ROLLBACK=new Error('rolled back on purpose');

/** Seed one stored row per employment (as the storage owner: the rows' content is what is timed, not their writer). */
async function seedPending(){
 await owner.client.unsafe('delete from public.payroll_recalc_pending');
 await owner.db.insert(schema.payrollRecalcPending).values(staff.map(e=>({tenantId:b.tenantId,employmentId:e.id,fromPeriod:'2026-01',untilPeriod:'2026-12',categories:['tax_profile']})));
 await owner.client.unsafe('analyze public.payroll_recalc_pending');
}
async function explainRolledBack(identity:Captured,statement:{sql:string;params:readonly unknown[]}):Promise<Explained>{
 let out:Explained|undefined;
 await client.begin(async tx=>{
  await tx.unsafe(identity.sql,identity.params as never[]);
  const [profile]=await tx.unsafe(`select current_user as role,(select rolbypassrls from pg_roles where rolname=current_user) as bypass,
   current_setting('row_security') as "rowSecurity",current_setting('jit') as jit`) as unknown as Explained['profile'][];
  const rows=await tx.unsafe(`explain (analyze, buffers, format json) ${statement.sql}`,statement.params as never[]);
  const plan=(rows[0] as Record<string,unknown>)['QUERY PLAN'] as [{Plan:PlanNode;'Execution Time':number;'Planning Time':number}];
  out={plan:plan[0].Plan,executionMs:plan[0]['Execution Time'],planningMs:plan[0]['Planning Time'],profile};
  throw ROLLBACK;
 }).catch(error=>{if(error!==ROLLBACK)throw error;});
 return out!;
}
function statementOf(observed:{statements:Captured[]},match:RegExp):{identity:Captured;statement:Captured}{
 const index=observed.statements.findIndex(s=>match.test(s.sql));
 expect(index,`a statement matching ${match}`).toBeGreaterThan(0);
 const identity=[...observed.statements.slice(0,index)].reverse().find(s=>isIdentityStatement(s.sql));
 expect(identity,'its identity statement').toBeTruthy();
 return {identity:identity!,statement:observed.statements[index]};
}
function expectBounded(kind:Kind,label:string,explained:Explained,stored:number){
 expect(explained.profile,`${label} runs as the application role under row security`).toEqual({role:'ai_hr_app',bypass:false,rowSecurity:'on',jit:'off'});
 const all=nodes(explained.plan);
 const policyNodes=all.filter(n=>n['Relation Name']==='payroll_recalc_pending'||n['Relation Name']==='employment');
 const maxLoops=Math.max(0,...policyNodes.map(n=>n['Actual Loops']??0));
 const buffers=(explained.plan['Shared Hit Blocks']??0)+(explained.plan['Shared Read Blocks']??0);
 console.log('POLICY_TIMING_7530 '+JSON.stringify({kind,label,executionMs:Math.round(explained.executionMs*100)/100,planningMs:Math.round(explained.planningMs*100)/100,buffers,maxPolicyNodeLoops:maxLoops,stored,
  nodes:all.map(n=>({node:n['Node Type'],relation:n['Relation Name']??n['Index Name']??null,subplan:n['Subplan Name']??null,rows:n['Actual Rows']??0,loops:n['Actual Loops']??0,filter:n.Filter?n.Filter.slice(0,200):null}))}));
 expect(policyNodes.length,`${label}: the plan reads payroll_recalc_pending or employment`).toBeGreaterThan(0);
 expect(maxLoops,`${label}: a node over payroll_recalc_pending / employment loops at most once per stored row`).toBeLessThanOrEqual(Math.max(stored,1));
 expect(explained.executionMs,`${label}: execution ms`).toBeLessThanOrEqual(PLAN_LIMITS[kind].executionMs);
 expect(explained.planningMs,`${label}: planning ms`).toBeLessThanOrEqual(PLAN_LIMITS[kind].planningMs);
 expect(buffers,`${label}: shared buffers`).toBeLessThanOrEqual(PLAN_LIMITS[kind].buffers);
}

describe('7530 payroll_recalc_pending rules at group scale (71 companies, 1,000 employments)',()=>{
 it('the save records with one bounded INSERT ... SELECT, and a single-row insert passes the insert rule cheaply',async()=>{
  expect(staff.length).toBeGreaterThanOrEqual(1000);
  await owner.client.unsafe('delete from public.payroll_recalc_pending');
  const ids=staff.slice(0,50).map(e=>e.id);
  const observed=await observeStatements(()=>withTenant(group,tx=>markRunsAffectedByEmploymentChangeTx(tx,group,{employmentIds:ids,category:'tax_profile',from:'2026-01-01'})));
  const {identity,statement}=statementOf(observed,/insert into "?payroll_recalc_pending"?/i);
  const recorded=await explainRolledBack(identity,statement);
  // Non-vacuous: the group administrator administers payroll for every one of them, so nothing is recorded.
  expect(await owner.db.select().from(schema.payrollRecalcPending)).toEqual([]);
  expectBounded('record','record | group administrator, 50 employments',recorded,ids.length);

  const own=staff.find(e=>e.companyId===companyId)!;
  const insert=owner.db.insert(schema.payrollRecalcPending).values({tenantId:b.tenantId,employmentId:own.id,fromPeriod:'2026-01',untilPeriod:null,categories:['zakat'],
   requestedBy:single.userId}).toSQL();
  const singleIdentity=statementOf(await observeStatements(()=>withTenant(single,tx=>tx.execute(sql`select 1`))),/^select 1$/i).identity;
  const inserted=await explainRolledBack(singleIdentity,insert);
  expectBounded('insert','insert | company-scoped administrator, own company',inserted,1);
  // The rule refuses a row for an employment of another company the saver cannot see.
  const foreign=staff.find(e=>e.companyId!==companyId)!;
  await expect(withTenant(single,tx=>tx.insert(schema.payrollRecalcPending).values({tenantId:b.tenantId,employmentId:foreign.id,categories:['zakat'],requestedBy:single.userId})))
   .rejects.toSatisfy((e:unknown)=>/row-level security/i.test(`${String(e)} ${String((e as {cause?:unknown})?.cause??'')}`));
 },300_000);

 it('the refresh consume (read and delete rules) is bounded for a group and a company-scoped administrator',async()=>{
  // Captured on an empty table (so capturing consumes nothing), then timed over 1,000 stored rows.
  await owner.client.unsafe('delete from public.payroll_recalc_pending');
  const cases:[string,SessionContext,number][]=[
   ['group administrator',group,500],
   ['company-scoped administrator',single,staff.filter(e=>e.companyId===companyId).length],
  ];
  for(const [label,ctx,expected] of cases){
   await owner.client.unsafe('delete from public.payroll_recalc_pending');
   const observed=await observeStatements(()=>withTenant(ctx,tx=>consumeRecalcPendingTx(tx,ctx)));
   expect(observed.result.consumed,label).toBe(0);
   const {identity,statement}=statementOf(observed,/delete from "?payroll_recalc_pending"?/i);
   await seedPending();
   const explained=await explainRolledBack(identity,statement);
   expect(explained.plan['Actual Rows'],label).toBe(Math.min(500,expected));
   expectBounded('consume',`consume | ${label}`,explained,staff.length);
  }
  // Non-vacuous refusal: the company-scoped administrator consumes only their company's rows.
  await seedPending();
  const done=await withTenant(single,tx=>consumeRecalcPendingTx(tx,single));
  expect(done.consumed).toBe(staff.filter(e=>e.companyId===companyId).length);
  const left=await owner.db.select({id:schema.payrollRecalcPending.employmentId}).from(schema.payrollRecalcPending)
   .where(and(eq(schema.payrollRecalcPending.tenantId,b.tenantId),inArray(schema.payrollRecalcPending.employmentId,staff.filter(e=>e.companyId===companyId).map(e=>e.id))));
  expect(left).toEqual([]);
 },300_000);
});
