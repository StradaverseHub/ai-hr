import { getSession } from '@/lib/session';
import { AuthRequiredError } from '@/lib/auth-errors';
import { readMobileBackground } from '@/core/mobile-backgrounds';

/** Protected preview delivery; original uploads and cross-tenant artwork are never served. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const s = await getSession();
    const { id } = await context.params;
    const content = await readMobileBackground(s, id);
    if (!content) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return new Response(new Uint8Array(content), { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(content.byteLength), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' } });
  } catch (e) {
    return new Response(null, { status: e instanceof AuthRequiredError ? 401 : 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
