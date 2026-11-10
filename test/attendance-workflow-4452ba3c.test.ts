// Board 4452ba3c: OR assignment groups, save/preview split with stored preview history, Direct Superior
// diagnosis, automatic skip of ended reporting chains decided at submission, and Copy Workflow.
// All people, companies and labels are fictional.
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {checkIn,checkOut,requestAttendanceCorrection,decideAttendanceCorrection} from '../core/attendance';
import {saveAttendanceWorkflow,ownAttendanceSubmissionRoute,previewAttendanceWorkflow,generateAttendanceWorkflowPreview,listAttendanceWorkflowPreviews,getAttendanceWorkflowPreview} from '../core/attendance-workflow';
import type {AttendanceV4WorkflowInput,AttendanceV4Level} from '../lib/attendance-workflow-v4';
import type {AttendanceWorkflowCriteria} from '../lib/attendance-workflow';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,createAppUser,owner,closeAll,migrateTestDb,resetDb,seedBase,type Base} from './harness';

let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();});

type Actor=Awaited<ReturnType<typeof actor>>;
async function actor(name:string,options:{role?:'employee'|'hr_admin';login?:boolean;departmentId?:string}={}){
 const email=`${randomUUID()}@example.invalid`;
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:email},companyId:base.companyId,departmentId:options.departmentId??base.deptB,employmentType:'full_time',hiredOn:'2020-01-01'});
 const role=options.role??'employee';
 const userId=options.login===false?null:await createAppUser(base.tenantId,hired.personId,role);
 const ctx:SessionContext={...adminCtx(base),userId:userId??undefined,personId:hired.personId,roles:[role],grants:[{role,companyId:base.companyId}]};
 return{...hired,ctx,email,userId};
}
const reports=(subordinate:Actor,manager:Actor)=>setReportingLine(adminCtx(base),{subordinateEmploymentId:subordinate.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:todayInKualaLumpur()});
const superior=(depth:number):AttendanceV4Level['sources'][number]=>({kind:'direct_manager',depth});
const level=(sources:AttendanceV4Level['sources'],hrAlternative=false):AttendanceV4Level=>({name:'Level 1',mode:'any_one',sources,hrAlternative});
function workflow(employees:Actor[],stages:AttendanceV4Level[],patch:Partial<AttendanceV4WorkflowInput>={}):AttendanceV4WorkflowInput{
 return{companyId:base.companyId,applicationType:'irregularity',routingVersion:4,code:'SKIP_'+randomUUID().slice(0,8),name:'Fictional skip workflow',priority:100,active:true,criteria:{employeeIds:employees.map(e=>e.employmentId)},stages:stages.map((stage,index)=>({...stage,name:`Level ${index+1}`})),cc:[],...patch};
}
async function submit(applicant:Actor){
 const on=todayInKualaLumpur(),root=adminCtx(base);
 await checkIn(root,{employmentId:applicant.employmentId,date:on,time:'08:00',manual:true});await checkOut(root,{employmentId:applicant.employmentId,date:on,time:'17:00',manual:true});
 return (await requestAttendanceCorrection(applicant.ctx,{employmentId:applicant.employmentId,date:on,checkIn:'09:00',checkOut:'18:00',reason:'Fictional 4452ba3c verification'})).correctionId;
}
const requestOf=async(correctionId:string)=>(await owner.db.select().from(schema.attendanceWorkflowRequest).where(eq(schema.attendanceWorkflowRequest.correctionId,correctionId)))[0];
const statusOf=async(correctionId:string)=>(await owner.db.select({status:schema.attendanceCorrection.status}).from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id,correctionId)))[0]?.status;
const decide=(who:Actor,correctionId:string,stage:number,slot:string)=>decideAttendanceCorrection(who.ctx,{correctionId,decision:'approved',expectedStageIndex:stage,expectedParticipantSlot:slot});
async function failure(run:()=>Promise<unknown>){try{await run();return null;}catch(error){const e=error as {message?:string;cause?:{message?:string}};return `${e.cause?.message??''} ${e.message??''}`;}}

