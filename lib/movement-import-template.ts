/** Browser template: transport names stay stable; field/type labels and guidance follow app locale. */
import type {MovementImportCatalog} from '../core/movement-import';
import {MOVEMENT_FORM_IDS,movementFormFields,movementFormRequired,type MovementFormField} from './movement-form-contract';
import {MOVEMENT_IMPORT_COLUMNS,MOVEMENT_IMPORT_FIELDS,MOVEMENT_IMPORT_HEADERS,MOVEMENT_IMPORT_LIMITS} from './movement-import-contract';
import {personnelFieldLabel,type PersonnelLabelResolver,personnelFieldChoices} from './personnel-import-contract';
import {personnelFormField} from './personnel-form-contract';
import {TERMINATION_REASON_CODES} from '../core/termination-reason';
import {buildXlsx} from './spreadsheet';
import {toCsv} from './csv';
export function movementImportTemplate(catalog:MovementImportCatalog,resolve:PersonnelLabelResolver){
 const words=(key:string,fallback:string)=>resolve('people.import.movement.'+key,fallback);
 const label=(field:MovementFormField)=>personnelFieldLabel(personnelFormField(MOVEMENT_FORM_IDS[field]),resolve);
 const typeLabel=(type:MovementImportCatalog['types'][number])=>type.label??resolve('people.detail.movement.eventType.'+type.behaviour,type.code);
 const instructions:(string|number)[][]=[
  [words('title','Import Movement events')],
  [words('guidance','Each row records a dated Movement for an existing Employee ID in the selected company. Hired is not an importable event.')],
  [words('sequenceHint','Rows are checked in effective-date order for each employee. One employee’s selected sequence saves together or rolls back together. Other employees are independent.')],
  [words('blankHint','Blank cells retain existing values. Only fields supported by that event type may contain values. Explicit clearing stays in Personnel.')],
  [words('dateHint','Dates: DD-MMM-YYYY (for example 06-Jan-2026). Excel date cells and YYYY-MM-DD are also accepted. Blacklist changes use today’s date.')],
  [words('displacedHint','Card ID and Attendance Photo updates are in Profile import. Contract and notice period settings remain in Personnel → Employment. Direct Superior changes use Movement.')],
  [words('limitsHint',`Maximum ${MOVEMENT_IMPORT_LIMITS.rows} rows, ${MOVEMENT_IMPORT_LIMITS.perEmployee} rows per employee and ${MOVEMENT_IMPORT_LIMITS.employees} employees. Split larger files.`)],
  [],[words('eventType','Event type'),words('behaviour','Behaviour'),words('requiredFields','Required fields'),words('optionalFields','Optional fields')],
  ...catalog.types.map(type=>{
   const fields=movementFormFields(type.behaviour,'resignation').filter(field=>field!=='kind');
   return [`${type.code} · ${typeLabel(type)}`,resolve('people.detail.movement.eventType.'+type.behaviour,type.behaviour),['Employee ID','EffectiveDate',...fields.filter(field=>field!=='effectiveDate'&&movementFormRequired(field,type.behaviour)).map(field=>field==='endDate'&&type.behaviour==='termination'?personnelFieldLabel(personnelFormField('employment_history.event_information.lastworkingdate'),resolve):field==='resignationDate'?label(field)+' ('+words('resignationOnly','resignation reason only')+')':label(field))].join(', '),fields.filter(field=>field!=='effectiveDate'&&!movementFormRequired(field,type.behaviour)).map(label).join(', ')];
  }),
  [],[words('terminationHint','For Termination, End date is Last Working Day. Resignation date is required only for resignation reason; termination reason determines exit classification.')],
  [],[words('column','Column'),words('field','Personnel field'),words('values','Values')],
  ...MOVEMENT_IMPORT_FIELDS.map((field,index)=>[MOVEMENT_IMPORT_HEADERS[index+1],label(field),['effectiveDate','endDate','resignationDate'].includes(field)?'DD-MMM-YYYY':field==='kind'?words('liveCatalog','Active Movement Settings types; use the code or code · label. Hired is excluded.'):personnelFieldChoices(personnelFormField(MOVEMENT_FORM_IDS[field])).map(value=>value.value).join(', ')]),
 ];
 const lists:{column:number;values:string[]}[]=[{column:1,values:catalog.types.map(type=>type.label?`${type.code} · ${type.label}`:type.code)}];
 for(const field of MOVEMENT_IMPORT_FIELDS){
  if(field==='kind')continue;
  const fieldOptions=catalog.fields[field];
  const values=field==='terminationReasonCode'?[...TERMINATION_REASON_CODES]:fieldOptions?.length?fieldOptions.map(option=>`${option.value} · ${option.label}`):personnelFieldChoices(personnelFormField(MOVEMENT_FORM_IDS[field])).map(option=>option.value);
  if(values.length)lists.push({column:MOVEMENT_IMPORT_FIELDS.indexOf(field)+1,values});
 }
 return {headers:MOVEMENT_IMPORT_HEADERS,columns:MOVEMENT_IMPORT_COLUMNS,instructions,lists,headerNotes:[words('employeeId','Employee ID'),...MOVEMENT_IMPORT_FIELDS.map(label)]};
}
export async function movementImportWorkbook(catalog:MovementImportCatalog,resolve:PersonnelLabelResolver){
 const template=movementImportTemplate(catalog,resolve);
 if(!catalog.types.length)throw new Error('No active Movement event types are available.');
 return buildXlsx(template.headers,[],{sheetName:'Movements',textColumns:template.headers.map((_,index)=>index),textRowFloor:MOVEMENT_IMPORT_LIMITS.rows,headerNotes:template.headerNotes,columnWidths:template.headers.map((_,index)=>index===0?22:26),extraSheets:[{name:'Instructions',rows:template.instructions,columnWidths:[55,35,70,90],wrapText:true}],validationLists:template.lists,validationSheetName:'Lists'});
}
export function movementImportCsvTemplate(){return toCsv([MOVEMENT_IMPORT_HEADERS]);}
