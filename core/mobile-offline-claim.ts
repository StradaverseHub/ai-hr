/** Ordered original-claim consumption. Provider preparation is outside locks; all effects share tx. */
import 'server-only';
import {createHash,createPublicKey,randomUUID} from 'node:crypto';
import {and,eq,isNull,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {mobileIntegrityKey,mobileOfflineContext,mobileOfflineClaim,mobileOfflinePhoto,attendancePunch,attendanceClockCapture} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import {encryptSecret,isSecretStorable} from '../lib/ai/crypto';
import {AppleEnrollmentSettings} from '../lib/mobile-key-enrollment';
import {OfflineClockSignedClaim,offlineClockClaimClientData} from '../lib/mobile-offline-clock';
import {OfflineClockDecision,OfflineClockReceipt,type OfflineClockDisposition} from '../lib/mobile-offline-receipt';
import {HR_LOCAL_TZ} from '../lib/hr-date';
import {offlineClockContextClientData,type OfflineClockContextData} from '../lib/mobile-offline-context';
import {verifyOfflineClockProof} from '../lib/mobile-api/offline-clock-proof';
import {offlineClockReportedBounds,type OfflineClockReportedBounds} from '../lib/mobile-api/offline-clock-time';
import {readIssuedOfflineContextTx} from './mobile-offline-context';
import {ownIntegrityEnrollmentCompanyTx} from './mobile-integrity-key';
import {withAttendanceTenant} from './module-gate';
import {attendanceClockCaptureEffectiveAt,clockAttendanceDateTx,openClockSessionDateTx} from '../packs/attendance/service';
type KeyRow=typeof mobileIntegrityKey.$inferSelect;
type ClaimRow=typeof mobileOfflineClaim.$inferSelect;
export type OfflineClaimFacts={claim:OfflineClockSignedClaim['claim'];context:OfflineClockContextData;key:Readonly<KeyRow>;
 digest:string;receivedAt:number;currentCompanyId:string;bounds:OfflineClockReportedBounds};
export type OfflineClaimPhoto={bytes:Buffer;mimeType:'image/jpeg'|'image/png'};
export type OfflineClaimPorts={
 /** Verify current upload environment/configuration outside DB locks. Android must perform its
  * fresh payload-bound Play check here; iOS must not generate a later transport assertion. */
 prepare(ctx:SessionContext,facts:OfflineClaimFacts):Promise<{assertFresh(tx:Tx,facts:OfflineClaimFacts):Promise<void>}>;
 /** Deterministic policy owner. Accepted must call the canonical offline attendance writer (captureOfflineClockTx) in
  * this same tx and return its capture, whose live mobile_offline punch records exactly effectiveAt; review/refusal creates
  * no attendance fact. No network/nested tx. Not called for a request ID an attendance capture already holds. */
 adjudicate(tx:Tx,ctx:SessionContext,facts:OfflineClaimFacts,photo:OfflineClaimPhoto|null):Promise<unknown>;
 /** Recheck deployment/issuer/current-key/policy eligibility after tentative writes. */
 beforeCommit(tx:Tx,ctx:SessionContext,facts:OfflineClaimFacts,decision:OfflineClockDisposition):Promise<void>;
};
export class OfflineClaimError extends Error{
 constructor(readonly reason:'configuration_unavailable'|'scope_unavailable'|'context_unavailable'|'key_unavailable'|'binding_conflict'|'chain_conflict'|'invalid_proof'|'attachment_mismatch'|'time_unavailable'){
  super('Offline claim unavailable');this.name='OfflineClaimError';
 }
}
const unavailable=()=>new OfflineClaimError('configuration_unavailable');
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const claimAAD=(r:Pick<ClaimRow,'tenantId'|'actorId'|'id'|'contextId'|'requestId'>)=>JSON.stringify(['mobile-offline-claim',1,r.tenantId,r.actorId,r.id,r.contextId,r.requestId]);
export function offlineClaimPhotoAAD(row:{tenantId:string;actorId:string;claimId:string;employmentId:string;photoDigest:string;byteLength:number;mimeType:string}){
 return JSON.stringify(['mobile-offline-photo',1,row.tenantId,row.actorId,row.claimId,row.employmentId,row.photoDigest,row.byteLength,row.mimeType]);
}
function receipt(row:ClaimRow):OfflineClockReceipt{
 try{return OfflineClockReceipt.parse({version:1,purpose:'attendance.clock.offline.receipt',id:row.id,contextId:row.contextId,requestId:row.requestId,sequence:row.sequence,digest:row.claimDigest,outcome:row.outcome,reason:row.reason,
  receivedAt:row.receivedAt.getTime(),effectiveMinimum:row.effectiveMinimum?.getTime()??null,effectiveMaximum:row.effectiveMaximum?.getTime()??null,effectiveAt:row.effectiveAt?.getTime()??null,captureId:row.captureId,
  photo:row.photoDigest&&row.photoRetainedUntil?{sha256:row.photoDigest,retainedUntil:row.photoRetainedUntil.getTime()}:null});}catch{throw unavailable();}
}
async function stamp(tx:Tx){const [row]=await tx.execute(sql`select clock_timestamp() stamp`),value=row?.stamp,date=value instanceof Date?value:new Date(String(value));if(!Number.isFinite(date.getTime()))throw new OfflineClaimError('time_unavailable');return date;}
/** No defaults, routes, provider bypass or automatic acceptance. Deployment must supply actual
 * current verification, deterministic adjudication/canonical writing, and commit guards. */
export function createOfflineClaimService(settings:unknown,ports:OfflineClaimPorts){
 const Config=z.object({apiOrigin:AppleEnrollmentSettings.shape.apiOrigin,photoRetentionMs:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict(),parsed=Config.safeParse(settings);
 if(!parsed.success||typeof ports?.prepare!=='function'||typeof ports.adjudicate!=='function'||typeof ports.beforeCommit!=='function')throw unavailable();
 const config=parsed.data;
 async function own(tx:Tx,ctx:SessionContext,signed:OfflineClockSignedClaim){
  const s=signed.claim.scope;if(s.apiOrigin!==config.apiOrigin||s.tenantId!==ctx.tenantId||s.actorId!==ctx.userId)throw new OfflineClaimError('scope_unavailable');
  const companyId=await ownIntegrityEnrollmentCompanyTx(tx,ctx,s.employmentId);if(!companyId)throw new OfflineClaimError('scope_unavailable');return companyId;
 }
 async function recovered(tx:Tx,ctx:SessionContext,signed:OfflineClockSignedClaim,digest:string){
  const [row]=await tx.select().from(mobileOfflineClaim).where(and(eq(mobileOfflineClaim.tenantId,ctx.tenantId),eq(mobileOfflineClaim.actorId,ctx.userId!),eq(mobileOfflineClaim.requestId,signed.claim.command.requestId))).limit(1);
  if(!row)return null;
  if(row.claimDigest!==digest||row.contextId!==signed.claim.context.id||row.employmentId!==signed.claim.scope.employmentId||row.deviceKeyId!==signed.claim.scope.deviceKeyId)throw new OfflineClaimError('binding_conflict');return receipt(row);
 }
 async function recover(ctx:SessionContext,signed:OfflineClockSignedClaim,digest:string){return withAttendanceTenant(ctx,async tx=>{await own(tx,ctx,signed);return recovered(tx,ctx,signed,digest);});}
 async function checked(tx:Tx,ctx:SessionContext,signed:OfflineClockSignedClaim,digest:string,lock:boolean,receivedAt?:number){
  const s=signed.claim.scope;
  // Same order as context issuance and key revocation: actor admission, registered key, then stream.
  if(lock)await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':mobile-integrity:'+ctx.userId},0))`);
  const query=tx.select().from(mobileIntegrityKey).where(and(eq(mobileIntegrityKey.id,s.deviceKeyId),eq(mobileIntegrityKey.tenantId,ctx.tenantId),eq(mobileIntegrityKey.actorId,ctx.userId!))).limit(1);
  const [key]=await(lock?query.for('update'):query);
  // Reconcile after the key wait, before revocation/provider/context checks: terminal receipts survive them.
  const currentCompanyId=await own(tx,ctx,signed),existing=await recovered(tx,ctx,signed,digest);if(existing)return {kind:'receipt',receipt:existing} as const;
  if(!key||key.revokedAt||key.appInstallationId!==s.appInstallationId||key.installationId!==s.installationId)throw new OfflineClaimError('key_unavailable');
  const contextQuery=tx.select().from(mobileOfflineContext).where(and(eq(mobileOfflineContext.id,signed.claim.context.id),eq(mobileOfflineContext.tenantId,ctx.tenantId),eq(mobileOfflineContext.actorId,ctx.userId!),eq(mobileOfflineContext.employmentId,s.employmentId),eq(mobileOfflineContext.deviceKeyId,key.id))).limit(1);
  const [stream]=await(lock?contextQuery.for('update'):contextQuery);if(!stream||stream.closedAt)throw new OfflineClaimError('context_unavailable');
  const {context}=await readIssuedOfflineContextTx(tx,stream,config.apiOrigin);
  const proof=verifyOfflineClockProof(signed,context,{id:key.id,tenantId:key.tenantId,actorId:key.actorId,installationId:key.installationId,appInstallationId:key.appInstallationId,platform:key.platform,appId:key.appId,environment:key.environment,
   publicKey:createPublicKey({key:key.publicKeySpki,format:'der',type:'spki'}),assertionCounter:key.assertionCounter},{nextSequence:stream.nextSequence,previousSha256:stream.previousDigest});
  if(proof.outcome!=='proof_valid')throw new OfflineClaimError(proof.reason==='chain_mismatch'?'chain_conflict':['scope_mismatch','context_mismatch','key_mismatch','permit_mismatch'].includes(proof.reason)?'binding_conflict':'invalid_proof');
  const now=await stamp(tx),admitted=receivedAt??now.getTime();if(admitted<context.issuedAt||now.getTime()<admitted)throw new OfflineClaimError('time_unavailable');
  return {kind:'new',facts:{claim:signed.claim,context,key,digest,receivedAt:admitted,currentCompanyId,bounds:offlineClockReportedBounds(context,signed.claim,admitted)} satisfies OfflineClaimFacts,stream,proof} as const;
 }
 function photoMatches(signed:OfflineClockSignedClaim,photo:OfflineClaimPhoto|null){
  const expected=signed.claim.command.photo;
  if(!expected)return photo===null;
  return photo!==null&&expected.byteLength===photo.bytes.length&&expected.mimeType===photo.mimeType&&expected.sha256===hash(photo.bytes);
 }
 return {
  async consume(ctx:SessionContext,raw:unknown,attachment?:OfflineClaimPhoto):Promise<OfflineClockReceipt>{
   // Reject unbounded opaque proof strings before invoking regex/CBOR/crypto, independently of HTTP caps.
   const opaque=raw&&typeof raw==='object'?Reflect.get(raw,'proof'):null;
   if(opaque&&typeof opaque==='object')for(const field of ['assertion','signature']){const value=Reflect.get(opaque,field);if(typeof value==='string'&&value.length>(field==='assertion'?10924:96))throw new OfflineClaimError('invalid_proof');}
   const signed=OfflineClockSignedClaim.parse(raw),digest=hash(offlineClockClaimClientData(signed.claim));
   let photo:OfflineClaimPhoto|null=null;
   if(attachment){if(!Buffer.isBuffer(attachment.bytes)||attachment.bytes.length<1||attachment.bytes.length>2097152||!['image/jpeg','image/png'].includes(attachment.mimeType))throw new OfflineClaimError('attachment_mismatch');photo={bytes:Buffer.from(attachment.bytes),mimeType:attachment.mimeType};}
   // Recovery needs no old image, issuer private key, provider call, active key or encryption key.
   const prior=await recover(ctx,signed,digest);if(prior)return prior;
   if(!photoMatches(signed,photo))throw new OfflineClaimError('attachment_mismatch');if(!isSecretStorable())throw unavailable();
   let initial:Awaited<ReturnType<typeof checked>>;
   try{initial=await withAttendanceTenant(ctx,async tx=>{await own(tx,ctx,signed);return checked(tx,ctx,signed,digest,false);});}
   catch(error){const committed=await recover(ctx,signed,digest);if(committed)return committed;throw error;}
   if(initial.kind==='receipt')return initial.receipt;
   const receivedAt=initial.facts.receivedAt;
   let prepared:Awaited<ReturnType<OfflineClaimPorts['prepare']>>;
   try{prepared=await ports.prepare(ctx,initial.facts);if(typeof prepared?.assertFresh!=='function')throw unavailable();}
   catch(error){const committed=await recover(ctx,signed,digest);if(committed)return committed;throw error;}
   return withAttendanceTenant(ctx,async tx=>{
    await own(tx,ctx,signed);const current=await checked(tx,ctx,signed,digest,true,receivedAt);if(current.kind==='receipt')return current.receipt;
    const {facts,stream,proof}=current;
    const seal=()=>hash(JSON.stringify([offlineClockClaimClientData(facts.claim),offlineClockContextClientData(facts.context),facts.key.id,facts.key.assertionCounter,facts.receivedAt,facts.currentCompanyId,facts.bounds]));
    const originalSeal=seal(),originalKeyId=facts.key.id;
    await prepared.assertFresh(tx,facts);
    // Owner decision 2026-10-28: a request ID an attendance capture already holds (tenant/employment/request,
    // its unique key) is refused before policy. The subject lock follows key/stream, as in the canonical
    // clock writers, which take it before their own request lookup; it is held to commit.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+facts.claim.scope.employmentId},0))`);
    const [recorded]=await tx.select({id:attendanceClockCapture.id}).from(attendanceClockCapture).where(and(eq(attendanceClockCapture.tenantId,ctx.tenantId),
     eq(attendanceClockCapture.employmentId,facts.claim.scope.employmentId),eq(attendanceClockCapture.requestId,facts.claim.command.requestId))).limit(1);
    // The session an overnight out may close, read as the canonical writer reads it: under this lock, before any punch.
    const unclosed=await openClockSessionDateTx(tx,facts.claim.scope.employmentId);
    // The policy owner receives a copy; the image bytes retained below never leave this service.
    let decision:OfflineClockDisposition;
    if(recorded)decision={outcome:'refused',reason:'request_conflict'};
    else{const parsedDecision=OfflineClockDecision.safeParse(await ports.adjudicate(tx,ctx,facts,photo&&{bytes:Buffer.from(photo.bytes),mimeType:photo.mimeType}));if(!parsedDecision.success)throw unavailable();decision=parsedDecision.data;}
    if(seal()!==originalSeal)throw new OfflineClaimError('binding_conflict');
    if(!photoMatches(signed,photo))throw new OfflineClaimError('attachment_mismatch');
    if(facts.currentCompanyId!==facts.context.scope.companyId&&(decision.outcome==='accepted'||(decision.reason!=='scope_changed'&&decision.reason!=='request_conflict')))throw unavailable();
    if(decision.outcome==='accepted'&&(facts.bounds.status!=='reported_interval'||facts.bounds.minimum<facts.context.issuedAt||facts.bounds.maximum>facts.context.expiresAt||decision.effectiveAt<facts.bounds.minimum||decision.effectiveAt>facts.bounds.maximum))throw unavailable();
    if(decision.outcome==='accepted'){
     // Owner decisions 2026-10-28: the linked live punch records exactly effectiveAt, else the whole tx rolls back,
     // and an overnight out belongs to the open session's start day, as the online writer files it. punch_at is
     // PostgreSQL time (microsecond), the MYT wall clock of the instant; it must equal the integer-millisecond
     // instant at that native precision. attendance_date must be the canonical writer's day for this action and
     // instant: its MYT day, or for that overnight out only the start day (instant = start day + 1 + punch_at).
     // The canonical offline writer's provenance too: its capture owns exactly this effective_at, its punch is mobile_offline.
     const effective=new Date(decision.effectiveAt),date=await clockAttendanceDateTx(tx,facts.claim.scope.employmentId,facts.claim.command.action,effective,unclosed);
     const [punch]=await tx.select({id:attendancePunch.id,date:attendancePunch.attendanceDate,method:attendancePunch.method,
      exact:sql<boolean>`${attendancePunch.punchAt}=(${effective.toISOString()}::timestamptz at time zone ${HR_LOCAL_TZ}::text)::time`,
      effective:sql<boolean>`coalesce(${attendanceClockCaptureEffectiveAt}=${effective.toISOString()}::timestamptz,false)`}).from(attendancePunch).innerJoin(attendanceClockCapture,eq(attendanceClockCapture.id,attendancePunch.clockCaptureId)).where(and(
      eq(attendanceClockCapture.id,decision.captureId),eq(attendanceClockCapture.tenantId,ctx.tenantId),eq(attendanceClockCapture.employmentId,facts.claim.scope.employmentId),eq(attendanceClockCapture.requestId,facts.claim.command.requestId),
      eq(attendancePunch.tenantId,ctx.tenantId),eq(attendancePunch.employmentId,facts.claim.scope.employmentId),eq(attendancePunch.direction,facts.claim.command.action),isNull(attendancePunch.voidedAt))).limit(1);
     if(!punch||punch.date!==date||punch.exact!==true||punch.effective!==true||punch.method!=='mobile_offline')throw unavailable();
    }
    const now=await stamp(tx),retainedUntil=photo?new Date(now.getTime()+config.photoRetentionMs):null;
    if(retainedUntil&&!Number.isFinite(retainedUntil.getTime()))throw unavailable();
    const id=randomUUID(),r={tenantId:ctx.tenantId,actorId:ctx.userId!,id,contextId:stream.id,requestId:facts.claim.command.requestId};
    const [stored]=await tx.insert(mobileOfflineClaim).values({...r,employmentId:facts.claim.scope.employmentId,deviceKeyId:facts.key.id,permitId:facts.claim.permit.id,sequence:facts.claim.chain.sequence,
     claimDigest:digest,previousDigest:facts.claim.chain.previousSha256,proofDigest:hash(Buffer.from(signed.proof.platform==='ios'?signed.proof.assertion:signed.proof.signature,'base64')),assertionCounter:proof.nextCounter,
     claimCiphertext:encryptSecret(JSON.stringify(signed),claimAAD(r)),photoDigest:photo?facts.claim.command.photo!.sha256:null,photoRetainedUntil:retainedUntil,
     claimedAt:new Date(facts.claim.time.claimedAt),sampledAt:new Date(facts.claim.command.sampledAt),receivedAt:new Date(facts.receivedAt),
     effectiveMinimum:facts.bounds.status==='reported_interval'?new Date(facts.bounds.minimum):null,effectiveMaximum:facts.bounds.status==='reported_interval'?new Date(facts.bounds.maximum):null,
     effectiveAt:decision.outcome==='accepted'?new Date(decision.effectiveAt):null,captureId:decision.outcome==='accepted'?decision.captureId:null,outcome:decision.outcome,reason:decision.reason}).returning();
    if(!stored)throw unavailable();
    if(photo){const metadata={claimId:id,tenantId:ctx.tenantId,actorId:ctx.userId!,employmentId:facts.claim.scope.employmentId,photoDigest:facts.claim.command.photo!.sha256,byteLength:photo.bytes.length,mimeType:photo.mimeType};
     await tx.insert(mobileOfflinePhoto).values({...metadata,retainedUntil:retainedUntil!,photoCiphertext:encryptSecret(photo.bytes.toString('base64'),offlineClaimPhotoAAD(metadata))});}
    if(proof.nextCounter!==null){const [advanced]=await tx.update(mobileIntegrityKey).set({assertionCounter:proof.nextCounter}).where(and(eq(mobileIntegrityKey.id,facts.key.id),eq(mobileIntegrityKey.assertionCounter,facts.key.assertionCounter),isNull(mobileIntegrityKey.revokedAt))).returning({id:mobileIntegrityKey.id});if(!advanced)throw new OfflineClaimError('key_unavailable');}
    const exhausted=proof.cursor.nextSequence>stream.permitCount;
    const [advanced]=await tx.update(mobileOfflineContext).set({nextSequence:proof.cursor.nextSequence,previousDigest:digest,...(exhausted?{closedAt:sql`clock_timestamp()`,closeReason:'exhausted' as const,closeRequestId:facts.claim.command.requestId}:{})})
     .where(and(eq(mobileOfflineContext.id,stream.id),eq(mobileOfflineContext.nextSequence,stream.nextSequence),isNull(mobileOfflineContext.closedAt))).returning({id:mobileOfflineContext.id});if(!advanced)throw new OfflineClaimError('chain_conflict');
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'mobile-offline-claim',aggregateId:id,eventType:'mobile.offline.claim.processed',actor:actorOf(ctx),subjectEmploymentId:facts.claim.scope.employmentId,
     payload:{contextId:stream.id,sequence:facts.claim.chain.sequence,outcome:decision.outcome,reason:decision.reason,keyId:facts.key.id}});
    await ports.beforeCommit(tx,ctx,facts,decision);await prepared.assertFresh(tx,facts);
    if(seal()!==originalSeal)throw new OfflineClaimError('binding_conflict');
    if(await own(tx,ctx,signed)!==facts.currentCompanyId)throw new OfflineClaimError('scope_unavailable');
    const [key]=await tx.select().from(mobileIntegrityKey).where(eq(mobileIntegrityKey.id,originalKeyId)).limit(1);if(!key||key.revokedAt)throw new OfflineClaimError('key_unavailable');
    if(!isSecretStorable())throw unavailable();if((await stamp(tx)).getTime()<facts.receivedAt)throw new OfflineClaimError('time_unavailable');
    return receipt(stored);
   });
  },
 };
}
