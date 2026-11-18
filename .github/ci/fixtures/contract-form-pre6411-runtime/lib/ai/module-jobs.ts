/** Actual named user jobs, each bound to an explicit canonical module capability. Discovery is not authority. */
import type {AgentModuleCode} from './module-agents';
export const MODULE_JOBS=[
 ['employees','personal'],['org','personal'],['leave','personal'],['ess','personal'],['payroll','personal'],['attendance','personal'],
 ['claims','workflow'],['approvals','workflow'],['performance','workflow'],['lifecycle','workflow'],['toil','workflow'],['notifications','workflow'],
 ['knowledge_base','personal'],['country-my','personal'],['multi_cycle_payroll','personal'],['typed_pay_components','personal'],
 ['rewards','operations'],['system_explorer','operations'],['system_testing','operations'],['assistant','personal'],
] as const satisfies readonly (readonly [AgentModuleCode,'personal'|'workflow'|'operations'])[];
export const JOB_FACT_FIELDS=['personCount','approvedOnFromDate','grade','holidayCalendar','workState','joinDate','relationship','leaveType','displayEntitlementDays','earnedEntitlement','broughtForward','adjustments','totalEntitlement','forfeited','asOf','cycleStart','employeeCode','company','hiredOn','terminatedOn','workStatus','manager','reportingKind','available','taken','pending','period','status',
 'hasRejectedDates','from','to','hours','durationType','days','date','workedMinutes','otMinutes','gross','deductions','net','currency','runType','runSequence','cycle','claimType','incurredOn','createdAt','decidedAt','paidAt',
 'framework','artifact','released','periodEnd','rewardKind','year','revision','progressDone','progressTotal','progressPercent','completed','activeCredit','usedCredit','expiredCredit','payConvertedCredit',
 'creditUnit','expiry','credited','remaining','notificationReadAt','notificationCreated','table','module','withheldTables','testCase','testingInstructionVersion','lastOutcome','lastRun','runCount',
 'amount','itemCode','category','rewardUnit','gapCount','readyRecords','checkedRecords','blockingEffect','capability','backgroundAgentsTotal','backgroundAgentSwitchesOn','backgroundAgentEffectiveSwitchesOn'] as const;
export type JobFactField=typeof JOB_FACT_FIELDS[number];
export type JobFact=Readonly<{field:JobFactField;value:string|number|boolean|null;format:'text'|'number'|'date'|'status'|'boolean'|'money'|'module'|'gap'|'blocks'|'performanceFramework'|'performanceArtifact'|'testingStatus'}>;
export type JobCard=Readonly<{title:Readonly<{kind:'text';value:string}|{kind:'record';number:number}|{kind:'gap';code:string}|{kind:'module';module:AgentModuleCode}>;
 facts:readonly JobFact[];href?:string;linkPurpose?:'human_review';withheld?:boolean}>;
export type JobPresentation=Readonly<{module:AgentModuleCode;cards:readonly JobCard[];truncated:boolean;hasEmployment?:boolean}>;
