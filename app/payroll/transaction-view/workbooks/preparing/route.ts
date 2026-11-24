import { transactionWorkbooksPreparing } from '@/core/payroll-transaction-export';
import { scopedAdmin } from '@/lib/scope';

export const runtime = 'nodejs';

/** The Workbooks page's poll while a workbook is being prepared: one small read of the viewer's own jobs, the same rows
 * and scope the page shows, instead of re-rendering the whole page and app shell every few seconds. A read only. */
export async function GET() {
  const { s, scopeIds } = await scopedAdmin();
  const preparing = await transactionWorkbooksPreparing(s, scopeIds);
  return Response.json({ preparing }, { headers: { 'Cache-Control': 'private, no-store' } });
}
