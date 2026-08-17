/**
 * 5c65367d — Excel (.xlsx) import for Fixed Transaction and Individual Transaction.
 *
 * ── THE WHOLE POINT OF THIS FILE IS THAT IT VALIDATES NOTHING TWICE ──────────────────────────────────
 *
 * The reporter's own words: "Manual Entry = Excel Import = Same validation + Same business rules + Same
 * payroll calculation logic." That is not a nice-to-have here, it is the implementation strategy. Every
 * row goes through the LIVE service — `setEmploymentPayComponent` for a recurring item,
 * `createIndividualTxnsBulk` for a one-off — so the typed errors those services already raise are the
 * import's error vocabulary, and a rule added to either service applies to the import on the day it
 * ships without anyone remembering to mirror it.
 *
 * What IS implemented here, and only this:
 *   1. RESOLUTION — an employee code to an employment inside the caller's company scope; a pay item code
 *      to a live `pay_component`. Both fail by NAME (`employeeUnknown`, `payItemUnknown`), because
 *      "row 12 is invalid" is the error report the reporter is explicitly trying to stop receiving.
 *   2. SHAPE — a date that is a date, a number that is a number, an enum value that is in the enum.
 *   3. THE PRE-FLIGHT DUPLICATE CHECK, which is the one piece of real logic. See below.
 *
 * ── WHY THE DUPLICATE CHECK IS HERE AND NOT LEFT TO THE SERVICE ──────────────────────────────────────
 *
 * Because a preview that says "Valid" and then throws on commit is worse than no preview. Migration 0426
 * put an EXCLUDE constraint on `employment_pay_component` — employment + component + INCLUSIVE daterange,
 * WHERE superseded_at IS NULL, and NOT keyed on payroll cycle (verified on production 2026-08-12). The
 * pre-flight uses that exact predicate (`fixedWindowsOverlap`), against BOTH the rows already on file and
 * the other rows IN THE SAME FILE — an in-file pair is the case the service cannot catch for us, because
 * it only ever sees one row at a time and each one is individually fine.
 *
 * ── 0db616f3: THE ONE-OFF HALF HAD NO DUPLICATE CHECK AT ALL, AND IT COST RM43,548.80 ────────────────
 *
 * Everything above described the FIXED half only. The Individual Transaction half wrote whatever it was
 * given: `payroll_individual_txn` has no unique constraint by design (many dated lines per person per
 * month are legal), the service's own `DuplicateTxnRowError` only sees inside ONE submission and this
 * importer calls it once per row, and `source_ref` was left null so the database could not tell one
 * upload from another. In January 2026 a bonus file was uploaded, appeared to do nothing (it landed on
 * the salary run — see the targeting note further down), and was uploaded again three minutes later:
 * 24 rows worth RM106,073.31 where 13 worth RM62,524.51 were owed, 11 of them exact duplicates.
 *
 * So the one-off half now has the same two-sided pre-flight the fixed half has always had — against the
 * rows already in the run and against the other rows in the same file — plus a `source_ref` that names
 * the upload, which arms migration 0432's uniqueness index as the database-level backstop.
 *
 * ── PARTIAL IMPORT IS DELIBERATE ─────────────────────────────────────────────────────────────────────
 *
 * Valid rows are written and failures are reported; a bad row does not sink the file. The approved plan
 * states that and offers all-or-nothing as the reject path. Each row is its own transaction (the service
 * opens one per call), so "written" is always exactly what the result says.
 *
 * ── NO WORKBOOK EVER REACHES THIS FILE ───────────────────────────────────────────────────────────────
 *
 * The client parses the .xlsx into CSV text in the BROWSER (lib/spreadsheet.ts, SheetJS lazily imported)
 * and sends text. That is r185's shape and it is kept for the reason r185 kept it: no server-side
 * spreadsheet parser means no server-side spreadsheet attack surface.
 */
import { createHash } from 'node:crypto';

import { and, eq, inArray, isNull } from 'drizzle-orm';

import { withTenant, type SessionContext } from '../db/client';
import { employmentPayComponent, payComponent, payrollIndividualTxn } from '../db/schema';
import { listEmployees } from './read';
// ADR-0080 D9 — payroll is a PACK, and this module is spine, so every payroll service comes through the
// FACADE rather than reaching into core/pay-components, core/pay-rule, core/payroll-individual-txn or
// core/payroll directly. Importing those turns test/payroll-pack-drift.test.ts red, and the fix is never
// test/pack-drift-allowlist.json: that list is audited kernel-contract debt and its own failure message
// says it only ever shrinks. The facade re-exports all four with `export *`, so every symbol below
// resolves unchanged, and seven core/ files already import a pack facade this way (absence-days, admin,
// attendance-recompute, entitlements, movement-apply, operator, schema-explorer) — no new cycle.
import {
  FIXED_TRANSACTION_CYCLES,
  FixedTransactionAmountError,
  FixedTransactionBackwardsError,
  FixedTransactionMidMonthError,
  FixedTransactionDateError,
  FixedTransactionOverlapError,
  FixedTransactionPaidError,
  TxnQuantityRequiredError,
  UnsupportedFixedCurrencyError,
  deriveIndividualTxnAmount,
  setEmploymentPayComponent,
  type FixedTransactionCycle,
  payRuleInputUnit,
  PayRuleEvalError,
  type PayRule,
  AmountNotPositiveError,
  ComponentRequiredError,
  DuplicateTxnRowError,
  EmploymentNotInBatchScopeError,
  InvalidTxnComponentError,
  InvalidTxnKindError,
  TxnDateOutOfPeriodError,
  createIndividualTxnsBulk,
  isTxnKind,
  isPayPeriod,
  BatchNotDraftError,
  batchEditImpact,
  listBatches,
} from '../packs/payroll/service';
import {
  TXN_IMPORT_REQUIRED_COLUMNS,
  fixedWindowsOverlap,
  isIsoDate,
  parseAmountCell,
  type TxnImportKind,
  type TxnImportPreview,
  type TxnImportResult,
  type TxnImportRow,
} from '../lib/payroll-txn-import-schema';

/** A file bigger than this is a mistake, not an import. 2,000 rows is ~50× production's whole ledger. */
const MAX_ROWS = 2000;