describe('automatic skip when the reporting chain has genuinely ended (decided at submission)',()=>{
 it('chain of one with three Direct Superior levels: one stage, two recorded skips, and B approves finally',async()=>{
  const a=await actor('Fictional Employee A'),b=await actor('Fictional Employee B');await reports(a,b);
  await saveAttendanceWorkflow(adminCtx(base),workflow([a],[level([superior(1)]),level([superior(2)]),level([superior(3)])]));
  const route=await ownAttendanceSubmissionRoute(a.ctx,a.employmentId,'irregularity');
  if(!route.available)throw Error('Expected an available route');
  expect(route.stages.map(stage=>stage.name)).toEqual(['Level 1']);
  expect(route.skippedLevels).toEqual([{configuredLevel:2,sources:[superior(2)],reason:'no_further_superior',levelSkipped:true},{configuredLevel:3,sources:[superior(3)],reason:'no_further_superior',levelSkipped:true}]);
  const id=await submit(a),frozen=await requestOf(id);
  expect(frozen.stages).toHaveLength(1);expect(frozen.stages[0].approvers.map(x=>[x.employmentId,x.slot])).toEqual([[b.employmentId,'0:0']]);
  expect(frozen.skippedLevels.map(entry=>entry.configuredLevel)).toEqual([2,3]);
  const events=await owner.db.select({payload:schema.domainEvent.payload}).from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,id),eq(schema.domainEvent.eventType,'attendance-workflow.resolved')));
  expect(events[0].payload).toMatchObject({skippedLevels:[{configuredLevel:2},{configuredLevel:3}]});
  await decide(b,id,0,'0:0');
  expect(await statusOf(id)).toBe('approved');
 });
 it('chain of two skips only the third level',async()=>{
  const a=await actor('Fictional chain-two A'),b=await actor('Fictional chain-two B'),c=await actor('Fictional chain-two C');await reports(a,b);await reports(b,c);
  await saveAttendanceWorkflow(adminCtx(base),workflow([a],[level([superior(1)]),level([superior(2)]),level([superior(3)])]));
  const id=await submit(a),frozen=await requestOf(id);
  expect(frozen.stages.map(stage=>[stage.name,stage.approvers[0].employmentId])).toEqual([['Level 1',b.employmentId],['Level 2',c.employmentId]]);
  expect(frozen.skippedLevels.map(entry=>entry.configuredLevel)).toEqual([3]);
  await decide(b,id,0,'0:0');expect(await statusOf(id)).toBe('pending');
  await decide(c,id,1,'1:0');expect(await statusOf(id)).toBe('approved');
 });
 it('never skips a configuration problem: no superior at all, an inactive superior, or an unusable login is refused',async()=>{
  const lone=await actor('Fictional employee without superior');
  const inactiveChild=await actor('Fictional inactive-chain A'),inactiveMid=await actor('Fictional inactive-chain B'),inactiveTop=await actor('Fictional inactive-chain C');
  await reports(inactiveChild,inactiveMid);await reports(inactiveMid,inactiveTop);
  await owner.db.update(schema.employment).set({terminatedOn:'2021-01-01'}).where(eq(schema.employment.id,inactiveTop.employmentId));
  const loginChild=await actor('Fictional login-chain A'),loginMid=await actor('Fictional login-chain B'),loginTop=await actor('Fictional login-chain C',{login:false});
  await reports(loginChild,loginMid);await reports(loginMid,loginTop);
  await saveAttendanceWorkflow(adminCtx(base),workflow([lone,inactiveChild,loginChild],[level([superior(1)]),level([superior(2)]),level([superior(3)])]));
  for(const applicant of [lone,inactiveChild,loginChild]){
   expect(await ownAttendanceSubmissionRoute(applicant.ctx,applicant.employmentId,'irregularity')).toEqual({available:false,reason:'unresolved'});
   await expect(submit(applicant)).rejects.toMatchObject({reason:'unresolved'});
  }
  expect(await owner.db.select().from(schema.attendanceWorkflowRequest)).toEqual([]);
 });
 it('keeps Selected Employees levels, renumbers slots by kept stage and keeps the configured level name',async()=>{
  const a=await actor('Fictional selected A'),b=await actor('Fictional selected B'),named=await actor('Fictional named approver');await reports(a,b);
  await saveAttendanceWorkflow(adminCtx(base),workflow([a],[level([superior(1)]),level([superior(2)]),level([{kind:'specific_employee',employmentIds:[named.employmentId]}])]));
  const id=await submit(a),frozen=await requestOf(id);
  expect(frozen.stages.map(stage=>[stage.name,stage.approvers.map(x=>x.slot)])).toEqual([['Level 1',['0:0']],['Level 3',['1:0']]]);
  expect(frozen.skippedLevels).toEqual([{configuredLevel:2,sources:[superior(2)],reason:'no_further_superior',levelSkipped:true}]);
  await decide(b,id,0,'0:0');expect(await statusOf(id)).toBe('pending');
  await decide(named,id,1,'1:0');expect(await statusOf(id)).toBe('approved');
 });
 it('drops only the ended Direct Superior source of a mixed level and records it',async()=>{
  const a=await actor('Fictional mixed A'),b=await actor('Fictional mixed B'),named=await actor('Fictional mixed named');await reports(a,b);
  await saveAttendanceWorkflow(adminCtx(base),workflow([a],[level([superior(1)]),level([superior(2),{kind:'specific_employee',employmentIds:[named.employmentId]}])]));
  const frozen=await requestOf(await submit(a));
  expect(frozen.stages[1]).toMatchObject({name:'Level 2',sources:[{kind:'specific_employee',employmentIds:[named.employmentId]}]});
  expect(frozen.skippedLevels).toEqual([{configuredLevel:2,sources:[superior(2)],reason:'no_further_superior',levelSkipped:false}]);
 });
 it('routes an HR-alternative level to HR instead of skipping it, and leaves out a CC to a superior who does not exist',async()=>{
  const a=await actor('Fictional HR-alternative A'),b=await actor('Fictional HR-alternative B');await actor('Fictional HR approver',{role:'hr_admin'});await reports(a,b);
  await saveAttendanceWorkflow(adminCtx(base),workflow([a],[level([superior(1)]),level([superior(2)],true)],{cc:[superior(1),superior(2)]}));
  const frozen=await requestOf(await submit(a));
  expect(frozen.stages).toHaveLength(2);expect(frozen.stages[1]).toMatchObject({name:'Level 2',hrAlternative:true,approvers:[]});
  expect(frozen.skippedLevels).toEqual([]);
  expect(frozen.cc.map(recipient=>recipient.kind==='employee'?recipient.employmentId:recipient.address)).toEqual([b.employmentId]);
 });
 it('refuses a route whose every level would be skipped (never zero approvers)',async()=>{
  const a=await actor('Fictional all-skipped A'),b=await actor('Fictional all-skipped B');await reports(a,b);
  await saveAttendanceWorkflow(adminCtx(base),workflow([a],[level([superior(2)]),level([superior(3)])]));
  expect(await ownAttendanceSubmissionRoute(a.ctx,a.employmentId,'irregularity')).toEqual({available:false,reason:'unresolved'});
 });
 it('the insert link check rejects tampered skipped levels and admits only the canonical resolution',async()=>{
  const a=await actor('Fictional tamper A'),b=await actor('Fictional tamper B');await reports(a,b);
  await saveAttendanceWorkflow(adminCtx(base),workflow([a],[level([superior(1)]),level([superior(2)])]));
  const id=await submit(a),row=await requestOf(id);
  await withTenant(a.ctx,async(tx:Tx)=>{
   const copy={...row,id:randomUUID()};
   expect(await failure(()=>tx.transaction(nested=>nested.insert(schema.attendanceWorkflowRequest).values({...copy,skippedLevels:[]})))).toMatch(/canonical resolution/);
   // The untampered duplicate passes the link trigger and is stopped only by the one-request-per-application key.
   expect(await failure(()=>tx.transaction(nested=>nested.insert(schema.attendanceWorkflowRequest).values(copy)))).toMatch(/duplicate key|unique/i);
  });
 });
});

