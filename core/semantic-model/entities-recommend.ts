/** ADR-0170 step 5 — recommendations, the daily digest and the agent registry, declared in the semantic model.
 *
 * Three subjects step 5 produces (the approver recommendation, the daily digest and a registered worker), and
 * the inputs of the existing automated workers that no earlier step modelled (payroll anomalies, record
 * readiness gaps, pending approvals and follow-up items), so every registered worker can declare its read
 * scope from this model (core/agent-registry/workers.ts checks each scope id against terasEntities()).
 * These are entities only: no read is added to the Teras tool catalogue, so the harness offers nothing new.
 * suggested_action declares the harness's existing suggest_action result (privacy fixes, November 2026), and approval_queue
 * its approval_queue result (after run 41641279562).
 * Counts are `minimum` (the person may read every row behind them) except where they describe a group of
 * other people, which are `bands`. Rule-version labels carry internal ids, so they are `never`. */
import type {DisclosureClass,FieldType,SemanticEntity,SemanticField} from './types';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'|'screen'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

/** Owner decision, 2 November 2026: the AI never recommends rejecting a leave request. Two outcomes only. */
export const RECOMMENDATION_VERDICTS=['recommend_approve','needs_review'] as const;
export const RECOMMENDATION_CHECKS=['balance_covers','own_overlap','team_coverage','policy_limits'] as const;
export const RECOMMENDATION_RESULTS=['pass','fail','unusual','missing'] as const;
export const WORKER_FAMILIES=['watcher','chaser','preparer','decider','explainer'] as const;
/** suggest_action's relative start for a pending request (core/proposals/suggested.ts pendingStarts). */
export const PENDING_STARTS=['started','this_week','next_week','in_2_to_4_weeks','later'] as const;
export const WORKER_EFFECTS=['none','notify','prepare','complete_under_mandate'] as const;
const page=(meaning:string)=>f('page','label','full',meaning);

