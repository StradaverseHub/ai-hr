/** Payroll history learning, P1 and P2 — over the real owners and the real database (migration 2012), on fictional data.
 *
 *  1. The history reader: closed runs only; months before the as-of month only, and with a replay instant only what was
 *     recorded before it (no look-ahead); the effective copy of an imported month only.
 *  2. The excluded months: a problem swing, a fix at the source, a correction after the run, a manual figure and the months
 *     before a salary change.
 *  3. The learning run as the sponsor: provisional vs stable against independent expected values in sen; a new version
 *     only when a result changes; nothing while learning is off; a sponsor who lost payroll authority stops it.
 *  4. Row-level security: another company, another tenant, an employee and the agent principal get nothing, and nobody
 *     updates or deletes a baseline.
 *  5. The cascade with the employment, person erasure and the leaver retention purge (3 months after the final pay closed;
 *     payslips untouched).
 *  6. The trigger: the payroll tick learns after a run closes, is unlocked or reset and after a payroll-history import is
 *     confirmed or reverted, and leaves an unchanged company alone.
 *  7. The switch: evidence by a group administrator, off by any payroll administrator, classify never directly; each change
 *     versioned, shown with its history and captured as configuration in the Audit loop's pack; and the tenant's stop switch
 *     halts learning and evidence.
 *  8. P2: the evidence lines (within, above, below, from provisional or stable baselines only, none while learning is off or
 *     for anyone but a payroll administrator), "Learned this cycle" counts, and the AI read: counts under the small-group
 *     rule, and no amount, range, person or id reaches the model.
 * Periods are relative to today in Malaysia (lib/hr-date), so the retention rule is tested against the real clock. Expected
 * values are written out from the fixture. No model is called by the learning itself. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {payrollLearnedBaseline,payrollLearningMode,payrollLearningRun} from '../db/payroll-learning-schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {erasePersonPii} from '../core/pdpa';
import {grantAssistant} from '../core/assistant-grant';
import {agentContext,ensureAgentPrincipal} from '../core/agent-principal';
import {readLearningHistoryTx} from '../core/payroll-learning/history';
import {learnedThisCycle} from '../core/payroll-learning/status';
import {runEvidence,swingFlagEvidence} from '../core/payroll-learning/evidence';
import {runPayrollLearning} from '../core/payroll-learning/recompute';
import {LEARNING_MODE_EVENT,PayrollLearningRefused,learningSettingsView,setPayrollLearningMode} from '../core/payroll-learning/mode';
import {setMandateStopSwitch} from '../core/mandates/mandates';
import {collectPayrollPeriodArtefactsTx} from '../core/payroll-audit/capture';
import {payrollLearningStatus} from '../core/explainers/payroll-learning';
import {runPayrollTick} from '../core/loops/tick';
import {nextPeriod,previousPeriod} from '../core/loops/period';
import {todayInKualaLumpur} from '../lib/hr-date';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import type {ModelRequest} from '../core/harness/model-client';
import {scriptedModel} from './harness-ratchet/scripted-model';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Login=SessionContext&{userId:string};
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const shift=(period:string,by:number)=>{let p=period;for(let i=0;i<Math.abs(by);i++)p=by<0?previousPeriod(p):nextPeriod(p);return p;};
/** Seven closed months, M-10 to M-4; the month after them, M-3, is the as-of month. */
const CURRENT=todayInKualaLumpur().slice(0,7);
const MONTHS=Array.from({length:7},(_,i)=>shift(CURRENT,i-10));
const AS_OF=shift(CURRENT,-3);
const lastDay=(period:string)=>new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5,7)),0)).toISOString().slice(0,10);

let b:Base,principalId:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-payroll-learning-passphrase');await resetDb();b=await seedBase();
 for(const module of ['payroll','assistant'])await setModule(b.tenantId,module,'active');
 principalId=await ensureAgentPrincipal(owner.db,b.tenantId);});

async function companyAdmin(companyId:string,base=b):Promise<Login>{
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:`user_${randomUUID()}`,personId:null}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId,role:'hr_admin'});
 return {...(await entitledCtx(base,['hr_admin'])),userId:user.id,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId}]};
}
/** A group administrator: the only one who switches learning on (and so its sponsor). */
async function groupAdmin(base=b):Promise<Login>{
 const userId=await createAppUser(base.tenantId,null,'hr_admin');
 return {...(await entitledCtx(base,['hr_admin'])),userId,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
}
const switchOn=async()=>{const group=await groupAdmin();await setPayrollLearningMode(group,{companyId:b.companyId,mode:'evidence'});return group;};
let seq=0;
async function hire(name:string,companyId=b.companyId,departmentId=b.deptA){
 return hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:`learning-${++seq}-${randomUUID()}@fixture.test`},companyId,departmentId,employmentType:'full_time',hiredOn:'2020-01-01'});
}
async function payPeriodId(companyId:string,period:string){
 const [existing]=await owner.db.select({id:schema.payPeriod.id}).from(schema.payPeriod).where(and(eq(schema.payPeriod.companyId,companyId),eq(schema.payPeriod.period,period)));
 return existing?.id??(await owner.db.insert(schema.payPeriod).values({tenantId:b.tenantId,companyId,period,status:'open'}).returning({id:schema.payPeriod.id}))[0].id;
}
type Slip=Readonly<{employmentId:string;net:string;statutory?:Record<string,unknown>}>;
/** One run of a company's month with its payslips, inserted as the owner (the reads under test are the real owners'). */
async function run(period:string,slips:readonly Slip[],over:Partial<{status:'draft'|'processed'|'closed';runType:'regular'|'bonus'|'adjustment';runSeq:number;closedAt:Date|null;companyId:string}>={}){
 const companyId=over.companyId??b.companyId,status=over.status??'closed';
 const [batch]=await owner.db.insert(schema.payrollBatch).values({tenantId:b.tenantId,companyId,payPeriodId:await payPeriodId(companyId,period),payPeriod:period,
  runType:over.runType??'regular',runSeq:over.runSeq??1,batchDate:`${period}-28`,status,
  closedAt:status==='closed'?(over.closedAt===undefined?new Date(`${period}-28T04:00:00Z`):over.closedAt):null}).returning({id:schema.payrollBatch.id});
 if(slips.length)await owner.db.insert(schema.payslip).values(slips.map(slip=>({tenantId:b.tenantId,batchId:batch.id,employmentId:slip.employmentId,basicSalary:'5000.00',
  grossPay:'5000.00',totalDeductions:'0.00',netPay:slip.net,employerCost:'5000.00',daysWorked:'30.00',statutory:slip.statutory??{}})));
 return batch.id;
}
/** Fixture rows the owners would only write through flows these tests do not exercise (triggers off, as the owner). */
type OwnerTx=Parameters<Parameters<typeof owner.db.transaction>[0]>[0];
const fixture=<T,>(work:(tx:OwnerTx)=>Promise<T>):Promise<T>=>owner.db.transaction(async tx=>{
 await tx.execute(sql`set local session_replication_role=replica`);return work(tx);});
