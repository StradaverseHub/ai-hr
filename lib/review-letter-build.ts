// 6522d26a — shared builder for the employment-review outcome letter: reads the completed review
// (RLS-gated), assembles the i18n labels and renders the A4 PDF. Extracted from the letter route so the
// on-demand download (app/admin/personnel/[employmentId]/review/[reviewId]/letter/route.ts) and the
// "save letter to record" action (uploadReviewDocument kind system_letter) emit byte-identical letters.
// Read-only — persistence (and its DomainEvent) belongs to the caller.
import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { reviewLetterData } from '@/core/employment-review';
import { renderReviewLetter, type ReviewLetterData } from '@/lib/review-letter-pdf';

export type BuiltReviewLetter = {
  bytes: Uint8Array;
  /** Sanitized `review-<type>-<employer>.pdf` filename (same shape the route always served). */
  fileName: string;
};

/** Null when the review is foreign/invisible (RLS) or not yet completed — callers 404/reject on null. */
export async function buildReviewLetterPdf(s: SessionContext, reviewId: string): Promise<BuiltReviewLetter | null> {
  const rev = await reviewLetterData(s, reviewId); // RLS-gated: null → not visible or not completed
  if (!rev) return null;

  const t = await getTranslations('review');
  const typeLabel = t(`reviewType.${rev.reviewType}` as 'reviewType.probation');
  const data: ReviewLetterData = {
    decision: rev.decision,
    reviewType: rev.reviewType,
    employer: rev.employer,
    employeeName: rev.employee,
    endDate: rev.endDate,
    extendToDate: rev.extendToDate,
    decidedOn: rev.decidedOn,
  };
  const bytes = await renderReviewLetter(data, {
    title: t(`letter.title.${rev.decision}` as 'letter.title.confirm'),
    dateLabel: t('letter.dateLabel'),
    reLabel: t('letter.reLabel'),
    reText: t('letter.reText', { type: typeLabel }),
    greeting: t('letter.greeting', { name: rev.employee }),
    body: t(`letter.body.${rev.decision}` as 'letter.body.confirm', {
      type: typeLabel,
      endDate: rev.endDate,
      extendTo: rev.extendToDate ?? '',
    }),
    signOff: t('letter.signOff'),
    hrSignature: t('letter.hrSignature'),
    disclaimer: t('letter.disclaimer'),
  });

  const fileName = `${`review-${rev.reviewType}-${rev.employer}`.replace(/[^a-zA-Z0-9._-]+/g, '-')}.pdf`;
  return { bytes, fileName };
}
