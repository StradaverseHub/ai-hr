/** Code-owned canonical domain playbooks. Models cannot choose facts, policy, thresholds or effects.
 * A playbook interprets permitted current facts; it never computes payroll/entitlement or approves work.
 * v1 is an explicit evaluated behavior candidate, not a cosmetic prompt/template variant. */
import {z} from 'zod';
import {canonicalSpecialistFollowup,FOLLOWUP_CODES,type SpecialistDiagnostic} from './module-specialist-followup';
import {AGENT_MODULE_CODES,MODULE_AGENT_CAPABILITIES,type AgentModuleCode} from './module-agents';
import {MODULE_AGENT_ACTIONS} from './module-agent-actions';
import {moduleHumanActionHandoffs} from './module-human-handoffs';
import {presentCanonicalModuleData} from './module-job-presentation';
import type {JobPresentation} from './module-jobs';
import {routingDigest} from './module-agent-routing';
export const SpecialistCandidate=z.object({kind:z.literal('canonical_specialist_v1'),module:z.enum(AGENT_MODULE_CODES),playbook:z.enum(['canonical_domain_v1','canonical_followup_v1'])}).strict();
export type SpecialistCandidate=z.infer<typeof SpecialistCandidate>;
export const SPECIALIST_FINDINGS=[
 'scope_current_caller','empty_is_not_tenant_absence','bounded_results','withheld_not_reconstructable',
 'employment_active','employment_inactive','choose_actual_employment','reporting_recorded','administrative_manager_missing',
 'leave_available_recorded','leave_pending_not_approved','readiness_gaps','readiness_currently_clear','readiness_no_subject',
 'own_request_pending','own_request_decided','request_partially_rejected','published_index_not_policy_text',
 'released_pay_stored_only','pay_record_incomplete_no_inference','attendance_exception_recorded','attendance_status_recorded',
 'claim_draft_not_submitted','claim_pending_not_approved','claim_approved_not_paid','claim_payment_recorded',
 'standard_review_unreleased','standard_review_released','onehr_review_status_not_rating','onehr_plan_status_not_endorsement',
 'reward_draft_not_awarded','reward_approved_not_posted','reward_posted_not_processed_or_paid','reward_decision_in_progress',
 'lifecycle_steps_remaining','lifecycle_progress_complete','lifecycle_progress_unknown',
 'credit_recorded_not_new_eligibility','credit_expired_not_available','credit_pay_conversion_not_payslip',
 'released_run_index_not_run_creation','additional_released_run_recorded','component_amount_stored_only','component_amount_unknown',
 'statutory_gap_not_rate_decision','statutory_readiness_not_filing','notification_unread_not_delivery_proof','notification_read_recorded',
 'schema_inventory_not_record_access','schema_partly_withheld','catalogue_not_permission','human_confirmation_owns_effects',
 'human_test_pass_not_independent_verification','human_test_failure_needs_native_followup','test_work_incomplete','test_not_applicable_not_pass',
] as const;
export type SpecialistFinding=typeof SPECIALIST_FINDINGS[number];
export type SpecialistAssessment=Readonly<{version:1;module:AgentModuleCode;coverage:'canonical_domain_guidance_only';findings:readonly SpecialistFinding[];presentation:JobPresentation;humanActions:ReturnType<typeof moduleHumanActionHandoffs>;effects:readonly [];requiresFreshNativeReview:true;diagnostic?:SpecialistDiagnostic}>;
const fail=():never=>{throw Error('Current specialist evidence unavailable.');},object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:fail(),array=(value:unknown)=>Array.isArray(value)?value.map(object):fail();
const bounded=(value:unknown)=>{const v=object(value);if(typeof v.truncated!=='boolean')return fail();return array(v.rows);};
const number=(value:unknown)=>{const parsed=typeof value==='number'?value:typeof value==='string'&&/^-?\d+(?:\.\d+)?$/.test(value)?Number(value):NaN;return Number.isFinite(parsed)?parsed:null;};
const positive=(value:unknown)=>{const n=number(value);return n!==null&&n>0;};
export function specialistNativeContractDigest(module:AgentModuleCode){return routingDigest(['specialist-native-contract-v1',module,MODULE_AGENT_CAPABILITIES.find(row=>row[0]===module),MODULE_AGENT_ACTIONS[module],moduleHumanActionHandoffs(module)]);}
export const SPECIALIST_ENGINE_DIGEST=routingDigest(['canonical-specialist-engine-v1',SPECIALIST_FINDINGS,'native-states-only','no-financial-or-entitlement-arithmetic','fresh-caller-only','fieldwise-native-leave-disclosure','canonical-followup-v1',FOLLOWUP_CODES]);
export const SPECIALIST_POLICY=Object.freeze({securityFailures:0,qualityFailures:0,independentEvaluators:2,maxJobs:100,maxHours:24,requiresNonemptyNativeEvidence:true,coverage:'canonical_domain_guidance_only' as const});
export const SPECIALIST_POLICY_DIGEST=routingDigest(SPECIALIST_POLICY);
/** Raw input must come from the actual current-caller owner, never a posted/model result. */
export function executeCanonicalSpecialist(candidateValue:unknown,source:{module:AgentModuleCode;capability:string;scope:string;data:unknown}):SpecialistAssessment{
 const candidate=SpecialistCandidate.parse(candidateValue),module=candidate.module;if(Object.keys(source).some(key=>!['module','capability','scope','data','humanActions'].includes(key)))return fail();
 if(source.module!==module||source.scope!=='current-caller'||source.capability!==MODULE_AGENT_CAPABILITIES.find(row=>row[0]===module)?.[1])return fail();
 // Native Mine disclosure is fieldwise: withheld means ANY component is hidden, not all summaries.
 // It omits decomposition aliases entirely when partial; their presence cannot override the owner.
 const data=source.data;if(module==='leave')for(const row of bounded(data))for(const balance of array(row.balances))if(balance.withheld===true&&['accrued','balance'].some(key=>Object.prototype.hasOwnProperty.call(balance,key)))return fail();if(module==='claims')for(const claim of array(object(data).claims))if(claim.status!=='paid'&&claim.paidAt!=null)return fail();const presentation=presentCanonicalModuleData(module,data),findings=new Set<SpecialistFinding>(['scope_current_caller']),add=(value:SpecialistFinding)=>{findings.add(value);};
 if(presentation.truncated)add('bounded_results');if(presentation.cards.some(card=>card.withheld))add('withheld_not_reconstructable');
 if(!presentation.cards.length)add('empty_is_not_tenant_absence');
 switch(module){
  case'employees':{const rows=bounded(data);if(rows.length>1)add('choose_actual_employment');for(const row of rows){if(['terminated','resigned','blacklisted'].includes(String(row.status)))add('employment_inactive');else if(['active','probation','active_serving_notice'].includes(String(row.status)))add('employment_active');}break;}
  case'org':for(const row of bounded(data)){const lines=array(row.reportingLines);if(lines.length)add('reporting_recorded');if(!lines.some(line=>line.lineType==='administrative'))add('administrative_manager_missing');}break;
  case'leave':for(const row of bounded(data))for(const balance of array(row.balances)){if(balance.withheld===true)add('withheld_not_reconstructable');if(balance.available!==null&&balance.available!==undefined)add('leave_available_recorded');if(positive(balance.pending))add('leave_pending_not_approved');}break;
  case'ess':case'country-my':{const row=object(data),gaps=array(row.gaps),employees=number(row.employees),ready=number(row.ready);if(employees===null||ready===null||!Number.isInteger(employees)||!Number.isInteger(ready)||employees<0||ready<0||ready>employees)return fail();if(employees===0)add('readiness_no_subject');else if(gaps.length)add('readiness_gaps');else if(number(row.ready)===number(row.employees))add('readiness_currently_clear');if(module==='country-my')add(gaps.some(gap=>gap.blocks==='statutory_filing')?'statutory_gap_not_rate_decision':'statutory_readiness_not_filing');break;}
  case'approvals':for(const row of bounded(data)){if(row.status==='pending')add('own_request_pending');else if(['approved','rejected','cancelled'].includes(String(row.status)))add('own_request_decided');if(row.hasRejectedDates===true)add('request_partially_rejected');}break;
  case'knowledge_base':if(bounded(data).length)add('published_index_not_policy_text');break;
  case'payroll':for(const row of bounded(data)){add('released_pay_stored_only');if(row.net==null||row.gross==null||row.deductions==null||row.currency==null)add('pay_record_incomplete_no_inference');}break;
  case'attendance':for(const row of bounded(data))add(['absent','late','half_day'].includes(String(row.status))?'attendance_exception_recorded':'attendance_status_recorded');break;
  case'claims':for(const row of array(object(data).claims)){if(row.status==='draft')add('claim_draft_not_submitted');else if(row.status==='pending')add('claim_pending_not_approved');else if(row.status==='paid')add('claim_payment_recorded');else if(row.status==='approved')add('claim_approved_not_paid');}break;
  case'performance':for(const row of bounded(data)){if(row.framework!=='onehr'&&typeof row.released!=='boolean')return fail();if(row.framework==='onehr')add(row.artifact==='plan'?'onehr_plan_status_not_endorsement':'onehr_review_status_not_rating');else if(row.released===true)add('standard_review_released');else add('standard_review_unreleased');}break;
  case'rewards':for(const row of bounded(data)){if(row.status==='posted')add('reward_posted_not_processed_or_paid');else if(row.status==='approved')add('reward_approved_not_posted');else if(row.status==='draft')add('reward_draft_not_awarded');else add('reward_decision_in_progress');}break;
  case'lifecycle':if(data!==null){const row=object(data),steps=array(row.steps),progress=object(row.progress);if(steps.some(step=>step.applicable===true&&typeof step.done!=='boolean'))return fail();if(steps.some(step=>step.applicable===true&&step.done===false))add('lifecycle_steps_remaining');else if(steps.some(step=>step.applicable===true)&&positive(progress.total)&&number(progress.done)===number(progress.total))add('lifecycle_progress_complete');else add('lifecycle_progress_unknown');}break;
  case'toil':for(const row of bounded(data)){if(positive(row.active))add('credit_recorded_not_new_eligibility');if(positive(row.expired))add('credit_expired_not_available');if(positive(row.convertedToPay))add('credit_pay_conversion_not_payslip');for(const credit of bounded(row.rows))if(credit.status==='expired')add('credit_expired_not_available');}break;
  case'multi_cycle_payroll':for(const row of bounded(data)){add('released_run_index_not_run_creation');if(number(row.runSeq)!==null&&number(row.runSeq)!>1)add('additional_released_run_recorded');}break;
  case'typed_pay_components':for(const row of bounded(data))for(const line of bounded(row.lines))add(line.amount==null?'component_amount_unknown':'component_amount_stored_only');break;
  case'notifications':for(const row of bounded(data))add(row.readAt==null?'notification_unread_not_delivery_proof':'notification_read_recorded');break;
  case'system_explorer':{const row=object(data);add('schema_inventory_not_record_access');if(positive(row.withheldTables))add('schema_partly_withheld');break;}
  case'assistant':add('catalogue_not_permission');add('human_confirmation_owns_effects');break;
  case'system_testing':for(const row of bounded(data)){if(row.status==='passed')add('human_test_pass_not_independent_verification');else if(['failed','blocked','retest_required'].includes(String(row.status)))add('human_test_failure_needs_native_followup');else if(row.status==='not_applicable')add('test_not_applicable_not_pass');else add('test_work_incomplete');}break;
  default:{const unsupported:never=module;void unsupported;return fail();}
 }
 return Object.freeze({version:1,module,coverage:'canonical_domain_guidance_only',findings:Object.freeze([...findings].sort()),presentation,humanActions:moduleHumanActionHandoffs(module),effects:Object.freeze([]) as readonly [],requiresFreshNativeReview:true,...(candidate.playbook==='canonical_followup_v1'?{diagnostic:canonicalSpecialistFollowup(module,data,presentation)}:{})});
}

