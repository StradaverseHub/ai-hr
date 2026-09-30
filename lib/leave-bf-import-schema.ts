/**
 * db55d08a (r369) — Client-safe contract for LEAVE B/F DATA IMPORT (the migration of BROUGHT-FORWARD
 * opening figures).
 *
 * No DB imports. The column contract, the header spellings, the key canonicaliser, the import mode and
 * the per-row result shapes live here so the server service (`core/leave-bf-import`), the client screen
 * (`app/admin/leave-config/bf-import`) and the downloadable template all read ONE list — the desync lock
 * lib/import-schema.ts, lib/payroll-history-import-schema.ts and lib/leave-history-import-schema.ts
 * already apply.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ THREE IMPORT CONTRACTS NOW, AND THEY MUST NEVER BE MERGED
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 *   lib/leave-import-schema.ts         → the BALANCE importer (`core/leave-import.ts`). Raw
 *                                        `leave_ledger` movements: the uploader states the entry type
 *                                        and the effective date themselves.
 *   lib/leave-history-import-schema.ts → the RECORD importer (`core/leave-history-import.ts`).
 *                                        `leave_request` rows, plus their debit when the run deducts.
 *   THIS FILE                          → the BROUGHT-FORWARD importer (`core/leave-bf-import.ts`). The
 *                                        uploader states a YEAR and a NUMBER OF DAYS and nothing else;
 *                                        the service works out the entry type and the date.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ WHY A THIRD TOOL EXISTS AT ALL: BROUGHT FORWARD IS A VIEW OF LAST YEAR, NOT A FIELD
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Nowhere in this system is there a column holding Brought Forward. It is derived, every time a screen
 * asks: `core/read.ts`'s `priorBalance` is `sum(leave_ledger.days) where effective_on < cycleStart`,
 * surfaced as `broughtForward`, and the Employee Balances grid column is that figure put through the
 * leave type's carry rule (`carriedForward` → `carryAllowanceFrom`).
 *
 * So the BALANCE importer can be made to produce a Brought Forward figure, but only by someone who knows
 * two things written down nowhere: the line must be dated in the PREVIOUS leave year, and it must be an
 * `adjustment` rather than an `accrual`. Doing the natural thing instead — one line, 3.5 days, dated
 * 1 January 2026 — goes wrong twice over. The days land under Earned to Date rather than Brought
 * Forward, and, far worse, that accrual row satisfies `yearOpenMarkerCond` (core/leave.ts), so Generate
 * Entitlement believes the year is already open for that person and grants them NOTHING for the year.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ THEREFORE: THIS IMPORTER WRITES `adjustment` AND NEVER `accrual`. THAT IS THE WHOLE POINT.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `LEAVE_BF_ENTRY_TYPE` below is the ONE place the entry type is named, it is a literal type rather than
 * a `string`, and `core/leave-bf-import.ts` writes it by reference. `yearOpenMarkerCond` matches
 * `entry_type = 'accrual'` and nothing else, so an `adjustment` row is invisible to it and the
 * cancel-a-whole-year's-entitlement trap above cannot be reached through this screen. Changing this
 * constant to 'accrual' is not a refactor: it is the defect, and test/leave-bf-import.test.ts fails on
 * both the constant and on a committed row failing to satisfy the marker.
 *
 * NOT IN SCOPE HERE, said out loud: the same trap is live on the existing Leave Balance Import screen,
 * whose own warning only looks for a pre-existing accrual dated exactly 1 January
 * (`core/leave-import.ts`). That screen is not edited by this item and its warning is not widened here —
 * it is its own item, and widening it would not even catch the damaging case, in which there is no
 * pre-existing accrual at all.
 */

/** One column of the upload contract: what the template writes, and what the validator reads it as. */
export type LeaveBfColumn = {
  key: string;
  header: string;
  required: boolean;
};

/**
 * ⚠️ THE ENTRY TYPE, NAMED ONCE. Read the block above before changing it. A `const` assertion rather
 * than a `string` so tsc refuses a widened value, and so the guard can assert the literal.
 */
export const LEAVE_BF_ENTRY_TYPE = 'adjustment' as const;

