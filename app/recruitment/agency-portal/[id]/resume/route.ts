// Recruitment slice 25 — the résumé an agency attached to a portal submission still waiting in the inbox, for the job's operators
// (anything else is a 404). Hardened as the candidate file route: never sniffed or cached, sandboxed, always a download.
import { requireModule } from '@/lib/authz';
import { agencyPortalResume } from '@/packs/recruitment/service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HARDENING = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': 'sandbox' } as const;
const notFound = () => new Response('Not found', { status: 404, headers: HARDENING });

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireModule('recruitment');
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const file = await agencyPortalResume(s, id);
  if (!file) return notFound();
  const safe = (name: string) => name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'document';
  const bytes = new Uint8Array(file.content);
  return new Response(bytes, {
    headers: { 'Content-Type': file.mimeType, 'Content-Disposition': `attachment; filename="${safe(file.fileName)}"`, 'Content-Length': String(bytes.byteLength), ...HARDENING },
  });
}
