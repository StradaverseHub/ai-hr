/** ADR-0151 §7 "Parity", review R16 (WP8) — the generic per-entry role matrix, driven by the agent action
 * registry through test/helpers/agent-action-parity-matrix.ts.
 *
 * For every probed registry entry and every matrix role, in a fresh fictional world (tenant with two
 * companies, plus a foreign tenant), this runs:
 *   - SCREEN: the owning screen's own admission (the page/route guard the server action calls, when it has
 *     one) and then the owning service itself under the role's own session, inside a transaction that is
 *     always rolled back. No second permission model: the outcome is whatever the native code decides.
 *   - AGENT offer: the Assistant's choices read for that action lists the subject.
 *   - AGENT prepare: the registry entry's store prepares a review of the same subject.
 *   - AGENT confirm: the role confirms its own review (which runs the native service again); a role that
 *     could not prepare instead tries to confirm a review a permitted role prepared.
 * It requires the observed screen outcome to equal the declared one, every agent phase to equal the screen
 * (or to be refused where the matrix declares the agent narrower), and never an agent allow where the screen
 * refuses. Real migrated database and real services; fictional fixtures only. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {createCompany,createDepartment} from '../core/admin';
import {setCompensation} from '../core/comp';
import {setRestDay} from '../core/roster';
import {grantAssistant} from '../core/assistant-grant';
import {createMovementEventTx} from '../core/movement';
import {isAdmin} from '../lib/authz-model';
import {createClaimType,setClaimPolicy,submitClaim,decideClaimTx} from '../packs/claims/service';
import {requestAttendanceCorrection,decideAttendanceCorrection} from '../packs/attendance/service';
import {setToilPolicy,submitReplacementLeaveRequest,decideReplacementLeaveRequestTx,applyLeaveAdjustmentBatchTx,grantLeaveCreditRowsTx,requestLeave,cancelOwnLeaveTx,editLeaveRequestTx} from '../packs/leave/service';
import {claimDecisionReviews,attendanceDecisionReviews,toilDecisionReviews,readClaimDecisionChoices,readAttendanceDecisionChoices,readToilDecisionChoices} from '../core/assistant-actions/assigned-decision-review-store';
import {leaveCancellationReviews,leaveEditReviews,readLeaveChangeChoices} from '../core/assistant-actions/leave-change-review-store';
import {leaveAdjustmentReviews,movementTransferReviews,leaveCreditReviews,readLeaveAdjustmentChoices,readMovementTransferChoices,readLeaveCreditChoices} from '../core/assistant-actions/hr-prepared-review-store';
import {ASSIGNED_CLAIM_DECISION_ACTION,ASSIGNED_ATTENDANCE_DECISION_ACTION,ASSIGNED_TOIL_DECISION_ACTION} from '../lib/assistant-actions/assigned-decision-contract';
import {OWN_LEAVE_CANCELLATION_ACTION,OWN_LEAVE_EDIT_ACTION} from '../lib/assistant-actions/own-leave-change-contract';
import {HR_LEAVE_ADJUSTMENT_ACTION,HR_MOVEMENT_TRANSFER_ACTION,HR_LEAVE_CREDIT_ACTION} from '../lib/assistant-actions/hr-prepared-contract';
import {AGENT_ACTIONS} from '../lib/ai/agent-action-registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import {AGENT_ACTION_PARITY,ALWAYS_REFUSED,PARITY_PHASES,PARITY_ROLES,PROBED_ACTION_IDS,expectedAgentOutcome,type ParityOutcome,type ParityRole,type ProbedActionId} from './helpers/agent-action-parity-matrix';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Person={employmentId:string;personId:string};
type DbRole=(typeof schema.roleEnum.enumValues)[number];
type Item={subjectId:string;employmentId:string;date?:string;dates?:string[]};
type Review={actionId:string;reviewedDigest:string};
/** The store surface the harness uses; each concrete store is structurally assignable to it. */
type Store={
 prepare(ctx:SessionContext,input:unknown):Promise<{review:Review}>;
 confirm(ctx:SessionContext,input:Review):Promise<{kind:string}>;
};
type World={
 b:Base;foreign:Base;companyB:string;subject:Person;people:Record<ParityRole,Person>;group:SessionContext;
 /** One login per role, created on first use (role assignment + Assistant grant + resolved entitlements). */
 as(role:ParityRole):Promise<SessionContext>;
 claimTypeId?:string;
};
type Adapter={
 store:Store;
 /** The page/route admission the screen's server action calls before its service (e.g. requireAdmin → isAdmin). */
 screenAdmits?:(who:SessionContext)=>boolean;
 /** The item one confirmation targets, belonging to the subject employee. */
 create(w:World):Promise<Item>;
 human(w:World,item:Item):Record<string,unknown>;
 offered(who:SessionContext,w:World,item:Item):Promise<boolean>;
 /** The owning service's write for this role, as the screen calls it (rolled back by the harness). */
 screen(tx:Tx,who:SessionContext,w:World,item:Item,actorEmploymentId:string|null):Promise<unknown>;
};

