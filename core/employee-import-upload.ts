/**
 * 524303d9 — "Everything — new employees" upload with Import History (ADR-0155 kind `employee_full`).
 *
 * The browser still decodes the workbook and previews it exactly as before; on Import it posts the ORIGINAL
 * file bytes together with the sheets as CSV text (the same text the preview validated). The rows are parsed
 * here with the same parsers as the server action and committed by `commitEmployeeImport`, which records the
 * file, its sha256, the per-row outcome and every created employment as an item of the attempt.
 */
import type {SessionContext} from '../db/client';
import {parseCostAllocationCsv} from '../lib/cost-allocation-import';
import {PERSONNEL_REGISTER_KINDS,personnelRegisterColumns,type PersonnelRegisterRecords,type PersonnelRegisterTexts} from '../lib/personnel-register-import';
import {parsePersonnelImportCsv} from '../lib/personnel-import-contract';
import {personnelImportLabelResolvers} from '../lib/personnel-import-labels.server';
import {DEPENDENT_IMPORT_COLUMNS,IMPORT_COLUMNS} from '../lib/import-schema';
import {commitEmployeeImport} from './import';
import {ImportHistoryError,IMPORT_SOURCE_MAX_BYTES} from './import-history';

/** The sheets' text, as the server action bounds it. */
export const EMPLOYEE_IMPORT_TEXT_MAX_BYTES=900000;
export type EmployeeImportUploadInput={companyId:string;csv:string;fileName?:string;dependentsCsv?:string;registers?:PersonnelRegisterTexts;allocationsCsv?:string;allocationToken?:string};

const text=(value:unknown)=>typeof value==='string'?value:'';
/** Validates the posted JSON part; anything malformed is refused before parsing a row. */
export function employeeImportUploadInput(raw:unknown):EmployeeImportUploadInput{
 const o=(raw&&typeof raw==='object'?raw:{}) as Record<string,unknown>;
 const registersRaw=(o.registers&&typeof o.registers==='object'?o.registers:{}) as Record<string,unknown>;
 if(Object.keys(registersRaw).some(key=>!(PERSONNEL_REGISTER_KINDS as readonly string[]).includes(key)))throw new ImportHistoryError('Unknown register sheet.');
 const input={companyId:text(o.companyId),csv:text(o.csv),fileName:text(o.fileName),dependentsCsv:text(o.dependentsCsv),allocationsCsv:text(o.allocationsCsv),allocationToken:text(o.allocationToken)||undefined,
  registers:Object.fromEntries(PERSONNEL_REGISTER_KINDS.map(kind=>[kind,text(registersRaw[kind])])) as PersonnelRegisterTexts};
 if(!/^[0-9a-f-]{36}$/i.test(input.companyId))throw new ImportHistoryError('Choose a company before importing.');
 if(Buffer.byteLength([input.csv,input.dependentsCsv,input.allocationsCsv,...Object.values(input.registers)].join(''),'utf8')>EMPLOYEE_IMPORT_TEXT_MAX_BYTES)throw new ImportHistoryError('The import is too large. Split the workbook and check each part.');
 return input;
}

export async function commitEmployeeImportUpload(ctx:SessionContext,input:EmployeeImportUploadInput,source:{name:string;content:Buffer;operationKey?:string}){
 if(source.content.length>IMPORT_SOURCE_MAX_BYTES)throw new ImportHistoryError('Choose a file no larger than 10 MB.');
 const records=parsePersonnelImportCsv(input.csv,{columns:[...IMPORT_COLUMNS.required,...IMPORT_COLUMNS.optional],resolvers:personnelImportLabelResolvers}).records;
 const family=(input.dependentsCsv??'').trim()?parsePersonnelImportCsv(input.dependentsCsv!,{columns:[...DEPENDENT_IMPORT_COLUMNS.required,...DEPENDENT_IMPORT_COLUMNS.optional],sheet:'family',resolvers:personnelImportLabelResolvers}).records:[];
 const registers:PersonnelRegisterRecords={};
 for(const kind of PERSONNEL_REGISTER_KINDS){const t=input.registers?.[kind]??'';registers[kind]=t.trim()?parsePersonnelImportCsv(t,{columns:personnelRegisterColumns(kind),sheet:kind,resolvers:personnelImportLabelResolvers}).records:[];}
 return commitEmployeeImport(ctx,{companyId:input.companyId,records,dependentRecords:family,registerRecords:registers,allocationRecords:parseCostAllocationCsv(input.allocationsCsv??''),allocationToken:input.allocationToken,fileName:input.fileName??source.name,source});
}
