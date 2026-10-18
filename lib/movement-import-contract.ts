/** Movement import transports New Event inputs; it never owns employment facts. */
import {parseCsv} from './csv';
import {isCalendarDate} from './calendar-date';
import {normalizeEmployeeCode,isValidEmployeeCode} from './employee-code';
import {MOVEMENT_FORM_IDS,movementFormFields,movementFormRequired,type MovementFormField} from './movement-form-contract';
import {personnelScalarIssue} from './personnel-import-contract';
import {personnelFormField} from './personnel-form-contract';
export const MOVEMENT_IMPORT_LIMITS={bytes:900000,rows:200,perEmployee:20,employees:50,statementMs:5000,lockMs:1000,employeeMs:15000,requestMs:45000} as const;
export const MOVEMENT_IMPORT_FIELDS=Object.keys(MOVEMENT_FORM_IDS).filter((key):key is MovementFormField=>key!=='reason');
export const MOVEMENT_IMPORT_COLUMNS=['employee_code',...MOVEMENT_IMPORT_FIELDS.map(field=>field==='kind'?'event_type':field.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()))];
export const MOVEMENT_IMPORT_HEADERS=['Employee ID',...MOVEMENT_IMPORT_FIELDS.map(field=>field==='kind'?'EventType':field==='effectiveDate'?'EffectiveDate':field.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,c=>c.toUpperCase()))];
export type MovementImportRecord={row:number;employeeCode:string;cells:Partial<Record<MovementFormField,string>>;errors:string[]};
export type MovementImportRow={row:number;employeeCode:string;eventType:string;effectiveDate:string;status:'valid'|'invalid'|'excluded'|'imported'|'failed';errors:string[];before?:Record<string,string|null>;proposed?:Record<string,string|null>;scheduled?:boolean;payrollFlaggedPeriods?:string[]};
export type MovementImportEmployee={employeeCode:string;employmentId:string|null;name:string|null;rows:MovementImportRow[];fingerprint:string|null};
export type MovementImportPreview={inputHash:string;selection:number[];fileErrors:string[];employees:MovementImportEmployee[];excluded:number;valid:number};
export type MovementImportResult={employees:MovementImportEmployee[];imported:number;failed:number;excluded:number;byEventType:{eventType:string;imported:number;failed:number;excluded:number}[]};
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function movementImportDate(raw:string):string|null{
 if(isCalendarDate(raw))return raw;
 const match=/^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(raw);if(!match)return null;
 const month=MONTHS.findIndex(value=>value.toLowerCase()===match[2].toLowerCase());
 const iso=`${match[3]}-${String(month+1).padStart(2,'0')}-${match[1]}`;
 return month>=0&&isCalendarDate(iso)?iso:null;
}
export function movementTemplateDate(iso:string):string{return isCalendarDate(iso)?`${iso.slice(8)}-${MONTHS[Number(iso.slice(5,7))-1]}-${iso.slice(0,4)}`:iso;}
/** Closed headers refuse unknown/retired fields rather than silently dropping an intended update. */
export function parseMovementImport(text:string):{records:MovementImportRecord[];fileErrors:string[]}{
 if(new TextEncoder().encode(text).length>MOVEMENT_IMPORT_LIMITS.bytes)return {records:[],fileErrors:['file_too_large']};
 const source=text.replace(/^\uFEFF/,'');
 let quoted=false,closed=false,fieldStart=true;
 for(let index=0;index<source.length;index++){const char=source[index];
  if(quoted){if(char==='\"'){if(source[index+1]==='\"')index++;else {quoted=false;closed=true;}}continue;}
  if(char===','||char==='\r'||char==='\n'){closed=false;fieldStart=true;continue;}
  if(char==='\"'){if(!fieldStart)return {records:[],fileErrors:['malformed_csv']};quoted=true;fieldStart=false;continue;}
  if(closed)return {records:[],fileErrors:['malformed_csv']};fieldStart=false;
 }
 if(quoted)return {records:[],fileErrors:['malformed_csv']};
 const grid=parseCsv(source);if(!grid.length)return {records:[],fileErrors:['empty_file']};
 const normalize=(value:string)=>value.trim().toLowerCase().replace(/[\s_]+/g,'');
 const aliases=new Map<string,string>();MOVEMENT_IMPORT_COLUMNS.forEach((column,index)=>{aliases.set(normalize(column),column);aliases.set(normalize(MOVEMENT_IMPORT_HEADERS[index]),column);});
 const headers=grid[0].map(value=>aliases.get(normalize(value))??value.trim());const errors:string[]=[];
 if(new Set(headers).size!==headers.length)errors.push('duplicate_headers');
 for(const header of headers)if(!MOVEMENT_IMPORT_COLUMNS.includes(header))errors.push(`unknown_column:${header}`);
 for(const header of ['employee_code','event_type','effective_date'])if(!headers.includes(header))errors.push(`missing_column:${header}`);
 if(grid.length-1>MOVEMENT_IMPORT_LIMITS.rows)errors.push('too_many_rows');
 if(errors.length)return {records:[],fileErrors:errors};
 const records=grid.slice(1).map((values,index)=>{
  const raw=Object.fromEntries(headers.map((header,column)=>[header,(values[column]??'').trim()]));const cells:MovementImportRecord['cells']={};
  MOVEMENT_IMPORT_FIELDS.forEach((field,column)=>{const value=raw[MOVEMENT_IMPORT_COLUMNS[column+1]];if(value)cells[field]=value;});
  const employeeCode=normalizeEmployeeCode(raw.employee_code);const rowErrors:string[]=[];
  if(values.length>headers.length)rowErrors.push('extra_cells');
  if(!isValidEmployeeCode(employeeCode))rowErrors.push('invalid_employee_code');
  if(!cells.kind)rowErrors.push('event_type_required');
  if(!cells.effectiveDate||!movementImportDate(cells.effectiveDate))rowErrors.push('invalid_effective_date');
  return {row:index+2,employeeCode,cells,errors:rowErrors};
 });
 const counts=new Map<string,number>();for(const row of records)counts.set(row.employeeCode,(counts.get(row.employeeCode)??0)+1);
 if(counts.size>MOVEMENT_IMPORT_LIMITS.employees)errors.push('too_many_employees');
 for(const record of records)if(counts.get(record.employeeCode)!>MOVEMENT_IMPORT_LIMITS.perEmployee)record.errors.push('too_many_employee_rows');
 return {records,fileErrors:errors};
}
export function movementImportCellIssues(record:MovementImportRecord,behaviour:string):string[]{
 const issues=[...record.errors];const visible=new Set(movementFormFields(behaviour,record.cells.terminationReasonCode));
 for(const field of MOVEMENT_IMPORT_FIELDS){
  const value=record.cells[field];
  // Every row carries a date. Blacklist is a current-day flag; the server verifies its date explicitly.
  if(field==='effectiveDate'&&behaviour==='blacklist')continue;
  if(value&&!visible.has(field)){issues.push(`not_applicable:${field}`);continue;}
  if(!visible.has(field))continue;
  if(!value&&movementFormRequired(field,behaviour))issues.push(`required:${field}`);
  if(!value)continue;
  if(['effectiveDate','endDate','resignationDate'].includes(field)){if(!movementImportDate(value))issues.push(`invalid_date:${field}`);}
  else if(!['kind','companyId','businessUnitId','departmentId','positionId','gradeId','locationId','managerEmploymentId'].includes(field)){
   const issue=personnelScalarIssue(personnelFormField(MOVEMENT_FORM_IDS[field]),value);if(issue)issues.push(`invalid_${issue}:${field}`);
  }
 }
 return issues;
}
