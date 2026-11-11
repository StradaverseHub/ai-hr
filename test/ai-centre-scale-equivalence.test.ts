/** AI Centre at group scale: every owner this branch made set-based answers EXACTLY what it answered at f7ee5177 (the
 * deployed release), on the varied fictional group fixture (test/helpers/ai-centre-scale-fixture.ts) plus Level 2 and
 * Level 3 loops with this week's applied actions and sample reviews, as a group administrator, an HR administrator granted
 * every company one by one, and an HR administrator of one company. The references are verbatim copies of the old owners
 * (test/helpers/ai-centre-scale-legacy.ts). Each comparison is deep equality of the whole answer, order included, and each
 * new owner's statement count is pinned so it cannot grow with the number of companies again. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>undefined}),headers:async()=>new Headers()}));
import type {SessionContext} from '../db/client';
import {terasLoopCase} from '../db/teras-schema';
import {terasLoopAction,terasLoopLevel,terasLoopSampleReview} from '../db/teras-autonomy-schema';
import {ensureAgentPrincipal} from '../core/agent-principal';
import {loopAutonomyDetail,loopCompanyLevels,loopLevelSummaries} from '../core/loops/autonomy-views';
import {currentWeekStart} from '../core/loops/samples';
import {acknowledgedBlocksForPeriods} from '../core/loops/grouped-dispositions';
import {LOOP_IDS} from '../core/loops/types';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {legacyExceptionsAcknowledged,legacyLoopAutonomyDetail,legacyLoopCompanyLevels,legacyLoopLevelSummaries,legacyOpenExceptionsAcrossRuns,legacyRecordReadiness} from './helpers/ai-centre-scale-legacy';
import {recordReadiness} from '../core/record-readiness';
import {orchestrationQueue} from '../core/hr-orchestrator';
import {readinessLoopAsks} from '../core/loops/readiness-asks';
import {openExceptionsAcrossRuns,type OpenExceptionRow} from '../core/payroll-anomaly';
import {observeStatements} from './helpers/statement-observer';

const DAY=86_400_000,LOOP='loop_missing_employee_data' as const;
const NOW=new Date();
const PERIODS=Array.from({length:10},(_,i)=>`2026-${String(i+1).padStart(2,'0')}`);
let b:Base,fixture:ScaleFixture;
const personas=()=>Object.entries(fixture.personas) as [string,SessionContext][];

/** Level 3 in five operating companies (and Level 2 in two), each Level 3 company with this week's applied actions; two
 * of them reviewed (one twice, so the latest review must win), one with fewer actions than the minimum sample. */
async function autonomy(){
 const principalId=await ensureAgentPrincipal(owner.db,b.tenantId);
 const sponsor=fixture.personas.group.userId!;
 const third=fixture.operatingCompanyIds.slice(0,5),second=fixture.operatingCompanyIds.slice(5,7);
 for(const companyId of [...third,...second])await owner.db.insert(terasLoopLevel).values({tenantId:b.tenantId,workerId:LOOP,companyId,level:2,changedBy:'administrator',changedByUserId:sponsor});
 for(const companyId of third)await owner.db.update(terasLoopLevel).set({level:3}).where(and(eq(terasLoopLevel.tenantId,b.tenantId),eq(terasLoopLevel.workerId,LOOP),eq(terasLoopLevel.companyId,companyId)));
 const staff=await owner.db.select({id:terasLoopCase.employmentId,companyId:terasLoopCase.companyId}).from(terasLoopCase).where(eq(terasLoopCase.tenantId,b.tenantId));
 const weekStart=currentWeekStart(NOW),monday=new Date(`${weekStart}T01:00:00+08:00`);
 const ids=new Map<string,string[]>();
 for(const [index,companyId] of third.entries()){
  const people=staff.filter(row=>row.companyId===companyId&&row.id).map(row=>row.id!);
  const count=index===4?3:Math.min(people.length,12+index*7);
  for(let i=0;i<count;i++){
   const employmentId=people[i%people.length];
   const [kase]=await owner.db.insert(terasLoopCase).values({tenantId:b.tenantId,workerId:LOOP,companyId,employmentId,subjectKey:`record:${randomUUID()}`,recipient:'employee',
    state:'open',facts:{gaps:['no_tax_number']},openedRunId:randomUUID(),checkedRunId:randomUUID()}).returning({id:terasLoopCase.id});
   const [action]=await owner.db.insert(terasLoopAction).values({tenantId:b.tenantId,workerId:LOOP,companyId,caseId:kase.id,employmentId,runId:randomUUID(),level:3,state:'applied',
    ruleVersion:'loop_missing_employee_data@v1',sponsorUserId:sponsor,agentPrincipalId:principalId,checks:[],facts:{},ownerRef:randomUUID(),
    appliedAt:new Date(monday.getTime()+i*60_000),undoUntil:new Date(NOW.getTime()+7*DAY)}).returning({id:terasLoopAction.id});
   (ids.get(companyId)??ids.set(companyId,[]).get(companyId)!).push(action.id);
  }
 }
 const review=(companyId:string,at:Date,reviewer:string)=>owner.db.insert(terasLoopSampleReview).values({tenantId:b.tenantId,workerId:LOOP,companyId,weekStart,
  actionIds:ids.get(companyId)!.slice(0,3),reviewedByUserId:reviewer,reviewedAt:at});
 await review(third[0],new Date(NOW.getTime()-2*3_600_000),sponsor);
 await review(third[0],new Date(NOW.getTime()-3_600_000),fixture.personas.multi.userId!);
 await review(third[2],new Date(NOW.getTime()-3_600_000),fixture.personas.single.userId!);
 return {third,second};
}

