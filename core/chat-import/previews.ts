/** AI v2 Phase 1, slice 3 (issue 16b) — the preview step of each import prepared in chat, through its own owner.
 *
 * Read-only owners only (test/chat-import-units.test.ts pins that this file names no commit path):
 *  - employee records: core/import.ts validateEmployeeImport, for the company in the turn's scope;
 *  - leave balances: validateLeaveImport (packs/leave/service), which checks each row's authority as the caller;
 *  - payroll history: previewPayrollHistoryUpload (packs/payroll/service), which records the upload as its own attempt
 *    (bound to the caller, with the source and its hash), exactly as the payroll history page's upload does;
 *  - attendance clockings: validateClockingImport (packs/attendance/service) with the built-in AIHR Standard Template
 *    (a tenant's own device mapping is chosen on the clocking import page).
 * Each runs as the caller. The result is reduced to counts and closed-vocabulary issues (lib/chat-import.ts): the owner's
 * own sentences can echo a cell, so they are never returned. The digest seals what the person saw. */
import {createHash} from 'node:crypto';
import type {SessionContext} from '../../db/client';
import {parseCsvRecords} from '../../lib/csv';
import {parsePersonnelImportCsv} from '../../lib/personnel-import-contract';
import {personnelImportLabelResolvers} from '../../lib/personnel-import-labels.server';
import {IMPORT_COLUMNS} from '../../lib/import-schema';
import {BUILTIN_MAPPING_ID} from '../../lib/clocking-file';
import {CHAT_IMPORT_ISSUES,type ChatImportFile,type ChatImportIssue,type ChatImportKind} from '../../lib/chat-import';
import {validateEmployeeImport} from '../import';
import {validateLeaveImport} from '../../packs/leave/service';
import {previewPayrollHistoryUpload} from '../../packs/payroll/service';
import {validateClockingImport} from '../../packs/attendance/service';
import type {ClockingImportLineResult} from '../../db/schema';
import {canonicalJson} from '../proposals/proposal';

/** One row needing attention: its data row number (0 is the header row), the column it is about, and why. */
export type ChatImportRowIssue=Readonly<{row:number;field:string;reason:ChatImportIssue}>;
export type ChatImportPreview=Readonly<{kind:ChatImportKind;
 /** Data rows in the file (the header row excluded). */
 total:number;
 /** Rows the owner would write when the person confirms. */
 ready:number;
 /** Rows it would not write: an error, already imported, or a change the import page decides. */
 attention:number;
 /** Rows it would write with a warning of its own (shown on the import page). */
 warned:number;
 /** Every row issue, in row order. */
 issues:readonly ChatImportRowIssue[];
 /** Whether Confirm can commit here: payroll history imports a file only when every row is correct. */
 confirmable:boolean;
 sourceHash:string;
 /** Payroll history: the owner's attempt and plan hash, which its own confirmation takes. */
 attemptId?:string;previewHash?:string;
 /** Payroll history: rows that would replace history already imported; Confirm here imports only the new ones. */
 replacing?:number}>;

export const sourceHashOf=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
const FIELD=/^[a-z0-9_]{1,40}$/;
const issue=(row:number,field:string,reason:ChatImportIssue):ChatImportRowIssue=>Object.freeze({row:Math.max(0,Math.trunc(row)),field:FIELD.test(field)?field:'row',reason});
/** The digest of everything the card shows and Confirm relies on. */
export function previewDigest(companyId:string,preview:ChatImportPreview):string{
 const {kind,total,ready,attention,warned,issues,confirmable,sourceHash,attemptId,previewHash,replacing}=preview;
 return createHash('sha256').update('teras:chat-import:v1\n'+canonicalJson({companyId,kind,total,ready,attention,warned,issues:issues.map(row=>({...row})),confirmable,sourceHash,
  attemptId:attemptId??null,previewHash:previewHash??null,replacing:replacing??0})).digest('hex');
}

/** An owner sentence without the cell it echoes: owners write "Employee not found: <cell>" or "... (got "<cell>")", so
 * everything after the first ": " and every quoted part is dropped before the sentence is classified. */
