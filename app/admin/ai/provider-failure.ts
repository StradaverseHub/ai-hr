/** Provider-settings failure reasons (server). Classification is by error TYPE and closed code only: error
 * constructors are not a disclosure boundary, so no message, cause, SQL, key, ciphertext, prompt or
 * provider response is ever read into copy or logs. Each reason selects fixed translated copy. */
import {AiConfigError} from '@/core/ai-config';
import {AiAdmissionRefusal,AiSpendControlError,isAiAdmissionRefusalCode,type AiAdmissionRefusalCode} from '@/lib/ai/admission-refusal';
import {AiPrivacyGateError} from '@/lib/ai/provider-privacy-error';
import {AiProviderReadinessError} from '@/lib/ai/provider-readiness-error';
import {AiAllowanceError,AiGatewayError} from '@/lib/ai/types';
import {pgErrorChain} from '@/lib/db-error';
import {PROVIDER_FAILURE_ORIGINS,PROVIDER_FAILURE_STAGES,type ProviderFailureOrigin,type ProviderFailureReason,type ProviderFailureStage,type ProviderFailureView} from './provider-failure-copy';
export {providerFailureMessage,type ProviderFailureView} from './provider-failure-copy';

export type ProviderAdminAction='save'|'activate'|'disable'|'remove'|'test_connection'|'evaluate';
/** Server-side description: the browser view plus closed diagnostic names for the log line. */
export type ProviderFailure=ProviderFailureView&Readonly<{
 /** AiProviderReadinessError/AiConfigError code, 'connection_failed' for a returned test refusal, else the reason. */
 code:string;
 /** Closed admission/spend/privacy/allowance code of the refusing step, when known. */
 refusal:string|null;
 /** SQLSTATE only (five characters), never the database message. */
 sqlstate:string|null;
 model:string|null;
}>;

const ADMISSION_REASONS:Readonly<Record<AiAdmissionRefusalCode,ProviderFailureReason>>=Object.freeze({
 request_invalid:'admission',admission_refused:'admission',admission_unavailable:'admission',admission_custody:'admission',
 admission_policy_unavailable:'admission',source_check_failed:'privacy_source',
 provider_configuration_changed:'configuration_changed',admission_scope_changed:'configuration_changed',
 ai_controls_unavailable:'controls',spend_root_required:'spend_root',spend_root_unavailable:'spend_root',
 spend_capability_unavailable:'spend_capability',spend_request_mismatch:'spend_capability',spend_reservation_unavailable:'spend_capability',
 spend_reservation_required:'spend_capability',spend_limit_requires_root:'spend_capability',
 spend_breach_review:'spend_control',spend_unpriced_history:'spend_control',spend_allocation_exhausted:'spend_control',
});
const CONFIG_REASONS:Readonly<Record<string,ProviderFailureReason>>=Object.freeze({not_admin:'not_admin',secret_unavailable:'secret_unavailable',
 evaluate_first:'evaluate_first',key_required:'key_required',receipt_required:'receipt_required',activation_unavailable:'activation_unavailable',invalid:'config_invalid'});
const READINESS_CODES=['consent_required','candidate_required','probe_failed','receipt_required','unavailable'] as const;
const own=(record:object,key:unknown):key is string=>typeof key==='string'&&Object.prototype.hasOwnProperty.call(record,key);
const pick=<T extends string>(list:readonly T[],value:unknown):T|null=>typeof value==='string'&&(list as readonly string[]).includes(value)?value as T:null;
const sqlstateOf=(error:unknown)=>{for(const link of pgErrorChain(error))if(link.code&&/^[0-9A-Z]{5}$/.test(link.code))return link.code;return null;};
const SAFE_MODEL=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
export const safeModel=(value:unknown)=>typeof value==='string'&&SAFE_MODEL.test(value)?value:null;
const PROVIDERS=['anthropic','openai','google','openrouter','ai_gateway'] as const;
export const safeProvider=(value:unknown)=>pick(PROVIDERS,value);

