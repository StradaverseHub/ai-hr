/** ADR-0170 step 0b — the declared semantic model over the twelve Assistant reads and three leave actions.
 *
 * One frozen declaration per subject. Field lists follow the allow-list projections the Assistant reads
 * already return (core/assistant-tools.ts, core/assistant-leave-projection.ts), so a field here is a field
 * a read hands back today; the disclosure class says how it may leave the product. Owners are the native
 * reads in core/read.ts and the owning services behind the registry actions; test/semantic-model-drift
 * imports each anchor and fails when it is missing. Nothing here grants access, runs a read or is imported
 * by the production Assistant. Not-yet-modelled registry actions are listed in ./pending.ts (shrink only). */
import {AGENT_MODULE_CODES} from '../../lib/ai/module-agents';
import type {SemanticAction,SemanticEntity,SemanticField,SemanticRead,FieldType,DisclosureClass} from './types';
import {OWN_CHANGE_ACTIONS,OWN_CHANGE_ENTITIES} from './entities-own-changes';
import {TOIL_ACTIONS,TOIL_ENTITIES} from './entities-toil';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'|'screen'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
/** A leave, claim or pay item name: screened for health-, religion- and similar-indicative names. */
const company=f('company','label','minimum','Company the record belongs to.');
const screened=(name:string,disclosure:DisclosureClass,meaning:string)=>f(name,'label',disclosure,meaning,{screen:'sensitive_label'});
/** Every field a module_work row may carry, from the closed projections in core/module-agent-readers.ts (one
 * reader per module; nested containers such as balances, reportingLines, lines, steps and tables are judged by
 * these same fields). Anything else is removed. Employee codes and record ids never leave (ids as handles); names
 * leave as placeholders; pay item codes and other screened labels leave as placeholders when sensitive; pay and
 * day figures leave as bands. */
