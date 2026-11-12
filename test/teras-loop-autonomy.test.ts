import {applyClockOut,compensateClockOutTx,evaluateClockOut} from '../core/loops/act-clock-outs';
/** Current owner policy: missed clock-outs prepare human-review cards; retained generic autonomy proofs use the missing-data request loop. Historical records are explicitly restored, never generated through disabled approval routing. */
import {seedAttendanceSubmissionBase} from './helpers/attendance-submission-fixture';

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
import {checkIn,checkOut,decideAttendanceCorrection,requestAttendanceCorrection,attendanceForEmploymentRange} from '../core/attendance';
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

const DAY_MS=86_400_000;let LOOP:'loop_missed_clock_outs'|'loop_missing_employee_data'='loop_missed_clock_outs';
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
 model.calls=0;LOOP='loop_missed_clock_outs';
 await resetDb();b=await seedAttendanceSubmissionBase();
 for(const module of ['payroll','attendance','notifications'])await setModule(b.tenantId,module,'active');
 group=await login(b,'Fictional Group Administrator','hr_admin');
 principalId=await ensureAgentPrincipal(owner.db,b.tenantId);
 // Every day is a working day, so the fixture does not depend on today's weekday.
 shift=(await createShift(adminCtx(b),{name:'Fictional Day',code:`DAY${randomUUID().slice(0,4)}`,startTime:'09:00',endTime:'18:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5,6,7]})).id;
});
afterEach(()=>{expect(model.calls,'a loop called a model').toBe(0);});

describe('the cap',()=>{
 it('keeps payroll inputs at Prepare in code and in the database, and caps probation and passports at Level 2, for any company and any writer',async()=>{
  const {companyId:second}=await secondCompany();
  // Owner, 11 November 2026: the request-only steps may reach Level 2 (with the evidence) but never 3. The database
  // (draft migration 9780) no longer refuses either loop.
  for(const companyId of [b.companyId,second])for(const workerId of ['loop_probation_ending','loop_document_expiry'] as const){
   await expect(setLoopLevel(group,{workerId,companyId,toLevel:2,expectedLevel:1,limits:LIMITS})).rejects.toMatchObject({reason:'certificate'});
   await expect(setLoopLevel(group,{workerId,companyId,toLevel:3,expectedLevel:1,limits:LIMITS})).rejects.toMatchObject({reason:'capped'});
  }
  // Wave 1 integration: the Phase 2 Salary payroll loop (pay) is held at Prepare the same way.
  for(const workerId of ['loop_payroll_inputs','loop_salary_payroll'] as const)for(const companyId of [b.companyId,second]){
   for(const toLevel of [2,3])await expect(setLoopLevel(group,{workerId,companyId,toLevel,expectedLevel:1,limits:LIMITS})).rejects.toMatchObject({reason:'capped'});
   const row={tenantId:b.tenantId,workerId,companyId,level:2 as const,changedBy:'administrator' as const,changedByUserId:group.userId};
   expect(await failure(owner.db.insert(terasLoopLevel).values(row))).toMatch(/teras_loop_level_cap/);
   expect(await failure(withTenant(group,tx=>tx.insert(terasLoopLevel).values(row)))).toMatch(/teras_loop_level_cap/);
   expect(await failure(owner.db.insert(terasLoopLevelChange).values({tenantId:b.tenantId,workerId,companyId,fromLevel:1,toLevel:2,kind:'promoted',changedBy:'administrator',
    changedByUserId:group.userId,limits:{},evidence:{}}))).toMatch(/teras_loop_level_change_cap/);
  }
  // The payroll Audit loop (P2-2b) has no level of its own: the level service refuses it, and the database caps it at Prepare.
  await expect(setLoopLevel(group,{workerId:'loop_payroll_audit' as never,companyId:b.companyId,toLevel:2,expectedLevel:1,limits:LIMITS})).rejects.toMatchObject({reason:'invalid'});
  expect(await failure(owner.db.insert(terasLoopLevel).values({tenantId:b.tenantId,workerId:'loop_payroll_audit' as never,companyId:b.companyId,level:2,changedBy:'administrator',
   changedByUserId:group.userId}))).toMatch(/teras_loop_level_cap/);
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


describe('promotion of the still-acting employee-data request loop',()=>{
 beforeEach(()=>{LOOP='loop_missing_employee_data';});
 it('computes the certificate from the loop\'s own records',async()=>{
  const e=await login(b,'Fictional Evidence Subject','employee');
  await certify(b.companyId,e.employmentId,{cases:214,changed:1,daysAgo:34});
  let view=await loopPromotion(group,LOOP,b.companyId);
  expect(view).toMatchObject({level:1,targetLevel:2,capped:false,hasActor:true,canChange:true,
   evidence:{currentLevel:1,prepared:214,asPrepared:213,changed:1,ruleBroken:0,daysAtLevel:34},
   certificate:{targetLevel:2,met:true}});
  expect(view.certificate!.criteria.map(item=>[item.id,item.actual,item.met])).toEqual([['prepared',214,true],['rule_broken',0,true],['days_at_level',34,true]]);
  // Too many changed by people, or too little time at the level, in other companies.
  const changed=await secondCompany('Fictional Changed Sdn Bhd');
  await certify(changed.companyId,e.employmentId,{cases:200,changed:3,daysAgo:40});
  expect((await loopPromotion(group,LOOP,changed.companyId)).certificate!.criteria.filter(item=>!item.met).map(item=>[item.id,item.actual])).toEqual([]);
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
  // HR withdraws it: refused after the window, then done as HR's own act (Phase 2 hardening), and the employee is told.
  const hr=await companyAdmin(b,b.companyId,b.deptA);
  expect(await undoLoopAction(hr,{actionId:action.id,confirm:true},new Date(action.undoUntil.getTime()+1000))).toEqual({kind:'refused',reason:'expired'});
  expect(await undoLoopAction(hr,{actionId:action.id,confirm:true})).toEqual({kind:'undone',by:'hr'});
  const [withdrawn]=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.eventType,'teras-loop.request.withdrawn'),eq(schema.domainEvent.aggregateId,action.id)));
  expect(withdrawn).toMatchObject({actorType:'user',actorId:hr.userId,subjectEmploymentId:e.employmentId});
  expect((withdrawn.payload as Attributed).agentAttribution).toBeUndefined();
  expect((await undosOf()).find(row=>row.actionId===action.id)).toMatchObject({undoneBy:'hr',undoneByUserId:hr.userId,compensationRef:withdrawn.id});
  await dispatchNotifications(await entitledCtx(b),{});
  expect((await owner.db.select().from(schema.notification).where(eq(schema.notification.sourceEventId,withdrawn.id)))[0])
   .toMatchObject({recipientEmploymentId:e.employmentId,kind:'teras-loop.details-request-withdrawn'});
  expect(await statutory()).toEqual(before);
  expect(await undoLoopAction(hr,{actionId:action.id,confirm:true})).toEqual({kind:'refused',reason:'changed'});
 });
});


describe('limits after an employee-data request promotion',()=>{
 beforeEach(()=>{LOOP='loop_missing_employee_data';});
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

});

describe('missed clock-outs require human review',()=>{
 async function restoreHistoricalActLevel(){
  // Explicit prior-installation fixture: only the new policy trigger is suspended, in the owner's
  // transaction, and restored before return. No current promotion API is claimed by this restoration.
  await owner.db.transaction(async tx=>{
   await tx.execute(sql`alter table teras_loop_level disable trigger teras_clock_out_review_only_guard`);
   try{
    await tx.insert(terasLoopLevel).values({tenantId:b.tenantId,workerId:'loop_missed_clock_outs',companyId:b.companyId,
     level:2,changedBy:'administrator',changedByUserId:group.userId,actCondition:'roster_end'});
    await tx.update(terasLoopLevel).set({level:3}).where(and(eq(terasLoopLevel.tenantId,b.tenantId),eq(terasLoopLevel.workerId,'loop_missed_clock_outs')));
   }finally{await tx.execute(sql`alter table teras_loop_level enable trigger teras_clock_out_review_only_guard`);}
  });
 }
 it('refuses promotion and raw new Act configuration without changing existing records',async()=>{
  const e=await clockedIn('Fictional review applicant');await certify(b.companyId,e.employmentId);
  const view=await loopPromotion(group,'loop_missed_clock_outs',b.companyId);
  expect(view).toMatchObject({level:1,maxLevel:1,hasActor:false,capped:true,targetLevel:null,certificate:null});
  await expect(promote(b.companyId)).rejects.toMatchObject({reason:'capped'});
  expect(await failure(owner.db.insert(terasLoopLevel).values({tenantId:b.tenantId,workerId:'loop_missed_clock_outs',companyId:b.companyId,
   level:2,changedBy:'administrator',changedByUserId:group.userId}))).toMatch(/human approval/);
  expect(await owner.db.select().from(terasLoopLevelChange)).toEqual([]);
 });
 it('prepares the employee card without writing an application, action, approval or clock-out even under a restored Act3 config',async()=>{
  const e=await clockedIn('Fictional stale Act applicant');await restoreHistoricalActLevel();await on();
  expect(await run()).toMatchObject({status:'ran'});
  expect(await clockOutOn(e.employmentId,YESTERDAY)).toBeNull();
  expect(await owner.db.select().from(schema.attendanceCorrection)).toEqual([]);
  expect(await actionsOf()).toEqual([]);expect(await owner.db.select().from(schema.attendanceWorkflowRequest)).toEqual([]);
  expect((await readLoopCards(e,{scopeIds:[],admin:false})).find(card=>card.kind==='clockOut')).toMatchObject({date:YESTERDAY,proposedCheckOut:'18:00'});
  const view=await loopAutonomyDetail(group,'loop_missed_clock_outs');
  expect(view).toMatchObject({maxLevel:1,promotableTo:1,hasActor:false});expect(view.companies.find(row=>row.companyId===b.companyId)?.level).toBe(1);
  const [effective]=await withTenant(group,tx=>tx.execute<{level:number}>(sql`select app.teras_loop_level_of('loop_missed_clock_outs',${b.companyId}::uuid) as level`));expect(effective.level).toBe(1);
  const stored=await levelOf(b.companyId);expect(stored.level).toBe(3); // historical configuration is not rewritten
  await setLoopPause(group,{workerId:LOOP,companyId:b.companyId,paused:true});await setWorkerSwitch(group,{workerId:LOOP,enabled:false});
  expect((await levelOf(b.companyId)).level).toBe(3);expect(await actionsOf()).toEqual([]);
  await setLoopLevel(group,{workerId:LOOP,companyId:b.companyId,toLevel:0,expectedLevel:1});
  const [history]=await owner.db.select().from(terasLoopLevelChange);expect(history).toMatchObject({fromLevel:3,toLevel:0,changedByUserId:group.userId});
 });
 it('accepts only the person-reviewed submission and leaves it pending for the configured human approver',async()=>{
  const e=await clockedIn('Fictional human-reviewed applicant');await on();await run();
  const result=await requestAttendanceCorrection(e,{employmentId:e.employmentId,date:YESTERDAY,checkIn:'09:02',checkOut:'18:00',reason:'Employee reviewed the prepared time'});
  const [pending]=await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id,result.correctionId));
  expect(pending.status).toBe('pending');expect(await clockOutOn(e.employmentId,YESTERDAY)).toBeNull();expect(await actionsOf()).toEqual([]);
  expect(await owner.db.select().from(schema.attendanceWorkflowRequest)).toHaveLength(1);
  await decideAttendanceCorrection(group,{correctionId:result.correctionId,decision:'approved',expectedStageIndex:0});
  expect(await clockOutOn(e.employmentId,YESTERDAY)).toBe('18:00:00');
 });
 it('legacy direct apply and compensation entries refuse before any attendance or workflow write',async()=>{
  const e=await clockedIn('Fictional direct-entry applicant'),actionId=randomUUID(),item={caseId:randomUUID(),companyId:b.companyId,employmentId:e.employmentId,date:YESTERDAY,checkIn:'09:02',proposedCheckOut:'18:00'};
  const before=await attendanceClockData(adminCtx(b),e.employmentId,YESTERDAY);
  expect(await evaluateClockOut(group,item,LIMITS)).toMatchObject({ok:false,reason:'approval_routed'});
  await expect(applyClockOut(group,{item,actionId,undoUntil:new Date(Date.now()+DAY_MS),principalId,workerId:LOOP,condition:'roster_end',
   attribution:loopAttribution({workerId:LOOP,principalId,actionId,employmentId:e.employmentId,sponsorUserId:group.userId,sponsorName:'Fictional Group Administrator',askedBy:null,askedByUserId:null,askedByName:null})})).rejects.toMatchObject({reason:'approval_routed'});
  await expect(withTenant(group,tx=>compensateClockOutTx(tx,group,{actionId,employmentId:e.employmentId,facts:{date:YESTERDAY,addedPunchId:randomUUID()},by:'hr'}))).rejects.toMatchObject({reason:'human_review_required'});
  expect((await attendanceClockData(adminCtx(b),e.employmentId,YESTERDAY)).baseline).toBe(before.baseline);
  expect(await owner.db.select().from(schema.attendanceCorrection)).toEqual([]);expect(await owner.db.select().from(schema.attendanceWorkflowRequest)).toEqual([]);
 });
 it('preserves declared historical actions, cards and source records while refusing automatic compensation atomically',async()=>{
  const e=await clockedIn('Fictional historical applicant');await on();await run();
  await checkOut(adminCtx(b),{employmentId:e.employmentId,date:YESTERDAY,time:'18:00',manual:true});
  // Saved records from the prior policy: restore an already approved correction and its action.
  // This does not invoke the current request/act services or purport to qualify the former automation.
  const [record]=await owner.db.insert(schema.attendanceCorrection).values({tenantId:b.tenantId,employmentId:e.employmentId,attendanceDate:YESTERDAY,
   proposedCheckIn:'09:02',proposedCheckOut:'18:00',reason:'Restored prior-installation automatic correction',status:'approved',decidedAt:new Date()}).returning();
  const kase=await caseOf(e.employmentId,YESTERDAY);expect(kase).toBeDefined();
  const [action]=await owner.db.insert(terasLoopAction).values({tenantId:b.tenantId,workerId:'loop_missed_clock_outs',companyId:b.companyId,caseId:kase.id,
   employmentId:e.employmentId,runId:randomUUID(),level:2,state:'applied',ruleVersion:'loop_missed_clock_outs.act@v1',sponsorUserId:group.userId,agentPrincipalId:principalId,
   checks:[],facts:{date:YESTERDAY,checkIn:'09:02',checkOut:'18:00'},ownerRef:record.id,appliedAt:new Date(),undoUntil:new Date(Date.now()+DAY_MS)}).returning();
  const before=await owner.db.select().from(schema.attendanceCorrection);
  // Direct app-role SQL cannot revive the retired attribution or forge an undo receipt.
  expect(await failure(withTenant(group,async tx=>{
   await setLoopAttributionTx(tx,loopAttribution({workerId:LOOP,principalId,actionId:action.id,employmentId:e.employmentId,
    sponsorUserId:group.userId,sponsorName:'Fictional Group Administrator',askedBy:'employee',askedByUserId:e.userId,askedByName:'Fictional historical applicant'}));
   const [attr]=await tx.execute<{worker:string}>(sql`select app.teras_loop_attribution()->>'workerId' as worker`);expect(attr.worker).toBe('loop_missed_clock_outs');
   await tx.insert(schema.attendanceCorrection).values({tenantId:b.tenantId,employmentId:e.employmentId,attendanceDate:EARLIER,
    proposedCheckOut:'17:00',reason:'Must not turn historical mandate into a new automatic application'});
  }))).toMatch(/requires a new human review/);
  expect(await failure(withTenant(group,tx=>tx.insert(terasLoopActionUndo).values({tenantId:b.tenantId,actionId:action.id,
   undoneBy:'hr',undoneByUserId:group.userId,compensationRef:randomUUID()})))).toMatch(/requires a new human review/);
  const view=await loopAutonomyDetail(group,'loop_missed_clock_outs');
  expect(view.actions.find(row=>row.id===action.id)).toMatchObject({state:'applied',canUndo:false,reviewHref:`/attendance/individual/${YESTERDAY}?emp=${e.employmentId}`});
  expect((await readLoopCards(e,{scopeIds:[],admin:false})).find(card=>card.kind==='autoFixed')).toMatchObject({actionId:action.id,date:YESTERDAY});
  for(const ctx of [e,group])expect(await undoLoopAction(ctx,{actionId:action.id,confirm:true})).toEqual({kind:'refused',reason:'human_review_required'});
  expect(await owner.db.select().from(schema.attendanceCorrection)).toEqual(before);expect(await owner.db.select().from(terasLoopActionUndo)).toEqual([]);
  expect((await actionsOf()).find(row=>row.id===action.id)).toMatchObject({state:'applied',ownerRef:record.id});
  const stranger=await login(b,'Fictional unrelated viewer','employee');expect(await undoLoopAction(stranger,{actionId:action.id,confirm:true})).toEqual({kind:'refused',reason:'unavailable'});
 });
});
