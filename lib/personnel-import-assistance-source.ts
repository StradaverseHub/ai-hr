/** Browser-memory provenance and human header revision only. Never pass this object to an action,
 * provider, storage API or telemetry. Canonical server validation/explicit import own all HR effects. */
import type {ImportFileFormat} from './import-file';
import {MAX_IMPORT_CSV_BYTES} from './import-file';
import {buildPersonnelCsv,parsePersonnelCsv,parseStrictPersonnelCsvWithSource,PERSONNEL_CSV_FRAME} from './personnel-csv';
import {personnelColumnLabel,personnelImportHeaderCandidates,type PersonnelImportHeaderOptions} from './personnel-import-contract';
export type PersonnelSourceCell=Readonly<{column:number;raw:string|number|boolean|null;display:string;decoded:string;kind:string;formula?:string}>;
export type PersonnelSourceRow=Readonly<{row:number;cells:readonly PersonnelSourceCell[]}>;
export type PersonnelWorksheetSource=Readonly<{sheetName:string;rows:readonly PersonnelSourceRow[]}>;
export type PersonnelImportSource=Readonly<{revisionId:string;originalText:string;currentText:string;acceptedDestinations?:readonly string[];fileName:string|null;format:ImportFileFormat|'paste';sheetName:string|null;
 matrix:readonly (readonly string[])[];rowNumbers:readonly number[];coordinateKind:'worksheet_row'|'csv_record'|'decoded_row';provenance?:PersonnelWorksheetSource}>;
export function capturePersonnelImportSource(input:{text:string;fileName?:string|null;format:ImportFileFormat|'paste';source?:PersonnelWorksheetSource},revisionId:string):PersonnelImportSource {
 if(!revisionId||new TextEncoder().encode(input.text).byteLength>MAX_IMPORT_CSV_BYTES)throw Error('Import source unavailable.');
 const strict=parseStrictPersonnelCsvWithSource(input.text),framed=strict.rows[0]?.[0]===PERSONNEL_CSV_FRAME;
 const matrix=parsePersonnelCsv(input.text,'employee');if(!matrix.length||!matrix[0].length||matrix[0].length>128)throw Error('Import source unavailable.');
 const rows=input.source?.rows.slice(framed?1:0);if(rows&&rows.length!==matrix.length)throw Error('Import source unavailable.');
 const provenance=input.source?Object.freeze({sheetName:input.source.sheetName,rows:Object.freeze(input.source.rows.map(row=>Object.freeze({row:row.row,cells:Object.freeze(row.cells.map(cell=>Object.freeze({...cell})))})))}):undefined;
 return Object.freeze({revisionId,originalText:input.text,currentText:input.text,fileName:input.fileName??null,format:input.format,sheetName:input.source?.sheetName??null,
  matrix:Object.freeze(matrix.map(row=>Object.freeze([...row]))),rowNumbers:Object.freeze(rows?rows.map(row=>row.row):strict.rowNumbers.slice(framed?1:0)),
  coordinateKind:rows?'worksheet_row':input.format==='csv'||input.format==='paste'?'csv_record':'decoded_row',...(provenance?{provenance}:{})});
}
export function personnelHeaderSuggestions(source:PersonnelImportSource,options:PersonnelImportHeaderOptions){return personnelImportHeaderCandidates(source.matrix[0],options);}
/** Explicit one-to-one destinations only. No missing-value fill, row correction, merge or value trim.
 * Keep untouched original data/coordinates in source; the new reversible CSV changes headings only. */
export function applyPersonnelHeaderMapping(source:PersonnelImportSource,expectedRevision:string,destinations:readonly string[],columns:readonly string[],nextRevisionId:string){
 if(source.revisionId!==expectedRevision||!nextRevisionId||nextRevisionId===expectedRevision||destinations.length!==source.matrix[0].length
  ||new Set(destinations).size!==destinations.length||destinations.some(key=>!columns.includes(key)))throw Error('Import mapping unavailable.');
 const text=buildPersonnelCsv('employee',[destinations.map(key=>personnelColumnLabel(key,'employee')),...source.matrix.slice(1)]);
 if(new TextEncoder().encode(text).byteLength>MAX_IMPORT_CSV_BYTES)throw Error('Import mapping unavailable.');
 const after=parsePersonnelCsv(text,'employee');if(JSON.stringify(after.slice(1))!==JSON.stringify(source.matrix.slice(1)))throw Error('Import mapping unavailable.');
 return Object.freeze({sourceRevisionId:source.revisionId,revisionId:nextRevisionId,text,
  mapping:Object.freeze(destinations.map((field,columnIndex)=>Object.freeze({columnIndex,field}))),
  source:Object.freeze({...source,revisionId:nextRevisionId,currentText:text,acceptedDestinations:Object.freeze([...destinations])})});
}
