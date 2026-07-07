// 6522d26a — stream a stored review document (persisted system letter / HR-uploaded signed copy) from the
// admin profile review section. ABAC is inherited from getReviewDocument → RLS on review_document
// (can_see_employment): a foreign or invisible id → 404, mirroring the letter route and
// app/me/leave/attachment/[id]/route.ts. Read-only — NO domain event (deliberate skip, like the letter route).
import { getSession } from '@/lib/session';
import { getReviewDocument } from '@/core/employment-review';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ reviewId: string; docId: string }> }) {
  const { reviewId, docId } = await params;
  if (!UUID.test(docId) || !UUID.test(reviewId)) return new Response('Not found', { status: 404 });

  const s = await getSession();
  const doc = await getReviewDocument(s, docId); // RLS-gated: null → 404
  if (!doc || doc.reviewId !== reviewId) return new Response('Not found', { status: 404 });

  const safe = (name: string) => name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'document';
  const disposition = new URL(req.url).searchParams.get('inline') === '1' ? 'inline' : 'attachment';
  const bytes = new Uint8Array(doc.content);
  return new Response(bytes, {
    headers: {
      'Content-Type': doc.mimeType || 'application/octet-stream',
      'Content-Disposition': `${disposition}; filename="${safe(doc.fileName)}"`,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, no-store',
    },
  });
}
