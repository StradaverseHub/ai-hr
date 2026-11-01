/** Native platform prerequisites for the future owned full-browser fixture. Not an entry point.
 * The guarded coordinator must already own the disposable DB/runtime and complete Workforce/financial
 * preparation. Nothing here mounts auth, starts services, writes a manifest or calls a provider.
 * Human correction/request/acknowledgement/test-save/promotion effects remain for the browser. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {assignRole} from '../../core/admin';
import {createNotice,publishNotice} from '../../core/notice';
import {dispatchNotifications,listNotifications} from '../../core/notifications';
import {grantAssistant} from '../../core/assistant-grant';
import {resolveEntitlementsTx} from '../../core/entitlements';
import {createShift,assignDefaultShift,setRestDay} from '../../core/roster'; // Shared roster spine has no public pack facade.
import {checkIn,checkOut,saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../../packs/attendance/service';
import {setToilPolicy,replacementRequestAvailability,leaveCreditOfferForEmployment} from '../../packs/leave/service';
import {createOnboardingCase,tickStep,getMyOnboarding,ONBOARDING_STEPS} from '../../packs/lifecycle/service';
import * as testing from '../../core/system-testing-workspace'; // No System Testing pack service exists.
import type {InstructionDefinition} from '../../lib/system-testing/model';
import {withAssistantRead} from '../../core/assistant-read-session';
import {AGENT_MODULE_CODES,type AgentModuleCode} from '../../lib/ai/module-agents';
import {executeSpecialistHoldout} from '../../core/module-specialist-harness';
import {specialistReviewWorkspaceTx} from '../../core/module-agent-releases';
import {aiDeliveryFixtureCalendar,type AiDeliveryFixtureContext} from './ai-delivery-fixture-context';

function requireFact(condition:unknown,message:string):asserts condition{if(!condition)throw Error('AI platform fixture: '+message);}
const actorCopy=(actor:AiDeliveryFixtureContext['actors']['operator'])=>({...actor,ctx:{...actor.ctx,roles:actor.ctx.roles?.slice(),grants:actor.ctx.grants?.map(grant=>({...grant}))}});

export async function populateAiDeliveryPlatform(input:AiDeliveryFixtureContext){
 const {owner,tenantId,companyId,today,period}=input,bootstrapCtx={...input.bootstrapCtx,roles:input.bootstrapCtx.roles?.slice(),grants:input.bootstrapCtx.grants?.map(grant=>({...grant}))};
 const operator=actorCopy(input.actors.operator),self=actorCopy(input.actors.self),reviewers=input.actors.reviewers.map(actorCopy),peer=actorCopy(input.actors.peer),manager=actorCopy(input.actors.manager);
 const participants=[operator,self,...reviewers,peer,manager];
 requireFact(period===today.slice(0,7),'the current native period must match the declared fixture day');
 requireFact(new Set(participants.map(actor=>actor.userId)).size===participants.length,'distinct actual callers required');
 requireFact(new Set([operator,...reviewers].map(actor=>actor.personId)).size===3,'independent evaluators must have distinct actual own people');
 const {correctionDate,workedDate}=aiDeliveryFixtureCalendar(today);
 const actualPeople=await owner.db.select({personId:s.person.id,name:s.person.fullName,email:s.person.primaryEmail,employmentId:s.employment.id,employeeCode:s.employment.employeeCode,hiredOn:s.employment.hiredOn})
  .from(s.employment).innerJoin(s.person,and(eq(s.person.id,s.employment.personId),eq(s.person.tenantId,s.employment.tenantId)))
  .where(and(eq(s.employment.tenantId,tenantId),eq(s.employment.companyId,companyId)));
 function personFor(actor:typeof operator){const person=actualPeople.find(row=>row.employmentId===actor.employmentId&&row.personId===actor.personId);requireFact(person?.email&&person.employeeCode&&person.hiredOn<=workedDate,'actual pre-existing employment/email must cover worked-date fixture');return person;}
 for(const actor of participants)personFor(actor);

 // Explicit fictional admin configuration, not invented employee observations or an eligibility bypass.
 // The native First Schedule gate may require a separate human consent; do not precheck that consent.
 await setToilPolicy(bootstrapCtx,{companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',allowFirstScheduleEligible:true,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true,extendedHoursEnabled:true});
 const shift=await createShift(bootstrapCtx,{companyId,name:'Fictional AI browser native shift',code:'AIB-'+randomUUID().slice(0,8),startTime:'08:00:00',endTime:'17:00:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5],offPattern:[6]});
 const correctionActors=[operator,self,...reviewers,peer];
 const workflow=await saveAttendanceWorkflow(bootstrapCtx,{companyId,code:'AI_BROWSER_NATIVE_IRREGULARITY',name:'Fictional browser manager review',description:'Explicit fictional native route; no request autoapproval',applicationType:'irregularity',priority:100,criteria:{employeeIds:correctionActors.map(actor=>actor.employmentId)},stages:[{name:'Actual administrative manager',level:{kind:'direct_manager',employmentId:null,alternates:[]}}],active:true});
 await setAttendanceWorkflowEnabled(bootstrapCtx,companyId,'irregularity',true);
 const attendance:Record<string,{employmentId:string;date:string;workedDate:string;shiftId:string;requiresFirstScheduleConsent:boolean;ordinaryDayAllowed:boolean}>={};
 for(const actor of participants){
  await assignDefaultShift(bootstrapCtx,{employmentId:actor.employmentId,shiftId:shift.id});
  await setRestDay(bootstrapCtx,{employmentId:actor.employmentId,shiftDate:workedDate});
  // These are explicit fictional manual observations through the real clocking owner. No INSERT of
  // computed attendance, worked minutes, approved overtime or pre-completed correction is performed.
  for(const date of new Set([correctionDate,workedDate])){
   await checkIn(bootstrapCtx,{employmentId:actor.employmentId,date,time:'08:00',manual:true});
   await checkOut(bootstrapCtx,{employmentId:actor.employmentId,date,time:'17:00',manual:true});
  }
  const availability=await replacementRequestAvailability(actor.ctx,actor.employmentId,today),offer=await leaveCreditOfferForEmployment(actor.ctx,actor.employmentId);
  requireFact(availability.allowed&&offer,'native TOIL request availability/offer must succeed for the actual person');
  attendance[actor.userId]={employmentId:actor.employmentId,date:correctionDate,workedDate,shiftId:shift.id,requiresFirstScheduleConsent:availability.requiresFirstScheduleConsent===true,ordinaryDayAllowed:offer.ordinaryDayAllowed};
 }

 async function readyCase(actor:typeof operator){
  const actual=personFor(actor),created=await createOnboardingCase(bootstrapCtx,{companyId,fullName:actual.name,employeeNo:actual.employeeCode!,joinDate:today,newhireEmail:actual.email!,personId:actor.personId,employmentId:actor.employmentId,laptopRequired:true,carparkRequired:false});
  for(const step of ONBOARDING_STEPS.filter(step=>step.phase===0&&step.rule!=='carpark'))await tickStep(bootstrapCtx,'onboarding',created.number,step.key);
  await tickStep(bootstrapCtx,'onboarding',created.number,'laptop_dist');
  const own=await getMyOnboarding(actor.ctx);requireFact(own?.number===created.number&&own.acknowledgement.available&&own.acknowledgement.submittedAt===null,'actual linked own DAA must be available and unsubmitted');
  return {caseId:created.id,number:created.number,employmentId:actor.employmentId,personId:actor.personId,status:own.status,acknowledgementSubmitted:false as const};
 }
 const lifecycle:Record<string,Awaited<ReturnType<typeof readyCase>>>={};
 for(const actor of participants)lifecycle[actor.userId]=await readyCase(actor);

 // A real PERSON with no EMPLOYMENT exercises native email-owned prehire access. This identity-only
 // fixture insertion is not a hire or HR effect. Case creation/eligibility uses the unchanged native owner.
 const prehireEmail='ai-browser-prehire-'+randomUUID()+'@example.test';
 const [prehirePerson]=await owner.db.insert(s.person).values({tenantId,fullName:'Fictional AI browser prehire recipient',primaryEmail:prehireEmail}).returning({id:s.person.id});
 const [prehireLogin]=await owner.db.insert(s.appUser).values({tenantId,personId:prehirePerson.id,workosUserId:'ai-browser-prehire:'+randomUUID(),onboardedAt:new Date()}).returning({id:s.appUser.id});
 await assignRole(bootstrapCtx,{appUserId:prehireLogin.id,role:'employee'});await grantAssistant(bootstrapCtx,{appUserId:prehireLogin.id});
 const prehireCtx:SessionContext={tenantId,userId:prehireLogin.id,personId:prehirePerson.id,roles:['employee'],grants:[{role:'employee',companyId:null}],entitlements:await withTenant(bootstrapCtx,tx=>resolveEntitlementsTx(tx,tenantId))};
 const prehireCase=await createOnboardingCase(bootstrapCtx,{companyId,fullName:'Fictional AI browser prehire recipient',employeeNo:'PRE-'+randomUUID().slice(0,8),joinDate:today,newhireEmail:prehireEmail,laptopRequired:true,carparkRequired:false});
 for(const step of ONBOARDING_STEPS.filter(step=>step.phase===0&&step.rule!=='carpark'))await tickStep(bootstrapCtx,'onboarding',prehireCase.number,step.key);
 await tickStep(bootstrapCtx,'onboarding',prehireCase.number,'laptop_dist');
 const prehireView=await getMyOnboarding(prehireCtx);requireFact(prehireView?.number===prehireCase.number&&prehireView.acknowledgement.available&&!prehireView.acknowledgement.submittedAt,'actual unlinked prehire DAA must be available');
 const prehireEmployment=await owner.db.select({id:s.employment.id}).from(s.employment).where(and(eq(s.employment.tenantId,tenantId),eq(s.employment.personId,prehirePerson.id)));requireFact(prehireEmployment.length===0,'never fabricate an employment for prehire acknowledgement');

 // Standalone testing USER: no PERSON, employment, subject-employment event or HR grant is invented.
 const [testerLogin]=await owner.db.insert(s.appUser).values({tenantId,personId:null,workosUserId:'ai-browser-tester:'+randomUUID(),onboardedAt:new Date()}).returning({id:s.appUser.id});
 await assignRole(bootstrapCtx,{appUserId:testerLogin.id,role:'employee'});await grantAssistant(bootstrapCtx,{appUserId:testerLogin.id});
 const testerCtx:SessionContext={tenantId,userId:testerLogin.id,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}],entitlements:await withTenant(bootstrapCtx,tx=>resolveEntitlementsTx(tx,tenantId))};
 const definition:InstructionDefinition={format:1,title:'Fictional browser human observation',objective:'Observe the fictional Personnel profile screen using your actual permission.',functionKey:'personnel.profile',area:'personnel',moduleCode:'employees',category:'functional',priority:'medium',active:true,prerequisites:['Use only the provided fictional local fixture.'],testData:['No real employee/customer data.'],steps:[{id:'observe',action:'Open the permitted fictional profile and record what you actually observe.',expected:'Report your own observed result; do not infer pass/fail from this fixture.'}],expectedBehavior:'The human records the actual permitted result.',expectedFunction:'Personnel profile access',permissions:['Actual current native profile authority'],jurisdiction:null,configuration:null,screenKeys:['personnelAdmin']};
 const draft=await testing.saveTestInstructionDraft(bootstrapCtx,{caseId:null,expectedRevision:0,definition}),version=await testing.publishTestInstruction(bootstrapCtx,{caseId:draft.caseId,expectedDraftRevision:draft.revision,expectedVersionId:null});
 const testingAssignments:Record<string,{caseId:string;versionId:string;assignmentId:string;executionId:string;revision:number}>={};
 for(const actor of [...participants,{userId:testerLogin.id,ctx:testerCtx}]){
  const assignment=await testing.assignTestingCase(bootstrapCtx,{caseId:draft.caseId,testerUserId:actor.userId,expectedVersionId:version.versionId,active:true,expectedRevision:null});
  const execution=await testing.beginTestingExecution(actor.ctx,{assignmentId:assignment.assignmentId,expectedVersionId:version.versionId,newAttempt:false});
  const native=await withTenant(actor.ctx,tx=>testing.ownTestingWorkStatusesTx(tx,actor.ctx,25));
  requireFact(native.rows.some(row=>row.assignmentId===assignment.assignmentId&&row.executionId===execution.executionId&&row.status==='not_started'),'native current own Testing execution must be present, with no reported result');
  testingAssignments[actor.userId]={caseId:draft.caseId,versionId:version.versionId,assignmentId:assignment.assignmentId,executionId:execution.executionId,revision:execution.revision};
 }

 // In-app notification evidence comes from an actual immutable notice publication and native
 // projection, not inserted notification/event rows. This never runs the external email dispatcher.
 const notice=await createNotice(bootstrapCtx,{companyId,title:'Fictional AI browser notice',body:'Read the fictional native notice through your own authorized account.',startOn:today,endOn:today,targetMode:'individual',employmentIds:participants.map(actor=>actor.employmentId),notifyOnPublish:true});
 const published=await publishNotice(bootstrapCtx,notice.id);requireFact(published.recipients===participants.length,'native published notice must resolve the exact actual recipient cohort');
 await dispatchNotifications(bootstrapCtx);
 const notificationIds:Record<string,string>={};
 for(const actor of participants){const current=await listNotifications(actor.ctx,actor.employmentId,{limit:25}),own=current.find(row=>row.kind==='notice.published'&&row.linkPath==='/notices/'+notice.id);requireFact(own,'native own in-app notice projection must exist');notificationIds[actor.userId]=own.id;}

 // A catalogue is not a grant. Prove actual Explorer access for the operator and denial for the
 // standalone non-HR tester, rather than making the self user's role a fixture assumption.
 const explorer=await withAssistantRead(operator.ctx,'system_explorer',read=>read.moduleWork('system_explorer'));
 const explorerData=explorer.data as {tables:{rows:unknown[]};withheldTables:number};requireFact(explorerData.tables.rows.length>0,'actual authorized schema metadata required');
 let testerExplorerDenied=false;try{await withAssistantRead(testerCtx,'system_explorer',read=>read.moduleWork('system_explorer'));}catch{testerExplorerDenied=true;}
 requireFact(testerExplorerDenied,'standalone employee must not inherit schema administration');

 // No candidate/evaluation/promotion/feedback is persisted here. The browser owns those explicit
 // human steps, including consent. Reports below prove only current nonempty fixture prerequisites.
 const governance:{userId:string;modules:{module:AgentModuleCode;state:'complete';nativeEvidence:'present'}[]}[]=[];
 for(const actor of [operator,...reviewers]){
  const view=await withTenant(actor.ctx,tx=>specialistReviewWorkspaceTx(tx,actor.ctx));requireFact(view,'actual group-admin specialist governance authority required');
  const modules:{module:AgentModuleCode;state:'complete';nativeEvidence:'present'}[]=[];
  for(const module of AGENT_MODULE_CODES){
   const report=await withAssistantRead(actor.ctx,module,read=>executeSpecialistHoldout({kind:'canonical_specialist_v1',module,playbook:'canonical_domain_v1'},read));
   requireFact(report.state==='complete'&&report.nativeEvidence==='present'&&report.qualityFailures===0&&report.securityFailures===0&&report.cases.every(item=>item.passed),'nonempty canonical specialist prerequisite failed for '+module);
   modules.push({module,state:'complete',nativeEvidence:'present'});
  }
  governance.push({userId:actor.userId,modules});
 }
 return {
  attendance:{workflow,subjects:attendance},lifecycle,
  prehire:{userId:prehireLogin.id,personId:prehirePerson.id,employmentId:null,ctx:prehireCtx,caseId:prehireCase.id,number:prehireCase.number},
  testing:{standalone:{userId:testerLogin.id,personId:null,employmentId:null,ctx:testerCtx},assignments:testingAssignments,humanObservationRecorded:false as const},
  explorer:{operatorUserId:operator.userId,visibleTables:explorerData.tables.rows.length,withheldTables:explorerData.withheldTables,standaloneEmployeeDenied:true as const},
  governance:{authorUserId:operator.userId,independentEvaluatorUserIds:reviewers.map(actor=>actor.userId),prerequisites:governance,candidatesCreated:false as const,promotionsCreated:false as const},
  notifications:{noticeId:notice.id,inAppNotificationIds:notificationIds,verifiedIdentity:'unavailable_requires_real_provider_session' as const,route:'/assistant/notifications' as const,reason:'Positive consent requires currentProviderSession emailVerified/issuer/subject/email and the actual app_external_identity binding; this fixture creates none.'},
  // Roster/clocking setup can mark the pre-existing current processed batch for recalculation.
  // The financial owner must run its canonical generation/closability check AFTER this function.
  financialFollowup:{regenerateCurrentProcessedRunAfterPlatform:true as const,period},
 };
}
