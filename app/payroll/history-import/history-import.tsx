'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UploadCloud } from 'lucide-react';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import {
  PAYROLL_HISTORY_HEADERS,
  PAYROLL_HISTORY_SAMPLE_ROWS,
  type HistoryImportPreview,
  type HistoryImportResult,
  type HistoryIssue,
  type ImportCodeEntry,
} from '@/lib/payroll-history-import-schema';
import {
  PAYROLL_HISTORY_TEXT_COLUMN_INDEXES,
  PAYROLL_HISTORY_XLSX_FILENAME,
  PAYROLL_HISTORY_XLSX_SHEETS,
  buildImportCodeRows,
} from '@/lib/import-template-xlsx';
import { validateHistoryImportAction, commitHistoryImportAction } from './actions';

// Next server actions default to a ~1 MB body; a 3,000-line import is ~150 KB, so this is generous.
const MAX_CSV_BYTES = 900_000;

const ACCEPT =
  '.csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The reporter's worked example as pasteable text — same rows the template's Sample sheet carries. */
const SAMPLE = [PAYROLL_HISTORY_HEADERS.join(','), ...PAYROLL_HISTORY_SAMPLE_ROWS.map((r) => r.join(','))].join('\n');

type Phase = 'idle' | 'previewed' | 'done';

type CompanyOption = { id: string; name: string; companyLabel: string | null };

