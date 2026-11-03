/** AI v2 Phase 2 P2-1 — the autonomy ladder on fictional data over the real owners (migration 0963, core/loops).
 *
 *  1. The cap: pay, employment status, access, discipline and statutory filing loops (probation, payroll inputs and
 *     passports) can never stand above Prepare, in code or in the database, for any company.
 *  2. The promotion certificate is computed from the loop's own case and run records; only a group administrator
 *     promotes, one level at a time, with a met certificate, recorded with their name, and can move it back at any time.
 *  3. At Level 2 the missed clock-outs loop sets a missed clock-out to the roster end through the attendance owner only
 *     when its conditions hold (no approved leave, the day unchanged, the condition the company chose), never more than
 *     the company's nightly limit, never in a company at Prepare, and tells the employee.
 *  4. Undo, by the employee or by HR, is a compensating correction through the owner, recorded as its own row and
 *     event, never a delete; refused after the window, twice, or by anyone else.
 *  5. More than 1% of the last 7 days' actions undone or changed by people moves the loop back to Prepare there, with
 *     a "Moved down" card on Today listing the corrections.
 *  6. Tenant, company and person isolation; a sponsor who lost access stops the loop and the employee's own undo.
 *  7. No model is called (the gateway is replaced by one that counts and refuses).
 *  8. Attribution: the loop's own correction, its events and the approvals history name the agent principal and the
 *     loop under its sponsor's mandate, never the sponsor alone; an undo records who asked; nothing else can write it.
 *  9. Missing employee data at Level 2 sends the request itself, within limits, changing no record; HR withdraws it.
 * 10. Level 3 acts as Level 2, but HR reviews a weekly sample (at least 10% and at least 5) instead of every action.
 * 11. A group administrator lowers limits or changes the condition at any time, recorded with their name; raising
 *     needs a promotion. The roster-end condition acts only when every part of it holds.
 * Expected values are written out from the fixtures, never re-derived from the loops' own helpers. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';

const model=vi.hoisted(()=>({calls:0}));
vi.mock('../lib/ai',async importOriginal=>{
 const original=await importOriginal<typeof import('../lib/ai')>();
 const refuse=async()=>{model.calls++;throw new Error('No model call is allowed in a loop.');};
 return {...original,generateDraft:refuse,converse:refuse,readImage:refuse};
});

import * as schema from '../db/schema';
import {terasLoopCase,terasLoopRun} from '../db/teras-schema';
import {terasLoopAction,terasLoopActionUndo,terasLoopLevel,terasLoopLevelChange,terasLoopSampleReview} from '../db/teras-autonomy-schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {agentContext,ensureAgentPrincipal} from '../core/agent-principal';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {checkIn,decideAttendanceCorrection,requestAttendanceCorrection,attendanceForEmploymentRange} from '../core/attendance';
import {attendanceClockData} from '../core/attendance-clock-data';
import {assignDefaultShift,createShift} from '../core/roster';
import {dispatchNotifications} from '../core/notifications';
import {runLoop} from '../core/loops/run';
import {readLoopCards} from '../core/loops/cards';
import {setLoopPause} from '../core/loops/controls';
import {LoopLevelRefused,changeLoopLimits,setLoopLevel} from '../core/loops/levels';
import {currentWeekStart,reviewLoopSample} from '../core/loops/samples';
import {setLoopAttributionTx} from '../core/loops/attribution';
import {loopAttribution} from '../lib/ai-centre/loop-attribution';
import {shapeApprovalHistoryItems} from '../lib/approval-history';
import {listApprovalHistory} from '../core/read';
import {undoLoopAction} from '../core/loops/undo';
import {loopAutonomyDetail,loopPromotion} from '../core/loops/autonomy-views';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const DAY_MS=86_400_000,LOOP='loop_missed_clock_outs' as const;
/** HR calendar days from the repository's HR date owner (Asia/Kuala_Lumpur), then plain date arithmetic. */
const TODAY=todayInKualaLumpur();
const day=(offset:number)=>new Date(Date.parse(`${TODAY}T00:00:00Z`)+offset*DAY_MS).toISOString().slice(0,10);
const YESTERDAY=day(-1),EARLIER=day(-2);
const LIMITS={maxActionsPerNight:2,undoDays:3,condition:'roster_end'} as const;
let b:Base,principalId:string,group:Login,shift:string;

type Login=SessionContext&{employmentId:string;personId:string;userId:string};
async function login(base:Base,name:string,role:'employee'|'manager'|'hr_admin',companyId=base.companyId,departmentId=base.deptA):Promise<Login>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:`${randomUUID()}@fixture.test`},companyId,departmentId,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);
 const ctx=await entitledCtx(base,[role]);
 return {...ctx,userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}],employmentId:hired.employmentId};
}
/** An HR administrator of one company only. */
async function companyAdmin(base:Base,companyId:string,departmentId:string):Promise<Login>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional Company Administrator',primaryEmail:`${randomUUID()}@fixture.test`},companyId,departmentId,employmentType:'full_time',hiredOn:'2024-01-01'});
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:`user_${randomUUID()}`,personId:hired.personId}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId,role:'hr_admin'});
 const ctx=await entitledCtx(base,['hr_admin']);
 return {...ctx,userId:user.id,personId:hired.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId}],employmentId:hired.employmentId};
}
async function secondCompany(name='Fictional Second Sdn Bhd'){
 const [company]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:name}).returning();
 const [dept]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:company.id,name:'Fictional Ops'}).returning();
 return {companyId:company.id,deptId:dept.id};
}
/** An employee on the 09:00–18:00 shift who clocked in on `date` and never clocked out. */
async function clockedIn(name:string,date=YESTERDAY,companyId=b.companyId,deptId=b.deptA,time='09:02'){
 const e=await login(b,name,'employee',companyId,deptId);
 await assignDefaultShift(adminCtx(b),{employmentId:e.employmentId,shiftId:shift});
 await checkIn(adminCtx(b),{employmentId:e.employmentId,date,time,manual:true});
 return e;
}
const entitlements=async()=>(await entitledCtx(b)).entitlements!;
const run=async()=>runLoop(LOOP,{tenantId:b.tenantId,principalId,entitlements:await entitlements(),today:TODAY});
const on=()=>setWorkerSwitch(group,{workerId:LOOP,enabled:true});
/** The loop's evidence for a company: prepared cases in the window and time at Prepare, written as fixtures. */
async function certify(companyId:string,employmentId:string,p:Readonly<{cases?:number;changed?:number;daysAgo?:number;workerId?:typeof LOOP|'loop_missing_employee_data'}>={}){
 const cases=p.cases??214,changed=p.changed??1,at=new Date(),started=new Date(Date.now()-(p.daysAgo??34)*DAY_MS),workerId=p.workerId??LOOP;
 await owner.db.insert(terasLoopCase).values(Array.from({length:cases},(_,index)=>({tenantId:b.tenantId,workerId,companyId,employmentId,
  subjectKey:`clockout:${randomUUID()}:2026-01-01`,recipient:'employee' as const,state:'closed' as const,closeReason:'done' as const,
  resolution:index<changed?'changed' as const:'as_prepared' as const,facts:{},firstOpenedAt:at,openedAt:at,checkedAt:at,closedAt:at,openedRunId:randomUUID(),checkedRunId:randomUUID()})));
 await owner.db.insert(terasLoopRun).values({tenantId:b.tenantId,runId:randomUUID(),workerId,companyId,status:'ran',sponsorUserId:group.userId,
  loopVersion:`${workerId}@v1`,startedAt:started,finishedAt:started,checks:[],reads:[]});
}
/** The loop attribution columns of an attendance correction (migration 0963), read as the owner. */
const correctionAttribution=async(id:string)=>(await owner.db.execute(sql`select agent_principal_id::text as principal,agent_worker_id as worker,agent_action_id::text as action,
 agent_sponsor_user_id::text as sponsor,agent_asked_by as asked,agent_asked_by_user_id::text as asker from public.attendance_correction where id=${id}::uuid`) as unknown as
 {principal:string|null;worker:string|null;action:string|null;sponsor:string|null;asked:string|null;asker:string|null}[])[0];
/** Every audit event of one attendance correction: its own aggregate, and the clock and day events that name it. */
const correctionEvents=(id:string)=>owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,b.tenantId),
 sql`(${schema.domainEvent.aggregateId}=${id}::uuid or ${schema.domainEvent.payload}->>'correctionId'=${id})`));
