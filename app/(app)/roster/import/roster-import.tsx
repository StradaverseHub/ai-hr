'use client';

/**
 * Upload Shift Roster — the picker, the preview, and the commit (item 23390097).
 *
 * The reporter's requirement is the PREVIEW, not the upload: "before anything is saved you see how many
 * employees and how many days were read, how many are valid, how many are duplicated, and a list of
 * every rejected line with the reason it was rejected". So the screen has two buttons and they are not
 * interchangeable — Check reads and reports, Save writes. The file itself never leaves the browser: it
 * is decoded to CSV text here (lib/import-file, the one workbook decoder in this repo) and only that
 * text crosses the wire, exactly as the employee and leave importers do it.
 */
import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UploadCloud } from 'lucide-react';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { RosterTemplateButton } from '@/components/roster-grid';
import { IMPORT_FILE_ACCEPT, importFileMessageKey, readImportFile } from '@/lib/import-file';
import { addMonths } from '@/lib/roster-month';
import type { RosterImportReject, RosterImportResult } from '@/core/roster-import';
import { commitRosterImportAction, dryRunRosterImportAction } from './actions';

export function RosterImport({
  companies,
  companyId: initialCompanyId,
  month: initialMonth,
  shiftCodes,
  template,
}: {
  companies: { id: string; name: string }[];
  companyId: string;
  month: string;
  shiftCodes: { code: string; name: string }[];
  template: { dates: string[]; rows: string[][]; codes: string[] };
}) {
  const t = useTranslations('roster.import');
  const tr = useTranslations('roster');
  const router = useRouter();
  const [companyId, setCompanyId] = useState(initialCompanyId);
  const [month, setMonth] = useState(initialMonth);
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<RosterImportResult | null>(null);
  const [committed, setCommitted] = useState<RosterImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setPreview(null);
    setCommitted(null);
    setError(null);
  };

  // Changing the company or the month invalidates a preview taken against the other one — a stale
  // "ready to save" card next to a different month is exactly how the wrong month gets written.
  const changeScope = (next: { companyId?: string; month?: string }) => {
    if (next.companyId) setCompanyId(next.companyId);
    if (next.month) setMonth(next.month);
    reset();
    const params = new URLSearchParams({ companyId: next.companyId ?? companyId, month: next.month ?? month });
    router.replace(`/roster/import?${params.toString()}`);
  };

  const runDryRun = (text: string, name: string | null) =>
    startTransition(async () => {
      setError(null);
      try {
        setPreview(await dryRunRosterImportAction({ csvText: text, month, companyId, fileName: name ?? '' }));
        setCommitted(null);
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const loadFile = async (file: File) => {
    setError(null);
    setReading(true);
    try {
      const { name, text } = await readImportFile(file);
      setCsv(text);
      setFileName(name);
      setCommitted(null);
      runDryRun(text, name);
    } catch (e) {
      setFileName(null);
      reset();
      setError(t(importFileMessageKey(e)));
    } finally {
      setReading(false);
      // Allow re-picking the same file after fixing it — the change event won't fire otherwise.
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const commit = () =>
    startTransition(async () => {
      setError(null);
      try {
        const r = await commitRosterImportAction({ csvText: csv, month, companyId, fileName: fileName ?? '' });
        setCommitted(r);
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const shown = committed ?? preview;
  const reasonLabel = (r: RosterImportReject['reason']) =>
    r === 'unknown_employee'
      ? t('reasonUnknownEmployee')
      : r === 'missing_employee_no'
        ? t('reasonMissingEmployeeNo')
        : r === 'out_of_month'
          ? t('reasonOutOfMonth')
          : r === 'bad_date_column'
            ? t('reasonBadDateColumn')
            : r === 'unknown_code'
              ? t('reasonUnknownCode')
              : r === 'archived_code'
                ? t('reasonArchivedCode')
                : t('reasonDuplicate');

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="flex flex-wrap gap-4">
          {companies.length > 1 && (
            <div className="sm:max-w-[260px]">
              <Field label={t('targetCompany')}>
                <select className={inputCls} value={companyId} onChange={(e) => changeScope({ companyId: e.target.value })}>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
          <div className="sm:max-w-[200px]">
            <Field label={t('targetMonth')}>
              <input type="month" className={inputCls} value={month} onChange={(e) => changeScope({ month: e.target.value })} />
            </Field>
          </div>
          <div className="flex items-end gap-2">
            <RosterTemplateButton
              dates={template.dates}
              rows={template.rows}
              month={month}
              codes={template.codes}
              label={tr('downloadTemplate')}
              notesTitle={tr('templateNotesTitle')}
              notes={[
                tr('templateNoteBlank'),
                tr('templateNoteCode'),
                tr('templateNoteRd'),
                tr('templateNoteOff'),
                tr('templateNoteMonth', { month }),
              ]}
              failedLabel={tr('templateFailed')}
            />
          </div>
        </div>

        <div className="mt-4">
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
              <p className="text-xs text-muted-foreground">{t('uploadHint', { month })}</p>
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
            {fileName && <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">{t('fileLoaded', { name: fileName })}</p>}
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={() => runDryRun(csv, fileName)} disabled={pending || reading || !csv.trim()}>
            {pending && !committed ? t('checking') : t('check')}
          </Button>
          <span className="text-xs text-muted-foreground">{t('monthGuardHint', { month })}</span>
        </div>

        <details className="mt-4 border-t border-border pt-3 text-xs">
          <summary className="cursor-pointer select-none font-medium text-muted-foreground">{t('vocabularyTitle')}</summary>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            <li>{t('vocabBlank')}</li>
            <li>{t('vocabBracket')}</li>
            <li>{t('vocabRd')}</li>
            <li>{t('vocabOff')}</li>
            <li>
              {t('vocabCodes')}{' '}
              {shiftCodes.length === 0
                ? '—'
                : shiftCodes.map((c) => (
                    <code key={c.code} className="mx-0.5">
                      {c.code}
                    </code>
                  ))}
            </li>
          </ul>
        </details>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      {committed && (
        <Card className="overflow-hidden border-emerald-200 dark:border-emerald-500/30">
          <div className="flex flex-wrap items-center gap-3 border-b border-border bg-emerald-50/60 px-4 py-3 dark:bg-emerald-500/10">
            <h2 className="text-sm font-semibold">{t('savedCount', { count: committed.changed })}</h2>
            <Link href={`/roster?companyId=${companyId}&month=${month}`} className="ml-auto text-sm text-primary hover:underline">
              {t('viewRoster')}
            </Link>
            <button
              type="button"
              className="text-sm text-muted-foreground hover:text-foreground"
              onClick={() => {
                setCsv('');
                setFileName(null);
                reset();
              }}
            >
              {t('uploadAnother')}
            </button>
          </div>
        </Card>
      )}

      {shown && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">{committed ? t('resultTitle') : t('previewTitle')}</h2>
            {!committed && (
              <Button onClick={commit} disabled={pending || shown.changed === 0} size="sm">
                {pending ? t('saving') : t('save', { count: shown.changed })}
              </Button>
            )}
          </div>

          {/* The five numbers the plan promises, before anything is saved. */}
          <dl className="grid grid-cols-2 gap-px bg-border sm:grid-cols-6">
            <Stat label={t('statEmployees')} value={shown.employees} />
            <Stat label={t('statRows')} value={shown.rowsRead} />
            <Stat label={t('statDays')} value={shown.daysRead} />
            <Stat label={t('statValid')} value={shown.valid} />
            <Stat label={t('statDuplicates')} value={shown.duplicates} />
            <Stat label={t('statChanged')} value={shown.changed} />
          </dl>

          {shown.rejects.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">{t('noRejects')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('colLine')}</th>
                    <th className="px-4 py-2 font-medium">{t('colEmployeeNo')}</th>
                    <th className="px-4 py-2 font-medium">{t('colDate')}</th>
                    <th className="px-4 py-2 font-medium">{t('colValue')}</th>
                    <th className="px-4 py-2 font-medium">{t('colReason')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {shown.rejects.slice(0, 200).map((r, i) => (
                    <tr key={`${r.row}-${r.date ?? ''}-${i}`} className="bg-red-50/40 dark:bg-red-500/5">
                      <td className="px-4 py-2 tabular-nums text-muted-foreground">{r.row}</td>
                      <td className="px-4 py-2">{r.employeeCode || '—'}</td>
                      <td className="px-4 py-2 tabular-nums text-muted-foreground">{r.date ?? '—'}</td>
                      <td className="px-4 py-2">{r.value || '—'}</td>
                      <td className="px-4 py-2 text-red-600 dark:text-red-400">{reasonLabel(r.reason)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {shown.rejects.length > 200 && (
                <p className="px-4 py-2 text-xs text-muted-foreground">{t('moreRejects', { count: shown.rejects.length - 200 })}</p>
              )}
            </div>
          )}

          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
            {t('outsideMonthNote', { month, prev: addMonths(month, -1), next: addMonths(month, 1) })}
          </p>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
