import { scopedAdmin } from '@/lib/scope';
import { readWorkbookList, workbookListActive, workbookListSignature } from '../list';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };

/**
 * Whether the caller's workbook list has changed, for the list page's poll while a workbook is preparing. One small
 * read, where router.refresh() would re-render the whole app shell every few seconds (refresh.tsx). Ids and states
 * only: the page itself, under the same scopedAdmin() fence, shows what they are.
 */
export async function GET() {
  const { s, scopeIds } = await scopedAdmin();
  const jobs = await readWorkbookList(s, scopeIds);
  return Response.json({ active: workbookListActive(jobs), signature: workbookListSignature(jobs) }, { headers });
}