/** One parsed record from `parseCsvRecords` — every value already trimmed, keys already snake_cased. */
export type TxnImportRecord = Record<string, string>;

/**
 * Map a TYPED service error to a reason key the client resolves against its catalogue.
 *
 * Reason keys, never sentences. The operator downloads the error report and it has to be in their own
 * language; a message built here would be English in six locales. `detail` carries the ICU values, and it
 * is only ever built from the error's OWN fields — a catalog code and two ISO dates — never from raw file
 * input.
 */
export function txnImportReason(e: unknown): { reason: string; detail?: Record<string, string | number> } {
  if (e instanceof FixedTransactionOverlapError) {
    return { reason: 'overlap', detail: { code: e.code, from: e.validFrom, to: e.validTo ?? '' } };
  }
  if (e instanceof FixedTransactionBackwardsError) {
    return { reason: 'backwards', detail: { code: e.code, from: e.validFrom, to: e.validTo ?? '' } };
  }
  // a3d485f6 — a fixed-transaction row whose start date lands part-way through a month a live record
  // already covers. Reachable from a file exactly as it is from the screen, and a downloadable error
  // report must never carry the service's raw English (see this function's note).
  if (e instanceof FixedTransactionMidMonthError) {
    return { reason: 'midMonth', detail: { code: e.code, nextFirst: e.nextFirstOfMonth } };
  }
  if (e instanceof FixedTransactionPaidError) return { reason: 'closedRun', detail: { period: e.payPeriod } };
  if (e instanceof FixedTransactionDateError) return { reason: 'endBeforeStart' };
  if (e instanceof UnsupportedFixedCurrencyError) return { reason: 'currencyUnsupported' };
  if (e instanceof FixedTransactionAmountError) return { reason: 'amountNotPositive' };
  if (e instanceof TxnQuantityRequiredError) {
    return { reason: e.unit === 'hours' ? 'quantityRequiredHours' : 'quantityRequiredDays' };
  }
  if (e instanceof AmountNotPositiveError) return { reason: 'amountNotPositive' };
  if (e instanceof TxnDateOutOfPeriodError) return { reason: 'dateOutOfPeriod' };
  if (e instanceof DuplicateTxnRowError) return { reason: 'duplicateRow' };
  if (e instanceof ComponentRequiredError) return { reason: 'componentRequired' };
  if (e instanceof InvalidTxnComponentError) return { reason: 'payItemUnsupported' };
  if (e instanceof InvalidTxnKindError) return { reason: 'kindUnknown' };
  if (e instanceof EmploymentNotInBatchScopeError) return { reason: 'employeeNotInScope' };
  if (e instanceof BatchNotDraftError) return { reason: 'runNotWritable' };
  if (e instanceof PayRuleEvalError) return { reason: 'derivedAmountUnavailable' };
  // A Postgres 23P01 from the 0426 exclusion constraint would land here. It should be unreachable —
  // the pre-flight uses that constraint's own predicate — but "unreachable" is not "impossible", and
  // a raw driver message must never reach a downloadable error report.
  if (typeof (e as { code?: string })?.code === 'string' && (e as { code: string }).code === '23P01') {
    return { reason: 'overlapDatabase' };
  }
  // 0db616f3 — a 23505 from `payroll_individual_txn_source_ref_uq`, which this import now arms by writing
  // `source_ref`. Like the 23P01 above it should be unreachable (the pre-flight checks that index's own
  // key), and like the 23P01 above "unreachable" is not "impossible": two operators uploading the same
  // file at the same moment both pass the pre-flight and one of them loses the race. A raw driver message
  // must never reach a downloadable error report, and "already imported" is the truth of it either way.
  if (typeof (e as { code?: string })?.code === 'string' && (e as { code: string }).code === '23505') {
    return { reason: 'duplicateImported' };
  }
  return { reason: 'unexpected', detail: { message: String((e as Error)?.message ?? e).slice(0, 200) } };
}

/** The catalogues one import run resolves against, read ONCE rather than per row. */
type ResolvedEmployee = {
  employmentId: string;
  companyId: string;
  departmentId: string | null;
  name: string;
};
type Catalogs = {
  /** employee_code (upper-cased) → employment. A code held by two people in scope is AMBIGUOUS and every
   *  row naming it is refused; silently picking one would post money to the wrong person. */
  employeeByCode: Map<string, ResolvedEmployee | 'ambiguous'>;
  componentByCode: Map<
    string,
    { id: string; code: string; name: string; kind: string; rule: PayRule | null; displayCategory: string | null }
  >;
};

async function loadCatalogs(ctx: SessionContext, scopeIds: string[]): Promise<Catalogs> {
  // FAIL CLOSED ON AN EMPTY SCOPE, and this is not defensive noise: `listEmployees` treats an EMPTY
  // companyIds array as "no filter" and returns every employee in the tenant. Every other read in this
  // codebase that takes a scope guards it the same way (`if (p.companyIds.length === 0) return []`), and
  // an import is the last place a fail-OPEN belongs — it writes money against whoever it resolves.
  const employees = scopeIds.length === 0 ? [] : await listEmployees(ctx, scopeIds);
  const employeeByCode = new Map<string, ResolvedEmployee | 'ambiguous'>();
  for (const e of employees) {
    const code = (e.employeeCode ?? '').trim().toUpperCase();
    if (!code) continue;
    employeeByCode.set(
      code,
      employeeByCode.has(code)
        ? 'ambiguous'
        : { employmentId: e.employmentId, companyId: e.companyId, departmentId: e.departmentId, name: e.name },
    );
  }
  const components = await withTenant(ctx, (tx) =>
    tx
      .select({
        id: payComponent.id,
        code: payComponent.code,
        name: payComponent.name,
        kind: payComponent.kind,
        rule: payComponent.rule,
        archivedAt: payComponent.archivedAt,
        // 0db616f3 — read ONLY to raise the "this looks like a bonus and you are not using the bonus
        // run" warning below. It is presentation metadata (db/schema.ts says so in as many words) and it
        // never routes a row; routing is the file's own `Payroll Cycle` column and nothing else.
        displayCategory: payComponent.displayCategory,
      })
      .from(payComponent)
      .where(eq(payComponent.tenantId, ctx.tenantId)),
  );
  const componentByCode: Catalogs['componentByCode'] = new Map();
  // ARCHIVED ITEMS ARE EXCLUDED. The request asks for "Payroll Item is active", and an archived item is
  // one an admin deliberately retired — importing against it would resurrect it through a side door.
  for (const c of components) {
    if (c.archivedAt != null) continue;
    componentByCode.set(c.code.trim().toUpperCase(), {
      id: c.id,
      code: c.code,
      name: c.name,
      kind: c.kind,
      rule: (c.rule ?? null) as PayRule | null,
      displayCategory: c.displayCategory ?? null,
    });
  }
  return { employeeByCode, componentByCode };
}