/** Compact source-owned handoff to the shared Assistant. Facts stay in the original canonical data;
 * no duplicate card/transcript payload, actor capability, candidate ID or effect instruction. */
export type CompactSpecialistWork=Readonly<{version:1;module:AgentModuleCode;mode:'baseline'|'promoted';candidateVersion:number;playbook:SpecialistCandidate['playbook'];configurationDigest:string;findings:readonly SpecialistFinding[];diagnostic?:SpecialistDiagnostic;effects:readonly [];requiresFreshNativeReview:true}>;
export function compactSpecialistWork(assessment:SpecialistAssessment,selection:{mode:'baseline'|'promoted';version:number;configuration:SpecialistCandidate}):CompactSpecialistWork{
 const configuration=SpecialistCandidate.parse(selection.configuration);
 if(configuration.module!==assessment.module||!['baseline','promoted'].includes(selection.mode)||!Number.isSafeInteger(selection.version)||(selection.mode==='baseline'?(selection.version!==0||configuration.playbook!=='canonical_domain_v1'):(selection.version<1||configuration.playbook!=='canonical_followup_v1')))return fail();
 return Object.freeze({version:1,module:assessment.module,mode:selection.mode,candidateVersion:selection.version,playbook:configuration.playbook,configurationDigest:routingDigest(configuration),findings:assessment.findings,...(assessment.diagnostic?{diagnostic:assessment.diagnostic}:{}),effects:Object.freeze([]) as readonly [],requiresFreshNativeReview:true});
}
