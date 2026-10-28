/** HR review and human resolution of offline claims (owner decision 2026-10-28; protocol decision 6), on draft 0647.
 * Read: a holder of attendance-correction authority over the claim's employment (app.can_correct_attendance) lists that
 * employment's claims and, unless a group admin, reads an UNEXPIRED retained photo; every listed claim and every photo
 * read appends an audit event. Resolve: one immutable human decision per needs_review claim, with a reason; an accept
 * records the punch through the canonical offline writer (captureOfflineClockTx) on behalf of the employee, at an
 * instant the resolver chooses inside the claim's proven interval, under the existing payroll lock owner. The claim row
 * is never changed. Permission is checked here as well as by RLS. UNMOUNTED: no route, screen or production caller.
 *
 * Lock order of a resolution: the subject advisory lock (tenant:employment), then the attendance owners' own order
 * (attendance day row, overtime source, payroll batches by id, through lockAttendancePayrollTx), then the canonical
 * writer, which re-takes the same subject lock (re-entrant) and the already-held day row. It is the tail of the claim
 * consumption order (actor admission, key, stream, subject, payroll, attendance) with its first three locks omitted:
 * a resolution never requests an actor, key or stream lock, so it cannot wait on one while holding the subject lock,
 * and below the subject lock both serialize on that one lock per employment. */
