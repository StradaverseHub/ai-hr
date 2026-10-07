/**
 * r412 (item e74af58c, step 2) — the EIS (SIP) monthly contribution schedule, as a PDF. A route handler, not a
 * guarded page (the Borang 8A PDF route is the precedent): every decision is `../shared.ts`'s, so the
 * document that downloads is the document that was reviewed. NO DOMAIN EVENT: rendering a form is a read.
 */
import { renderSipContributionPdf, sipContributionFilename } from '@/lib/sip-contribution-pdf';
import { NO_EIS_CONTRIBUTIONS, describeSipGaps, loadSip } from '../shared';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const loaded = await loadSip({ companyId: q.get('companyId') ?? '', periodKey: q.get('periodKey') ?? '', query: q });

  if (!loaded.ok) {
    if (loaded.reason === 'not-found') return new Response('Not found', { status: 404 });
    if (loaded.reason === 'no-batch') {
      return new Response('No payroll run for this month — run payroll first.', { status: 422 });
    }
    if (loaded.reason === 'selection-empty') {
      return new Response('No payroll run for this month matches the payroll cycles you selected.', { status: 422 });
    }
    if (loaded.reason === 'bad-selection') return new Response(loaded.message, { status: 422 });
    if (loaded.reason === 'no-contributions') return new Response(NO_EIS_CONTRIBUTIONS, { status: 422 });
    return new Response(`Cannot produce the EIS (SIP) schedule: ${describeSipGaps(loaded)}.`, { status: 422 });
  }

  const pdf = await renderSipContributionPdf(loaded.form);
  // THE PREVIEW IS THIS ROUTE, ASKED TO SHOW RATHER THAN SAVE — same loader, gate, renderer and bytes.
  const disposition = q.get('disposition') === 'inline' ? 'inline' : 'attachment';
  return new Response(Buffer.from(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="${sipContributionFilename(loaded.form)}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
