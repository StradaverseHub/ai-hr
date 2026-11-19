import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import { BulkJobError } from '@/core/bulk-job';
import { readFixedTransactionImport } from '@/core/fixed-transaction-import-job';
import { bulkJobActive, bulkJobPercent } from '@/lib/bulk-job';
import { FIXED_TXN_IMPORT_LOG, fixedImportLogStatus } from '@/lib/fixed-transaction-import-log';
import { formatImportBatch } from '@/lib/import-reference';
import { scopedAdmin } from '@/lib/scope';
import { ImportBatchControls } from '../../../individual/imports/batches/[jobId]/batch-controls';

export default async function FixedTransactionImportDetail({ params }: { params: Promise<{ id: string }> }) {
  const { s, scopeIds } = await scopedAdmin();
  const { id } = await params;
  const job = await readFixedTransactionImport(s, id, scopeIds).catch((error) => {
    if (error instanceof BulkJobError) notFound();
    throw error;
  });
  const [t, labels, txn] = await Promise.all([
    getTranslations('payroll.individualImport'), getTranslations('importLog'), getTranslations('payroll.txnImport'),
  ]);
  const failed = (job.counters.invalid ?? 0) + (job.counters.failed ?? 0);
  const active = bulkJobActive(job.state);
  const status = job.state === 'completed' && failed
    ? t('completedWithErrors') : t(`batchState.${fixedImportLogStatus[job.state]}`);
  return (
    <div className={pageWideCls}>
      <PageHeader title={formatImportBatch(labels, job.id)} description={job.sourceName}
        back={{ href: FIXED_TXN_IMPORT_LOG, label: t('log') }}
        actions={failed > 0 && (
          <Link className="inline-flex rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
            href={`${FIXED_TXN_IMPORT_LOG}/${id}/errors`}>{txn('downloadErrors')}</Link>
        )}
      />
      <ImportBatchControls id={job.id} running={active} canConfirm={false} />
      <Card className="mb-4 p-4">
        <p className="font-medium">{status}</p>
        <p className="text-sm text-muted-foreground">{t('batchCounts', {
          total: job.counters.total ?? 0, written: job.counters.written ?? 0, failed,
        })}</p>
        {active && <progress className="mt-2 w-full" value={bulkJobPercent(job)} max={100} aria-label={t('progress')} />}
        {job.error && (
          <p className="text-sm text-destructive">
            {txn.has(`fileError.${job.error}` as never) ? txn(`fileError.${job.error}` as never) : t('importFailed')}
          </p>
        )}
      </Card>
      {job.rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/50">
              <tr>{(['row', 'employee', 'payItem', 'outcome'] as const).map((key) => <th key={key} className="p-3">{t(key)}</th>)}</tr>
            </thead>
            <tbody>
              {job.rows.map(({ rowNum, employeeId, payItemCode, state, reason, detail }) => (
                <tr key={rowNum} className="border-t border-border">
                  <td className="p-3">{rowNum}</td><td className="p-3">{employeeId}</td><td className="p-3">{payItemCode}</td>
                  <td className="p-3">
                    {reason
                      ? reason !== 'unexpected' && txn.has(`reason.${reason}` as never)
                        ? txn(`reason.${reason}` as never, (detail ?? {}) as never) : t('importFailed')
                      : state === 'pending' ? t('batchState.pending') : t('imported')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