type Attributed={agentAttribution?:Record<string,unknown>};
const promote=(companyId:string,limits:Record<string,unknown>=LIMITS,ctx:SessionContext=group)=>setLoopLevel(ctx,{workerId:LOOP,companyId,toLevel:2,expectedLevel:1,limits});
const actionsOf=(ctx:SessionContext=group)=>withTenant(ctx,tx=>tx.select().from(terasLoopAction).where(eq(terasLoopAction.workerId,LOOP)));
const actionFor=async(employmentId:string)=>(await actionsOf()).find(row=>row.employmentId===employmentId);
const undosOf=(ctx:SessionContext=group)=>withTenant(ctx,tx=>tx.select().from(terasLoopActionUndo));
const levelOf=async(companyId:string)=>(await withTenant(group,tx=>tx.select().from(terasLoopLevel).where(and(eq(terasLoopLevel.workerId,LOOP),eq(terasLoopLevel.companyId,companyId)))))[0];
const caseOf=async(employmentId:string,date:string)=>(await withTenant(group,tx=>tx.select().from(terasLoopCase)
 .where(and(eq(terasLoopCase.workerId,LOOP),eq(terasLoopCase.subjectKey,`clockout:${employmentId}:${date}`)))))[0];
const clockOutOn=async(employmentId:string,date:string)=>(await attendanceForEmploymentRange(adminCtx(b),employmentId,date,date))[0]?.checkOutAt??null;
const pgText=(error:unknown)=>{const parts:string[]=[];for(let cur=error as Record<string,unknown>|undefined,n=0;cur&&typeof cur==='object'&&n<5;cur=cur.cause as never,n++)
 for(const key of ['message','detail','constraint_name'])if(typeof cur[key]==='string')parts.push(cur[key] as string);return parts.join(' | ');};
const failure=(work:Promise<unknown>)=>work.then(()=>'no error',(error:unknown)=>pgText(error));

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 model.calls=0;
 await resetDb();b=await seedBase();
 for(const module of ['payroll','attendance','notifications'])await setModule(b.tenantId,module,'active');
 group=await login(b,'Fictional Group Administrator','hr_admin');
 principalId=await ensureAgentPrincipal(owner.db,b.tenantId);
 // Every day is a working day, so the fixture does not depend on today's weekday.
 shift=(await createShift(adminCtx(b),{name:'Fictional Day',code:`DAY${randomUUID().slice(0,4)}`,startTime:'09:00',endTime:'18:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5,6,7]})).id;
});
afterEach(()=>{expect(model.calls,'a loop called a model').toBe(0);});

describe('the cap',()=>{
 it('keeps probation, payroll inputs and passports at Prepare in code and in the database, for any company and any writer',async()=>{
  const {companyId:second}=await secondCompany();
  for(const workerId of ['loop_probation_ending','loop_payroll_inputs','loop_document_expiry'] as const)for(const companyId of [b.companyId,second]){
   for(const toLevel of [2,3])await expect(setLoopLevel(group,{workerId,companyId,toLevel,expectedLevel:1,limits:LIMITS})).rejects.toMatchObject({reason:'capped'});
   const row={tenantId:b.tenantId,workerId,companyId,level:2 as const,changedBy:'administrator' as const,changedByUserId:group.userId};
   expect(await failure(owner.db.insert(terasLoopLevel).values(row))).toMatch(/teras_loop_level_cap/);
   expect(await failure(withTenant(group,tx=>tx.insert(terasLoopLevel).values(row)))).toMatch(/teras_loop_level_cap/);
   expect(await failure(owner.db.insert(terasLoopLevelChange).values({tenantId:b.tenantId,workerId,companyId,fromLevel:1,toLevel:2,kind:'promoted',changedBy:'administrator',
    changedByUserId:group.userId,limits:{},evidence:{}}))).toMatch(/teras_loop_level_change_cap/);
  }
  // A capped loop cannot even have an automatic action recorded.
  const e=await login(b,'Fictional Payroll Subject','employee');
  const [kase]=await owner.db.insert(terasLoopCase).values({tenantId:b.tenantId,workerId:'loop_payroll_inputs',companyId:b.companyId,employmentId:null,
   subjectKey:`payroll:${b.companyId}:2026-07`,recipient:'payroll',state:'open',facts:{},openedRunId:randomUUID(),checkedRunId:randomUUID()}).returning();
  expect(await failure(owner.db.insert(terasLoopAction).values({tenantId:b.tenantId,workerId:'loop_payroll_inputs' as never,companyId:b.companyId,caseId:kase.id,employmentId:e.employmentId,
   runId:randomUUID(),level:2,state:'applying',ruleVersion:'x@v1',sponsorUserId:group.userId,agentPrincipalId:principalId,checks:[],facts:{},undoUntil:new Date(Date.now()+DAY_MS)}))).toMatch(/check constraint/i);
  // Missing employee data may go above Prepare (it sends its request itself), but only with the evidence.
  await expect(setLoopLevel(group,{workerId:'loop_missing_employee_data',companyId:b.companyId,toLevel:2,expectedLevel:1,limits:LIMITS})).rejects.toMatchObject({reason:'certificate'});
  expect(await withTenant(group,tx=>tx.select().from(terasLoopLevel))).toEqual([]);
  // Watch is a move down, allowed for any loop, and hides the loop's cards in that company.
  const p=await login(b,'Fictional Probationer','employee');
  await owner.db.update(schema.employment).set({probationEndDate:day(10)}).where(eq(schema.employment.id,p.employmentId));
  await setWorkerSwitch(group,{workerId:'loop_probation_ending',enabled:true});
  await runLoop('loop_probation_ending',{tenantId:b.tenantId,principalId,entitlements:await entitlements(),today:TODAY});
  expect((await readLoopCards(group,{scopeIds:[b.companyId],admin:true})).map(card=>card.kind)).toEqual(['probation']);
  await setLoopLevel(group,{workerId:'loop_probation_ending',companyId:b.companyId,toLevel:0,expectedLevel:1});
  expect(await readLoopCards(group,{scopeIds:[b.companyId],admin:true})).toEqual([]);
  await setLoopLevel(group,{workerId:'loop_probation_ending',companyId:b.companyId,toLevel:1,expectedLevel:0});
  expect((await readLoopCards(group,{scopeIds:[b.companyId],admin:true})).map(card=>card.kind)).toEqual(['probation']);
 });
});

describe('promotion',()=>{
 it('computes the certificate from the loop\'s own records',async()=>{
  const e=await login(b,'Fictional Evidence Subject','employee');
  await certify(b.companyId,e.employmentId,{cases:214,changed:1,daysAgo:34});
  let view=await loopPromotion(group,LOOP,b.companyId);
  expect(view).toMatchObject({level:1,targetLevel:2,capped:false,hasActor:true,canChange:true,
   evidence:{currentLevel:1,prepared:214,asPrepared:213,changed:1,ruleBroken:0,daysAtLevel:34},
   certificate:{targetLevel:2,met:true}});
  expect(view.certificate!.criteria.map(item=>[item.id,item.actual,item.met])).toEqual([['prepared',214,true],['changed',1/214,true],['rule_broken',0,true],['days_at_level',34,true]]);
  // Too many changed by people, or too little time at the level, in other companies.
  const changed=await secondCompany('Fictional Changed Sdn Bhd');
  await certify(changed.companyId,e.employmentId,{cases:200,changed:3,daysAgo:40});
  expect((await loopPromotion(group,LOOP,changed.companyId)).certificate!.criteria.filter(item=>!item.met).map(item=>[item.id,item.actual])).toEqual([['changed',3/200]]);
  const young=await secondCompany('Fictional Young Sdn Bhd');
  await certify(young.companyId,e.employmentId,{cases:200,changed:0,daysAgo:20});
  expect((await loopPromotion(group,LOOP,young.companyId)).certificate!.criteria.filter(item=>!item.met).map(item=>[item.id,item.actual])).toEqual([['days_at_level',20]]);
  const few=await secondCompany('Fictional Few Sdn Bhd');
  await certify(few.companyId,e.employmentId,{cases:150,changed:0,daysAgo:40});
  expect((await loopPromotion(group,LOOP,few.companyId)).certificate!.criteria.filter(item=>!item.met).map(item=>[item.id,item.actual])).toEqual([['prepared',150]]);
  // A run that did not finish is a broken rule.
  await owner.db.insert(terasLoopRun).values({tenantId:b.tenantId,runId:randomUUID(),workerId:LOOP,companyId:null,status:'failed',sponsorUserId:group.userId,
   loopVersion:'loop_missed_clock_outs@v1',startedAt:new Date(),finishedAt:new Date(),checks:[],reads:[]});
  view=await loopPromotion(group,LOOP,b.companyId);
  expect(view.certificate!.criteria.filter(item=>!item.met).map(item=>[item.id,item.actual])).toEqual([['rule_broken',1]]);
  await expect(promote(b.companyId)).rejects.toMatchObject({reason:'certificate'});
 });

 it('only a group administrator promotes, one level at a time, recorded with their name and reversible',async()=>{
  const e=await login(b,'Fictional Evidence Subject','employee');
  await certify(b.companyId,e.employmentId);
  const scoped=await companyAdmin(b,b.companyId,b.deptA);
  await expect(promote(b.companyId,LIMITS,scoped)).rejects.toMatchObject({reason:'not_group_administrator'});
  await expect(promote(b.companyId,LIMITS,e)).rejects.toBeInstanceOf(LoopLevelRefused);
  expect(await failure(withTenant(scoped,tx=>tx.insert(terasLoopLevel).values({tenantId:b.tenantId,workerId:LOOP,companyId:b.companyId,level:2,
   changedBy:'administrator',changedByUserId:scoped.userId})))).toMatch(/row-level security/i);
  // The agent principal can never raise a level, nor write a promotion.
  const agent=agentContext(b.tenantId,principalId,await entitlements());
  expect(await failure(withTenant(agent,tx=>tx.insert(terasLoopLevel).values({tenantId:b.tenantId,workerId:LOOP,companyId:b.companyId,level:2,
   changedBy:'administrator',changedByUserId:group.userId})))).toMatch(/row-level security/i);
  // Limits outside their closed values are refused, never clamped.
  await expect(promote(b.companyId,{...LIMITS,maxActionsPerNight:500})).rejects.toMatchObject({reason:'invalid'});
  await expect(promote(b.companyId,{...LIMITS,undoDays:5})).rejects.toMatchObject({reason:'invalid'});
  await expect(setLoopLevel(group,{workerId:LOOP,companyId:b.companyId,toLevel:3,expectedLevel:1,limits:LIMITS})).rejects.toMatchObject({reason:'not_next_level'});
  const row=await promote(b.companyId,{maxActionsPerNight:50,undoDays:7,condition:'roster_and_site_exit'});
  expect(row).toMatchObject({companyId:b.companyId,level:2,limits:{maxActionsPerNight:50,undoDays:7,condition:'roster_and_site_exit'},changedBy:'administrator',changedByUserId:group.userId});
  // The condition is recorded with who chose it and when.
  const chosen=await levelOf(b.companyId);
  expect(chosen).toMatchObject({actCondition:'roster_and_site_exit',conditionSetByUserId:group.userId});
  expect(Math.abs(chosen.conditionSetAt!.getTime()-Date.now())).toBeLessThan(60_000);
  // A stale page is refused; Level 3 needs 90 days at Level 2.
  await expect(promote(b.companyId)).rejects.toMatchObject({reason:'changed'});
  await expect(setLoopLevel(group,{workerId:LOOP,companyId:b.companyId,toLevel:3,expectedLevel:2,limits:LIMITS})).rejects.toMatchObject({reason:'certificate'});
  // The database refuses a jump of two levels even from the owner connection.
  expect(await failure(owner.db.update(terasLoopLevel).set({level:1}).where(eq(terasLoopLevel.companyId,b.companyId)).then(()=>
   owner.db.update(terasLoopLevel).set({level:3}).where(eq(terasLoopLevel.companyId,b.companyId))))).toMatch(/one level at a time/);
  await owner.db.update(terasLoopLevel).set({level:2}).where(eq(terasLoopLevel.companyId,b.companyId));
  // Moved back at any time, recorded too.
  await setLoopLevel(group,{workerId:LOOP,companyId:b.companyId,toLevel:1,expectedLevel:2});
  const history=await withTenant(group,tx=>tx.select().from(terasLoopLevelChange).where(eq(terasLoopLevelChange.companyId,b.companyId)));
  expect(history.map(item=>[item.fromLevel,item.toLevel,item.kind,item.changedBy,item.changedByUserId]).sort()).toEqual([
   [1,2,'promoted','administrator',group.userId],[2,1,'moved_down','administrator',group.userId]].sort());
  const promoted=history.find(item=>item.kind==='promoted')!;
  expect(promoted.limits).toEqual({maxActionsPerNight:50,undoDays:7,condition:'roster_and_site_exit'});
  expect((promoted.evidence as {certificate:{met:boolean}}).certificate.met).toBe(true);
  const audit=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.eventType,'teras-loop.level-changed')));
  expect(audit.map(item=>[item.actorType,item.actorId,(item.payload as {from:number;to:number}).from,(item.payload as {to:number}).to]).sort()).toEqual([
   ['user',group.userId,1,2],['user',group.userId,2,1]].sort());
  // The history is append-only.
  expect(await failure(owner.db.update(terasLoopLevelChange).set({kind:'promoted'}).where(eq(terasLoopLevelChange.id,promoted.id)))).toMatch(/append-only/);
  expect(await failure(owner.db.delete(terasLoopLevelChange).where(eq(terasLoopLevelChange.id,promoted.id)))).toMatch(/append-only/);
 });
});

