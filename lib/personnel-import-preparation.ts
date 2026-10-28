/** Browser-memory preparation only. No provider, persistence, validation admission or HR writer.
 * All aliases/choice normalization belong to the canonical Personnel contract. Originals survive
 * every review; unsupported prose/oversized inputs require manual preparation rather than truncation.
 */
import {personnelImportHeaderCandidates,personnelImportField,personnelImportFields,personnelColumnLabel,normalizePersonnelImportValue,personnelScalarIssue,type PersonnelImportHeaderOptions} from './personnel-import-contract';
import {buildPersonnelCsv,parseStrictPersonnelCsvWithSource,parsePersonnelCsv,PERSONNEL_CSV_FRAME} from './personnel-csv';
import {proposePersonnelDateFormat} from './personnel-import-preparation-date';
import {normalizeEmployeeCode,isValidEmployeeCode} from './employee-code';
import {MAX_IMPORT_CSV_BYTES} from './import-file';
import type {PersonnelWorksheetSource} from './personnel-import-assistance-source';
export const PERSONNEL_PREPARATION_LIMITS=Object.freeze({rows:500,columns:128,cells:16000,bytes:MAX_IMPORT_CSV_BYTES});
export type PreparationReason='canonical_header'|'type_shape'|'unknown_label'|'ambiguous_label'|'trim'|'canonical_choice'|'date_format'|'ambiguous_date'|'ambiguous_number'|'identity_review'|'formula_review'|'duplicate_record'|'required_missing'|'scalar_invalid'|'conflicting_field';
export type PreparationCell=Readonly<{row:number;column:number;value:string;raw:string|number|boolean|null;span?:Readonly<{start:number;end:number}>;kind?:string;formula?:string}>;
export type PreparationField=Readonly<{id:string;label:string;cells:readonly PreparationCell[];candidates:readonly string[];suggestedField:string|null;suggestedValue:string;reasons:readonly PreparationReason[]}>;
export type PreparationRecord=Readonly<{id:string;rows:readonly number[];fields:readonly PreparationField[]}>;
export type PersonnelPreparation=Readonly<{state:'needs_review';sourceRevisionId:string;layout:'table'|'labeled_blocks'|'unlabeled_table';original:Readonly<{matrix:readonly(readonly PreparationCell[])[];text?:string;source?:PersonnelWorksheetSource;coordinateKind:string}>;records:readonly PreparationRecord[];extras:readonly Readonly<{id:string;row:number;kind:'header'|'blank'|'note';cells:readonly PreparationCell[]}>[];columns:readonly string[];options:PersonnelImportHeaderOptions}>|Readonly<{state:'manual';sourceRevisionId:string;reason:'limits'|'unsupported_structure'|'unsupported_cells'}>;
export type PreparationHumanField=Readonly<{id:string;field:string;value:string;reviewed:boolean}>;
export type PreparationDecisions=Readonly<{structureAccepted:boolean;records:Readonly<Record<string,'include'|'exclude'>>;extras:Readonly<Record<string,'retain_evidence'>>;fields:Readonly<Record<string,Readonly<{field:string|'exclude';value:string;reviewed:true}>>>;humanFields?:Readonly<Record<string,readonly PreparationHumanField[]>>}>;
const bytes=(value:string)=>new TextEncoder().encode(value).byteLength;
const text=(value:unknown)=>value===null||value===undefined?'':String(value);
const deep=<T>(value:T):T=>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value as object))deep(child);}return value;};
function optionsCapture(options:PersonnelImportHeaderOptions){return Object.freeze({...options,columns:Object.freeze([...options.columns]),resolvers:options.resolvers?Object.freeze([...options.resolvers]):undefined,sheet:'employee' as const});}
function shapeCandidates(values:readonly string[],options:PersonnelImportHeaderOptions){const filled=values.map(value=>value.trim()).filter(Boolean);if(!filled.length)return [];
 const fields=personnelImportFields('employee').filter(field=>field.import.column&&options.columns.includes(field.import.column));
 if(filled.every(value=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)))return fields.filter(field=>field.form?.widget==='email').map(field=>field.import.column!);
 if(filled.every(value=>/^\d{4}-\d{2}-\d{2}$/.test(value)))return fields.filter(field=>field.type==='date'&&field.unit!=='month').map(field=>field.import.column!);
 return [];
}
function field(id:string,label:string,cells:readonly PreparationCell[],candidates:readonly string[],options:PersonnelImportHeaderOptions,typeShape=false):PreparationField{
 const suggestedField=!typeShape&&candidates.length===1?candidates[0]:null,raw=cells.map(cell=>cell.value).join(' '),trimmed=raw.trim();
 const choiceValue=suggestedField?normalizePersonnelImportValue(suggestedField,trimmed,'employee',options.resolvers??[]):trimmed,descriptor=suggestedField?personnelImportField(suggestedField):undefined,date=descriptor?.type==='date'&&!cells.some(cell=>cell.formula)?proposePersonnelDateFormat(choiceValue,descriptor.unit==='month'?'month':'day'):null,suggestedValue=date?.value??choiceValue;
 const reasons:PreparationReason[]=[typeShape?'type_shape':candidates.length===1?'canonical_header':candidates.length?'ambiguous_label':'unknown_label'];
 if(raw!==trimmed)reasons.push('trim');if(choiceValue!==trimmed)reasons.push('canonical_choice');if(date&&date.value!==choiceValue)reasons.push('date_format');
 if(descriptor?.type==='date'&&trimmed&&!date&&!/^\d{4}-\d{2}(?:-\d{2})?$/.test(trimmed))reasons.push('ambiguous_date');
 if(descriptor&&['number','currency'].includes(descriptor.type)&&trimmed&&!/^-?\d+(?:\.\d+)?$/.test(trimmed))reasons.push('ambiguous_number');
 if(descriptor&&(descriptor.sensitivity==='identity'||descriptor.sensitivity==='bank'||descriptor.ownerField==='employeeCode')&&cells.some(cell=>typeof cell.raw==='number'))reasons.push('identity_review');
 if(cells.some(cell=>cell.formula))reasons.push('formula_review');if(descriptor?.ownerField==='employeeCode'&&trimmed&&!isValidEmployeeCode(trimmed))reasons.push('scalar_invalid');if(descriptor&&personnelScalarIssue(descriptor,suggestedValue))reasons.push('scalar_invalid');
 return deep({id,label,cells:[...cells],candidates:[...candidates],suggestedField,suggestedValue,reasons});
}
/** Comparison only; original values never change. These are the same keys used by core/import.ts:
 * normalizeEmployeeCode for Employee ID, and trimmed lowercase for the canonical primary email.
 * Do not extend this to names, personal email or other identity fields without an owning policy.
 */
