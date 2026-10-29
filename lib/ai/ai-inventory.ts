/** WP12 — architecture review R8, R20, R21 (ADR-0116, ADR-0151 §4.7). Pure, deterministic metadata:
 *
 *  1. THE AI INVENTORY: every AI component, derived from the owners that already declare it — the gateway feature
 *     list (lib/ai/features.ts), the agent action registry (agent-action-registry.ts), the module read bindings
 *     (module-jobs.ts), the agent principal specialists (agent-capability-inventory.ts), the nightly orchestrator
 *     pass (core/hr-orchestrator.ts runHrOrchestrator) and the scheduled jobs (core/job-run.ts). Nothing here is a
 *     second declaration: a new feature, action or binding appears without editing this file, and
 *     test/ai-inventory.test.ts fails if an owner's entry is missing from the inventory.
 *  2. ALERT THRESHOLDS and their evaluation (R20), shared by the AI management banner and scripts/ai-alerts.ts.
 *  3. SWITCH DRIFT: configured-vs-effective switch disagreement, from the AI management view's own fields.
 *  4. THE PROVIDER DATA REGISTER (R21): per gateway feature, which field categories leave the tenant for the model
 *     provider and after which redaction. Each entry names the prompt builder it was read from; a reviewer
 *     re-reads that source when the feature changes. It is a disclosure record, not an enforcement mechanism.
 *  5. RUN HISTORY RANGE AND PAGING.
 *
 * This file grants nothing. Access is core/ai-inventory.ts's job; authority stays user ∩ registry ∩ tier ∩ switches.
 */
import {AI_FEATURES,type AiFeatureId} from './features';
import {AGENT_ACTIONS,agentActionPauseKey} from './agent-action-registry';
import {MODULE_JOBS} from './module-jobs';
import {AGENT_PRINCIPAL_SPECIALISTS} from './agent-capability-inventory';
import type {AgentTier} from './agent-action-tiers';

export const AI_COMPONENT_KINDS=['chat','read_binding','specialist','action','scheduled_job','embedded_feature','orchestrator_step','operator_loop'] as const;
export type AiComponentKind=(typeof AI_COMPONENT_KINDS)[number];

export type AiInventoryComponent=Readonly<{
 /** Stable row key: `<kind>:<id>`. */
 key:string;kind:AiComponentKind;id:string;
 /** The gateway feature whose runs, cost and switch this row reports; null = no model call of its own. */
 featureId:AiFeatureId|null;
 module:string|null;tier:AgentTier|null;category:string|null;
 /** The pause key that stops it: the feature id, or `hr_assistant:<actionId>` for one agent action. */
 pauseKey:string|null;
 /** A job_run.job_key whose last run this row reports, if any. */
 jobKey:string|null;
 /** Operator tooling outside the product: listed so nothing is hidden, never switched from this screen. */
 outOfBand:boolean;
}>;

const featureOf=(id:AiFeatureId)=>AI_FEATURES.find(f=>f.id===id)!;
const row=(r:Omit<AiInventoryComponent,'key'|'outOfBand'|'jobKey'|'tier'|'category'>&Partial<Pick<AiInventoryComponent,'outOfBand'|'jobKey'|'tier'|'category'>>):AiInventoryComponent=>
 Object.freeze({tier:null,category:null,jobKey:null,outOfBand:false,...r,key:`${r.kind}:${r.id}`});

/** The orchestrator pass steps, in the order runHrOrchestrator runs them (core/hr-orchestrator.ts). */
export const ORCHESTRATOR_STEPS=Object.freeze([
 {id:'observe',featureId:null},
 {id:'readiness',featureId:'readiness_reminders'},
 {id:'claims',featureId:'claims_triage'},
] as const satisfies readonly {id:string;featureId:AiFeatureId|null}[]);

/** Scheduled work that touches AI. review.sweep runs the nightly orchestrator pass under the agent principal
 * (scripts/review-sweep.ts); ai-retention purges AI run history (scripts/ai-retention-runner.ts, systemd timer,
 * no job_run row); ai.alerts is this package's alert check (scripts/ai-alerts.ts, run under deploy/cron-alert.sh). */