describe('in-flight requests keep their stored route',()=>{
 it('a request decides on its frozen stages after the reporting line and the workflow change; new rules apply only to later submissions',async()=>{
  const a=await actor('Fictional in-flight A'),d=await actor('Fictional in-flight D'),b=await actor('Fictional in-flight B'),c=await actor('Fictional in-flight C');
  await reports(a,b);await reports(d,b);
  const saved=await saveAttendanceWorkflow(adminCtx(base),workflow([a,d],[level([superior(1)]),level([superior(2)])]));
  const first=await submit(a),before=await requestOf(first);
  expect(before.stages).toHaveLength(1);expect(before.skippedLevels.map(entry=>entry.configuredLevel)).toEqual([2]);
  // Personnel later adds B's own superior; D's later submission routes through both levels.
  await reports(b,c);
  const second=await submit(d);
  expect((await requestOf(second)).stages.map(stage=>stage.approvers[0].employmentId)).toEqual([b.employmentId,c.employmentId]);
  // A later configuration edit never re-routes either application.
  const edited=workflow([a,d],[level([superior(1)]),level([superior(2)]),level([{kind:'specific_employee',employmentIds:[c.employmentId]}])],{code:'EDITED',expectedVersion:1});
  await saveAttendanceWorkflow(adminCtx(base),{...edited,code:saved.code},saved.lineageId);
  await decide(b,first,0,'0:0');
  expect(await statusOf(first)).toBe('approved');
  const after=await requestOf(first);
  expect({stages:after.stages,skippedLevels:after.skippedLevels,cc:after.cc,templateVersion:after.templateVersion}).toEqual({stages:before.stages,skippedLevels:before.skippedLevels,cc:before.cc,templateVersion:1});
  await decide(b,second,0,'0:0');expect(await statusOf(second)).toBe('pending');
  await decide(c,second,1,'1:0');expect(await statusOf(second)).toBe('approved');
  expect((await requestOf(second)).templateVersion).toBe(1);
 });
});

