/** ADR-0170 §3.13 and §3.8, step 5 — the agent registry: every automated worker, one contract.
 *
 * Every worker belongs to exactly one of five families and declares, in code:
 *  - a deterministic trigger (schedule, event or request);
 *  - its read scope, as entity ids of the semantic model (checked against terasEntities());
 *  - its declared effect (none, notify, prepare, complete under a mandate);
 *  - the authority it runs under (a tenant switch, or a mandate of a named job type);
 *  - its per-tenant switch, off by default: an EXISTING switch where the worker already has one (a tenant
 *    setting, the AI provider, or job-type enablement for mandates), or a row in teras_worker_control
 *    (migration 0895) for a worker with none. Never a second switch for the same worker;
 *  - whether its run path honours the tenant-wide stop switch today (teras_mandate_control.stopped);
 *  - where each run is recorded (outcome record, agent proposal ledger or domain events);
 *  - how its acceptance and reversal are measured, reusing the Control Tower agreement view.
 * A declaration missing any of these, or inconsistent with its family, is refused here; the registry does not
 * load with it, and workerRunGate (./controls.ts) refuses any worker id not in the loaded registry.
 *
 * The existing chasers, nudges, triage and the narrator live in the approved provider closure, so their run
 * paths cannot consult the stop switch in this step without a fresh approval of that closure. They are
 * declared with `stop.honoured:false` and the reason, and the registry view says so; nothing pretends they stop.
 * No React, no route: read services are in ./views.ts. Not imported by the production Assistant. */
import type {AgentFeature} from '../agent-principal';
import type {ProposalTypeId} from '../agent-proposal';
import type {WorkJobType} from '../mandates/job-types';
import {TERAS_READS,terasEntities} from '../semantic-model/generate';
import {SEMANTIC_READS} from '../semantic-model/entities';
import {WORKER_EFFECTS,WORKER_FAMILIES} from '../semantic-model/entities-recommend';
import type {EntityId,OwnerAnchor} from '../semantic-model/types';
import type {TerasSwitchedWorker} from '../../db/teras-schema';

export type WorkerFamily=(typeof WORKER_FAMILIES)[number];
export type WorkerEffect=(typeof WORKER_EFFECTS)[number];
export type WorkerTrigger=Readonly<{kind:'schedule'|'event'|'request';detail:string}>;
/** Whose authority a run uses. `requester`: the person who asked, under their own login; `agent_principal`: the
 * tenant's named agent principal (ADR-0151); `mandate`: the agent acting FOR a grantor (§3.10). */
export type WorkerAuthority=Readonly<{kind:'tenant_switch';actsAs:'requester'|'agent_principal'}>|Readonly<{kind:'mandate';jobType:WorkJobType}>;
export type WorkerSwitch=
 |Readonly<{kind:'tenant_setting';feature:AgentFeature}>
 |Readonly<{kind:'ai_provider';feature:'payroll_explanation'}>
 |Readonly<{kind:'job_type';jobType:WorkJobType}>
 |Readonly<{kind:'worker_control';workerId:TerasSwitchedWorker}>;
export type WorkerStop=Readonly<{honoured:true}>|Readonly<{honoured:false;pending:string}>;
export type WorkerRecord=
 |Readonly<{kind:'outcome_record';agentIdentity:string;tools?:readonly string[]}>
 |Readonly<{kind:'mandate_runs';jobType:WorkJobType}>
 |Readonly<{kind:'agent_proposal';proposalTypes:readonly ProposalTypeId[]}>
 |Readonly<{kind:'domain_event';eventType:string;source?:string}>
 // AI v2 W8: a loop records each run in teras_loop_run (migration 0960), its outcome record.
 |Readonly<{kind:'loop_runs'}>;
export type WorkerMetrics=
 |Readonly<{kind:'agreement_view';proposalTypes:readonly ProposalTypeId[]}>
 |Readonly<{kind:'outcome_followups'}>
 |Readonly<{kind:'not_measurable';reason:string}>
 // AI v2 W8: a loop's cards are measured from its cases: completed as prepared, or changed by the person. Only a card
 // that proposes a value of its own (the clock-out time) can be changed; the others are not measurable that way.
 |Readonly<{kind:'loop_cases';proposesValue:boolean}>;
