'use client';
import {useAssistantImportIntake} from '@/components/assistant/import-handoff';
import {PersonnelImportEvaluationPanel,type PersonnelImportEvaluationHandle,type PersonnelImportEvaluationStatus} from '@/components/personnel-import-evaluation-panel';
import {employeeImportSourceFingerprint,personnelImportLocalDigest,personnelImportLocalBytesDigest} from '@/lib/personnel-import-evaluation-client';
import {PersonnelImportEvidenceReview} from '@/components/personnel-import-evidence-review';
import {PersonnelImportPreparationReview} from '@/components/personnel-import-preparation-review';
import {preparePersonnelImportMatrix,preparePersonnelImportText,type PersonnelPreparation} from '@/lib/personnel-import-preparation';
import {PersonnelImportWorkbookReview,type PersonnelWorkbookReviewMessages} from '@/components/personnel-import-workbook-review';
import {PersonnelImportHeaderReview,type PersonnelImportHeaderReviewMessages,type PersonnelImportHeaderAssistanceAnnotation} from '@/components/personnel-import-header-review';
import {capturePersonnelImportSource,applyPersonnelHeaderMapping,currentPersonnelImportMatrix,appendPersonnelImportLocalEvidence,PERSONNEL_IMPORT_LOCAL_EVIDENCE_LIMIT,personnelWorksheetMatrixRows,type PersonnelImportLocalEvidence,type PersonnelImportSource,type PersonnelWorkbookSource,type PersonnelSheetRole} from '@/lib/personnel-import-assistance-source';
import { personnelTemplateReferenceLists, type PersonnelReferenceOption } from '@/lib/personnel-template-reference';
import { useNricPolicyMessage } from '@/components/nric-policy-message';
import {ALLOCATION_SHEET,ALLOCATION_REFERENCE_SHEET,ALLOCATION_INSTRUCTIONS_SHEET} from '@/lib/employment-cost-allocation';
import {allocationWorkbookSheets} from '@/lib/cost-allocation-workbook';
import {allocationWorkbookReferencesAction} from './cost-allocation-actions';
import {buildPersonnelCsv,decodePersonnelCsvRows,PERSONNEL_CSV_FRAME} from '@/lib/personnel-csv';
import {personnelImportExclusionRows} from '@/lib/personnel-import-exclusions';
import {PERSONNEL_REGISTER_KINDS,PERSONNEL_REGISTER_SHEETS,personnelRegisterColumns,type PersonnelRegisterTexts,type PersonnelRegisterKind} from '@/lib/personnel-register-import';
import type {PersonnelImportSheet} from '@/lib/personnel-import-contract';
import { PersonnelImportValues } from '@/components/personnel-import-values';

import { Fragment, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UploadCloud } from 'lucide-react';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { DownloadTemplate } from '@/components/download-template';
import { employeeTemplate } from '@/lib/import-template';
import { IMPORT_COLUMNS, type ImportPreview, type ImportResult } from '@/lib/import-schema';
import { IMPORT_FILE_ACCEPT, MAX_IMPORT_CSV_BYTES, importFileMessageKey, readImportFile } from '@/lib/import-file';
import { toCsv } from '@/lib/csv';
import { personnelColumnLabel as descriptorColumnLabel, personnelColumnGuidance, personnelImportField } from '@/lib/personnel-import-contract';
import {
  buildPersonnelInstructionRows,
  personnelTemplateColumnWidths,
  PERSONNEL_INSTRUCTION_COLUMN_WIDTHS,
  buildReferenceRows,
  dependentTextColumnIndexes,
  employeeTextColumnIndexes,
  DEPENDENT_SAMPLE_ROWS,
  DEPENDENT_XLSX_COLUMNS,
  EMPLOYEE_XLSX_FILENAME,
  EMPLOYEE_XLSX_SHEETS,
} from '@/lib/import-template-xlsx';
import { validateImportAction, commitImportAction } from './actions';

const SAMPLE = `full_name,email,department,position,hired_on,employment_type,ic_number,basic_salary,monthly_allowance,bank_name,bank_account_no,tax_category,num_children
Nadia Yusof,nadia@demo.test,Finance,,2026-06-01,full_time,910505051234,5200,400,Maybank,5566778899,2,1
Ravi Chandran,ravi@demo.test,Engineering,,2026-06-01,full_time,880808082345,9800,600,CIMB,1122334455,3,2
Siti Aminah,siti@demo.test,Operations,,2026-06-15,contract,950909093456,4100,0,,,1,0`;

type Phase = 'idle' | 'previewed' | 'done';

export type ImportReference = {
  allowDuplicatedNric?:boolean;
  organisationByCompany?:Record<string,Record<string,string[]>>;
  organisationOptionsByCompany?:Record<string,Record<string,PersonnelReferenceOption[]>>;
  catalogOptions?:Record<string,PersonnelReferenceOption[]>;
  departments: string[];
  positions: string[];
  costCenters: string[];
  // Item 2983802f — the profile_option catalogs the new columns are validated against. Empty arrays are
  // meaningful and correct: a tenant that never configured a list accepts free text, exactly as the
  // Personnel screens do, and the sheet then shows an em dash rather than pretending otherwise.
  states: string[];
  countries: string[];
  /** The passport's Issuing Country list. It is the NATIONALITY catalog — the Personnel Passport card's
   *  picker reads that one, so the stored value is a demonym ("Malaysian"), and `analyze()` checks this
   *  column against the same catalog. Listing `country` here would print spellings the importer refuses. */
  nationalities: string[];
  relationships: string[];
  familyRelationships: string[];
  salutations?:string[];religions?:string[];races?:string[];
  catalogs?:Record<string,string[]>;
};

