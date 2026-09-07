'use client';

import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UploadCloud } from 'lucide-react';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { DownloadTemplate } from '@/components/download-template';
import { employeeTemplate } from '@/lib/import-template';
import { IMPORT_COLUMNS, type ImportPreview, type ImportResult } from '@/lib/import-schema';
import { IMPORT_FILE_ACCEPT, importFileMessageKey, readImportFile } from '@/lib/import-file';
import { toCsv } from '@/lib/csv';
import {
  buildInstructionRows,
  buildReferenceRows,
  dependentTextColumnIndexes,
  employeeColumnLabel,
  employeeTextColumnIndexes,
  DEPENDENT_ENUM_VALUES,
  DEPENDENT_SAMPLE_ROWS,
  DEPENDENT_XLSX_HEADERS,
  EMPLOYEE_ENUM_VALUES,
  EMPLOYEE_XLSX_FILENAME,
  EMPLOYEE_XLSX_HEADERS,
  EMPLOYEE_XLSX_SHEETS,
} from '@/lib/import-template-xlsx';
import { validateImportAction, commitImportAction } from './actions';

const SAMPLE = `full_name,email,department,position,hired_on,employment_type,ic_number,basic_salary,monthly_allowance,bank_name,bank_account_no,tax_category,num_children
Nadia Yusof,nadia@demo.test,Finance,,2026-06-01,full_time,910505051234,5200,400,Maybank,5566778899,2,1
Ravi Chandran,ravi@demo.test,Engineering,,2026-06-01,full_time,880808082345,9800,600,CIMB,1122334455,3,2
Siti Aminah,siti@demo.test,Operations,,2026-06-15,contract,950909093456,4100,0,,,1,0`;

type Phase = 'idle' | 'previewed' | 'done';

export type ImportReference = {
  departments: string[];
  positions: string[];
  costCenters: string[];
  // Item 2983802f — the profile_option catalogs the new columns are validated against. Empty arrays are
  // meaningful and correct: a tenant that never configured a list accepts free text, exactly as the
  // Personnel screens do, and the sheet then shows an em dash rather than pretending otherwise.
  states: string[];
  countries: string[];
  relationships: string[];
  familyRelationships: string[];
};

