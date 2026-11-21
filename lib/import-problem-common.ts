/**
 * Board d3ba1e9f — what every Personnel Management import adapter (Everything, Profile, Family, Qualifications,
 * Emergency Contacts) shares when it turns its own validation result into ImportProblemLine rows: the Excel row,
 * the sensitive-value rule, the plain-language problem for system errors and NRIC policy refusals, and the common
 * corrections. Client-safe (no database, no React, no server-only imports): the check screen, the result screen and
 * the Import History download all call the same functions, which is what keeps the screen and the Error Log equal.
 */
import {HIDDEN_VALUE,boundProblemValue,type ImportProblemLine} from './import-problem-lines';
import {nricPolicyMessage} from './nric-policy-message';
import {parseDatabaseErrorRef} from './database-error-token';
import {parseStrictPersonnelCsvWithSource,PERSONNEL_CSV_FRAME} from './personnel-csv';
import {personnelColumnLabel,personnelImportField,type PersonnelImportSheet} from './personnel-import-contract';
import type {ImportIssue} from './import-schema';

/**
 * The translators an adapter receives — the shape of the Import History registry's `t`:
 *  - `problems`: the ROOT translator (full keys, e.g. 'importErrorLogEmployee.correction.date',
 *    'peopleGeneral.duplicate', 'common.databaseError.system'). Client: useTranslations(); server:
 *    getTranslations({locale}).
 *  - `shared`: the importProblems translator (useTranslations('importProblems') / getTranslations({locale,
 *    namespace:'importProblems'})), the same one the table and the workbook use.
 */
export type ImportProblemTranslate={problems:(key:string,values?:Record<string,unknown>)=>string;shared:(key:string)=>string};

/** The row as Excel numbers it, from the captured sheet rows (index = data row - 1), else data row + 1 (header). */
export function excelRowOf(rows:readonly number[]|undefined,rowNum:number):number{
 const captured=rows?.[rowNum-1];
 return typeof captured==='number'&&Number.isSafeInteger(captured)&&captured>rowNum?captured:rowNum+1;
}
/** A line's row: the recorded Excel row when the row carries one, otherwise data row + 1 (older history entries). */
export const lineRowOf=(row:{rowNum:number;excelRow?:number|null})=>typeof row.excelRow==='number'&&row.excelRow>0?row.excelRow:row.rowNum+1;

/** Excel rows of the data records of a CSV text (header and an optional Personnel frame row skipped; blank lines
 *  counted as Excel counts them). Used when no workbook rows were captured: a CSV file opened in Excel numbers
 *  its lines exactly so. */
export function csvDataExcelRows(text:string):number[]{
 try{
  const {rows,rowNumbers}=parseStrictPersonnelCsvWithSource(text);
  const skip=rows[0]?.[0]===PERSONNEL_CSV_FRAME?2:1;
  return rowNumbers.slice(skip);
 }catch{return[];}
}

/** Sheets of the Everything workbook whose Excel rows travel with the check and the import. */
export const IMPORT_SOURCE_ROW_SHEETS=['employee','family','qualification','emergency','allocations'] as const;
export type ImportSourceRowSheet=typeof IMPORT_SOURCE_ROW_SHEETS[number];
export type ImportSourceRows=Partial<Record<ImportSourceRowSheet,number[]>>;
/** Bound and type-check client-supplied rows: positive, strictly increasing integers, at most 20,000 per sheet. A
 *  sheet whose list does not match the parsed record count is dropped (the data-row fallback applies). */
export function sanitizeImportSourceRows(raw:unknown,counts?:Partial<Record<ImportSourceRowSheet,number>>):ImportSourceRows{
 const out:ImportSourceRows={};
 if(!raw||typeof raw!=='object')return out;
 for(const sheet of IMPORT_SOURCE_ROW_SHEETS){
  const list=(raw as Record<string,unknown>)[sheet];
  if(!Array.isArray(list)||list.length>20000)continue;
  if(!list.every((n,i)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>1&&(i===0||n>(list[i-1] as number))))continue;
  if(counts&&counts[sheet]!==undefined&&counts[sheet]!==list.length)continue;
  out[sheet]=list as number[];
 }
 return out;
}

/**
 * Values the Error Log never repeats: identity and passport numbers, bank, statutory and pay columns (the
 * personnel field registry's bank, payroll, statutory and restricted sensitivity, plus identity-number columns).
 * Full name and Employee ID are not hidden. Unknown columns that look like pay, bank or statutory numbers are
 * hidden too, so an unregistered column errs on the safe side.
 */
export function isHiddenImportColumn(column:string|undefined,sheet:PersonnelImportSheet='employee'):boolean{
 if(!column)return false;
 if(/(^|_)(ic|nric|passport|old_ic)(_|$)|ic_or_passport|identity/i.test(column))return true;
 const field=personnelImportField(column,sheet);
 if(field)return['bank','payroll','statutory','restricted'].includes(field.sensitivity);
 return /salary|allowance|rate_amount|bank|account|epf|socso|eis|tax_number|pcb|zakat|hrdf/i.test(column);
}

