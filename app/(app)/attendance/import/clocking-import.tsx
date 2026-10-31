'use client';

/**
 * r424 (50ed39e1) — Import Clocking Data, steps 1 and 2 (step 3 is the import log page this hands off to).
 *
 * The browser's one privileged job is DECODING: the file's bytes go through TextDecoder with the chosen
 * mapping's encoding (so a UTF-16 or Windows-1252 device file arrives as text), and the size ceiling is
 * checked on the decoded text, which is what crosses the server action. Everything else — reading the
 * lines, matching cards, duplicates, refusals — is decided on the server, at Validate and again at Import.
 */
import { useId, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UploadCloud } from 'lucide-react';
import { Button, inputCls } from '@/components/ui';
import { FormRow, SectionCard, noteCls, typeHelpCls } from '@/components/ui/section-card';
import { StackedBody, StackedHead, StackedRow, StackedTable, StackedTd, StackedTh, stackedSplitNoteCls, stackedSplitWordCls } from '@/components/ui/stacked-table';
import { StatCells } from '@/components/ui/stat-cells';
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
  const uid = useId();

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

  // r427 (50ed39e1 contest) — LOOK ONLY. The three steps as a ruled row, then "01 Mapping and file" and
  // "02 Validation result" as sections; counts as one row of figures; the preview a table that stacks on a
  // narrow section. Same state, handlers, counts, tabs, search and 500-row cap as r424.
  const step = (n: number, label: string, on: boolean) => (
    <li
      aria-current={on ? 'step' : undefined}
      className={`min-w-0 border-b-2 pb-2 text-xs font-medium uppercase tracking-widest [overflow-wrap:anywhere] monolith:font-mono monolith:text-[11px] monolith:font-normal monolith:tracking-[0.12em] ${
        on ? 'border-foreground text-foreground monolith:border-signal monolith:text-ink' : 'border-border text-muted-foreground monolith:border-hairline monolith:text-mid'
      }`}
    >
      {n} · {label}
    </li>
  );
  const alertCls =
    'rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive monolith:rounded-none monolith:border-0 monolith:border-l-2 monolith:border-signal monolith:bg-transparent monolith:text-signal-text';

  return (
    <div className="space-y-6">
      <ol className="grid grid-cols-3 gap-3">
        {step(1, t('import.step1'), !preview)}
        {step(2, t('import.step2'), !!preview)}
        {step(3, t('import.step3'), false)}
      </ol>

      <SectionCard index={1} title={t('import.step1')}>
        <FormRow label={t('import.mapping')} htmlFor={`${uid}-mapping`} required>
          <select
            id={`${uid}-mapping`}
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
          <Link
            href="/admin/attendance/file-mappings"
            className="mt-1.5 inline-block text-xs text-primary underline-offset-2 hover:underline monolith:text-[13px] monolith:text-ink monolith:underline"
          >
            {t('import.manageMappings')}
          </Link>
        </FormRow>
        <FormRow label={t('import.file')} required>
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
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-border bg-card px-3 py-2 text-sm monolith:rounded-none monolith:border-ink monolith:bg-transparent">
              <span className="min-w-0 break-all">
                <strong>{fileName}</strong>{' '}
                <span className="text-muted-foreground monolith:text-mid">· {t('import.fileInfo', { size: fmtSize(bytes.length), lines: lineCount })}</span>
              </span>
              <button type="button" className="text-primary underline underline-offset-2 monolith:text-ink" onClick={() => fileRef.current?.click()}>
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
              className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors monolith:rounded-none monolith:border monolith:border-ink ${
                dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-muted/40'
              }`}
            >
              <UploadCloud className="h-5 w-5 text-muted-foreground" aria-hidden />
              <div className="text-sm font-medium">{t('import.dropFile')}</div>
              <p className={typeHelpCls}>{t('import.dropFileHint')}</p>
            </div>
          )}
        </FormRow>
        {!preview && (
          <div className="flex justify-end pt-4">
            <Button onClick={validate} disabled={pending || !bytes || !mappingId}>
              {pending ? t('import.validating') : t('import.validate')}
            </Button>
          </div>
        )}
      </SectionCard>

      {error && (
        <div role="alert" className={alertCls}>
          {error}
        </div>
      )}

      {preview && c && (
        <>
          <SectionCard index={2} title={t('import.resultTitle')}>
            <div className="space-y-5">
              {preview.previousImport && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200 monolith:rounded-none monolith:border-0 monolith:border-l-2 monolith:border-signal monolith:bg-transparent monolith:text-ink">
                  {t('import.previousImport', { at: formatDmyTime(preview.previousImport.at), name: preview.previousImport.fileName || '—' })}{' '}
                  <Link className="underline" href={`/attendance/import/logs/${preview.previousImport.runId}`}>
                    {t('import.viewPrevious')}
                  </Link>
                </div>
              )}
              <StatCells
                cells={[
                  { label: t('import.total'), value: c.total.toLocaleString('en') },
                  { label: t('import.valid'), value: c.valid.toLocaleString('en') },
                  { label: t('import.cardNotFound'), value: c.unmatchedCard.toLocaleString('en'), warn: c.unmatchedCard > 0 },
                  { label: t('import.invalidDateTime'), value: c.invalidDateTime.toLocaleString('en'), warn: c.invalidDateTime > 0 },
                  { label: t('import.duplicate'), value: c.duplicate.toLocaleString('en'), warn: c.duplicate > 0 },
                  { label: t('import.otherErrors'), value: c.otherError.toLocaleString('en'), warn: c.otherError > 0 },
                  { label: t('import.employees'), value: c.employees.toLocaleString('en') },
                  { label: t('import.datesInFile'), value: dateRange, text: true },
                ]}
              />

              <div className="flex flex-wrap items-end justify-between gap-3">
                <div role="tablist" className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
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
                      className={`border-b-2 pb-1 ${
                        tab === k
                          ? 'border-foreground font-medium monolith:border-ink'
                          : 'border-transparent text-muted-foreground hover:text-foreground monolith:text-mid'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <input className={`${inputCls} w-full sm:w-72`} placeholder={t('import.searchRows')} value={q} onChange={(e) => setQ(e.target.value)} />
              </div>

              <StackedTable label={t('import.step2')}>
                <StackedHead>
                  <StackedTh>{t('import.colLine')}</StackedTh>
                  <StackedTh>{t('import.colCardId')}</StackedTh>
                  <StackedTh>{t('import.colEmployee')}</StackedTh>
                  <StackedTh>{t('import.colDate')}</StackedTh>
                  <StackedTh>{t('import.colTime')}</StackedTh>
                  <StackedTh>{t('import.colInOut')}</StackedTh>
                  <StackedTh>{t('import.colStatus')}</StackedTh>
                </StackedHead>
                <StackedBody>
                  {shownRows.map((r) => (
                    <StackedRow key={r.lineNo}>
                      <StackedTd label={t('import.colLine')} role="title-inline" className="tabular-nums text-muted-foreground monolith:text-mid">
                        {r.lineNo.toLocaleString('en')}
                      </StackedTd>
                      <StackedTd label={t('import.colCardId')} className="font-mono text-xs leading-5">
                        {r.cardRef || '—'}
                      </StackedTd>
                      <StackedTd label={t('import.colEmployee')}>{r.employeeName ?? '—'}</StackedTd>
                      <StackedTd label={t('import.colDate')} className="whitespace-nowrap tabular-nums">
                        {r.date ? formatDmy(r.date) : r.dateText || '—'}
                      </StackedTd>
                      <StackedTd label={t('import.colTime')} className="tabular-nums">
                        {r.time ? r.time.slice(0, 5) : r.timeText || '—'}
                      </StackedTd>
                      <StackedTd label={t('import.colInOut')}>{r.direction ? t(`dirShort.${r.direction}`) : '—'}</StackedTd>
                      <StackedTd label={t('import.colStatus')} role="split" hideLabel className="@3xl:min-w-64">
                        <span className={`block ${stackedSplitWordCls}`}>
                          <ResultPill result={r.result} label={r.result === 'imported' ? t('import.statusValid') : t(`resultShort.${r.result}`)} />
                        </span>
                        {r.result !== 'imported' && <div className={`mt-0.5 ${typeHelpCls} ${stackedSplitNoteCls}`}>{lineMessage(t, r)}</div>}
                      </StackedTd>
                    </StackedRow>
                  ))}
                </StackedBody>
              </StackedTable>
              <div className={`flex flex-wrap justify-between gap-2 ${typeHelpCls}`}>
                <span>{t('import.showing', { shown: shownRows.length.toLocaleString('en'), total: tabTotal.toLocaleString('en') })}</span>
                <span>{t('import.checksAgain')}</span>
              </div>
              {c.total > preview.errorRows.length + preview.validRows.length && (
                <p className={typeHelpCls}>{t('import.previewCapped', { errors: '2,000', valid: '500' })}</p>
              )}
            </div>
          </SectionCard>
          <p className={noteCls}>{t.rich('import.errorsNotImported', { b: (x) => <strong>{x}</strong> })}</p>
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