/** The live (non-superseded) recurring rows for a set of employments — the left-hand side of the
 *  overlap test. Read once for the whole file rather than once per row. */
async function loadLiveFixedRows(
  ctx: SessionContext,
  employmentIds: string[],
): Promise<Map<string, { componentId: string; validFrom: string; validTo: string | null; code: string }[]>> {
  const out = new Map<string, { componentId: string; validFrom: string; validTo: string | null; code: string }[]>();
  if (employmentIds.length === 0) return out;
  const rows = await withTenant(ctx, (tx) =>
    tx
      .select({
        employmentId: employmentPayComponent.employmentId,
        componentId: employmentPayComponent.componentId,
        validFrom: employmentPayComponent.validFrom,
        validTo: employmentPayComponent.validTo,
        code: payComponent.code,
      })
      .from(employmentPayComponent)
      .innerJoin(payComponent, eq(payComponent.id, employmentPayComponent.componentId))
      .where(
        and(
          inArray(employmentPayComponent.employmentId, employmentIds),
          isNull(employmentPayComponent.supersededAt),
        ),
      ),
  );
  for (const r of rows) {
    const list = out.get(r.employmentId) ?? [];
    list.push({ componentId: r.componentId, validFrom: r.validFrom, validTo: r.validTo, code: r.code });
    out.set(r.employmentId, list);
  }
  return out;
}

/** A row that has passed every check, carrying everything the write needs — so the commit does not
 *  re-parse the file's strings a second time and cannot reach a different conclusion from the preview. */
type ResolvedFixed = {
  employmentId: string;
  componentId: string;
  amount: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  runType: FixedTransactionCycle | null;
  remarks: string | null;
};
type ResolvedIndividual = {
  employmentId: string;
  companyId: string;
  departmentId: string | null;
  componentId: string;
  kind: string;
  txnDate: string;
  payPeriod: string;
  amount: number;
  quantity: number | null;
  unit: string | null;
  notes: string | null;
  /** 0db616f3 — the run this row was routed to, decided in the PREVIEW so the operator sees it before
   *  anything is written. Null means period-keyed (no writable regular run for the month yet). */
  targetBatchId: string | null;
  /** The cycle that decided the target: the file's own `Payroll Cycle` when it named one, else 'regular'. */
  targetCycle: FixedTransactionCycle;
  /** `payroll_individual_txn.source_ref` — this row's identity as a line OF THIS FILE. See `fileRowRef`. */
  sourceRef: string;
};

/** The rows already in the ledger for the employments a file names, read ONCE for the whole file. The
 *  left-hand side of the duplicate test — the January double import's whole defence. */
type LedgerRow = {
  batchId: string | null;
  companyId: string | null;
  payPeriod: string | null;
  employmentId: string;
  componentId: string | null;
  txnDate: string;
  amount: string;
  source: string | null;
  sourceRef: string | null;
};
async function loadLedgerRows(ctx: SessionContext, employmentIds: string[]): Promise<LedgerRow[]> {
  if (employmentIds.length === 0) return [];
  return withTenant(ctx, (tx) =>
    tx
      .select({
        batchId: payrollIndividualTxn.batchId,
        companyId: payrollIndividualTxn.companyId,
        payPeriod: payrollIndividualTxn.payPeriod,
        employmentId: payrollIndividualTxn.employmentId,
        componentId: payrollIndividualTxn.componentId,
        txnDate: payrollIndividualTxn.txnDate,
        amount: payrollIndividualTxn.amount,
        source: payrollIndividualTxn.source,
        sourceRef: payrollIndividualTxn.sourceRef,
      })
      .from(payrollIndividualTxn)
      .where(
        and(
          eq(payrollIndividualTxn.tenantId, ctx.tenantId),
          inArray(payrollIndividualTxn.employmentId, employmentIds),
        ),
      ),
  );
}

/**
 * THE DUPLICATE KEY: which RUN, which PERSON, which PAY ITEM, which AMOUNT.
 *
 * Exactly the grouping that found January's eleven duplicated pairs on production (2026-08-13:
 * `group by (employment_id, component_id, amount)` over one batch returned 11 groups with count 2,
 * RM43,548.80 duplicated). The run is part of the key rather than the month, because two runs of the
 * same month are two different payments and a line on each is not a duplicate of the other. An
 * unattached row's "run" is the (company, month) pair it is keyed to, which is where it will be
 * collected from.
 *
 * NOT KEYED ON THE DATE, deliberately. The two January waves were three minutes apart and carried the
 * same dates, but an operator who re-uploads a file after nudging one date has still uploaded the same
 * money twice, and a date is the easiest field in a spreadsheet to change by accident.
 */
const dupKey = (p: {
  batchId: string | null;
  companyId: string | null;
  payPeriod: string | null;
  employmentId: string;
  componentId: string | null;
  amount: string;
}): string =>
  [p.batchId ?? `period:${p.companyId ?? ''}:${p.payPeriod ?? ''}`, p.employmentId, p.componentId ?? '', p.amount].join('|');

