/**
 * ac6645ec — the single Movements sheet (ADR-0156). One row per field change: rows with the same Company ID,
 * Employee ID, Effective Date and Event Type form ONE movement. System Fields map onto the existing
 * per-behaviour New Event inputs (the same layout the per-type workbook used), After is the value to record
 * and Before is the value the preparer saw, checked against the record at preview. Company ID is resolved
 * per row by the server; this module only groups and maps.
 */
import {normalizeEmployeeCode,isValidEmployeeCode} from './employee-code';
import {movementImportDate,MOVEMENT_IMPORT_LIMITS,type MovementImportRecord} from './movement-import-contract';
import {movementWorkbookLayout,movementWorkbookScalarChoices,type MovementWorkbookType} from './movement-workbook-layout';
import {movementRecordLimits} from './movement-type-csv';
import {personnelImportOptionLookup} from './personnel-import-lookup';
import type {PersonnelLabelResolver} from './personnel-import-contract';
export const MOVEMENT_SHEET='Movements';
export const MOVEMENT_COLUMNS=['companyId','employeeId','employeeName','effectiveDate','eventType','systemField','before','after'] as const;
export type MovementColumn=typeof MOVEMENT_COLUMNS[number];
const CAPTIONS:Record<MovementColumn,string>={companyId:'Company ID',employeeId:'Employee ID',employeeName:'Employee Name',effectiveDate:'Effective Date',eventType:'Event Type',systemField:'System Fields',before:'Before',after:'After'};
export const movementColumnCaption=(column:MovementColumn,resolve:PersonnelLabelResolver)=>resolve('people.import.movement.sheet.col.'+column,CAPTIONS[column]);
export const movementColumnCaptions=(resolve:PersonnelLabelResolver)=>MOVEMENT_COLUMNS.map(column=>movementColumnCaption(column,resolve));
/** One sheet row in column order; `row` is the spreadsheet row number shown to the user. */
export type MovementSheetRow={row:number;values:string[]};
export type MovementSystemField={key:string;label:string};
/** The System Fields an event type may change: the per-behaviour inputs, except the row's own date. */
export function movementSystemFields(type:MovementWorkbookType,resolve:PersonnelLabelResolver):MovementSystemField[]{
 return movementWorkbookLayout(type,resolve).filter(column=>column.role==='input'&&column.key!=='effectiveDate').map(column=>({key:column.key,label:column.label}));
}
/** Display value for an event type in the drop-down: its label, or its code where labels repeat. */
export function movementTypeDisplay(types:MovementWorkbookType[],type:MovementWorkbookType,resolve:PersonnelLabelResolver){
 const label=type.label??resolve('people.detail.movement.eventType.'+type.behaviour,type.code);
 return types.filter(other=>(other.label??resolve('people.detail.movement.eventType.'+other.behaviour,other.code)).trim().toLowerCase()===label.trim().toLowerCase()).length>1?type.code:label;
}
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const key=(value:string)=>value.trim().toLowerCase();
/** Header row check. Captions in any shipped language are accepted; the per-type layouts are refused. */
export function movementHeaderIssue(header:string[],resolvers:PersonnelLabelResolver[]):string|null{
 const cells=header.map(value=>key(value??''));while(cells.length&&!cells[cells.length-1])cells.pop();
 const matches=MOVEMENT_COLUMNS.every((column,index)=>resolvers.some(resolve=>key(movementColumnCaption(column,resolve))===cells[index]));
 if(matches&&cells.length===MOVEMENT_COLUMNS.length)return null;
 // The retired per-type layouts started with Employee ID and had no Company ID / System Fields columns.
 if(['employee id','employee_code','employeecode'].includes(cells[0]??'')||!cells.some(cell=>resolvers.some(resolve=>key(movementColumnCaption('systemField',resolve))===cell)))return 'workbook_old_layout';
 return 'workbook_columns_changed';
}
/** Group sheet rows into one record per movement. File-level limits use the existing record bounds. */
export function movementRowsToRecords(rows:MovementSheetRow[],types:MovementWorkbookType[],resolvers:PersonnelLabelResolver[]):{records:MovementImportRecord[];fileErrors:string[]}{
 const entered=rows.filter(row=>row.values.some(value=>(value??'').trim()));
 if(!entered.length)return{records:[],fileErrors:['no_data_rows']};
 if(entered.length>MOVEMENT_IMPORT_LIMITS.rows)return{records:[],fileErrors:['too_many_rows']};
 const typeLookup=personnelImportOptionLookup(types.map(type=>({value:type.code,label:type.label??type.code,aliases:resolvers.map(resolve=>resolve('people.detail.movement.eventType.'+type.behaviour,type.code))})));
 const records=new Map<string,MovementImportRecord>();
 for(const sheetRow of entered){
  const [companyCode,employeeRaw,employeeName,dateRaw,typeRaw,fieldRaw,beforeRaw,afterRaw]=MOVEMENT_COLUMNS.map((_,index)=>(sheetRow.values[index]??'').trim());
  const employeeCode=normalizeEmployeeCode(employeeRaw),date=movementImportDate(dateRaw)??dateRaw;
  const typeCode=typeRaw&&!typeLookup.isAmbiguous(typeRaw)?typeLookup.get(typeRaw):undefined,type=types.find(t=>t.code===typeCode);
  const groupKey=[companyCode.toUpperCase(),employeeCode,date,typeCode??key(typeRaw)].join('|');
  let record=records.get(groupKey);
  if(!record){
   record={row:sheetRow.row,employeeCode,companyCode,employeeName:employeeName||undefined,cells:{kind:typeCode??typeRaw,...(dateRaw?{effectiveDate:dateRaw}:{})},errors:[],importVersion:2,source:{sheet:MOVEMENT_SHEET,row:sheetRow.row},sourceRows:[],before:{}};
   if(!companyCode)record.errors.push('company_required');
   if(!isValidEmployeeCode(employeeCode))record.errors.push('invalid_employee_code');
   if(!typeRaw)record.errors.push('event_type_required');else if(!type)record.errors.push(typeLookup.isAmbiguous(typeRaw)?'ambiguous_reference:event_type':'unknown_or_inactive_event_type');
   if(type?.behaviour!=='blacklist'&&!movementImportDate(dateRaw))record.errors.push('invalid_effective_date');
   records.set(groupKey,record);
  }
  record.sourceRows!.push(sheetRow.row);
  const values=[companyCode,employeeRaw,employeeName,dateRaw,typeRaw,fieldRaw,beforeRaw,afterRaw];
  if(values.some(value=>/^[=+@]/.test(value)))record.errors.push('formula_input');
  if(values.some(value=>UUID.test(value)))record.errors.push('internal_reference_not_allowed');
  if(!fieldRaw){if(beforeRaw||afterRaw)record.errors.push('system_field_required');continue;}
  if(!type)continue;
  const fields=resolvers.flatMap(resolve=>movementSystemFields(type,resolve));
  const field=fields.find(f=>key(f.key)===key(fieldRaw)||key(f.label)===key(fieldRaw));
  if(!field){record.errors.push('unknown_system_field:'+fieldRaw.slice(0,100));continue;}
  if(record.before![field.key]!==undefined||field.key==='incrementAmount'&&record.incrementAmount!==undefined||field.key!=='incrementAmount'&&record.cells[field.key as keyof MovementImportRecord['cells']]!==undefined){record.errors.push('duplicate_system_field:'+field.key);continue;}
  if(!afterRaw)record.errors.push('required:'+field.key);
  if(beforeRaw)record.before![field.key]=beforeRaw;
  if(!afterRaw)continue;
  if(field.key==='incrementAmount'){record.incrementAmount=afterRaw;continue;}
  const formField=field.key as keyof MovementImportRecord['cells'];
  const choices=movementWorkbookScalarChoices(formField);
  const matched=choices.filter(choice=>key(afterRaw)===key(choice.value)||resolvers.some(resolve=>{const label=resolve(choice.labelKey,choice.value);return key(afterRaw)===key(label)||key(afterRaw)===key(choice.value+' · '+label);}));
  record.cells[formField]=matched.length===1?matched[0].value:afterRaw;
 }
 const list=[...records.values()];
 for(const record of list)record.errors=[...new Set(record.errors)];
 return{records:list,fileErrors:movementRecordLimits(list)};
}
