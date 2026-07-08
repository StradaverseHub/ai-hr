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
export async function GET(_req: Request, { params }: { params: Promise<{ personId: string }> }) {
  const { personId } = await params;
  const s = await getSession();
  const photo = await getPersonPhoto(s, personId);
  if (!photo) return new Response('Not found', { status: 404 });

  const safe = (name: string) => name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'photo';
  const bytes = new Uint8Array(photo.content);
  return new Response(bytes, {
    headers: {
      'Content-Type': photo.mimeType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${safe(photo.fileName)}"`,
      'Content-Length': String(bytes.byteLength),
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
