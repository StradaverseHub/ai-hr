import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { ClockingImportRunRow } from '@/packs/attendance/service';
import { formatDmyTime } from '@/lib/date-display';
import { typeHelpCls } from '@/components/ui/section-card';
import { StackedBody, StackedHead, StackedRow, StackedTable, StackedTd, StackedTh } from '@/components/ui/stacked-table';
import { RunStatusPill } from './run-status';

/**
 * r424 — the import-log list, shared by the logs page and the foot of one log. Most recent first.
 * r427 — a StackedTable: a table on a wide section, one block of labelled values per import on a phone.
 */
export async function RunsTable({ runs, currentId }: { runs: ClockingImportRunRow[]; currentId?: string }) {
  const t = await getTranslations('clockingFile');
  if (runs.length === 0) return <p className={`px-1 py-6 ${typeHelpCls}`}>{t('logs.empty')}</p>;
  const num = 'text-right tabular-nums @max-3xl:text-left';
  return (
    <StackedTable label={t('logs.title')}>
      <StackedHead>
        <StackedTh>{t('logs.colAt')}</StackedTh>
        <StackedTh>{t('logs.colFile')}</StackedTh>
        <StackedTh>{t('logs.colMapping')}</StackedTh>
        <StackedTh>{t('logs.colUser')}</StackedTh>
        <StackedTh className="text-right">{t('logs.colTotal')}</StackedTh>
        <StackedTh className="text-right">{t('logs.colImported')}</StackedTh>
        <StackedTh className="text-right">{t('logs.colFailed')}</StackedTh>
        <StackedTh>{t('logs.colStatus')}</StackedTh>
      </StackedHead>
      <StackedBody>
        {runs.map((r) => (
          <StackedRow key={r.id} className={r.id === currentId ? 'bg-muted/40 monolith:bg-pressed' : ''}>
            <StackedTd label={t('logs.colAt')} role="title" className="whitespace-nowrap tabular-nums">
              {formatDmyTime(r.createdAt)}
            </StackedTd>
            <StackedTd label={t('logs.colFile')} role="full" className="font-medium">
              <Link className="text-primary underline-offset-2 hover:underline monolith:text-ink monolith:underline" href={`/attendance/import/logs/${r.id}`}>
                {r.fileName || '—'}
              </Link>
            </StackedTd>
            <StackedTd label={t('logs.colMapping')}>{r.mappingName || '—'}</StackedTd>
            <StackedTd label={t('logs.colUser')}>{r.userName ?? t('logs.unknownUser')}</StackedTd>
            <StackedTd label={t('logs.colTotal')} className={num}>
              {r.totalLines.toLocaleString('en')}
            </StackedTd>
            <StackedTd label={t('logs.colImported')} className={num}>
              {r.importedLines.toLocaleString('en')}
            </StackedTd>
            <StackedTd label={t('logs.colFailed')} className={num}>
              {r.failedLines.toLocaleString('en')}
            </StackedTd>
            <StackedTd label={t('logs.colStatus')} role="aside" hideLabel>
              <span className="inline-flex flex-wrap items-center gap-2 @max-3xl:justify-end">
                <RunStatusPill status={r.status} label={t(`runStatus.${r.status}`)} />
                {r.status === 'no_records' && r.duplicateLines > 0 && (
                  <span className={typeHelpCls}>{t('logs.duplicatesNote', { count: r.duplicateLines })}</span>
                )}
                {r.status === 'failed' && <span className={typeHelpCls}>{t('logs.stoppedNote')}</span>}
              </span>
            </StackedTd>
          </StackedRow>
        ))}
      </StackedBody>
    </StackedTable>
  );
}