/** AI v2 W8: who answers for a loop. `switched_on_by`: the group administrator who switched it on; the loop reads under
 * that person's current authority and stops when they lose it. */
export type WorkerSponsor=Readonly<{kind:'switched_on_by'}>;
export type WorkerDeclaration=Readonly<{id:string;label:string;family:WorkerFamily;owners:readonly OwnerAnchor[];trigger:WorkerTrigger;
 readScope:readonly EntityId[];effect:WorkerEffect;authority:WorkerAuthority;switch:WorkerSwitch;stop:WorkerStop;record:WorkerRecord;metrics:WorkerMetrics;
 sponsor?:WorkerSponsor}>;

export class WorkerNotRegistrable extends Error{constructor(readonly id:string,readonly missing:readonly string[]){super(`Worker ${id} cannot be registered: ${missing.join(', ')}`);this.name='WorkerNotRegistrable';}}

const FIELDS=['id','label','family','owners','trigger','readScope','effect','authority','switch','stop','record','metrics'] as const;
/** Effects each family may declare (§3.13): watchers and chasers notify at most, preparers prepare, deciders
 * complete only under a mandate, explainers change nothing. */
const FAMILY_EFFECTS:Readonly<Record<WorkerFamily,readonly WorkerEffect[]>>={watcher:['none','notify'],chaser:['notify'],preparer:['prepare'],decider:['complete_under_mandate'],explainer:['none']};
const nonEmpty=(value:unknown)=>typeof value==='string'?value.trim().length>0:Array.isArray(value)?value.length>0:value!==null&&typeof value==='object';

