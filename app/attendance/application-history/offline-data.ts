/** The Offline punches tab's server reads on Attendance › Application History (draft 0647; owner-approved design
 * 2026-10-28). Server code only (the review module reaches server-only core/mobile-offline-claim).
 *
 * offlineReviewTabCount is null on a database without draft 0647, and the page then shows no tab at all, so this
 * screen is unchanged wherever offline clocking is not installed. The rows handed to the client are a narrow view:
 * no location, signed proof, photo bytes or digests. */
import type {SessionContext} from '@/db/client';
import {countOfflineClaimsAwaitingReview} from '@/packs/attendance/service';
import {readOfflineClaimReviewPage,type OfflineClaimResolutionStatus} from '@/packs/attendance/mobile-offline-claim-review';

export type OfflineReviewStatus='needs_review'|OfflineClaimResolutionStatus;
export type OfflineReviewRow={id:string;employeeName:string|null;action:'in'|'out';claimedAt:number;receivedAt:number;effectiveMinimum:number|null;effectiveMaximum:number|null;
 /** The instant already decided (an accept's chosen time), else null. */
 decidedAt:number|null;
 /** The stored hold reason, one of OfflineClockReviewReason (lib/mobile-offline-receipt). */
 reason:string;status:OfflineReviewStatus;
 photo:{retainedUntil:number;retained:boolean}|null;resolutionReason:string|null};
export type OfflineReviewPage={groupAdmin:boolean;rows:OfflineReviewRow[];next:string|null};

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function offlineReviewTabCount(s:SessionContext,scopeIds:readonly string[]){return countOfflineClaimsAwaitingReview(s,scopeIds);}

export async function loadOfflineReview(s:SessionContext,scopeIds:readonly string[],p:{all:boolean;before?:string}):Promise<OfflineReviewPage>{
 const page=await readOfflineClaimReviewPage(s,{companyIds:scopeIds,all:p.all,...(p.before&&UUID.test(p.before)?{before:p.before}:{})});
 return {groupAdmin:page.groupAdmin,next:page.next,rows:page.claims.map(claim=>({id:claim.id,employeeName:claim.employeeName,action:claim.command.action,claimedAt:claim.claimedAt,
  receivedAt:claim.receivedAt,effectiveMinimum:claim.effectiveMinimum,effectiveMaximum:claim.effectiveMaximum,decidedAt:claim.resolution?.effectiveAt??claim.effectiveAt,
  reason:claim.reason,status:claim.resolution?claim.resolution.status:'needs_review',photo:claim.photo?{retainedUntil:claim.photo.retainedUntil,retained:claim.photo.retained}:null,
  resolutionReason:claim.resolution?.reason??null}))};
}
