/**
 * 8ca344bf — the SAME Borang 8A the sibling `pdf/` route draws, written out as plain text: the header,
 * then each sheet's rows in the order the columns appear, with that sheet's total.
 *
 * WHY A TEXT FILE AT ALL, WHEN THE PDF EXISTS. A Borang 8A is keyed into PERKESO's own portal — the drawn
 * page is the thing you read while you key, and a paginated A4 rendering is a poor thing to key from. This
 * is the same content in a fixed-width layout that can be worked down without hunting, and it is what an
 * operator can keep, search and diff month to month. Both come off the SAME `Borang8AForm`, so they cannot
 * say different things. (The same argument the CP22 text export was built on in r191.)
 *
 * GATED IDENTICALLY TO THE PDF ROUTE, and it must be: this response carries every employee's name, IC and
 * contribution in a form that is easier to copy. Both call `loadBorang8A`, so there is one gate, not two.
 */
import { borang8ATextExport } from '@/lib/borang-8a';
import { borang8AFilename } from '@/lib/borang-8a-pdf';
import { describeGaps, loadBorang8A } from '../shared';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const loaded = await loadBorang8A({
    companyId: q.get('companyId') ?? '',
    periodKey: q.get('periodKey') ?? '',
    query: q,
  });

  if (!loaded.ok) {
    if (loaded.reason === 'not-found') return new Response('Not found', { status: 404 });
    if (loaded.reason === 'no-batch') {
      return new Response('No payroll run for this month — run payroll first.', { status: 422 });
    }
    // r372 (item f022dd70) — TWO MORE REFUSALS, BOTH ABOUT THE PAYROLL-CYCLE SELECTION ON THE LINK.
    // Unreachable from this screen, which sends no run parameter, and answered here anyway: a route is
    // not a screen, and a hand-edited link must not fall through to "somebody is missing a number".
    if (loaded.reason === 'selection-empty') {
      return new Response('No payroll run for this month matches the payroll cycles you selected.', {
        status: 422,
      });
    }
    if (loaded.reason === 'bad-selection') return new Response(loaded.message, { status: 422 });
    // Both kinds of gap, named, THROUGH THE ONE HELPER (r372). An employer-level gap (no SOCSO employer
    // code) gaps every page at once and is fixed in one place; a per-employee gap is fixed on that
    // person's record, and the reason is the pack's own — this route does not guess which one it was.
    return new Response(`Cannot produce Borang 8A: ${describeGaps(loaded)}.`, { status: 422 });
  }

  return new Response(borang8ATextExport(loaded.form), {
    headers: {
      // charset is not optional: the form's own labels are Malay and the band at the foot carries
      // non-ASCII punctuation.
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${borang8AFilename(loaded.form, 'txt')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