type Refusal={reason:ProviderFailureReason;code:string;refusal:string|null;sqlstate:string|null};
/** One refusal (not an evaluation wrapper). Order matters: subclasses before their parents. */
function refusalOf(error:unknown):Refusal{
 if(error instanceof AiSpendControlError)return{reason:'spend_control',code:'spend_control',refusal:isAiAdmissionRefusalCode(error.code)?error.code:null,sqlstate:null};
 if(error instanceof AiAllowanceError){const reason=pick(['paused','daily_limit','monthly_limit','concurrent_limit'] as const,error.reason)??'paused';return{reason,code:reason,refusal:reason,sqlstate:null};}
 if(error instanceof AiPrivacyGateError){const kind=pick(['unreviewed','unsupported','small_cohort','source'] as const,error.reason)??'unreviewed',reason=kind==='unreviewed'?'privacy_review':'privacy_source';return{reason,code:reason,refusal:'privacy_'+kind,sqlstate:null};}
 if(error instanceof AiAdmissionRefusal&&isAiAdmissionRefusalCode(error.code)){const reason=ADMISSION_REASONS[error.code];return{reason,code:reason,refusal:error.code,sqlstate:null};}
 if(error instanceof AiGatewayError)return{reason:'unavailable',code:'unavailable',refusal:'gateway',sqlstate:null};
 if(error instanceof AiProviderReadinessError){const code=pick(READINESS_CODES,error.code)??'unavailable',reason=code==='probe_failed'?'unexpected':code;return{reason,code,refusal:null,sqlstate:null};}
 if(error instanceof AiConfigError){const raw=(error as {reason?:unknown}).reason,reason=own(CONFIG_REASONS,raw)?CONFIG_REASONS[raw]:'config_invalid';return{reason,code:own(CONFIG_REASONS,raw)?raw:'invalid',refusal:null,sqlstate:null};}
 const sqlstate=sqlstateOf(error);
 return{reason:sqlstate?'database':'unexpected',code:sqlstate?'database':'unexpected',refusal:null,sqlstate};
}

export function describeProviderFailure(error:unknown):ProviderFailure{
 if(error instanceof AiProviderReadinessError&&error.code==='probe_failed'){
  const detail=error.detail;
  const stage:ProviderFailureStage|null=pick(PROVIDER_FAILURE_STAGES,detail?.stage),origin:ProviderFailureOrigin|null=pick(PROVIDER_FAILURE_ORIGINS,detail?.origin);
  // A call refused here carries its own typed refusal; one admitted to the provider has only stage/origin.
  const inner=origin==='local'&&stage!=='summary'&&detail&&detail.refusal!==undefined?refusalOf(detail.refusal):null;
  const reason:ProviderFailureReason=origin==='provider'||origin==='response'?'connection_failed':inner?.reason??'unexpected';
  return Object.freeze({reason,probe:true,stage,origin,code:'probe_failed',refusal:inner?.refusal??null,sqlstate:inner?.sqlstate??null,model:safeModel(detail?.model)});
 }
 const refusal=refusalOf(error);
 return Object.freeze({...refusal,probe:false,stage:null,origin:null,model:null});
}

/** A returned (not thrown) connection-check refusal: the owner's own text is never read. */
export const CONNECTION_CHECK_FAILURE:ProviderFailure=Object.freeze({reason:'connection_failed',probe:false,stage:null,origin:null,code:'connection_failed',refusal:null,sqlstate:null,model:null});

/** Only the closed browser view leaves the server. */
export const providerFailureView=(failure:ProviderFailure):ProviderFailureView=>Object.freeze({reason:failure.reason,probe:failure.probe,stage:failure.stage,origin:failure.origin});

/** One structured line per failed provider command: closed names only, never keys, ciphertext, prompts,
 * provider bodies or error messages. A broken sink cannot change the command's own result. */
export function logProviderFailure(action:ProviderAdminAction,failure:ProviderFailure,context:Readonly<{provider?:unknown;model?:unknown}>={}):void{
 try{
  console.warn('[ai-provider-admin-failure]',JSON.stringify({action,code:failure.code,reason:failure.reason,stage:failure.stage,origin:failure.origin,
   refusal:failure.refusal,sqlstate:failure.sqlstate,provider:safeProvider(context.provider),model:failure.model??safeModel(context.model)}));
 }catch{/* Logging never replaces the user-facing refusal. */}
}
