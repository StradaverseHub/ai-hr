'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UploadCloud } from 'lucide-react';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { DownloadTemplate } from '@/components/download-template';
import { leaveBfImportTemplate, LEAVE_BF_XLSX_HEADERS } from '@/lib/import-template';
import { toCsv } from '@/lib/csv';
import { IMPORT_FILE_ACCEPT, importFileMessageKey, readImportFile } from '@/lib/import-file';
import {
  LEAVE_BF_COLUMNS,
  LEAVE_BF_IMPORT_MODES,
  LEAVE_BF_STEPS,
  leaveBfRunOutcome,
  resolveLeaveBfImportOptions,
  type LeaveBfBalanceImpact,
  type LeaveBfImportError,
  type LeaveBfImportMode,
  type LeaveBfImportPreview,
  type LeaveBfImportResult,
  type LeaveBfImportSource,
  type LeaveBfRowResult,
  type LeaveBfRunRow,
  type LeaveBfStep,
} from '@/lib/leave-bf-import-schema';
import {
  validateLeaveBfImportAction,
  commitLeaveBfImportAction,
  reverseLeaveBfImportAction,
} from './actions';

/**
 * db55d08a (r369) — the Leave B/F Data Import workbench, drawn as the six steps the reporter set out:
 * Download Template › Upload Excel › Validate › Preview Results › Confirm Import › Import Summary.
 * Nothing is written until Confirm Import, and the preview is reached by validating first.
 *
 * A CLIENT island for the three reasons its sibling is one and no others: the workbook is decoded IN THE
 * BROWSER (so no spreadsheet ever reaches a server action), the template and the error report are built in
 * the browser from data already in hand, and the step rail reflects state the user is holding. The run log
 * arrives as props from the RSC page — nothing is fetched here.
 *
 * THE STEP RAIL IS DERIVED FROM STATE, never from a click. A rail you can click your way along lies about
 * where you are; this one is the answer to "what has actually happened to this file".
 */
const MAX_PREVIEW_ROWS = 500;

type Phase = 'idle' | 'previewed' | 'done';