const MODULES=['assistant','claims','attendance','toil'];
const SUBJECT_NAME='Fictional Parity Subject';
/** HR calendar days from the repository's HR date owner. */
function calendarDate(offset:number){const value=new Date(todayInKualaLumpur()+'T12:00:00Z');value.setUTCDate(value.getUTCDate()+offset);return value.toISOString().slice(0,10);}
const hiredOn=()=>`${Number(todayInKualaLumpur().slice(0,4))-2}-01-01`;
const groupOf=(base:Base):SessionContext=>({...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]});
const hire=(base:Base,name:string,companyId:string,departmentId:string):Promise<Person>=>hireEmployee(groupOf(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId,departmentId,employmentType:'full_time',hiredOn:hiredOn()});
async function login(base:Base,person:Person,role:DbRole,companyId:string|null):Promise<SessionContext>{
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:`user_${randomUUID()}`,personId:person.personId}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId,role});
 await grantAssistant(groupOf(base),{appUserId:user.id});
 return {...await entitledCtx(base,[role]),userId:user.id,personId:person.personId,grants:[{role,companyId}]};
}

async function buildWorld():Promise<World>{
 const b=await seedBase(),group=groupOf(b);for(const code of MODULES)await setModule(b.tenantId,code,'active');
 const other=await createCompany(group,{legalName:'Fictional other employer',country:'MY',currency:'MYR'} as never);
 const otherDept=await createDepartment(group,{companyId:other.id,name:'Fictional other department'} as never) as {id:string};
 // Only the subject sits in department A.
 const subject=await hire(b,SUBJECT_NAME,b.companyId,b.deptA);
 const at=(name:string)=>hire(b,name,b.companyId,b.deptB);
 const manager=await at('Fictional Parity Line Manager'),approver=await at('Fictional Parity Delegate'),approverReport=await at('Fictional Parity Delegate Report');
 const companyHr=await at('Fictional Parity Company HR'),groupHr=await at('Fictional Parity Group HR'),payroll=await at('Fictional Parity Payroll Partner');
 const perfComp=await at('Fictional Parity Performance Comp Partner'),perf=await at('Fictional Parity Performance Partner');
 const otherCompanyHr=await hire(b,'Fictional Parity Other-Company HR',other.id,otherDept.id);
 await setReportingLine(group,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:hiredOn()});
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
 const as=(role:ParityRole)=>{let s=sessions.get(role);if(!s){const [base,dbRole,companyId]=grantOf[role];s=login(base,people[role],dbRole,companyId);sessions.set(role,s);}return s;};
 return {b,foreign,companyB:other.id,subject,people,group,as};
}

