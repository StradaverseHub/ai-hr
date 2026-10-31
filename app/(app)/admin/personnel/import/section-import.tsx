'use client';
import {BankImportProgress} from './bank-import-progress';
import { personnelTemplateReferenceLists } from '@/lib/personnel-template-reference';
import { useNricPolicyMessage } from '@/components/nric-policy-message';
import {personnelImportExclusionRows} from '@/lib/personnel-import-exclusions';
import {buildPersonnelCsv} from '@/lib/personnel-csv';
import {isPersonnelRegisterKind,buildPersonnelRegisterCsv} from '@/lib/personnel-register-import';
import type {PersonnelImportSheet} from '@/lib/personnel-import-contract';
import { PersonnelImportValues } from '@/components/personnel-import-values';

import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UploadCloud } from 'lucide-react';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { IMPORT_FILE_ACCEPT, importFileMessageKey, readImportFile } from '@/lib/import-file';
import { toCsv } from '@/lib/csv';
import { personnelColumnLabel as descriptorColumnLabel, personnelColumnGuidance, personnelImportField, personnelImportFields } from '@/lib/personnel-import-contract';
import {
  buildPersonnelInstructionRows,
  personnelTemplateColumnWidths,
  PERSONNEL_INSTRUCTION_COLUMN_WIDTHS,
  buildReferenceRows,
} from '@/lib/import-template-xlsx';
import {
  sectionColumns, sectionTemplateColumns,
  sectionTextColumnIndexes,
  SECTION_SHEET_NAMES,
  SECTION_TEMPLATE_FILENAMES,
  type ImportSection,
  type SectionImportPreview,
  type SectionImportResult,
} from '@/lib/import-sections';
import type { ImportReference } from './employee-import';
import { commitSectionAction, validateSectionAction,registerRecordsAction } from './section-actions';
import { bankStatutoryChoices } from '@/lib/bank-statutory-import';

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
export function SectionImport({ section, reference, onCommitPendingChange }: { section: ImportSection; reference: ImportReference; onCommitPendingChange?: (pending: boolean) => void }) {
  const t = useTranslations('people.import');
  const nricMessage = useNricPolicyMessage();
  const nricTexts = useTranslations('peopleGeneral');
  const nricGuidance=nricTexts(reference.allowDuplicatedNric?'importOn':'importOff');
  const personnelLabels = useTranslations();
  const employeeColumnLabel=(key:string)=>descriptorColumnLabel(key,isPersonnelRegisterKind(section)?section:section==='family'?'family':'employee',(labelKey,fallback)=>personnelLabels.has(labelKey)?personnelLabels(labelKey):fallback);
  const guidance=(key:string,sheet:PersonnelImportSheet,mode:'create'|'update')=>[key==='ic_number'?nricGuidance:'',personnelColumnGuidance(key,sheet,mode,{required:t('required'),optional:t('optional'),reference:t('instructionReference'),blankRetains:t('sectionInstructionBlank')})].filter(Boolean).join(' · ');

  const router = useRouter();
  const [csv, setCsv] = useState('');
  const [existingEmployeeCode,setExistingEmployeeCode]=useState('');
  const [preview, setPreview] = useState<SectionImportPreview | null>(null);
  const [result, setResult] = useState<SectionImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  // 0db97f14 — the picked file itself, so a Bank & Statutory import records the ORIGINAL file in Import History.
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // A preview belongs to exact input; a slower read/validation cannot restore superseded input.
  const inputRevision = useRef(0);
  const fileReadRevision = useRef(0);
  const commitPending = useRef(false);
  // Keep the submitted file fixed until the real write reports its outcome; never discard success.
  const [committing, setCommitting] = useState(false);

  // Literal `t()` calls in a map, not a computed key: test/i18n-coverage.test.ts check C only resolves
  // literal keys, and a label that silently falls back to the key is exactly the class of bug it exists
  // to catch.
  const SECTION_LABEL: Record<ImportSection, string> = {
    profile: t('sectionProfile'),
    bank_statutory: t('sectionBankStatutory'),
    family: t('sectionFamily'),
    qualification:t('sectionQualification'),
    emergency:t('sectionEmergency'),
  };
  const label = SECTION_LABEL[section];
  const columns = sectionTemplateColumns(section);

  const reset = () => {
    inputRevision.current++;
    setPreview(null);
    setResult(null);
    setError(null);
  };

  const runValidate = (text: string) => {
    if (commitPending.current) return;
    reset();
    const revision = inputRevision.current;
    startTransition(async () => {
      setError(null);
      try {
        const p = await validateSectionAction(section, text);
        if (revision !== inputRevision.current) return;
        setPreview(p);
        setResult(null);
      } catch (e) {
        if (revision !== inputRevision.current) return;
        setError((e as Error).message);
      }
    });
  };

  const loadFile = async (file: File) => {
    if (commitPending.current) return;
    reset();
    const revision = inputRevision.current;
    const readRevision = ++fileReadRevision.current;
    setFileName(null);setSourceFile(null);
    setReading(true);
    try {
      // No extra sheets: a section file is ONE sheet by definition — that is what makes it a section.
      const { name, text } = await readImportFile(file,{allowedSheets:['Reference','Instructions','__PersonnelLists']});
      if (revision !== inputRevision.current) return;
      setCsv(text);
      setFileName(name);
      setSourceFile(file);
      setResult(null);
      runValidate(text);
    } catch (e) {
      if (revision !== inputRevision.current) return;
      setFileName(null);setSourceFile(null);
      reset();
      setError(t(importFileMessageKey(e)));
    } finally {
      if (readRevision === fileReadRevision.current) {
        setReading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    }
  };

  /**
   * The section's own template — the whole point of the request. Built in the BROWSER from the same
   * column list the server validates against (`lib/import-sections.ts`), so it carries THAT section's
   * columns and no others, and the identity columns are stamped as text so Excel cannot eat a leading
   * zero out of an Employee ID.
   */
  const downloadCsvTemplate=()=> {
    const url=URL.createObjectURL(new Blob([buildPersonnelCsv(isPersonnelRegisterKind(section)?section:section==='family'?'family':'employee',[columns.map(employeeColumnLabel)])],{type:'text/csv;charset=utf-8;'}));
    const a=document.createElement('a');a.href=url;a.download=SECTION_TEMPLATE_FILENAMES[section].replace(/\.xlsx$/,'.csv');a.click();URL.revokeObjectURL(url);
  };
  const downloadExistingRegister=()=>startTransition(async()=>{
    setError(null);
    if(!isPersonnelRegisterKind(section))return;
    try {
      const records=await registerRecordsAction(section,existingEmployeeCode);
      const text=buildPersonnelRegisterCsv(section,records,(key,fallback)=>personnelLabels.has(key)?personnelLabels(key):fallback);
      const url=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8;'}));
      const a=document.createElement('a');a.href=url;a.download=SECTION_TEMPLATE_FILENAMES[section].replace(/\.xlsx$/,'-current.csv');a.click();URL.revokeObjectURL(url);
    }catch(error){setError(error instanceof Error?error.message:t('fileReadError'));}
  });
  const downloadTemplate = async () => {
    setError(null);
    try {
      const { buildXlsx } = await import('@/lib/spreadsheet');
      const sheet=isPersonnelRegisterKind(section)?section:section==='family'?'family':'employee';
      const resolveLabel=(key:string,fallback:string)=>personnelLabels.has(key)?personnelLabels(key):fallback;
      const referenceLists=personnelTemplateReferenceLists(sheet,columns,reference,employeeColumnLabel,resolveLabel);
      // 0db97f14 — Yes/No, HRDF, tax category and bank lists for the Bank & Statutory settings.
      if(section==='bank_statutory')for(const column of columns){
        if(referenceLists.some(list=>list.column===column))continue;
        const choices=bankStatutoryChoices(column);if(!choices.length)continue;
        referenceLists.push({column,label:employeeColumnLabel(column),values:choices.map(choice=>choice.value),entries:choices.map(choice=>({value:choice.value,label:choice.labelKey?resolveLabel(choice.labelKey,choice.value):choice.label??choice.value}))});
      }
      // One Instructions row per column: what it is, whether it is required, and the values it accepts.
      const columnRows=section==='bank_statutory'?[[],[t('instructionColumnsHeading')],...columns.map(column=>{
        const list=referenceLists.find(item=>item.column===column);
        return [employeeColumnLabel(column),column==='employee_code'?t('required'):t('optional'),[guidance(column,'employee','update'),list?t('instructionAccepted',{values:list.values.join(', ')}):''].filter(Boolean).join(' · ')];
      })]:[];
      const extraSheets: NonNullable<import('@/lib/spreadsheet').BuildXlsxOptions['extraSheets']> = [];
      // Registry-owned choices and fresh catalogs follow the selected section.
      if (referenceLists.length > 0) {
        extraSheets.push({
          name: 'Reference',
          columnWidths:[38,80],wrapText:true,
          rows: buildReferenceRows(t('referenceHeading'), referenceLists,{code:personnelLabels('admin.systemLabels.col.code'),label:personnelLabels('admin.systemLabels.col.label')}),
        });
      }
      extraSheets.push({
        name: 'Instructions',
        columnWidths:PERSONNEL_INSTRUCTION_COLUMN_WIDTHS,wrapText:true,
        rows: [...buildPersonnelInstructionRows(t('instructionsHeading'), [
          t('sectionInstructionKey'),
          t('sectionInstructionBlank'),
          isPersonnelRegisterKind(section)?t('registerInstructions'):section === 'family' ? t('sectionInstructionFamilyRow') : t('sectionInstructionOneRow'),
          t('sectionInstructionFence'),
          t('instructionDates'),
          t('instructionIdentityText'),
          t('instructionImportCodes'),
          t('instructionLargeLists'),
                nricGuidance,
        ]),...columnRows,[],...personnelImportExclusionRows(section,(key,fallback)=>personnelLabels.has(key)?personnelLabels(key):fallback)],
      });
      const bytes = await buildXlsx(columns.map(employeeColumnLabel), [], {
        sheetName: SECTION_SHEET_NAMES[section],
        textColumns: sectionTextColumnIndexes(section),
        columnWidths:personnelTemplateColumnWidths(columns.map(employeeColumnLabel)),
        wrapText:true,
        headerNotes:columns.map(key=>[guidance(key,isPersonnelRegisterKind(section)?section:section==='family'?'family':'employee','update'),isPersonnelRegisterKind(section)&&personnelImportFields(section).find(field=>field.import.column===key)?.import.requiredCreate?t('registerRequiredCreate'):null].filter(Boolean).join(' · ')),
        extraSheets,
        validationListFallbackNote:t('instructionLargeLists'),
        validationLists:referenceLists.flatMap(list=>{const column=columns.indexOf(list.column);return column>=0?[{column,values:list.values}]:[];}),
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
      ...rows.map((r) => [r.rowNum, r.employeeCode, r.employeeName, r.errors.map(nricMessage).join('; ')]),
    ]);
    const url = URL.createObjectURL(new Blob([csvOut], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'section-import-errors.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const commit = () => {
    if (commitPending.current || pending || reading || !preview) return;
    commitPending.current = true;
    setCommitting(true);
    onCommitPendingChange?.(true);
    startTransition(async () => {
      setError(null);
      try {
        // The section name rides along on the history label so one history can hold both kinds of run
        // without an admin having to guess which was which.
        if (section === 'bank_statutory') {
          // 0db97f14 — the original file (or the pasted text as a CSV file) is recorded in Import History.
          const body = sourceFile ?? new Blob([csv], { type: 'text/csv;charset=utf-8' });
          const name = sourceFile?.name ?? 'pasted-bank-statutory.csv';
          const response = await fetch('/admin/personnel/import/bank-statutory/upload?name=' + encodeURIComponent(name), { method: 'POST', body, headers: { 'x-upload-operation': crypto.randomUUID() } });
          const payload = await response.json().catch(() => ({ error: null }));
          if (!response.ok) { setError(response.status === 413 ? t('fileTooLarge') : payload.error ?? t('bankStatutoryUploadFailed')); return; }
          setResult(payload as SectionImportResult);
          router.refresh();
          return;
        }
        const r = await commitSectionAction(section, csv, `${label} · ${fileName ?? t('historyPasted')}`);
        setResult(r);
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        commitPending.current = false;
        setCommitting(false);
        onCommitPendingChange?.(false);
      }
    });
  };

  if(section==='bank_statutory')return <div className="space-y-4"><Card className="space-y-3 p-5"><StepHeading num={1} label={t('sectionStep1')}/><div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={()=>void downloadTemplate()}>{t('sectionDownloadTemplate',{section:label})}</Button><Button variant="secondary" onClick={downloadCsvTemplate}>CSV</Button></div><p className="text-xs text-muted-foreground">{t('sectionUpdateOnlyNotice')}</p></Card><BankImportProgress/></div>;

  return (
    <div className="space-y-6">
      {isPersonnelRegisterKind(section) && <Card className="space-y-3 p-5"><p className="text-sm">{t('registerInstructions')}</p><p className="text-xs text-muted-foreground">{t('registerLimit')}</p><div className="flex flex-wrap items-end gap-2"><Field label={t('registerExistingEmployeeId')}><input className={inputCls} value={existingEmployeeCode} onChange={event=>setExistingEmployeeCode(event.target.value)} maxLength={30}/></Field><Button type="button" variant="secondary" disabled={pending||!existingEmployeeCode.trim()} onClick={downloadExistingRegister}>{t('registerDownloadExisting')}</Button></div></Card>}
      <Card className="space-y-4 p-5">
        <fieldset disabled={committing} className="min-w-0 space-y-4">
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
          <button type="button" onClick={downloadCsvTemplate} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted">CSV</button>
        </div>

        <StepHeading num={2} label={t('sectionStep2')} />
        <details className="text-xs">
          <summary className="cursor-pointer select-none font-medium text-muted-foreground">
            {t('sectionColumnsHeading')}
          </summary>
          <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground sm:grid-cols-3">
            {columns.map((c) => (
              <li key={c}>
                <span>{employeeColumnLabel(c)}</span>
              </li>
            ))}
          </ul>
          {/* The fence, said before the upload rather than only in the refusal — and said HONESTLY:
              some of the full template's columns belong to another section, and some belong to no
              section at all and are changed on the employee's own record instead. */}
          <p className="mt-2 text-muted-foreground">{t('sectionColumnsNotice')}</p>
        </details>

        <StepHeading num={3} label={t('sectionStep3')} />
        <Field label={t('uploadFile')}>
          <div
            role="button"
            aria-disabled={committing}
            tabIndex={committing ? -1 : 0}
            onClick={() => { if (!commitPending.current) fileInputRef.current?.click(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (!commitPending.current) fileInputRef.current?.click();
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
                  if (commitPending.current) return;
                  setCsv(e.target.value);
                  setFileName(null);setSourceFile(null);
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
        </fieldset>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {nricMessage(error)}
        </div>
      )}

      {result && (
        <Card className="overflow-hidden border-emerald-200 dark:border-emerald-500/30">
          <div className="border-b border-border bg-emerald-50/60 px-4 py-3 dark:bg-emerald-500/10">
            <h2 className="text-sm font-semibold">
              {result.section === 'family'
                ? t('familySavedCount', { count: result.updated })
                : isPersonnelRegisterKind(result.section)
                  ? t('registerSavedCount', { count: result.updated })
                  : t('sectionUpdatedCount', { count: result.updated })}
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
          {!!result.warnings?.length && <p role="status" className="px-4 py-3 text-sm text-amber-700 dark:text-amber-300">{result.warnings.join(' ')}</p>}
          {result.failed.length > 0 && (
            <ul className="divide-y divide-border text-sm">
              {result.failed.map((f) => (
                <li key={f.rowNum} className="px-4 py-2">
                  <span className="text-muted-foreground">{t('row', { num: f.rowNum })}</span> · {f.employeeCode} —{' '}
                  <span className="text-red-600 dark:text-red-400">{nricMessage(f.message)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-3 px-4 py-3 text-sm">
            <Link href="/admin/personnel" className="text-primary hover:underline">
              {t('viewPeople')}
            </Link>
            {result.attemptId && (
              <Link href={`/admin/personnel/import/history/${result.attemptId}`} className="text-primary hover:underline">
                {t('viewImportHistoryEntry')}
              </Link>
            )}
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                setCsv('');
                setFileName(null);setSourceFile(null);
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
  const nricMessage = useNricPolicyMessage();
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
  const nricMessage = useNricPolicyMessage();
  const labels = useTranslations();
  const sheet = isPersonnelRegisterKind(preview.section) ? preview.section : preview.section === 'family' ? 'family' : 'employee';
  const fieldLabel = (column: string) => descriptorColumnLabel(column, sheet, (key, fallback) => labels.has(key) ? labels(key) : fallback);
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
            {isPersonnelRegisterKind(preview.section)?t('readyCount',{count:preview.updateCount}):t('sectionUpdateCount', { count: preview.updateCount })}
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

      {/* ROWS THAT MATCH NOBODY, ANSWERED ONCE AND IN FULL. The per-row cell says "Not found"; this
          says WHY a section file cannot simply create them, and names the template that can. Without
          it the only place the product admits to being update-only is a truncated table cell. */}
      {preview.createCount > 0 && (
        <div className="border-b border-border bg-amber-50/60 px-4 py-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          {t('sectionNotFoundNotice', { count: preview.createCount })}
        </div>
      )}

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
                      {r.registerAction==='create'?t('registerCreate'):t('verdictUpdate')}
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
                  <PersonnelImportValues values={r.proposed} sheet={isPersonnelRegisterKind(preview.section)?preview.section:preview.section==='family'?'family':'employee'} />
                </td>
                <td className="px-4 py-2 text-xs">
                  {r.errors.length > 0 ? (
                    <span className="text-red-600 dark:text-red-400">{r.errors.map(nricMessage).join('; ')}</span>
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
          {busy ? t('importing') : isPersonnelRegisterKind(preview.section)?t('importValid',{count:preview.updateCount}):t('sectionImportButton', { count: preview.updateCount })}
        </Button>
      </div>
    </Card>
  );
}
