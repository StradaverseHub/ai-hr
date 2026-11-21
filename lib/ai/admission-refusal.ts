/** Closed, code-owned names for the step that refused an AI admission. A refusal carries the caller's
 * existing fixed client-safe message and one code from this list: never SQL, bound parameters, a
 * driver message, a provider response or a cause. Only the codes, not messages, select operator copy. */
import {AiAllowanceError,AiGatewayError} from './types';

export const AI_ADMISSION_REFUSAL_CODES=Object.freeze([
 'request_invalid','provider_configuration_changed','ai_controls_unavailable','source_check_failed',
 'admission_policy_unavailable','spend_root_required','spend_root_unavailable','spend_capability_unavailable',
 'spend_request_mismatch','spend_reservation_unavailable','spend_reservation_required','admission_custody',
 'admission_scope_changed','admission_refused','admission_unavailable',
 // Configured USD spend controls (AiSpendControlError, a typed pause).
 'spend_limit_requires_root','spend_breach_review','spend_unpriced_history','spend_allocation_exhausted',
] as const);
export type AiAdmissionRefusalCode=typeof AI_ADMISSION_REFUSAL_CODES[number];
export const isAiAdmissionRefusalCode=(value:unknown):value is AiAdmissionRefusalCode=>
 typeof value==='string'&&(AI_ADMISSION_REFUSAL_CODES as readonly string[]).includes(value);

/** Same type, name and message as the generic gateway refusal it replaces, plus the refusing step. */
export class AiAdmissionRefusal extends AiGatewayError{
 readonly code:AiAdmissionRefusalCode;
 constructor(code:AiAdmissionRefusalCode,message='The AI request could not be admitted.'){
  super(message);this.code=isAiAdmissionRefusalCode(code)?code:'admission_unavailable';
 }
}

/** The exact USD spend-control refusals RAISEd by migrations 0651/0654 (pinned against them by test). */
const SPEND_CONTROL_REFUSALS=Object.freeze({
 'This monetary limit requires a native AI task root':'spend_limit_requires_root',
 'AI spend ceiling breach requires review':'spend_breach_review',
 'Unpriced AI history requires monetary review':'spend_unpriced_history',
 'Unpriced AI task history requires monetary review':'spend_unpriced_history',
 'AI spend allocation exhausted':'spend_allocation_exhausted',
} as const satisfies Record<string,AiAdmissionRefusalCode>);
export type AiSpendControlRefusal=keyof typeof SPEND_CONTROL_REFUSALS;
export const AI_SPEND_CONTROL_REFUSALS=Object.freeze(Object.keys(SPEND_CONTROL_REFUSALS) as AiSpendControlRefusal[]);

/** A configured USD spend control refused admission before any provider call. It IS the existing typed AI control
 * refusal (an AiAllowanceError; 'paused' until an administrator reviews the spend or removes the cap), so every
 * caller already maps it to the product's AI control message. No SQL, amount, scope, root or record is carried;
 * `code` names only which fixed control refused. */
export class AiSpendControlError extends AiAllowanceError{
 readonly code:AiAdmissionRefusalCode;
 constructor(raised?:string){
  super('paused');this.message='This AI feature is paused by its spend controls.';this.name='AiSpendControlError';
  this.code=raised!==undefined&&Object.prototype.hasOwnProperty.call(SPEND_CONTROL_REFUSALS,raised)?SPEND_CONTROL_REFUSALS[raised as AiSpendControlRefusal]:'spend_breach_review';
 }
}

/** Exact constant RAISE texts of the admission-transaction owners (ai_admit, _ai_control_context,
 * ai_spend_policy_context, ai_spend_reviewed_*carrier, ai_spend_reserve, ai_spend_record_admission). Text
 * selects a code only by exact equality; nothing raised is ever carried or logged. */
const SQL_ADMISSION_REFUSALS=Object.freeze({
 'Invalid AI request':'request_invalid',
 'Invalid AI feature':'admission_policy_unavailable','AI unavailable':'admission_policy_unavailable',
 'Unknown actor':'admission_policy_unavailable','Current AI admission policy unavailable':'admission_policy_unavailable',
 'Fresh AI action controls require Read Committed':'admission_policy_unavailable',
 'Actual AI task root required':'spend_root_required',
 'Actual AI task root unavailable':'spend_root_unavailable','AI spend root unavailable':'spend_root_unavailable',
 'AI spend allocation unavailable':'spend_reservation_unavailable','AI spend allocation requires this admission':'spend_reservation_unavailable',
 'AI monetary policy unavailable':'spend_reservation_unavailable','AI spend ceiling unavailable':'spend_reservation_unavailable',
 'AI spend already reserved':'spend_reservation_unavailable','AI spend budget missing':'spend_reservation_unavailable',
 'Reviewed spend carrier busy':'spend_capability_unavailable',
 'Verified AI monetary reservation required':'spend_reservation_required','AI monetary policy changed':'spend_reservation_required',
 'AI admission custody unavailable':'admission_custody','AI admission custody requires this actual admission':'admission_custody',
 'AI policy exclusion requires this admission':'admission_custody','AI native task request required':'admission_custody',
 'AI admission company scope changed':'admission_scope_changed',
} as const satisfies Record<string,AiAdmissionRefusalCode>);
export function sqlAdmissionRefusalCode(raised:string|undefined,fallback:AiAdmissionRefusalCode='admission_unavailable'):AiAdmissionRefusalCode{
 return raised!==undefined&&Object.prototype.hasOwnProperty.call(SQL_ADMISSION_REFUSALS,raised)?SQL_ADMISSION_REFUSALS[raised as keyof typeof SQL_ADMISSION_REFUSALS]:fallback;
}

/** Names the refusing admission step. Only an untyped gateway refusal (its existing fixed message) is
 * re-labelled; typed AI refusals (pause, allowance, privacy, an earlier labelled step) and non-AI errors
 * leave unchanged, so callers keep exactly the error class, name and message they handled before. */
export async function admissionStep<T>(code:AiAdmissionRefusalCode,step:()=>T|Promise<T>):Promise<T>{
 try{return await step();}
 catch(error){
  if(error instanceof AiGatewayError&&Object.getPrototypeOf(error)===AiGatewayError.prototype)throw new AiAdmissionRefusal(code,error.message);
  throw error;
 }
}
