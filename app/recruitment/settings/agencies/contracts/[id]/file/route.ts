// Recruitment slice 10 — the agency contract PDF, for the company's recruitment administrators only: the bytes live in
// recruitment_agency_contract_terms, whose only policy admits them, so anybody else gets the same 404. getAgencyContractFile
// appends the download audit event (contract id and size — never the name or the bytes) in the same transaction.
//
// The same response hardening as the candidate file route (nosniff, no caching, sandboxed).
import { requireModule } from '@/lib/authz';
import { getAgencyContractFile } from '@/packs/recruitment/service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HARDENING = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': 'sandbox' } as const;
const notFound = () => new Response('Not found', { status: 404, headers: HARDENING });

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireModule('recruitment');
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const file = await getAgencyContractFile(s, id);
  if (!file) return notFound();
  const safe = file.fileName.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'contract.pdf';
  const bytes = new Uint8Array(file.content);
  return new Response(bytes, {
    headers: { 'Content-Type': file.mimeType, 'Content-Disposition': `attachment; filename="${safe}"`, 'Content-Length': String(bytes.byteLength), ...HARDENING },
  });
}
