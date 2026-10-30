/** Movement import transports New Event inputs; it never owns employment facts. */
import {parseCsv} from './csv';
import {isCalendarDate} from './calendar-date';
import {normalizeEmployeeCode,isValidEmployeeCode} from './employee-code';
import {MOVEMENT_FORM_IDS,movementFormFields,movementFormRequired,type MovementFormField} from './movement-form-contract';
import {personnelScalarIssue} from './personnel-import-contract';
import {personnelFormField} from './personnel-form-contract';
export const MOVEMENT_IMPORT_LIMITS={bytes:900000,rows:200,perEmployee:20,employees:50,statementMs:5000,lockMs:1000,employeeMs:15000,requestMs:45000,historyRows:10000,referenceRows:10000} as const;
export const MOVEMENT_IMPORT_FIELDS=Object.keys(MOVEMENT_FORM_IDS).filter((key):key is MovementFormField=>key!=='reason');
export const MOVEMENT_IMPORT_COLUMNS=['employee_code',...MOVEMENT_IMPORT_FIELDS.map(field=>field==='kind'?'event_type':field.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()))];
export const MOVEMENT_IMPORT_HEADERS=['Employee ID',...MOVEMENT_IMPORT_FIELDS.map(field=>field==='kind'?'EventType':field==='effectiveDate'?'EffectiveDate':field.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,c=>c.toUpperCase()))];
/** ac6645ec — `companyCode` (Company ID cell) is resolved per record by the server into `companyId`; `before`
 * holds the Before cells by System Field key; `sourceRows` lists every sheet row of one grouped movement. */
/** 646355e5 slice C — `action` (blank = create) and `movementId`/`reason` come from the version 4 columns; an
 * Update or Delete names ONE existing movement, resolved only within the row's tenant, company and employee. */
export type MovementImportAction='create'|'update'|'delete';
export type MovementImportRecord={row:number;employeeCode:string;cells:Partial<Record<MovementFormField,string>>;errors:string[];incrementAmount?:string;importVersion?:2;source?:{sheet:string;row:number};companyCode?:string;companyId?:string;employeeName?:string;before?:Record<string,string>;sourceRows?:number[];action?:MovementImportAction;movementId?:string;reason?:string};
export type MovementImportRow={row:number;employeeCode:string;eventType:string;effectiveDate:string;status:'valid'|'invalid'|'excluded'|'imported'|'failed';errors:string[];warnings?:string[];source?:{sheet:string;row:number};sourceRows?:number[];companyCode?:string;baselineDate?:string;before?:Record<string,string|null>;proposed?:Record<string,string|null>;scheduled?:boolean;payrollFlaggedPeriods?:string[];action?:MovementImportAction;movementId?:string;closedPayrollPeriods?:string[]};
/** `key` identifies one employee of one company in a multi-company file (selection and fingerprints). */
export type MovementImportEmployee={employeeCode:string;employmentId:string|null;name:string|null;rows:MovementImportRow[];fingerprint:string|null;key?:string;companyId?:string|null;companyName?:string|null};
export type MovementImportPreview={inputHash:string;selection:number[];fileErrors:string[];employees:MovementImportEmployee[];excluded:number;valid:number};
export type MovementImportResult={employees:MovementImportEmployee[];imported:number;failed:number;excluded:number;byEventType:{eventType:string;imported:number;failed:number;excluded:number}[];batchId?:string;attemptId?:string};
export const movementEmployeeKey=(employee:Pick<MovementImportEmployee,'employeeCode'|'key'>)=>employee.key??employee.employeeCode;
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
 if(grid.length===1)errors.push('no_data_rows');
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
/** A partial import omits retained facts, unlike the manual form's full right column.
 * Department must remain valid in the canonical writer, but a blank transport cell never clears it.
 * Entity Transfer still needs an explicit destination; lifecycle requirements keep their form owner.
 */
