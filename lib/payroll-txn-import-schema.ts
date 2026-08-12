/**
 * 5c65367d — the .xlsx import contracts for Fixed Transaction and Individual Transaction.
 *
 * CLIENT-SAFE AND DB-FREE ON PURPOSE. The screen (a client component) needs the headers to build the
 * template and to render the preview; the server needs the same headers to parse an upload. Putting them
 * in one module with no `db/` import is what stops the two ends drifting — the exact split
 * lib/payroll-history-import-schema.ts already uses for the r185 import.
 *
 * THE HEADERS ARE HUMAN LABELS THAT MUST ROUND-TRIP. `parseCsvRecords` (lib/csv.ts) normalises a header
 * with `h.trim().toLowerCase().replace(/\s+/g, '_')`, so "Pay Item Code" becomes `pay_item_code`. A
 * prettier label that does not round-trip silently DROPS ITS WHOLE COLUMN — every row would then read as
 * missing that field, with no error naming the header. test/payroll-txn-import.test.ts asserts the
 * round-trip for every column of both contracts rather than trusting it.
 *
 * THE FILL-IN SHEET MUST BE SHEET 1. `workbookToCsvText` reads the FIRST worksheet only (and reads it in
 * the BROWSER — the server never parses a workbook, which is why there is no server-side spreadsheet
 * attack surface). Reordering the sheets would silently change which one an upload is read from.
 */

/** Which of the two screens a file belongs to. */
export type TxnImportKind = 'fixed' | 'individual';

// ─────────────────────────────── Fixed Transaction ───────────────────────────────

/**
 * The recurring-item contract. Deliberately the Add dialog's own fields and nothing else: pay item,
 * amount, cycle, start, end, remarks — plus the employee, which the dialog gets from the screen.
 *
 * Employee Name and Pay Item are CONFIRMATION columns, not keys. The import matches on Employee ID and
 * Pay Item Code; the two name columns are there so a human reading the file can see who and what a row
 * is about, and they are ignored on upload. That is stated in the template's own instructions.
 */
export const FIXED_TXN_COLUMNS = [
  'employee_id',
  'employee_name',
  'pay_item_code',
  'pay_item',
  'amount',
  'payroll_cycle',
  'start_date',
  'end_date',
  'remarks',
] as const;
export type FixedTxnColumn = (typeof FIXED_TXN_COLUMNS)[number];

export const FIXED_TXN_HEADERS = [
  'Employee ID',
  'Employee Name',
  'Pay Item Code',
  'Pay Item',
  'Amount',
  'Payroll Cycle',
  'Start Date',
  'End Date',
  'Remarks',
] as const;

/** The reporter's own worked example, from their ticket. */
export const FIXED_TXN_SAMPLE_ROWS: readonly (readonly string[])[] = [
  ['X000001', 'John Tan', 'HANDPHONE', 'Handphone Allowance', '100', 'regular', '2026-08-01', '', ''],
  ['X000002', 'Mary Lim', 'TRANSPORT', 'Transport Allowance', '250', 'regular', '2026-08-01', '2026-12-31', 'Reviewed Dec'],
];

// ─────────────────────────────── Individual Transaction ───────────────────────────────

/**
 * The one-off contract. `Kind` and `Quantity` exist because the ledger has them and because a pay item
 * whose rule reads hours or days CANNOT be imported without the quantity — `payRuleInputUnit` decides
 * which, and the existing `TxnQuantityRequiredError` is what refuses a row that omits it.
 *
 * `Amount` is present but is IGNORED for a pay item that works its own amount out: the server re-derives
 * it through the same evaluator the screen and the payslip use, exactly as the Add form does. The
 * template's instructions say so, and the preview shows the derived figure rather than the typed one.
 */
export const INDIVIDUAL_TXN_COLUMNS = [
  'employee_id',
  'employee_name',
  'pay_item_code',
  'pay_item',
  'kind',
  'quantity',
  'amount',
  'transaction_date',
  'notes',
] as const;
export type IndividualTxnColumn = (typeof INDIVIDUAL_TXN_COLUMNS)[number];

