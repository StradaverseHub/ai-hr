'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UploadCloud } from 'lucide-react';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { DownloadTemplate } from '@/components/download-template';
import { leaveHistoryImportTemplate, LEAVE_HISTORY_XLSX_HEADERS } from '@/lib/import-template';
import { toCsv } from '@/lib/csv';
import {
  IMPORT_FILE_ACCEPT,
  importFileMessageKey,
  readImportFile,
} from '@/lib/import-file';
import {
  LEAVE_HISTORY_COLUMNS,
  LEAVE_HISTORY_STEPS,
  leaveHistoryRunOutcome,
  type LeaveHistoryImportError,
  type LeaveHistoryImportPreview,
  type LeaveHistoryImportResult,
  type LeaveHistoryImportSource,
  type LeaveHistoryRowResult,
  type LeaveHistoryRunRow,
  type LeaveHistoryStep,
} from '@/lib/leave-history-import-schema';
import {
  validateLeaveHistoryImportAction,
  commitLeaveHistoryImportAction,
} from './actions';

/**
 * 3f15ffdb (r362) — the Leave History Data Import workbench, drawn as the six steps the reporter set
 * out: Download Template › Upload Excel › Validate › Preview Results › Confirm Import › Import
 * Summary. Nothing is written until Confirm Import, and the preview is reached by validating first.
 *
 * A CLIENT island for three reasons and no others: the workbook is decoded IN THE BROWSER (so no
 * spreadsheet ever reaches a server action), the template and the error report are built in the
 * browser from data already in hand, and the step rail reflects state the user is holding. The run
 * log arrives as props from the RSC page — nothing is fetched here.
 *
 * THE STEP RAIL IS DERIVED FROM STATE, never from a click. A rail you can click your way along lies
 * about where you are; this one is the answer to "what has actually happened to this file".
 */
const MAX_PREVIEW_ROWS = 500;

type Phase = 'idle' | 'previewed' | 'done';

