/** Transactional preissued context/permit owner. No route activation or attendance adjudication. */
import 'server-only';
import {createHash,KeyObject,randomBytes,randomUUID} from 'node:crypto';
import {and,eq,gt,isNull,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {mobileIntegrityChallenge,mobileIntegrityKey,mobileOfflineContext,mobileOfflinePermit} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import {encryptSecret,decryptSecret,isSecretStorable} from '../lib/ai/crypto';
import {AppleEnrollmentSettings} from '../lib/mobile-key-enrollment';
import {OfflineClockContextData,OfflineClockContextEnvelope,OfflineClockContextIssuer,OfflineClockContextRequest,OFFLINE_CLOCK_CONTEXT_MAX_BYTES,offlineClockContextClientData} from '../lib/mobile-offline-context';
import {offlineContextIssuerIdentity,signOfflineClockContext} from '../lib/mobile-api/offline-context-signature';
import {RequestBudgetExceeded} from '../lib/request-budget';
import {withAttendanceTenant} from './module-gate';
import {ownIntegrityEnrollmentCompanyTx} from './mobile-integrity-key';
import {assertNoOfflineClockLeaseTx} from './mobile-offline-lease';
import {requireRegisteredDeviceTx} from './attendance-device';
import {OfflineContextIssueError} from '../lib/mobile-offline-errors';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const Input=z.object({employmentId:uuid,request:OfflineClockContextRequest}).strict();
const Snapshot=z.object({policy:OfflineClockContextData.shape.policy,sites:OfflineClockContextData.shape.sites,attendance:OfflineClockContextData.shape.attendance,target:OfflineClockContextData.shape.target,permitCount:z.number().int().min(1).max(32)}).strict();
export type OfflineContextSnapshot=z.infer<typeof Snapshot>;
type KeyRow=typeof mobileIntegrityKey.$inferSelect;
export type IssuedOfflineContextRow=typeof mobileOfflineContext.$inferSelect;
// The class lives in a server-agnostic module so the attendance facade's load graph stays free of 'server-only'.
export {OfflineContextIssueError};
export class OfflineContextCloseError extends Error{
 constructor(readonly reason:'context_unavailable'|'key_unavailable'|'context_closed'|'claims_pending'|'cursor_mismatch'|'binding_conflict'){
  super('Offline context close unavailable');this.name='OfflineContextCloseError';
 }
}
export type OfflineContextIssuePorts={
 /** Trusted current policy/site/attendance and key-configuration owner; no network/nested tx. */
 snapshot(tx:Tx,ctx:SessionContext,subject:{employmentId:string;companyId:string;key:Readonly<KeyRow>}):Promise<unknown>;
 /** Mandatory deployment/current-key eligibility check, including same-transaction revalidation.
  * Recover mode preserves historical signed bytes through ordinary issuer/policy rotation. */
 beforeCommit(tx:Tx,ctx:SessionContext,checked:{context:OfflineClockContextData;key:Readonly<KeyRow>;mode:'issue'|'recover'}):Promise<void>;
};
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const aad=(row:Pick<IssuedOfflineContextRow,'tenantId'|'actorId'|'id'|'requestId'>)=>JSON.stringify(['mobile-offline-context',1,row.tenantId,row.actorId,row.id,row.requestId]);
const unavailable=()=>new OfflineContextIssueError('configuration_unavailable');
async function stamp(tx:Tx){
 const [row]=await tx.execute(sql`select clock_timestamp() stamp`),value=row?.stamp,date=value instanceof Date?value:new Date(String(value));
 if(!Number.isFinite(date.getTime()))throw new OfflineContextIssueError('time_unavailable');return date;
}
/** The caller must first load this own issued row under the appropriate stream/key locks. AES-GCM
 * and immutable record checks bind recovery to original issuance, including after signer rotation.
 * This is not an HTTP-supplied context verifier and grants no authority to a submitted envelope. */
export async function readIssuedOfflineContextTx(tx:Tx,row:IssuedOfflineContextRow,apiOrigin:string){
 try{
  if(!isSecretStorable())throw unavailable();
  const raw=decryptSecret(row.contextCiphertext,aad(row));if(Buffer.byteLength(raw,'utf8')>OFFLINE_CLOCK_CONTEXT_MAX_BYTES)throw unavailable();
  const {context}=OfflineClockContextEnvelope.parse(JSON.parse(raw)),s=context.scope,digest=hash(offlineClockContextClientData(context));
  if(context.id!==row.id||context.requestId!==row.requestId||context.requestNonce!==row.requestNonce||digest!==row.contextDigest||context.issuer.keyId!==row.issuerKeyId||
   context.policy.revision!==row.policyRevision||context.issuedAt!==row.issuedAt.getTime()||context.expiresAt!==row.expiresAt.getTime()||context.permits.length!==row.permitCount||
   s.apiOrigin!==apiOrigin||s.tenantId!==row.tenantId||s.actorId!==row.actorId||s.employmentId!==row.employmentId||s.companyId!==row.companyId||s.deviceKeyId!==row.deviceKeyId||s.installationId!==row.installationId||s.appInstallationId!==row.appInstallationId)throw unavailable();
  const permits=await tx.select().from(mobileOfflinePermit).where(eq(mobileOfflinePermit.contextId,row.id)).orderBy(mobileOfflinePermit.ordinal);
  if(permits.length!==context.permits.length||permits.some((p,i)=>p.tenantId!==row.tenantId||p.actorId!==row.actorId||p.id!==context.permits[i].id||p.ordinal!==context.permits[i].ordinal||p.nonce!==context.permits[i].nonce))throw unavailable();
  return {raw,context,digest};
 }catch(error){if(error instanceof OfflineContextIssueError)throw error;throw unavailable();}
}
/** Config/private material and both policy ports are server-owned. Required admission cap is an
 * engineering request budget, not an attendance rule. There is deliberately no default policy,
 * issuer/private-key loader or mounted offline endpoint in this service. */
export function createOfflineContextIssueService(settings:unknown,ports:OfflineContextIssuePorts){
 const Config=z.object({apiOrigin:AppleEnrollmentSettings.shape.apiOrigin,issuer:OfflineClockContextIssuer,
  privateKey:z.custom<KeyObject>(value=>value instanceof KeyObject),maximumIssuesPerHour:z.number().int().min(1).max(24)}).strict();
 const parsed=Config.safeParse(settings);if(!parsed.success||typeof ports?.snapshot!=='function'||typeof ports.beforeCommit!=='function')throw unavailable();
 const config=parsed.data;
 try{const identity=offlineContextIssuerIdentity(config.privateKey);if(identity.keyId!==config.issuer.keyId||identity.publicKey!==config.issuer.publicKey)throw unavailable();}catch{throw unavailable();}
 async function own(tx:Tx,ctx:SessionContext,employmentId:string){
  const companyId=await ownIntegrityEnrollmentCompanyTx(tx,ctx,employmentId);if(!companyId)throw unavailable();return companyId;
 }
 async function key(tx:Tx,ctx:SessionContext,input:z.infer<typeof Input>){
  const [row]=await tx.select().from(mobileIntegrityKey).where(and(eq(mobileIntegrityKey.id,input.request.keyId),eq(mobileIntegrityKey.tenantId,ctx.tenantId),eq(mobileIntegrityKey.actorId,ctx.userId!))).limit(1).for('update');
  if(!row||row.revokedAt||row.appInstallationId!==input.request.appInstallationId||
   (row.platform==='ios'?(row.environment===null||!['apple_key_proof','apple_app_metadata'].includes(row.proofKind)):(row.environment!==null||row.proofKind!=='google_key_generation_proof')))throw new OfflineContextIssueError('key_unavailable');
  return row;
 }
 async function final(tx:Tx,ctx:SessionContext,input:z.infer<typeof Input>,context:OfflineClockContextData,enrolled:KeyRow,mode:'issue'|'recover'){
  await ports.beforeCommit(tx,ctx,{context,key:enrolled,mode});
  if(await own(tx,ctx,input.employmentId)!==context.scope.companyId)throw new OfflineContextIssueError('binding_conflict');
  await key(tx,ctx,input);
  const [current]=await tx.select().from(mobileOfflineContext).where(eq(mobileOfflineContext.id,context.id)).limit(1).for('update');
  if(!current||current.closedAt)throw new OfflineContextIssueError('context_closed');
  if(current.contextDigest!==hash(offlineClockContextClientData(context)))throw unavailable();
  if(!isSecretStorable())throw unavailable();
  const now=await stamp(tx);if(now.getTime()<context.issuedAt||mode==='issue'&&now.getTime()>=context.expiresAt)throw new OfflineContextIssueError('time_unavailable');
 }
 return {
  async issue(ctx:SessionContext,raw:unknown):Promise<{outcome:'issued';raw:string;contextId:string;authorization:'not_granted'}>{
   const input=Input.parse(raw);if(!isSecretStorable())throw unavailable();
   return withAttendanceTenant(ctx,async tx=>{
    await own(tx,ctx,input.employmentId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':mobile-integrity:'+ctx.userId},0))`);
    const enrolled=await key(tx,ctx,input),companyId=await own(tx,ctx,input.employmentId);
    const [existing]=await tx.select().from(mobileOfflineContext).where(and(eq(mobileOfflineContext.tenantId,ctx.tenantId),eq(mobileOfflineContext.actorId,ctx.userId!),eq(mobileOfflineContext.requestId,input.request.requestId))).limit(1);
    if(existing){
     if(existing.employmentId!==input.employmentId||existing.companyId!==companyId||existing.deviceKeyId!==enrolled.id||existing.appInstallationId!==input.request.appInstallationId||existing.requestNonce!==input.request.requestNonce)throw new OfflineContextIssueError('binding_conflict');
     if(existing.closedAt)throw new OfflineContextIssueError('context_closed');
     const recovered=await readIssuedOfflineContextTx(tx,existing,config.apiOrigin);
     if(recovered.context.target.platform!==enrolled.platform||recovered.context.target.appId!==enrolled.appId||recovered.context.target.environment!==enrolled.environment)throw new OfflineContextIssueError('key_unavailable');
     await final(tx,ctx,input,recovered.context,enrolled,'recover');
     return {outcome:'issued',raw:recovered.raw,contextId:existing.id,authorization:'not_granted'};
    }
    await assertNoOfflineClockLeaseTx(tx,ctx,input.request.appInstallationId);
    const now=await stamp(tx);
    const pending=await tx.select({id:mobileIntegrityChallenge.id}).from(mobileIntegrityChallenge).where(and(eq(mobileIntegrityChallenge.tenantId,ctx.tenantId),eq(mobileIntegrityChallenge.actorId,ctx.userId!),eq(mobileIntegrityChallenge.appInstallationId,input.request.appInstallationId),eq(mobileIntegrityChallenge.purpose,'clock.online'),isNull(mobileIntegrityChallenge.consumedAt),gt(mobileIntegrityChallenge.expiresAt,now))).limit(1);
    if(pending.length)throw new OfflineContextIssueError('online_pending');
    const snapshot=Snapshot.safeParse(await ports.snapshot(tx,ctx,{employmentId:input.employmentId,companyId,key:enrolled}));if(!snapshot.success)throw unavailable();
    // The trusted owner says offline is off for this company: a clean refusal, nothing written.
    if(!snapshot.data.policy.offlineEnabled)throw new OfflineContextIssueError('offline_disabled');
    // Owner decision 5 (2026-10-28): a company that requires a registered device gets no new context. A claim carries no
    // legacy device token, so the canonical writer would only ever hold it for review. New issuance only: an exact
    // recovery above still returns the original bytes, so the phone can learn the context id and close it.
    if(await requireRegisteredDeviceTx(tx,input.employmentId))throw new OfflineContextIssueError('device_required');
    const p=snapshot.data;
    if(p.target.platform!==enrolled.platform||p.target.appId!==enrolled.appId||p.target.environment!==enrolled.environment)throw new OfflineContextIssueError('key_unavailable');
    const minted=await stamp(tx),issuedAt=minted.getTime(),expiresAt=Math.min(issuedAt+p.policy.windowMs,config.issuer.validUntil);
    if(config.issuer.revoked||issuedAt<config.issuer.validFrom||expiresAt<=issuedAt)throw unavailable();
    const [budget]=await tx.execute(sql`select app.consume_request_budget(${hash(JSON.stringify(['mobile-offline-context-issue',ctx.tenantId,ctx.userId]))},${config.maximumIssuesPerHour},3600) retry_after`),retry=Number(budget?.retry_after);
    if(budget?.retry_after==null||!Number.isFinite(retry)||retry<0)throw unavailable();if(retry>0)throw new RequestBudgetExceeded(Math.max(1,Math.ceil(retry)));
    const checkedContext=OfflineClockContextData.safeParse({version:1,purpose:'attendance.clock.offline.context',issuer:{algorithm:'ed25519',keyId:config.issuer.keyId},id:randomUUID(),requestId:input.request.requestId,requestNonce:input.request.requestNonce,
     scope:{apiOrigin:config.apiOrigin,installationId:enrolled.installationId,tenantId:ctx.tenantId,companyId,actorId:ctx.userId,employmentId:input.employmentId,appInstallationId:input.request.appInstallationId,deviceKeyId:enrolled.id},target:p.target,
     issuedAt,expiresAt,policy:p.policy,sites:p.sites,attendance:p.attendance,permits:Array.from({length:p.permitCount},(_,index)=>({id:randomUUID(),ordinal:index+1,nonce:randomBytes(32).toString('base64url')}))});
    if(!checkedContext.success)throw unavailable();const context=checkedContext.data;
    const signed=signOfflineClockContext(context,config.privateKey),digest=hash(offlineClockContextClientData(context));
    await tx.insert(mobileOfflineContext).values({id:context.id,tenantId:ctx.tenantId,actorId:ctx.userId!,employmentId:input.employmentId,companyId,deviceKeyId:enrolled.id,installationId:enrolled.installationId,appInstallationId:input.request.appInstallationId,
     requestId:input.request.requestId,requestNonce:input.request.requestNonce,contextDigest:digest,issuerKeyId:config.issuer.keyId,policyRevision:p.policy.revision,contextCiphertext:encryptSecret(signed,aad({tenantId:ctx.tenantId,actorId:ctx.userId!,id:context.id,requestId:input.request.requestId})),issuedAt:minted,expiresAt:new Date(expiresAt),permitCount:p.permitCount});
    await tx.insert(mobileOfflinePermit).values(context.permits.map(permit=>({...permit,tenantId:ctx.tenantId,actorId:ctx.userId!,contextId:context.id})));
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'mobile-offline-context',aggregateId:context.id,eventType:'mobile.offline.context.issued',actor:actorOf(ctx),subjectEmploymentId:input.employmentId,payload:{keyId:enrolled.id,permitCount:p.permitCount,policyRevision:p.policy.revision}});
    await final(tx,ctx,input,context,enrolled,'issue');
    return {outcome:'issued',raw:signed,contextId:context.id,authorization:'not_granted'};
   });
  },
 };
}
const CloseInput=z.object({contextId:uuid,closeRequestId:uuid,consumedThrough:z.number().int().min(0).max(32)}).strict();
export type OfflineContextClosed={outcome:'closed';contextId:string;reason:'exhausted'|'retired'|'revoked';closeRequestId:string;consumedThrough:number;closedAt:number};
function closed(row:IssuedOfflineContextRow):OfflineContextClosed{
 if(!row.closedAt||!row.closeReason||!row.closeRequestId)throw new OfflineContextCloseError('context_unavailable');
 return {outcome:'closed',contextId:row.id,reason:row.closeReason,closeRequestId:row.closeRequestId,consumedThrough:row.nextSequence-1,closedAt:row.closedAt.getTime()};
}
/** Explicit own retirement, releasing the key lease (0647's open-context unique index and lease function), so online
 * clocking and a later issuance can proceed. Authority is the bearer session's actor plus ownership of the context's
 * registered key (revoked or not); no deployment, issuer or company policy is read here. Closes with reason 'retired'
 * only when the phone's consumedThrough equals the server cursor (nextSequence-1): claims the phone holds but has not
 * uploaded (claims_pending), or a phone behind the server (cursor_mismatch), are refused and nothing changes. A closed
 * context is never reopened. An exact retry (same closeRequestId and consumedThrough) returns the recorded closure;
 * any other request on a closed context is context_closed. Same lock order as issuance, consumption and revocation:
 * actor admission, registered key, then stream. An unreadable former employment hides the context (RLS); revoking
 * the key remains the release path then. */
export async function closeOwnOfflineContext(ctx:SessionContext,raw:unknown):Promise<OfflineContextClosed>{
 const input=CloseInput.parse(raw);
 return withAttendanceTenant(ctx,async tx=>{
  if(!ctx.userId)throw new OfflineContextCloseError('context_unavailable');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':mobile-integrity:'+ctx.userId},0))`);
  const own=and(eq(mobileOfflineContext.id,input.contextId),eq(mobileOfflineContext.tenantId,ctx.tenantId),eq(mobileOfflineContext.actorId,ctx.userId));
  const [located]=await tx.select({deviceKeyId:mobileOfflineContext.deviceKeyId}).from(mobileOfflineContext).where(own).limit(1);
  if(!located)throw new OfflineContextCloseError('context_unavailable');
  const [key]=await tx.select({id:mobileIntegrityKey.id}).from(mobileIntegrityKey).where(and(eq(mobileIntegrityKey.id,located.deviceKeyId),eq(mobileIntegrityKey.tenantId,ctx.tenantId),eq(mobileIntegrityKey.actorId,ctx.userId))).limit(1).for('update');
  if(!key)throw new OfflineContextCloseError('key_unavailable');
  const [row]=await tx.select().from(mobileOfflineContext).where(own).limit(1).for('update');
  if(!row||row.deviceKeyId!==key.id)throw new OfflineContextCloseError('context_unavailable');
  const consumed=row.nextSequence-1;
  if(row.closedAt){
   if(row.closeRequestId===input.closeRequestId){if(consumed!==input.consumedThrough)throw new OfflineContextCloseError('binding_conflict');return closed(row);}
   throw new OfflineContextCloseError('context_closed');
  }
  if(input.consumedThrough!==consumed)throw new OfflineContextCloseError(input.consumedThrough>consumed?'claims_pending':'cursor_mismatch');
  const [retired]=await tx.update(mobileOfflineContext).set({closedAt:sql`clock_timestamp()`,closeReason:'retired',closeRequestId:input.closeRequestId})
   .where(and(eq(mobileOfflineContext.id,row.id),eq(mobileOfflineContext.nextSequence,row.nextSequence),isNull(mobileOfflineContext.closedAt))).returning();
  if(!retired)throw new OfflineContextCloseError('context_closed');
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'mobile-offline-context',aggregateId:row.id,eventType:'mobile.offline.context.closed',actor:actorOf(ctx),subjectEmploymentId:row.employmentId,
   payload:{reason:'retired',consumedThrough:consumed,keyId:row.deviceKeyId}});
  return closed(retired);
 });
}
