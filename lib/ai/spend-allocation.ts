/** USD inference allocation only, never an upstream invoice or prepaid-credit guarantee. */
import {AiGatewayError,type ResolvedAiConfig} from './types';
import type {AiFeatureId} from './features';
import type {AiAdmission} from './governance';
export type StrictAiSpendRoot=Readonly<{rootTaskId:string;kind:'agent'|'evaluation'}>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX=9223372036854775807n;
export const STRICT_AI_SPEND_FEATURES=Object.freeze(['provider_evaluation','module_agent_evaluation','module_agent_planning'] as const);
export function requiresStrictAiSpend(feature:AiFeatureId){return (STRICT_AI_SPEND_FEATURES as readonly string[]).includes(feature);}
export function captureStrictAiSpendRoot(value:StrictAiSpendRoot):StrictAiSpendRoot{
 if(!value||Object.keys(value).sort().join(',')!=='kind,rootTaskId'||!UUID.test(value.rootTaskId)||!['agent','evaluation'].includes(value.kind))throw new AiGatewayError('The AI spend allocation could not be confirmed.');
 return Object.freeze({rootTaskId:value.rootTaskId.toLowerCase(),kind:value.kind});
}
/** No float multiplication and no rounding down. Reject fractional nano-USD and overflow. */
export function usdToNanos(value:string):bigint{
 if(typeof value!=='string'||!/^\d{1,10}(?:\.\d{1,9})?$/.test(value))throw new AiGatewayError('Enter an exact non-negative USD allocation with at most nine decimal places.');
 const [whole,fraction='']=value.split('.'),result=BigInt(whole)*1000000000n+BigInt(fraction.padEnd(9,'0'));
 if(result>MAX)throw new AiGatewayError('The USD allocation is too large.');return result;
}
export function nanosToUsd(value:string):string{
 if(!/^\d+$/.test(value))throw new AiGatewayError('Invalid USD allocation.');const amount=BigInt(value);if(amount>MAX)throw new AiGatewayError('Invalid USD allocation.');
 const fraction=(amount%1000000000n).toString().padStart(9,'0').replace(/0+$/,'');return (amount/1000000000n).toString()+(fraction?'.'+fraction:'');
}
export function reserveUsdNanos(input:Readonly<{inputUnits:bigint;outputUnits:bigint;inputNanosPerMillion:bigint;outputNanosPerMillion:bigint;requestNanos:bigint}>):bigint{
 const {inputUnits,outputUnits,inputNanosPerMillion,outputNanosPerMillion,requestNanos}=input;
 if([inputUnits,outputUnits,inputNanosPerMillion,outputNanosPerMillion,requestNanos].some(n=>typeof n!=='bigint'||n<0n||n>MAX))throw new AiGatewayError('The AI price ceiling could not be confirmed.');
 const result=(inputUnits*inputNanosPerMillion+outputUnits*outputNanosPerMillion+999999n)/1000000n+requestNanos;
 if(result>MAX)throw new AiGatewayError('The AI price ceiling is too large.');return result;
}
export type CertifiedAiSpendEnvelope=Readonly<{capabilityDigest:string;requestDigest:string;reservedNanos:string}>;
/** Deliberately empty: none of the currently implemented adapters proves a COMPLETE billable-unit
 * ceiling plus immutable price enforcement. Key metadata/max_price alone does not supply that proof.
 * Only a reviewed source change implementing and testing such a carrier can add a capability here.
 * No administrator/browser/provider price-list response can mint one. Unknown is never zero. */
export function certifiedAiSpendEnvelope(_configuration:ResolvedAiConfig,_request:Readonly<AiAdmission>):CertifiedAiSpendEnvelope{
 throw new AiGatewayError('This provider route has no verified complete spend ceiling. Autonomous AI and evaluation requests are paused.');
}
