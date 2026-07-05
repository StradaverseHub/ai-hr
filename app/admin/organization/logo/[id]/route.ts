import { getSession } from '@/lib/session';
import { getCompanyLogo } from '@/core/admin';

/**
 * Serve a company logo INLINE (it renders in an <img> on the org screen). getCompanyLogo runs under RLS —
 * any same-tenant member may read a logo (branding, matching the company row's own visibility); an
 * unauthenticated / cross-tenant caller sees nothing (404). Access is RLS-scoped, NOT admin-only, and this
 * route is NOT public to the outside internet.
 *
 * Inline-serving is safe here because the stored mime was re-derived from the file's magic bytes at upload
 * (PNG/JPEG only) and X-Content-Type-Options: nosniff stops the browser from re-sniffing it into something
 * scriptable. This is exactly why SVG is excluded from what setCompanyLogoAction accepts.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSession();
  const att = await getCompanyLogo(s, id);
  if (!att) return new Response('Not found', { status: 404 });

  const safe = (name: string) => name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'logo';
  const bytes = new Uint8Array(att.content);
  return new Response(bytes, {
    headers: {
      'Content-Type': att.mimeType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${safe(att.fileName)}"`,
      'Content-Length': String(bytes.byteLength),
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