import {createHash} from 'node:crypto';
import {and,desc,eq,isNull,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {attendanceClockCapture,attendancePunch,employment,mobileOfflineClaim,mobileOfflineClaimResolution,mobileOfflinePhoto} from '../../db/schema';
import {actorOf,appendEvent,appendEvents} from '../../db/events';
import {decryptSecret} from '../../lib/ai/crypto';
import {HR_LOCAL_TZ,todayInKualaLumpur} from '../../lib/hr-date';
import {OfflineClockSignedClaim,offlineClockClaimClientData,type OfflineClockClaimData} from '../../lib/mobile-offline-clock';
import {offlineClaimAAD,offlineClaimPhotoAAD} from '../../core/mobile-offline-claim';
import {withAttendanceTenant} from '../../core/module-gate';
import {attendanceClockCaptureEffectiveAt,captureOfflineClockTx,clockAttendanceDateTx,openClockSessionDateTx} from '../../core/attendance-clock';
import {ClockDataChangedError,clockFingerprint,lockAttendancePayrollTx,markAttendancePayrollTx,punchesForCorrectionTx} from '../../core/attendance-punch-change';
import {clockingEmploymentSpan,employedOnDate} from '../../core/attendance-clocking-import';
import {readOvertimeSettlementForDayTx} from './overtime-patterns';
import {offlineEffectiveInstant} from './mobile-offline-adjudicator';
type ClaimRow=typeof mobileOfflineClaim.$inferSelect;
type ResolutionRow=typeof mobileOfflineClaimResolution.$inferSelect;
export type OfflineClaimReviewRefusal='invalid_input'|'not_found'|'forbidden'|'self_resolution'|'no_photo'|'photo_unavailable'|'not_resolvable'|'resolution_conflict'
 |'effective_time_invalid'|'employment_inactive'|'overtime_settled'|'not_acceptable'|'unavailable';
/** Typed refusal; `detail` carries the canonical writer's refusal reason for not_acceptable. Closed payroll is the
 * existing AttendancePayrollClosedError ("Reopen the payroll"), a changed day the existing ClockDataChangedError. */
export class OfflineClaimReviewError extends Error{
 constructor(readonly reason:OfflineClaimReviewRefusal,readonly detail:string|null=null){super('Offline claim review unavailable');this.name='OfflineClaimReviewError';}
}
const refuse=(reason:OfflineClaimReviewRefusal,detail:string|null=null)=>new OfflineClaimReviewError(reason,detail);
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const ms=(value:unknown)=>{const date=value instanceof Date?value:new Date(String(value)),time=date.getTime();if(!Number.isFinite(time))throw refuse('unavailable');return time;};
/** Correction authority, group-admin status and self-subject, read in the caller's transaction under its session. */
async function authorityTx(tx:Tx,employmentId:string){
 const [row]=await tx.execute<{correct:boolean;group:boolean;self:boolean}>(sql`select app.can_correct_attendance(${employmentId}::uuid) "correct",app.is_group_admin() "group",
  exists(select 1 from employment e where e.id=${employmentId}::uuid and app.is_self_person(e.person_id)) "self"`);
 return {correct:row?.correct===true,group:row?.group===true,self:row?.self===true};
}
async function claimTx(tx:Tx,ctx:SessionContext,claimId:string){
 const [claim]=await tx.select().from(mobileOfflineClaim).where(and(eq(mobileOfflineClaim.id,claimId),eq(mobileOfflineClaim.tenantId,ctx.tenantId))).limit(1);
 if(!claim)throw refuse('not_found');return claim;
}
/** The signed claim behind a stored row, checked against every column it must equal. Never returned whole. */
function signedClaimOf(row:ClaimRow):OfflineClockClaimData{
 let claim:OfflineClockClaimData;
 try{claim=OfflineClockSignedClaim.parse(JSON.parse(decryptSecret(row.claimCiphertext,offlineClaimAAD(row)))).claim;}catch{throw refuse('unavailable');}
 if(hash(offlineClockClaimClientData(claim))!==row.claimDigest||claim.scope.tenantId!==row.tenantId||claim.scope.actorId!==row.actorId||claim.scope.employmentId!==row.employmentId
  ||claim.context.id!==row.contextId||claim.command.requestId!==row.requestId||claim.chain.sequence!==row.sequence)throw refuse('unavailable');
 return claim;
}
/** An unexpired retained photo the session may read (RLS: the actor, or correction authority that is not a group admin),
 * decrypted, verified against the claim's digest and audited. Expired or purged custody is null. */
async function retainedPhotoTx(tx:Tx,ctx:SessionContext,claim:ClaimRow,purpose:'review'|'resolution'){
 if(!claim.photoDigest)return null;
 const [row]=await tx.select({photo:mobileOfflinePhoto,live:sql<boolean>`${mobileOfflinePhoto.retainedUntil}>clock_timestamp()`}).from(mobileOfflinePhoto)
  .where(and(eq(mobileOfflinePhoto.claimId,claim.id),eq(mobileOfflinePhoto.tenantId,ctx.tenantId))).limit(1);
 if(!row||row.live!==true)return null;
 const p=row.photo;let bytes:Buffer;
 try{bytes=Buffer.from(decryptSecret(p.photoCiphertext,offlineClaimPhotoAAD(p)),'base64');}catch{throw refuse('unavailable');}
 if(p.photoDigest!==claim.photoDigest||hash(bytes)!==p.photoDigest||bytes.length!==p.byteLength)throw refuse('unavailable');
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'mobile-offline-claim',aggregateId:claim.id,eventType:'mobile.offline.photo.reviewed',actor:actorOf(ctx),subjectEmploymentId:claim.employmentId,
  payload:{reason:purpose,digest:p.photoDigest,retainedUntil:p.retainedUntil.toISOString()}});
 return {bytes,mimeType:p.mimeType,sha256:p.photoDigest,retainedUntil:p.retainedUntil.getTime()};
}

const ListFilters=z.object({companyId:uuid.optional(),employmentId:uuid.optional(),outcome:z.enum(['accepted','needs_review','refused']).optional(),unresolved:z.boolean().optional(),
 limit:z.number().int().min(1).max(100).default(50),before:uuid.optional()}).strict();
