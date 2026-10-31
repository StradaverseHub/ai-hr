'use server';
import {parseCostAllocationCsv} from '@/lib/cost-allocation-import';

import {PERSONNEL_REGISTER_KINDS,personnelRegisterColumns,type PersonnelRegisterTexts,type PersonnelRegisterRecords} from '@/lib/personnel-register-import';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import {getBrowserCommandSession} from '@/lib/session';
import {beginEmployeeImportEvaluation,prepareEmployeeImportEvaluationCommit,reopenEmployeeImportEvaluation,recordEmployeeImportEvaluationTelemetry,associateReusedEmployeeImportHeader,eraseOwnImportEvaluationMetadata,EMPLOYEE_IMPORT_EVALUATION_UNAVAILABLE} from '@/core/personnel-import-evaluation';
import {EmployeeImportEvaluationBindingSchema,type EmployeeImportEvaluationBinding,type EmployeeImportEvaluationReceipt,type EmployeeImportEvaluationPublicResult} from '@/lib/personnel-import-evaluation';
import { parsePersonnelImportCsv } from '@/lib/personnel-import-contract';
import { personnelImportLabelResolvers } from '@/lib/personnel-import-labels.server';
import { IMPORT_COLUMNS, DEPENDENT_IMPORT_COLUMNS } from '@/lib/import-schema';
const parseEmployee=(text:string)=>parsePersonnelImportCsv(text,{columns:[...IMPORT_COLUMNS.required,...IMPORT_COLUMNS.optional],resolvers:personnelImportLabelResolvers});
const parseFamily=(text:string)=>parsePersonnelImportCsv(text,{columns:[...DEPENDENT_IMPORT_COLUMNS.required,...DEPENDENT_IMPORT_COLUMNS.optional],sheet:'family',resolvers:personnelImportLabelResolvers});
import {
  validateEmployeeImport,
  commitEmployeeImport,
  type ImportPreview,
  type ImportResult,
} from '@/core/import';

/** Item 2983802f — the Family sheet arrives as its own CSV text, decoded in the browser from the SAME
 *  workbook, and is parsed here by the SAME parser. Empty string (a CSV upload, a paste, or a workbook
 *  with no Family sheet) means no family rows, which is every file that imports today. */
function familyRecords(dependentsCsv?: string) {
  const text = (dependentsCsv ?? '').trim();
  return text === '' ? [] : parseFamily(text).records;
}

function registerRecords(texts:PersonnelRegisterTexts={}):PersonnelRegisterRecords {
  if(Object.keys(texts).some(key=>!(PERSONNEL_REGISTER_KINDS as readonly string[]).includes(key)))throw new Error('Unknown register sheet.');
  const result:PersonnelRegisterRecords={};
  for(const kind of PERSONNEL_REGISTER_KINDS) {
    const text=texts[kind]??'';
    result[kind]=text.trim()?parsePersonnelImportCsv(text,{columns:personnelRegisterColumns(kind),sheet:kind,resolvers:personnelImportLabelResolvers}).records:[];
  }
  return result;
}

/** 524303d9 — Import History keeps what was imported. A file upload posts its original bytes to
 *  ./employee/upload; these actions carry a paste or a prepared text, so that text is the recorded source. */
const pastedSource=(csv:string,fileName?:string)=>({name:fileName||'pasted-employees.csv',content:Buffer.from(csv,'utf8')});

/** Dry-run validation. Returns a per-row preview; writes nothing. */
export async function validateImportAction(
  csv: string,
  companyId: string,
  dependentsCsv?: string,
  registers?:PersonnelRegisterTexts,
  allocationsCsv?:string,
): Promise<ImportPreview> {
  const s = await requireAdmin();
  if(Buffer.byteLength([csv,dependentsCsv??'',allocationsCsv??'',...Object.values(registers??{})].join(''),'utf8')>900000)throw new Error('The import is too large. Split the workbook and check each part.');
  const { records, warnings } = parseEmployee(csv);
  const preview=await validateEmployeeImport(s, { companyId, records, dependentRecords: familyRecords(dependentsCsv),registerRecords:registerRecords(registers),allocationRecords:parseCostAllocationCsv(allocationsCsv??'') });
  for(const row of preview.rows) row.warnings.push(...warnings);
  const familyWarnings=(dependentsCsv??'').trim()?parseFamily(dependentsCsv!).warnings:[];
  for(const row of preview.rows) row.warnings.push(...familyWarnings.map(warning=>`Family: ${warning}`));
  return preview;
}

/** Commit the valid rows. Re-validates server-side, so a tampered client preview can't widen
 *  what gets written. `fileName` is a LABEL for the history row (cf43c909) — the file's contents
 *  always arrive as the same CSV text a paste would produce, so there is still exactly one write path,
 *  and the file itself is never uploaded or stored. */
export async function commitImportAction(
  csv: string,
  companyId: string,
  fileName?: string,
  dependentsCsv?: string,
  registers?:PersonnelRegisterTexts,
  allocationsCsv?:string,allocationToken?:string,evaluationBinding?:EmployeeImportEvaluationBinding,
): Promise<ImportResult & {evaluationReceipt?:EmployeeImportEvaluationReceipt}> {
  if(evaluationBinding!==undefined)return commitMeasuredEmployeeImport(csv,companyId,evaluationBinding,dependentsCsv,registers,allocationsCsv,allocationToken,fileName);
  const s = await requireAdmin();
  if(Buffer.byteLength([csv,dependentsCsv??'',allocationsCsv??'',...Object.values(registers??{})].join(''),'utf8')>900000)throw new Error('The import is too large. Split the workbook and check each part.');
  const { records } = parseEmployee(csv);
  const result = await commitEmployeeImport(s, {
    companyId,
    records,
    dependentRecords: familyRecords(dependentsCsv),
    registerRecords:registerRecords(registers),
    allocationRecords:parseCostAllocationCsv(allocationsCsv??''),allocationToken,
    fileName: fileName ?? '',
    source:pastedSource(csv,fileName),
  });
  revalidatePath('/admin/personnel');
  revalidatePath('/admin/personnel/import');
  return result;
}

