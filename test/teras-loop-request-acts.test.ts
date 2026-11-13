/** The probation and passports loops' request-only acts (owner decisions, 11 and 13 November 2026), on fictional data.
 *
 *  1. Each act fires once when its conditions hold: passports send the employee the renewal request; probation opens
 *     the review and routes it to the manager with its due date. Both are attributed to the AI Centre loop on behalf of
 *     the company (the agent principal, under the sponsor who answers for it).
 *  2. No act below Level 2 or with the loop switched off; a failing condition is recorded with its reason.
 *  3. Idempotent: one action, one notice or review, however many nights pass.
 *  4. Undo within the window: HR withdraws the renewal request; HR cancels the opened review (never the employee), and
 *     a cancelled review no longer blocks a new one, while a completed review still does.
 *  5. Demotion: undone actions count; more than 1% over 7 days moves the loop back to Prepare for that company.
 *  6. Another company and another tenant are never touched; probation never changes the employment or decides.
 *  7. An employment owned by the Probation module keeps its manual flow: the act never fires for it.
 * No model is called. Expected values are written out from the fixtures. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';

const model=vi.hoisted(()=>({calls:0}));
vi.mock('../lib/ai',async importOriginal=>{
 const original=await importOriginal<typeof import('../lib/ai')>();
 const refuse=async()=>{model.calls++;throw new Error('No model call is allowed in a loop.');};
 return {...original,generateDraft:refuse,converse:refuse,readImage:refuse};
});
/** Employments the Probation module owns, for the module-owned case (the module's own cutover is out of scope here). */
const moduleOwned=vi.hoisted(()=>new Set<string>());
vi.mock('../core/employment-review',async importOriginal=>{
 const original=await importOriginal<typeof import('../core/employment-review')>();
 return {...original,probationOwnsLegacyReviewTx:async(tx:Parameters<typeof original.probationOwnsLegacyReviewTx>[0],employmentId:string)=>
  moduleOwned.has(employmentId)||original.probationOwnsLegacyReviewTx(tx,employmentId)};
});

import * as schema from '../db/schema';
import {terasLoopCase,terasLoopRun} from '../db/teras-schema';
import {terasLoopAction,terasLoopActionUndo,terasLoopLevel,terasLoopLevelChange} from '../db/teras-autonomy-schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee,setReportingLine} from '../core/org';
import {ensureAgentPrincipal} from '../core/agent-principal';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {dispatchNotifications} from '../core/notifications';
import {runLoop} from '../core/loops/run';
import {setLoopLevel} from '../core/loops/levels';
import {undoLoopAction} from '../core/loops/undo';
import {loopAutonomyDetail} from '../core/loops/autonomy-views';
import {evaluatePassport} from '../core/loops/act-passports';
import {cancelLoopOpenedReviewTx,startReview} from '../core/employment-review';
import type {LoopId} from '../core/loops/types';
import {todayInKualaLumpur} from '../lib/hr-date';
import {seedAttendanceSubmissionBase} from './helpers/attendance-submission-fixture';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const DAY_MS=86_400_000;
const TODAY=todayInKualaLumpur();
const day=(offset:number)=>new Date(Date.parse(`${TODAY}T00:00:00Z`)+offset*DAY_MS).toISOString().slice(0,10);
const LIMITS={maxActionsPerNight:50,undoDays:3,condition:'roster_end'} as const;
const PASSPORT='loop_document_expiry' as const,PROBATION='loop_probation_ending' as const;
let b:Base,principalId:string,group:Login;

