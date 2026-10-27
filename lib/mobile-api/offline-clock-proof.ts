/** Original offline proof binding. No issuance, permit consumption, time/GPS trust or attendance write. */
import 'server-only';
import {createHash,KeyObject} from 'node:crypto';
import {z} from 'zod';
import {OfflineClockSignedClaim,offlineClockClaimClientData} from '../mobile-offline-clock';
import {OfflineClockContextData,offlineClockContextClientData,parseOfflineClockContext} from '../mobile-offline-context';
import {checkAppAttestAssertion,AppAttestAssertionError} from './app-attest-assertion';
import {checkAndroidOfflineClockSignature,AndroidClockSignatureError} from './android-clock-signature';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const sha=z.string().length(64).regex(/^[a-f0-9]{64}$/);
const RegisteredKey=z.object({id:uuid,tenantId:uuid,actorId:uuid,installationId:uuid,appInstallationId:uuid,
 platform:z.enum(['ios','android']),appId:z.string().min(3).max(300),environment:z.enum(['production','development']).nullable(),
 publicKey:z.custom<KeyObject>(value=>value instanceof KeyObject&&value.type==='public'&&value.asymmetricKeyType==='ec'&&value.asymmetricKeyDetails?.namedCurve==='prime256v1'),
 assertionCounter:z.number().int().min(0).max(0xffffffff),
}).strict().refine(key=>key.platform==='ios'?key.environment!==null:key.environment===null&&key.assertionCounter===0);
export type OfflineClockRegisteredKey=z.infer<typeof RegisteredKey>;
const Cursor=z.object({nextSequence:z.number().int().min(1).max(33),previousSha256:sha.nullable()}).strict()
 .refine(cursor=>(cursor.nextSequence===1)===(cursor.previousSha256===null));
export type OfflineClockStreamCursor=z.infer<typeof Cursor>;
export class OfflineClockProofUnavailable extends Error{constructor(){super('Offline clock proof configuration unavailable');this.name='OfflineClockProofUnavailable';}}
export type OfflineClockProofResult={outcome:'proof_valid';authorization:'not_granted';claim:OfflineClockSignedClaim['claim'];digest:string;
 nextCounter:number|null;cursor:OfflineClockStreamCursor}|
 {outcome:'invalid';reason:'malformed'|'scope_mismatch'|'context_mismatch'|'key_mismatch'|'permit_mismatch'|'chain_mismatch'|'invalid_proof'|'replayed_counter'};
const hash=(bytes:string)=>createHash('sha256').update(bytes,'utf8').digest('hex');
/** trustedContext must come from independently verified signature AND issued server record.
 * key and cursor must be read from the locked registered-key/stream owners. A caller-supplied
 * context/key/cursor cannot establish those facts. This function performs no DB/provider work.
 * Keep the original claim assertion counter ordered: never replace it with a later batch proof.
 * On success the transaction still owns current authorization/revocation/policy, actual photos,
 * adjudication, counter compare/update, one-use permit/receipt and all attendance effects.
 */
export function verifyOfflineClockProof(input:unknown,trustedContext:OfflineClockContextData,registeredKey:OfflineClockRegisteredKey,
 streamCursor:OfflineClockStreamCursor):OfflineClockProofResult{
 let context:OfflineClockContextData,key:OfflineClockRegisteredKey,cursor:OfflineClockStreamCursor;
 try{context=parseOfflineClockContext(trustedContext);key=RegisteredKey.parse(registeredKey);cursor=Cursor.parse(streamCursor);}
 catch{throw new OfflineClockProofUnavailable();}
 const parsed=OfflineClockSignedClaim.safeParse(input);if(!parsed.success)return {outcome:'invalid',reason:'malformed'};
 const {claim,proof}=parsed.data,s=context.scope;
 if(JSON.stringify(claim.scope)!==JSON.stringify(s))return {outcome:'invalid',reason:'scope_mismatch'};
 if(claim.context.id!==context.id||claim.context.sha256!==hash(offlineClockContextClientData(context)))return {outcome:'invalid',reason:'context_mismatch'};
 if(key.id!==s.deviceKeyId||key.tenantId!==s.tenantId||key.actorId!==s.actorId||key.installationId!==s.installationId||key.appInstallationId!==s.appInstallationId||
  key.platform!==context.target.platform||key.appId!==context.target.appId||key.environment!==context.target.environment||
  claim.evidence.platform!==key.platform||claim.evidence.appId!==(key.platform==='ios'?key.appId.slice(11):key.appId))return {outcome:'invalid',reason:'key_mismatch'};
 const permit=context.permits[claim.permit.ordinal-1];
 if(!permit||JSON.stringify(permit)!==JSON.stringify(claim.permit))return {outcome:'invalid',reason:'permit_mismatch'};
 if(claim.chain.sequence!==cursor.nextSequence||claim.chain.previousSha256!==cursor.previousSha256)return {outcome:'invalid',reason:'chain_mismatch'};
 const bytes=offlineClockClaimClientData(claim),digest=hash(bytes);let nextCounter:number|null=null;
 try{
  if(proof.platform==='ios')nextCounter=checkAppAttestAssertion({assertion:Buffer.from(proof.assertion,'base64'),clientData:Buffer.from(bytes,'utf8'),publicKey:key.publicKey,appId:key.appId,previousCounter:key.assertionCounter}).nextCounter;
  else checkAndroidOfflineClockSignature({signature:Buffer.from(proof.signature,'base64'),claim,publicKey:key.publicKey,expectedAppId:key.appId});
 }catch(error){
  if(error instanceof AppAttestAssertionError){
   if(error.reason==='invalid_configuration'||error.reason==='invalid_key')throw new OfflineClockProofUnavailable();
   return {outcome:'invalid',reason:error.reason==='replayed_counter'?'replayed_counter':'invalid_proof'};
  }
  if(error instanceof AndroidClockSignatureError){
   if(error.reason==='configuration'||error.reason==='invalid_key')throw new OfflineClockProofUnavailable();
   return {outcome:'invalid',reason:'invalid_proof'};
  }
  throw error;
 }
 return {outcome:'proof_valid',authorization:'not_granted',claim,digest,nextCounter,cursor:{nextSequence:cursor.nextSequence+1,previousSha256:digest}};
}