describe('OR assignment groups use one matcher for preview, save and submission',()=>{
 async function units(){
  return owner.db.insert(schema.businessUnit).values(['MATERIALS','GROUP'].map(code=>({tenantId:base.tenantId,companyId:base.companyId,code:`FICT_${code}`,name:`Fictional ${code}`}))).returning();
 }
 it('matches either complete group (BU X AND Design) OR (BU Y AND Design) and submission routes an employee matched only by group 2',async()=>{
  const [materials,group]=await units();
  const e1=await actor('Fictional materials designer',{departmentId:base.deptA}),e2=await actor('Fictional group designer',{departmentId:base.deptA}),e3=await actor('Fictional materials accountant',{departmentId:base.deptB}),s=await actor('Fictional design lead');
  for(const [e,unit] of [[e1,materials],[e2,group],[e3,materials]] as const)await owner.db.update(schema.assignment).set({businessUnitId:unit.id}).where(eq(schema.assignment.employmentId,e.employmentId));
  await reports(e2,s);
  const criteria:AttendanceWorkflowCriteria={groups:[{businessUnitIds:[materials.id],departmentIds:[base.deptA]},{businessUnitIds:[group.id],departmentIds:[base.deptA]}]};
  const input=workflow([],[level([superior(1)])],{criteria});
  const saved=await saveAttendanceWorkflow(adminCtx(base),input);
  expect(saved.criteria).toEqual(criteria);
  expect(new Set((await previewAttendanceWorkflow(adminCtx(base),input,saved.lineageId)).rows.map(row=>row.employmentId))).toEqual(new Set([e1.employmentId,e2.employmentId]));
  // A flat (single-group) assignment of the same fields is an AND across them and matches nobody here.
  expect((await previewAttendanceWorkflow(adminCtx(base),{...input,code:'FLAT',criteria:{businessUnitIds:[materials.id,group.id],departmentIds:[base.deptB]}})).rows.map(row=>row.employmentId)).toEqual([e3.employmentId]);
  const id=await submit(e2);
  expect((await requestOf(id)).templateId).toBe(saved.id);
 });
 it('ORs an employee group with an organisational group and refuses a group-aware overlap at the same priority',async()=>{
  const listed=await actor('Fictional listed employee'),designer=await actor('Fictional designer',{departmentId:base.deptA});
  const first=await saveAttendanceWorkflow(adminCtx(base),workflow([],[level([{kind:'specific_employee',employmentIds:[(await actor('Fictional HR reviewer',{role:'hr_admin'})).employmentId]}])],{priority:7,criteria:{groups:[{employeeIds:[listed.employmentId]},{departmentIds:[base.deptA]}]}}));
  expect(new Set((await previewAttendanceWorkflow(adminCtx(base),{...workflow([],[level([superior(1)])]),criteria:first.criteria,code:first.code,priority:7},first.lineageId)).rows.map(row=>row.employmentId))).toEqual(new Set([listed.employmentId,designer.employmentId]));
  await expect(saveAttendanceWorkflow(adminCtx(base),workflow([],[level([superior(1)])],{priority:7,code:'OVERLAP_G2',criteria:{departmentIds:[base.deptA]}}))).rejects.toMatchObject({code:'overlap'});
  await expect(saveAttendanceWorkflow(adminCtx(base),workflow([],[level([superior(1)])],{priority:8,code:'DISJOINT',criteria:{departmentIds:[base.deptA]}}))).resolves.toMatchObject({priority:8});
 });
 it('accepts a company-scoped label used by only one of the workflow companies',async()=>{
  const [other]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Fictional second company'}).returning();
  const [onlyOther]=await owner.db.insert(schema.businessUnit).values({tenantId:base.tenantId,companyId:other.id,code:'FICT_OTHER',name:'Fictional other unit'}).returning();
  const [onlyBase]=await owner.db.insert(schema.businessUnit).values({tenantId:base.tenantId,companyId:base.companyId,code:'FICT_BASE',name:'Fictional base unit'}).returning();
  const input={...workflow([],[level([superior(1)])]),companyIds:[base.companyId,other.id],criteria:{groups:[{businessUnitIds:[onlyBase.id]},{businessUnitIds:[onlyOther.id]}]}};
  await expect(saveAttendanceWorkflow(adminCtx(base),input)).resolves.toMatchObject({companyIds:[base.companyId,other.id].sort()});
 });
});

