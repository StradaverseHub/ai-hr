/** ADR-0170 step 5 — recommendations, the daily digest and the agent registry, declared in the semantic model.
 *
 * Three subjects step 5 produces (the approver recommendation, the daily digest and a registered worker), and
 * the inputs of the existing automated workers that no earlier step modelled (payroll anomalies, record
 * readiness gaps, pending approvals and follow-up items), so every registered worker can declare its read
 * scope from this model (core/agent-registry/workers.ts checks each scope id against terasEntities()).
 * These are entities only: no read is added to the Teras tool catalogue, so the harness offers nothing new.
 * Counts are `minimum` (the person may read every row behind them) except where they describe a group of
 * other people, which are `bands`. Rule-version labels carry internal ids, so they are `never`. */
import type {DisclosureClass,FieldType,SemanticEntity,SemanticField} from './types';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

/** Owner decision, 2 November 2026: the AI never recommends rejecting a leave request. Two outcomes only. */
export const RECOMMENDATION_VERDICTS=['recommend_approve','needs_review'] as const;
export const RECOMMENDATION_CHECKS=['balance_covers','own_overlap','team_coverage','policy_limits'] as const;
export const RECOMMENDATION_RESULTS=['pass','fail','unusual','missing'] as const;
export const WORKER_FAMILIES=['watcher','chaser','preparer','decider','explainer'] as const;
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
] satisfies SemanticEntity[]);
