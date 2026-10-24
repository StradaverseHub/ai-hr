'use client';
import {useTranslations} from 'next-intl';
import {formatDays} from '@/lib/day-format';
import type {LeaveCreditClaimReview} from '@/lib/leave-credit-claim-review';
export function LeaveCreditClaimReviewNotice({review}:{review:LeaveCreditClaimReview|null}) {
 const t=useTranslations('replacementRequest.formulaReview');
 if(!review)return <p className="min-w-0 max-w-full whitespace-normal [overflow-wrap:anywhere]" role="status">{t('reading')}</p>;
 if(review.basis==='legacy')return null;
 if(review.basis==='unavailable')return <p className="min-w-0 max-w-full whitespace-normal [overflow-wrap:anywhere]" role="alert">{t(`errors.${review.reason}`)}</p>;
 return <div className="min-w-0 max-w-full space-y-1 whitespace-normal text-xs [overflow-wrap:anywhere]" role={review.status==='refused'?'alert':'status'}>
  <p>{t('bound',{minutes:review.boundMinutes})}{review.claimedMinutes!==null?' · '+t('claimed',{minutes:review.claimedMinutes}):''}</p>
  {review.status==='incomplete'?<p>{t('incomplete')}</p>:review.reason?<p>{t(`errors.${review.reason}`)}</p>:review.eligibleMinutes!==null?<p>{t('reviewed',{minutes:review.eligibleMinutes})}</p>:<p>{t('incomplete')}</p>}
  {review.status==='ready'&&review.creditDays!==null?<p>{t('reviewedCredit',{days:formatDays(review.creditDays)})}</p>:null}
  {review.datedParts?.length?<ul className="space-y-1" aria-label={t('datedBreakdown')} data-testid="leave-credit-dated-parts">
    {review.datedParts.map(part=><li key={part.sequence}>{t('datedCredit',{date:part.date,dayClass:t(`datedClasses.${part.dayClass}`),minutes:part.countedMinutes,days:formatDays(part.days)})}</li>)}
  </ul>:null}
  <p className="break-all text-muted-foreground">{t('reference',{id:review.calculationId,revision:review.sourceRevision})}</p>
  <p className="text-muted-foreground">{t('subjectToApproval')}</p>
 </div>;
}
