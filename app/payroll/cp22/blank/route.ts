/**
 * d3a9383c — the completely blank fillable CP22, for the occasional notice an operator would rather
 * complete by hand, and for a LATE filing on a hire older than the 60-day window the worklist covers.
 *
 * SAME RENDERER, SAME 33 BOXES, no data: `renderCp22Pdf(template, null)`. A second code path that drew a
 * "blank version" would be a second form to keep in step with LHDN's artwork, which is the duplication this
 * feature exists to avoid.
 *
 * `blank` is not a UUID, so it cannot collide with the sibling `[employmentId]/pdf` route.
 *
 * `requireAdmin` rather than `scopedAdmin`: there is no company and no employee in this response — the
 * bytes are LHDN's published form plus empty widgets — so there is nothing for a company scope to narrow.
 * It stays admin-only because it belongs to the Statutory Forms screen, not because it is sensitive.
 */
import { requireAdmin } from '@/lib/authz';
import { renderCp22Pdf } from '@/lib/cp22-pdf';
import { readCp22Template } from '@/lib/cp22-template';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

export async function GET() {
  await requireAdmin();
  const bytes = await renderCp22Pdf(readCp22Template(), null);
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="cp22-blank.pdf"',
      'Cache-Control': 'private, no-store',
    },
  });
}
