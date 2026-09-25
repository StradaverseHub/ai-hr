import { createHash } from 'node:crypto';
import { getSession } from '@/lib/session';
import { getPersonPhoto } from '@/core/person-photo';

/**
 * Serve an employee profile photo INLINE (it renders in an <img> on the Personnel header and /me).
 * getPersonPhoto runs under RLS — the photo is visible EXACTLY where the employee's name already is
 * (app.can_see_person: self / admin / administrative-manager subtree). An unauthenticated / out-of-scope
 * caller sees nothing (404). Deliberately NOT under /admin so /me and the directory can render it; the RLS
 * predicate is the gate, not the URL prefix.
 *
 * Inline-serving is safe: the stored mime was re-derived from the file's magic bytes at upload (PNG/JPEG
 * only) and X-Content-Type-Options: nosniff stops the browser re-sniffing it into something scriptable
 * (exactly why SVG is excluded from what setPersonPhotoAction accepts).
 */
export async function GET(req: Request, { params }: { params: Promise<{ personId: string }> }) {
  const { personId } = await params;
  const s = await getSession();
  const photo = await getPersonPhoto(s, personId);
  if (!photo) return new Response('Not found', { status: 404 });

  const safe = (name: string) => name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'photo';
  const bytes = new Uint8Array(photo.content);
  // 597c810a — CACHING. The list now renders this URL once per person WITH a photo, so the same bytes are
  // re-fetched on every page of the listing and on every navigation back to it.
  //
  // `private` IS NOT OPTIONAL: this is a face photo behind app.can_see_person, and a shared/proxy cache
  // holding it would serve one viewer's scope to another. `must-revalidate` with NO max-age is the other
  // half — the URL carries no version or content hash, so an admin who REPLACES a photo would otherwise
  // keep being served the old face for the life of the max-age. The browser must ask every time; the ETag
  // is what makes asking cheap (304, no body) instead of free-but-wrong.
  //
  // The ETag is derived from the CONTENT, not from updated_at: a replace that happens to land in the same
  // clock tick still changes the bytes, and a hash cannot be wrong about that.
  const etag = `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 27)}"`;
  const cache = { 'Cache-Control': 'private, must-revalidate', ETag: etag } as const;
  // A conditional request that already holds these bytes gets no body. `If-None-Match` may carry a LIST
  // (and a `W/` weak prefix), so the tag is matched against its members rather than the raw header.
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