export type OfflineClaimReviewFilters=z.input<typeof ListFilters>;
const resolutionView=(r:ResolutionRow)=>({claimId:r.claimId,decision:r.decision,effectiveAt:r.effectiveAt?.getTime()??null,captureId:r.captureId,dayRevision:r.dayRevision,reason:r.reason,resolvedBy:r.resolvedBy,resolvedAt:r.resolvedAt.getTime()});
export type OfflineClaimResolutionView=ReturnType<typeof resolutionView>;
/** Claims the session may correct, newest received first (received_at desc, id desc); `before` is the last claim id of
 * the previous page. Metadata, outcome, reason, the signed command's action/location/source flags and any resolution;
 * never photo bytes or the signed proof. Each returned claim appends one audit event. */
export async function listOfflineClaimsForReviewTx(tx:Tx,ctx:SessionContext,filters:OfflineClaimReviewFilters={}){
 const parsed=ListFilters.safeParse(filters);if(!parsed.success)throw refuse('invalid_input');const f=parsed.data;
 if(!ctx.userId)throw refuse('forbidden');
 if(f.employmentId&&!(await authorityTx(tx,f.employmentId)).correct)throw refuse('forbidden');
 const c=mobileOfflineClaim,r=mobileOfflineClaimResolution;
 const rows=await tx.select({claim:c,companyId:employment.companyId,resolution:r,photoLive:sql<boolean>`coalesce(${c.photoRetainedUntil}>clock_timestamp(),false)`}).from(c)
  .innerJoin(employment,eq(employment.id,c.employmentId)).leftJoin(r,eq(r.claimId,c.id))
  .where(and(eq(c.tenantId,ctx.tenantId),sql`app.can_correct_attendance(${c.employmentId})`,f.employmentId?eq(c.employmentId,f.employmentId):undefined,
   f.companyId?eq(employment.companyId,f.companyId):undefined,f.outcome?eq(c.outcome,f.outcome):undefined,f.unresolved?isNull(r.claimId):undefined,
   f.before?sql`(${c.receivedAt},${c.id})<(select b.received_at,b.id from mobile_offline_claim b where b.id=${f.before}::uuid and b.tenant_id=${ctx.tenantId}::uuid)`:undefined))
  .orderBy(desc(c.receivedAt),desc(c.id)).limit(f.limit);
 const claims=rows.map(({claim,companyId,resolution,photoLive})=>{const signed=signedClaimOf(claim);return {id:claim.id,employmentId:claim.employmentId,companyId,actorId:claim.actorId,
  contextId:claim.contextId,sequence:claim.sequence,requestId:claim.requestId,outcome:claim.outcome,reason:claim.reason,claimedAt:claim.claimedAt.getTime(),sampledAt:claim.sampledAt.getTime(),
  receivedAt:claim.receivedAt.getTime(),effectiveMinimum:claim.effectiveMinimum?.getTime()??null,effectiveMaximum:claim.effectiveMaximum?.getTime()??null,effectiveAt:claim.effectiveAt?.getTime()??null,
  captureId:claim.captureId,command:{action:signed.command.action,lat:signed.command.lat,lng:signed.command.lng,accuracy:signed.command.accuracy},
  evidence:{mock:signed.evidence.mock,simulated:signed.evidence.simulated,accessory:signed.evidence.accessory},
  photo:claim.photoDigest&&claim.photoRetainedUntil?{sha256:claim.photoDigest,retainedUntil:claim.photoRetainedUntil.getTime(),retained:photoLive===true}:null,
  resolution:resolution?resolutionView(resolution):null};});
 await appendEvents(tx,claims.map(claim=>({tenantId:ctx.tenantId,aggregateType:'mobile-offline-claim',aggregateId:claim.id,eventType:'mobile.offline.claim.reviewed',actor:actorOf(ctx),subjectEmploymentId:claim.employmentId,payload:{reason:'review'}})));
 return {claims,next:claims.length===f.limit?claims[claims.length-1].id:null};
}
export function listOfflineClaimsForReview(ctx:SessionContext,filters:OfflineClaimReviewFilters={}){return withAttendanceTenant(ctx,tx=>listOfflineClaimsForReviewTx(tx,ctx,filters));}

/** The retained original photo of one claim, for a correction-authority holder that is not a group admin. Each read is
 * audited (actor, claim, reason "review"). No photo, an expired one or purged custody is a typed refusal. */
