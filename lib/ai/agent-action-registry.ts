/** ADR-0151 §4.2, review R3 (D4, D5) — THE ONE typed registry of Assistant agent actions.
 *
 * Adding an action = one defineAgentAction entry here + one INSERT row into app.assistant_action_kind in a new
 * migration (see db/migrations/0704_assistant_action_kind.sql). Every closed TypeScript list is derived from
 * AGENT_ACTIONS: the effect-id union and module declarations (module-agent-actions.ts), the nomination parser,
 * the tier-ceiling and category maps (agent-capability-inventory.ts), the native-outcome list
 * (module-native-outcomes.ts), the human handoff routes and their enums (module-human-handoffs.ts), the
 * completed-outcome reader table (core/assistant-actions/completed-outcome-readers.ts) and the browser
 * dispatch owners (lib/assistant-actions/module-action-http.ts, core/assistant-actions/module-action-server.ts).
 * test/agent-action-registry.test.ts fails when the registry, the seeded reference rows, the capability
 * inventory or the tier-ceiling map disagree. The action's own behaviour still lives with its owner: the
 * owning service, the store adapter and, in SQL, its per-kind column rule and effect verifier.
 *
 * This is metadata. It never checks a user's access, resolves a callable or grants authority: agent authority
 * stays the user's current authority ∩ this registry ∩ tier ∩ switches and allowances (ADR-0151 §4.1).
 *
 * Field guide (for WP8 parity, WP9 store collapse, WP10 chat catalogue, WP12 inventory/pause, WP13 Automatic):
 *   id, module            stable action kind (also app.assistant_action_kind.id) and its module read binding
 *   owner, service        canonical owner and the public owning-service boundary `path#export` it reaches
 *   prepare, confirm      adapter and contract schema NAMES per phase (the zod schemas live with the contract)
 *   outcome, semantics    what a completed receipt means; semantics feeds the native-outcome association
 *   humanInputs           keys of the human-supplied prepare content; a model never supplies them
 *   permission            coarse actor class + the exported guard that re-checks native authority (`path#export`)
 *   subject               what one confirmation targets
 *   blastRadius           hard per-confirmation bound on native records written
 *   idempotencyKey        what dedupes a confirmation (review id bound to its reviewed digest; never repeats)
 *   policy                tier ceiling + category, typed so never-Automatic categories cannot be `automatic`
 *   reversal              what withdraws or undoes the effect, if anything
 *   evaluationCases       holdout cases that exercise this action by id
 *   screen                the native page and the inventory entry points classified `registered:<id>`
 *   review                the Assistant review page and whether module reads offer it as a human handoff
 *   store                 custody family: dedicated | generic_own | generic_assigned | module_action | own_leave
 *   browserOwner          key of ModuleActionBrowserOwners ('root' = notifications, 'ownLeave' = own-leave handler)
 *   pauseKey              module AI pause; agentActionPauseKey() also checks `hr_assistant:<id>`
 *   automatic             template-only scheduled specialist source, thresholds, cooldown and caps
 */
import type {AgentModuleCode} from './module-agents';
import {NEVER_AUTOMATIC_CATEGORIES,AUTOMATIC_CATEGORIES,type AgentTier,type AgentActionPolicy} from './agent-action-tiers';
import {OWN_LEAVE_CONTRACT_VERSION} from '../assistant-actions/own-leave-contract';

export type AgentActionOwner='personnel'|'organization'|'leave'|'profile'|'knowledge_base'|'payroll'|'attendance'|'claims'|'performance'|'rewards'|'lifecycle'|'country_pack_my'|'notifications'|'system_testing';
export type AgentActionPhaseStatus='implemented'|'human_workflow_only'|'pending_adapter';
export type AgentActionPhase=Readonly<{status:AgentActionPhaseStatus;adapter:string|null;inputSchema:string|null;outputSchema:string|null}>;
export type AgentActionActor='self'|'assigned_approver'|'hr_admin'|'workforce_maintainer'|'tenant_admin'|'payroll_admin'|'rewards_admin'|'assigned_tester'|'agent_principal';
export type AgentActionSubject='own_employment'|'own_user'|'assigned_request'|'other_employment'|'other_person'|'company'|'tenant';
export type AgentActionStoreFamily='dedicated'|'generic_own'|'generic_assigned'|'module_action'|'own_leave'|'human_workflow_only';
export type AgentActionHandoff='review_page'|'native_workflow'|'none';
export type AgentActionIdempotencyKey='review_action_id'|'import_attempt_version'|'chase_item_stage_cooldown';
/** Each human entry also has an own pause key; Automatic specialists keep their fixed template-only switches. */
export type AgentActionPauseKey='hr_assistant'|AgentAutomaticSpecialist;
export type AgentActionOwnPauseKey=`hr_assistant:${string}`;
type Anchor=`${string}#${string}`;
export type AgentActionReversal=
 | Readonly<{kind:'action';by:string}>          // another registry action withdraws it
 | Readonly<{kind:'entry_point';by:Anchor}>      // a human entry point (inventory key) reverses it
 | Readonly<{kind:'repeat'}>                     // superseded by doing the same action again
 | Readonly<{kind:'final'}>                      // the decision, acknowledgement or withdrawal stands
 | Readonly<{kind:'unknown'}>;                   // no reversal path found in source
export type AgentActionEvaluationCase=Readonly<{suite:'assistant_conversation';case:string}>;
/** WP13 (R18). The scheduled specialist (an AI management switch run by the tenant's agent principal), the native
 * source it reads, and the bounds the executor enforces: chase an item once it has waited `overdueAfterDays` working
 * days at its current stage, not again within `cooldownDays`, at most `maxPerItem` times per stage, and at most
 * `maxPerRun` reminders per tenant per run. `overdueAfterDays` counts WORKING days on the requester's roster minus
 * public holidays (the leave escalation's clock). These are registry defaults; per-company values are a follow-up.
 * Reminders only: never a decision, submission or record change. */
export type AgentAutomaticSpecialist='approval_chasers'|'review_chasers'|'clock_reminders'|'document_reminders'|'lifecycle_chasers';
export type AgentAutomaticSource='claim'|'attendance_correction'|'replacement_leave'|'employment_review'|'missing_clock'|'passport_expiry'|'lifecycle_step';
export type AgentAutomaticPolicy=Readonly<{specialist:AgentAutomaticSpecialist;source:AgentAutomaticSource;/** Default working_wait. Fixed presence/expiry sources have explicit eligibility and no overdue-day interpretation. */eligibility?:'working_wait'|'previous_date_record_gap'|'recorded_expiry_30_calendar_days';overdueAfterDays:number;cooldownDays:number;maxPerItem:number;maxPerRun:number}>;

/** Closed country-owned members; metadata never resolves or executes a callable. */
export type AgentActionServiceMember='statutory.set'|'statutory.setBank'|'statutory.setPassport';

/** The policy field reuses WP2's AgentActionPolicy union, so `{category:'pay',tier:'automatic'}` (or any
 * never-Automatic category paired with Automatic) is a compile error in the entry itself. */
export type AgentActionDefinition=Readonly<{
 id:string;module:AgentModuleCode;owner:AgentActionOwner;service:Anchor;serviceMember?:AgentActionServiceMember;observations?:'human_actual_only';
 contractVersion:number;prepare:AgentActionPhase;confirm:AgentActionPhase;
 outcome:'canonical_receipt_required'|'submitted_not_approved'|'notification_only';semantics:string;
 humanInputs:readonly string[]|'native_page_only';
 permission:Readonly<{actor:AgentActionActor;guard:Anchor}>;subject:AgentActionSubject;
 blastRadius:Readonly<{max:number;unit:string}>;idempotencyKey:AgentActionIdempotencyKey;
 policy:AgentActionPolicy;reversal:AgentActionReversal;evaluationCases:readonly AgentActionEvaluationCase[];
 screen:Readonly<{native:string;entryPoints:readonly Anchor[]}>;review:Readonly<{route:string;handoff:AgentActionHandoff}>;
 store:AgentActionStoreFamily;browserOwner:string|null;pauseKey:AgentActionPauseKey;automatic?:AgentAutomaticPolicy;
}>;

function freezeDeep<T>(value:T):T{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const inner of Object.values(value))freezeDeep(inner);Object.freeze(value);}return value;}
/** Load-time defence in depth for what the types already say; a malformed entry fails every importer. */
export function defineAgentAction<const T extends AgentActionDefinition>(definition:T):T{
 const d:AgentActionDefinition=definition,fail=(why:string):never=>{throw Error(`Agent action ${String(d?.id)} is malformed: ${why}`);};
 if(!/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_]*)+$/.test(d.id))fail('id');
 if(d.policy.tier==='automatic'&&!(AUTOMATIC_CATEGORIES as readonly string[]).includes(d.policy.category))fail('automatic tier outside read/reminder/chaser');
 if(d.policy.tier==='automatic'&&(NEVER_AUTOMATIC_CATEGORIES as readonly string[]).includes(d.policy.category))fail('never-Automatic category');
 if((d.store==='human_workflow_only')!==(d.prepare.status==='human_workflow_only'&&d.confirm.status==='human_workflow_only'))fail('store family and phases disagree');
 if(d.prepare.status==='implemented'&&(!d.prepare.adapter||d.prepare.adapter!==d.confirm.adapter))fail('implemented phases need one adapter');
 if((d.store==='human_workflow_only')!==(d.browserOwner===null))fail('browser owner');
 if(d.reversal.kind==='action'&&d.reversal.by===d.id)fail('reversal');
 // WP13: an Automatic entry is a reminder run by the agent principal. No model nominates or prepares it, it has no
 // review row and its only outcome is a notification; its bounds are positive integers.
 if((d.policy.tier==='automatic')!==(d.automatic!==undefined))fail('automatic policy');
 if(d.automatic){const a=d.automatic;if(d.pauseKey!==a.specialist)fail('automatic specialist switch');
  if(d.store!=='human_workflow_only'||d.permission.actor!=='agent_principal'||d.outcome!=='notification_only'||d.idempotencyKey!=='chase_item_stage_cooldown')fail('automatic shape');
  const eligibility=a.source==='missing_clock'?'previous_date_record_gap':a.source==='passport_expiry'?'recorded_expiry_30_calendar_days':'working_wait';
  if((a.eligibility??'working_wait')!==eligibility)fail('automatic eligibility');
  if(![a.overdueAfterDays,a.cooldownDays,a.maxPerItem,a.maxPerRun].every(n=>Number.isSafeInteger(n)&&n>=1&&n<=1000))fail('automatic bounds');}
 else if(d.pauseKey!=='hr_assistant'||d.permission.actor==='agent_principal'||d.outcome==='notification_only')fail('automatic shape');
 return freezeDeep(definition);
}