/** The acting fixture: the main company at Level 2 (roster end, at most two a night, undo for three days), a second
 * company at Prepare, and five people who clocked in and did not clock out. */
async function acting(){
 const second=await secondCompany();
 const e1=await clockedIn('Fictional Early One',EARLIER),e2=await clockedIn('Fictional Early Two',EARLIER);
 const leave=await clockedIn('Fictional On Leave',EARLIER);
 await owner.db.insert(schema.leaveRequest).values({tenantId:b.tenantId,employmentId:leave.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:EARLIER,endDate:EARLIER,
  durationType:'half_day_am',status:'approved',days:'0.5',reason:'Fictional leave',employeeRemark:'Fictional'});
 const late=await clockedIn('Fictional Later One',YESTERDAY);
 const prepared=await clockedIn('Fictional Prepare Company',EARLIER,second.companyId,second.deptId);
 await on();
 await certify(b.companyId,e1.employmentId);
 await promote(b.companyId);
 return {second,e1,e2,leave,late,prepared};
}

describe('acting at Level 2',()=>{
 it('sets the clock-out through the attendance owner only within its conditions and limits, and tells the employee',async()=>{
  const {e1,e2,leave,late,prepared}=await acting();
  expect(await run()).toMatchObject({status:'ran'});
  const actions=await actionsOf();
  const of=(who:Login)=>actions.find(row=>row.employmentId===who.employmentId);
  // Two applied (tonight's limit), the leave day not applied, the third waiting for the next night, nothing at Prepare.
  expect(of(e1)).toMatchObject({state:'applied',level:2,reason:null,ruleVersion:'loop_missed_clock_outs.act@v1',sponsorUserId:group.userId,companyId:b.companyId,
   facts:{date:EARLIER,checkIn:'09:02',checkOut:'18:00'}});
  expect(of(e2)).toMatchObject({state:'applied'});
  expect(of(leave)).toMatchObject({state:'not_applied',reason:'condition_leave',ownerRef:null,appliedAt:null});
  expect(of(leave)!.checks).toEqual(expect.arrayContaining([{check:'no_approved_leave',ruleVersion:'packs/leave/service.ts#approvedLeavePresenceByEmploymentTx',result:'fail'}]));
  expect(of(late)).toBeUndefined();
  expect(of(prepared)).toBeUndefined();
  expect(actions).toHaveLength(3);
  // The undo deadline is three days from the action.
  const undoMs=of(e1)!.undoUntil.getTime()-of(e1)!.appliedAt!.getTime();
  expect(undoMs).toBeGreaterThan(3*DAY_MS-60_000);expect(undoMs).toBeLessThan(3*DAY_MS+60_000);
  // The attendance owner holds the change: an approved correction, the original clock-in kept, one clock-out added.
  expect(await clockOutOn(e1.employmentId,EARLIER)).toBe('18:00:00');
  const raw=await attendanceClockData(adminCtx(b),e1.employmentId,EARLIER);
  expect(raw.rows.filter(row=>!row.voidedAt).map(row=>[row.punchAt,row.direction])).toEqual([['09:02:00','in'],['18:00:00','out']]);
  const [correction]=await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id,of(e1)!.ownerRef!));
  expect(correction.status).toBe('approved');
  expect(correction.reason).toMatch(/^AI Centre: missed clock-out set automatically to the roster end 18:00/);
  expect(correction.reason).not.toMatch(/noveri/i);
  // The correction is the agent principal's, made by the loop under its sponsor's mandate; the sponsor answers for it.
  expect(await correctionAttribution(of(e1)!.ownerRef!)).toEqual({principal:principalId,worker:LOOP,action:of(e1)!.id,sponsor:group.userId,asked:null,asker:null});
  const label='AI Centre loop (missed clock-outs), sponsored by Fictional Group Administrator';
  const events=await correctionEvents(of(e1)!.ownerRef!);
  expect(events.map(item=>item.eventType)).toEqual(expect.arrayContaining(['attendance-correction.requested','attendance-correction.approved']));
  for(const item of events){
   expect([item.eventType,item.actorType,item.actorId]).toEqual([item.eventType,'agent',principalId]);
   expect((item.payload as Attributed).agentAttribution).toMatchObject({workerId:LOOP,principalId,actionId:of(e1)!.id,sponsorUserId:group.userId,askedBy:null,label});
  }
  // The approvals history names the loop and its sponsor as the decider, never the sponsor alone.
  const approvals=shapeApprovalHistoryItems(await listApprovalHistory(group)).filter(item=>item.subjectName==='Fictional Early One');
  expect(approvals.map(item=>item.deciderName)).toEqual([label]);
  // Nothing changed where a condition failed, where the limit was reached, or in the company at Prepare.
  expect(await clockOutOn(leave.employmentId,EARLIER)).toBeNull();
  expect(await clockOutOn(late.employmentId,YESTERDAY)).toBeNull();
  expect(await clockOutOn(prepared.employmentId,EARLIER)).toBeNull();
  // The work is done: the case closes as prepared and leaves Today; the others keep their cards.
  expect(await caseOf(e1.employmentId,EARLIER)).toMatchObject({state:'closed',closeReason:'done',resolution:'as_prepared',facts:{autoApplied:true,recordedCheckOut:'18:00'}});
  expect(await caseOf(leave.employmentId,EARLIER)).toMatchObject({state:'open'});
  expect(await caseOf(late.employmentId,YESTERDAY)).toMatchObject({state:'open'});
  // The employee is told, in-app, as the agent acting for the sponsor; Today shows the fix with its undo window.
  const [notice]=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.eventType,'teras-loop.action.applied'),eq(schema.domainEvent.subjectEmploymentId,e1.employmentId)));
  expect(notice).toMatchObject({actorType:'agent',actorId:principalId,aggregateType:'teras-loop-action',aggregateId:of(e1)!.id});
  expect(notice.payload).toMatchObject({date:EARLIER,checkOut:'18:00',correctionId:of(e1)!.ownerRef,sponsorUserId:group.userId});
  await dispatchNotifications(await entitledCtx(b),{});
  const [bell]=await owner.db.select().from(schema.notification).where(eq(schema.notification.sourceEventId,notice.id));
  expect(bell).toMatchObject({recipientEmploymentId:e1.employmentId,kind:'teras-loop.clock-out-set',title:'Missed clock-out filled in',linkPath:'/'});
  expect(bell.body).toContain(`Your missing clock-out on ${EARLIER} was set to 18:00, the end of your roster.`);
  const own=await readLoopCards(e1,{scopeIds:[],admin:false});
  expect(own).toEqual([{kind:'autoFixed',actionId:of(e1)!.id,date:EARLIER,checkOut:'18:00',undoUntil:of(e1)!.undoUntil.toISOString()}]);
  expect((await readLoopCards(leave,{scopeIds:[],admin:false})).map(card=>card.kind)).toEqual(['clockOut']);
  // HR's Today at Level 2: every action of the last day, and the day the loop left for the person (who keeps their card).
  const feed=(await readLoopCards(group,{scopeIds:[b.companyId],admin:true})).filter(card=>card.kind==='acted'||card.kind==='leftAlone');
  expect(feed).toEqual([
   {kind:'acted',workerId:LOOP,companyId:b.companyId,companyName:'Acme Sdn Bhd',count:2,items:expect.arrayContaining([
    {personName:'Fictional Early One',date:EARLIER,reason:null},{personName:'Fictional Early Two',date:EARLIER,reason:null}]),more:0,href:'/control-tower/loops/loop_missed_clock_outs'},
   {kind:'leftAlone',workerId:LOOP,companyId:b.companyId,companyName:'Acme Sdn Bhd',count:1,items:[{personName:'Fictional On Leave',date:EARLIER,reason:'condition_leave'}],
    more:0,href:'/control-tower/loops/loop_missed_clock_outs'}]);
  expect((await readLoopCards(e1,{scopeIds:[b.companyId],admin:false})).filter(card=>card.kind==='acted'||card.kind==='leftAlone')).toEqual([]);
  // The next night acts once per case at most and keeps within the limit counted for the night.
  expect(await run()).toMatchObject({status:'ran'});
  expect(await actionsOf()).toHaveLength(3);
  // Undo windows and actions are readable only by those allowed: the employee their own, nobody else's.
  expect((await actionsOf(e1)).map(row=>row.employmentId)).toEqual([e1.employmentId]);
  expect(await actionsOf(prepared)).toEqual([]);
 });

 it('does nothing under "roster end and site exit agree" (no site exit is recorded), nor while paused or below Level 2',async()=>{
  const {companyId,deptId}=await secondCompany('Fictional Strict Sdn Bhd');
  const strict=await clockedIn('Fictional Strict Worker',EARLIER,companyId,deptId);
  const paused=await clockedIn('Fictional Paused Worker',EARLIER);
  await on();
  await certify(companyId,strict.employmentId);await certify(b.companyId,paused.employmentId);
  await promote(companyId,{maxActionsPerNight:50,undoDays:7,condition:'roster_and_site_exit'});
  await promote(b.companyId);
  await setLoopPause(group,{workerId:LOOP,companyId:b.companyId,paused:true});
  await run();
  expect((await actionsOf()).map(row=>[row.employmentId,row.state,row.reason])).toEqual([[strict.employmentId,'not_applied','condition_site_exit']]);
  expect(await clockOutOn(strict.employmentId,EARLIER)).toBeNull();
  expect(await clockOutOn(paused.employmentId,EARLIER)).toBeNull();
  // The database refuses an action for a paused company, or one at Prepare, even from the agent principal.
  const agent=agentContext(b.tenantId,principalId,await entitlements());
  const pausedCase=await caseOf(paused.employmentId,EARLIER);
  const values={tenantId:b.tenantId,workerId:LOOP,companyId:b.companyId,caseId:pausedCase?.id??randomUUID(),employmentId:paused.employmentId,runId:randomUUID(),level:2 as const,
   state:'applying' as const,ruleVersion:'loop_missed_clock_outs.act@v1',sponsorUserId:group.userId,agentPrincipalId:principalId,checks:[],facts:{},undoUntil:new Date(Date.now()+DAY_MS)};
  expect(await failure(withTenant(agent,tx=>tx.insert(terasLoopAction).values(values)))).toMatch(/row-level security/i);
  await setLoopPause(group,{workerId:LOOP,companyId:b.companyId,paused:false});
  await setLoopLevel(group,{workerId:LOOP,companyId:b.companyId,toLevel:1,expectedLevel:2});
  await run();
  expect(await clockOutOn(paused.employmentId,EARLIER)).toBeNull();
  const created=await caseOf(paused.employmentId,EARLIER);
  expect(await failure(withTenant(agent,tx=>tx.insert(terasLoopAction).values({...values,caseId:created!.id})))).toMatch(/row-level security/i);
  // An action moves forward once; nothing else about it changes, and it is never deleted.
  const [action]=await actionsOf();
  expect(await failure(owner.db.update(terasLoopAction).set({state:'applied'}).where(eq(terasLoopAction.id,action.id)))).toMatch(/moves forward once|check constraint/);
  expect(await failure(owner.db.update(terasLoopAction).set({undoUntil:new Date(Date.now()+30*DAY_MS)}).where(eq(terasLoopAction.id,action.id)))).toMatch(/keeps its identity/);
  expect(await failure(owner.db.delete(terasLoopAction).where(eq(terasLoopAction.id,action.id)))).toMatch(/append-only/);
 });
});