export function ownerSentence(message:string):string{
 return message.replace(/\s*\(got\s+"[\s\S]*?"\)/g,'').replace(/"[^"]*"/g,'').replace(/:\s[\s\S]*$/,'').toLowerCase();
}
/** A column named in an owner sentence: the column itself, its words, or its first word (employee_id from "employee"). */
export function fieldIn(message:string,columns:readonly string[]):string{
 const lower=ownerSentence(message);
 return columns.find(column=>lower.includes(column))??columns.find(column=>lower.includes(column.replace(/_/g,' ')))
  ??columns.find(column=>new RegExp('\\b'+column.split('_')[0]+'\\b').test(lower))??'row';
}
/** Reduces one owner sentence to the closed vocabulary. Unknown sentences are `other`. */
export function issueOf(message:string):ChatImportIssue{
 const text=ownerSentence(message);
 if(/missing required column|missing columns?|required column/.test(text))return 'missing_column';
 if(/^missing\b|\bis required\b|\brequired\b|\bempty\b|\bblank\b/.test(text))return 'missing_value';
 if(/not authori[sz]ed|permission|access is unavailable|outside your/.test(text))return 'not_permitted';
 if(/already imported|already exists|already on file|unchanged/.test(text))return 'already_imported';
 if(/duplicate/.test(text))return 'duplicate_in_file';
 if(/employee (?:not found|no\b)|no such employee|employee .*not found|nric|identity/.test(text))return 'unknown_employee';
 if(/still open in payroll|processed payroll|statutory report|payment export|period (?:is )?closed|cannot be replaced/.test(text))return 'period_closed';
 if(/leave credit|toil|replace(?:ment)?/.test(text))return 'needs_page';
 if(/date|period|yyyy-mm-dd|month/.test(text))return 'invalid_date';
 if(/days?\b|amount|number|figure|range|≤|≥/.test(text))return 'invalid_number';
 if(/not found|unknown|invalid|not recogni[sz]ed|does not match/.test(text))return 'unknown_type';
 return 'other';
}

const LEAVE_COLUMNS=['employee_id','leave_type','transaction_type','days','effective_date'];
async function leaveBalances(ctx:SessionContext,file:ChatImportFile,sourceHash:string):Promise<ChatImportPreview>{
 const {records}=parseCsvRecords(file.text);
 const preview=await validateLeaveImport(ctx,{records});
 const issues:ChatImportRowIssue[]=preview.missingColumns.map(column=>issue(0,column,'missing_column'));
 let ready=0,warned=0;
 for(const row of preview.rows){
  const skipped=row.warnings.some(warning=>warning.startsWith('Already imported'));
  if(row.ok&&!skipped){ready++;if(row.warnings.some(warning=>warning!=='Terminated employee'))warned++;continue;}
  if(row.ok){issues.push(issue(row.rowNum,'row','already_imported'));continue;}
  const first=row.errors[0]??'';issues.push(issue(row.rowNum,fieldIn(first,LEAVE_COLUMNS),issueOf(first)));
 }
 return Object.freeze({kind:'leave_balances' as const,total:preview.total,ready,attention:preview.total-ready,warned,issues:Object.freeze(issues),confirmable:ready>0,sourceHash});
}

async function employeeRecords(ctx:SessionContext,companyId:string,file:ChatImportFile,sourceHash:string):Promise<ChatImportPreview>{
 const columns=[...IMPORT_COLUMNS.required,...IMPORT_COLUMNS.optional];
 const {records}=parsePersonnelImportCsv(file.text,{columns,resolvers:personnelImportLabelResolvers});
 const preview=await validateEmployeeImport(ctx,{companyId,records});
 const issues:ChatImportRowIssue[]=preview.missingColumns.map(column=>issue(0,column,'missing_column'));
 // A whole-file refusal writes nothing (core/import.ts item 2983802f): every row waits for the import page.
 if(preview.fileErrors.length)return Object.freeze({kind:'employee_records' as const,total:preview.total,ready:0,attention:preview.total,warned:0,
  issues:Object.freeze([...issues,issue(0,'row','needs_page')]),confirmable:false,sourceHash});
 let ready=0,warned=0;
 for(const row of preview.rows){
  if(row.ok){ready++;if(row.warnings.length)warned++;continue;}
  const first=row.errors[0]??'';issues.push(issue(row.rowNum,fieldIn(first,columns),issueOf(first)));
 }
 return Object.freeze({kind:'employee_records' as const,total:preview.total,ready,attention:preview.total-ready,warned,issues:Object.freeze(issues),confirmable:ready>0,sourceHash});
}