const learn=(trigger:'tick'|'sweep'='sweep')=>entitledCtx(b).then(ctx=>runPayrollLearning({tenantId:b.tenantId,principalId,entitlements:ctx.entitlements!,trigger}));
const stored=(employmentId:string)=>owner.db.select().from(payrollLearnedBaseline).where(eq(payrollLearnedBaseline.employmentId,employmentId)).orderBy(payrollLearnedBaseline.version);

type People=Readonly<{e1:string;e2:string;e3:string;e4:string;steady:readonly string[];fresh:readonly string[];batches:readonly string[]}>;
const E1=['4000.00','4100.00','4050.00','4200.00','4000.00','4150.00','4100.00'];
/** The company's seven closed months:
 *  - e1: net 4000.00 4100.00 4050.00 4200.00 4000.00 4150.00 4100.00 (stable: 7 runs; P10 400000, median 410000, P90 420000 sen);
 *  - five steady people at 3000.00 (stable); e2 paid only the last four months (provisional);
 *  - e3 in all seven, with month 2 a problem swing, month 3 fixed at the source, month 4 reprocessed after a reopen and month
 *    6 a manual EPF figure (provisional: months 1, 5 and 7);
 *  - e4 in all seven, with a basic salary change from the 1st of month 5 (provisional: months 5 to 7);
 *  - five new people paid only the last two months (not yet). */