describe('undo',()=>{
 it('compensates through the owner for the employee or HR within the window, as its own record, and is refused otherwise',async()=>{
  const {e1,e2,late}=await acting();
  await run();
  const a1=(await actionFor(e1.employmentId))!,a2=(await actionFor(e2.employmentId))!;
  // Only an explicit press, and only the person or HR.
  expect(await undoLoopAction(e1,{actionId:a1.id,confirm:'true'})).toEqual({kind:'refused',reason:'not_confirmed'});
  expect(await undoLoopAction(late,{actionId:a1.id,confirm:true})).toEqual({kind:'refused',reason:'unavailable'});
  expect(await undoLoopAction(e1,{actionId:'not-an-id',confirm:true})).toEqual({kind:'refused',reason:'invalid'});
  // After the window: refused in code, and by the database.
  expect(await undoLoopAction(e1,{actionId:a1.id,confirm:true},new Date(a1.undoUntil.getTime()+1000))).toEqual({kind:'refused',reason:'expired'});
  // The employee undoes their own: the clock-out the loop added is voided by an approved compensating correction.
  expect(await undoLoopAction(e1,{actionId:a1.id,confirm:true})).toEqual({kind:'undone',by:'employee'});
  expect(await clockOutOn(e1.employmentId,EARLIER)).toBeNull();
  const raw=await attendanceClockData(adminCtx(b),e1.employmentId,EARLIER);
  expect(raw.rows.map(row=>[row.punchAt,row.direction,row.voidedAt===null])).toEqual([['09:02:00','in',true],['18:00:00','out',false]]);
  const [undo]=await undosOf();
  expect(undo).toMatchObject({actionId:a1.id,undoneBy:'employee',undoneByUserId:e1.userId});
  const [compensation]=await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id,undo.compensationRef));
  expect(compensation).toMatchObject({status:'approved',employmentId:e1.employmentId,attendanceDate:EARLIER});
  expect(compensation.reason).toMatch(/^AI Centre: undo of the clock-out the missed clock-outs loop set on /);
  // The loop carried the undo out at the employee's request, under its sponsor's mandate: said on the correction and its events.
  expect(await correctionAttribution(undo.compensationRef)).toEqual({principal:principalId,worker:LOOP,action:a1.id,sponsor:group.userId,asked:'employee',asker:e1.userId});
  const undoLabel='AI Centre loop (missed clock-outs), at the request of Fictional Early One (the employee), sponsored by Fictional Group Administrator';
  for(const item of await correctionEvents(undo.compensationRef)){
   expect([item.eventType,item.actorType,item.actorId]).toEqual([item.eventType,'agent',principalId]);
   expect((item.payload as Attributed).agentAttribution).toMatchObject({askedBy:'employee',askedByUserId:e1.userId,sponsorUserId:group.userId,label:undoLabel});
  }
  // The applied correction is still on record: nothing was deleted, and the action itself is unchanged.
  expect((await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id,a1.ownerRef!)))[0].status).toBe('approved');
  expect(await actionFor(e1.employmentId)).toMatchObject({state:'applied',ownerRef:a1.ownerRef});
  const [event]=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.eventType,'teras-loop.action.undone'),eq(schema.domainEvent.aggregateId,a1.id)));
  expect(event).toMatchObject({actorType:'agent',actorId:principalId,subjectEmploymentId:e1.employmentId});
  expect((event.payload as Attributed).agentAttribution).toMatchObject({askedBy:'employee',askedByUserId:e1.userId,sponsorUserId:group.userId,label:undoLabel});
  // Twice is refused, and Today no longer offers it.
  expect(await undoLoopAction(e1,{actionId:a1.id,confirm:true})).toEqual({kind:'refused',reason:'changed'});
  expect(await readLoopCards(e1,{scopeIds:[],admin:false})).toEqual([]);
  // HR undoes another employee's fix in its own name; the employee could not undo someone else's.
  expect(await undoLoopAction(e1,{actionId:a2.id,confirm:true})).toEqual({kind:'refused',reason:'unavailable'});
  const scoped=await companyAdmin(b,b.companyId,b.deptA);
  expect(await undoLoopAction(scoped,{actionId:a2.id,confirm:true})).toEqual({kind:'undone',by:'hr'});
  const hrUndo=(await undosOf()).find(row=>row.actionId===a2.id)!;
  expect(hrUndo).toMatchObject({undoneBy:'hr',undoneByUserId:scoped.userId});
  expect(await correctionAttribution(hrUndo.compensationRef)).toEqual({principal:principalId,worker:LOOP,action:a2.id,sponsor:group.userId,asked:'hr',asker:scoped.userId});
  expect(await clockOutOn(e2.employmentId,EARLIER)).toBeNull();
  // The undo row is append-only.
  expect(await failure(owner.db.update(terasLoopActionUndo).set({undoneBy:'hr'}).where(eq(terasLoopActionUndo.actionId,a1.id)))).toMatch(/append-only/);
  // The database refuses an undo after the deadline, whoever writes it.
  const expired=await clockedIn('Fictional Expired Fix',day(-3));
  const [oldCase]=await owner.db.insert(terasLoopCase).values({tenantId:b.tenantId,workerId:LOOP,companyId:b.companyId,employmentId:expired.employmentId,
   subjectKey:`clockout:${expired.employmentId}:${day(-30)}`,recipient:'employee',state:'closed',closeReason:'done',resolution:'as_prepared',facts:{},
   closedAt:new Date(),openedRunId:randomUUID(),checkedRunId:randomUUID()}).returning();
  const created=new Date(Date.now()-10*DAY_MS);
  const [old]=await owner.db.insert(terasLoopAction).values({tenantId:b.tenantId,workerId:LOOP,companyId:b.companyId,caseId:oldCase.id,employmentId:expired.employmentId,runId:randomUUID(),
   level:2,state:'applied',ruleVersion:'loop_missed_clock_outs.act@v1',sponsorUserId:group.userId,agentPrincipalId:principalId,checks:[],facts:{date:day(-30),checkOut:'18:00'},ownerRef:randomUUID(),
   createdAt:created,appliedAt:created,undoUntil:new Date(created.getTime()+3*DAY_MS)}).returning();
  expect(await failure(withTenant(scoped,tx=>tx.insert(terasLoopActionUndo).values({actionId:old.id,tenantId:b.tenantId,undoneBy:'hr',undoneByUserId:scoped.userId,compensationRef:randomUUID()}))))
   .toMatch(/row-level security/i);
  expect(await undoLoopAction(scoped,{actionId:old.id,confirm:true})).toEqual({kind:'refused',reason:'expired'});
 });

 it('reopens the case for the person to confirm, and the loop never acts on it again',async()=>{
  const {e1}=await acting();
  await run();
  const a1=(await actionFor(e1.employmentId))!;
  await undoLoopAction(e1,{actionId:a1.id,confirm:true});
  await run();
  expect(await caseOf(e1.employmentId,EARLIER)).toMatchObject({state:'open',reopenCount:1});
  expect((await actionsOf()).filter(row=>row.employmentId===e1.employmentId)).toHaveLength(1);
  expect((await readLoopCards(e1,{scopeIds:[],admin:false})).map(card=>card.kind)).toEqual(['clockOut']);
 });
});