const MODULE_ROW_FIELDS:readonly SemanticField[]=[
 // Identifiers and other people (employees, org, payroll, claims, performance, rewards, toil, notifications, system_testing).
 f('employmentId','id','never','Handle of the caller\'s employment.'),f('payslipId','id','never','Handle of a payslip.'),f('id','id','never','Handle of a record.'),
 f('employeeCode','code','never','Employee code.'),
 // A `name` is always withheld as a placeholder (another person's name in org rows, a pay item name in typed pay rows).
 f('name','name','minimum','A manager\'s name (org) or a pay item name (typed_pay_components).'),screened('code','minimum','A pay item code.'),f('leaveTypeId','id','never','Handle of a leave type.'),f('reviewId','id','never','Handle of a review.'),f('planId','id','never','Handle of a plan.'),
 f('assignmentId','id','never','Handle of a test assignment.'),f('caseId','id','never','Handle of a test case.'),f('versionId','id','never','Handle of a test case version.'),f('executionId','id','never','Handle of a test execution.'),
 // The caller's own work record (employees, org, leave, approvals, attendance).
 company,f('hiredOn','date','minimum','Own hire date.'),f('terminatedOn','date','minimum','Own end date, if ended.'),f('status','label','full','Where the record stands.'),
 f('lineType','enum','full','Kind of reporting line.'),
 // Own leave (leave, approvals, toil).
 screened('leaveType','minimum','Leave type name.'),f('accrued','number','bands','Days accrued.'),f('taken','number','bands','Days taken.'),f('pending','number','bands','Days awaiting approval.'),
 f('balance','number','bands','Recorded balance.'),f('available','number','bands','Days available.'),f('sharedPoolName','label','minimum','Leave type whose pool a balance draws from.'),
 f('withheld','boolean','full','Whether ESS visibility hid part of the row.'),f('startDate','date','minimum','First day.'),f('endDate','date','minimum','Last day.'),
 f('days','number','minimum','Day quantity of an own request.'),f('hours','number','minimum','Hour quantity of an own request.'),f('durationType','enum','full','Full day, half day or hours.'),
 f('hasRejectedDates','boolean','full','Whether some dates were rejected.'),
 f('active','number','bands','Replacement leave days available.'),f('expired','number','bands','Replacement leave days expired.'),f('convertedToPay','number','bands','Replacement leave days paid out.'),
 f('soonestExpiry','date','minimum','When the next replacement leave credit expires.'),f('leaveUnit','enum','full','Days or hours.'),f('workedDate','date','minimum','Day worked for a credit.'),
 f('expiresOn','date','minimum','When a credit expires.'),f('daysCredited','number','bands','Days credited.'),f('daysTaken','number','bands','Days used.'),f('remaining','number','bands','Days remaining.'),
 // Readiness (ess, country-my).
 f('employees','integer','minimum','Own employments checked.'),f('ready','integer','minimum','Own employments ready.'),f('blocks','enum','full','What a readiness gap blocks.'),f('count','integer','minimum','Own records with the gap.'),
 // Knowledge base, notifications.
 f('title','label','minimum','Guide title.'),f('category','label','full','Guide category.'),f('updatedAt','datetime','minimum','When the guide changed.'),
 f('readAt','datetime','minimum','When the notification was read.'),f('createdAt','datetime','minimum','When the record was created.'),
 // Pay (payroll, typed_pay_components, multi_cycle_payroll): the same money my_payslip_summary already bands.
 f('payPeriod','period','full','Pay period.'),f('runType','enum','full','Regular or off-cycle run.'),f('runSeq','integer','full','Run number in the period.'),f('currency','enum','full','Currency code.'),
 f('cycleName','label','minimum','Pay cycle name.'),f('gross','number','bands','Gross pay.'),f('deductions','number','bands','Total deductions.'),f('net','number','bands','Net pay.'),f('amount','number','bands','A pay item amount.'),
 // Attendance.
 f('date','date','minimum','Attendance day.'),f('workedMinutes','integer','minimum','Minutes worked.'),f('otMinutes','integer','minimum','Overtime minutes.'),
 // Claims.
 f('hasEmployment','boolean','full','Whether the caller has an employment.'),screened('claimType','minimum','Claim type name.'),f('incurredOn','date','minimum','Date incurred.'),
 f('decidedAt','datetime','minimum','When it was decided.'),f('paidAt','datetime','minimum','When it was paid.'),
 // Performance, rewards, lifecycle.
 f('framework','enum','full','Performance framework.'),f('artifact','enum','full','Review or plan.'),f('periodEnd','date','minimum','End of the review period.'),f('released','boolean','full','Whether it was released.'),
 f('kind','enum','full','Reward unit kind.'),f('year','integer','full','Reward year.'),f('revision','integer','full','Reward unit revision.'),f('cycle','label','minimum','Reward cycle.'),f('unit','label','minimum','Reward unit.'),
 f('progress','number','full','Onboarding progress.'),f('key','enum','full','Onboarding step key.'),f('label','label','full','Onboarding step label.'),f('applicable','boolean','full','Whether the step applies.'),f('done','boolean','full','Whether the step is done.'),
 // System explorer, system testing, assistant.
 f('table','label','full','Schema table name.'),f('module','enum','full','Module code.'),f('withheldTables','integer','full','Tables withheld.'),
 f('caseNo','code','never','Test case number.'),f('moduleCode','enum','full','Module code.'),f('ordinal','integer','full','Step order.'),
 f('capability','enum','full','Module capability.'),f('authority','enum','full','Where authority is checked.'),f('effects','enum','full','How effects are confirmed.'),
 f('total','integer','full','Scheduled agents.'),f('switchesOn','integer','full','Agents switched on.'),f('effectiveSwitchesOn','integer','full','Agents effectively on.'),
 f('feature','enum','full','Agent feature.'),f('switchOn','boolean','full','Switch state.'),f('effectiveSwitchOn','boolean','full','Effective switch state.'),f('state','enum','full','Agent state.'),
 f('attribution','enum','full','Switch attribution.'),f('managementHref','label','full','Agent management page.'),
];
const LEAVE_STATUS=['pending','approved','rejected','cancelled'] as const;