function identityKey(column:string,value:string){const descriptor=personnelImportField(column);if(descriptor?.ownerField==='employeeCode')return normalizeEmployeeCode(value);if(descriptor?.ownerField==='primaryEmail')return value.trim().toLowerCase();return null;}
function markedDuplicates(records:readonly PreparationRecord[]){
 const occurrences=new Map<string,string[]>();for(const record of records)for(const item of record.fields){const descriptor=item.suggestedField?personnelImportField(item.suggestedField):null;if(!descriptor||(descriptor.ownerField!=='employeeCode'&&descriptor.ownerField!=='primaryEmail')||!item.suggestedValue)continue;const key=item.suggestedField+'\u0000'+identityKey(item.suggestedField!,item.suggestedValue);occurrences.set(key,[...(occurrences.get(key)??[]),item.id]);}
 const duplicateIds=new Set([...occurrences.values()].filter(ids=>ids.length>1).flat());return records.map(record=>deep({...record,fields:record.fields.map(item=>duplicateIds.has(item.id)?{...item,reasons:[...item.reasons,'duplicate_record' as const]}:item)}));
}
export function preparePersonnelImportMatrix(input:{revisionId:string;matrix:readonly(readonly unknown[])[];rowNumbers?:readonly number[];coordinateKind?:string;source?:PersonnelWorksheetSource;text?:string},headerOptions:PersonnelImportHeaderOptions):PersonnelPreparation{
 const revisionId=input.revisionId;if(!revisionId)throw Error('Preparation source unavailable.');if(headerOptions.sheet&&headerOptions.sheet!=='employee')return deep({state:'manual',sourceRevisionId:revisionId,reason:'unsupported_structure'});const options=optionsCapture(headerOptions),matrix=input.matrix;
 if(!Array.isArray(matrix)||matrix.some(row=>!Array.isArray(row)||row.some(value=>value!==null&&value!==undefined&&(!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value)))))return deep({state:'manual',sourceRevisionId:revisionId,reason:'unsupported_cells'});
 if(input.rowNumbers&&(input.rowNumbers.length!==matrix.length||input.rowNumbers.some(row=>!Number.isSafeInteger(row)||row<1)||new Set(input.rowNumbers).size!==input.rowNumbers.length))return deep({state:'manual',sourceRevisionId:revisionId,reason:'unsupported_structure'});
 if(matrix.length>PERSONNEL_PREPARATION_LIMITS.rows||matrix.some(row=>row.length>PERSONNEL_PREPARATION_LIMITS.columns)||matrix.reduce((n,row)=>n+row.length,0)>PERSONNEL_PREPARATION_LIMITS.cells||bytes(JSON.stringify(matrix))>PERSONNEL_PREPARATION_LIMITS.bytes)return deep({state:'manual',sourceRevisionId:revisionId,reason:'limits'});
 const source=input.source?deep({sheetName:input.source.sheetName,rows:input.source.rows.map(row=>({row:row.row,cells:row.cells.map(cell=>({...cell}))}))}):undefined;
 const sourceRows:readonly(readonly unknown[])[]=matrix;
 const original:Extract<PersonnelPreparation,{state:'needs_review'}>['original']=deep({matrix:sourceRows.map((row,r)=>row.map((value,c)=>{const evidence=source?.rows.find(line=>line.row===(input.rowNumbers?.[r]??r+1))?.cells.find(cell=>cell.column===c+1);return {row:input.rowNumbers?.[r]??r+1,column:c+1,value:text(value),raw:(evidence?evidence.raw:value??null) as string|number|boolean|null,...(evidence?{kind:evidence.kind,...(evidence.formula?{formula:evidence.formula}:{})}:{})};})),...(input.text===undefined?{}:{text:input.text}),...(source?{source}:{}),coordinateKind:input.coordinateKind??'worksheet_row'});
 const nonblank=original.matrix.filter(row=>row.some(cell=>cell.value.trim()));if(!nonblank.length)return deep({state:'manual',sourceRevisionId:revisionId,reason:'unsupported_structure'});
 const scores=original.matrix.map((row,index)=>({index,candidates:personnelImportHeaderCandidates(row.map(cell=>cell.value),options)})).map(row=>({...row,score:row.candidates.filter(item=>item.matches.length===1).length}));
 const best=[...scores].sort((a,b)=>b.score-a.score||a.index-b.index)[0],header=best.score>=2?best:null;
 const extras:{id:string;row:number;kind:'header'|'blank'|'note';cells:readonly PreparationCell[]}[]=[],records:PreparationRecord[]=[];
 if(header){const width=Math.max(...original.matrix.map(row=>row.length));for(let r=0;r<original.matrix.length;r++){const row=original.matrix[r],number=row[0]?.row??input.rowNumbers?.[r]??r+1;const repeated=scores[r].score>=2&&scores[r].candidates.map(item=>item.matches.length===1?item.matches[0]:'').join('|')===header.candidates.map(item=>item.matches.length===1?item.matches[0]:'').join('|');
   if(r<header.index||r===header.index||repeated||!row.some(cell=>cell.value.trim())){extras.push({id:'extra:'+r,row:number,kind:r===header.index||repeated?'header':row.some(cell=>cell.value.trim())?'note':'blank',cells:row});continue;}
   records.push(deep({id:'record:'+r,rows:[number],fields:Array.from({length:width},(_,c)=>field('cell:'+r+':'+c,original.matrix[header.index][c]?.value??'',row[c]?[row[c]]:[],header.candidates[c]?.matches??[],options))}));
  }
 }else{
  // Regular unlabeled delimited rows can offer type-shape candidates, never guess an identity/name.
  const width=Math.max(...original.matrix.map(row=>row.length));if(width<2)return deep({state:'manual',sourceRevisionId:revisionId,reason:'unsupported_structure'});
  const shapes=Array.from({length:width},(_,c)=>shapeCandidates(original.matrix.map(row=>row[c]?.value??''),options));
  for(let r=0;r<original.matrix.length;r++){const row=original.matrix[r],number=row[0]?.row??r+1;if(!row.some(cell=>cell.value.trim())){extras.push({id:'extra:'+r,row:number,kind:'blank',cells:row});continue;}records.push(deep({id:'record:'+r,rows:[number],fields:Array.from({length:width},(_,c)=>field('cell:'+r+':'+c,'',row[c]?[row[c]]:[],shapes[c],options,true))}));}
 }
 return deep({state:'needs_review',sourceRevisionId:revisionId,layout:header?'table':'unlabeled_table',original,records:markedDuplicates(records),extras,columns:[...options.columns],options});
}
export function preparePersonnelImportText(input:{revisionId:string;text:string},options:PersonnelImportHeaderOptions):PersonnelPreparation{
 if(options.sheet&&options.sheet!=='employee')return deep({state:'manual',sourceRevisionId:input.revisionId,reason:'unsupported_structure'});
 if(bytes(input.text)>PERSONNEL_PREPARATION_LIMITS.bytes)return deep({state:'manual',sourceRevisionId:input.revisionId,reason:'limits'});
 const lines=input.text.split(/\r\n|\n|\r/);const labeled=lines.map(line=>{const split=line.search(/[:：=]/);return split>0?{label:line.slice(0,split),value:line.slice(split+1)}:null;});
 const known=labeled.filter(Boolean).filter(row=>personnelImportHeaderCandidates([row!.label],options)[0].matches.length>0).length;
 if(known>=2&&labeled.filter(Boolean).length>=Math.ceil(lines.filter(line=>line.trim()).length/2)){
  if(lines.length>PERSONNEL_PREPARATION_LIMITS.rows)return deep({state:'manual',sourceRevisionId:input.revisionId,reason:'limits'});
  const captured=optionsCapture(options),matrix:PreparationCell[][]=[],records:PreparationRecord[]=[],extras:{id:string;row:number;kind:'blank'|'note';cells:PreparationCell[]}[]=[];let group:PreparationField[]=[],rows:number[]=[],offset=0;
  const finish=()=>{if(group.length){records.push(deep({id:'block:'+records.length,rows:[...rows],fields:[...group]}));group=[];rows=[];}};
  for(let r=0;r<lines.length;r++){const line=lines[r],parts=labeled[r],cell=deep({row:r+1,column:1,value:line,raw:line,span:{start:offset,end:offset+line.length}});matrix.push([cell]);offset+=line.length+(input.text.slice(offset+line.length,offset+line.length+2)==='\r\n'?2:1);
   if(!line.trim()){finish();extras.push({id:'extra:'+r,row:r+1,kind:'blank',cells:[cell]});continue;}
   if(!parts){extras.push({id:'extra:'+r,row:r+1,kind:'note',cells:[cell]});continue;}
   const matches=personnelImportHeaderCandidates([parts.label],captured)[0].matches;
   // A repeated canonical full-name/employee-code label suggests a new record, never overwrites it.
   if(matches.length===1&&group.some(item=>item.suggestedField===matches[0])&&['employeeCode','fullName'].includes(personnelImportField(matches[0])?.ownerField??''))finish();
   const start=cell.span!.start+line.search(/[:：=]/)+1,valueCell=deep({...cell,column:2,value:parts.value,raw:parts.value,span:{start,end:cell.span!.end}});group.push(field('label:'+r,parts.label,[valueCell],matches,captured));rows.push(r+1);
  }finish();return deep({state:'needs_review',sourceRevisionId:input.revisionId,layout:'labeled_blocks',original:{matrix,text:input.text,coordinateKind:'text_span'},records:markedDuplicates(records),extras,columns:[...captured.columns],options:captured});
 }
 if(input.text.includes('\t'))return preparePersonnelImportMatrix({revisionId:input.revisionId,matrix:lines.map(line=>line.split('\t')),text:input.text,coordinateKind:'text_line'},options);
 const pipes=lines.filter(line=>line.trim()).map(line=>line.split('|').length),aligned=lines.filter(line=>line.trim()).map(line=>line.split(/ {2,}/).length);
 if(pipes.length>=2&&pipes.every(width=>width>=2&&width===pipes[0]))return preparePersonnelImportMatrix({revisionId:input.revisionId,matrix:lines.map(line=>line.split('|')),text:input.text,coordinateKind:'text_line'},options);
 if(aligned.length>=2&&aligned.every(width=>width>=2&&width===aligned[0]))return preparePersonnelImportMatrix({revisionId:input.revisionId,matrix:lines.map(line=>line.split(/ {2,}/)),text:input.text,coordinateKind:'text_line'},options);
 try{const source=parseStrictPersonnelCsvWithSource(input.text),framed=source.rows[0]?.[0]===PERSONNEL_CSV_FRAME;return preparePersonnelImportMatrix({revisionId:input.revisionId,matrix:framed?parsePersonnelCsv(input.text,'employee'):source.rows,rowNumbers:framed?source.rowNumbers.slice(1):source.rowNumbers,text:input.text,coordinateKind:'csv_record'},options);}catch{return deep({state:'manual',sourceRevisionId:input.revisionId,reason:'unsupported_structure'});}
}
/** Only explicit human decisions create a new revision. No canonical preview/commit runs here. */
export function applyPersonnelImportPreparation(preparation:PersonnelPreparation,expectedRevision:string,decisions:PreparationDecisions,nextRevisionId:string,mode:'create'|'update'='create'){
 if(preparation.state!=='needs_review'||preparation.sourceRevisionId!==expectedRevision||!nextRevisionId||nextRevisionId===expectedRevision||decisions.structureAccepted!==true)throw Error('Preparation review incomplete.');
 // Human additions are decisions, never new 'original' source cells or automatic proposals.
 // Use the full-import column registry: disabledReason describes section-only updates, not this boundary.
 const additions=decisions.humanFields??{},recordIds=new Set(preparation.records.map(record=>record.id)),ids=new Set(preparation.records.flatMap(record=>record.fields.map(item=>item.id)));
 if(!additions||typeof additions!=='object'||Array.isArray(additions)||(Object.getPrototypeOf(additions)!==Object.prototype&&Object.getPrototypeOf(additions)!==null))throw Error('Preparation human fields unavailable.');
 let addedCount=0;
 for(const [recordId,items] of Object.entries(additions)){
  if(!recordIds.has(recordId)||!Array.isArray(items))throw Error('Preparation human record unavailable.');
  const record=preparation.records.find(record=>record.id===recordId)!;
  if(items.length&&record.fields.length+items.length>PERSONNEL_PREPARATION_LIMITS.columns)throw Error('Preparation exceeds limits.');
  for(const item of items){
   if(!item||(Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null)||Object.keys(item).sort().join(',')!=='field,id,reviewed,value'||typeof item.id!=='string'||!/^human:[a-zA-Z0-9-]{1,80}$/.test(item.id)||ids.has(item.id)||typeof item.field!=='string'||typeof item.value!=='string'||typeof item.reviewed!=='boolean'||((item.field!==''||decisions.records[recordId]!=='exclude')&&(!preparation.columns.includes(item.field)||personnelImportField(item.field)?.import.column!==item.field)))throw Error('Preparation human field unavailable.');
   ids.add(item.id);addedCount++;
  }
 }
 if(addedCount){
  const originalCells=preparation.original.matrix.reduce((total,row)=>total+row.length,0),sourceBytes=Math.max(bytes(preparation.original.text??''),bytes(JSON.stringify(preparation.original.matrix.map(row=>row.map(cell=>cell.raw)))));
  if(preparation.records.length>PERSONNEL_PREPARATION_LIMITS.rows||originalCells+addedCount>PERSONNEL_PREPARATION_LIMITS.cells||sourceBytes+bytes(JSON.stringify(additions))>PERSONNEL_PREPARATION_LIMITS.bytes)throw Error('Preparation exceeds limits.');
 }
 const records:Record<string,string>[]=[],changes:{recordId:string;fieldId:string;original:readonly PreparationCell[];field:string;value:string;reason:string;changed:boolean;origin?:'human_supplied'}[]=[];let exclusions=0;
 for(const extra of preparation.extras)if(decisions.extras[extra.id]!=='retain_evidence')throw Error('Preparation review incomplete.');
 for(const record of preparation.records){const decision=decisions.records[record.id];if(decision==='exclude'){exclusions++;continue;}if(decision!=='include')throw Error('Preparation review incomplete.');const output:Record<string,string>={};
  for(const item of record.fields){const selected=decisions.fields[item.id];if(!selected||selected.reviewed!==true)throw Error('Preparation review incomplete.');if(selected.field==='exclude'){exclusions++;continue;}if(!preparation.columns.includes(selected.field)||Object.prototype.hasOwnProperty.call(output,selected.field))throw Error('Preparation field conflict.');
   if(item.cells.some(cell=>cell.formula)&&!selected.value.trim())throw Error('Preparation formula value needs review.');const descriptor=personnelImportField(selected.field);if(descriptor&&personnelScalarIssue(descriptor,selected.value))throw Error('Preparation value needs review.');if(descriptor&&['number','currency'].includes(descriptor.type)&&selected.value&&!/^-?\d+(?:\.\d+)?$/.test(selected.value))throw Error('Preparation value needs review.');
   output[selected.field]=selected.value;changes.push({recordId:record.id,fieldId:item.id,original:item.cells,field:selected.field,value:selected.value,reason:selected.value===item.suggestedValue?'reviewed_proposal':'human_edit',changed:selected.field!==item.suggestedField||selected.value!==item.cells.map(cell=>cell.value).join(' ')});
  }
  for(const item of additions[record.id]??[]){
   if(item.reviewed!==true)throw Error('Preparation human field needs review.');
   if(Object.prototype.hasOwnProperty.call(output,item.field))throw Error('Preparation field conflict.');
   const descriptor=personnelImportField(item.field)!;
   if((descriptor.ownerField==='employeeCode'&&item.value.trim()&&!isValidEmployeeCode(item.value.trim()))||personnelScalarIssue(descriptor,item.value)||(['number','currency'].includes(descriptor.type)&&item.value&&!/^-?\d+(?:\.\d+)?$/.test(item.value)))throw Error('Preparation value needs review.');
   output[item.field]=item.value;
   changes.push({recordId:record.id,fieldId:item.id,original:[],field:item.field,value:item.value,reason:'human_added',origin:'human_supplied',changed:true});
  }
  if(preparation.options.columns.some(column=>(mode==='create'?personnelImportField(column)?.import.requiredCreate:personnelImportField(column)?.import.requiredUpdate)&&!output[column]?.trim()))throw Error('Preparation required field missing.');records.push(output);
 }
 if(!records.length)throw Error('Preparation contains no reviewed records.');
 const identity=personnelImportFields('employee').filter(field=>field.ownerField==='employeeCode'||field.ownerField==='primaryEmail').map(field=>field.import.column!);
 for(const column of identity){const seen=new Set<string>();for(const record of records){const value=identityKey(column,record[column]??'');if(value&&seen.has(value))throw Error('Preparation duplicate identity needs review.');if(value)seen.add(value);}}
 const columns=preparation.columns.filter(column=>records.some(record=>Object.prototype.hasOwnProperty.call(record,column))),text=buildPersonnelCsv('employee',[columns.map(column=>personnelColumnLabel(column,'employee')),...records.map(record=>columns.map(column=>record[column]??''))]);
 if(addedCount&&columns.length>PERSONNEL_PREPARATION_LIMITS.columns)throw Error('Preparation exceeds limits.');
 if(bytes(text)>PERSONNEL_PREPARATION_LIMITS.bytes)throw Error('Preparation exceeds limits.');
 return deep({text,sourceRevisionId:expectedRevision,revisionId:nextRevisionId,changesCount:changes.filter(change=>change.changed).length+exclusions,reviewedFieldsCount:changes.length,unresolvedCount:0 as const,evidence:preparation.original,recordEvidence:preparation.records,extraEvidence:preparation.extras,decisions,changes,excludedCount:exclusions});
}

