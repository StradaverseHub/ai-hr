import {personnelImportFields, personnelScalarIssue} from './personnel-import-contract';
import {normalizeEmployeeCode, isValidEmployeeCode} from './employee-code';
import type {ImportRecord} from './import-schema';

export const PERSONNEL_REGISTER_KINDS=['qualification','emergency'] as const;
export type PersonnelRegisterKind=typeof PERSONNEL_REGISTER_KINDS[number];
export const PERSONNEL_REGISTER_SHEETS={qualification:'Qualifications',emergency:'Emergency Contacts'} as const;
export const MAX_PERSONNEL_REGISTER_ROWS=500;
export type PersonnelRegisterRecords=Partial<Record<PersonnelRegisterKind,ImportRecord[]>>;
export type PersonnelRegisterTexts=Partial<Record<PersonnelRegisterKind,string>>;
export type RegisterRowPreview={rowNum:number;employeeCode:string;employeeName:string;recordId:string;action:'create'|'update';ok:boolean;errors:string[];proposed:{column:string;value:string}[]};
export type RegisterPreview={kind:PersonnelRegisterKind;total:number;validCount:number;rows:RegisterRowPreview[];fileErrors:string[]};
export function isPersonnelRegisterKind(value:string):value is PersonnelRegisterKind {
  return (PERSONNEL_REGISTER_KINDS as readonly string[]).includes(value);
}
export function personnelRegisterColumns(kind:PersonnelRegisterKind) {
  return ['employee_code','record_id',...personnelImportFields(kind).map(field=>field.import.column!)];
}
/** Column presence survives parsing; only supplied nonblank values reach patch owners. */
export function personnelRegisterInput(kind:PersonnelRegisterKind,record:ImportRecord) {
  const errors:string[]=[];
  const input:Record<string,string|boolean>={};
  const columns=new Set(personnelRegisterColumns(kind));
  for(const column of Object.keys(record))if(!columns.has(column))errors.push(`Column ${column} does not belong to this register.`);
  const employeeCode=normalizeEmployeeCode(record.employee_code);
  if(!isValidEmployeeCode(employeeCode))errors.push('Employee ID is required and must use the saved employee code.');
  const recordId=(record.record_id??'').trim().toLowerCase();
  if(recordId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(recordId))errors.push('Record ID must be an existing canonical record ID, or blank to create.');
  for(const field of personnelImportFields(kind)) {
    let value=(record[field.import.column!]??'').trim();if(!value)continue;
    if(field.type==='boolean') {
      const norm=value.toLowerCase();
      if(['true','yes'].includes(norm))value='true';else if(['false','no'].includes(norm))value='false';
    }
    const issue=personnelScalarIssue(field,value);
    if(issue)errors.push(`${field.label}: invalid ${issue}.`);
    input[field.import.writerField!]=field.type==='boolean'?value==='true':value;
  }
  return {employeeCode,recordId,input,errors};
}
