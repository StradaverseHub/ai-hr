import { getSession } from '@/lib/session';
import { getDownload } from '@/core/knowledge-base';

/** Stream a KB document: an article as `.md`, a file with its original type. Re-checks the session,
 *  and getDownload runs under RLS (tenant member) — the only read that touches the file bytes. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSession();
  const doc = await getDownload(s, id);
  if (!doc) return new Response('Not found', { status: 404 });

  const safe = (name: string) => name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'document';
  // `?inline=1` renders in the browser (image/PDF preview); default forces a download.
  const disposition = new URL(req.url).searchParams.get('inline') === '1' ? 'inline' : 'attachment';

  if (doc.kind === 'article') {
    const filename = `${safe(doc.title)}.md`;
    return new Response(doc.body ?? '', {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  }

  if (!doc.content) return new Response('No content', { status: 404 });
  const filename = safe(doc.fileName ?? doc.title);
  // postgres.js returns bytea as a Buffer/Uint8Array; hand it to the Response as bytes.
  const bytes = new Uint8Array(doc.content);
  return new Response(bytes, {
    headers: {
      'Content-Type': doc.mimeType || 'application/octet-stream',
      'Content-Disposition': `${disposition}; filename="${filename}"`,
      'Content-Length': String(bytes.byteLength),
    },
  });
}