/** Explicit review convenience, never automatic acceptance or a canonical validation result.
 * Current manual choices, draft edits, exclusions, cross-page duplicates and destination conflicts
 * stay outside this set. The caller must show the count/rule and require a separate human action.
 */
export function personnelPreparationClearMatches(preparation:Extract<PersonnelPreparation,{state:'needs_review'}>,recordIds:readonly string[],current:{records:Readonly<Record<string,'include'|'exclude'>>;fields:PreparationDecisions['fields'];humanFields?:PreparationDecisions['humanFields']},drafts:Readonly<Record<string,{field:string;value:string}>>={}){
 const allowed=new Set<PreparationReason>(['canonical_header','trim','canonical_choice']),wanted=new Set(recordIds),identityOccurrences=new Map<string,string[]>(),destinations=new Map<string,Map<string,number>>();
 for(const record of preparation.records){if(current.records[record.id]==='exclude')continue;const counts=new Map<string,number>();destinations.set(record.id,counts);for(const item of current.humanFields?.[record.id]??[]){if(!item.field)continue;counts.set(item.field,(counts.get(item.field)??0)+1);const key=identityKey(item.field,item.value);if(key){const composite=item.field+'\u0000'+key;identityOccurrences.set(composite,[...(identityOccurrences.get(composite)??[]),item.id]);}}for(const item of record.fields){const selected=drafts[item.id]??current.fields[item.id]??{field:item.suggestedField??'',value:item.suggestedValue};if(!selected.field||selected.field==='exclude')continue;counts.set(selected.field,(counts.get(selected.field)??0)+1);const key=identityKey(selected.field,selected.value);if(key){const composite=selected.field+'\u0000'+key;identityOccurrences.set(composite,[...(identityOccurrences.get(composite)??[]),item.id]);}}}
 const duplicateIds=new Set([...identityOccurrences.values()].filter(ids=>ids.length>1).flat()),matches:PreparationField[]=[];
 for(const record of preparation.records){if(!wanted.has(record.id)||current.records[record.id]==='exclude')continue;for(const item of record.fields){if(current.fields[item.id]||Object.prototype.hasOwnProperty.call(drafts,item.id)||!item.suggestedField||item.candidates.length!==1||item.reasons.some(reason=>!allowed.has(reason))||duplicateIds.has(item.id)||(destinations.get(record.id)?.get(item.suggestedField)??0)!==1)continue;matches.push(item);}}
 return Object.freeze(matches);
}