export const SEMANTIC_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'leave_balance',label:'Leave balance',meaning:'The caller\'s own balance per leave type, as shown on their own leave page (ESS visibility applies first).',
  module:'leave',sensitivity:'ordinary',audience:'self',rls:'own_employment',owners:['core/read.ts#myEmployments','core/read.ts#leaveBalances','core/assistant-leave-projection.ts#projectMineLeaveBalance'],
  ruleVersion:null,relations:[{to:'leave_entitlement',kind:'one_to_many',via:'leaveTypeId'}],page:'/leave',
  fields:[f('employmentId','id','never','Handle of the caller\'s employment.'),company,
   f('leaveTypeId','id','never','Handle of the leave type, for the entitlement explainer.'),f('leaveType','label','full','Leave type name.'),
   f('accrued','number','bands','Days accrued this cycle.'),f('taken','number','bands','Days taken.'),f('pending','number','bands','Days awaiting approval.'),
   f('balance','number','bands','Recorded balance.'),f('available','number','bands','Days the caller can still apply for.'),
   f('sharedPoolName','label','minimum','Leave type whose pool this balance draws from.'),f('withheld','boolean','full','Whether ESS visibility hid part of the row.')]},
 {id:'leave_request',label:'Leave request',meaning:'One leave application by the caller, with its status and covered dates.',
  module:'leave',sensitivity:'ordinary',audience:'self',rls:'own_employment',owners:['core/read.ts#myEmployments','core/read.ts#leaveRequestsFor'],
  ruleVersion:null,relations:[{to:'leave_balance',kind:'many_to_one',via:'leaveTypeId'},{to:'leave_approval_step',kind:'one_to_many',via:'leaveRequestId'}],page:'/leave',
  fields:[company,f('leaveTypeId','id','never','Handle of the leave type.'),screened('leaveType','full','Leave type name.'),
   f('status','enum','full','Where the application stands.',{values:LEAVE_STATUS}),f('startDate','date','minimum','First day.'),f('endDate','date','minimum','Last day.'),
   f('days','number','minimum','Day quantity recorded.'),f('hours','number','minimum','Hour quantity for hourly leave.'),
   f('durationType','enum','full','Full day, half day or hours.',{values:['full_day','first_half','second_half','hours']}),
   f('fromTime','time','minimum','Start time for hourly leave.'),f('toTime','time','minimum','End time for hourly leave.'),
   f('reason','text','never','Free text the person typed.'),f('employeeRemark','text','never','Free text the person typed.'),
   f('workingDates','list','minimum','Working days the application covers.'),f('hasDocument','boolean','full','Whether a document is attached.'),
   f('hasRejectedDates','boolean','full','Whether some dates were rejected.')]},
 {id:'leave_entitlement',label:'Leave entitlement',meaning:'How one of the caller\'s own entitlements was arrived at for the current cycle.',
  module:'leave',sensitivity:'ordinary',audience:'self',rls:'own_employment',owners:['core/read.ts#myEmployments','core/read.ts#leaveEntitlementBreakdown','core/assistant-leave-projection.ts#projectMineLeaveEntitlement'],
  // Entitlement tables are versioned lineages (core/entitlement-template.ts), but the breakdown does not
  // yet return the version it resolved; the proposal and outcome record cannot cite it until it does.
  ruleVersion:null,relations:[{to:'leave_balance',kind:'many_to_one',via:'leaveTypeId'}],page:'/leave',
  fields:[f('employmentId','id','never','Handle of the caller\'s employment.'),company,f('leaveType','label','full','Leave type name.'),
   f('cycleStart','date','minimum','Start of the current cycle.'),f('entitlementStatus','enum','full','Whether an eligibility rule matched.'),
   f('entitlementTemplateName','label','minimum','Entitlement table that applied.'),f('eligibility','object','minimum','Which rule did not match, when none did.'),
   f('displayEntitlementDays','number','bands','Entitlement for the cycle.'),f('broughtForward','number','bands','Days carried in.'),
   f('adjustments','number','bands','Adjustments this cycle.'),f('totalEntitlement','number','bands','Total entitlement.'),
   f('takenThisCycle','number','bands','Days taken this cycle.'),f('pendingApproval','number','bands','Days awaiting approval.'),
   f('forfeitedThisCycle','number','bands','Days forfeited.'),f('carryForwardExpiryDate','date','minimum','When carried days expire.'),
   f('totalAvailable','number','bands','Days available.'),f('withheld','boolean','full','Whether ESS visibility hid part of the breakdown.'),
   f('transactions','list','minimum','Recent ledger rows behind the figure.',{of:[f('effectiveOn','date','minimum','Ledger date.'),f('entryType','enum','full','Ledger entry kind.'),
    f('days','number','bands','Day quantity.'),f('sourceRequestId','id','never','Handle of the leave request.'),f('reason','text','never','Free text recorded on the entry.')]}),
   // Step 4: the breakdown fields the Mine projection already returns (run 41302596155). The caller's own day
   // counts, like displayEntitlementDays and totalAvailable, so they are bands.
   f('eligibleDays','number','bands','Full-year allowance of the entitlement table that applied, before proration, carry, adjustments or use.'),
   f('currentYearEntitlement','number','bands','Earned to date this cycle, exact.'),f('currentYearEntitlementRounded','number','bands','Earned to date as the leave type\'s rounding shows it.'),
   f('monthlyAccruedToDate','number','bands','Earned leave only: accrued to date this cycle.'),f('carriedForward','number','bands','Days carried into the cycle, after the carry cap.'),
   f('carryForwardRemaining','number','bands','Carried days not yet used.'),f('configAdjustments','number','bands','HR\'s own adjustments this cycle.'),
   f('systemAdjustments','number','bands','Automatic corrections this cycle.'),f('balance','number','bands','Ledger balance as at the date asked.')]},
 {id:'public_holiday',label:'Public holiday',meaning:'A public holiday the caller actually observes under their company, work state and calendar.',
  module:'org',sensitivity:'ordinary',audience:'self',rls:'own_holiday_calendar',owners:['core/read.ts#myEmployment','core/read.ts#upcomingHolidays','core/read.ts#holidayDatesForEmployment'],
  ruleVersion:null,relations:[],page:'/leave',
  fields:[f('employmentId','id','never','Handle of the caller\'s employment.'),f('date','date','full','Holiday date.'),f('name','label','full','Holiday name.')]},
 {id:'absence',label:'Planned absence',meaning:'Approved or pending leave of people the caller may see, in a bounded window.',
  module:'leave',sensitivity:'ordinary',audience:'visible_scope',rls:'visible_employments',owners:['core/read.ts#plannedAbsences','core/read.ts#awayTodayCount'],
  ruleVersion:null,relations:[{to:'employment_profile',kind:'many_to_one',via:'employmentIds'}],page:'/leave',
  fields:[f('personName','name','minimum','Name of the person away.'),f('employeeCode','code','never','Employee code.'),f('employmentIds','list','never','Handles of the person\'s employments.'),
   f('personCount','integer','bands','How many people are away when the list is too long.'),f('approvedOnFromDate','integer','bands','How many are away on the first day.'),
   f('absences','list','minimum','Each absence in the window.',{of:[screened('leaveType','full','Leave type name.'),f('status','enum','full','Approval status.',{values:LEAVE_STATUS}),
    f('startDate','date','minimum','First day.'),f('endDate','date','minimum','Last day.'),f('days','number','minimum','Day quantity.'),f('hours','number','minimum','Hour quantity.')]})]},
 {id:'team_leave_balance',label:'Team member leave balance',meaning:'Balances and pending counts for one person who reports to the caller.',
  module:'leave',sensitivity:'ordinary',audience:'manager',rls:'reporting_subordinates',owners:['core/read.ts#subordinateLeaveSummary'],
  ruleVersion:null,relations:[{to:'employment_profile',kind:'many_to_one',via:'employmentId'}],page:'/leave',
  fields:[f('employmentId','id','never','Handle of the report\'s employment.'),f('leaveTypeId','id','never','Handle of the leave type.'),screened('leaveType','full','Leave type name.'),
   f('balance','number','bands','Recorded balance.'),f('pendingCount','integer','minimum','Applications awaiting approval (a count, not days).'),
   f('upcomingFrom','date','minimum','Start of the next approved leave.'),f('upcomingTo','date','minimum','End of the next approved leave.')]},
 {id:'employment_profile',label:'Employment record',meaning:'Work-record details of one employee the caller may see; never personal particulars.',
  module:'employees',sensitivity:'identity',audience:'visible_scope',rls:'visible_employments',owners:['core/read.ts#employeeDetail'],
  ruleVersion:null,relations:[{to:'reporting_line',kind:'one_to_many',via:'employmentId'}],page:'/personnel',
  fields:[f('employmentId','id','never','Handle of the employment.'),f('employeeCode','code','never','Employee code.'),f('name','name','minimum','Employee name.'),company,
   f('gradeName','label','minimum','Job grade.'),f('holidayGroupName','label','full','Holiday calendar.'),f('workState','label','full','Work state.'),
   f('hiredOn','date','minimum','Hire date.'),f('joinDate','date','minimum','Join date.'),f('terminatedOn','date','minimum','Termination date, if ended.')]},
 {id:'reporting_line',label:'Reporting line',meaning:'Who the caller reports to and who reports to them, as of today.',
  module:'org',sensitivity:'ordinary',audience:'self',rls:'own_employment',owners:['core/read.ts#myEmployment','core/read.ts#reportingLinesFor'],
  ruleVersion:null,relations:[{to:'employment_profile',kind:'many_to_one',via:'employmentId'}],page:'/org',
  fields:[f('employmentId','id','never','Handle of the caller\'s employment.'),
   f('managers','list','minimum','Current reporting managers.',{of:[f('name','name','minimum','Manager name.'),f('employeeCode','code','never','Employee code.'),f('lineType','enum','full','Kind of reporting line.')]}),
   f('reports','list','minimum','Current direct reports.',{of:[f('name','name','minimum','Report name.'),f('employmentId','id','never','Handle of the report\'s employment.'),f('lineType','enum','full','Kind of reporting line.')]})]},
 {id:'payslip',label:'Payslip',meaning:'Headline figures of the caller\'s own released payslips.',
  module:'payroll',sensitivity:'pay',audience:'self',rls:'own_person',owners:['core/read.ts#myEmploymentIdsAll','core/read.ts#myPayslips'],
  // Statutory rates are country-pack rules, but a payslip row does not carry the rule version that produced it.
  ruleVersion:null,relations:[{to:'pay_change',kind:'one_to_many',via:'payPeriod'}],page:'/me/payslip',
  fields:[f('payPeriod','period','full','Pay period.'),company,f('runType','enum','full','Regular or off-cycle run.'),
   f('gross','number','bands','Gross pay.'),f('deductions','number','bands','Total deductions.'),f('net','number','bands','Net pay.')]},
 {id:'pay_change',label:'Pay change',meaning:'Why the caller\'s own take-home pay changed between two released periods, already calculated.',
  module:'payroll',sensitivity:'pay',audience:'self',rls:'own_person',owners:['core/read.ts#myEmploymentIdsAll','core/read.ts#myPayslips','core/payslip-earning-lines.ts#storedComponentLines'],
  ruleVersion:null,relations:[{to:'payslip',kind:'many_to_one',via:'payPeriod'}],page:'/me/payslip',
  fields:[f('period','period','full','Period explained.'),f('previousPeriod','period','full','Period compared against.'),
   f('gross','object','bands','Gross now, before and the difference.'),f('deductions','object','bands','Deductions now, before and the difference.'),f('net','object','bands','Net now, before and the difference.'),
   f('lines','list','minimum','Pay items that moved.',{of:[screened('code','minimum','Pay item code.'),screened('name','minimum','Pay item name.'),
    f('current','number','bands','Amount this period.'),f('previous','number','bands','Amount last period.'),f('change','number','bands','Difference.')]})]},
 {id:'claim_status',label:'Claim status',meaning:'The caller\'s own latest expense claim statuses; never amounts or receipts.',
  module:'claims',sensitivity:'ordinary',audience:'self',rls:'own_person',owners:['packs/claims/service.ts#ownClaimStatuses'],
  ruleVersion:null,relations:[],page:'/claims',
  fields:[f('id','id','never','Handle of the claim.'),f('employmentId','id','never','Handle of the employment.'),screened('claimType','full','Claim type name.'),
   f('status','enum','full','Where the claim stands.'),f('incurredOn','date','minimum','Date incurred.'),f('createdAt','datetime','minimum','When the record was created.'),
   f('decidedAt','datetime','minimum','When it was decided.'),f('paidAt','datetime','minimum','When it was paid.')]},
 {id:'module_work',label:'Module work',meaning:'One module\'s current-caller canonical work summary, with the pages a person uses to act.',
  module:null,sensitivity:'pay',audience:'self',rls:'own_module_scope',owners:['core/module-agent-readers.ts#createModuleAgentReaders','lib/ai/module-specialists.ts#compactSpecialistWork'],
  ruleVersion:null,relations:[],page:'/assistant',
  fields:[f('module','enum','full','The module read.'),f('data','list','minimum','Module-owned rows; only the declared row fields leave. Pay and day figures are released as bands.',{of:MODULE_ROW_FIELDS}),
   f('specialistWork','object','minimum','Deterministic findings over the rows; never an effect.'),f('humanActions','list','full','Fixed pages for human review.')]},
 {id:'leave_approval_step',label:'Leave approval step',meaning:'One pending step of a leave request assigned to the caller to decide.',
  module:'approvals',sensitivity:'ordinary',audience:'assigned_approver',rls:'assigned_request',owners:['core/assistant-actions/reviewed-leave-decision-source.ts#assertReviewedLeaveDecisionActorTx'],
  ruleVersion:null,relations:[{to:'leave_request',kind:'many_to_one',via:'leaveRequestId'}],page:'/approvals',
  fields:[f('leaveRequestId','id','never','Handle of the request.'),f('currentStepId','id','never','Handle of the step.'),
   f('decision','enum','minimum','The approver\'s decision.',{values:['approve','reject']}),f('rejectReason','text','never','Free text the approver typed.')]},
 // AI v2 W2: one own attendance request (a clock correction or an overtime request), filed for the existing approval.
 {id:'attendance_request',label:'Attendance request',meaning:'One request by the caller to correct their own attendance day or to work overtime, sent for the existing approval.',
  module:'attendance',sensitivity:'ordinary',audience:'self',rls:'own_employment',owners:['core/read.ts#myEmployment','packs/attendance/service.ts#attendanceForEmploymentRange','packs/attendance/service.ts#myAttendanceCorrections'],
  ruleVersion:null,relations:[],page:'/attendance/requests',
  fields:[f('employmentId','id','never','Handle of the caller\'s employment.'),f('date','date','minimum','Attendance day.'),
   f('checkIn','time','minimum','Clock-in asked for.'),f('checkOut','time','minimum','Clock-out asked for.'),
   f('recordedCheckIn','time','minimum','Clock-in on record.'),f('recordedCheckOut','time','minimum','Clock-out on record.'),
   f('plannedStartTime','time','minimum','Overtime start.'),f('plannedEndTime','time','minimum','Overtime end.'),
   f('requestedOtMinutes','integer','minimum','Overtime minutes, as the attendance service counted the window.'),
   f('status','enum','full','Where the request stands.',{values:['pending','approved','rejected','cancelled']}),
   f('reason','text','never','Free text the person typed.'),f('remark','text','never','Free text the person typed.')]},
 // AI v2 W2: own claims and own profile changes prepared in chat.
 ...OWN_CHANGE_ENTITIES,
 // AI v2 W2 (slice 2): the own Leave Credit request (time off in lieu) prepared in chat.
 ...TOIL_ENTITIES,
] satisfies SemanticEntity[]);