export const AI_SCHEDULED_JOBS=Object.freeze([
 {id:'review.sweep',jobKey:'review.sweep',featureId:null},
 {id:'ai-retention',jobKey:null,featureId:null},
 {id:'ai-alerts',jobKey:'ai.alerts',featureId:null},
] as const);

export function aiInventoryComponents():readonly AiInventoryComponent[]{
 const rows:AiInventoryComponent[]=[];
 rows.push(row({kind:'chat',id:'hr_assistant',featureId:'hr_assistant',module:'assistant',pauseKey:'hr_assistant'}));
 for(const [module] of MODULE_JOBS)rows.push(row({kind:'read_binding',id:module,featureId:'hr_assistant',module,category:'read',pauseKey:'hr_assistant'}));
 for(const f of AI_FEATURES.filter(f=>f.kind==='agent')){
  const principal=(AGENT_PRINCIPAL_SPECIALISTS as Record<string,{tier:AgentTier}>)[f.id];
  rows.push(row({kind:'specialist',id:f.id,featureId:f.id,module:f.module,tier:principal?.tier??null,pauseKey:f.id}));
 }
 for(const a of AGENT_ACTIONS)rows.push(row({kind:'action',id:a.id,featureId:'automatic' in a?a.automatic.specialist:'hr_assistant',module:a.module,tier:a.policy.tier,category:a.policy.category,pauseKey:agentActionPauseKey(a)}));
 for(const j of AI_SCHEDULED_JOBS)rows.push(row({kind:'scheduled_job',id:j.id,featureId:j.featureId,module:null,pauseKey:null,jobKey:j.jobKey}));
 for(const f of AI_FEATURES.filter(f=>(f.kind==='feature'||f.kind==='assistant')&&f.id!=='hr_assistant'))rows.push(row({kind:'embedded_feature',id:f.id,featureId:f.id,module:f.module,pauseKey:f.id}));
 for(const s of ORCHESTRATOR_STEPS)rows.push(row({kind:'orchestrator_step',id:s.id,featureId:s.featureId,module:s.featureId?featureOf(s.featureId).module:null,pauseKey:s.featureId}));
 // The operator improve loop (scripts/improve/, feedback_planning): platform-managed, never a tenant switch.
 rows.push(row({kind:'operator_loop',id:'improve',featureId:'feedback_planning',module:null,pauseKey:'feedback_planning',outOfBand:true}));
 return Object.freeze(rows);
}

/** Company HR's read-only registry/tier view (ADR-0151 §4.7): no runtime, cost, people or provider facts. */
export type AiRegistryRow=Pick<AiInventoryComponent,'key'|'kind'|'id'|'module'|'tier'|'category'|'pauseKey'|'outOfBand'>;
export const registryRow=(c:AiInventoryComponent):AiRegistryRow=>({key:c.key,kind:c.kind,id:c.id,module:c.module,tier:c.tier,category:c.category,pauseKey:c.pauseKey,outOfBand:c.outOfBand});