/**
 * THIS ROW'S IDENTITY AS A LINE OF THIS FILE, and the reason `source_ref` is now populated on an import.
 *
 * MEASURED ON PRODUCTION 2026-08-13: `source_ref` was NULL on all 24 of January's imported rows, so the
 * only thing that could ever have suggested the file had been uploaded before was the amounts agreeing —
 * and nothing was comparing them. This gives an imported line a name of its own: the digest of the whole
 * FILE plus the row's position in it.
 *
 * THE DIGEST IS OF THE FILE, NOT OF THE ROW, and the difference is the corrected-and-re-uploaded case.
 * A per-row digest would let a file be re-uploaded unchanged as long as every row differed from what was
 * already stored, which is the wrong way round. A file digest says "this is upload X of this exact
 * sheet"; if the operator fixes one cell and re-uploads, every row gets a NEW ref and it is the amount
 * key above — not this one — that refuses the eleven rows that did not change. The two rules answer
 * different questions and both are needed.
 *
 * It also arms `payroll_individual_txn_source_ref_uq` (migration 0432), which was written for the
 * Attendance/Leave syncs that do not exist yet and has been an empty partial index ever since. From now
 * on the database itself refuses a second copy of the same file-row, so the pre-flight and the constraint
 * agree instead of the preview saying "Valid" and the commit raising 23505.
 */
const fileDigest = (records: TxnImportRecord[]): string => {
  const h = createHash('sha256');
  for (const rec of records) {
    // The separators are explicit and non-printable on purpose: without them 'a=1','b=2' and
    // 'a=12','b=' would digest identically, and two different files would claim the same identity.
    for (const k of Object.keys(rec).sort()) h.update(`${k}=${rec[k]}\u001f`);
    h.update('\u001e');
  }
  return h.digest('hex').slice(0, 32);
};
const fileRowRef = (digest: string, rowNum: number): string => `xlsx:${digest}:${rowNum}`;

/**
 * WHICH RUN AN IMPORTED ONE-OFF ROW LANDS ON — and the answer has to be the SAME one the Add form
 * reaches, or a row typed by hand and the identical row imported would behave differently.
 *
 * The form derives its target from `eligibleBatches`: the writable runs for (company, month) whose scope
 * includes the employee. It offers a choice when there is more than one and keys the row against the
 * month itself when there is none (f1564110 Phase 2's designed pre-run entry flow, which
 * `generatePayslips` later stamps onto the month's regular run).
 *
 * An import used to have no way to express that choice at all: this function's caller pinned
 * `runType === 'regular'`, so EVERY imported line went to the salary run whatever it was for. That is
 * how January's bonus file came to sit on the regular run while the bonus run showed nineteen zero
 * payslips — the operator had done nothing wrong and had nowhere to say so.
 *
 * 0db616f3 GIVES THE FILE THE SAME COLUMN THE FIXED-TRANSACTION TEMPLATE ALREADY HAS: `Payroll Cycle`.
 * Blank still means the month's REGULAR run and then, if there is none, keyed by period — byte-identical
 * to the behaviour above, so no existing file changes meaning. Naming a cycle sends the row to THAT run,
 * and when no writable run of that cycle exists for the month the row is REFUSED BY NAME rather than
 * quietly falling back. The fallback is what would rebuild the defect: a period-keyed row naming no cycle
 * is collected by `generatePayslips`'s attach-on-generate on the month's REGULAR run (core/payroll.ts), so
 * "bonus, but there is no bonus run" would land on the salary run exactly as January did. (Since c11e81aa
 * a NON-regular run also collects — but only rows naming its own cycle, which is precisely why the refusal
 * above must stay: a row naming a cycle that has no run is collected by nothing, and saying so is the
 * point.)
 *
 * WHAT IS DELIBERATELY NOT DONE: routing inferred from the pay item. `display_category` is presentation
 * metadata ("which box on the payslip", 3c473773) and paying a bonus inside the salary run is completely
 * ordinary here — inferring 'bonus' from it would force a separate run on everyone who has never wanted
 * one. It is used for ONE thing, a warning: a bonus-coded line heading for the regular run in a month
 * that HAS a writable bonus run is the January shape, and the preview says so.
 *
 * WHY NOT JUST ALWAYS KEY BY PERIOD. Because `resolveTxnTarget` returns `status: null` for a period-keyed
 * write, so `markBatchNeedsRecalc` never fires — and the request's "must not automatically mark newly
 * imported transactions as Processed" would silently become "imported rows never mark anything at all",
 * which is the same defect wearing the opposite hat.
 */
type BatchScopeShape = { departmentIds?: string[]; employmentIds?: string[] } | null;
function batchScopeIncludes(scope: BatchScopeShape, e: { employmentId: string; departmentId: string | null }): boolean {
  const empIds = scope?.employmentIds ?? [];
  const deptIds = scope?.departmentIds ?? [];
  if (empIds.length === 0 && deptIds.length === 0) return true; // whole company
  if (empIds.includes(e.employmentId)) return true;
  return e.departmentId != null && deptIds.includes(e.departmentId);
}

type Analysis =
  | { kind: 'fixed'; preview: TxnImportPreview; resolved: Map<number, ResolvedFixed> }
  | { kind: 'individual'; preview: TxnImportPreview; resolved: Map<number, ResolvedIndividual> };

const fail = (base: Omit<TxnImportRow, 'ok' | 'reason'>, reason: string, detail?: Record<string, string | number>): TxnImportRow => ({
  ...base,
  ok: false,
  reason,
  detail,
});

/**
 * Validate a whole file WITHOUT WRITING ANYTHING.
 *
 * Returns one verdict per row plus the resolved values, so `commitTxnImport` can re-run this and write
 * from ITS answer rather than from a preview the client sent back. A commit that trusted the client's
 * preview would be a commit the client could widen.
 */
export async function analyzeTxnImport(
  ctx: SessionContext,
  p: { kind: TxnImportKind; scopeIds: string[]; records: TxnImportRecord[] },
): Promise<Analysis> {
  const { kind, records } = p;
  const empty: TxnImportPreview = { kind, total: 0, valid: 0, invalid: 0, rows: [] };

  if (records.length === 0) {
    return kind === 'fixed'
      ? { kind, preview: { ...empty, fileError: 'emptyFile' }, resolved: new Map() }
      : { kind, preview: { ...empty, fileError: 'emptyFile' }, resolved: new Map() };
  }
  if (records.length > MAX_ROWS) {
    return kind === 'fixed'
      ? { kind, preview: { ...empty, fileError: 'tooManyRows' }, resolved: new Map() }
      : { kind, preview: { ...empty, fileError: 'tooManyRows' }, resolved: new Map() };
  }
  // A MISSING COLUMN IS A FILE ERROR, NOT N ROW ERRORS. If "Pay Item Code" was renamed, every row reads
  // as missing a pay item and the operator gets four hundred identical failures naming the wrong thing.
  const present = new Set(Object.keys(records[0]));
  const missing = TXN_IMPORT_REQUIRED_COLUMNS[kind].filter((c) => !present.has(c));
  if (missing.length > 0) {
    return kind === 'fixed'
      ? { kind, preview: { ...empty, fileError: 'missingColumns' }, resolved: new Map() }
      : { kind, preview: { ...empty, fileError: 'missingColumns' }, resolved: new Map() };
  }

  const cat = await loadCatalogs(ctx, p.scopeIds);
  return kind === 'fixed'
    ? { kind: 'fixed', ...(await analyzeFixed(ctx, records, cat)) }
    : { kind: 'individual', ...(await analyzeIndividual(ctx, records, cat)) };
}

