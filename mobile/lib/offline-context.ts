/** Portable Ed25519 verification for iPhone/Android. No fetching, persistence or attendance effects. */
import {ed25519} from '@noble/curves/ed25519.js';
import {CryptoDigestAlgorithm,digest} from 'expo-crypto';
import {z} from 'zod';
import {setupBytes} from '../../lib/mobile-workplace-setup';
import {OfflineClockContextBinding,type OfflineClockContextVerificationResult,OfflineClockContextEnvelope,OfflineClockContextIssuer,
 OFFLINE_CLOCK_CONTEXT_MAX_BYTES,parseOfflineClockContext,offlineClockContextClientData} from '../../lib/mobile-offline-context';
export class OfflineContextVerificationUnavailable extends Error{constructor(){super('Offline context verification unavailable');this.name='OfflineContextVerificationUnavailable';}}
export type ExpectedOfflineContext=OfflineClockContextBinding;
export type NativeOfflineContextResult=OfflineClockContextVerificationResult;
// JSON.stringify escapes lone surrogates; this also counts actual raw UTF-8 bytes before JSON parsing.
function utf8(value:string):Uint8Array{
 const encoded=encodeURIComponent(value).replace(/%([0-9A-F]{2})/g,(_,hex:string)=>String.fromCharCode(parseInt(hex,16)));
 return Uint8Array.from(encoded,char=>char.charCodeAt(0));
}
/** Registry and expected request are supplied by the current trusted connection owner, never the envelope.
 * Signature validity does not establish current permission, trusted elapsed time or permit consumption. */
export async function verifyNativeOfflineClockContext(raw:string,trustedIssuers:readonly OfflineClockContextIssuer[],expected:ExpectedOfflineContext,
 assertCurrent:()=>void):Promise<NativeOfflineContextResult>{
 assertCurrent();
 let issuers:OfflineClockContextIssuer[],binding:ExpectedOfflineContext;
 try{
  if(!Array.isArray(trustedIssuers)||trustedIssuers.length<1||trustedIssuers.length>16)throw new Error();
  issuers=trustedIssuers.map(key=>OfflineClockContextIssuer.parse(key));binding=OfflineClockContextBinding.parse(expected);
  if(new Set(issuers.map(key=>key.keyId)).size!==issuers.length)throw new Error();
 }catch{throw new OfflineContextVerificationUnavailable();}
 async function sha256(bytes:Uint8Array):Promise<string>{
  assertCurrent();let output:ArrayBuffer;
  try{output=await digest(CryptoDigestAlgorithm.SHA256,new Uint8Array(bytes));}
  catch{assertCurrent();throw new OfflineContextVerificationUnavailable();}
  assertCurrent();
  if(!(output instanceof ArrayBuffer)||output.byteLength!==32)throw new OfflineContextVerificationUnavailable();
  return Array.from(new Uint8Array(output),byte=>byte.toString(16).padStart(2,'0')).join('');
 }
 for(const key of issuers)if(await sha256(setupBytes(key.publicKey))!==key.keyId)throw new OfflineContextVerificationUnavailable();
 let envelope:z.infer<typeof OfflineClockContextEnvelope>;
 try{
  if(typeof raw!=='string'||raw.length>OFFLINE_CLOCK_CONTEXT_MAX_BYTES||utf8(raw).byteLength>OFFLINE_CLOCK_CONTEXT_MAX_BYTES)throw new Error();
  const parsed:unknown=JSON.parse(raw);if(!parsed||typeof parsed!=='object')throw new Error();
  parseOfflineClockContext(Reflect.get(parsed,'context'));envelope=OfflineClockContextEnvelope.parse(parsed);
 }catch{return {outcome:'invalid',reason:'malformed'};}
 assertCurrent();const context=envelope.context;
 if(JSON.stringify(context.scope)!==JSON.stringify(binding.scope))return {outcome:'invalid',reason:'scope_mismatch'};
 if(context.requestId!==binding.request.requestId||context.requestNonce!==binding.request.requestNonce)return {outcome:'invalid',reason:'request_mismatch'};
 if(JSON.stringify(context.target)!==JSON.stringify(binding.target))return {outcome:'invalid',reason:'target_mismatch'};
 const issuer=issuers.find(key=>key.keyId===context.issuer.keyId);
 if(!issuer||issuer.revoked||context.issuedAt<issuer.validFrom||context.expiresAt>issuer.validUntil)return {outcome:'invalid',reason:'issuer_unavailable'};
 const canonical=offlineClockContextClientData(context);let valid=false;
 try{valid=ed25519.verify(setupBytes(envelope.signature),utf8(canonical),setupBytes(issuer.publicKey),{zip215:false});}
 catch{return {outcome:'invalid',reason:'invalid_signature'};}
 if(!valid)return {outcome:'invalid',reason:'invalid_signature'};
 const hash=await sha256(utf8(canonical));assertCurrent();
 return {outcome:'signature_valid',context,digest:hash,authorization:'not_granted'};
}