describe('automatic demotion',()=>{
 it('moves the loop back to Prepare when more than 1% are corrected in 7 days, with a Moved down card listing them',async()=>{
  const {e1,e2,late}=await acting();
  await run();
  // No correction yet: the next run keeps Level 2.
  await run();
  expect(await levelOf(b.companyId)).toMatchObject({level:2,changedBy:'administrator'});
  // HR changes one fix afterwards to the time the person really left; the next run marks it as a person's change.
  const a2=(await actionFor(e2.employmentId))!;
  const raw=await attendanceClockData(adminCtx(b),e2.employmentId,EARLIER);
  const entries=raw.rows.filter(row=>!row.voidedAt).map(row=>row.direction==='out'?{punchAt:'19:10',direction:'out' as const}:{id:row.id,punchAt:row.punchAt,direction:row.direction});
  const {correctionId}=await requestAttendanceCorrection(adminCtx(b),{employmentId:e2.employmentId,date:EARLIER,reason:'Fictional: left at 19:10',clockChanges:{version:1,baseline:raw.baseline,entries}});
  await decideAttendanceCorrection(adminCtx(b),{correctionId,decision:'approved'});
  // The employee undoes the other.
  const a1=(await actionFor(e1.employmentId))!;
  expect(await undoLoopAction(e1,{actionId:a1.id,confirm:true})).toMatchObject({kind:'undone'});
  await run();
  expect(await actionFor(e2.employmentId)).toMatchObject({state:'applied',facts:{recordedCheckOut:'19:10'}});
  expect((await actionFor(e2.employmentId))!.peopleChangedAt).not.toBeNull();
  expect(await levelOf(b.companyId)).toMatchObject({level:1,changedBy:'automatic',changedByUserId:null,maxActionsPerNight:2,undoDays:3,actCondition:'roster_end'});
  const [demotion]=await withTenant(group,tx=>tx.select().from(terasLoopLevelChange).where(eq(terasLoopLevelChange.kind,'demoted_auto')));
  expect(demotion).toMatchObject({fromLevel:2,toLevel:1,changedBy:'automatic',changedByUserId:null,companyId:b.companyId});
  expect(demotion.evidence).toMatchObject({applied:2,corrected:2,share:1});
  expect((demotion.evidence as {corrections:unknown[]}).corrections).toEqual(expect.arrayContaining([
   {actionId:a1.id,kind:'undone',by:'employee'},{actionId:a2.id,kind:'changed',by:null}]));
  // At Prepare again: the waiting day is not fixed, and HR's Today says why, with the corrections named.
  expect(await clockOutOn(late.employmentId,YESTERDAY)).toBeNull();
  expect((await actionsOf()).filter(row=>row.employmentId===late.employmentId)).toEqual([]);
  const moved=(await readLoopCards(group,{scopeIds:[b.companyId],admin:true})).filter(card=>card.kind==='movedDown');
  expect(moved).toEqual([{kind:'movedDown',changeId:demotion.id,workerId:LOOP,companyName:'Acme Sdn Bhd',at:demotion.changedAt.toISOString(),applied:2,corrected:2,
   corrections:expect.arrayContaining([{personName:'Fictional Early One',date:EARLIER,kind:'undone',by:'employee'},{personName:'Fictional Early Two',date:EARLIER,kind:'changed',by:null}]),
   more:0,href:'/control-tower/loops/loop_missed_clock_outs'}]);
  // An employee never sees it; another company's administrator does not either.
  expect((await readLoopCards(e1,{scopeIds:[b.companyId],admin:false})).filter(card=>card.kind==='movedDown')).toEqual([]);
  const other=await secondCompany('Fictional Other Sdn Bhd');
  const otherAdmin=await companyAdmin(b,other.companyId,other.deptId);
  expect((await readLoopCards(otherAdmin,{scopeIds:[other.companyId,b.companyId],admin:true})).filter(card=>card.kind==='movedDown')).toEqual([]);
  // The loop page shows the level and the actions with their outcome.
  const detail=await loopAutonomyDetail(group,LOOP);
  expect(detail.companies.find(item=>item.companyId===b.companyId)).toMatchObject({level:1,changedBy:'automatic',lastChange:'demoted_auto'});
  expect(detail.figures).toMatchObject({applied:2,corrected:2,undoneByEmployee:1});
 });
});

