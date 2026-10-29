/** ADR-0151 §7 "Parity", review R16 (WP8) — the generic per-entry role matrix, driven by the agent action
 * registry through test/helpers/agent-action-parity-matrix.ts.
 *
 * For every probed registry entry and every matrix role, in a fresh fictional world (tenant with two
 * companies, plus a foreign tenant), this runs:
 *   - SCREEN: the owning screen's own admission (the page/route guard the server action calls, when it has
 *     one) and then the owning service itself under the role's own session, inside a transaction that is
 *     always rolled back. No second permission model: the outcome is whatever the native code decides.
 *   - AGENT offer: the Assistant's choices read for that action lists this specific item.
 *   - AGENT prepare: the registry entry's store prepares a review of the same item.
 *   - AGENT confirm: the role confirms ITS OWN review (which runs the native service again); 'deny' when it
 *     has none.
 *   - CROSS-USER CONFIRM (refused roles only): a permitted role prepares a review, and this role must not be
 *     able to confirm it. The reference review must exist, or the test fails.
 * It requires the observed screen outcome to equal the declared one, every agent phase to equal the screen
 * (or to be refused where the matrix declares the agent narrower), and never an agent allow where the screen
 * refuses. Further sections: rejected decisions, the attendance delegate under a routed workflow,
 * revalidation after a permission is removed between prepare and confirm, and positive controls that let
 * the cross-company and cross-tenant sessions act in their OWN company or tenant.
 * Real migrated database and real services; fictional fixtures only. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine,endReportingLine} from '../core/org';
import {createCompany,createDepartment} from '../core/admin';
import {setCompensation} from '../core/comp';
import {setRestDay} from '../core/roster';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {createMovementEventTx} from '../core/movement';
import {isAdmin} from '../lib/authz-model';
import {createClaimType,setClaimPolicy,submitClaim,decideClaimTx,cancelClaimTx} from '../packs/claims/service';
import {prepareClaimCancellationReview,confirmClaimCancellationReview,readClaimCancellationChoices} from '../core/assistant-actions/claim-cancellation-review-store';
import {OWN_CLAIM_CANCELLATION_ACTION} from '../lib/assistant-actions/own-claim-cancellation-contract';
import {requestAttendanceCorrection,requestAttendanceCorrectionTx,decideAttendanceCorrection,saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../packs/attendance/service';
import {overtimeRequestReviews,readOvertimeRequestChoices} from '../core/assistant-actions/overtime-request-review-store';
import {OWN_OVERTIME_REQUEST_ACTION} from '../lib/assistant-actions/own-overtime-request-contract';
import {myEmployment} from '../core/read';
import {resolveEntitlementsTx} from '../core/entitlements';
import {setToilPolicy,submitReplacementLeaveRequest,decideReplacementLeaveRequestTx,applyLeaveAdjustmentBatchTx,grantLeaveCreditRowsTx,requestLeave,cancelOwnLeaveTx,editLeaveRequestTx} from '../packs/leave/service';
import {claimDecisionReviews,attendanceDecisionReviews,toilDecisionReviews,readClaimDecisionChoices,readAttendanceDecisionChoices,readToilDecisionChoices} from '../core/assistant-actions/assigned-decision-review-store';
import {leaveCancellationReviews,leaveEditReviews,readLeaveChangeChoices} from '../core/assistant-actions/leave-change-review-store';
import {leaveAdjustmentReviews,movementTransferReviews,leaveCreditReviews,readLeaveAdjustmentChoices,readMovementTransferChoices,readLeaveCreditChoices} from '../core/assistant-actions/hr-prepared-review-store';
import {ASSIGNED_CLAIM_DECISION_ACTION,ASSIGNED_ATTENDANCE_DECISION_ACTION,ASSIGNED_TOIL_DECISION_ACTION} from '../lib/assistant-actions/assigned-decision-contract';
import {OWN_LEAVE_CANCELLATION_ACTION,OWN_LEAVE_EDIT_ACTION} from '../lib/assistant-actions/own-leave-change-contract';
import {HR_LEAVE_ADJUSTMENT_ACTION,HR_MOVEMENT_TRANSFER_ACTION,HR_LEAVE_CREDIT_ACTION} from '../lib/assistant-actions/hr-prepared-contract';
import {AGENT_ACTIONS} from '../lib/ai/agent-action-registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import {AGENT_ACTION_PARITY,ATTENDANCE_WORKFLOW_PARITY,ALWAYS_REFUSED,PARITY_PHASES,PARITY_ROLES,PROBED_ACTION_IDS,expectedAgentOutcome,type ParityPhase,type ParityOutcome,type ParityRole,type ProbedActionId} from './helpers/agent-action-parity-matrix';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Person={employmentId:string;personId:string};
type DbRole=(typeof schema.roleEnum.enumValues)[number];
type Decision='approved'|'rejected';
/** Per-probe options: the decision a decider records, and whether the subject's company routes overtime
 * through a one-level direct-manager attendance workflow (the configuration delegate access exists for). */
