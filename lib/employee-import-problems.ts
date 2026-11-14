/**
 * Board d3ba1e9f — the ONE adapter for "Everything — new employees" (with its Family, Qualifications, Emergency
 * Contacts and Cost Center Allocations sheets): the check screen's preview, the result screen and the Import History
 * entry all become ImportProblemLine rows here, and the on-screen table and the downloaded Error Log are both drawn
 * from those rows. Client-safe (no database, no React).
 *
 * Results: a row refused by the file check is 'refused'; a row refused while saving is 'stopped' (it stopped the
 * whole file: an Everything import is saved all together or not at all); every other valid row of a stopped file is
 * 'cancelled' and is never reported as imported. Rows are numbered as Excel numbers them.
 */
import type {ImportProblemLine} from './import-problem-lines';
import type {ImportPreview,ImportResult,RowResult} from './import-schema';
import {isCancelledRowMessage,ownerRefusalColumn,type EmployeeImportReport} from './employee-import-report';
import {importFieldCaption,importProblemText,issueProblemLine,issuesOf,lineRowOf,importCorrectionText,type ImportProblemTranslate} from './import-problem-common';
import type {PersonnelImportSheet} from './personnel-import-contract';

/** Worksheet names of the Everything template (the names Excel shows on the tabs). */
export const EMPLOYEE_IMPORT_SHEET_NAMES={employee:'Employee Import',family:'Family',qualification:'Qualifications',emergency:'Emergency Contacts',allocations:'Cost Center Allocations'} as const;
const ALLOCATION_PREFIX='Cost Center Allocations · ';

/** Whole-file line (no row number); a database error keeps its support reference and becomes a system line. */
function fileLine(message:string,t:ImportProblemTranslate,stage:ImportProblemLine['stage'],result:ImportProblemLine['result']):ImportProblemLine{
 const text=importProblemText(message,t);
 const correction=text.errorReference?importCorrectionText('system',t):undefined;
 return{row:null,problem:text.problem,...(correction?{correction}:{}),stage:text.system?'system':stage,result,...(text.errorReference?{errorReference:text.errorReference}:{})};
}
function missingColumnLines(columns:readonly string[],sheet:PersonnelImportSheet,sheetName:string|undefined,t:ImportProblemTranslate):ImportProblemLine[]{
 return columns.map(column=>{const field=importFieldCaption(column,sheet,t)??column;return{...(sheetName?{sheet:sheetName}:{}),row:null,field,
  problem:t.problems('importErrorLogEmployee.missingColumn',{field}),correction:t.problems('importErrorLogEmployee.correction.missingColumn',{field}),stage:'file' as const,result:'refused' as const};});
}
/** Fill the employee sheet's name on its lines when the file's problems span several sheets. */
function nameSheets(lines:ImportProblemLine[]):ImportProblemLine[]{
 if(!lines.some(l=>l.sheet&&l.sheet!==EMPLOYEE_IMPORT_SHEET_NAMES.employee))return lines;
 return lines.map(l=>l.sheet||l.row===null?l:{...l,sheet:EMPLOYEE_IMPORT_SHEET_NAMES.employee});
}

/** The check screen: whole-file problems first, then every refused row of every sheet. */
export function employeePreviewProblemLines(preview:ImportPreview,t:ImportProblemTranslate):ImportProblemLine[]{
 const lines:ImportProblemLine[]=[];
 const names=new Map(preview.rows.filter(r=>r.employeeCode).map(r=>[r.employeeCode!.toUpperCase(),r.fullName] as const));
 // Allocation group problems are listed once, against their own sheet and rows, rather than as a file sentence.
 for(const message of preview.fileErrors)if(!(preview.allocations&&message.startsWith(ALLOCATION_PREFIX)))lines.push(fileLine(message,t,'file','refused'));
 lines.push(...missingColumnLines(preview.missingColumns,'employee',undefined,t));
 lines.push(...missingColumnLines(preview.dependents?.missingColumns??[],'family',EMPLOYEE_IMPORT_SHEET_NAMES.family,t));
 for(const row of preview.rows)if(!row.ok)lines.push(...employeeRowLines(row,t,'check','refused'));
 for(const row of preview.dependents?.rows??[])if(!row.ok)for(const issue of issuesOf(row))
  lines.push(issueProblemLine(issue,{sheet:EMPLOYEE_IMPORT_SHEET_NAMES.family,row:lineRowOf(row),reference:row.employeeCode||undefined,employeeName:names.get(row.employeeCode.toUpperCase()),stage:'check',result:'refused'},'family',t));
 for(const register of preview.registers??[])for(const row of register.rows)if(!row.ok)for(const message of row.errors)
  lines.push(issueProblemLine({message},{sheet:EMPLOYEE_IMPORT_SHEET_NAMES[register.kind],row:lineRowOf(row as typeof row&{excelRow?:number}),reference:row.employeeCode||undefined,employeeName:row.employeeName||names.get(row.employeeCode.toUpperCase()),stage:'check',result:'refused'},register.kind,t));
 for(const group of preview.allocations?.groups??[])if(group.errors.length)for(const message of group.errors)
  // Allocation rows are already numbered as Excel numbers them (the allocation owner counts the header).
  lines.push({sheet:EMPLOYEE_IMPORT_SHEET_NAMES.allocations,row:group.rowNums[0]??null,reference:group.employeeCode||undefined,employeeName:names.get(group.employeeCode.toUpperCase()),
   problem:importProblemText(message,t).problem,stage:'check',result:'refused'});
 return nameSheets(lines);
}
function employeeRowLines(row:RowResult,t:ImportProblemTranslate,stage:ImportProblemLine['stage'],result:ImportProblemLine['result']):ImportProblemLine[]{
 return issuesOf(row).map(issue=>issueProblemLine(contractText(issue,t),{row:lineRowOf(row),reference:row.employeeCode||undefined,employeeName:row.fullName||undefined,stage,result},'employee',t));
}
/** The contract-period refusals in the viewer's language (the same wording Import History already used). */
function contractText<T extends {code?:string|null;message:string}>(issue:T,t:ImportProblemTranslate):T{
 const code=issue.code?.startsWith('contract.')?issue.code.slice('contract.'.length):null;
 if(!code||!['required','before_hire','end_not_after_start'].includes(code))return issue;
 return{...issue,message:t.problems(`people.importHistory.errorReport.contract.${code}`)};
}

