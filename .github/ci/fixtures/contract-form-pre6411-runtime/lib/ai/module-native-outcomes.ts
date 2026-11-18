/** Closed evidence links, not an executor, permission oracle, quality score or causal credit. */
import {z} from 'zod';
import type {AgentModuleCode} from './module-agents';
import {AGENT_ACTIONS,type AgentAction,type AgentActionOf,type AgentReviewActionId} from './agent-action-registry';
const Id=z.guid().transform(value=>value.toLowerCase());
type NativeEffectActionId=Exclude<AgentAction,{readonly outcome:'notification_only'}>['id'];
type NativeOutcomeEntry<K extends NativeEffectActionId>=Readonly<{module:AgentActionOf<K>['module'];semantics:string}>;
/** Human native effects only, in registry order. Automatic reminders have separate event evidence;
 * they cannot become human-linked native effect receipts. */
export const NATIVE_OUTCOME_ACTIONS=Object.freeze(Object.fromEntries(AGENT_ACTIONS.filter(action=>action.outcome!=='notification_only').map(action=>[action.id,Object.freeze({module:action.module,semantics:action.semantics})]))) as {readonly [K in NativeEffectActionId]:NativeOutcomeEntry<K>} satisfies Readonly<Record<NativeEffectActionId,Readonly<{module:AgentModuleCode;semantics:string}>>>;
export type NativeOutcomeAction=keyof typeof NATIVE_OUTCOME_ACTIONS;
/** Every action with a prepared-review store row; the human import workflow is its own source below. */
export const NATIVE_REVIEW_ACTIONS:readonly AgentReviewActionId[]=Object.freeze(AGENT_ACTIONS.filter(action=>action.store!=='human_workflow_only').map(action=>action.id as AgentReviewActionId));
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
