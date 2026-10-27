/** Internal online assertion owner. No route, trust tier or attendance acceptance is enabled here. */
import {createHash,createPublicKey} from 'node:crypto';
import {and,eq,isNull,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {mobileIntegrityKey} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import {AppleEnrollmentSettings} from '../lib/mobile-key-enrollment';
import {OnlineClockIntegrityData,onlineClockClientData} from '../lib/mobile-clock-integrity';
import {checkAppAttestAssertion} from '../lib/mobile-api/app-attest-assertion';
import {withAttendanceTenant} from './module-gate';
import {myOwnEmploymentSubjectsTx} from './read';
import {OwnClockEmploymentUnavailableError} from './attendance-clock-subject';
import {consumeOwnIntegrityChallenge,issueOwnIntegrityChallenge,type IntegrityChallengeView} from './mobile-integrity-challenge';

const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const commandSchema=OnlineClockIntegrityData.shape.command.omit({photo:true});
const intentSchema=z.object({employmentId:uuid,appInstallationId:uuid,keyId:uuid,deviceToken:uuid.optional(),command:commandSchema,
  evidence:OnlineClockIntegrityData.shape.evidence,
  photo:z.custom<Buffer>(Buffer.isBuffer).optional(),mime:z.enum(['image/jpeg','image/png']).optional(),
}).strict();
export type AppleClockAssertionInput=z.input<typeof intentSchema>;
export class AppleClockAssertionError extends Error{
  constructor(readonly reason:'configuration_unavailable'|'invalid_command'|'key_unavailable'|'time_unavailable'|'expired'|'counter_unavailable'){
    super('Online device proof unavailable');this.name='AppleClockAssertionError';
  }
}
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

/** Configuration is deployment-owned. Input photo means exact submitted bytes, never a phone digest.
 * Attendance callers MUST use the supplied transaction and this command snapshot for their
 * authoritative receipt/writes. No network calls or nested transactions belong in the callback.
 * already_consumed only requests receipt reconciliation; it is not a new proof check or acceptance.
 */
export function createAppleClockAssertionService(settings:unknown,ports:{beforeCommit?:(tx:Tx)=>Promise<void>}={}){
  const parsed=AppleEnrollmentSettings.safeParse(settings);
  if(!parsed.success)throw new AppleClockAssertionError('configuration_unavailable');
  const config=parsed.data;
  function snapshot(raw:AppleClockAssertionInput){
    const p=intentSchema.parse(raw);
    if((p.photo===undefined)!==(p.mime===undefined)||p.photo&&(p.photo.length<1||p.photo.length>2*1024*1024))
      throw new AppleClockAssertionError('invalid_command');
    const photo=p.photo?Buffer.from(p.photo):undefined;
    const command={...p.command,photo:photo?{sha256:hash(photo),byteLength:photo.length,mimeType:p.mime!}:null};
    if(p.evidence.platform!=='ios'||p.evidence.appId!==config.target.appId.slice(11))throw new AppleClockAssertionError('invalid_command');
    return {...p,photo,command};
  }
  type Snapshot=ReturnType<typeof snapshot>;
  function intent(p:Snapshot){return {employmentId:p.employmentId,requestId:p.command.requestId,appInstallationId:p.appInstallationId,purpose:'clock.online' as const,
    // The nonce also binds the exact legacy registered-device credential, without publishing it in
    // canonical client data or audit. It remains a bearer gate, not a hardware-key association.
    bindingHash:hash(JSON.stringify(['aihr.apple.clock.binding',1,config,p.keyId,p.command,p.evidence,p.deviceToken?hash(p.deviceToken):null]))};}
  function data(ctx:SessionContext,p:Snapshot,challenge:IntegrityChallengeView){
    return OnlineClockIntegrityData.parse({version:1,purpose:'attendance.clock.online',
      scope:{apiOrigin:config.apiOrigin,installationId:challenge.installationId,tenantId:ctx.tenantId,actorId:ctx.userId,
        employmentId:p.employmentId,deviceKeyId:p.keyId},challenge:{id:challenge.id,nonce:challenge.nonce,expiresAt:Date.parse(challenge.expiresAt)},
      command:p.command,evidence:p.evidence});
  }
  async function own(tx:Tx,ctx:SessionContext,p:Snapshot){
    if(!ctx.userId||!ctx.personId||!(await myOwnEmploymentSubjectsTx(tx,ctx,{profileEdit:true})).some(e=>e.employmentId===p.employmentId))
      throw new OwnClockEmploymentUnavailableError();
  }
  async function key(tx:Tx,ctx:SessionContext,p:Snapshot,lock:boolean){
    await own(tx,ctx,p);
    const query=tx.select().from(mobileIntegrityKey).where(and(eq(mobileIntegrityKey.id,p.keyId),eq(mobileIntegrityKey.tenantId,ctx.tenantId),
      eq(mobileIntegrityKey.actorId,ctx.userId!))).limit(1);
    const [row]=await (lock?query.for('update'):query);
    // Eligibility can change on a different row while this SELECT waits for the key lock.
    if(lock)await own(tx,ctx,p);
    if(!row||row.revokedAt||row.platform!=='ios'||row.appInstallationId!==p.appInstallationId||row.appId!==config.target.appId||row.environment!==config.target.environment)
      throw new AppleClockAssertionError('key_unavailable');
    const required=config.target.requiredMetadata,metadata=row.metadata as {validationCategory?:number;bundleVersion?:string}|null;
    if(required&&(row.proofKind!=='apple_app_metadata'||metadata?.validationCategory!==required.validationCategory||!required.bundleVersions.includes(metadata?.bundleVersion??'')))
      throw new AppleClockAssertionError('key_unavailable');
    return row;
  }
  async function fresh(tx:Tx,challenge:IntegrityChallengeView){
    const rows=await tx.execute(sql`select clock_timestamp() stamp`),rawStamp=rows[0]?.stamp;
    const now=rawStamp instanceof Date?rawStamp:new Date(String(rawStamp));
    if(!Number.isFinite(now.getTime())||now.getTime()<Date.parse(challenge.issuedAt))throw new AppleClockAssertionError('time_unavailable');
    if(now.getTime()>=Date.parse(challenge.expiresAt))throw new AppleClockAssertionError('expired');
  }
  return {
    async begin(ctx:SessionContext,raw:AppleClockAssertionInput){
      const p=snapshot(raw);
      const enrolled=await withAttendanceTenant(ctx,tx=>key(tx,ctx,p,false));
      const challenge=await issueOwnIntegrityChallenge(ctx,intent(p));
      if(challenge.installationId!==enrolled.installationId)throw new AppleClockAssertionError('key_unavailable');
      return {challenge,context:data(ctx,p,challenge)};
    },
    async consume<T>(ctx:SessionContext,raw:AppleClockAssertionInput,proof:{challengeId:string;assertion:Buffer},
      operation:(tx:Tx,checked:{context:OnlineClockIntegrityData;photo:Buffer|undefined;deviceToken:string|undefined;nextCounter:number;proofKind:'apple_key_proof'|'apple_app_metadata'})=>Promise<T>){
      const p=snapshot(raw),challengeId=uuid.parse(proof.challengeId);
      if(!Buffer.isBuffer(proof.assertion)||proof.assertion.length<1||proof.assertion.length>8192)throw new AppleClockAssertionError('invalid_command');
      const assertion=Buffer.from(proof.assertion);
      return consumeOwnIntegrityChallenge(ctx,{...intent(p),challengeId},async(tx,challenge)=>{
        const enrolled=await key(tx,ctx,p,true);
        if(enrolled.installationId!==challenge.installationId)throw new AppleClockAssertionError('key_unavailable');
        const context=data(ctx,p,challenge),checked=checkAppAttestAssertion({assertion,clientData:Buffer.from(onlineClockClientData(context),'utf8'),
          publicKey:createPublicKey({key:enrolled.publicKeySpki,type:'spki',format:'der'}),appId:config.target.appId,previousCounter:enrolled.assertionCounter});
        // A request can wait for the key lock beyond the challenge window. Recheck DB time after
        // that wait and verification; process wall time and the earlier consumption stamp do not suffice.
        await fresh(tx,challenge);
        const [updated]=await tx.update(mobileIntegrityKey).set({assertionCounter:checked.nextCounter}).where(and(
          eq(mobileIntegrityKey.id,enrolled.id),eq(mobileIntegrityKey.assertionCounter,enrolled.assertionCounter),isNull(mobileIntegrityKey.revokedAt))).returning({id:mobileIntegrityKey.id});
        if(!updated)throw new AppleClockAssertionError('counter_unavailable');
        const value=await operation(tx,{context,photo:p.photo,deviceToken:p.deviceToken,nextCounter:checked.nextCounter,proofKind:enrolled.proofKind as 'apple_key_proof'|'apple_app_metadata'});
        await ports.beforeCommit?.(tx);
        // Acceptance may wait on another subject/day lock after the key check. A stale grant must
        // roll back even if the callback has already written its tentative attendance outcome.
        await own(tx,ctx,p);
        await fresh(tx,challenge);
        await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'mobile-integrity-challenge',aggregateId:challengeId,
          eventType:'mobile.integrity.assertion.checked',actor:actorOf(ctx),subjectEmploymentId:p.employmentId,
          payload:{keyId:enrolled.id,counter:checked.nextCounter,proofKind:enrolled.proofKind}});
        return value;
      });
    },
  };
}