export async function readOfflineClaimPhotoForReview(ctx:SessionContext,claimId:string){
 const id=uuid.safeParse(claimId);if(!id.success)throw refuse('invalid_input');if(!ctx.userId)throw refuse('forbidden');
 return withAttendanceTenant(ctx,async tx=>{
  const claim=await claimTx(tx,ctx,id.data),who=await authorityTx(tx,claim.employmentId);
  if(!who.correct||who.group)throw refuse('forbidden');
  if(!claim.photoDigest)throw refuse('no_photo');
  const photo=await retainedPhotoTx(tx,ctx,claim,'review');if(!photo)throw refuse('photo_unavailable');
  return photo;
 });
}

const ResolveInput=z.object({claimId:uuid,decision:z.enum(['accepted','rejected']),effectiveAt:z.number().int().positive().max(8640000000000000).optional(),
 reason:z.string().trim().min(1).max(500),expectedRevision:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict()
 .refine(v=>(v.decision==='accepted')===(v.effectiveAt!==undefined)).refine(v=>v.decision==='accepted'||v.expectedRevision===undefined);
export type OfflineClaimResolutionInput=z.input<typeof ResolveInput>;
/** The acceptable instant rule, the adjudicator's own (offlineEffectiveInstant) applied to the resolver's instant: a
 * whole second inside the proven interval cut at the context's expiry, the claimed-time window and the interval's
 * start no earlier than issuance. No width limit: choosing inside a wide interval is the human decision under review. */
async function acceptableInstantTx(tx:Tx,claimId:string,effectiveAt:number){
 const [window]=await tx.execute<{issued_at:unknown;expires_at:unknown;minimum:unknown;maximum:unknown}>(sql`select issued_at,expires_at,minimum,maximum from app.mobile_offline_claim_window(${claimId}::uuid)`);
 if(!window)return false;
 const issuedAt=ms(window.issued_at),expiresAt=ms(window.expires_at),minimum=ms(window.minimum),maximum=ms(window.maximum);
 const decided=offlineEffectiveInstant({claimedAt:effectiveAt,issuedAt,expiresAt,bounds:{status:'reported_interval',minimum,maximum:Math.min(maximum,expiresAt)},maxProvenWindowSeconds:Number.POSITIVE_INFINITY});
 return decided.kind==='instant'&&decided.effectiveAt===effectiveAt;
}
/** The attendance day an accept at `effectiveAt` files (the canonical writer's own rule) and its correction-model
 * baseline (clockFingerprint), which a resolver passes back as expectedRevision. Read-only. */
export async function readOfflineClaimResolutionBaselineTx(tx:Tx,ctx:SessionContext,p:{claimId:string;effectiveAt:number}){
 const id=uuid.safeParse(p.claimId);if(!id.success||!Number.isSafeInteger(p.effectiveAt))throw refuse('invalid_input');
 const claim=await claimTx(tx,ctx,id.data);if(!(await authorityTx(tx,claim.employmentId)).correct)throw refuse('forbidden');
 const action=signedClaimOf(claim).command.action,date=await clockAttendanceDateTx(tx,claim.employmentId,action,new Date(p.effectiveAt),await openClockSessionDateTx(tx,claim.employmentId));
 return {date,revision:clockFingerprint(await punchesForCorrectionTx(tx,claim.employmentId,date))};
}
/** Accept: every check before the first write; the canonical writer is the only attendance writer. */
async function acceptTx(tx:Tx,ctx:SessionContext,claim:ClaimRow,who:{group:boolean},effectiveAt:number,expectedRevision:string|undefined){
 if(!(await acceptableInstantTx(tx,claim.id,effectiveAt)))throw refuse('effective_time_invalid');
 const command=signedClaimOf(claim).command,effective=new Date(effectiveAt);
 // A photo still retained is the evidence under review: the resolver must be able to read it (a group admin cannot),
 // and the canonical writer then applies the employee's photo setting to it exactly as online. Expired custody is gone.
 const [held]=await tx.execute<{live:boolean}>(sql`select coalesce(${claim.photoRetainedUntil?.toISOString()??null}::timestamptz>clock_timestamp(),false) live`);
 const photo=held?.live===true?(who.group?null:await retainedPhotoTx(tx,ctx,claim,'resolution')):null;
 if(held?.live===true&&!photo)throw refuse('photo_unavailable');
 const date=await clockAttendanceDateTx(tx,claim.employmentId,command.action,effective,await openClockSessionDateTx(tx,claim.employmentId));
 const [span]=await tx.select(clockingEmploymentSpan).from(employment).where(eq(employment.id,claim.employmentId)).limit(1);
 const employed=span&&{start:String(span.start),end:span.end==null?null:String(span.end)};
 if(!employed||![todayInKualaLumpur(effective),date].every(day=>employedOnDate(employed,day)))throw refuse('employment_inactive');
 // Payroll before the plan's attendance work, as corrections order it: the day row, its overtime source, then the
 // batches. Closed payroll throws AttendancePayrollClosedError here, before any write; processed is marked below.
 const batches=await lockAttendancePayrollTx(tx,claim.employmentId,date);
 if((await readOvertimeSettlementForDayTx(tx,ctx,{employmentId:claim.employmentId,date}))?.settlement)throw refuse('overtime_settled');
 // The correction model's baseline, read with the day row locked: what the resolver decided against.
 const dayRevision=clockFingerprint(await punchesForCorrectionTx(tx,claim.employmentId,date));
 if(expectedRevision!==undefined&&expectedRevision!==dayRevision)throw new ClockDataChangedError();
 const written=await captureOfflineClockTx(tx,ctx,{employmentId:claim.employmentId,requestId:claim.requestId,action:command.action,lat:command.lat,lng:command.lng,accuracy:command.accuracy,
  ...(photo?{photo:{bytes:photo.bytes,mimeType:photo.mimeType}}:{}),effectiveAt:effective,claimDigest:claim.claimDigest},{kind:'resolution',actorId:claim.actorId});
 if(written.kind==='refused')throw refuse('not_acceptable',written.reason);
 // As the claim service checks an accepted claim: one live mobile_offline punch on that capture, at exactly the instant.
 const [punch]=await tx.select({date:attendancePunch.attendanceDate,method:attendancePunch.method,
  exact:sql<boolean>`${attendancePunch.punchAt}=(${effective.toISOString()}::timestamptz at time zone ${HR_LOCAL_TZ}::text)::time`,
  effective:sql<boolean>`coalesce(${attendanceClockCaptureEffectiveAt}=${effective.toISOString()}::timestamptz,false)`}).from(attendancePunch).innerJoin(attendanceClockCapture,eq(attendanceClockCapture.id,attendancePunch.clockCaptureId)).where(and(
  eq(attendanceClockCapture.id,written.captureId),eq(attendanceClockCapture.tenantId,ctx.tenantId),eq(attendanceClockCapture.employmentId,claim.employmentId),eq(attendanceClockCapture.requestId,claim.requestId),
  eq(attendancePunch.tenantId,ctx.tenantId),eq(attendancePunch.employmentId,claim.employmentId),eq(attendancePunch.direction,command.action),isNull(attendancePunch.voidedAt))).limit(1);
 if(written.effectiveAt!==effectiveAt||written.date!==date||!punch||punch.date!==date||punch.exact!==true||punch.effective!==true||punch.method!=='mobile_offline')throw refuse('unavailable');
 await markAttendancePayrollTx(tx,ctx,batches,claim.employmentId);
 return {captureId:written.captureId,effectiveAt:effective,date,dayRevision,photoUsed:photo!==null};
}
/** Resolves one needs_review claim. A retry with the same decision, instant and reason by the same resolver returns the
 * recorded resolution (replayed); any other input once a resolution exists is resolution_conflict. Reject records the
 * resolution only. Every resolution appends an audit event with the actor and reason. */
export async function resolveOfflineClaimTx(tx:Tx,ctx:SessionContext,input:OfflineClaimResolutionInput){
 const parsed=ResolveInput.safeParse(input);if(!parsed.success)throw refuse('invalid_input');const p=parsed.data;
 if(!ctx.userId)throw refuse('forbidden');
 const claim=await claimTx(tx,ctx,p.claimId),who=await authorityTx(tx,claim.employmentId);
 if(!who.correct)throw refuse('forbidden');if(who.self)throw refuse('self_resolution');
 await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+claim.employmentId},0))`);
 const inputDigest=hash(JSON.stringify(['mobile-offline-claim-resolution',1,claim.id,p.decision,p.effectiveAt??null,p.reason]));
 const [prior]=await tx.select().from(mobileOfflineClaimResolution).where(and(eq(mobileOfflineClaimResolution.claimId,claim.id),eq(mobileOfflineClaimResolution.tenantId,ctx.tenantId))).limit(1);
 if(prior){if(prior.inputDigest===inputDigest&&prior.resolvedBy===ctx.userId)return {...resolutionView(prior),replayed:true};throw refuse('resolution_conflict');}
 if(claim.outcome!=='needs_review')throw refuse('not_resolvable');
 const accepted=p.decision==='accepted'?await acceptTx(tx,ctx,claim,who,p.effectiveAt!,p.expectedRevision):null;
 const [stored]=await tx.insert(mobileOfflineClaimResolution).values({claimId:claim.id,tenantId:ctx.tenantId,actorId:claim.actorId,employmentId:claim.employmentId,decision:p.decision,
  effectiveAt:accepted?.effectiveAt??null,captureId:accepted?.captureId??null,dayRevision:accepted?.dayRevision??null,reason:p.reason,inputDigest,resolvedBy:ctx.userId}).returning();
 if(!stored)throw refuse('unavailable');
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'mobile-offline-claim',aggregateId:claim.id,eventType:'mobile.offline.claim.resolved',actor:actorOf(ctx),subjectEmploymentId:claim.employmentId,
  payload:{decision:p.decision,reason:p.reason,heldFor:claim.reason,effectiveAt:accepted?.effectiveAt.toISOString()??null,captureId:accepted?.captureId??null,date:accepted?.date??null,dayRevision:accepted?.dayRevision??null,photoUsed:accepted?.photoUsed??false}});
 return {...resolutionView(stored),replayed:false};
}
export function resolveOfflineClaim(ctx:SessionContext,input:OfflineClaimResolutionInput){return withAttendanceTenant(ctx,tx=>resolveOfflineClaimTx(tx,ctx,input));}

/** The employee's own receipt view of a claim and its human resolution, if any. Read-only; the resolver's identity,
 * reason and day baseline are not part of it. Not a v1 receipt field: installed clients never see a new meaning. */
export async function ownOfflineClaimResolution(ctx:SessionContext,claimId:string){
 const id=uuid.safeParse(claimId);if(!id.success||!ctx.userId)return null;
 return withAttendanceTenant(ctx,async tx=>{
  const [row]=await tx.select({claim:mobileOfflineClaim,resolution:mobileOfflineClaimResolution}).from(mobileOfflineClaim).leftJoin(mobileOfflineClaimResolution,eq(mobileOfflineClaimResolution.claimId,mobileOfflineClaim.id))
   .where(and(eq(mobileOfflineClaim.id,id.data),eq(mobileOfflineClaim.tenantId,ctx.tenantId),eq(mobileOfflineClaim.actorId,ctx.userId!))).limit(1);
  if(!row)return null;
  const r=row.resolution;
  return {claimId:row.claim.id,outcome:row.claim.outcome,reason:row.claim.reason,resolution:r?{decision:r.decision,effectiveAt:r.effectiveAt?.getTime()??null,captureId:r.captureId,resolvedAt:r.resolvedAt.getTime()}:null};
 });
}
