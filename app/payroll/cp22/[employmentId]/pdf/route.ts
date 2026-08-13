/**
 * d3a9383c — stream one new joiner's CP22 [Pin.1/2021] as a FILLABLE PDF over LHDN's official two pages.
 *
 * ROUTE SHAPE COPIED FROM THE EA (app/me/ea/[employmentId]/pdf/route.ts) and the statutory-form export
 * beside it: Node runtime because pdf-lib needs it, a UUID guard before any query, an RLS-gated read whose
 * null is a 404, `attachment` + `private, no-store`, and NO domain event — rendering a form is a read, and
 * downloading it is not filing. "I generated the form" stays a separate, deliberate act.
 *
 * `scopedAdmin` RATHER THAN `isAdmin`, for the reason the export route documents: an hr_admin grant on ANY
 * company makes `isAdmin` true, and this document carries a named person's IC, passport, tax number, home
 * address and salary. It fails closed twice — the session must be an admin AND the employing company must
 * be one they are scoped to — and a foreign id, an out-of-scope company and a non-Malaysian company are
 * ALL the same 404, so the URL cannot be used to enumerate any of them.
 *
 * DELIBERATELY NOT UNDER app/payroll/statutory-forms/: that segment already carries [formId], so a static
 * `cp22` sibling there would shadow a form id of 'cp22'. Harmless today (ids are 'my.cp8d' shaped) but not
 * a trap worth planting.
 */
import { scopedAdmin } from '@/lib/scope';
import { cp22Particulars } from '@/core/reporting';
import { renderCp22Pdf } from '@/lib/cp22-pdf';
import { cp22WithReview } from '@/lib/cp22-review';
import { readCp22Template } from '@/lib/cp22-template';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ employmentId: string }> }) {
  const { employmentId } = await params;
  const q = new URL(req.url).searchParams;
  if (!UUID.test(employmentId)) return new Response('Not found', { status: 404 });

  const { s, scopeIds } = await scopedAdmin();
  // RLS-gated, and null for a non-Malaysian company as well as for an employment this session cannot see.
  const particulars = await cp22Particulars(s, { employmentId });
  if (!particulars) return new Response('Not found', { status: 404 });
  if (!scopeIds.includes(particulars.companyId)) return new Response('Not found', { status: 404 });

  // 88076362 — the review screen's corrections, when the request came from it. A request with none of
  // its boxes (the worklist's plain link, an old bookmark) produces exactly the document it always did:
  // `cp22WithReview` returns the record untouched. See lib/cp22-review.ts for why absent and empty are
  // different answers here.
  const bytes = await renderCp22Pdf(readCp22Template(), cp22WithReview(particulars, q));

  // `inline` is the review screen's "View" action — the SAME bytes, shown in the browser's own reader
  // instead of landing in Downloads. It is not a second document and not a second code path.
  const inline = q.get('inline') === '1';
  const fname = `cp22-${particulars.employee.fullName}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${fname}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
