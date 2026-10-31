/**
 * r412 (item e74af58c, step 2) — Borang 8B as a PDF: the employer's header and the under-paid month filled,
 * every employee line blank. A route handler, not a guarded page; every decision is `../shared.ts`'s, so the
 * framed preview and the download are the same bytes. NO DOMAIN EVENT: rendering a form is a read.
 */
import { borang8BFilename, renderBorang8BPdf } from '@/lib/borang-8b-pdf';
import { loadBorang8B } from '../shared';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const loaded = await loadBorang8B({ companyId: q.get('companyId') ?? '', periodKey: q.get('periodKey') ?? '' });
  if (!loaded.ok) {
    if (loaded.reason === 'not-found') return new Response('Not found', { status: 404 });
    if (loaded.reason === 'month-not-ended') {
      return new Response('Borang 8B is for a month that has already ended; choose an earlier month.', { status: 422 });
    }
    return new Response(`Cannot produce Borang 8B: the company is missing: ${loaded.headerMissing.join(', ')}.`, {
      status: 422,
    });
  }
  const pdf = await renderBorang8BPdf(loaded.form);
  const disposition = q.get('disposition') === 'inline' ? 'inline' : 'attachment';
  return new Response(Buffer.from(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="${borang8BFilename(loaded.form)}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