describe('isolation and the sponsor',()=>{
 it('keeps tenants, companies and people apart',async()=>{
  const {e1,second}=await acting();
  await run();
  const b2=await seedBase();
  const group2=await login(b2,'Fictional Other Tenant Administrator','hr_admin');
  expect(await actionsOf(group2)).toEqual([]);
  expect(await withTenant(group2,tx=>tx.select().from(terasLoopLevelChange))).toEqual([]);
  expect(await withTenant(group2,tx=>tx.select().from(terasLoopLevel))).toEqual([]);
  expect(await undoLoopAction(group2,{actionId:(await actionFor(e1.employmentId))!.id,confirm:true})).toEqual({kind:'refused',reason:'unavailable'});
  // An administrator of the second company reads none of the first company's actions or history.
  const otherAdmin=await companyAdmin(b,second.companyId,second.deptId);
  expect(await actionsOf(otherAdmin)).toEqual([]);
  expect(await withTenant(otherAdmin,tx=>tx.select().from(terasLoopLevelChange))).toEqual([]);
  expect((await loopAutonomyDetail(otherAdmin,LOOP)).actions).toEqual([]);
  expect(await undoLoopAction(otherAdmin,{actionId:(await actionFor(e1.employmentId))!.id,confirm:true})).toEqual({kind:'refused',reason:'unavailable'});
  await expect(loopPromotion(otherAdmin,LOOP,b.companyId)).rejects.toMatchObject({reason:'not_found'});
  await expect(loopAutonomyDetail(e1,LOOP)).rejects.toMatchObject({reason:'not_administrator'});
 });

 it('stops acting when the sponsor loses access; the employee is pointed to HR, and HR can still undo',async()=>{
  const {e1,late}=await acting();
  await run();
  const a1=(await actionFor(e1.employmentId))!;
  const reader=await login(b,'Fictional Second Administrator','hr_admin');
  await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,group.userId));
  await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:group.userId,companyId:null,role:'employee'});
  expect(await run()).toMatchObject({status:'sponsor_lost'});
  expect((await actionsOf(reader)).filter(row=>row.employmentId===late.employmentId)).toEqual([]);
  expect(await undoLoopAction(e1,{actionId:a1.id,confirm:true})).toEqual({kind:'refused',reason:'ask_hr'});
  expect(await clockOutOn(e1.employmentId,EARLIER)).toBe('18:00:00');
  expect(await undoLoopAction(reader,{actionId:a1.id,confirm:true})).toEqual({kind:'undone',by:'hr'});
  expect(await clockOutOn(e1.employmentId,EARLIER)).toBeNull();
 });
});

