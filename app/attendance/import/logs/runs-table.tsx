import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { ClockingImportRunRow } from '@/packs/attendance/service';
import { formatDmyTime } from '@/lib/date-display';
import { RunStatusPill } from './run-status';

/** r424 — the import-log list, shared by the logs page and the foot of one log. Most recent first. */
export async function RunsTable({ runs, currentId }: { runs: ClockingImportRunRow[]; currentId?: string }) {
  const t = await getTranslations('clockingFile');
  const th = 'px-3 py-2 font-medium';
  if (runs.length === 0) return <p className="px-1 py-6 text-sm text-muted-foreground">{t('logs.empty')}</p>;
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className={th}>{t('logs.colAt')}</th>
            <th className={th}>{t('logs.colFile')}</th>
            <th className={th}>{t('logs.colMapping')}</th>
            <th className={th}>{t('logs.colUser')}</th>
            <th className={`${th} text-right`}>{t('logs.colTotal')}</th>
            <th className={`${th} text-right`}>{t('logs.colImported')}</th>
            <th className={`${th} text-right`}>{t('logs.colFailed')}</th>
            <th className={th}>{t('logs.colStatus')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {runs.map((r) => (
            <tr key={r.id} className={r.id === currentId ? 'bg-muted/40' : ''}>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums">{formatDmyTime(r.createdAt)}</td>
              <td className="px-3 py-2 font-medium">
                <Link className="text-primary underline-offset-2 hover:underline" href={`/attendance/import/logs/${r.id}`}>
                  {r.fileName || '—'}
                </Link>
              </td>
              <td className="px-3 py-2">{r.mappingName || '—'}</td>
              <td className="px-3 py-2">{r.userName ?? t('logs.unknownUser')}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.totalLines.toLocaleString('en')}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.importedLines.toLocaleString('en')}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.failedLines.toLocaleString('en')}</td>
              <td className="px-3 py-2">
                <span className="inline-flex flex-wrap items-center gap-2">
                  <RunStatusPill status={r.status} label={t(`runStatus.${r.status}`)} />
                  {r.status === 'no_records' && r.duplicateLines > 0 && (
                    <span className="text-xs text-muted-foreground">{t('logs.duplicatesNote', { count: r.duplicateLines })}</span>
                  )}
                  {r.status === 'failed' && <span className="text-xs text-muted-foreground">{t('logs.stoppedNote')}</span>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
