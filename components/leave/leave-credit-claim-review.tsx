'use client';
import {useTranslations} from 'next-intl';
import {formatDays} from '@/lib/day-format';
import type {LeaveCreditClaimReview} from '@/lib/leave-credit-claim-review';
export function LeaveCreditClaimReviewNotice({review}:{review:LeaveCreditClaimReview|null}) {
 const t=useTranslations('replacementRequest.formulaReview');
 if(!review)return <p role="status">{t('reading')}</p>;
 if(review.basis==='legacy')return null;
 if(review.basis==='unavailable')return <p role="alert">{t(`errors.${review.reason}`)}</p>;
 return <div className="space-y-1 text-xs" role={review.status==='refused'?'alert':'status'}>
  <p>{t('bound',{minutes:review.boundMinutes})}{review.claimedMinutes!==null?' · '+t('claimed',{minutes:review.claimedMinutes}):''}</p>
  {review.status==='incomplete'?<p>{t('incomplete')}</p>:review.reason?<p>{t(`errors.${review.reason}`)}</p>:review.eligibleMinutes!==null?<p>{t('reviewed',{minutes:review.eligibleMinutes})}</p>:<p>{t('incomplete')}</p>}
  {review.status==='ready'&&review.creditDays!==null?<p>{t('reviewedCredit',{days:formatDays(review.creditDays)})}</p>:null}
  <p className="break-all text-muted-foreground">{t('reference',{id:review.calculationId,revision:review.sourceRevision})}</p>
  <p className="text-muted-foreground">{t('subjectToApproval')}</p>
 </div>;
}
