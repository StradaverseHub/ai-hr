/** Scoped Apple enrollment orchestration. Enrollment never assigns an attendance trust tier. */
import {createHash,KeyObject,randomUUID} from 'node:crypto';
import {and,eq,isNull,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {mobileIntegrityChallenge,mobileIntegrityKey} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import {encryptSecret,isSecretStorable} from '../lib/ai/crypto';
import {AppleEnrollmentSettings,KeyEnrollmentContext,keyEnrollmentClientData} from '../lib/mobile-key-enrollment';
import {checkAppAttestKeyProof} from '../lib/mobile-api/app-attest-enrollment';
import {integrityKeyReceipt} from './mobile-integrity-key';
import {IntegrityKeyReceipt} from '../lib/mobile-integrity-contract';
import {withAttendanceTenant} from './module-gate';
import {myOwnEmploymentSubjectsTx} from './read';
import {OwnClockEmploymentUnavailableError} from './attendance-clock-subject';
import {issueOwnIntegrityChallenge,readOwnIntegrityChallenge,consumeOwnIntegrityChallenge,type IntegrityChallengeView} from './mobile-integrity-challenge';

const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const intentSchema=z.object({employmentId:uuid,requestId:uuid,appInstallationId:uuid}).strict();
type Intent=z.infer<typeof intentSchema>;
export class AppleKeyEnrollmentError extends Error{
  constructor(readonly reason:'configuration_unavailable'|'binding_conflict'|'not_found'|'key_unavailable'|'active_key_exists'|'capacity'|'metadata_unavailable'|'invalid_proof'){
    super('Device key enrollment unavailable');this.name='AppleKeyEnrollmentError';
  }
}
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest();
const receipt=(row:typeof mobileIntegrityKey.$inferSelect)=>IntegrityKeyReceipt.parse(integrityKeyReceipt(row));
async function own(tx:Tx,ctx:SessionContext,employmentId:string){
  if(!ctx.userId||!ctx.personId||!(await myOwnEmploymentSubjectsTx(tx,ctx,{profileEdit:true})).some(row=>row.employmentId===employmentId))throw new OwnClockEmploymentUnavailableError();
}


/** Settings and verifier are server-owned. The verifier override is an integration-test port only. */
export function createAppleEnrollmentService(settings:unknown,ports:{verifyProof?:typeof checkAppAttestKeyProof;beforeCommit?:(tx:Tx)=>Promise<void>}={}){
  const parsed=AppleEnrollmentSettings.safeParse(settings);
  if(!parsed.success)throw new AppleKeyEnrollmentError('configuration_unavailable');
  const config=parsed.data,verify=ports.verifyProof??checkAppAttestKeyProof;
  function bound(ctx:SessionContext,input:Intent){
    return {...input,purpose:'device.enrollment' as const,bindingHash:hash(JSON.stringify(['aihr-apple-enrollment-binding',1,
      config.apiOrigin,ctx.tenantId.toLowerCase(),ctx.userId?.toLowerCase(),input.employmentId,input.appInstallationId,config.target])).toString('hex')};
  }
  function context(ctx:SessionContext,row:IntegrityChallengeView){
    return KeyEnrollmentContext.parse({version:1,purpose:'device.key.enrollment',apiOrigin:config.apiOrigin,installationId:row.installationId,
      tenantId:ctx.tenantId,actorId:row.actorId,employmentId:row.employmentId,appInstallationId:row.appInstallationId,requestId:row.requestId,
      challengeId:row.id,nonce:row.nonce,issuedAt:Date.parse(row.issuedAt),expiresAt:Date.parse(row.expiresAt),target:config.target});
  }
  async function existing(ctx:SessionContext,intent:Intent,challengeId:string,proofDigest:string){
    return withAttendanceTenant(ctx,async tx=>{
      await own(tx,ctx,intent.employmentId);
      const [found]=await tx.select({row:mobileIntegrityKey,requestId:mobileIntegrityChallenge.requestId}).from(mobileIntegrityKey)
        .innerJoin(mobileIntegrityChallenge,eq(mobileIntegrityChallenge.id,mobileIntegrityKey.originChallengeId)).where(and(eq(mobileIntegrityKey.tenantId,ctx.tenantId),
        eq(mobileIntegrityKey.actorId,ctx.userId!),eq(mobileIntegrityKey.originChallengeId,challengeId))).limit(1);
      if(!found)return null;const {row}=found;
      if(row.platform!=='ios'||found.requestId!==intent.requestId||row.proofDigest!==proofDigest||row.appInstallationId!==intent.appInstallationId||row.enrolledForEmploymentId!==intent.employmentId)
        throw new AppleKeyEnrollmentError('binding_conflict');
      return receipt(row);
    });
  }
  return {
    async begin(ctx:SessionContext,input:Intent){
      const intent=intentSchema.parse(input);
      if(!isSecretStorable())throw new AppleKeyEnrollmentError('configuration_unavailable');
      const challenge=await issueOwnIntegrityChallenge(ctx,bound(ctx,intent)),data=context(ctx,challenge),bytes=keyEnrollmentClientData(data);
      return {challenge,context:data,clientDataHash:hash(bytes).toString('base64'),
        alias:'aihr_'+hash(JSON.stringify(['aihr-key-alias',1,data.installationId,data.tenantId,data.actorId,data.appInstallationId,data.challengeId])).toString('hex')};
    },
    async complete(ctx:SessionContext,input:Intent&{challengeId:string;vendorKeyId:string;attestation:Buffer}){
      const {challengeId:rawId,vendorKeyId,attestation:raw,...rawIntent}=input,intent=intentSchema.parse(rawIntent),challengeId=uuid.parse(rawId);
      if(typeof vendorKeyId!=='string'||vendorKeyId.length!==44||Buffer.from(vendorKeyId,'base64').length!==32||Buffer.from(vendorKeyId,'base64').toString('base64')!==vendorKeyId||
        !Buffer.isBuffer(raw)||raw.length<1||raw.length>65536)throw new AppleKeyEnrollmentError('invalid_proof');
      const attestation=Buffer.from(raw),proofDigest=hash(JSON.stringify(['apple-enrollment-proof',1,challengeId,vendorKeyId,hash(attestation).toString('hex')])).toString('hex');
      const recovered=await existing(ctx,intent,challengeId,proofDigest);if(recovered)return recovered;
      if(!isSecretStorable())throw new AppleKeyEnrollmentError('configuration_unavailable');
      const binding=bound(ctx,intent),challenge=await readOwnIntegrityChallenge(ctx,{...binding,challengeId});
      if(challenge.state!=='active'){
        // A competing exact request can commit after the initial receipt lookup. Only the matching
        // stored proof/owner is recoverable; consumption alone never establishes a successful key.
        const committed=await existing(ctx,intent,challengeId,proofDigest);if(committed)return committed;
        throw new AppleKeyEnrollmentError('key_unavailable');
      }
      const data=context(ctx,challenge),proof=await verify({attestation,clientDataHash:hash(keyEnrollmentClientData(data)),keyId:vendorKeyId,
        appId:config.target.appId,environment:config.target.environment});
      if(proof.keyId!==vendorKeyId||proof.environment!==config.target.environment||!(proof.publicKey instanceof KeyObject)||proof.publicKey.type!=='public'||
        proof.publicKey.asymmetricKeyType!=='ec'||proof.publicKey.asymmetricKeyDetails?.namedCurve!=='prime256v1'||
        !Buffer.isBuffer(proof.receipt)||proof.receipt.length<1||proof.receipt.length>32768)throw new AppleKeyEnrollmentError('invalid_proof');
      const publicJwk=proof.publicKey.export({format:'jwk'}),x=Buffer.from(publicJwk.x??'','base64url'),y=Buffer.from(publicJwk.y??'','base64url');
      const fingerprint=hash(Buffer.concat([Buffer.from([4]),x,y]));
      if(x.length!==32||y.length!==32||fingerprint.toString('base64')!==vendorKeyId)throw new AppleKeyEnrollmentError('invalid_proof');
      const required=config.target.requiredMetadata;
      if(required&&proof.metadata.status!=='available')throw new AppleKeyEnrollmentError('metadata_unavailable');
      if(required&&proof.metadata.status==='available'&&(proof.metadata.validationCategory!==required.validationCategory||!required.bundleVersions.includes(proof.metadata.bundleVersion)))throw new AppleKeyEnrollmentError('invalid_proof');
      const id=randomUUID(),aad=JSON.stringify(['mobile-integrity-key-receipt',1,data.tenantId,data.actorId,id,challengeId]);
      const receiptCiphertext=encryptSecret(proof.receipt.toString('base64'),aad);
      const consumed=await consumeOwnIntegrityChallenge(ctx,{...binding,challengeId},async tx=>{
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':mobile-integrity:'+ctx.userId},0))`);
        await ports.beforeCommit?.(tx);
        const active=await tx.select({appInstallationId:mobileIntegrityKey.appInstallationId}).from(mobileIntegrityKey).where(and(
          eq(mobileIntegrityKey.actorId,ctx.userId!),isNull(mobileIntegrityKey.revokedAt))).limit(5);
        if(active.some(row=>row.appInstallationId===intent.appInstallationId))throw new AppleKeyEnrollmentError('active_key_exists');
        if(active.length===5)throw new AppleKeyEnrollmentError('capacity');
        const [old]=await tx.select({id:mobileIntegrityKey.id}).from(mobileIntegrityKey).where(eq(mobileIntegrityKey.fingerprint,fingerprint.toString('hex'))).limit(1);
        if(old)throw new AppleKeyEnrollmentError('key_unavailable');
        const [row]=await tx.insert(mobileIntegrityKey).values({id,tenantId:ctx.tenantId,actorId:ctx.userId!,appInstallationId:intent.appInstallationId,
          installationId:challenge.installationId,originChallengeId:challengeId,enrolledForEmploymentId:intent.employmentId,
          platform:'ios',appId:config.target.appId,environment:config.target.environment,vendorKeyId,fingerprint:fingerprint.toString('hex'),
          publicKeySpki:proof.publicKey.export({type:'spki',format:'der'}),proofDigest,proofKind:required?'apple_app_metadata':'apple_key_proof',
          metadata:proof.metadata.status==='available'?{validationCategory:proof.metadata.validationCategory,bundleVersion:proof.metadata.bundleVersion}:null,receiptCiphertext}).onConflictDoNothing().returning();
        if(!row)throw new AppleKeyEnrollmentError('key_unavailable');
        await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'mobile-integrity-key',aggregateId:row.id,eventType:'mobile.integrity.key.enrolled',
          actor:actorOf(ctx),subjectEmploymentId:intent.employmentId,payload:{platform:'ios',proofKind:row.proofKind}});
        return receipt(row);
      });
      if(consumed.state==='consumed')return consumed.value;
      const result=await existing(ctx,intent,challengeId,proofDigest);if(!result)throw new AppleKeyEnrollmentError('key_unavailable');return result;
    },
  };
}

export {listOwnIntegrityKeys,revokeOwnIntegrityKey} from './mobile-integrity-key';
