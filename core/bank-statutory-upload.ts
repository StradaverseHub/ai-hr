/**
 * 0db97f14 — Bank & Statutory upload with Import History (ADR-0152 kind `bank_statutory`).
 *
 * The browser previews the file exactly as before (section dry run). On Import, the ORIGINAL bytes are
 * sent here: they are read with the same reader and heading grammar, re-validated, recorded as an import
 * attempt (file, sha256, companies, the dry run's per-row outcome), and then saved by the section
 * importer one employee per transaction, each transaction also writing that employee's field-level
 * before/after. Rows of companies the actor cannot maintain are refused in the attempt's plan.
 * `employee_import_run` keeps being written by the section importer so the existing run list is unchanged.
 */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {readImportFile} from '../lib/import-file';
import {parsePersonnelImportCsv} from '../lib/personnel-import-contract';
import {personnelImportLabelResolvers} from '../lib/personnel-import-labels.server';
import {sectionParseColumns,type SectionImportResult} from '../lib/import-sections';
import type {ImportPlanBase} from '../lib/import-history';
import {analyzeSectionRows,commitSectionImport} from './import-sections';
import {BankStatutoryImportError} from './bank-statutory-import';
import {createImportAttemptTx,recordImportFailure,sealImportPlan,ImportHistoryError,IMPORT_SOURCE_MAX_BYTES} from './import-history';

export type BankStatutoryImportPlan=ImportPlanBase&{kind:'bank_statutory';rows:{rowNum:number;employeeCode:string;employeeName:string;verdict:string;errors:string[];changes:string[]}[]};
export type BankStatutoryUploadResult=SectionImportResult&{attemptId:string};
const FILE_MESSAGE='This file could not be read. Download the Bank & Statutory template and try again.';

/** Reads the original bytes exactly as the browser preview did (same reader, same heading grammar). */
export async function readBankStatutorySource(name:string,content:Buffer){
 if(content.length>IMPORT_SOURCE_MAX_BYTES)throw new BankStatutoryImportError('Choose a file no larger than 10 MB.');
 let text:string;
 try{text=(await readImportFile(new File([new Uint8Array(content)],name),{allowedSheets:['Reference','Instructions','__PersonnelLists']})).text;}
 catch{throw new BankStatutoryImportError(FILE_MESSAGE);}
 try{return parsePersonnelImportCsv(text,{columns:sectionParseColumns('bank_statutory'),sheet:'employee',resolvers:personnelImportLabelResolvers});}
 catch(error){throw new BankStatutoryImportError(error instanceof Error&&error.name==='PersonnelImportHeaderError'?error.message:FILE_MESSAGE);}
}

export async function commitBankStatutoryUpload(ctx:SessionContext,input:{name:string;content:Buffer;operationKey?:string}):Promise<BankStatutoryUploadResult>{
 let records:Record<string,string>[]=[],parseError:string|null=null;
 try{records=(await readBankStatutorySource(input.name,input.content)).records;}
 catch(error){parseError=error instanceof BankStatutoryImportError?error.message:FILE_MESSAGE;}
 if(!parseError&&!records.length)parseError='The file has no employee rows.';
 const analysis=parseError?{fileErrors:[parseError],rows:[]}:await analyzeSectionRows(ctx,'bank_statutory',records);
 const created=await withTenant(ctx,async tx=>{
  const candidates=[...new Set(analysis.rows.map(r=>r.companyId).filter((c):c is string=>!!c))];
  const maintainable=new Set<string>();
  for(const c of candidates){const[row]=await tx.execute<{ok:boolean}>(sql`select app.import_company_access('bank_statutory',${c}::uuid,'maintain') as ok`);if(row?.ok)maintainable.add(c);}
  const issues=[
   ...analysis.fileErrors.map(reason=>({rowNum:0,reason})),
   ...analysis.rows.filter(r=>r.companyId&&!maintainable.has(r.companyId)).map(r=>({rowNum:r.rowNum,reason:`Row ${r.rowNum} (${r.employeeCode}): you do not have permission to update employees of this company.`})),
   ...analysis.rows.filter(r=>!r.companyId&&r.errors.length).map(r=>({rowNum:r.rowNum,reason:`Row ${r.rowNum} (${r.employeeCode||'no Employee ID'}): ${r.errors.join('; ')}`})),
  ];
  const rows=analysis.rows.map(r=>({rowNum:r.rowNum,employeeCode:r.employeeCode,employeeName:r.employeeName,verdict:r.verdict,errors:r.errors,changes:r.changes}));
  const valid=analysis.rows.filter(r=>r.ok&&r.companyId&&maintainable.has(r.companyId)).length;
  const plan=sealImportPlan<BankStatutoryImportPlan>({version:1,kind:'bank_statutory',rows,counts:{total:rows.length,valid,invalid:analysis.rows.filter(r=>r.errors.length).length},issues,previewHash:''});
  return createImportAttemptTx(tx,ctx,{kind:'bank_statutory',sourceName:input.name,content:input.content,companyIds:[...maintainable],plan,operationKey:input.operationKey});
 });
 if(created.existing)throw new ImportHistoryError('This upload was already received. Open Import History to see its outcome.');
 if(analysis.fileErrors.length){
  await recordImportFailure(ctx,created.attemptId,'bank_statutory','failed',new ImportHistoryError(analysis.fileErrors.join(' ')));
  return{section:'bank_statutory',updated:0,skipped:analysis.rows.length,failed:[],fileErrors:analysis.fileErrors,runId:null,attemptId:created.attemptId};
 }
 // Rows of companies outside the attempt are refused by the section importer's own workforce check.
 try{
  const result=await commitSectionImport(ctx,{section:'bank_statutory',records,fileName:input.name,history:{attemptId:created.attemptId}});
  return{...result,attemptId:created.attemptId};
 }catch(error){await recordImportFailure(ctx,created.attemptId,'bank_statutory','failed',error);throw error;}
}
