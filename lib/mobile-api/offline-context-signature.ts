/** Actual Ed25519 byte signatures. No env/file/metadata lookup, issuance row or attendance effect. */
import {createHash,createPublicKey,KeyObject,sign,verify} from 'node:crypto';
import {z} from 'zod';
import {OfflineClockContextData,OfflineClockContextEnvelope,OfflineClockContextIssuer,OFFLINE_CLOCK_CONTEXT_MAX_BYTES,
 offlineClockContextClientData,parseOfflineClockContext} from '../mobile-offline-context';
import {OfflineClockClaimData} from '../mobile-offline-clock';
export class OfflineContextSigningUnavailable extends Error{constructor(){super('Offline context signing unavailable');this.name='OfflineContextSigningUnavailable';}}
const digest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function offlineContextIssuerIdentity(privateKey:KeyObject):{keyId:string;publicKey:string}{
 try{
  if(!(privateKey instanceof KeyObject)||privateKey.type!=='private'||privateKey.asymmetricKeyType!=='ed25519')throw new Error();
  const key=createPublicKey(privateKey).export({format:'jwk'});
  if(key.kty!=='OKP'||key.crv!=='Ed25519'||typeof key.x!=='string')throw new Error();
  const bytes=Buffer.from(key.x,'base64url');if(bytes.length!==32||bytes.toString('base64url')!==key.x)throw new Error();
  return {keyId:digest(bytes),publicKey:key.x};
 }catch{throw new OfflineContextSigningUnavailable();}
}
/** Signing bytes does not issue a context/permit. The core issuance transaction owns that fact. */
export function signOfflineClockContext(input:unknown,privateKey:KeyObject):string{
 const context=parseOfflineClockContext(input),issuer=offlineContextIssuerIdentity(privateKey);
 if(context.issuer.keyId!==issuer.keyId)throw new OfflineContextSigningUnavailable();
 try{
  const signature=sign(null,Buffer.from(offlineClockContextClientData(context),'utf8'),privateKey).toString('base64url');
  const result=JSON.stringify(OfflineClockContextEnvelope.parse({context,signature}));
  if(Buffer.byteLength(result,'utf8')>OFFLINE_CLOCK_CONTEXT_MAX_BYTES)throw new Error();return result;
 }catch{throw new OfflineContextSigningUnavailable();}
}
type Scope=z.infer<typeof OfflineClockClaimData.shape.scope>;
export type OfflineContextSignatureResult={outcome:'signature_valid';context:OfflineClockContextData;digest:string;authorization:'not_granted'}|
 {outcome:'invalid';reason:'malformed'|'scope_mismatch'|'issuer_unavailable'|'invalid_signature'};
/** trustedIssuers and expectedScope are internal trusted inputs, never read from the submitted JSON.
 * Expiry/current policy, issued nonce/record and permit consumption are deliberately NOT decided here:
 * an expired signed claim still needs an auditable adjudication outcome, not fake online acceptance. */
export function verifyOfflineClockContextSignature(raw:string,trustedIssuers:readonly OfflineClockContextIssuer[],expectedScope:Scope):OfflineContextSignatureResult{
 let issuers:OfflineClockContextIssuer[],scope:Scope;
 try{
  if(!Array.isArray(trustedIssuers)||trustedIssuers.length<1||trustedIssuers.length>16)throw new Error();
  issuers=trustedIssuers.map(key=>OfflineClockContextIssuer.parse(key));scope=OfflineClockClaimData.shape.scope.parse(expectedScope);
  if(new Set(issuers.map(key=>key.keyId)).size!==issuers.length)throw new Error();
  for(const key of issuers)if(digest(Buffer.from(key.publicKey,'base64url'))!==key.keyId)throw new Error();
 }catch{throw new OfflineContextSigningUnavailable();}
 let envelope:z.infer<typeof OfflineClockContextEnvelope>;
 try{
  if(typeof raw!=='string'||raw.length>OFFLINE_CLOCK_CONTEXT_MAX_BYTES||Buffer.byteLength(raw,'utf8')>OFFLINE_CLOCK_CONTEXT_MAX_BYTES)throw new Error();
  const parsed:unknown=JSON.parse(raw);if(!parsed||typeof parsed!=='object')throw new Error();
  parseOfflineClockContext(Reflect.get(parsed,'context'));envelope=OfflineClockContextEnvelope.parse(parsed);
 }catch{return {outcome:'invalid',reason:'malformed'};}
 const context=envelope.context;
 if(JSON.stringify(context.scope)!==JSON.stringify(scope))return {outcome:'invalid',reason:'scope_mismatch'};
 const issuer=issuers.find(key=>key.keyId===context.issuer.keyId);
 if(!issuer||issuer.revoked||context.issuedAt<issuer.validFrom||context.expiresAt>issuer.validUntil)return {outcome:'invalid',reason:'issuer_unavailable'};
 try{
  const publicKey=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:issuer.publicKey},format:'jwk'});
  const bytes=offlineClockContextClientData(context);
  if(!verify(null,Buffer.from(bytes,'utf8'),publicKey,Buffer.from(envelope.signature,'base64url')))return {outcome:'invalid',reason:'invalid_signature'};
  return {outcome:'signature_valid',context,digest:digest(bytes),authorization:'not_granted'};
 }catch{throw new OfflineContextSigningUnavailable();}
}
