/** Internal command-signature owner. Historical key enrollment is not current device/location proof. */
import {createHash,createPublicKey,timingSafeEqual} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {mobileIntegrityKey} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import {AndroidEnrollmentSettings,AndroidEnrollmentContext,AndroidEnrollmentKeyArtifact} from '../lib/mobile-android-enrollment';
import {OnlineClockIntegrityData} from '../lib/mobile-clock-integrity';
import type {AndroidClockIntegrityResult} from '../lib/mobile-api/android-clock-integrity';
import {checkAndroidClockSignature} from '../lib/mobile-api/android-clock-signature';
import {decryptSecret,isSecretStorable} from '../lib/ai/crypto';
import {withAttendanceTenant} from './module-gate';
import {myOwnEmploymentSubjectsTx} from './read';
import {OwnClockEmploymentUnavailableError} from './attendance-clock-subject';
import {consumeOwnIntegrityChallenge,issueOwnIntegrityChallenge,readOwnIntegrityChallenge,type IntegrityChallengeView} from './mobile-integrity-challenge';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const inputSchema=z.object({employmentId:uuid,appInstallationId:uuid,keyId:uuid,deviceToken:uuid.optional(),
 command:OnlineClockIntegrityData.shape.command.omit({photo:true}),evidence:OnlineClockIntegrityData.shape.evidence,
 photo:z.custom<Buffer>(Buffer.isBuffer).optional(),mime:z.enum(['image/jpeg','image/png']).optional(),}).strict();
export type AndroidClockSignatureInput=z.input<typeof inputSchema>;
export class AndroidClockCommandError extends Error{
 constructor(readonly reason:'configuration_unavailable'|'invalid_command'|'key_unavailable'|'time_unavailable'|'expired'){
  super('Online device proof unavailable');this.name='AndroidClockCommandError';
 }
}
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export type AndroidClockCurrentAssessment=Extract<AndroidClockIntegrityResult,{status:'eligible'}>['assessment'];
export type AndroidClockSignaturePorts={beforeCommit?:(tx:Tx)=>Promise<void>;
 /** Vendor work runs after a scoped signature precheck and BEFORE any consumption/key lock.
  * The returned assertion runs inside the acceptance transaction and must perform no network work. */
 verifyCurrent?:(context:OnlineClockIntegrityData,challenge:IntegrityChallengeView)=>Promise<{
  assertFresh(tx:Tx,context:OnlineClockIntegrityData):Promise<void>;assessment:AndroidClockCurrentAssessment;
 }>};
/** Caller must use the supplied transaction and checked snapshot for business acceptance. No network
 * operation belongs in the callback. already_consumed requests exact receipt recovery only. */
