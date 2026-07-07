// Employment-review outcome letter (0110) — stream the completed-review letter as a downloadable A4 PDF.
// ABAC is inherited from reviewLetterData → RLS on employment_review (can_see_employment): the read returns
// null unless the caller may see the employment (subject / admin-line manager / admin). A foreign or
// invisible id → 404 (mirrors the EA route). The letter generates only once status='completed'.
//
// 6522d26a: rendering moved to lib/review-letter-build.ts so the "save letter to record" action persists a
// byte-identical letter. Font: Latin-only (Helvetica/WinAnsi), same documented limitation as lib/ea-pdf.ts
// (ADR-0036). A Unicode font is the deferred follow-up.
import { getSession } from '@/lib/session';
import { buildReviewLetterPdf } from '@/lib/review-letter-build';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, { params }: { params: Promise<{ employmentId: string; reviewId: string }> }) {
  const { reviewId } = await params;
  if (!UUID.test(reviewId)) return new Response('Not found', { status: 404 });

  const s = await getSession();
  const letter = await buildReviewLetterPdf(s, reviewId); // RLS-gated: null → 404 (foreign id or not completed)
  if (!letter) return new Response('Not found', { status: 404 });

  // Substrate: a read-only render (no state change) appends NO domain event — same as the EA route. Deliberate skip.
  return new Response(Buffer.from(letter.bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${letter.fileName}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
