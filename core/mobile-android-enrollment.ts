/** Server-owned Android enrollment transaction. No public enrollment route is enabled. */
import {createHash,createPublicKey,KeyObject,randomUUID,timingSafeEqual} from 'node:crypto';
import {and,eq,isNull,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {mobileIntegrityKey,mobileIntegrityChallenge} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import {AndroidEnrollmentSettings} from '../lib/mobile-android-enrollment';
import {IntegrityKeyReceiptV2} from '../lib/mobile-integrity-contract';
import {createAndroidKeyProofVerifier} from '../lib/mobile-api/android-key-proof';
import {encryptSecret,isSecretStorable} from '../lib/ai/crypto';
import {withAttendanceTenant} from './module-gate';
import {integrityKeyReceipt,requireOwnIntegrityEmployment} from './mobile-integrity-key';
import {consumeOwnIntegrityChallenge} from './mobile-integrity-challenge';
import {createAndroidEnrollmentChallenges,androidEnrollmentIntent} from './mobile-android-enrollment-challenge';
type Intent=z.infer<typeof androidEnrollmentIntent>;
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest();
export class AndroidKeyEnrollmentError extends Error{
 constructor(readonly reason:'configuration_unavailable'|'invalid_proof'|'binding_conflict'|'key_unavailable'|'active_key_exists'|'capacity'){
  super('Device key enrollment unavailable');this.name='AndroidKeyEnrollmentError';
 }
}
function fail(reason:AndroidKeyEnrollmentError['reason']):never{throw new AndroidKeyEnrollmentError(reason);}
const receipt=(row:typeof mobileIntegrityKey.$inferSelect)=>IntegrityKeyReceiptV2.parse(integrityKeyReceipt(row));
/** Verifier override is only an integration-test seam. Settings/proof verification are server-owned. */
export function createAndroidEnrollmentService(settings:unknown,ports:{verifyProof?:ReturnType<typeof createAndroidKeyProofVerifier>}={}){
 const parsed=AndroidEnrollmentSettings.safeParse(settings);if(!parsed.success)fail('configuration_unavailable');
 const config=parsed.data,{platform:_platform,...policy}=config.target;
 const challenges=createAndroidEnrollmentChallenges(config),verify=ports.verifyProof??createAndroidKeyProofVerifier(policy);
 async function existing(ctx:SessionContext,intent:Intent,challengeId:string,proofDigest:string){
  await requireOwnIntegrityEmployment(ctx,intent.employmentId);
  return withAttendanceTenant(ctx,async tx=>{
   const [found]=await tx.select({row:mobileIntegrityKey,requestId:mobileIntegrityChallenge.requestId}).from(mobileIntegrityKey)
    .innerJoin(mobileIntegrityChallenge,eq(mobileIntegrityChallenge.id,mobileIntegrityKey.originChallengeId)).where(and(eq(mobileIntegrityKey.tenantId,ctx.tenantId),eq(mobileIntegrityKey.actorId,ctx.userId!),eq(mobileIntegrityKey.originChallengeId,challengeId))).limit(1);
   if(!found)return null;const {row}=found;
   if(row.platform!=='android'||found.requestId!==intent.requestId||row.enrolledForEmploymentId!==intent.employmentId||row.appInstallationId!==intent.appInstallationId||row.proofDigest!==proofDigest)fail('binding_conflict');
   return receipt(row);
  });
 }
 return {
  async begin(ctx:SessionContext,input:Intent){if(!isSecretStorable())fail('configuration_unavailable');return challenges.begin(ctx,input);},
  async complete(ctx:SessionContext,input:Intent&{challengeId:string;publicKeySpki:Buffer;certificateChain:Buffer[]},signal?:AbortSignal){
   const {challengeId:rawId,publicKeySpki:rawSpki,certificateChain:rawChain,...rawIntent}=input,intent=androidEnrollmentIntent.parse(rawIntent),challengeId=uuid.parse(rawId);
   if(!Buffer.isBuffer(rawSpki)||rawSpki.length<64||rawSpki.length>256||!Array.isArray(rawChain)||rawChain.length<2||rawChain.length>8||rawChain.some(value=>!Buffer.isBuffer(value)||value.length<1||value.length>16384))fail('invalid_proof');
   // Snapshot before the first await; proof boundaries/order are part of immutable retry identity.
   const publicKeySpki=Buffer.from(rawSpki),certificateChain=rawChain.map(value=>Buffer.from(value));
   const serialized=JSON.stringify(['aihr.android.enrollment.proof',1,publicKeySpki.toString('base64'),certificateChain.map(value=>value.toString('base64'))]);
   if(Buffer.byteLength(serialized)>32768)fail('invalid_proof');
   const proofDigest=hash(JSON.stringify(['android-enrollment-proof',1,challengeId,hash(serialized).toString('hex')])).toString('hex');
   const recovered=await existing(ctx,intent,challengeId,proofDigest);if(recovered)return recovered;
   if(!isSecretStorable())fail('configuration_unavailable');if(signal?.aborted)fail('key_unavailable');
   const prepared=await challenges.read(ctx,{...intent,challengeId});if(prepared.challenge.state!=='active')fail('key_unavailable');
   const started=Date.now(),proof=await verify({certificateChain,publicKeySpki,challenge:Buffer.from(prepared.clientDataHash,'base64')},signal);
   if(signal?.aborted||proof.verification!=='google_key_generation_proof'||!Number.isSafeInteger(proof.checkedAt)||proof.checkedAt<started||proof.checkedAt>Date.now()||
    !(proof.publicKey instanceof KeyObject)||proof.publicKey.type!=='public'||proof.publicKey.asymmetricKeyType!=='ec'||proof.publicKey.asymmetricKeyDetails?.namedCurve!=='prime256v1')fail('invalid_proof');
   const verifiedSpki=proof.publicKey.export({type:'spki',format:'der'});
   if(verifiedSpki.length!==publicKeySpki.length||!timingSafeEqual(verifiedSpki,publicKeySpki))fail('invalid_proof');
   // The real composed verifier owns all policy checks; preserve only its minimal key-generation facts.
   const {publicKey:_key,verification:_verification,packageName,...metadata}=proof;
   if(packageName!==config.target.packageName||!config.target.versionCodes.includes(proof.versionCode)||!config.target.securityLevels.includes(proof.securityLevel))fail('invalid_proof');
   const jwk=createPublicKey({key:publicKeySpki,type:'spki',format:'der'}).export({format:'jwk'}),x=Buffer.from(jwk.x??'','base64url'),y=Buffer.from(jwk.y??'','base64url');
   if(x.length!==32||y.length!==32)fail('invalid_proof');
   const fingerprint=hash(Buffer.concat([Buffer.from([4]),x,y])),vendorKeyId=fingerprint.toString('base64'),id=randomUUID();
   // Retain the original server context for later policy re-evaluation and audit. Reconstructing it
   // from a changed deployment policy would change the attested digest and destroy that evidence.
   const provenance=JSON.stringify(['aihr.android.key.provenance',1,prepared.context,JSON.parse(serialized)]);
   if(Buffer.byteLength(provenance)>48000)fail('invalid_proof');
   const aad=JSON.stringify(['mobile-integrity-key-receipt',1,ctx.tenantId,ctx.userId,id,challengeId]),receiptCiphertext=encryptSecret(provenance,aad);
   const consumed=await consumeOwnIntegrityChallenge(ctx,{...intent,purpose:'device.enrollment',bindingHash:prepared.challenge.bindingHash,challengeId},async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':mobile-integrity:'+ctx.userId},0))`);
    const active=await tx.select({appInstallationId:mobileIntegrityKey.appInstallationId}).from(mobileIntegrityKey).where(and(eq(mobileIntegrityKey.actorId,ctx.userId!),isNull(mobileIntegrityKey.revokedAt))).limit(5);
    if(active.some(row=>row.appInstallationId===intent.appInstallationId))fail('active_key_exists');if(active.length===5)fail('capacity');
    const [row]=await tx.insert(mobileIntegrityKey).values({id,tenantId:ctx.tenantId,actorId:ctx.userId!,appInstallationId:intent.appInstallationId,installationId:prepared.challenge.installationId,originChallengeId:challengeId,enrolledForEmploymentId:intent.employmentId,
     platform:'android',appId:config.target.packageName,environment:null,vendorKeyId,fingerprint:fingerprint.toString('hex'),publicKeySpki,proofDigest,proofKind:'google_key_generation_proof',metadata:{androidKeyGeneration:{version:1,...metadata}},receiptCiphertext}).onConflictDoNothing().returning();
    if(!row)fail('key_unavailable');
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'mobile-integrity-key',aggregateId:id,eventType:'mobile.integrity.key.enrolled',actor:actorOf(ctx),subjectEmploymentId:intent.employmentId,payload:{platform:'android',proofKind:row.proofKind}});
    return receipt(row);
   });
   if(consumed.state==='consumed')return consumed.value;
   const result=await existing(ctx,intent,challengeId,proofDigest);if(!result)fail('key_unavailable');return result;
  },
 };
}