export const INDIVIDUAL_TXN_HEADERS = [
  'Employee ID',
  'Employee Name',
  'Pay Item Code',
  'Pay Item',
  'Kind',
  'Quantity',
  'Amount',
  'Transaction Date',
  'Notes',
] as const;

export const INDIVIDUAL_TXN_SAMPLE_ROWS: readonly (readonly string[])[] = [
  ['X000001', 'John Tan', 'OT1_5', 'Overtime 1.5', 'overtime', '5', '', '2026-08-05', 'Weekend callout'],
  ['X000002', 'Mary Lim', 'BONUS', 'Bonus', 'earning', '', '1500', '2026-08-31', 'Q3 incentive'],
];

// ─────────────────────────────── shared shape ───────────────────────────────

export const TXN_IMPORT_COLUMNS: Record<TxnImportKind, readonly string[]> = {
  fixed: FIXED_TXN_COLUMNS,
  individual: INDIVIDUAL_TXN_COLUMNS,
};

export const TXN_IMPORT_HEADERS: Record<TxnImportKind, readonly string[]> = {
  fixed: FIXED_TXN_HEADERS,
  individual: INDIVIDUAL_TXN_HEADERS,
};

export const TXN_IMPORT_SAMPLE_ROWS: Record<TxnImportKind, readonly (readonly string[])[]> = {
  fixed: FIXED_TXN_SAMPLE_ROWS,
  individual: INDIVIDUAL_TXN_SAMPLE_ROWS,
};

/**
 * 0-based positions stamped as TEXT (`z: '@'`) in the template.
 *
 * Employee ID and Pay Item Code only. Amount and Quantity must stay real numbers so Excel can sum a
 * column of them — forcing those to text is a defect HR would rightly report. Dates are left as typed:
 * `workbookToCsvText` reads a real date cell as a Date and ISO-formats it, and a text date typed as
 * `2026-08-01` survives verbatim, so both paths land on the same string.
 *
 * The guard matters even though none of production's 40 employee codes is numeric-with-leading-zero
 * today (100009, A0001, EMP-0001, IDB-240009, T100009, TMPL0001, X000001): a General-formatted cell
 * destroys a leading zero IN THE FILE, before any reader sees it, so it cannot be recovered afterwards.
 */
export const TXN_IMPORT_TEXT_COLUMN_INDEXES: Record<TxnImportKind, readonly number[]> = {
  fixed: [0, 2],
  individual: [0, 2],
};

export const TXN_IMPORT_FILENAME: Record<TxnImportKind, string> = {
  fixed: 'fixed-transaction-import-template.xlsx',
  individual: 'individual-transaction-import-template.xlsx',
};

export const TXN_IMPORT_ERROR_FILENAME: Record<TxnImportKind, string> = {
  fixed: 'fixed-transaction-import-errors.xlsx',
  individual: 'individual-transaction-import-errors.xlsx',
};

/** Sheet names. The DATA sheet is first and must stay first — see the module doc. */
export const TXN_IMPORT_SHEETS = {
  data: { fixed: 'Fixed Transactions', individual: 'Individual Transactions' },
  example: 'Example',
  employees: 'Employees',
  payItems: 'Pay Items',
  cycles: 'Payroll Cycles',
  kinds: 'Transaction Kinds',
} as const;

/**
 * ONE ROW'S VERDICT.
 *
 * `ok` rows are what Confirm Import writes. A failed row carries a REASON KEY, not a sentence: the reason
 * is resolved against the six catalogues on the client, so the error report a Malay-reading admin
 * downloads is in Malay. `detail` carries the values an ICU message needs (a clashing code and its
 * dates), and it is only ever built from a TYPED service error's own fields — never from raw file input.
 */
