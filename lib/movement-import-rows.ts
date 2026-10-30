/**
 * ac6645ec — the single Movements sheet (ADR-0156). One row per field change: rows with the same Company ID,
 * Employee ID, Effective Date and Event Type form ONE movement. System Fields map onto the existing
 * per-behaviour New Event inputs (the same layout the per-type workbook used), After is the value to record
 * and Before is the value the preparer saw, checked against the record at preview. Company ID is resolved
 * per row by the server; this module only groups and maps.
 */
import {normalizeEmployeeCode,isValidEmployeeCode} from './employee-code';
import {movementImportDate,MOVEMENT_IMPORT_LIMITS,type MovementImportRecord} from './movement-import-contract';
import {movementWorkbookLayout,movementWorkbookScalarChoices,movementWorkbookChoiceLabel,type MovementWorkbookType} from './movement-workbook-layout';
import {movementRecordLimits} from './movement-type-csv';
import {personnelImportOptionLookup} from './personnel-import-lookup';
import type {PersonnelLabelResolver} from './personnel-import-contract';
export const MOVEMENT_SHEET='Movements';
/** 646355e5 slice C — template version 4 appends Action, Movement Event ID and Reason to the eight version 3
 * columns. Appending keeps every version 3 column at its position; a version 3 file (or 8-column CSV) is read
 * with those three cells blank, which means Create, exactly as before. */
export const MOVEMENT_COLUMNS=['companyId','employeeId','employeeName','effectiveDate','eventType','systemField','before','after','action','movementId','reason'] as const;
export const MOVEMENT_COLUMNS_V3=MOVEMENT_COLUMNS.slice(0,8);
export type MovementTemplateVersion=3|4;
export const movementColumnsFor=(version:MovementTemplateVersion)=>version===3?MOVEMENT_COLUMNS_V3:MOVEMENT_COLUMNS;
export type MovementColumn=typeof MOVEMENT_COLUMNS[number];
const CAPTIONS:Record<MovementColumn,string>={companyId:'Company ID',employeeId:'Employee ID',employeeName:'Employee Name',effectiveDate:'Effective Date',eventType:'Event Type',systemField:'System Fields',before:'Before',after:'After',action:'Action',movementId:'Movement Event ID',reason:'Reason'};
export const movementColumnCaption=(column:MovementColumn,resolve:PersonnelLabelResolver)=>resolve('people.import.movement.sheet.col.'+column,CAPTIONS[column]);
export const movementColumnCaptions=(resolve:PersonnelLabelResolver,version:MovementTemplateVersion=4)=>movementColumnsFor(version).map(column=>movementColumnCaption(column,resolve));
export const MOVEMENT_ACTIONS=['create','update','delete'] as const;
const ACTION_CAPTIONS={create:'Create',update:'Update',delete:'Delete'} as const;
/** The Action drop-down value: the translated word; the English word and the code are always accepted too. */
export const movementActionLabel=(action:typeof MOVEMENT_ACTIONS[number],resolve:PersonnelLabelResolver)=>resolve('people.import.movement.sheet.action.'+action,ACTION_CAPTIONS[action]);
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
/** The header's template version: the eight version 3 captions, or all eleven (version 4); null otherwise. */
export function movementHeaderVersion(header:string[],resolvers:PersonnelLabelResolver[]):MovementTemplateVersion|null{
 const cells=header.map(value=>key(value??''));while(cells.length&&!cells[cells.length-1])cells.pop();
 for(const version of [4,3] as const){const columns=movementColumnsFor(version);if(cells.length===columns.length&&columns.every((column,index)=>resolvers.some(resolve=>key(movementColumnCaption(column,resolve))===cells[index])))return version;}
 return null;
}
/** Header row check. Captions in any shipped language are accepted; the per-type layouts are refused. */
export function movementHeaderIssue(header:string[],resolvers:PersonnelLabelResolver[]):string|null{
 const cells=header.map(value=>key(value??''));while(cells.length&&!cells[cells.length-1])cells.pop();
 if(movementHeaderVersion(header,resolvers))return null;
 // The retired per-type layouts started with Employee ID and had no Company ID / System Fields columns.
 if(['employee id','employee_code','employeecode'].includes(cells[0]??'')||!cells.some(cell=>resolvers.some(resolve=>key(movementColumnCaption('systemField',resolve))===cell)))return 'workbook_old_layout';
 return 'workbook_columns_changed';
}
const UUID_EXACT=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function actionOf(raw:string,resolvers:PersonnelLabelResolver[]):typeof MOVEMENT_ACTIONS[number]|null{
 if(!raw)return 'create';
 return MOVEMENT_ACTIONS.find(action=>key(raw)===action||resolvers.some(resolve=>key(movementActionLabel(action,resolve))===key(raw)))??null;
}
/** Group sheet rows into one record per movement. File-level limits use the existing record bounds.
 * Create rows group by company, employee, date and event type. 646355e5 slice C — Update and Delete rows group
 * by company, employee, action and Movement Event ID; their blank Effective Date and Event Type mean "keep". */
