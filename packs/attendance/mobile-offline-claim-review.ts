/** HR review and human resolution of offline claims (owner decisions 2026-10-28; protocol decision 6), on draft 0647.
 * Read: a holder of attendance-correction authority over the claim's employment (app.can_correct_attendance) lists that
 * employment's claims and, unless a group admin, reads an UNEXPIRED retained photo; every photo read appends an audit
 * event (owner decision: photo reads are audited). Listing claims writes nothing: a list load is a read of metadata the
 * session may already see under RLS, and auditing every row of every page load recorded no decision. Resolve: one immutable human decision per needs_review claim, with a reason. An accept
 * is an HR punch correction: the existing correction owner (requestAttendanceCorrection then decideAttendanceCorrection,
 * core/attendance.ts) files a clock-data correction adding one 'admin' punch at the instant the resolver chooses inside
 * the claim's proven interval, and the resolver decides its first level, in this transaction. Its rules apply, not the
 * live clock rules: later punches never block it, HR's reasoned decision overrides the hold (geofence, photo, device),
 * payroll locks and correction/decision authority still refuse, and the day recalculates when the punch lands. Owner
 * decision D-A: a workflow with further levels leaves the correction pending, and the punch is written only by its final
 * approval, as for any correction; the resolution is recorded either way. Its state (pending, accepted, rejected,
 * cancelled) and its punch are derived from the correction (app.mobile_offline_claim_resolution_state), never stored.
 * Owner decision D-B: while the claim's photo is retained only a session that may read it (correction authority that
 * is not a group admin) accepts; a group admin may reject, and may accept once the photo has expired or been purged or
 * when there is none. The resolution row links the claim to that correction. The claim row is never changed.
 * Permission is checked here as well as by RLS and the bound trigger. Mounted by the HR review tab of Attendance ›
 * Application History (app/(app)/attendance/application-history) and its photo route; not exported through the facade,
 * because core/mobile-offline-claim (its AAD owner) is server-only.
 *
 * Lock order of a resolution: the subject advisory lock (tenant:employment), then the correction owner's own order
 * (payroll batches by id on filing; on approval the same subject lock again, re-entrant, the correction row, its
 * workflow, payroll, then the attendance day row). It is the tail of the claim consumption order (actor admission, key,
 * stream, subject, payroll, attendance) with its first three locks omitted: a resolution never requests an actor, key or
 * stream lock, so it cannot wait on one while holding the subject lock, and below the subject lock both serialize on
 * that one lock per employment. */
