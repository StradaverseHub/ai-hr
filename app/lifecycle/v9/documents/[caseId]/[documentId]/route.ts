import { requireModule } from '@/lib/authz';
import { v9DownloadDocument } from '@/packs/lifecycle/service';
export async function GET(_request: Request, { params }: { params: Promise<{ caseId: string; documentId: string }> }) {
  try {
    const session = await requireModule('lifecycle'), { caseId, documentId } = await params;
    const file = await v9DownloadDocument(session, caseId, documentId);
    const filename = encodeURIComponent(file.name).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16));
    return new Response(new Uint8Array(file.content), { headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename="document.pdf"; filename*=UTF-8''${filename}` } });
  } catch { return new Response('Document not found or unavailable.', { status: 404, headers: { 'Cache-Control': 'private, no-store' } }); }
}
