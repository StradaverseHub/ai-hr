'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { UploadCloud } from 'lucide-react';

import { Badge, Button, Card } from '@/components/ui';
import {
  TXN_IMPORT_ERROR_FILENAME,
  TXN_IMPORT_FILENAME,
  type TxnImportKind,
  type TxnImportPreview,
  type TxnImportResult,
  type TxnImportRow,
} from '@/lib/payroll-txn-import-schema';
import { buildTxnImportWorkbook, type TxnTemplateReference } from '@/lib/import-template-xlsx';
import { commitTxnImportAction, validateTxnImportAction } from './actions';

/**
 * 5c65367d — ONE upload/preview/confirm surface, mounted on BOTH transaction screens.
 *
 * The reporter asked for "a shared UI pattern between Fixed Transaction and Individual Transaction,
 * while each screen continues to apply its own transaction rules". That is exactly the split: this
 * component is identical for both and knows nothing about pay components or ledgers; `kind` picks the
 * column contract, and every rule lives behind the two server actions in the live services.
 *
 * ── WHY A DIALOG AND NOT A PAGE ──────────────────────────────────────────────────────────────────────
 * A new guarded `page.tsx` would need a column in lib/permissions.ts (the list is EXACT — the reverse-
 * completeness check in test/function-access.test.ts fails the build for a guarded page with no column),
 * and it would put the import a navigation away from the list it changes. The Add form on Fixed
 * Transaction is already a Radix dialog for the same reason (ee21508c: the LIST is the primary surface),
 * so this matches the screen it sits on rather than inventing a second convention.
 *
 * ── .XLSX ONLY, AND ONLY HERE ────────────────────────────────────────────────────────────────────────
 * The ticket is explicit: .csv, .xls, .txt, .pdf are all refused with one message. The r185 history
 * import deliberately accepts .csv and .xls as well and is NOT narrowed — that screen's contract is its
 * own, and a migration file that arrives as CSV is a legitimate thing there.
 *
 * ── THE SERVER NEVER SEES A WORKBOOK ─────────────────────────────────────────────────────────────────
 * `workbookToCsvText` runs in the browser and reads the FIRST worksheet only, which is why the template's
 * fill-in sheet is sheet 1 and every reference list comes after it.
 */

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** .xlsx ONLY. Both the picker filter and the explicit extension check below — the filter is a hint a
 *  determined operator can bypass with "All files", so it is not the guard. */
const ACCEPT = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Next server actions default to a ~1 MB body. A 2,000-row transaction file is well under 200 KB. */
const MAX_CSV_BYTES = 900_000;

