/**
 * Board d3ba1e9f — the ONE adapter for the section imports (Profile, Family, Qualifications, Emergency Contacts): the
 * check screen's preview, the result screen and the Import History run log all become ImportProblemLine rows here,
 * and the on-screen table and the downloaded Error Log are both drawn from them. Client-safe (no database, no React).
 *
 * Section rows stand alone: a refused row is 'refused' and the other rows still save; a row whose save failed is
 * 'not_saved'. Rows are numbered as Excel numbers them where the row recorded it, else data row + 1.
 */
import type {ImportProblemLine} from './import-problem-lines';
import type {ImportIssue,ImportRunError} from './import-schema';
import type {SectionImportPreview,SectionImportResult,SectionRowResult,ImportSection} from './import-sections';
import {importCorrectionText,importFieldCaption,importProblemText,issueProblemLine,issuesOf,lineRowOf,type ImportProblemTranslate} from './import-problem-common';
import type {PersonnelImportSheet} from './personnel-import-contract';

/** A section row as the server returns it: the shared row result plus its issue list and Excel row (additive). */
export type SectionRowResultWithIssues=SectionRowResult&{issues?:ImportIssue[];excelRow?:number};
export type SectionProblemKind=Exclude<ImportSection,'bank_statutory'>;
/** Which Personnel sheet contract names a section's columns. */
export const sectionSheet=(section:SectionProblemKind):PersonnelImportSheet=>section==='qualification'||section==='emergency'?section:section==='family'?'family':'employee';

function fileLine(message:string,t:ImportProblemTranslate,stage:ImportProblemLine['stage'],result:ImportProblemLine['result']):ImportProblemLine{
 const text=importProblemText(message,t);
 const correction=text.errorReference?importCorrectionText('system',t):undefined;
 return{row:null,problem:text.problem,...(correction?{correction}:{}),stage:text.system?'system':stage,result,...(text.errorReference?{errorReference:text.errorReference}:{})};
}
function rowLines(row:SectionRowResultWithIssues,sheet:PersonnelImportSheet,t:ImportProblemTranslate,stage:ImportProblemLine['stage'],result:ImportProblemLine['result']):ImportProblemLine[]{
 return issuesOf(row).map(issue=>issueProblemLine(issue,{row:lineRowOf(row),reference:row.employeeCode||undefined,employeeName:row.employeeName||undefined,stage,result},sheet,t));
}

/** The check screen: whole-file problems first, then every row the check refused. */
export function sectionPreviewProblemLines(preview:SectionImportPreview,t:ImportProblemTranslate):ImportProblemLine[]{
 const sheet=sectionSheet(preview.section as SectionProblemKind);
 const lines:ImportProblemLine[]=preview.fileErrors.map(message=>fileLine(message,t,'file','refused'));
 for(const column of preview.missingColumns){const field=importFieldCaption(column,sheet,t)??column;
  lines.push({row:null,field,problem:t.problems('importErrorLogEmployee.missingColumn',{field}),correction:t.problems('importErrorLogEmployee.correction.missingColumn',{field}),stage:'file',result:'refused'});}
 for(const row of preview.rows as SectionRowResultWithIssues[])if(row.errors.length)lines.push(...rowLines(row,sheet,t,'check','refused'));
 return lines;
}

/** The result screen: the rows the check refused (not saved; the others went ahead) and the rows whose save failed. */
export function sectionResultProblemLines(result:SectionImportResult,preview:SectionImportPreview|null,t:ImportProblemTranslate):ImportProblemLine[]{
 const sheet=sectionSheet(result.section as SectionProblemKind);
 const lines:ImportProblemLine[]=result.fileErrors.map(message=>fileLine(message,t,preview?.fileErrors.includes(message)?'file':'save','not_saved'));
 const byRow=new Map(((preview?.rows??[]) as SectionRowResultWithIssues[]).map(r=>[r.rowNum,r] as const));
 if(preview&&!result.fileErrors.length)for(const row of preview.rows as SectionRowResultWithIssues[])if(row.errors.length)lines.push(...rowLines(row,sheet,t,'check','refused'));
 for(const f of result.failed){
  const checked=byRow.get(f.rowNum);
  lines.push(issueProblemLine({message:f.message},{row:checked?lineRowOf(checked):f.rowNum+1,reference:f.employeeCode||undefined,employeeName:checked?.employeeName||undefined,stage:'save',result:'not_saved'},sheet,t));
 }
 return lines;
}

/** Import History: a section run's recorded rows (at most IMPORT_RUN_ERROR_CAP of them, as the run kept them). */
export function sectionRunProblemLines(run:{kind:SectionProblemKind|null;errors:readonly ImportRunError[]},t:ImportProblemTranslate):ImportProblemLine[]{
 const sheet=run.kind?sectionSheet(run.kind):'employee';
 const lines:ImportProblemLine[]=[];
 for(const e of run.errors){
  const stage:ImportProblemLine['stage']=e.stage==='save'?'save':'check';
  const result:ImportProblemLine['result']=e.outcome==='cancelled'?'cancelled':stage==='save'?'not_saved':'refused';
  // Older runs stored the employee's name, or only the Employee ID, in `fullName`.
  const reference=e.employeeCode||undefined,employeeName=e.fullName&&e.fullName!==e.employeeCode?e.fullName:undefined;
  for(const issue of issuesOf(e))lines.push(issueProblemLine(issue,{row:lineRowOf(e),reference,employeeName,stage,result},sheet,t));
 }
 return lines;
}
