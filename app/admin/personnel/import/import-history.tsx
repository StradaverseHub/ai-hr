'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Card } from '@/components/ui';
import { toCsv } from '@/lib/csv';
import { importRunOutcome, type ImportRunError, type ImportRunRow } from '@/lib/import-schema';

/**
 * Import History (item cf43c909). Every past employee-import run: who ran it, when, which file, how many
 * records were imported and how many failed — plus the failed rows, downloadable with their reasons so they
 * can be corrected and uploaded again.
 *
 * A CLIENT island only because of that download: the error report is generated in the browser from data the
 * server already sent, exactly like the pre-import error report the preview offers (d8471481). Nothing is
 * fetched here and nothing is written — the list arrives as props from the RSC page.
 *
 * WHAT IS NOT HERE: the uploaded file. It is never stored (migration 0341's header says why — it carries IC,
 * bank and salary for the whole workforce), so "re-run this import" is deliberately not offered. What HR gets
 * is the failed rows and their reasons, which is what a correction actually needs.
 *
 * The outcome badge is DERIVED from the counts via `importRunOutcome`, so the badge and the numbers beside it
 * can never disagree.
 */
export function ImportHistory({ runs }: { runs: ImportRunRow[] }) {
  const t = useTranslations('people.import');
  const [openId, setOpenId] = useState<string | null>(null);

  // Same shape and the same csvSafeCell formula-injection guard as the preview's error report: this echoes
  // user-supplied values back into a file that will be opened in Excel.
  const downloadErrors = (run: ImportRunRow) => {
    const csvOut = toCsv([
      [t('colRow'), t('colName'), t('colEmail'), t('colResult')],
      ...run.errors.map((e: ImportRunError) => [e.rowNum, e.fullName, e.email, e.errors.join('; ')]),
    ]);
    const url = URL.createObjectURL(new Blob([csvOut], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'employee-import-errors.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{t('historyTitle')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('historyHint')}</p>
      </div>

      {runs.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">{t('historyEmpty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('historyColWhen')}</th>
                <th className="px-4 py-2 font-medium">{t('historyColFile')}</th>
                <th className="px-4 py-2 font-medium">{t('colCompany')}</th>
                <th className="px-4 py-2 font-medium">{t('historyColBy')}</th>
                <th className="px-4 py-2 font-medium">{t('historyColResult')}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {runs.map((run) => {
                const outcome = importRunOutcome(run);
                const open = openId === run.id;
                return (
                  <RunRows
                    key={run.id}
                    run={run}
                    outcome={outcome}
                    open={open}
                    onToggle={() => setOpenId(open ? null : run.id)}
                    onDownload={() => downloadErrors(run)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function RunRows({
  run,
  outcome,
  open,
  onToggle,
  onDownload,
}: {
  run: ImportRunRow;
  outcome: 'succeeded' | 'partial' | 'failed';
  open: boolean;
  onToggle: () => void;
  onDownload: () => void;
}) {
  const t = useTranslations('people.import');
  const outcomeCls =
    outcome === 'succeeded'
      ? 'text-emerald-600 dark:text-emerald-400'
      : outcome === 'partial'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-red-600 dark:text-red-400';
  const outcomeLabel =
    outcome === 'succeeded'
      ? t('historyOutcomeSucceeded')
      : outcome === 'partial'
        ? t('historyOutcomePartial')
        : t('historyOutcomeFailed');
  // Rendered in the VIEWER's locale + timezone. A run is a moment in wall-clock time for the person who
  // ran it, not a payroll date, so this is deliberately not routed through the Kuala Lumpur date helper
  // (which answers "what date is it for HR purposes", a different question).
  const when = new Date(run.createdAt).toLocaleString();

  return (
    <>
      <tr className={open ? 'bg-muted/30' : undefined}>
        <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">{when}</td>
        <td className="px-4 py-2 font-medium">
          {run.fileName || <span className="font-normal text-muted-foreground">{t('historyPasted')}</span>}
        </td>
        <td className="px-4 py-2 text-muted-foreground">{run.companyName || '—'}</td>
        <td className="px-4 py-2 text-muted-foreground">{run.actorName || t('historyActorUnknown')}</td>
        <td className="px-4 py-2">
          <span className={outcomeCls}>{outcomeLabel}</span>{' '}
          <span className="text-muted-foreground">
            · {t('historyCounts', { imported: run.importedRows, failed: run.failedRows })}
          </span>
        </td>
        <td className="px-4 py-2 text-right">
          {run.failedRows > 0 && (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted"
            >
              {open ? (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              )}
              {t('historyViewFailed')}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="bg-muted/20 px-4 py-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {run.errorsTruncated
                  ? t('historyErrorsTruncated', { shown: run.errors.length, total: run.failedRows })
                  : t('historyErrorsShown', { count: run.errors.length })}
              </p>
              {run.errors.length > 0 && (
                <button
                  type="button"
                  onClick={onDownload}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                >
                  {t('downloadErrors')}
                </button>
              )}
            </div>
            {run.errors.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('historyNoDetail')}</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {run.errors.map((e) => (
                  <li key={e.rowNum}>
                    <span className="text-muted-foreground">{t('row', { num: e.rowNum })}</span>
                    {(e.fullName || e.email) && ` · ${[e.fullName, e.email].filter(Boolean).join(' · ')}`} —{' '}
                    <span className="text-red-600 dark:text-red-400">{e.errors.join('; ')}</span>
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
