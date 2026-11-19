import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { PageHeader, pageWideCls } from '@/components/ui';
import { listFixedTransactionImports } from '@/core/fixed-transaction-import-job';
import { bulkJobPercent } from '@/lib/bulk-job';
import { FIXED_TXN_IMPORT_LOG, fixedImportLogStatus } from '@/lib/fixed-transaction-import-log';
import { formatImportBatch } from '@/lib/import-reference';
import { scopedAdmin } from '@/lib/scope';

export default async function FixedTransactionImportLog({ searchParams }: {
  searchParams: Promise<{ before?: string; beforeId?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const { before, beforeId } = await searchParams;
  const cursor = z.object({ at: z.iso.datetime(), id: z.uuid() }).safeParse({ at: before, id: beforeId });
  const [jobs, t, labels, fixed, formatter] = await Promise.all([
    listFixedTransactionImports(s, scopeIds, cursor.data),
    getTranslations('payroll.individualImport'),
    getTranslations('importLog'),
    getTranslations('payroll.transactions.fixed'),
    getFormatter(),
  ]);
  const items = jobs.slice(0, 50);
  const last = items.at(-1);
  return (
    <div className={pageWideCls}>
      <PageHeader title={t('log')} back={{ href: '/payroll/transactions/fixed', label: fixed('title') }} />
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50">
            <tr>{(['reference', 'time', 'outcome', 'progress', 'details'] as const).map((key) =>
              <th key={key} className="p-3">{t(key)}</th>)}</tr>
          </thead>
          <tbody>{items.map((job) => {
            const href = `${FIXED_TXN_IMPORT_LOG}/${job.id}`;
            const failed = (job.counters.invalid ?? 0) + (job.counters.failed ?? 0);
            return (
              <tr key={job.id} className="border-t border-border">
                <td className="p-3">
                  <Link className="font-medium text-primary underline" href={href}>{formatImportBatch(labels, job.id)}</Link>
                  <p className="break-all text-xs text-muted-foreground">{job.sourceName}</p>
                </td>
                <td className="p-3">{formatter.dateTime(new Date(job.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}</td>
                <td className="p-3">
                  <p>{job.state === 'completed' && failed ? t('completedWithErrors') : t(`batchState.${fixedImportLogStatus[job.state]}`)}</p>
                  <p className="text-xs text-muted-foreground">{t('batchCounts', {
                    total: job.counters.total ?? 0, written: job.counters.written ?? 0, failed,
                  })}</p>
                </td>
                <td className="p-3">{bulkJobPercent(job)}%</td>
                <td className="p-3"><Link className="text-primary underline" href={href}>{t('details')}</Link></td>
              </tr>
            );
          })}</tbody>
        </table>
        {!items.length && <p className="p-6 text-muted-foreground">{t('empty')}</p>}
      </div>
      {jobs.length > 50 && last && (
        <Link className="mt-4 inline-flex rounded-lg border border-border px-4 py-2"
          href={`?before=${encodeURIComponent(last.createdAt)}&beforeId=${last.id}`}>{t('older')}</Link>
      )}
    </div>
  );
}
