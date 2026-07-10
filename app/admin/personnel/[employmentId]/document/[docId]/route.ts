// f018ce8d — stream a stored employee document (Personnel → Documents tab). ABAC is inherited from
// getEmployeeDocument → RLS on employee_document (can_see_employment): a foreign or invisible id → 404.
// getEmployeeDocument also appends the `employee-document.downloaded` audit event (expected_function §6).
//
// Security: X-Content-Type-Options: nosniff on every response, and only images / PDF may render inline
// (`?inline=1`) — Office/text/unknown types are ALWAYS forced to attachment so the browser never executes
// or renders untrusted content in the app origin.
import { getSession } from '@/lib/session';
import { getEmployeeDocument } from '@/core/employee-documents';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INLINE_SAFE = new Set(['application/pdf', 'image/jpeg', 'image/png']);

export async function GET(req: Request, { params }: { params: Promise<{ employmentId: string; docId: string }> }) {
  const { employmentId, docId } = await params;
  if (!UUID.test(docId) || !UUID.test(employmentId)) return new Response('Not found', { status: 404 });

  const s = await getSession();
  const doc = await getEmployeeDocument(s, docId); // RLS-gated: null → 404
  if (!doc || doc.employmentId !== employmentId) return new Response('Not found', { status: 404 });

  const safe = (name: string) => name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'document';
  const wantsInline = new URL(req.url).searchParams.get('inline') === '1';
  const disposition = wantsInline && INLINE_SAFE.has(doc.mimeType) ? 'inline' : 'attachment';
  const bytes = new Uint8Array(doc.content);
  return new Response(bytes, {
    headers: {
      'Content-Type': doc.mimeType || 'application/octet-stream',
      'Content-Disposition': `${disposition}; filename="${safe(doc.fileName)}"`,
      'Content-Length': String(bytes.byteLength),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}