export type TxnImportRow = {
  /** 1-based row number in the operator's spreadsheet (the header is row 1, so data starts at 2). */
  rowNum: number;
  employeeId: string;
  employeeName: string;
  payItemCode: string;
  /** The pay item's real name, resolved — not the one typed in the file. Blank when unresolved. */
  payItem: string;
  /** Fixed: the start date. Individual: the transaction date. Shown in the preview's Effective From. */
  effectiveFrom: string;
  /** What will actually be written. On a calculating pay item this is the DERIVED figure, not the typed
   *  one — the preview must show the number that will be stored, or it is not a preview. */
  amount: string;
  ok: boolean;
  /** i18n key under `payroll.txnImport.reason.*`. Empty when `ok`. */
  reason: string;
  /** ICU values for that key. */
  detail?: Record<string, string | number>;
};

export type TxnImportPreview = {
  kind: TxnImportKind;
  total: number;
  valid: number;
  invalid: number;
  rows: TxnImportRow[];
  /** A whole-file refusal (wrong headers, empty file). When set, `rows` is empty and nothing may commit. */
  fileError?: string;
};

export type TxnImportResult = {
  kind: TxnImportKind;
  /** Rows the commit actually wrote. */
  written: number;
  /** Rows that were valid in the preview but were refused at write time — a race, or a guard the
   *  pre-flight cannot fully model. Reported per row, never swallowed. */
  failed: TxnImportRow[];
  /** Individual Transaction only: the processed runs this import marked for recalculation, and who on
   *  them. Imported rows behave exactly like typed ones — the request's "must not automatically mark
   *  newly imported transactions as Processed". */
  recalcBatchIds: string[];
};

/**
 * THE DUPLICATE PREDICATE, AND IT IS THE CONSTRAINT'S OWN.
 *
 * Migration 0426 put an EXCLUDE constraint on `employment_pay_component`, verified on production
 * 2026-08-12 as:
 *
 *   EXCLUDE USING gist (employment_id WITH =, component_id WITH =,
 *                       daterange(valid_from, COALESCE(valid_to, '9999-12-31'), '[]') WITH &&)
 *   WHERE (superseded_at IS NULL)
 *
 * Two things about it decide this whole function. It is keyed on employment + component and NOT on
 * payroll cycle — so two rows for the same person and the same pay item collide even when one is tagged
 * `regular` and the other `bonus`. And the daterange is INCLUSIVE at BOTH ends, so windows that merely
 * TOUCH (…-06-30 and 06-30-…) already overlap.
 *
 * The pre-flight check MUST use exactly this, including row-against-row inside the same file. Anything
 * looser and the preview says "Valid" and the commit raises 23P01 — which is precisely the failure mode
 * this item exists to avoid, in a screen whose entire promise is "find out what is wrong before anything
 * reaches an employee's pay".
 */
export const OPEN_END = '9999-12-31';
export function fixedWindowsOverlap(
  a: { validFrom: string; validTo: string | null },
  b: { validFrom: string; validTo: string | null },
): boolean {
  return a.validFrom <= (b.validTo ?? OPEN_END) && b.validFrom <= (a.validTo ?? OPEN_END);
}

/** 'YYYY-MM-DD'. The same shape `assertDateInPeriod` and the pay-component writer both expect. */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (v: string): boolean => ISO_DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/**
 * A money / quantity cell as a number, or null when it is not one.
 *
 * Tolerates the thousands separators and the currency prefix HR types into a spreadsheet ("1,500.00",
 * "RM 250"), because refusing those would make the import fail on files that are obviously correct —
 * and the alternative is an operator hand-deleting commas from four hundred rows. It does NOT tolerate
 * anything else: a cell that is not a number reads as null and the row is refused by name.
 */
export function parseAmountCell(v: string): number | null {
  const cleaned = v.replace(/[,\s]/g, '').replace(/^(RM|MYR)/i, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Header labels normalise back to the column keys. Exported so both ends check the same thing. */
export const normaliseHeader = (h: string): string => h.trim().toLowerCase().replace(/\s+/g, '_');

/** Every required column present in the uploaded file's header row, in any order. The two NAME columns
 *  are confirmation only, so a file without them still imports. */
export const TXN_IMPORT_REQUIRED_COLUMNS: Record<TxnImportKind, readonly string[]> = {
  fixed: ['employee_id', 'pay_item_code', 'amount', 'start_date'],
  individual: ['employee_id', 'pay_item_code', 'transaction_date'],
};