function download(bytes: BlobPart, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function TxnImportButtons({
  kind,
  reference,
}: {
  kind: TxnImportKind;
  /** The live catalogues, read by the SCREEN from the same source the validator resolves against. */
  reference: TxnTemplateReference;
}) {
  const t = useTranslations('payroll.txnImport');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<TxnImportPreview | null>(null);
  const [result, setResult] = useState<TxnImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setCsv('');
    setFileName(null);
    setPreview(null);
    setResult(null);
    setError(null);
  };

  /** Resolve one row's failure reason. The key is resolved HERE, against the operator's own catalogue,
   *  which is why the server sends a key and not a sentence — an error report has to be readable in the
   *  language the reader picked. */
  const reasonText = (r: TxnImportRow): string =>
    r.ok ? t('statusValid') : t(`reason.${r.reason}` as never, (r.detail ?? {}) as never);

  const loadFile = async (file: File) => {
    setError(null);
    setResult(null);
    setPreview(null);
    // THE FILE-TYPE GATE, and it is an extension check rather than a MIME check on purpose: browsers
    // disagree about the MIME type of an .xlsx (and Windows sometimes reports the .xls one), so trusting
    // `file.type` would refuse files that are perfectly correct.
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setError(t('invalidFormat'));
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setReading(true);
    try {
      const { workbookToCsvText } = await import('@/lib/spreadsheet');
      let text: string;
      try {
        text = await workbookToCsvText(await file.arrayBuffer());
      } catch (e) {
        setError((e as Error).message === 'EMPTY_SHEET' ? t('emptySheet') : t('fileReadError'));
        return;
      }
      if (new Blob([text]).size > MAX_CSV_BYTES) {
        setError(t('fileTooLarge'));
        return;
      }
      setCsv(text);
      setFileName(file.name);
      startTransition(async () => {
        try {
          setPreview(await validateTxnImportAction(text, kind));
        } catch {
          setError(t('fileReadError'));
        }
      });
    } catch {
      setError(t('fileReadError'));
    } finally {
      setReading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const confirmImport = () =>
    startTransition(async () => {
      setError(null);
      try {
        const r = await commitTxnImportAction(csv, kind);
        setResult(r);
        setPreview(null);
        router.refresh();
      } catch {
        setError(t('fileReadError'));
      }
    });

  /** The template: a real workbook whose fill-in sheet is FIRST and whose reference sheets are generated
   *  from the same catalogues the validator resolves against. */
  const downloadTemplate = async () => {
    setError(null);
    try {
      download(
        (await buildTxnImportWorkbook(kind, reference)) as BlobPart,
        TXN_IMPORT_FILENAME[kind],
        XLSX_MIME,
      );
    } catch {
      setError(t('fileReadError'));
    }
  };

  /** The error report, as an .xlsx the operator corrects and re-uploads — the reporter's own four
   *  columns (Row, Employee ID, Pay Item, Error), plus the employee name so a row is identifiable
   *  without cross-referencing. Same `buildXlsx` the template uses. */
  const downloadIssues = async (rows: TxnImportRow[]) => {
    setError(null);
    try {
      const { buildXlsx } = await import('@/lib/spreadsheet');
      const header = [t('colRow'), t('colEmployeeId'), t('colEmployeeName'), t('colPayItemCode'), t('colError')];
      const bytes = await buildXlsx(
        header,
        rows.map((r) => [String(r.rowNum), r.employeeId, r.employeeName, r.payItemCode, reasonText(r)]),
        // Employee ID and Pay Item Code stay TEXT so a code with a leading zero survives the round trip
        // back into Excel — the same guard the template applies to the same two columns.
        { sheetName: 'Validation Result', textColumns: [1, 3] },
      );
      download(bytes as BlobPart, TXN_IMPORT_ERROR_FILENAME[kind], XLSX_MIME);
    } catch {
      setError(t('fileReadError'));
    }
  };

  const failedRows = preview?.rows.filter((r) => !r.ok) ?? [];

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        {t('importExcel')}
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={downloadTemplate}>
        {t('downloadTemplate')}
      </Button>

      <Dialog.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100%-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
            <Dialog.Title className="text-base font-semibold">{t(`title.${kind}`)}</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted-foreground">{t('intro')}</Dialog.Description>

            <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto">
              {/* ── 1. Pick a file ── */}
              <Card className="p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ACCEPT}
                    id={`txn-import-${kind}`}
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void loadFile(f);
                    }}
                  />
                  <label
                    htmlFor={`txn-import-${kind}`}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
                  >
                    <UploadCloud className="h-4 w-4" aria-hidden="true" />
                    {t('chooseFile')}
                  </label>
                  <span className="text-xs text-muted-foreground">
                    {reading || pending ? t('reading') : (fileName ?? t('noFile'))}
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{t('xlsxOnlyHint')}</p>
              </Card>

              {error && <p className="text-sm text-destructive">{error}</p>}

              {/* ── 2. The preview. NOTHING IS WRITTEN YET, and that is the product. ── */}
              {preview && (
                <div className="space-y-3">
                  {preview.fileError ? (
                    <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {t(`fileError.${preview.fileError}` as never)}
                    </p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-4 text-sm">
                        <span>{t('totalRecords', { count: preview.total })}</span>
                        <span className="text-emerald-700 dark:text-emerald-400">
                          {t('validRecords', { count: preview.valid })}
                        </span>
                        <span className="text-destructive">{t('errorRecords', { count: preview.invalid })}</span>
                        {preview.invalid > 0 && (
                          <Button type="button" size="sm" variant="outline" onClick={() => downloadIssues(failedRows)}>
                            {t('downloadErrors')}
                          </Button>
                        )}
                      </div>

                      <div className="overflow-x-auto rounded-lg border border-border">
                        <table className="w-full min-w-[720px] text-sm">
                          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                            <tr>
                              <th className="px-3 py-2 font-medium">{t('colRow')}</th>
                              <th className="px-3 py-2 font-medium">{t('colEmployeeId')}</th>
                              <th className="px-3 py-2 font-medium">{t('colEmployeeName')}</th>
                              <th className="px-3 py-2 font-medium">{t('colPayItem')}</th>
                              <th className="px-3 py-2 text-right font-medium">{t('colAmount')}</th>
                              <th className="px-3 py-2 font-medium">{t('colEffectiveFrom')}</th>
                              <th className="px-3 py-2 font-medium">{t('colStatus')}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {preview.rows.map((r) => (
                              <tr key={r.rowNum} className={r.ok ? '' : 'bg-red-50/60 dark:bg-red-500/10'}>
                                <td className="px-3 py-2 tabular-nums">{r.rowNum}</td>
                                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{r.employeeId}</td>
                                <td className="whitespace-nowrap px-3 py-2">{r.employeeName || '—'}</td>
                                <td className="whitespace-nowrap px-3 py-2">
                                  <span className="font-mono text-xs">{r.payItemCode}</span>
                                  {r.payItem ? <span className="text-muted-foreground"> {r.payItem}</span> : null}
                                </td>
                                {/* THE FIGURE THAT WILL BE STORED. On a calculating pay item that is the
                                    server's derived amount, not the one typed into the file — a preview
                                    showing a different number from the one it writes is not a preview. */}
                                <td className="px-3 py-2 text-right tabular-nums">{r.amount || '—'}</td>
                                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{r.effectiveFrom || '—'}</td>
                                <td className="px-3 py-2">
                                  {r.ok ? (
                                    <Badge variant="success">{t('statusValid')}</Badge>
                                  ) : (
                                    <span className="text-xs text-destructive">{reasonText(r)}</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* ── 3. What actually happened ── */}
              {result && (
                <div className="space-y-3">
                  <p className="text-sm font-medium">{t('importedRecords', { count: result.written })}</p>
                  {result.recalcBatchIds.length > 0 && (
                    <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                      {/* Imported rows behave exactly like typed ones: landing on a processed run marks
                          it for recalculation rather than being quietly counted as already paid. */}
                      {t('recalcNotice', { count: result.recalcBatchIds.length })}
                    </p>
                  )}
                  {result.failed.length > 0 && (
                    <>
                      <p className="text-sm text-destructive">{t('failedRecords', { count: result.failed.length })}</p>
                      <ul className="space-y-1 text-xs text-destructive">
                        {result.failed.map((r) => (
                          <li key={r.rowNum}>
                            {t('failedLine', { row: r.rowNum, employee: r.employeeId, reason: reasonText(r) })}
                          </li>
                        ))}
                      </ul>
                      <Button type="button" size="sm" variant="outline" onClick={() => downloadIssues(result.failed)}>
                        {t('downloadErrors')}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-border pt-4">
              <Dialog.Close asChild>
                <Button type="button" variant="outline" size="sm">
                  {result ? t('close') : t('cancel')}
                </Button>
              </Dialog.Close>
              {/* Only the VALID rows are written, and only when this is pressed. Disabled while there is
                  nothing to write, so the button can never be a no-op that looks like a success. */}
              {!result && (
                <Button
                  type="button"
                  size="sm"
                  disabled={pending || !preview || !!preview.fileError || preview.valid === 0}
                  onClick={confirmImport}
                >
                  {pending ? t('importing') : t('confirmImport', { count: preview?.valid ?? 0 })}
                </Button>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
