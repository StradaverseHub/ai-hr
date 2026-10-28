import type {RegisterPreview} from './personnel-register-import';
import { PERSONNEL_FIELDS, PERSONNEL_IMPORT_COMPATIBILITY } from './personnel-field-registry';
/** Client-safe shape of the employee importer — the column list and result types, with no
 *  server (DB) imports, so both the server service (core/import) and the client UI can use them. */

export type ImportRecord = Record<string, string>;

export type RowResult = {
  proposed?:{column:string;value:string}[];
  rowNum: number; // 1-based data row (header excluded)
  fullName: string;
  email: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Resolved company for THIS row (d8471481) — the `company` cell when supplied, otherwise the
   *  screen's target company. Shown in the preview so a multi-company file is auditable before
   *  anything is written. Empty when the cell named a company that could not be resolved. */
  company: string;
};

export type ImportPreview = {
  allocations?:import('./cost-allocation-import').AllocationImportPreview;
  registers?:RegisterPreview[];
  companyId: string;
  total: number;
  validCount: number;
  rows: RowResult[];
  missingColumns: string[];
  /**
   * Item 2983802f — WHOLE-FILE refusals, as opposed to the per-row errors above.
   *
   * A per-row error skips that row and imports the rest, which is right when one person's IC is wrong.
   * It is the wrong answer when the FILE is internally inconsistent — a family sheet naming an employee
   * who is not in it. There, importing "the rest" means loading a workforce with a silent hole in it, so
   * this list exists and, when it is non-empty, nothing at all is written. `commitEmployeeImport`
   * re-derives it server-side and refuses; the screen disables the Import button and says why.
   */
  fileErrors: string[];
  /** The family sheet's own row set (item 2983802f). Zero rows when the upload carried no Family sheet. */
  dependents: DependentPreview;
};

export type ImportResult = {
  registersImported?:{qualification:number;emergency:number};
  warnings?:string[];
  companyId: string;
  imported: number;
  failed: { rowNum: number; email: string; message: string }[];
  skipped: number;
  /** Item 2983802f — family members created alongside the employees, from the Family sheet. */
  dependentsImported: number;
  /**
   * Item 2983802f — rows whose employee WAS created but whose Direct Superior link was not.
   *
   * Deliberately NOT folded into `failed`, which means "this person is not in the system". These people
   * ARE in the system; one field on them is missing, and saying otherwise would send HR looking for an
   * employee who exists. The superior is resolved during the dry run, so this only fills on a genuine
   * write-time refusal (a reporting cycle the file did not contain).
   */
  superiorFailed: { rowNum: number; email: string; message: string }[];
  /**
   * Item 2983802f — the file was refused whole (see `ImportPreview.fileErrors`). Nothing was written;
   * every count above is zero.
   */
  fileErrors: string[];
  /** cf43c909 — the history row this run wrote, so the screen can link straight to it. Null when the
   *  history write itself failed: recording a run must never fail an import that already happened. */
  runId?: string | null;
  /** 524303d9 — the Import History attempt (ADR-0155 kind `employee_full`); null for a system context. */
  attemptId?: string | null;
};

/** cf43c909 — one rejected row, as stored on an import run and as re-exported to the error report.
 *  IDENTITY + REASON only: never the row's IC, bank account, statutory numbers or salary. */
export type ImportRunError = {
  rowNum: number;
  fullName: string;
  email: string;
  errors: string[];
};

/** cf43c909 — one past import, for the Import History list. `outcome` is DERIVED from the counts
 *  (see `importRunOutcome`), never stored, so no status can disagree with the numbers beside it. */
export type ImportRunRow = {
  id: string;
  companyId: string | null;
  companyName: string | null;
  /** Display name of whoever ran it; null when the actor had no person row (operator / support login). */
  actorName: string | null;
  /** '' when the CSV was pasted rather than uploaded. */
  fileName: string;
  totalRows: number;
  importedRows: number;
  failedRows: number;
  errors: ImportRunError[];
  /** More rows failed than `errors` holds — the list is a sample, not the whole story. */
  errorsTruncated: boolean;
  /** ISO timestamp; formatted in the browser's locale by the client island. */
  createdAt: string;
};

/**
 * "Did it succeed?" — derived, in ONE place, so the list, the badge and any future report agree.
 *   succeeded — nothing in the file was wrong: every row that had work to do was done.
 *   partial   — some rows went in, some did not.
 *   failed    — rows were rejected and none went in (an all-rejected file, or an empty one).
 *
 * 2983802f — WHY "IMPORTED NOTHING" IS NOT THE SAME AS "FAILED". The per-section importer UPDATES
 * people who already exist, so its most ordinary happy path is a file every row of which is already
 * correct: `importedRows` 0, `failedRows` 0, nothing wrong with any of it. Keying the badge on
 * `importedRows === 0` alone painted that run red. The question the badge answers is "did anything go
 * wrong?", and the honest answer to a run with no failures is no — a file with no rows at all is the
 * one case where nothing having happened really is a failure.
 */
