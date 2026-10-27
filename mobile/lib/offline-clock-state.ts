/** App-local context exchange state under the installed-account proof owner. Never transport it. */
import {z} from 'zod';
import {OfflineClockContextBinding,OfflineClockContextEnvelope,OFFLINE_CLOCK_CONTEXT_MAX_BYTES,parseOfflineClockContext} from '../../lib/mobile-offline-context';
import {ClockSigningKey} from './clock-signing-key';
import {NativeClockSnapshot} from './integrity-bridge';
import {EnrollmentScope} from './enrollment-journal';
const fields={binding:OfflineClockContextBinding,key:ClockSigningKey,requestStarted:NativeClockSnapshot};
export const OfflineClockExchange=z.discriminatedUnion('phase',[
 z.object({...fields,phase:z.literal('context_requested')}).strict(),
 z.object({...fields,phase:z.literal('context_ready'),rawContext:z.string().min(1).max(OFFLINE_CLOCK_CONTEXT_MAX_BYTES),
  digest:z.string().length(64).regex(/^[a-f0-9]{64}$/),responseReceived:NativeClockSnapshot}).strict(),
]);
export type OfflineClockExchange=z.infer<typeof OfflineClockExchange>;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Structural validation is local storage integrity, never signature verification/attendance authority. */
export function validateOfflineClockExchange(input:unknown,scope:EnrollmentScope):OfflineClockExchange{
 const value=OfflineClockExchange.parse(input),{binding,key,requestStarted}=value,s=binding.scope;
 if(s.apiOrigin!==scope.apiOrigin||s.actorId!==scope.actorId||s.appInstallationId!==scope.appInstallationId||
  key.apiOrigin!==s.apiOrigin||key.actorId!==s.actorId||key.appInstallationId!==s.appInstallationId||key.installationId!==s.installationId||
  key.tenantId!==s.tenantId||key.keyId!==s.deviceKeyId||key.platform!==binding.target.platform||key.appId!==binding.target.appId)throw new Error('Invalid offline exchange');
 const source=key.platform==='ios'?'ios_continuous':'android_elapsed_realtime';
 if(requestStarted.source!==source)throw new Error('Invalid offline clock source');
 if(value.phase==='context_ready'){
  if(new TextEncoder().encode(value.rawContext).byteLength>OFFLINE_CLOCK_CONTEXT_MAX_BYTES)throw new Error('Invalid offline context size');
  if(value.responseReceived.source!==source)throw new Error('Invalid offline clock source');
  const raw:unknown=JSON.parse(value.rawContext);
  if(!raw||typeof raw!=='object')throw new Error('Invalid offline context');
  parseOfflineClockContext(Reflect.get(raw,'context'));
  const {context}=OfflineClockContextEnvelope.parse(raw);
  if(!same(context.scope,s)||!same(context.target,binding.target)||context.requestId!==binding.request.requestId||context.requestNonce!==binding.request.requestNonce)throw new Error('Invalid offline context binding');
 }
 return value;
}
