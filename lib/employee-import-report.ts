/**
 * Item 1859cce0 — the "Everything — new employees" error report, derived in ONE place from what Import History
 * already keeps: the attempt's validated plan rows (file check) and the failed event's save report (problems
 * found while saving, and the rows that were not saved because the file was cancelled). Client-safe: no database
 * or server imports, so the attempt page, its CSV download and tests share it.
 */
import type {ImportIssue,ImportIssueStage,ImportRowOutcome} from './import-schema';

/** One row of the save report, recorded on the failed Import History event (detail.rows). Identity and reason only:
 *  never the row's identity number, bank account, statutory numbers or salary. */
export type EmployeeImportSaveReportRow={
 rowNum:number;employeeCode:string;fullName:string;companyId:string;
 /** 'stopped': refused while saving (this row stopped the file); 'cancelled': no problem, not saved. */
 outcome:'stopped'|'cancelled';
 column?:string;message?:string;
 /** For a cancelled row: the rows whose refusal cancelled the file (empty when no row was named). */
 stoppedBy?:number[];
};
/** Bounded like the job's own row errors: a file with more problems than this is the wrong file. */
export const EMPLOYEE_IMPORT_SAVE_REPORT_LIMIT=2000;

/** English text recorded with a cancelled row (Import History renders the translated wording by outcome). */
export function cancelledRowMessage(stoppedBy:readonly number[]){
 return stoppedBy.length
  ?`Not saved: the file was cancelled because row ${stoppedBy.join(', ')} could not be saved. This row has no problem; upload it again with the corrected file.`
  :'Not saved: the file was cancelled before any employee was saved. This row has no problem; upload it again with the corrected file.';
}
/** English summary for a file cancelled while saving. */
export function cancelledFileMessage(stoppedBy:readonly number[],reason:string){
 return stoppedBy.length
  ?`No employee was saved. Row ${stoppedBy.join(', ')} could not be saved, so the whole file was cancelled. Fix the rows listed and upload the whole file again.`
  :`No employee was saved: the import stopped before it finished (${reason}). The whole file was cancelled; upload it again.`;
}

/**
 * Owner refusals that name their field in a fixed sentence. The owners throw plain errors; this exact-text table
 * lets the report point at the column for the ones that are known, and says nothing about any other text.
 */
const OWNER_REFUSAL_COLUMNS:Record<string,string>={
 'Contract start date and contract end date are required for a contract employee.':'contract_end_date',
 'Contract start date cannot be earlier than the hire date.':'contract_start_date',
 'Contract end date must be later than the contract start date.':'contract_end_date',
 'The direct superior named on this row was not imported.':'direct_superior',
};
export const ownerRefusalColumn=(message:string)=>OWNER_REFUSAL_COLUMNS[message.trim()];

type PlanRow={rowNum:number;fullName?:string;employeeCode?:string;companyId?:string;ok:boolean;errors?:string[];issues?:ImportIssue[]};
type HistoryEvent={kind:string;detail:Record<string,unknown>};
export type EmployeeImportReportLine={
 rowNum:number;employeeCode:string;fullName:string;companyId:string|null;
 column:string|null;code:string|null;message:string|null;stage:ImportIssueStage|null;
 /** 'pending': the import has not finished (no outcome recorded yet). */
 outcome:ImportRowOutcome|'pending';stoppedBy:number[];
};
export type EmployeeImportReport={lines:EmployeeImportReportLine[];counts:{saved:number;toFix:number;cancelled:number;total:number};
 /** The file was cancelled while saving (at least one row stopped it, or the save stopped). */
 cancelledWhileSaving:boolean;stoppedBy:number[]};

const planRowsOf=(plan:unknown):PlanRow[]=>{
 const rows=(plan as {rows?:unknown}|null)?.rows;
 return Array.isArray(rows)?rows.filter((r):r is PlanRow=>!!r&&typeof r==='object'&&typeof (r as PlanRow).rowNum==='number'):[];
};
const saveRowsOf=(events:readonly HistoryEvent[]):EmployeeImportSaveReportRow[]|null=>{
 const failed=[...events].reverse().find(e=>e.kind==='failed');
 const rows=failed?.detail?.rows;
 return Array.isArray(rows)?rows.filter((r):r is EmployeeImportSaveReportRow=>!!r&&typeof r==='object'&&typeof (r as EmployeeImportSaveReportRow).rowNum==='number'):null;
};