async function analyzeFixed(
  ctx: SessionContext,
  records: TxnImportRecord[],
  cat: Catalogs,
): Promise<{ preview: TxnImportPreview; resolved: Map<number, ResolvedFixed> }> {
  const rows: TxnImportRow[] = [];
  const resolved = new Map<number, ResolvedFixed>();
  // Resolve identity first so the live-row read can be one query for the whole file.
  const stage: { rowNum: number; base: Omit<TxnImportRow, 'ok' | 'reason'>; r: ResolvedFixed | null; failure?: TxnImportRow }[] = [];

  for (const [i, rec] of records.entries()) {
    const rowNum = i + 2; // header is row 1
    const employeeId = rec.employee_id ?? '';
    const payItemCode = rec.pay_item_code ?? '';
    const base = {
      rowNum,
      employeeId,
      employeeName: rec.employee_name ?? '',
      payItemCode,
      payItem: '',
      effectiveFrom: rec.start_date ?? '',
      amount: rec.amount ?? '',
    };

    const emp = cat.employeeByCode.get(employeeId.trim().toUpperCase());
    if (!emp) {
      stage.push({ rowNum, base, r: null, failure: fail(base, 'employeeUnknown', { value: employeeId }) });
      continue;
    }
    if (emp === 'ambiguous') {
      stage.push({ rowNum, base, r: null, failure: fail(base, 'employeeAmbiguous', { value: employeeId }) });
      continue;
    }
    const comp = cat.componentByCode.get(payItemCode.trim().toUpperCase());
    if (!comp) {
      stage.push({ rowNum, base, r: null, failure: fail(base, 'payItemUnknown', { value: payItemCode }) });
      continue;
    }
    base.payItem = comp.name;
    base.employeeName = base.employeeName || emp.name;

    const amount = parseAmountCell(rec.amount ?? '');
    if (amount == null) {
      stage.push({ rowNum, base, r: null, failure: fail(base, 'amountInvalid', { value: rec.amount ?? '' }) });
      continue;
    }
    // The service asserts this too. Doing it here as well is not duplication for its own sake — it is
    // what lets the PREVIEW name the row, which is the whole product.
    if (!(amount > 0)) {
      stage.push({ rowNum, base, r: null, failure: fail(base, 'amountNotPositive') });
      continue;
    }
    const effectiveFrom = (rec.start_date ?? '').trim();
    if (!isIsoDate(effectiveFrom)) {
      stage.push({ rowNum, base, r: null, failure: fail(base, 'startDateInvalid', { value: effectiveFrom }) });
      continue;
    }
    const endRaw = (rec.end_date ?? '').trim();
    const effectiveTo = endRaw === '' ? null : endRaw;
    if (effectiveTo != null && !isIsoDate(effectiveTo)) {
      stage.push({ rowNum, base, r: null, failure: fail(base, 'endDateInvalid', { value: endRaw }) });
      continue;
    }
    if (effectiveTo != null && effectiveTo < effectiveFrom) {
      stage.push({ rowNum, base, r: null, failure: fail(base, 'endBeforeStart') });
      continue;
    }
    // The screen's "Payroll cycle" is the run_type enum, not a payroll_cycle row — production's 44
    // payroll_cycle records all have a NULL code and nothing on this table references them.
    const cycleRaw = (rec.payroll_cycle ?? '').trim().toLowerCase();
    let runType: FixedTransactionCycle | null = null;
    if (cycleRaw !== '') {
      if (!(FIXED_TRANSACTION_CYCLES as readonly string[]).includes(cycleRaw)) {
        stage.push({ rowNum, base, r: null, failure: fail(base, 'cycleUnknown', { value: rec.payroll_cycle ?? '' }) });
        continue;
      }
      runType = cycleRaw as FixedTransactionCycle;
    }

    stage.push({
      rowNum,
      base: { ...base, amount: amount.toFixed(2), effectiveFrom },
      r: {
        employmentId: emp.employmentId,
        componentId: comp.id,
        amount,
        effectiveFrom,
        effectiveTo,
        runType,
        remarks: (rec.remarks ?? '').trim() || null,
      },
    });
  }

  // ── THE DUPLICATE PASS. The constraint's own predicate, against the rows on file AND against the
  //    other rows in THIS file. The in-file half is the one the service can never catch for us: each
  //    row is individually fine and only the pair is wrong, and by the time the second one is written
  //    the first is already committed. ──
  const employmentIds = [...new Set(stage.filter((s) => s.r).map((s) => s.r!.employmentId))];
  const live = await loadLiveFixedRows(ctx, employmentIds);
  const seenInFile: { employmentId: string; componentId: string; validFrom: string; validTo: string | null; rowNum: number; code: string }[] = [];

  for (const s of stage) {
    if (s.failure) {
      rows.push(s.failure);
      continue;
    }
    const r = s.r!;
    const window = { validFrom: r.effectiveFrom, validTo: r.effectiveTo };
    const onFile = (live.get(r.employmentId) ?? []).find(
      (x) => x.componentId === r.componentId && fixedWindowsOverlap(window, x),
    );
    if (onFile) {
      rows.push(fail(s.base, 'overlap', { code: onFile.code, from: onFile.validFrom, to: onFile.validTo ?? '' }));
      continue;
    }
    const inFile = seenInFile.find(
      (x) => x.employmentId === r.employmentId && x.componentId === r.componentId && fixedWindowsOverlap(window, x),
    );
    if (inFile) {
      rows.push(fail(s.base, 'overlapInFile', { code: inFile.code, row: inFile.rowNum }));
      continue;
    }
    seenInFile.push({ ...window, employmentId: r.employmentId, componentId: r.componentId, rowNum: s.rowNum, code: s.base.payItemCode });
    rows.push({ ...s.base, ok: true, reason: '' });
    resolved.set(s.rowNum, r);
  }

  const valid = rows.filter((x) => x.ok).length;
  return { preview: { kind: 'fixed', total: rows.length, valid, invalid: rows.length - valid, rows }, resolved };
}