/**
 * The contract, in the reporter's own order. FIVE columns, four required.
 *
 * `B/F Expiry Date` IS DELIBERATELY ABSENT and its absence is a decision, not an omission. The reporter's
 * own note says a blank cell should fall back to the leave type's own carry-forward expiry rule
 * (`carryForwardExpiryMode` / `Months` / `Month` / `Day`), which makes the column a per-row OVERRIDE of a
 * type-level rule. Two rules on one figure disagree the first time somebody edits the leave type, and
 * there is no per-row expiry column on a ledger row to hold the override in the first place. The approved
 * plan states this exclusion to the reporter in the same words.
 *
 * `Entitlement Year` is the year the days go INTO: 2026 means days carried from 2025 into 2026. It is
 * REQUIRED, unlike the history importer's optional column, because it is the only thing that says which
 * leave year this figure opens — there is no start date to infer it from.
 */
export const LEAVE_BF_COLUMNS: readonly LeaveBfColumn[] = [
  { key: 'employee_id', header: 'Employee ID', required: true },
  { key: 'leave_code', header: 'Leave Code', required: true },
  { key: 'entitlement_year', header: 'Entitlement Year', required: true },
  { key: 'bf_days', header: 'B/F Days', required: true },
  { key: 'remark', header: 'Remark', required: false },
] as const;

/** The keys a row MUST carry a non-empty value for. Derived, never re-listed. */
export const LEAVE_BF_REQUIRED_KEYS: readonly string[] = LEAVE_BF_COLUMNS.filter((c) => c.required).map(
  (c) => c.key,
);

/**
 * Spellings accepted for a contract key beyond its own canonical form.
 *
 * `b_f_days` IS NOT A CONVENIENCE ALIAS — it is load-bearing. `parseCsvRecords` lower-cases a header and
 * replaces whitespace, but it keeps punctuation, so the reporter's own "B/F Days" arrives as `b/f_days`;
 * `canonicalBfColumnKey` then strips the slash to `b_f_days`. Without this entry the workbook this product
 * hands out is a workbook this product rejects, behind a green everything. Pinned in
 * test/import-template.test.ts as a round trip over every header.
 *
 * The employee-number spellings are the three a customer's own export plausibly already uses, matching the
 * history importer's list rather than inventing a second vocabulary.
 */
const COLUMN_ALIASES: Readonly<Record<string, string>> = {
  b_f_days: 'bf_days',
  bf_day: 'bf_days',
  brought_forward_days: 'bf_days',
  employee_no: 'employee_id',
  employee_code: 'employee_id',
  employee_number: 'employee_id',
  year: 'entitlement_year',
  leave_type: 'leave_code',
};

/**
 * A file header → a contract key. Strips anything that is not a letter or a digit (which is what turns
 * `employee_id.` and `b/f_days` into something recognisable) and then applies the alias table.
 *
 * Exported rather than inlined in the service so the template test can assert the round trip: every
 * `header` in LEAVE_BF_COLUMNS must canonicalise back to its own `key`.
 */
export function canonicalBfColumnKey(raw: string): string {
  const k = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return COLUMN_ALIASES[k] ?? k;
}

/** A record as it reaches the service: whatever headers the file carried, values as strings. */
export type LeaveBfRecord = Record<string, string>;

/**
 * THE REPORTER'S IMPORT MODE, asked once per run.
 *
 *   'replace' (THE DEFAULT, and the reporter's own recommended default) — the figure in the file becomes
 *      the brought-forward figure. The service writes the NEGATION of what a previous B/F import put
 *      there, then the new figure; it never UPDATEs and never DELETEs a ledger row (ADR-0006: the ledger
 *      is append-only).
 *   'add' — the figure in the file is ADDED to what is already brought forward.
 *
 * ⚠️ 'replace' NEGATES ONLY WHAT **THIS IMPORTER** WROTE, identified by `leave_ledger.bf_import_run_id`.
 * It does NOT negate the rest of the prior-year balance. That restriction is not a limitation, it is the
 * safety property: the prior-cycle sum also contains real accruals, real debits and real adjustments, and
 * a "replace" that reversed those would destroy history and hand days back or take them away. Where a
 * genuine prior-year balance already exists the preview says so and the warning names the figure, so the
 * reader is never left believing Replace flattened something it did not touch.
 *
 * PER RUN, not per tenant and not per row: it is a property of the FILE.
 */
export const LEAVE_BF_IMPORT_MODES = ['replace', 'add'] as const;
export type LeaveBfImportMode = (typeof LEAVE_BF_IMPORT_MODES)[number];

