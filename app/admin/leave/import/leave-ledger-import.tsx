'use client';

import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UploadCloud } from 'lucide-react';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { DownloadTemplate } from '@/components/download-template';
import { leaveImportTemplate } from '@/lib/import-template';
import { toCsv } from '@/lib/csv';
import {
  LEAVE_IMPORT_COLUMNS,
  type LeaveImportPreview,
  type LeaveImportResult,
  type LeaveImportSource,
} from '@/lib/leave-import-schema';
import { validateLeaveImportAction, commitLeaveImportAction } from './actions';

// Reporter's human-readable headers (Function 1). They normalise to the snake_case contract
// (employee_id, …) via parseCsvRecords on re-upload, so the Excel template can be human-friendly.
const XLSX_TEMPLATE_HEADERS = ['Employee ID', 'Leave Type', 'Transaction Type', 'Days', 'Effective Date'];

// Next server actions default to a ~1 MB body; a 500-row import is ~20 KB, so this is a generous guard.
const MAX_CSV_BYTES = 900_000;

const ACCEPT = '.csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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
  // How the current data reached the box — recorded in the commit's audit event. Defaults to 'paste'.
  const [source, setSource] = useState<LeaveImportSource>({ kind: 'paste' });
  const [fileInfo, setFileInfo] = useState<{ name: string; rows: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Any edit invalidates a stale preview/result — force a fresh validate before importing.
  const reset = () => {
    setPreview(null);
    setResult(null);
    setPhase('idle');
    setError(null);
  };

  const runValidate = (text: string) =>
    startTransition(async () => {
      setError(null);
      try {
        const p = await validateLeaveImportAction(text);
        setPreview(p);
        setResult(null);
        setPhase('previewed');
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const validate = () => runValidate(csv);

  const commit = () =>
    startTransition(async () => {
      setError(null);
      try {
        const r = await commitLeaveImportAction(csv, source);
        setResult(r);
        setPhase('done');
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    });

  // Function 2: read a picked/dropped file into the shared `csv` state, then auto-run validation so the
  // upload flows straight into the Ready/Error preview (Function 2 → 3 → 4). CSV is read natively;
  // .xlsx/.xls are parsed IN THE BROWSER via the dynamically-imported SheetJS helper (server never sees
  // a workbook — it always receives the same CSV text as the paste path and re-validates it).
  const loadFile = async (file: File) => {
    setError(null);
    setReading(true);
    try {
      const lower = file.name.toLowerCase();
      let text: string;
      let format: LeaveImportSource['format'];
      if (lower.endsWith('.csv')) {
        format = 'csv';
        text = await file.text();
      } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
        format = lower.endsWith('.xlsx') ? 'xlsx' : 'xls';
        const { workbookToCsvText } = await import('@/lib/spreadsheet');
        try {
          text = await workbookToCsvText(await file.arrayBuffer());
        } catch (e) {
          setError((e as Error).message === 'EMPTY_SHEET' ? t('emptySheet') : t('fileReadError'));
          return;
        }
      } else {
        setError(t('unsupportedFileType'));
        return;
      }
      if (new Blob([text]).size > MAX_CSV_BYTES) {
        setError(t('fileTooLarge'));
        return;
      }
      const rows = Math.max(0, text.trim() === '' ? 0 : text.trim().split(/\r?\n/).length - 1);
      setCsv(text);
      setSource({ kind: 'file', name: file.name, format });
      setFileInfo({ name: file.name, rows });
      setResult(null);
      runValidate(text);
    } catch {
      setError(t('fileReadError'));
    } finally {
      setReading(false);
      // Allow re-selecting the same file (change event won't fire otherwise).
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Function 1 (Excel): build a genuine .xlsx template client-side from the reporter's human headers +
  // the shared sample rows, so HR gets a real Excel file, not a renamed CSV.
  const downloadXlsxTemplate = async () => {
    setError(null);
    try {
      const { buildXlsx } = await import('@/lib/spreadsheet');
      const bytes = await buildXlsx(XLSX_TEMPLATE_HEADERS, leaveImportTemplate.sampleRows);
      const url = URL.createObjectURL(
        new Blob([bytes as BlobPart], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = 'leave-import-template.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(t('fileReadError'));
    }
  };

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
      <Card id="leave-import-form" className="scroll-mt-6 p-5">
        {/* Function 2 — file upload (CSV / XLSX / XLS). Drop or pick a file; it auto-validates. */}
        <Field label={t('uploadFile')}>
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void loadFile(f);
            }}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ${
              dragging
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-primary/50 hover:bg-muted/40'
            }`}
          >
            <UploadCloud className="h-6 w-6 text-muted-foreground" aria-hidden />
            <div className="text-sm font-medium">{reading ? t('reading') : t('dropHere')}</div>
            <p className="text-xs text-muted-foreground">{t('uploadHint')}</p>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void loadFile(f);
              }}
            />
          </div>
          {fileInfo && (
            <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
              {t('fileLoaded', { name: fileInfo.name, rows: fileInfo.rows })}
            </p>
          )}
        </Field>

        {/* Secondary path: paste raw CSV (also the way to inspect/fix an uploaded file's content). */}
        <details className="mt-4 border-t border-border pt-3" open={source.kind === 'paste' && !fileInfo}>
          <summary className="cursor-pointer select-none text-sm font-medium text-muted-foreground">
            {t('pasteToggle')}
          </summary>
          <div className="mt-3">
            <Field label={t('csvData')}>
              <textarea
                className={`${inputCls} h-44 resize-y font-mono text-xs leading-relaxed`}
                placeholder={t('csvPlaceholder')}
                value={csv}
                onChange={(e) => {
                  setCsv(e.target.value);
                  setSource({ kind: 'paste' });
                  setFileInfo(null);
                  reset();
                }}
                spellCheck={false}
              />
            </Field>
          </div>
        </details>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={validate} disabled={pending || reading || !csv.trim()}>
            {pending && phase !== 'done' ? t('validating') : t('validate')}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setCsv(SAMPLE);
              setSource({ kind: 'paste' });
              setFileInfo(null);
              reset();
            }}
            disabled={pending}
          >
            {t('loadSample')}
          </Button>
          <DownloadTemplate spec={leaveImportTemplate} />
          <button
            type="button"
            onClick={() => void downloadXlsxTemplate()}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
          >
            {t('downloadTemplateXlsx')}
          </button>
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
