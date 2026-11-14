/**
 * Board d3ba1e9f (stage f) — the Movement import's ONE Error Log adapter: the check screen's preview, the result
 * screen and the Import History entry all become ImportProblemLine rows here, and the on-screen table
 * (ImportProblemTable) and the downloaded Error Log (.xlsx) are both drawn from those rows, so they say the same thing.
 * Client-safe (no database, no React, no server-only imports).
 *
 * Wording: the problem is movementImportIssueText — the sentence the Movement screen already shows, including its
 * %date%/%detail% handling. When an issue code's detail names a field or a column (`required:positionId`,
 * `unknown_column:Grade`), that field goes to the Field column instead of being appended to the sentence.
 *
 * Rows: a movement may span several sheet rows (one per System Field); a line points at the movement's FIRST sheet
 * row, exactly as Excel numbers it (lib/movement-workbook.server.ts and readMovementCsvRows count the header as row
 * 1). Whole-file problems have no row.
 *
 * Results: Movement saves each employee's movements together or not at all.
 *  - check: a row the check refused is 'refused'; a valid row held back only because another row of the same
 *    employee was refused (employee_sequence_invalid) is 'cancelled';
 *  - save: a row of an employee whose save was refused is 'stopped' (nothing of that employee was saved).
 *
 * Values: the entered value is shown where the row carries it (Employee ID, Company ID, Effective Date, Event Type,
 * Movement Event ID, an unknown System Field name). Pay, bank, statutory and restricted fields (basic salary,
 * increment amount, currency, pay mode ...) are never repeated: their value is HIDDEN_VALUE.
 */
import {HIDDEN_VALUE,boundProblemValue,type ImportProblemLine} from './import-problem-lines';
import {movementImportFieldLabel,movementImportIssueText} from './movement-import-issues';
import {movementColumnCaption,type MovementColumn} from './movement-import-rows';
import {MOVEMENT_FORM_IDS} from './movement-form-contract';
import {personnelFormField} from './personnel-form-contract';
import {parseDatabaseErrorRef} from './database-error-token';
import type {MovementImportEmployee,MovementImportPreview,MovementImportResult,MovementImportRow} from './movement-import-contract';
import type {PersonnelLabelResolver} from './personnel-import-contract';

/** What the adapter needs of a movement row (a preview/result row, or one recorded on the Import History plan). */
export type MovementProblemRow=Pick<MovementImportRow,'row'|'employeeCode'|'eventType'|'effectiveDate'|'status'|'errors'>&Partial<Pick<MovementImportRow,'source'|'companyCode'|'movementId'|'proposed'>>;

/** The rows of a check the Import History plan keeps for its Error Log: only rows with a problem, only these keys. */
export function movementRecordedProblemRows(rows:readonly MovementImportRow[]):MovementProblemRow[]{
 return rows.filter(r=>r.errors.length).map(r=>({row:r.row,employeeCode:r.employeeCode,eventType:r.eventType,effectiveDate:r.effectiveDate,status:r.status,errors:[...r.errors],
  ...(r.source?{source:{sheet:r.source.sheet,row:r.source.row}}:{}),...(r.companyCode!==undefined?{companyCode:r.companyCode}:{}),...(r.movementId?{movementId:r.movementId}:{})}));
}

/** A resolver over a ROOT translator that may not offer `has` (the Import History registry's `t.problems`). */
export function movementProblemResolver(problems:(key:string)=>string):PersonnelLabelResolver{
 return (key,fallback)=>{try{const text=problems(key);return text&&text!==key?text:fallback;}catch{return fallback;}};
}

/** Corrections under importErrorLogMovement.correction (all six locales). English fallbacks keep a missing catalogue readable. */
const CORRECTIONS={
 date:'Enter the date as DD-MMM-YYYY (for example 06-Jan-2026) or as an Excel date.',
 required:'Fill in this field - this event type requires it.',
 chooseCompany:'Choose a Company ID from the Reference sheet.',
 eventType:'Choose an active Event Type from the drop-down list.',
 chooseReference:'Choose a value from the drop-down list or the Reference sheet.',
 employeeId:'Check the Employee ID and the Company ID on this row against Personnel.',
 systemField:'Choose a System Field that this event type can change (see the Reference sheet), or remove that row.',
 duplicateField:'Keep one row for each System Field of a movement.',
 number:'Enter a number (digits only, no currency sign).',
 noFormula:'Type the value itself, not a formula.',
 movementId:'Copy the Movement Event ID from the employee’s Movement history.',
 before:'Enter the value now on the employee’s record as Before, or download a new template.',
 otherRows:'Correct the other rows of this employee, then upload the whole file again.',
 recheck:'Upload the file again so it is checked against the current records.',
 template:'Download the current Movement template, copy your rows into it and upload it again.',
 splitFile:'Split the file into smaller files (at most 200 rows, 50 employees and 20 rows per employee) and upload each one.',
 saveStopped:'Nothing was saved for this employee. Correct the problem, then import this employee again.',
} as const;
export type MovementCorrectionKey=keyof typeof CORRECTIONS;
export const MOVEMENT_CORRECTION_KEYS=Object.keys(CORRECTIONS) as MovementCorrectionKey[];
export const movementCorrectionText=(key:MovementCorrectionKey,resolve:PersonnelLabelResolver)=>resolve('importErrorLogMovement.correction.'+key,CORRECTIONS[key]);

