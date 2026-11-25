/**
 * POST /personnel/list — the People directory's list only (ADR 0181 Phase 4, list-only filters).
 *
 * A filter, chip, page-size or pager step on /personnel fetches this instead of rendering the page again, so the
 * frame and the page's other reads (companies, departments) do not run. It answers exactly what the page answers
 * for the same parameters (app/personnel/directory-view.ts renders both), under the same authority: the signed-in
 * session and its company switcher scope from scopedSession(), with row security deciding every row. It fails
 * closed: no session is 401, a cross-origin caller 403, any body other than a small JSON object of the directory's
 * own string parameters 400. POST keeps the search term out of the URL and access logs; the page writes the address
 * itself. Read-only: no event, no write.
 */
import { capacityAwareRoute } from '@/lib/database-degraded';
import { scopedSession } from '@/lib/scope';
import { AuthRequiredError } from '@/lib/auth-errors';
import { isSameOriginBrowserRequest } from '@/lib/request-origin';
import { DIRECTORY_PARAMS, directoryParams } from '../directory-params';
import { directoryView } from '../directory-view';

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization', 'X-Content-Type-Options': 'nosniff' };
class DirectoryListInputError extends Error {}

async function body(request: Request) {
  if (new URL(request.url).search || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '') || !request.body)
    throw new DirectoryListInputError();
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new DirectoryListInputError(); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new DirectoryListInputError(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DirectoryListInputError();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !(DIRECTORY_PARAMS as readonly string[]).includes(key) || typeof input[key] !== 'string' || (input[key] as string).length > 200))
    throw new DirectoryListInputError();
  return directoryParams(input);
}

export const POST = capacityAwareRoute(async function POST(request: Request) {
  if (!isSameOriginBrowserRequest(request)) return Response.json({ error: 'origin' }, { status: 403, headers });
  try {
    const { s, scopeIds } = await scopedSession();
    const params = await body(request);
    return Response.json(await directoryView(s, scopeIds, params), { headers });
  } catch (error) {
    const status = error instanceof AuthRequiredError ? 401 : error instanceof DirectoryListInputError || error instanceof RangeError ? 400 : 503;
    return Response.json({ error: status === 401 ? 'authentication' : status === 400 ? 'invalid' : 'unavailable' }, { status, headers });
  }
});