type Login=SessionContext&{employmentId:string;personId:string;userId:string};
async function login(base:Base,name:string,role:'employee'|'manager'|'hr_admin',companyId=base.companyId,departmentId=base.deptA):Promise<Login>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:`${randomUUID()}@fixture.test`},companyId,departmentId,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);
 const ctx=await entitledCtx(base,[role]);
 return {...ctx,userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}],employmentId:hired.employmentId};
}
async function secondCompany(name='Fictional Second Sdn Bhd'){
 const [company]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:name}).returning();
 const [dept]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:company.id,name:'Fictional Ops'}).returning();
 return {companyId:company.id,deptId:dept.id};
}
const entitlements=async(base=b)=>(await entitledCtx(base)).entitlements!;
const run=async(workerId:LoopId,base=b,principal=principalId)=>runLoop(workerId,{tenantId:base.tenantId,principalId:principal,entitlements:await entitlements(base),today:TODAY});
const on=(workerId:LoopId,ctx:SessionContext=group,enabled=true)=>setWorkerSwitch(ctx,{workerId,enabled});
/** The loop's promotion evidence for a company, written as fixtures: prepared cases in the window and time at Prepare. */
async function certify(workerId:LoopId,companyId:string,employmentId:string){
 const at=new Date(),started=new Date(Date.now()-34*DAY_MS);
 await owner.db.insert(terasLoopCase).values(Array.from({length:214},()=>({tenantId:b.tenantId,workerId,companyId,employmentId,subjectKey:`evidence:${randomUUID()}`,
  recipient:'hr' as const,state:'closed' as const,closeReason:'done' as const,resolution:'as_prepared' as const,facts:{},firstOpenedAt:at,openedAt:at,checkedAt:at,closedAt:at,
  openedRunId:randomUUID(),checkedRunId:randomUUID()})));
 await owner.db.insert(terasLoopRun).values({tenantId:b.tenantId,runId:randomUUID(),workerId,companyId,status:'ran',sponsorUserId:group.userId,loopVersion:`${workerId}@v1`,
  startedAt:started,finishedAt:started,checks:[],reads:[]});
}
async function promote(workerId:LoopId,companyId:string,employmentId:string){
 await certify(workerId,companyId,employmentId);
 expect(await setLoopLevel(group,{workerId,companyId,toLevel:2,expectedLevel:1,limits:LIMITS})).toMatchObject({level:2});
}
const actionsOf=(workerId:LoopId,ctx:SessionContext=group)=>withTenant(ctx,tx=>tx.select().from(terasLoopAction).where(eq(terasLoopAction.workerId,workerId)));
const levelOf=async(workerId:LoopId,companyId:string)=>(await withTenant(group,tx=>tx.select().from(terasLoopLevel)
 .where(and(eq(terasLoopLevel.workerId,workerId),eq(terasLoopLevel.companyId,companyId)))))[0];
const eventsOf=(type:string,tenantId=b.tenantId)=>owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,tenantId),eq(schema.domainEvent.eventType,type)));
const reviewsOf=(employmentId:string)=>owner.db.select().from(schema.employmentReview).where(eq(schema.employmentReview.employmentId,employmentId));
const employmentRow=async(employmentId:string)=>(await owner.db.select().from(schema.employment).where(eq(schema.employment.id,employmentId)))[0];
type Attributed={agentAttribution?:Record<string,unknown>};

async function traveller(name='Fictional Traveller',companyId=b.companyId,departmentId=b.deptA,base=b){
 const e=await login(base,name,'employee',companyId,departmentId);
 await owner.db.insert(schema.employeeStatutoryMy).values({tenantId:base.tenantId,personId:e.personId,passportNumber:randomUUID(),passportExpiryDate:day(40)});
 return e;
}
async function probationer(name='Fictional Probationer',companyId=b.companyId,departmentId=b.deptA,base=b,managed=true){
 const p=await login(base,name,'employee',companyId,departmentId);
 await owner.db.update(schema.employment).set({probationEndDate:day(10)}).where(eq(schema.employment.id,p.employmentId));
 if(!managed)return {p,m:null};
 const m=await login(base,`${name} Manager`,'manager',companyId,departmentId);
 await setReportingLine(adminCtx(base),{subordinateEmploymentId:p.employmentId,managerEmploymentId:m.employmentId,lineType:'administrative',validFrom:'2024-01-01'});
 return {p,m};
}

/** Another tenant, set up like the first. */
async function otherTenant(){
 const base=await seedBase();
 for(const module of ['payroll','attendance','notifications'])await setModule(base.tenantId,module,'active');
 return base;
}

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 model.calls=0;moduleOwned.clear();
 await resetDb();b=await seedAttendanceSubmissionBase();
 for(const module of ['payroll','attendance','notifications'])await setModule(b.tenantId,module,'active');
 group=await login(b,'Fictional Group Administrator','hr_admin');
 principalId=await ensureAgentPrincipal(owner.db,b.tenantId);
});
afterEach(()=>{expect(model.calls,'a loop called a model').toBe(0);});