/** A conversation holdout case suffix: every locale's `<locale>:<case>` in lib/ai/assistant-conversation-holdouts.ts. */
const conversation=(suffix:string):AgentActionEvaluationCase=>({suite:'assistant_conversation',case:suffix});

/** Order matters for compatibility: it is the historical NATIVE_OUTCOME_ACTIONS order, and within a module
 * it is the historical handoff order. A module's declaration lists the action whose service is the module's
 * public boundary first, then the rest in this order (lib/ai/module-agent-actions.ts). */
export const AGENT_ACTIONS=Object.freeze([
 defineAgentAction({id:'employees.import',module:'employees',owner:'personnel',service:'core/import.ts#commitEmployeeImport',contractVersion:1,
  prepare:{status:'human_workflow_only',adapter:null,inputSchema:null,outputSchema:null},confirm:{status:'human_workflow_only',adapter:null,inputSchema:null,outputSchema:null},
  outcome:'canonical_receipt_required',semantics:'canonical_import_committed_not_quality_certified',humanInputs:'native_page_only',
  permission:{actor:'hr_admin',guard:'app/admin/personnel/import/actions.ts#commitImportAction'},subject:'company',blastRadius:{max:1,unit:'import_file_one_company'},
  idempotencyKey:'import_attempt_version',policy:{tier:'handoff',category:'personnel'},reversal:{kind:'entry_point',by:'app/admin/personnel/import/history/actions.ts#revertImportAction'},evaluationCases:[],
  screen:{native:'app/admin/personnel/import/page.tsx',entryPoints:['app/admin/personnel/import/actions.ts#commitImportAction']},review:{route:'/admin/personnel/import',handoff:'native_workflow'},
  store:'human_workflow_only',browserOwner:null,pauseKey:'hr_assistant'}),
 defineAgentAction({id:'org.reporting.change',module:'org',owner:'organization',service:'core/workforce-commands.ts#setReportingLine',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_org_reporting_review_v1',inputSchema:'OrgActionPrepare',outputSchema:'OrgActionPreparedReview'},
  confirm:{status:'implemented',adapter:'module_org_reporting_review_v1',inputSchema:'OrgActionConfirmation',outputSchema:'OrgActionCompletedReceipt'},
  outcome:'canonical_receipt_required',semantics:'reporting_change_recorded',humanInputs:['subordinateEmploymentId','managerEmploymentId','lineType','validFrom','confirmReportingChange'],
  permission:{actor:'hr_admin',guard:'core/assistant-actions/reviewed-reporting-line-source.ts#prepareReviewedReportingLineSourceTx'},subject:'other_employment',blastRadius:{max:1,unit:'reporting_line'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'personnel'},reversal:{kind:'repeat'},evaluationCases:[],
  screen:{native:'app/admin/personnel/[employmentId]/page.tsx',entryPoints:['app/admin/personnel/[employmentId]/actions.ts#setDirectSuperiorAction']},review:{route:'/assistant/org',handoff:'review_page'},
  store:'generic_assigned',browserOwner:'org',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'leave.apply',module:'leave',owner:'leave',service:'packs/leave/service.ts#requestLeave',contractVersion:OWN_LEAVE_CONTRACT_VERSION,
  prepare:{status:'implemented',adapter:'leave_own_review_v1',inputSchema:'OwnLeaveHumanSelection+OwnLeaveHumanText',outputSchema:'OwnLeavePreparedReview'},
  confirm:{status:'implemented',adapter:'leave_own_review_v1',inputSchema:'OwnLeaveConfirmation',outputSchema:'OwnLeaveFinalReceipt'},
  outcome:'submitted_not_approved',semantics:'submitted_not_approved',humanInputs:['employmentId','leaveTypeId','reason','employeeRemark'],
  permission:{actor:'self',guard:'core/assistant-actions/own-leave-actor.ts#readOwnLeaveActorTx'},subject:'own_employment',blastRadius:{max:1,unit:'leave_request_one_full_day'},
  idempotencyKey:'review_action_id',policy:{tier:'confirm',category:'own_work'},reversal:{kind:'action',by:'leave.cancel'},evaluationCases:[],
  screen:{native:'app/leave/page.tsx',entryPoints:['app/leave/actions.ts#requestLeaveAction','app/me/actions.ts#myRequestLeave']},review:{route:'/assistant/leave',handoff:'review_page'},
  store:'own_leave',browserOwner:'ownLeave',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'leave.cancel',module:'leave',owner:'leave',service:'packs/leave/service.ts#cancelOwnLeaveTx',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_leave_cancellation_review_v1',inputSchema:'OwnLeaveCancellationHumanContent',outputSchema:'LeaveCancellationPreparedReview'},
  confirm:{status:'implemented',adapter:'module_leave_cancellation_review_v1',inputSchema:'LeaveCancellationReviewConfirmation',outputSchema:'LeaveCancellationCompletedReview'},
  outcome:'canonical_receipt_required',semantics:'pending_leave_withdrawn_no_balance_effect',humanInputs:['employmentId','leaveRequestId','cancel'],
  permission:{actor:'self',guard:'core/assistant-actions/own-leave-change-source.ts#withOwnLeaveChangeSubjectTx'},subject:'own_employment',blastRadius:{max:1,unit:'pending_leave_request'},
  idempotencyKey:'review_action_id',policy:{tier:'confirm',category:'own_work'},reversal:{kind:'final'},evaluationCases:[conversation('propose:valid')],
  screen:{native:'app/leave/page.tsx',entryPoints:['app/leave/actions.ts#cancelOwnLeaveAction','app/me/actions.ts#myCancelLeave']},review:{route:'/assistant/leave',handoff:'review_page'},
  store:'generic_own',browserOwner:'leaveCancellation',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'leave.edit',module:'leave',owner:'leave',service:'packs/leave/service.ts#editLeaveRequestTx',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_leave_edit_review_v1',inputSchema:'OwnLeaveEditHumanContent',outputSchema:'LeaveEditPreparedReview'},
  confirm:{status:'implemented',adapter:'module_leave_edit_review_v1',inputSchema:'LeaveEditReviewConfirmation',outputSchema:'LeaveEditCompletedReview'},
  outcome:'canonical_receipt_required',semantics:'pending_leave_edited_still_not_approved',humanInputs:['employmentId','leaveRequestId','startDate','endDate','reason','employeeRemark'],
  permission:{actor:'self',guard:'core/assistant-actions/own-leave-change-source.ts#withOwnLeaveChangeSubjectTx'},subject:'own_employment',blastRadius:{max:1,unit:'pending_leave_request'},
  idempotencyKey:'review_action_id',policy:{tier:'confirm',category:'own_work'},reversal:{kind:'repeat'},evaluationCases:[],
  screen:{native:'app/leave/page.tsx',entryPoints:['app/leave/actions.ts#editLeaveAction','app/me/actions.ts#myEditLeave']},review:{route:'/assistant/leave',handoff:'review_page'},
  store:'generic_own',browserOwner:'leaveEdit',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'ess.profile.request',module:'ess',owner:'profile',service:'core/profile.ts#requestProfileChange',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_profile_review_v1',inputSchema:'ProfileModuleActionPrepare',outputSchema:'ProfileModuleActionPreparedReview'},
  confirm:{status:'implemented',adapter:'module_profile_review_v1',inputSchema:'ProfileModuleActionConfirmation',outputSchema:'ProfileModuleActionCompletedReceipt'},
  outcome:'submitted_not_approved',semantics:'submitted_not_approved_or_applied',humanInputs:['employmentId','proposal'],
  permission:{actor:'self',guard:'core/assistant-actions/own-profile-change-source.ts#prepareOwnProfileChangeSourceTx'},subject:'own_employment',blastRadius:{max:1,unit:'profile_change_request'},
  idempotencyKey:'review_action_id',policy:{tier:'confirm',category:'own_work'},reversal:{kind:'unknown'},evaluationCases:[],
  screen:{native:'app/me/page.tsx',entryPoints:[]},review:{route:'/assistant/profile',handoff:'review_page'},
  store:'generic_own',browserOwner:'profile',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'approvals.leave.decide',module:'approvals',owner:'leave',service:'packs/leave/service.ts#decideLeave',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_leave_decision_review_v1',inputSchema:'LeaveDecisionReviewPrepare',outputSchema:'LeaveDecisionPreparedReview'},
  confirm:{status:'implemented',adapter:'module_leave_decision_review_v1',inputSchema:'LeaveDecisionReviewConfirmation',outputSchema:'LeaveDecisionCompletedReview'},
  outcome:'canonical_receipt_required',semantics:'decision_recorded_current_request_state_separate',humanInputs:['leaveRequestId','currentStepId','decision','rejectReason','confirmAssignedDecision'],
  permission:{actor:'assigned_approver',guard:'core/assistant-actions/reviewed-leave-decision-source.ts#assertReviewedLeaveDecisionActorTx'},subject:'assigned_request',blastRadius:{max:1,unit:'leave_approval_step_decision'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'approvals'},reversal:{kind:'final'},evaluationCases:[],
  screen:{native:'app/approvals/page.tsx',entryPoints:['app/approvals/actions.ts#approveLeaveAction']},review:{route:'/assistant/approvals',handoff:'review_page'},
  store:'generic_assigned',browserOwner:'assignedDecision',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'approvals.claim.decide',module:'approvals',owner:'claims',service:'packs/claims/service.ts#decideClaimTx',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_claim_decision_review_v1',inputSchema:'AssignedClaimDecision.Human',outputSchema:'AssignedClaimDecision.Prepared'},
  confirm:{status:'implemented',adapter:'module_claim_decision_review_v1',inputSchema:'AssignedClaimDecision.Confirmation',outputSchema:'AssignedClaimDecision.Completed'},
  outcome:'canonical_receipt_required',semantics:'claim_decision_recorded_payment_separate',humanInputs:['employmentId','subjectId','decision','note'],
  permission:{actor:'assigned_approver',guard:'core/assistant-actions/assigned-decision-sources.ts#withAssignedClaimSubjectTx'},subject:'assigned_request',blastRadius:{max:1,unit:'claim_approval_decision'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'approvals'},reversal:{kind:'final'},evaluationCases:[conversation('propose:unreadable')],
  screen:{native:'app/approvals/page.tsx',entryPoints:['app/approvals/actions.ts#approveClaimAction']},review:{route:'/assistant/approvals',handoff:'review_page'},
  store:'generic_assigned',browserOwner:'claimDecision',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'approvals.attendance.decide',module:'approvals',owner:'attendance',service:'packs/attendance/service.ts#decideAttendanceCorrection',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_attendance_decision_review_v1',inputSchema:'AssignedAttendanceDecision.Human',outputSchema:'AssignedAttendanceDecision.Prepared'},
  confirm:{status:'implemented',adapter:'module_attendance_decision_review_v1',inputSchema:'AssignedAttendanceDecision.Confirmation',outputSchema:'AssignedAttendanceDecision.Completed'},
  outcome:'canonical_receipt_required',semantics:'attendance_decision_recorded_request_may_remain_pending',humanInputs:['employmentId','subjectId','decision','note'],
  permission:{actor:'assigned_approver',guard:'core/assistant-actions/assigned-decision-sources.ts#withAssignedAttendanceSubjectTx'},subject:'assigned_request',blastRadius:{max:1,unit:'attendance_correction_level_decision'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'approvals'},reversal:{kind:'final'},evaluationCases:[],
  screen:{native:'app/approvals/page.tsx',entryPoints:['app/approvals/actions.ts#approveCorrectionAction','app/attendance/actions.ts#decideCorrectionAction']},review:{route:'/assistant/approvals',handoff:'review_page'},
  store:'generic_assigned',browserOwner:'attendanceDecision',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'approvals.toil.decide',module:'approvals',owner:'leave',service:'packs/leave/service.ts#decideReplacementLeaveRequestTx',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_toil_decision_review_v1',inputSchema:'AssignedToilDecision.Human',outputSchema:'AssignedToilDecision.Prepared'},
  confirm:{status:'implemented',adapter:'module_toil_decision_review_v1',inputSchema:'AssignedToilDecision.Confirmation',outputSchema:'AssignedToilDecision.Completed'},
  outcome:'canonical_receipt_required',semantics:'replacement_leave_decision_recorded_credit_on_approval_only',humanInputs:['employmentId','subjectId','decision','note'],
  permission:{actor:'assigned_approver',guard:'core/assistant-actions/assigned-decision-sources.ts#withAssignedToilSubjectTx'},subject:'assigned_request',blastRadius:{max:1,unit:'replacement_leave_decision'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'approvals'},reversal:{kind:'final'},evaluationCases:[],
  screen:{native:'app/approvals/page.tsx',entryPoints:['app/leave/actions.ts#decideReplacementLeaveRequestAction']},review:{route:'/assistant/approvals',handoff:'review_page'},
  store:'generic_assigned',browserOwner:'toilDecision',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'knowledge_base.article.create',module:'knowledge_base',owner:'knowledge_base',service:'core/knowledge-base.ts#createArticle',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_knowledge_article_review_v1',inputSchema:'KnowledgeArticleReviewPrepare',outputSchema:'KnowledgeArticlePreparedReview'},
  confirm:{status:'implemented',adapter:'module_knowledge_article_review_v1',inputSchema:'KnowledgeArticleReviewConfirmation',outputSchema:'KnowledgeArticleCompletedReview'},
  outcome:'canonical_receipt_required',semantics:'article_created_not_content_certified',humanInputs:['title','body','category','audience'],
  permission:{actor:'hr_admin',guard:'core/assistant-actions/knowledge-article-source.ts#assertKnowledgeArticleActorTx'},subject:'tenant',blastRadius:{max:1,unit:'knowledge_article'},
  idempotencyKey:'review_action_id',policy:{tier:'confirm',category:'own_work'},reversal:{kind:'entry_point',by:'app/knowledge-base/actions.ts#archiveDocumentAction'},evaluationCases:[],
  screen:{native:'app/knowledge-base/page.tsx',entryPoints:['app/knowledge-base/actions.ts#createArticleAction']},review:{route:'/assistant/knowledge-base',handoff:'review_page'},
  store:'generic_own',browserOwner:'knowledge',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'payroll.close',module:'payroll',owner:'payroll',service:'packs/payroll/service.ts#closeBatch',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_payroll_close_review_v1',inputSchema:'PayrollCloseReviewPrepare',outputSchema:'PayrollClosePreparedReview'},
  confirm:{status:'implemented',adapter:'module_payroll_close_review_v1',inputSchema:'PayrollCloseReviewConfirmation',outputSchema:'PayrollCloseCompletedReview'},
  outcome:'canonical_receipt_required',semantics:'batch_close_recorded_not_payment',humanInputs:['batchId','confirmCloseProcessedRun'],
  permission:{actor:'payroll_admin',guard:'core/assistant-actions/reviewed-payroll-close-source.ts#assertReviewedPayrollCloseActorTx'},subject:'company',blastRadius:{max:1,unit:'payroll_batch_one_company_period'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'payroll'},reversal:{kind:'entry_point',by:'app/payroll/actions.ts#unlockAction'},evaluationCases:[],
  screen:{native:'app/payroll/[batchId]/page.tsx',entryPoints:['app/payroll/actions.ts#closeAction']},review:{route:'/assistant/payroll-close',handoff:'review_page'},
  store:'generic_own',browserOwner:'payrollClose',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'attendance.correction.request',module:'attendance',owner:'attendance',service:'packs/attendance/service.ts#requestAttendanceCorrection',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_attendance_review_v1',inputSchema:'AttendanceCorrectionReviewPrepare',outputSchema:'AttendanceCorrectionPreparedReview'},
  confirm:{status:'implemented',adapter:'module_attendance_review_v1',inputSchema:'AttendanceCorrectionReviewConfirmation',outputSchema:'AttendanceCorrectionCompletedReview'},
  outcome:'submitted_not_approved',semantics:'correction_requested_not_approved',
  humanInputs:['employmentId','date','checkIn','checkOut','requestedOtMinutes','plannedStartTime','plannedEndTime','otReasonCategory','reason','remark','requestKind','clockChanges','unclockedWork'],
  permission:{actor:'self',guard:'core/assistant-actions/own-attendance-correction-source.ts#assertOwnAttendanceCorrectionActorTx'},subject:'own_employment',blastRadius:{max:1,unit:'attendance_correction_one_date'},
  idempotencyKey:'review_action_id',policy:{tier:'confirm',category:'own_work'},reversal:{kind:'entry_point',by:'app/me/actions.ts#myCancelAttendanceRequest'},evaluationCases:[],
  screen:{native:'app/attendance/my-records/[date]/page.tsx',entryPoints:['app/attendance/my-records/[date]/actions.ts#requestOwnAttendanceDayAction','app/me/actions.ts#myRequestCorrection']},review:{route:'/assistant/attendance',handoff:'review_page'},
  store:'generic_own',browserOwner:'attendance',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'attendance.overtime.request',module:'attendance',owner:'attendance',service:'packs/attendance/service.ts#requestAttendanceCorrectionTx',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_overtime_request_review_v1',inputSchema:'OwnOvertimeHumanContent',outputSchema:'OvertimeRequestPreparedReview'},
  confirm:{status:'implemented',adapter:'module_overtime_request_review_v1',inputSchema:'OvertimeRequestReviewConfirmation',outputSchema:'OvertimeRequestCompletedReview'},
  outcome:'submitted_not_approved',semantics:'overtime_requested_not_approved',humanInputs:['employmentId','date','plannedStartTime','plannedEndTime','reason','remark'],
  permission:{actor:'self',guard:'core/assistant-actions/own-overtime-request-source.ts#withOwnOvertimeSubjectTx'},subject:'own_employment',blastRadius:{max:1,unit:'overtime_request_one_date'},
  idempotencyKey:'review_action_id',policy:{tier:'confirm',category:'pay'},reversal:{kind:'entry_point',by:'app/me/actions.ts#myWithdrawOvertimePlan'},evaluationCases:[],
  screen:{native:'app/attendance/plan-ot/apply/page.tsx',entryPoints:['app/me/actions.ts#myRequestOvertime']},review:{route:'/assistant/attendance',handoff:'review_page'},
  store:'generic_own',browserOwner:'overtimeRequest',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'claims.draft.save',module:'claims',owner:'claims',service:'packs/claims/service.ts#saveClaimDraft',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_claim_draft_review_v1',inputSchema:'ClaimModuleActionPrepare',outputSchema:'ClaimModuleActionPreparedReview'},
  confirm:{status:'implemented',adapter:'module_claim_draft_review_v1',inputSchema:'ClaimModuleActionConfirmation',outputSchema:'ClaimModuleActionCompletedReceipt'},
  outcome:'canonical_receipt_required',semantics:'draft_saved_not_submitted_or_reimbursed',
  humanInputs:['employmentId','draftId','expectedDraftRevision','claimTypeId','claimItemId','enteredAmount','quantityKm','incurredOn','description','fieldValues','retainedAttachmentIds'],
  permission:{actor:'self',guard:'core/assistant-actions/own-claim-source.ts#prepareOwnClaimDraftSourceTx'},subject:'own_employment',blastRadius:{max:1,unit:'claim_draft'},
  idempotencyKey:'review_action_id',policy:{tier:'confirm',category:'claim_money'},reversal:{kind:'entry_point',by:'app/claims/actions.ts#deleteDraftAction'},evaluationCases:[],
  screen:{native:'app/claims/page.tsx',entryPoints:[]},review:{route:'/assistant/claims',handoff:'review_page'},
  store:'generic_own',browserOwner:'claims',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'claims.submit',module:'claims',owner:'claims',service:'packs/claims/service.ts#submitDraftClaims',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_claim_submission_review_v1',inputSchema:'ClaimSubmissionModuleActionPrepare',outputSchema:'ClaimSubmissionModuleActionPreparedReview'},
  confirm:{status:'implemented',adapter:'module_claim_submission_review_v1',inputSchema:'ClaimSubmissionModuleActionConfirmation',outputSchema:'ClaimSubmissionModuleActionCompletedReceipt'},
  outcome:'submitted_not_approved',semantics:'submitted_not_approved_or_reimbursed',humanInputs:['employmentId','draftId','receiptIds','submitForApproval'],
  permission:{actor:'self',guard:'core/assistant-actions/own-claim-submission-source.ts#withOwnClaimSubmissionIntervalTx'},subject:'own_employment',blastRadius:{max:1,unit:'claim_request'},
  idempotencyKey:'review_action_id',policy:{tier:'confirm',category:'claim_money'},reversal:{kind:'action',by:'claims.cancel'},evaluationCases:[],
  screen:{native:'app/claims/page.tsx',entryPoints:['app/claims/actions.ts#submitDraftsAction']},review:{route:'/assistant/claims',handoff:'review_page'},
  store:'generic_own',browserOwner:'claimSubmission',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'claims.cancel',module:'claims',owner:'claims',service:'packs/claims/service.ts#cancelClaimTx',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_claim_cancellation_review_v1',inputSchema:'ClaimCancellationReviewPrepare',outputSchema:'ClaimCancellationPreparedReview'},
  confirm:{status:'implemented',adapter:'module_claim_cancellation_review_v1',inputSchema:'ClaimCancellationReviewConfirmation',outputSchema:'ClaimCancellationCompletedReview'},
  outcome:'canonical_receipt_required',semantics:'pending_claim_cancelled_no_payment_effect',humanInputs:['employmentId','claimId','cancel'],
  permission:{actor:'self',guard:'core/assistant-actions/own-claim-cancellation-source.ts#assertOwnClaimCancellationActorTx'},subject:'own_employment',blastRadius:{max:1,unit:'pending_claim_request'},
  idempotencyKey:'review_action_id',policy:{tier:'confirm',category:'claim_money'},reversal:{kind:'final'},evaluationCases:[conversation('propose:free_text')],
  screen:{native:'app/claims/page.tsx',entryPoints:['app/claims/actions.ts#cancelClaimAction']},review:{route:'/assistant/claims',handoff:'review_page'},
  // Generic SQL family (0670) with a hand-cloned TypeScript custody owner: WP9 moves it to generic_own first.
  store:'generic_own',browserOwner:'claimCancellation',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'performance.review.acknowledge',module:'performance',owner:'performance',service:'core/performance.ts#acknowledgeReview',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_standard_review_v1',inputSchema:'ReviewModuleActionPrepare',outputSchema:'ReviewModuleActionPreparedReview'},
  confirm:{status:'implemented',adapter:'module_standard_review_v1',inputSchema:'ReviewModuleActionConfirmation',outputSchema:'ReviewModuleActionCompletedReceipt'},
  outcome:'canonical_receipt_required',semantics:'review_acknowledged_not_rating_endorsement',humanInputs:['reviewId','acknowledge'],
  permission:{actor:'self',guard:'core/assistant-actions/own-review-acknowledgement-source.ts#prepareOwnReviewAcknowledgementTx'},subject:'own_employment',blastRadius:{max:1,unit:'review_acknowledgement'},
  idempotencyKey:'review_action_id',policy:{tier:'confirm',category:'own_work'},reversal:{kind:'final'},evaluationCases:[],
  screen:{native:'app/performance/review/[reviewId]/page.tsx',entryPoints:['app/performance/actions.ts#acknowledgeAction']},review:{route:'/assistant/performance',handoff:'review_page'},
  store:'generic_own',browserOwner:'performance',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'performance.onehr.plan.acknowledge',module:'performance',owner:'performance',service:'packs/performance/service.ts#acknowledgeOnehrPlan',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_onehr_plan_review_v1',inputSchema:'OnehrModuleActionPrepare',outputSchema:'OnehrModuleActionPreparedReview'},
  confirm:{status:'implemented',adapter:'module_onehr_plan_review_v1',inputSchema:'OnehrModuleActionConfirmation',outputSchema:'OnehrModuleActionCompletedReceipt'},
  outcome:'canonical_receipt_required',semantics:'career_conversation_acknowledged_not_rating_endorsement',humanInputs:['planId','acknowledge'],
  permission:{actor:'self',guard:'core/assistant-actions/own-onehr-plan-acknowledgement-source.ts#prepareOwnOnehrPlanAcknowledgementTx'},subject:'own_employment',blastRadius:{max:1,unit:'plan_acknowledgement'},
  idempotencyKey:'review_action_id',policy:{tier:'confirm',category:'own_work'},reversal:{kind:'final'},evaluationCases:[],
  screen:{native:'app/performance/review/[reviewId]/page.tsx',entryPoints:[]},review:{route:'/assistant/performance',handoff:'review_page'},
  store:'generic_own',browserOwner:'performance',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'rewards.post',module:'rewards',owner:'rewards',service:'packs/rewards/service.ts#postRewardUnit',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_rewards_post_review_v1',inputSchema:'RewardsPostReviewPrepare',outputSchema:'RewardsPostPreparedReview'},
  confirm:{status:'implemented',adapter:'module_rewards_post_review_v1',inputSchema:'RewardsPostReviewConfirmation',outputSchema:'RewardsPostCompletedReview'},
  outcome:'canonical_receipt_required',semantics:'posted_to_payroll_inputs_not_processed_or_paid',humanInputs:['unitId','revision','batchId','confirmWholeApprovedUnit'],
  permission:{actor:'rewards_admin',guard:'core/assistant-actions/reviewed-rewards-post-source.ts#assertReviewedRewardsPostActorTx'},subject:'company',blastRadius:{max:1,unit:'approved_reward_unit_all_entries'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'pay'},reversal:{kind:'unknown'},evaluationCases:[],
  screen:{native:'app/rewards/[unitId]/page.tsx',entryPoints:['app/rewards/actions.ts#postAction']},review:{route:'/assistant/rewards',handoff:'review_page'},
  store:'generic_assigned',browserOwner:'rewardsPost',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'lifecycle.acknowledgement.submit',module:'lifecycle',owner:'lifecycle',service:'core/lifecycle-self.ts#submitMyAcknowledgement',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_lifecycle_ack_review_v1',inputSchema:'LifecycleAckReviewPrepare',outputSchema:'LifecycleAckPreparedReview'},
  confirm:{status:'implemented',adapter:'module_lifecycle_ack_review_v1',inputSchema:'LifecycleAckReviewConfirmation',outputSchema:'LifecycleAckCompletedReview'},
  outcome:'canonical_receipt_required',semantics:'equipment_acknowledgement_recorded',
  humanInputs:['caseId','contactNumber','serialNumber','accessories','pcType','hasMonitor','monitorSerial','receiptEmail','acknowledged'],
  permission:{actor:'self',guard:'core/assistant-actions/own-lifecycle-acknowledgement-source.ts#assertOwnLifecycleAcknowledgementActorTx'},subject:'own_user',blastRadius:{max:1,unit:'lifecycle_case_acknowledgement'},
  idempotencyKey:'review_action_id',policy:{tier:'confirm',category:'own_work'},reversal:{kind:'final'},evaluationCases:[],
  screen:{native:'app/lifecycle/me/page.tsx',entryPoints:['app/lifecycle/actions.ts#acknowledgeAction']},review:{route:'/assistant/lifecycle',handoff:'review_page'},
  store:'generic_own',browserOwner:'lifecycleAck',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'toil.replacement.request',module:'toil',owner:'leave',service:'packs/leave/service.ts#submitReplacementLeaveRequest',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_toil_request_review_v1',inputSchema:'ToilRequestReviewPrepare',outputSchema:'ToilRequestPreparedReview'},
  confirm:{status:'implemented',adapter:'module_toil_request_review_v1',inputSchema:'ToilRequestReviewConfirmation',outputSchema:'ToilRequestCompletedReview'},
  outcome:'submitted_not_approved',semantics:'replacement_request_submitted_not_approved',humanInputs:['engine','employmentId','leaveTypeId','firstScheduleConsent','reason','rows','unit','lines'],
  permission:{actor:'self',guard:'core/assistant-actions/own-toil-replacement-source.ts#assertOwnToilReplacementActorTx'},subject:'own_employment',blastRadius:{max:1,unit:'replacement_request_up_to_32_worked_dates'},
  idempotencyKey:'review_action_id',policy:{tier:'confirm',category:'own_work'},reversal:{kind:'entry_point',by:'app/leave/credit/actions.ts#cancelLeaveCreditRequestAction'},evaluationCases:[],
  screen:{native:'app/leave/page.tsx',entryPoints:['app/leave/actions.ts#submitReplacementLeaveRequestAction']},review:{route:'/assistant/toil',handoff:'review_page'},
  store:'generic_own',browserOwner:'toil',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'multi_cycle_payroll.create_run',module:'multi_cycle_payroll',owner:'payroll',service:'packs/payroll/service.ts#createAdditionalRun',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_multi_cycle_run_review_v1',inputSchema:'MultiCycleRunReviewPrepare',outputSchema:'MultiCycleRunPreparedReview'},
  confirm:{status:'implemented',adapter:'module_multi_cycle_run_review_v1',inputSchema:'MultiCycleRunReviewConfirmation',outputSchema:'MultiCycleRunCompletedReview'},
  outcome:'canonical_receipt_required',semantics:'draft_run_created_not_processed_or_paid',
  humanInputs:['companyId','payPeriod','runType','paymentDate','remarks','scope','payrollCycleId','confirmDraftCreation'],
  permission:{actor:'payroll_admin',guard:'core/assistant-actions/reviewed-multi-cycle-run-source.ts#assertReviewedMultiCycleRunActorTx'},subject:'company',blastRadius:{max:1,unit:'draft_additional_run_one_company_period'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'payroll'},reversal:{kind:'entry_point',by:'app/payroll/actions.ts#deleteDraftBatchAction'},evaluationCases:[],
  screen:{native:'app/payroll/process/page.tsx',entryPoints:['app/payroll/process/actions.ts#createRunAction']},review:{route:'/assistant/payroll-runs',handoff:'review_page'},
  store:'generic_own',browserOwner:'multiCycleRun',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'typed_pay_components.create',module:'typed_pay_components',owner:'payroll',service:'packs/payroll/service.ts#createPayComponent',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_pay_component_review_v1',inputSchema:'PayComponentReviewPrepare',outputSchema:'PayComponentPreparedReview'},
  confirm:{status:'implemented',adapter:'module_pay_component_review_v1',inputSchema:'PayComponentReviewConfirmation',outputSchema:'PayComponentCompletedReview'},
  outcome:'canonical_receipt_required',semantics:'component_created_not_pay_calculated',
  humanInputs:['code','name','label','description','kind','includedInEpf','includedInSocsoEis','includedInPcb','includedInHrdfBase','isNonPayable','prorates','eaFormLine','roundingMethod','rule','pcbRemunerationType','pcbExemptionCode','displayCategory','orpOvertime','orpUnpaidLeave','confirmCatalogCreate'],
  permission:{actor:'tenant_admin',guard:'core/assistant-actions/reviewed-pay-component-source.ts#withReviewedPayComponentIntervalTx'},subject:'tenant',blastRadius:{max:1,unit:'pay_component_catalogue_entry'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'pay'},reversal:{kind:'entry_point',by:'app/admin/pay-components/actions.ts#archiveComponentAction'},evaluationCases:[],
  screen:{native:'app/admin/pay-components/new/page.tsx',entryPoints:['app/admin/pay-components/actions.ts#createComponentAction']},review:{route:'/assistant/pay-codes',handoff:'review_page'},
  store:'generic_own',browserOwner:'payComponent',pauseKey:'hr_assistant'}),
 /** Country dispatch resolves the company's actual pack through requirePackFor and its typed statutory.set
  * member; direct MY imports are forbidden to adapters. */
 defineAgentAction({id:'country-my.statutory.update',module:'country-my',owner:'country_pack_my',service:'localization/registry.ts#requirePackFor',serviceMember:'statutory.set',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_country_statutory_review_v1',inputSchema:'CountryStatutoryReviewPrepare',outputSchema:'CountryStatutoryPreparedReview'},
  confirm:{status:'implemented',adapter:'module_country_statutory_review_v1',inputSchema:'CountryStatutoryReviewConfirmation',outputSchema:'CountryStatutoryCompletedReview'},
  outcome:'canonical_receipt_required',semantics:'statutory_record_saved_not_filed',humanInputs:['employmentId','input','confirmSharedPersonWrite'],
  permission:{actor:'hr_admin',guard:'core/assistant-actions/reviewed-country-statutory-source.ts#assertReviewedCountryStatutoryActorTx'},subject:'other_employment',blastRadius:{max:1,unit:'person_statutory_section'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'payroll'},reversal:{kind:'repeat'},evaluationCases:[],
  screen:{native:'app/admin/personnel/[employmentId]/page.tsx',entryPoints:['app/admin/personnel/[employmentId]/actions.ts#setStatutoryAction']},review:{route:'/assistant/statutory',handoff:'review_page'},
  store:'generic_assigned',browserOwner:'countryStatutory',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'notifications.email_preferences.save',module:'notifications',owner:'notifications',service:'core/notification-email.ts#saveNotificationEmailPreferences',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_notification_review_v1',inputSchema:'ModuleActionPrepare',outputSchema:'ModuleActionPreparedReview'},
  confirm:{status:'implemented',adapter:'module_notification_review_v1',inputSchema:'ModuleActionConfirmation',outputSchema:'ModuleActionCompletedReceipt'},
  outcome:'canonical_receipt_required',semantics:'historical_event_current_preferences_not_delivery',humanInputs:['employmentId','enabledCategories','locale','consent'],
  permission:{actor:'self',guard:'core/assistant-actions/own-notification-preferences-source.ts#prepareOwnNotificationPreferencesTx'},subject:'own_employment',blastRadius:{max:1,unit:'employment_preference_set'},
  idempotencyKey:'review_action_id',policy:{tier:'confirm',category:'own_work'},reversal:{kind:'repeat'},evaluationCases:[],
  screen:{native:'app/me/notifications/page.tsx',entryPoints:['app/me/notifications/actions.ts#saveMyWorkflowEmailPreferences']},review:{route:'/assistant/notifications',handoff:'review_page'},
  store:'generic_own',browserOwner:'root',pauseKey:'hr_assistant'}),
 /** System Testing saves only the human's real versioned execution observations. */
 defineAgentAction({id:'system_testing.execution.save',module:'system_testing',owner:'system_testing',service:'core/system-testing-workspace.ts#saveTestingExecution',contractVersion:1,observations:'human_actual_only',
  prepare:{status:'implemented',adapter:'module_testing_execution_review_v1',inputSchema:'TestingModuleActionPrepare',outputSchema:'TestingModuleActionPreparedReview'},
  confirm:{status:'implemented',adapter:'module_testing_execution_review_v1',inputSchema:'TestingModuleActionConfirmation',outputSchema:'TestingModuleActionCompletedReceipt'},
  outcome:'canonical_receipt_required',semantics:'human_reported_observation_not_independent_verification',
  humanInputs:['humanObserved','executionId','assignmentId','versionId','expectedRevision','status','actualResult','comments','defectNotes','improvementNotes'],
  permission:{actor:'assigned_tester',guard:'core/assistant-actions/own-testing-execution-source.ts#withOwnTestingExecutionIntervalTx'},subject:'own_user',blastRadius:{max:1,unit:'test_execution_observation'},
  idempotencyKey:'review_action_id',policy:{tier:'confirm',category:'own_work'},reversal:{kind:'unknown'},evaluationCases:[],
  screen:{native:'app/system-testing/executions/[id]/page.tsx',entryPoints:['app/admin/system-testing/workspace-actions.ts#saveTestingObservationAction']},review:{route:'/assistant/testing',handoff:'review_page'},
  store:'generic_own',browserOwner:'testing',pauseKey:'hr_assistant'}),
 /** ADR-0151 (amendment 2026-10-29): HR acts on another person's employment through the wave 1b assigned
  * store. The administrator confirms; the native service decides authority and the effect. */
 defineAgentAction({id:'leave.adjustment.apply',module:'leave',owner:'leave',service:'packs/leave/service.ts#applyLeaveAdjustmentBatchTx',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_leave_adjustment_review_v1',inputSchema:'HrLeaveAdjustment.Human',outputSchema:'HrLeaveAdjustment.Prepared'},
  confirm:{status:'implemented',adapter:'module_leave_adjustment_review_v1',inputSchema:'HrLeaveAdjustment.Confirmation',outputSchema:'HrLeaveAdjustment.Completed'},
  outcome:'canonical_receipt_required',semantics:'hr_adjustment_written_balance_from_effective_date',humanInputs:['employmentId','subjectId','leaveTypeId','direction','days','effectiveOn','reason'],
  permission:{actor:'hr_admin',guard:'core/assistant-actions/hr-prepared-sources.ts#withHrLeaveAdjustmentSubjectTx'},subject:'other_employment',blastRadius:{max:1,unit:'leave_ledger_adjustment_one_type'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'approvals'},reversal:{kind:'entry_point',by:'app/admin/leave/adjustments/actions.ts#reverseLeaveAdjustmentAction'},evaluationCases:[],
  screen:{native:'app/admin/leave-config/adjustments/page.tsx',entryPoints:['app/admin/leave/adjustments/actions.ts#applyLeaveAdjustmentAction']},review:{route:'/assistant/hr?flow=leave',handoff:'none'},
  store:'generic_assigned',browserOwner:'leaveAdjustment',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'employees.movement.transfer',module:'employees',owner:'personnel',service:'core/movement.ts#createMovementEventTx',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_movement_transfer_review_v1',inputSchema:'HrMovementTransfer.Human',outputSchema:'HrMovementTransfer.Prepared'},
  confirm:{status:'implemented',adapter:'module_movement_transfer_review_v1',inputSchema:'HrMovementTransfer.Confirmation',outputSchema:'HrMovementTransfer.Completed'},
  outcome:'canonical_receipt_required',semantics:'hr_assignment_movement_applied_or_scheduled',
  humanInputs:['employmentId','subjectId','kind','effectiveDate','departmentId','positionId','businessUnitId','locationId','remarks'],
  permission:{actor:'hr_admin',guard:'core/assistant-actions/hr-prepared-sources.ts#withHrMovementSubjectTx'},subject:'other_employment',blastRadius:{max:1,unit:'movement_event_one_employment'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'personnel'},reversal:{kind:'entry_point',by:'app/admin/personnel/[employmentId]/actions.ts#reverseMovementEventAction'},evaluationCases:[],
  screen:{native:'app/admin/personnel/[employmentId]/page.tsx',entryPoints:['app/admin/personnel/[employmentId]/actions.ts#createMovementEventAction']},review:{route:'/assistant/hr?flow=movement',handoff:'none'},
  store:'generic_assigned',browserOwner:'movementTransfer',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'employees.compensation.maintain',module:'employees',owner:'personnel',service:'core/comp.ts#executeReviewedCompensationCommandTx',contractVersion:1,
  prepare:{status:'implemented',adapter:'compensation_maintenance_review_v1',inputSchema:'CompensationMaintenance.Human',outputSchema:'CompensationMaintenance.Prepared'},
  confirm:{status:'implemented',adapter:'compensation_maintenance_review_v1',inputSchema:'CompensationMaintenance.Confirmation',outputSchema:'CompensationMaintenance.Completed'},
  outcome:'canonical_receipt_required',semantics:'salary_history_changed_not_payroll_generated_approved_or_paid',humanInputs:['employmentId','subjectId','operation','compensationId','fields'],
  permission:{actor:'hr_admin',guard:'core/assistant-actions/compensation-maintenance-source.ts#withCompensationMaintenanceSubjectTx'},subject:'other_employment',blastRadius:{max:102,unit:'salary_records_and_existing_payroll_run_markers'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'pay'},reversal:{kind:'entry_point',by:'app/admin/personnel/[employmentId]/actions.ts#supersedeCompensationAction'},evaluationCases:[],
  screen:{native:'app/admin/personnel/[employmentId]/page.tsx',entryPoints:['app/admin/personnel/[employmentId]/actions.ts#setCompensationAction','app/admin/personnel/[employmentId]/actions.ts#editCompensationAction','app/admin/personnel/[employmentId]/actions.ts#supersedeCompensationAction']},review:{route:'/assistant/compensation',handoff:'review_page'},
  store:'generic_assigned',browserOwner:'compensationMaintenance',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'employees.code.maintain',module:'employees',owner:'personnel',service:'core/workforce-code.ts#setWorkforceEmployeeCode',contractVersion:1,
  prepare:{status:'implemented',adapter:'employee_code_maintenance_review_v1',inputSchema:'EmployeeCodeMaintenance.Human',outputSchema:'EmployeeCodeMaintenance.Prepared'},
  confirm:{status:'implemented',adapter:'employee_code_maintenance_review_v1',inputSchema:'EmployeeCodeMaintenance.Confirmation',outputSchema:'EmployeeCodeMaintenance.Completed'},
  outcome:'canonical_receipt_required',semantics:'employment_identifier_changed_not_person_pay_or_access',humanInputs:['employmentId','subjectId','expectedCode','employeeCode'],
  permission:{actor:'workforce_maintainer',guard:'core/assistant-actions/employee-code-maintenance-source.ts#withEmployeeCodeMaintenanceSubjectTx'},subject:'other_employment',blastRadius:{max:1,unit:'employment_identifier'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'personnel'},reversal:{kind:'repeat'},evaluationCases:[],
  screen:{native:'app/admin/personnel/[employmentId]/page.tsx',entryPoints:['app/admin/personnel/[employmentId]/workforce-record-actions.ts#saveWorkforceCodeAction']},review:{route:'/assistant/employee-code',handoff:'review_page'},
  store:'generic_assigned',browserOwner:'employeeCodeMaintenance',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'employees.workforce_profile.maintain',module:'employees',owner:'personnel',service:'core/workforce-maintenance.ts#maintainWorkforceRecord',contractVersion:1,
  prepare:{status:'implemented',adapter:'workforce_profile_maintenance_review_v1',inputSchema:'WorkforceProfileMaintenance.Human',outputSchema:'WorkforceProfileMaintenance.Prepared'},
  confirm:{status:'implemented',adapter:'workforce_profile_maintenance_review_v1',inputSchema:'WorkforceProfileMaintenance.Confirmation',outputSchema:'WorkforceProfileMaintenance.Completed'},
  outcome:'canonical_receipt_required',semantics:'shared_person_profile_updated_not_employment_pay_or_access',humanInputs:['employmentId','subjectId','section','expectedVersion','values'],
  permission:{actor:'workforce_maintainer',guard:'core/assistant-actions/workforce-profile-maintenance-source.ts#withWorkforceProfileMaintenanceIntervalTx'},subject:'other_person',blastRadius:{max:1,unit:'shared_person_finite_profile_section'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'personnel'},reversal:{kind:'repeat'},evaluationCases:[],
  screen:{native:'app/admin/personnel/[employmentId]/page.tsx',entryPoints:[]},review:{route:'/assistant/workforce-profile',handoff:'review_page'},
  store:'generic_assigned',browserOwner:'workforceProfileMaintenance',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'employees.bank.maintain',module:'employees',owner:'personnel',service:'localization/registry.ts#requirePackFor',serviceMember:'statutory.setBank',contractVersion:1,
  prepare:{status:'implemented',adapter:'bank_maintenance_review_v1',inputSchema:'BankMaintenance.Human',outputSchema:'BankMaintenance.Prepared'},
  confirm:{status:'implemented',adapter:'bank_maintenance_review_v1',inputSchema:'BankMaintenance.Confirmation',outputSchema:'BankMaintenance.Completed'},
  outcome:'canonical_receipt_required',semantics:'bank_destination_saved_not_payment_processed_or_statutory_changed',humanInputs:['employmentId','subjectId','fields'],
  permission:{actor:'hr_admin',guard:'core/assistant-actions/bank-maintenance-source.ts#withBankMaintenanceIntervalTx'},subject:'other_person',blastRadius:{max:1,unit:'shared_person_bank_destination'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'personnel'},reversal:{kind:'repeat'},evaluationCases:[],
  screen:{native:'app/admin/personnel/[employmentId]/page.tsx',entryPoints:[]},review:{route:'/assistant/bank',handoff:'review_page'},
  store:'generic_assigned',browserOwner:'bankMaintenance',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'employees.document_metadata.maintain',module:'employees',owner:'personnel',service:'core/employee-documents.ts#updateEmployeeDocumentMeta',contractVersion:1,
  prepare:{status:'implemented',adapter:'document_metadata_review_v1',inputSchema:'DocumentMetadata.Human',outputSchema:'DocumentMetadata.Prepared'},
  confirm:{status:'implemented',adapter:'document_metadata_review_v1',inputSchema:'DocumentMetadata.Confirmation',outputSchema:'DocumentMetadata.Completed'},
  outcome:'canonical_receipt_required',semantics:'ordinary_document_metadata_changed_attachment_untouched',humanInputs:['employmentId','subjectId','fields'],
  permission:{actor:'hr_admin',guard:'core/assistant-actions/document-metadata-source.ts#withDocumentMetadataSubjectTx'},subject:'other_employment',blastRadius:{max:1,unit:'ordinary_document_three_metadata_fields'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'personnel'},reversal:{kind:'repeat'},evaluationCases:[],
  screen:{native:'app/admin/personnel/[employmentId]/page.tsx',entryPoints:['app/admin/personnel/[employmentId]/actions.ts#updateEmployeeDocumentMetaAction']},review:{route:'/assistant/document-details',handoff:'review_page'},
  store:'generic_assigned',browserOwner:'documentMetadata',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'employees.passport.maintain',module:'employees',owner:'personnel',service:'localization/registry.ts#requirePackFor',serviceMember:'statutory.setPassport',contractVersion:1,
  prepare:{status:'implemented',adapter:'passport_maintenance_review_v1',inputSchema:'PassportMaintenance.Human',outputSchema:'PassportMaintenance.Prepared'},
  confirm:{status:'implemented',adapter:'passport_maintenance_review_v1',inputSchema:'PassportMaintenance.Confirmation',outputSchema:'PassportMaintenance.Completed'},
  outcome:'canonical_receipt_required',semantics:'passport_information_saved_not_ic_dob_pay_or_access',humanInputs:['employmentId','subjectId','fields'],
  permission:{actor:'hr_admin',guard:'core/assistant-actions/passport-maintenance-source.ts#withPassportMaintenanceIntervalTx'},subject:'other_person',blastRadius:{max:1,unit:'shared_person_passport_information'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'personnel'},reversal:{kind:'repeat'},evaluationCases:[],
  screen:{native:'app/admin/personnel/[employmentId]/page.tsx',entryPoints:[]},review:{route:'/assistant/passport',handoff:'review_page'},
  store:'generic_assigned',browserOwner:'passportMaintenance',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'employees.emergency_contact.maintain',module:'employees',owner:'personnel',service:'core/workforce-registers.ts#addEmergencyContact',contractVersion:1,
  prepare:{status:'implemented',adapter:'emergency_contact_maintenance_review_v1',inputSchema:'EmergencyContactMaintenance.Human',outputSchema:'EmergencyContactMaintenance.Prepared'},
  confirm:{status:'implemented',adapter:'emergency_contact_maintenance_review_v1',inputSchema:'EmergencyContactMaintenance.Confirmation',outputSchema:'EmergencyContactMaintenance.Completed'},
  outcome:'canonical_receipt_required',semantics:'shared_person_emergency_register_changed_not_employment_or_pay',humanInputs:['employmentId','subjectId','operation','contactId','fields'],
  permission:{actor:'hr_admin',guard:'core/assistant-actions/emergency-contact-maintenance-source.ts#withEmergencyContactMaintenanceIntervalTx'},subject:'other_person',blastRadius:{max:2,unit:'emergency_contact_and_previous_primary_priority'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'personnel'},reversal:{kind:'repeat'},evaluationCases:[],
  screen:{native:'app/admin/personnel/[employmentId]/page.tsx',entryPoints:['app/admin/personnel/[employmentId]/emergency-contact-actions.ts#addEmergencyContactAction','app/admin/personnel/[employmentId]/emergency-contact-actions.ts#editEmergencyContactAction','app/admin/personnel/[employmentId]/emergency-contact-actions.ts#deleteEmergencyContactAction']},review:{route:'/assistant/emergency-contacts',handoff:'review_page'},
  store:'generic_assigned',browserOwner:'emergencyContactMaintenance',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'employees.family.maintain',module:'employees',owner:'personnel',service:'core/workforce-registers.ts#addDependent',contractVersion:1,
  prepare:{status:'implemented',adapter:'family_maintenance_review_v1',inputSchema:'FamilyMaintenance.Human',outputSchema:'FamilyMaintenance.Prepared'},
  confirm:{status:'implemented',adapter:'family_maintenance_review_v1',inputSchema:'FamilyMaintenance.Confirmation',outputSchema:'FamilyMaintenance.Completed'},
  outcome:'canonical_receipt_required',semantics:'shared_person_family_and_native_auto_relief_changed_payroll_alert_only',humanInputs:['employmentId','subjectId','operation','dependentId','fields'],
  permission:{actor:'hr_admin',guard:'core/assistant-actions/family-maintenance-source.ts#withFamilyMaintenanceIntervalTx'},subject:'other_person',blastRadius:{max:2,unit:'family_record_and_native_automatic_relief'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'personnel'},reversal:{kind:'repeat'},evaluationCases:[],
  screen:{native:'app/admin/personnel/[employmentId]/page.tsx',entryPoints:['app/admin/personnel/[employmentId]/dependent-actions.ts#addDependentAction','app/admin/personnel/[employmentId]/dependent-actions.ts#editDependentAction','app/admin/personnel/[employmentId]/dependent-actions.ts#archiveDependentAction']},review:{route:'/assistant/family',handoff:'review_page'},
  store:'generic_assigned',browserOwner:'familyMaintenance',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'employees.qualification.maintain',module:'employees',owner:'personnel',service:'core/workforce-registers.ts#addQualification',contractVersion:1,
  prepare:{status:'implemented',adapter:'qualification_maintenance_review_v1',inputSchema:'QualificationMaintenance.Human',outputSchema:'QualificationMaintenance.Prepared'},
  confirm:{status:'implemented',adapter:'qualification_maintenance_review_v1',inputSchema:'QualificationMaintenance.Confirmation',outputSchema:'QualificationMaintenance.Completed'},
  outcome:'canonical_receipt_required',semantics:'qualification_register_changed_not_employment_or_pay',humanInputs:['employmentId','subjectId','operation','qualificationId','fields'],
  permission:{actor:'hr_admin',guard:'core/assistant-actions/qualification-maintenance-source.ts#withQualificationMaintenanceSubjectTx'},subject:'other_employment',blastRadius:{max:2,unit:'qualification_record_and_previous_highest_flag'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'personnel'},reversal:{kind:'repeat'},evaluationCases:[],
  screen:{native:'app/admin/personnel/[employmentId]/page.tsx',entryPoints:['app/admin/personnel/[employmentId]/qualification-actions.ts#addQualificationAction','app/admin/personnel/[employmentId]/qualification-actions.ts#editQualificationAction','app/admin/personnel/[employmentId]/qualification-actions.ts#archiveQualificationAction']},review:{route:'/assistant/qualifications',handoff:'review_page'},
  store:'generic_assigned',browserOwner:'qualificationMaintenance',pauseKey:'hr_assistant'}),

 defineAgentAction({id:'employees.draft.activate',module:'employees',owner:'personnel',service:'core/employee-draft.ts#saveAndCompleteEmployeeDraft',contractVersion:1,
  prepare:{status:'implemented',adapter:'employee_draft_activation_review_v1',inputSchema:'EmployeeDraftActivation.Human',outputSchema:'EmployeeDraftActivation.Prepared'},
  confirm:{status:'implemented',adapter:'employee_draft_activation_review_v1',inputSchema:'EmployeeDraftActivation.Confirmation',outputSchema:'EmployeeDraftActivation.Completed'},
  outcome:'canonical_receipt_required',semantics:'employment_created_not_payroll_processed_or_access_granted',humanInputs:['draftId','companyId'],
  permission:{actor:'hr_admin',guard:'core/assistant-actions/employee-draft-activation-source.ts#withEmployeeDraftActivationIntervalTx'},subject:'company',blastRadius:{max:1,unit:'new_person_employment_and_native_initial_owners'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'hiring'},reversal:{kind:'unknown'},evaluationCases:[],
  // The legacy endpoint accepts broader shapes; it remains backlog until every variant has parity.
  screen:{native:'app/admin/personnel/new/page.tsx',entryPoints:[]},review:{route:'/assistant/employee-drafts',handoff:'review_page'},store:'generic_own',browserOwner:'employeeDraftActivation',pauseKey:'hr_assistant'}),
 defineAgentAction({id:'toil.credit.grant',module:'toil',owner:'leave',service:'packs/leave/service.ts#grantLeaveCreditRowsTx',contractVersion:1,
  prepare:{status:'implemented',adapter:'module_leave_credit_review_v1',inputSchema:'HrLeaveCredit.Human',outputSchema:'HrLeaveCredit.Prepared'},
  confirm:{status:'implemented',adapter:'module_leave_credit_review_v1',inputSchema:'HrLeaveCredit.Confirmation',outputSchema:'HrLeaveCredit.Completed'},
  outcome:'canonical_receipt_required',semantics:'hr_leave_credit_banked_overtime_on_date_not_paid',humanInputs:['employmentId','subjectId','workedDate','claimStart','claimEnd','reason','firstScheduleConsent'],
  permission:{actor:'hr_admin',guard:'core/assistant-actions/hr-prepared-sources.ts#withHrLeaveCreditSubjectTx'},subject:'other_employment',blastRadius:{max:1,unit:'leave_credit_accrual_one_date'},
  idempotencyKey:'review_action_id',policy:{tier:'approve',category:'approvals'},reversal:{kind:'entry_point',by:'app/admin/leave-config/leave-credit/actions.ts#reverseLeaveCreditAction'},evaluationCases:[],
  screen:{native:'app/admin/leave-config/leave-credit/page.tsx',entryPoints:['app/admin/leave-config/leave-credit/actions.ts#grantLeaveCreditRowsAction']},review:{route:'/assistant/hr?flow=credit',handoff:'none'},
  store:'generic_assigned',browserOwner:'leaveCredit',pauseKey:'hr_assistant'}),
 /** WP13 (R18; ADR-0151 §4.4-4.5, owner decisions 1-2 of 29 Oct 2026): the first Automatic entries. The tenant's agent
  * principal runs them nightly behind an administrator's attributed switch-on, from templates only (no model, no
  * spend). Each appends one stamped reminder event; the notification registry re-checks that the item still waits
  * and notifies its current approver. They never approve, reject, submit or change a record. The effective pause is
  * the specialist switch in AI management (plus SETTING_KILL); pauseKey names that specialist; its own action pause remains in the stable hr_assistant namespace. */
 defineAgentAction({id:'approvals.claim.chase',module:'approvals',owner:'claims',service:'core/automatic-chasers.ts#runApprovalChasers',contractVersion:1,
  prepare:{status:'human_workflow_only',adapter:null,inputSchema:null,outputSchema:null},confirm:{status:'human_workflow_only',adapter:null,inputSchema:null,outputSchema:null},
  outcome:'notification_only',semantics:'approver_reminded_claim_decision_unchanged',humanInputs:'native_page_only',
  permission:{actor:'agent_principal',guard:'core/automatic-chasers.ts#assertAutomaticChaserTx'},subject:'assigned_request',blastRadius:{max:1,unit:'reminder_event_per_claim_stage'},
  idempotencyKey:'chase_item_stage_cooldown',policy:{tier:'automatic',category:'chaser'},reversal:{kind:'final'},evaluationCases:[],
  screen:{native:'app/approvals/page.tsx',entryPoints:[]},review:{route:'/approvals',handoff:'none'},
  store:'human_workflow_only',browserOwner:null,pauseKey:'approval_chasers',automatic:{specialist:'approval_chasers',source:'claim',overdueAfterDays:3,cooldownDays:7,maxPerItem:3,maxPerRun:100}}),
 defineAgentAction({id:'approvals.attendance.chase',module:'approvals',owner:'attendance',service:'core/automatic-chasers.ts#runApprovalChasers',contractVersion:1,
  prepare:{status:'human_workflow_only',adapter:null,inputSchema:null,outputSchema:null},confirm:{status:'human_workflow_only',adapter:null,inputSchema:null,outputSchema:null},
  outcome:'notification_only',semantics:'approver_reminded_attendance_decision_unchanged',humanInputs:'native_page_only',
  permission:{actor:'agent_principal',guard:'core/automatic-chasers.ts#assertAutomaticChaserTx'},subject:'assigned_request',blastRadius:{max:1,unit:'reminder_event_per_correction_stage'},
  idempotencyKey:'chase_item_stage_cooldown',policy:{tier:'automatic',category:'chaser'},reversal:{kind:'final'},evaluationCases:[],
  screen:{native:'app/approvals/page.tsx',entryPoints:[]},review:{route:'/approvals',handoff:'none'},
  store:'human_workflow_only',browserOwner:null,pauseKey:'approval_chasers',automatic:{specialist:'approval_chasers',source:'attendance_correction',overdueAfterDays:3,cooldownDays:7,maxPerItem:3,maxPerRun:100}}),
 defineAgentAction({id:'approvals.toil.chase',module:'approvals',owner:'leave',service:'core/automatic-chasers.ts#runApprovalChasers',contractVersion:1,
  prepare:{status:'human_workflow_only',adapter:null,inputSchema:null,outputSchema:null},confirm:{status:'human_workflow_only',adapter:null,inputSchema:null,outputSchema:null},
  outcome:'notification_only',semantics:'approver_reminded_replacement_decision_unchanged',humanInputs:'native_page_only',
  permission:{actor:'agent_principal',guard:'core/automatic-chasers.ts#assertAutomaticChaserTx'},subject:'assigned_request',blastRadius:{max:1,unit:'reminder_event_per_replacement_request'},
  idempotencyKey:'chase_item_stage_cooldown',policy:{tier:'automatic',category:'chaser'},reversal:{kind:'final'},evaluationCases:[],
  screen:{native:'app/approvals/page.tsx',entryPoints:[]},review:{route:'/approvals',handoff:'none'},
  store:'human_workflow_only',browserOwner:null,pauseKey:'approval_chasers',automatic:{specialist:'approval_chasers',source:'replacement_leave',overdueAfterDays:3,cooldownDays:7,maxPerItem:3,maxPerRun:100}}),
 defineAgentAction({id:'employees.review_overdue.remind',module:'employees',owner:'personnel',service:'core/automatic-chasers.ts#runReviewChasers',contractVersion:1,
  prepare:{status:'human_workflow_only',adapter:null,inputSchema:null,outputSchema:null},confirm:{status:'human_workflow_only',adapter:null,inputSchema:null,outputSchema:null},
  outcome:'notification_only',semantics:'review_owner_reminded_decision_unchanged',humanInputs:'native_page_only',
  permission:{actor:'agent_principal',guard:'core/automatic-chasers.ts#assertAutomaticChaserTx'},subject:'other_employment',blastRadius:{max:1,unit:'reminder_event_per_review_stage'},
  idempotencyKey:'chase_item_stage_cooldown',policy:{tier:'automatic',category:'reminder'},reversal:{kind:'final'},evaluationCases:[],
  screen:{native:'app/approvals/page.tsx',entryPoints:[]},review:{route:'/approvals',handoff:'none'},
  store:'human_workflow_only',browserOwner:null,pauseKey:'review_chasers',automatic:{specialist:'review_chasers',source:'employment_review',overdueAfterDays:1,cooldownDays:7,maxPerItem:4,maxPerRun:100}}),
 defineAgentAction({id:'attendance.missing_clock.remind',module:'attendance',owner:'attendance',service:'core/automatic-followups.ts#runAutomaticFollowups',contractVersion:1,
  prepare:{status:'human_workflow_only',adapter:null,inputSchema:null,outputSchema:null},confirm:{status:'human_workflow_only',adapter:null,inputSchema:null,outputSchema:null},
  outcome:'notification_only',semantics:'missing_record_reminded_no_work_attested',humanInputs:'native_page_only',
  permission:{actor:'agent_principal',guard:'core/automatic-followups.ts#assertAutomaticFollowupTx'},subject:'assigned_request',blastRadius:{max:1,unit:'reminder_event_per_item_stage'},
  idempotencyKey:'chase_item_stage_cooldown',policy:{tier:'automatic',category:'reminder'},reversal:{kind:'final'},evaluationCases:[],
  screen:{native:'app/me/page.tsx',entryPoints:[]},review:{route:'/me',handoff:'none'},
  store:'human_workflow_only',browserOwner:null,pauseKey:'clock_reminders',automatic:{specialist:'clock_reminders',source:'missing_clock',eligibility:'previous_date_record_gap',overdueAfterDays:1,cooldownDays:1,maxPerItem:1,maxPerRun:100}}),
 defineAgentAction({id:'employees.passport_expiry.remind',module:'employees',owner:'personnel',service:'core/automatic-followups.ts#runAutomaticFollowups',contractVersion:1,
  prepare:{status:'human_workflow_only',adapter:null,inputSchema:null,outputSchema:null},confirm:{status:'human_workflow_only',adapter:null,inputSchema:null,outputSchema:null},
  outcome:'notification_only',semantics:'recorded_passport_expiry_reminded_no_document_changed',humanInputs:'native_page_only',
  permission:{actor:'agent_principal',guard:'core/automatic-followups.ts#assertAutomaticFollowupTx'},subject:'assigned_request',blastRadius:{max:1,unit:'reminder_event_per_item_stage'},
  idempotencyKey:'chase_item_stage_cooldown',policy:{tier:'automatic',category:'reminder'},reversal:{kind:'final'},evaluationCases:[],
  screen:{native:'app/me/page.tsx',entryPoints:[]},review:{route:'/me',handoff:'none'},
  store:'human_workflow_only',browserOwner:null,pauseKey:'document_reminders',automatic:{specialist:'document_reminders',source:'passport_expiry',eligibility:'recorded_expiry_30_calendar_days',overdueAfterDays:1,cooldownDays:7,maxPerItem:4,maxPerRun:100}}),
 defineAgentAction({id:'lifecycle.step.chase',module:'lifecycle',owner:'lifecycle',service:'core/automatic-followups.ts#runAutomaticFollowups',contractVersion:1,
  prepare:{status:'human_workflow_only',adapter:null,inputSchema:null,outputSchema:null},confirm:{status:'human_workflow_only',adapter:null,inputSchema:null,outputSchema:null},
  outcome:'notification_only',semantics:'actionable_step_reminded_no_task_completed',humanInputs:'native_page_only',
  permission:{actor:'agent_principal',guard:'core/automatic-followups.ts#assertAutomaticFollowupTx'},subject:'assigned_request',blastRadius:{max:1,unit:'reminder_event_per_item_stage'},
  idempotencyKey:'chase_item_stage_cooldown',policy:{tier:'automatic',category:'reminder'},reversal:{kind:'final'},evaluationCases:[],
  screen:{native:'app/lifecycle/page.tsx',entryPoints:[]},review:{route:'/lifecycle',handoff:'none'},
  store:'human_workflow_only',browserOwner:null,pauseKey:'lifecycle_chasers',automatic:{specialist:'lifecycle_chasers',source:'lifecycle_step',eligibility:'working_wait',overdueAfterDays:3,cooldownDays:7,maxPerItem:3,maxPerRun:100}}),
] as const);

