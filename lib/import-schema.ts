/** Client-safe shape of the employee importer — the column list and result types, with no
 *  server (DB) imports, so both the server service (core/import) and the client UI can use them. */

export type ImportRecord = Record<string, string>;

export type RowResult = {
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

/** Columns the importer recognises. Required ones must be present and non-empty per row.
 *  employee_code is OPTIONAL (38668d9b gives HR the ABILITY to key in an Employee ID, not an
 *  obligation): when the column is absent or a cell is blank, hireEmployee auto-generates the
 *  next code; when supplied it is validated (format + file/tenant uniqueness). */
export const IMPORT_COLUMNS = {
  required: ['full_name', 'email', 'department', 'hired_on', 'ic_number', 'basic_salary'],
  optional: [
    // d8471481 — ONE FILE, MANY COMPANIES. Blank (or the column absent) keeps the old behaviour
    // exactly: the row lands in the company selected on screen. When supplied it is matched against
    // the tenant's companies by legal name, company label or registration number, and every catalog
    // lookup for that row (department / position / cost centre) is done against THAT company — which
    // is what makes "Department does not belong to this company" a real check rather than a hope.
    'company',
    'employee_code',
    'phone',
    'position',
    'cost_center',
    'employment_type',
    'monthly_allowance',
    'bank_name',
    'bank_account_no',
    'epf_number',
    'socso_number',
    'tax_number',
    'tax_category',
    'num_children',
    'eis_eligible',
    'is_resident',
    'epf_citizenship',
    // ADR-0078 (642ecc55) — employee-specific salary structure. All optional: blank = monthly / monthly /
    // no rate (the setCompensation defaults). pay_mode daily|hourly REQUIRES a positive rate_amount.
    'pay_mode',
    'payment_term',
    'rate_amount',
    // r369 (item eb949191) — THE CONFIRMATION GESTURE, CARRIED BY THE FILE.
    //
    // A basic salary of 0 is legal now: a Director paid quarterly Director Fees has no monthly basic, and
    // `core/comp.ts` accepts such a record on ONE condition — whoever saves it types a remark saying why
    // (`SalaryRemarkRequiredError`). That sentence is the whole thing that tells a deliberate zero from a
    // mistyped one, months before any payroll run reads either, and the kernel never reads it to decide
    // money.
    //
    // WITHOUT A COLUMN FOR IT the condition was unmeetable by anybody importing, so the reporter's own
    // Director — onboarded by file, like the rest of their workforce — failed their row on a refusal the
    // file had no way to answer. Nothing about the refusal is weakened here and NO remark is written on
    // the operator's behalf: the file states the reason, or the row is refused with this column named.
    //
    // OPTIONAL, and that is the scope fence. A row with a positive basic never has to carry it, a file
    // that has no such column imports exactly as it did, and a blank cell reaches `setCompensation` as
    // `undefined` — which stores `null` and logs no `remarks` field change, byte-identical to the call
    // this importer made before r369.
    'salary_remarks',
    // ── Item 2983802f — the seven blocks the template had no columns for at all. EVERY ONE IS OPTIONAL,
    //    and that is the scope fence: a file that imports today imports unchanged tomorrow.
    //
    // Passport Information (employee_statutory_my). All-or-nothing on the trio, exactly as the Personnel
    // card enforces it: number + issue + expiry together, or none of them. Issuing country is optional.
    'passport_number',
    'passport_issue_date',
    'passport_expiry_date',
    'passport_issuing_country',
    // Contact & Address — the employee's HOME address. Written to the PERMANENT block on `person`, which
    // is what the Contact & Address card maintains (the flat legacy block is rollback history only).
    // `state` / `country` are validated against the tenant's profile_option catalog, so a typo is a
    // per-row error at preview rather than a failure at write.
    'address_line_1',
    'address_line_2',
    'address_line_3',
    'postcode',
    'city',
    'state',
    'country',
    // Emergency Contact — ONE contact per employee row, filed as Primary. The register holds several;
    // a second one is added on the card afterwards (see the parity test's exclusion note).
    'emergency_contact_name',
    'emergency_contact_relationship',
    'emergency_contact_phone',
    'emergency_contact_home_phone',
    'emergency_contact_address',
    // Probation Information. `probation_end_date` is the employment's provisional end date, which IS the
    // probation end for a full-time hire — it is refused for any other employment type, because for a
    // contract or an internship that same column means the end of the contract.
    'probation_end_date',
    'probation_months',
    'probation_days',
    'confirmation_date',
    // Notice Period Information — the contractual policy the Employment tab maintains.
    'resignation_notice_months',
    'resignation_notice_days',
    // Direct Superior — an Employee ID (or work email) naming the administrative manager. FORWARD
    // REFERENCES ARE LEGAL: the superior may appear further down the same file, so this is resolved
    // after every employee row is staged, never row by row (see core/import.ts).
    'direct_superior',
  ],
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
export const DEPENDENT_IMPORT_COLUMNS = {
  required: ['employee_code', 'full_name', 'relationship'],
  optional: [
    'date_of_birth',
    'gender',
    'ic_or_passport',
    'passport_number',
    'phone',
    'is_beneficiary',
    'remarks',
  ],
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