export function EmployeeImport({
  companies,
  defaultCompanyId,
  reference,
}: {
  companies: { id: string; name: string }[];
  defaultCompanyId: string;
  /** Live catalog values for the Excel template's Reference sheet (d8471481). */
  reference: ImportReference;
}) {
  const t = useTranslations('people.import');
  const router = useRouter();
  const [companyId, setCompanyId] = useState(defaultCompanyId);
  const [csv, setCsv] = useState('');
  // Item 2983802f — the Family sheet's rows, as CSV text, decoded from the SAME workbook in the browser.
  // Always '' for a pasted or .csv upload: a CSV file is one sheet, so it cannot carry family members.
  const [dependentsCsv, setDependentsCsv] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [pending, startTransition] = useTransition();
  // Upload state. `fileName` is only a confirmation label — the imported data is always `csv`,
  // whether it arrived by file or by paste, so there is exactly one path into validate/commit.
  const [fileName, setFileName] = useState<string | null>(null);
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

  // Validate an explicit string rather than the `csv` state: after a file read the state update
  // has not flushed yet, so passing the text through avoids validating the previous contents.
  const runValidate = (text: string, family = dependentsCsv) =>
    startTransition(async () => {
      setError(null);
      try {
        const p = await validateImportAction(text, companyId, family);
        setPreview(p);
        setResult(null);
        setPhase('previewed');
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const validate = () => runValidate(csv);

  // Step 1 of the import (see lib/import-file): turn the chosen file into CSV text, then hand that
  // text to the SAME validate step the paste box uses. Nothing about parsing, validation or the
  // write path changes — this only replaces "open the file and copy its contents" for the user.
  const loadFile = async (file: File) => {
    setError(null);
    setReading(true);
    try {
      // Item 2983802f — ask the reader for the Family sheet too. A file without one decodes exactly as
      // it always did; `dependentsText` simply comes back empty.
      const { name, text, dependentsText } = await readImportFile(file, {
        extraSheets: [EMPLOYEE_XLSX_SHEETS.family],
      });
      setCsv(text);
      setDependentsCsv(dependentsText);
      setFileName(name);
      setResult(null);
      runValidate(text, dependentsText);
    } catch (e) {
      // Drop the file label and any earlier preview so a rejected pick can never leave a stale
      // "ready to import" preview on screen next to an error. Whatever is in the paste box is left
      // alone — the user must press Validate again to get a preview back.
      setFileName(null);
      setDependentsCsv('');
      reset();
      setError(t(importFileMessageKey(e)));
    } finally {
      setReading(false);
      // Allow re-picking the same file after fixing it — the change event won't fire otherwise.
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // d8471481 — the Excel template. Built in the BROWSER (SheetJS is dynamically imported so the
  // ~400 KB library never enters the initial bundle or any server action), from the live catalogs the
  // server passed down. Three sheets; the data sheet stays FIRST because `workbookToCsvText` reads
  // the first worksheet on re-upload.
  const downloadXlsxTemplate = async () => {
    setError(null);
    try {
      const { buildXlsx } = await import('@/lib/spreadsheet');
      const enumList = (key: keyof typeof EMPLOYEE_ENUM_VALUES) => ({
        label: employeeColumnLabel(key),
        values: [...EMPLOYEE_ENUM_VALUES[key]],
      });
      const bytes = await buildXlsx(
        [...EMPLOYEE_XLSX_HEADERS],
        employeeTemplate.sampleRows,
        {
          sheetName: EMPLOYEE_XLSX_SHEETS.data,
          textColumns: employeeTextColumnIndexes(),
          extraSheets: [
            // Item 2983802f — THE FAMILY SHEET, second so it reads as the other sheet to fill in. It is
            // read back BY NAME on upload, so its position is free but its name is not.
            {
              name: EMPLOYEE_XLSX_SHEETS.family,
              rows: [[...DEPENDENT_XLSX_HEADERS], ...DEPENDENT_SAMPLE_ROWS.map((r) => [...r])],
              textColumns: dependentTextColumnIndexes(),
            },
            {
              name: EMPLOYEE_XLSX_SHEETS.reference,
              rows: buildReferenceRows(t('referenceHeading'), [
                { label: employeeColumnLabel('company'), values: companies.map((c) => c.name) },
                { label: employeeColumnLabel('department'), values: reference.departments },
                { label: employeeColumnLabel('position'), values: reference.positions },
                { label: employeeColumnLabel('cost_center'), values: reference.costCenters },
                // Item 2983802f — the catalog-governed vocabularies the new columns write into. These are
                // the SAME active options core/import validates a cell against, read from the live catalog
                // by the server component, so a value on this sheet is a value the file may carry.
                { label: employeeColumnLabel('state'), values: reference.states },
                { label: employeeColumnLabel('country'), values: reference.countries },
                { label: employeeColumnLabel('emergency_contact_relationship'), values: reference.relationships },
                { label: t('familyRelationshipLabel'), values: reference.familyRelationships },
                { label: t('familyGenderLabel'), values: [...DEPENDENT_ENUM_VALUES.gender] },
                enumList('employment_type'),
                enumList('pay_mode'),
                enumList('payment_term'),
                enumList('epf_citizenship'),
                enumList('tax_category'),
                enumList('eis_eligible'),
              ]),
            },
            {
              name: EMPLOYEE_XLSX_SHEETS.instructions,
              rows: buildInstructionRows(t('instructionsHeading'), [
                t('instructionRequired', { columns: IMPORT_COLUMNS.required.map(employeeColumnLabel).join(', ') }),
                t('instructionDates'),
                t('instructionIdentityText'),
                t('instructionCompany'),
                t('instructionReference'),
                t('instructionAddress'),
                t('instructionProbation'),
                t('instructionSuperior'),
                t('instructionFamily'),
                t('instructionFamilyWhole'),
                t('instructionSamples'),
              ]),
            },
          ],
        },
      );
      const url = URL.createObjectURL(
        new Blob([bytes as BlobPart], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = EMPLOYEE_XLSX_FILENAME;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(t('fileReadError'));
    }
  };

  // Error feedback report (d8471481): just the rows that cannot be accepted, with the reason, so HR
  // fixes those and re-uploads instead of hunting through the file. Uses toCsv's csvSafeCell
  // formula-injection guard because it echoes user-supplied values back into a file opened in Excel.
  const downloadErrors = (rows: { rowNum: number; fullName: string; email: string; errors: string[] }[]) => {
    const csvOut = toCsv([
      [t('colRow'), t('colName'), t('colEmail'), t('colResult')],
      ...rows.map((r) => [r.rowNum, r.fullName, r.email, r.errors.join('; ')]),
    ]);
    const url = URL.createObjectURL(new Blob([csvOut], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'employee-import-errors.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const commit = () =>
    startTransition(async () => {
      setError(null);
      try {
        // cf43c909 — the file's NAME rides along as the history row's label. The file itself never leaves
        // the browser: `csv` is still the only thing sent, so the write path is unchanged.
        const r = await commitImportAction(csv, companyId, fileName ?? '', dependentsCsv);
        setResult(r);
        setPhase('done');
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const company = companies.find((c) => c.id === companyId);

  // Item 2983802f — which numbered step the screen is on, derived from the phase it was ALREADY in.
  // Nothing new is tracked: 'done' is the result, 'previewed' is the confirm decision, text in the box
  // means the file has been provided, and everything before that is the admin's own work off-screen.
  const currentStep = result ? 6 : preview ? 5 : csv.trim() !== '' ? 4 : 1;

  return (
    <div className="space-y-6">
      <StepRail current={currentStep} />
      <Card className="space-y-4 p-5">
        <div className="sm:max-w-[260px]">
          <Field label={t('targetCompany')}>
            <select
              className={inputCls}
              value={companyId}
              onChange={(e) => {
                setCompanyId(e.target.value);
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
        </div>

        {/* Item 2983802f — STEP LABELLING. The screen already did all six of these things; what it never
            did was say so, which left an admin guessing whether "Validate" was the import. Nothing about
            the process changed here — the two template buttons moved above the upload box so that the
            numbers read down the page in the order they happen. */}
        <StepHeading num={1} label={t('step1')} />
        <div className="flex flex-wrap items-center gap-2">
          {/* d8471481 — the Excel template is the PRIMARY one now (text-typed identity columns +
              a live Reference sheet). The CSV template stays beside it: the reporter's existing
              files are CSV and removing that path would break a workflow that works. */}
          <button
            type="button"
            onClick={() => void downloadXlsxTemplate()}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
          >
            {t('downloadTemplateXlsx')}
          </button>
          <DownloadTemplate spec={employeeTemplate} />
          <span className="ml-auto text-xs text-muted-foreground">
            {t('resolveHint', { company: company?.name ?? t('theCompany') })}
          </span>
        </div>

        <StepHeading num={2} label={t('step2')} />
        <p className="text-xs text-muted-foreground">{t('step2Hint')}</p>

        <StepHeading num={3} label={t('step3')} />
        {/* Choose (or drop) the completed template. Reading it auto-runs the same validate step the
            paste box uses, so the file flows straight into the check-before-create preview below. */}
        <div>
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
                accept={IMPORT_FILE_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void loadFile(f);
                }}
              />
            </div>
            {fileName && (
              <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
                {t('fileLoaded', { name: fileName })}
              </p>
            )}
          </Field>
        </div>

        {/* Secondary path, kept for the people who already use it — and the way to inspect or fix an
            uploaded file's contents without leaving the screen. */}
        <details className="border-t border-border pt-3" open={!fileName}>
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
                  setDependentsCsv('');
                  setFileName(null);
                  reset();
                }}
                spellCheck={false}
              />
            </Field>
          </div>
        </details>

        <StepHeading num={4} label={t('step4')} />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={validate} disabled={pending || reading || !csv.trim()}>
            {pending && phase !== 'done' ? t('validating') : t('validate')}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setCsv(SAMPLE);
              setDependentsCsv('');
              setFileName(null);
              reset();
            }}
            disabled={pending}
          >
            {t('loadSample')}
          </Button>
          <span className="ml-auto text-xs text-muted-foreground">{t('step4Hint')}</span>
        </div>

        <details className="border-t border-border pt-3 text-xs">
          <summary className="cursor-pointer select-none font-medium text-muted-foreground">
            {t('columnReference')}
          </summary>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <div className="mb-1 font-medium text-foreground">{t('required')}</div>
              <ul className="space-y-0.5 text-muted-foreground">
                {IMPORT_COLUMNS.required.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1 font-medium text-foreground">{t('optional')}</div>
              <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
                {IMPORT_COLUMNS.optional.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="mt-2 text-muted-foreground">
            <code>ic_number</code> {t('icHint')} <code>hired_on</code> {t('hiredOnHint')}{' '}
            <code>bank_name</code> {t('bankAnd')} <code>bank_account_no</code> {t('bankHint')}{' '}
            {t('booleanHintPre')}(<code>eis_eligible</code>, <code>is_resident</code>){t('booleanHintPost')}
          </p>
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
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('stepNum', { num: 6 })}
              </span>{' '}
              {t('importedCount', { count: result.imported })}
              {result.dependentsImported > 0 &&
                ` · ${t('dependentsImportedCount', { count: result.dependentsImported })}`}
              {result.skipped > 0 && ` · ${t('skippedCount', { count: result.skipped })}`}
              {result.failed.length > 0 && ` · ${t('failedCount', { count: result.failed.length })}`}
            </h2>
          </div>
          {/* Item 2983802f — the file was refused whole; nothing was written. Shown here as well as on the
              preview because a stale preview could have been confirmed against a file the server then
              re-checked and rejected. */}
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
          {/* These people ARE imported — only their Direct Superior link is missing, which is why they are
              reported apart from the failures rather than counted among them. */}
          {result.superiorFailed.length > 0 && (
            <div className="border-b border-border bg-amber-50/60 px-4 py-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              <div className="mb-1 font-semibold">
                {t('superiorFailedCount', { count: result.superiorFailed.length })}
              </div>
              <ul className="list-disc space-y-0.5 pl-5">
                {result.superiorFailed.map((f) => (
                  <li key={f.rowNum}>
                    {t('row', { num: f.rowNum })} · {f.email} — {f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.failed.length > 0 && (
            <ul className="divide-y divide-border text-sm">
              {result.failed.map((f) => (
                <li key={f.rowNum} className="px-4 py-2">
                  <span className="text-muted-foreground">{t('row', { num: f.rowNum })}</span> ·{' '}
                  {f.email} — <span className="text-red-600 dark:text-red-400">{f.message}</span>
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
                setDependentsCsv('');
                setFileName(null);
                reset();
              }}
            >
              {t('importAnother')}
            </button>
          </div>
        </Card>
      )}

      {preview && !result && (
        <PreviewTable
          preview={preview}
          onImport={commit}
          onDownloadErrors={downloadErrors}
          busy={pending}
        />
      )}
    </div>
  );
}

/**
 * Item 2983802f — the six steps, named, with the current one marked.
 *
 * The request asked for a step-by-step screen. The screen already WAS step-by-step; what it lacked was
 * any statement of where you are in it, so an admin who had pressed Validate could not tell whether the
 * import had happened. This rail is that statement and nothing more — no phase, no button and no
 * validation rule changed to add it.
 */
function StepRail({ current }: { current: number }) {
  const t = useTranslations('people.import');
  const labels = [t('step1'), t('step2'), t('step3'), t('step4'), t('step5'), t('step6')];
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs" aria-label={t('stepsAria')}>
      {labels.map((label, i) => {
        const num = i + 1;
        const done = num < current;
        const now = num === current;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              aria-current={now ? 'step' : undefined}
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                now
                  ? 'bg-primary text-primary-foreground'
                  : done
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              {num}
            </span>
            <span className={now ? 'font-medium text-foreground' : 'text-muted-foreground'}>{label}</span>
            {num < labels.length && (
              <span aria-hidden className="text-muted-foreground/40">
                →
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The same numbering, repeated over the control that performs that step. */
function StepHeading({ num, label }: { num: number; label: string }) {
  const t = useTranslations('people.import');
  return (
    <div className="flex items-baseline gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('stepNum', { num })}
      </span>
      <span className="text-sm font-medium">{label}</span>
    </div>
  );
}

function PreviewTable({
  preview,
  onImport,
  onDownloadErrors,
  busy,
}: {
  preview: ImportPreview;
  onImport: () => void;
  onDownloadErrors: (rows: ImportPreview['rows']) => void;
  busy: boolean;
}) {
  const t = useTranslations('people.import');
  const invalid = preview.total - preview.validCount;
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('stepNum', { num: 4 })}
          </span>{' '}
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
          {preview.dependents.total > 0 && (
            <>
              {' · '}
              <span className="text-muted-foreground">
                {t('familyRowsCount', { count: preview.dependents.total })}
              </span>
            </>
          )}
        </h2>
        {/* Function 3 of the reporter's flow: download just the rows that need correcting. */}
        {invalid > 0 && (
          <button
            type="button"
            onClick={() => onDownloadErrors(preview.rows.filter((r) => !r.ok))}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
          >
            {t('downloadErrors')}
          </button>
        )}
      </div>

      {/* Item 2983802f — A WHOLE-FILE REFUSAL. Distinct from the per-row errors in the table below,
          because it means something different: no row of this file will be imported, valid ones included.
          The Import button below is disabled while this is showing, and the server refuses independently
          — the button is the courtesy, not the guard. */}
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

      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="w-12 px-4 py-2 font-medium">#</th>
            <th className="px-4 py-2 font-medium">{t('colName')}</th>
            <th className="px-4 py-2 font-medium">{t('colEmail')}</th>
            {/* d8471481 — one file may span companies, so the preview must show WHERE each row lands
                before anything is created. Blank company cell ⇒ the target company selected above. */}
            <th className="px-4 py-2 font-medium">{t('colCompany')}</th>
            <th className="px-4 py-2 font-medium">{t('colResult')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {preview.rows.map((r) => (
            <tr key={r.rowNum} className={r.ok ? '' : 'bg-red-50/40 dark:bg-red-500/5'}>
              <td className="px-4 py-2 tabular-nums text-muted-foreground">{r.rowNum}</td>
              <td className="px-4 py-2 font-medium">{r.fullName || <span className="text-muted-foreground">—</span>}</td>
              <td className="px-4 py-2 text-muted-foreground">{r.email || '—'}</td>
              <td className="px-4 py-2 text-muted-foreground">{r.company || '—'}</td>
              <td className="px-4 py-2">
                {r.ok ? (
                  <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                    {t('ready')}
                    {r.warnings.length > 0 && (
                      <span className="text-amber-600 dark:text-amber-400">· {r.warnings.join('; ')}</span>
                    )}
                  </span>
                ) : (
                  <span className="text-red-600 dark:text-red-400">{r.errors.join('; ')}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Item 2983802f — the FAMILY sheet, checked as its own row set and shown as its own list. Only
          rendered when the workbook carried one, so a file without family looks exactly as it did. */}
      {preview.dependents.total > 0 && (
        <div className="border-t border-border">
          <div className="bg-muted/30 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('familySheet')} · {t('familyRowsCount', { count: preview.dependents.total })}
          </div>
          {preview.dependents.missingColumns.length > 0 && (
            <div className="border-b border-border bg-red-50/60 px-4 py-2.5 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-400">
              {t('missingColumns', { count: preview.dependents.missingColumns.length })}{' '}
              {preview.dependents.missingColumns.map((c) => (
                <code key={c} className="mx-0.5">
                  {c}
                </code>
              ))}
            </div>
          )}
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-12 px-4 py-2 font-medium">#</th>
                <th className="px-4 py-2 font-medium">{t('colEmployeeCode')}</th>
                <th className="px-4 py-2 font-medium">{t('colName')}</th>
                <th className="px-4 py-2 font-medium">{t('colRelationship')}</th>
                <th className="px-4 py-2 font-medium">{t('colResult')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {preview.dependents.rows.map((r) => (
                <tr key={r.rowNum} className={r.ok ? '' : 'bg-red-50/40 dark:bg-red-500/5'}>
                  <td className="px-4 py-2 tabular-nums text-muted-foreground">{r.rowNum}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.employeeCode || '—'}</td>
                  <td className="px-4 py-2 font-medium">{r.fullName || '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground">{r.relationship || '—'}</td>
                  <td className="px-4 py-2">
                    {r.ok ? (
                      <span className="text-emerald-600 dark:text-emerald-400">{t('ready')}</span>
                    ) : (
                      <span className="text-red-600 dark:text-red-400">{r.errors.join('; ')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Step 5 — the confirm decision, on its own bar under everything it is a decision about. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
        <span className="text-xs text-muted-foreground">
          <span className="font-semibold uppercase tracking-wide">{t('stepNum', { num: 5 })}</span> ·{' '}
          {preview.fileErrors.length > 0 ? t('step5Blocked') : t('step5Hint')}
        </span>
        <Button
          onClick={onImport}
          disabled={busy || preview.validCount === 0 || preview.fileErrors.length > 0}
          size="sm"
        >
          {busy ? t('importing') : t('importValid', { count: preview.validCount })}
        </Button>
      </div>
    </Card>
  );
}