import {createHash} from 'node:crypto';
import {and,desc,eq,inArray,isNull,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {employment,mobileOfflineClaim,mobileOfflineClaimResolution,mobileOfflinePhoto,person} from '../../db/schema';
import {actorOf,appendEvent} from '../../db/events';
import {decryptSecret} from '../../lib/ai/crypto';
import {HR_LOCAL_TZ,todayInKualaLumpur} from '../../lib/hr-date';
import {OfflineClockSignedClaim,offlineClockClaimClientData,type OfflineClockClaimData} from '../../lib/mobile-offline-clock';
import {offlineClaimAAD,offlineClaimPhotoAAD} from '../../core/mobile-offline-claim';
import {withAttendanceTenant} from '../../core/module-gate';
import {clockAttendanceDateTx,openClockSessionDateTx} from '../../core/attendance-clock';
import {decideAttendanceCorrection,requestAttendanceCorrection} from '../../core/attendance';
import {ClockDataChangedError,clockFingerprint,punchesForCorrectionTx} from '../../core/attendance-punch-change';
import {clockingEmploymentSpan,employedOnDate} from '../../core/attendance-clocking-import';
import {offlineEffectiveInstant} from './mobile-offline-adjudicator';
type ClaimRow=typeof mobileOfflineClaim.$inferSelect;
type ResolutionRow=typeof mobileOfflineClaimResolution.$inferSelect;
export type OfflineClaimReviewRefusal='invalid_input'|'not_found'|'forbidden'|'self_resolution'|'no_photo'|'photo_unavailable'|'not_resolvable'|'resolution_conflict'
 |'effective_time_invalid'|'employment_inactive'|'photo_review_required'|'unavailable';
/** Typed refusal. The correction owner's own refusals pass through unchanged: closed payroll is the existing
 * AttendancePayrollClosedError ("Reopen the payroll"), a changed day ClockDataChangedError, a pending request for the
 * day AttendanceCorrectionPendingError, a stage the resolver may not decide AttendanceWorkflowError.
 * photo_review_required: a group admin's accept while the claim's photo is still retained (owner decision D-B). */
export class OfflineClaimReviewError extends Error{
 constructor(readonly reason:OfflineClaimReviewRefusal){super('Offline claim review unavailable');this.name='OfflineClaimReviewError';}
}
const refuse=(reason:OfflineClaimReviewRefusal)=>new OfflineClaimReviewError(reason);
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
async function retainedPhotoTx(tx:Tx,ctx:SessionContext,claim:ClaimRow){
 if(!claim.photoDigest)return null;
 const [row]=await tx.select({photo:mobileOfflinePhoto,live:sql<boolean>`${mobileOfflinePhoto.retainedUntil}>clock_timestamp()`}).from(mobileOfflinePhoto)
  .where(and(eq(mobileOfflinePhoto.claimId,claim.id),eq(mobileOfflinePhoto.tenantId,ctx.tenantId))).limit(1);
 if(!row||row.live!==true)return null;
 const p=row.photo;let bytes:Buffer;
 try{bytes=Buffer.from(decryptSecret(p.photoCiphertext,offlineClaimPhotoAAD(p)),'base64');}catch{throw refuse('unavailable');}
 if(p.photoDigest!==claim.photoDigest||hash(bytes)!==p.photoDigest||bytes.length!==p.byteLength)throw refuse('unavailable');
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'mobile-offline-claim',aggregateId:claim.id,eventType:'mobile.offline.photo.reviewed',actor:actorOf(ctx),subjectEmploymentId:claim.employmentId,
  payload:{reason:'review',digest:p.photoDigest,retainedUntil:p.retainedUntil.toISOString()}});
 return {bytes,mimeType:p.mimeType,sha256:p.photoDigest,retainedUntil:p.retainedUntil.getTime()};
}

const ListFilters=z.object({companyId:uuid.optional(),companyIds:z.array(uuid).max(1000).optional(),employmentId:uuid.optional(),outcome:z.enum(['accepted','needs_review','refused']).optional(),unresolved:z.boolean().optional(),
 limit:z.number().int().min(1).max(100).default(50),before:uuid.optional()}).strict();
export type OfflineClaimReviewFilters=z.input<typeof ListFilters>;
/** A resolution's state: a reject is 'rejected'; an accept is its correction's status ('approved' read as 'accepted'). */
export type OfflineClaimResolutionStatus='pending'|'accepted'|'rejected'|'cancelled';
type ResolutionState={status:OfflineClaimResolutionStatus;punchId:string|null};
/** The derived state of the visible resolutions of `claimIds` (app.mobile_offline_claim_resolution_state, owner decision
 * D-A): the linked correction's status, and the punch its applied changes added once approved. Never stored. */
async function resolutionStatesTx(tx:Tx,claimIds:string[]){
 const states=new Map<string,ResolutionState>();if(!claimIds.length)return states;
 const rows=await tx.execute<{claim_id:string;status:OfflineClaimResolutionStatus|null;punch_id:string|null}>(sql`select claim_id,status,punch_id
  from app.mobile_offline_claim_resolution_state(array[${sql.join(claimIds.map(id=>sql`${id}::uuid`),sql`,`)}]::uuid[])`);
 for(const row of rows){if(!row.status)throw refuse('unavailable');states.set(row.claim_id,{status:row.status,punchId:row.punch_id});}
 return states;
}
const resolutionView=(r:ResolutionRow,state:ResolutionState|undefined)=>{if(!state)throw refuse('unavailable');
 return {claimId:r.claimId,decision:r.decision,status:state.status,effectiveAt:r.effectiveAt?.getTime()??null,correctionId:r.correctionId,punchId:state.punchId,dayRevision:r.dayRevision,
  reason:r.reason,resolvedBy:r.resolvedBy,resolvedAt:r.resolvedAt.getTime()};};
