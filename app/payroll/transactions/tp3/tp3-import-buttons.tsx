'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { UploadCloud } from 'lucide-react';

import { Button, Card } from '@/components/ui';
import { bulkJobActive } from '@/lib/bulk-job';
import {
  TP3_IMPORT_LOG, TP3_IMPORT_MAX_CSV_BYTES, TP3_IMPORT_SAMPLE_FILENAME, TP3_IMPORT_TEMPLATE_FILENAME,
  type Tp3ImportCatalogue, type Tp3ImportColumn,
} from '@/lib/tp3-import-columns';
import type { Tp3WorkbookCopy, Tp3WorkbookEmployee } from '@/lib/tp3-import-workbook';
import type { Tp3ImportDetail, Tp3ImportResultRow } from '@/core/tp3-import-job';
import { checkTp3ImportAction, confirmTp3ImportAction, readTp3ImportAction } from './import-actions';
import { tp3ColumnLabel, tp3RowReason } from './tp3-import-text';

/**
 * 5084d02e — Form TP3's four import buttons: Download Template, Sample Reference, Import Excel, Import Log.
 *
 * Import Excel is CHECK, THEN CONFIRM. The browser turns the first sheet into CSV (lib/spreadsheet.ts, the same
 * decoder every import uses), queues a check job and follows it; the dialog shows how many rows are ready and every
 * problem as row, Employee ID, column and reason. Nothing is saved until Save is pressed, which sends the SAME text
 * again with the check job's id (the kernel keeps no uploaded file after a job ends) and opens the saved import's page.
 * Pressing Save twice returns the same save job (its key is derived from the check).
 *
 * .xlsx ONLY, checked by extension (browsers disagree about the MIME type of an .xlsx).
 */
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ACCEPT = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function download(bytes: BlobPart, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function Tp3ImportButtons({ catalogue, employees }: { catalogue: Tp3ImportCatalogue; employees: Tp3WorkbookEmployee[] }) {
  const t = useTranslations('payroll.tp3Import');
  const tr = useTranslations('taxRelief');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Tp3ImportDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const operationKey = useRef<string | null>(null);

  const reset = () => {
    setCsv(''); setFileName(null); setJobId(null); setJob(null); setError(null);
    operationKey.current = null;
  };
  const refusalText = (code: string) => (t.has(`error.${code}` as never) ? t(`error.${code}` as never) : t('error.unavailable'));

  // Follow the check until it ends. One read per tick; it stops as soon as the job is terminal or the dialog closes.
  useEffect(() => {
    if (!open || !jobId || (job && !bulkJobActive(job.state))) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      const read = await readTp3ImportAction(jobId).catch(() => null);
      if (stopped) return;
      if (!read) { setError(t('error.unavailable')); return; }
      if (!read.ok) { setError(refusalText(read.error)); setJobId(null); return; }
      setJob(read.job);
    }, 1500);
    return () => { stopped = true; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, jobId, job?.state]);

  // ── The workbook copy, from the catalogue's own wording ──
  const box = (column: Extract<Tp3ImportColumn, { kind: 'amount' }>) => {
    const base = column.section === 'C' ? `tp3.money.${column.code}` : `items.${column.code}`;
    const key = column.sub ? `${base}.sub.${column.sub}` : `${base}.label`;
    return tr.has(key as never) ? tr(key as never) : '';
  };
  const copy: Tp3WorkbookCopy = {
    sheetImport: t('template.sheetImport'),
    sheetInstructions: t('template.sheetInstructions'),
    sheetEmployees: t('template.sheetEmployees'),
    wording: (column) => {
      switch (column.kind) {
        case 'amount': return box(column);
        case 'employerName': return t('template.column.employerName', { n: column.employer });
        case 'employerTin': return t('template.column.employerTin', { n: column.employer });
        default: return t(`template.column.${column.kind}`);
      }
    },
    format: (column) => {
      switch (column.kind) {
        case 'employeeId': return t('template.formatEmployeeId');
        case 'assessmentYear': return t('template.formatYear');
        case 'deductionMonth': return t('template.formatMonth');
        case 'amount': return t('template.formatAmount');
        default: return t('template.formatText', { max: column.max });
      }
    },
    limit: (column) => {
      if (column.kind !== 'amount') return '';
      if (column.exemptionLimit != null) return t('template.limitExempt', { limit: money(column.exemptionLimit) });
      const item = `D${column.code.replace(/^c/, '')}`;
      if (column.limit != null && column.groupLimit != null) return t('template.limitAmountGroup', { limit: money(column.limit), item, groupLimit: money(column.groupLimit) });
      if (column.limit != null) return t('template.limitAmount', { limit: money(column.limit) });
      if (column.groupLimit != null) return t('template.limitGroup', { item, limit: money(column.groupLimit) });
      return column.section === 'D' ? t('template.limitNone') : '';
    },
    required: t('template.required'),
    optional: t('template.optional'),
    title: t('template.title'),
    intro: [t('template.intro1'), t('template.intro2'), t('template.intro3')],
    instructionsHeader: [t('template.headColumn'), t('template.headMeaning'), t('template.headRequired'), t('template.headFormat'), t('template.headLimit')],
    employeesHeader: [t('template.employeesCode'), t('template.employeesName'), t('template.employeesCompany')],
  };
  const buildAndDownload = async (kind: 'template' | 'sample') => {
    setError(null);
    try {
      const { buildTp3ImportWorkbook } = await import('@/lib/tp3-import-workbook');
      const bytes = await buildTp3ImportWorkbook(catalogue, kind === 'sample' ? { ...copy, intro: [...copy.intro, t('template.sampleNote')] } : copy,
        kind === 'sample' ? { kind } : { kind, employees });
      download(bytes as BlobPart, kind === 'sample' ? TP3_IMPORT_SAMPLE_FILENAME : TP3_IMPORT_TEMPLATE_FILENAME);
    } catch {
      setError(t('error.fileReadError'));
    }
  };

  const loadFile = async (file: File) => {
    reset();
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setError(t('error.invalidFormat'));
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
        setError((e as Error).message === 'EMPTY_SHEET' ? t('error.emptySheet') : t('error.fileReadError'));
        return;
      }
      if (new Blob([text]).size > TP3_IMPORT_MAX_CSV_BYTES) { setError(t('error.fileTooLarge')); return; }
      setCsv(text);
      setFileName(file.name);
      operationKey.current = crypto.randomUUID();
      const key = operationKey.current;
      startTransition(async () => {
        const queued = await checkTp3ImportAction({ csv: text, fileName: file.name, operationKey: key }).catch(() => null);
        if (!queued) { setError(t('error.unavailable')); return; }
        if (!queued.ok) { setError(refusalText(queued.error)); return; }
        setJobId(queued.id);
      });
    } finally {
      setReading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const confirm = () => startTransition(async () => {
    if (!job || !fileName) return;
    setError(null);
    const saved = await confirmTp3ImportAction({ checkJobId: job.id, csv, fileName }).catch(() => null);
    if (!saved) { setError(t('error.unavailable')); return; }
    if (!saved.ok) { setError(refusalText(saved.error)); return; }
    setOpen(false);
    router.push(`${TP3_IMPORT_LOG}/${saved.id}`);
  });

  const checking = !!jobId && (!job || bulkJobActive(job.state));
  const checked = job && job.state === 'completed' ? job : null;
  const problems: Tp3ImportResultRow[] = checked?.rows.filter((row) => row.state === 'problem') ?? [];
  const fileFailed = job && job.state === 'failed' ? job : null;

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => void buildAndDownload('template')}>{t('downloadTemplate')}</Button>
      <Button type="button" variant="outline" size="sm" onClick={() => void buildAndDownload('sample')}>{t('sampleReference')}</Button>
      <Button type="button" size="sm" onClick={() => { reset(); setOpen(true); }}>{t('importExcel')}</Button>
      <Button asChild variant="outline" size="sm"><Link href={TP3_IMPORT_LOG}>{t('importLog')}</Link></Button>
      {error && !open ? <p role="alert" className="w-full text-sm text-destructive">{error}</p> : null}

      <Dialog.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100%-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
            <Dialog.Title className="text-base font-semibold">{t('dialogTitle')}</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted-foreground">{t('dialogIntro')}</Dialog.Description>

            <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto">
              <Card className="p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <input ref={fileInputRef} type="file" accept={ACCEPT} id="tp3-import-file" className="sr-only"
                    disabled={checking || pending}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadFile(f); }} />
                  <label htmlFor="tp3-import-file"
                    className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted">
                    <UploadCloud className="h-4 w-4" aria-hidden="true" />
                    {t('chooseFile')}
                  </label>
                  <span className="text-xs text-muted-foreground">{reading ? t('reading') : (fileName ?? t('noFile'))}</span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{t('xlsxOnly')}</p>
              </Card>

              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

              {checking && (
                <p className="text-sm text-muted-foreground" aria-live="polite">
                  {job?.workerStatus === 'unavailable' ? t('waitingForService') : t('checking')}
                </p>
              )}

              {fileFailed && (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {fileFailed.error && t.has(`fileError.${fileFailed.error}` as never)
                    ? t(`fileError.${fileFailed.error}` as never, (fileFailed.fileDetail ?? {}) as never)
                    : t('fileError.failed')}
                </p>
              )}

              {checked && (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-3">
                    <Count value={checked.ready} label={t('readyCount')} tone="text-emerald-700 dark:text-emerald-400" />
                    <Count value={checked.failed} label={t('problemCount')} tone="text-destructive" />
                    <Count value={checked.total} label={t('rowCount')} tone="text-foreground" />
                  </div>
                  <p className="text-xs text-muted-foreground">{t('replaceNote')}</p>
                  {problems.length > 0 ? (
                    <div className="overflow-x-auto rounded-lg border border-border">
                      <table className="w-full min-w-[560px] text-sm">
                        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="px-3 py-2 font-medium">{t('colRow')}</th>
                            <th className="px-3 py-2 font-medium">{t('colEmployeeId')}</th>
                            <th className="px-3 py-2 font-medium">{t('colColumn')}</th>
                            <th className="px-3 py-2 font-medium">{t('colReason')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {problems.map((row) => (
                            <tr key={row.rowNum}>
                              <td className="px-3 py-2 tabular-nums">{row.rowNum}</td>
                              <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{row.employeeId || '—'}</td>
                              <td className="whitespace-nowrap px-3 py-2">{tp3ColumnLabel(t, row.field)}</td>
                              <td className="px-3 py-2 text-destructive">{tp3RowReason(t, row)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-emerald-700 dark:text-emerald-400">{t('allReady')}</p>
                  )}
                  {checked.ready === 0 && <p className="text-sm text-destructive">{t('noReadyRows')}</p>}
                </div>
              )}
            </div>

            <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-border pt-4">
              <Dialog.Close asChild>
                <Button type="button" variant="outline" size="sm">{t('cancel')}</Button>
              </Dialog.Close>
              <Button type="button" size="sm" aria-busy={pending} disabled={pending || !checked || checked.ready === 0} onClick={confirm}>
                {pending && checked ? t('saving') : t('saveReady', { count: checked?.ready ?? 0 })}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function Count({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <div className="min-w-24 rounded-lg border border-border px-4 py-3">
      <p className={`text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
