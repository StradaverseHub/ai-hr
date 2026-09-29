import { getSession } from '@/lib/session';
import { inlineDisposition } from '@/lib/attachment-response';
import { getLeaveAttachment } from '@/core/leave';

/** Stream a leave request's supporting document (e.g. MC). getLeaveAttachment runs under RLS
 *  (subject + manager + admin via can_see_employment). `id` is the leave request id. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSession();
  const att = await getLeaveAttachment(s, id);
  if (!att) return new Response('Not found', { status: 404 });

  const safe = (name: string) => name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'document';
  const disposition = inlineDisposition(req, att.mimeType);
  const bytes = new Uint8Array(att.content);
  return new Response(bytes, {
    headers: {
      'Content-Type': att.mimeType || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${disposition}; filename="${safe(att.fileName)}"`,
      'Content-Length': String(bytes.byteLength),
    },
  });
}