function download(bytes: BlobPart, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function HistoryImport({
  companies,
  defaultCompanyId,
  codes,
  cyclesByCompany,
}: {
  companies: CompanyOption[];
  defaultCompanyId: string;
  codes: ImportCodeEntry[];
  cyclesByCompany: Record<string, { name: string; code: string | null }[]>;
}) {
  const t = useTranslations('payroll.historyImport');
  const router = useRouter();
  const [companyId, setCompanyId] = useState(defaultCompanyId);
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<HistoryImportPreview | null>(null);
  const [result, setResult] = useState<HistoryImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [pending, startTransition] = useTransition();
  const [fileInfo, setFileInfo] = useState<{ name: string; rows: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  // The load cannot be undone, so the Confirm step requires an explicit acknowledgement.
  const [acknowledged, setAcknowledged] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const company = companies.find((c) => c.id === companyId);
  const cycles = cyclesByCompany[companyId] ?? [];

  // Any edit invalidates a stale preview/result — force a fresh validate before importing.
  const reset = () => {
    setPreview(null);
    setResult(null);
    setPhase('idle');
    setError(null);
    setAcknowledged(false);
  };

  const runValidate = (text: string) =>
    startTransition(async () => {
      setError(null);
      try {
        const p = await validateHistoryImportAction(text, companyId);
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
        const r = await commitHistoryImportAction(csv, companyId);
        setResult(r);
        setPhase('done');
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    });

  /**
   * Read a picked/dropped file into the shared `csv` state, then auto-run validation so the upload flows
   * straight into the result. CSV is read natively; .xlsx/.xls are parsed IN THE BROWSER via the
   * dynamically-imported SheetJS helper — the server never sees a workbook, it always receives the same
   * CSV text as the paste path and re-validates it.
   */
  const loadFile = async (file: File) => {
    setError(null);
    setReading(true);
    try {
      const lower = file.name.toLowerCase();
      let text: string;
      if (lower.endsWith('.csv')) {
        text = await file.text();
      } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
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
      setFileInfo({ name: file.name, rows });
      setResult(null);
      setAcknowledged(false);
      runValidate(text);
    } catch {
      setError(t('fileReadError'));
    } finally {
      setReading(false);
      // Allow re-selecting the same file (the change event won't fire otherwise).
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /**
   * The template: a genuine .xlsx with the reporter's seven headings, verbatim and in their order, and
   * three sheets — a blank one to fill in, their worked example, and every code the import accepts.
   * Identity columns are stamped as text so Excel cannot mangle an employee code.
   */
  const downloadTemplate = async () => {
    setError(null);
    try {
      const { buildXlsx } = await import('@/lib/spreadsheet');
      const bytes = await buildXlsx([...PAYROLL_HISTORY_HEADERS], [], {
        sheetName: PAYROLL_HISTORY_XLSX_SHEETS.data,
        textColumns: [...PAYROLL_HISTORY_TEXT_COLUMN_INDEXES],
        extraSheets: [
          {
            name: PAYROLL_HISTORY_XLSX_SHEETS.sample,
            rows: [[...PAYROLL_HISTORY_HEADERS], ...PAYROLL_HISTORY_SAMPLE_ROWS.map((r) => [...r])],
          },
          {
            name: PAYROLL_HISTORY_XLSX_SHEETS.codes,
            rows: buildImportCodeRows(
              {
                title: t('codeReference'),
                note: t('codeReferenceHint'),
                code: t('colCode'),
                label: t('colCodeLabel'),
                destination: t('colDestination'),
                direction: t('colDirection'),
              },
              codes.map((c) => ({
                code: c.code,
                label: c.label,
                destination: c.destination,
                direction: c.direction,
              })),
            ),
          },
        ],
      });
      download(bytes as BlobPart, PAYROLL_HISTORY_XLSX_FILENAME, XLSX_MIME);
    } catch {
      setError(t('fileReadError'));
    }
  };

  /** The validation result as an Excel file — the reporter's seven columns, ready to correct and re-upload. */
  const downloadIssues = async (issues: HistoryIssue[]) => {
    setError(null);
    try {
      const { buildXlsx } = await import('@/lib/spreadsheet');
      const header = [
        t('colRow'),
        t('colEmployeeNo'),
        t('colPeriod'),
        t('colDoeCode'),
        t('colErrorType'),
        t('colErrorDescription'),
        t('colImportStatus'),
      ];
      const rows = issues.map((i) => [
        String(i.rowNum),
        i.employeeNo,
        i.period,
        i.doeCode,
        i.type,
        i.description,
        i.status,
      ]);
      const bytes = await buildXlsx(header, rows, { sheetName: 'Validation Result', textColumns: [1, 2] });
      download(bytes as BlobPart, 'payroll-history-import-errors.xlsx', XLSX_MIME);
    } catch {
      setError(t('fileReadError'));
    }
  };

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[280px_1fr]">
          <div className="space-y-2">
            <Field label={t('targetCompany')}>
              <select
                className={inputCls}
                value={companyId}
                onChange={(e) => {
                  setCompanyId(e.target.value);
                  setFileInfo(null);
                  reset();
                }}
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            {company?.companyLabel ? (
              <p className="text-xs text-muted-foreground">
                {t('companyCodeIs')} <code className="font-medium text-foreground">{company.companyLabel}</code>
              </p>
            ) : (
              <p className="text-xs text-amber-600 dark:text-amber-400">{t('companyCodeMissing')}</p>
            )}
          </div>

          {/* File upload (CSV / XLSX / XLS). Drop or pick a file; it auto-validates. */}
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
                dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-muted/40'
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
        </div>

        {/* Secondary path: paste the rows (also the way to inspect or fix an uploaded file's content). */}
        <details className="mt-4 border-t border-border pt-3" open={!fileInfo && csv !== ''}>
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
          <Button variant="outline" onClick={() => void downloadTemplate()} disabled={pending}>
            {t('downloadTemplate')}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setCsv(SAMPLE);
              setFileInfo(null);
              reset();
            }}
            disabled={pending}
          >
            {t('loadSample')}
          </Button>
        </div>

        <details className="mt-4 border-t border-border pt-3 text-xs">
          <summary className="cursor-pointer select-none font-medium text-muted-foreground">
            {t('columnReference')}
          </summary>
          <ol className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground sm:grid-cols-4">
            {PAYROLL_HISTORY_HEADERS.map((h) => (
              <li key={h}>
                <code>{h}</code>
              </li>
            ))}
          </ol>
          <p className="mt-2 text-muted-foreground">{t('completenessHint')}</p>
          <p className="mt-2 text-muted-foreground">{t('overrideNote')}</p>
          <p className="mt-2 text-muted-foreground">{t('eaSplitHint')}</p>

          <div className="mt-3 font-medium text-foreground">{t('cycleReference')}</div>
          {cycles.length === 0 ? (
            <p className="text-muted-foreground">{t('noCycleCodes')}</p>
          ) : (
            <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground sm:grid-cols-3">
              {cycles.map((c) => (
                <li key={c.name}>
                  <code>{c.code ?? c.name}</code>
                  {c.code ? ` — ${c.name}` : ''}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-muted-foreground">{t('cycleReferenceHint')}</p>

          <div className="mt-3 font-medium text-foreground">{t('codeReference')}</div>
          <p className="text-muted-foreground">{t('codeReferenceHint')}</p>
          <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground sm:grid-cols-3">
            {codes.map((c) => (
              <li key={c.code}>
                <code>{c.code}</code> — {c.label}
              </li>
            ))}
          </ul>
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
            <h2 className="text-sm font-semibold">{t('resultTitle')}</h2>
          </div>
          <SummaryGrid
            items={[
              { label: t('sumTotal'), value: result.total },
              { label: t('sumValid'), value: result.valid },
              { label: t('sumInvalid'), value: result.invalid },
              { label: t('sumImported'), value: result.imported, tone: 'good' },
              { label: t('sumUpdated'), value: result.updated },
              { label: t('sumDuplicates'), value: result.duplicates },
              { label: t('sumFailed'), value: result.failed, tone: result.failed > 0 ? 'bad' : undefined },
              { label: t('sumExisting'), value: result.existing, tone: result.existing > 0 ? 'warn' : undefined },
            ]}
          />
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{t('overrideNote')}</p>
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3 text-sm">
            <Link href="/payroll" className="text-primary hover:underline">
              {t('viewPayroll')}
            </Link>
            {result.issues.length > 0 && (
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => void downloadIssues(result.issues)}
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
                reset();
              }}
            >
              {t('importAnother')}
            </button>
          </div>
        </Card>
      )}

      {preview && !result && (
        <PreviewPanel
          preview={preview}
          acknowledged={acknowledged}
          onAcknowledge={setAcknowledged}
          onImport={commit}
          onDownloadIssues={() => void downloadIssues(preview.issues)}
          busy={pending}
        />
      )}
    </div>
  );
}

function SummaryGrid({
  items,
}: {
  items: { label: string; value: number; tone?: 'good' | 'bad' | 'warn' }[];
}) {
  return (
    <dl className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
      {items.map((i) => (
        <div key={i.label} className="bg-card px-4 py-3">
          <dt className="text-xs text-muted-foreground">{i.label}</dt>
          <dd
            className={`text-lg font-semibold tabular-nums ${
              i.tone === 'good'
                ? 'text-emerald-600 dark:text-emerald-400'
                : i.tone === 'bad'
                  ? 'text-red-600 dark:text-red-400'
                  : i.tone === 'warn'
                    ? 'text-amber-600 dark:text-amber-400'
                    : ''
            }`}
          >
            {i.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function PreviewPanel({
  preview,
  acknowledged,
  onAcknowledge,
  onImport,
  onDownloadIssues,
  busy,
}: {
  preview: HistoryImportPreview;
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
  onImport: () => void;
  onDownloadIssues: () => void;
  busy: boolean;
}) {
  const t = useTranslations('payroll.historyImport');
  const readyMonths = useMemo(() => preview.months.filter((m) => m.ok), [preview.months]);

  return (
    <>
      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{t('summaryTitle')}</h2>
        </div>
        <SummaryGrid
          items={[
            { label: t('sumTotal'), value: preview.total },
            { label: t('sumValid'), value: preview.valid, tone: 'good' },
            { label: t('sumInvalid'), value: preview.invalid, tone: preview.invalid > 0 ? 'bad' : undefined },
            { label: t('sumDuplicates'), value: preview.duplicates },
            {
              label: t('sumExisting'),
              value: preview.existingMonths,
              tone: preview.existingMonths > 0 ? 'warn' : undefined,
            },
            { label: t('sumMonthsReady'), value: readyMonths.length, tone: 'good' },
            { label: t('sumMonthsTotal'), value: preview.months.length },
            { label: t('sumUpdated'), value: 0 },
          ]}
        />

        {preview.missingColumns.length > 0 && (
          <div className="border-t border-border bg-red-50/60 px-4 py-2.5 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-400">
            {t('missingColumns')}{' '}
            {preview.missingColumns.map((c) => (
              <code key={c} className="mx-0.5">
                {c}
              </code>
            ))}
          </div>
        )}

        {preview.existingMonths > 0 && (
          <div className="border-t border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
            {t('existingBanner')}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 rounded"
              checked={acknowledged}
              onChange={(e) => onAcknowledge(e.target.checked)}
            />
            <span>{t('acknowledgeLabel')}</span>
          </label>
          <Button
            onClick={onImport}
            disabled={busy || readyMonths.length === 0 || !acknowledged}
            size="sm"
            className="ml-auto"
          >
            {busy ? t('importing') : t('importMonths', { count: readyMonths.length })}
          </Button>
        </div>
      </Card>

      {/* Per-employee-month outcome — the unit that is imported or held back, never half of one. */}
      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{t('monthsTitle')}</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colEmployeeNo')}</th>
                <th className="px-4 py-2 font-medium">{t('colPeriod')}</th>
                <th className="px-4 py-2 font-medium">{t('colCycle')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colLines')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colGross')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colNet')}</th>
                <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {preview.months.map((m) => (
                <tr
                  key={m.key}
                  className={m.ok ? '' : m.existing ? 'bg-amber-50/40 dark:bg-amber-500/5' : 'bg-red-50/40 dark:bg-red-500/5'}
                >
                  <td className="px-4 py-2 font-medium">{m.employeeNo}</td>
                  <td className="px-4 py-2 text-muted-foreground">{m.period}</td>
                  <td className="px-4 py-2 text-muted-foreground">{m.cycle}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{m.lineCount}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{m.gross.toFixed(2)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{m.net.toFixed(2)}</td>
                  <td className="px-4 py-2">
                    {m.ok ? (
                      <Badge variant="success">{t('statusReady')}</Badge>
                    ) : m.existing ? (
                      <Badge variant="warning">{t('statusExisting')}</Badge>
                    ) : (
                      <Badge variant="danger">{t('statusHeld')}</Badge>
                    )}
                  </td>
                </tr>
              ))}
              {preview.months.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    {t('noMonths')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* The reporter's validation result, column for column. */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{t('issuesTitle')}</h2>
          {preview.issues.length > 0 && (
            <button type="button" className="text-sm text-primary hover:underline" onClick={onDownloadIssues}>
              {t('downloadErrors')}
            </button>
          )}
        </div>
        {preview.issues.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('noIssues')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('colRow')}</th>
                  <th className="px-4 py-2 font-medium">{t('colEmployeeNo')}</th>
                  <th className="px-4 py-2 font-medium">{t('colPeriod')}</th>
                  <th className="px-4 py-2 font-medium">{t('colDoeCode')}</th>
                  <th className="px-4 py-2 font-medium">{t('colErrorType')}</th>
                  <th className="px-4 py-2 font-medium">{t('colErrorDescription')}</th>
                  <th className="px-4 py-2 font-medium">{t('colImportStatus')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {preview.issues.map((i, idx) => (
                  <tr key={`${i.rowNum}-${i.type}-${idx}`}>
                    <td className="px-4 py-2 tabular-nums text-muted-foreground">{i.rowNum}</td>
                    <td className="px-4 py-2 font-medium">{i.employeeNo || '—'}</td>
                    <td className="px-4 py-2 text-muted-foreground">{i.period || '—'}</td>
                    <td className="px-4 py-2 text-muted-foreground">{i.doeCode || '—'}</td>
                    <td className="px-4 py-2">{i.type}</td>
                    <td className="px-4 py-2 text-muted-foreground">{i.description}</td>
                    <td className="px-4 py-2">
                      <Badge
                        variant={
                          i.status === 'Failed' ? 'danger' : i.status === 'Needs action' ? 'warning' : 'default'
                        }
                      >
                        {i.status === 'Failed'
                          ? t('statusFailed')
                          : i.status === 'Needs action'
                            ? t('statusNeedsAction')
                            : t('statusWarning')}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