/** Issue code -> the template column it is about (when the code itself carries no field) and its common correction. */
const CODES:Record<string,{column?:MovementColumn;correction?:MovementCorrectionKey}>={
 invalid_employee_code:{column:'employeeId',correction:'employeeId'},
 employee_not_found_in_selected_company:{column:'employeeId',correction:'employeeId'},
 movement_id_other_employee:{column:'movementId',correction:'employeeId'},
 company_required:{column:'companyId',correction:'chooseCompany'},
 company_unknown:{column:'companyId',correction:'chooseCompany'},
 company_ambiguous:{column:'companyId',correction:'chooseCompany'},
 company_not_available:{column:'companyId',correction:'chooseCompany'},
 workbook_company_mismatch:{correction:'template'},
 event_type_required:{column:'eventType',correction:'eventType'},
 unknown_or_inactive_event_type:{column:'eventType',correction:'eventType'},
 invalid_effective_date:{column:'effectiveDate',correction:'date'},
 blacklist_date_must_be_today:{column:'effectiveDate'},
 movement_before_current_record:{column:'effectiveDate'},
 movement_before_join_date:{column:'effectiveDate'},
 event_before_hire:{column:'effectiveDate'},
 event_after_exit:{column:'effectiveDate'},
 backdated_over_three_months:{column:'effectiveDate'},
 movement_history_future:{column:'effectiveDate'},
 movement_history_earlier_change:{column:'effectiveDate'},
 movement_history_splits_movement:{column:'effectiveDate'},
 system_field_required:{column:'systemField',correction:'systemField'},
 unknown_system_field:{column:'systemField',correction:'systemField'},
 not_applicable:{correction:'systemField'},
 movement_field_not_included:{correction:'systemField'},
 duplicate_system_field:{column:'systemField',correction:'duplicateField'},
 unknown_action:{column:'action'},
 movement_id_required:{column:'movementId',correction:'movementId'},
 movement_id_unknown:{column:'movementId',correction:'movementId'},
 movement_id_not_for_create:{column:'movementId'},
 duplicate_movement_id:{column:'movementId'},
 reason_required:{column:'reason'},
 reason_not_for_create:{column:'reason'},
 required:{correction:'required'},
 invalid_date:{correction:'date'},
 invalid_number:{correction:'number'},
 invalid_choice:{correction:'chooseReference'},
 unknown_reference:{correction:'chooseReference'},
 ambiguous_reference:{correction:'chooseReference'},
 movement_label_other_company:{correction:'chooseReference'},
 before_mismatch:{correction:'before'},
 formula_input:{correction:'noFormula'},
 employee_sequence_invalid:{correction:'otherRows'},
 employee_changed:{correction:'recheck'},
 preview_stale_revalidate:{correction:'recheck'},
 change_refused:{correction:'recheck'},
 extra_cells:{correction:'template'},
 unknown_column:{correction:'template'},
 missing_column:{correction:'template'},
 duplicate_headers:{correction:'template'},
 malformed_csv:{correction:'template'},
 empty_file:{correction:'template'},
 invalid_file:{correction:'template'},
 workbook_old_layout:{correction:'template'},
 workbook_columns_changed:{correction:'template'},
 workbook_catalogue_changed:{correction:'template'},
 workbook_metadata_invalid:{correction:'template'},
 workbook_structure_invalid:{correction:'template'},
 workbook_damaged:{correction:'template'},
 workbook_unexpected_sheet:{correction:'template'},
 workbook_identity_changed:{correction:'template'},
 file_too_large:{correction:'splitFile'},
 workbook_too_large:{correction:'splitFile'},
 too_many_rows:{correction:'splitFile'},
 too_many_employees:{correction:'splitFile'},
 too_many_employee_rows:{correction:'splitFile'},
 movement_import_timeout:{correction:'splitFile'},
};
/** Details that are a template column rather than a System Field. */
const DETAIL_COLUMNS:Record<string,MovementColumn>={event_type:'eventType',kind:'eventType',employee_code:'employeeId',employeeCode:'employeeId',effectiveDate:'effectiveDate'};
const OTHER_FIELDS=new Set(['incrementAmount','parentCompany']);
const HIDDEN_SENSITIVITY=new Set(['bank','payroll','statutory','restricted']);

