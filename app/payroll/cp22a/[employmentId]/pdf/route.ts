/**
 * r413 (item 79f3f64d, step 2) — one leaver's CP22A [Pin.1/2023], FILLABLE, over LHDN's own two pages.
 *
 * Shaped exactly like app/payroll/cp22/[employmentId]/pdf/route.ts, and for the same reasons: Node runtime
 * (pdf-lib), a UUID guard before any query, an RLS-gated read whose null is a 404, `scopedAdmin` rather
 * than `isAdmin` (an hr_admin grant on ANY company makes `isAdmin` true, and this document carries a named
 * person's IC, TIN, address and year's pay), the company-scope check, `private, no-store`, and NO domain
 * event — rendering a form is a read, downloading it is not filing it.
 *
 * A foreign id, an out-of-scope company, a non-Malaysian company and an employment with no leaving date
 * are ALL the same bare 404, so the URL cannot be used to find out which.
 *
 * The operator's typed boxes (A5, A6, A8, A17) arrive in the query string and are read by
 * `readCp22aTyped` — the same function the preview reads them with, so the framed preview and the download
 * are one document. `inline=1` is the viewer's frame: the same bytes, a different disposition.
 */
import { scopedAdmin } from '@/lib/scope';
import { cp22aParticulars } from '@/core/reporting';
import { renderCp22aPdf } from '@/lib/cp22a-pdf';
import { readCp22aTyped } from '@/lib/cp22a-review';
import { readCp22aTemplate } from '@/lib/cp22a-template';

export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ employmentId: string }> }) {
  const { employmentId } = await params;
  if (!UUID.test(employmentId)) return new Response('Not found', { status: 404 });
  const q = new URL(req.url).searchParams;

  const { s, scopeIds } = await scopedAdmin();
  const particulars = await cp22aParticulars(s, { employmentId });
  if (!particulars) return new Response('Not found', { status: 404 });
  if (!scopeIds.includes(particulars.companyId)) return new Response('Not found', { status: 404 });

  const bytes = await renderCp22aPdf(readCp22aTemplate(), { ...particulars, typed: readCp22aTyped(q) });
  const inline = q.get('inline') === '1';
  const fname = `cp22a-${particulars.employee.fullName}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${fname}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