type Options={decision:Decision;workflow:boolean};
const DEFAULT_OPTIONS:Options={decision:'approved',workflow:false};
/** Who the item belongs to: the default fictional subject, or a positive-control subject in another company or tenant. */
type Home={person:Person;base:Base;companyId:string;departmentId:string;name:string;session():Promise<SessionContext>};
type Item={subjectId:string;employmentId:string;leaveTypeId:string;name:string;transferTo:string;date?:string;dates?:string[]};
type Review={actionId:string;reviewedDigest:string};
/** The store surface the harness uses; each concrete store is structurally assignable to it. */
type Store={
 prepare(ctx:SessionContext,input:unknown):Promise<{review:Review}>;
 confirm(ctx:SessionContext,input:Review):Promise<{kind:string}>;
};
type World={
 b:Base;foreign:Base;companyB:string;deptOther:string;subject:Person;people:Record<ParityRole,Person>;group:SessionContext;
 /** The subject's administrative line to the manager (ended by the revalidation probe). */
 managerLineId:string;
 home:Home;
 /** One login per role, created on first use (role assignment + Assistant grant + resolved entitlements). */
 as(role:ParityRole):Promise<SessionContext>;
 /** A fresh login with the given role for a person (no memo). */
 login(base:Base,person:Person,role:DbRole,companyId:string|null):Promise<{ctx:SessionContext;userId:string}>;
 claimTypes:Map<string,string>;
};
type Family='assigned_decision'|'hr_on_employment'|'own';
type Adapter={
 family:Family;store:Store;
 /** The page/route admission the screen's server action calls before its service (e.g. requireAdmin → isAdmin). */
 screenAdmits?:(who:SessionContext,item:Item)=>boolean|Promise<boolean>;
 /** The item one confirmation targets, belonging to the home subject. */
 create(w:World,h:Home,o:Options):Promise<Item>;
 human(item:Item,o:Options):Record<string,unknown>;
 /** True when the Assistant's choices for this action list THIS item (not merely the employee). */
 offered(who:SessionContext,item:Item):Promise<boolean>;
 /** The owning service's write for this role, as the screen calls it (rolled back by the harness). */
 screen(tx:Tx,who:SessionContext,item:Item,actorEmploymentId:string|null,o:Options):Promise<unknown>;
};

const MODULES=['assistant','claims','attendance','toil'];
const SUBJECT_NAME='Fictional Parity Subject';
/** HR calendar days from the repository's HR date owner. */
function calendarDate(offset:number){const value=new Date(todayInKualaLumpur()+'T12:00:00Z');value.setUTCDate(value.getUTCDate()+offset);return value.toISOString().slice(0,10);}
const hiredOn=()=>`${Number(todayInKualaLumpur().slice(0,4))-2}-01-01`;
/** Taken after the modules are on: the fixture admin's synthetic entitlement snapshot is a point-in-time read. */
const groupOf=(base:Base):SessionContext=>({...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]});
const hire=(base:Base,name:string,companyId:string,departmentId:string):Promise<Person>=>hireEmployee(groupOf(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId,departmentId,employmentType:'full_time',hiredOn:hiredOn()});
async function sessionFor(base:Base,userId:string,personId:string,role:DbRole,companyId:string|null):Promise<SessionContext>{
 const entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,base.tenantId));
 return {tenantId:base.tenantId,userId,personId,roles:[role],grants:[{role,companyId}],entitlements};
}
async function login(base:Base,person:Person,role:DbRole,companyId:string|null){
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:`user_${randomUUID()}`,personId:person.personId}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId,role});
 await grantAssistant(groupOf(base),{appUserId:user.id});
 return {ctx:await sessionFor(base,user.id,person.personId,role,companyId),userId:user.id};
}