// ── Alerts (R20) ────────────────────────────────────────────────────────────────────────────────────────────
export const AI_ALERT_THRESHOLDS=Object.freeze({
 /** Failure rate over the last 24 hours of admitted (not blocked) runs, once at least minRuns ran. */
 failureRateWarning:0.2,failureRateCritical:0.5,minRuns:5,
 /** Any refusal under the agent principal is unexpected: scheduled work is template-only (owner decision 2). */
 principalRefusals:1,
 /** Share of a monetary or token cap used, from the existing allowance meter (allowanceLevel: near 80%, at 100%). */
 spendNear:0.8,
});
export const AI_ALERT_KINDS=['failure_rate','principal_refusals','spend_near_cap','switch_drift'] as const;
export type AiAlertKind=(typeof AI_ALERT_KINDS)[number];
export type AiAlert=Readonly<{kind:AiAlertKind;level:'warning'|'critical';count:number;detail:string|null}>;
export type AiAlertInput=Readonly<{
 runs24h:{admitted:number;failed:number};
 principalRefusals24h:number;
 /** This Kuala Lumpur month's tenant USD allocation use (held + confirmed nano-USD) against the tenant monthly cap;
  * null where the caller cannot read the private ledger (the app role cannot; scripts/ai-alerts.ts can). */
 spend:{usedNanos:bigint;capNanos:bigint|null}|null;
 /** A reconciled charge exceeded its verified allocation (app.ai_spend_status `breached`): strict admissions pause. */
 spendBreached?:boolean;
 /** Token/request allowances at or near their cap (AI management attention). */
 allowancesNear:number;allowancesAt:number;
 drift:readonly SwitchDrift[];
}>;
/** Deterministic: the same input always yields the same alerts, in AI_ALERT_KINDS order. */
export function evaluateAiAlerts(i:AiAlertInput):AiAlert[]{
 const out:AiAlert[]=[],T=AI_ALERT_THRESHOLDS;
 if(i.runs24h.admitted>=T.minRuns&&i.runs24h.failed>0){
  const rate=i.runs24h.failed/i.runs24h.admitted;
  if(rate>=T.failureRateWarning)out.push({kind:'failure_rate',level:rate>=T.failureRateCritical?'critical':'warning',count:i.runs24h.failed,detail:`${Math.round(rate*100)}%`});
 }
 if(i.principalRefusals24h>=T.principalRefusals)out.push({kind:'principal_refusals',level:'critical',count:i.principalRefusals24h,detail:null});
 let spendLevel:'warning'|'critical'|null=null,spendCount=0;
 if(i.spend&&i.spend.capNanos!==null){
  const cap=i.spend.capNanos,used=i.spend.usedNanos;
  if(cap<=BigInt(0)||used>=cap){spendLevel='critical';spendCount++;}
  else if(used*BigInt(100)>=cap*BigInt(Math.round(T.spendNear*100))){spendLevel='warning';spendCount++;}
 }
 if(i.spendBreached){spendLevel='critical';spendCount++;}
 if(i.allowancesAt>0){spendLevel='critical';spendCount+=i.allowancesAt;}
 if(i.allowancesNear>0){spendLevel??='warning';spendCount+=i.allowancesNear;}
 if(spendLevel)out.push({kind:'spend_near_cap',level:spendLevel,count:spendCount,detail:null});
 if(i.drift.length)out.push({kind:'switch_drift',level:'warning',count:i.drift.length,detail:[...new Set(i.drift.map(d=>d.featureId))].join(',')});
 return out;
}

// ── Switch drift (R20) ──────────────────────────────────────────────────────────────────────────────────────
export const SWITCH_DRIFT_REASONS=['stale_override','module_off','platform_restricted','unattributed_agent'] as const;
export type SwitchDriftReason=(typeof SWITCH_DRIFT_REASONS)[number];
export type SwitchDrift=Readonly<{featureId:string;reason:SwitchDriftReason}>;
export type SwitchDriftFeature=Readonly<{id:string;enabled:boolean;state:string;staleOverride:{enabled:boolean}|null;
 /** An administrator stored this switch (not a default). Module/platform drift is reported only for a configured switch. */
 configured?:boolean}>;
/** Configured-vs-effective: a switch an administrator set ON that does not take effect, or a stored override the
 * gateway ignores (0692) that disagrees with the real switch, or an agent specialist switched on with no named
 * administrator (ADR-0151 §4.5: it does not run). `state` is aiManagementView's computed state. */
/** THE stale-override rule, shared by the banner (switchDrift) and the cron sweep (core/ai-alert-sweep.ts): a `feature:`
 * policy row left for a setting-backed feature (ignored by admission since 0692) is drift when it disagrees with the
 * feature's real switch, i.e. its setting as resolved with the entitlement snapshot's provenance rule. */
export const staleOverrideDisagrees=(overrideEnabled:boolean,switchOn:boolean)=>overrideEnabled!==switchOn;
/** Which drift reasons each surface can evaluate. The sweep has no session entitlement resolution, so it evaluates the
 * stale-override rule only; the banner evaluates all four. Both use the same rule functions. */
export const SWEEP_DRIFT_REASONS=['stale_override'] as const satisfies readonly SwitchDriftReason[];
export function switchDrift(features:readonly SwitchDriftFeature[],agentSwitches:Readonly<Record<string,{state:string}|undefined>>={}):SwitchDrift[]{
 const out:SwitchDrift[]=[];
 for(const f of features){
  if(f.staleOverride&&staleOverrideDisagrees(f.staleOverride.enabled,f.enabled))out.push({featureId:f.id,reason:'stale_override'});
  if(f.configured!==false&&f.enabled&&f.state==='module')out.push({featureId:f.id,reason:'module_off'});
  if(f.configured!==false&&f.enabled&&f.state==='restricted')out.push({featureId:f.id,reason:'platform_restricted'});
  if(agentSwitches[f.id]?.state==='unattributed')out.push({featureId:f.id,reason:'unattributed_agent'});
 }
 return out;
}

