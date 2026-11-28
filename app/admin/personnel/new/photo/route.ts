import { createHash } from 'node:crypto';
import { requireAdmin } from '@/lib/authz';
import { getEmployeeDraftPhoto } from '@/core/employee-draft-photo';

/**
 * Board 2c1b2fba — serve a DRAFT employee's profile photo inline for the Draft Employee page's header card
 * (`?draft=<draftId>`). Guarded like the draft page itself (requireAdmin), and the read runs under row security
 * (7610: the photo is visible exactly where its draft is), so an out-of-scope caller gets 404. Inline-serving is safe
 * for the same reason as /personnel/photo: the stored type was sniffed from the bytes (PNG/JPEG only) and nosniff
 * stops the browser re-sniffing it. `private, must-revalidate` + a content ETag, as the record's photo route.
 */
export async function GET(req: Request) {
  const s = await requireAdmin();
  const draftId = new URL(req.url).searchParams.get('draft') ?? '';
  const photo = await getEmployeeDraftPhoto(s, draftId);
  if (!photo) return new Response('Not found', { status: 404 });
  const safe = (name: string) => name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'photo';
  const bytes = new Uint8Array(photo.content);
  const etag = `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 27)}"`;
  const cache = { 'Cache-Control': 'private, must-revalidate', ETag: etag } as const;
  const inm = req.headers.get('if-none-match');
  if (inm) {
    const held = inm.split(',').map((t) => t.trim().replace(/^W\//, ''));
    if (held.includes(etag) || held.includes('*')) return new Response(null, { status: 304, headers: cache });
  }
  return new Response(bytes, {
    headers: {
      'Content-Type': photo.mimeType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${safe(photo.fileName)}"`,
      'Content-Length': String(bytes.byteLength),
      'X-Content-Type-Options': 'nosniff',
      ...cache,
    },
  });
}