export type AgentAction=(typeof AGENT_ACTIONS)[number];
export type AgentActionId=AgentAction['id'];
export type AgentActionOf<K extends AgentActionId>=Extract<AgentAction,{readonly id:K}>;
export type AgentActionIdOfModule<M extends AgentModuleCode>=Extract<AgentAction,{readonly module:M}>['id'];
/** Actions with a prepared-review store row (app.assistant_own_leave_review). */
export type AgentReviewActionId=Exclude<AgentAction,{readonly store:'human_workflow_only'}>['id'];
/** Actions a model may nominate for a human-selected prepare. */
export type AgentPreparableActionId=Extract<AgentAction,{readonly prepare:{readonly status:'implemented'}}>['id'];
export type AgentActionAdapter=NonNullable<AgentAction['prepare']['adapter']>;
export type AgentActionBrowserOwner=AgentAction['browserOwner'];
export type AgentActionRoute=AgentAction['review']['route'];

const BY_ID:ReadonlyMap<string,AgentAction>=new Map<string,AgentAction>(AGENT_ACTIONS.map(action=>[action.id,action]));
if(BY_ID.size!==AGENT_ACTIONS.length)throw Error('Agent action registry has a duplicate id.');
export const AGENT_ACTION_IDS:readonly AgentActionId[]=Object.freeze(AGENT_ACTIONS.map(action=>action.id));
/** WP12 (R8): the per-action pause key, under the entry's module pause. Derived, so a new entry needs no extra field. */
export function agentActionPauseKey(action:Pick<AgentActionDefinition,'id'|'pauseKey'>):AgentActionOwnPauseKey{return `hr_assistant:${action.id}`;}
export function isAgentActionId(value:unknown):value is AgentActionId{return typeof value==='string'&&BY_ID.has(value);}
/** Runtime strings fail closed: unknown, inherited or future ids return null. */
export function agentActionById(id:unknown):AgentAction|null{return typeof id==='string'?BY_ID.get(id)??null:null;}
export function getAgentAction<K extends AgentActionId>(id:K):AgentActionOf<K>{const action=BY_ID.get(id);if(!action)throw Error('Agent action unavailable.');return action as AgentActionOf<K>;}
/** Registry order within the module (see the ordering note above AGENT_ACTIONS). */
export function agentActionsByModule<M extends AgentModuleCode>(module:M):readonly Extract<AgentAction,{readonly module:M}>[]{
 return Object.freeze(AGENT_ACTIONS.filter((action):action is Extract<AgentAction,{readonly module:M}>=>action.module===module));
}
export function agentActionsByTier<T extends AgentTier>(tier:T):readonly Extract<AgentAction,{readonly policy:{readonly tier:T}}>[]{
 return Object.freeze(AGENT_ACTIONS.filter((action):action is Extract<AgentAction,{readonly policy:{readonly tier:T}}>=>action.policy.tier===tier));
}