/** One declaration per Assistant read, in ASSISTANT_TOOLS order. Input schemas are the catalogue's own. */
const limit=(maximum:number,description?:string)=>({type:'integer',minimum:1,maximum,...(description?{description}:{})});
const isoDate=(description:string)=>({type:'string',description});
const handle=(description:string)=>({type:'string',description});
export const SEMANTIC_READS:readonly SemanticRead[]=freeze([
 {name:'my_leave_balances',entity:'leave_balance',purpose:'The asking person\'s own leave balances, one block per active employment.',input:[]},
 {name:'my_leave_requests',entity:'leave_request',purpose:'The asking person\'s own leave applications (requests they made), most recent first. Not requests waiting for their approval: those are approval_queue.',
  input:[{name:'limit',identifier:false,schema:limit(25,'How many of the most recent applications to return.')}]},
 {name:'leave_entitlement_explain',entity:'leave_entitlement',purpose:'How one of the asking person\'s own entitlements was arrived at; every figure is already computed.',
  input:[{name:'leave_type_id',identifier:true,schema:handle('A leaveTypeId taken from a my_leave_balances result. Do not guess one.')},
   {name:'as_of',identifier:false,schema:isoDate('The date to explain the figure as at, YYYY-MM-DD.')}]},
 {name:'upcoming_holidays',entity:'public_holiday',purpose:'Public holidays the asking person actually observes, earliest first.',
  input:[{name:'from',identifier:false,schema:isoDate('The earliest date to consider, YYYY-MM-DD.')},{name:'limit',identifier:false,schema:limit(20,'How many holidays to return.')}]},
 {name:'who_is_away',entity:'absence',purpose:'Who among the people the asking person may see is on approved or pending leave in a window of 62 days or less.',
  input:[{name:'from',identifier:false,schema:isoDate('Start of the window, inclusive, YYYY-MM-DD.')},{name:'to',identifier:false,schema:isoDate('End of the window, inclusive, YYYY-MM-DD.')}]},
 {name:'team_leave_summary',entity:'team_leave_balance',purpose:'Leave balances and pending-application counts for one person who reports to the asking person.',
  input:[{name:'employment_id',identifier:true,schema:handle('An employmentId from a previous tool result. Do not guess one.')}]},
 {name:'employee_profile',entity:'employment_profile',purpose:'Work-record details for one employee the asking person may see; never personal particulars.',
  input:[{name:'employment_id',identifier:true,schema:handle('An employmentId from a previous tool result. Do not guess one.')}]},
 {name:'my_reporting_line',entity:'reporting_line',purpose:'Who the asking person reports to, and who reports to them.',input:[]},
 {name:'my_payslip_summary',entity:'payslip',purpose:'Headline figures from the asking person\'s own released payslips, most recent first.',
  input:[{name:'limit',identifier:false,schema:limit(12,'How many recent payslips to return.')}]},
 {name:'my_pay_change',entity:'pay_change',purpose:'Why the asking person\'s own take-home pay changed against the previous released period, already calculated.',
  input:[{name:'period',identifier:false,schema:{type:'string',pattern:'^\\d{4}-\\d{2}$',description:'The pay period to explain, as YYYY-MM. It is compared against the previous released period.'}}]},
 {name:'my_claim_statuses',entity:'claim_status',purpose:'The asking person\'s own latest claim statuses.',input:[{name:'limit',identifier:false,schema:limit(25)}]},
 {name:'my_module_work',entity:'module_work',purpose:'One current-caller module work summary, with fixed pages for human review.',
  input:[{name:'module',identifier:false,schema:{type:'string',enum:[...AGENT_MODULE_CODES]}}]},
] satisfies SemanticRead[]);