/** Whether a movement System Field's value must not be repeated (pay, bank, statutory and restricted fields). */
export function movementFieldHidden(field:string):boolean{
 if(field==='incrementAmount')return true;
 if(!(field in MOVEMENT_FORM_IDS))return false;
 try{return HIDDEN_SENSITIVITY.has(personnelFormField(MOVEMENT_FORM_IDS[field as keyof typeof MOVEMENT_FORM_IDS]).sensitivity);}catch{return true;}
}
const isFieldKey=(detail:string,resolve:PersonnelLabelResolver)=>detail in MOVEMENT_FORM_IDS||OTHER_FIELDS.has(detail)||!!resolve('people.import.movement.currentFields.'+detail,'');

type Base={sheet?:string;row:number|null;reference?:string;employeeName?:string;stage:ImportProblemLine['stage'];result:ImportProblemLine['result']};

/** One line per distinct issue (codes may arrive joined with "; ", as movementImportIssueText accepts them). */
function issueLines(errors:readonly string[],base:Base,row:MovementProblemRow|null,resolve:PersonnelLabelResolver):ImportProblemLine[]{
 const parts=[...new Set(errors.flatMap(issue=>issue.split('; ')))].filter(Boolean);
 return parts.map(part=>{
  const [code,...rest]=part.split(':'),detail=rest.join(':');
  const translated=resolve('people.import.movement.issues.'+code,'');
  const placeholder=translated.includes('%date%')||translated.includes('%detail%');
  const known=CODES[code];
  let column=known?.column,fieldKey:string|undefined,field:string|undefined,value:ImportProblemLine['value'],text=part;
  if(detail&&!placeholder){
   if(code==='unknown_system_field'){value=boundProblemValue(detail);text=code;}
   else if(code==='unknown_column'||code==='missing_column'){field=detail;text=code;}
   else if(DETAIL_COLUMNS[detail]){column=DETAIL_COLUMNS[detail];text=code;}
   else if(isFieldKey(detail,resolve)){fieldKey=detail;column=undefined;text=code;}
  }
  if(fieldKey){
   field=movementImportFieldLabel(fieldKey,resolve);
   const entered=row?.proposed?.[fieldKey];
   if(entered)value=movementFieldHidden(fieldKey)?HIDDEN_VALUE:boundProblemValue(entered);
  }else if(column&&!field){
   field=movementColumnCaption(column,resolve);
   if(value===undefined&&row){
    const entered=column==='employeeId'?row.employeeCode:column==='companyId'?row.companyCode:column==='effectiveDate'?row.effectiveDate:column==='movementId'?row.movementId:
     column==='eventType'&&code!=='event_type_required'?row.eventType:undefined;
    if(entered)value=boundProblemValue(entered);
   }
  }
  const result:ImportProblemLine['result']=base.stage==='check'&&code==='employee_sequence_invalid'?'cancelled':base.result;
  const common:MovementCorrectionKey|undefined=column==='eventType'&&known?.correction==='chooseReference'?'eventType':known?.correction;
  const correctionKey:MovementCorrectionKey|undefined=base.stage==='save'?(common==='recheck'||!common?'saveStopped':common):common;
  return{...(base.sheet?{sheet:base.sheet}:{}),row:base.row,...(base.reference?{reference:base.reference}:{}),...(base.employeeName?{employeeName:base.employeeName}:{}),
   ...(field?{field}:{}),...(value!==undefined?{value}:{}),problem:movementImportIssueText(text,resolve),
   ...(correctionKey?{correction:movementCorrectionText(correctionKey,resolve)}:{}),stage:base.stage,result};
 });
}

