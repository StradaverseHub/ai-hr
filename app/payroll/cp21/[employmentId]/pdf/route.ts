/**
 * r415 (item 79f3f64d, step 3) — one employee's CP21 [Pin.1/2025], FILLABLE, over LHDN's own two A4 pages.
 *
 * Shaped exactly like app/payroll/cp22a/[employmentId]/pdf/route.ts, for the same reasons: Node runtime
 * (pdf-lib), a UUID guard before any query, an RLS-gated read whose null is a 404, `scopedAdmin` rather
 * than `isAdmin` (an hr_admin grant on ANY company makes `isAdmin` true, and this document carries a named
 * person's IC, TIN, address and year's pay), the company-scope check, `private, no-store`, and NO domain
 * event — rendering a form is a read, downloading it is not filing it.
 *
 * A foreign id, an out-of-scope company and a non-Malaysian company are ALL the same bare 404.
 *
 * The operator's typed boxes (A3, A14, A15, A16, A18) arrive in the query string and are read by
 * `readCp21Typed` — the same function the preview reads them with. The typed departure date also decides
 * the period section B covers, so it is passed to `cp21Particulars` as well as to the renderer: the frame
 * and the download are one document. `inline=1` is the viewer's frame: the same bytes, a different
 * disposition.
 */
import { scopedAdmin } from '@/lib/scope';
import { cp21Particulars } from '@/core/reporting';
import { renderCp21Pdf } from '@/lib/cp21-pdf';
import { readCp21Typed } from '@/lib/cp21-review';
import { readCp21Template } from '@/lib/cp21-template';

export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ employmentId: string }> }) {
  const { employmentId } = await params;
  if (!UUID.test(employmentId)) return new Response('Not found', { status: 404 });
  const q = new URL(req.url).searchParams;
  const typed = readCp21Typed(q);

  const { s, scopeIds } = await scopedAdmin();
  const particulars = await cp21Particulars(s, { employmentId, departureDate: typed.departureDate });
  if (!particulars) return new Response('Not found', { status: 404 });
  if (!scopeIds.includes(particulars.companyId)) return new Response('Not found', { status: 404 });

  const bytes = await renderCp21Pdf(readCp21Template(), { ...particulars, typed });
  const inline = q.get('inline') === '1';
  const fname = `cp21-${particulars.employee.fullName}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${fname}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
