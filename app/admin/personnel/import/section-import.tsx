'use client';

import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UploadCloud } from 'lucide-react';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { IMPORT_FILE_ACCEPT, importFileMessageKey, readImportFile } from '@/lib/import-file';
import { toCsv } from '@/lib/csv';
import {
  buildInstructionRows,
  buildReferenceRows,
  employeeColumnLabel,
  EMPLOYEE_ENUM_VALUES,
  DEPENDENT_ENUM_VALUES,
} from '@/lib/import-template-xlsx';
import {
  sectionColumns,
  sectionTextColumnIndexes,
  SECTION_SHEET_NAMES,
  SECTION_TEMPLATE_FILENAMES,
  type ImportSection,
  type SectionImportPreview,
  type SectionImportResult,
} from '@/lib/import-sections';
import type { ImportReference } from './employee-import';
import { commitSectionAction, validateSectionAction } from './section-actions';

/**
 * Item 2983802f — THE PER-SECTION IMPORT SCREEN: one subject area, existing employees only.
 *
 * A deliberate sibling of `EmployeeImport` rather than a mode inside it. The wide importer is the
 * CREATE path and the reporter was promised it would keep working while this was built, so it is left
 * exactly as it was; this file is the UPDATE path and shares only the pieces that genuinely are shared
 * (the file reader, the CSV encoder, the xlsx writer).
 *
 * WHAT THE PREVIEW HAS TO SAY, and why it is a different table from the wide importer's. A create
 * preview answers "will this row be accepted?". An UPDATE preview has to answer two more questions
 * before anybody presses the button: WHO does this row land on, and WHAT does it change about them.
 * So every row shows the matched employee's name — the file itself carries only an ID — and the exact
 * list of fields that will move. A row that matches nobody is shown as "Not found" rather than quietly
 * dropped, because a mistyped Employee ID is the single likeliest error in a bulk update.
 */
