// 6522d26a Fn 6 — ESS download of the employee's OWN probation/review letters (persisted system letter +
// the HR-uploaded signed copy). Authorization is entirely RLS: review_document reads with
// can_see_employment(employment_id), so the subject sees exactly their own documents and a foreign id →
// null → 404 (same pattern as app/me/leave/attachment/[id]/route.ts). Read-only — NO domain event
// (deliberate skip, like every download route).
import { getSession } from '@/lib/session';
import { inlineDisposition } from '@/lib/attachment-response';
import { getReviewDocument } from '@/core/employment-review';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  if (!UUID.test(docId)) return new Response('Not found', { status: 404 });

  const s = await getSession();
  const doc = await getReviewDocument(s, docId); // RLS-gated: null → 404
  if (!doc) return new Response('Not found', { status: 404 });

  const safe = (name: string) => name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'document';
  const disposition = inlineDisposition(req, doc.mimeType);
  const bytes = new Uint8Array(doc.content);
  return new Response(bytes, {
    headers: {
      'Content-Type': doc.mimeType || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${disposition}; filename="${safe(doc.fileName)}"`,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, no-store',
    },
  });
}