async function analyzeIndividual(
  ctx: SessionContext,
  records: TxnImportRecord[],
  cat: Catalogs,
): Promise<{ preview: TxnImportPreview; resolved: Map<number, ResolvedIndividual> }> {
  const rows: TxnImportRow[] = [];
  const resolved = new Map<number, ResolvedIndividual>();
  // 0db616f3 — STAGE FIRST, DECIDE SECOND, exactly as the Fixed Transaction half above already does.
  // The duplicate test needs the rows already on file (one read for the whole file) and the OTHER rows in
  // this file, and neither is knowable while the first row is still being parsed. The in-file half is the
  // one no service can catch for us: each row is individually fine, and by the time the second is written
  // the first has already committed — which is precisely how January's file came to be imported twice
  // three minutes apart with nothing complaining.
  type Stage = {
    rowNum: number;
    base: Omit<TxnImportRow, 'ok' | 'reason'>;
    /** Set when this row already failed; then `r` is null and the failure is emitted verbatim. */
    failure: TxnImportRow | null;
    r: Omit<ResolvedIndividual, 'targetBatchId'> | null;
    /** The pay item's payslip box, for the "this looks like a bonus" warning only. Never routes. */
    displayCategory: string | null;
    /** True when the file NAMED the cycle. A named cycle that has no run is refused, not fallen back. */
    cycleStated: boolean;
  };
  const stage: Stage[] = [];
  const digest = fileDigest(records);

  for (const [i, rec] of records.entries()) {
    const rowNum = i + 2;
    const employeeId = rec.employee_id ?? '';
    const payItemCode = rec.pay_item_code ?? '';
    const base = {
      rowNum,
      employeeId,
      employeeName: rec.employee_name ?? '',
      payItemCode,
      payItem: '',
      effectiveFrom: (rec.transaction_date ?? '').trim(),
      amount: rec.amount ?? '',
    };
    const push = (failure: TxnImportRow) =>
      stage.push({ rowNum, base, failure, r: null, displayCategory: null, cycleStated: false });

    const emp = cat.employeeByCode.get(employeeId.trim().toUpperCase());
    if (!emp) {
      push(fail(base, 'employeeUnknown', { value: employeeId }));
      continue;
    }
    if (emp === 'ambiguous') {
      push(fail(base, 'employeeAmbiguous', { value: employeeId }));
      continue;
    }
    const comp = cat.componentByCode.get(payItemCode.trim().toUpperCase());
    if (!comp) {
      push(fail(base, 'payItemUnknown', { value: payItemCode }));
      continue;
    }
    base.payItem = comp.name;
    base.employeeName = base.employeeName || emp.name;

    const txnDate = (rec.transaction_date ?? '').trim();
    if (!isIsoDate(txnDate)) {
      push(fail(base, 'txnDateInvalid', { value: txnDate }));
      continue;
    }
    // The month a one-off row belongs to IS its date's month. `assertDateInPeriod` re-checks it against
    // the resolved target, and the write is period-keyed (unattached) when no run exists yet — which is
    // f1564110 Phase 2's designed pre-run entry flow, not a fault.
    const payPeriod = txnDate.slice(0, 7);
    if (!isPayPeriod(payPeriod)) {
      push(fail(base, 'txnDateInvalid', { value: txnDate }));
      continue;
    }

    const kindRaw = (rec.kind ?? '').trim().toLowerCase();
    // Blank Kind falls back to the PAY ITEM's own class, which is what the Add form does: a master
    // allowance is an earning and a master deduction is a deduction. Requiring the operator to restate
    // it would be asking them for something the system already knows.
    const kind = kindRaw !== '' ? kindRaw : comp.kind === 'deduction' ? 'deduction' : 'earning';
    if (!isTxnKind(kind)) {
      push(fail(base, 'kindUnknown', { value: rec.kind ?? '' }));
      continue;
    }

    // WHICH BOX THE OPERATOR HAS TO FILL IS THE PAY ITEM'S DECISION, not the template's. `payRuleInputUnit`
    // is the same resolver the entry form asks, so a file and the form cannot disagree about it.
    const inputUnit = payRuleInputUnit(comp.rule);
    const quantityRaw = (rec.quantity ?? '').trim();
    const quantity = quantityRaw === '' ? null : parseAmountCell(quantityRaw);
    if (quantityRaw !== '' && quantity == null) {
      push(fail(base, 'quantityInvalid', { value: quantityRaw }));
      continue;
    }
    if (inputUnit != null && !(Number(quantity) > 0)) {
      push(fail(base, inputUnit === 'hours' ? 'quantityRequiredHours' : 'quantityRequiredDays'));
      continue;
    }

    const typed = parseAmountCell(rec.amount ?? '');
    // THE AMOUNT THE PREVIEW SHOWS IS THE AMOUNT THAT WILL BE STORED. On a calculating pay item that is
    // the SERVER's figure, from the same evaluator the payslip uses — never the typed one. Previewing
    // the typed figure and storing a different one would be a preview that lies.
    let amount = typed ?? 0;
    let unit: string | null = inputUnit;
    if (comp.rule != null) {
      try {
        const d = await deriveIndividualTxnAmount(ctx, {
          componentId: comp.id,
          employmentId: emp.employmentId,
          companyId: emp.companyId,
          payPeriod,
          quantity,
          unit: inputUnit,
        });
        if (d.derived) {
          amount = d.amount;
          unit = d.inputUnit ?? inputUnit;
        }
      } catch (e) {
        const { reason, detail } = txnImportReason(e);
        push(fail(base, reason, detail));
        continue;
      }
    }
    if (!(amount > 0)) {
      push(fail(base, typed == null && comp.rule == null ? 'amountInvalid' : 'amountNotPositive', { value: rec.amount ?? '' }));
      continue;
    }

    // 0db616f3 — the run this line is FOR, and the file is the only thing allowed to say so. The same
    // vocabulary as the Fixed Transaction template's `Payroll Cycle` column, so an operator who has used
    // one has used both. Blank means 'regular', which is byte-identical to what every import did before.
    const cycleRaw = (rec.payroll_cycle ?? '').trim().toLowerCase();
    if (cycleRaw !== '' && !(FIXED_TRANSACTION_CYCLES as readonly string[]).includes(cycleRaw)) {
      push(fail(base, 'cycleUnknown', { value: rec.payroll_cycle ?? '' }));
      continue;
    }
    const targetCycle = (cycleRaw === '' ? 'regular' : cycleRaw) as FixedTransactionCycle;

    stage.push({
      rowNum,
      base: { ...base, payItem: comp.name, amount: amount.toFixed(2) },
      failure: null,
      displayCategory: comp.displayCategory,
      cycleStated: cycleRaw !== '',
      r: {
        employmentId: emp.employmentId,
        companyId: emp.companyId,
        departmentId: emp.departmentId,
        componentId: comp.id,
        kind,
        txnDate,
        payPeriod,
        amount,
        quantity,
        unit,
        notes: (rec.notes ?? '').trim() || comp.name,
        targetCycle,
        sourceRef: fileRowRef(digest, rowNum),
      },
    });
  }

  // ── THE TARGETING AND DUPLICATE PASS. Everything below needs the whole file, so none of it could run
  //    in the loop above. Two reads for the file, not two per row. ──
  const staged = stage.filter((s) => s.r != null);
  const periods = [...new Set(staged.map((s) => s.r!.payPeriod))];
  const companyIds = [...new Set(staged.map((s) => s.r!.companyId))];
  // `listBatches` is the same read the Add form's page makes, so a file and the form resolve against the
  // same set of runs. Both projections used below (`runType`, `status`) come from it.
  const allBatches = periods.length > 0 && companyIds.length > 0 ? await listBatches(ctx, companyIds, periods) : [];
  const ledger = await loadLedgerRows(ctx, [...new Set(staged.map((s) => s.r!.employmentId))]);

  const onFileKeys = new Set(ledger.map((l) => dupKey({ ...l, amount: Number(l.amount).toFixed(2) })));
  // (employment, date, component, source_ref) — the exact key of `payroll_individual_txn_source_ref_uq`.
  // Checking it here rather than letting the index raise 23505 is what keeps the preview honest.
  const onFileRefs = new Set(
    ledger
      .filter((l) => l.sourceRef != null)
      .map((l) => [l.employmentId, l.txnDate, l.componentId ?? '', l.source ?? '', l.sourceRef].join('|')),
  );
  const seenInFile = new Map<string, number>();

  for (const s of stage) {
    if (s.failure) {
      rows.push(s.failure);
      continue;
    }
    const r = s.r!;
    // The run of the resolved cycle, if it is writable and covers this employee — see `batchScopeIncludes`.
    const target = allBatches.find(
      (b) =>
        b.companyId === r.companyId &&
        b.payPeriod === r.payPeriod &&
        b.runType === r.targetCycle &&
        (b.status === 'draft' || b.status === 'processed') &&
        // Read defensively, exactly as app/payroll/transactions/individual/page.tsx does: `listBatches`
        // does not project `scope` today, so this reads undefined and every run is treated as
        // whole-company — which is precisely how the Add form behaves. `createIndividualTxnsBulk`
        // re-checks scope membership authoritatively and refuses with EmploymentNotInBatchScopeError,
        // surfaced as `employeeNotInScope`. If the projection ever grows the column this starts
        // narrowing correctly with no further change.
        batchScopeIncludes((b as { scope?: BatchScopeShape }).scope ?? null, r),
    );
    // A NAMED CYCLE WITH NO RUN IS A REFUSAL, NOT A FALLBACK. Falling back to period-keyed would rebuild
    // the exact defect this item is about: a row that names no cycle is collected by the month's REGULAR
    // run at attach-on-generate (core/payroll.ts), so a row saying "bonus" would be paid by the salary run
    // — which is what January did. c11e81aa lets a non-regular run collect rows naming ITS OWN cycle, which
    // does not soften this: with no such run there is nothing to collect the row at all.
    if (!target && s.cycleStated && r.targetCycle !== 'regular') {
      rows.push(fail(s.base, 'runMissingForCycle', { cycle: r.targetCycle, period: r.payPeriod }));
      continue;
    }
    const key = dupKey({
      batchId: target?.id ?? null,
      companyId: r.companyId,
      payPeriod: r.payPeriod,
      employmentId: r.employmentId,
      componentId: r.componentId,
      amount: r.amount.toFixed(2),
    });
    if (onFileKeys.has(key)) {
      rows.push(fail(s.base, 'duplicateInRun', { code: s.base.payItemCode, amount: r.amount.toFixed(2) }));
      continue;
    }
    const refKey = [r.employmentId, r.txnDate, r.componentId, 'import', r.sourceRef].join('|');
    if (onFileRefs.has(refKey)) {
      rows.push(fail(s.base, 'duplicateImported', { code: s.base.payItemCode, amount: r.amount.toFixed(2) }));
      continue;
    }
    const earlier = seenInFile.get(key);
    if (earlier != null) {
      rows.push(fail(s.base, 'duplicateInFile', { row: earlier, code: s.base.payItemCode }));
      continue;
    }
    seenInFile.set(key, s.rowNum);

    // ── WARNINGS. These do NOT stop the write; they break the SILENCE that let January happen twice. ──
    const warnings: { reason: string; detail?: Record<string, string | number> }[] = [];
    // The run has already produced payslips. Refusing here was considered and rejected: 5c65367d's
    // approved behaviour is that an imported row lands exactly as a typed one does and marks the run for
    // recalculation (the service's own `markBatchNeedsRecalc`), and test/payroll-txn-import.test.ts pins
    // it. What was missing was any acknowledgement AT ALL — the operator saw a clean "12 imported" over a
    // run that had already been paid, decided nothing had happened, and uploaded the file again.
    if (target?.status === 'processed') {
      warnings.push({ reason: 'runAlreadyProcessed', detail: { period: r.payPeriod } });
    }
    // A bonus-coded line heading for the regular run in a month that HAS a writable bonus run. Exactly
    // January's shape, and the reason it is a warning rather than a refusal is that paying a bonus inside
    // the salary run is completely ordinary — only the operator knows which they meant.
    if (
      !s.cycleStated &&
      s.displayCategory === 'bonus' &&
      r.targetCycle === 'regular' &&
      allBatches.some(
        (b) =>
          b.companyId === r.companyId &&
          b.payPeriod === r.payPeriod &&
          b.runType === 'bonus' &&
          (b.status === 'draft' || b.status === 'processed'),
      )
    ) {
      warnings.push({ reason: 'bonusRunExists', detail: { code: s.base.payItemCode } });
    }

    rows.push({ ...s.base, ok: true, reason: '', ...(warnings.length > 0 ? { warnings } : {}) });
    resolved.set(s.rowNum, { ...r, targetBatchId: target?.id ?? null });
  }

  const valid = rows.filter((x) => x.ok).length;
  const warned = rows.filter((x) => (x.warnings?.length ?? 0) > 0).length;
  return {
    preview: { kind: 'individual', total: rows.length, valid, invalid: rows.length - valid, warned, rows },
    resolved,
  };
}