describe('passports: the renewal request',()=>{
 it('is sent once at Level 2, attributed to the loop, never below Level 2 or while switched off, and changes no record',async()=>{
  const e=await traveller();
  const statutory=()=>owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId,e.personId));
  const before=await statutory();
  // Prepare (the default): the card only.
  await on(PASSPORT);
  expect(await run(PASSPORT)).toMatchObject({status:'ran'});
  expect(await actionsOf(PASSPORT)).toEqual([]);
  // Level 2, but switched off: nothing runs.
  await promote(PASSPORT,b.companyId,e.employmentId);
  await on(PASSPORT,group,false);
  await run(PASSPORT);
  expect(await actionsOf(PASSPORT)).toEqual([]);
  expect(await eventsOf('teras-loop.request.sent')).toEqual([]);
  // Switched on at Level 2: sent once.
  await on(PASSPORT);
  expect(await run(PASSPORT)).toMatchObject({status:'ran'});
  const [action]=await actionsOf(PASSPORT);
  expect(action).toMatchObject({state:'applied',level:2,reason:null,ruleVersion:'loop_document_expiry.act@v1',employmentId:e.employmentId,companyId:b.companyId,
   sponsorUserId:group.userId,agentPrincipalId:principalId,facts:{date:day(40),request:'passport_renewal'}});
  const [sent]=await eventsOf('teras-loop.request.sent');
  expect(sent).toMatchObject({id:action.ownerRef,aggregateId:action.id,actorType:'agent',actorId:principalId,subjectEmploymentId:e.employmentId});
  expect(sent.payload).toMatchObject({request:'passport_renewal',expiresOn:day(40)});
  expect((sent.payload as Attributed).agentAttribution).toMatchObject({workerId:PASSPORT,actionId:action.id,sponsorUserId:group.userId,
   label:'AI Centre loop (passports), sponsored by Fictional Group Administrator'});
  await dispatchNotifications(await entitledCtx(b),{});
  const [bell]=await owner.db.select().from(schema.notification).where(eq(schema.notification.sourceEventId,sent.id));
  expect(bell).toMatchObject({recipientEmploymentId:e.employmentId,kind:'teras-loop.details-requested',title:'Please renew your passport',linkPath:'/me?tab=profile'});
  expect(bell.body).toBe(`The passport on your record expires on ${day(40)}. Renew it, then send the new details to HR from your profile; HR approves them as usual.`);
  // Idempotent: another night sends nothing more.
  await run(PASSPORT);
  expect(await actionsOf(PASSPORT)).toHaveLength(1);
  expect(await eventsOf('teras-loop.request.sent')).toHaveLength(1);
  // No record changed; the case stays open for the employee to send HR the new details.
  expect(await statutory()).toEqual(before);
  // The loop page shows it in plain language, with the withdraw control for HR.
  const view=await loopAutonomyDetail(group,PASSPORT);
  expect(view).toMatchObject({maxLevel:2,promotableTo:2,hasActor:true,capped:false});
  expect(view.actions.find(item=>item.id===action.id)).toMatchObject({state:'applied',canUndo:true,facts:{date:day(40)}});
 });

 it('records a condition that no longer holds, and sends nothing',async()=>{
  const e=await traveller();
  const item={caseId:randomUUID(),companyId:b.companyId,employmentId:e.employmentId,expiresOn:day(40)};
  expect(await evaluatePassport(group,item)).toMatchObject({ok:true,reason:null});
  // A renewal recorded since the case was found.
  expect(await evaluatePassport(group,{...item,expiresOn:day(41)})).toMatchObject({ok:false,reason:'condition_record_changed'});
  // The employment ended.
  await owner.db.update(schema.employment).set({terminatedOn:day(-1)}).where(eq(schema.employment.id,e.employmentId));
  expect(await evaluatePassport(group,item)).toMatchObject({ok:false,reason:'condition_inactive'});
 });

 it('HR withdraws it within the window; the employee is told; the undo counts toward demotion and moves the loop back to Prepare',async()=>{
  const e=await traveller();
  await on(PASSPORT);await run(PASSPORT);
  await promote(PASSPORT,b.companyId,e.employmentId);
  await run(PASSPORT);
  const [action]=await actionsOf(PASSPORT);
  expect(await undoLoopAction(group,{actionId:action.id,confirm:true},new Date(action.undoUntil.getTime()+1000))).toEqual({kind:'refused',reason:'expired'});
  expect(await undoLoopAction(group,{actionId:action.id,confirm:true})).toEqual({kind:'undone',by:'hr'});
  const [withdrawn]=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.eventType,'teras-loop.request.withdrawn'),eq(schema.domainEvent.aggregateId,action.id)));
  expect(withdrawn).toMatchObject({actorType:'user',actorId:group.userId,subjectEmploymentId:e.employmentId,payload:{by:'hr',request:'passport_renewal'}});
  expect((await owner.db.select().from(terasLoopActionUndo))).toEqual([expect.objectContaining({actionId:action.id,undoneBy:'hr',compensationRef:withdrawn.id})]);
  await dispatchNotifications(await entitledCtx(b),{});
  expect((await owner.db.select().from(schema.notification).where(eq(schema.notification.sourceEventId,withdrawn.id)))[0])
   .toMatchObject({recipientEmploymentId:e.employmentId,title:'Passport renewal request withdrawn'});
  expect(await undoLoopAction(group,{actionId:action.id,confirm:true})).toEqual({kind:'refused',reason:'changed'});
  // One of one undone in 7 days is over 1%: the next run moves the loop back to Prepare for this company, by itself.
  await run(PASSPORT);
  expect(await levelOf(PASSPORT,b.companyId)).toMatchObject({level:1,changedBy:'automatic'});
  const [demotion]=await withTenant(group,tx=>tx.select().from(terasLoopLevelChange).where(eq(terasLoopLevelChange.kind,'demoted_auto')));
  expect(demotion).toMatchObject({workerId:PASSPORT,companyId:b.companyId,fromLevel:2,toLevel:1,changedBy:'automatic'});
 });

 it('counts exactly: 1% corrected over 7 days keeps the level, more than 1% demotes',async()=>{
  // No passport of their own: the runs prepare and act on nothing new, so the window holds exactly the 100 fixtures.
  const e=await login(b,'Fictional Evidence Subject','employee');
  await on(PASSPORT);await run(PASSPORT);
  await promote(PASSPORT,b.companyId,e.employmentId);
  // 100 applied requests in the window (fixtures), none open, so the run itself sends nothing new.
  const at=new Date();
  const cases=await owner.db.insert(terasLoopCase).values(Array.from({length:100},()=>({tenantId:b.tenantId,workerId:PASSPORT,companyId:b.companyId,employmentId:e.employmentId,
   subjectKey:`fixture:${randomUUID()}`,recipient:'employee' as const,state:'closed' as const,closeReason:'done' as const,resolution:'completed' as const,facts:{},
   firstOpenedAt:at,openedAt:at,checkedAt:at,closedAt:at,openedRunId:randomUUID(),checkedRunId:randomUUID()}))).returning({id:terasLoopCase.id});
  const actions=await owner.db.insert(terasLoopAction).values(cases.map(kase=>({tenantId:b.tenantId,workerId:PASSPORT,companyId:b.companyId,caseId:kase.id,
   employmentId:e.employmentId,runId:randomUUID(),level:2 as const,state:'applied' as const,ruleVersion:'loop_document_expiry.act@v1',sponsorUserId:group.userId,
   agentPrincipalId:principalId,checks:[],facts:{date:day(40),request:'passport_renewal'},ownerRef:randomUUID(),appliedAt:at,undoUntil:new Date(at.getTime()+3*DAY_MS)}))).returning({id:terasLoopAction.id});
  const undo=(actionId:string)=>owner.db.insert(terasLoopActionUndo).values({actionId,tenantId:b.tenantId,undoneBy:'hr',undoneByUserId:group.userId,compensationRef:randomUUID()});
  await undo(actions[0].id);
  await run(PASSPORT);
  expect(await levelOf(PASSPORT,b.companyId)).toMatchObject({level:2});
  await undo(actions[1].id);
  await run(PASSPORT);
  expect(await levelOf(PASSPORT,b.companyId)).toMatchObject({level:1,changedBy:'automatic'});
 });

 it('never touches another company of the tenant or another tenant',async()=>{
  const second=await secondCompany();
  const here=await traveller('Fictional Here Traveller');
  const there=await traveller('Fictional Second Company Traveller',second.companyId,second.deptId);
  // Another tenant with its own expiring passport and the loop on at Prepare.
  const b2=await otherTenant();
  const group2=await login(b2,'Fictional Other Group Administrator','hr_admin');
  const principal2=await ensureAgentPrincipal(owner.db,b2.tenantId);
  const other=await traveller('Fictional Other Tenant Traveller',b2.companyId,b2.deptA,b2);
  await on(PASSPORT,group2);await run(PASSPORT,b2,principal2);
  await on(PASSPORT);await run(PASSPORT);
  await promote(PASSPORT,b.companyId,here.employmentId);
  await run(PASSPORT);
  expect((await actionsOf(PASSPORT)).map(row=>row.employmentId)).toEqual([here.employmentId]);
  expect((await actionsOf(PASSPORT)).some(row=>row.employmentId===there.employmentId)).toBe(false);
  expect(await owner.db.select().from(terasLoopAction).where(eq(terasLoopAction.tenantId,b2.tenantId))).toEqual([]);
  expect(await eventsOf('teras-loop.request.sent',b2.tenantId)).toEqual([]);
  expect((await owner.db.select().from(terasLoopCase).where(and(eq(terasLoopCase.tenantId,b2.tenantId),eq(terasLoopCase.employmentId,other.employmentId))))[0])
   .toMatchObject({state:'open'});
 });
});

