/** Deterministic offline-claim policy owner (owner decisions 2026-10-28). Every check reads the current owner in the
 * claim service's transaction BEFORE any write; only an accepted decision calls the canonical offline writer. No model,
 * network, nested transaction or clock beyond the database time the owners already read. A model never decides here.
 * UNMOUNTED: no route or production wiring passes it to createOfflineClaimService, and no company enables offline. */
import {eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {employment} from '../../db/schema';
import type {OfflineClaimFacts,OfflineClaimPhoto,OfflineClaimPorts} from '../../core/mobile-offline-claim';
import {OfflineContextIssueError,type OfflineContextIssuePorts} from '../../core/mobile-offline-context';
import {captureOfflineClockTx,clockAttendanceDateTx,openClockSessionDateTx,planOfflineClockTx,type OfflineClockCommand,type OfflineClockRefusalReason} from '../../core/attendance-clock';
import {assertDayNotOwnedByCorrectionTx,CorrectedClockConflictError} from '../../core/attendance';
import {requireRegisteredDeviceTx} from '../../core/attendance-device';
import {clockingEmploymentSpan,employedOnDate} from '../../core/attendance-clocking-import';
import {readOvertimeSettlementForDayTx} from './overtime-patterns';
import {lockPayrollForOwnAttendanceRemoval} from '../payroll/service';
import {OfflineClockContextData} from '../../lib/mobile-offline-context';
import type {OfflineClockDecision,OfflineClockReviewReason} from '../../lib/mobile-offline-receipt';
import type {OfflineClockReportedBounds} from '../../lib/mobile-api/offline-clock-time';
import {todayInKualaLumpur} from '../../lib/hr-date';
type Reason=z.infer<typeof OfflineClockReviewReason>;
export class OfflineAdjudicationError extends Error{constructor(){super('Offline adjudication unavailable');this.name='OfflineAdjudicationError';}}
const unavailable=()=>new OfflineAdjudicationError();

/** Engine default and bounds of the per-company maximum proven-window width (draft 0647's CHECK). */
export const OFFLINE_PROVEN_WINDOW_SECONDS={default:900,minimum:60,maximum:86400} as const;
export type OfflineClockingPolicy={enabled:boolean;maxProvenWindowSeconds:number};
/** The company's offline clocking settings (draft 0647 columns on attendance_policy, one row per company). They are
 * read by name through to_jsonb because db/schema.ts does not declare unjournaled columns; no row, or a database
 * without 0647, is the engine default: OFF (ADR-0088) and 900 s. Read-only; RLS scopes the row to the tenant. */
export async function readOfflineClockingPolicyTx(tx:Tx,companyId:string):Promise<OfflineClockingPolicy>{
 const [row]=await tx.execute<{enabled:string|null;seconds:string|null}>(sql`select to_jsonb(p)->>'offline_clocking_enabled' enabled,to_jsonb(p)->>'offline_max_proven_window_seconds' seconds
  from attendance_policy p where p.company_id=${companyId}::uuid limit 1`);
 const enabled=row?.enabled??'false',stored=row?.seconds??null,seconds=stored===null?OFFLINE_PROVEN_WINDOW_SECONDS.default:Number(stored);
 if(!['true','false'].includes(enabled)||!Number.isInteger(seconds)||seconds<OFFLINE_PROVEN_WINDOW_SECONDS.minimum||seconds>OFFLINE_PROVEN_WINDOW_SECONDS.maximum)throw unavailable();
 return {enabled:enabled==='true',maxProvenWindowSeconds:seconds};
}

export type OfflineEffectiveInstant={kind:'instant';effectiveAt:number}|{kind:'needs_review'|'refused';reason:Reason};
/** Owner decision O1. The effective instant is the device's claimedAt rounded to a whole second, clamped into the
 * whole seconds of the server-proven interval [minimum, maximum]. A claimed time outside the context window
 * [issuedAt, expiresAt], or a proven interval wholly after it, is refused (ADR-0088). An interval that is missing,
 * inconsistent, runs past the window, holds no whole second or is wider than the company maximum goes to review. */
export function offlineEffectiveInstant(p:{claimedAt:number;issuedAt:number;expiresAt:number;bounds:OfflineClockReportedBounds;maxProvenWindowSeconds:number}):OfflineEffectiveInstant{
 if(!(p.claimedAt>=p.issuedAt&&p.claimedAt<=p.expiresAt))return {kind:'refused',reason:'outside_context_window'};
 const b=p.bounds;
 if(b.status!=='reported_interval')return {kind:'needs_review',reason:b.reason==='continuity_unknown'?'continuity_unknown':'time_unverifiable'};
 if(b.minimum>p.expiresAt)return {kind:'refused',reason:'outside_context_window'};
 if(!(b.minimum>=p.issuedAt&&b.maximum>=b.minimum))return {kind:'needs_review',reason:'time_unverifiable'};
 if(b.maximum>p.expiresAt)return {kind:'needs_review',reason:'outside_context_window'};
 if(b.maximum-b.minimum>p.maxProvenWindowSeconds*1000)return {kind:'needs_review',reason:'proven_window_too_wide'};
 const low=Math.ceil(b.minimum/1000)*1000,high=Math.floor(b.maximum/1000)*1000;
 if(low>high)return {kind:'needs_review',reason:'time_unverifiable'};
 return {kind:'instant',effectiveAt:Math.min(high,Math.max(low,Math.round(p.claimedAt/1000)*1000))};
}

/** Owner decision O3: a failed canonical plan check sends the claim to HR review, never to refusal. */
const PLAN_REVIEW:Record<OfflineClockRefusalReason,Reason>={invalid_command:'review_required',employment_unavailable:'employment_inactive',clock_conflict:'attendance_changed',
 corrected_day:'corrected_day',device_unavailable:'device_required',photo_required:'photo_required',photo_invalid:'photo_invalid',location_invalid:'location_required',
 geofence_quality:'poor_accuracy',outside_geofence:'outside_geofence',effective_time_invalid:'time_unverifiable'};
const Current=z.object({policy:OfflineClockContextData.shape.policy,sites:OfflineClockContextData.shape.sites});
type Context=OfflineClaimFacts['context'];
// The signed context's own canonical order (lib/mobile-offline-context.ts): policy fields positional, sites by id.
const policyKey=(p:Context['policy'])=>JSON.stringify([p.revision,p.offlineEnabled,p.windowMs,p.geofencingRequired,p.maximumAccuracyM,p.photoRequirement]);
const sitesKey=(sites:Context['sites'])=>JSON.stringify([...sites].sort((x,y)=>x.id<y.id?-1:x.id>y.id?1:0).map(s=>[s.id,s.name,s.lat,s.lng,s.radiusM]));
/** The exact guard of app.own_attendance_removal_payroll_protection (0539), checked first so that definer can never
 * RAISE inside the claim transaction: own active employment, live unblocked login, not terminated by today (MYT). */
async function ownPayrollGuardTx(tx:Tx,employmentId:string){
 const [row]=await tx.execute<{ok:boolean}>(sql`select exists(select 1 from employment e join app_user u on u.person_id=e.person_id and u.tenant_id=e.tenant_id
  where e.id=${employmentId}::uuid and e.tenant_id=app.current_tenant_id() and u.id=app.current_user_id() and u.archived_at is null and not app.login_blocked(u.id)
  and (e.terminated_on is null or e.terminated_on>(now() at time zone 'Asia/Kuala_Lumpur')::date)) ok`);
 return row?.ok===true;
}
const command=(facts:OfflineClaimFacts,photo:OfflineClaimPhoto|null,effectiveAt:Date):OfflineClockCommand=>{const c=facts.claim.command;
 return {employmentId:facts.claim.scope.employmentId,requestId:c.requestId,action:c.action,lat:c.lat,lng:c.lng,accuracy:c.accuracy,...(photo?{photo:{bytes:Buffer.from(photo.bytes),mimeType:photo.mimeType}}:{}),effectiveAt,claimDigest:facts.digest};};
export type OfflineAdjudication={outcome:'accept';effectiveAt:number}|{outcome:'needs_review'|'refused';reason:Reason};

/** `snapshot` is the same trusted current policy/site owner that context issuance signs (OfflineContextIssuePorts);
 * drift is measured against it, never against the phone. The production port is offlineClockSnapshotPort
 * (./mobile-offline-snapshot), the identical function issuance takes; nothing passes it yet. */
export function createOfflineAdjudicator(ports:{snapshot:OfflineContextIssuePorts['snapshot']}){
 if(typeof ports?.snapshot!=='function')throw unavailable();
 /** Decides from current owners, in this order, before any write. The first failing check names the outcome. */
 async function decide(tx:Tx,ctx:SessionContext,facts:OfflineClaimFacts,photo:OfflineClaimPhoto|null):Promise<OfflineAdjudication>{
  const {claim,context}=facts,employmentId=claim.scope.employmentId,review=(reason:Reason)=>({outcome:'needs_review',reason}) as const;
  // The service admits only scope_changed once the employment's company is no longer the context's company.
  if(facts.currentCompanyId!==context.scope.companyId)return review('scope_changed');
  const company=await readOfflineClockingPolicyTx(tx,facts.currentCompanyId);
  if(!company.enabled)return {outcome:'refused',reason:'offline_disabled'};
  const time=offlineEffectiveInstant({claimedAt:claim.time.claimedAt,issuedAt:context.issuedAt,expiresAt:context.expiresAt,bounds:facts.bounds,maxProvenWindowSeconds:company.maxProvenWindowSeconds});
  if(time.kind!=='instant')return {outcome:time.kind,reason:time.reason};
  const effective=new Date(time.effectiveAt),e=claim.evidence;
  // Reported source indicators. Only true is a report; null (unavailable) and false assure nothing either way.
  if(e.mock===true)return review('mock_reported');
  if(e.simulated===true)return review('simulated_reported');
  if(e.accessory===true)return review('accessory_reported');
  // A current world the signed context cannot represent (more than 32 sites, an over-long name, an unparsable value)
  // differs from what was signed: review, so a held claim never sticks. A rebound employment is a changed scope.
  // Only the snapshot owner's own typed refusals are mapped; any other failure still throws.
  let raw:unknown;
  try{raw=await ports.snapshot(tx,ctx,{employmentId,companyId:facts.currentCompanyId,key:facts.key});}
  catch(error){
   if(error instanceof OfflineContextIssueError&&error.reason==='configuration_unavailable')return review('site_changed');
   if(error instanceof OfflineContextIssueError&&error.reason==='binding_conflict')return review('scope_changed');
   throw error;
  }
  const current=Current.safeParse(raw);
  if(!current.success)return review('site_changed');
  if(policyKey(current.data.policy)!==policyKey(context.policy))return review('policy_changed');
  if(sitesKey(current.data.sites)!==sitesKey(context.sites))return review('site_changed');
  // An offline claim carries no legacy device token, so a company requiring a registered device reviews it.
  if(await requireRegisteredDeviceTx(tx,employmentId))return review('device_required');
  const date=await clockAttendanceDateTx(tx,employmentId,claim.command.action,effective,await openClockSessionDateTx(tx,employmentId));
  const [span]=await tx.select(clockingEmploymentSpan).from(employment).where(eq(employment.id,employmentId)).limit(1);
  const employed=span&&{start:String(span.start),end:span.end==null?null:String(span.end)};
  if(!employed||![todayInKualaLumpur(effective),date].every(day=>employedOnDate(employed,day)))return review('employment_inactive');
  if(!(await ownPayrollGuardTx(tx,employmentId)))return review('employment_inactive');
  // Payroll before the attendance row locks the plan takes, as the correction and removal effects order them.
  // Processed or closed payroll on that day is review: the SQL guards behind the writer are never reached.
  if((await lockPayrollForOwnAttendanceRemoval(tx,employmentId,date)).length)return review('payroll_locked');
  if((await readOvertimeSettlementForDayTx(tx,ctx,{employmentId,date}))?.settlement)return review('overtime_settled');
  try{await assertDayNotOwnedByCorrectionTx(tx,employmentId,date);}catch(error){if(error instanceof CorrectedClockConflictError)return review('corrected_day');throw error;}
  // The canonical read-only plan: ordering, geofence, photo, location and every other online rule.
  const plan=await planOfflineClockTx(tx,ctx,command(facts,photo,effective));
  if(plan.kind==='refused')return review(PLAN_REVIEW[plan.reason]);
  return {outcome:'accept',effectiveAt:time.effectiveAt};
 }
 /** The only write: the canonical offline writer, with exactly the decided instant, after `decide` accepted these
  * facts in this transaction. Its re-plan under the same locks cannot differ; if it refuses, nothing was written. */
 async function accept(tx:Tx,ctx:SessionContext,facts:OfflineClaimFacts,photo:OfflineClaimPhoto|null,decided:{outcome:'accept';effectiveAt:number}):Promise<OfflineClockDecision>{
  if(decided?.outcome!=='accept'||!Number.isSafeInteger(decided.effectiveAt)||decided.effectiveAt%1000!==0)throw unavailable();
  const written=await captureOfflineClockTx(tx,ctx,command(facts,photo,new Date(decided.effectiveAt)));
  if(written.kind==='refused')return {outcome:'needs_review',reason:PLAN_REVIEW[written.reason]};
  if(written.effectiveAt!==decided.effectiveAt)throw unavailable();
  return {outcome:'accepted',reason:'clock_accepted',captureId:written.captureId,effectiveAt:decided.effectiveAt};
 }
 const adjudicate=(async(tx,ctx,facts,photo)=>{const decided=await decide(tx,ctx,facts,photo);return decided.outcome==='accept'?accept(tx,ctx,facts,photo,decided):decided;}) satisfies OfflineClaimPorts['adjudicate'];
 return {decide,accept,adjudicate};
}