// ── Provider data register (R21) ────────────────────────────────────────────────────────────────────────────
export const AI_DATA_FIELDS=['question_text','scoped_hr_records','pasted_import_source','admin_prompt','synthetic_only','column_headings',
 'gap_codes','claim_details','payroll_ratios','payroll_figures','rule_description','field_catalogue','performance_text','first_name',
 'full_names','approver_names','attachment_text','image_attachments','product_feedback_text'] as const;
export type AiDataField=(typeof AI_DATA_FIELDS)[number];
/** pii_masked = redactPII (emails, Malaysian IC numbers, phone-like runs; NEVER names); partial = some fields
 * masked, others not; none = sent as read; not_needed = no free text or no tenant data. */
export type AiRedaction='pii_masked'|'partial'|'none'|'not_needed';
export type AiDataRegisterEntry=Readonly<{fields:readonly AiDataField[];redaction:AiRedaction;images:boolean;
 /** Scheduled (agent principal) use sends nothing: template only or refused before any read. */
 principalSendsNothing?:true;anchor:string}>;
/** Read from source at e71f7ec43 (prompt builders named in `anchor`). Re-read the anchor when a feature changes. */
export const AI_DATA_REGISTER:Readonly<Record<AiFeatureId,AiDataRegisterEntry>>=Object.freeze({
 hr_assistant:{fields:['question_text','scoped_hr_records','pasted_import_source','admin_prompt'],redaction:'none',images:false,anchor:'core/assistant.ts (converse; lib/ai/index.ts skips redaction), core/assistant-tools.ts, core/assistant-import.ts'},
 provider_evaluation:{fields:['synthetic_only'],redaction:'not_needed',images:false,anchor:'lib/ai/provider-protocol.ts, core/ai-provider-readiness.ts'},
 module_agent_evaluation:{fields:['synthetic_only','admin_prompt'],redaction:'not_needed',images:false,anchor:'core/module-agent-prompt-harness.ts, core/assistant-conversation-harness.ts'},
 personnel_import_mapping:{fields:['column_headings','field_catalogue'],redaction:'none',images:false,anchor:'core/personnel-import-assistance.ts'},
 module_agent_planning:{fields:['question_text','admin_prompt'],redaction:'none',images:false,anchor:'core/module-agent-releases.ts (human question prompt)'},
 approval_chasers:{fields:[],redaction:'not_needed',images:false,principalSendsNothing:true,anchor:'core/automatic-chasers.ts (fixed templates only)'},
 review_chasers:{fields:[],redaction:'not_needed',images:false,principalSendsNothing:true,anchor:'core/automatic-chasers.ts (fixed templates only)'},
 clock_reminders:{fields:[],redaction:'not_needed',images:false,principalSendsNothing:true,anchor:'core/automatic-followups.ts (fixed templates only)'},
 document_reminders:{fields:[],redaction:'not_needed',images:false,principalSendsNothing:true,anchor:'core/automatic-followups.ts (fixed templates only)'},
 lifecycle_chasers:{fields:[],redaction:'not_needed',images:false,principalSendsNothing:true,anchor:'core/automatic-followups.ts (fixed templates only)'},
 readiness_reminders:{fields:['gap_codes'],redaction:'not_needed',images:false,principalSendsNothing:true,anchor:'core/readiness-nudge.ts'},
 claims_triage:{fields:['claim_details'],redaction:'pii_masked',images:false,principalSendsNothing:true,anchor:'core/input-triage.ts (claimAsText)'},
 payroll_hypotheses:{fields:['payroll_ratios'],redaction:'not_needed',images:false,anchor:'core/payroll-hypothesis.ts (featuresAsText)'},
 payroll_explanation:{fields:['payroll_figures'],redaction:'not_needed',images:false,anchor:'core/payroll-anomaly-narrate.ts'},
 pay_rule_draft:{fields:['rule_description'],redaction:'pii_masked',images:false,anchor:'core/pay-rule-ai.ts'},
 report_insight:{fields:['field_catalogue','question_text'],redaction:'pii_masked',images:false,anchor:'core/report-ai.ts'},
 performance_360:{fields:['performance_text'],redaction:'pii_masked',images:false,anchor:'packs/performance/onehr/feedback-conversation.ts, rewrite-service.ts'},
 performance_tc:{fields:['performance_text','first_name','approver_names'],redaction:'pii_masked',images:false,anchor:'packs/performance/onehr/competency-insight-service.ts, potential-insight-service.ts, written-remarks-service.ts'},
 performance_pm:{fields:['performance_text','approver_names','attachment_text','image_attachments','question_text'],redaction:'partial',images:true,anchor:'core/performance.ts (manager review draft), packs/performance/onehr/insight-service.ts, evidence-reading.ts, review-command-ai.ts'},
 performance_review:{fields:['performance_text','question_text','first_name'],redaction:'pii_masked',images:false,anchor:'packs/performance/onehr/guide-service.ts, admin-agent-service.ts, talent-insight-service.ts'},
 performance_idp:{fields:['performance_text','first_name'],redaction:'partial',images:false,anchor:'packs/performance/onehr/career-draft-service.ts, development-suggestion-service.ts (unredacted), idp-fit-service.ts'},
 performance_calib:{fields:['question_text','full_names'],redaction:'none',images:false,anchor:'packs/performance/onehr/calibration-conversation.ts'},
 performance_assistant:{fields:['question_text','performance_text'],redaction:'none',images:false,anchor:'packs/performance/onehr/review-command-ai.ts, provider-source-draft.ts'},
 feedback_planning:{fields:['product_feedback_text'],redaction:'pii_masked',images:false,anchor:'core/feedback.ts'},
});

