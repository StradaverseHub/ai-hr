import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import { BulkJobError } from '@/core/bulk-job';
import { readTp3Import } from '@/core/tp3-import-job';
import { bulkJobActive, bulkJobPercent } from '@/lib/bulk-job';
import { TP3_IMPORT_LOG } from '@/lib/tp3-import-columns';
import { scopedAdmin } from '@/lib/scope';
import { tp3ColumnLabel, tp3RowResult } from '../../tp3-import-text';
import { RefreshWhileRunning } from './refresh-while-running';

/**
 * 5084d02e — one Form TP3 import: its progress while it runs, its totals, and every row's result with its reason.
 * A check that was never confirmed says so: the uploaded file is not kept, so saving its rows means importing the
 * file again from Form TP3.
 */
export default async function Tp3ImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { s, scopeIds } = await scopedAdmin();
  const { id } = await params;
  const job = await readTp3Import(s, id, scopeIds).catch((error) => {
    if (error instanceof BulkJobError) notFound();
    throw error;
  });
  const [t, formatter] = await Promise.all([getTranslations('payroll.tp3Import'), getFormatter()]);
  const active = bulkJobActive(job.state);
  const problems = job.rows.some((row) => row.reason);
  const tone = (state: string) =>
    state === 'saved' || state === 'ready' ? 'text-emerald-700 dark:text-emerald-400'
      : state === 'formOnly' ? 'text-amber-700 dark:text-amber-400'
        : state === 'problem' || state === 'failed' || state === 'notSaved' ? 'text-destructive' : 'text-muted-foreground';
  return (
    <div className={pageWideCls}>
      <PageHeader title={job.sourceName || t('log.title')} back={{ href: TP3_IMPORT_LOG, label: t('log.title') }}
        description={t('log.uploaded', {
          name: job.uploadedBy ?? t('log.unavailableUser'),
          at: formatter.dateTime(new Date(job.createdAt), { dateStyle: 'medium', timeStyle: 'short' }),
        })}
        actions={problems && (
          <a className="inline-flex rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted" href={`${TP3_IMPORT_LOG}/${job.id}/errors`}>
            {t('downloadProblems')}
          </a>
        )}
      />
      <RefreshWhileRunning running={active} />
      <Card className="space-y-2 p-4">
        <p className="font-medium">{t(`status.${job.status}`)}</p>
        <p className="text-sm text-muted-foreground">
          {t('log.counts', { total: job.total, saved: job.saved, unchanged: job.unchanged, failed: job.failed })}
        </p>
        {active && <progress className="w-full" value={bulkJobPercent(job)} max={100} aria-label={t('log.progress')} />}
        {job.status === 'failed' && (
          <p className="text-sm text-destructive">
            {job.error && t.has(`fileError.${job.error}` as never)
              ? t(`fileError.${job.error}` as never, (job.fileDetail ?? {}) as never)
              : t('fileError.failed')}
          </p>
        )}
        {job.mode === 'check' && job.status === 'checked' && (job.savedAs
          ? <Link className="text-sm text-primary underline" href={`${TP3_IMPORT_LOG}/${job.savedAs}`}>{t('log.openSaved')}</Link>
          : <p className="text-sm text-muted-foreground">{t('log.checkedNotSaved')}</p>)}
        {job.mode === 'save' && <p className="text-xs text-muted-foreground">{t('log.replaceNote')}</p>}
      </Card>
      {job.rows.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-3">{t('colRow')}</th>
                <th className="p-3">{t('colEmployeeId')}</th>
                <th className="p-3">{t('colYear')}</th>
                <th className="p-3">{t('colColumn')}</th>
                <th className="p-3">{t('colResult')}</th>
              </tr>
            </thead>
            <tbody>
              {job.rows.map((row) => (
                <tr key={row.rowNum} className="border-t border-border">
                  <td className="p-3 tabular-nums">{row.rowNum}</td>
                  <td className="p-3 font-mono text-xs">{row.employeeId || '—'}</td>
                  <td className="p-3 tabular-nums">{row.year ?? '—'}</td>
                  <td className="p-3">{tp3ColumnLabel(t, row.field)}</td>
                  <td className={`p-3 ${tone(row.state)}`}>{tp3RowResult(t, row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !active && <p className="text-sm text-muted-foreground">{t('log.noRows')}</p>
      )}
    </div>
  );
}
