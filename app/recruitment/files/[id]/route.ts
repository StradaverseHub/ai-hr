// Recruitment slice 5 — stream a candidate's resume or attachment. Access is the service's and row security's: the
// resume for anyone who may read one of the candidate's applications, other attachments for administrators and the
// candidate's job operators; anything else is a 404. getCandidateFile appends the download audit event (file id, kind
// and size — never the name or the bytes) in the same transaction.
//
// Response hardening as the personnel document route (nosniff, no caching, only PDF and images inline with `?inline=1`)
// plus `Content-Security-Policy: sandbox` on every response.
import { requireModule } from '@/lib/authz';
import { getCandidateFile } from '@/packs/recruitment/service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INLINE_SAFE = new Set(['application/pdf', 'image/jpeg', 'image/png']);
/** Every response, the 404 included: never sniffed, never cached, and sandboxed so an uploaded file cannot run in the app's origin. */
const HARDENING = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': 'sandbox' } as const;
const notFound = () => new Response('Not found', { status: 404, headers: HARDENING });

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireModule('recruitment');
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const file = await getCandidateFile(s, id);
  if (!file) return notFound();
  const safe = (name: string) => name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'document';
  const disposition = new URL(req.url).searchParams.get('inline') === '1' && INLINE_SAFE.has(file.mimeType) ? 'inline' : 'attachment';
  const bytes = new Uint8Array(file.content);
  return new Response(bytes, {
    headers: {
      'Content-Type': file.mimeType,
      'Content-Disposition': `${disposition}; filename="${safe(file.fileName)}"`,
      'Content-Length': String(bytes.byteLength),
      ...HARDENING,
    },
  });
}
