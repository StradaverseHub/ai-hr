/**
 * 3f15ffdb — Client-safe contract for LEAVE HISTORY DATA IMPORT (the migration of past leave RECORDS).
 *
 * No DB imports. The column contract, the header spellings, the key canonicaliser and the per-row
 * result shapes live here so the server service (`core/leave-history-import`), the client screen
 * (`app/admin/leave-config/history-import`) and the downloadable template all read ONE list — the
 * desync lock lib/import-schema.ts and lib/payroll-history-import-schema.ts already apply.
 *
 * ⚠️ NOT THE SAME THING AS `lib/leave-import-schema.ts`, and the two must never be merged. That one is
 * the contract for the BALANCE importer (`core/leave-import.ts` → leave_ledger rows: opening balances,
 * carry-forward, ad-hoc credits). This one is the contract for the RECORD importer
 * (`core/leave-history-import.ts` → leave_request rows). A migration needs both and they count
 * different things; see core/leave-history-import.ts's header for why an imported RECORD deliberately
 * moves no balance.
 *
 * THE TWELVE COLUMNS ARE THE REPORTER'S, IN THE REPORTER'S ORDER. `header` is what the downloadable
 * template writes and what HR sees in Excel; `key` is what the validator reads. They are paired here so
 * the template and the validator cannot drift, and `canonicalColumnKey` below is what closes the gap
 * between the two (parseCsvRecords lower-cases and underscores a header but keeps punctuation, so
 * "Employee No." arrives as `employee_no.`).
 */

/** One column of the upload contract: what the template writes, and what the validator reads it as. */
export type LeaveHistoryColumn = {
  key: string;
  header: string;
  required: boolean;
};

/**
 * The contract, in the ticket's own order. Six are required; the rest are stated-if-known.
 *
 * `entitlement_year` is OPTIONAL on purpose. The ticket asks that it be "a valid year" — not that it be
 * present — and the leave period is configurable per company, so a January record can legitimately
 * belong to the previous entitlement year. An absent value is stored as absent; a value that disagrees
 * with the start date's year is a WARNING, never a rejection (see core/leave-history-import.ts).
 */
export const LEAVE_HISTORY_COLUMNS: readonly LeaveHistoryColumn[] = [
  { key: 'employee_no', header: 'Employee No.', required: true },
  { key: 'leave_reference', header: 'Leave Reference', required: true },
  { key: 'leave_code', header: 'Leave Code', required: true },
  { key: 'entitlement_year', header: 'Entitlement Year', required: false },
  { key: 'leave_start_date', header: 'Leave Start Date', required: true },
  { key: 'leave_end_date', header: 'Leave End Date', required: true },
  { key: 'number_of_day', header: 'Number of Day', required: true },
  { key: 'session', header: 'Session', required: false },
  { key: 'entry_date', header: 'Entry Date', required: false },
  { key: 'submit_date', header: 'Submit Date', required: false },
  { key: 'approved_date', header: 'Approved Date', required: false },
  { key: 'remark', header: 'Remark', required: false },
] as const;

/** The keys a row MUST carry a non-empty value for. Derived, never re-listed. */
export const LEAVE_HISTORY_REQUIRED_KEYS: readonly string[] = LEAVE_HISTORY_COLUMNS.filter(
  (c) => c.required,
).map((c) => c.key);

/**
 * Spellings accepted for a contract key beyond its own canonical form. Deliberately short: these are the
 * three a customer's own export plausibly already uses, not an open-ended synonym dictionary. A header
 * nobody recognises is reported as a missing column, which is a better failure than a silent misread.
 */
const COLUMN_ALIASES: Readonly<Record<string, string>> = {
  employee_id: 'employee_no',
  employee_code: 'employee_no',
  employee_number: 'employee_no',
  number_of_days: 'number_of_day',
  no_of_day: 'number_of_day',
  no_of_days: 'number_of_day',
  leave_ref: 'leave_reference',
};

/**
 * A file header → a contract key. `parseCsvRecords` has already lower-cased and underscored the header,
 * but it keeps punctuation, so the reporter's own "Employee No." arrives as `employee_no.` — this strips
 * anything that is not a letter or digit and then applies the alias table.
 *
 * Exported (rather than inlined in the service) so the template test can assert the round trip: every
 * `header` in LEAVE_HISTORY_COLUMNS must canonicalise back to its own `key`.
 */
