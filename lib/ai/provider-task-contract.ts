import type {AiFeatureId} from './features';
import type {GenerateArgs,ConverseArgs} from './types';
export type PrivateTaskCapture=Readonly<{args:GenerateArgs|ConverseArgs;local?:unknown;retire?:()=>void}>;
/** SOURCE-OWNED registry entry, never supplied by a client or model. fingerprint strictly captures
 * raw local facts; capture emits only its closed masked schema and keeps maps in local memory. */
export type PrivateTaskDescriptor=Readonly<{features:readonly AiFeatureId[];operation:'draft'|'conversation';fingerprint:(source:unknown)=>string;capture:(source:unknown)=>PrivateTaskCapture}>;