export const RECOMMEND_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'leave_decision_recommendation',label:'Approver recommendation',
  meaning:'For a leave request assigned to the caller to decide: recommend approve or needs review (never reject), computed only from native checks (balance, overlap with the applicant\'s own leave, team coverage, leave policy limits), each with its rule version. The approver always decides; the model only words it.',
  module:'approvals',sensitivity:'ordinary',audience:'assigned_approver',rls:'assigned_request',
  owners:['core/recommenders/leave-decision.ts#recommendLeaveDecision','core/recommenders/leave-decision.ts#evaluateLeaveDecision'],
  ruleVersion:'core/outcome-record/rule-versions.ts#leavePolicyVersionTx',relations:[{to:'leave_approval_step',kind:'many_to_one',via:'leaveRequestId'}],page:'/approvals',
  fields:[f('verdict','enum','full','The recommendation; needs_review unless all four checks pass.',{values:RECOMMENDATION_VERDICTS}),
   f('failedRules','list','full','Each failed rule and whether the leave rules themselves refuse on it, so the approver sees why.',{of:[f('check','enum','full','Which check.',{values:RECOMMENDATION_CHECKS}),
    f('blocking','boolean','full','A failure the leave rules themselves would refuse on.'),f('ruleVersion','code','never','The rule version the check ran under.')]}),
   f('checks','list','full','Every native check, in order.',{of:[f('check','enum','full','Which check.',{values:RECOMMENDATION_CHECKS}),
    f('result','enum','full','pass, fail, unusual or missing (could not be read).',{values:RECOMMENDATION_RESULTS}),
    f('blocking','boolean','full','A failure the leave rules themselves would refuse on.'),
    f('ruleVersion','code','never','The rule version the check ran under.')]}),
   f('recommenderVersion','label','full','Version of the recommendation rules.'),f('recordId','id','never','Handle of the outcome record.')]},
 {id:'daily_digest',label:'Daily digest',
  meaning:'What is waiting for the caller today: approvals waiting by kind, setup gaps from readiness and statutory deadlines, as counts and links only, built from the existing owners as the caller.',
  module:null,sensitivity:'ordinary',audience:'self',rls:'own_person',
  owners:['core/digest/daily-digest.ts#prepareDailyDigest','core/approvals-inbox.ts#listPendingTasks','core/setup-copilot/copilot.ts#setupCopilot','core/reporting.ts#complianceWorklist'],
  ruleVersion:null,relations:[],page:'/tasks',
  fields:[f('asOf','date','full','The HR day the digest was prepared for.'),
   f('approvals','object','full','Items waiting for the caller\'s decision.',{of:[f('total','integer','minimum','How many items wait.'),
    f('byKind','list','full','Counts per kind.',{of:[f('kind','label','full','Task kind.'),f('count','integer','minimum','How many.')]}),page('Where to decide them.')]}),
   f('setup','object','full','Administrators: setup stages blocked or needing attention, across the companies they administer.',{of:[f('blocked','integer','minimum','Stages blocked.'),
    f('attention','integer','minimum','Stages with warnings only.'),f('companies','integer','minimum','Companies checked.'),page('Where to fix them.')]}),
   f('deadlines','object','full','Administrators: statutory notifications overdue or due within seven days.',{of:[f('overdue','integer','bands','Overdue items.'),
    f('dueSoon','integer','bands','Items due within seven days.'),page('Where to file them.')]})]},
 {id:'agent_worker',label:'Automated worker',
  meaning:'One registered automated worker: its family, trigger, read scope, declared effect, authority, per-tenant switch, stop switch, last run, and acceptance and reversal rates where they are measurable.',
  module:null,sensitivity:'ordinary',audience:'admin',rls:'administered_scope',
  owners:['core/agent-registry/views.ts#listWorkers','core/agent-registry/views.ts#workerDetail','core/agent-registry/export.ts#exportAgentRegistry'],
  ruleVersion:null,relations:[],page:'/control-tower/agents',
  fields:[f('id','label','full','Worker key.'),f('family','enum','full','Worker family.',{values:WORKER_FAMILIES}),f('effect','enum','full','Declared effect.',{values:WORKER_EFFECTS}),
   f('trigger','label','full','What starts it.'),f('readScope','list','full','Semantic entities it reads.'),f('enabled','boolean','full','Its tenant switch.'),
   f('stopped','boolean','full','The tenant-wide stop switch.'),f('lastRunAt','datetime','full','When it last ran.'),
   f('acceptanceRate','number','bands','Share of its suggestions people accepted, when measured.'),f('reversalRate','number','bands','Share of accepted results later undone, when measured.')]},
 // Inputs of the existing automated workers (§3.7), declared so their read scope comes from the model.
 {id:'payroll_anomaly',label:'Payroll anomaly',meaning:'A deterministic detector finding on one payroll run line, with its disposition and the facts behind it.',
  module:'payroll',sensitivity:'pay',audience:'admin',rls:'administered_scope',owners:['core/payroll-anomaly.ts#evaluateBatchAnomalies','core/payroll-anomaly-narrate.ts#narrateVerdict'],
  ruleVersion:null,relations:[],page:'/control-tower',
  fields:[f('detector','label','full','Detector key.'),f('disposition','enum','full','Auto-clear, review or block.',{values:['auto_clear','review','block']}),
   f('facts','object','bands','The figures the detector compared.'),f('employmentId','id','never','Handle of the employment.')]},
 {id:'readiness_gap',label:'Record readiness gap',meaning:'A missing field on an employee record that blocks or weakens payroll or statutory filing.',
  module:null,sensitivity:'identity',audience:'admin',rls:'administered_scope',owners:['core/record-readiness.ts#agentReadinessSnapshot'],
  ruleVersion:null,relations:[],page:'/control-tower/readiness',
  fields:[f('gap','label','full','Gap key.'),f('people','integer','bands','How many records have it.'),f('employmentId','id','never','Handle of the employment.')]},
 {id:'pending_approval',label:'Pending approval',meaning:'An item waiting at its current approval stage, and who can decide it now.',
  module:'approvals',sensitivity:'ordinary',audience:'assigned_approver',rls:'assigned_request',owners:['core/approvals-inbox.ts#listPendingTasks','core/automatic-chasers.ts#overdueChaseItemsTx'],
  ruleVersion:null,relations:[],page:'/approvals',
  fields:[f('kind','label','full','Item kind.'),f('stage','label','full','Current stage.'),f('waitingSince','date','minimum','When the wait at this stage began.'),f('itemId','id','never','Handle of the item.')]},
 {id:'followup_item',label:'Follow-up item',meaning:'A missing clock-in, a passport expiring within 30 days, or a lifecycle step waiting three working days.',
  module:null,sensitivity:'ordinary',audience:'visible_scope',rls:'visible_employments',owners:['core/automatic-followups.ts#followupItemsTx'],
  ruleVersion:null,relations:[],page:'/tasks',
  fields:[f('source','enum','full','What is followed up.',{values:['missing_clock','passport_expiry','lifecycle_step']}),f('dueOn','date','minimum','When it became due.'),
   f('itemId','id','never','Handle of the item.')]},
 // The Teras harness's suggest_action result, disclosed under this declaration rather than as
 // product context: with several leave requests waiting, the approver chooses between them by number. The
 // model sees each request's ordinal, a leave type label (screened), its day count and a relative start; the
 // applicant and the exact dates are about another person, so they leave as placeholders the person sees restored.
 {id:'suggested_action',label:'Suggested change',
  meaning:'A pointer to the review page where the person completes and confirms one change, the pending leave requests an approver chooses between, or what a leave application from chat still needs.',
  module:null,sensitivity:'ordinary',audience:'assigned_approver',rls:'assigned_request',
  owners:['core/product-context/tools.ts#suggestAction','core/proposals/suggested.ts#prepareSuggestedProposal','core/proposals/suggested.ts#prepareChatLeaveApplyProposal'],
  ruleVersion:null,relations:[{to:'leave_approval_step',kind:'one_to_many',via:'leaveRequestId'}],page:'/approvals',
  fields:[f('suggested','boolean','full','Whether a review page was suggested.'),f('action','label','full','The action from available_actions.'),
   f('reviewRoute','label','full','The review page.'),f('inlineCard','boolean','full','Whether the change has an inline card.'),
   // Spec v20: no_match (nothing pending for this approver matches the person's words) and unavailable (that could not be read).
   f('reason','enum','full','Why nothing was suggested.',{values:['not_available','missing_details','no_match','unavailable']}),f('missing','list','full','Details still needed.'),
   f('page','label','full','The approvals page, when a decision matches nothing pending.'),
   // Issue 10: the caller's own apply menu, numbered, when a leave application's type is missing or unclear.
   f('options','list','full','Leave types the person may apply for, numbered in a fixed order, when the type is missing or unclear.',{of:[
    f('option','integer','full','The leave type\'s number in this list; the person chooses by it.'),
    f('leaveType','label','full','Leave type name.',{screen:'sensitive_label'}),
    // AI v2 W2: claim types or items to choose from, or the caller's own pending claims to cancel (core/proposals/claim-*.ts).
    f('claimType','label','full','Claim type name.',{screen:'sensitive_label'}),f('claimItem','label','full','Claim item name.',{screen:'sensitive_label'}),
    // The caller's own pending claim, so its date may be named back as incurredOn to choose it.
    f('incurredOn','date','full','Date one of the caller\'s own pending claims was incurred.'),f('amount','number','bands','Amount of a pending claim, as stored.')]}),
   f('notListed','integer','full','Further pending requests left to the review page.'),
   f('pending','list','full','Pending leave requests the approver chooses between, in a fixed order.',{of:[
    f('request','integer','full','The request\'s number in this list; the approver chooses by it.'),
    f('applicant','name','minimum','Who applied.'),f('leaveType','label','full','Leave type name.',{screen:'sensitive_label'}),
    f('days','number','full','Day quantity; with the applicant withheld it identifies no one.'),
    f('starts','enum','full','When it starts, relative to today.',{values:PENDING_STARTS}),
    f('startDate','date','minimum','First day.'),f('endDate','date','minimum','Last day.'),
    // AI v2 W2 (slice 3): assigned claims and attendance requests to choose between (core/proposals/assigned-decide.ts).
    f('date','date','minimum','The claim\'s date incurred, or the attendance day.'),
    f('claimType','label','full','Claim type name.',{screen:'sensitive_label'}),f('claimItem','label','full','Claim item name.',{screen:'sensitive_label'}),
    f('amount','number','bands','Amount of the claim, as stored.'),f('kind','enum','full','An overtime request or a clock correction.',{values:['overtime','correction']}),
    f('plannedStart','time','minimum','Overtime start.'),f('plannedEnd','time','minimum','Overtime end.'),
    f('checkIn','time','minimum','Clock-in asked for.'),f('checkOut','time','minimum','Clock-out asked for.')]})]},
 // The Teras harness's approval_queue result, disclosed under this declaration rather than as product context (after spec
 // v20's scored run 41641279562, mgr-queue-1: "1 leave request is waiting" without who or when). Beside the counts per kind,
 // the leave requests the queue counts that the leave decision card can open for this approver, numbered as suggest_action
 // numbers them. The applicant and the dates are about another person, so they leave as placeholders the person sees
 // restored, as on their approvals page; the leave type is screened and the day count identifies no one. The counts stay
 // `full`, exactly as the counts-only context tool sent them before.
 {id:'approval_queue',label:'Waiting for your decision',
  meaning:'What waits for the caller\'s own decision as an approver: counts per kind with the queue page and review action, from the approvals inbox, and the leave requests among them that the leave decision card can open for this approver.',
  module:'approvals',sensitivity:'ordinary',audience:'assigned_approver',rls:'assigned_request',
  owners:['core/product-context/approval-queue.ts#approvalQueueWithLeaveIdsFor','core/approvals-inbox.ts#listPendingTasks','core/proposals/suggested.ts#assignedLeaveDecisionChoices'],
  ruleVersion:null,relations:[{to:'leave_approval_step',kind:'one_to_many',via:'leaveRequestId'}],page:'/approvals',
  fields:[f('total','integer','full','How many items wait for this person\'s decision.'),
   f('groups','list','full','Counts per kind, largest first.',{of:[f('kind','label','full','Item kind.'),f('count','integer','full','How many.'),
    f('href','label','full','The queue page for the kind.'),f('reviewAction','label','full','The review action for the kind, where one exists.')]}),
   f('leaveRequests','list','full','Leave requests waiting for this person\'s decision that the decision card can open, in a fixed order.',{of:[
    f('request','integer','full','Its number: the number suggest_action takes as request.'),
    f('applicant','name','minimum','Who applied.'),f('leaveType','label','full','Leave type name.',{screen:'sensitive_label'}),
    f('days','number','full','Day quantity; with the applicant withheld it identifies no one.'),
    f('starts','enum','full','When it starts, relative to today.',{values:PENDING_STARTS}),
    f('startDate','date','minimum','First day.'),f('endDate','date','minimum','Last day.')]}),
   f('leaveRequestsNotListed','integer','full','Further waiting leave requests, left to the approvals page.'),
   f('decide','label','full','The action suggest_action takes to open the decision card for a listed leave request.')]},
] satisfies SemanticEntity[]);