export type LeaveBfImportOptions = {
  mode?: LeaveBfImportMode;
};

export type ResolvedLeaveBfImportOptions = {
  mode: LeaveBfImportMode;
};

/**
 * The ONE place the default lives, so the validate action, the commit action and the screen cannot
 * disagree — the `resolveLeaveHistoryImportOptions` precedent, and for the same reason: an omitted option
 * must resolve to the answer the reporter asked for as the default rather than to whatever a caller
 * happened to leave out.
 */
export function resolveLeaveBfImportOptions(o?: LeaveBfImportOptions): ResolvedLeaveBfImportOptions {
  return { mode: o?.mode === 'add' ? 'add' : 'replace' };
}

/**
 * Two values, not three. A duplicate employee + leave code + year INSIDE the file is an ERROR here rather
 * than its own status, because the reporter's own validation list says so: unlike a leave reference, two
 * B/F lines for one pair-and-year are not "already loaded", they are a file whose author has not decided
 * which figure they mean. There is no cross-run duplicate status either — re-running a corrected file is
 * the expected workflow and Replace is what makes it safe.
 */
export type LeaveBfRowStatus = 'valid' | 'error';

/**
 * One row of the preview. Carries the file's OWN values back (not the resolved ids) because that is what
 * the preview table shows and what the error report has to hand back for correction — PLUS the two things
 * the file did not state and the service worked out, which is the whole reason this screen exists:
 *
 *   `cycleStart`  — the day that employee's `entitlementYear` leave year OPENS. Calendar or anniversary,
 *                   per employee, resolved through `earnedCycleStart` (core/leave.ts) so it is the SAME
 *                   boundary every balance surface cuts at.
 *   `effectiveOn` — the day BEFORE `cycleStart`, which is where a brought-forward figure has to be dated
 *                   for `priorBalance` to see it. Shown because a figure whose date the reader cannot see
 *                   is a figure they cannot check.
 */
export type LeaveBfRowResult = {
  rowNum: number; // 1-based data row (header excluded)
  employeeId: string;
  employeeName: string;
  leaveCode: string;
  /** The code of the leave type whose LEDGER moves, when it differs from `leaveCode`; else ''. */
  balanceCode: string;
  entitlementYear: string;
  days: string;
  cycleStart: string;
  effectiveOn: string;
  status: LeaveBfRowStatus;
  errors: string[];
  warnings: string[];
};

/**
 * WHAT CONFIRM IMPORT WILL DO TO A BROUGHT-FORWARD FIGURE, one line per employee, per LEDGER and per
 * leave year — and it is deliberately NOT the same as what the uploader typed.
 *
 * GROUPED BY THE LEDGER THAT MOVES (the resolved Balance Deduction Source, cdf9ca48), not by the code the
 * line was filed under, for the reason `LeaveHistoryBalanceImpact` gives: a borrower leave type has no
 * balance of its own, and a preview line headed "EL" promising a change to an EL balance would be a false
 * statement about a row that is about to be written. `filedCodes` keeps the pooling visible.
 *
 * THE THREE FIGURES THE READER ACTUALLY NEEDS, and the reason the middle one is not enough on its own:
 *
 *   `broughtForwardAfter`  — the RAW prior-cycle sum afterwards. This is what the Explain panel prints as
 *                            Brought Forward (`core/read.ts` → `broughtForward` ← `priorBalance`).
 *   `carriedForwardAfter`  — the same figure through the leave type's carry rule (`carryAllowanceFrom`),
 *                            which is what the Employee Balances GRID column prints
 *                            (components/leave-balance-row.ts → `carriedForward`).
 *   `forfeitedBf`          — the difference. Load 3.5 days into a type that caps carry-forward at 2 and
 *                            the grid will read 2.00 with 1.50 forfeited. The approved plan promises the
 *                            reader sees that BEFORE pressing the button, not after.
 *
 * `netDays` is the change this run makes to the raw figure, which under Replace is (file figure − what a
 * previous B/F import put there) and under Add is the file figure. It is shown because it, and not the
 * file's number, is what moves.
 */