/** Snapshot raw effect inputs before authentication awaits. They never enter evaluation metadata/provider. */
function measuredInputs(csv:string,companyId:string,dependentsCsv?:string,registers?:PersonnelRegisterTexts,allocationsCsv?:string){
 const captured=structuredClone({csv,companyId,dependentsCsv,registers,allocationsCsv});
 if(Buffer.byteLength([captured.csv,captured.dependentsCsv??'',captured.allocationsCsv??'',...Object.values(captured.registers??{})].join(''),'utf8')>900000)throw Error(EMPLOYEE_IMPORT_EVALUATION_UNAVAILABLE);
 return{companyId:captured.companyId,records:parseEmployee(captured.csv).records,dependentRecords:familyRecords(captured.dependentsCsv),registerRecords:registerRecords(captured.registers),allocationRecords:parseCostAllocationCsv(captured.allocationsCsv??'')};
}
/** Begins before cleaning: no rows, headers or parseable CSV are needed or accepted. */
export async function beginEmployeeImportEvaluationAction(metadata:unknown):Promise<EmployeeImportEvaluationPublicResult>{
 try{const captured=structuredClone(metadata),ctx=await getBrowserCommandSession();return{kind:'evaluation',receipt:await beginEmployeeImportEvaluation(ctx,captured)};}catch{return{kind:'unavailable',message:EMPLOYEE_IMPORT_EVALUATION_UNAVAILABLE};}
}
/** Bind the actual canonical effect input only after local cleaning/mapping and preview are ready. */
export async function prepareEmployeeImportEvaluationCommitAction(preparation:unknown,csv:string,companyId:string,dependentsCsv?:string,registers?:PersonnelRegisterTexts,allocationsCsv?:string):Promise<EmployeeImportEvaluationPublicResult>{
 try{const captured=structuredClone(preparation),inputs=measuredInputs(csv,companyId,dependentsCsv,registers,allocationsCsv),ctx=await getBrowserCommandSession();return{kind:'evaluation',receipt:await prepareEmployeeImportEvaluationCommit(ctx,captured,inputs)};}catch{return{kind:'unavailable',message:EMPLOYEE_IMPORT_EVALUATION_UNAVAILABLE};}
}
async function commitMeasuredEmployeeImport(csv:string,companyId:string,binding:EmployeeImportEvaluationBinding,dependentsCsv?:string,registers?:PersonnelRegisterTexts,allocationsCsv?:string,allocationToken?:string,fileName?:string){
 try{const inputs=measuredInputs(csv,companyId,dependentsCsv,registers,allocationsCsv),captured=EmployeeImportEvaluationBindingSchema.parse(structuredClone(binding)),ctx=await getBrowserCommandSession();
  const result=await commitEmployeeImport(ctx,{...inputs,allocationToken,fileName:fileName??'',evaluationBinding:captured});revalidatePath('/admin/personnel');revalidatePath('/admin/personnel/import');return result;
 }catch{throw Error(EMPLOYEE_IMPORT_EVALUATION_UNAVAILABLE);}
}
/** Recovery is metadata/event reconciliation only. It can NEVER re-import the original source. */
export async function reopenEmployeeImportEvaluationAction(binding:EmployeeImportEvaluationBinding,companyId:string):Promise<EmployeeImportEvaluationPublicResult>{
 try{const captured=EmployeeImportEvaluationBindingSchema.parse(structuredClone(binding)),company=companyId,ctx=await getBrowserCommandSession();return{kind:'evaluation',receipt:await reopenEmployeeImportEvaluation(ctx,captured,company)};}catch{return{kind:'unavailable',message:EMPLOYEE_IMPORT_EVALUATION_UNAVAILABLE};}
}
export async function recordEmployeeImportEvaluationTelemetryAction(binding:EmployeeImportEvaluationBinding,companyId:string,value:unknown):Promise<EmployeeImportEvaluationPublicResult>{
 try{const captured=EmployeeImportEvaluationBindingSchema.parse(structuredClone(binding)),company=companyId,event=structuredClone(value),ctx=await getBrowserCommandSession();return{kind:'evaluation',receipt:await recordEmployeeImportEvaluationTelemetry(ctx,captured,company,event)};}catch{return{kind:'unavailable',message:EMPLOYEE_IMPORT_EVALUATION_UNAVAILABLE};}
}

/** Explicit reuse association; previous job's model charge is never assigned a second time. */
export async function associateReusedEmployeeImportHeaderAction(value:unknown,companyId:string):Promise<EmployeeImportEvaluationPublicResult>{
 try{const captured=structuredClone(value),company=companyId,ctx=await getBrowserCommandSession();return{kind:'evaluation',receipt:await associateReusedEmployeeImportHeader(ctx,captured,company)};}catch{return{kind:'unavailable',message:EMPLOYEE_IMPORT_EVALUATION_UNAVAILABLE};}
}
/** Identity-only own-history erasure remains available after Workforce/module/Assistant revocation. */
export async function eraseOwnImportEvaluationMetadataAction():Promise<void>{
 try{await eraseOwnImportEvaluationMetadata(await getBrowserCommandSession());revalidatePath('/assistant');revalidatePath('/admin/personnel/import');}catch{throw Error(EMPLOYEE_IMPORT_EVALUATION_UNAVAILABLE);}
}