export function canonicalColumnKey(raw: string): string {
  const k = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return COLUMN_ALIASES[k] ?? k;
}

/** A record as it reaches the service: whatever headers the file carried, values as strings. */
export type LeaveHistoryRecord = Record<string, string>;

/**
 * The ticket's Status column, and there are exactly three values because the ticket names exactly three.
 * `duplicate` is NOT a kind of `error`: on a re-upload of an already-loaded file it is the expected
 * answer, and the counts the reporter asked for keep it separate. Neither is imported.
 */
export type LeaveHistoryRowStatus = 'valid' | 'error' | 'duplicate';

/**
 * One row of the preview. Carries the file's OWN values back (not the resolved ids) because that is what
 * the preview table shows and what the error report has to hand back for correction.
 *
 * `warnings` are non-blocking and do NOT demote a row from `valid`: a day count that disagrees with our
 * calendar, an entitlement year that disagrees with the start date, a terminated employee. A migration
 * that refused rows on this system's arithmetic would throw out good history wholesale — the old
 * system's holidays and rest days are not ours, and the file's figure is the one that is kept.
 */
export type LeaveHistoryRowResult = {
  rowNum: number; // 1-based data row (header excluded)
  employeeNo: string;
  leaveReference: string;
  leaveCode: string;
  entitlementYear: string;
  startDate: string;
  endDate: string;
  days: string;
  session: string;
  status: LeaveHistoryRowStatus;
  errors: string[];
  warnings: string[];
};

export type LeaveHistoryImportPreview = {
  total: number;
  validCount: number;
  errorCount: number;
  duplicateCount: number;
  rows: LeaveHistoryRowResult[];
  /** Required contract columns the file's header row does not carry, canonicalised. */
  missingColumns: string[];
};

/** A row that did not go in, as the downloadable error report and the run log carry it. */
export type LeaveHistoryImportError = {
  rowNum: number;
  employeeNo: string;
  leaveReference: string;
  errors: string[];
};

export type LeaveHistoryImportResult = {
  /** Rows read from the file. imported + failed + duplicates = total, always. */
  total: number;
  imported: number;
  failed: number;
  duplicates: number;
  /** Every row that did not go in, with its reasons — failures AND duplicates, capped. */
  errors: LeaveHistoryImportError[];
  errorsTruncated: boolean;
  /** The run log row this commit wrote, when it could be written. */
  runId: string | null;
};

/** One past run, as the log table on the screen renders it. */
export type LeaveHistoryRunRow = {
  id: string;
  actorName: string | null;
  fileName: string;
  totalRows: number;
  importedRows: number;
  failedRows: number;
  duplicateRows: number;
  errors: LeaveHistoryImportError[];
  errorsTruncated: boolean;
  createdAt: string; // ISO
};

/**
 * The outcome badge, DERIVED from the counts so it can never disagree with the numbers beside it
 * (the `employee_import_run` rule, lib/import-schema.ts `importRunOutcome`).
 *
 * A run that imported nothing because every row was already there is `succeeded`, not `failed`: that is
 * a correct and expected re-upload, and calling it a failure would train HR to ignore the badge.
 */
export function leaveHistoryRunOutcome(r: {
  importedRows: number;
  failedRows: number;
}): 'succeeded' | 'partial' | 'failed' {
  if (r.failedRows === 0) return 'succeeded';
  return r.importedRows > 0 ? 'partial' : 'failed';
}

/** How the rows reached the commit — recorded in the run log and the audit event. */
export type LeaveHistoryImportSource = {
  kind: 'file' | 'paste';
  name?: string;
  format?: 'csv' | 'xls' | 'xlsx';
};

/**
 * The six steps the reporter drew, in order. Declared here rather than in the component so the screen
 * and its test read one list — the rail is the ticket's section 12 verbatim.
 */
export const LEAVE_HISTORY_STEPS = [
  'downloadTemplate',
  'uploadExcel',
  'validate',
  'previewResults',
  'confirmImport',
  'importSummary',
] as const;
export type LeaveHistoryStep = (typeof LEAVE_HISTORY_STEPS)[number];