describe('Save no longer resolves every employee; Preview Assignment is stored',()=>{
 it('saves without per-employee resolution and still refuses self-approval and invalid labels',async()=>{
  const lone=await actor('Fictional saved without superior');
  const saved=await saveAttendanceWorkflow(adminCtx(base),workflow([lone],[level([superior(1)])]));
  expect(saved).not.toHaveProperty('warningCount');
  expect(await owner.db.select().from(schema.attendanceWorkflowPreview)).toEqual([]);
  await expect(saveAttendanceWorkflow(adminCtx(base),workflow([lone],[level([{kind:'specific_employee',employmentIds:[lone.employmentId]}])],{code:'SELF'}))).rejects.toMatchObject({problem:{code:'self_approval'}});
  await expect(saveAttendanceWorkflow(adminCtx(base),workflow([],[level([superior(1)])],{code:'BAD_LABEL',criteria:{groups:[{departmentIds:[base.deptA]},{departmentIds:[randomUUID()]}]}}))).rejects.toMatchObject({code:'invalid'});
 });
 it('stores matching employees and distinct Direct Superior warnings with the approver, and flags an older version',async()=>{
  const ok=await actor('Fictional routed employee'),okBoss=await actor('Fictional routed superior');await reports(ok,okBoss);
  const noLogin=await actor('Fictional employee whose superior has no login'),loginless=await actor('Fictional superior without login',{login:false});await reports(noLogin,loginless);
  const inactive=await actor('Fictional employee whose superior left'),gone=await actor('Fictional departed superior');await reports(inactive,gone);
  await owner.db.update(schema.employment).set({terminatedOn:'2021-01-01'}).where(eq(schema.employment.id,gone.employmentId));
  const lone=await actor('Fictional employee without superior');
  const root=adminCtx(base),saved=await saveAttendanceWorkflow(root,workflow([ok,noLogin,inactive,lone],[level([superior(1)]),level([superior(2)])]));
  const generated=await generateAttendanceWorkflowPreview(root,saved.lineageId,1,[base.companyId]);
  expect(generated).toMatchObject({totalMatching:4,warningCount:3});
  const stored=(await getAttendanceWorkflowPreview(root,saved.lineageId,[base.companyId]))!;
  expect(stored).toMatchObject({id:generated.id,templateVersion:1,totalMatching:4,warningCount:3,truncated:false});
  const byEmployee=Object.fromEntries(stored.warnings.map(w=>[w.employmentId,w]));
  expect(byEmployee[noLogin.employmentId]).toMatchObject({levelIndex:0,source:{kind:'direct_manager',depth:1},superiorProblem:'no_login',approverName:'Fictional superior without login'});
  expect(byEmployee[inactive.employmentId]).toMatchObject({levelIndex:0,superiorProblem:'superior_inactive',approverName:'Fictional departed superior'});
  expect(byEmployee[lone.employmentId]).toMatchObject({levelIndex:0,superiorProblem:'no_superior',approverName:null});
  expect(stored.employees.find(e=>e.employmentId===ok.employmentId)).toMatchObject({outcome:'routed',levels:[{level:1,state:'resolved',approvers:[{name:'Fictional routed superior'}]},{level:2,state:'skipped',approvers:[]}]});
  // Later Personnel changes appear only in a new preview, and a later save marks the stored one as older.
  await saveAttendanceWorkflow(root,{...workflow([ok,noLogin,inactive,lone],[level([superior(1)])]),code:saved.code,expectedVersion:1},saved.lineageId);
  const headers=(await listAttendanceWorkflowPreviews(root,saved.lineageId,[base.companyId]))!;
  expect(headers.map(h=>[h.id,h.templateVersion])).toEqual([[generated.id,1]]);
  await expect(generateAttendanceWorkflowPreview(root,saved.lineageId,1,[base.companyId])).rejects.toMatchObject({code:'stale'});
  const newer=await generateAttendanceWorkflowPreview(root,saved.lineageId,2,[base.companyId]);
  expect((await listAttendanceWorkflowPreviews(root,saved.lineageId,[base.companyId]))!.map(h=>h.id)).toEqual([newer.id,generated.id]);
  expect((await getAttendanceWorkflowPreview(root,saved.lineageId,[base.companyId],generated.id))!.templateVersion).toBe(1);
  const events=await owner.db.select({payload:schema.domainEvent.payload}).from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,saved.lineageId),eq(schema.domainEvent.eventType,'attendance-workflow-preview.generated')));
  expect(events).toHaveLength(2);
 });
 it('is append-only and readable only by an administrator of every workflow company',async()=>{
  const root=adminCtx(base),employee=await actor('Fictional preview subject');
  const [other]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Fictional preview second company'}).returning();
  const saved=await saveAttendanceWorkflow(root,{...workflow([employee],[level([superior(1)])]),companyIds:[base.companyId,other.id]});
  const generated=await generateAttendanceWorkflowPreview(root,saved.lineageId,1,[base.companyId,other.id]);
  expect(await failure(()=>owner.db.update(schema.attendanceWorkflowPreview).set({warningCount:0}).where(eq(schema.attendanceWorkflowPreview.id,generated.id)))).not.toBeNull();
  expect(await failure(()=>owner.db.delete(schema.attendanceWorkflowPreview).where(eq(schema.attendanceWorkflowPreview.id,generated.id)))).not.toBeNull();
  const scoped=await actor('Fictional one-company HR',{role:'hr_admin'});
  await owner.db.update(schema.roleAssignment).set({companyId:base.companyId}).where(eq(schema.roleAssignment.appUserId,scoped.userId!));
  await expect(generateAttendanceWorkflowPreview(scoped.ctx,saved.lineageId,1,[base.companyId])).rejects.toMatchObject({code:'scope'});
  expect(await getAttendanceWorkflowPreview(scoped.ctx,saved.lineageId,[base.companyId])).toBeNull();
  expect(await withTenant(scoped.ctx,tx=>tx.select().from(schema.attendanceWorkflowPreview))).toEqual([]);
  const plain=await actor('Fictional employee reader');
  await expect(generateAttendanceWorkflowPreview(plain.ctx,saved.lineageId,1,[base.companyId])).rejects.toMatchObject({code:'scope'});
  expect(await withTenant(plain.ctx,tx=>tx.select().from(schema.attendanceWorkflowPreview))).toEqual([]);
 });
 it('the Direct Superior diagnostic answers only an administrator of the subject company',async()=>{
  const a=await actor('Fictional diagnosed employee'),b=await actor('Fictional diagnosed superior',{login:false});await reports(a,b);
  const query=(ctx:SessionContext)=>withTenant(ctx,tx=>tx.execute<{level_number:number;problem:string|null;full_name:string|null}>(sql`select level_number,problem,full_name from app.attendance_workflow_superior_diagnostic(${a.employmentId}::uuid,2)`));
  expect((await query(adminCtx(base))).map(row=>({...row}))).toEqual([{level_number:1,problem:'no_login',full_name:'Fictional diagnosed superior'}]);
  expect(await query(a.ctx)).toHaveLength(0);
 });
});