describe('attribution cannot be forged',()=>{
 it('only the loop\'s own transaction, naming its own action under its sponsor, records a loop; it never changes and never decides a routed stage',async()=>{
  const {e1}=await acting();
  await run();
  const a1=(await actionFor(e1.employmentId))!;
  const own=loopAttribution({workerId:LOOP,principalId,actionId:a1.id,employmentId:e1.employmentId,sponsorUserId:group.userId,sponsorName:'Fictional Group Administrator',
   askedBy:null,askedByUserId:null,askedByName:null});
  const attributed=(ctx:SessionContext,value:unknown)=>withTenant(ctx,async tx=>{
   await tx.execute(sql`select set_config('app.teras_loop_attribution',${JSON.stringify(value)},true)`);
   return tx.execute(sql`select app.teras_loop_attribution() as a`);
  });
  // The loop's own attribution, under its sponsor, is accepted.
  expect(await failure(attributed(group,own))).toBe('no error');
  // Another action, another employee, another principal, a malformed one, or someone else's session: refused.
  expect(await failure(attributed(group,{...own,actionId:randomUUID()}))).toMatch(/name the loop's own action/);
  expect(await failure(attributed(group,{...own,employmentId:randomUUID()}))).toMatch(/name the loop's own action/);
  expect(await failure(attributed(group,{...own,principalId:randomUUID()}))).toMatch(/name the loop's own action/);
  expect(await failure(attributed(group,{...own,v:2}))).toMatch(/Invalid AI Centre loop attribution/);
  const scoped=await companyAdmin(b,b.companyId,b.deptA);
  expect(await failure(attributed(scoped,own))).toMatch(/acts only under its sponsor's authority/);
  expect(await failure(attributed(scoped,{...own,askedBy:'hr',askedByUserId:group.userId}))).toMatch(/acts only under its sponsor's authority/);
  const agent=agentContext(b.tenantId,principalId,await entitlements());
  expect(await failure(attributed(agent,own))).toMatch(/acts only under its sponsor's authority/);
  // A correction a person files under someone else's forged attribution is refused through the owner itself.
  const forged=await clockedIn('Fictional Forged Day',EARLIER);
  const raw=await attendanceClockData(adminCtx(b),forged.employmentId,EARLIER);
  const entries=[...raw.rows.filter(row=>!row.voidedAt).map(row=>({id:row.id,punchAt:row.punchAt,direction:row.direction})),{punchAt:'18:00',direction:'out' as const}];
  expect(await failure(withTenant(group,async tx=>{await setLoopAttributionTx(tx,own);
   return requestAttendanceCorrection(group,{employmentId:forged.employmentId,date:EARLIER,reason:'Fictional forged',clockChanges:{version:1,baseline:raw.baseline,entries}},tx);})))
   .toMatch(/corrects only the day it acts on/);
  // Without the loop's transaction nobody writes the columns, and they never change once written.
  const {correctionId}=await requestAttendanceCorrection(adminCtx(b),{employmentId:forged.employmentId,date:EARLIER,reason:'Fictional person-made',clockChanges:{version:1,baseline:raw.baseline,entries}});
  expect(await correctionAttribution(correctionId)).toEqual({principal:null,worker:null,action:null,sponsor:null,asked:null,asker:null});
  expect(await failure(owner.db.execute(sql`update public.attendance_correction set agent_principal_id=${principalId}::uuid,agent_worker_id=${LOOP},agent_action_id=${a1.id}::uuid,
   agent_sponsor_user_id=${group.userId}::uuid where id=${correctionId}::uuid`))).toMatch(/never changes/);
  expect(await failure(owner.db.execute(sql`update public.attendance_correction set agent_asked_by='hr',agent_asked_by_user_id=${group.userId}::uuid where id=${a1.ownerRef}::uuid`))).toMatch(/never changes/);
  // A loop never decides a routed approval stage, whoever holds the connection.
  for(const table of ['attendance_workflow_decision','attendance_workflow_participant_decision'])
   expect(await failure(owner.db.transaction(async tx=>{
    await tx.execute(sql`select set_config('app.teras_loop_attribution',${JSON.stringify(own)},true)`);
    await tx.execute(sql`insert into ${sql.identifier('public')}.${sql.identifier(table)} default values`);
   }))).toMatch(/never decides a routed approval stage/);
 });
});

describe('missing employee data at Level 2',()=>{
 const MD='loop_missing_employee_data' as const;
 it('sends the request itself within its limits, recorded, and changes no record; HR withdraws it within the window',async()=>{
  const e=await login(b,'Fictional Request Employee','employee');
  await owner.db.insert(schema.employeeStatutoryMy).values({tenantId:b.tenantId,personId:e.personId,passportNumber:randomUUID(),epfNumber:'EPF',socsoNumber:'SOCSO',taxNumber:'TAX'});
  await setWorkerSwitch(group,{workerId:MD,enabled:true});
  await certify(b.companyId,e.employmentId,{workerId:MD});
  expect(await setLoopLevel(group,{workerId:MD,companyId:b.companyId,toLevel:2,expectedLevel:1,limits:{maxActionsPerNight:50,undoDays:3,condition:'roster_end'}})).toMatchObject({level:2});
  const statutory=()=>owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId,e.personId));
  const before=await statutory();
  const runMd=async()=>runLoop(MD,{tenantId:b.tenantId,principalId,entitlements:await entitlements(),today:TODAY});
  expect(await runMd()).toMatchObject({status:'ran'});
  const actionsMd=()=>withTenant(group,tx=>tx.select().from(terasLoopAction).where(and(eq(terasLoopAction.workerId,MD),eq(terasLoopAction.employmentId,e.employmentId))));
  const [action]=await actionsMd();
  expect(action).toMatchObject({state:'applied',level:2,reason:null,ruleVersion:'loop_missing_employee_data.act@v1',sponsorUserId:group.userId,agentPrincipalId:principalId,
   companyId:b.companyId,facts:{gaps:1,tab:'bankStatutory'}});
  // The request is the agent principal's notice, attributed to the loop under its sponsor; the employee is told in-app.
  const [sent]=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.eventType,'teras-loop.request.sent'),eq(schema.domainEvent.aggregateId,action.id)));
  expect(sent).toMatchObject({id:action.ownerRef,actorType:'agent',actorId:principalId,subjectEmploymentId:e.employmentId});
  expect((sent.payload as Attributed).agentAttribution).toMatchObject({workerId:MD,actionId:action.id,sponsorUserId:group.userId,
   label:'AI Centre loop (missing employee data), sponsored by Fictional Group Administrator'});
  await dispatchNotifications(await entitledCtx(b),{});
  const [bell]=await owner.db.select().from(schema.notification).where(eq(schema.notification.sourceEventId,sent.id));
  expect(bell).toMatchObject({recipientEmploymentId:e.employmentId,kind:'teras-loop.details-requested',linkPath:'/me?tab=bankStatutory#section-request-bankStatutory'});
  expect(bell.body).toBe('One detail is missing from your record. Fill it in on your profile; HR approves it as usual.');
  // No record changed: the employee still fills the detail in and HR approves it; the case stays open for them.
  expect(await statutory()).toEqual(before);
  const [kase]=await withTenant(group,tx=>tx.select().from(terasLoopCase).where(and(eq(terasLoopCase.workerId,MD),eq(terasLoopCase.subjectKey,`record:${e.employmentId}`))));
  expect(kase).toMatchObject({state:'open',facts:{gaps:['no_bank_account'],tabs:['bankStatutory']}});
  // Sent once per case, however many nights pass.
  await runMd();
  expect(await actionsMd()).toHaveLength(1);
  // HR withdraws it: refused after the window, then done in the loop's name at HR's request, and the employee is told.
  const hr=await companyAdmin(b,b.companyId,b.deptA);
  expect(await undoLoopAction(hr,{actionId:action.id,confirm:true},new Date(action.undoUntil.getTime()+1000))).toEqual({kind:'refused',reason:'expired'});
  expect(await undoLoopAction(hr,{actionId:action.id,confirm:true})).toEqual({kind:'undone',by:'hr'});
  const [withdrawn]=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.eventType,'teras-loop.request.withdrawn'),eq(schema.domainEvent.aggregateId,action.id)));
  expect(withdrawn).toMatchObject({actorType:'agent',actorId:principalId,subjectEmploymentId:e.employmentId});
  expect((withdrawn.payload as Attributed).agentAttribution).toMatchObject({askedBy:'hr',askedByUserId:hr.userId,
   label:'AI Centre loop (missing employee data), at the request of Fictional Company Administrator (HR), sponsored by Fictional Group Administrator'});
  expect((await undosOf()).find(row=>row.actionId===action.id)).toMatchObject({undoneBy:'hr',undoneByUserId:hr.userId,compensationRef:withdrawn.id});
  await dispatchNotifications(await entitledCtx(b),{});
  expect((await owner.db.select().from(schema.notification).where(eq(schema.notification.sourceEventId,withdrawn.id)))[0])
   .toMatchObject({recipientEmploymentId:e.employmentId,kind:'teras-loop.details-request-withdrawn'});
  expect(await statutory()).toEqual(before);
  expect(await undoLoopAction(hr,{actionId:action.id,confirm:true})).toEqual({kind:'refused',reason:'changed'});
 });
});

describe('Level 3: act and audit',()=>{
 it('acts and tells the employee as at Level 2, while HR reviews a weekly sample of at least 10% and at least 5 instead of every action',async()=>{
  const {e1}=await acting();
  await run();
  await owner.db.update(terasLoopLevel).set({level:3}).where(and(eq(terasLoopLevel.workerId,LOOP),eq(terasLoopLevel.companyId,b.companyId)));
  // Ten more fixes this week on their own cases: twelve in all.
  const subject=await login(b,'Fictional Sample Subject','employee'),now=new Date();
  for(let index=0;index<10;index++){
   const [kase]=await owner.db.insert(terasLoopCase).values({tenantId:b.tenantId,workerId:LOOP,companyId:b.companyId,employmentId:subject.employmentId,
    subjectKey:`clockout:${subject.employmentId}:2026-0${index}-01`,recipient:'employee',state:'closed',closeReason:'done',resolution:'as_prepared',facts:{},
    closedAt:now,openedRunId:randomUUID(),checkedRunId:randomUUID()}).returning();
   await owner.db.insert(terasLoopAction).values({tenantId:b.tenantId,workerId:LOOP,companyId:b.companyId,caseId:kase.id,employmentId:subject.employmentId,runId:randomUUID(),
    level:3,state:'applied',ruleVersion:'loop_missed_clock_outs.act@v1',sponsorUserId:group.userId,agentPrincipalId:principalId,checks:[],facts:{date:EARLIER,checkOut:'18:00'},
    ownerRef:randomUUID(),appliedAt:now,undoUntil:new Date(now.getTime()+3*DAY_MS)});
  }
  const week=currentWeekStart();
  // HR's Today shows the sample, not every action; the employee keeps their own fix card with its undo.
  const cards=await readLoopCards(group,{scopeIds:[b.companyId],admin:true});
  expect(cards.filter(card=>card.kind==='acted')).toEqual([]);
  expect(cards.filter(card=>card.kind==='sample')).toEqual([{kind:'sample',workerId:LOOP,companyId:b.companyId,companyName:'Acme Sdn Bhd',weekStart:week,size:5,total:12,
   href:'/control-tower/loops/loop_missed_clock_outs'}]);
  expect((await readLoopCards(e1,{scopeIds:[],admin:false})).map(card=>card.kind)).toEqual(['autoFixed']);
  // The loop page shows the same five to every administrator of the company.
  const sampleOf=async(ctx:SessionContext)=>(await loopAutonomyDetail(ctx,LOOP)).samples.find(item=>item.companyId===b.companyId)!;
  const sample=await sampleOf(group);
  expect(sample).toMatchObject({weekStart:week,total:12,reviewed:null,canReview:true});
  expect(sample.actions).toHaveLength(5);
  const scoped=await companyAdmin(b,b.companyId,b.deptA);
  expect((await sampleOf(scoped)).actions.map(item=>item.id).sort()).toEqual(sample.actions.map(item=>item.id).sort());
  // An administrator of the company records the review in their own name; an employee or a wrong week cannot.
  await expect(reviewLoopSample(e1,{workerId:LOOP,companyId:b.companyId,weekStart:week})).rejects.toMatchObject({reason:'not_administrator'});
  await expect(reviewLoopSample(scoped,{workerId:LOOP,companyId:b.companyId,weekStart:day(0)===week?day(1):day(0)})).rejects.toMatchObject({reason:'invalid'});
  const review=await reviewLoopSample(scoped,{workerId:LOOP,companyId:b.companyId,weekStart:week});
  expect(review).toMatchObject({reviewedByUserId:scoped.userId,weekStart:week,companyId:b.companyId});
  expect([...review.actionIds].sort()).toEqual(sample.actions.map(item=>item.id).sort());
  expect((await readLoopCards(group,{scopeIds:[b.companyId],admin:true})).filter(card=>card.kind==='sample')).toEqual([]);
  expect((await sampleOf(group)).reviewed).toMatchObject({byName:'Fictional Company Administrator',covered:5});
  const [audit]=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.eventType,'teras-loop.sample-reviewed')));
  expect(audit).toMatchObject({actorType:'user',actorId:scoped.userId});
  expect(await failure(owner.db.delete(terasLoopSampleReview).where(eq(terasLoopSampleReview.id,review.id)))).toMatch(/append-only/);
  // Undo is unchanged at Level 3.
  expect(await undoLoopAction(e1,{actionId:(await actionFor(e1.employmentId))!.id,confirm:true})).toEqual({kind:'undone',by:'employee'});
 });
});

