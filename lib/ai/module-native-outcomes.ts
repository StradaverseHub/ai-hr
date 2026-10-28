/** Closed evidence links, not an executor, permission oracle, quality score or causal credit. */
import {z} from 'zod';
import type {ModuleEffectActionId} from './module-agent-actions';
import type {AgentModuleCode} from './module-agents';
const Id=z.guid().transform(value=>value.toLowerCase());
const entry=<M extends AgentModuleCode>(module:M,semantics:string)=>Object.freeze({module,semantics});
export const NATIVE_OUTCOME_ACTIONS=Object.freeze({
 'employees.import':entry('employees','canonical_import_committed_not_quality_certified'),
 'org.reporting.change':entry('org','reporting_change_recorded'),
 'leave.apply':entry('leave','submitted_not_approved'),
 'ess.profile.request':entry('ess','submitted_not_approved_or_applied'),
 'approvals.leave.decide':entry('approvals','decision_recorded_current_request_state_separate'),
 'knowledge_base.article.create':entry('knowledge_base','article_created_not_content_certified'),
 'payroll.close':entry('payroll','batch_close_recorded_not_payment'),
 'attendance.correction.request':entry('attendance','correction_requested_not_approved'),
 'claims.draft.save':entry('claims','draft_saved_not_submitted_or_reimbursed'),
 'claims.submit':entry('claims','submitted_not_approved_or_reimbursed'),
 'claims.cancel':entry('claims','pending_claim_cancelled_no_payment_effect'),
 'performance.review.acknowledge':entry('performance','review_acknowledged_not_rating_endorsement'),
 'performance.onehr.plan.acknowledge':entry('performance','career_conversation_acknowledged_not_rating_endorsement'),
 'rewards.post':entry('rewards','posted_to_payroll_inputs_not_processed_or_paid'),
 'lifecycle.acknowledgement.submit':entry('lifecycle','equipment_acknowledgement_recorded'),
 'toil.replacement.request':entry('toil','replacement_request_submitted_not_approved'),
 'multi_cycle_payroll.create_run':entry('multi_cycle_payroll','draft_run_created_not_processed_or_paid'),
 'typed_pay_components.create':entry('typed_pay_components','component_created_not_pay_calculated'),
 'country-my.statutory.update':entry('country-my','statutory_record_saved_not_filed'),
 'notifications.email_preferences.save':entry('notifications','historical_event_current_preferences_not_delivery'),
 'system_testing.execution.save':entry('system_testing','human_reported_observation_not_independent_verification'),
} satisfies Record<ModuleEffectActionId,Readonly<{module:AgentModuleCode;semantics:string}>>);
export type NativeOutcomeAction=keyof typeof NATIVE_OUTCOME_ACTIONS;
export const NATIVE_REVIEW_ACTIONS=Object.freeze(Object.keys(NATIVE_OUTCOME_ACTIONS).filter((action):action is Exclude<NativeOutcomeAction,'employees.import'>=>action!=='employees.import'));
export const NativeOutcomeReference=z.discriminatedUnion('source',[
 z.object({source:z.literal('review'),action:z.enum(NATIVE_REVIEW_ACTIONS as [typeof NATIVE_REVIEW_ACTIONS[number],...typeof NATIVE_REVIEW_ACTIONS[number][]]),actionId:Id}).strict(),
 z.object({source:z.literal('employee_import'),action:z.literal('employees.import'),attemptId:Id,attemptVersion:z.number().int().positive(),companyId:Id}).strict(),
]);
export type NativeOutcomeReference=z.infer<typeof NativeOutcomeReference>;
export const RecordNativeOutcomeAssociation=z.object({jobId:Id,reference:NativeOutcomeReference,consented:z.literal(true),nonce:Id}).strict();
export type RecordNativeOutcomeAssociation=z.infer<typeof RecordNativeOutcomeAssociation>;
export const NativeOutcomeAssociationId=z.object({associationId:Id}).strict();
/** Server-internal references only. No values, names, private fingerprints or learned HR data. */
export const NativeOutcomeEvidence=z.object({action:z.enum(Object.keys(NATIVE_OUTCOME_ACTIONS) as [NativeOutcomeAction,...NativeOutcomeAction[]]),sourceId:Id,eventId:Id,currentStatus:z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).nullable()}).strict();
export type NativeOutcomeEvidence=z.infer<typeof NativeOutcomeEvidence>;
export const NativeOutcomeAssociationView=z.object({associationId:Id,action:z.enum(Object.keys(NATIVE_OUTCOME_ACTIONS) as [NativeOutcomeAction,...NativeOutcomeAction[]]),module:z.string(),semantics:z.string(),currentStatus:z.string().nullable(),association:z.literal('human_linked_verified_native_outcome'),causalCredit:z.literal(false),quality:z.literal('not_assessed'),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();
export type NativeOutcomeAssociationView=z.infer<typeof NativeOutcomeAssociationView>;
export function nativeOutcomeDescriptor(action:NativeOutcomeAction){if(!Object.hasOwn(NATIVE_OUTCOME_ACTIONS,action))throw Error('Native outcome unavailable.');return NATIVE_OUTCOME_ACTIONS[action];}
/** These modules have genuine observations, never synthetic native effect receipts. */
export const NON_EFFECT_OBSERVATIONS=Object.freeze({system_explorer:'authorized_schema_observation',assistant:'authorized_orchestration_read_execution'} as const);
