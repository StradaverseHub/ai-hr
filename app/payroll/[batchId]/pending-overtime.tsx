'use client';

import Link from 'next/link';
import {useTranslations} from 'next-intl';
import type {PendingOvertimeCashEvidence,PendingOvertimeReview} from '@/packs/payroll/service';
import {overtimeMoneyText} from '@/components/overtime-patterns/calculation-result';

/** A known refusal must never be rendered as an empty, basic-salary-only run. */
export function PendingMoneyStatus({hasLines,review}:{hasLines:boolean;review?:PendingOvertimeReview}) {
  const t=useTranslations('payroll.batch.pendingMoney');
  const ot=useTranslations('overtimePatterns');
  if(review?.status==='unavailable') return <div role="alert" className="mx-4 my-3 space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
    <p className="font-medium">{t('formulaUnavailable')}</p>
    <p>{ot(`errors.${review.code}`)}</p>
    <p className="text-xs">{t('formulaReviewHint')}</p>
    <Link href="/admin/attendance/settings/overtime-patterns" className="text-primary underline">{ot('title')}</Link>
  </div>;
  if(!hasLines) return <p className="px-4 py-4 text-sm text-muted-foreground">{t('empty')}</p>;
  return review?.status==='available'&&review.lineCount>0?<p className="px-4 pt-3 text-xs text-muted-foreground">{t('formulaRecordedHint')}</p>:null;
}

export function PendingOvertimeCashAmount({evidence}:{evidence:PendingOvertimeCashEvidence}) {
  return <>{overtimeMoneyText(evidence.amountMinorUnits,evidence.minorScale,evidence.currency)}</>;
}

/** Evidence stays separate from an earning label and never substitutes a mutable name for an ID. */
export function PendingOvertimeCashDetails({evidence}:{evidence:PendingOvertimeCashEvidence}) {
  const t=useTranslations('overtimePatterns');
  return <div className="mt-1 space-y-1 text-xs text-muted-foreground">
    <p>{t('recordedCalculation')} · {evidence.date}</p>
    <details><summary className="cursor-pointer">{t('calculationTrace')}</summary>
      <p className="mt-2 break-all">{t('calculationReference',{id:evidence.calculationId,revision:evidence.sourceRevision})}</p>
      <dl className="mt-2 space-y-1">{(['sourceId','settlementId','lineId','earningItemId'] as const).map(key=><div key={key}><dt>{t('evidenceDetail',{key})}</dt><dd className="break-all">{evidence[key]}</dd></div>)}</dl>
    </details>
  </div>;
}