async function company():Promise<People>{
 const e1=(await hire('Ravi Fictional')).employmentId,e2=(await hire('Mei Ling Fictional')).employmentId,e3=(await hire('Chong Fictional')).employmentId;
 const e4h=await hire('Aisyah Fictional'),e4=e4h.employmentId;
 await setCompensation(adminCtx(b),{employmentId:e4,basicSalary:3000,effectiveFrom:'2020-01-01'});
 await setCompensation(adminCtx(b),{employmentId:e4,basicSalary:3500,effectiveFrom:`${MONTHS[4]}-01`});
 const steady:string[]=[],fresh:string[]=[];
 for(let i=0;i<5;i++)steady.push((await hire(`Steady Fictional ${i}`)).employmentId);
 for(let i=0;i<5;i++)fresh.push((await hire(`Joiner Fictional ${i}`)).employmentId);
 const manual={adjustment:{lines:{epfEmployee:{system:550,applied:600}},reason:'Fictional agreed EPF'}};
 const batches:string[]=[];
 for(const [i,period] of MONTHS.entries()){
  const slips:Slip[]=[{employmentId:e1,net:E1[i]},...steady.map(employmentId=>({employmentId,net:'3000.00'})),{employmentId:e3,net:'3500.00',...(i===5?{statutory:manual}:{})},
   {employmentId:e4,net:i>=4?'3300.00':'2900.00'},...(i>=3?[{employmentId:e2,net:'2500.00'}]:[]),...(i>=5?fresh.map(employmentId=>({employmentId,net:'2000.00'})):[])];
  batches.push(await run(period,slips));
 }
 // Month 2: payroll HR found e3's net-swing flag a real problem. Month 3: an exception fixed at the source. Month 4: e3's
 // result reprocessed after the run was reopened.
 await fixture(async tx=>{
  await tx.execute(sql`insert into public.teras_payroll_swing_disposition(tenant_id,case_id,company_id,employment_id,pay_period,pattern,swing_bp,threshold_bp,disposition,decided_by_user_id)
   values (${b.tenantId}::uuid,gen_random_uuid(),${b.companyId}::uuid,${e3}::uuid,${MONTHS[1]},'cause:other',2000,1500,'problem',${b.adminUserId}::uuid)`);
  await tx.insert(schema.payrollAnomalyVerdict).values({tenantId:b.tenantId,batchId:batches[2],employmentId:e3,disposition:'review',resolution:'fixed_upstream',
   resolvedAt:new Date(`${MONTHS[2]}-28T05:00:00Z`),resolvedByUserId:b.adminUserId});
  await tx.insert(schema.payrollStatusHistory).values({tenantId:b.tenantId,batchId:batches[3],action:'unlock',fromStatus:'closed',toStatus:'processed',actorType:'user',actorId:b.adminUserId,
   createdAt:new Date(`${MONTHS[3]}-28T05:00:00Z`)});
  await tx.insert(schema.payrollEmployeeResultHistory).values({tenantId:b.tenantId,batchId:batches[3],employmentId:e3,action:'reprocess',actorType:'user',actorId:b.adminUserId,
   createdAt:new Date(`${MONTHS[3]}-28T06:00:00Z`)});
 });
 return {e1,e2,e3,e4,steady,fresh,batches};
}
/** An imported month, imported at `first` then corrected to `corrected`: two closed imported runs, the second effective. */
async function importedMonth(employmentId:string,period:string,first:string,corrected:string){
 const [cycle]=await owner.db.insert(schema.payrollCycle).values({tenantId:b.tenantId,companyId:b.companyId,name:`Fictional Monthly ${randomUUID().slice(0,8)}`,runType:'regular'}).returning({id:schema.payrollCycle.id});
 const attempt=randomUUID(),periodId=await payPeriodId(b.companyId,period);
 return fixture(async tx=>{
  await tx.execute(sql`insert into public.payroll_history_import_attempt(id,tenant_id,created_by,operation_key,source_name,mime_type,source_hash,source_content,company_ids,plan)
   values (${attempt}::uuid,${b.tenantId}::uuid,${b.adminUserId}::uuid,gen_random_uuid(),'fixture.csv','text/csv',encode(sha256('fixture'::bytea),'hex'),'fixture'::bytea,
    array[${b.companyId}::uuid],jsonb_build_object('sourceHash',encode(sha256('fixture'::bytea),'hex')))`);
  const slips:string[]=[];
  for(const [i,net] of [first,corrected].entries()){
   const [batch]=await tx.insert(schema.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:periodId,payPeriod:period,runType:'adjustment',runSeq:20+i,
    batchDate:`${period}-28`,status:'closed',closedAt:new Date(`${period}-28T04:00:00Z`),payrollCycleId:cycle.id,historyImportAttemptId:attempt}).returning({id:schema.payrollBatch.id});
   const [slip]=await tx.insert(schema.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId,basicSalary:net,grossPay:net,totalDeductions:'0.00',netPay:net,
    employerCost:net,statutory:{}}).returning({id:schema.payslip.id});
   slips.push(slip.id);
  }
  const record=randomUUID(),rev1=randomUUID();
  await tx.execute(sql`insert into public.payroll_history_import_record(id,tenant_id,company_id,employment_id,period,cycle_id)
   values (${record}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employmentId}::uuid,${period},${cycle.id}::uuid)`);
  for(const id of slips)await tx.execute(sql`insert into public.payroll_history_import_snapshot(id,tenant_id,record_id,value_hash,"values")
   values (${id}::uuid,${b.tenantId}::uuid,${record}::uuid,${'a'.repeat(64)},'{}'::jsonb)`);
  await tx.execute(sql`insert into public.payroll_history_import_revision(id,tenant_id,record_id,ordinal,attempt_id,snapshot_id,previous_revision_id,kind,cycle_name)
   values (${rev1}::uuid,${b.tenantId}::uuid,${record}::uuid,1,${attempt}::uuid,${slips[0]}::uuid,null,'import','Monthly'),
    (gen_random_uuid(),${b.tenantId}::uuid,${record}::uuid,2,${attempt}::uuid,${slips[1]}::uuid,${rev1}::uuid,'correction','Monthly')`);
  return {attempt,superseded:slips[0],effective:slips[1]};
 });
}