export function movementImportRequired(field:MovementFormField,behaviour:string):boolean{
 if(field==='departmentId')return false;
 if(field==='kind')return true;
 if(field==='companyId'&&behaviour==='entityTransfer')return true;
 return movementFormRequired(field,behaviour);
}
/** Import scaffolding is not an instruction to accept the manual blacklist default.
 * An explicit status (including false), or remarks with the canonical default, records intent.
 * Kind, generated date and grey snapshots alone never supply that intent. */
export function movementImportHasBlacklistInput(cells:MovementImportRecord['cells']):boolean{
 return !!(cells.blacklisted?.trim()||cells.remarks?.trim());
}
export function movementImportCellIssues(record:MovementImportRecord,behaviour:string):string[]{
 const issues=[...record.errors];const visible=new Set(movementFormFields(behaviour,record.cells.terminationReasonCode));
 if(behaviour==='blacklist'&&record.action!=='update'&&!movementImportHasBlacklistInput(record.cells)&&!issues.includes('blacklist_input_required'))issues.push('blacklist_input_required');
 for(const field of MOVEMENT_IMPORT_FIELDS){
  const value=record.cells[field];
  // Every row carries a date. Blacklist is a current-day flag; the server verifies its date explicitly.
  if(field==='effectiveDate'&&behaviour==='blacklist')continue;
  if(value&&!visible.has(field)){issues.push(`not_applicable:${field}`);continue;}
  if(!visible.has(field))continue;
  // An Update keeps every value it leaves blank (646355e5 slice C), so nothing is required of it here.
  if(!value&&record.action!=='update'&&movementImportRequired(field,behaviour))issues.push(`required:${field}`);
  if(!value)continue;
  if(['effectiveDate','endDate','resignationDate','tenderResignationDate','resignationEffectiveDate'].includes(field)){if(!movementImportDate(value))issues.push(`invalid_date:${field}`);}
  else if(!['kind','companyId','businessUnitId','departmentId','positionId','gradeId','locationId','managerEmploymentId'].includes(field)){
   const issue=personnelScalarIssue(personnelFormField(MOVEMENT_FORM_IDS[field]),value);if(issue)issues.push(`invalid_${issue}:${field}`);
  }
 }
 return issues;
}
/** Preserve server-observed rejection explanations while rechecking a narrower selected sequence.
 * Display-only: neither this history nor these error strings are accepted by the write owner. */
export function retainMovementExclusionReasons(employees:MovementImportEmployee[],previous:MovementImportEmployee[]):MovementImportEmployee[]{
 const prior=new Map(previous.flatMap(employee=>employee.rows.map(row=>[row.row,row] as const)));
 return employees.map(employee=>{
  // The write owner intentionally does not resolve an entirely unselected employee again.
  // Retain only its already-visible preview name, never its employment ID or fingerprint.
  // A fresh server refusal, changed sequence or unresolved preview must not revive identity.
  const candidates=previous.filter(old=>old.employeeCode===employee.employeeCode);
  const oldEmployee=candidates.length===1?candidates[0]:undefined;
  const sameRow=(row:MovementImportRow,old:MovementImportRow)=>row.row===old.row&&row.employeeCode===employee.employeeCode&&row.employeeCode===old.employeeCode&&row.eventType===old.eventType&&row.effectiveDate===old.effectiveDate&&row.source?.sheet===old.source?.sheet&&row.source?.row===old.source?.row;
  const retainName=employee.name===null&&employee.employmentId===null&&employee.fingerprint===null&&employee.rows.length>0&&
   employee.rows.every(row=>row.status==='excluded'&&row.errors.length===0)&&oldEmployee?.employmentId&&oldEmployee.name&&
   oldEmployee.rows.length===employee.rows.length&&employee.rows.every(row=>oldEmployee.rows.filter(old=>sameRow(row,old)).length===1);
  return {...employee,name:retainName?oldEmployee?.name??employee.name:employee.name,rows:employee.rows.map(row=>{
   const old=prior.get(row.row);
   return row.status==='excluded'&&!row.errors.length&&old?.employeeCode===row.employeeCode&&old.eventType===row.eventType&&old.errors.length?{...row,errors:[...old.errors]}:row;
  })};
 });
}
