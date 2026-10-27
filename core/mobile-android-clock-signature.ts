/** Internal command-signature owner. Historical key enrollment is not current device/location proof. */
import {createHash,createPublicKey,timingSafeEqual} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {mobileIntegrityKey} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import {AndroidEnrollmentSettings,AndroidEnrollmentContext,AndroidEnrollmentKeyArtifact} from '../lib/mobile-android-enrollment';
import {OnlineClockIntegrityData} from '../lib/mobile-clock-integrity';
import {checkAndroidClockSignature} from '../lib/mobile-api/android-clock-signature';
import {decryptSecret,isSecretStorable} from '../lib/ai/crypto';
import {withAttendanceTenant} from './module-gate';
import {myOwnEmploymentSubjectsTx} from './read';
import {OwnClockEmploymentUnavailableError} from './attendance-clock-subject';
import {consumeOwnIntegrityChallenge,issueOwnIntegrityChallenge,type IntegrityChallengeView} from './mobile-integrity-challenge';
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
/** Caller must use the supplied transaction and checked snapshot for business acceptance. No network
 * operation belongs in the callback. already_consumed requests exact receipt recovery only. */
export function createAndroidClockSignatureService(settings:unknown){
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
  async consume<T>(ctx:SessionContext,raw:AndroidClockSignatureInput,proof:{challengeId:string;signature:Buffer},operation:(tx:Tx,checked:{context:OnlineClockIntegrityData;photo:Buffer|undefined;deviceToken:string|undefined;proofKind:'google_key_generation_proof';verification:'command_signature'})=>Promise<T>){
   const p=snapshot(raw),challengeId=uuid.parse(proof.challengeId);
   if(!Buffer.isBuffer(proof.signature)||proof.signature.length<8||proof.signature.length>72)throw new AndroidClockCommandError('invalid_command');
   const signature=Buffer.from(proof.signature);
   return consumeOwnIntegrityChallenge(ctx,{...intent(p),challengeId},async(tx,challenge)=>{
    const enrolled=await key(tx,ctx,p,true);if(enrolled.installationId!==challenge.installationId)throw new AndroidClockCommandError('key_unavailable');
    const context=data(ctx,p,challenge);
    checkAndroidClockSignature({publicKey:createPublicKey({key:enrolled.publicKeySpki,type:'spki',format:'der'}),signature,clientData:context,expectedAppId:config.target.packageName,allowedBuildVersions:config.target.versionCodes});
    await fresh(tx,challenge);
    const value=await operation(tx,{context,photo:p.photo,deviceToken:p.deviceToken,proofKind:'google_key_generation_proof',verification:'command_signature'});
    await own(tx,ctx,p);await fresh(tx,challenge);
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'mobile-integrity-challenge',aggregateId:challengeId,eventType:'mobile.integrity.signature.checked',actor:actorOf(ctx),subjectEmploymentId:p.employmentId,
     payload:{keyId:enrolled.id,proofKind:'google_key_generation_proof',verification:'command_signature'}});
    return value;
   });
  },
 };
}