describe('the history reader',()=>{
 it('reads closed runs only, months before the as-of month only (no look-ahead), and the effective copy only',async()=>{
  const admin=await companyAdmin(b.companyId);
  const e1=(await hire('Ravi Fictional')).employmentId;
  // Part months: joined the company in month 2, an unpaid-leave line in month 4, a proration stamp in month 5, left in month 6.
  const part=(await hire('Part Month Fictional')).employmentId;
  await owner.db.update(schema.employment).set({joinDate:`${MONTHS[1]}-15`,terminatedOn:`${MONTHS[5]}-20`}).where(eq(schema.employment.id,part));
  const partSlip=(i:number):Slip[]=>i<1||i>5?[]:[{employmentId:part,net:'2000.00',statutory:i===3?{unpaidLeave:{days:2,amount:180}}:i===4?{reportContext:{proration:{payMode:'monthly',factor:0.75}}}:{}}];
  for(const [i,period] of MONTHS.entries())await run(period,[{employmentId:e1,net:E1[i]},...partSlip(i)]);
  // A processed run of the as-of month and a draft of the month after: never history.
  await run(AS_OF,[{employmentId:e1,net:'9999.00'}],{status:'processed'});
  await run(nextPeriod(AS_OF),[{employmentId:e1,net:'8888.00'}],{status:'draft'});
  const imported=await importedMonth(e1,shift(MONTHS[0],-1),'3000.00','3100.00');
  const read=(asOf:string,knownBefore?:Date)=>withTenant(admin,tx=>readLearningHistoryTx(tx,{companyId:b.companyId,asOf,...(knownBefore?{knownBefore}:{})}));
  const all=await read(nextPeriod(AS_OF));
  const months=all.months.get(e1)!;
  expect(months.map(month=>month.period)).toEqual([shift(MONTHS[0],-1),...MONTHS]);
  expect(all.latestClosed).toBe(MONTHS[6]);
  // A part month is usual for nobody: the first and last month with the company and the months with unpaid leave or proration.
  expect(all.months.get(part)!.map(month=>[month.period,month.excluded])).toEqual([[MONTHS[1],['first_month']],[MONTHS[2],[]],[MONTHS[3],['part_month']],
   [MONTHS[4],['part_month']],[MONTHS[5],['last_month']]]);
  // The imported month: only its effective copy (the correction, 3100.00), and set aside as a correction.
  expect(months[0].rows.map(row=>[row.figures.net,row.imported,row.runType])).toEqual([['3100.00',true,'regular']]);
  expect(months[0].excluded).toEqual(['correction']);
  expect([imported.superseded,imported.effective].every(id=>UUID.test(id))).toBe(true);
  // No look-ahead: the as-of month and later are never read, closed or not.
  expect((await read(MONTHS[4])).months.get(e1)!.map(month=>month.period)).toEqual([shift(MONTHS[0],-1),...MONTHS.slice(0,4)]);
  for(const month of months)for(const row of month.rows)expect(['9999.00','8888.00','3000.00']).not.toContain(row.figures.net);
  // A replay instant: a run closed after it is not yet history.
  const replay=await read(nextPeriod(AS_OF),new Date(`${MONTHS[6]}-20T00:00:00Z`));
  expect(replay.months.get(e1)!.map(month=>month.period)).toEqual([shift(MONTHS[0],-1),...MONTHS.slice(0,6)]);
 },120000);
 it('sets aside a problem swing, a fix at the source, a correction, a manual figure and the months before a salary change',async()=>{
  const admin=await companyAdmin(b.companyId);
  const people=await company();
  const history=await withTenant(admin,tx=>readLearningHistoryTx(tx,{companyId:b.companyId,asOf:AS_OF}));
  expect(history.months.get(people.e3)!.map(month=>month.excluded)).toEqual([[],['problem_swing'],['fixed_upstream'],['correction'],[],['manual_figure'],[]]);
  expect(history.months.get(people.e4)!.map(month=>month.excluded)).toEqual([['before_salary_change'],['before_salary_change'],['before_salary_change'],['before_salary_change'],[],[],[]]);
  expect(history.months.get(people.e1)!.every(month=>month.excluded.length===0)).toBe(true);
  // Another company's administrator reads none of it.
  const [other]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Other Sdn Bhd'}).returning({id:schema.company.id});
  const outsider=await companyAdmin(other.id);
  expect((await withTenant(outsider,tx=>readLearningHistoryTx(tx,{companyId:b.companyId,asOf:AS_OF}))).months.size).toBe(0);
 },120000);
});

describe('the learning run',()=>{
 it('learns nothing while learning is off, then each person\'s baselines as the sponsor, provisional and stable, in sen',async()=>{
  const admin=await companyAdmin(b.companyId);
  const people=await company();
  expect((await learn()).companies).toEqual([]);
  expect(await owner.db.select().from(payrollLearnedBaseline)).toEqual([]);
  // A payroll administrator of one company may not switch it on, in the service or the database; a group administrator does.
  await expect(setPayrollLearningMode(admin,{companyId:b.companyId,mode:'evidence'})).rejects.toMatchObject({reason:'group_administrator'});
  await expect(withTenant(admin,tx=>tx.insert(payrollLearningMode).values({tenantId:b.tenantId,companyId:b.companyId,version:1,mode:'evidence',source:'admin',setByUserId:admin.userId}))).rejects.toThrow();
  const group=await groupAdmin();
  expect(await setPayrollLearningMode(group,{companyId:b.companyId,mode:'evidence'})).toMatchObject({mode:'evidence',version:1});
  const result=await learn();
  expect(result.companies).toEqual([expect.objectContaining({companyId:b.companyId,status:'ran'})]);
  // Stable: 6; provisional: e2, e3, e4; not yet: the five joiners (regular basis, the as-of month).
  expect(result.companies[0].counts).toMatchObject({people:14,stable:6,provisional:3,none:5,rebasing:0,contradicted:0,purged:0});
  const e1=(await stored(people.e1)).filter(row=>row.basis==='regular'&&row.asOfPeriod===AS_OF);
  expect(e1).toHaveLength(1);
  expect(e1[0]).toMatchObject({companyId:b.companyId,status:'stable',runs:7,excluded:0,throughPeriod:MONTHS[6],sponsorUserId:group.userId,method:'payroll_baseline@v1',version:expect.any(Number)});
  expect(e1[0].components.net).toEqual({n:7,median:410000,p10:400000,p90:420000,nonZero:7,monthMask:expect.any(Number),fixed:false});
  // The baseline of the latest closed month rests on the six months before it.
  const latest=(await stored(people.e1)).find(row=>row.basis==='regular'&&row.asOfPeriod===MONTHS[6])!;
  expect(latest).toMatchObject({status:'stable',runs:6,throughPeriod:MONTHS[5]});
  expect(latest.components.net).toMatchObject({median:405000,p10:400000,p90:420000});
  expect((await stored(people.e3)).find(row=>row.basis==='regular'&&row.asOfPeriod===AS_OF)).toMatchObject({status:'provisional',runs:3,excluded:4});
  expect((await stored(people.e4)).find(row=>row.basis==='regular'&&row.asOfPeriod===AS_OF)).toMatchObject({status:'provisional',runs:3,excluded:4});
  expect((await stored(people.fresh[0])).find(row=>row.basis==='regular'&&row.asOfPeriod===AS_OF)).toMatchObject({status:'none',runs:2});
  // Learning again with nothing changed appends nothing; the run is still recorded.
  const before=(await owner.db.select().from(payrollLearnedBaseline)).length;
  expect((await learn()).companies[0].counts).toMatchObject({appended:0});
  expect((await owner.db.select().from(payrollLearnedBaseline)).length).toBe(before);
  expect((await owner.db.select().from(payrollLearningRun)).map(row=>[row.status,row.trigger])).toEqual([['ran','sweep'],['ran','sweep']]);
  // A changed month is a new version, never an update.
  await fixture(tx=>tx.update(schema.payslip).set({netPay:'4300.00'}).where(and(eq(schema.payslip.batchId,people.batches[6]),eq(schema.payslip.employmentId,people.e1))));
  await learn();
  const versions=(await stored(people.e1)).filter(row=>row.basis==='regular'&&row.asOfPeriod===AS_OF);
  expect(versions.map(row=>[row.version>0,row.components.net.p90])).toEqual([[true,420000],[true,430000]]);
  expect(versions[1].version).toBeGreaterThan(versions[0].version);
 },180000);
 it('stops for a company whose sponsor lost payroll authority, and refuses classify and a non-administrator',async()=>{
  const admin=await companyAdmin(b.companyId);
  await company();
  const group=await switchOn();
  await expect(setPayrollLearningMode(group,{companyId:b.companyId,mode:'classify'})).rejects.toBeInstanceOf(PayrollLearningRefused);
  await expect(setPayrollLearningMode(group,{companyId:b.companyId,mode:'evidence'})).rejects.toMatchObject({reason:'unchanged'});
  const employee=await createAppUser(b.tenantId,null,'employee');
  await expect(setPayrollLearningMode({...(await entitledCtx(b,['employee'])),userId:employee,roles:['employee'],grants:[{role:'employee',companyId:null}]},
   {companyId:b.companyId,mode:'off'})).rejects.toMatchObject({reason:'not_permitted'});
  // The database refuses classify set directly, and an update of the mode.
  await expect(withTenant(admin,tx=>tx.insert(payrollLearningMode).values({tenantId:b.tenantId,companyId:b.companyId,version:9,mode:'classify',source:'admin',setByUserId:admin.userId}))).rejects.toThrow();
  await expect(withTenant(admin,tx=>tx.update(payrollLearningMode).set({mode:'off'}).where(eq(payrollLearningMode.companyId,b.companyId)))).rejects.toThrow();
  await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,group.userId));
  const result=await learn();
  expect(result.companies).toEqual([expect.objectContaining({companyId:b.companyId,status:'sponsor_lost'})]);
  expect(await owner.db.select().from(payrollLearnedBaseline)).toEqual([]);
  // Switched off again by a payroll administrator of the company, it is not learned and nothing is shown.
  await setPayrollLearningMode(admin,{companyId:b.companyId,mode:'off'});
  expect((await learn()).companies).toEqual([]);
  expect((await owner.db.select().from(payrollLearningMode).where(eq(payrollLearningMode.companyId,b.companyId))).map(row=>[row.version,row.mode])).toEqual([[1,'evidence'],[2,'off']]);
 },180000);
});