describe('limits after a promotion',()=>{
 it('a group administrator makes them stricter or changes the condition at any time, recorded; raising needs a promotion',async()=>{
  const e=await login(b,'Fictional Evidence Subject','employee');
  await certify(b.companyId,e.employmentId);
  await promote(b.companyId,{maxActionsPerNight:50,undoDays:3,condition:'roster_and_site_exit'});
  const promoted=await levelOf(b.companyId);
  const change=(limits:Record<string,unknown>,ctx:SessionContext=group,expectedVersion=promoted.version)=>changeLoopLimits(ctx,{workerId:LOOP,companyId:b.companyId,expectedVersion,limits});
  const scoped=await companyAdmin(b,b.companyId,b.deptA);
  await expect(change({maxActionsPerNight:20,undoDays:3,condition:'roster_and_site_exit'},scoped)).rejects.toMatchObject({reason:'not_group_administrator'});
  await expect(change({maxActionsPerNight:20,undoDays:3,condition:'roster_and_site_exit'},e)).rejects.toMatchObject({reason:'not_group_administrator'});
  await expect(change({maxActionsPerNight:60,undoDays:3,condition:'roster_and_site_exit'})).rejects.toMatchObject({reason:'raise_needs_promotion'});
  await expect(change({maxActionsPerNight:50,undoDays:3,condition:'roster_and_site_exit'})).rejects.toMatchObject({reason:'unchanged'});
  await expect(change({maxActionsPerNight:20,undoDays:3,condition:'roster_and_site_exit'},group,promoted.version+1)).rejects.toMatchObject({reason:'changed'});
  // Another group administrator makes it stricter and chooses the roster-end condition: recorded with their name.
  const second=await login(b,'Fictional Second Group Administrator','hr_admin');
  expect(await change({maxActionsPerNight:20,undoDays:7,condition:'roster_end'},second)).toMatchObject({level:2,limits:{maxActionsPerNight:20,undoDays:7,condition:'roster_end'}});
  const changed=await levelOf(b.companyId);
  expect(changed).toMatchObject({level:2,maxActionsPerNight:20,undoDays:7,actCondition:'roster_end',changedByUserId:second.userId,conditionSetByUserId:second.userId});
  const history=await withTenant(group,tx=>tx.select().from(terasLoopLevelChange).where(eq(terasLoopLevelChange.kind,'limits_changed')));
  expect(history.map(item=>[item.fromLevel,item.toLevel,item.changedBy,item.changedByUserId,item.limits,item.evidence])).toEqual([[2,2,'administrator',second.userId,
   {maxActionsPerNight:20,undoDays:7,condition:'roster_end'},{before:{maxActionsPerNight:50,undoDays:3,condition:'roster_and_site_exit'},after:{maxActionsPerNight:20,undoDays:7,condition:'roster_end'}}]]);
  const [audit]=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.eventType,'teras-loop.limits-changed')));
  expect(audit).toMatchObject({actorType:'user',actorId:second.userId});
  expect(audit.payload).toMatchObject({workerId:LOOP,companyId:b.companyId,level:2,before:{maxActionsPerNight:50},after:{maxActionsPerNight:20,condition:'roster_end'}});
  // Lowering only the number keeps who chose the condition; the page shows the chooser.
  await change({maxActionsPerNight:10,undoDays:7,condition:'roster_end'},group,changed.version);
  expect(await levelOf(b.companyId)).toMatchObject({maxActionsPerNight:10,conditionSetByUserId:second.userId,changedByUserId:group.userId});
  expect((await loopAutonomyDetail(group,LOOP)).companies.find(item=>item.companyId===b.companyId)).toMatchObject({conditionSetByName:'Fictional Second Group Administrator',
   limits:{maxActionsPerNight:10,undoDays:7,condition:'roster_end'}});
  // The database refuses a raise without a promotion, even from the owner connection.
  const where=and(eq(terasLoopLevel.workerId,LOOP),eq(terasLoopLevel.companyId,b.companyId));
  expect(await failure(owner.db.update(terasLoopLevel).set({maxActionsPerNight:200}).where(where))).toMatch(/raised only by a promotion/);
  expect(await failure(owner.db.update(terasLoopLevel).set({undoDays:3}).where(where))).toMatch(/raised only by a promotion/);
  // At Prepare there are no limits to change.
  await setLoopLevel(group,{workerId:LOOP,companyId:b.companyId,toLevel:1,expectedLevel:2});
  await expect(change({maxActionsPerNight:5,undoDays:7,condition:'roster_end'},group,(await levelOf(b.companyId)).version)).rejects.toMatchObject({reason:'not_acting'});
 });

 it('under the roster-end condition it acts only when every part holds: no approved leave and no other clocking that day',async()=>{
  const twice=await clockedIn('Fictional Two Clockings',EARLIER);
  await checkIn(adminCtx(b),{employmentId:twice.employmentId,date:EARLIER,time:'13:05',manual:true});
  const once=await clockedIn('Fictional One Clocking',EARLIER);
  await on();
  await certify(b.companyId,once.employmentId);
  await promote(b.companyId,{maxActionsPerNight:50,undoDays:3,condition:'roster_end'});
  await run();
  const actions=await actionsOf();
  expect(actions.map(row=>[row.employmentId,row.state,row.reason]).sort()).toEqual([[twice.employmentId,'not_applied','condition_other_clocking'],[once.employmentId,'applied',null]].sort());
  expect(actions.find(row=>row.employmentId===twice.employmentId)!.checks).toEqual(expect.arrayContaining([expect.objectContaining({check:'no_other_clocking',result:'fail'})]));
  expect(actions.find(row=>row.employmentId===once.employmentId)!.checks).toEqual(expect.arrayContaining([expect.objectContaining({check:'no_other_clocking',result:'pass'}),
   expect.objectContaining({check:'no_approved_leave',result:'pass'})]));
  expect(await clockOutOn(twice.employmentId,EARLIER)).toBeNull();
  expect(await clockOutOn(once.employmentId,EARLIER)).toBe('18:00:00');
  // The day it left alone stays with the person, and HR sees it.
  expect((await readLoopCards(twice,{scopeIds:[],admin:false})).map(card=>card.kind)).toEqual(['clockOut']);
  expect((await readLoopCards(group,{scopeIds:[b.companyId],admin:true})).find(card=>card.kind==='leftAlone')).toMatchObject({count:1,
   items:[{personName:'Fictional Two Clockings',date:EARLIER,reason:'condition_other_clocking'}]});
 });
});
