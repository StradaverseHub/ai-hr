/** Single-type CSV uses the same column presentation definition, never a row-supplied event type. */
import {todayInKualaLumpur} from './hr-date';
import {parseCsv,toCsv} from './csv';
import {normalizeEmployeeCode,isValidEmployeeCode} from './employee-code';
import {movementImportDate,movementImportHasBlacklistInput,MOVEMENT_IMPORT_LIMITS,type MovementImportRecord} from './movement-import-contract';
import {movementWorkbookLayout,movementWorkbookScalarChoices,movementWorkbookChoiceLabel,type MovementWorkbookType,type MovementWorkbookColumn} from './movement-workbook-layout';
import type {PersonnelLabelResolver} from './personnel-import-contract';
export function movementTypeCsvTemplate(type:MovementWorkbookType,resolve:PersonnelLabelResolver){return toCsv([movementWorkbookLayout(type,resolve).map(c=>c.label)]);}
export function movementInputRecord(type:MovementWorkbookType,columns:MovementWorkbookColumn[],values:string[],row:number,source:{sheet:string;row:number},resolvers:PersonnelLabelResolver[]=[]):MovementImportRecord{
 const cells:MovementImportRecord['cells']={kind:type.code,...(type.behaviour==='blacklist'?{effectiveDate:todayInKualaLumpur()}:{})},errors:string[]=[];let employeeCode='',incrementAmount:string|undefined;
 columns.forEach((column,index)=>{
  const value=(values[index]??'').trim();if(column.key==='employeeCode'){employeeCode=normalizeEmployeeCode(value);return;}
  if(column.role!=='input'||!value)return;
  if(/^[=+@]/.test(value)){errors.push('formula_input:'+column.key);return;}
  if(column.key==='incrementAmount')incrementAmount=value;
  else if(column.field){const choices=movementWorkbookScalarChoices(column.field,[type]);const matches=choices.filter(choice=>value===choice.value||resolvers.some(resolve=>{const label=movementWorkbookChoiceLabel(choice,resolve);return value===label||value===choice.value+' · '+label;}));cells[column.field]=matches.length===1?matches[0].value:value;}
 });
 if(type.behaviour==='blacklist'&&!movementImportHasBlacklistInput(cells))errors.push('blacklist_input_required');
 if(!isValidEmployeeCode(employeeCode))errors.push('invalid_employee_code');
 if(type.behaviour!=='blacklist'&&(!cells.effectiveDate||!movementImportDate(cells.effectiveDate)))errors.push('invalid_effective_date');
 return {row,employeeCode,cells,errors,incrementAmount,importVersion:2,source};
}
export function movementRecordLimits(records:MovementImportRecord[]){
 const errors:string[]=[];
 if(new Set(records.map(r=>r.row)).size!==records.length||records.some(r=>!Number.isSafeInteger(r.row)||r.row<1))errors.push('invalid_row_keys');
 if(!records.length)errors.push('no_data_rows');if(records.length>MOVEMENT_IMPORT_LIMITS.rows)errors.push('too_many_rows');
 if(new TextEncoder().encode(JSON.stringify(records)).length>MOVEMENT_IMPORT_LIMITS.bytes)errors.push('file_too_large');
 const counts=new Map<string,number>();for(const row of records)counts.set(row.employeeCode,(counts.get(row.employeeCode)??0)+1);
 if(counts.size>MOVEMENT_IMPORT_LIMITS.employees)errors.push('too_many_employees');
 for(const row of records)if(counts.get(row.employeeCode)!>MOVEMENT_IMPORT_LIMITS.perEmployee)row.errors.push('too_many_employee_rows');
 return errors;
}
export function parseMovementTypeCsv(csv:string,type:MovementWorkbookType,resolve:PersonnelLabelResolver,resolvers:PersonnelLabelResolver[]=[resolve]){
 if(new TextEncoder().encode(csv).length>MOVEMENT_IMPORT_LIMITS.bytes)return {records:[],fileErrors:['file_too_large']};
 let quoted=false,closed=false,start=true;for(let i=0;i<csv.length;i++){const char=csv[i];if(quoted){if(char==='\"'){if(csv[i+1]==='\"')i++;else{quoted=false;closed=true;}}continue;}if([',','\r','\n'].includes(char)){closed=false;start=true;continue;}if(char==='\"'){if(!start)return {records:[],fileErrors:['malformed_csv']};quoted=true;start=false;continue;}if(closed)return {records:[],fileErrors:['malformed_csv']};start=false;}if(quoted)return {records:[],fileErrors:['malformed_csv']};
 const grid=parseCsv(csv.replace(/^\uFEFF/,'')),columns=movementWorkbookLayout(type,resolve),normal=(s:string)=>s.trim().toLowerCase().replace(/[\s_]+/g,'');
 if(!grid.length)return {records:[],fileErrors:['empty_file']};
 const header=grid[0],indices=header.map(h=>columns.findIndex(c=>normal(h)===normal(c.key)||normal(h)===normal(c.label)||resolvers.some(r=>movementWorkbookLayout(type,r).some(other=>other.key===c.key&&normal(h)===normal(other.label)))));
 if(indices.some(i=>i<0)||new Set(indices).size!==indices.length||!indices.includes(0))return {records:[],fileErrors:['wrong_type_columns']};
 const records=grid.slice(1).filter(row=>row.some(c=>c.trim())).map((row,index)=>{
  const ordered=columns.map(()=> '');indices.forEach((column,i)=>{ordered[column]=row[i]??'';});
  const record=movementInputRecord(type,columns,ordered,index+2,{sheet:'CSV',row:index+2},resolvers);if(row.length>header.length)record.errors.push('extra_cells');return record;
 });
 return {records,fileErrors:movementRecordLimits(records)};
}
