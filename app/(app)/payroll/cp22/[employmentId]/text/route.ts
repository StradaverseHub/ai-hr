/**
 * 88076362 — the SAME CP22 the sibling `pdf/` route produces, written out as plain text: every field and
 * value on its own line, grouped by the form's own sections A to F.
 *
 * WHY A TEXT FILE AT ALL, WHEN THE PDF EXISTS. Since 1 September 2024 a CP22 is filed through the e-CP22
 * service on MyTax — the PDF is not the filing, it is the thing you read while you key the filing in, and
 * a scrolling, watermarked, two-page government form is a poor thing to key from. This is the same content
 * in the order the boxes appear, so it can be worked down without hunting; and it is what an operator can
 * keep, search and diff. Both come off `cp22FieldValues`, so they cannot say different things.
 *
 * GATED IDENTICALLY TO THE PDF ROUTE, and it must be: this response carries the same named person's IC,
 * passport, tax number, home address and salary, in a form that is easier to copy. `scopedAdmin` rather
 * than `isAdmin` for the reason that route documents — an hr_admin grant on ANY company makes `isAdmin`
 * true — and a malformed id, a foreign employment, an out-of-scope company and a non-Malaysian company are
 * ALL the same bare 404, so the URL cannot be used to enumerate any of them.
 *
 * NO DOMAIN EVENT, for the reason the PDF route gives: rendering a form is a read, and this download is
 * explicitly not a filing.
 */
import { scopedAdmin } from '@/lib/scope';
import { cp22Particulars } from '@/core/reporting';
import { cp22ReviewFrom, cp22TextExport } from '@/lib/cp22-review';

export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ employmentId: string }> }) {
  const { employmentId } = await params;
  if (!UUID.test(employmentId)) return new Response('Not found', { status: 404 });
  const q = new URL(req.url).searchParams;

  const { s, scopeIds } = await scopedAdmin();
  // RLS-gated, and null for a non-Malaysian company as well as for an employment this session cannot see.
  const particulars = await cp22Particulars(s, { employmentId });
  if (!particulars) return new Response('Not found', { status: 404 });
  if (!scopeIds.includes(particulars.companyId)) return new Response('Not found', { status: 404 });

  // The review screen's own five boxes when it sent them, the record's values otherwise — including
  // `submitTo`, which has no box on the 2021 form and therefore exists ONLY here and on the screen. The
  // merge lives in lib/cp22-review.ts so this route and the PDF route cannot drift apart about it.
  const review = cp22ReviewFrom(particulars, q);

  const fname = `cp22-${particulars.employee.fullName}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return new Response(cp22TextExport(particulars, review), {
    headers: {
      // charset is not optional: the form's own labels are bilingual and carry non-ASCII punctuation.
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fname}.txt"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