/** The three leave cards of ADR-0170 step 2. Each mirrors its agent action registry entry (pinned by test). */
const actorCheck={check:'actor_current',owner:'core/assistant-actions/own-leave-actor.ts#readOwnLeaveActorTx',ruleVersion:null} as const;
const aiControls={check:'ai_controls_unpaused',owner:'core/ai-governance.ts#assertAiActionUnpausedTx',ruleVersion:null} as const;
export const SEMANTIC_ACTIONS:readonly SemanticAction[]=freeze([
 {id:'leave.apply',entity:'leave_request',effect:'create',module:'leave',purpose:'Apply for one full day of annual leave for yourself.',
  audience:'self',actor:'self',service:'packs/leave/service.ts#requestLeave',guard:'core/assistant-actions/own-leave-actor.ts#readOwnLeaveActorTx',
  preparer:'core/assistant-actions/own-leave-store.ts#prepareOwnLeaveReviewTx',
  checks:[actorCheck,aiControls,
   {check:'leave_type_eligible',owner:'core/read.ts#listEligibleLeaveTypesFor',ruleVersion:null},
   {check:'deduction_and_balance',owner:'packs/leave/service.ts#previewLeaveDeduction',ruleVersion:null},
   {check:'review_contract',owner:'core/assistant-actions/own-leave-review-digest.ts#ownLeaveReviewedDigest',ruleVersion:'lib/assistant-actions/own-leave-contract.ts#OWN_LEAVE_CONTRACT_VERSION'}],
  reviewRoute:'/assistant/leave',humanInputs:['employmentId','leaveTypeId','reason','employeeRemark'],
  nominable:[{name:'date',optional:false,type:'date'}],proposal:'core/proposals/leave-apply.ts#prepareLeaveApplyProposal'},
 {id:'approvals.leave.decide',entity:'leave_approval_step',effect:'decide',module:'approvals',purpose:'Review leave requests waiting for your approval.',
  audience:'assigned_approver',actor:'assigned_approver',service:'packs/leave/service.ts#decideLeave',
  guard:'core/assistant-actions/reviewed-leave-decision-source.ts#assertReviewedLeaveDecisionActorTx',
  preparer:'core/assistant-actions/reviewed-leave-decision-source.ts#prepareReviewedLeaveDecisionSourceTx',
  checks:[aiControls,{check:'assigned_step_current',owner:'core/assistant-actions/reviewed-leave-decision-source.ts#assertReviewedLeaveDecisionActorTx',ruleVersion:null}],
  reviewRoute:'/assistant/approvals',humanInputs:['leaveRequestId','currentStepId','decision','rejectReason','confirmAssignedDecision'],
  nominable:[],proposal:'core/proposals/leave-decide.ts#prepareLeaveDecideProposal'},
 {id:'leave.cancel',entity:'leave_request',effect:'withdraw',module:'leave',purpose:'Cancel one of your own pending leave requests, or ask to give back dates of approved leave.',
  audience:'self',actor:'self',service:'packs/leave/service.ts#cancelOwnLeaveTx',guard:'core/assistant-actions/own-leave-change-source.ts#withOwnLeaveChangeSubjectTx',
  preparer:'core/assistant-actions/own-leave-change-source.ts#prepareOwnLeaveCancellationSourceTx',
  // A pending request uses the first two; approved leave (step 2) is offered through the native /leave give-back
  // path and uses the actor, the AI controls and the native offer (core/proposals/leave-cancel.ts).
  checks:[aiControls,{check:'own_pending_request',owner:'core/assistant-actions/own-leave-change-source.ts#withOwnLeaveChangeSubjectTx',ruleVersion:null},
   actorCheck,{check:'own_approved_cancellable',owner:'core/read.ts#employeeCancelOffers',ruleVersion:null}],
  reviewRoute:'/assistant/leave',humanInputs:['employmentId','leaveRequestId','cancel'],
  nominable:[{name:'startDate',optional:true,type:'date'}],proposal:'core/proposals/leave-cancel.ts#prepareLeaveCancelProposal'},
 // AI v2 W2: own attendance requests prepared from chat. The attendance service decides; the approval route is ADR-0121's.
 {id:'attendance.correction.request',entity:'attendance_request',effect:'create',module:'attendance',purpose:'Ask to correct your own clock-in or clock-out on a past day.',
  audience:'self',actor:'self',service:'packs/attendance/service.ts#requestAttendanceCorrection',guard:'core/assistant-actions/own-attendance-correction-source.ts#assertOwnAttendanceCorrectionActorTx',
  preparer:'core/assistant-actions/own-attendance-correction-source.ts#prepareOwnAttendanceCorrectionTx',
  checks:[{check:'actor_current',owner:'core/assistant-actions/own-attendance-correction-source.ts#assertOwnAttendanceCorrectionActorTx',ruleVersion:null},aiControls,
   {check:'attendance_day_read',owner:'packs/attendance/service.ts#attendanceForEmploymentRange',ruleVersion:null},
   {check:'attendance_request_rules',owner:'packs/attendance/service.ts#prepareAttendanceCorrectionRequestTx',ruleVersion:null},
   {check:'approval_route',owner:'packs/attendance/service.ts#prepareAttendanceWorkflowSnapshotTx',ruleVersion:null}],
  reviewRoute:'/assistant/attendance',humanInputs:['employmentId','date','checkIn','checkOut','requestedOtMinutes','plannedStartTime','plannedEndTime','otReasonCategory','reason','remark','requestKind','clockChanges','unclockedWork'],
  nominable:[{name:'date',optional:false,type:'date'}],proposal:'core/proposals/attendance-request.ts#prepareChatAttendanceCorrectionProposal'},
 {id:'attendance.overtime.request',entity:'attendance_request',effect:'create',module:'attendance',purpose:'Request overtime for yourself on one date, for a start and end time.',
  audience:'self',actor:'self',service:'packs/attendance/service.ts#requestAttendanceCorrectionTx',guard:'core/assistant-actions/own-overtime-request-source.ts#withOwnOvertimeSubjectTx',
  preparer:'core/assistant-actions/own-overtime-request-source.ts#prepareOwnOvertimeSourceTx',
  checks:[actorCheck,aiControls,
   {check:'attendance_request_rules',owner:'packs/attendance/service.ts#prepareAttendanceCorrectionRequestTx',ruleVersion:null},
   {check:'approval_route',owner:'packs/attendance/service.ts#prepareAttendanceWorkflowSnapshotTx',ruleVersion:null}],
  reviewRoute:'/assistant/attendance',humanInputs:['employmentId','date','plannedStartTime','plannedEndTime','reason','remark'],
  nominable:[{name:'date',optional:false,type:'date'}],proposal:'core/proposals/attendance-request.ts#prepareChatOvertimeRequestProposal'},
 // AI v2 W2: claims.submit, claims.cancel and ess.profile.request (./entities-own-changes.ts).
 ...OWN_CHANGE_ACTIONS,
 // AI v2 W2 (slice 2): toil.replacement.request (./entities-toil.ts).
 ...TOIL_ACTIONS,
] satisfies SemanticAction[]);

export const semanticEntity=(id:string):SemanticEntity=>{const entity=SEMANTIC_ENTITIES.find(row=>row.id===id);if(!entity)throw Error('Unknown semantic entity.');return entity;};
