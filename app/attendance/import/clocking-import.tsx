'use client';

/**
 * r424 (50ed39e1) — Import Clocking Data, steps 1 and 2 (step 3 is the import log page this hands off to).
 *
 * The browser's one privileged job is DECODING: the file's bytes go through TextDecoder with the chosen
 * mapping's encoding (so a UTF-16 or Windows-1252 device file arrives as text), and the size ceiling is
 * checked on the decoded text, which is what crosses the server action. Everything else — reading the
 * lines, matching cards, duplicates, refusals — is decided on the server, at Validate and again at Import.
 */
import { useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UploadCloud } from 'lucide-react';
import { Button, inputCls } from '@/components/ui';
import { decodeClockingBytes, physicalLines, type ClockingEncoding } from '@/lib/clocking-file';
import { MAX_IMPORT_CSV_BYTES, MAX_IMPORT_FILE_BYTES } from '@/lib/import-file';
import { formatDmy, formatDmyTime } from '@/lib/date-display';
import type { ClockingImportPreview } from '@/packs/attendance/service';
import { commitClockingImportAction, validateClockingImportAction } from './actions';
import { lineMessage, ResultPill } from './line-view';

export type ImportMappingOption = { id: string; label: string; encoding: ClockingEncoding };
type Tab = 'all' | 'valid' | 'errors';

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function ClockingImport({ mappings }: { mappings: ImportMappingOption[] }) {
  const t = useTranslations('clockingFile');
  const router = useRouter();
  const [mappingId, setMappingId] = useState(mappings[0]?.id ?? '');
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ClockingImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [dragging, setDragging] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const mapping = mappings.find((m) => m.id === mappingId) ?? null;
  const text = useMemo(() => (bytes && mapping ? decodeClockingBytes(bytes, mapping.encoding) : ''), [bytes, mapping]);
  const lineCount = useMemo(() => physicalLines(text).filter((l) => l.text.trim()).length, [text]);
  const tooLarge = new TextEncoder().encode(text).length > MAX_IMPORT_CSV_BYTES;

  const reset = () => {
    setPreview(null);
    setError(null);
    setTab('all');
    setQ('');
  };

  const loadFile = async (f: File) => {
    reset();
    if (/\.(xlsx|xls)$/i.test(f.name)) {
      setError(t('import.error.excel'));
      return;
    }
    if (f.size > MAX_IMPORT_FILE_BYTES) {
      setError(t('import.error.fileTooLarge'));
      return;
    }
    try {
      setBytes(new Uint8Array(await f.arrayBuffer()));
      setFileName(f.name);
    } catch {
      setError(t('import.error.unreadable'));
    }
  };

  const validate = () =>
    startTransition(async () => {
      setError(null);
      if (tooLarge) {
        setError(t('import.error.fileTooLarge'));
        return;
      }
      const r = await validateClockingImportAction(mappingId, text);
      if (!r.ok) {
        setError(t(`import.error.${r.error}`));
        return;
      }
      setPreview(r.preview);
      setTab('all');
    });

  const commit = () =>
    startTransition(async () => {
      setError(null);
      const r = await commitClockingImportAction(mappingId, text, fileName, bytes?.length ?? 0);
      if (!r.ok) {
        setError(t(`import.error.${r.error}`));
        return;
      }
      if (r.outcome.runId) {
        router.push(`/attendance/import/logs/${r.outcome.runId}`);
        return;
      }
      setError(t('import.importFailed', { reason: r.outcome.failureReason ?? '' }));
    });

  const rows = useMemo(() => {
    if (!preview) return [];
    const base =
      tab === 'valid'
        ? preview.validRows
        : tab === 'errors'
          ? preview.errorRows
          : [...preview.errorRows, ...preview.validRows].sort((a, b) => a.lineNo - b.lineNo);
    const needle = q.trim().toLowerCase();
    return needle
      ? base.filter((r) => r.cardRef.toLowerCase().includes(needle) || (r.employeeName ?? '').toLowerCase().includes(needle))
      : base;
  }, [preview, tab, q]);
  const shownRows = rows.slice(0, 500);
  const c = preview?.counts;
  const errorsTotal = c ? c.total - c.valid : 0;
  const tabTotal = !c ? 0 : tab === 'valid' ? c.valid : tab === 'errors' ? errorsTotal : c.total;
  const dateRange =
    c?.firstDate && c.lastDate ? (c.firstDate === c.lastDate ? formatDmy(c.firstDate) : `${formatDmy(c.firstDate)} – ${formatDmy(c.lastDate)}`) : '—';

  const step = (n: number, label: string, on: boolean) => (
    <div className={`flex-1 px-3 py-2 text-xs font-medium uppercase tracking-widest ${on ? 'bg-foreground text-background' : 'text-muted-foreground'}`}>
      {n} · {label}
    </div>
  );
  const tile = (value: number | string, label: string, warn = false) => (
    <div className="border-b border-r border-border p-4">
      <div className={`text-2xl font-semibold tabular-nums ${warn ? 'text-destructive' : ''}`}>{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-widest text-muted-foreground">{label}</div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col overflow-hidden rounded-md border border-border sm:flex-row">
        {step(1, t('import.step1'), !preview)}
        {step(2, t('import.step2'), !!preview)}
        {step(3, t('import.step3'), false)}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">
            {t('import.mapping')}
            <span className="ml-0.5 text-destructive">*</span>
          </span>
          <select
            className={inputCls}
            value={mappingId}
            onChange={(e) => {
              setMappingId(e.target.value);
              reset();
            }}
          >
            {mappings.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <Link href="/admin/attendance/file-mappings" className="mt-1 inline-block text-xs text-primary underline-offset-2 hover:underline">
            {t('import.manageMappings')}
          </Link>
        </label>
        <div>
          <span className="mb-1 block text-sm font-medium">
            {t('import.file')}
            <span className="ml-0.5 text-destructive">*</span>
          </span>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadFile(f);
              e.target.value = '';
            }}
          />
          {bytes ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
              <span className="min-w-0 break-all">
                <strong>{fileName}</strong> <span className="text-muted-foreground">· {t('import.fileInfo', { size: fmtSize(bytes.length), lines: lineCount })}</span>
              </span>
              <button type="button" className="text-primary underline underline-offset-2" onClick={() => fileRef.current?.click()}>
                {t('import.replaceFile')}
              </button>
            </div>
          ) : (
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileRef.current?.click();
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
              className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors ${
                dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-muted/40'
              }`}
            >
              <UploadCloud className="h-5 w-5 text-muted-foreground" aria-hidden />
              <div className="text-sm font-medium">{t('import.dropFile')}</div>
              <p className="text-xs text-muted-foreground">{t('import.dropFileHint')}</p>
            </div>
          )}
        </div>
      </div>

      {!preview && (
        <div className="flex justify-end">
          <Button onClick={validate} disabled={pending || !bytes || !mappingId}>
            {pending ? t('import.validating') : t('import.validate')}
          </Button>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {preview && c && (
        <>
          <h2 className="border-t border-border pt-4 text-xs font-medium uppercase tracking-widest text-muted-foreground">{t('import.resultTitle')}</h2>
          {preview.previousImport && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              {t('import.previousImport', { at: formatDmyTime(preview.previousImport.at), name: preview.previousImport.fileName || '—' })}{' '}
              <Link className="underline" href={`/attendance/import/logs/${preview.previousImport.runId}`}>
                {t('import.viewPrevious')}
              </Link>
            </div>
          )}
          <div className="grid grid-cols-2 border-l border-t border-border lg:grid-cols-4">
            {tile(c.total.toLocaleString('en'), t('import.total'))}
            {tile(c.valid.toLocaleString('en'), t('import.valid'))}
            {tile(c.unmatchedCard.toLocaleString('en'), t('import.cardNotFound'), c.unmatchedCard > 0)}
            {tile(c.invalidDateTime.toLocaleString('en'), t('import.invalidDateTime'), c.invalidDateTime > 0)}
            {tile(c.duplicate.toLocaleString('en'), t('import.duplicate'), c.duplicate > 0)}
            {tile(c.otherError.toLocaleString('en'), t('import.otherErrors'), c.otherError > 0)}
            {tile(c.employees.toLocaleString('en'), t('import.employees'))}
            {tile(dateRange, t('import.datesInFile'))}
          </div>

          <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border pt-4">
            <div role="tablist" className="flex gap-4 text-sm">
              {(
                [
                  ['all', t('import.tabAll', { count: c.total.toLocaleString('en') })],
                  ['valid', t('import.tabValid', { count: c.valid.toLocaleString('en') })],
                  ['errors', t('import.tabErrors', { count: errorsTotal.toLocaleString('en') })],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  role="tab"
                  type="button"
                  aria-selected={tab === k}
                  onClick={() => setTab(k)}
                  className={`border-b-2 pb-1 ${tab === k ? 'border-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <input className={`${inputCls} w-full sm:w-72`} placeholder={t('import.searchRows')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>

          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('import.colLine')}</th>
                  <th className="px-3 py-2 font-medium">{t('import.colCardId')}</th>
                  <th className="px-3 py-2 font-medium">{t('import.colEmployee')}</th>
                  <th className="px-3 py-2 font-medium">{t('import.colDate')}</th>
                  <th className="px-3 py-2 font-medium">{t('import.colTime')}</th>
                  <th className="px-3 py-2 font-medium">{t('import.colInOut')}</th>
                  <th className="px-3 py-2 font-medium">{t('import.colStatus')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shownRows.map((r) => (
                  <tr key={r.lineNo}>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.lineNo.toLocaleString('en')}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.cardRef || '—'}</td>
                    <td className="px-3 py-2">{r.employeeName ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{r.date ? formatDmy(r.date) : r.dateText || '—'}</td>
                    <td className="px-3 py-2 tabular-nums">{r.time ? r.time.slice(0, 5) : r.timeText || '—'}</td>
                    <td className="px-3 py-2">{r.direction ? t(`dirShort.${r.direction}`) : '—'}</td>
                    <td className="min-w-64 px-3 py-2">
                      <ResultPill
                        result={r.result}
                        label={r.result === 'imported' ? t('import.statusValid') : t(`resultShort.${r.result}`)}
                      />
                      {r.result !== 'imported' && <div className="mt-0.5 text-xs text-muted-foreground">{lineMessage(t, r)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap justify-between gap-2 text-sm text-muted-foreground">
            <span>{t('import.showing', { shown: shownRows.length.toLocaleString('en'), total: tabTotal.toLocaleString('en') })}</span>
            <span>{t('import.checksAgain')}</span>
          </div>
          {(c.total > preview.errorRows.length + preview.validRows.length) && (
            <p className="text-xs text-muted-foreground">{t('import.previewCapped', { errors: '2,000', valid: '500' })}</p>
          )}
          <p className="border-l-2 border-primary bg-muted/40 px-4 py-3 text-sm">
            {t.rich('import.errorsNotImported', { b: (x) => <strong>{x}</strong> })}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                reset();
                setBytes(null);
                setFileName('');
              }}
            >
              {t('import.startAgain')}
            </Button>
            <Button onClick={commit} disabled={pending}>
              {pending ? t('import.importing') : t('import.importValid', { count: c.valid })}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
