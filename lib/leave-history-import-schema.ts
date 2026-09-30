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
 * different things; see core/leave-history-import.ts's header for what an imported RECORD does to a
 * balance and who decides it.
 *
 * r367 - THE BALANCE DECISION IS NOW THE UPLOADER'S, ONCE PER RUN (`LeaveHistoryImportOptions`).
 * r362 asserted, in prose the product showed the user, that a migrated opening balance already has the
 * imported leave removed from it. That is a claim about the CUSTOMER'S DATA which this product never
 * asked about and cannot verify, and it is false whenever entitlement is generated from the entitlement
 * tables with nothing brought forward - the leave was then recorded and never deducted. So the question
 * is asked instead of assumed, it defaults to NO (deduct), and `LeaveHistoryBalanceImpact` is what shows
 * the answer's consequence BEFORE Confirm import rather than days afterwards.
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
 * r367 - THE ONE THING THE UPLOADER IS ASKED ABOUT THEIR FILE, and it decides whether money moves.
 *
 * `openingBalancesAreNet` answers: "are the balances you are starting from already net of this leave?"
 *
 *   false (THE DEFAULT) - the balances in this system are whole-year allowances generated from the
 *     entitlement tables, so the imported leave has NOT been taken off them yet. The import writes the
 *     matching `leave_ledger` debit, exactly as an ordinary approval does. This is the reporter's case
 *     and it is the default because it is the safe one: a missing debit overstates a balance, and an
 *     overstated Annual Leave balance is PAID OUT at resignation (core/leave-encashment.ts).
 *   true - the customer arrived with their own closing balances, which already have this leave removed.
 *     Deducting again would take the same days twice, so no ledger row is written. This is r362's
 *     behaviour, kept intact rather than removed: it is a genuine migration shape, and r362 shipped one
 *     day before the report against it.
 *
 * PER RUN, not per tenant and not per row: it is a property of the FILE and of the balances it arrives
 * beside, and the same tenant can legitimately answer differently for two uploads.
 *
 * DEFAULTED, NEVER INFERRED. `resolveLeaveHistoryImportOptions` is the single place the default lives, so
 * the validate action, the commit action and the screen cannot disagree - and an omitted option means
 * DEDUCT, so a caller that forgets the field gets the arithmetic that cannot overpay anybody.
 */
export type LeaveHistoryImportOptions = {
  openingBalancesAreNet?: boolean;
};

/** The resolved options, with every default applied exactly once. */
export type ResolvedLeaveHistoryImportOptions = {
  openingBalancesAreNet: boolean;
};

export function resolveLeaveHistoryImportOptions(
  o?: LeaveHistoryImportOptions,
): ResolvedLeaveHistoryImportOptions {
  return { openingBalancesAreNet: o?.openingBalancesAreNet === true };
}

/**
 * r367 - WHAT CONFIRM IMPORT IS ABOUT TO DO TO A BALANCE, one line per employee and per LEDGER.
 *
 * Grouped by the ledger that actually MOVES (the resolved Balance Deduction Source), not by the code the
 * record was filed under, because that is the figure the reader will go and check afterwards: a pooled
 * Emergency Leave record spends Annual Leave's balance, and a preview line headed "EL" promising a change
 * to an EL balance would be a false statement about a row that is about to be written. `filedCodes`
 * carries the codes the records were filed under when any of them differs, so the grouping hides nothing.
 *
 * `balanceBefore` is the running ledger total (`sum(leave_ledger.days)`), which is what every balance
 * surface in this product means by Balance - NOT the additive column formula, which 6574c6b4 removed for
 * double-counting. `balanceAfter` = before - days, and `goesNegative` is the flag the plan promised the
 * reporter: an employee who has earned nothing yet this cycle goes below zero, and the screen says so
 * rather than doing it quietly.
 */
export type LeaveHistoryBalanceImpact = {
  employeeNo: string;
  employeeName: string;
  /** The code of the leave type whose LEDGER moves - the resolved balance source. */
  leaveCode: string;
  /** Codes the records were filed under, ascending, when any differs from `leaveCode`; else empty. */
  filedCodes: string[];
  /** Entitlement years the records fall in, ascending. Context for the reader; not part of the sum. */
  entitlementYears: string[];
  /** How many records in this run land on this ledger. */
  records: number;
  /** Days this run will take off it - always positive; 0 is possible, and is shown rather than hidden. */
  days: number;
  balanceBefore: number;
  balanceAfter: number;
  goesNegative: boolean;
};

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
  /**
   * r367 - WILL THIS RUN DEDUCT? The resolved answer to `openingBalancesAreNet`, inverted, echoed back
   * from the SERVER so the screen states what the server is actually about to do rather than what the
   * control it drew happens to be showing. The commit re-resolves it from its own argument, so this is a
   * readout and never an instruction.
   */
  deducts: boolean;
  /**
   * The balance movement Confirm import will make, per employee and per ledger. EMPTY when `deducts` is
   * false - there is no movement to preview - and that emptiness is the screen's cue to say so in words.
   * Only rows the run would actually write are counted: an error row and a duplicate row move nothing.
   */
  balanceImpact: LeaveHistoryBalanceImpact[];
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