// ── Run history range and paging ───────────────────────────────────────────────────────────────────────────
export const AI_RUN_PAGE_SIZE=50;
export const AI_RUN_MAX_RANGE_DAYS=366;
export const AI_RUN_DEFAULT_RANGE_DAYS=30;
export type AiRunRange=Readonly<{from:string;to:string;page:number}>;
const ISO_DATE=/^\d{4}-\d{2}-\d{2}$/;
const validDate=(v:unknown):v is string=>typeof v==='string'&&ISO_DATE.test(v)&&!Number.isNaN(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
const addDays=(d:string,n:number)=>new Date(Date.parse(`${d}T00:00:00Z`)+n*86400000).toISOString().slice(0,10);
/** Inclusive Kuala Lumpur calendar dates. `today` comes from the HR date owner (lib/hr-date todayInKualaLumpur).
 * Invalid or reversed input falls back to the default window; a range longer than the maximum is clipped to its
 * last AI_RUN_MAX_RANGE_DAYS days; a page is a positive integer (page 1 when absent or invalid). */
export function parseAiRunRange(input:{from?:unknown;to?:unknown;page?:unknown},today:string):AiRunRange{
 if(!validDate(today))throw Error('A Kuala Lumpur calendar date is required.');
 let to=validDate(input.to)&&input.to<=today?input.to:today;
 let from=validDate(input.from)?input.from:addDays(to,-(AI_RUN_DEFAULT_RANGE_DAYS-1));
 if(from>to){from=addDays(to,-(AI_RUN_DEFAULT_RANGE_DAYS-1));}
 if(from<addDays(to,-(AI_RUN_MAX_RANGE_DAYS-1)))from=addDays(to,-(AI_RUN_MAX_RANGE_DAYS-1));
 const n=typeof input.page==='string'&&/^\d{1,6}$/.test(input.page)?Number(input.page):typeof input.page==='number'?input.page:1;
 return {from,to,page:Number.isSafeInteger(n)&&n>=1&&n<=100000?n:1};
}
/** SQL bounds: [from 00:00 KL, to+1 00:00 KL). */
export const aiRunRangeBounds=(r:AiRunRange)=>({fromTs:`${r.from}T00:00:00+08:00`,toTs:`${addDays(r.to,1)}T00:00:00+08:00`});
export const aiRunPageOffset=(r:AiRunRange)=>(r.page-1)*AI_RUN_PAGE_SIZE;