let levels:Awaited<ReturnType<typeof autonomy>>;
beforeAll(async()=>{
 await migrateTestDb();await resetDb();
 b=await seedBase();
 for(const code of ['assistant','claims','notifications','attendance','lifecycle','payroll'])await setModule(b.tenantId,code,'active');
 fixture=await buildScaleFixture(b,{employments:600,events:3000});
 levels=await autonomy();
},300_000);
afterAll(closeAll);

describe('AI Centre set-based owners answer exactly as the per-company owners did',()=>{
 it('Loops overview: every loop\'s level summary and company levels, for every persona',async()=>{
  for(const [name,ctx] of personas()){
   expect(await loopLevelSummaries(ctx),name).toEqual(await legacyLoopLevelSummaries(ctx));
   expect(await loopCompanyLevels(ctx),name).toEqual(await legacyLoopCompanyLevels(ctx));
  }
  // The fixture is not trivial: the group administrator sees Level 3, Level 2 and Prepare companies for the loop.
  const summary=(await loopLevelSummaries(fixture.personas.group))[LOOP];
  expect(summary.map(row=>row.level)).toEqual([3,2,1]);
  expect(summary.find(row=>row.level===3)?.count).toBe(levels.third.length);
  // One statement for every loop's levels, not one per loop.
  const observed=await observeStatements(()=>loopLevelSummaries(fixture.personas.group));
  expect(observed.statements.length).toBe(3);
 },120_000);

 it('Loop detail: levels, actions, figures and every Level 3 company\'s weekly sample, for every persona and loop',async()=>{
  for(const [name,ctx] of personas())for(const id of LOOP_IDS){
   expect(await loopAutonomyDetail(ctx,id,{now:NOW}),`${name} ${id}`).toEqual(await legacyLoopAutonomyDetail(ctx,id,{now:NOW}));
  }
  const view=await loopAutonomyDetail(fixture.personas.group,LOOP,{now:NOW});
  expect(view.samples.map(sample=>sample.companyId).sort()).toEqual([...levels.third].sort());
  expect(view.samples.every(sample=>sample.actions.length>0)).toBe(true);
  expect(view.samples.filter(sample=>sample.reviewed).length).toBe(2);
  // Statements no longer grow with the Level 3 companies: the old owner sent two to four more for each of them.
  const now=await observeStatements(()=>loopAutonomyDetail(fixture.personas.group,LOOP,{now:NOW}));
  const before=await observeStatements(()=>legacyLoopAutonomyDetail(fixture.personas.group,LOOP,{now:NOW}));
  expect(now.statements.length).toBeLessThanOrEqual(12);
  expect(before.statements.length).toBeGreaterThanOrEqual(now.statements.length+2*(levels.third.length-1));
 },180_000);

 it('Exceptions: every month\'s acknowledged blocks in one transaction, row for row as one transaction per month gave them',async()=>{
  const cases:readonly(readonly string[])[]=[PERIODS,PERIODS.slice(3,6),[PERIODS[9],PERIODS[0]],[PERIODS[2],PERIODS[2]],['2025-12'],[]];
  for(const [name,ctx] of personas())for(const companies of [fixture.companyIds,fixture.companyIds.slice(7,9),[]] as const)for(const periods of cases){
   expect(await acknowledgedBlocksForPeriods(ctx,{companyIds:companies,payPeriods:periods}),`${name} ${periods.join(',')}`)
    .toEqual(await legacyExceptionsAcknowledged(ctx,companies,periods));
  }
  const all=await acknowledgedBlocksForPeriods(fixture.personas.group,{companyIds:fixture.companyIds,payPeriods:PERIODS});
  // Non-trivial: acknowledged blocks in every one of the ten months.
  expect(new Set(all.map(row=>row.payPeriod)).size).toBe(10);
  const observed=await observeStatements(()=>acknowledgedBlocksForPeriods(fixture.personas.group,{companyIds:fixture.companyIds,payPeriods:PERIODS}));
  expect(observed.transactions).toBe(1);
  expect(observed.statements.length).toBeLessThanOrEqual(4);
 },180_000);
 it('Exceptions queue: the page bounded in SQL is the page the in-memory sort gave, with the same counts',async()=>{
  // Worst first, then oldest first. The old in-memory sort left verdicts of the same time in the database's row order;
  // the bounded read settles them by verdict id. So: the same counts, the same (severity, time) sequence, the same rows
  // wherever a time is not split by the page's edge, and the same rows outright when nothing is cut off.
  const rank=(row:OpenExceptionRow)=>row.disposition==='block'?0:row.disposition==='review'?1:2;
  const key=(row:OpenExceptionRow)=>`${rank(row)}|${row.computedAt.getTime()}`;
  const canon=(rows:readonly OpenExceptionRow[])=>[...rows].sort((a,b)=>rank(a)-rank(b)||a.computedAt.getTime()-b.computedAt.getTime()||a.verdictId.localeCompare(b.verdictId));
  let compared=0;
  for(const [name,ctx] of personas())for(const limit of [1000,100,25,7,1,undefined]){
   const now=await openExceptionsAcrossRuns(ctx,limit===undefined?undefined:{limit}),before=await legacyOpenExceptionsAcrossRuns(ctx,limit===undefined?undefined:{limit});
   const label=`${name} limit ${limit}`;
   expect({total:now.total,blocking:now.blocking,cappedOut:now.cappedOut},label).toEqual({total:before.total,blocking:before.blocking,cappedOut:before.cappedOut});
   expect(now.rows.map(key),label).toEqual(before.rows.map(key));
   const edge=now.rows.length?key(now.rows[now.rows.length-1]):null;
   expect(canon(now.rows.filter(row=>key(row)!==edge)),label).toEqual(canon(before.rows.filter(row=>key(row)!==edge)));
   if(!before.cappedOut)expect(canon(now.rows),label).toEqual(canon(before.rows));
   compared+=now.rows.length;
  }
  // Non-trivial: the group administrator's queue is longer than a page and holds both blocks and reviews.
  const group=await openExceptionsAcrossRuns(fixture.personas.group,{limit:25});
  expect(group.cappedOut).toBe(true);expect(group.blocking).toBeGreaterThan(0);expect(group.total).toBeGreaterThan(group.blocking);
  expect(compared).toBeGreaterThan(100);
  const observed=await observeStatements(()=>openExceptionsAcrossRuns(fixture.personas.group));
  expect(observed.statements.length).toBe(3);
 },180_000);
 it('Record readiness: the screen\'s read (compensation probed per employment, planned without JIT) answers as before',async()=>{
  for(const [name,ctx] of personas())for(const peopleLimit of [undefined,0,3,Number.POSITIVE_INFINITY]){
   const opts=peopleLimit===undefined?undefined:{peopleLimit};
   const before=await legacyRecordReadiness(ctx,opts);
   expect(await recordReadiness(ctx,{...opts,planWithoutJit:true}),`${name} ${peopleLimit}`).toEqual(before);
   expect(await recordReadiness(ctx,opts),`${name} ${peopleLimit} (other callers)`).toEqual(before);
  }
  // Non-trivial: every gap occurs, and the group administrator sees ready and unready people.
  const view=await recordReadiness(fixture.personas.group,{peopleLimit:Number.POSITIVE_INFINITY,planWithoutJit:true});
  expect(view.gaps.map(gap=>gap.id).sort()).toEqual(['no_bank_account','no_compensation','no_epf_number','no_identity','no_socso_number','no_tax_number']);
  expect(view.ready).toBeGreaterThan(0);expect(view.ready).toBeLessThan(view.employees);
  // The screen's three reads keep their statements: one per read plus each transaction's identity and its JIT setting.
  const read=await observeStatements(async()=>{const v=await recordReadiness(fixture.personas.group,{planWithoutJit:true});
   await orchestrationQueue(fixture.personas.group);return readinessLoopAsks(fixture.personas.group,v.gaps.flatMap(g=>g.people.map(p=>p.employmentId)));});
  expect(read.transactions).toBe(3);
  expect(read.statements.filter(s=>!/^select b\.oid, b\.typarray/i.test(s.sql.trim())).length).toBe(13);
  expect(read.statements.filter(s=>/^set local jit\s*=\s*off$/i.test(s.sql.trim())).length).toBe(3);
 },180_000);
});
