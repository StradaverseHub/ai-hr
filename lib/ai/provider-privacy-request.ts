/** Opaque exact disclosure binding. Issuance belongs to core/ai-governance.ts only;
 * capture/derivation transfer belongs to canonical config owners. No posted flag is authority. */
import {performance} from 'node:perf_hooks';
import {AiGatewayError,type ResolvedAiConfig} from './types';
import type {AiOperation} from './governance';
import type {AiFeatureId} from './features';
import {assertProviderDataContractReviewed} from './provider-data-reviews';
type Disclosure=Readonly<{feature:AiFeatureId;operation:AiOperation;inputDigest:string;contractId:string;sourceDigest:string;expiresAt:number}>;
type Owned={disclosure:Disclosure;deadline:number;used:boolean;revoked:boolean};
const issued=new WeakMap<object,Owned>();
export class AiPrivacyGateError extends AiGatewayError{
 constructor(){super('This AI request needs a reviewed data-protection policy. You can continue using the application directly.');this.name='AiPrivacyGateError';}
}
const refuse=():never=>{throw new AiPrivacyGateError();};
/** INTERNAL issuer: only core/ai-governance may import this symbol in production. */
export function bindProviderPrivacyRequest(configuration:ResolvedAiConfig,disclosure:Disclosure):void{
 if(issued.has(configuration)||!Object.isFrozen(configuration)||!['draft','conversation'].includes(disclosure.operation)||
  !/^[a-f0-9]{64}$/.test(disclosure.inputDigest)||!/^[a-f0-9]{64}$/.test(disclosure.sourceDigest)||
  !Number.isSafeInteger(disclosure.expiresAt)||disclosure.expiresAt<=Date.now()||disclosure.expiresAt>Date.now()+300000)return refuse();
 const captured=Object.freeze({...disclosure});
 issued.set(configuration,{disclosure:captured,deadline:performance.now()+Math.max(0,captured.expiresAt-Date.now()),used:false,revoked:false});
}
/** INTERNAL transfer. A copy cannot acquire provenance; canonical derived configs share one-use state. */
export function transferProviderPrivacyRequest(source:ResolvedAiConfig,target:ResolvedAiConfig):void{
 const state=issued.get(source);if(state){if(issued.has(target))return refuse();issued.set(target,state);}
}
export function assertProviderPrivacyRequest(configuration:ResolvedAiConfig,operation:AiOperation,inputDigest:string|undefined,feature?:AiFeatureId):void{
 const state=issued.get(configuration);
 if(!state||state.used||state.revoked||state.disclosure.expiresAt<=Date.now()||performance.now()>=state.deadline||state.disclosure.operation!==operation||
  state.disclosure.inputDigest!==inputDigest||feature!==undefined&&state.disclosure.feature!==feature)return refuse();
 assertProviderDataContractReviewed(state.disclosure.contractId,state.disclosure.sourceDigest);
}
/** Invoked after deterministic admission and immediately before one-use native egress issuance. */
export function consumeProviderPrivacyRequest(configuration:ResolvedAiConfig,operation:AiOperation,inputDigest:string|undefined):()=>void{
 assertProviderPrivacyRequest(configuration,operation,inputDigest);const state=issued.get(configuration)!;state.used=true;
 // Rechecked at the actual native serializer after any async DNS/admission delay.
 return ()=>{if(state.revoked||state.disclosure.expiresAt<=Date.now()||performance.now()>=state.deadline)return refuse();
  assertProviderDataContractReviewed(state.disclosure.contractId,state.disclosure.sourceDigest);};
}

/** Canonical cancellation/retirement revokes every retained or derived view immediately. */
export function revokeProviderPrivacyRequest(configuration:ResolvedAiConfig):void{
 const state=issued.get(configuration);if(state)state.revoked=true;
}