export function createAndroidClockSignatureService(settings:unknown,ports:AndroidClockSignaturePorts={}){
 const parsed=AndroidEnrollmentSettings.safeParse(settings);if(!parsed.success)throw new AndroidClockCommandError('configuration_unavailable');
 const config=parsed.data;
 function snapshot(raw:AndroidClockSignatureInput){
  const p=inputSchema.parse(raw);
  if((p.photo===undefined)!==(p.mime===undefined)||p.photo&&(p.photo.length<1||p.photo.length>2*1024*1024))throw new AndroidClockCommandError('invalid_command');
  const photo=p.photo?Buffer.from(p.photo):undefined;
  if(p.evidence.platform!=='android'||p.evidence.appId!==config.target.packageName||!config.target.versionCodes.includes(p.evidence.buildVersion))throw new AndroidClockCommandError('invalid_command');
  return {...p,photo,command:{...p.command,photo:photo?{sha256:hash(photo),byteLength:photo.length,mimeType:p.mime!}:null}};
 }
 type Snapshot=ReturnType<typeof snapshot>;
 function intent(p:Snapshot){return {employmentId:p.employmentId,requestId:p.command.requestId,appInstallationId:p.appInstallationId,purpose:'clock.online' as const,
  bindingHash:hash(JSON.stringify(['aihr.android.clock.binding',1,config,p.keyId,p.command,p.evidence,p.deviceToken?hash(p.deviceToken):null]))};}
 function data(ctx:SessionContext,p:Snapshot,challenge:IntegrityChallengeView){
  return OnlineClockIntegrityData.parse({version:1,purpose:'attendance.clock.online',scope:{apiOrigin:config.apiOrigin,installationId:challenge.installationId,
   tenantId:ctx.tenantId,actorId:ctx.userId,employmentId:p.employmentId,deviceKeyId:p.keyId},challenge:{id:challenge.id,nonce:challenge.nonce,expiresAt:Date.parse(challenge.expiresAt)},command:p.command,evidence:p.evidence});
 }
 async function own(tx:Tx,ctx:SessionContext,p:Snapshot){
  if(!ctx.userId||!ctx.personId||!(await myOwnEmploymentSubjectsTx(tx,ctx,{profileEdit:true})).some(e=>e.employmentId===p.employmentId))throw new OwnClockEmploymentUnavailableError();
 }
 async function key(tx:Tx,ctx:SessionContext,p:Snapshot,lock:boolean){
  await own(tx,ctx,p);
  const query=tx.select().from(mobileIntegrityKey).where(and(eq(mobileIntegrityKey.id,p.keyId),eq(mobileIntegrityKey.tenantId,ctx.tenantId),eq(mobileIntegrityKey.actorId,ctx.userId!))).limit(1);
  const [row]=await(lock?query.for('update'):query);if(lock)await own(tx,ctx,p);
  if(!row||row.revokedAt||row.platform!=='android'||row.environment!==null||row.proofKind!=='google_key_generation_proof'||row.appInstallationId!==p.appInstallationId||row.appId!==config.target.packageName)throw new AndroidClockCommandError('key_unavailable');
  // Minimal metadata omits signer digests. Reuse the encrypted immutable enrollment target instead
  // of inventing a policy match from incomplete facts. Changed target/origin requires reenrollment.
  try{
   if(!isSecretStorable())throw new Error();
   const aad=JSON.stringify(['mobile-integrity-key-receipt',1,ctx.tenantId,ctx.userId,row.id,row.originChallengeId]);
   const raw=JSON.parse(decryptSecret(row.receiptCiphertext,aad));
   if(!Array.isArray(raw)||raw.length!==4||raw[0]!=='aihr.android.key.provenance'||raw[1]!==1)throw new Error();
   const context=AndroidEnrollmentContext.parse(raw[2]),artifact=raw[3];
   if(!Array.isArray(artifact)||artifact.length!==4||artifact[0]!=='aihr.android.enrollment.proof'||artifact[1]!==1)throw new Error();
   const proof=AndroidEnrollmentKeyArtifact.parse({publicKeySpki:artifact[2],certificateChain:artifact[3]}),spki=Buffer.from(proof.publicKeySpki,'base64');
   if(spki.length!==row.publicKeySpki.length||!timingSafeEqual(spki,row.publicKeySpki)||context.apiOrigin!==config.apiOrigin||
    JSON.stringify(context.target)!==JSON.stringify(config.target)||context.tenantId!==ctx.tenantId||context.actorId!==ctx.userId||
    context.appInstallationId!==p.appInstallationId||context.installationId!==row.installationId||context.challengeId!==row.originChallengeId||context.employmentId!==row.enrolledForEmploymentId)throw new Error();
  }catch{throw new AndroidClockCommandError('key_unavailable');}
  return row;
 }
 async function fresh(tx:Tx,challenge:IntegrityChallengeView){
  const rows=await tx.execute(sql`select clock_timestamp() stamp`),raw=rows[0]?.stamp,now=raw instanceof Date?raw:new Date(String(raw));
  if(!Number.isFinite(now.getTime())||now.getTime()<Date.parse(challenge.issuedAt))throw new AndroidClockCommandError('time_unavailable');
  if(now.getTime()>=Date.parse(challenge.expiresAt))throw new AndroidClockCommandError('expired');
 }
 return {
  async begin(ctx:SessionContext,raw:AndroidClockSignatureInput){
   const p=snapshot(raw),enrolled=await withAttendanceTenant(ctx,tx=>key(tx,ctx,p,false)),challenge=await issueOwnIntegrityChallenge(ctx,intent(p));
   if(challenge.installationId!==enrolled.installationId)throw new AndroidClockCommandError('key_unavailable');
   return {challenge,context:data(ctx,p,challenge)};
  },
  async consume<T>(ctx:SessionContext,raw:AndroidClockSignatureInput,proof:{challengeId:string;signature:Buffer},operation:(tx:Tx,checked:{context:OnlineClockIntegrityData;photo:Buffer|undefined;deviceToken:string|undefined;proofKind:'google_key_generation_proof';verification:'command_signature';currentIntegrity?:AndroidClockCurrentAssessment})=>Promise<T>){
   const p=snapshot(raw),challengeId=uuid.parse(proof.challengeId);
   if(!Buffer.isBuffer(proof.signature)||proof.signature.length<8||proof.signature.length>72)throw new AndroidClockCommandError('invalid_command');
   const signature=Buffer.from(proof.signature);
   const bound={...intent(p),challengeId};
   let current:Awaited<ReturnType<NonNullable<AndroidClockSignaturePorts['verifyCurrent']>>>|undefined;
   if(ports.verifyCurrent){
    const challenge=await readOwnIntegrityChallenge(ctx,bound);
    if(challenge.state==='active'){
     const context=data(ctx,p,challenge);
     // A direct caller with another key/signature must not spend a vendor request. This read-only
     // precheck is not acceptance: repeat all authorization/key/signature checks under the locks.
     try{
      await withAttendanceTenant(ctx,async tx=>{
       const enrolled=await key(tx,ctx,p,false);if(enrolled.installationId!==challenge.installationId)throw new AndroidClockCommandError('key_unavailable');
       checkAndroidClockSignature({publicKey:createPublicKey({key:enrolled.publicKeySpki,type:'spki',format:'der'}),signature,clientData:context,expectedAppId:config.target.packageName,allowedBuildVersions:config.target.versionCodes});
       await fresh(tx,challenge);
      });
      current=await ports.verifyCurrent(context,challenge);
     }
     catch(error){
      // Google may clear a concurrent reuse after another request committed this exact receipt.
      // Observe consumption again; never turn a failed vendor check into a fresh business write.
      const latest=await readOwnIntegrityChallenge(ctx,bound);
      if(latest.state==='consumed')return consumeOwnIntegrityChallenge<T>(ctx,bound,async()=>{throw error;});
      throw error;
     }
    }
   }
   return consumeOwnIntegrityChallenge(ctx,bound,async(tx,challenge)=>{
    const enrolled=await key(tx,ctx,p,true);if(enrolled.installationId!==challenge.installationId)throw new AndroidClockCommandError('key_unavailable');
    const context=data(ctx,p,challenge);
    checkAndroidClockSignature({publicKey:createPublicKey({key:enrolled.publicKeySpki,type:'spki',format:'der'}),signature,clientData:context,expectedAppId:config.target.packageName,allowedBuildVersions:config.target.versionCodes});
    await fresh(tx,challenge);
    if(ports.verifyCurrent&&!current)throw new AndroidClockCommandError('configuration_unavailable');
    // PROBE ONLY: omit pre-write freshness.
    const value=await operation(tx,{context,photo:p.photo,deviceToken:p.deviceToken,proofKind:'google_key_generation_proof',verification:'command_signature',...(current?{currentIntegrity:current.assessment}:{})});
    await ports.beforeCommit?.(tx);
    await current?.assertFresh(tx,context);
    await own(tx,ctx,p);await fresh(tx,challenge);
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'mobile-integrity-challenge',aggregateId:challengeId,eventType:'mobile.integrity.signature.checked',actor:actorOf(ctx),subjectEmploymentId:p.employmentId,
     payload:{keyId:enrolled.id,proofKind:'google_key_generation_proof',verification:'command_signature'}});
    return value;
   });
  },
 };
}