describe('row-level security',()=>{
 it('gives baselines to a payroll administrator of the company only: never another company, another tenant, an employee or the agent principal',async()=>{
  const admin=await companyAdmin(b.companyId);
  const people=await company();
  await switchOn();await learn();
  const mine=await withTenant(admin,tx=>tx.select().from(payrollLearnedBaseline));
  expect(mine.length).toBeGreaterThan(0);
  const [other]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Other Sdn Bhd'}).returning({id:schema.company.id});
  const outsider=await companyAdmin(other.id);
  expect(await withTenant(outsider,tx=>tx.select().from(payrollLearnedBaseline))).toEqual([]);
  const b2=await seedBase();
  expect(await withTenant(adminCtx(b2),tx=>tx.select().from(payrollLearnedBaseline))).toEqual([]);
  // The person themself, logged in as an employee.
  const [person]=await owner.db.select({personId:schema.employment.personId}).from(schema.employment).where(eq(schema.employment.id,people.e1));
  const employeeUser=await createAppUser(b.tenantId,person.personId,'employee');
  const employee={...(await entitledCtx(b,['employee'])),userId:employeeUser,personId:person.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  expect(await withTenant(employee,tx=>tx.select().from(payrollLearnedBaseline))).toEqual([]);
  const agent=agentContext(b.tenantId,principalId,(await entitledCtx(b)).entitlements!);
  expect(await withTenant(agent,tx=>tx.select().from(payrollLearnedBaseline))).toEqual([]);
  // Nobody writes another company's, the agent writes none, and nobody updates or deletes one.
  const row=mine[0];
  const copy={tenantId:b.tenantId,companyId:b.companyId,employmentId:row.employmentId,basis:row.basis,asOfPeriod:row.asOfPeriod,version:1,status:row.status,runs:row.runs,
   excluded:row.excluded,throughPeriod:row.throughPeriod,components:row.components,inputDigest:'b'.repeat(64),method:row.method};
  await expect(withTenant(outsider,tx=>tx.insert(payrollLearnedBaseline).values({...copy,sponsorUserId:outsider.userId}))).rejects.toThrow();
  await expect(withTenant(agent,tx=>tx.insert(payrollLearnedBaseline).values({...copy,sponsorUserId:admin.userId}))).rejects.toThrow();
  await expect(withTenant(admin,tx=>tx.update(payrollLearnedBaseline).set({status:'stable'}).where(eq(payrollLearnedBaseline.id,row.id)))).rejects.toThrow();
  await expect(withTenant(admin,tx=>tx.delete(payrollLearnedBaseline).where(eq(payrollLearnedBaseline.id,row.id)))).rejects.toThrow();
  expect((await owner.db.select().from(payrollLearnedBaseline).where(eq(payrollLearnedBaseline.id,row.id)))[0]).toMatchObject({status:row.status});
  // The run records carry counts only, read by the agent principal and the payroll administrator, not by the outsider.
  expect((await withTenant(agent,tx=>tx.select().from(payrollLearningRun))).length).toBe(1);
  expect((await withTenant(outsider,tx=>tx.select().from(payrollLearningRun)))).toEqual([]);
 },180000);
});

describe('cascade, erasure and the leaver retention purge',()=>{
 it('goes with its employment, and with the person in an admitted erasure, leaving payslips and other people alone',async()=>{
  const admin=await companyAdmin(b.companyId);
  const people=await company();
  await switchOn();await learn();
  // Cascade: a bare employment with one baseline, deleted.
  const [person]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional Cascade',primaryEmail:`cascade-${randomUUID()}@fixture.test`}).returning({id:schema.person.id});
  const [bare]=await owner.db.insert(schema.employment).values({tenantId:b.tenantId,personId:person.id,companyId:b.companyId,hiredOn:'2024-01-01'}).returning({id:schema.employment.id});
  const template=(await stored(people.e1))[0];
  await withTenant(admin,tx=>tx.insert(payrollLearnedBaseline).values({tenantId:b.tenantId,companyId:b.companyId,employmentId:bare.id,basis:'regular',asOfPeriod:AS_OF,version:1,
   status:'none',runs:0,excluded:0,throughPeriod:null,components:{},inputDigest:'c'.repeat(64),method:template.method,sponsorUserId:admin.userId}));
  expect(await stored(bare.id)).toHaveLength(1);
  await owner.db.delete(schema.employment).where(eq(schema.employment.id,bare.id));
  expect(await stored(bare.id)).toEqual([]);
  // Erasure: every baseline of the person, nobody else's; their payslips stay.
  const slips=async(employmentId:string)=>(await owner.db.select({id:schema.payslip.id}).from(schema.payslip).where(eq(schema.payslip.employmentId,employmentId))).length;
  const before={e1:(await stored(people.e1)).length,e2:(await stored(people.e2)).length,slips:await slips(people.e1)};
  expect(before.e1).toBeGreaterThan(0);
  const report=await erasePersonPii(await entitledCtx(b),{subjectEmploymentId:people.e1,scope:'contact',reason:'Fictional privacy request',requestRef:'fixture-'+randomUUID()});
  expect(report.erased).toContain('payrollLearnedBaselines');
  expect(await stored(people.e1)).toEqual([]);
  expect((await stored(people.e2)).length).toBe(before.e2);
  expect(await slips(people.e1)).toBe(before.slips);
  // Outside an admitted erasure the function refuses.
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.payroll_learned_baseline_redact(${people.e2}::uuid)`))).rejects.toThrow();
  expect((await stored(people.e2)).length).toBe(before.e2);
 },180000);
 it('deletes a leaver\'s baselines 3 months after their final pay closed, keeps a recent leaver\'s and every payslip, and never learns them again',async()=>{
  const admin=await companyAdmin(b.companyId);
  const early=(await hire('Early Leaver Fictional')).employmentId,recent=(await hire('Recent Leaver Fictional')).employmentId;
  // Early: paid months 1 to 4, the last closed at its month's end (long ago). Recent: paid all seven, the last closed 30 days ago.
  for(const [i,period] of MONTHS.entries())await run(period,[...(i<4?[{employmentId:early,net:'2800.00'}]:[]),{employmentId:recent,net:'2600.00'}],
   i===6?{closedAt:new Date(Date.now()-30*86_400_000)}:{});
  await switchOn();await learn();
  expect((await stored(early)).length).toBeGreaterThan(0);expect((await stored(recent)).length).toBeGreaterThan(0);
  await owner.db.update(schema.employment).set({terminatedOn:lastDay(MONTHS[3])}).where(eq(schema.employment.id,early));
  await owner.db.update(schema.employment).set({terminatedOn:lastDay(MONTHS[6])}).where(eq(schema.employment.id,recent));
  const slipsBefore=(await owner.db.select().from(schema.payslip)).length;
  const result=await learn();
  expect(result.purged).toBeGreaterThan(0);
  expect(await stored(early)).toEqual([]);
  expect((await stored(recent)).length).toBeGreaterThan(0);
  expect((await owner.db.select().from(schema.payslip)).length).toBe(slipsBefore);
  expect(result.companies[0].counts?.purged).toBeGreaterThan(0);
  // Learning again does not bring the early leaver back, and the database refuses to.
  await learn();
  expect(await stored(early)).toEqual([]);
  await expect(withTenant(admin,tx=>tx.insert(payrollLearnedBaseline).values({tenantId:b.tenantId,companyId:b.companyId,employmentId:early,basis:'regular',asOfPeriod:AS_OF,version:1,
   status:'none',runs:0,excluded:0,throughPeriod:null,components:{},inputDigest:'d'.repeat(64),method:'payroll_baseline@v1',sponsorUserId:admin.userId}))).rejects.toThrow();
 },180000);
});

describe('the trigger: the payroll tick',()=>{
 it('learns after a close, an unlock or a reset and after a payroll-history import is confirmed or reverted, and leaves an unchanged company alone',async()=>{
  const admin=await companyAdmin(b.companyId);
  const people=await company();
  const imported=await importedMonth(people.e1,shift(MONTHS[0],-1),'3000.00','3100.00');
  await switchOn();
  const entitlements=(await entitledCtx(b)).entitlements!;
  const tick=async()=>{const result=await runPayrollTick(owner.client,{tenantId:b.tenantId,principalId,entitlements});
   if(result.status!=='ran'||!result.learning)throw Error('The tick did not run.');return result.learning.companies.map(c=>c.status);};
  expect(await tick()).toEqual(['ran']);
  expect(await tick()).toEqual(['unchanged']);
  const event=async(aggregateType:string,aggregateId:string,eventType:string)=>withTenant(admin,tx=>appendEvent(tx,{tenantId:b.tenantId,aggregateType,aggregateId,eventType,
   actor:actorOf(admin),payload:{fictional:true}}));
  for(const type of ['payroll-batch.closed','payroll-batch.unlocked','payroll-batch.reset']){
   await new Promise(resolve=>setTimeout(resolve,20));
   await event('payroll-batch',people.batches[6],type);
   expect(await tick(),type).toEqual(['ran']);
   expect(await tick(),type).toEqual(['unchanged']);
  }
  for(const type of ['payroll-history-import.committed','payroll-history-import.reverted']){
   await new Promise(resolve=>setTimeout(resolve,20));
   await event('payroll-history-import',imported.attempt,type);
   expect(await tick(),type).toEqual(['ran']);
   expect(await tick(),type).toEqual(['unchanged']);
  }
  // Another kind of payroll event is not learning's business.
  await event('payroll-batch',people.batches[6],'payroll-batch.processed');
  expect(await tick()).toEqual(['unchanged']);
  expect((await owner.db.select().from(payrollLearningRun)).map(row=>row.trigger)).toEqual(Array(6).fill('tick'));
 },240000);
});

describe('P2: evidence lines, "Learned this cycle" and the AI read',()=>{
 it('judges a flagged month and a run against the person\'s baseline, from provisional or stable baselines only, for payroll administrators only',async()=>{
  const admin=await companyAdmin(b.companyId);
  const people=await company();
  // The as-of month's run, processed: e1 4500.00 (above 4200.00), a steady person 3000.00 (within), e2 2400.00 (below
  // 2500.00, provisional), a joiner 2000.00 (not yet: no line).
  const batch=await run(AS_OF,[{employmentId:people.e1,net:'4500.00'},{employmentId:people.steady[0],net:'3000.00'},{employmentId:people.e2,net:'2400.00'},
   {employmentId:people.fresh[0],net:'2000.00'}],{status:'processed'});
  const flags=[people.e1,people.steady[0],people.e2,people.fresh[0]].map(employmentId=>({companyId:b.companyId,employmentId}));
  // Off: nothing, whatever is stored.
  expect((await swingFlagEvidence(admin,{period:AS_OF,flags})).size).toBe(0);
  await switchOn();await learn();
  const swing=await swingFlagEvidence(admin,{period:AS_OF,flags});
  expect(Object.fromEntries([...swing].map(([id,e])=>[id,e]))).toEqual({
   [people.e1]:{basis:'month_total',judgement:'above',runs:7,status:'stable',low:400000,high:420000,value:450000},
   [people.steady[0]]:{basis:'month_total',judgement:'within',runs:7,status:'stable',low:300000,high:300000,value:300000},
   [people.e2]:{basis:'month_total',judgement:'below',runs:4,status:'provisional',low:250000,high:250000,value:240000}});
  const queue=await runEvidence(admin,{batchId:batch});
  expect([...queue.keys()].sort()).toEqual([people.e1,people.steady[0],people.e2].sort());
  expect(queue.get(people.e1)).toEqual({basis:'regular',judgement:'above',runs:7,status:'stable',low:400000,high:420000,value:450000});
  // No look-ahead: an earlier month is judged against the baseline built before it.
  const earlier=await swingFlagEvidence(admin,{period:MONTHS[6],flags:[{companyId:b.companyId,employmentId:people.e1}]});
  expect(earlier.get(people.e1)).toMatchObject({runs:6,low:400000,high:420000,value:410000,judgement:'within'});
  // Another company's administrator, an employee and the agent principal get nothing.
  const [other]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Other Sdn Bhd'}).returning({id:schema.company.id});
  expect((await swingFlagEvidence(await companyAdmin(other.id),{period:AS_OF,flags})).size).toBe(0);
  expect((await runEvidence(await companyAdmin(other.id),{batchId:batch})).size).toBe(0);
  const agent=agentContext(b.tenantId,principalId,(await entitledCtx(b)).entitlements!);
  expect((await swingFlagEvidence(agent,{period:AS_OF,flags})).size).toBe(0);
 },180000);
 it('counts the month\'s learning per company, exactly for the page and under the small-group rule for the model, and no amount reaches the model',async()=>{
  const admin=await companyAdmin(b.companyId);
  await company();
  await switchOn();await learn();
  const page=await learnedThisCycle(admin,{period:AS_OF});
  expect(page.companies.map(c=>[c.companyName,c.mode,c.people])).toEqual([['Acme Sdn Bhd','evidence',{stable:6,provisional:3,none:5,rebasing:0,contradicted:0}]]);
  expect(page.companies[0].learnedOn).toBe(todayInKualaLumpur());
  // The read: 3 provisional is under 5, and the next smallest (5 not yet) is withheld with it.
  const out=await payrollLearningStatus(admin,{period:AS_OF}) as unknown as Record<string,unknown>&{companies:{company:string;mode:string;people:Record<string,number|null>}[]};
  expect(out.companies).toEqual([{company:'Acme Sdn Bhd',mode:'evidence',learnedOn:todayInKualaLumpur(),people:{stable:6,provisional:null,notYet:null,rebasing:0,contradicted:0}}]);
  expect(JSON.stringify(out)).not.toMatch(UUID);
  for(const amount of ['4000','4100','410000','400000','3000','300000','2500'])expect(JSON.stringify(out.companies)).not.toContain(amount);
  // Through the harness, as an operations_status topic, declared in full, with no amount, person or id.
  const groupUser=await createAppUser(b.tenantId,null,'hr_admin');await grantAssistant(adminCtx(b),{appUserId:groupUser});
  const group={...(await entitledCtx(b,['hr_admin'])),userId:groupUser,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
  const model=scriptedModel([{calls:[{name:'operations_status',args:{topic:'payroll_learning',period:AS_OF}}]},{final:{reply:'Here is what the page shows.',mode:'answer'}}]);
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx:group,conversationId:randomUUID(),question:'How many people have a settled usual pay range?',
   scope:{companyId:b.companyId,locale:'en'},model,memory:new InMemoryTaskMemoryStore()});
  expect(result.trace.calls).toEqual([expect.objectContaining({tool:'operations_status',status:'ok'})]);
  expect(result.trace.disclosure[0]).toMatchObject({tool:'operations_status',entity:'payroll_learning',undeclared:[],removed:[]});
  const tool=[...(model.requests[1] as ModelRequest).messages].reverse().find(message=>message.role==='tool');
  const sent=String(tool?.content??'');
  expect(sent).toContain('Acme Sdn Bhd');expect(sent).not.toMatch(UUID);
  for(const amount of ['410000','400000','420000','4100.00','4000.00','4200.00','Ravi Fictional','Chong Fictional'])expect(sent).not.toContain(amount);
  // Not a payroll administrator (a manager): refused.
  expect(await payrollLearningStatus({...(await entitledCtx(b,['manager'])),userId:groupUser,roles:['manager'],grants:[{role:'manager',companyId:null}]},{})).toMatchObject({ok:false,refusal:'not_permitted'});
 },180000);
});

describe('the switch, its history and audit, and the stop switch',()=>{
 it('is switched on by a group administrator and off by a payroll administrator, each a version shown with who, and captured in the Audit loop\'s pack',async()=>{
  const admin=await companyAdmin(b.companyId);
  const group=await groupAdmin();
  await setPayrollLearningMode(group,{companyId:b.companyId,mode:'evidence'});
  await setPayrollLearningMode(admin,{companyId:b.companyId,mode:'off'});
  // The settings page's read: the mode now and every change, newest first, for companies whose payroll the viewer runs.
  const view=await learningSettingsView(admin,[b.companyId]);
  expect(view.get(b.companyId)).toMatchObject({mode:'off',version:2});
  expect(view.get(b.companyId)!.history.map(row=>[row.version,row.mode,row.source])).toEqual([[2,'off','admin'],[1,'evidence','admin']]);
  const [other]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Other Sdn Bhd'}).returning({id:schema.company.id});
  expect((await learningSettingsView(await companyAdmin(other.id),[b.companyId])).size).toBe(0);
  // Each change is a payroll-learning.mode-set configuration event, captured for the month by the Audit loop's pack.
  const artefacts=await withTenant(group,tx=>collectPayrollPeriodArtefactsTx(tx,group,{companyId:b.companyId,payPeriod:todayInKualaLumpur().slice(0,7)}));
  const changes=artefacts.filter(item=>item.kind==='config_change'&&item.content.eventType===LEARNING_MODE_EVENT);
  expect(changes.map(item=>[(item.content.payload as {mode:string;from:string}).mode,(item.content.payload as {from:string}).from,item.content.actorId]))
   .toEqual([['evidence','off',group.userId],['off','evidence',admin.userId]]);
 },180000);
 it('learns nothing and shows no evidence while the tenant\'s stop switch is on, still purges, and resumes when it is off',async()=>{
  const admin=await companyAdmin(b.companyId);
  const people=await company();
  const batch=await run(AS_OF,[{employmentId:people.e1,net:'4500.00'}],{status:'processed'});
  const group=await switchOn();
  await setMandateStopSwitch(group,true);
  expect(await learn()).toMatchObject({stopped:true,companies:[]});
  const entitlements=(await entitledCtx(b)).entitlements!;
  const tick=await runPayrollTick(owner.client,{tenantId:b.tenantId,principalId,entitlements});
  expect(tick.status==='ran'&&tick.learning?.stopped).toBe(true);
  expect(await owner.db.select().from(payrollLearnedBaseline)).toEqual([]);
  expect(await owner.db.select().from(payrollLearningRun)).toEqual([]);
  // The database refuses a baseline written anyway.
  await expect(withTenant(group,tx=>tx.insert(payrollLearnedBaseline).values({tenantId:b.tenantId,companyId:b.companyId,employmentId:people.e1,basis:'regular',asOfPeriod:AS_OF,
   version:1,status:'none',runs:0,excluded:0,throughPeriod:null,components:{},inputDigest:'e'.repeat(64),method:'payroll_baseline@v1',sponsorUserId:group.userId}))).rejects.toThrow();
  await setMandateStopSwitch(group,false);
  expect(await learn()).toMatchObject({stopped:false,companies:[expect.objectContaining({status:'ran'})]});
  const flags=[{companyId:b.companyId,employmentId:people.e1}];
  expect((await swingFlagEvidence(admin,{period:AS_OF,flags})).get(people.e1)).toMatchObject({judgement:'above'});
  expect((await runEvidence(admin,{batchId:batch})).get(people.e1)).toMatchObject({judgement:'above'});
  // Stopped again: what is stored stays, but no evidence is shown.
  await setMandateStopSwitch(group,true);
  expect((await swingFlagEvidence(admin,{period:AS_OF,flags})).size).toBe(0);
  expect((await runEvidence(admin,{batchId:batch})).size).toBe(0);
 },240000);
});
