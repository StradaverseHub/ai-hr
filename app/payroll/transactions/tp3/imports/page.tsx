import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { PageHeader, pageWideCls } from '@/components/ui';
import { listTp3Imports } from '@/core/tp3-import-job';
import { TP3_IMPORT_LOG } from '@/lib/tp3-import-columns';
import { scopedAdmin } from '@/lib/scope';

/**
 * 5084d02e — the Form TP3 Import Log: every TP3 import of the companies the viewer administers, whoever ran it, newest
 * first, 50 a page by key. One read (app.tp3_import_log, migration 7570) whatever the number of companies. The log
 * keeps each import's details and row results, never the uploaded file.
 */
export default async function Tp3ImportLogPage({ searchParams }: { searchParams: Promise<{ before?: string; beforeId?: string }> }) {
  const { s, scopeIds } = await scopedAdmin();
  const { before, beforeId } = await searchParams;
  const cursor = z.object({ at: z.iso.datetime(), id: z.uuid() }).safeParse({ at: before, id: beforeId });
  const [jobs, t, formatter] = await Promise.all([
    listTp3Imports(s, scopeIds, cursor.data),
    getTranslations('payroll.tp3Import'),
    getFormatter(),
  ]);
  const items = jobs.slice(0, 50);
  const last = items.at(-1);
  return (
    <div className={pageWideCls}>
      <PageHeader title={t('log.title')} description={t('log.intro')} back={{ href: '/payroll/transactions/tp3', label: t('log.back') }} />
      <p className="text-xs text-muted-foreground">{t('log.keepCopy')}</p>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="p-3">{t('log.colFile')}</th>
              <th className="p-3">{t('log.colUploadedBy')}</th>
              <th className="p-3">{t('log.colWhen')}</th>
              <th className="p-3 text-right">{t('log.colRows')}</th>
              <th className="p-3 text-right">{t('log.colSaved')}</th>
              <th className="p-3 text-right">{t('log.colFailed')}</th>
              <th className="p-3">{t('log.colStatus')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((job) => (
              <tr key={job.id} className="border-t border-border">
                <td className="p-3">
                  <Link className="break-all font-medium text-primary underline" href={`${TP3_IMPORT_LOG}/${job.id}`}>{job.sourceName || '—'}</Link>
                </td>
                <td className="p-3">{job.uploadedBy ?? t('log.unavailableUser')}</td>
                <td className="whitespace-nowrap p-3">{formatter.dateTime(new Date(job.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}</td>
                <td className="p-3 text-right tabular-nums">{job.total}</td>
                <td className="p-3 text-right tabular-nums text-emerald-700 dark:text-emerald-400">{job.saved}</td>
                <td className="p-3 text-right tabular-nums text-destructive">{job.failed}</td>
                <td className="p-3">{t(`status.${job.status}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && <p className="p-6 text-muted-foreground">{t('log.empty')}</p>}
      </div>
      {jobs.length > 50 && last && (
        <Link className="mt-4 inline-flex rounded-lg border border-border px-4 py-2"
          href={`?before=${encodeURIComponent(last.cursorAt)}&beforeId=${last.id}`}>{t('log.older')}</Link>
      )}
    </div>
  );
}
