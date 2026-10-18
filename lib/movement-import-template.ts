/** Browser template: transport names stay stable; field/type labels and guidance follow app locale. */
import type {MovementImportCatalog} from '../core/movement-import';
import {MOVEMENT_FORM_IDS,movementFormFields,movementFormRequired,type MovementFormField} from './movement-form-contract';
import {MOVEMENT_IMPORT_COLUMNS,MOVEMENT_IMPORT_FIELDS,MOVEMENT_IMPORT_HEADERS,MOVEMENT_IMPORT_LIMITS} from './movement-import-contract';
import {personnelFieldLabel,type PersonnelLabelResolver,personnelFieldChoices} from './personnel-import-contract';
import {personnelFormField} from './personnel-form-contract';
import {TERMINATION_REASON_CODES} from '../core/termination-reason';
import {buildXlsx} from './spreadsheet';
import {toCsv} from './csv';
import {addXlsxListValidation} from './xlsx-list-validation';
// The shared form order places Company before EventType. Bind validation to the actual transport
// column; a fixed B column would put event choices on Company and hide its own reference list.
const eventTypeColumn=MOVEMENT_IMPORT_FIELDS.indexOf('kind')+1;
const eventTypeValidationName=`AIHR_Personnel_0_${eventTypeColumn}`;
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
 const lists:{column:number;values:string[]}[]=[{column:eventTypeColumn,values:catalog.types.map(type=>type.label?`${type.code} · ${type.label}`:type.code)}];
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
 const references=[
  {title:resolve('people.import.movement.eventType','Event type'),values:template.lists.find(list=>list.column===eventTypeColumn)!.values},
  {title:resolve('people.import.movement.values','Values'),values:catalog.types.map(type=>type.label??resolve('people.detail.movement.eventType.'+type.behaviour,type.code))},
  ...template.lists.filter(list=>list.column!==eventTypeColumn).map(list=>({title:template.headerNotes[list.column],values:list.values})),
 ];
 const length=Math.max(...references.map(column=>column.values.length));
 const listRows=[references.map(column=>column.title),...Array.from({length},(_,index)=>references.map(column=>column.values[index]??''))];
 const bytes=await buildXlsx(template.headers,[],{sheetName:'Movements',textColumns:template.headers.map((_,index)=>index),textRowFloor:MOVEMENT_IMPORT_LIMITS.rows,headerNotes:template.headerNotes,columnWidths:template.headers.map((_,index)=>index===0?22:26),extraSheets:[{name:'Instructions',rows:template.instructions,columnWidths:[55,35,70,90],wrapText:true},{name:'Lists',rows:listRows,columnWidths:references.map(()=>44)}]});
 // Our own three-sheet workbook has no defined names. Add only the fixed EventType reference;
 // all other large lookup lists remain visible without Excel's bounded dropdown inventory.
 const {default:JSZip}=await import('jszip');const zip=await JSZip.loadAsync(bytes),entry=zip.file('xl/workbook.xml');
 if(!entry)throw new Error('Generated Movement workbook is missing.');
 const xml=await entry.async('string');if(/<definedNames\b/.test(xml))throw new Error('Unexpected Movement template names.');
 const position=xml.search(/<(?:calcPr|oleSize|customWorkbookViews|pivotCaches|smartTagPr|smartTagTypes|webPublishing|fileRecoveryPr|webPublishObjects|extLst)\b|<\/workbook>/);
 if(position<0)throw new Error('Generated Movement workbook is malformed.');
 zip.file('xl/workbook.xml',xml.slice(0,position)+`<definedNames><definedName name="${eventTypeValidationName}">&apos;Lists&apos;!$A$2:$A$${catalog.types.length+1}</definedName></definedNames>`+xml.slice(position));
 return addXlsxListValidation(await zip.generateAsync({type:'uint8array',compression:'DEFLATE'}),[{sheetIndex:0,column:eventTypeColumn,name:eventTypeValidationName,lastRow:MOVEMENT_IMPORT_LIMITS.rows+1}]);
}
export function movementImportCsvTemplate(){return toCsv([MOVEMENT_IMPORT_HEADERS]);}
