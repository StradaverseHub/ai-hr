// Recruitment slice 12 — a background check's authorisation file or report, for the job's recruiter, assistants and
// recruitment administrators only: the bytes live in recruitment_background_check_file, whose only policies admit them, so a
// hiring manager, an interviewer or anybody else gets the same 404. getBackgroundCheckFile appends the download audit event
// (check id, file id and kind — never the name or the bytes) in the same transaction.
//
// The same response hardening as the candidate file route (nosniff, no caching, sandboxed; only PDF and images inline with
// `?inline=1`).
import { requireModule } from '@/lib/authz';
import { getBackgroundCheckFile } from '@/packs/recruitment/service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INLINE_SAFE = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const HARDENING = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': 'sandbox' } as const;
const notFound = () => new Response('Not found', { status: 404, headers: HARDENING });

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireModule('recruitment');
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const file = await getBackgroundCheckFile(s, id);
  if (!file) return notFound();
  const safe = file.fileName.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'document';
  const disposition = new URL(req.url).searchParams.get('inline') === '1' && INLINE_SAFE.has(file.mimeType) ? 'inline' : 'attachment';
  const bytes = new Uint8Array(file.content);
  return new Response(bytes, {
    headers: { 'Content-Type': file.mimeType, 'Content-Disposition': `${disposition}; filename="${safe}"`, 'Content-Length': String(bytes.byteLength), ...HARDENING },
  });
}