export function LeaveHistoryImport({ runs }: { runs: LeaveHistoryRunRow[] }) {
  const t = useTranslations('admin.leaveHistoryImport');
  const router = useRouter();
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<LeaveHistoryImportPreview | null>(null);
  const [result, setResult] = useState<LeaveHistoryImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [templateTaken, setTemplateTaken] = useState(false);
  const [pending, startTransition] = useTransition();
  const [source, setSource] = useState<LeaveHistoryImportSource>({ kind: 'paste' });
  const [fileInfo, setFileInfo] = useState<{ name: string; rows: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        const p = await validateLeaveHistoryImportAction(text);
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
        const r = await commitLeaveHistoryImportAction(csv, source);
        setResult(r);
        setPhase('done');
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    });

  /** Step 2 → 3 → 4 in one gesture: read the file, then validate it immediately. */
  const loadFile = async (file: File) => {
    setError(null);
    setReading(true);
    try {
      const read = await readImportFile(file);
      const rows = Math.max(0, read.text.trim() === '' ? 0 : read.text.trim().split(/\r?\n/).length - 1);
      setCsv(read.text);
      setSource({ kind: 'file', name: read.name, format: read.format });
      setFileInfo({ name: read.name, rows });
      setResult(null);
      runValidate(read.text);
    } catch (e) {
      // `importFileMessageKey` maps a thrown ImportFileError to a key in THIS namespace, which is why
      // every one of its five codes has a string here. A computed key is invisible to the i18n
      // static-key check, so test/leave-history-import-screen.test.ts pins the set in six locales.
      setError(t(importFileMessageKey(e)));
    } finally {
      setReading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /** Step 1, the Excel form: the reporter's own twelve headings, derived from the contract. */
  const downloadXlsxTemplate = async () => {
    setError(null);
    try {
      const { buildXlsx } = await import('@/lib/spreadsheet');
      const bytes = await buildXlsx(LEAVE_HISTORY_XLSX_HEADERS, leaveHistoryImportTemplate.sampleRows, {
        sheetName: 'Leave History',
        // Employee No. and Leave Reference are IDENTITY strings: "0012" and "LV/2025/00418" must
        // survive a round trip through Excel, which would otherwise turn the first into the number 12.
        textColumns: [0, 1],
      });
      const url = URL.createObjectURL(
        new Blob([bytes as BlobPart], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = 'leave-history-import-template.xlsx';
      a.click();
      URL.revokeObjectURL(url);
      setTemplateTaken(true);
    } catch {
      setError(t('fileReadError'));
    }
  };

  /**
   * The error report (ticket point 6). Built in the browser from rows the server already sent, and
   * routed through `toCsv`, whose `csvSafeCell` guard is what stops a cell beginning `=` becoming a
   * formula when HR opens the report in Excel — it echoes back values the file supplied.
   */
  const downloadErrors = (rows: LeaveHistoryImportError[]) => {
    const csvOut = toCsv([
      [t('colRow'), t('colEmployee'), t('colReference'), t('colReason')],
      ...rows.map((r) => [r.rowNum, r.employeeNo, r.leaveReference, r.errors.join('; ')]),
    ]);
    const url = URL.createObjectURL(new Blob([csvOut], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'leave-history-import-errors.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  /** Every row the preview would not import, as the report carries them. */
  const rejectedRows = useMemo<LeaveHistoryImportError[]>(
    () =>
      (preview?.rows ?? [])
        .filter((r) => r.status !== 'valid')
        .map((r) => ({
          rowNum: r.rowNum,
          employeeNo: r.employeeNo,
          leaveReference: r.leaveReference,
          errors: r.errors,
        })),
    [preview],
  );

  // Derived, never clicked: where this file has actually got to.
  const currentStep: LeaveHistoryStep =
    phase === 'done'
      ? 'importSummary'
      : preview
        ? 'previewResults'
        : csv.trim()
          ? 'validate'
          : templateTaken
            ? 'uploadExcel'
            : 'downloadTemplate';

  return (
    <div className="space-y-6">
      <StepRail current={currentStep} />

      <Card id="leave-history-import-form" className="scroll-mt-6 p-5">
        {/* Step 1 — the template, in both forms. The Excel one carries the reporter's headings. */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void downloadXlsxTemplate()}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
          >
            {t('downloadTemplateXlsx')}
          </button>
          <DownloadTemplate spec={leaveHistoryImportTemplate} onDownloaded={() => setTemplateTaken(true)} />
        </div>

        {/* Step 2 — upload. Drop or pick; it reads and validates in one gesture. */}
        <Field label={t('step.uploadExcel')}>
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
              accept={IMPORT_FILE_ACCEPT}
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

        {/* The paste path, secondary: also how you inspect what a workbook actually decoded to. */}
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

        {/* Step 3 — validate. */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={() => runValidate(csv)} disabled={pending || reading || !csv.trim()}>
            {pending && phase !== 'done' ? t('validating') : t('validate')}
          </Button>
        </div>

        <details className="mt-4 border-t border-border pt-3 text-xs">
          <summary className="cursor-pointer select-none font-medium text-muted-foreground">
            {t('columnReference')}
          </summary>
          <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground sm:grid-cols-3">
            {LEAVE_HISTORY_COLUMNS.map((c) => (
              <li key={c.key}>
                <code>{c.header}</code>
                {c.required ? ' *' : ''}
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

      {/* Step 6 — the summary, in the reporter's own four lines. */}
      {result && (
        <Card className="overflow-hidden border-emerald-200 dark:border-emerald-500/30">
          <div className="border-b border-border bg-emerald-50/60 px-4 py-3 dark:bg-emerald-500/10">
            <h2 className="text-sm font-semibold">{t('resultTitle')}</h2>
          </div>
          <ul className="space-y-1 px-4 py-3 text-sm">
            <li>{t('resultTotal', { count: result.total })}</li>
            <li className="text-emerald-700 dark:text-emerald-400">
              {t('resultImported', { count: result.imported })}
            </li>
            <li className={result.failed > 0 ? 'text-red-600 dark:text-red-400' : undefined}>
              {t('resultFailed', { count: result.failed })}
            </li>
            <li className={result.duplicates > 0 ? 'text-amber-600 dark:text-amber-400' : undefined}>
              {t('resultDuplicate', { count: result.duplicates })}
            </li>
            {result.errorsTruncated && (
              <li className="text-xs text-muted-foreground">
                {t('resultTruncated', { shown: result.errors.length, total: result.failed + result.duplicates })}
              </li>
            )}
          </ul>
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3 text-sm">
            <Link href="/leave" className="text-primary hover:underline">
              {t('viewLeaveHistory')}
            </Link>
            {result.errors.length > 0 && (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => downloadErrors(result.errors)}
              >
                {t('downloadErrors')}
              </button>
            )}
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                setCsv('');
                setFileInfo(null);
                setSource({ kind: 'paste' });
                reset();
              }}
            >
              {t('importAnother')}
            </button>
          </div>
        </Card>
      )}

      {/* Steps 4 and 5 — the preview, then Confirm Import on the same card. */}
      {preview && !result && (
        <PreviewCard
          preview={preview}
          rejected={rejectedRows}
          onImport={commit}
          onDownloadErrors={() => downloadErrors(rejectedRows)}
          busy={pending}
        />
      )}

      {/* The one thing on this page that must not be missed, so it is always rendered. */}
      <NoBalanceNotice />

      <ImportLog runs={runs} onDownload={downloadErrors} />
    </div>
  );
}

/** The six steps, with the one the file has actually reached marked. Not clickable: it is a readout. */
function StepRail({ current }: { current: LeaveHistoryStep }) {
  const t = useTranslations('admin.leaveHistoryImport');
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="leave-history-import-steps">
      {LEAVE_HISTORY_STEPS.map((s, i) => {
        const active = s === current;
        return (
          <li
            key={s}
            aria-current={active ? 'step' : undefined}
            className={`rounded-lg border px-3 py-2 ${
              active ? 'border-primary bg-primary/5' : 'border-border bg-muted/30'
            }`}
          >
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {t('stepNumber', { n: i + 1 })}
            </div>
            <div className={`text-sm ${active ? 'font-semibold' : 'text-muted-foreground'}`}>{t(`step.${s}`)}</div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The single most important thing on this screen, and the reporter's own point 9 answered in their
 * own terms. Always rendered — before an import as a promise, after one as an explanation — because
 * the surprise it prevents ("why has Taken not moved?") arrives days later, not at upload time.
 */
function NoBalanceNotice() {
  const t = useTranslations('admin.leaveHistoryImport');
  return (
    <Card className="border-emerald-200 bg-emerald-50/40 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/5">
      <h2 className="text-sm font-semibold">{t('noBalanceTitle')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('noBalanceBody')}</p>
    </Card>
  );
}

function PreviewCard({
  preview,
  rejected,
  onImport,
  onDownloadErrors,
  busy,
}: {
  preview: LeaveHistoryImportPreview;
  rejected: LeaveHistoryImportError[];
  onImport: () => void;
  onDownloadErrors: () => void;
  busy: boolean;
}) {
  const t = useTranslations('admin.leaveHistoryImport');
  const shown = preview.rows.slice(0, MAX_PREVIEW_ROWS);
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{t('previewTitle')}</h2>
      </div>

      {/* The four counts the ticket asks for, as four tiles rather than one sentence. */}
      <div className="grid grid-cols-2 gap-3 border-b border-border p-4 lg:grid-cols-4">
        <Tile label={t('totalRecords')} value={preview.total} />
        <Tile label={t('validRecords')} value={preview.validCount} tone="good" />
        <Tile label={t('errorRecords')} value={preview.errorCount} tone="bad" />
        <Tile label={t('duplicateRecords')} value={preview.duplicateCount} tone="warn" />
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
              <th className="w-12 px-3 py-2 font-medium">{t('colRow')}</th>
              <th className="px-3 py-2 font-medium">{t('colStatus')}</th>
              <th className="px-3 py-2 font-medium">{t('colEmployee')}</th>
              <th className="px-3 py-2 font-medium">{t('colReference')}</th>
              <th className="px-3 py-2 font-medium">{t('colCode')}</th>
              <th className="px-3 py-2 font-medium">{t('colYear')}</th>
              <th className="px-3 py-2 font-medium">{t('colStart')}</th>
              <th className="px-3 py-2 font-medium">{t('colEnd')}</th>
              <th className="px-3 py-2 font-medium">{t('colDays')}</th>
              <th className="px-3 py-2 font-medium">{t('colSession')}</th>
              <th className="px-3 py-2 font-medium">{t('colReason')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map((r) => (
              <PreviewRow key={r.rowNum} row={r} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
        <Button onClick={onImport} disabled={busy || preview.validCount === 0} size="sm">
          {busy ? t('importing') : t('confirmImport', { count: preview.validCount })}
        </Button>
        {rejected.length > 0 && (
          <button
            type="button"
            onClick={onDownloadErrors}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
          >
            {t('downloadErrorReport', { count: rejected.length })}
          </button>
        )}
        <span className="text-xs text-muted-foreground">{t('nothingSilentlyDropped')}</span>
      </div>
    </Card>
  );
}

function PreviewRow({ row }: { row: LeaveHistoryRowResult }) {
  const t = useTranslations('admin.leaveHistoryImport');
  const tone =
    row.status === 'error'
      ? 'bg-red-50/40 dark:bg-red-500/5'
      : row.status === 'duplicate'
        ? 'bg-amber-50/40 dark:bg-amber-500/5'
        : '';
  const badge =
    row.status === 'valid'
      ? 'text-emerald-600 dark:text-emerald-400'
      : row.status === 'duplicate'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-red-600 dark:text-red-400';
  const label =
    row.status === 'valid' ? t('statusValid') : row.status === 'duplicate' ? t('statusDuplicate') : t('statusError');
  return (
    <tr className={tone}>
      <td className="px-3 py-2 tabular-nums text-muted-foreground">{row.rowNum}</td>
      <td className="px-3 py-2">
        <span className={badge}>{label}</span>
      </td>
      <td className="px-3 py-2 font-medium">{row.employeeNo || '—'}</td>
      <td className="px-3 py-2">{row.leaveReference || '—'}</td>
      <td className="px-3 py-2">{row.leaveCode || '—'}</td>
      <td className="px-3 py-2 tabular-nums">{row.entitlementYear || '—'}</td>
      <td className="px-3 py-2 tabular-nums">{row.startDate || '—'}</td>
      <td className="px-3 py-2 tabular-nums">{row.endDate || '—'}</td>
      <td className="px-3 py-2 tabular-nums">{row.days || '—'}</td>
      <td className="px-3 py-2">{row.session || '—'}</td>
      <td className="px-3 py-2">
        {row.errors.length > 0 && <span className="text-red-600 dark:text-red-400">{row.errors.join('; ')}</span>}
        {row.warnings.length > 0 && (
          <span className="text-amber-600 dark:text-amber-400">
            {row.errors.length > 0 ? ' · ' : ''}
            {row.warnings.join('; ')}
          </span>
        )}
        {row.errors.length === 0 && row.warnings.length === 0 && <span className="text-muted-foreground">—</span>}
      </td>
    </tr>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'bad' | 'warn' }) {
  const cls =
    tone === 'good'
      ? 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-500/30 dark:bg-emerald-500/5'
      : tone === 'bad'
        ? 'border-red-200 bg-red-50/50 dark:border-red-500/30 dark:bg-red-500/5'
        : tone === 'warn'
          ? 'border-amber-200 bg-amber-50/50 dark:border-amber-500/30 dark:bg-amber-500/5'
          : 'border-border bg-muted/30';
  return (
    <div className={`rounded-lg border px-3 py-2 ${cls}`}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/**
 * The audit trail (ticket point 10), on the same page. Always rendered, empty state included, so an
 * admin who has never imported learns that a record is kept before they upload anything. The failed
 * rows stay downloadable afterwards; the uploaded file itself is not kept (migration 0490's header).
 */
function ImportLog({
  runs,
  onDownload,
}: {
  runs: LeaveHistoryRunRow[];
  onDownload: (rows: LeaveHistoryImportError[]) => void;
}) {
  const t = useTranslations('admin.leaveHistoryImport');
  const [openId, setOpenId] = useState<string | null>(null);

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
                <th className="px-3 py-2 font-medium">{t('historyColWhen')}</th>
                <th className="px-3 py-2 font-medium">{t('historyColFile')}</th>
                <th className="px-3 py-2 font-medium">{t('historyColBy')}</th>
                <th className="px-3 py-2 font-medium">{t('historyColRecords')}</th>
                <th className="px-3 py-2 font-medium">{t('historyColImported')}</th>
                <th className="px-3 py-2 font-medium">{t('historyColFailed')}</th>
                <th className="px-3 py-2 font-medium">{t('historyColDuplicate')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {runs.map((run) => {
                const open = openId === run.id;
                const outcome = leaveHistoryRunOutcome(run);
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
                return (
                  <tr key={run.id} className={open ? 'align-top' : undefined}>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {/* The viewer's own locale and timezone: a run is a wall-clock moment for the
                          person who ran it, not an HR date, so it is deliberately NOT routed through
                          the Kuala Lumpur date helper (which answers a different question). */}
                      {new Date(run.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 font-medium">
                      {run.fileName || <span className="font-normal text-muted-foreground">{t('historyPasted')}</span>}
                      <div className={`text-xs font-normal ${outcomeCls}`}>{outcomeLabel}</div>
                      {open && (
                        <div className="mt-2 max-w-md rounded-md bg-muted/40 p-2 text-xs font-normal">
                          <p className="mb-1 text-muted-foreground">
                            {run.errorsTruncated
                              ? t('historyErrorsTruncated', { shown: run.errors.length, total: run.failedRows + run.duplicateRows })
                              : t('historyErrorsShown', { count: run.errors.length })}
                          </p>
                          {run.errors.length === 0 ? (
                            <p className="text-muted-foreground">{t('historyNoDetail')}</p>
                          ) : (
                            <ul className="space-y-1">
                              {run.errors.map((e) => (
                                <li key={e.rowNum}>
                                  <span className="text-muted-foreground">{t('row', { num: e.rowNum })}</span>
                                  {(e.employeeNo || e.leaveReference) &&
                                    ` · ${[e.employeeNo, e.leaveReference].filter(Boolean).join(' · ')}`}{' '}
                                  — <span className="text-red-600 dark:text-red-400">{e.errors.join('; ')}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {run.errors.length > 0 && (
                            <button
                              type="button"
                              onClick={() => onDownload(run.errors)}
                              className="mt-2 rounded-lg border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted"
                            >
                              {t('downloadErrors')}
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{run.actorName || t('historyActorUnknown')}</td>
                    <td className="px-3 py-2 tabular-nums">{run.totalRows}</td>
                    <td className="px-3 py-2 tabular-nums text-emerald-700 dark:text-emerald-400">{run.importedRows}</td>
                    <td className="px-3 py-2 tabular-nums">{run.failedRows}</td>
                    <td className="px-3 py-2 tabular-nums">{run.duplicateRows}</td>
                    <td className="px-3 py-2 text-right">
                      {run.failedRows + run.duplicateRows > 0 && (
                        <button
                          type="button"
                          onClick={() => setOpenId(open ? null : run.id)}
                          aria-expanded={open}
                          className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted"
                        >
                          {t('historyViewFailed')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
