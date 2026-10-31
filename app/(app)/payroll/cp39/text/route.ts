/**
 * e0cd4583 — the SAME CP39 the sibling `pdf/` route draws, written out as plain text: the employer block,
 * the payment summary, then each sheet's rows in the order the columns appear, with the JUMLAH per sheet
 * and JUMLAH BESAR at the end.
 *
 * ⚠️ THIS IS NOT THE e-DATA PCB UPLOAD FILE. That is the fixed-width 57/136-character machine format LHDN
 * ingests, and it lives at `/payroll/reports/cp39-file` behind its own route and its own stricter refusals
 * (`localization/my/cp39-file.ts`). This is the HUMAN-READABLE twin of the drawn page — what an operator
 * reads while keying into e-PCB by hand, and what they can keep, search and diff month to month. Both come
 * off the SAME `Cp39Form` as the PDF, so the two cannot say different things.
 *
 * GATED IDENTICALLY TO THE PDF ROUTE, and it must be: this response carries every employee's name,
 * identity card number, tax reference number, employee number, passport number and monthly deduction in a
 * form that is easier to copy. Both call `loadCp39Form`, so there is one gate, not two.
 */
import { cp39FormFilename, cp39FormTextExport } from '@/lib/cp39-form';
import { NO_DEDUCTIONS, describeCp39Gaps, loadCp39Form } from '../shared';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const loaded = await loadCp39Form({
    companyId: q.get('companyId') ?? '',
    periodKey: q.get('periodKey') ?? '',
    query: q,
  });

  if (!loaded.ok) {
    if (loaded.reason === 'not-found') return new Response('Not found', { status: 404 });
    if (loaded.reason === 'no-batch') {
      return new Response('No payroll run for this month — run payroll first.', { status: 422 });
    }
    // r409 (item 79f3f64d) — THREE MORE REFUSALS. The review screen's Continue gate answers each of these
    // before any link is drawn, so here they answer a hand-edited or stale link: a route is not a screen.
    if (loaded.reason === 'selection-empty') {
      return new Response('No payroll run for this month matches the payroll cycles you selected.', {
        status: 422,
      });
    }
    if (loaded.reason === 'bad-selection') return new Response(loaded.message, { status: 422 });
    if (loaded.reason === 'no-deductions') return new Response(NO_DEDUCTIONS, { status: 422 });
    return new Response(`Cannot produce a CP39: ${describeCp39Gaps(loaded)}.`, { status: 422 });
  }

  return new Response(cp39FormTextExport(loaded.form), {
    headers: {
      // charset is not optional: the form's own labels are Malay and the band at the foot carries
      // non-ASCII punctuation.
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${cp39FormFilename(loaded.form, 'txt')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
