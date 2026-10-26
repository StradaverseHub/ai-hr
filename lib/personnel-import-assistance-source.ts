/** Browser-memory provenance and human header revision only. Never pass this object to an action,
 * provider, storage API or telemetry. Canonical server validation/explicit import own all HR effects. */
import type {ImportFileFormat} from './import-file';
import {MAX_IMPORT_CSV_BYTES} from './import-file';
import {buildPersonnelCsv,parsePersonnelCsv,parseStrictPersonnelCsvWithSource,PERSONNEL_CSV_FRAME} from './personnel-csv';
import {personnelColumnLabel,personnelImportHeaderCandidates,type PersonnelImportHeaderOptions} from './personnel-import-contract';
export type PersonnelSourceCell=Readonly<{column:number;raw:string|number|boolean|null;display:string;decoded:string;kind:string;formula?:string}>;
export type PersonnelSourceRow=Readonly<{row:number;cells:readonly PersonnelSourceCell[]}>;
export type PersonnelWorksheetSource=Readonly<{sheetName:string;rows:readonly PersonnelSourceRow[]}>;
export type PersonnelWorkbookSource=Readonly<{sheets:readonly Readonly<{sheetName:string;text:string;source:PersonnelWorksheetSource}>[];decodedBytes:number;rangeCells:number}>;
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

/** Header-only wire construction. This API cannot accept a source snapshot, rows, filenames or cells.
 * Capture before WebCrypto awaits; cryptography is a revision binding, never permission or truth. */
export async function preparePersonnelHeaderAssistancePacket(input:{companyId:string;operationNonce:string;headers:readonly import('./personnel-import-assistance').PersonnelImportHeader[];sendHeadingsOnly:boolean;evaluationBinding?:import('./personnel-import-evaluation').EmployeeImportEvaluationBinding}){
 const captured={companyId:input.companyId,operationNonce:input.operationNonce,sendHeadingsOnly:input.sendHeadingsOnly,
  headers:input.headers.map(header=>({columnIndex:header.columnIndex,heading:header.heading})),...(input.evaluationBinding?{evaluationBinding:{...input.evaluationBinding}}:{})};
 const {capturePersonnelImportHeaders,PersonnelImportHeaderAssistanceRequestSchema,personnelImportRegistryRevisionText,personnelImportHeadersRevisionText,personnelImportSourceRevisionText}=await import('./personnel-import-assistance');
 const headers=capturePersonnelImportHeaders(captured.headers);
 const sha=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),byte=>byte.toString(16).padStart(2,'0')).join('');
 const registryDigest=await sha(personnelImportRegistryRevisionText()),headersDigest=await sha(personnelImportHeadersRevisionText(headers));
 const sourceRevision=await sha(personnelImportSourceRevisionText(headersDigest,registryDigest));
 const packet=PersonnelImportHeaderAssistanceRequestSchema.parse({version:1,companyId:captured.companyId,operationNonce:captured.operationNonce,
  headers,...captured.evaluationBinding?{evaluationBinding:captured.evaluationBinding}:{},registryDigest,sourceRevision,mode:'ai',consent:{headersReviewed:true,sendHeadingsOnly:captured.sendHeadingsOnly}});
 return Object.freeze({...packet,headers:Object.freeze(packet.headers.map(header=>Object.freeze({...header}))),consent:Object.freeze({...packet.consent}),...packet.evaluationBinding?{evaluationBinding:Object.freeze({...packet.evaluationBinding})}:{}});
}

/** Remove only metadata padding for physically absent trailing cells, never explicit empty strings,
 * whitespace, formulas or a recorded raw value. Original full cell coordinates remain in source. */
export function personnelWorksheetMatrixRows(source:PersonnelWorksheetSource):string[][] {
 return source.rows.map(row=>{let end=row.cells.length;
  while(end>0){const cell=row.cells[end-1];if(cell.kind!=='blank'||cell.raw!==null||cell.decoded!==''||cell.formula!==undefined)break;end--;}
  return row.cells.slice(0,end).map(cell=>cell.decoded);
 });
}

export type PersonnelSheetRole='employee'|'family'|'allocations'|'qualification'|'emergency'|'unassigned'|'excluded';
/** All original worksheet evidence is client-local. This is a human scope decision, never an
 * automatic all-workbook discovery or a new parser for companion record kinds. */
export function reviewPersonnelWorkbookRoles(workbook:PersonnelWorkbookSource,roles:Readonly<Record<string,PersonnelSheetRole>>,acknowledgedExcluded:boolean){
 const allowed:readonly PersonnelSheetRole[]=['employee','family','allocations','qualification','emergency','unassigned','excluded'];
 if(workbook.sheets.length<1||workbook.sheets.length>32||new Set(workbook.sheets.map(sheet=>sheet.sheetName)).size!==workbook.sheets.length
  ||Object.keys(roles).some(name=>!workbook.sheets.some(sheet=>sheet.sheetName===name)))throw Error('Workbook review unavailable.');
 const selections=workbook.sheets.map(sheet=>({sheet,role:roles[sheet.sheetName]??'unassigned'}));
 if(selections.some(item=>!allowed.includes(item.role)))throw Error('Workbook review unavailable.');
 const employees=selections.filter(item=>item.role==='employee');
 const omitted=selections.filter(item=>item.role==='unassigned'||item.role==='excluded');
 const assigned=selections.filter(item=>item.role!=='unassigned'&&item.role!=='excluded');
 if(employees.length!==1||new Set(assigned.map(item=>item.role)).size!==assigned.length||omitted.length&&!acknowledgedExcluded)throw Error('Workbook review unavailable.');
 return Object.freeze({employee:employees[0].sheet,companions:Object.freeze(Object.fromEntries(['family','allocations','qualification','emergency'].map(role=>[role,selections.find(item=>item.role===role)?.sheet.text??''])) as Record<'family'|'allocations'|'qualification'|'emergency',string>),
  excluded:Object.freeze(omitted.map(item=>item.sheet.sheetName)),roles:Object.freeze(Object.fromEntries(selections.map(item=>[item.sheet.sheetName,item.role]))),excludedAcknowledged:acknowledgedExcluded,original:workbook});
}