/** Every line of the report, in row order: one per problem, and one per row with no problem (its result). */
export function employeeImportReport(plan:unknown,events:readonly HistoryEvent[]):EmployeeImportReport{
 const confirmed=events.find(e=>e.kind==='confirmed');
 const failed=events.some(e=>e.kind==='failed');
 const saveRows=saveRowsOf(events)??[];
 const byRow=new Map<number,EmployeeImportSaveReportRow[]>();
 for(const r of saveRows)(byRow.get(r.rowNum)??byRow.set(r.rowNum,[]).get(r.rowNum)!).push(r);
 const stoppedBy=[...new Set(saveRows.filter(r=>r.outcome==='stopped').map(r=>r.rowNum))].sort((a,b)=>a-b);
 const lines:EmployeeImportReportLine[]=[];
 for(const row of planRowsOf(plan).sort((a,b)=>a.rowNum-b.rowNum)){
  const base={rowNum:row.rowNum,employeeCode:row.employeeCode??'',fullName:row.fullName??'',companyId:row.companyId??null};
  if(!row.ok){
   const issues:ImportIssue[]=Array.isArray(row.issues)&&row.issues.length?row.issues:(row.errors??[]).map(message=>({message}));
   for(const issue of issues)lines.push({...base,column:issue.column??null,code:issue.code??null,message:issue.message,stage:'check',outcome:'refused',stoppedBy:[]});
   continue;
  }
  const saved=byRow.get(row.rowNum);
  const stops=saved?.filter(r=>r.outcome==='stopped')??[];
  if(stops.length){for(const s of stops)lines.push({...base,column:s.column??null,code:null,message:s.message??null,stage:'save',outcome:'stopped',stoppedBy:[]});continue;}
  if(confirmed)lines.push({...base,column:null,code:null,message:null,stage:null,outcome:'saved',stoppedBy:[]});
  else if(failed)lines.push({...base,column:null,code:null,message:null,stage:null,outcome:'cancelled',stoppedBy:saved?.find(r=>r.outcome==='cancelled')?.stoppedBy??stoppedBy});
  else lines.push({...base,column:null,code:null,message:null,stage:null,outcome:'pending',stoppedBy:[]});
 }
 const rowsWith=(...o:EmployeeImportReportLine['outcome'][])=>new Set(lines.filter(l=>o.includes(l.outcome)).map(l=>l.rowNum)).size;
 const total=planRowsOf(plan).length;
 const saved=confirmed?Number((confirmed.detail as {succeeded?:unknown}).succeeded??0):0;
 return{lines,counts:{saved,toFix:rowsWith('refused','stopped'),cancelled:confirmed?0:rowsWith('cancelled'),total},cancelledWhileSaving:!confirmed&&failed&&(stoppedBy.length>0||saveRows.length>0),stoppedBy};
}

/**
 * Lines a viewer may see: rows of companies the viewer can view. A row recorded before rows carried their company
 * is shown only to a viewer who covers every company of the attempt (the same rule as the original file).
 */
export function scopeEmployeeImportReport(report:EmployeeImportReport,visibleCompanyIds:ReadonlySet<string>,coversAttempt:boolean):EmployeeImportReport{
 if(coversAttempt)return report;
 const lines=report.lines.filter(l=>l.companyId?visibleCompanyIds.has(l.companyId):false);
 const rows=(...o:EmployeeImportReportLine['outcome'][])=>new Set(lines.filter(l=>o.includes(l.outcome)).map(l=>l.rowNum)).size;
 return{...report,lines,counts:{saved:rows('saved'),toFix:rows('refused','stopped'),cancelled:rows('cancelled'),total:new Set(lines.map(l=>l.rowNum)).size}};
}
/** The plan's own row-issue list (shown in the attempt summary), narrowed to the rows of visible companies. */
export function scopeEmployeeImportIssues<T extends {rowNum:number}>(issues:readonly T[],plan:unknown,visibleCompanyIds:ReadonlySet<string>,coversAttempt:boolean):T[]{
 if(coversAttempt)return[...issues];
 const company=new Map(planRowsOf(plan).map(r=>[r.rowNum,r.companyId]));
 // rowNum 0 is a whole-file problem; its text may quote rows of any company, so it needs the whole attempt too.
 return issues.filter(i=>i.rowNum!==0&&(company.get(i.rowNum)?visibleCompanyIds.has(company.get(i.rowNum)!):false));
}
