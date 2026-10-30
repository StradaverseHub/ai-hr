import { requireModule } from '@/lib/authz';
import { v9DownloadEmailAsset } from '@/packs/lifecycle/service';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireModule('lifecycle'), { id } = await params, asset = await v9DownloadEmailAsset(session, id);
    const filename = encodeURIComponent(asset.name).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16));
    return new Response(new Uint8Array(asset.content), { headers: { 'Content-Type': asset.mimeType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `${asset.mimeType.startsWith('image/') ? 'inline' : 'attachment'}; filename="email-file"; filename*=UTF-8''${filename}` } });
  } catch { return new Response('Email file not found or unavailable.', { status: 404, headers: { 'Cache-Control': 'private, no-store' } }); }
}