export function LeaveBfImport({ runs }: { runs: LeaveBfRunRow[] }) {
  const t = useTranslations('admin.leaveBfImport');
  const router = useRouter();
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<LeaveBfImportPreview | null>(null);
  const [result, setResult] = useState<LeaveBfImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [templateTaken, setTemplateTaken] = useState(false);
  const [pending, startTransition] = useTransition();
  const [source, setSource] = useState<LeaveBfImportSource>({ kind: 'paste' });
  const [fileInfo, setFileInfo] = useState<{ name: string; rows: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /**
   * THE REPORTER'S IMPORT MODE, and its default comes from the CONTRACT, not from a literal `'replace'`
   * written here. `resolveLeaveBfImportOptions()` is the same function the server resolves with, so the
   * control cannot start out showing one behaviour while the server would run the other.
   */
  const [mode, setMode] = useState<LeaveBfImportMode>(resolveLeaveBfImportOptions().mode);

  const reset = () => {
    setPreview(null);
    setResult(null);
    setPhase('idle');
    setError(null);
  };

  /**
   * The mode is passed EXPLICITLY on every validate, and the preview is re-fetched whenever it changes. A
   * preview computed under Replace and then read under Add would show a movement Confirm import is not
   * going to make.
   */
  const runValidate = (text: string, m = mode) =>
    startTransition(async () => {
      setError(null);
      try {
        const p = await validateLeaveBfImportAction(text, m);
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
        const r = await commitLeaveBfImportAction(csv, mode, source);
        setResult(r);
        setPhase('done');
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const rollback = (runId: string) => {
    onCommitPending?.(true);
    startTransition(async () => {
      setError(null);
      try {
        await reverseLeaveBfImportAction(runId);
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        onCommitPending?.(false);
      }
    });
  };

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
      // `importFileMessageKey` maps a thrown ImportFileError to a key in THIS namespace, which is why every
      // one of its codes has a string here. A computed key is invisible to the i18n static-key check, so
      // test/leave-bf-import-screen.test.ts pins the set in six locales.
      setError(t(importFileMessageKey(e)));
    } finally {
      setReading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /** Step 1, the Excel form: the reporter's own five headings, derived from the contract. */
  const downloadXlsxTemplate = async () => {
    setError(null);
    try {
      const { buildXlsx } = await import('@/lib/spreadsheet');
      const bytes = await buildXlsx(LEAVE_BF_XLSX_HEADERS, leaveBfImportTemplate.sampleRows, {
        sheetName: 'Leave BF',
        // Employee ID is an IDENTITY string: "0012" must survive a round trip through Excel, which would
        // otherwise turn it into the number 12. Entitlement Year is text-typed for the same reason — a
        // year rendered as 2,026 by a locale-aware save is a year the validator rejects.
        textColumns: [0, 2],
      });
      const url = URL.createObjectURL(
        new Blob([bytes as BlobPart], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = 'leave-bf-import-template.xlsx';
      a.click();
      URL.revokeObjectURL(url);
      setTemplateTaken(true);
    } catch {
      setError(t('fileReadError'));
    }
  };

  /**
   * The error report. Built in the browser from rows the server already sent, and routed through `toCsv`,
   * whose `csvSafeCell` guard is what stops a cell beginning `=` becoming a formula when HR opens the
   * report in Excel — it echoes back values the file supplied.
   */
  const downloadErrors = (rows: LeaveBfImportError[]) => {
    const csvOut = toCsv([
      [t('colRow'), t('colEmployee'), t('colCode'), t('colYear'), t('colReason')],
      ...rows.map((r) => [r.rowNum, r.employeeId, r.leaveCode, r.entitlementYear, r.errors.join('; ')]),
    ]);
    const url = URL.createObjectURL(new Blob([csvOut], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'leave-bf-import-errors.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  /** Every row the preview would not import, as the report carries them. */
  const rejectedRows = useMemo<LeaveBfImportError[]>(
    () =>
      (preview?.rows ?? [])
        .filter((r) => r.status !== 'valid')
        .map((r) => ({
          rowNum: r.rowNum,
          employeeId: r.employeeId,
          leaveCode: r.leaveCode,
          entitlementYear: r.entitlementYear,
          errors: r.errors,
        })),
    [preview],
  );

  // Derived, never clicked: where this file has actually got to.
  const currentStep: LeaveBfStep =
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

      {/* The reporter's go-live order, ON the screen. Loading B/F before the year's entitlements are
          generated risks the year-end carry rule trimming the figure that was just loaded, and the order of
          the work is not something an administrator should have to remember from a plan document. */}
      <SequenceNotice />

      <Card id="leave-bf-import-form" className="scroll-mt-6 p-5">
        {/* Step 1 — the template, in both forms. The Excel one carries the reporter's headings. */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void downloadXlsxTemplate()}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
          >
            {t('downloadTemplateXlsx')}
          </button>
          <DownloadTemplate spec={leaveBfImportTemplate} onDownloaded={() => setTemplateTaken(true)} />
        </div>

        {/* The one thing users get wrong, said next to the template rather than in it. */}
        <p className="mb-4 rounded-lg border border-sky-200 bg-sky-50/50 px-3 py-2 text-xs text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">
          {t('yearMeaning')}
        </p>

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

        {/* Step 2½ — the reporter's Replace / Add choice, ABOVE Validate, because its answer is what the
            preview then shows the consequence of. Changing it re-validates, so the movement on screen always
            belongs to the mode on screen. */}
        <ModeQuestion
          value={mode}
          onChange={(next) => {
            setMode(next);
            setResult(null);
            // Only re-validate when there is something to re-validate; `next` is passed explicitly because
            // this state update has not been applied yet when the transition starts.
            if (csv.trim()) runValidate(csv, next);
            else setPreview(null);
          }}
          disabled={pending || reading}
        />

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
            {LEAVE_BF_COLUMNS.map((c) => (
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

      {/* Step 6 — the summary. */}
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
            {result.errorsTruncated && (
              <li className="text-xs text-muted-foreground">
                {t('resultTruncated', { shown: result.errors.length, total: result.failed })}
              </li>
            )}
            {/* No leave record was created, said again at the end: it is the difference between this tool
                and the row above it, and the moment somebody checks is right after an import. */}
            <li className="text-xs text-muted-foreground">{t('resultNoRecord')}</li>
          </ul>
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3 text-sm">
            <Link href="/leave/employee-balances" className="text-primary hover:underline">
              {t('viewBalances')}
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

      <ImportLog runs={runs} onDownload={downloadErrors} onRollback={rollback} busy={pending} />
    </div>
  );
}

/** The six steps, with the one the file has actually reached marked. Not clickable: it is a readout. */
function StepRail({ current }: { current: LeaveBfStep }) {
  const t = useTranslations('admin.leaveBfImport');
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="leave-bf-import-steps">
      {LEAVE_BF_STEPS.map((s, i) => {
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
 * THE GO-LIVE ORDER, PRINTED. The reporter's own sequence, and it is on the screen rather than only in the
 * plan because loading B/F before the year's entitlements are generated risks the year-end carry rule
 * trimming the figure that was just loaded — a silent wrong number, not an error.
 */
function SequenceNotice() {
  const t = useTranslations('admin.leaveBfImport');
  return (
    <Card className="border-border bg-muted/30 p-4">
      <h2 className="text-sm font-semibold">{t('sequenceTitle')}</h2>
      <ol className="mt-1 list-inside list-decimal space-y-0.5 text-sm text-muted-foreground">
        <li>{t('sequence1')}</li>
        <li>{t('sequence2')}</li>
        <li>{t('sequence3')}</li>
        <li>{t('sequence4')}</li>
      </ol>
    </Card>
  );
}

/**
 * THE REPORTER'S REPLACE / ADD CHOICE.
 *
 * TWO RADIOS, NOT A CHECKBOX. A checkbox would make one of the two answers the unlabelled absence of the
 * other, and both are real, deliberate migration shapes a reader has to recognise their own file in. Replace
 * is the default because the reporter asked for it as the default and because it is what makes re-running a
 * corrected file safe.
 *
 * The hint under Replace says WHAT IT DOES NOT DO, which is the part that would otherwise surprise: it
 * negates only what a previous B/F import put there, never the rest of the prior-year balance.
 *
 * `name` is fixed rather than generated: there is exactly one of these on the page.
 */
function ModeQuestion({
  value,
  onChange,
  disabled,
}: {
  value: LeaveBfImportMode;
  onChange: (next: LeaveBfImportMode) => void;
  disabled: boolean;
}) {
  const t = useTranslations('admin.leaveBfImport');
  return (
    <fieldset className="mt-4 border-t border-border pt-4" data-testid="leave-bf-import-mode-choice">
      <legend className="text-sm font-medium">{t('modeQuestion')}</legend>
      <p className="mt-0.5 text-xs text-muted-foreground">{t('modeQuestionHint')}</p>
      <div className="mt-2 space-y-2">
        {LEAVE_BF_IMPORT_MODES.map((m) => (
          <label
            key={m}
            className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
              value === m ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
            }`}
          >
            <input
              type="radio"
              name="bfImportMode"
              className="mt-0.5"
              checked={value === m}
              disabled={disabled}
              onChange={() => onChange(m)}
            />
            <span>
              <span className="font-medium">{t(`mode.${m}.label`)}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t(`mode.${m}.hint`)}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * WHAT BROUGHT FORWARD WILL ACTUALLY READ AFTERWARDS, above Confirm Import, and that position is the
 * requirement: the approved plan promises the reader sees the effect BEFORE pressing the button.
 *
 * Every figure comes off `preview.balanceImpact`, which the SERVER computed from the lines it would write
 * and the ledger as it stands. Nothing is recomputed here: a browser-side sum would be a second derivation
 * of a money figure and would disagree the first time the two drifted.
 *
 * THREE COLUMNS, NOT ONE, because the file's number is not the answer. `broughtForwardAfter` is the raw
 * figure the Explain panel prints; `carriedForwardAfter` is the same figure through the leave type's carry
 * rule, which is what the Employee Balances GRID column prints; `forfeitedBf` is the difference. Load 3.5
 * into a type capped at 2 and the grid reads 2.00 with 1.50 forfeited — and the reader sees that here.
 */
function BalanceImpactSection({ preview }: { preview: LeaveBfImportPreview }) {
  const t = useTranslations('admin.leaveBfImport');
  const rows = preview.balanceImpact;
  const capped = rows.filter((r) => r.capped).length;
  return (
    <div className="border-b border-border" data-testid="leave-bf-import-balance-impact">
      <div className="px-4 py-3">
        <h3 className="text-sm font-semibold">{t('impactTitle')}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {rows.length > 0 ? t('impactHint') : t('impactNoneHint')}
        </p>
      </div>
      {rows.length > 0 && (
        <>
          {capped > 0 && (
            <div className="mx-4 mb-3 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
              {t('impactCappedWarning', { count: capped })}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('colEmployee')}</th>
                  <th className="px-3 py-2 font-medium">{t('impactColCode')}</th>
                  <th className="px-3 py-2 font-medium">{t('colYear')}</th>
                  <th className="px-3 py-2 font-medium">{t('impactColDated')}</th>
                  <th className="px-3 py-2 font-medium">{t('impactColFileDays')}</th>
                  <th className="px-3 py-2 font-medium">{t('impactColBefore')}</th>
                  <th className="px-3 py-2 font-medium">{t('impactColAfter')}</th>
                  <th className="px-3 py-2 font-medium">{t('impactColCarried')}</th>
                  <th className="px-3 py-2 font-medium">{t('impactColForfeited')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <ImpactRow key={`${r.employeeId}-${r.leaveCode}-${r.entitlementYear}`} row={r} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function ImpactRow({ row }: { row: LeaveBfBalanceImpact }) {
  const t = useTranslations('admin.leaveBfImport');
  // 2dp everywhere a day figure is shown, so 2 and 2.00 are never both on screen for one column.
  const n = (v: number) => v.toFixed(2);
  return (
    <tr className={row.capped ? 'bg-amber-50/40 dark:bg-amber-500/5' : undefined}>
      <td className="px-3 py-2">
        <span className="font-medium">{row.employeeId || '—'}</span>
        {row.employeeName && <span className="ml-1.5 text-xs text-muted-foreground">{row.employeeName}</span>}
      </td>
      <td className="px-3 py-2">
        {row.leaveCode || '—'}
        {row.filedCodes.length > 0 && (
          <span className="mt-0.5 block text-[11px] text-muted-foreground">
            {t('impactPooledFrom', { codes: row.filedCodes.join(', ') })}
          </span>
        )}
      </td>
      <td className="px-3 py-2 tabular-nums text-muted-foreground">{row.entitlementYear || '—'}</td>
      <td className="px-3 py-2 tabular-nums text-muted-foreground">{row.effectiveOn || '—'}</td>
      <td className="px-3 py-2 tabular-nums">{n(row.fileDays)}</td>
      <td className="px-3 py-2 tabular-nums">{n(row.broughtForwardBefore)}</td>
      <td className="px-3 py-2 tabular-nums font-medium">{n(row.broughtForwardAfter)}</td>
      <td className="px-3 py-2 tabular-nums font-medium">{n(row.carriedForwardAfter)}</td>
      <td
        className={`px-3 py-2 tabular-nums ${row.capped ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}
      >
        {n(row.forfeitedBf)}
        {row.capped && <span className="mt-0.5 block text-[11px] font-normal">{t('impactCappedFlag')}</span>}
      </td>
    </tr>
  );
}

function PreviewCard({
  preview,
  rejected,
  onImport,
  onDownloadErrors,
  busy,
}: {
  preview: LeaveBfImportPreview;
  rejected: LeaveBfImportError[];
  onImport: () => void;
  onDownloadErrors: () => void;
  busy: boolean;
}) {
  const t = useTranslations('admin.leaveBfImport');
  const shown = preview.rows.slice(0, MAX_PREVIEW_ROWS);
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{t('previewTitle')}</h2>
        {/* What the SERVER resolved, not what the radio shows: the commit re-resolves from its own
            argument, so this is the readout that matters. */}
        <p className="mt-0.5 text-xs text-muted-foreground">{t(`modeReadout.${preview.mode}`)}</p>
      </div>

      <div className="grid grid-cols-3 gap-3 border-b border-border p-4">
        <Tile label={t('totalRecords')} value={preview.total} />
        <Tile label={t('validRecords')} value={preview.validCount} tone="good" />
        <Tile label={t('errorRecords')} value={preview.errorCount} tone="bad" />
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
              <th className="px-3 py-2 font-medium">{t('colCode')}</th>
              <th className="px-3 py-2 font-medium">{t('colYear')}</th>
              <th className="px-3 py-2 font-medium">{t('colDays')}</th>
              <th className="px-3 py-2 font-medium">{t('colDated')}</th>
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

      {/* ABOVE Confirm import, and that position is the requirement. */}
      <BalanceImpactSection preview={preview} />

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

function PreviewRow({ row }: { row: LeaveBfRowResult }) {
  const t = useTranslations('admin.leaveBfImport');
  const tone = row.status === 'error' ? 'bg-red-50/40 dark:bg-red-500/5' : '';
  const badge =
    row.status === 'valid' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
  return (
    <tr className={tone}>
      <td className="px-3 py-2 tabular-nums text-muted-foreground">{row.rowNum}</td>
      <td className="px-3 py-2">
        <span className={badge}>{row.status === 'valid' ? t('statusValid') : t('statusError')}</span>
      </td>
      <td className="px-3 py-2">
        <span className="font-medium">{row.employeeId || '—'}</span>
        {row.employeeName && <span className="ml-1.5 text-xs text-muted-foreground">{row.employeeName}</span>}
      </td>
      <td className="px-3 py-2">
        {row.leaveCode || '—'}
        {row.balanceCode && (
          <span className="mt-0.5 block text-[11px] text-muted-foreground">
            {t('rowPooledInto', { code: row.balanceCode })}
          </span>
        )}
      </td>
      <td className="px-3 py-2 tabular-nums">{row.entitlementYear || '—'}</td>
      <td className="px-3 py-2 tabular-nums">{row.days || '—'}</td>
      <td className="px-3 py-2 tabular-nums text-muted-foreground">{row.effectiveOn || '—'}</td>
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
 * The audit trail AND the rollback, on the same page. Always rendered, empty state included, so an admin
 * who has never imported learns that a record is kept — and that a run can be undone — before they upload
 * anything. The uploaded file itself is not kept (migration 0497's header).
 *
 * A rolled-back run keeps its row and says so. Rollback writes compensating ledger rows rather than
 * deleting, so "what was loaded, and what undid it" stays answerable, and the button is gone rather than
 * disabled once a run has been rolled back.
 */
function ImportLog({
  runs,
  onDownload,
  onRollback,
  busy,
}: {
  runs: LeaveBfRunRow[];
  onDownload: (rows: LeaveBfImportError[]) => void;
  onRollback: (runId: string) => void;
  busy: boolean;
}) {
  const t = useTranslations('admin.leaveBfImport');
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

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
                <th className="px-3 py-2 font-medium">{t('historyColMode')}</th>
                <th className="px-3 py-2 font-medium">{t('historyColBy')}</th>
                <th className="px-3 py-2 font-medium">{t('historyColRecords')}</th>
                <th className="px-3 py-2 font-medium">{t('historyColImported')}</th>
                <th className="px-3 py-2 font-medium">{t('historyColFailed')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {runs.map((run) => {
                const open = openId === run.id;
                const outcome = leaveBfRunOutcome(run);
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
                      {/* The viewer's own locale and timezone: a run is a wall-clock moment for the person
                          who ran it, not an HR date, so it is deliberately NOT routed through the Kuala
                          Lumpur date helper (which answers a different question). */}
                      {new Date(run.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 font-medium">
                      {run.fileName || <span className="font-normal text-muted-foreground">{t('historyPasted')}</span>}
                      <div className={`text-xs font-normal ${outcomeCls}`}>{outcomeLabel}</div>
                      {run.reversedAt && (
                        <div className="text-xs font-normal text-muted-foreground">
                          {t('historyReversed', { when: new Date(run.reversedAt).toLocaleString() })}
                        </div>
                      )}
                      {open && (
                        <div className="mt-2 max-w-md rounded-md bg-muted/40 p-2 text-xs font-normal">
                          <p className="mb-1 text-muted-foreground">
                            {run.errorsTruncated
                              ? t('historyErrorsTruncated', { shown: run.errors.length, total: run.failedRows })
                              : t('historyErrorsShown', { count: run.errors.length })}
                          </p>
                          {run.errors.length === 0 ? (
                            <p className="text-muted-foreground">{t('historyNoDetail')}</p>
                          ) : (
                            <ul className="space-y-1">
                              {run.errors.map((e) => (
                                <li key={e.rowNum}>
                                  <span className="text-muted-foreground">{t('row', { num: e.rowNum })}</span>
                                  {(e.employeeId || e.leaveCode) &&
                                    ` · ${[e.employeeId, e.leaveCode, e.entitlementYear].filter(Boolean).join(' · ')}`}{' '}
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
                    <td className="px-3 py-2 text-muted-foreground">{t(`mode.${run.mode}.short`)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{run.actorName || t('historyActorUnknown')}</td>
                    <td className="px-3 py-2 tabular-nums">{run.totalRows}</td>
                    <td className="px-3 py-2 tabular-nums text-emerald-700 dark:text-emerald-400">
                      {run.importedRows}
                      <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                        {t('historyLedgerRows', { count: run.ledgerRows })}
                      </span>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{run.failedRows}</td>
                    <td className="space-x-2 px-3 py-2 text-right">
                      {run.failedRows > 0 && (
                        <button
                          type="button"
                          onClick={() => setOpenId(open ? null : run.id)}
                          aria-expanded={open}
                          className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted"
                        >
                          {t('historyViewFailed')}
                        </button>
                      )}
                      {/* A rolled-back run is not offered again; a run that wrote nothing has nothing to
                          undo. Two clicks, because this moves days. */}
                      {!run.reversedAt && run.ledgerRows > 0 && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => (confirmId === run.id ? onRollback(run.id) : setConfirmId(run.id))}
                          className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                            confirmId === run.id
                              ? 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-400'
                              : 'border-border hover:bg-muted'
                          }`}
                        >
                          {confirmId === run.id ? t('rollbackConfirm') : t('rollback')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{t('rollbackHint')}</p>
        </div>
      )}
    </Card>
  );
}
