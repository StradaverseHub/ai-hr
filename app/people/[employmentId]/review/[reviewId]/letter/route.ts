// Employment-review outcome letter (0110) — stream the completed-review letter as a downloadable A4 PDF.
// ABAC is inherited from reviewLetterData → RLS on employment_review (can_see_employment): the read returns
// null unless the caller may see the employment (subject / admin-line manager / admin). A foreign or
// invisible id → 404 (mirrors the EA route). The letter generates only once status='completed'.
//
// Font: Latin-only (Helvetica/WinAnsi), same documented limitation as lib/ea-pdf.ts (ADR-0036). A Unicode
// font is the deferred follow-up.
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { reviewLetterData } from '@/core/employment-review';
import { renderReviewLetter, type ReviewLetterData } from '@/lib/review-letter-pdf';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, { params }: { params: Promise<{ employmentId: string; reviewId: string }> }) {
  const { reviewId } = await params;
  if (!UUID.test(reviewId)) return new Response('Not found', { status: 404 });

  const s = await getSession();
  const rev = await reviewLetterData(s, reviewId); // RLS-gated: null → 404 (foreign id or not completed)
  if (!rev) return new Response('Not found', { status: 404 });

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

  // Substrate: a read-only render (no state change) appends NO domain event — same as the EA route. Deliberate skip.
  const fname = `review-${rev.reviewType}-${rev.employer}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fname}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