type Choices={kind:string;items?:{subjectId:string}[];employees?:{employmentId:string}[];requests?:{leaveRequestId:string}[]};
const lists=(found:unknown,item:Item)=>{const c=found as Choices;return c?.kind==='choices'&&(!!c.items?.some(row=>row.subjectId===item.subjectId)||!!c.employees?.some(row=>row.employmentId===item.employmentId)||!!c.requests?.some(row=>row.leaveRequestId===item.subjectId));};
/** The next n weekdays after today (HR date owner). */
function weekdays(n:number){const out:string[]=[],next=new Date(todayInKualaLumpur()+'T00:00:00Z');while(out.length<n){next.setUTCDate(next.getUTCDate()+1);if(![0,6].includes(next.getUTCDay()))out.push(next.toISOString().slice(0,10));}return out;}
/** One plain pending full-day leave request of the subject's, applied on their own leave screen path. */
async function pendingLeave(w:World):Promise<Item>{
 await owner.db.insert(schema.leaveLedger).values({tenantId:w.b.tenantId,employmentId:w.subject.employmentId,leaveTypeId:w.b.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 const dates=weekdays(4),done=await requestLeave(await w.as('employee'),{employmentId:w.subject.employmentId,leaveTypeId:w.b.annualLeaveTypeId,startDate:dates[0],endDate:dates[0],durationType:'full_day',reason:'Fictional family visit'});
 return {subjectId:done.leaveRequestId,employmentId:w.subject.employmentId,dates};
}
const employmentItem=(w:World):Item=>({subjectId:w.subject.employmentId,employmentId:w.subject.employmentId});

const ADAPTERS:Record<ProbedActionId,Adapter>={
 'approvals.claim.decide':{store:claimDecisionReviews,
  async create(w){
   w.claimTypeId??=(await createClaimType(w.group,{code:'FIC-PARITY',name:'Fictional parity travel',defaultTaxable:false,requiresReceipt:false})).id;
   await setClaimPolicy(w.group,{claimTypeId:w.claimTypeId,annualBudget:1000,perClaimCap:1000,effectiveFrom:todayInKualaLumpur()});
   const claim=await submitClaim(await w.as('employee'),{employmentId:w.subject.employmentId,claimTypeId:w.claimTypeId,amount:42.5,incurredOn:todayInKualaLumpur(),description:'Fictional taxi fare'});
   return {subjectId:claim.id,employmentId:w.subject.employmentId};},
  human:(_w,item)=>({action:ASSIGNED_CLAIM_DECISION_ACTION,contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,decision:'approved'}),
  offered:async(who,_w,item)=>lists(await readClaimDecisionChoices(who),item),
  screen:(tx,who,_w,item,decider)=>decideClaimTx(tx,who,{claimRequestId:item.subjectId,decision:'approve',deciderEmploymentId:decider})},
 'approvals.attendance.decide':{store:attendanceDecisionReviews,
  // A future planned overtime request (deferred approval: no attendance day is needed or written).
  async create(w){const done=await requestAttendanceCorrection(await w.as('employee'),{employmentId:w.subject.employmentId,date:calendarDate(7),plannedStartTime:'18:00',plannedEndTime:'19:00',requestedOtMinutes:60,reason:'Fictional planned release work',requestKind:'self_overtime'});
   return {subjectId:done.correctionId,employmentId:w.subject.employmentId};},
  human:(_w,item)=>({action:ASSIGNED_ATTENDANCE_DECISION_ACTION,contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,decision:'approved'}),
  offered:async(who,_w,item)=>lists(await readAttendanceDecisionChoices(who),item),
  screen:(tx,who,_w,item)=>decideAttendanceCorrection(who,{correctionId:item.subjectId,decision:'approved'},tx)},
 'approvals.toil.decide':{store:toilDecisionReviews,
  async create(w){const date=calendarDate(-3);await setRestDay(w.group,{employmentId:w.subject.employmentId,shiftDate:date});
   const done=await submitReplacementLeaveRequest(await w.as('employee'),{employmentId:w.subject.employmentId,unit:'day',lines:[{workedDate:date,days:1}],reason:'Fictional rest-day release support',today:todayInKualaLumpur()});
   return {subjectId:done.requestId,employmentId:w.subject.employmentId};},
  human:(_w,item)=>({action:ASSIGNED_TOIL_DECISION_ACTION,contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,decision:'approved',note:'Fictional approver note'}),
  offered:async(who,_w,item)=>lists(await readToilDecisionChoices(who),item),
  screen:(tx,who,_w,item)=>decideReplacementLeaveRequestTx(tx,who,{requestId:item.subjectId,decision:'approved'})},
 // Own leave screen: cancelOwnLeaveAction / editLeaveAction call the service with the session (no page admission).
 'leave.cancel':{store:leaveCancellationReviews,
  create:pendingLeave,
  human:(_w,item)=>({action:OWN_LEAVE_CANCELLATION_ACTION,contractVersion:1,employmentId:item.employmentId,leaveRequestId:item.subjectId,cancel:true}),
  offered:async(who,_w,item)=>lists(await readLeaveChangeChoices(who),item),
  screen:(tx,who,_w,item)=>cancelOwnLeaveTx(tx,who,{leaveRequestId:item.subjectId})},
 'leave.edit':{store:leaveEditReviews,
  create:pendingLeave,
  human:(_w,item)=>({action:OWN_LEAVE_EDIT_ACTION,contractVersion:1,employmentId:item.employmentId,leaveRequestId:item.subjectId,startDate:item.dates![1],endDate:item.dates![2]}),
  offered:async(who,_w,item)=>lists(await readLeaveChangeChoices(who),item),
  screen:(tx,who,w,item)=>editLeaveRequestTx(tx,who,{leaveRequestId:item.subjectId,leaveTypeId:w.b.annualLeaveTypeId,startDate:item.dates![1],endDate:item.dates![2],durationType:'full_day',today:todayInKualaLumpur()})},
 // HR screens: the server actions call requireAdmin() (isAdmin) before the service.
 'leave.adjustment.apply':{store:leaveAdjustmentReviews,screenAdmits:isAdmin,
  create:async w=>employmentItem(w),
  human:(w,item)=>({action:HR_LEAVE_ADJUSTMENT_ACTION,contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,leaveTypeId:w.b.annualLeaveTypeId,direction:'add',days:'1.5',effectiveOn:todayInKualaLumpur(),reason:'Fictional correction of a missed carry-forward'}),
  offered:async(who,_w,item)=>lists(await readLeaveAdjustmentChoices(who,{query:SUBJECT_NAME}),item),
  screen:(tx,who,w,item)=>applyLeaveAdjustmentBatchTx(tx,who,{targetMode:'individual',employmentIds:[item.employmentId],leaveTypeIds:[w.b.annualLeaveTypeId],days:1.5,effectiveOn:todayInKualaLumpur(),reason:'Fictional correction of a missed carry-forward'})},
 'employees.movement.transfer':{store:movementTransferReviews,screenAdmits:isAdmin,
  create:async w=>employmentItem(w),
  human:(w,item)=>({action:HR_MOVEMENT_TRANSFER_ACTION,contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,kind:'transfer',effectiveDate:todayInKualaLumpur(),departmentId:w.b.deptB,positionId:null,businessUnitId:null,locationId:null,remarks:'Fictional team change'}),
  offered:async(who,_w,item)=>lists(await readMovementTransferChoices(who,{query:SUBJECT_NAME}),item),
  screen:(tx,who,w,item)=>createMovementEventTx(tx,who,{employmentId:item.employmentId,kind:'transfer',effectiveDate:todayInKualaLumpur(),departmentId:w.b.deptB})},
 'toil.credit.grant':{store:leaveCreditReviews,screenAdmits:isAdmin,
  async create(w){const date=calendarDate(-3);await setRestDay(w.group,{employmentId:w.subject.employmentId,shiftDate:date});return {...employmentItem(w),date};},
  human:(_w,item)=>({action:HR_LEAVE_CREDIT_ACTION,contractVersion:1,employmentId:item.employmentId,subjectId:item.subjectId,workedDate:item.date,claimStart:'09:00',claimEnd:'17:00',reason:'Fictional weekend stock-take',firstScheduleConsent:false}),
  offered:async(who,_w,item)=>lists(await readLeaveCreditChoices(who,{query:SUBJECT_NAME}),item),
  screen:(tx,who,_w,item)=>grantLeaveCreditRowsTx(tx,who,{employmentId:item.employmentId,rows:[{workedDate:item.date!,dayType:'rest_day',claimStart:'09:00',claimEnd:'17:00'}],reason:'Fictional weekend stock-take'})},
};

class Rollback extends Error{constructor(){super('parity probe rollback');}}
const why=(error:unknown)=>error instanceof Error?`${error.name}: ${error.message}`.slice(0,240):String(error).slice(0,240);
type Observed={screen:ParityOutcome}&Record<(typeof PARITY_PHASES)[number],ParityOutcome>;

async function observe(id:ProbedActionId,role:ParityRole):Promise<{observed:Observed;notes:Record<string,string>}>{
 const adapter=ADAPTERS[id],declared=AGENT_ACTION_PARITY[id],notes:Record<string,string>={};
 const w=await buildWorld(),item=await adapter.create(w),who=await w.as(role);
 const actorEmploymentId=w.people[role].employmentId;
 // SCREEN: admission, then the owning service, always rolled back.
 let screen:ParityOutcome='deny';
 if(adapter.screenAdmits&&!adapter.screenAdmits(who))notes.screen='refused by the screen admission';
 else{try{await withTenant(who,async tx=>{await adapter.screen(tx,who,w,item,actorEmploymentId);throw new Rollback();});}catch(error){if(error instanceof Rollback)screen='allow';else notes.screen=why(error);}}
 // AGENT offer.
 let offer:ParityOutcome='deny';
 try{offer=await adapter.offered(who,w,item)?'allow':'deny';}catch(error){notes.offer=why(error);}
 // AGENT prepare.
 let review:Review|null=null,prepare:ParityOutcome='deny';
 try{review=(await adapter.store.prepare(who,adapter.human(w,item))).review;prepare='allow';}catch(error){notes.prepare=why(error);}
 // AGENT confirm: the role's own review, or a permitted role's review it must not be able to confirm.
 let confirm:ParityOutcome='deny';
 if(!review){
  const reference=PARITY_ROLES.find(r=>r!==role&&expectedAgentOutcome(declared,r)==='allow');
  if(reference){try{review=(await adapter.store.prepare(await w.as(reference),adapter.human(w,item))).review;notes.confirmOf=reference;}catch(error){notes.confirmOf=`${reference} could not prepare: ${why(error)}`;}}
 }
 if(review){try{const done=await adapter.store.confirm(who,{actionId:review.actionId,reviewedDigest:review.reviewedDigest});confirm=done.kind==='completed'?'allow':'deny';if(confirm==='deny')notes.confirm='kind '+done.kind;}catch(error){notes.confirm=why(error);}}
 return {observed:{screen,offer,prepare,confirm},notes};
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
 it.each([...PARITY_ROLES])('%s gets the screen\'s allow/deny on offer, prepare and confirm',async role=>{
  const declared=AGENT_ACTION_PARITY[id],{observed,notes}=await observe(id,role);
  console.info(`[parity] ${id} ${role} ${JSON.stringify(observed)} ${JSON.stringify(notes)}`);
  const context=`${id} as ${role}: ${JSON.stringify({observed,notes})}`;
  // Never wider than the screen, whatever the declaration says.
  for(const phase of PARITY_PHASES)if(observed.screen==='deny')expect(observed[phase],`${context} — the agent ${phase} is wider than the screen`).toBe('deny');
  if(ALWAYS_REFUSED.includes(role))expect(observed,`${context} — cross-company/tenant must be refused everywhere`).toEqual({screen:'deny',offer:'deny',prepare:'deny',confirm:'deny'});
  // The owning screen behaves as declared (independent expected value), and the agent matches it.
  expect(observed.screen,`${context} — screen differs from the declared matrix`).toBe(declared.screen[role]);
  const agent=expectedAgentOutcome(declared,role);
  for(const phase of PARITY_PHASES)expect(observed[phase],`${context} — agent ${phase} differs from the screen`).toBe(agent);
 },180_000);
});