export type LeaveBfBalanceImpact = {
  employeeId: string;
  employeeName: string;
  /** The code of the leave type whose LEDGER moves — the resolved balance source. */
  leaveCode: string;
  /** Codes the lines were filed under, ascending, when any differs from `leaveCode`; else empty. */
  filedCodes: string[];
  entitlementYear: string;
  cycleStart: string;
  effectiveOn: string;
  /** How many file lines land on this ledger, for this year. */
  lines: number;
  /** The figure the file states, summed over those lines. */
  fileDays: number;
  /** What this run will add to the raw prior-cycle sum — signed, and NOT the same as `fileDays`. */
  netDays: number;
  broughtForwardBefore: number;
  broughtForwardAfter: number;
  /** `broughtForwardAfter` through the type's carry rule: the Employee Balances grid column. */
  carriedForwardAfter: number;
  /** max(0, broughtForwardAfter) − carriedForwardAfter. Positive means the cap bites. */
  forfeitedBf: number;
  /** True when `forfeitedBf > 0`: the flag the screen highlights rather than leaving to arithmetic. */
  capped: boolean;
};

export type LeaveBfImportPreview = {
  total: number;
  validCount: number;
  errorCount: number;
  rows: LeaveBfRowResult[];
  /** Required contract columns the file's header row does not carry, canonicalised. */
  missingColumns: string[];
  /**
   * The resolved import mode, echoed back from the SERVER so the screen states what the server is about
   * to do rather than what the control it drew happens to be showing. The commit re-resolves it from its
   * own argument, so this is a readout and never an instruction.
   */
  mode: LeaveBfImportMode;
  /**
   * The movement Confirm import will make. Only rows the run would actually write are counted: an error
   * row moves nothing.
   */
  balanceImpact: LeaveBfBalanceImpact[];
};

/** A row that did not go in, as the downloadable error report and the run log carry it. */
export type LeaveBfImportError = {
  rowNum: number;
  employeeId: string;
  leaveCode: string;
  entitlementYear: string;
  errors: string[];
};

export type LeaveBfImportResult = {
  /** Rows read from the file. imported + failed = total, always. */
  total: number;
  imported: number;
  failed: number;
  /** Every row that did not go in, with its reasons, capped. */
  errors: LeaveBfImportError[];
  errorsTruncated: boolean;
  /**
   * The run this commit wrote. NEVER null, unlike the history importer's: the run row is created BEFORE
   * any ledger row, because every ledger row references it and because a batch with no run row could
   * never be undone. An import that cannot record its run does not happen at all — see
   * `core/leave-bf-import.ts`.
   */
  runId: string;
};

/** One past run, as the log table on the screen renders it. */
export type LeaveBfRunRow = {
  id: string;
  actorName: string | null;
  fileName: string;
  mode: LeaveBfImportMode;
  totalRows: number;
  importedRows: number;
  failedRows: number;
  /** Ledger rows the run wrote. 0 is possible and honest: a Replace of 0 over nothing writes nothing. */
  ledgerRows: number;
  errors: LeaveBfImportError[];
  errorsTruncated: boolean;
  /** ISO, or null while the run stands. A reversed run is never offered for reversal a second time. */
  reversedAt: string | null;
  createdAt: string; // ISO
};

/**
 * The outcome badge, DERIVED from the counts so it can never disagree with the numbers beside it (the
 * `employee_import_run` rule, lib/import-schema.ts `importRunOutcome`).
 */
export function leaveBfRunOutcome(r: {
  importedRows: number;
  failedRows: number;
}): 'succeeded' | 'partial' | 'failed' {
  if (r.failedRows === 0) return 'succeeded';
  return r.importedRows > 0 ? 'partial' : 'failed';
}

/** How the rows reached the commit — recorded in the run log and the audit event. */
export type LeaveBfImportSource = {
  kind: 'file' | 'paste';
  name?: string;
  format?: 'csv' | 'xls' | 'xlsx';
};

/**
 * The six steps the reporter drew, in order, and deliberately the same six words the Leave History Data
 * Import rail uses — the reporter asked for the same wizard so HR does not learn a second shape. Declared
 * here rather than in the component so the screen and its test read one list.
 */
export const LEAVE_BF_STEPS = [
  'downloadTemplate',
  'uploadExcel',
  'validate',
  'previewResults',
  'confirmImport',
  'importSummary',
] as const;
export type LeaveBfStep = (typeof LEAVE_BF_STEPS)[number];
