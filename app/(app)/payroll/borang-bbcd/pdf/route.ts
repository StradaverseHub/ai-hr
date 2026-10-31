/**
 * r411 (item 4f45f9b0) — the BBCD as a PDF: one A4 page, the cover for the month's Borang A payment.
 *
 * A ROUTE HANDLER, NOT A GUARDED PAGE (the Borang A pdf route is the precedent). Every decision is in
 * `../shared.ts`, which is `loadBorangA` — so this route refuses exactly what the Borang A PDF route
 * refuses, with the same words, and its Amaun Caruman is that form's total.
 *
 * `?disposition=inline` is the in-app viewer's frame: the same bytes, only the header differs.
 */
import { renderBorangBbcdPdf } from '@/lib/borang-bbcd-pdf';
import { borangBbcdFilename } from '@/lib/borang-bbcd';
import { NO_CONTRIBUTIONS, describeGaps } from '../../borang-a/shared';
import { loadBorangBbcd } from '../shared';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const loaded = await loadBorangBbcd({
    companyId: q.get('companyId') ?? '',
    periodKey: q.get('periodKey') ?? '',
    query: q,
  });

  if (!loaded.ok) {
    if (loaded.reason === 'not-found') return new Response('Not found', { status: 404 });
    if (loaded.reason === 'no-batch') {
      return new Response('No payroll run for this month — run payroll first.', { status: 422 });
    }
    if (loaded.reason === 'selection-empty') {
      return new Response('No payroll run for this month matches the payroll cycles you selected.', {
        status: 422,
      });
    }
    if (loaded.reason === 'bad-selection') return new Response(loaded.message, { status: 422 });
    if (loaded.reason === 'no-contributions') return new Response(NO_CONTRIBUTIONS, { status: 422 });
    return new Response(`Cannot produce BBCD: the Borang A is not ready — ${describeGaps(loaded)}.`, { status: 422 });
  }

  const pdf = await renderBorangBbcdPdf(loaded.bbcd);
  const disposition = q.get('disposition') === 'inline' ? 'inline' : 'attachment';
  return new Response(Buffer.from(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="${borangBbcdFilename(loaded.bbcd)}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