/** The field caption as the template header shows it, in the viewer's language. */
export function importFieldCaption(column:string|undefined,sheet:PersonnelImportSheet,t:ImportProblemTranslate):string|undefined{
 if(!column)return undefined;
 const resolve=(key:string,fallback:string)=>{try{const text=t.problems(key);return text&&text!==key?text:fallback;}catch{return fallback;}};
 return personnelColumnLabel(column,sheet,resolve);
}

/** The cell value for a line: hidden for a sensitive column, otherwise the recorded value (bounded). */
export function importLineValue(column:string|undefined,value:string|undefined,sheet:PersonnelImportSheet):ImportProblemLine['value']{
 if(isHiddenImportColumn(column,sheet))return value===undefined||value===''?undefined:HIDDEN_VALUE;
 return value===undefined||value===''?undefined:boundProblemValue(value);
}

/**
 * The problem in the viewer's words, and its support reference: NRIC policy refusals and redacted database errors
 * (lib/public-error.ts) in the viewer's language; every other recorded sentence as it is today. For a sensitive
 * column, any quoted value inside the sentence (e.g. Invalid IC "...") is replaced by the hidden-value marker.
 */
export function importProblemText(message:string,t:ImportProblemTranslate,hideQuoted=false):{problem:string;errorReference?:string;system:boolean}{
 const db=parseDatabaseErrorRef(message);
 if(db)return{problem:t.problems(`common.databaseError.${db.kind}`,{ref:db.ref}),errorReference:db.ref,system:db.kind==='system'||db.kind==='busy'};
 const policy=nricPolicyMessage(message,key=>t.problems(`peopleGeneral.${key}`));
 if(policy!==message)return{problem:policy,system:false};
 return{problem:hideQuoted?message.replace(/"[^"]*"/g,`"${t.shared('hiddenValue')}"`):message,system:false};
}

/** Correction keys under importErrorLogEmployee.correction (all six locales). */
export const IMPORT_CORRECTION_KEYS=['reference','date','month','required','requiredForContract','duplicateInFile','duplicateEmployeeId','duplicateInSystem','number','choice','yesNo','email','notOnEmployeeSheet','employeeNotFound','missingColumn','wrongSection','system','uploadAgain'] as const;
export type ImportCorrectionKey=typeof IMPORT_CORRECTION_KEYS[number];

/** The common correction for an issue code (codes are set where the issue is raised, never parsed from text). */
export function importCorrectionKey(code:string|undefined,column?:string):ImportCorrectionKey|undefined{
 if(!code)return undefined;
 if(code==='unknown_reference')return'reference';
 if(code==='invalid_date')return'date';
 if(code==='invalid_month')return'month';
 if(code==='required')return'required';
 if(code==='contract.required')return'requiredForContract';
 if(code==='duplicate_in_file')return column==='employee_code'?'duplicateEmployeeId':'duplicateInFile';
 if(code==='duplicate_in_system')return'duplicateInSystem';
 if(code==='invalid_number')return'number';
 if(code==='invalid_choice')return'choice';
 if(code==='yes_no')return'yesNo';
 if(code==='invalid_email')return'email';
 if(code==='not_on_employee_sheet')return'notOnEmployeeSheet';
 if(code==='employee_not_found')return'employeeNotFound';
 if(code==='missing_column')return'missingColumn';
 if(code==='wrong_section')return'wrongSection';
 return undefined;
}
export function importCorrectionText(key:ImportCorrectionKey|undefined,t:ImportProblemTranslate,values:{field?:string}={}):string|undefined{
 if(!key)return undefined;
 return t.problems(`importErrorLogEmployee.correction.${key}`,{field:values.field||t.problems('importErrorLogEmployee.thisField')});
}

/** The issues of a row: its recorded issue list when present, else one issue per plain message (older rows). */
export function issuesOf(row:{errors?:readonly string[];issues?:readonly ImportIssue[]}):ImportIssue[]{
 return Array.isArray(row.issues)&&row.issues.length?[...row.issues]:(row.errors??[]).map(message=>({message}));
}

/**
 * One problem line from one issue. Shared by every Personnel adapter so the field caption, the hidden value, the
 * problem text, the correction and the system reference are decided once.
 */
export function issueProblemLine(issue:ImportIssue,base:{sheet?:string;row:number|null;reference?:string;employeeName?:string;stage:ImportProblemLine['stage'];result:ImportProblemLine['result']},sheet:PersonnelImportSheet,t:ImportProblemTranslate):ImportProblemLine{
 const hidden=isHiddenImportColumn(issue.column,sheet);
 const text=importProblemText(issue.message,t,hidden);
 const field=importFieldCaption(issue.column,sheet,t);
 const correction=text.errorReference?importCorrectionText('system',t):importCorrectionText(importCorrectionKey(issue.code,issue.column),t,{field});
 const value=importLineValue(issue.column,issue.value,sheet);
 return{...(base.sheet?{sheet:base.sheet}:{}),row:base.row,...(base.reference?{reference:base.reference}:{}),...(base.employeeName?{employeeName:base.employeeName}:{}),
  ...(field?{field}:{}),...(value!==undefined?{value}:{}),problem:text.problem,...(correction?{correction}:{}),
  stage:text.system?'system':base.stage,result:base.result,...(text.errorReference?{errorReference:text.errorReference}:{})};
}