async function buildWorld():Promise<World>{
 const b=await seedBase();for(const code of MODULES)await setModule(b.tenantId,code,'active');
 const group=groupOf(b);
 const other=await createCompany(group,{legalName:'Fictional other employer',country:'MY',currency:'MYR'} as never);
 const otherDept=await createDepartment(group,{companyId:other.id,name:'Fictional other department'} as never) as {id:string};
 // Only the subject sits in department A.
 const subject=await hire(b,SUBJECT_NAME,b.companyId,b.deptA);
 const at=(name:string)=>hire(b,name,b.companyId,b.deptB);
 const manager=await at('Fictional Parity Line Manager'),approver=await at('Fictional Parity Delegate'),approverReport=await at('Fictional Parity Delegate Report');
 const companyHr=await at('Fictional Parity Company HR'),groupHr=await at('Fictional Parity Group HR'),payroll=await at('Fictional Parity Payroll Partner');
 const perfComp=await at('Fictional Parity Performance Comp Partner'),perf=await at('Fictional Parity Performance Partner');
 const otherCompanyHr=await hire(b,'Fictional Parity Other-Company HR',other.id,otherDept.id);
 const managerLine=await setReportingLine(group,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:hiredOn()});
 // The delegate is a same-level manager (one report of their own) holding the line manager's whole-scope cover.
 await setReportingLine(group,{subordinateEmploymentId:approverReport.employmentId,managerEmploymentId:approver.employmentId,lineType:'administrative',validFrom:hiredOn()});
 await setReportingLine(group,{subordinateEmploymentId:manager.employmentId,managerEmploymentId:approver.employmentId,lineType:'delegate',validFrom:todayInKualaLumpur(),validTo:calendarDate(30),reason:'Fictional approval cover'});
 await setCompensation(group,{employmentId:subject.employmentId,basicSalary:8000,monthlyAllowance:0,effectiveFrom:hiredOn()});
 await setToilPolicy(group,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true});
 const foreign=await seedBase();for(const code of MODULES)await setModule(foreign.tenantId,code,'active');
 const foreignHr=await hire(foreign,'Fictional Parity Foreign HR',foreign.companyId,foreign.deptB);
 const people:Record<ParityRole,Person>={employee:subject,manager,assigned_approver:approver,company_hr:companyHr,group_hr:groupHr,payroll_partner:payroll,
  performance_comp_partner:perfComp,performance_partner:perf,another_company:otherCompanyHr,another_tenant:foreignHr};
 const grantOf:Record<ParityRole,[Base,DbRole,string|null]>={employee:[b,'employee',null],manager:[b,'manager',null],assigned_approver:[b,'employee',null],
  company_hr:[b,'hr_admin',b.companyId],group_hr:[b,'hr_admin',null],payroll_partner:[b,'payroll_partner',b.companyId],
  performance_comp_partner:[b,'performance_comp_partner',b.companyId],performance_partner:[b,'performance_partner',b.companyId],
  another_company:[b,'hr_admin',other.id],another_tenant:[foreign,'hr_admin',null]};
 const sessions=new Map<ParityRole,Promise<SessionContext>>();
 const as=(role:ParityRole)=>{let s=sessions.get(role);if(!s){const [base,dbRole,companyId]=grantOf[role];s=login(base,people[role],dbRole,companyId).then(r=>r.ctx);sessions.set(role,s);}return s;};
 const home:Home={person:subject,base:b,companyId:b.companyId,departmentId:b.deptA,name:SUBJECT_NAME,session:()=>as('employee')};
 return {b,foreign,companyB:other.id,deptOther:otherDept.id,subject,people,group,managerLineId:managerLine.reportingLineId,home,as,login,claimTypes:new Map()};
}

