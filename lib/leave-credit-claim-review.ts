import type {DatedToilCredit} from './toil-dated-credit';
import type {LeaveCreditDayType} from './leave-credit-day-type';
/** Duration-only review. It is neither an approval nor a cash/leave entitlement. */
export type LeaveCreditFormulaReason = 'unavailable'|'stale'|'fractional'|'cashConflict';
export type LeaveCreditClaimReview =
  | {basis:'legacy'}
  | {basis:'unavailable';reason:LeaveCreditFormulaReason}
  | {basis:'formula';/** Source-date form label only; datedParts own each credit classification. */workedDayKind:LeaveCreditDayType;datedClassScope?:true;datedParts?:DatedToilCredit[];status:'incomplete'|'ready'|'refused';reason:'exceedsBound'|'belowThreshold'|'ordinaryDisabled'|null;
      claimedMinutes:number|null;boundMinutes:number;eligibleMinutes:number|null;creditDays:number|null;
      calculationId:string;sourceRevision:number};

export type LeaveCreditClaimReviewAction=(workedDate:string,claimStart:string,claimEnd:string,employmentId?:string)=>Promise<LeaveCreditClaimReview>;

/** Absence/pending/error never authorizes a formula promise. Only explicit legacy preserves the old rule. */
export function leaveCreditClaimReviewBlocks(review:LeaveCreditClaimReview|null|undefined):boolean {return !review||review.basis==='unavailable'||review.basis==='formula'&&(review.status!=='ready'||review.eligibleMinutes===null||review.creditDays===null);}