export type OfflineClaimResolutionView=ReturnType<typeof resolutionView>;
/** Claims the session may correct, newest received first (received_at desc, id desc); `before` is the last claim id of
 * the previous page. Metadata, the employee's name, outcome, reason, the signed command's action/location/source flags
 * and any resolution; never photo bytes or the signed proof. Read-only: no audit event (only a photo read is audited). */
export async function listOfflineClaimsForReviewTx(tx:Tx,ctx:SessionContext,filters:OfflineClaimReviewFilters={}){
 const parsed=ListFilters.safeParse(filters);if(!parsed.success)throw refuse('invalid_input');const f=parsed.data;
 if(!ctx.userId)throw refuse('forbidden');
 if(f.employmentId&&!(await authorityTx(tx,f.employmentId)).correct)throw refuse('forbidden');
 const c=mobileOfflineClaim,r=mobileOfflineClaimResolution;
 const rows=await tx.select({claim:c,companyId:employment.companyId,employeeName:person.fullName,resolution:r,photoLive:sql<boolean>`coalesce(${c.photoRetainedUntil}>clock_timestamp(),false)`}).from(c)
  .innerJoin(employment,eq(employment.id,c.employmentId)).leftJoin(person,eq(person.id,employment.personId)).leftJoin(r,eq(r.claimId,c.id))
  .where(and(eq(c.tenantId,ctx.tenantId),sql`app.can_correct_attendance(${c.employmentId})`,f.employmentId?eq(c.employmentId,f.employmentId):undefined,
   f.companyId?eq(employment.companyId,f.companyId):undefined,f.companyIds?(f.companyIds.length?inArray(employment.companyId,f.companyIds):sql`false`):undefined,f.outcome?eq(c.outcome,f.outcome):undefined,f.unresolved?isNull(r.claimId):undefined,
   f.before?sql`(${c.receivedAt},${c.id})<(select b.received_at,b.id from mobile_offline_claim b where b.id=${f.before}::uuid and b.tenant_id=${ctx.tenantId}::uuid)`:undefined))
  .orderBy(desc(c.receivedAt),desc(c.id)).limit(f.limit);
 const states=await resolutionStatesTx(tx,rows.flatMap(row=>row.resolution?[row.resolution.claimId]:[]));
 const claims=rows.map(({claim,companyId,employeeName,resolution,photoLive})=>{const signed=signedClaimOf(claim);return {id:claim.id,employmentId:claim.employmentId,companyId,employeeName:employeeName??null,actorId:claim.actorId,
  contextId:claim.contextId,sequence:claim.sequence,requestId:claim.requestId,outcome:claim.outcome,reason:claim.reason,claimedAt:claim.claimedAt.getTime(),sampledAt:claim.sampledAt.getTime(),
  receivedAt:claim.receivedAt.getTime(),effectiveMinimum:claim.effectiveMinimum?.getTime()??null,effectiveMaximum:claim.effectiveMaximum?.getTime()??null,effectiveAt:claim.effectiveAt?.getTime()??null,
  captureId:claim.captureId,command:{action:signed.command.action,lat:signed.command.lat,lng:signed.command.lng,accuracy:signed.command.accuracy},
  evidence:{mock:signed.evidence.mock,simulated:signed.evidence.simulated,accessory:signed.evidence.accessory},
  photo:claim.photoDigest&&claim.photoRetainedUntil?{sha256:claim.photoDigest,retainedUntil:claim.photoRetainedUntil.getTime(),retained:photoLive===true}:null,
  resolution:resolution?resolutionView(resolution,states.get(resolution.claimId)):null};});
 return {claims,next:claims.length===f.limit?claims[claims.length-1].id:null};
}
export function listOfflineClaimsForReview(ctx:SessionContext,filters:OfflineClaimReviewFilters={}){return withAttendanceTenant(ctx,tx=>listOfflineClaimsForReviewTx(tx,ctx,filters));}
export type OfflineClaimReviewRow=Awaited<ReturnType<typeof listOfflineClaimsForReviewTx>>['claims'][number];
/** The HR review tab's one read: held claims of `companyIds` (unresolved only unless `all`), newest first, and whether
 * this session is a group admin (owner decision D-B: no retained photo and no accept while the photo is kept). */