export function movementRowsToRecords(rows:MovementSheetRow[],types:MovementWorkbookType[],resolvers:PersonnelLabelResolver[]):{records:MovementImportRecord[];fileErrors:string[]}{
 const entered=rows.filter(row=>row.values.some(value=>(value??'').trim()));
 // d9e33556 — an unchanged download is readable but has nothing to check: say so, not a structure error.
 if(!entered.length)return{records:[],fileErrors:['no_movement_entries']};
 if(entered.length>MOVEMENT_IMPORT_LIMITS.rows)return{records:[],fileErrors:['too_many_rows']};
 const typeLookup=personnelImportOptionLookup(types.map(type=>({value:type.code,label:type.label??type.code,aliases:resolvers.map(resolve=>resolve('people.detail.movement.eventType.'+type.behaviour,type.code))})));
 const records=new Map<string,MovementImportRecord>();
 for(const sheetRow of entered){
  const [companyCode,employeeRaw,employeeName,dateRaw,typeRaw,fieldRaw,beforeRaw,afterRaw,actionRaw,idRaw,reasonRaw]=MOVEMENT_COLUMNS.map((_,index)=>(sheetRow.values[index]??'').trim());
  const employeeCode=normalizeEmployeeCode(employeeRaw),date=movementImportDate(dateRaw)??dateRaw;
  const typeCode=typeRaw&&!typeLookup.isAmbiguous(typeRaw)?typeLookup.get(typeRaw):undefined,type=types.find(t=>t.code===typeCode);
  const action=actionOf(actionRaw,resolvers),correction=action==='update'||action==='delete';
  const groupKey=action===null?'?action|'+sheetRow.row:correction?[companyCode.toUpperCase(),employeeCode,action,idRaw.toLowerCase()||'?id|'+sheetRow.row].join('|'):[companyCode.toUpperCase(),employeeCode,date,typeCode??key(typeRaw)].join('|');
  const typeError=typeLookup.isAmbiguous(typeRaw)?'ambiguous_reference:event_type':'unknown_or_inactive_event_type';
  let record=records.get(groupKey);
  if(!record){
   record={row:sheetRow.row,employeeCode,companyCode,employeeName:employeeName||undefined,cells:{...(typeRaw||!correction?{kind:typeCode??typeRaw}:{}),...(dateRaw?{effectiveDate:dateRaw}:{})},errors:[],importVersion:2,source:{sheet:MOVEMENT_SHEET,row:sheetRow.row},sourceRows:[],before:{},
    ...(correction?{action,...(idRaw?{movementId:idRaw.toLowerCase()}:{})}:{})};
   if(!companyCode)record.errors.push('company_required');
   if(!isValidEmployeeCode(employeeCode))record.errors.push('invalid_employee_code');
   // An unknown Action says nothing about which other rules apply; that one error is the row's message.
   if(action===null)record.errors.push('unknown_action');
   else if(correction){
    if(!idRaw)record.errors.push('movement_id_required');else if(!UUID_EXACT.test(idRaw))record.errors.push('movement_id_unknown');
    if(typeRaw&&!type)record.errors.push(typeError);
    if(dateRaw&&!movementImportDate(dateRaw))record.errors.push('invalid_effective_date');
   }else{
    if(!typeRaw)record.errors.push('event_type_required');else if(!type)record.errors.push(typeError);
    if(type?.behaviour!=='blacklist'&&!movementImportDate(dateRaw))record.errors.push('invalid_effective_date');
   }
   records.set(groupKey,record);
  }else if(correction){
   // One Update or Delete may span several rows; a filled Effective Date or Event Type must agree across them.
   if(dateRaw){if(record.cells.effectiveDate===undefined){record.cells.effectiveDate=dateRaw;if(!movementImportDate(dateRaw))record.errors.push('invalid_effective_date');}else if((movementImportDate(record.cells.effectiveDate)??record.cells.effectiveDate)!==date)record.errors.push('conflicting_values:effectiveDate');}
   if(typeRaw){if(record.cells.kind===undefined){record.cells.kind=typeCode??typeRaw;if(!type)record.errors.push(typeError);}else if(record.cells.kind!==(typeCode??typeRaw))record.errors.push('conflicting_values:kind');}
  }
  record.sourceRows!.push(sheetRow.row);
  const values=[companyCode,employeeRaw,employeeName,dateRaw,typeRaw,fieldRaw,beforeRaw,afterRaw,actionRaw,reasonRaw];
  if(values.some(value=>/^[=+@]/.test(value))||/^[=+@]/.test(idRaw))record.errors.push('formula_input');
  // The Movement Event ID is the one internal reference a row may carry; the server resolves it only within
  // the row's own tenant, company and employee. Every other cell still refuses an internal id.
  if(values.some(value=>UUID.test(value)))record.errors.push('internal_reference_not_allowed');
  if(correction){
   if(reasonRaw){if(record.reason===undefined)record.reason=reasonRaw;else if(record.reason!==reasonRaw)record.errors.push('conflicting_values:reason');}
  }else{
   if(idRaw)record.errors.push('movement_id_not_for_create');
   if(reasonRaw)record.errors.push('reason_not_for_create');
  }
  if(action==='delete'){if(fieldRaw||beforeRaw||afterRaw)record.errors.push('not_applicable_on_delete');continue;}
  if(!fieldRaw){if(beforeRaw||afterRaw)record.errors.push('system_field_required');continue;}
  const fieldType=type??(action==='update'&&!typeRaw?undefined:null);
  if(fieldType===null)continue;
  // An Update that keeps its event type names any System Field of any type; the server then refuses one the
  // movement's own type cannot change (not_applicable), exactly as it does for a Create.
  const fields=resolvers.flatMap(resolve=>fieldType?movementSystemFields(fieldType,resolve):types.flatMap(t=>movementSystemFields(t,resolve)));
  const field=fields.find(f=>key(f.key)===key(fieldRaw)||key(f.label)===key(fieldRaw));
  if(!field){record.errors.push('unknown_system_field:'+fieldRaw.slice(0,100));continue;}
  if(record.before![field.key]!==undefined||field.key==='incrementAmount'&&record.incrementAmount!==undefined||field.key!=='incrementAmount'&&record.cells[field.key as keyof MovementImportRecord['cells']]!==undefined){record.errors.push('duplicate_system_field:'+field.key);continue;}
  if(action==='update'&&field.key==='incrementAmount'){record.errors.push('increment_amount_not_for_update');continue;}
  // Update: a blank After keeps the recorded value (Before, when filled, is still checked).
  if(!afterRaw&&action!=='update')record.errors.push('required:'+field.key);
  if(beforeRaw)record.before![field.key]=beforeRaw;
  if(!afterRaw)continue;
  if(field.key==='incrementAmount'){record.incrementAmount=afterRaw;continue;}
  const formField=field.key as keyof MovementImportRecord['cells'];
  // 1d58019a Step 2 — a termination reason may be one of the organisation's own, under its own name.
  const choices=movementWorkbookScalarChoices(formField,fieldType?[fieldType]:types);
  const matched=choices.filter(choice=>key(afterRaw)===key(choice.value)||resolvers.some(resolve=>{const label=movementWorkbookChoiceLabel(choice,resolve);return key(afterRaw)===key(label)||key(afterRaw)===key(choice.value+' · '+label);}));
  record.cells[formField]=matched.length===1?matched[0].value:afterRaw;
 }
 const list=[...records.values()];
 for(const record of list){if((record.action==='update'||record.action==='delete')&&!record.reason?.trim())record.errors.push('reason_required');record.errors=[...new Set(record.errors)];}
 // The same movement may be named by only one Update or Delete in a file.
 const named=new Map<string,number>();for(const record of list)if(record.movementId)named.set(record.movementId,(named.get(record.movementId)??0)+1);
 for(const record of list)if(record.movementId&&named.get(record.movementId)!>1&&!record.errors.includes('duplicate_movement_id'))record.errors.push('duplicate_movement_id');
 return{records:list,fileErrors:movementRecordLimits(list)};
}
