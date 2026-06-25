import { getSession } from '@/lib/session';
import { getPerformanceAttachment } from '@/core/performance';

/** Stream a performance attachment. getPerformanceAttachment runs under RLS (subject + manager + admin). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSession();
  const att = await getPerformanceAttachment(s, id);
  if (!att) return new Response('Not found', { status: 404 });

  const safe = (name: string) => name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'attachment';
  const disposition = new URL(req.url).searchParams.get('inline') === '1' ? 'inline' : 'attachment';
  const bytes = new Uint8Array(att.content);
  return new Response(bytes, {
    headers: {
      'Content-Type': att.mimeType || 'application/octet-stream',
      'Content-Disposition': `${disposition}; filename="${safe(att.fileName)}"`,
      'Content-Length': String(bytes.byteLength),
    },
  });
}