describe('Copy Workflow',()=>{
 it('saves a separate workflow with provenance and never writes to the source',async()=>{
  const root=adminCtx(base),employee=await actor('Fictional copied subject');
  const source=await saveAttendanceWorkflow(root,workflow([employee],[level([superior(1)])],{priority:20}));
  const before=await owner.db.select().from(schema.attendanceWorkflowTemplate).where(eq(schema.attendanceWorkflowTemplate.lineageId,source.lineageId));
  // An unchanged copy covers the same employees at the same priority and is refused.
  await expect(saveAttendanceWorkflow(root,{...workflow([employee],[level([superior(1)])],{priority:20}),code:'COPY_SAME'},undefined,undefined,false,undefined,{lineageId:source.lineageId,version:1})).rejects.toMatchObject({code:'overlap'});
  const copy=await saveAttendanceWorkflow(root,{...workflow([employee],[level([superior(1)])],{priority:21}),code:'COPY_NEW',name:'Fictional copy'},undefined,undefined,false,undefined,{lineageId:source.lineageId,version:1});
  expect(copy.lineageId).not.toBe(source.lineageId);
  const [created]=await owner.db.select({payload:schema.domainEvent.payload}).from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,copy.lineageId),eq(schema.domainEvent.eventType,'attendance-workflow-template.created')));
  expect(created.payload).toMatchObject({copiedFrom:{lineageId:source.lineageId,version:1}});
  expect(await owner.db.select().from(schema.attendanceWorkflowTemplate).where(eq(schema.attendanceWorkflowTemplate.lineageId,source.lineageId))).toEqual(before);
 });
 it('refuses provenance from a workflow outside the administrator scope or with an invalid reference',async()=>{
  const root=adminCtx(base),employee=await actor('Fictional scoped copy subject');
  const [other]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Fictional copy second company'}).returning();
  const shared=await saveAttendanceWorkflow(root,{...workflow([employee],[level([superior(1)])]),companyIds:[base.companyId,other.id]});
  const scoped=await actor('Fictional copy HR',{role:'hr_admin'});
  await owner.db.update(schema.roleAssignment).set({companyId:base.companyId}).where(eq(schema.roleAssignment.appUserId,scoped.userId!));
  await expect(saveAttendanceWorkflow(scoped.ctx,{...workflow([],[level([superior(1)])],{priority:30}),code:'COPY_SCOPE'},undefined,undefined,false,undefined,{lineageId:shared.lineageId,version:1})).rejects.toMatchObject({code:'scope'});
  await expect(saveAttendanceWorkflow(root,{...workflow([],[level([superior(1)])],{priority:31}),code:'COPY_BAD'},undefined,undefined,false,undefined,{lineageId:'not-a-lineage',version:1})).rejects.toMatchObject({code:'invalid'});
  await expect(saveAttendanceWorkflow(root,{...workflow([],[level([superior(1)])],{priority:32}),code:'COPY_EDIT'},shared.lineageId,undefined,false,undefined,{lineageId:shared.lineageId,version:1})).rejects.toMatchObject({code:'invalid'});
 });
});