const HISTORY_COLUMNS=['employee_no','payroll_period','payroll_cycle','doe_code','company_code','amount'];
/** The payroll history parser reads a workbook by its extension; the attached workbook arrives as its CSV text. */
export const historySourceName=(name:string)=>/\.csv$/i.test(name)?name:name.replace(/\.(xlsx|xls)$/i,'')+'.csv';
async function payrollHistory(ctx:SessionContext,file:ChatImportFile,sourceHash:string,operationKey:string):Promise<ChatImportPreview>{
 const total=parseCsvRecords(file.text).records.length;
 const {attemptId,plan}=await previewPayrollHistoryUpload(ctx,{name:historySourceName(file.name),content:Buffer.from(file.text,'utf8'),operationKey});
 const issues:ChatImportRowIssue[]=[];
 for(const problem of plan.issues)issues.push(issue(/missing required column/i.test(problem.reason)?0:problem.rowNum,fieldIn(problem.reason,HISTORY_COLUMNS),issueOf(problem.reason)));
 let ready=0,replacing=0,warned=0;
 for(const row of plan.rows){
  if(row.operation==='create'){ready+=row.rowNums.length;if(row.warnings?.length)warned+=row.rowNums.length;continue;}
  if(row.operation==='replace'){replacing+=row.rowNums.length;for(const at of row.rowNums)issues.push(issue(at,'row','needs_page'));continue;}
  if(row.operation==='unchanged'){for(const at of row.rowNums)issues.push(issue(at,'row','already_imported'));continue;}
  const first=row.reasons[0]??'';for(const at of row.rowNums)issues.push(issue(at,fieldIn(first,HISTORY_COLUMNS),issueOf(first)));
 }
 issues.sort((a,b)=>a.row-b.row);
 // The payroll history owner confirms a file only when nothing in it is invalid, and a record with a warning only once
 // the person acknowledges it on its page (core/payroll-history-revisions.ts confirmPayrollHistoryUpload).
 const confirmable=ready>0&&!plan.counts.invalid&&!plan.issues.length&&warned===0;
 return Object.freeze({kind:'payroll_history' as const,total,ready,attention:Math.max(0,total-ready),warned,issues:Object.freeze(issues),confirmable,sourceHash,
  attemptId,previewHash:plan.previewHash,replacing});
}

const CLOCKING_ISSUE:Readonly<Record<ClockingImportLineResult,readonly [string,ChatImportIssue]>>=Object.freeze({
 imported:['row','other'],duplicate:['row','already_imported'],unmatched_card:['card','unknown_employee'],ambiguous_card:['card','unknown_employee'],
 invalid_date:['date','invalid_date'],future_date:['date','invalid_date'],invalid_time:['time','invalid_time'],unknown_in_out_code:['in_out','unknown_type'],
 missing_value:['row','missing_value'],line_too_short:['row','missing_value'],not_employed_on_date:['card','not_employed'],
 day_corrected:['date','period_closed'],period_closed:['date','period_closed'],uncoded_on_clocked_day:['date','period_closed'],other:['row','other'],
});
async function attendanceClockings(ctx:SessionContext,file:ChatImportFile,sourceHash:string):Promise<ChatImportPreview>{
 const preview=await validateClockingImport(ctx,{mappingId:BUILTIN_MAPPING_ID,text:file.text});
 const issues=preview.errorRows.map(line=>{const [field,reason]=CLOCKING_ISSUE[line.result]??CLOCKING_ISSUE.other;return issue(line.lineNo,field,reason);});
 const {total,valid}=preview.counts;
 return Object.freeze({kind:'attendance_clockings' as const,total,ready:valid,attention:Math.max(0,total-valid),warned:0,issues:Object.freeze(issues),confirmable:valid>0,sourceHash});
}

/** Runs the kind's own preview as the caller. Throws what the owner throws (no access, module off, unreadable file). */
export async function previewChatImport(ctx:SessionContext,input:Readonly<{kind:ChatImportKind;companyId:string;file:ChatImportFile;operationKey:string}>):Promise<ChatImportPreview>{
 const sourceHash=sourceHashOf(input.file.text);
 switch(input.kind){
  case 'leave_balances':return leaveBalances(ctx,input.file,sourceHash);
  case 'employee_records':return employeeRecords(ctx,input.companyId,input.file,sourceHash);
  case 'payroll_history':return payrollHistory(ctx,input.file,sourceHash,input.operationKey);
  case 'attendance_clockings':return attendanceClockings(ctx,input.file,sourceHash);
 }
}
/** Issue counts by reason, for the model: categories and counts only. */
export function issueCounts(issues:readonly ChatImportRowIssue[]):readonly Readonly<{reason:ChatImportIssue;rows:number}>[]{
 return Object.freeze(CHAT_IMPORT_ISSUES.flatMap(reason=>{const rows=new Set(issues.filter(row=>row.reason===reason).map(row=>row.row)).size;return rows?[Object.freeze({reason,rows})]:[];}));
}