/** Dry run: the verdicts only. Writes nothing, appends no event — a preview is a read. */
export async function validateTxnImport(
  ctx: SessionContext,
  p: { kind: TxnImportKind; scopeIds: string[]; records: TxnImportRecord[] },
): Promise<TxnImportPreview> {
  return (await analyzeTxnImport(ctx, p)).preview;
}

/**
 * Write the valid rows, one at a time, THROUGH THE LIVE SERVICES.
 *
 * RE-ANALYSED SERVER-SIDE rather than trusting whatever the client believed: the commit writes from its
 * own answer, so a tampered preview cannot widen what gets written.
 *
 * Every row is its own service call and therefore its own transaction. That is the shape the approved
 * plan describes — valid rows land, failures are reported — and it is why `written` is always exactly
 * what happened rather than an intention.
 *
 * On Individual Transaction the service's own `markBatchNeedsRecalc` fires when a row lands on a
 * PROCESSED run, which is what satisfies the request's "must not automatically mark newly imported
 * transactions as Processed". It is free precisely because the write goes through the service.
 */
export async function commitTxnImport(
  ctx: SessionContext,
  p: { kind: TxnImportKind; scopeIds: string[]; records: TxnImportRecord[] },
): Promise<TxnImportResult> {
  const analysis = await analyzeTxnImport(ctx, p);
  const failed: TxnImportRow[] = [];
  const recalcBatchIds = new Set<string>();
  let written = 0;

  const byRow = new Map(analysis.preview.rows.map((r) => [r.rowNum, r]));

  if (analysis.kind === 'fixed') {
    for (const [rowNum, r] of analysis.resolved) {
      try {
        await setEmploymentPayComponent(ctx, {
          employmentId: r.employmentId,
          componentId: r.componentId,
          amount: r.amount,
          effectiveFrom: r.effectiveFrom,
          effectiveTo: r.effectiveTo,
          remarks: r.remarks,
          runType: r.runType,
        });
        written += 1;
      } catch (e) {
        const { reason, detail } = txnImportReason(e);
        failed.push({ ...(byRow.get(rowNum) as TxnImportRow), ok: false, reason, detail });
      }
    }
  } else {
    // 0db616f3 — THE TARGET RUN IS THE PREVIEW'S ANSWER, not a second one worked out here. It used to be
    // re-derived at this point with `runType === 'regular'` hardcoded, which meant the screen could never
    // show the operator which run their file was about to land on — and it always said 'regular' anyway.
    // Deciding it once, in `analyzeIndividual`, is what lets the preview refuse a cycle that has no run
    // and warn about a run that has already been paid.
    const touchedBatchIds = new Set<string>();

    for (const [rowNum, r] of analysis.resolved) {
      try {
        await createIndividualTxnsBulk(ctx, {
          ...(r.targetBatchId ? { batchId: r.targetBatchId } : { companyId: r.companyId, payPeriod: r.payPeriod }),
          employmentIds: [r.employmentId],
          rows: [
            {
              kind: r.kind,
              componentId: r.componentId,
              txnDate: r.txnDate,
              amount: r.amount,
              quantity: r.quantity,
              unit: r.unit,
              notes: r.notes,
              // 4e403268 — provenance. An imported row is not hand-keyed, and saying so is the whole
              // reason the column exists.
              source: 'import',
              // 0db616f3 — and WHICH upload it came from. This used to be null, with a note saying a
              // spreadsheet has no stable record id so a re-upload legitimately posts the rows again.
              // The January double import is what that note cost: `source_ref` was NULL on all 24 rows,
              // so nothing in the database could tell that the same file had arrived twice. The ref is
              // the file's digest plus this row's position in it, and it arms the 0432 uniqueness index
              // (partial on source_ref IS NOT NULL) as the backstop under the pre-flight check.
              sourceRef: r.sourceRef,
            },
          ],
        });
        written += 1;
        if (r.targetBatchId) touchedBatchIds.add(r.targetBatchId);
      } catch (e) {
        const { reason, detail } = txnImportReason(e);
        failed.push({ ...(byRow.get(rowNum) as TxnImportRow), ok: false, reason, detail });
      }
    }
    // Which runs this import made stale, read from the RUNS themselves rather than inferred from what was
    // written — the service marked them inside its own transaction, so this reports the fact. Only runs
    // that actually RECEIVED a row are asked, and it is the row's own target run rather than "the
    // month's regular run", so a bonus-run import reports the bonus run.
    for (const batchId of touchedBatchIds) {
      const impact = await batchEditImpact(ctx, { batchId });
      if (impact?.needsRecalcAt != null) recalcBatchIds.add(batchId);
    }
  }

  return { kind: analysis.kind, written, failed, recalcBatchIds: [...recalcBatchIds] };
}
