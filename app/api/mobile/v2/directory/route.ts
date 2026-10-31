/**
 * GET /api/mobile/v2/directory?q&offset&limit — the web's read-only People directory (app/(app)/personnel/page.tsx) for
 * the app: active colleagues the caller may see, by name, with the fields the web directory already shows them.
 * The request rules are about SHAPE only (lib/mobile-api/v2/directory.ts); who is visible is RLS's, as on the web.
 */
import { staffDirectoryPageV2 } from '@/core/mobile-directory';
import { oneParam } from '@/lib/mobile-api/attendance-routes';
import { mobileRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { DIRECTORY_OFFSET_MAX, DIRECTORY_PAGE_DEFAULT, DIRECTORY_PAGE_MAX, DIRECTORY_QUERY_MAX, DirectoryPageV2 } from '@/lib/mobile-api/v2/directory';

function directoryQueryOf(url: URL): { q?: string; offset: number; limit: number } {
  const rawQ = oneParam(url, 'q'), rawOffset = oneParam(url, 'offset'), rawLimit = oneParam(url, 'limit');
  const q = rawQ?.trim() || undefined;
  if (q && q.length > DIRECTORY_QUERY_MAX) throw new MobileBadRequest('Search too long');
  let offset = 0, limit = DIRECTORY_PAGE_DEFAULT;
  if (rawOffset !== undefined) {
    if (!/^\d{1,6}$/.test(rawOffset)) throw new MobileBadRequest('Invalid offset');
    offset = Number(rawOffset);
    if (offset > DIRECTORY_OFFSET_MAX) throw new MobileBadRequest('Invalid offset');
  }
  if (rawLimit !== undefined) {
    if (!/^\d{1,2}$/.test(rawLimit)) throw new MobileBadRequest('Invalid limit');
    limit = Number(rawLimit);
    if (limit < 1 || limit > DIRECTORY_PAGE_MAX) throw new MobileBadRequest('Invalid limit');
  }
  return { q, offset, limit };
}

export const GET = mobileRoute(DirectoryPageV2, async (s, req) => staffDirectoryPageV2(s, directoryQueryOf(new URL(req.url))));
