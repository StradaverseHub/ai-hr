import { getSession } from '@/lib/session';
import { getResignationAttachmentById } from '@/core/offboarding';

/** #42cff598 (ADR-0042): stream a resignation's supporting document (e.g. a signed resignation letter).
 *  getResignationAttachmentById runs under RLS (subject + manager + admin via can_see_employment), so the
 *  route stays thin. `id` is the attachment id. Copied verbatim from the leave attachment route. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSession();
  const att = await getResignationAttachmentById(s, id);
  if (!att) return new Response('Not found', { status: 404 });

  const safe = (name: string) => name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'document';
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