/** Exact-item matchers: each adapter names the list and key that identify ITS item. */
const listed=(found:unknown,list:string,key:string,value:string)=>{const c=found as {kind?:string}&Record<string,unknown>;const rows=c?.[list];return c?.kind==='choices'&&Array.isArray(rows)&&rows.some(row=>(row as Record<string,unknown>)[key]===value);};
/** /me screens (resolveMe) act only on the caller's own employment, resolved by core/read myEmployment. */
const ownEmploymentScreen=async(who:SessionContext,item:Item)=>(await myEmployment(who))?.employmentId===item.employmentId;
const itemOf=(h:Home,subjectId:string,extra:Partial<Item>={}):Item=>({subjectId,employmentId:h.person.employmentId,leaveTypeId:h.base.annualLeaveTypeId,name:h.name,transferTo:h.base.deptB,...extra});
/** One pending claim the home subject submitted on their own claims screen path. */
async function pendingClaim(w:World,h:Home):Promise<Item>{
 const group=groupOf(h.base);let typeId=w.claimTypes.get(h.base.tenantId);
 if(!typeId){typeId=(await createClaimType(group,{code:'FIC-PARITY',name:'Fictional parity travel',defaultTaxable:false,requiresReceipt:false})).id;w.claimTypes.set(h.base.tenantId,typeId);
  await setClaimPolicy(group,{claimTypeId:typeId,annualBudget:1000,perClaimCap:1000,effectiveFrom:todayInKualaLumpur()});}
 const claim=await submitClaim(await h.session(),{employmentId:h.person.employmentId,claimTypeId:typeId,amount:42.5,incurredOn:todayInKualaLumpur(),description:'Fictional taxi fare'});
 return itemOf(h,claim.id);
}
/** The next n weekdays after today (HR date owner). */
function weekdays(n:number){const out:string[]=[],next=new Date(todayInKualaLumpur()+'T00:00:00Z');while(out.length<n){next.setUTCDate(next.getUTCDate()+1);if(![0,6].includes(next.getUTCDay()))out.push(next.toISOString().slice(0,10));}return out;}
/** One plain pending full-day leave request of the home subject's, applied on their own leave screen path. */
async function pendingLeave(_w:World,h:Home):Promise<Item>{
 await owner.db.insert(schema.leaveLedger).values({tenantId:h.base.tenantId,employmentId:h.person.employmentId,leaveTypeId:h.base.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 const dates=weekdays(4),done=await requestLeave(await h.session(),{employmentId:h.person.employmentId,leaveTypeId:h.base.annualLeaveTypeId,startDate:dates[0],endDate:dates[0],durationType:'full_day',reason:'Fictional family visit'});
 return itemOf(h,done.leaveRequestId,{dates});
}
const REJECT_REASON='Fictional explicit rejection reason';

const ADAPTERS:Record<ProbedActionId,Adapter>={
 'approvals.claim.decide':{family:'assigned_decision',store:claimDecisionReviews,
  create:pendingClaim,
  // The claim decision contract carries no note; the approvals screen requires a reason to reject.
  human:(item,o)=>({action:ASSIGNED_CLAIM_DECISION_ACTION,contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,decision:o.decision}),
  offered:async(who,item)=>listed(await readClaimDecisionChoices(who),'items','subjectId',item.subjectId),
  screen:(tx,who,item,decider,o)=>decideClaimTx(tx,who,{claimRequestId:item.subjectId,decision:o.decision==='approved'?'approve':'reject',deciderEmploymentId:decider,rejectReason:o.decision==='rejected'?REJECT_REASON:null})},
 'approvals.attendance.decide':{family:'assigned_decision',store:attendanceDecisionReviews,
  // A future planned overtime request (deferred approval: no attendance day is needed or written).
  async create(w,h,o){
   // Activation resolves the direct manager's live login, so it must exist before the workflow is saved.
   if(o.workflow){await w.as('manager');const group=groupOf(h.base);
    await saveAttendanceWorkflow(group,{companyId:h.companyId,code:'FIC_PARITY_OT',name:'Fictional parity overtime',description:'Fictional one-level route',applicationType:'self_overtime',priority:100,criteria:{departmentIds:[h.departmentId]},
     stages:[{name:'Manager review',level:{kind:'direct_manager',employmentId:null,alternates:[]}}],active:true});
    await setAttendanceWorkflowEnabled(group,h.companyId,'self_overtime',true);}
   const done=await requestAttendanceCorrection(await h.session(),{employmentId:h.person.employmentId,date:calendarDate(7),plannedStartTime:'18:00',plannedEndTime:'19:00',requestedOtMinutes:60,reason:'Fictional planned release work',requestKind:'self_overtime'});
   return itemOf(h,done.correctionId);},
  human:(item,o)=>({action:ASSIGNED_ATTENDANCE_DECISION_ACTION,contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,decision:o.decision,...(o.decision==='rejected'?{note:REJECT_REASON}:{})}),
  offered:async(who,item)=>listed(await readAttendanceDecisionChoices(who),'items','subjectId',item.subjectId),
  // approveCorrectionAction posts the rendered workflow stage for a routed request.
  screen:(tx,who,item,_d,o)=>decideAttendanceCorrection(who,{correctionId:item.subjectId,decision:o.decision,...(o.decision==='rejected'?{rejectReason:REJECT_REASON}:{}),...(o.workflow?{expectedStageIndex:0}:{})},tx)},
 'approvals.toil.decide':{family:'assigned_decision',store:toilDecisionReviews,
  async create(_w,h){const date=calendarDate(-3);await setRestDay(groupOf(h.base),{employmentId:h.person.employmentId,shiftDate:date});
   const done=await submitReplacementLeaveRequest(await h.session(),{employmentId:h.person.employmentId,unit:'day',lines:[{workedDate:date,days:1}],reason:'Fictional rest-day release support',today:todayInKualaLumpur()});
   return itemOf(h,done.requestId);},
  human:(item,o)=>({action:ASSIGNED_TOIL_DECISION_ACTION,contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,decision:o.decision,note:'Fictional approver note'}),
  offered:async(who,item)=>listed(await readToilDecisionChoices(who),'items','subjectId',item.subjectId),
  screen:(tx,who,item,_d,o)=>decideReplacementLeaveRequestTx(tx,who,{requestId:item.subjectId,decision:o.decision,note:'Fictional approver note'})},
 // Own leave screen: cancelOwnLeaveAction / editLeaveAction call the service with the session (no page admission).
 'leave.cancel':{family:'own',store:leaveCancellationReviews,
  create:pendingLeave,
  human:item=>({action:OWN_LEAVE_CANCELLATION_ACTION,contractVersion:1,employmentId:item.employmentId,leaveRequestId:item.subjectId,cancel:true}),
  offered:async(who,item)=>listed(await readLeaveChangeChoices(who),'requests','leaveRequestId',item.subjectId),
  screen:(tx,who,item)=>cancelOwnLeaveTx(tx,who,{leaveRequestId:item.subjectId})},
 'leave.edit':{family:'own',store:leaveEditReviews,
  create:pendingLeave,
  human:item=>({action:OWN_LEAVE_EDIT_ACTION,contractVersion:1,employmentId:item.employmentId,leaveRequestId:item.subjectId,startDate:item.dates![1],endDate:item.dates![2]}),
  offered:async(who,item)=>listed(await readLeaveChangeChoices(who),'requests','leaveRequestId',item.subjectId),
  screen:(tx,who,item)=>editLeaveRequestTx(tx,who,{leaveRequestId:item.subjectId,leaveTypeId:item.leaveTypeId,startDate:item.dates![1],endDate:item.dates![2],durationType:'full_day',today:todayInKualaLumpur()})},
 // Claims page: cancelClaimAction calls cancelClaim(session, id, employmentId-if-posted) with no page admission.
 'claims.cancel':{family:'own',
  store:{prepare:prepareClaimCancellationReview,confirm:(who,r)=>confirmClaimCancellationReview(who,{action:OWN_CLAIM_CANCELLATION_ACTION,contractVersion:1,...r})},
  create:pendingClaim,
  human:item=>({action:OWN_CLAIM_CANCELLATION_ACTION,contractVersion:1,employmentId:item.employmentId,claimId:item.subjectId,cancel:true}),
  offered:async(who,item)=>listed(await readClaimCancellationChoices(who),'claims','claimId',item.subjectId),
  screen:(tx,who,item)=>cancelClaimTx(tx,who,item.subjectId)},
 // /me overtime screen: myRequestOvertime resolves the caller's own employment, then requestAttendanceCorrection.
 'attendance.overtime.request':{family:'own',store:overtimeRequestReviews,screenAdmits:ownEmploymentScreen,
  create:async(_w,h)=>itemOf(h,h.person.employmentId,{date:calendarDate(7)}),
  human:item=>({action:OWN_OVERTIME_REQUEST_ACTION,contractVersion:1,employmentId:item.employmentId,date:item.date,plannedStartTime:'18:00',plannedEndTime:'20:00',reason:'Fictional release preparation',remark:'Fictional optional note'}),
  // Its subject is the employment itself: the choices list the employments the caller may request for.
  offered:async(who,item)=>listed(await readOvertimeRequestChoices(who),'employments','employmentId',item.employmentId),
  screen:(tx,who,item)=>requestAttendanceCorrectionTx(tx,who,{employmentId:item.employmentId,date:item.date!,requestedOtMinutes:120,reason:'Fictional release preparation',remark:'Fictional optional note',plannedStartTime:'18:00',plannedEndTime:'20:00'})},
 // HR screens: the server actions call requireAdmin() (isAdmin) before the service. The subject IS the employment.
 'leave.adjustment.apply':{family:'hr_on_employment',store:leaveAdjustmentReviews,screenAdmits:isAdmin,
  create:async(_w,h)=>itemOf(h,h.person.employmentId),
  human:item=>({action:HR_LEAVE_ADJUSTMENT_ACTION,contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,leaveTypeId:item.leaveTypeId,direction:'add',days:'1.5',effectiveOn:todayInKualaLumpur(),reason:'Fictional correction of a missed carry-forward'}),
  offered:async(who,item)=>listed(await readLeaveAdjustmentChoices(who,{query:item.name}),'employees','employmentId',item.employmentId),
  screen:(tx,who,item)=>applyLeaveAdjustmentBatchTx(tx,who,{targetMode:'individual',employmentIds:[item.employmentId],leaveTypeIds:[item.leaveTypeId],days:1.5,effectiveOn:todayInKualaLumpur(),reason:'Fictional correction of a missed carry-forward'})},
 'employees.movement.transfer':{family:'hr_on_employment',store:movementTransferReviews,screenAdmits:isAdmin,
  create:async(_w,h)=>itemOf(h,h.person.employmentId),
  human:item=>({action:HR_MOVEMENT_TRANSFER_ACTION,contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,kind:'transfer',effectiveDate:todayInKualaLumpur(),departmentId:item.transferTo,positionId:null,businessUnitId:null,locationId:null,remarks:'Fictional team change'}),
  offered:async(who,item)=>listed(await readMovementTransferChoices(who,{query:item.name}),'employees','employmentId',item.employmentId),
  screen:(tx,who,item)=>createMovementEventTx(tx,who,{employmentId:item.employmentId,kind:'transfer',effectiveDate:todayInKualaLumpur(),departmentId:item.transferTo})},
 'toil.credit.grant':{family:'hr_on_employment',store:leaveCreditReviews,screenAdmits:isAdmin,
  async create(_w,h){const date=calendarDate(-3);await setRestDay(groupOf(h.base),{employmentId:h.person.employmentId,shiftDate:date});return itemOf(h,h.person.employmentId,{date});},
  human:item=>({action:HR_LEAVE_CREDIT_ACTION,contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,workedDate:item.date,claimStart:'09:00',claimEnd:'17:00',reason:'Fictional weekend stock-take',firstScheduleConsent:false}),
  offered:async(who,item)=>listed(await readLeaveCreditChoices(who,{query:item.name}),'employees','employmentId',item.employmentId),
  screen:(tx,who,item)=>grantLeaveCreditRowsTx(tx,who,{employmentId:item.employmentId,rows:[{workedDate:item.date!,dayType:'rest_day',claimStart:'09:00',claimEnd:'17:00'}],reason:'Fictional weekend stock-take'})},
};

class Rollback extends Error{constructor(){super('parity probe rollback');}}
/** The refusal, with the driver's underlying cause (e.g. an RLS violation behind a 'Failed query'). */
const why=(error:unknown):string=>{if(!(error instanceof Error))return String(error).slice(0,240);const cause=(error as {cause?:unknown}).cause;return `${error.name}: ${error.message.slice(0,160)}`+(cause instanceof Error?` | cause: ${cause.message.slice(0,200)}`:'');};
/** confirm = the role confirms its OWN review ('deny' when it has none). crossUserConfirm = the role tries to
 * confirm a review another permitted role prepared ('n/a' for permitted roles). */
type Observed={screen:ParityOutcome}&Record<(typeof PARITY_PHASES)[number],ParityOutcome>&{crossUserConfirm:ParityOutcome|'n/a'};

async function screenOutcome(adapter:Adapter,who:SessionContext,item:Item,actorEmploymentId:string|null,o:Options,notes:Record<string,string>):Promise<ParityOutcome>{
 if(adapter.screenAdmits&&!(await adapter.screenAdmits(who,item))){notes.screen='refused by the screen admission';return 'deny';}
 try{await withTenant(who,async tx=>{await adapter.screen(tx,who,item,actorEmploymentId,o);throw new Rollback();});}catch(error){if(error instanceof Rollback)return 'allow';notes.screen=why(error);}
 return 'deny';
}
async function tryPrepare(adapter:Adapter,who:SessionContext,item:Item,o:Options,notes:Record<string,string>,key='prepare'):Promise<Review|null>{
 try{return (await adapter.store.prepare(who,adapter.human(item,o))).review;}catch(error){notes[key]=why(error);return null;}
}
async function tryConfirm(adapter:Adapter,who:SessionContext,review:Review,notes:Record<string,string>,key:string):Promise<ParityOutcome>{
 try{const done=await adapter.store.confirm(who,{actionId:review.actionId,reviewedDigest:review.reviewedDigest});if(done.kind==='completed')return 'allow';notes[key]='kind '+done.kind;}catch(error){notes[key]=why(error);}
 return 'deny';
}

/** The roles the matrix permits for this entry, used as the reference preparer for cross-user confirmation. */
async function observe(id:ProbedActionId,role:ParityRole,o:Options=DEFAULT_OPTIONS):Promise<{observed:Observed;notes:Record<string,string>}>{
 const adapter=ADAPTERS[id],declared=AGENT_ACTION_PARITY[id],notes:Record<string,string>={};
 const w=await buildWorld(),item=await adapter.create(w,w.home,o),who=await w.as(role);
 const screen=await screenOutcome(adapter,who,item,w.people[role].employmentId,o,notes);
 let offer:ParityOutcome='deny';
 try{offer=await adapter.offered(who,item)?'allow':'deny';}catch(error){notes.offer=why(error);}
 const own=await tryPrepare(adapter,who,item,o,notes),prepare:ParityOutcome=own?'allow':'deny';
 const confirm:ParityOutcome=own?await tryConfirm(adapter,who,own,notes,'confirm'):'deny';
 let crossUserConfirm:ParityOutcome|'n/a'='n/a';
 if(!own){
  // Any role the agent permits for the default (approved) matrix; the reference review MUST exist.
  const reference=PARITY_ROLES.find(r=>r!==role&&expectedAgentOutcome(declared,r)==='allow');
  if(!reference)throw Error(`${id}: no permitted reference role for the cross-user confirm of ${role}`);
  const theirs=await tryPrepare(adapter,await w.as(reference),item,o,notes,'reference');
  if(!theirs)throw Error(`${id}: reference role ${reference} could not prepare, so the cross-user confirm of ${role} proves nothing: ${notes.reference}`);
  notes.crossUserReference=reference;crossUserConfirm=await tryConfirm(adapter,who,theirs,notes,'crossUserConfirm');
 }
 return {observed:{screen,offer,prepare,confirm,crossUserConfirm},notes};
}
/** The parity invariants every probe must satisfy, whatever is declared: never wider than the screen,
 * never a cross-user confirmation, and cross-company/tenant refused everywhere. */
function assertInvariants(id:string,role:ParityRole,observed:Observed,notes:Record<string,string>,narrowed:boolean|Readonly<Partial<Record<ParityPhase,string>>>){
 const context=`${id} as ${role}: ${JSON.stringify({observed,notes})}`;
 for(const phase of PARITY_PHASES)if(observed.screen==='deny')expect(observed[phase],`${context} — the agent ${phase} is wider than the screen`).toBe('deny');
 for(const phase of PARITY_PHASES)expect(observed[phase],`${context} — agent ${phase} differs from the screen`).toBe((typeof narrowed==='boolean'?narrowed:!!narrowed[phase])?'deny':observed.screen);
 expect(observed.crossUserConfirm,`${context} — confirmed another user's review`).not.toBe('allow');
 if(observed.prepare==='deny')expect(observed.crossUserConfirm,`${context} — a refused role must be probed for cross-user confirmation`).toBe('deny');
 if(ALWAYS_REFUSED.includes(role))expect({screen:observed.screen,offer:observed.offer,prepare:observed.prepare,confirm:observed.confirm},`${context} — cross-company/tenant must be refused everywhere`).toEqual({screen:'deny',offer:'deny',prepare:'deny',confirm:'deny'});
 return context;
}

beforeAll(async()=>{await migrateTestDb();});
afterAll(closeAll);
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-parity-harness-custody-key-1234');await resetDb();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});

describe('WP8 parity harness coverage',()=>{
 it('has exactly one adapter per probed matrix entry, each a registry entry with an agent store',()=>{
  expect(Object.keys(ADAPTERS).sort()).toEqual([...PROBED_ACTION_IDS].sort());
  for(const id of PROBED_ACTION_IDS)expect(AGENT_ACTIONS.find(action=>action.id===id)?.store,id).not.toBe('human_workflow_only');
 });
});

describe.each([...PROBED_ACTION_IDS])('ADR-0151 parity: %s',id=>{
 it.each([...PARITY_ROLES])('%s gets the screen\'s allow/deny on offer, prepare and own confirm, and no cross-user confirm',async role=>{
  const declared=AGENT_ACTION_PARITY[id],{observed,notes}=await observe(id,role);
  console.info(`[parity] ${id} ${role} ${JSON.stringify(observed)} ${JSON.stringify(notes)}`);
  const context=assertInvariants(id,role,observed,notes,expectedAgentOutcome(declared,role)==='deny'&&declared.screen[role]==='allow');
  // The owning screen behaves as declared (independent expected value).
  expect(observed.screen,`${context} — screen differs from the declared matrix`).toBe(declared.screen[role]);
 },180_000);
});

const DECISIONS=PROBED_ACTION_IDS.filter(id=>ADAPTERS[id].family==='assigned_decision');
/** Rejections: the parity invariants hold; the observed screen outcome is recorded in the log, not declared. */
describe.each(DECISIONS)('ADR-0151 parity, rejected decision: %s',id=>{
 it.each([...PARITY_ROLES])('%s gets the screen\'s allow/deny when rejecting',async role=>{
  const {observed,notes}=await observe(id,role,{decision:'rejected',workflow:false});
  console.info(`[parity:rejected] ${id} ${role} ${JSON.stringify(observed)} ${JSON.stringify(notes)}`);
  assertInvariants(id,role,observed,notes,false);
 },180_000);
});

/** The attendance delegate policies (0533/0570/0592) apply to workflow-routed requests; probe the delegate,
 * the manager and HR under a one-level direct-manager workflow, approving and rejecting. */
describe('ADR-0151 parity, attendance under a routed one-level workflow',()=>{
 it.each((['assigned_approver','manager','company_hr','employee'] as const).flatMap(role=>(['approved','rejected'] as const).map(decision=>[role,decision] as const)))('%s %s',async(role,decision)=>{
  const {observed,notes}=await observe('approvals.attendance.decide',role,{decision,workflow:true});
  console.info(`[parity:workflow] approvals.attendance.decide ${role} ${decision} ${JSON.stringify(observed)} ${JSON.stringify(notes)}`);
  const narrowed=role==='assigned_approver'?ATTENDANCE_WORKFLOW_PARITY.narrowed.assigned_approver:false;
  const context=assertInvariants('approvals.attendance.decide (workflow)',role,observed,notes,narrowed);
  expect(observed.screen,`${context} — screen differs from routed declaration`).toBe(ATTENDANCE_WORKFLOW_PARITY.screen[role]);
  if(role==='assigned_approver')expect(notes.confirm,context).toContain('AssignedDecisionUnavailable');
 },180_000);
});

/** Prepare as a permitted role, remove that permission, then confirm must be refused by revalidation. */
describe('ADR-0151 parity: permission removed between prepare and confirm',()=>{
 it('assigned decision: the manager\'s reporting line ends before confirmation',async()=>{
  const w=await buildWorld(),adapter=ADAPTERS['approvals.claim.decide'],item=await adapter.create(w,w.home,DEFAULT_OPTIONS),mgr=await w.as('manager'),notes:Record<string,string>={};
  const review=await tryPrepare(adapter,mgr,item,DEFAULT_OPTIONS,notes);expect(review,JSON.stringify(notes)).not.toBeNull();
  await endReportingLine(w.group,{reportingLineId:w.managerLineId,endDate:todayInKualaLumpur()});
  expect(await screenOutcome(adapter,mgr,item,w.people.manager.employmentId,DEFAULT_OPTIONS,notes),'the screen must refuse the former manager too').toBe('deny');
  expect(await tryConfirm(adapter,mgr,review!,notes,'confirm'),JSON.stringify(notes)).toBe('deny');
  const [claim]=await owner.db.select({status:schema.claimRequest.status}).from(schema.claimRequest).where(eq(schema.claimRequest.id,item.subjectId));expect(claim.status).toBe('pending');
 },180_000);
 it('HR on another employment: the company HR role is withdrawn before confirmation',async()=>{
  const w=await buildWorld(),adapter=ADAPTERS['leave.adjustment.apply'],item=await adapter.create(w,w.home,DEFAULT_OPTIONS),notes:Record<string,string>={};
  const hr=await w.login(w.b,w.people.company_hr,'hr_admin',w.b.companyId);
  const review=await tryPrepare(adapter,hr.ctx,item,DEFAULT_OPTIONS,notes);expect(review,JSON.stringify(notes)).not.toBeNull();
  const ledger=()=>owner.db.select({id:schema.leaveLedger.id}).from(schema.leaveLedger).where(eq(schema.leaveLedger.employmentId,item.employmentId));
  const before=(await ledger()).length;
  // The role assignment row changes; the next request's session is resolved from it (as getSession does).
  await owner.db.update(schema.roleAssignment).set({role:'employee',companyId:null}).where(eq(schema.roleAssignment.appUserId,hr.userId));
  const after=await sessionFor(w.b,hr.userId,w.people.company_hr.personId,'employee',null);
  expect(await screenOutcome(adapter,after,item,w.people.company_hr.employmentId,DEFAULT_OPTIONS,notes),'the screen must refuse the former HR administrator too').toBe('deny');
  expect(await tryConfirm(adapter,after,review!,notes,'confirm'),JSON.stringify(notes)).toBe('deny');
  expect((await ledger()).length,'no adjustment row may be written').toBe(before);
 },180_000);
 it('own action: the Assistant grant is revoked before confirmation',async()=>{
  const w=await buildWorld(),adapter=ADAPTERS['leave.cancel'],item=await adapter.create(w,w.home,DEFAULT_OPTIONS),me=await w.as('employee'),notes:Record<string,string>={};
  const review=await tryPrepare(adapter,me,item,DEFAULT_OPTIONS,notes);expect(review,JSON.stringify(notes)).not.toBeNull();
  await revokeAssistant(w.group,{appUserId:me.userId!});
  expect(await tryConfirm(adapter,me,review!,notes,'confirm'),JSON.stringify(notes)).toBe('deny');
  const [request]=await owner.db.select({status:schema.leaveRequest.status}).from(schema.leaveRequest).where(eq(schema.leaveRequest.id,item.subjectId));expect(request.status).toBe('pending');
 },180_000);
});

/** Positive controls: the cross-company and cross-tenant sessions are refused above only because of the
 * boundary. Here each acts on an item in its OWN company or tenant and must be able to prepare and confirm. */
const CONTROLS:[ProbedActionId,'another_company'|'another_tenant'][]=(['approvals.claim.decide','leave.adjustment.apply','leave.cancel'] as const).flatMap(id=>(['another_company','another_tenant'] as const).map(role=>[id,role] as [ProbedActionId,'another_company'|'another_tenant']));
describe('ADR-0151 parity positive controls: the boundary sessions act inside their own company or tenant',()=>{
 it.each(CONTROLS)('%s as %s on its own side of the boundary',async(id,role)=>{
  const w=await buildWorld(),adapter=ADAPTERS[id],who=await w.as(role),notes:Record<string,string>={};
  const base=role==='another_tenant'?w.foreign:w.b,companyId=role==='another_tenant'?w.foreign.companyId:w.companyB,departmentId=role==='another_tenant'?w.foreign.deptB:w.deptOther;
  let home:Home;
  if(adapter.family==='own')home={person:w.people[role],base,companyId,departmentId,name:'Fictional Parity '+role,session:()=>w.as(role)};
  else{const name='Fictional Parity Home Subject',person=await hire(base,name,companyId,departmentId);const mine=await w.login(base,person,'employee',null);home={person,base,companyId,departmentId,name,session:async()=>mine.ctx};}
  const item=await adapter.create(w,home,DEFAULT_OPTIONS);
  const screen=await screenOutcome(adapter,who,item,w.people[role].employmentId,DEFAULT_OPTIONS,notes);
  const offer=await adapter.offered(who,item),review=await tryPrepare(adapter,who,item,DEFAULT_OPTIONS,notes);
  const confirm=review?await tryConfirm(adapter,who,review,notes,'confirm'):'deny';
  console.info(`[parity:control] ${id} ${role} ${JSON.stringify({screen,offer,prepare:review?'allow':'deny',confirm})} ${JSON.stringify(notes)}`);
  expect({screen,offer,prepare:review?'allow':'deny',confirm},JSON.stringify(notes)).toEqual({screen:'allow',offer:true,prepare:'allow',confirm:'allow'});
 },180_000);
});