export function SectionImport({ section, reference }: { section: ImportSection; reference: ImportReference }) {
  const t = useTranslations('people.import');
  const router = useRouter();
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<SectionImportPreview | null>(null);
  const [result, setResult] = useState<SectionImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Literal `t()` calls in a map, not a computed key: test/i18n-coverage.test.ts check C only resolves
  // literal keys, and a label that silently falls back to the key is exactly the class of bug it exists
  // to catch.
  const SECTION_LABEL: Record<ImportSection, string> = {
    profile: t('sectionProfile'),
    employment: t('sectionEmployment'),
    bank_statutory: t('sectionBankStatutory'),
    family: t('sectionFamily'),
  };
  const label = SECTION_LABEL[section];
  const columns = sectionColumns(section);

  const reset = () => {
    setPreview(null);
    setResult(null);
    setError(null);
  };

  const runValidate = (text: string) =>
    startTransition(async () => {
      setError(null);
      try {
        const p = await validateSectionAction(section, text);
        setPreview(p);
        setResult(null);
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const loadFile = async (file: File) => {
    setError(null);
    setReading(true);
    try {
      // No extra sheets: a section file is ONE sheet by definition — that is what makes it a section.
      const { name, text } = await readImportFile(file);
      setCsv(text);
      setFileName(name);
      setResult(null);
      runValidate(text);
    } catch (e) {
      setFileName(null);
      reset();
      setError(t(importFileMessageKey(e)));
    } finally {
      setReading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /**
   * The section's own template — the whole point of the request. Built in the BROWSER from the same
   * column list the server validates against (`lib/import-sections.ts`), so it carries THAT section's
   * columns and no others, and the identity columns are stamped as text so Excel cannot eat a leading
   * zero out of an Employee ID.
   */
  const downloadTemplate = async () => {
    setError(null);
    try {
      const { buildXlsx } = await import('@/lib/spreadsheet');
      const referenceLists =
        section === 'profile'
          ? [
              { label: employeeColumnLabel('state'), values: reference.states },
              { label: employeeColumnLabel('country'), values: reference.countries },
              { label: employeeColumnLabel('passport_issuing_country'), values: reference.nationalities },
              { label: employeeColumnLabel('emergency_contact_relationship'), values: reference.relationships },
            ]
          : section === 'bank_statutory'
            ? [{ label: employeeColumnLabel('tax_category'), values: [...EMPLOYEE_ENUM_VALUES.tax_category] }]
            : section === 'family'
              ? [
                  { label: t('familyRelationshipLabel'), values: reference.familyRelationships },
                  { label: t('familyGenderLabel'), values: [...DEPENDENT_ENUM_VALUES.gender] },
                ]
              : [];
      const extraSheets: { name: string; rows: (string | number)[][] }[] = [];
      // Employment has no catalog-governed column, so it gets no Reference sheet rather than an empty
      // one: a sheet that lists nothing teaches nothing and invites the reader to look for a list.
      if (referenceLists.length > 0) {
        extraSheets.push({
          name: 'Reference',
          rows: buildReferenceRows(t('referenceHeading'), referenceLists),
        });
      }
      extraSheets.push({
        name: 'Instructions',
        rows: buildInstructionRows(t('instructionsHeading'), [
          t('sectionInstructionKey'),
          t('sectionInstructionBlank'),
          section === 'family' ? t('sectionInstructionFamilyRow') : t('sectionInstructionOneRow'),
          t('sectionInstructionFence'),
          t('instructionDates'),
          t('instructionIdentityText'),
        ]),
      });
      const bytes = await buildXlsx(columns.map(employeeColumnLabel), [], {
        sheetName: SECTION_SHEET_NAMES[section],
        textColumns: sectionTextColumnIndexes(section),
        extraSheets,
      });
      const url = URL.createObjectURL(
        new Blob([bytes as BlobPart], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = SECTION_TEMPLATE_FILENAMES[section];
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(t('fileReadError'));
    }
  };

  /** The rows that need correcting, with the reason — the same escape hatch the wide importer offers.
   *  `toCsv` applies its formula-injection guard: this echoes user-supplied values into an Excel file. */
  const downloadErrors = () => {
    const rows = (preview?.rows ?? []).filter((r) => r.errors.length > 0);
    const csvOut = toCsv([
      [t('colRow'), t('colEmployeeCode'), t('colEmployee'), t('colResult')],
      ...rows.map((r) => [r.rowNum, r.employeeCode, r.employeeName, r.errors.join('; ')]),
    ]);
    const url = URL.createObjectURL(new Blob([csvOut], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'section-import-errors.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const commit = () =>
    startTransition(async () => {
      setError(null);
      try {
        // The section name rides along on the history label so one history can hold both kinds of run
        // without an admin having to guess which was which.
        const r = await commitSectionAction(section, csv, `${label} · ${fileName ?? t('historyPasted')}`);
        setResult(r);
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    });

  return (
    <div className="space-y-6">
      <Card className="space-y-4 p-5">
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t('sectionUpdateOnlyNotice')}
        </div>

        <StepHeading num={1} label={t('sectionStep1')} />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void downloadTemplate()}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
          >
            {t('sectionDownloadTemplate', { section: label })}
          </button>
        </div>

        <StepHeading num={2} label={t('sectionStep2')} />
        <details className="text-xs">
          <summary className="cursor-pointer select-none font-medium text-muted-foreground">
            {t('sectionColumnsHeading')}
          </summary>
          <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground sm:grid-cols-3">
            {columns.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
        </details>

        <StepHeading num={3} label={t('sectionStep3')} />
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
              accept={IMPORT_FILE_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void loadFile(f);
              }}
            />
          </div>
          {fileName && (
            <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">{t('fileLoaded', { name: fileName })}</p>
          )}
        </Field>

        <details className="border-t border-border pt-3" open={!fileName}>
          <summary className="cursor-pointer select-none text-sm font-medium text-muted-foreground">
            {t('pasteToggle')}
          </summary>
          <div className="mt-3">
            <Field label={t('csvData')}>
              <textarea
                className={`${inputCls} h-36 resize-y font-mono text-xs leading-relaxed`}
                value={csv}
                onChange={(e) => {
                  setCsv(e.target.value);
                  setFileName(null);
                  reset();
                }}
                spellCheck={false}
              />
            </Field>
          </div>
        </details>

        <StepHeading num={4} label={t('sectionStep4')} />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => runValidate(csv)} disabled={pending || reading || !csv.trim()}>
            {pending && !result ? t('validating') : t('validate')}
          </Button>
          <span className="ml-auto text-xs text-muted-foreground">{t('step4Hint')}</span>
        </div>
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
              {t('sectionUpdatedCount', { count: result.updated })}
              {result.skipped > 0 && ` · ${t('skippedCount', { count: result.skipped })}`}
              {result.failed.length > 0 && ` · ${t('failedCount', { count: result.failed.length })}`}
            </h2>
          </div>
          {result.fileErrors.length > 0 && (
            <div className="border-b border-border bg-red-50/60 px-4 py-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-400">
              <div className="mb-1 font-semibold">{t('fileRejected')}</div>
              <ul className="list-disc space-y-0.5 pl-5 text-xs">
                {result.fileErrors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {result.failed.length > 0 && (
            <ul className="divide-y divide-border text-sm">
              {result.failed.map((f) => (
                <li key={f.rowNum} className="px-4 py-2">
                  <span className="text-muted-foreground">{t('row', { num: f.rowNum })}</span> · {f.employeeCode} —{' '}
                  <span className="text-red-600 dark:text-red-400">{f.message}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-3 px-4 py-3 text-sm">
            <Link href="/admin/personnel" className="text-primary hover:underline">
              {t('viewPeople')}
            </Link>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                setCsv('');
                setFileName(null);
                reset();
              }}
            >
              {t('importAnother')}
            </button>
          </div>
        </Card>
      )}

      {preview && !result && <SectionPreview preview={preview} onImport={commit} onDownloadErrors={downloadErrors} busy={pending} />}
    </div>
  );
}

/** The same numbering the wide importer uses over the control that performs each step. */
function StepHeading({ num, label }: { num: number; label: string }) {
  const t = useTranslations('people.import');
  return (
    <div className="flex items-baseline gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('stepNum', { num })}</span>
      <span className="text-sm font-medium">{label}</span>
    </div>
  );
}

function SectionPreview({
  preview,
  onImport,
  onDownloadErrors,
  busy,
}: {
  preview: SectionImportPreview;
  onImport: () => void;
  onDownloadErrors: () => void;
  busy: boolean;
}) {
  const t = useTranslations('people.import');
  const withErrors = preview.rows.filter((r) => r.errors.length > 0).length;
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('stepNum', { num: 4 })}
          </span>{' '}
          {t('preview')} ·{' '}
          <span className="text-emerald-600 dark:text-emerald-400">
            {t('sectionUpdateCount', { count: preview.updateCount })}
          </span>
          {preview.skipCount > 0 && (
            <>
              {' · '}
              <span className="text-muted-foreground">{t('sectionSkipCount', { count: preview.skipCount })}</span>
            </>
          )}
          {preview.createCount > 0 && (
            <>
              {' · '}
              <span className="text-red-600 dark:text-red-400">
                {t('sectionNotFoundCount', { count: preview.createCount })}
              </span>
            </>
          )}
        </h2>
        {withErrors > 0 && (
          <button
            type="button"
            onClick={onDownloadErrors}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
          >
            {t('downloadErrors')}
          </button>
        )}
      </div>

      {/* A WHOLE-FILE REFUSAL — the fence, or a missing Employee ID column. Nothing at all is written
          while this is showing, and the server refuses independently: the disabled button is the
          courtesy, not the guard. */}
      {preview.fileErrors.length > 0 && (
        <div className="border-b border-border bg-red-50/60 px-4 py-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-400">
          <div className="mb-1 font-semibold">{t('fileRejected')}</div>
          <ul className="list-disc space-y-0.5 pl-5 text-xs">
            {preview.fileErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-12 px-4 py-2 font-medium">#</th>
              <th className="px-4 py-2 font-medium">{t('colEmployeeCode')}</th>
              <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
              <th className="px-4 py-2 font-medium">{t('colVerdict')}</th>
              <th className="px-4 py-2 font-medium">{t('colChanges')}</th>
              <th className="px-4 py-2 font-medium">{t('colResult')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {preview.rows.map((r) => (
              <tr key={r.rowNum} className={r.errors.length > 0 ? 'bg-red-50/40 dark:bg-red-500/5' : ''}>
                <td className="px-4 py-2 tabular-nums text-muted-foreground">{r.rowNum}</td>
                <td className="px-4 py-2 font-mono text-xs">{r.employeeCode || '—'}</td>
                <td className="px-4 py-2 font-medium">{r.employeeName || <span className="text-muted-foreground">—</span>}</td>
                <td className="px-4 py-2">
                  {r.verdict === 'update' && r.ok ? (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                      {t('verdictUpdate')}
                    </span>
                  ) : r.verdict === 'skip' ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                      {t('verdictSkip')}
                    </span>
                  ) : (
                    <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400">
                      {r.verdict === 'create' ? t('verdictCreate') : t('verdictBlocked')}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">
                  {r.changes.length > 0 ? r.changes.map(fieldLabel).join(', ') : '—'}
                </td>
                <td className="px-4 py-2 text-xs">
                  {r.errors.length > 0 ? (
                    <span className="text-red-600 dark:text-red-400">{r.errors.join('; ')}</span>
                  ) : r.warnings.length > 0 ? (
                    <span className="text-amber-600 dark:text-amber-400">{r.warnings.join('; ')}</span>
                  ) : (
                    <span className="text-emerald-600 dark:text-emerald-400">{t('ready')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
        <span className="text-xs text-muted-foreground">
          <span className="font-semibold uppercase tracking-wide">{t('stepNum', { num: 5 })}</span> ·{' '}
          {preview.fileErrors.length > 0 ? t('step5Blocked') : t('sectionStep5Hint')}
        </span>
        <Button onClick={onImport} disabled={busy || preview.updateCount === 0 || preview.fileErrors.length > 0} size="sm">
          {busy ? t('importing') : t('sectionImportButton', { count: preview.updateCount })}
        </Button>
      </div>
    </Card>
  );
}

/** `bank_account_no` → `Bank Account No`. The preview's "what changes" column shows the same words the
 *  template's header row does, so a reader can find the cell they are being told about. */
function fieldLabel(column: string): string {
  return employeeColumnLabel(column);
}
