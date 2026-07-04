'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { DownloadTemplate } from '@/components/download-template';
import { leaveImportTemplate } from '@/lib/import-template';
import { toCsv } from '@/lib/csv';
import {
  LEAVE_IMPORT_COLUMNS,
  type LeaveImportPreview,
  type LeaveImportResult,
} from '@/lib/leave-import-schema';
import { validateLeaveImportAction, commitLeaveImportAction } from './actions';

const SAMPLE = `employee_id,leave_type,transaction_type,days,effective_date
E1001,ANNUAL,adjustment,5,2026-01-01
E1001,ANNUAL,debit,-2,2026-03-14
E1002,ANNUAL,accrual,14,2026-01-01`;

type Phase = 'idle' | 'previewed' | 'done';

export function LeaveLedgerImport() {
  const t = useTranslations('admin.leave.import');
  const router = useRouter();
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<LeaveImportPreview | null>(null);
  const [result, setResult] = useState<LeaveImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [pending, startTransition] = useTransition();

  // Any edit invalidates a stale preview/result — force a fresh validate before importing.
  const reset = () => {
    setPreview(null);
    setResult(null);
    setPhase('idle');
    setError(null);
  };

  const validate = () =>
    startTransition(async () => {
      setError(null);
      try {
        const p = await validateLeaveImportAction(csv);
        setPreview(p);
        setResult(null);
        setPhase('previewed');
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const commit = () =>
    startTransition(async () => {
      setError(null);
      try {
        const r = await commitLeaveImportAction(csv);
        setResult(r);
        setPhase('done');
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    });

  // Function 5: client-side error report of just the failed rows (rowNum, employee_id as given, message).
  // Uses toCsv's csvSafeCell formula-injection guard since it echoes back user-supplied cell values.
  const downloadErrors = (rows: { rowNum: number; employeeRef: string; message: string }[]) => {
    const csvOut = toCsv([
      [t('colRow'), 'employee_id', t('colMessage')],
      ...rows.map((r) => [r.rowNum, r.employeeRef, r.message]),
    ]);
    const url = URL.createObjectURL(new Blob([csvOut], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'leave-import-errors.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <Field label={t('csvData')}>
          <textarea
            className={`${inputCls} h-44 resize-y font-mono text-xs leading-relaxed`}
            placeholder={t('csvPlaceholder')}
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              reset();
            }}
            spellCheck={false}
          />
        </Field>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={validate} disabled={pending || !csv.trim()}>
            {pending && phase !== 'done' ? t('validating') : t('validate')}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setCsv(SAMPLE);
              reset();
            }}
            disabled={pending}
          >
            {t('loadSample')}
          </Button>
          <DownloadTemplate spec={leaveImportTemplate} />
        </div>

        <details className="mt-4 border-t border-border pt-3 text-xs">
          <summary className="cursor-pointer select-none font-medium text-muted-foreground">
            {t('columnReference')}
          </summary>
          <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground sm:grid-cols-3">
            {LEAVE_IMPORT_COLUMNS.required.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-muted-foreground">{t('columnHint')}</p>
        </details>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      {result && (
        <Card className="overflow-hidden border-emerald-200 dark:border-emerald-500/30">
          <div className="border-b border-border bg-emerald-50/60 px-4 py-3 dark:bg-emerald-500/10">
            <h2 className="text-sm font-semibold">
              {t('importedCount', { count: result.imported })}
              {result.skipped > 0 && ` · ${t('skippedCount', { count: result.skipped })}`}
              {result.failed.length > 0 && ` · ${t('failedCount', { count: result.failed.length })}`}
            </h2>
          </div>
          {result.failed.length > 0 && (
            <ul className="divide-y divide-border text-sm">
              {result.failed.map((f) => (
                <li key={f.rowNum} className="px-4 py-2">
                  <span className="text-muted-foreground">{t('colRow')} {f.rowNum}</span> ·{' '}
                  {f.employeeRef} — <span className="text-red-600 dark:text-red-400">{f.message}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <Link href="/leave" className="text-primary hover:underline">
              {t('viewLeave')}
            </Link>
            {result.failed.length > 0 && (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => downloadErrors(result.failed)}
              >
                {t('downloadErrors')}
              </button>
            )}
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                setCsv('');
                reset();
              }}
            >
              {t('importAnother')}
            </button>
          </div>
        </Card>
      )}

      {preview && !result && (
        <PreviewTable preview={preview} onImport={commit} busy={pending} />
      )}
    </div>
  );
}

function PreviewTable({
  preview,
  onImport,
  busy,
}: {
  preview: LeaveImportPreview;
  onImport: () => void;
  busy: boolean;
}) {
  const t = useTranslations('admin.leave.import');
  const invalid = preview.total - preview.validCount;
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">
          {t('preview')} ·{' '}
          <span className="text-emerald-600 dark:text-emerald-400">
            {t('readyCount', { count: preview.validCount })}
          </span>
          {invalid > 0 && (
            <>
              {' · '}
              <span className="text-red-600 dark:text-red-400">
                {t('withErrorsCount', { count: invalid })}
              </span>
            </>
          )}
        </h2>
        <Button onClick={onImport} disabled={busy || preview.validCount === 0} size="sm">
          {busy ? t('importing') : t('importValid', { count: preview.validCount })}
        </Button>
      </div>

      {preview.missingColumns.length > 0 && (
        <div className="border-b border-border bg-red-50/60 px-4 py-2.5 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-400">
          {t('missingColumns', { count: preview.missingColumns.length })}{' '}
          {preview.missingColumns.map((c) => (
            <code key={c} className="mx-0.5">
              {c}
            </code>
          ))}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-12 px-4 py-2 font-medium">{t('colRow')}</th>
              <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
              <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
              <th className="px-4 py-2 font-medium">{t('colMessage')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {preview.rows.map((r) => (
              <tr key={r.rowNum} className={r.ok ? '' : 'bg-red-50/40 dark:bg-red-500/5'}>
                <td className="px-4 py-2 tabular-nums text-muted-foreground">{r.rowNum}</td>
                <td className="px-4 py-2 font-medium">
                  {r.employeeRef || <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-4 py-2">
                  {r.ok ? (
                    <span className="text-emerald-600 dark:text-emerald-400">{t('ready')}</span>
                  ) : (
                    <span className="text-red-600 dark:text-red-400">{t('statusError')}</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  {r.errors.length > 0 && (
                    <span className="text-red-600 dark:text-red-400">{r.errors.join('; ')}</span>
                  )}
                  {r.warnings.length > 0 && (
                    <span className="text-amber-600 dark:text-amber-400">
                      {r.errors.length > 0 ? ' · ' : ''}
                      {r.warnings.join('; ')}
                    </span>
                  )}
                  {r.errors.length === 0 && r.warnings.length === 0 && (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