/**
 * The result screen: what the check refused (still not imported), then what the save reported. A refusal while
 * saving stops the whole file, so the remaining valid rows are listed as cancelled with the rows that stopped it.
 */
export function employeeResultProblemLines(result:ImportResult,preview:ImportPreview|null,t:ImportProblemTranslate):ImportProblemLine[]{
 const lines:ImportProblemLine[]=[];
 const byRow=new Map((preview?.rows??[]).map(r=>[r.rowNum,r] as const));
 const checkFile=new Set(preview?.fileErrors??[]);
 for(const message of result.fileErrors)lines.push(fileLine(message,t,checkFile.has(message)?'file':'save','not_saved'));
 if(preview)for(const row of preview.rows)if(!row.ok)lines.push(...employeeRowLines(row,t,'check','refused'));
 const cancelled=(f:ImportResult['failed'][number])=>f.outcome==='cancelled'||(f.outcome===undefined&&isCancelledRowMessage(f.message));
 const rowOf=(f:{rowNum:number;excelRow?:number})=>typeof f.excelRow==='number'?f.excelRow:byRow.has(f.rowNum)?lineRowOf(byRow.get(f.rowNum)!):f.rowNum+1;
 const stoppedRows=[...new Set(result.failed.filter(f=>!cancelled(f)).map(rowOf))].sort((a,b)=>a-b);
 for(const f of result.failed){
  const checked=byRow.get(f.rowNum);
  const base={row:rowOf(f),reference:f.employeeCode||checked?.employeeCode||undefined,employeeName:f.fullName||checked?.fullName||undefined};
  if(cancelled(f)){
   lines.push({...base,problem:stoppedRows.length?t.problems('people.importHistory.errorReport.cancelledRow',{rows:stoppedRows.join(', ')}):t.problems('people.importHistory.errorReport.cancelledRowUnnamed'),
    correction:t.problems('importErrorLogEmployee.correction.uploadAgain'),stage:'save',result:'cancelled'});
   continue;
  }
  lines.push(issueProblemLine({message:f.message,column:f.column??ownerRefusalColumn(f.message)},{...base,stage:'save',result:'stopped'},'employee',t));
 }
 return lines;
}

/** Import History: the attempt's report (already scoped to the viewer's companies) plus its whole-file problems. */
export function employeeHistoryProblemLines(input:{report:EmployeeImportReport;fileIssues:readonly {rowNum:number;reason:string}[];failure?:string|null},t:ImportProblemTranslate):ImportProblemLine[]{
 const lines:ImportProblemLine[]=[];
 for(const issue of input.fileIssues)if(issue.rowNum===0&&!issue.reason.startsWith(ALLOCATION_PREFIX))lines.push(fileLine(issue.reason,t,'file','refused'));
 for(const issue of input.fileIssues)if(issue.rowNum===0&&issue.reason.startsWith(ALLOCATION_PREFIX))
  lines.push({...fileLine(issue.reason.slice(ALLOCATION_PREFIX.length),t,'check','refused'),sheet:EMPLOYEE_IMPORT_SHEET_NAMES.allocations});
 const stopped=input.report.lines.some(l=>l.outcome==='stopped');
 // A save that stopped with no row to name (a technical failure) keeps its sentence and support reference.
 if(input.failure&&!stopped&&!input.fileIssues.length)lines.push(fileLine(input.failure,t,'save','not_saved'));
 for(const line of input.report.lines){
  const base={row:line.excelRow,reference:line.employeeCode||undefined,employeeName:line.fullName||undefined};
  if(line.outcome==='refused')lines.push(issueProblemLine(contractText({message:line.message??'',column:line.column??undefined,code:line.code??undefined,value:line.value},t),{...base,stage:'check',result:'refused'},'employee',t));
  else if(line.outcome==='stopped')lines.push(issueProblemLine({message:line.message??'',column:line.column??undefined},{...base,stage:'save',result:'stopped'},'employee',t));
  else if(line.outcome==='cancelled')lines.push({...base,problem:line.stoppedByRows.length?t.problems('people.importHistory.errorReport.cancelledRow',{rows:line.stoppedByRows.join(', ')}):t.problems('people.importHistory.errorReport.cancelledRowUnnamed'),
   correction:t.problems('importErrorLogEmployee.correction.uploadAgain'),stage:'save',result:'cancelled'});
 }
 return lines;
}