export function EmployeeImport({
  companies,
  defaultCompanyId,
  reference,
  onCommitPendingChange,
}: {
  companies: { id: string; name: string }[];
  defaultCompanyId: string;
  /** Live catalog values for the Excel template's Reference sheet (d8471481). */
  reference: ImportReference;
  onCommitPendingChange?: (pending: boolean) => void;
}) {
  const t = useTranslations('people.import');
  const headerMessages:PersonnelImportHeaderReviewMessages={title:t('headerAssistance.title'),
localOnly:t('headerAssistance.localOnly'),
sheet:t('headerAssistance.sheet'),
column:t('headerAssistance.column'),
sourceHeading:t('headerAssistance.sourceHeading'),
sampleValues:t('headerAssistance.sampleValues'),
destination:t('headerAssistance.destination'),
chooseField:t('headerAssistance.chooseField'),
unresolved:t('headerAssistance.unresolved'),
ambiguous:t('headerAssistance.ambiguous'),
duplicate:t('headerAssistance.duplicate'),
applyMapping:t('headerAssistance.applyMapping'),
cancel:t('headerAssistance.cancel'),
reviewHeadings:t('headerAssistance.reviewHeadings'),
invalidSource:t('headerAssistance.invalidSource'),
acceptedRevision:t('headerAssistance.acceptedRevision'),
sourceChanged:t('headerAssistance.sourceChanged'),
unknownSheet:t('headerAssistance.unknownSheet'),aiTitle:t('headerAssistance.aiTitle'),aiDescription:t('headerAssistance.aiDescription'),aiChoose:t('headerAssistance.aiChoose'),aiConsent:t('headerAssistance.aiConsent'),aiSend:t('headerAssistance.aiSend'),aiWorking:t('headerAssistance.aiWorking'),aiUnavailable:t('headerAssistance.aiUnavailable'),aiUncertain:t('headerAssistance.aiUncertain'),aiReopen:t('headerAssistance.aiReopen'),aiNewRequest:t('headerAssistance.aiNewRequest'),aiReady:t('headerAssistance.aiReady'),aiUseSuggestion:t('headerAssistance.aiUseSuggestion'),aiNoHeadings:t('headerAssistance.aiNoHeadings'),aiLimit:t('headerAssistance.aiLimit'),aiSelected:t('headerAssistance.aiSelected'),aiStale:t('headerAssistance.aiStale'),aiPrepareUnknown:t('headerAssistance.aiPrepareUnknown')};
  const workbookMessages:PersonnelWorkbookReviewMessages={title:t('headerAssistance.workbook.title'),description:t('headerAssistance.workbook.description'),sheet:t('headerAssistance.workbook.sheet'),rows:t('headerAssistance.workbook.rows'),role:t('headerAssistance.workbook.role'),employee:t('headerAssistance.workbook.employee'),family:t('headerAssistance.workbook.family'),allocations:t('headerAssistance.workbook.allocations'),qualification:t('headerAssistance.workbook.qualification'),emergency:t('headerAssistance.workbook.emergency'),unassigned:t('headerAssistance.workbook.unassigned'),excluded:t('headerAssistance.workbook.excluded'),acknowledge:t('headerAssistance.workbook.acknowledge'),apply:t('headerAssistance.workbook.apply'),cancel:t('headerAssistance.workbook.cancel'),incomplete:t('headerAssistance.workbook.incomplete')};
  const nricMessage = useNricPolicyMessage();
  const nricTexts = useTranslations('peopleGeneral');
  const nricGuidance=nricTexts(reference.allowDuplicatedNric?'importOn':'importOff');
  const ta=useTranslations('costAllocations');
  const personnelLabels = useTranslations();
  const employeeColumnLabel=(key:string)=>descriptorColumnLabel(key,'employee',(labelKey,fallback)=>personnelLabels.has(labelKey)?personnelLabels(labelKey):fallback);
  const guidance=(key:string,sheet:PersonnelImportSheet,mode:'create'|'update')=>[key==='ic_number'?nricGuidance:'',personnelColumnGuidance(key,sheet,mode,{required:t('required'),optional:t('optional'),reference:t('instructionReference'),blankRetains:t('sectionInstructionBlank')})].filter(Boolean).join(' · ');
  const resolveReferenceLabel=(key:string,fallback:string)=>personnelLabels.has(key)?personnelLabels(key):fallback;
  const employeeChoices=personnelTemplateReferenceLists('employee',employeeTemplate.columns.map(column=>column.key),reference,employeeColumnLabel,resolveReferenceLabel);
  const familyChoices=personnelTemplateReferenceLists('family',DEPENDENT_XLSX_COLUMNS,reference,key=>descriptorColumnLabel(key,'family',resolveReferenceLabel),resolveReferenceLabel);
  const router = useRouter();
  const [companyId, setCompanyId] = useState(defaultCompanyId);
  const organisationGuidance=reference.organisationByCompany?.[companyId]??{department:reference.departments,position:reference.positions,cost_center:reference.costCenters};
  const [csv, setCsv] = useState('');
  const evaluation=useRef<PersonnelImportEvaluationHandle|null>(null);
  const [evaluationStatus,setEvaluationStatus]=useState<PersonnelImportEvaluationStatus>({tracked:false,mode:null,blocked:false,committed:false});
  const [sourceEpoch,setSourceEpoch]=useState(0),[guidedUsed,setGuidedUsed]=useState(false);
  const manualCorrection=useRef(false);
  const originalSourceFingerprint=useRef<string|null>(null);
  const baseline=evaluationStatus.tracked&&evaluationStatus.mode==='baseline';
  const [importSource,setImportSource]=useState<PersonnelImportSource|null>(null);
  const [reviewHeaders,setReviewHeaders]=useState(false);
  const headerReviewInputRevision=useRef<number|null>(null);
  const [headerNotice,setHeaderNotice]=useState<string|null>(null);
  // Opaque proposal-use metadata only. This does not claim a canonical commit or correctness.
  const headerAssistanceAnnotation=useRef<PersonnelImportHeaderAssistanceAnnotation|null>(null);
  // Item 2983802f — the Family sheet's rows, as CSV text, decoded from the SAME workbook in the browser.
  // Always '' for a pasted or .csv upload: a CSV file is one sheet, so it cannot carry family members.
  const [prepareIntake,setPrepareIntake]=useState(false);
  type PendingFileSource={fingerprint:string|null;priorGuidedUsed:boolean};
  const [workbookReview,setWorkbookReview]=useState<{revisionId:string;inputRevision:number;companyId:string;fileName:string;format:'xlsx'|'xls';workbook:PersonnelWorkbookSource;pendingSource:PendingFileSource}|null>(null);
  type PreparationReview={revisionId:string;inputRevision:number;companyId:string;fileName:string|null;preparation:PersonnelPreparation;
    companions:{family:string;allocations:string;registers:PersonnelRegisterTexts};replacesSource?:boolean;pendingSource?:PendingFileSource;workbook?:PersonnelWorkbookSource;sheetDecision?:{roles:Readonly<Record<string,PersonnelSheetRole>>;excluded:readonly string[];excludedAcknowledged:boolean}};
  const [preparationReview,setPreparationReview]=useState<PreparationReview|null>(null);
  const pendingFileSource=workbookReview?.pendingSource??preparationReview?.pendingSource;
  // Original cell/span/sheet evidence stays browser-local even after an accepted normalized revision.
  const [localEvidence,setLocalEvidence]=useState<readonly PersonnelImportLocalEvidence[]>([]);
  const [dependentsCsv, setDependentsCsv] = useState('');
  const [allocationsCsv,setAllocationsCsv]=useState('');
  const [registerTexts,setRegisterTexts]=useState<PersonnelRegisterTexts>({});
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
  // Item 2983802f — a template really was taken. The rail's step 1 is a thing the admin does, so it is
  // reported from the click that does it and never inferred from something else being true.
  const [templateDownloaded, setTemplateDownloaded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 524303d9 — the ORIGINAL file and the text read from it, so Import History keeps the uploaded file. Used
  // only while the text being imported is still exactly that text (an edit or a prepared text is not it).
  const sourceFile = useRef<{file:File;text:string}|null>(null);
  // A preview belongs to exact input; a slower read/validation cannot restore superseded input.
  const inputRevision = useRef(0);
  const fileReadRevision = useRef(0);
  const commitPending = useRef(false);
  // Keep the submitted file fixed until the real write reports its outcome; never discard success.
  const [committing, setCommitting] = useState(false);

  // Any edit invalidates a stale preview/result — force a fresh validate before importing.
  const reset = () => {
    inputRevision.current++;
    setPreview(null);
    setResult(null);
    setPhase('idle');
    setError(null);
    headerReviewInputRevision.current=null;setReviewHeaders(false);setHeaderNotice(null);
  };

  // Validate an explicit string rather than the `csv` state: after a file read the state update
  // has not flushed yet, so passing the text through avoids validating the previous contents.
  const runValidate = (text: string, family = dependentsCsv,registers=registerTexts,allocations=allocationsCsv) => {
    if (commitPending.current) return;
    reset();
    const revision = inputRevision.current;
    startTransition(async () => {
      setError(null);
      try {
        const p = await validateImportAction(text, companyId, family,registers,allocations);
        if (revision !== inputRevision.current) return;
        setPreview(p);
        setResult(null);
        setPhase('previewed');
        await evaluation.current?.record({kind:'preview',validRows:p.validCount,rejectedRows:p.total-p.validCount,fileErrors:p.fileErrors.length});
      } catch (e) {
        if (revision !== inputRevision.current) return;
        setError((e as Error).message);
      }
    });
  };

  const validate = () => runValidate(csv);

  const beginTextPreparation=()=>{
    if(commitPending.current||baseline||evaluationStatus.blocked)return;
    setGuidedUsed(true);reset();setWorkbookReview(null);
    const revisionId=crypto.randomUUID();
    const source=importSource?.currentText===csv?importSource:null;
    const options={columns:employeeTemplate.columns.map(column=>column.key),sheet:'employee' as const,resolvers:[resolveReferenceLabel]};
    try{
    const preparation=source?.provenance?preparePersonnelImportMatrix({revisionId,matrix:currentPersonnelImportMatrix(source),rowNumbers:source.rowNumbers,coordinateKind:source.coordinateKind,source:source.provenance,text:source.originalText},options):preparePersonnelImportText({revisionId,text:csv},options);
    setPreparationReview({revisionId,inputRevision:inputRevision.current,companyId,fileName:source?.fileName??fileName,preparation,
      companions:{family:dependentsCsv,allocations:allocationsCsv,registers:registerTexts}});
    }catch{setHeaderNotice(headerMessages.invalidSource);setPreparationReview(null);}
  };

  // Step 1 of the import (see lib/import-file): turn the chosen file into CSV text, then hand that
  // text to the SAME validate step the paste box uses. Nothing about parsing, validation or the
  // write path changes — this only replaces "open the file and copy its contents" for the user.
  const loadFile = async (file: File) => {
    if (commitPending.current) return;
    // A picked candidate is not the active source. Preserve its file label, companions, original
    // fingerprint and lineage until adoption; a failed/delayed read must not retarget old CSV.
    const priorGuidedUsed=pendingFileSource?.priorGuidedUsed??guidedUsed;
    if(pendingFileSource){setSourceEpoch(value=>value+1);setGuidedUsed(priorGuidedUsed);}
    reset();setWorkbookReview(null);setPreparationReview(null);
    const preparing=prepareIntake&&!baseline;
    const revision = inputRevision.current;
    const readRevision = ++fileReadRevision.current;
    setReading(true);
    try {
      // The reader maps the first requested companion to dependentsText, so Family must stay first.
      // A workbook without Family returns empty dependentsText, even when allocations are present.
      const { name, format,text, dependentsText,extraTexts,source,preparation } = await readImportFile(file, {
        captureSource:true,preparePersonnel:preparing,
        extraSheets: [EMPLOYEE_XLSX_SHEETS.family,ALLOCATION_SHEET,...Object.values(PERSONNEL_REGISTER_SHEETS)],
        allowedSheets:[ALLOCATION_SHEET,ALLOCATION_REFERENCE_SHEET,ALLOCATION_INSTRUCTIONS_SHEET,EMPLOYEE_XLSX_SHEETS.family,EMPLOYEE_XLSX_SHEETS.reference,EMPLOYEE_XLSX_SHEETS.instructions,...Object.values(PERSONNEL_REGISTER_SHEETS),'__PersonnelLists'],
      });
      // The canonical reader has already enforced file/decode bounds before allocating hash bytes.
      let originalDigest:string|null=null;
      try{originalDigest=await personnelImportLocalBytesDigest(await file.arrayBuffer());}catch{/* Measurement may be unavailable; the ordinary manual import stays usable. */}
      if(revision!==inputRevision.current)return;
      if(preparing){
        // Explicitly isolate measurement for the candidate before any cleanup. Cancel/supersede
        // invalidates this epoch; the still-active old CSV never inherits the candidate fingerprint.
        const pendingSource:PendingFileSource={fingerprint:originalDigest,priorGuidedUsed};
        const revisionId=crypto.randomUUID();
        if(preparation&&format!=='csv')setWorkbookReview({revisionId,inputRevision:revision,companyId,fileName:name,format,workbook:preparation,pendingSource});
        else setPreparationReview({revisionId,inputRevision:revision,companyId,fileName:name,
          replacesSource:true,pendingSource,preparation:preparePersonnelImportText({revisionId,text},{columns:employeeTemplate.columns.map(column=>column.key),sheet:'employee',resolvers:[resolveReferenceLabel]}),
          companions:{family:'',allocations:'',registers:{}}});
        setSourceEpoch(value=>value+1);setGuidedUsed(false);
        return;
      }
      // Recognised/manual file flow adopts only after decode AND fingerprint await are current.
      originalSourceFingerprint.current=originalDigest;setSourceEpoch(value=>value+1);setGuidedUsed(false);manualCorrection.current=false;
      setLocalEvidence([]);setCsv(text);headerAssistanceAnnotation.current=null;sourceFile.current={file,text};
      try{setImportSource(capturePersonnelImportSource({text,fileName:name,format,source},crypto.randomUUID()));}catch{setImportSource(null);}

      setDependentsCsv(dependentsText);
      const allocations=extraTexts?.[ALLOCATION_SHEET]??'';setAllocationsCsv(allocations);
      const registers=Object.fromEntries(PERSONNEL_REGISTER_KINDS.map(kind=>[kind,extraTexts?.[PERSONNEL_REGISTER_SHEETS[kind]]??'']));
      setRegisterTexts(registers);
      setFileName(name);
      setResult(null);
      runValidate(text, dependentsText,registers,allocations);
    } catch (e) {
      if (revision !== inputRevision.current) return;
      // A rejected candidate owns none of the active source identity or companion data. The old
      // preview stays invalidated, so the user must explicitly validate the unchanged old input again.
      reset();
      setError(t(importFileMessageKey(e)));
    } finally {
      if (readRevision === fileReadRevision.current) {
        setReading(false);
        // Allow re-picking the same file after fixing it — the change event won't fire otherwise.
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    }
  };

  // d8471481 — the Excel template. Built in the BROWSER (SheetJS is dynamically imported so the
  // ~400 KB library never enters the initial bundle or any server action), from the live catalogs the
  // server passed down. Three sheets; the data sheet stays FIRST because `workbookToCsvText` reads
  // the first worksheet on re-upload.
  const downloadFamilyCsv=()=> {
    const headings=DEPENDENT_XLSX_COLUMNS.map(key=>descriptorColumnLabel(key,'family',(labelKey,fallback)=>personnelLabels.has(labelKey)?personnelLabels(labelKey):fallback));
    const url=URL.createObjectURL(new Blob([buildPersonnelCsv('family',[headings])],{type:'text/csv;charset=utf-8;'}));
    const a=document.createElement('a');a.href=url;a.download='family-update-template.csv';a.click();URL.revokeObjectURL(url);
  };
  const registerLabel=(kind:PersonnelRegisterKind)=>kind==='qualification'?t('sectionQualification'):t('sectionEmergency');
  const registerColumnLabel=(kind:PersonnelRegisterKind,key:string)=>descriptorColumnLabel(key,kind,(labelKey,fallback)=>personnelLabels.has(labelKey)?personnelLabels(labelKey):fallback);
  const registerChoices=(kind:PersonnelRegisterKind)=>personnelTemplateReferenceLists(kind,personnelRegisterColumns(kind),reference,key=>registerColumnLabel(kind,key),resolveReferenceLabel);
  const downloadRegisterCsv=(kind:PersonnelRegisterKind)=>{
    const url=URL.createObjectURL(new Blob([buildPersonnelCsv(kind,[personnelRegisterColumns(kind).map(key=>registerColumnLabel(kind,key))])],{type:'text/csv;charset=utf-8;'}));
    const a=document.createElement('a');a.href=url;a.download=`${kind}-update-template.csv`;a.click();URL.revokeObjectURL(url);
  };
  const downloadXlsxTemplate = async () => {
    setError(null);
    try {
      const { buildXlsx } = await import('@/lib/spreadsheet');
      // c4055300 — the Cost Center Allocations sheet uses the same Company Code layout and codes for
      // every company the actor may maintain, exactly as the standalone allocation template.
      const allocationReferenceResult=await allocationWorkbookReferencesAction();
      if(!allocationReferenceResult.ok){setError(ta(`errors.${allocationReferenceResult.error}`));return;}
      const allocationReferences=allocationReferenceResult.references;
      const bytes = await buildXlsx(
        employeeTemplate.columns.map(column=>employeeColumnLabel(column.key)),
        employeeTemplate.sampleRows.map(row=>employeeTemplate.columns.map((_,i)=>row[i]??'')),
        {
          sheetName: EMPLOYEE_XLSX_SHEETS.data,
          textColumns: employeeTextColumnIndexes(),
          columnWidths:personnelTemplateColumnWidths(employeeTemplate.columns.map(column=>employeeColumnLabel(column.key))),
          wrapText:true,
          headerNotes: employeeTemplate.columns.map(column=>guidance(column.key,'employee','create')),
          validationListFallbackNote:t('instructionLargeLists'),
          validationLists:[...Object.entries(organisationGuidance).map(([key,values])=>({column:employeeTemplate.columns.findIndex(column=>column.key===key),values})).filter(list=>list.column>=0),...employeeChoices.map(list=>({column:employeeTemplate.columns.findIndex(column=>column.key===list.column),values:list.values})),{column:employeeTemplate.columns.findIndex(column=>column.key==='company'),values:companies.map(company=>company.name)}].filter(list=>list.column>=0),
          extraSheets: [
            ...allocationWorkbookSheets(allocationReferences,ta('instructions')).map(sheet=>({...sheet,validationListFallbackNote:t('instructionLargeLists')})),
            // Item 2983802f — THE FAMILY SHEET, second so it reads as the other sheet to fill in. It is
            // read back BY NAME on upload, so its position is free but its name is not.
            {
              name: EMPLOYEE_XLSX_SHEETS.family,
              rows: [DEPENDENT_XLSX_COLUMNS.map(key=>descriptorColumnLabel(key,'family',(labelKey,fallback)=>personnelLabels.has(labelKey)?personnelLabels(labelKey):fallback)), ...DEPENDENT_SAMPLE_ROWS.map((r) => [...r])],
              textColumns: dependentTextColumnIndexes(),
              columnWidths:personnelTemplateColumnWidths(DEPENDENT_XLSX_COLUMNS.map(key=>descriptorColumnLabel(key,'family',(labelKey,fallback)=>personnelLabels.has(labelKey)?personnelLabels(labelKey):fallback))),
              wrapText:true,
              headerNotes: DEPENDENT_XLSX_COLUMNS.map(key=>guidance(key,'family','create')),
              validationListFallbackNote:t('instructionLargeLists'),
              validationLists:familyChoices.map(list=>({column:DEPENDENT_XLSX_COLUMNS.indexOf(list.column),values:list.values})),
            },
            ...PERSONNEL_REGISTER_KINDS.map(kind=>({name:PERSONNEL_REGISTER_SHEETS[kind],
              rows:[personnelRegisterColumns(kind).map(key=>registerColumnLabel(kind,key))],
              textColumns:personnelRegisterColumns(kind).map((_,index)=>index),
              columnWidths:personnelTemplateColumnWidths(personnelRegisterColumns(kind).map(key=>registerColumnLabel(kind,key))),
              wrapText:true,
              headerNotes:personnelRegisterColumns(kind).map(key=>guidance(key,kind,'create')),
              validationListFallbackNote:t('instructionLargeLists'),
              validationLists:registerChoices(kind).map(list=>({column:personnelRegisterColumns(kind).indexOf(list.column),values:list.values})),
            })),
            {
              name: EMPLOYEE_XLSX_SHEETS.reference,
              columnWidths:[38,80],wrapText:true,
              rows: buildReferenceRows(t('referenceHeading'), [
                { label: employeeColumnLabel('company'), values: companies.map((c) => c.name), entries:companies.map(company=>({value:company.name,label:company.name})) },
                ...Object.entries(organisationGuidance).map(([column,values])=>({label:`${employeeColumnLabel(column)} — ${companies.find(company=>company.id===companyId)?.name??''}`,values,entries:reference.organisationOptionsByCompany?.[companyId]?.[column]})),
                ...employeeChoices,
                ...familyChoices,
                ...PERSONNEL_REGISTER_KINDS.flatMap(registerChoices),
              ],{code:personnelLabels('admin.systemLabels.col.code'),label:personnelLabels('admin.systemLabels.col.label')}),
            },
            {
              name: EMPLOYEE_XLSX_SHEETS.instructions,
              columnWidths:PERSONNEL_INSTRUCTION_COLUMN_WIDTHS,wrapText:true,
              rows: [...buildPersonnelInstructionRows(t('instructionsHeading'), [
                t('instructionRequired', { columns: IMPORT_COLUMNS.required.map(employeeColumnLabel).join(', ') }),
                t('instructionDates'),
                t('instructionIdentityText'),
                nricGuidance,
                t('instructionCompany'),
                t('instructionReference'),
                t('instructionImportCodes'),
                t('instructionLargeLists'),
                t('instructionPassport'),
                t('instructionAddress'),
                t('instructionProbation'),
                // r369 (item eb949191) — the one column whose rule is a CONDITION rather than a format, so
                // it has to be said in words: a zero Basic Salary is accepted, and then the reason is not
                // optional. Named by its workbook heading, which is the spelling on the sheet beside it.
                t('instructionSalaryRemarks', { column: employeeColumnLabel('salary_remarks') }),
                t('instructionSuperior'),
                t('instructionFamily'),
                t('instructionFamilyWhole'),
                t('registerInstructions'),
                t('registerFullInstructions'),
                t('instructionSamples'),
                // 524303d9 — the duplicate policy, the Bank & Statutory settings, the hire-time settings, Import
                // History/Revert, and everything this template deliberately does not carry, each with its reason.
                t('instructionDuplicateEmail'),
                t('instructionStatutorySettings'),
                t('instructionHireSettings'),
                t('instructionRevert'),
                t('notImported.heading'),
                ...(['photos','documents','leaveBalances','delegations','payItems','openingTax','holidayCalendar'] as const).map(key=>t(`notImported.${key}`)),
              ]),[],...personnelImportExclusionRows('full',(key,fallback)=>personnelLabels.has(key)?personnelLabels(key):fallback)],
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
      setTemplateDownloaded(true);
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
      ...rows.map((r) => [r.rowNum, r.fullName, r.email, r.errors.map(nricMessage).join('; ')]),
    ]);
    const url = URL.createObjectURL(new Blob([csvOut], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'employee-import-errors.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const commit = () => {
    if (commitPending.current || pending || reading || evaluationStatus.blocked || evaluationStatus.committed || !preview) return;
    commitPending.current = true;
    setCommitting(true);
    onCommitPendingChange?.(true);
    startTransition(async () => {
      setError(null);
      try {
        // cf43c909 — the file's NAME rides along as the history row's label. The file itself never leaves
        // the browser: `csv` is still the only thing sent, so the write path is unchanged.
        const revision=inputRevision.current;
        const binding=await evaluation.current?.prepareCommit({csv,companyId,family:dependentsCsv,registers:registerTexts,allocations:allocationsCsv,revision});
        if(binding===null||revision!==inputRevision.current)return;
        let r:Awaited<ReturnType<typeof commitImportAction>>;
        try{
          // 524303d9 — an uploaded file whose text is still exactly what is being imported goes to Import History
          // as the original bytes; a paste, an edited or a prepared text is recorded by the action as its CSV text.
          const original=!binding&&sourceFile.current&&sourceFile.current.text===csv?sourceFile.current.file:null;
          if(!original)r=await commitImportAction(csv, companyId, fileName ?? '', dependentsCsv, registerTexts, allocationsCsv, preview.allocations?.token, binding);
          else{
            const body=new FormData();
            body.append('file',original,original.name);
            body.append('payload',JSON.stringify({companyId,csv,fileName:fileName??'',dependentsCsv,registers:registerTexts,allocationsCsv,allocationToken:preview.allocations?.token}));
            const response=await fetch('/admin/personnel/import/employee/upload',{method:'POST',body,headers:{'x-upload-operation':crypto.randomUUID()}});
            const payload=await response.json().catch(()=>({error:null}));
            if(!response.ok)throw new Error(response.status===413?t('fileTooLarge'):payload.error??t('employeeUploadFailed'));
            r=payload as Awaited<ReturnType<typeof commitImportAction>>;
          }
        }catch(cause){if(binding)evaluation.current?.commitUncertain();throw cause;}
        if(binding)evaluation.current?.acceptCommit(r.evaluationReceipt);
        setResult(r);
        setPhase('done');
        router.refresh();
      } catch (e) {
        setError(evaluationStatus.tracked?t('measurement.commitUncertain'):(e as Error).message);
      } finally {
        commitPending.current = false;
        setCommitting(false);
        onCommitPendingChange?.(false);
      }
    });
  };

  const company = companies.find((c) => c.id === companyId);

  // Item 2983802f — which numbered step the screen is on. Every arm is a thing the screen has EVIDENCE
  // for, and the rail paints only the steps before it as done, so it never claims a step that has not
  // happened. The first cut derived it from three signals alone and could therefore never show steps 2
  // or 3 at all: it sat on step 1 until text appeared and then jumped straight to 4, so an admin who had
  // downloaded the template and was filling it in was told they were still on "Download the template",
  // and the two middle steps were dead labels. The template download and the upload in progress are both
  // observable, so they are observed.
  //
  // Note on step 4: being ON "Check and preview" is not a claim that validation has run. It becomes DONE
  // (and the rail moves to 5) only when a preview actually comes back — `preview`, below, is set by the
  // server action and by nothing else.
  const currentStep = result
    ? 6
    : preview
      ? 5
      : reading || dragging
        ? 3 // a file is being dropped or read right now — the upload IS the step in progress
        : csv.trim() !== ''
          ? 4 // data is in hand, however it arrived; the next thing to do is check it
          : templateDownloaded
            ? 2 // the template has been taken; filling it in happens off-screen
            : 1;

  useAssistantImportIntake('employee',text=>{reset();setCsv(text);setFileName(null);sourceFile.current=null;},setError);

  return (
    <div className="space-y-6">
      {allocationsCsv.trim()&&<p className="rounded-md border p-3 text-sm">{ta('companion',{count:preview?.allocations?.groups.length??0})}</p>}
      {preview?.allocations&&<section className="space-y-3 rounded-md border p-4" aria-label={ta('confirmTitle')}>{preview.allocations.groups.map(group=><div key={group.key} className="border-b pb-3 text-sm last:border-0"><p className="font-medium">{group.employeeCode} · {group.effectiveDate}</p><p className="text-xs text-muted-foreground">{group.companyId} · {ta('sourceRows')}: {group.rowNums.join(', ')}</p><ul>{group.displayRows?.map((row,i)=><li key={i}>{row.code} · {row.percentage}%</li>)}</ul>{group.operation==='clear'&&<p>{ta('clearHelp')}</p>}{group.errors.map((message,i)=><p key={i} className="text-destructive">{message}</p>)}</div>)}</section>}
      <StepRail current={currentStep} />
      <PersonnelImportEvaluationPanel ref={evaluation} companyId={companyId} sourceEpoch={sourceEpoch} baselineAvailable={!workbookReview&&!preparationReview}
        getSource={()=>{
          // A candidate with unknown hash NEVER borrows the unrelated active source fingerprint.
          const fingerprint=pendingFileSource?pendingFileSource.fingerprint:originalSourceFingerprint.current;
          return{...(fingerprint?{fingerprint}:{}),text:workbookReview?JSON.stringify(workbookReview.workbook):preparationReview?.preparation?JSON.stringify(preparationReview.preparation):employeeImportSourceFingerprint(csv,dependentsCsv,registerTexts,allocationsCsv),revision:inputRevision.current};
        }}
        canBegin={!guidedUsed&&!!(csv.trim()||workbookReview||preparationReview)} disabled={pending||reading||committing} onStatus={setEvaluationStatus} onStarted={()=>{setPreview(null);setResult(null);setPhase('idle');}}/>
      <Card className="space-y-4 p-5">
        <fieldset disabled={committing||evaluationStatus.blocked} className="min-w-0 space-y-4">
        <div className="sm:max-w-[260px]">
          <Field label={t('targetCompany')}>
            <select
              className={inputCls}
              value={companyId}
              onChange={(e) => {
                if (commitPending.current) return;
                setCompanyId(e.target.value);setSourceEpoch(value=>value+1);setGuidedUsed(false);manualCorrection.current=false;originalSourceFingerprint.current=null;headerAssistanceAnnotation.current=null;setWorkbookReview(null);setPreparationReview(null);setLocalEvidence([]);
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
          <DownloadTemplate spec={employeeTemplate} onDownloaded={() => setTemplateDownloaded(true)} />
          <button type="button" onClick={downloadFamilyCsv} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted">{t('sectionFamily')} CSV</button>
          {PERSONNEL_REGISTER_KINDS.map(kind=><button key={kind} type="button" onClick={()=>downloadRegisterCsv(kind)} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted">{registerLabel(kind)} CSV</button>)}
          <span className="ml-auto text-xs text-muted-foreground">
            {t('resolveHint', { company: company?.name ?? t('theCompany') })}
          </span>
        </div>

        <StepHeading num={2} label={t('step2')} />
        <p className="text-xs text-muted-foreground">{t('step2Hint',{columns:IMPORT_COLUMNS.required.map(employeeColumnLabel).join(', ')})}</p>

        <StepHeading num={3} label={t('step3')} />
        {/* Choose (or drop) the completed template. Reading it auto-runs the same validate step the
            paste box uses, so the file flows straight into the check-before-create preview below. */}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={prepareIntake&&!baseline} disabled={baseline||pending||reading||committing} onChange={e=>setPrepareIntake(e.target.checked)}/><span>{t('headerAssistance.workbook.prepareToggle')}<span className="mt-1 block text-xs text-muted-foreground">{t('headerAssistance.workbook.prepareHint')}</span></span></label>
        <div>
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
                dragging
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50 hover:bg-muted/40'
              }`}
            >
              <UploadCloud className="h-6 w-6 text-muted-foreground" aria-hidden />
              <div className="text-sm font-medium">{reading ? t('reading') : t('dropHere')}</div>
              <p className="text-xs text-muted-foreground">{t('fullUploadHint')}</p>
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
                onBlur={()=>{if(manualCorrection.current){manualCorrection.current=false;void evaluation.current?.record({kind:'correction',mappingChanges:null,editedRows:null,reason:'values'});}}}
                onChange={(e) => {
                  if (commitPending.current) return;
                  if(pendingFileSource){setSourceEpoch(value=>value+1);setGuidedUsed(pendingFileSource.priorGuidedUsed);}
                  manualCorrection.current=true;originalSourceFingerprint.current=null;setCsv(e.target.value);setImportSource(null);headerAssistanceAnnotation.current=null;setWorkbookReview(null);setPreparationReview(null);
                  setFileName(null);
                  reset();
                }}
                spellCheck={false}
              />
            </Field>
          </div>
        </details>

        <Button type="button" variant="outline" disabled={baseline||pending||reading||committing||!!workbookReview||!!preparationReview||!csv.trim()} onClick={beginTextPreparation}>{t('headerAssistance.workbook.prepareText')}</Button>
        {!baseline&&workbookReview&&<PersonnelImportWorkbookReview key={workbookReview.revisionId} workbook={workbookReview.workbook} revisionId={workbookReview.revisionId}
          knownRoles={Object.fromEntries(workbookReview.workbook.sheets.map(sheet=>{
            const key=sheet.sheetName.trim().toLowerCase(),roles:Record<string,PersonnelSheetRole>={[EMPLOYEE_XLSX_SHEETS.family.trim().toLowerCase()]:'family',[ALLOCATION_SHEET.trim().toLowerCase()]:'allocations',[PERSONNEL_REGISTER_SHEETS.qualification.trim().toLowerCase()]:'qualification',[PERSONNEL_REGISTER_SHEETS.emergency.trim().toLowerCase()]:'emergency'};
            return[sheet.sheetName,roles[key]??'unassigned'];
          }))} messages={workbookMessages} disabled={pending||reading||committing}
          onCancel={()=>{if(workbookReview.pendingSource){setSourceEpoch(value=>value+1);setGuidedUsed(workbookReview.pendingSource.priorGuidedUsed);}setWorkbookReview(null);}} onApply={(reviewed,expectedRevision)=>{
            if(commitPending.current)return;
            if(expectedRevision!==workbookReview.revisionId||workbookReview.inputRevision!==inputRevision.current||workbookReview.companyId!==companyId){setHeaderNotice(headerMessages.sourceChanged);setWorkbookReview(null);return;}
            try{
            setGuidedUsed(true);const employee=reviewed.employee,revisionId=crypto.randomUUID();
            const framed=employee.source.rows[0]?.cells[0]?.decoded===PERSONNEL_CSV_FRAME;
            const rows=employee.source.rows.slice(framed?1:0);
            const matrix=decodePersonnelCsvRows(personnelWorksheetMatrixRows(employee.source),'employee');
            const preparation=preparePersonnelImportMatrix({revisionId,matrix,rowNumbers:rows.map(row=>row.row),coordinateKind:'worksheet_row',source:employee.source,text:employee.text},
              {columns:employeeTemplate.columns.map(column=>column.key),sheet:'employee',resolvers:[resolveReferenceLabel]});
            setPreparationReview({revisionId,inputRevision:inputRevision.current,companyId,fileName:workbookReview.fileName,preparation,replacesSource:true,pendingSource:workbookReview.pendingSource,workbook:reviewed.original,sheetDecision:{roles:reviewed.roles,excluded:reviewed.excluded,excludedAcknowledged:reviewed.excludedAcknowledged},
              companions:{family:reviewed.companions.family,allocations:reviewed.companions.allocations,registers:{qualification:reviewed.companions.qualification,emergency:reviewed.companions.emergency}}});
            }catch{setHeaderNotice(headerMessages.invalidSource);return;}
            setWorkbookReview(null);
          }}/>}
        {!baseline&&preparationReview&&<div className="space-y-3"><PersonnelImportPreparationReview key={preparationReview.revisionId} preparation={preparationReview.preparation} sourceRevisionId={preparationReview.revisionId} mode="create" onApply={applied=>{
          if(commitPending.current)return;
          if(applied.sourceRevisionId!==preparationReview.revisionId||preparationReview.inputRevision!==inputRevision.current||preparationReview.companyId!==companyId){setHeaderNotice(headerMessages.sourceChanged);setPreparationReview(null);return;}
          if(!preparationReview.replacesSource&&localEvidence.length>=PERSONNEL_IMPORT_LOCAL_EVIDENCE_LIMIT){setHeaderNotice(t('localEvidence.limit'));return;}
          const companions=preparationReview.companions;
          if(new Blob([applied.text,companions.family,companions.allocations,...Object.values(companions.registers)]).size>MAX_IMPORT_CSV_BYTES){setError(t('fileTooLarge'));return;}
          try{
            const nextSource=capturePersonnelImportSource({text:applied.text,fileName:preparationReview.fileName,format:'paste'},applied.revisionId);
            const evidence=appendPersonnelImportLocalEvidence(preparationReview.replacesSource?[]:localEvidence,{kind:'preparation',revisionId:applied.revisionId,text:applied.text,applied,...preparationReview.workbook?{workbook:preparationReview.workbook}:{},...preparationReview.sheetDecision?{sheetDecision:preparationReview.sheetDecision}:{}});setLocalEvidence(evidence);
            if(preparationReview.pendingSource)originalSourceFingerprint.current=preparationReview.pendingSource.fingerprint;
            reset();setCsv(applied.text);setImportSource(nextSource);setGuidedUsed(true);manualCorrection.current=false;
            const capturedRevision=inputRevision.current;void personnelImportLocalDigest(applied.text).then(revision=>{if(capturedRevision===inputRevision.current)void evaluation.current?.record({kind:'preparation',revision,normalizations:null,corrections:null,unresolved:0,conflicts:null,duplicates:null,missingSourceEvidence:null});}).catch(()=>setHeaderNotice(t('measurement.observationUnavailable')));headerAssistanceAnnotation.current=null;
            setDependentsCsv(companions.family);setAllocationsCsv(companions.allocations);setRegisterTexts(companions.registers);setFileName(preparationReview.fileName);setPreparationReview(null);setHeaderNotice(headerMessages.acceptedRevision);
          }catch{setHeaderNotice(headerMessages.invalidSource);}
        }}/><Button type="button" variant="outline" disabled={pending||reading||committing} onClick={()=>{if(preparationReview.pendingSource){setSourceEpoch(value=>value+1);setGuidedUsed(preparationReview.pendingSource.priorGuidedUsed);}setPreparationReview(null);}}>{workbookMessages.cancel}</Button></div>}

        <div className="space-y-3">
          <Button type="button" variant="outline" disabled={baseline||pending||reading||committing||!!workbookReview||!!preparationReview||!csv.trim()} onClick={()=>{
            if(commitPending.current||baseline)return;setGuidedUsed(true);
            try{const source=importSource?.currentText===csv?importSource:capturePersonnelImportSource({text:csv,format:'paste'},crypto.randomUUID());setImportSource(source);headerReviewInputRevision.current=inputRevision.current;setReviewHeaders(true);setHeaderNotice(null);}
            catch{setHeaderNotice(headerMessages.invalidSource);setReviewHeaders(false);}
          }}>{headerMessages.reviewHeadings}</Button>
          {headerNotice&&<p role="status" className="text-sm text-muted-foreground">{headerNotice}</p>}
          {!baseline&&reviewHeaders&&importSource&&<PersonnelImportHeaderReview key={importSource.revisionId} source={importSource} companyId={companyId}
            options={{columns:employeeTemplate.columns.map(column=>column.key),sheet:'employee',resolvers:[resolveReferenceLabel]}}
            choices={employeeTemplate.columns.map(column=>({key:column.key,label:employeeColumnLabel(column.key)}))}
            messages={headerMessages} evaluationBinding={evaluation.current?.binding()} allowAi={!baseline&&!evaluationStatus.blocked} disabled={pending||reading||committing}
            onCancel={()=>setReviewHeaders(false)} onApply={(destinations,revision,assistance)=>{
              if(commitPending.current)return;
              if(headerReviewInputRevision.current!==inputRevision.current||importSource.revisionId!==revision||importSource.currentText!==csv){setHeaderNotice(headerMessages.sourceChanged);setReviewHeaders(false);return;}
              if(localEvidence.length>=PERSONNEL_IMPORT_LOCAL_EVIDENCE_LIMIT){setHeaderNotice(t('localEvidence.limit'));return;}
              try{const accepted=applyPersonnelHeaderMapping(importSource,revision,destinations,employeeTemplate.columns.map(column=>column.key),crypto.randomUUID());const evidence=appendPersonnelImportLocalEvidence(localEvidence,{kind:'headers',revisionId:accepted.revisionId,text:accepted.text,source:accepted.source});setLocalEvidence(evidence);reset();setCsv(accepted.text);setImportSource(accepted.source);headerAssistanceAnnotation.current=assistance??null;void evaluation.current?.record({kind:'correction',mappingChanges:null,editedRows:0,reason:'mapping'});setHeaderNotice(headerMessages.acceptedRevision);}
              catch{setHeaderNotice(headerMessages.invalidSource);}
            }}/>}
        </div>

        <PersonnelImportEvidenceReview entries={localEvidence} currentText={csv}/>
        <StepHeading num={4} label={t('step4')} />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={validate} disabled={pending || reading || !!workbookReview || !!preparationReview || !csv.trim()}>
            {pending && phase !== 'done' ? t('validating') : t('validate')}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              if (commitPending.current) return;
              setSourceEpoch(value=>value+1);setGuidedUsed(false);manualCorrection.current=false;originalSourceFingerprint.current=null;setCsv(SAMPLE);setImportSource(null);headerAssistanceAnnotation.current=null;setWorkbookReview(null);setPreparationReview(null);setLocalEvidence([]);
              setDependentsCsv('');setRegisterTexts({});setAllocationsCsv('');
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
                    <span>{employeeColumnLabel(c)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1 font-medium text-foreground">{t('optional')}</div>
              <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
                {IMPORT_COLUMNS.optional.map((c) => (
                  <li key={c}>
                    <span>{employeeColumnLabel(c)}</span>
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
          {/* r369 (item eb949191) — the condition on the new column, stated where the columns are listed.
              The reference above names the column; this says the one thing about it that a spelling
              cannot: WHEN it stops being optional. */}
          <p className="mt-2 text-muted-foreground">
            {t('instructionSalaryRemarks', { column: 'salary_remarks' })}
          </p>
        </details>
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
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('stepNum', { num: 6 })}
              </span>{' '}
              {t('importedCount', { count: result.imported })}
              {result.registersImported && result.registersImported.qualification+result.registersImported.emergency>0 && <span> · {t('registerSavedCount',{count:result.registersImported.qualification+result.registersImported.emergency})}</span>}
              {result.dependentsImported > 0 &&
                ` · ${t('dependentsImportedCount', { count: result.dependentsImported })}`}
              {result.skipped > 0 && ` · ${t('skippedCount', { count: result.skipped })}`}
              {result.failed.length > 0 && ` · ${t('failedCount', { count: result.failed.length })}`}
            </h2>
          </div>
          {/* Item 2983802f — the file was refused whole; nothing was written. Shown here as well as on the
              preview because a stale preview could have been confirmed against a file the server then
              re-checked and rejected. */}
          {result.attemptId && (
            <p className="border-b border-border px-4 py-2 text-sm">
              <Link href={`/admin/personnel/import/history/${result.attemptId}`} className="text-primary hover:underline">{t('viewImportHistoryEntry')}</Link>
            </p>
          )}
          {!!result.warnings?.length && <p role="status" className="px-4 py-3 text-sm text-amber-700 dark:text-amber-300">{result.warnings.join(' ')}</p>}
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
                    {t('row', { num: f.rowNum })} · {f.email} — {nricMessage(f.message)}
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
                  {f.email} — <span className="text-red-600 dark:text-red-400">{nricMessage(f.message)}</span>
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
                setSourceEpoch(value=>value+1);setGuidedUsed(false);manualCorrection.current=false;originalSourceFingerprint.current=null;setCsv('');setImportSource(null);headerAssistanceAnnotation.current=null;setWorkbookReview(null);setPreparationReview(null);setLocalEvidence([]);
                setDependentsCsv('');setRegisterTexts({});setAllocationsCsv('');
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
          busy={pending||evaluationStatus.blocked||evaluationStatus.committed}
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
  const nricMessage = useNricPolicyMessage();
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
            <Fragment key={r.rowNum}><tr className={r.ok ? '' : 'bg-red-50/40 dark:bg-red-500/5'}>
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
                  <span className="text-red-600 dark:text-red-400">{r.errors.map(nricMessage).join('; ')}</span>
                )}
              </td>
            </tr>
            {!!r.proposed?.length && <tr className={r.ok ? '' : 'bg-red-50/40 dark:bg-red-500/5'}>
              <td colSpan={5} className="px-4 pb-3">
                <PersonnelImportValues values={r.proposed} sheet="employee" />
              </td>
            </tr>}
            </Fragment>
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
                      <span className="text-red-600 dark:text-red-400">{r.errors.map(nricMessage).join('; ')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview.registers?.filter(register=>register.total>0).map(register=><div key={register.kind} className="overflow-x-auto border-t border-border">
        <h3 className="bg-muted/30 px-4 py-2 text-sm font-semibold">{register.kind==='qualification'?t('sectionQualification'):t('sectionEmergency')} · {register.total}</h3>
        <table className="w-full text-sm"><thead className="bg-muted/50 text-left text-xs"><tr><th className="px-4 py-2">#</th><th>{t('colEmployeeCode')}</th><th>{t('colName')}</th><th>{t('colResult')}</th></tr></thead>
          <tbody>{register.rows.map(row=><tr key={row.rowNum} className={row.ok?'':'bg-red-50/40 dark:bg-red-500/5'}><td className="px-4 py-2">{row.rowNum}</td><td className="font-mono text-xs">{row.employeeCode}</td><td>{row.employeeName}<PersonnelImportValues values={row.proposed} sheet={register.kind}/></td><td className={row.ok?'text-emerald-600':'text-red-600'}>{row.ok?(row.action==='create'?t('registerCreate'):t('verdictUpdate')):row.errors.map(nricMessage).join('; ')}</td></tr>)}</tbody>
        </table>
      </div>)}

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
