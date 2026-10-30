import {scheduleGroupMaintenanceReviews,readScheduleGroupMaintenanceChoices} from '../../core/assistant-actions/schedule-group-maintenance-review-store';
import {ensureStandardRule} from '../../packs/attendance/service';
import {setEmploymentScheduleGroupTx} from '../../core/roster';
import {profileRequestRejectionReviews,readProfileRequestRejectionChoices} from '../../core/assistant-actions/profile-request-rejection-review-store';
import {decideProfileChange} from '../../core/profile';
import {preparePayrollReopenReview,confirmPayrollReopenReview,readPayrollReopenChoices} from '../../core/assistant-actions/payroll-reopen-review-store';
import {unlockClosedBatch} from '../../packs/payroll/service';
import {departmentArchiveReviews,readDepartmentArchiveChoices} from '../../core/assistant-actions/department-archive-review-store';
import {listDepartmentsForLabels} from '../../core/admin';
import {positionArchiveReviews,readPositionArchiveChoices} from '../../core/assistant-actions/position-archive-review-store';
import {createPosition,bulkSaveLabels,listPositionsForLabels} from '../../core/admin';
import {fixedItemArchiveReviews,readFixedItemArchiveChoices} from '../../core/assistant-actions/fixed-item-archive-review-store';
import {archiveEmploymentPayComponent,setEmploymentPayComponent,seedPayComponentCatalog,listPayComponents} from '../../packs/payroll/service';
import {tp3OpeningMaintenanceReviews,readTp3OpeningMaintenanceChoices} from '../../core/assistant-actions/tp3-opening-maintenance-review-store';
import {costAllocationMaintenanceReviews,readCostAllocationChoices} from '../../core/assistant-actions/cost-allocation-maintenance-review-store';
import {saveEmploymentCostAllocations} from '../../core/employment-cost-allocations';
import {paymentMethodMaintenanceReviews,readPaymentMethodMaintenanceChoices} from '../../core/assistant-actions/payment-method-maintenance-review-store';
import {setEmploymentPaymentMethod} from '../../core/org';
import {passportMaintenanceReviews,readPassportMaintenanceChoices} from '../../core/assistant-actions/passport-maintenance-review-store';
import {employeeCodeMaintenanceReviews,readEmployeeCodeMaintenanceChoices} from '../../core/assistant-actions/employee-code-maintenance-review-store';
import {setWorkforceEmployeeCode} from '../../core/workforce-code';
import {documentMetadataReviews,readDocumentMetadataChoices} from '../../core/assistant-actions/document-metadata-review-store';
import {addEmployeeDocument,updateEmployeeDocumentMeta} from '../../core/employee-documents';
import {workforceViewScope} from '../../core/workforce-access';
import {PARITY_PROBE_GROUPS,type ParityProbeGroup,type ParityProbeVariant} from './agent-action-parity-groups';
import {workforceProfileMaintenanceReviews,readWorkforceProfileMaintenanceChoices} from '../../core/assistant-actions/workforce-profile-maintenance-review-store';
import {maintainWorkforceRecord,workforceEditor} from '../../core/workforce-maintenance';
import {workforceMaintenanceFields} from '../../lib/workforce-maintenance-fields';
import {familyMaintenanceReviews,readFamilyMaintenanceChoices} from '../../core/assistant-actions/family-maintenance-review-store';
import {addDependent} from '../../core/workforce-registers';
import {bankMaintenanceReviews,readBankMaintenanceChoices} from '../../core/assistant-actions/bank-maintenance-review-store';
import {emergencyContactMaintenanceReviews,readEmergencyContactMaintenanceChoices} from '../../core/assistant-actions/emergency-contact-maintenance-review-store';
import {addEmergencyContact} from '../../core/workforce-registers';
/** ADR-0151 §7 "Parity", review R16 (WP8) — the generic per-entry role matrix, driven by the agent action
 * registry through test/helpers/agent-action-parity-matrix.ts.
 *
 * For every probed registry entry and every matrix role, in a fresh fictional world (tenant with two
 * companies, plus a foreign tenant), this runs:
 *   - SCREEN: the owning screen's own admission (the page/route guard the server action calls, when it has
 *     one) and then the owning service itself under the role's own session. Supplied-Tx APIs roll back;
 *     transaction-owning APIs use an equivalent separate fictional world. Native code decides the result.
 *   - AGENT offer: the Assistant's choices read for that action lists this specific item.
 *   - AGENT prepare: the registry entry's store prepares a review of the same item.
 *   - AGENT confirm: the role confirms ITS OWN review (which runs the native service again); 'deny' when it
 *     has none.
 *   - CROSS-USER CONFIRM (every role): a permitted role prepares a review, and this role must not be
 *     able to confirm it. The reference review must exist, or the test fails.
 * It requires the observed screen outcome to equal the declared one, every agent phase to equal the screen
 * (or to be refused where the matrix declares the agent narrower), and never an agent allow where the screen
 * refuses. Further sections: rejected decisions, the attendance delegate under a routed workflow,
 * revalidation after a permission is removed between prepare and confirm, and positive controls that let
 * the cross-company and cross-tenant sessions act in their OWN company or tenant.
 * Real migrated database and real services; fictional fixtures only. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import * as schema from '../../db/schema';
import {hireEmployee,setReportingLine,endReportingLine} from '../../core/org';
import {createCompany,createDepartment,createCostCenter} from '../../core/admin';
import {setCompensation} from '../../core/comp';
import {setRestDay} from '../../core/roster';
import {grantAssistant,revokeAssistant} from '../../core/assistant-grant';
import {createMovementEventTx} from '../../core/movement';
import {isAdmin,canManagePayroll} from '../../lib/authz-model';
import {createClaimType,setClaimPolicy,submitClaim,decideClaimTx,cancelClaimTx} from '../../packs/claims/service';
import {prepareClaimCancellationReview,confirmClaimCancellationReview,readClaimCancellationChoices} from '../../core/assistant-actions/claim-cancellation-review-store';
import {OWN_CLAIM_CANCELLATION_ACTION} from '../../lib/assistant-actions/own-claim-cancellation-contract';
import {requestAttendanceCorrection,requestAttendanceCorrectionTx,decideAttendanceCorrection,saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../../packs/attendance/service';
import {overtimeRequestReviews,readOvertimeRequestChoices} from '../../core/assistant-actions/overtime-request-review-store';
import {OWN_OVERTIME_REQUEST_ACTION} from '../../lib/assistant-actions/own-overtime-request-contract';
import {toilRequestReviews} from '../../core/assistant-actions/toil-request-review-store';
import {readToilRequestModuleActionChoices} from '../../core/assistant-actions/module-action-server';
import {myEmployment,employeeDetail} from '../../core/read';
import {resolveEntitlementsTx} from '../../core/entitlements';
import {setToilPolicy,submitReplacementLeaveRequest,decideReplacementLeaveRequestTx,applyLeaveAdjustmentBatchTx,grantLeaveCreditRowsTx,requestLeave,cancelOwnLeaveTx,editLeaveRequestTx} from '../../packs/leave/service';
import {claimDecisionReviews,attendanceDecisionReviews,toilDecisionReviews,readClaimDecisionChoices,readAttendanceDecisionChoices,readToilDecisionChoices} from '../../core/assistant-actions/assigned-decision-review-store';
import {leaveCancellationReviews,leaveEditReviews,readLeaveChangeChoices} from '../../core/assistant-actions/leave-change-review-store';
import {compensationMaintenanceReviews,readCompensationMaintenanceChoices} from '../../core/assistant-actions/compensation-maintenance-review-store';
import {employeeDraftActivationReviews,readEmployeeDraftActivationChoices} from '../../core/assistant-actions/employee-draft-activation-review-store';
import {createEmployeeDraftWithReservedCode,saveEmployeeDraft,saveAndCompleteEmployeeDraft} from '../../core/employee-draft';
import type {EmployeeDraftData} from '../../lib/employee-draft-schema';
import {qualificationMaintenanceReviews,readQualificationMaintenanceChoices} from '../../core/assistant-actions/qualification-maintenance-review-store';
import {addQualification} from '../../core/workforce-registers';
import {leaveAdjustmentReviews,movementTransferReviews,leaveCreditReviews,readLeaveAdjustmentChoices,readMovementTransferChoices,readLeaveCreditChoices} from '../../core/assistant-actions/hr-prepared-review-store';
import {ASSIGNED_CLAIM_DECISION_ACTION,ASSIGNED_ATTENDANCE_DECISION_ACTION,ASSIGNED_TOIL_DECISION_ACTION} from '../../lib/assistant-actions/assigned-decision-contract';
import {OWN_LEAVE_CANCELLATION_ACTION,OWN_LEAVE_EDIT_ACTION} from '../../lib/assistant-actions/own-leave-change-contract';
import {HR_LEAVE_ADJUSTMENT_ACTION,HR_MOVEMENT_TRANSFER_ACTION,HR_LEAVE_CREDIT_ACTION} from '../../lib/assistant-actions/hr-prepared-contract';
import {AGENT_ACTIONS} from '../../lib/ai/agent-action-registry';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {AGENT_ACTION_PARITY,ATTENDANCE_WORKFLOW_PARITY,ALWAYS_REFUSED,PARITY_PHASES,PARITY_ROLES,PROBED_ACTION_IDS,expectedAgentOutcome,type ParityPhase,type ParityOutcome,type ParityRole,type ProbedActionId} from './agent-action-parity-matrix';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from '../harness';


vi.mock('server-only',()=>({}));
vi.mock('../../lib/real-auth',()=>({appOrigin:()=>undefined}));
vi.mock('../../core/assistant-actions/own-leave-server',()=>({authenticateOwnLeaveBrowserSession:vi.fn(()=>{throw Error('No HTTP authentication in DB parity fixtures');})}));
import {prepareOwnLeaveReviewTx,confirmOwnLeaveReview} from '../../core/assistant-actions/own-leave-store';
import {readOwnLeaveCandidateTx} from '../../core/assistant-actions/own-leave-candidate';
import {prepareProfileModuleActionReview,confirmProfileModuleActionReview,prepareClaimModuleActionReview,confirmClaimModuleActionReview,prepareClaimSubmissionModuleActionReview,confirmClaimSubmissionModuleActionReview} from '../../core/assistant-actions/module-action-review-store';
import {readProfileModuleActionChoices,readClaimModuleActionChoices,readAttendanceCorrectionModuleActionChoices,readKnowledgeModuleActionAvailability,readPayComponentModuleActionChoices,readOrgModuleActionChoices} from '../../core/assistant-actions/module-action-server';
import {prepareAttendanceCorrectionReview,confirmAttendanceCorrectionReview} from '../../core/assistant-actions/attendance-correction-review-store';
import {prepareKnowledgeArticleReview,confirmKnowledgeArticleReview} from '../../core/assistant-actions/knowledge-article-review-store';
import {preparePayComponentReview,confirmPayComponentReview} from '../../core/assistant-actions/pay-component-review-store';
import {prepareOrgActionReview,confirmOrgActionReview} from '../../core/assistant-actions/org-action-review-store';
import {createArticleTx} from '../../core/knowledge-base';
import {createPayComponentTx} from '../../packs/payroll/service';
import {saveProfileEditPolicy} from '../../core/profile-edit-policy';
import {readOwnProfileWorkspace,submitOwnProfileEdit} from '../../core/profile-edit';
import {saveClaimDraft,submitDraftClaims} from '../../packs/claims/service';


const provider=vi.hoisted(()=>({current:vi.fn()}));
vi.mock('../../lib/identity/provider',()=>({currentProviderSession:provider.current}));
import {prepareLeaveDecisionReview,confirmLeaveDecisionReview} from '../../core/assistant-actions/leave-decision-review-store';
import {preparePayrollCloseReview,confirmPayrollCloseReview} from '../../core/assistant-actions/payroll-close-review-store';
import {prepareMultiCycleRunReview,confirmMultiCycleRunReview} from '../../core/assistant-actions/multi-cycle-run-review-store';
import {prepareCountryStatutoryReview,confirmCountryStatutoryReview} from '../../core/assistant-actions/country-statutory-review-store';
import {prepareRewardsPostReview,confirmRewardsPostReview} from '../../core/assistant-actions/rewards-post-review-store';
import {prepareLifecycleAckReview,confirmLifecycleAckReview} from '../../core/assistant-actions/lifecycle-ack-review-store';
import {prepareReviewModuleActionReview,confirmReviewModuleActionReview,prepareOnehrModuleActionReview,confirmOnehrModuleActionReview,prepareTestingModuleActionReview,confirmTestingModuleActionReview,prepareModuleActionReview,confirmModuleActionReview} from '../../core/assistant-actions/module-action-review-store';
import {readAssignedLeaveModuleActionChoices,readPerformanceModuleActionChoices,readTestingModuleActionChoices,readLifecycleAckModuleActionAvailability,readPayrollCloseModuleActionChoices,readRewardsPostModuleActionChoices,readCountryStatutoryModuleActionChoices,readNotificationModuleActionChoices} from '../../core/assistant-actions/module-action-server';
import {readMultiCycleRunModuleActionChoices} from '../../core/assistant-actions/multi-cycle-run-choices';
import {resolveOwnNotificationServerIdentity} from '../../core/assistant-actions/own-notification-preferences-source';
import {saveNotificationEmailPolicy,saveNotificationEmailPreferences} from '../../core/notification-email';
import {decideLeave} from '../../packs/leave/service';
import * as perf from '../../packs/performance/service';
import {defaultPolicy as defaultOnehrPolicy} from '../../packs/performance/onehr/model';
import onehrFramework from '../../packs/performance/onehr/framework.json';
import {createBatch,generatePayslips,closeBatch,createAdditionalRunTx} from '../../packs/payroll/service';
import {upsertPayrollCycle} from '../../core/payroll-cycle';
import {requirePackFor} from '../../localization/registry';
import {createOnboardingCase,tickStep} from '../../packs/lifecycle/service';
import {submitMyAcknowledgement} from '../../core/lifecycle-self';
import {ONBOARDING_STEPS} from '../../core/lifecycle-defaults';
import * as testing from '../../core/system-testing-workspace';
import type {InstructionDefinition} from '../../lib/system-testing/model';
import * as rewards from '../../packs/rewards/service';
import {emptyFacts as emptyRewardFacts} from '../../packs/rewards/model';
import {setRewardMember} from '../rewards-access-fixture';
import {configureRewardFixture,refreshRewardFixtureBudget} from '../rewards-governance-fixture';

type Person={employmentId:string;personId:string};
type DbRole=(typeof schema.roleEnum.enumValues)[number];
type Decision='approved'|'rejected';
/** Per-probe options: the decision a decider records, and whether the subject's company routes overtime
 * through a one-level direct-manager attendance workflow (the configuration delegate access exists for). */
