/**
 * 9c8dad7a — the SAME Borang A the sibling `pdf/` route draws, written out as plain text: the header,
 * then each sheet's rows in the order the columns appear, with the carried-forward totals.
 *
 * ⚠️ THIS IS NOT THE i-AKAUN UPLOAD FILE. That is the fixed-width 129-character machine format and it
 * lives at `../file`. This is the HUMAN-READABLE twin of the drawn page — what an operator reads while
 * keying by hand, and what they can keep, search and diff month to month. Both come off the SAME
 * `BorangAForm` as the PDF, so the three cannot say different things.
 *
 * GATED IDENTICALLY TO THE PDF ROUTE, and it must be: this response carries every employee's name,
 * identity card number, EPF member number, wage and contribution in a form that is easier to copy. Both
 * call `loadBorangA`, so there is one gate, not two.
 */
import { borangAFilename, borangATextExport } from '@/lib/borang-a';
import { describeGaps, loadBorangA } from '../shared';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const loaded = await loadBorangA({
    companyId: q.get('companyId') ?? '',
    periodKey: q.get('periodKey') ?? '',
    query: q,
  });

  if (!loaded.ok) {
    if (loaded.reason === 'not-found') return new Response('Not found', { status: 404 });
    if (loaded.reason === 'no-batch') {
      return new Response('No payroll run for this month — run payroll first.', { status: 422 });
    }
    return new Response(`Cannot produce Borang A: ${describeGaps(loaded)}.`, { status: 422 });
  }

  return new Response(borangATextExport(loaded.form), {
    headers: {
      // charset is not optional: the form's own labels are Malay and the band at the foot carries
      // non-ASCII punctuation.
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${borangAFilename(loaded.form, 'txt')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