describe('probation: the review opened for the manager',()=>{
 it('opens it once at Level 2 with its due date, routed to the manager, attributed to the loop; decides nothing and changes no employment record',async()=>{
  const {p,m}=await probationer();
  await on(PROBATION);
  expect(await run(PROBATION)).toMatchObject({status:'ran'});
  expect(await actionsOf(PROBATION)).toEqual([]);
  expect(await reviewsOf(p.employmentId)).toEqual([]);
  await promote(PROBATION,b.companyId,p.employmentId);
  const employmentBefore=await employmentRow(p.employmentId);
  await run(PROBATION);
  const [action]=await actionsOf(PROBATION);
  const [review]=await reviewsOf(p.employmentId);
  expect(review).toMatchObject({id:action.ownerRef,reviewType:'probation',status:'pending_manager',endDate:day(10),managerEmploymentId:m!.employmentId,
   autoTriggered:true,decision:null});
  expect(action).toMatchObject({state:'applied',level:2,ruleVersion:'loop_probation_ending.act@v1',facts:{date:day(10),dueDate:review.dueDate}});
  const [started]=await eventsOf('employment-review.started');
  expect(started).toMatchObject({aggregateId:review.id,actorType:'agent',actorId:principalId,subjectEmploymentId:p.employmentId});
  expect((started.payload as Attributed).agentAttribution).toMatchObject({workerId:PROBATION,actionId:action.id,sponsorUserId:group.userId,
   label:'AI Centre loop (probation ending), sponsored by Fictional Group Administrator'});
  // It decides nothing: no decision, and the employment record is exactly as it was.
  expect(await eventsOf('employment-review.decided')).toEqual([]);
  expect(await employmentRow(p.employmentId)).toEqual(employmentBefore);
  // Idempotent.
  await run(PROBATION);
  expect(await actionsOf(PROBATION)).toHaveLength(1);
  expect(await reviewsOf(p.employmentId)).toHaveLength(1);
  expect(await employmentRow(p.employmentId)).toEqual(employmentBefore);
  const view=await loopAutonomyDetail(group,PROBATION);
  expect(view).toMatchObject({maxLevel:2,promotableTo:2,hasActor:true,capped:false});
  expect(view.actions.find(item=>item.id===action.id)).toMatchObject({state:'applied',canUndo:true,facts:{dueDate:review.dueDate}});
 });

 it('records that there is no manager to route to, and opens nothing',async()=>{
  const {p}=await probationer('Fictional Unmanaged Probationer',b.companyId,b.deptA,b,false);
  await on(PROBATION);await run(PROBATION);
  await promote(PROBATION,b.companyId,p.employmentId);
  await run(PROBATION);
  expect(await actionsOf(PROBATION)).toEqual([expect.objectContaining({employmentId:p.employmentId,state:'not_applied',reason:'condition_no_manager'})]);
  expect(await reviewsOf(p.employmentId)).toEqual([]);
 });

 it('never fires for an employment the Probation module owns',async()=>{
  const {p}=await probationer('Fictional Module Probationer');
  moduleOwned.add(p.employmentId);
  await on(PROBATION);await run(PROBATION);
  await promote(PROBATION,b.companyId,p.employmentId);
  await run(PROBATION);await run(PROBATION);
  expect(await actionsOf(PROBATION)).toEqual([]);
  expect(await reviewsOf(p.employmentId)).toEqual([]);
  expect(await eventsOf('employment-review.started')).toEqual([]);
 });

 it('HR cancels the opened review within the window, never the employee; a cancelled review does not block a new one, a completed one does; the undo counts toward demotion',async()=>{
  const {p}=await probationer();
  await on(PROBATION);await run(PROBATION);
  await promote(PROBATION,b.companyId,p.employmentId);
  const employmentBefore=await employmentRow(p.employmentId);
  await run(PROBATION);
  const [action]=await actionsOf(PROBATION);
  // The employee the review is about cannot cancel it.
  expect(await undoLoopAction(p,{actionId:action.id,confirm:true})).toEqual({kind:'refused',reason:'access'});
  expect(await undoLoopAction(group,{actionId:action.id,confirm:true},new Date(action.undoUntil.getTime()+1000))).toEqual({kind:'refused',reason:'expired'});
  // The owner's cancel refuses a review the loop did not open (no matching action).
  await expect(withTenant(group,tx=>cancelLoopOpenedReviewTx(tx,group,{reviewId:action.ownerRef!,loopActionId:randomUUID()}))).rejects.toThrow(/AI Centre opened/);
  expect(await undoLoopAction(group,{actionId:action.id,confirm:true})).toEqual({kind:'undone',by:'hr'});
  const [review]=await reviewsOf(p.employmentId);
  expect(review).toMatchObject({status:'cancelled',decision:null});
  const [cancelled]=await eventsOf('employment-review.cancelled');
  expect(cancelled).toMatchObject({aggregateId:review.id,actorType:'user',actorId:group.userId,payload:{reviewType:'probation',loopActionId:action.id}});
  expect((await owner.db.select().from(terasLoopActionUndo))).toEqual([expect.objectContaining({actionId:action.id,undoneBy:'hr',compensationRef:cancelled.id})]);
  expect(await employmentRow(p.employmentId)).toEqual(employmentBefore);
  // A cancelled review does not block a new one.
  const again=await startReview(adminCtx(b),{employmentId:p.employmentId});
  expect(again).toMatchObject({reviewType:'probation'});
  expect((await reviewsOf(p.employmentId)).map(row=>row.status).sort()).toEqual(['cancelled','pending_manager']);
  // A completed review still does.
  const {p:done}=await probationer('Fictional Decided Probationer');
  await owner.db.insert(schema.employmentReview).values({tenantId:b.tenantId,employmentId:done.employmentId,personId:done.personId,reviewType:'probation',
   status:'completed',endDate:day(10),dueDate:day(3),decision:'confirm'});
  await expect(startReview(adminCtx(b),{employmentId:done.employmentId})).rejects.toThrow(/already exists/);
  // One of one undone: the next run moves the loop back to Prepare for the company.
  await run(PROBATION);
  expect(await levelOf(PROBATION,b.companyId)).toMatchObject({level:1,changedBy:'automatic'});
 });

 it('never touches another company of the tenant or another tenant',async()=>{
  const second=await secondCompany();
  const {p:here}=await probationer('Fictional Here Probationer');
  const {p:there}=await probationer('Fictional Second Company Probationer',second.companyId,second.deptId);
  const b2=await otherTenant();
  const group2=await login(b2,'Fictional Other Group Administrator','hr_admin');
  const principal2=await ensureAgentPrincipal(owner.db,b2.tenantId);
  const {p:other}=await probationer('Fictional Other Tenant Probationer',b2.companyId,b2.deptA,b2);
  await on(PROBATION,group2);await run(PROBATION,b2,principal2);
  await on(PROBATION);await run(PROBATION);
  await promote(PROBATION,b.companyId,here.employmentId);
  await run(PROBATION);
  expect((await actionsOf(PROBATION)).map(row=>row.employmentId)).toEqual([here.employmentId]);
  expect(await reviewsOf(there.employmentId)).toEqual([]);
  expect(await reviewsOf(other.employmentId)).toEqual([]);
  expect(await owner.db.select().from(terasLoopAction).where(eq(terasLoopAction.tenantId,b2.tenantId))).toEqual([]);
 });
});