export function readOfflineClaimReviewPage(ctx:SessionContext,p:{companyIds:readonly string[];all:boolean;before?:string}){
 return withAttendanceTenant(ctx,async tx=>{
  const [row]=await tx.execute<{group:boolean}>(sql`select app.is_group_admin() "group"`);
  const page=await listOfflineClaimsForReviewTx(tx,ctx,{companyIds:[...p.companyIds],outcome:'needs_review',...(p.all?{}:{unresolved:true}),...(p.before?{before:p.before}:{})});
  return {groupAdmin:row?.group===true,...page};
 });
}

/** The retained original photo of one claim, for a correction-authority holder that is not a group admin. Each read is
 * audited (actor, claim, reason "review"). No photo, an expired one or purged custody is a typed refusal. */
export async function readOfflineClaimPhotoForReview(ctx:SessionContext,claimId:string){
 const id=uuid.safeParse(claimId);if(!id.success)throw refuse('invalid_input');if(!ctx.userId)throw refuse('forbidden');
 return withAttendanceTenant(ctx,async tx=>{
  const claim=await claimTx(tx,ctx,id.data),who=await authorityTx(tx,claim.employmentId);
  if(!who.correct||who.group)throw refuse('forbidden');
  if(!claim.photoDigest)throw refuse('no_photo');
  const photo=await retainedPhotoTx(tx,ctx,claim);if(!photo)throw refuse('photo_unavailable');
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
/** The attendance day an accept at `effectiveAt` files (the canonical clock day rule) and its correction baseline
 * (clockFingerprint), which a resolver passes back as expectedRevision. Read-only. */
export async function readOfflineClaimResolutionBaselineTx(tx:Tx,ctx:SessionContext,p:{claimId:string;effectiveAt:number}){
 const id=uuid.safeParse(p.claimId);if(!id.success||!Number.isSafeInteger(p.effectiveAt))throw refuse('invalid_input');
 const claim=await claimTx(tx,ctx,id.data);if(!(await authorityTx(tx,claim.employmentId)).correct)throw refuse('forbidden');
 const action=signedClaimOf(claim).command.action,date=await clockAttendanceDateTx(tx,claim.employmentId,action,new Date(p.effectiveAt),await openClockSessionDateTx(tx,claim.employmentId));
 return {date,revision:clockFingerprint(await punchesForCorrectionTx(tx,claim.employmentId,date))};
}
/** The MYT wall time of an instant, as punch_at and the correction entries hold it (HH:MM:SS). */
const wallTime=(at:Date)=>new Intl.DateTimeFormat('en-GB',{timeZone:HR_LOCAL_TZ,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(at);
/** Accept: reads and checks first, then the correction owner is the only attendance writer. Its punch set is the day's
 * live punches unchanged plus one entry at the accepted instant, against the baseline read under the subject lock.
 * The resolver decides the first level; a final level writes the punch now, a further level leaves it to the
 * correction's final approver (owner decision D-A). */
async function acceptTx(tx:Tx,ctx:SessionContext,claim:ClaimRow,effectiveAt:number,reason:string,expectedRevision:string|undefined){
 if(!(await acceptableInstantTx(tx,claim.id,effectiveAt)))throw refuse('effective_time_invalid');
 const action=signedClaimOf(claim).command.action,effective=new Date(effectiveAt),punchAt=wallTime(effective);
 const date=await clockAttendanceDateTx(tx,claim.employmentId,action,effective,await openClockSessionDateTx(tx,claim.employmentId));
 const [span]=await tx.select(clockingEmploymentSpan).from(employment).where(eq(employment.id,claim.employmentId)).limit(1);
 const employed=span&&{start:String(span.start),end:span.end==null?null:String(span.end)};
 if(!employed||![todayInKualaLumpur(effective),date].every(day=>employedOnDate(employed,day)))throw refuse('employment_inactive');
 // The correction model's baseline: what the resolver decided against. The owner re-checks it under its own locks.
 const rows=await punchesForCorrectionTx(tx,claim.employmentId,date),dayRevision=clockFingerprint(rows);
 if(expectedRevision!==undefined&&expectedRevision!==dayRevision)throw new ClockDataChangedError();
 const entries=[...rows.filter(row=>!row.voidedAt).map(row=>({id:row.id,punchAt:row.punchAt,direction:row.direction})),{punchAt,direction:action}];
 try{
  // Filing locks payroll first (closed payroll refuses before its insert); the final approval applies the punch set,
  // recomputes the day, refreshes overtime and marks processed payroll, as for any HR punch correction. A further
  // level returns pending with nothing applied; that correction's own final decision applies it later.
  const {correctionId}=await requestAttendanceCorrection(ctx,{employmentId:claim.employmentId,date,reason,clockChanges:{version:1,baseline:dayRevision,entries}},tx);
  const decided=await decideAttendanceCorrection(ctx,{correctionId,decision:'approved',expectedStageIndex:0},tx);
  if(decided.status!=='approved'&&decided.status!=='pending')throw refuse('unavailable');
  return {correctionId,effectiveAt:effective,date,dayRevision};
 }catch(error){
  // After the first write a throw must never leave a committable partial correction for a caller that catches it.
  await tx.execute(sql`select cast('offline claim resolution failed; transaction aborted' as integer)`).catch(()=>undefined);
  throw error;
 }
}
/** Whether the claim's photo is still retained (owner decision D-B). Custody is purged only after expiry (the photo's
 * delete policy and trigger), so the claim's retention instant decides it for a group admin, which cannot read the
 * custody row; the bound trigger checks the row itself. */
async function photoRetainedTx(tx:Tx,claim:ClaimRow){
 if(!claim.photoDigest||!claim.photoRetainedUntil)return false;
 const [row]=await tx.execute<{retained:boolean}>(sql`select ${claim.photoRetainedUntil.toISOString()}::timestamptz>clock_timestamp() "retained"`);
 return row?.retained===true;
}
/** Resolves one needs_review claim. A retry with the same decision, instant and reason by the same resolver returns the
 * recorded resolution (replayed) with its current derived state; any other input once a resolution exists, pending
 * or final, is resolution_conflict. Reject records the resolution only; accept also files the HR punch correction
 * (acceptTx). A group admin may not accept while the photo is retained. Every resolution appends an audit event with
 * the actor, reason and the state at that moment. */
export async function resolveOfflineClaimTx(tx:Tx,ctx:SessionContext,input:OfflineClaimResolutionInput){
 const parsed=ResolveInput.safeParse(input);if(!parsed.success)throw refuse('invalid_input');const p=parsed.data;
 if(!ctx.userId)throw refuse('forbidden');
 const claim=await claimTx(tx,ctx,p.claimId),who=await authorityTx(tx,claim.employmentId);
 if(!who.correct)throw refuse('forbidden');if(who.self)throw refuse('self_resolution');
 await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+claim.employmentId},0))`);
 const inputDigest=hash(JSON.stringify(['mobile-offline-claim-resolution',1,claim.id,p.decision,p.effectiveAt??null,p.reason]));
 const [prior]=await tx.select().from(mobileOfflineClaimResolution).where(and(eq(mobileOfflineClaimResolution.claimId,claim.id),eq(mobileOfflineClaimResolution.tenantId,ctx.tenantId))).limit(1);
 if(prior){if(prior.inputDigest===inputDigest&&prior.resolvedBy===ctx.userId)return {...resolutionView(prior,(await resolutionStatesTx(tx,[prior.claimId])).get(prior.claimId)),replayed:true};
  throw refuse('resolution_conflict');}
 if(claim.outcome!=='needs_review')throw refuse('not_resolvable');
 if(p.decision==='accepted'&&who.group&&(await photoRetainedTx(tx,claim)))throw refuse('photo_review_required');
 const accepted=p.decision==='accepted'?await acceptTx(tx,ctx,claim,p.effectiveAt!,p.reason,p.expectedRevision):null;
 const [stored]=await tx.insert(mobileOfflineClaimResolution).values({claimId:claim.id,tenantId:ctx.tenantId,actorId:claim.actorId,employmentId:claim.employmentId,decision:p.decision,
  effectiveAt:accepted?.effectiveAt??null,correctionId:accepted?.correctionId??null,dayRevision:accepted?.dayRevision??null,reason:p.reason,inputDigest,resolvedBy:ctx.userId}).returning();
 if(!stored)throw refuse('unavailable');
 const view=resolutionView(stored,(await resolutionStatesTx(tx,[stored.claimId])).get(stored.claimId));
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'mobile-offline-claim',aggregateId:claim.id,eventType:'mobile.offline.claim.resolved',actor:actorOf(ctx),subjectEmploymentId:claim.employmentId,
  payload:{decision:p.decision,status:view.status,reason:p.reason,heldFor:claim.reason,effectiveAt:accepted?.effectiveAt.toISOString()??null,correctionId:accepted?.correctionId??null,punchId:view.punchId,
   date:accepted?.date??null,dayRevision:accepted?.dayRevision??null}});
 return {...view,replayed:false};
}
export function resolveOfflineClaim(ctx:SessionContext,input:OfflineClaimResolutionInput){return withAttendanceTenant(ctx,tx=>resolveOfflineClaimTx(tx,ctx,input));}

/** The employee's own receipt view of a claim and its human resolution, if any: pending, accepted, rejected or cancelled
 * (derived from the correction, owner decision D-A). Read-only; the resolver's identity, reason and day baseline are
 * not part of it (the accepted punch is the employee's own record, shown as an HR correction). Not a v1 receipt
 * field: installed clients never see a new meaning. */
export async function ownOfflineClaimResolution(ctx:SessionContext,claimId:string){
 const id=uuid.safeParse(claimId);if(!id.success||!ctx.userId)return null;
 return withAttendanceTenant(ctx,async tx=>{
  const [row]=await tx.select({claim:mobileOfflineClaim,resolution:mobileOfflineClaimResolution}).from(mobileOfflineClaim).leftJoin(mobileOfflineClaimResolution,eq(mobileOfflineClaimResolution.claimId,mobileOfflineClaim.id))
   .where(and(eq(mobileOfflineClaim.id,id.data),eq(mobileOfflineClaim.tenantId,ctx.tenantId),eq(mobileOfflineClaim.actorId,ctx.userId!))).limit(1);
  if(!row)return null;
  const r=row.resolution,state=r?(await resolutionStatesTx(tx,[r.claimId])).get(r.claimId):undefined;
  if(r&&!state)throw refuse('unavailable');
  return {claimId:row.claim.id,outcome:row.claim.outcome,reason:row.claim.reason,
   resolution:r&&state?{decision:r.decision,status:state.status,effectiveAt:r.effectiveAt?.getTime()??null,correctionId:r.correctionId,punchId:state.punchId,resolvedAt:r.resolvedAt.getTime()}:null};
 });
}
