/**
 * e0cd4583 — the CP39 monthly PCB statement itself, as a PDF: a cover page carrying the employer, the
 * period, the payment summary and the preparer block, then the employee schedule paginated with a JUMLAH
 * per sheet and JUMLAH BESAR on the last.
 *
 * A ROUTE HANDLER, NOT A GUARDED PAGE — deliberately, and r191's CP22 downloads plus r193's Borang 8A and
 * r194's Borang A downloads are the precedent. A `route.ts` has no screen column in the function-access
 * matrix and needs none; only `page.tsx` files are enumerated there. The one guarded PAGE this feature
 * adds is `../preview`, and that one IS registered (lib/permissions.ts).
 *
 * EVERY DECISION LIVES IN `../shared.ts`. Scope, period validation, generation, the preparer overrides and
 * the readiness gate are shared with the review screen and the sibling text route, so the document that
 * downloads cannot differ from the document that was reviewed.
 *
 * NO DOMAIN EVENT. Rendering a form is a READ, and this download is explicitly not a filing — LHDN has
 * not accepted a paper CP39 since September 2019, and the actual submission is the e-Data PCB file behind
 * its own route. Same deliberate skip the EA, payslip, CP22, Borang 8A and Borang A routes make.
 * "Record generation" on the [formId] screen remains the one deliberate act that writes an artefact.
 */
import { cp39FormFilename } from '@/lib/cp39-form';
import { renderCp39FormPdf } from '@/lib/cp39-form-pdf';
import { describeCp39Gaps, loadCp39Form } from '../shared';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const loaded = await loadCp39Form({
    companyId: q.get('companyId') ?? '',
    periodKey: q.get('periodKey') ?? '',
    query: q,
  });

  if (!loaded.ok) {
    // A bad company, a bad period and a form this jurisdiction does not have are ONE answer, so the URL
    // cannot enumerate any of them. The two operational refusals say what is wrong, because they are
    // things the operator can fix and they are reached from a screen that already told them so.
    if (loaded.reason === 'not-found') return new Response('Not found', { status: 404 });
    if (loaded.reason === 'no-batch') {
      return new Response('No payroll run for this month — run payroll first.', { status: 422 });
    }
    return new Response(`Cannot produce a CP39: ${describeCp39Gaps(loaded)}.`, { status: 422 });
  }

  const pdf = await renderCp39FormPdf(loaded.form);
  return new Response(Buffer.from(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${cp39FormFilename(loaded.form, 'pdf')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
