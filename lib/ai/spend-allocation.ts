/** USD inference allocation only, never an upstream invoice or prepaid-credit guarantee. */
import {AiGatewayError,type ResolvedAiConfig} from './types';
import type {AiFeatureId} from './features';
import {currentReviewedFreeEnvelope} from './providers/openrouter-fixed-free-carrier';
import type {AiAdmission} from './governance';
export type StrictAiSpendRoot=Readonly<{rootTaskId:string;kind:'agent'|'evaluation'}>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX=BigInt("9223372036854775807");
export const STRICT_AI_SPEND_FEATURES=Object.freeze(['provider_evaluation','module_agent_evaluation','module_agent_planning','hr_assistant','readiness_reminders','claims_triage','payroll_hypotheses','performance_assistant'] as const);
export function requiresStrictAiSpend(feature:AiFeatureId){return (STRICT_AI_SPEND_FEATURES as readonly string[]).includes(feature);}
export function captureStrictAiSpendRoot(value:StrictAiSpendRoot):StrictAiSpendRoot{
 if(!value||Object.keys(value).sort().join(',')!=='kind,rootTaskId'||!UUID.test(value.rootTaskId)||!['agent','evaluation'].includes(value.kind))throw new AiGatewayError('The AI spend allocation could not be confirmed.');
 return Object.freeze({rootTaskId:value.rootTaskId.toLowerCase(),kind:value.kind});
}
/** No float multiplication and no rounding down. Reject fractional nano-USD and overflow. */
export function usdToNanos(value:string):bigint{
 if(typeof value!=='string'||!/^\d{1,10}(?:\.\d{1,9})?$/.test(value))throw new AiGatewayError('Enter an exact non-negative USD allocation with at most nine decimal places.');
 const [whole,fraction='']=value.split('.'),result=BigInt(whole)*BigInt("1000000000")+BigInt(fraction.padEnd(9,'0'));
 if(result>MAX)throw new AiGatewayError('The USD allocation is too large.');return result;
}
export function nanosToUsd(value:string):string{
 if(!/^\d{1,128}$/.test(value))throw new AiGatewayError('Invalid USD allocation.');const amount=BigInt(value);
 const fraction=(amount%BigInt("1000000000")).toString().padStart(9,'0').replace(/0+$/,'');return (amount/BigInt("1000000000")).toString()+(fraction?'.'+fraction:'');
}
export function reserveUsdNanos(input:Readonly<{inputUnits:bigint;outputUnits:bigint;inputNanosPerMillion:bigint;outputNanosPerMillion:bigint;requestNanos:bigint}>):bigint{
 const {inputUnits,outputUnits,inputNanosPerMillion,outputNanosPerMillion,requestNanos}=input;
 if([inputUnits,outputUnits,inputNanosPerMillion,outputNanosPerMillion,requestNanos].some(n=>typeof n!=='bigint'||n<BigInt("0")||n>MAX))throw new AiGatewayError('The AI price ceiling could not be confirmed.');
 const result=(inputUnits*inputNanosPerMillion+outputUnits*outputNanosPerMillion+BigInt("999999"))/BigInt("1000000")+requestNanos;
 if(result>MAX)throw new AiGatewayError('The AI price ceiling is too large.');return result;
}
export type CertifiedAiSpendEnvelope=Readonly<{capabilityDigest:string;requestDigest:string;reservedNanos:string}>;
/** Conditional release-reviewed carriers only. No live certificate is seeded; unresolved paid and
 * arbitrary tenant routes refuse. The actual current-Tx resolver owns catalog/control evidence. */
export function certifiedAiSpendEnvelope(configuration:ResolvedAiConfig,request:Readonly<AiAdmission>,proof?:object):CertifiedAiSpendEnvelope{
 return currentReviewedFreeEnvelope(configuration,request,proof);
}
