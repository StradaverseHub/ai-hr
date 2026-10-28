/** Authored UNRUN. Real native source controls for seven specialist domain interpreters.
 * No injected reader, model, provider, learned HR fact, inline migration or independent execution claim.
 * Requires normally installed AI action controls; fixture absence fails rather than skips coverage. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {assignRole} from '../core/admin';
import {hireEmployee,setReportingLine} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {withAssistantRead} from '../core/assistant-read-session';
import {executeSpecialistHoldout,type SpecialistEvaluationReport} from '../core/module-specialist-harness';
import {executeCanonicalSpecialist} from '../lib/ai/module-specialists';
import type {AgentModuleCode} from '../lib/ai/module-agents';
import {createArticle} from '../core/knowledge-base';
import {createNotice,publishNotice} from '../core/notice';
import {dispatchNotifications,listNotifications,markNotificationRead} from '../core/notifications';
import {createOnboardingCase,getMyOnboarding,tickStep} from '../packs/lifecycle/service';
import * as perf from '../packs/performance/service';
import {defaultPolicy} from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import * as testing from '../core/system-testing-workspace';
import {reopenOwnTestingExecutionEventTx} from '../core/assistant-actions/own-testing-execution-source';
import type {InstructionDefinition} from '../lib/system-testing/model';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,a:SessionContext;
const year=Number(todayInKualaLumpur().slice(0,4));
const configuration=(module:AgentModuleCode)=>({kind:'canonical_specialist_v1',module,playbook:'canonical_domain_v1'} as const);
const evaluate=(ctx:SessionContext,module:AgentModuleCode)=>withAssistantRead(ctx,module,read=>executeSpecialistHoldout(configuration(module),read));
const assess=(ctx:SessionContext,module:AgentModuleCode)=>withAssistantRead(ctx,module,async read=>{
 const native=await read.moduleWork(module);
 return {native,assessment:executeCanonicalSpecialist(configuration(module),native)};
});
function complete(report:SpecialistEvaluationReport,module:AgentModuleCode){
 expect(report).toMatchObject({module,state:'complete',nativeEvidence:'present',securityFailures:0,qualityFailures:0,coverage:'canonical_domain_guidance_only'});
 expect(report.cases.filter(row=>row.category==='native')).toEqual([
  {id:module+':fresh-native-facts-preserved',passed:true,category:'native'},
  {id:module+':nonempty-business-evidence',passed:true,category:'native'}
 ]);
 expect(JSON.stringify(report)).not.toContain('PRIVATE_');
}
async function events(){return owner.db.select({id:s.domainEvent.id}).from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id);}
async function checked(ctx:SessionContext,module:AgentModuleCode){
 const before=await events(),report=await evaluate(ctx,module),view=await assess(ctx,module);
 complete(report,module);expect(view.assessment.effects).toEqual([]);expect(view.assessment.requiresFreshNativeReview).toBe(true);
 expect(view.native.scope).toBe('current-caller');expect(await events()).toEqual(before);
 return view;
}
async function revoke(ctx:SessionContext,module:AgentModuleCode){
 await revokeAssistant(a,{appUserId:ctx.userId!});
 await expect(evaluate(ctx,module)).rejects.toThrow();
}
async function employee(name='Fictional own specialist'){
 const email=randomUUID()+'@fixture.test',hired=await hireEmployee(a,{person:{fullName:name,primaryEmail:email},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
 const userId=await createAppUser(b.tenantId,hired.personId,'employee');
 await grantAssistant(a,{appUserId:userId});
 const ctx:SessionContext={...await entitledCtx(b),userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 return {...hired,email,ctx};
}
async function standalone(){
 const [user]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'user_'+randomUUID(),personId:null}).returning({id:s.appUser.id});
 await assignRole(a,{appUserId:user.id,role:'employee'});await grantAssistant(a,{appUserId:user.id});
 return {...await entitledCtx(b),userId:user.id,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}]} satisfies SessionContext;
}
beforeAll(async()=>{
 await migrateTestDb();
 const [installed]=await owner.db.execute<{controls:boolean;testingReceipt:boolean}>(sql`select to_regprocedure('app.ai_action_unpaused(text,boolean)') is not null as controls,to_regprocedure('app.testing_own_execution_event_source(uuid,uuid)') is not null as "testingReceipt"`);
 expect(installed,'Install the reviewed AI action-control and fixed-purpose Testing receipt migrations through the normal owner before these native controls').toEqual({controls:true,testingReceipt:true});
});
afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 // Optional modules only: core Knowledge Base must never gain a fabricated tenant module row.
 for(const module of ['assistant','performance','lifecycle','notifications','system_explorer','system_testing'])await setModule(b.tenantId,module,'active');
 a={...await entitledCtx(b),personId:null,grants:[{role:'hr_admin',companyId:null}]};
});

describe('canonical specialist native business controls (seven modules)',()=>{
 it('Performance distinguishes an actual standard unreleased review and OneHR review/plan without rating or endorsement inference',async()=>{
  const self=await employee(),manager=await employee('Fictional manager');
  const [grade]=await owner.db.insert(s.jobGrade).values({tenantId:b.tenantId,code:'12',name:'Fictional grade12'}).returning({id:s.jobGrade.id});
  await owner.db.update(s.employment).set({gradeId:grade.id}).where(eq(s.employment.tenantId,b.tenantId));
  await setReportingLine(a,{subordinateEmploymentId:self.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:`${year-2}-01-01`});
  const modern=await perf.createCycle(a,{name:'Current OneHR cycle',companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});
  await perf.configureOnehrCycle(a,modern.cycleId,null,defaultPolicy(framework));await perf.openCycle(a,modern);
  const [review]=await owner.db.select({id:s.performanceReview.id}).from(s.performanceReview).where(and(eq(s.performanceReview.cycleId,modern.cycleId),eq(s.performanceReview.employmentId,self.employmentId)));
  expect(review).toBeTruthy();
  await perf.saveOnehrPlan(self.ctx,review.id,null,{career:{aspiration:'PRIVATE_CAREER',mobility:'stay',mobilityNote:'PRIVATE_MOBILITY',targetProfileId:null},goals:[]});
  const standard=await perf.createCycle(a,{name:'Standard prior cycle',companyId:b.companyId,periodStart:`${year-1}-01-01`,periodEnd:`${year-1}-12-31`});await perf.openCycle(a,standard);
  const {native,assessment}=await checked(self.ctx,'performance');
  const rows=native.data as Awaited<ReturnType<typeof perf.ownPerformanceWorkStatusesTx>>;
  expect(rows.rows).toEqual(expect.arrayContaining([
   expect.objectContaining({reviewId:review.id,framework:'onehr',artifact:'review',released:null}),
   expect.objectContaining({reviewId:review.id,framework:'onehr',artifact:'plan',status:'draft',released:null}),
   expect.objectContaining({cycleName:'Standard prior cycle',framework:'standard',released:false})
  ]));
  expect(assessment.findings).toEqual(expect.arrayContaining(['onehr_review_status_not_rating','onehr_plan_status_not_endorsement','standard_review_unreleased']));
  expect(assessment.findings).not.toContain('standard_review_released');expect(JSON.stringify({native,assessment})).not.toContain('PRIVATE_');
  await revoke(self.ctx,'performance');
 });

 it('Lifecycle follows the actual own-email checklist and incomplete applicable steps rather than treating a tick as completion',async()=>{
  const self=await employee(),peer=await employee('PRIVATE_PEER');
  await owner.db.update(s.company).set({companyLabel:'OWN'}).where(eq(s.company.id,b.companyId));
  for(const subject of [self,peer])await createOnboardingCase(a,{companyId:b.companyId,fullName:subject===self?'Fictional own case':'PRIVATE_PEER_CASE',employeeNo:subject===self?'OWN-NATIVE':'PEER-NATIVE',joinDate:todayInKualaLumpur(),newhireEmail:subject.email,jobTitle:'Canonical role',department:'Canonical department',supervisor:'PRIVATE_SUPERVISOR',laptopRequired:false,carparkRequired:false,costCentre:'PRIVATE_COST',nricPassport:'PRIVATE_ID',notes:'PRIVATE_CASE_NOTES'});
  const before=await getMyOnboarding(self.ctx);expect(before).toBeTruthy();expect(before!.progress.total).toBeGreaterThan(1);
  await tickStep(a,'onboarding',before!.number,'p_file');
  const actual=await getMyOnboarding(self.ctx);expect(actual!.steps.find(row=>row.key==='p_file')?.done).toBe(true);
  expect(actual!.steps.some(row=>row.applicable&&!row.done)).toBe(true);
  const {native,assessment}=await checked(self.ctx,'lifecycle');
  expect(native.data).toMatchObject({progress:actual!.progress,steps:expect.arrayContaining([expect.objectContaining({key:'p_file',done:true})])});
  expect(assessment.findings).toContain('lifecycle_steps_remaining');expect(assessment.findings).not.toContain('lifecycle_progress_complete');
  for(const secret of ['PRIVATE_','PEER-NATIVE',peer.email])expect(JSON.stringify({native,assessment})).not.toContain(secret);
  await revoke(self.ctx,'lifecycle');
 });

 it('Knowledge Base evaluates a real permitted published index without treating article text or hidden HR policy as retrieved evidence',async()=>{
  const self=await employee();
  const permitted=await createArticle(a,{title:'Current employee guide',body:'PRIVATE_ARTICLE_BODY',category:'General',audience:'all'});
  const hidden=await createArticle(a,{title:'PRIVATE_HR_TITLE',body:'PRIVATE_HR_BODY',category:'Private',audience:'hr_admin'});
  const {native,assessment}=await checked(self.ctx,'knowledge_base');
  const data=native.data as {rows:{id:string;title:string}[];truncated:boolean};
  expect(data.rows).toEqual(expect.arrayContaining([expect.objectContaining({id:permitted.id,title:'Current employee guide'})]));
  expect(data.rows.some(row=>row.id===hidden.id)).toBe(false);expect(assessment.findings).toContain('published_index_not_policy_text');
  expect(JSON.stringify({native,assessment})).not.toContain('PRIVATE_');
  await revoke(self.ctx,'knowledge_base');
 });

 it('Notifications reads an actual native published notice projection and current read marker, never equating the marker with external delivery',async()=>{
  const self=await employee(),peer=await employee('Fictional other recipient');
  const notice=await createNotice(a,{title:'PRIVATE_NOTICE_TITLE',body:'PRIVATE_NOTICE_BODY',startOn:todayInKualaLumpur(),endOn:todayInKualaLumpur(),companyId:b.companyId,targetMode:'individual',employmentIds:[self.employmentId],notifyOnPublish:true});
  expect(await publishNotice(a,notice.id)).toEqual({recipients:1});
  expect((await dispatchNotifications(a)).created).toBeGreaterThan(0);
  const notices=await listNotifications(self.ctx,self.employmentId),own=notices.find(row=>row.kind==='notice.published');expect(own).toBeTruthy();
  expect((await listNotifications(peer.ctx,peer.employmentId)).some(row=>row.id===own!.id)).toBe(false);
  const first=await checked(self.ctx,'notifications');expect(first.assessment.findings).toContain('notification_unread_not_delivery_proof');
  expect((first.native.data as {rows:unknown[]}).rows).toContainEqual(expect.objectContaining({id:own!.id,readAt:null}));
  await markNotificationRead(self.ctx,own!.id);
  const next=await checked(self.ctx,'notifications');expect(next.assessment.findings).toContain('notification_read_recorded');
  expect((next.native.data as {rows:{id:string;readAt:unknown}[]}).rows.find(row=>row.id===own!.id)?.readAt).not.toBeNull();
  expect(JSON.stringify({first,next})).not.toContain('PRIVATE_');
  await revoke(self.ctx,'notifications');
 });

 it('System Explorer evaluates actual authorized schema metadata without interpreting it as record access, and refuses the real employee',async()=>{
  await grantAssistant(a,{appUserId:a.userId!});expect(a.personId).toBeNull();
  const {native,assessment}=await checked(a,'system_explorer'),data=native.data as {tables:{rows:{table:string;module:string|null}[]};withheldTables:number};
  expect(data.tables.rows.length).toBeGreaterThan(0);expect(data.tables.rows.every(row=>Object.keys(row).sort().join(',')==='module,table')).toBe(true);
  expect(assessment.findings).toContain('schema_inventory_not_record_access');
  const employeeCtx=(await employee()).ctx;await expect(evaluate(employeeCtx,'system_explorer')).rejects.toThrow();
  await setModule(b.tenantId,'system_explorer','disabled');await expect(evaluate(a,'system_explorer')).rejects.toThrow();
 });

 it('Assistant evaluates the real enabled catalogue for a standalone user while preserving authority rechecks and human-only effects',async()=>{
  const ctx=await standalone();expect(ctx.personId).toBeNull();
  const {native,assessment}=await checked(ctx,'assistant'),data=native.data as {capabilities:{module:string;authority:string}[];effects:string};
  expect(data.capabilities.length).toBeGreaterThan(0);expect(data.capabilities.some(row=>row.module==='system_testing')).toBe(true);
  expect(data.capabilities.some(row=>row.module==='system_explorer')).toBe(false);
  expect(data.capabilities.every(row=>row.authority==='rechecked-at-canonical-source')).toBe(true);
  expect(data.effects).toBe('human-confirmation-only');expect(assessment.findings).toEqual(expect.arrayContaining(['catalogue_not_permission','human_confirmation_owns_effects']));
  expect(JSON.stringify({native,assessment})).not.toContain(ctx.userId!);await revoke(ctx,'assistant');
 });

 it('System Testing uses real standalone assignment/execution, labels human pass truthfully and requires native retest after publication',async()=>{
  const ctx=await standalone(),peer=await standalone();
  const definition:InstructionDefinition={format:1,title:'Current assigned check',objective:'PRIVATE_OBJECTIVE',functionKey:'personnel.profile',area:'personnel',moduleCode:'employees',category:'functional',priority:'medium',active:true,prerequisites:['PRIVATE_PREREQUISITE'],testData:['PRIVATE_DATA'],steps:[{id:'observe',action:'PRIVATE_INSTRUCTION',expected:'PRIVATE_EXPECTATION'}],expectedBehavior:'PRIVATE_BEHAVIOR',expectedFunction:'PRIVATE_FUNCTION',permissions:['PRIVATE_PERMISSION'],jurisdiction:null,configuration:null,screenKeys:['personnelAdmin']};
  const draft=await testing.saveTestInstructionDraft(a,{caseId:null,expectedRevision:0,definition}),version=await testing.publishTestInstruction(a,{caseId:draft.caseId,expectedDraftRevision:draft.revision,expectedVersionId:null});
  const assignment=await testing.assignTestingCase(a,{caseId:draft.caseId,testerUserId:ctx.userId!,expectedVersionId:version.versionId,active:true,expectedRevision:null});
  const start=await checked(ctx,'system_testing');expect(start.assessment.findings).toContain('test_work_incomplete');
  const execution=await testing.beginTestingExecution(ctx,{assignmentId:assignment.assignmentId,expectedVersionId:version.versionId,newAttempt:false});
  const saved=await testing.saveTestingExecution(ctx,{executionId:execution.executionId,assignmentId:assignment.assignmentId,versionId:version.versionId,expectedRevision:execution.revision,status:'passed',actualResult:'PRIVATE_OBSERVED_RESULT',comments:'PRIVATE_COMMENT',defectNotes:'',improvementNotes:''});
  expect(saved).toEqual({runId:expect.any(String),revision:execution.revision+1});expect(ctx.personId).toBeNull();expect(ctx.roles).toEqual(['employee']);
  // Native event provenance is checked through fixture-owner evidence, never a forged subject/HR role.
  const observationEvents=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,b.tenantId),eq(s.domainEvent.aggregateId,draft.caseId),eq(s.domainEvent.eventType,'test_execution.observation_saved')));
  expect(observationEvents).toHaveLength(1);const recorded=observationEvents[0];
  expect(recorded).toMatchObject({actorType:'user',actorId:ctx.userId,subjectEmploymentId:null,payload:{executionId:execution.executionId,runId:saved.runId,versionId:version.versionId,revision:saved.revision,status:'passed',testerUserId:ctx.userId}});
  // INSERT remains legitimate while broad event SELECT is still withheld from this standalone tester.
  expect(await withTenant(ctx,tx=>tx.select({id:s.domainEvent.id}).from(s.domainEvent).where(eq(s.domainEvent.id,recorded.id)))).toEqual([]);
  const beforeReopen=await events(),reference={runId:saved.runId,eventId:recorded.id};
  const receipt=await withTenant(ctx,tx=>reopenOwnTestingExecutionEventTx(tx,ctx,reference));
  expect(receipt).toMatchObject({...reference,caseId:draft.caseId,assignmentId:assignment.assignmentId,executionId:execution.executionId,versionId:version.versionId,revision:saved.revision,status:'passed',meaning:'human_observation_recorded_not_independently_verified'});
  expect(await withTenant(ctx,tx=>reopenOwnTestingExecutionEventTx(tx,ctx,reference))).toEqual(receipt);
  expect(await events()).toEqual(beforeReopen);expect(await owner.db.select().from(s.testRun).where(eq(s.testRun.executionId,execution.executionId))).toHaveLength(1);
  const passed=await checked(ctx,'system_testing');expect(passed.assessment.findings).toContain('human_test_pass_not_independent_verification');
  expect((passed.native.data as {rows:unknown[]}).rows).toContainEqual(expect.objectContaining({assignmentId:assignment.assignmentId,status:'passed'}));
  const unassigned=await evaluate(peer,'system_testing');expect(unassigned).toMatchObject({state:'incomplete',nativeEvidence:'missing'});
  const [current]=await owner.db.select().from(s.testCase).where(eq(s.testCase.id,draft.caseId));
  const revised=await testing.saveTestInstructionDraft(a,{caseId:draft.caseId,expectedRevision:current.draftRevision,definition:{...definition,objective:'PRIVATE_CHANGED_OBJECTIVE'}});
  const published=await testing.publishTestInstruction(a,{caseId:draft.caseId,expectedDraftRevision:revised.revision,expectedVersionId:version.versionId});
  const retest=await checked(ctx,'system_testing');expect((retest.native.data as {rows:unknown[]}).rows).toContainEqual(expect.objectContaining({versionId:published.versionId,status:'retest_required',executionId:null}));
  expect(retest.assessment.findings).toContain('human_test_failure_needs_native_followup');expect(retest.assessment.findings).not.toContain('human_test_pass_not_independent_verification');
  expect(JSON.stringify({start,passed,retest})).not.toContain('PRIVATE_');
  await revoke(ctx,'system_testing');
 });
});
