import type { SessionContext } from '@/db/client';
import { listBulkJobsTx } from '@/core/bulk-job';
import { TRANSACTION_EXPORT_KIND } from '@/core/payroll-transaction-export';
import { withPayrollTenant } from '@/core/module-gate';
import { bulkJobActive, type BulkJobState } from '@/lib/bulk-job';

/**
 * The caller's own recent transaction workbooks, kept only when every company in them is still in scope. The list
 * page and its status poll read through this one function, so they agree on which jobs the screen shows.
 */
export async function readWorkbookList(s: SessionContext, scopeIds: readonly string[]) {
  return (await withPayrollTenant(s, (tx) => listBulkJobsTx(tx, s, TRANSACTION_EXPORT_KIND, 25)))
    .filter((item) => item.company_ids.length > 0 && item.company_ids.every((id) => scopeIds.includes(id)));
}

/** Changes exactly when a row appears, disappears or changes state: the moment the list is worth re-rendering. */
export function workbookListSignature(jobs: readonly { id: string; state: string }[]): string {
  return jobs.map((job) => `${job.id}:${job.state}`).join(',');
}

export function workbookListActive(jobs: readonly { state: BulkJobState }[]): boolean {
  return jobs.some((job) => bulkJobActive(job.state));
}