export function importRunOutcome(r: {
  importedRows: number;
  failedRows: number;
  totalRows?: number;
}): 'succeeded' | 'partial' | 'failed' {
  if (r.importedRows > 0) return r.failedRows === 0 ? 'succeeded' : 'partial';
  if (r.failedRows > 0) return 'failed';
  return (r.totalRows ?? 0) > 0 ? 'succeeded' : 'failed';
}

/** Columns the importer recognises. Required columns come from the shared Personnel declaration. Conditional salary/identity rules are validated by their owners.
 *  employee_code is OPTIONAL (38668d9b gives HR the ABILITY to key in an Employee ID, not an
 *  obligation): when the column is absent or a cell is blank, hireEmployee auto-generates the
 *  next code; when supplied it is validated (format + file/tenant uniqueness). */
// 0db97f14 — `updateOnly` marks a column a section writer owns but the create path does not write. 524303d9
// cleared it from every Bank & Statutory setting: "Everything — new employees" writes them in the hire transaction.
const employeeFields=PERSONNEL_FIELDS.filter(field=>field.import.column && field.import.section!=='family' && !field.import.updateOnly);
export const IMPORT_COLUMNS = {
  required: [...new Set(employeeFields.filter(field=>field.import.requiredCreate).map(field=>field.import.column!))],
  optional: [...new Set([...employeeFields.filter(field=>!field.import.requiredCreate).map(field=>field.import.column!),...PERSONNEL_IMPORT_COMPATIBILITY.map(adapter=>adapter.column)])],
} as const;

/**
 * Item 2983802f — THE FAMILY SHEET.
 *
 * One employee has any number of family members, so family cannot be flat columns on the employee row
 * without inventing a cap ("spouse, child 1, child 2, child 3…" and a support ticket the first time
 * someone has four children). It is a SECOND SHEET in the same workbook, keyed to the employee row by
 * Employee ID, validated as its own row set, and loaded in the same import run.
 *
 * TWO RULES DECIDED AND WRITTEN DOWN HERE, because both are the kind of thing that silently corrupts a
 * load if left to chance:
 *
 *  1. AN UNMATCHED EMPLOYEE ID REJECTS THE WHOLE FILE. If the family sheet names an Employee ID that the
 *     employee sheet does not carry, nothing at all is imported — not the employees, not the family. The
 *     alternative (import the employees, drop the orphan family rows) leaves a workforce loaded and a
 *     silent hole in it that nobody discovers until an insurance claim. A rejected file is fixed in Excel
 *     in a minute; a half-loaded one is found months later.
 *  2. AN EMPLOYEE ROW WITH NO EMPLOYEE ID CANNOT HAVE FAMILY. The link is the Employee ID column, and it
 *     is optional on the employee sheet (blank = the system issues one). A row that leaves it blank has
 *     nothing for the family sheet to point at, so a family row naming it is an unmatched ID — rule 1.
 *
 * The sheet is only readable from a real workbook: a CSV file is one sheet by definition, so a CSV upload
 * carries employees only. That is stated on the template's Instructions sheet rather than left to be
 * discovered.
 */
const familyFields=PERSONNEL_FIELDS.filter(field=>field.import.section==='family' && field.import.column);
export const DEPENDENT_IMPORT_COLUMNS = {
  required:['employee_code',...familyFields.filter(field=>field.import.requiredCreate).map(field=>field.import.column!)],
  optional:familyFields.filter(field=>!field.import.requiredCreate).map(field=>field.import.column!),
} as const;

/** One validated row of the family sheet, mirroring `RowResult`'s shape for the employee sheet. */
export type DependentRowResult = {
  /** 1-based data row of the FAMILY sheet (header excluded). */
  rowNum: number;
  /** The Employee ID this family member is linked to, as typed. */
  employeeCode: string;
  fullName: string;
  relationship: string;
  ok: boolean;
  errors: string[];
};

/** The family sheet's half of a preview. Absent columns are reported like the employee sheet's. */
export type DependentPreview = {
  total: number;
  validCount: number;
  rows: DependentRowResult[];
  missingColumns: string[];
};

/** Prior compound columns are read for one generation but never emitted by new templates. */
export const RETIRED_PERSONNEL_TEMPLATE_COLUMNS:readonly string[]=['probation_months','probation_days','resignation_notice_months','resignation_notice_days'];
export const EMPLOYEE_TEMPLATE_COLUMNS={required:IMPORT_COLUMNS.required,optional:IMPORT_COLUMNS.optional.filter(column=>!RETIRED_PERSONNEL_TEMPLATE_COLUMNS.includes(column))};