function rowLines(row:MovementProblemRow,employee:Pick<MovementImportEmployee,'employeeCode'|'name'>|null,errors:readonly string[],stage:ImportProblemLine['stage'],result:ImportProblemLine['result'],resolve:PersonnelLabelResolver){
 const reference=row.employeeCode||employee?.employeeCode||undefined;
 return issueLines(errors,{sheet:row.source?.sheet,row:row.source?.row??row.row,reference,employeeName:employee?.name??undefined,stage,result},row,resolve);
}
const fileLines=(fileErrors:readonly string[],resolve:PersonnelLabelResolver)=>issueLines(fileErrors,{row:null,stage:'file',result:'refused'},null,resolve);

/** The check screen: whole-file problems first, then every row the check refused (and the rows held back with them). */
export function movementPreviewProblemLines(preview:Pick<MovementImportPreview,'fileErrors'|'employees'>,resolve:PersonnelLabelResolver):ImportProblemLine[]{
 const lines=fileLines(preview.fileErrors,resolve);
 for(const employee of preview.employees)for(const row of employee.rows)if(row.errors.length)lines.push(...rowLines(row,employee,row.errors,'check','refused',resolve));
 return lines;
}

/**
 * The result screen: rows of an employee whose save was refused ('stopped': nothing of that employee was saved), and
 * the rows the check had refused (still not imported). The result keeps a refused row's own reading errors; the check's
 * findings come from the preview when it is still on screen.
 */
export function movementResultProblemLines(result:Pick<MovementImportResult,'employees'>,preview:Pick<MovementImportPreview,'employees'>|null,resolve:PersonnelLabelResolver):ImportProblemLine[]{
 const checked=new Map((preview?.employees??[]).flatMap(e=>e.rows.map(r=>[r.row,r] as const)));
 const lines:ImportProblemLine[]=[];
 for(const employee of result.employees)for(const row of employee.rows){
  if(row.status==='imported')continue;
  if(row.status==='failed'||row.status==='invalid'){if(row.errors.length)lines.push(...rowLines(row,employee,row.errors,'save','stopped',resolve));continue;}
  const errors=row.errors.length?row.errors:checked.get(row.row)?.errors??[];
  if(errors.length)lines.push(...rowLines(row,employee,errors,'check','refused',resolve));
 }
 return lines;
}

/** What an Import History movement attempt recorded (core/movement-import-history.ts MovementImportPlan). */
export type MovementRecordedAttempt={
 /** File problem codes (attempts recorded since this Error Log); older attempts keep only `fileIssues`. */
 fileErrors?:readonly string[];
 /** The plan's issue sentences, as recorded (in the language of whoever checked the file). */
 fileIssues:readonly {reason:string}[];
 employees:readonly {employeeCode:string;name:string|null;rows:readonly number[];valid:boolean;errors:readonly string[];checked?:readonly MovementProblemRow[]}[];
 /** Employees whose save was refused: their failed Import History item (sentence as recorded). */
 saveFailures:readonly {ordinal:number;employeeCode:string;name:string|null;errors:readonly string[]}[];
 /** The confirmation's own refusal (the attempt's last failed event), when it stopped before any employee. */
 failure?:string|null;
};

/** Import History: the attempt's recorded check (per row since this Error Log; per employee before) and save results. */
export function movementHistoryProblemLines(input:MovementRecordedAttempt,resolve:PersonnelLabelResolver):ImportProblemLine[]{
 const lines:ImportProblemLine[]=input.fileErrors?.length?fileLines(input.fileErrors,resolve):
  input.fileIssues.map(issue=>({row:null,problem:issue.reason,stage:'file' as const,result:'refused' as const}));
 if(input.failure){
  const ref=parseDatabaseErrorRef(input.failure);
  lines.push({row:null,problem:input.failure,correction:movementCorrectionText('recheck',resolve),stage:ref?'system':'save',result:'not_saved',...(ref?{errorReference:ref.ref}:{})});
 }
 for(const employee of input.employees){
  if(employee.valid)continue;
  if(employee.checked){for(const row of employee.checked)lines.push(...rowLines(row,employee,row.errors,'check','refused',resolve));continue;}
  // Recorded before this Error Log: one sentence for the employee, against its first row.
  if(employee.errors.length)lines.push({row:employee.rows.length?Math.min(...employee.rows):null,reference:employee.employeeCode||undefined,...(employee.name?{employeeName:employee.name}:{}),
   problem:employee.errors.join('; '),stage:'check',result:'refused'});
 }
 for(const failed of input.saveFailures)lines.push({row:failed.ordinal,reference:failed.employeeCode||undefined,...(failed.name?{employeeName:failed.name}:{}),
  problem:failed.errors.join('; '),correction:movementCorrectionText('saveStopped',resolve),stage:'save',result:'stopped'});
 return lines;
}