/** The contract check. Returns the problems; empty means the worker may be registered. */
export function workerDeclarationProblems(value:unknown):readonly string[]{
 if(!value||typeof value!=='object')return['declaration'];
 const decl=value as Partial<Record<(typeof FIELDS)[number],unknown>>;
 const missing:string[]=FIELDS.filter(field=>!nonEmpty(decl[field]));
 if(missing.length)return missing;
 const d=value as WorkerDeclaration,problems:string[]=[];
 if(!/^[a-z][a-z0-9_]{1,62}$/.test(d.id))problems.push('id');
 if(!(WORKER_FAMILIES as readonly string[]).includes(d.family))problems.push('family');
 if(!(WORKER_EFFECTS as readonly string[]).includes(d.effect)||!FAMILY_EFFECTS[d.family]?.includes(d.effect))problems.push('effect');
 if(!['schedule','event','request'].includes(d.trigger.kind)||!nonEmpty(d.trigger.detail))problems.push('trigger');
 const known=new Set(terasEntities().map(entity=>entity.id));
 if(d.readScope.some(entity=>!known.has(entity)))problems.push('readScope');
 if(d.owners.some(anchor=>!/^[a-z0-9_./-]+\.ts#[A-Za-z_][A-Za-z0-9_]*$/.test(anchor)))problems.push('owners');
 // A decider completes only under a mandate; a mandate worker is switched by its job type and recorded per run.
 if(d.effect==='complete_under_mandate'&&d.authority.kind!=='mandate')problems.push('authority');
 if(d.authority.kind==='mandate'&&(d.switch.kind!=='job_type'||d.switch.jobType!==d.authority.jobType||d.record.kind!=='mandate_runs'))problems.push('switch');
 if(d.stop.honoured===false&&!nonEmpty(d.stop.pending))problems.push('stop');
 if(d.metrics.kind==='not_measurable'&&!nonEmpty(d.metrics.reason))problems.push('metrics');
 // AI v2 W8: a loop prepares only, as the agent principal behind its own registry switch, honours the stop switch,
 // names its sponsor and is measured from its cases. A sponsor is declared only by a loop.
 const loop=d.record.kind==='loop_runs';
 if(loop&&(d.family!=='preparer'||d.effect!=='prepare'||d.authority.kind!=='tenant_switch'||d.authority.actsAs!=='agent_principal'
  ||d.switch.kind!=='worker_control'||d.switch.workerId!==d.id||d.stop.honoured!==true||d.metrics.kind!=='loop_cases'))problems.push('loop');
 if(loop!==(d.sponsor?.kind==='switched_on_by'))problems.push('sponsor');
 if(!loop&&d.metrics.kind==='loop_cases')problems.push('metrics');
 return problems;
}
export function assertWorkerDeclaration(value:unknown):asserts value is WorkerDeclaration{
 const problems=workerDeclarationProblems(value);
 if(problems.length)throw new WorkerNotRegistrable(typeof (value as {id?:unknown})?.id==='string'?(value as {id:string}).id:'unknown',problems);
}

const CLOSURE_PENDING='Its run path is in the approved provider closure; it consults the stop switch once that closure is next approved. Until then use its own switch.';
const NIGHTLY:WorkerTrigger={kind:'schedule',detail:'Nightly sweep'};
const LOOP_NIGHTLY:WorkerTrigger={kind:'schedule',detail:'Nightly sweep, for each company in scope'};
/** AI v2 P2-2a: the Pre-salary loop checks each company at its own interval (hourly, twice daily or daily). */
const LOOP_PAYROLL_INTERVAL:WorkerTrigger={kind:'schedule',detail:'Each company at its own interval: hourly, twice daily or daily'};

const DECLARATIONS:readonly WorkerDeclaration[]=[
 {id:'payroll_anomaly_narrator',label:'Payroll anomaly narrator',family:'explainer',owners:['core/payroll-anomaly-narrate.ts#narrateVerdict'],
  trigger:{kind:'request',detail:'An operator opens a payroll anomaly'},readScope:['payroll_anomaly'],effect:'none',
  authority:{kind:'tenant_switch',actsAs:'requester'},switch:{kind:'ai_provider',feature:'payroll_explanation'},stop:{honoured:false,pending:CLOSURE_PENDING},
  record:{kind:'agent_proposal',proposalTypes:['anomaly_narration']},metrics:{kind:'agreement_view',proposalTypes:['anomaly_narration']}},
 {id:'claims_triage',label:'Claims input triage',family:'watcher',owners:['core/input-triage.ts#triagePendingClaims'],
  trigger:NIGHTLY,readScope:['claim_status'],effect:'notify',
  authority:{kind:'tenant_switch',actsAs:'agent_principal'},switch:{kind:'tenant_setting',feature:'claims_triage'},stop:{honoured:false,pending:CLOSURE_PENDING},
  record:{kind:'agent_proposal',proposalTypes:['input_triage']},metrics:{kind:'agreement_view',proposalTypes:['input_triage']}},
 {id:'readiness_nudges',label:'Readiness nudges',family:'chaser',owners:['core/readiness-nudge.ts#sweepReadinessNudges'],
  trigger:NIGHTLY,readScope:['readiness_gap'],effect:'notify',
  authority:{kind:'tenant_switch',actsAs:'agent_principal'},switch:{kind:'tenant_setting',feature:'readiness_reminders'},stop:{honoured:false,pending:CLOSURE_PENDING},
  record:{kind:'agent_proposal',proposalTypes:['readiness_nudge','readiness_fix']},metrics:{kind:'agreement_view',proposalTypes:['readiness_fix']}},
 {id:'approval_chasers',label:'Approval chasers',family:'chaser',owners:['core/automatic-chasers.ts#runApprovalChasers'],
  trigger:NIGHTLY,readScope:['pending_approval'],effect:'notify',
  authority:{kind:'tenant_switch',actsAs:'agent_principal'},switch:{kind:'tenant_setting',feature:'approval_chasers'},stop:{honoured:false,pending:CLOSURE_PENDING},
  record:{kind:'domain_event',eventType:'automatic-chase.approval-raised'},metrics:{kind:'not_measurable',reason:'A reminder has no accept or decline; the item being decided later is not attributable to it.'}},
 {id:'review_chasers',label:'Employment review chasers',family:'chaser',owners:['core/automatic-chasers.ts#runReviewChasers'],
  trigger:NIGHTLY,readScope:['pending_approval'],effect:'notify',
  authority:{kind:'tenant_switch',actsAs:'agent_principal'},switch:{kind:'tenant_setting',feature:'review_chasers'},stop:{honoured:false,pending:CLOSURE_PENDING},
  record:{kind:'domain_event',eventType:'automatic-chase.review-raised'},metrics:{kind:'not_measurable',reason:'A reminder has no accept or decline; the item being decided later is not attributable to it.'}},
 {id:'clock_reminders',label:'Missing clock-in reminders',family:'chaser',owners:['core/automatic-followups.ts#runAutomaticFollowups'],
  trigger:NIGHTLY,readScope:['followup_item'],effect:'notify',
  authority:{kind:'tenant_switch',actsAs:'agent_principal'},switch:{kind:'tenant_setting',feature:'clock_reminders'},stop:{honoured:false,pending:CLOSURE_PENDING},
  record:{kind:'domain_event',eventType:'automatic-chase.followup-raised',source:'missing_clock'},metrics:{kind:'not_measurable',reason:'A reminder has no accept or decline.'}},
 {id:'document_reminders',label:'Passport expiry reminders',family:'chaser',owners:['core/automatic-followups.ts#runAutomaticFollowups'],
  trigger:NIGHTLY,readScope:['followup_item'],effect:'notify',
  authority:{kind:'tenant_switch',actsAs:'agent_principal'},switch:{kind:'tenant_setting',feature:'document_reminders'},stop:{honoured:false,pending:CLOSURE_PENDING},
  record:{kind:'domain_event',eventType:'automatic-chase.followup-raised',source:'passport_expiry'},metrics:{kind:'not_measurable',reason:'A reminder has no accept or decline.'}},
 {id:'lifecycle_chasers',label:'Lifecycle step chasers',family:'chaser',owners:['core/automatic-followups.ts#runAutomaticFollowups'],
  trigger:NIGHTLY,readScope:['followup_item'],effect:'notify',
  authority:{kind:'tenant_switch',actsAs:'agent_principal'},switch:{kind:'tenant_setting',feature:'lifecycle_chasers'},stop:{honoured:false,pending:CLOSURE_PENDING},
  record:{kind:'domain_event',eventType:'automatic-chase.followup-raised',source:'lifecycle_step'},metrics:{kind:'not_measurable',reason:'A reminder has no accept or decline.'}},
 {id:'approver_recommendation',label:'Approver recommendations',family:'explainer',
  owners:['core/recommenders/leave-decision.ts#recommendLeaveDecision'],trigger:{kind:'request',detail:'An approver opens a leave request assigned to them'},
  readScope:['leave_decision_recommendation','leave_approval_step','absence'],effect:'none',
  authority:{kind:'tenant_switch',actsAs:'requester'},switch:{kind:'worker_control',workerId:'approver_recommendation'},stop:{honoured:true},
  record:{kind:'outcome_record',agentIdentity:'worker.approver_recommendation'},metrics:{kind:'outcome_followups'}},
 {id:'explainers',label:'Explainers',family:'explainer',
  owners:['core/explainers/statutory.ts#explainOwnPayslipStatutory','core/explainers/entitlement.ts#explainOwnLeaveEntitlement','core/explainers/attendance.ts#explainOwnAttendanceDay',
   // AI v2 W5: the pay difference and claim limit explainers.
   'core/explainers/pay-difference.ts#explainOwnPayDifference','core/explainers/claim-limit.ts#explainOwnClaimLimit'],
  trigger:{kind:'request',detail:'A person asks the Assistant why a figure is what it is'},
  readScope:['statutory_explanation','entitlement_explanation','attendance_day_explanation','pay_difference_explanation','claim_limit_explanation'],effect:'none',
  authority:{kind:'tenant_switch',actsAs:'requester'},switch:{kind:'worker_control',workerId:'explainers'},
  // Explainers run only inside Noveri conversation turns. The conversation's gate (below) includes the tenant stop
  // switch, so a stopped tenant's chat goes back to the closed grammar and no explainer runs.
  stop:{honoured:true},
  record:{kind:'outcome_record',agentIdentity:'teras.assistant',tools:['explain_payslip_statutory','explain_leave_entitlement','explain_attendance_day','explain_pay_difference','explain_claim_limit']},
  metrics:{kind:'not_measurable',reason:'An explanation has no accept or decline.'}},
 {id:'conversation',label:'Noveri conversation',family:'preparer',
  owners:['core/teras-wiring/turn.ts#runConversationTurn'],trigger:{kind:'request',detail:'A person asks a question in the Assistant chat'},
  // Any read the caller is offered in a turn, and the leave cards it may prepare for the person to confirm.
  readScope:[...new Set([...SEMANTIC_READS,...TERAS_READS].map(read=>read.entity)),'suggested_action','product_capability'],effect:'prepare',
  authority:{kind:'tenant_switch',actsAs:'requester'},switch:{kind:'worker_control',workerId:'conversation'},stop:{honoured:true},
  record:{kind:'outcome_record',agentIdentity:'teras.assistant'},
  metrics:{kind:'not_measurable',reason:'A conversation turn has no accept or decline; each prepared card is decided, and measured, on its own review page.'}},
 {id:'team_absence_weekly_summary',label:'Weekly team absence summary',family:'preparer',owners:['core/mandates/team-absence-summary.ts#teamAbsenceWeeklySummary'],
  trigger:{kind:'schedule',detail:'Weekly, on the weekday the grantor chose'},readScope:['absence'],effect:'prepare',
  authority:{kind:'mandate',jobType:'team_absence_weekly_summary'},switch:{kind:'job_type',jobType:'team_absence_weekly_summary'},stop:{honoured:true},
  record:{kind:'mandate_runs',jobType:'team_absence_weekly_summary'},metrics:{kind:'not_measurable',reason:'A prepared summary completes nothing, so there is nothing to accept or undo.'}},
 {id:'daily_digest',label:'Daily digest',family:'preparer',owners:['core/digest/daily-digest.ts#dailyDigestJob'],
  trigger:{kind:'schedule',detail:'Daily, once each HR day'},readScope:['daily_digest','pending_approval'],effect:'prepare',
  authority:{kind:'mandate',jobType:'daily_digest'},switch:{kind:'job_type',jobType:'daily_digest'},stop:{honoured:true},
  record:{kind:'mandate_runs',jobType:'daily_digest'},metrics:{kind:'not_measurable',reason:'A prepared digest completes nothing, so there is nothing to accept or undo.'}},
 // AI v2 W8: the first five loops, at the Prepare level (core/loops). Each detects through its native owners, prepares a
 // card for the right person, and verifies on its next run whether the work is done. Nothing changes without a person's
 // Confirm on the owner's own page. Run by the nightly sweep (scripts/review-sweep.ts) as the agent principal.
 {id:'loop_probation_ending',label:'Probation ending',family:'preparer',
  owners:['core/loops/probation-ending.ts#detectProbationEnding','core/employment-review.ts#probationDecisionFacts'],
  trigger:LOOP_NIGHTLY,readScope:['employment_profile','pending_approval'],effect:'prepare',
  authority:{kind:'tenant_switch',actsAs:'agent_principal'},switch:{kind:'worker_control',workerId:'loop_probation_ending'},stop:{honoured:true},
  record:{kind:'loop_runs'},metrics:{kind:'loop_cases',proposesValue:false},sponsor:{kind:'switched_on_by'}},
 // AI v2 P2-2a: the Pre-salary loop absorbs the payroll inputs loop (same id): every input check from the start of the
 // period to the cut-off, at each company's own interval.
 {id:'loop_payroll_inputs',label:'Pre-salary loop',family:'preparer',
  owners:['core/loops/payroll-inputs.ts#detectPayrollInputs','core/loops/pre-salary-checks.ts#preSalaryChecks','core/payroll-readiness.ts#payrollReadiness'],
  trigger:LOOP_PAYROLL_INTERVAL,readScope:['setup_copilot','readiness_gap','attendance_request','absence','leave_request','claim_request','pending_approval'],effect:'prepare',
  authority:{kind:'tenant_switch',actsAs:'agent_principal'},switch:{kind:'worker_control',workerId:'loop_payroll_inputs'},stop:{honoured:true},
  record:{kind:'loop_runs'},metrics:{kind:'loop_cases',proposesValue:false},sponsor:{kind:'switched_on_by'}},
 {id:'loop_missing_employee_data',label:'Missing employee data',family:'preparer',
  owners:['core/loops/missing-employee-data.ts#detectMissingEmployeeData','core/record-readiness.ts#readinessSnapshot','core/readiness-actions.ts#loadReadinessActions'],
  trigger:LOOP_NIGHTLY,readScope:['readiness_gap','profile_change_request'],effect:'prepare',
  authority:{kind:'tenant_switch',actsAs:'agent_principal'},switch:{kind:'worker_control',workerId:'loop_missing_employee_data'},stop:{honoured:true},
  record:{kind:'loop_runs'},metrics:{kind:'loop_cases',proposesValue:false},sponsor:{kind:'switched_on_by'}},
 {id:'loop_missed_clock_outs',label:'Missed clock-outs',family:'preparer',
  owners:['core/loops/missed-clock-outs.ts#detectMissedClockOuts','packs/attendance/service.ts#attendanceForEmploymentsRange'],
  trigger:LOOP_NIGHTLY,readScope:['attendance_request','absence'],effect:'prepare',
  authority:{kind:'tenant_switch',actsAs:'agent_principal'},switch:{kind:'worker_control',workerId:'loop_missed_clock_outs'},stop:{honoured:true},
  record:{kind:'loop_runs'},metrics:{kind:'loop_cases',proposesValue:true},sponsor:{kind:'switched_on_by'}},
 {id:'loop_document_expiry',label:'Passports expiring',family:'preparer',
  owners:['core/loops/document-expiry.ts#detectDocumentExpiry','core/automatic-followups.ts#followupItemsTx'],
  trigger:LOOP_NIGHTLY,readScope:['followup_item'],effect:'prepare',
  authority:{kind:'tenant_switch',actsAs:'agent_principal'},switch:{kind:'worker_control',workerId:'loop_document_expiry'},stop:{honoured:true},
  record:{kind:'loop_runs'},metrics:{kind:'loop_cases',proposesValue:false},sponsor:{kind:'switched_on_by'}},
 // AI v2 P2-2a (migration 0964): the Salary payroll loop, from cut-off to close. Prepare only in every company: it checks
 // each run and prepares it for payroll HR; a person runs, approves and closes payroll.
 {id:'loop_salary_payroll',label:'Salary payroll loop',family:'preparer',
  owners:['core/loops/salary-payroll.ts#detectSalaryPayroll','core/payroll-anomaly.ts#anomalyMetrics','core/pay-difference.ts#comparePayPeriods','core/loops/net-swing.ts#netSwings'],
  trigger:LOOP_NIGHTLY,readScope:['payroll_anomaly','payslip','pay_difference_explanation','statutory_explanation'],effect:'prepare',
  authority:{kind:'tenant_switch',actsAs:'agent_principal'},switch:{kind:'worker_control',workerId:'loop_salary_payroll'},stop:{honoured:true},
  record:{kind:'loop_runs'},metrics:{kind:'loop_cases',proposesValue:false},sponsor:{kind:'switched_on_by'}},
 // AI v2 P2-2b: the payroll Audit loop (core/payroll-audit). Daily, per company and pay month: captures each run's evidence,
 // hashed and chained, runs seven control checks that prepare findings for a person, and never files, closes or changes pay.
 {id:'loop_payroll_audit',label:'Audit loop',family:'preparer',
  owners:['core/payroll-audit/run.ts#runPayrollAuditLoop','core/payroll-audit/capture.ts#collectPayrollPeriodArtefactsTx',
   'core/payroll-audit/controls.ts#detectControlFindingsTx','core/statutory-filed.ts#periodFiledTx','core/payroll-anomaly.ts#loadBatchContexts'],
  trigger:LOOP_NIGHTLY,readScope:['payslip','pay_change','payroll_anomaly','employment_profile','absence','claim_status'],effect:'prepare',
  authority:{kind:'tenant_switch',actsAs:'agent_principal'},switch:{kind:'worker_control',workerId:'loop_payroll_audit'},stop:{honoured:true},
  record:{kind:'loop_runs'},metrics:{kind:'loop_cases',proposesValue:false},sponsor:{kind:'switched_on_by'}},
];

/** Builds a registry, refusing the whole list if any declaration breaks the contract or repeats an id. */
export function buildRegistry(declarations:readonly unknown[]):readonly WorkerDeclaration[]{
 const seen=new Set<string>();
 for(const declaration of declarations){
  assertWorkerDeclaration(declaration);
  if(seen.has(declaration.id))throw new WorkerNotRegistrable(declaration.id,['duplicate id']);
  seen.add(declaration.id);
 }
 const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
 return freeze(declarations.map(declaration=>structuredClone(declaration as WorkerDeclaration)));
}

let registry:readonly WorkerDeclaration[]|undefined;
/** The registered workers. Built on first use, so a broken declaration fails every caller, never only one. */
export function registeredWorkers():readonly WorkerDeclaration[]{registry??=buildRegistry(DECLARATIONS);return registry;}
export const registeredWorker=(id:string):WorkerDeclaration|null=>registeredWorkers().find(worker=>worker.id===id)??null;