type Options={decision:Decision;workflow:boolean;allocationOperation?:'replace'|'clear'};
const DEFAULT_OPTIONS:Options={decision:'approved',workflow:false};
/** Who the item belongs to: the default fictional subject, or a positive-control subject in another company or tenant. */
type Home={person:Person;base:Base;companyId:string;departmentId:string;name:string;session():Promise<SessionContext>};
type Item={subjectId:string;employmentId:string;leaveTypeId:string;name:string;transferTo:string;date?:string;dates?:string[];managerId?:string;claimTypeId?:string;proposal?:unknown;code?:string;personId?:string;companyId?:string;cycleId?:string;batchId?:string;period?:string;stepId?:string|null;revision?:number;assignmentId?:string;versionId?:string};
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
type Family='assigned_decision'|'hr_on_employment'|'own'|'catalogue';
type Adapter={
 family:Family;store:Store;independentScreen?:boolean;pageAdmits?:(who:SessionContext)=>boolean;
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

const MODULES=['assistant','claims','attendance','toil','payroll','rewards','typed_pay_components','performance','multi_cycle_payroll','country-my','lifecycle','notifications','system_testing'];
const SUBJECT_NAME='Fictional Parity Subject';
/** HR calendar days from the repository's HR date owner. */
function calendarDate(offset:number){const value=new Date(todayInKualaLumpur()+'T12:00:00Z');value.setUTCDate(value.getUTCDate()+offset);return value.toISOString().slice(0,10);}
const hiredOn=()=>`${Number(todayInKualaLumpur().slice(0,4))-2}-01-01`;
/** Taken after the modules are on: the fixture admin's synthetic entitlement snapshot is a point-in-time read. */
const groupOf=(base:Base):SessionContext=>({...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]});
const hire=(base:Base,name:string,companyId:string,departmentId:string):Promise<Person>=>hireEmployee(groupOf(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId,departmentId,employmentType:'full_time',hiredOn:hiredOn()});
async function sessionFor(base:Base,userId:string,personId:string|null,role:DbRole,companyId:string|null):Promise<SessionContext>{
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
 const companyHr=await at('Fictional Parity Company HR'),groupHr=await at('Fictional Parity Group HR'),superAdmin=await at('Fictional Parity Tenant Administrator'),payroll=await at('Fictional Parity Payroll Partner');
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
 const people:Record<ParityRole,Person>={employee:subject,manager,assigned_approver:approver,company_hr:companyHr,group_hr:groupHr,super_admin:superAdmin,payroll_partner:payroll,
  performance_comp_partner:perfComp,performance_partner:perf,another_company:otherCompanyHr,another_tenant:foreignHr};
 const grantOf:Record<ParityRole,[Base,DbRole,string|null]>={employee:[b,'employee',null],manager:[b,'manager',null],assigned_approver:[b,'employee',null],
  company_hr:[b,'hr_admin',b.companyId],group_hr:[b,'hr_admin',null],super_admin:[b,'super_admin',null],payroll_partner:[b,'payroll_partner',b.companyId],
  performance_comp_partner:[b,'performance_comp_partner',b.companyId],performance_partner:[b,'performance_partner',b.companyId],
  another_company:[b,'hr_admin',other.id],another_tenant:[foreign,'hr_admin',null]};
 const sessions=new Map<ParityRole,Promise<SessionContext>>();
 const as=(role:ParityRole)=>{let s=sessions.get(role);if(!s){const [base,dbRole,companyId]=grantOf[role];s=login(base,people[role],dbRole,companyId).then(r=>r.ctx);sessions.set(role,s);}return s;};
 // Delegated effects require the delegator's live calculation identity, independently of the role being probed.
 await as('manager');
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

const packetStore=(action:string,prepare:Store['prepare'],confirm:(ctx:SessionContext,input:unknown)=>Promise<{kind:string}>):Store=>({prepare,confirm:(ctx,p)=>confirm(ctx,{action,contractVersion:1,...p})});
const preferredField='profile.personal_details.preferredname';
const leaveNomination=(item:Item)=>({action:'leave.apply',contractVersion:1,employmentId:item.employmentId,leaveTypeId:item.leaveTypeId,date:item.date,durationType:'full_day'});
const payInput=(item:Item)=>({code:item.code!,name:'Fictional human pay code',label:'Human label',description:'Fictional catalogue declaration',kind:'allowance' as const,includedInEpf:false,includedInSocsoEis:false,includedInPcb:false,includedInHrdfBase:false,isNonPayable:false,prorates:false,eaFormLine:null,roundingMethod:'none' as const,rule:null,epfBonus2012:false,pcbRemunerationType:null,pcbExemptionCode:null,displayCategory:'allowance' as const,orpOvertime:false,orpUnpaidLeave:false});

const previousPeriod=()=>{const [year,month]=todayInKualaLumpur().split('-').map(Number);return new Date(Date.UTC(year,month-2,1)).toISOString().slice(0,7);};
const additionalRunInput=(item:Item)=>({companyId:item.companyId!,payPeriod:item.period!,runType:'bonus' as const,payrollCycleId:item.cycleId!,scope:{employmentIds:[item.employmentId]}});
const equipmentInput={contactNumber:'012-345',serialNumber:'FIC-SERIAL',accessories:'Human-declared mouse',pcType:'Laptop',hasMonitor:false,monitorSerial:null,receiptEmail:null,acknowledged:true};
const testingGuide:InstructionDefinition={format:1,title:'Fictional human observation',objective:'Record a fictional manually observed value',functionKey:'personnel.profile',area:'personnel',moduleCode:'employees',category:'functional',priority:'medium',active:true,prerequisites:[],testData:[],steps:[{id:'observe',action:'Inspect fictional value',expected:'Value retained'}],expectedBehavior:'The observed value can be recorded',expectedFunction:'Personal Testing',permissions:['Only assigned tester records observations'],jurisdiction:null,configuration:null,screenKeys:['personnelAdmin']};
const testingObservation=(item:Item)=>({executionId:item.subjectId,assignmentId:item.assignmentId!,versionId:item.versionId!,expectedRevision:item.revision!,status:'in_progress' as const,actualResult:'Fictional value inspected by a human',comments:'Human comment',defectNotes:'',improvementNotes:''});
async function notificationIdentity(who:SessionContext){
 const [person]=await owner.db.select({email:schema.person.primaryEmail}).from(schema.person).where(eq(schema.person.id,who.personId!));
 const identity={issuer:'https://fictional.parity.test',subject:who.userId!,email:person.email!,emailVerified:true};
 await owner.db.insert(schema.appExternalIdentity).values({issuer:identity.issuer,subject:identity.subject,appUserId:who.userId!}).onConflictDoNothing();provider.current.mockResolvedValue(identity);return identity;
}
const ADAPTERS:Record<ProbedActionId,Adapter>={
 'org.position.archive':{family:'catalogue',store:packetStore('org.position.archive',positionArchiveReviews.prepare,positionArchiveReviews.confirm),
  screenAdmits:async(who,item)=>isAdmin(who)&&(await listPositionsForLabels(who)).some(p=>p.id===item.subjectId&&!p.inUse),
  create:async(_w,h)=>{const title='FIC_POSITION_'+randomUUID().slice(0,8),p=await createPosition(groupOf(h.base),{companyId:h.companyId,title});return itemOf(h,p.id,{code:title});},
  human:item=>({action:'org.position.archive',contractVersion:1,positionId:item.subjectId,expectedArchived:false,archived:true}),
  offered:async(who,item)=>{const choices=await readPositionArchiveChoices(who,{query:item.code});return choices.kind==='choices'&&choices.positions.some(p=>p.positionId===item.subjectId);},
  screen:(tx,who,item)=>bulkSaveLabels(who,'position',{creates:[],updates:[{key:item.subjectId,id:item.subjectId,title:item.code,jobFamily:'',label:'',description:'',archived:true}]},tx)},
 'org.department.archive':{family:'catalogue',store:packetStore('org.department.archive',departmentArchiveReviews.prepare,departmentArchiveReviews.confirm),
  screenAdmits:async(who,item)=>isAdmin(who)&&(await listDepartmentsForLabels(who)).some(p=>p.id===item.subjectId&&!p.inUse),
  create:async(_w,h)=>{const name='FIC_DEPARTMENT_'+randomUUID().slice(0,8),p=await createDepartment(groupOf(h.base),{companyId:h.companyId,name});return itemOf(h,p.id,{code:name});},
  human:item=>({action:'org.department.archive',contractVersion:1,departmentId:item.subjectId,expectedArchived:false,archived:true}),
  offered:async(who,item)=>{const choices=await readDepartmentArchiveChoices(who,{query:item.code});return choices.kind==='choices'&&choices.departments.some(p=>p.departmentId===item.subjectId);},
  screen:(tx,who,item)=>bulkSaveLabels(who,'department',{creates:[],updates:[{key:item.subjectId,id:item.subjectId,name:item.code,businessUnitId:null,headEmploymentId:null,label:'',description:'',archived:true}]},tx)},
 'approvals.leave.decide':{family:'assigned_decision',store:packetStore('approvals.leave.decide',prepareLeaveDecisionReview,confirmLeaveDecisionReview),
  async create(w,h){const item=await pendingLeave(w,h);const steps=await owner.db.select().from(schema.leaveApprovalStep).where(eq(schema.leaveApprovalStep.leaveRequestId,item.subjectId)).orderBy(schema.leaveApprovalStep.stepIndex);return {...item,stepId:steps.find(row=>row.status==='pending')?.id??null};},
  human:(item,o)=>({action:'approvals.leave.decide',contractVersion:1,leaveRequestId:item.subjectId,currentStepId:item.stepId??null,decision:o.decision,rejectReason:o.decision==='rejected'?REJECT_REASON:null,confirmAssignedDecision:true}),
  offered:async(who,item)=>listed(await readAssignedLeaveModuleActionChoices(who),'tasks','leaveRequestId',item.subjectId),screen:(tx,who,item,_actor,o)=>decideLeave(who,{leaveRequestId:item.subjectId,decision:o.decision,...(o.decision==='rejected'?{rejectReason:REJECT_REASON}:{})},tx)},
 'performance.review.acknowledge':{family:'own',screenAdmits:ownEmploymentScreen,store:packetStore('performance.review.acknowledge',prepareReviewModuleActionReview,confirmReviewModuleActionReview),
  async create(w,h){const year=Number(todayInKualaLumpur().slice(0,4)),group=groupOf(h.base),{cycleId}=await perf.createCycle(group,{name:'Fictional Standard Review',companyId:h.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`,assessmentWorkflow:false});await perf.openCycle(group,{cycleId});const [review]=await owner.db.select({id:schema.performanceReview.id}).from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,cycleId),eq(schema.performanceReview.employmentId,h.person.employmentId)));await perf.submitSelfReview(await h.session(),{reviewId:review.id,selfRating:4});await perf.submitManagerReview(await w.as('manager'),{reviewId:review.id,managerRating:4,overallRating:4});await perf.releaseCycle(group,{cycleId});return itemOf(h,review.id);},
  human:item=>({action:'performance.review.acknowledge',contractVersion:1,intent:{version:1,reviewId:item.subjectId,acknowledge:true}}),offered:async(who,item)=>listed(await readPerformanceModuleActionChoices(who),'items','sourceId',item.subjectId),screen:(tx,who,item)=>perf.acknowledgeReviewTx(tx,who,{reviewId:item.subjectId})},
 'performance.onehr.plan.acknowledge':{family:'own',screenAdmits:ownEmploymentScreen,store:packetStore('performance.onehr.plan.acknowledge',prepareOnehrModuleActionReview,confirmOnehrModuleActionReview),
  async create(w,h){const year=Number(todayInKualaLumpur().slice(0,4)),group=groupOf(h.base),[grade]=await owner.db.insert(schema.jobGrade).values({tenantId:h.base.tenantId,code:'12',name:'Fictional Grade12'}).returning({id:schema.jobGrade.id});await owner.db.update(schema.employment).set({gradeId:grade.id}).where(eq(schema.employment.companyId,h.companyId));const {cycleId}=await perf.createCycle(group,{name:'Fictional OneHR Review',companyId:h.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});await perf.configureOnehrCycle(group,cycleId,null,defaultOnehrPolicy(onehrFramework));await perf.openCycle(group,{cycleId});const [review]=await owner.db.select({id:schema.performanceReview.id}).from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,cycleId),eq(schema.performanceReview.employmentId,h.person.employmentId)));await perf.saveOnehrPlan(await h.session(),review.id,null,{career:{aspiration:'Fictional workshop practice',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[{id:randomUUID(),area:'Fictional facilitation',dueOn:'',onJob:'Human fixture workshop',fromOthers:'',formalLearning:'',status:'not_started'}]},true);let [plan]=await owner.db.select().from(schema.onehrPlan).where(and(eq(schema.onehrPlan.employmentId,h.person.employmentId),eq(schema.onehrPlan.planYear,year+1)));await perf.reviewOnehrPlan(await w.as('manager'),plan.id,plan.revision,'Agreed','Fictional career conversation',true,undefined,todayInKualaLumpur());[plan]=await owner.db.select().from(schema.onehrPlan).where(eq(schema.onehrPlan.id,plan.id));return itemOf(h,plan.id,{revision:plan.revision});},
  human:item=>({action:'performance.onehr.plan.acknowledge',contractVersion:1,intent:{version:1,planId:item.subjectId,acknowledge:true}}),offered:async(who,item)=>listed(await readPerformanceModuleActionChoices(who),'items','sourceId',item.subjectId),screen:(tx,who,item)=>perf.acknowledgeOnehrPlanTx(tx,who,item.subjectId,item.revision!)},
 'payroll.reopen':{family:'hr_on_employment',pageAdmits:canManagePayroll,independentScreen:true,store:packetStore('payroll.reopen',preparePayrollReopenReview,confirmPayrollReopenReview),
  async create(_w,h){const group=groupOf(h.base),period=previousPeriod();await requirePackFor('MY').statutory.set(group,{personId:h.person.personId,icNumber:'900101019885'});const {batchId}=await createBatch(group,{companyId:h.companyId,payPeriod:period,scope:{employmentIds:[h.person.employmentId]}});await generatePayslips(group,{batchId});await closeBatch(group,{batchId});await setSetting(h.base.tenantId,'payroll.unlock_enabled',true);return itemOf(h,batchId);},human:item=>({action:'payroll.reopen',contractVersion:1,batchId:item.subjectId,reason:'Fictional payroll reopen parity reason',confirmReopenClosedRun:true,acknowledgeRecordedDownstreamWarnings:true}),offered:async(who,item)=>listed(await readPayrollReopenChoices(who),'batches','batchId',item.subjectId),screen:(_tx,who,item)=>unlockClosedBatch(who,{batchId:item.subjectId,reason:'Fictional payroll reopen parity reason'})},
 'payroll.close':{family:'hr_on_employment',pageAdmits:isAdmin,independentScreen:true,store:packetStore('payroll.close',preparePayrollCloseReview,confirmPayrollCloseReview),
  async create(_w,h){const group=groupOf(h.base),period=previousPeriod();await requirePackFor('MY').statutory.set(group,{personId:h.person.personId,icNumber:'900101019885'});const {batchId}=await createBatch(group,{companyId:h.companyId,payPeriod:period,scope:{employmentIds:[h.person.employmentId]}});await generatePayslips(group,{batchId});return itemOf(h,batchId);},human:item=>({action:'payroll.close',contractVersion:1,batchId:item.subjectId,confirmCloseProcessedRun:true}),offered:async(who,item)=>listed(await readPayrollCloseModuleActionChoices(who),'batches','batchId',item.subjectId),screen:(_tx,who,item)=>closeBatch(who,{batchId:item.subjectId})},
 'multi_cycle_payroll.create_run':{family:'hr_on_employment',pageAdmits:isAdmin,store:packetStore('multi_cycle_payroll.create_run',prepareMultiCycleRunReview,confirmMultiCycleRunReview),
  async create(_w,h){const cycle=await upsertPayrollCycle(groupOf(h.base),{companyId:h.companyId,name:'Fictional Bonus Cycle',code:'FIC-BONUS',runType:'bonus'});return itemOf(h,h.person.employmentId,{companyId:h.companyId,cycleId:cycle.id,period:previousPeriod()});},human:item=>({action:'multi_cycle_payroll.create_run',contractVersion:1,input:additionalRunInput(item),confirmDraftCreation:true}),offered:async(who,item)=>listed(await readMultiCycleRunModuleActionChoices(who),'companies','companyId',item.companyId!),screen:(tx,who,item)=>createAdditionalRunTx(tx,who,additionalRunInput(item))},
 'country-my.statutory.update':{family:'hr_on_employment',screenAdmits:isAdmin,independentScreen:true,store:packetStore('country-my.statutory.update',prepareCountryStatutoryReview,confirmCountryStatutoryReview),
  async create(_w,h){await requirePackFor('MY').statutory.set(groupOf(h.base),{personId:h.person.personId,icNumber:'900101019885',epfNumber:'FIC-OLD'});return itemOf(h,h.person.employmentId,{personId:h.person.personId});},human:item=>({action:'country-my.statutory.update',contractVersion:1,employmentId:item.employmentId,confirmSharedPersonWrite:true,input:{personId:item.personId,epfNumber:'FIC-NEW',socsoNumber:'FIC-SOCSO',epfMode:'auto'}}),offered:async(who,item)=>listed(await readCountryStatutoryModuleActionChoices(who),'items','employmentId',item.employmentId),screen:async(_tx,who,item)=>{const pack=requirePackFor('MY');if(!pack.statutory.withWrite)throw Error('Missing native statutory write interval');return pack.statutory.withWrite(who,item.personId!,async(tx,current)=>{if(!current)throw Error('Missing native statutory profile');return pack.statutory.set(who,{personId:item.personId!,icNumber:current.icNumber,epfNumber:'FIC-NEW',socsoNumber:'FIC-SOCSO',epfMode:'auto'},tx);});}},
 'lifecycle.acknowledgement.submit':{family:'own',independentScreen:true,store:packetStore('lifecycle.acknowledgement.submit',prepareLifecycleAckReview,confirmLifecycleAckReview),
  async create(_w,h){const [person]=await owner.db.select({email:schema.person.primaryEmail}).from(schema.person).where(eq(schema.person.id,h.person.personId));const root=groupOf(h.base),c=await createOnboardingCase(root,{companyId:h.companyId,fullName:'Fictional equipment recipient',employeeNo:'F-'+randomUUID().slice(0,8),joinDate:todayInKualaLumpur(),laptopRequired:true,carparkRequired:false,newhireEmail:person.email!,personId:h.person.personId,employmentId:h.person.employmentId});for(const step of ONBOARDING_STEPS.filter(row=>row.phase===0&&row.rule!=='carpark'))await tickStep(root,'onboarding',c.number,step.key);await tickStep(root,'onboarding',c.number,'laptop_dist');return itemOf(h,c.id);},human:item=>({action:'lifecycle.acknowledgement.submit',contractVersion:1,caseId:item.subjectId,...equipmentInput}),offered:async(who,item)=>{const value=await readLifecycleAckModuleActionAvailability(who);return value.kind==='available'&&value.currentCase.caseId===item.subjectId;},screen:(_tx,who)=>submitMyAcknowledgement(who,equipmentInput)},
 'system_testing.execution.save':{family:'own',store:packetStore('system_testing.execution.save',prepareTestingModuleActionReview,confirmTestingModuleActionReview),
  async create(_w,h){const root=groupOf(h.base),who=await h.session(),draft=await testing.saveTestInstructionDraft(root,{caseId:null,expectedRevision:0,definition:testingGuide}),version=await testing.publishTestInstruction(root,{caseId:draft.caseId,expectedDraftRevision:draft.revision,expectedVersionId:null}),assignment=await testing.assignTestingCase(root,{caseId:draft.caseId,testerUserId:who.userId!,expectedVersionId:version.versionId,active:true,expectedRevision:null}),execution=await testing.beginTestingExecution(who,{assignmentId:assignment.assignmentId,expectedVersionId:version.versionId,newAttempt:false});return itemOf(h,execution.executionId,{assignmentId:assignment.assignmentId,versionId:version.versionId,revision:execution.revision});},human:item=>({action:'system_testing.execution.save',contractVersion:1,intent:{version:1,humanObserved:true,observation:testingObservation(item)}}),offered:async(who,item)=>listed(await readTestingModuleActionChoices(who),'items','executionId',item.subjectId),screen:(tx,who,item)=>testing.saveTestingExecutionTx(tx,who,testingObservation(item))},
 'notifications.email_preferences.save':{family:'own',independentScreen:true,
  store:{prepare:async(who,input)=>{await notificationIdentity(who);return prepareModuleActionReview(who,input,await resolveOwnNotificationServerIdentity());},confirm:async(who,p)=>{await notificationIdentity(who);return confirmModuleActionReview(who,{action:'notifications.email_preferences.save',contractVersion:1,...p},await resolveOwnNotificationServerIdentity());}},
  async create(_w,h){await saveNotificationEmailPolicy(groupOf(h.base),['leave','claims']);return itemOf(h,h.person.employmentId);},human:item=>({action:'notifications.email_preferences.save',contractVersion:1,intent:{version:1,employmentId:item.employmentId,enabledCategories:['leave'],locale:'en',consent:'selected_categories_only'}}),offered:async(who,item)=>listed(await readNotificationModuleActionChoices(who),'employments','employmentId',item.employmentId),screen:async(_tx,who,item)=>saveNotificationEmailPreferences(who,item.employmentId,['leave'],'en',await notificationIdentity(who))},
 'rewards.post':{family:'hr_on_employment',independentScreen:true,store:packetStore('rewards.post',prepareRewardsPostReview,confirmRewardsPostReview),
  async create(w,h){const root=groupOf(h.base),year=Number(todayInKualaLumpur().slice(0,4)),[bu]=await owner.db.insert(schema.businessUnit).values({tenantId:h.base.tenantId,companyId:h.companyId,code:'FIC-BU',name:'Fictional Unit'}).returning(),[grade]=await owner.db.insert(schema.jobGrade).values({tenantId:h.base.tenantId,code:'12',name:'Fictional Grade12'}).returning();await owner.db.update(schema.assignment).set({businessUnitId:bu.id}).where(eq(schema.assignment.employmentId,h.person.employmentId));await owner.db.update(schema.employment).set({gradeId:grade.id,confirmationDate:hiredOn()}).where(eq(schema.employment.id,h.person.employmentId));const unitId=await rewards.createRewardUnit(root,{name:'Fictional approved Rewards',year,companyId:h.companyId,businessUnitId:bu.id,snapshotDate:todayInKualaLumpur()});const actors:Record<string,SessionContext>={gr:root,bu:await h.session()};for(const seat of ['bg','ctro','ec'] as const){const person=await hire(h.base,'Fictional '+seat+' reviewer',h.companyId,h.base.deptB);actors[seat]=(await w.login(h.base,person,'employee',null)).ctx;}for(const seat of ['bu','bg','ctro','ec'] as const)await setRewardMember(root,unitId,(await rewards.getRewardUnit(root,unitId)).unit.revision,actors[seat].userId!,seat);for(const role of ['company_hr','group_hr','super_admin','payroll_partner'] as const)await setRewardMember(root,unitId,(await rewards.getRewardUnit(root,unitId)).unit.revision,(await w.as(role)).userId!,'payroll');let view=await rewards.getRewardUnit(root,unitId);await configureRewardFixture(root,unitId,view.unit.revision,{...view.unit.policy,effectiveFrom:todayInKualaLumpur(),patActual:100,patTarget:100,ranges:{'12':[300000,500000,700000]}});view=await rewards.getRewardUnit(root,unitId);await rewards.saveRewardEntry(root,unitId,view.unit.revision,view.rows[0].id,view.rows[0].recommendation,{...emptyRewardFacts(),reviewed:true,talent:'SCORE',performance:'ME'});await refreshRewardFixtureBudget(root,unitId);view=await rewards.getRewardUnit(root,unitId);await rewards.decideRewardUnit(actors.bu,unitId,view.unit.revision,'submit','Fictional human recommendation');for(const role of view.route.slice(1))await rewards.decideRewardUnit(actors[role],unitId,view.unit.revision,'approve','Fictional human recommendation');const {batchId}=await createBatch(root,{companyId:h.companyId,payPeriod:todayInKualaLumpur().slice(0,7),scope:{employmentIds:[h.person.employmentId]}});return itemOf(h,unitId,{batchId,revision:view.unit.revision});},human:item=>({action:'rewards.post',contractVersion:1,unitId:item.subjectId,revision:item.revision,batchId:item.batchId,confirmWholeApprovedUnit:true}),offered:async(who,item)=>listed(await readRewardsPostModuleActionChoices(who),'units','unitId',item.subjectId),screen:(_tx,who,item)=>rewards.postRewardUnit(who,item.subjectId,item.revision!,item.batchId)},
 'leave.apply':{family:'own',screenAdmits:ownEmploymentScreen,
  store:{prepare:async(who,input)=>{const h=input as ReturnType<typeof leaveNomination>;const r=await withTenant(who,tx=>prepareOwnLeaveReviewTx(tx,who,h,{employmentId:h.employmentId,leaveTypeId:h.leaveTypeId},{reason:'Fictional parity leave reason'},'en'));if(r.kind!=='prepared')throw Error('No native leave candidate');return r;},confirm:(who,p)=>confirmOwnLeaveReview(who,{contractVersion:1,...p},'en')},
  async create(_w,h){await owner.db.insert(schema.leaveLedger).values({tenantId:h.base.tenantId,employmentId:h.person.employmentId,leaveTypeId:h.base.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});return itemOf(h,h.person.employmentId,{date:weekdays(1)[0]});},human:leaveNomination,
  offered:async(who,item)=>(await withTenant(who,tx=>readOwnLeaveCandidateTx(tx,who,leaveNomination(item),{employmentId:item.employmentId,leaveTypeId:item.leaveTypeId},{reason:'Fictional parity leave reason'},'en'))).kind==='candidate',
  screen:(tx,who,item)=>requestLeave(who,{employmentId:item.employmentId,leaveTypeId:item.leaveTypeId,startDate:item.date!,endDate:item.date!,durationType:'full_day',reason:'Fictional parity leave reason'},tx)},
 'ess.profile.request':{family:'own',screenAdmits:ownEmploymentScreen,store:packetStore('ess.profile.request',prepareProfileModuleActionReview,confirmProfileModuleActionReview),
  async create(_w,h){await saveProfileEditPolicy(groupOf(h.base),{keys:[preferredField],withdrawnReason:'Fictional parity policy'});const workspace=await readOwnProfileWorkspace(await h.session(),{employmentId:h.person.employmentId});return itemOf(h,h.person.employmentId,{proposal:{v:2,fields:[{fieldId:preferredField,before:workspace.baselines[preferredField],value:'Fictional preferred name'}],registers:[]}});},
  human:item=>({action:'ess.profile.request',contractVersion:1,employmentId:item.employmentId,proposal:item.proposal}),offered:async(who,item)=>listed(await readProfileModuleActionChoices(who),'employments','employmentId',item.employmentId),
  screen:(tx,who,item)=>submitOwnProfileEdit(who,{employmentId:item.employmentId,proposal:item.proposal},tx)},
 'attendance.correction.request':{family:'own',screenAdmits:ownEmploymentScreen,store:packetStore('attendance.correction.request',prepareAttendanceCorrectionReview,confirmAttendanceCorrectionReview),
  create:async(_w,h)=>itemOf(h,h.person.employmentId,{date:calendarDate(7)}),human:item=>({action:'attendance.correction.request',contractVersion:1,intent:{version:1,employmentId:item.employmentId,date:item.date,reason:'Fictional planned correction',requestedOtMinutes:60,plannedStartTime:'18:00',plannedEndTime:'19:00',requestKind:'self_overtime'}}),
  offered:async(who,item)=>listed(await readAttendanceCorrectionModuleActionChoices(who),'employments','employmentId',item.employmentId),screen:(tx,who,item)=>requestAttendanceCorrectionTx(tx,who,{employmentId:item.employmentId,date:item.date!,reason:'Fictional planned correction',requestedOtMinutes:60,plannedStartTime:'18:00',plannedEndTime:'19:00',requestKind:'self_overtime'})},
 'claims.draft.save':{family:'own',screenAdmits:ownEmploymentScreen,store:packetStore('claims.draft.save',prepareClaimModuleActionReview,confirmClaimModuleActionReview),
  async create(w,h){const pending=await pendingClaim(w,h);return {...itemOf(h,h.person.employmentId),claimTypeId:w.claimTypes.get(h.base.tenantId)!};},
  human:item=>({action:'claims.draft.save',contractVersion:1,employmentId:item.employmentId,draftId:null,claimTypeId:item.claimTypeId,claimItemId:null,enteredAmount:42.5,quantityKm:null,incurredOn:todayInKualaLumpur(),description:'Fictional draft receipt',fieldValues:null,retainedAttachmentIds:[]}),
  offered:async(who,item)=>listed(await readClaimModuleActionChoices(who),'employments','employmentId',item.employmentId),screen:(tx,who,item)=>saveClaimDraft(who,{employmentId:item.employmentId,claimTypeId:item.claimTypeId!,amount:42.5,incurredOn:todayInKualaLumpur(),description:'Fictional draft receipt'},null,tx)},
 'claims.submit':{family:'own',screenAdmits:ownEmploymentScreen,store:packetStore('claims.submit',prepareClaimSubmissionModuleActionReview,confirmClaimSubmissionModuleActionReview),
  async create(w,h){await pendingClaim(w,h);const claimTypeId=w.claimTypes.get(h.base.tenantId)!;const draft=await saveClaimDraft(await h.session(),{employmentId:h.person.employmentId,claimTypeId,amount:42.5,incurredOn:todayInKualaLumpur(),description:'Fictional draft submission'});return itemOf(h,draft.id,{claimTypeId});},
  human:item=>({action:'claims.submit',contractVersion:1,employmentId:item.employmentId,draftId:item.subjectId,receiptIds:[],submitForApproval:true}),offered:async(who,item)=>listed(await readClaimModuleActionChoices(who),'drafts','id',item.subjectId),screen:(tx,who,item)=>submitDraftClaims(who,{ids:[item.subjectId],employmentId:item.employmentId},tx)},
 'knowledge_base.article.create':{family:'hr_on_employment',screenAdmits:isAdmin,store:packetStore('knowledge_base.article.create',prepareKnowledgeArticleReview,confirmKnowledgeArticleReview),create:async(_w,h)=>itemOf(h,h.person.employmentId),
  human:()=>({action:'knowledge_base.article.create',contractVersion:1,title:'Fictional human publication',body:'Fictional human article body',category:'Training',audience:'employee'}),offered:async who=>(await readKnowledgeModuleActionAvailability(who)).kind==='available',screen:(tx,who)=>createArticleTx(tx,who,{title:'Fictional human publication',body:'Fictional human article body',category:'Training',audience:'employee'})},
 'typed_pay_components.create':{family:'hr_on_employment',screenAdmits:isAdmin,store:packetStore('typed_pay_components.create',preparePayComponentReview,confirmPayComponentReview),create:async(_w,h)=>itemOf(h,h.person.employmentId,{code:'FIC_'+randomUUID().slice(0,8).toUpperCase()}),
  human:item=>({action:'typed_pay_components.create',contractVersion:1,input:payInput(item),confirmCatalogCreate:true}),offered:async who=>(await readPayComponentModuleActionChoices(who)).kind==='choices',screen:(tx,who,item)=>createPayComponentTx(tx,who,payInput(item))},
 'org.reporting.change':{family:'hr_on_employment',screenAdmits:isAdmin,store:packetStore('org.reporting.change',prepareOrgActionReview,confirmOrgActionReview),create:async(w,h)=>itemOf(h,h.person.employmentId,{managerId:w.people.group_hr.employmentId}),
  human:item=>({action:'org.reporting.change',contractVersion:1,subordinateEmploymentId:item.employmentId,managerEmploymentId:item.managerId,lineType:'functional',validFrom:todayInKualaLumpur(),confirmReportingChange:true}),
  offered:async(who,item)=>{const result=await readOrgModuleActionChoices(who,{role:'subordinate',query:item.name});return result.items.some(row=>row.employmentId===item.employmentId);},screen:(tx,who,item)=>setReportingLine(who,{subordinateEmploymentId:item.employmentId,managerEmploymentId:item.managerId!,lineType:'functional',validFrom:todayInKualaLumpur()},tx)},

 'approvals.claim.decide':{family:'assigned_decision',store:claimDecisionReviews,
  create:pendingClaim,
  // New claim rejections bind the same explicit human reason used by the native screen.
  human:(item,o)=>({action:ASSIGNED_CLAIM_DECISION_ACTION,contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,decision:o.decision,...(o.decision==='rejected'?{note:REJECT_REASON}:{})}),
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
 // Claims page: cancelClaimAction always resolves the caller's own employment before cancellation.
 'claims.cancel':{family:'own',screenAdmits:ownEmploymentScreen,
  store:{prepare:prepareClaimCancellationReview,confirm:(who,r)=>confirmClaimCancellationReview(who,{action:OWN_CLAIM_CANCELLATION_ACTION,contractVersion:1,...r})},
  create:pendingClaim,
  human:item=>({action:OWN_CLAIM_CANCELLATION_ACTION,contractVersion:1,employmentId:item.employmentId,claimId:item.subjectId,cancel:true}),
  offered:async(who,item)=>listed(await readClaimCancellationChoices(who),'claims','claimId',item.subjectId),
  screen:(tx,who,item)=>cancelClaimTx(tx,who,item.subjectId,item.employmentId)},
 // /me overtime screen: myRequestOvertime resolves the caller's own employment, then requestAttendanceCorrection.
 'toil.replacement.request':{family:'own',screenAdmits:ownEmploymentScreen,
  store:{prepare:toilRequestReviews.prepare,confirm:toilRequestReviews.confirm},
  async create(_w,h){const date=calendarDate(-3);await setRestDay(groupOf(h.base),{employmentId:h.person.employmentId,shiftDate:date});return itemOf(h,h.person.employmentId,{date});},
  human:item=>({action:'toil.replacement.request',contractVersion:1,engine:'replacement_native',employmentId:item.employmentId,unit:'day',lines:[{workedDate:item.date,days:1}],reason:'Fictional human-declared worked rest day',firstScheduleConsent:false}),
  offered:async(who,item)=>listed(await readToilRequestModuleActionChoices(who),'employments','employmentId',item.employmentId),
  screen:(tx,who,item)=>submitReplacementLeaveRequest(who,{employmentId:item.employmentId,unit:'day',lines:[{workedDate:item.date!,days:1}],reason:'Fictional human-declared worked rest day',firstScheduleConsent:false,today:todayInKualaLumpur()},tx)},
 'attendance.overtime.request':{family:'own',store:overtimeRequestReviews,screenAdmits:ownEmploymentScreen,
  create:async(_w,h)=>itemOf(h,h.person.employmentId,{date:calendarDate(7)}),
  human:item=>({action:OWN_OVERTIME_REQUEST_ACTION,contractVersion:1,employmentId:item.employmentId,date:item.date,plannedStartTime:'18:00',plannedEndTime:'20:00',reason:'Fictional release preparation',remark:'Fictional optional note'}),
  // Its subject is the employment itself: the choices list the employments the caller may request for.
  offered:async(who,item)=>listed(await readOvertimeRequestChoices(who),'employments','employmentId',item.employmentId),
  screen:(tx,who,item)=>requestAttendanceCorrectionTx(tx,who,{employmentId:item.employmentId,date:item.date!,requestedOtMinutes:120,reason:'Fictional release preparation',remark:'Fictional optional note',plannedStartTime:'18:00',plannedEndTime:'20:00'})},
 // HR screens call requireAdmin() before the native service. Some registers target the employment;
 // shared-person registers keep that profile binding while targeting its true person owner.
 'leave.adjustment.apply':{family:'hr_on_employment',store:leaveAdjustmentReviews,screenAdmits:isAdmin,
  create:async(_w,h)=>itemOf(h,h.person.employmentId),
  human:item=>({action:HR_LEAVE_ADJUSTMENT_ACTION,contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,leaveTypeId:item.leaveTypeId,direction:'add',days:'1.5',effectiveOn:todayInKualaLumpur(),reason:'Fictional correction of a missed carry-forward'}),
  offered:async(who,item)=>listed(await readLeaveAdjustmentChoices(who,{query:item.name}),'employees','employmentId',item.employmentId),
  screen:(tx,who,item)=>applyLeaveAdjustmentBatchTx(tx,who,{targetMode:'individual',employmentIds:[item.employmentId],leaveTypeIds:[item.leaveTypeId],days:1.5,effectiveOn:todayInKualaLumpur(),reason:'Fictional correction of a missed carry-forward'})},
 'employees.compensation.maintain':{family:'hr_on_employment',store:compensationMaintenanceReviews,screenAdmits:isAdmin,
  create:async(_w,h)=>itemOf(h,h.person.employmentId),
  human:item=>({action:'employees.compensation.maintain',contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,operation:'set',compensationId:null,fields:{basicSalary:'2500.25',currency:'MYR',payMode:'monthly',paymentTerm:'monthly',rateAmount:null,remarks:'Fictional human salary',effectiveFrom:todayInKualaLumpur()}}),
  offered:async(who,item)=>listed(await readCompensationMaintenanceChoices(who,{query:item.name}),'employees','employmentId',item.employmentId),
  screen:(tx,who,item)=>setCompensation(who,{employmentId:item.employmentId,basicSalary:2500.25,currency:'MYR',payMode:'monthly',paymentTerm:'monthly',rateAmount:null,remarks:'Fictional human salary',effectiveFrom:todayInKualaLumpur()},tx)},
 'employees.cost_allocation.maintain':{family:'hr_on_employment',store:packetStore('employees.cost_allocation.maintain',costAllocationMaintenanceReviews.prepare,costAllocationMaintenanceReviews.confirm),
  create:async(_w,h,o)=>{const center=await createCostCenter(groupOf(h.base),{companyId:h.companyId,code:'PARITY-COST',name:'Fictional cost distribution'});const operation=o.allocationOperation??'replace',date=todayInKualaLumpur();if(operation==='clear')await saveEmploymentCostAllocations(groupOf(h.base),{employmentId:h.person.employmentId,effectiveDate:date,expectedRevision:0,operation:'replace',rows:[{costCenterId:center.id,percentage:'25.00'}]});return itemOf(h,h.person.employmentId,{proposal:{effectiveDate:date,effectiveCompanyId:h.companyId,expectedRevision:operation==='clear'?1:0,operation,rows:operation==='clear'?[]:[{costCenterId:center.id,percentage:'33.33'}]}});},
  human:item=>({action:'employees.cost_allocation.maintain',contractVersion:1,employmentId:item.employmentId,subjectId:item.employmentId,...(item.proposal as object)}),
  offered:async(who,item)=>{const proposal=item.proposal as {effectiveDate:string};const result=await readCostAllocationChoices(who,{query:item.name,employmentId:item.employmentId,effectiveDate:proposal.effectiveDate});return result.kind==='choices'&&result.current!==null&&listed(result,'employees','employmentId',item.employmentId);},
  screen:(tx,who,item)=>{const {effectiveCompanyId:_nomination,...input}=item.proposal as {effectiveCompanyId:string;effectiveDate:string;expectedRevision:number;operation:'replace'|'clear';rows:{costCenterId:string;percentage:string}[]};return saveEmploymentCostAllocations(who,{employmentId:item.employmentId,...input},{existingTx:tx,source:'manual'});}},
 'employees.payment_method.maintain':{family:'hr_on_employment',store:paymentMethodMaintenanceReviews,screenAdmits:isAdmin,
  create:async(_w,h)=>itemOf(h,h.person.employmentId),
  human:item=>({action:'employees.payment_method.maintain',contractVersion:1,employmentId:item.employmentId,subjectId:item.employmentId,expectedMethod:null,paymentMethod:'cash'}),
  offered:async(who,item)=>listed(await readPaymentMethodMaintenanceChoices(who,{query:item.name}),'employees','employmentId',item.employmentId),
  screen:(tx,who,item)=>setEmploymentPaymentMethod(who,{employmentId:item.employmentId,paymentMethod:'cash'},tx)},
 'attendance.schedule_group.maintain':{family:'hr_on_employment',screenAdmits:isAdmin,store:scheduleGroupMaintenanceReviews,
  create:async(_w,h)=>{const rule=await ensureStandardRule(groupOf(h.base));await owner.db.update(schema.employment).set({attendanceRuleId:rule.id}).where(and(eq(schema.employment.id,h.person.employmentId),eq(schema.employment.tenantId,h.base.tenantId)));return itemOf(h,h.person.employmentId,{proposal:{expectedGroupId:rule.id,attendanceRuleId:null}});},
  human:item=>({action:'attendance.schedule_group.maintain',contractVersion:1,employmentId:item.employmentId,subjectId:item.employmentId,...(item.proposal as {expectedGroupId:string;attendanceRuleId:null})}),
  offered:async(who,item)=>listed(await readScheduleGroupMaintenanceChoices(who,{query:item.name}),'employees','employmentId',item.employmentId),
  screen:(tx,who,item)=>setEmploymentScheduleGroupTx(tx,who,{employmentId:item.employmentId,attendanceRuleId:null})},
 'employees.profile_request.reject':{family:'hr_on_employment',store:profileRequestRejectionReviews,screenAdmits:isAdmin,
  create:async(_w,h)=>{const [request]=await owner.db.insert(schema.profileChangeRequest).values({tenantId:h.base.tenantId,employmentId:h.person.employmentId,personId:h.person.personId,proposed:{preferredName:'Fictional requested name'}}).returning({id:schema.profileChangeRequest.id});return itemOf(h,request.id);},
  human:item=>({action:'employees.profile_request.reject',contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,reason:'Please check the submitted request.'}),
  offered:async(who,item)=>listed(await readProfileRequestRejectionChoices(who,{query:item.name,subjectId:item.subjectId}),'requests','subjectId',item.subjectId),
  screen:(tx,who,item)=>decideProfileChange(who,{requestId:item.subjectId,decision:'rejected',reason:'Please check the submitted request.'},tx)},
 'employees.code.maintain':{family:'hr_on_employment',store:employeeCodeMaintenanceReviews,
  // Baseline construction is an owner fixture read, before per-role Assistant authority is exercised.
  create:async(_w,h)=>{const [selected]=await owner.db.select({employeeCode:schema.employment.employeeCode}).from(schema.employment).where(and(eq(schema.employment.id,h.person.employmentId),eq(schema.employment.tenantId,h.base.tenantId)));if(!selected)throw Error('Missing native code fixture');return itemOf(h,h.person.employmentId,{proposal:{expectedCode:selected.employeeCode,employeeCode:'FIC-'+randomUUID().slice(0,8).toUpperCase()}});},
  human:item=>({action:'employees.code.maintain',contractVersion:1,employmentId:item.employmentId,subjectId:item.employmentId,...(item.proposal as {expectedCode:string|null;employeeCode:string})}),
  offered:async(who,item)=>listed(await readEmployeeCodeMaintenanceChoices(who,{query:item.name}),'employees','employmentId',item.employmentId),
  screen:(tx,who,item)=>setWorkforceEmployeeCode(who,{employmentId:item.employmentId,...(item.proposal as {expectedCode:string|null;employeeCode:string})},tx)},
 'employees.workforce_profile.maintain':{family:'hr_on_employment',store:workforceProfileMaintenanceReviews,
  create:async(_w,h)=>{const workspace=await workforceEditor(groupOf(h.base),h.person.employmentId);if(!workspace)throw Error('Native profile fixture unavailable');const values=Object.fromEntries(workforceMaintenanceFields('person','personal').map(({key})=>[key,workspace.profile[key as keyof typeof workspace.profile]]));values.preferredName='Fictional reviewed name';return itemOf(h,h.person.employmentId,{proposal:{expectedVersion:workspace.profileVersion,values}});},
  human:item=>({action:'employees.workforce_profile.maintain',contractVersion:1,employmentId:item.employmentId,subjectId:item.employmentId,section:'personal',...(item.proposal as {expectedVersion:string;values:Record<string,string|null>})}),
  offered:async(who,item)=>listed(await readWorkforceProfileMaintenanceChoices(who,{query:item.name}),'employees','employmentId',item.employmentId),
  screen:(tx,who,item)=>maintainWorkforceRecord(who,{employmentId:item.employmentId,kind:'person',rowId:null,operation:'update',patch:(item.proposal as {values:Record<string,string|null>}).values,expectedVersion:(item.proposal as {expectedVersion:string}).expectedVersion},tx)},
 'employees.tp3_opening.maintain':{family:'hr_on_employment',store:tp3OpeningMaintenanceReviews,screenAdmits:isAdmin,
  create:async(_w,h)=>{const pack=requirePackFor('MY');await pack.statutory.set(groupOf(h.base),{personId:h.person.personId,icNumber:null});await pack.statutory.setTp3(groupOf(h.base),{personId:h.person.personId,tp3Year:2026,tp3NetRemuneration:1000,tp3EpfClaimed:100,tp3PcbPaid:10});return itemOf(h,h.person.personId);},
  human:item=>({action:'employees.tp3_opening.maintain',contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,fields:{tp3Year:2026,tp3NetRemuneration:2000.25,tp3EpfClaimed:200.25,tp3PcbPaid:20.25}}),
  offered:async(who,item)=>listed(await readTp3OpeningMaintenanceChoices(who,{query:item.name}),'employees','employmentId',item.employmentId),
  screen:(tx,who,item)=>requirePackFor('MY').statutory.setTp3(who,{personId:item.subjectId,tp3Year:2026,tp3NetRemuneration:2000.25,tp3EpfClaimed:200.25,tp3PcbPaid:20.25},tx)},
 'employees.passport.maintain':{family:'hr_on_employment',store:passportMaintenanceReviews,screenAdmits:async(who,item)=>isAdmin(who)&&(await workforceViewScope(who)).canOpen&&!!await employeeDetail(who,item.employmentId,'workforce'),
  create:async(_w,h)=>{await requirePackFor('MY').statutory.set(groupOf(h.base),{personId:h.person.personId,icNumber:null});return itemOf(h,h.person.personId);},
  human:item=>({action:'employees.passport.maintain',contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,fields:{passportNumber:'FICTIONAL',passportIssueDate:'2020-01-01',passportExpiryDate:'2030-01-01',passportRemark:null,passportIssuingCountry:null,passportIssuingCountryCode:null}}),
  offered:async(who,item)=>listed(await readPassportMaintenanceChoices(who,{query:item.name}),'employees','employmentId',item.employmentId),
  screen:(tx,who,item)=>requirePackFor('MY').statutory.setPassport(who,{personId:item.subjectId,employmentId:item.employmentId,passportNumber:'FICTIONAL',passportIssueDate:'2020-01-01',passportExpiryDate:'2030-01-01',passportRemark:null,passportIssuingCountry:null,passportIssuingCountryCode:null},tx)},
 'employees.bank.maintain':{family:'hr_on_employment',store:bankMaintenanceReviews,screenAdmits:async(who,item)=>isAdmin(who)&&(await workforceViewScope(who)).canOpen&&!!await employeeDetail(who,item.employmentId,'workforce'),
  create:async(_w,h)=>{await requirePackFor('MY').statutory.set(groupOf(h.base),{personId:h.person.personId,icNumber:null});return itemOf(h,h.person.personId);},
  human:item=>({action:'employees.bank.maintain',contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,fields:{bankName:'Fictional bank',bankAccountNo:'000-FICTIONAL',enableCustomHolderName:false,customHolderName:null,enableCustomHolderId:false,customHolderId:null}}),
  offered:async(who,item)=>listed(await readBankMaintenanceChoices(who,{query:item.name}),'employees','employmentId',item.employmentId),
  screen:(tx,who,item)=>requirePackFor('MY').statutory.setBank(who,{personId:item.subjectId,employmentId:item.employmentId,bankName:'Fictional bank',bankAccountNo:'000-FICTIONAL',enableCustomHolderName:false,customHolderName:null,enableCustomHolderId:false,customHolderId:null},tx)},
 'employees.fixed_item.archive':{family:'hr_on_employment',store:fixedItemArchiveReviews,screenAdmits:isAdmin,
  create:async(_w,h)=>{const ctx=groupOf(h.base);await seedPayComponentCatalog(ctx);const component=(await listPayComponents(ctx)).find(row=>row.code==='ALLOWANCE');if(!component)throw Error('Missing native recurring fixture');const row=await setEmploymentPayComponent(ctx,{employmentId:h.person.employmentId,componentId:component.id,amount:200,effectiveFrom:todayInKualaLumpur()});return itemOf(h,row.id);},
  human:item=>({action:'employees.fixed_item.archive',contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId}),
  offered:async(who,item)=>listed(await readFixedItemArchiveChoices(who,{query:item.name,employmentId:item.employmentId}),'items','id',item.subjectId),
  screen:(tx,who,item)=>archiveEmploymentPayComponent(who,{id:item.subjectId,employmentId:item.employmentId},tx)},
 'employees.document_metadata.maintain':{family:'hr_on_employment',store:documentMetadataReviews,screenAdmits:isAdmin,
  create:async(_w,h)=>{const doc=await addEmployeeDocument(groupOf(h.base),{employmentId:h.person.employmentId,title:'Fictional metadata original',fileName:'fixture.txt',mimeType:'text/plain',content:Buffer.from('Fictional fixture attachment')});return itemOf(h,doc.id);},
  human:item=>({action:'employees.document_metadata.maintain',contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,fields:{title:'Fictional revised metadata',category:'Fictional category',description:'Fictional description'}}),
  offered:async(who,item)=>listed(await readDocumentMetadataChoices(who,{query:item.name,employmentId:item.employmentId}),'documents','id',item.subjectId),
  screen:(tx,who,item)=>updateEmployeeDocumentMeta(who,{documentId:item.subjectId,title:'Fictional revised metadata',category:'Fictional category',description:'Fictional description'},tx)},
 'employees.emergency_contact.maintain':{family:'hr_on_employment',store:emergencyContactMaintenanceReviews,screenAdmits:isAdmin,
  create:async(_w,h)=>itemOf(h,h.person.personId),
  human:item=>({action:'employees.emergency_contact.maintain',contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,operation:'add',contactId:null,fields:{fullName:'Fictional Emergency Contact',relationship:null,mobilePhone:'000-FICTIONAL',homePhone:null,address:null,remarks:'Fictional human note',priority:'primary'}}),
  offered:async(who,item)=>listed(await readEmergencyContactMaintenanceChoices(who,{query:item.name}),'employees','employmentId',item.employmentId),
  screen:(tx,who,item)=>addEmergencyContact(who,{personId:item.subjectId,fullName:'Fictional Emergency Contact',relationship:null,mobilePhone:'000-FICTIONAL',homePhone:null,address:null,remarks:'Fictional human note',priority:'primary'},tx)},
 'employees.draft.activate':{family:'hr_on_employment',store:{prepare:employeeDraftActivationReviews.prepare,confirm:(ctx,input)=>employeeDraftActivationReviews.confirm(ctx,{action:'employees.draft.activate',contractVersion:1,...input})},screenAdmits:isAdmin,
  async create(_w,h){const root=groupOf(h.base),draft=await createEmployeeDraftWithReservedCode(root,{companyId:h.companyId,fullName:'Fictional saved draft',primaryEmail:randomUUID()+'@fixture.test',employeeIdMode:'manual',employeeCode:'P-'+randomUUID().slice(0,10).toUpperCase()}),data:EmployeeDraftData={profile:{fullName:'Fictional saved draft',primaryEmail:randomUUID()+'@fixture.test',employeeCode:draft.employeeCode,employeeIdMode:'manual'},employment:{companyId:h.companyId,departmentId:h.departmentId,employmentType:'full_time',hiredOn:todayInKualaLumpur()},payroll:{basicSalary:'3000'}};await saveEmployeeDraft(root,{id:draft.id,data,currentStep:4});return itemOf(h,draft.id,{companyId:h.companyId,proposal:data});},
  human:item=>({action:'employees.draft.activate',contractVersion:1,draftId:item.subjectId,companyId:item.companyId}),
  offered:async(who,item)=>listed(await readEmployeeDraftActivationChoices(who,{}),'drafts','draftId',item.subjectId),
  screen:(tx,who,item)=>saveAndCompleteEmployeeDraft(who,{id:item.subjectId,data:item.proposal as EmployeeDraftData,currentStep:4},tx)},
 'employees.family.maintain':{family:'hr_on_employment',store:familyMaintenanceReviews,screenAdmits:isAdmin,
  create:async(_w,h)=>itemOf(h,h.person.personId),
  human:item=>({action:'employees.family.maintain',contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,operation:'add',dependentId:null,fields:{"fullName":"Fictional Family Member","relationship":"child","dateOfBirth":"2015-01-01","gender":null,"icOrPassport":null,"phone":null,"remarks":"Human entered note","passportNumber":null,"residentialAddress":null,"deceasedOn":null,"marriageDate":null,"marriageStatus":null,"occupation":null,"companyName":null,"employerAddress":null,"schoolName":null,"studyLevel":null,"studyCountry":null,"childReliefCategory":null,"isBeneficiary":false,"isDeceased":false,"spouseWorking":null,"isStudent":null,"childTaxRelief":null,"childReliefPercentage":null}}),
  offered:async(who,item)=>listed(await readFamilyMaintenanceChoices(who,{query:item.name}),'employees','employmentId',item.employmentId),
  screen:(tx,who,item)=>addDependent(who,{personId:item.subjectId,...{"fullName":"Fictional Family Member","relationship":"child","dateOfBirth":"2015-01-01","gender":null,"icOrPassport":null,"phone":null,"remarks":"Human entered note","passportNumber":null,"residentialAddress":null,"deceasedOn":null,"marriageDate":null,"marriageStatus":null,"occupation":null,"companyName":null,"employerAddress":null,"schoolName":null,"studyLevel":null,"studyCountry":null,"childReliefCategory":null,"isBeneficiary":false,"isDeceased":false,"spouseWorking":null,"isStudent":null,"childTaxRelief":null,"childReliefPercentage":null}},tx)},
 'employees.qualification.maintain':{family:'hr_on_employment',store:qualificationMaintenanceReviews,screenAdmits:isAdmin,
  create:async(_w,h)=>itemOf(h,h.person.employmentId),
  human:item=>({action:'employees.qualification.maintain',contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,operation:'add',qualificationId:null,fields:{qualification:'Bachelor',description:'Fictional human-entered qualification',fromYm:'2018-01',toYm:'2021-12',institute:'Fictional Institute',major:null,graduationDate:'2021-12-15',result:null,isHighest:true}}),
  offered:async(who,item)=>listed(await readQualificationMaintenanceChoices(who,{query:item.name}),'employees','employmentId',item.employmentId),
  screen:(tx,who,item)=>addQualification(who,{employmentId:item.employmentId,qualification:'Bachelor',description:'Fictional human-entered qualification',fromYm:'2018-01',toYm:'2021-12',institute:'Fictional Institute',major:null,graduationDate:'2021-12-15',result:null,isHighest:true},tx)},
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
 * confirm a review another permitted login prepared. */
type Observed={screen:ParityOutcome;page?:ParityOutcome}&Record<(typeof PARITY_PHASES)[number],ParityOutcome>&{crossUserConfirm:ParityOutcome|'n/a'};

async function screenOutcome(adapter:Adapter,who:SessionContext,item:Item,actorEmploymentId:string|null,o:Options,notes:Record<string,string>):Promise<ParityOutcome>{
 if(adapter.screenAdmits&&!(await adapter.screenAdmits(who,item))){notes.screen='refused by the screen admission';return 'deny';}
 try{if(adapter.independentScreen){await adapter.screen(undefined as unknown as Tx,who,item,actorEmploymentId,o);return 'allow';}await withTenant(who,async tx=>{await adapter.screen(tx,who,item,actorEmploymentId,o);throw new Rollback();});}catch(error){if(error instanceof Rollback)return 'allow';notes.screen=why(error);}
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
 let w=await buildWorld(),item=await adapter.create(w,w.home,o),who=await w.as(role);
 const screen=await screenOutcome(adapter,who,item,w.people[role].employmentId,o,notes);
 if(adapter.independentScreen){w=await buildWorld();item=await adapter.create(w,w.home,o);who=await w.as(role);}
 // Creating the reference login changes native Access/policy revisions. Finish that setup before
 // either review, so this custody probe does not accidentally manufacture a stale source.
 const reference=PARITY_ROLES.find(r=>r!==role&&expectedAgentOutcome(declared,r)==='allow'),referenceActor=reference?await w.as(reference):null;
 let offer:ParityOutcome='deny';
 try{offer=await adapter.offered(who,item)?'allow':'deny';}catch(error){notes.offer=why(error);}
 const own=await tryPrepare(adapter,who,item,o,notes),prepare:ParityOutcome=own?'allow':'deny';
 // Probe another login BEFORE any effect changes the shared source. A permitted actor must not be
 // able to adopt another permitted actor's review, including another login linked to the same person.
 let theirs:Review|null,crossActor=who;
 if(reference&&referenceActor){notes.crossUserReference=reference;theirs=await tryPrepare(adapter,referenceActor,item,o,notes,'reference');}
 else if(own){crossActor=(await w.login(w.b,w.subject,'employee',null)).ctx;notes.crossUserReference='same_person_new_login_attempts_original_review';theirs=own;}
 else throw Error(`${id}: no permitted reference actor for custody refusal: ${JSON.stringify(notes)}`);
 if(!theirs)throw Error(`${id}: reference preparation failed, so cross-user confirmation proves nothing: ${notes.reference}`);
 const custody=()=>owner.db.execute(sql`select r.state,r.intent_digest,r.reviewed_digest,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where r.id=${theirs.actionId}::uuid`);
 const effects=()=>owner.db.select({id:schema.domainEvent.id}).from(schema.domainEvent).orderBy(schema.domainEvent.id);
 const held=await custody(),beforeEffects=await effects();expect(held).toHaveLength(1);
 const crossUserConfirm=await tryConfirm(adapter,crossActor,theirs,notes,'crossUserConfirm');
 expect(await custody(),`${id}: foreign confirmation changed the owner's custody`).toEqual(held);
 expect(await effects(),`${id}: foreign confirmation wrote a native event`).toEqual(beforeEffects);
 const confirm:ParityOutcome=own?await tryConfirm(adapter,who,own,notes,'confirm'):'deny';
 if(id==='approvals.claim.decide'&&o.decision==='rejected'&&confirm==='allow'){
  const events=await owner.db.select({actorId:schema.domainEvent.actorId,payload:schema.domainEvent.payload}).from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,item.subjectId),eq(schema.domainEvent.eventType,'claim-request.rejected')));
  expect(events,`${id}: rejection must preserve the same explicit human reason as the native screen`).toEqual([{actorId:who.userId,payload:{rejectReason:REJECT_REASON}}]);
 }
 return {observed:{screen,offer,prepare,confirm,crossUserConfirm,...(adapter.pageAdmits?{page:adapter.pageAdmits(who)?'allow' as const:'deny' as const}:{})},notes};
}
/** The parity invariants every probe must satisfy, whatever is declared: never wider than the screen,
 * never a cross-user confirmation, and cross-company/tenant refused everywhere. */
function assertInvariants(id:string,role:ParityRole,observed:Observed,notes:Record<string,string>,narrowed:boolean|Readonly<Partial<Record<ParityPhase,string>>>,scope?:'caller_tenant'|'caller_login'){
 const context=`${id} as ${role}: ${JSON.stringify({observed,notes})}`;
 for(const phase of PARITY_PHASES)if(observed.screen==='deny')expect(observed[phase],`${context} — the agent ${phase} is wider than the screen`).toBe('deny');
 for(const phase of PARITY_PHASES)expect(observed[phase],`${context} — agent ${phase} differs from the screen`).toBe((typeof narrowed==='boolean'?narrowed:!!narrowed[phase])?'deny':observed.screen);
 expect(observed.crossUserConfirm,`${context} — confirmed another user's review`).not.toBe('allow');
 if(observed.prepare==='deny')expect(observed.crossUserConfirm,`${context} — a refused role must be probed for cross-user confirmation`).toBe('deny');
 if(!scope&&ALWAYS_REFUSED.includes(role)){expect({offer:observed.offer,prepare:observed.prepare,confirm:observed.confirm},`${context} — cross-company/tenant agent must refuse`).toEqual({offer:'deny',prepare:'deny',confirm:'deny'});if(role==='another_tenant'||!(typeof narrowed==='boolean'?narrowed:Object.keys(narrowed).length>0))expect(observed.screen,`${context} — foreign native action must refuse absent an explicit narrower finding`).toBe('deny');}
 return context;
}

/** Register exactly one selected DB entrypoint; wrappers add no describe nesting or hooks. */
export function registerAgentActionParity(group:ParityProbeGroup){
const selection:{actions:readonly ProbedActionId[];variants:readonly ParityProbeVariant[]}=PARITY_PROBE_GROUPS[group];
beforeAll(async()=>{await migrateTestDb();});
afterAll(closeAll);
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-parity-harness-custody-key-1234');await resetDb();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});

if(selection.variants.includes('adapter_coverage')) describe('WP8 parity harness coverage',()=>{
 it('has exactly one adapter per probed matrix entry, each a registry entry with an agent store',()=>{
  expect(Object.keys(ADAPTERS).sort()).toEqual([...PROBED_ACTION_IDS].sort());
  for(const id of PROBED_ACTION_IDS)expect(AGENT_ACTIONS.find(action=>action.id===id)?.store,id).not.toBe('human_workflow_only');
 });
});

describe.each([...selection.actions])('ADR-0151 parity: %s',id=>{
 it.each([...PARITY_ROLES])('%s gets the screen\'s allow/deny on offer, prepare and own confirm, and no cross-user confirm',async role=>{
  const declared=AGENT_ACTION_PARITY[id],{observed,notes}=await observe(id,role);
  console.info(`[parity] ${id} ${role} ${JSON.stringify(observed)} ${JSON.stringify(notes)}`);
  const phaseNarrowing=Object.fromEntries(PARITY_PHASES.filter(phase=>expectedAgentOutcome(declared,role)==='deny'&&declared.screen[role]==='allow').map(phase=>[phase,'Declared narrower finding']));
  const context=assertInvariants(id,role,observed,notes,phaseNarrowing,'scope' in declared?declared.scope:undefined);
  if('page' in declared)expect(observed.page,`${context} — native page discoverability differs`).toBe(declared.page[role]);
  // The owning screen behaves as declared (independent expected value).
  expect(observed.screen,`${context} — screen differs from the declared matrix`).toBe(declared.screen[role]);
 },180_000);
});

if(selection.variants.includes('cost_allocation_clear')) describe('ADR-0151 parity, cost allocation explicit clear',()=>{
 it.each([...PARITY_ROLES])('%s clears a complete native distribution with the same authority',async role=>{
  const {observed,notes}=await observe('employees.cost_allocation.maintain',role,{decision:'approved',workflow:false,allocationOperation:'clear'});
  const declared=AGENT_ACTION_PARITY['employees.cost_allocation.maintain'];assertInvariants('employees.cost_allocation.maintain clear',role,observed,notes,false);expect(observed.screen).toBe(declared.screen[role]);
 },180_000);
});

const DECISIONS=PROBED_ACTION_IDS.filter(id=>ADAPTERS[id].family==='assigned_decision');
/** Rejections: the parity invariants hold; the observed screen outcome is recorded in the log, not declared. */
if(selection.variants.includes('rejected_decisions')) describe.each(DECISIONS)('ADR-0151 parity, rejected decision: %s',id=>{
 it.each([...PARITY_ROLES])('%s gets the screen\'s allow/deny when rejecting',async role=>{
  const {observed,notes}=await observe(id,role,{decision:'rejected',workflow:false});
  console.info(`[parity:rejected] ${id} ${role} ${JSON.stringify(observed)} ${JSON.stringify(notes)}`);
  const declared=AGENT_ACTION_PARITY[id];assertInvariants(id,role,observed,notes,Object.fromEntries(PARITY_PHASES.filter(phase=>expectedAgentOutcome(declared,role)==='deny'&&declared.screen[role]==='allow').map(phase=>[phase,'Declared narrower finding'])));
 },180_000);
});

/** The attendance delegate policies (0533/0570/0592) apply to workflow-routed requests; probe the delegate,
 * the manager and HR under a one-level direct-manager workflow, approving and rejecting. */
if(selection.variants.includes('routed_attendance')) describe('ADR-0151 parity, attendance under a routed one-level workflow',()=>{
 it.each((['assigned_approver','manager','company_hr','employee'] as const).flatMap(role=>(['approved','rejected'] as const).map(decision=>[role,decision] as const)))('%s %s',async(role,decision)=>{
  const {observed,notes}=await observe('approvals.attendance.decide',role,{decision,workflow:true});
  console.info(`[parity:workflow] approvals.attendance.decide ${role} ${decision} ${JSON.stringify(observed)} ${JSON.stringify(notes)}`);
  const context=assertInvariants('approvals.attendance.decide (workflow)',role,observed,notes,false);
  expect(observed.screen,`${context} — screen differs from routed declaration`).toBe(ATTENDANCE_WORKFLOW_PARITY.screen[role]);
 },180_000);
});

/** Prepare as a permitted role, remove that permission, then confirm must be refused by revalidation. */
if(selection.variants.includes('permission_revalidation')) describe('ADR-0151 parity: permission removed between prepare and confirm',()=>{
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
const CONTROLS:[ProbedActionId,'another_company'|'another_tenant'][]=(['approvals.claim.decide','leave.adjustment.apply','leave.cancel','notifications.email_preferences.save'] as const).flatMap(id=>(['another_company','another_tenant'] as const).map(role=>[id,role] as [ProbedActionId,'another_company'|'another_tenant']));
if(selection.variants.includes('boundary_controls')) describe('ADR-0151 parity positive controls: the boundary sessions act inside their own company or tenant',()=>{
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

/** A standalone assigned tester is a USER, with no fabricated PERSON or EMPLOYMENT. The role matrix
 * above additionally probes the employee-linked assigned tester against all other native actors. */
if(selection.variants.includes('standalone_tester')) describe('WP8 assigned tester without staff identity',()=>{
 it('records the assigned login observation and refuses another login and another tenant',async()=>{
  const w=await buildWorld(),adapter=ADAPTERS['system_testing.execution.save'],original=await adapter.create(w,w.home,DEFAULT_OPTIONS);
  const [originalAssignment]=await owner.db.select().from(schema.testAssignment).where(eq(schema.testAssignment.id,original.assignmentId!));
  const newTester=async(base:Base)=>{
   const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'user_'+randomUUID(),personId:null}).returning({id:schema.appUser.id});
   await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,role:'employee',companyId:null});await grantAssistant(groupOf(base),{appUserId:user.id});
   return {...await sessionFor(base,user.id,null,'employee',null),personId:null};
  };
  const who=await newTester(w.b),other=await newTester(w.b),foreign=await newTester(w.foreign);
  const assignment=await testing.assignTestingCase(w.group,{caseId:originalAssignment.testCaseId,testerUserId:who.userId!,expectedVersionId:original.versionId!,active:true,expectedRevision:null});
  const execution=await testing.beginTestingExecution(who,{assignmentId:assignment.assignmentId,expectedVersionId:original.versionId!,newAttempt:false});
  const item={...original,subjectId:execution.executionId,assignmentId:assignment.assignmentId,revision:execution.revision};
  const observation=testingObservation(item),notes:Record<string,string>={};
  expect(await screenOutcome(adapter,who,item,null,DEFAULT_OPTIONS,notes),JSON.stringify(notes)).toBe('allow');
  expect(await adapter.offered(who,item)).toBe(true);const review=await tryPrepare(adapter,who,item,DEFAULT_OPTIONS,notes);expect(review,JSON.stringify(notes)).not.toBeNull();
  expect(await tryConfirm(adapter,other,review!,notes,'other')).toBe('deny');expect(await tryConfirm(adapter,foreign,review!,notes,'foreign')).toBe('deny');
  expect(await tryConfirm(adapter,who,review!,notes,'confirm'),JSON.stringify(notes)).toBe('allow');
  const [run]=await owner.db.select().from(schema.testRun).where(eq(schema.testRun.executionId,item.subjectId));expect(run).toMatchObject({runByUserId:who.userId,actualResult:observation.actualResult,executionStatus:observation.status});
 },180_000);
});

}
