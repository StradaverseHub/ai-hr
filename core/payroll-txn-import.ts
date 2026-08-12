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
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { withTenant, type SessionContext } from '../db/client';
import { employmentPayComponent, payComponent } from '../db/schema';
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
  componentByCode: Map<string, { id: string; code: string; name: string; kind: string; rule: PayRule | null }>;
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
      })
      .from(payComponent)
      .where(eq(payComponent.tenantId, ctx.tenantId)),
  );
  const componentByCode = new Map<string, { id: string; code: string; name: string; kind: string; rule: PayRule | null }>();
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
};

/**
 * WHICH RUN AN IMPORTED ONE-OFF ROW LANDS ON — and the answer has to be the SAME one the Add form
 * reaches, or a row typed by hand and the identical row imported would behave differently.
 *
 * The form derives its target from `eligibleBatches`: the writable runs for (company, month) whose scope
 * includes the employee. It offers a choice when there is more than one and keys the row against the
 * month itself when there is none (f1564110 Phase 2's designed pre-run entry flow, which
 * `generatePayslips` later stamps onto the month's regular run).
 *
 * An import has no operator standing there to choose, so it takes the month's REGULAR run — which is the
 * only run that ever collects transactions (core/payroll-view.ts says so, and the stranded-money read is
 * built on it). If there is no writable regular run, the row is keyed by period, exactly as the form
 * would. `createIndividualTxnsBulk` re-checks company match and scope membership authoritatively either
 * way, so this decides WHERE, never WHETHER.
 *
 * WHY NOT JUST ALWAYS KEY BY PERIOD. Because `resolveTxnTarget` returns `status: null` for a period-keyed
 * write, so `markBatchNeedsRecalc` never fires — and the request's "must not automatically mark newly
 * imported transactions as Processed" would silently become "imported rows never mark anything at all",
 * which is the same defect wearing the opposite hat.
 */
type BatchScopeShape = { departmentIds?: string[]; employmentIds?: string[] } | null;
function batchScopeIncludes(scope: BatchScopeShape, e: ResolvedIndividual): boolean {
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

    const emp = cat.employeeByCode.get(employeeId.trim().toUpperCase());
    if (!emp) {
      rows.push(fail(base, 'employeeUnknown', { value: employeeId }));
      continue;
    }
    if (emp === 'ambiguous') {
      rows.push(fail(base, 'employeeAmbiguous', { value: employeeId }));
      continue;
    }
    const comp = cat.componentByCode.get(payItemCode.trim().toUpperCase());
    if (!comp) {
      rows.push(fail(base, 'payItemUnknown', { value: payItemCode }));
      continue;
    }
    base.payItem = comp.name;
    base.employeeName = base.employeeName || emp.name;

    const txnDate = (rec.transaction_date ?? '').trim();
    if (!isIsoDate(txnDate)) {
      rows.push(fail(base, 'txnDateInvalid', { value: txnDate }));
      continue;
    }
    // The month a one-off row belongs to IS its date's month. `assertDateInPeriod` re-checks it against
    // the resolved target, and the write is period-keyed (unattached) when no run exists yet — which is
    // f1564110 Phase 2's designed pre-run entry flow, not a fault.
    const payPeriod = txnDate.slice(0, 7);
    if (!isPayPeriod(payPeriod)) {
      rows.push(fail(base, 'txnDateInvalid', { value: txnDate }));
      continue;
    }

    const kindRaw = (rec.kind ?? '').trim().toLowerCase();
    // Blank Kind falls back to the PAY ITEM's own class, which is what the Add form does: a master
    // allowance is an earning and a master deduction is a deduction. Requiring the operator to restate
    // it would be asking them for something the system already knows.
    const kind = kindRaw !== '' ? kindRaw : comp.kind === 'deduction' ? 'deduction' : 'earning';
    if (!isTxnKind(kind)) {
      rows.push(fail(base, 'kindUnknown', { value: rec.kind ?? '' }));
      continue;
    }

    // WHICH BOX THE OPERATOR HAS TO FILL IS THE PAY ITEM'S DECISION, not the template's. `payRuleInputUnit`
    // is the same resolver the entry form asks, so a file and the form cannot disagree about it.
    const inputUnit = payRuleInputUnit(comp.rule);
    const quantityRaw = (rec.quantity ?? '').trim();
    const quantity = quantityRaw === '' ? null : parseAmountCell(quantityRaw);
    if (quantityRaw !== '' && quantity == null) {
      rows.push(fail(base, 'quantityInvalid', { value: quantityRaw }));
      continue;
    }
    if (inputUnit != null && !(Number(quantity) > 0)) {
      rows.push(fail(base, inputUnit === 'hours' ? 'quantityRequiredHours' : 'quantityRequiredDays'));
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
        rows.push(fail(base, reason, detail));
        continue;
      }
    }
    if (!(amount > 0)) {
      rows.push(fail(base, typed == null && comp.rule == null ? 'amountInvalid' : 'amountNotPositive', { value: rec.amount ?? '' }));
      continue;
    }

    rows.push({ ...base, payItem: comp.name, amount: amount.toFixed(2), ok: true, reason: '' });
    resolved.set(rowNum, {
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
    });
  }

  const valid = rows.filter((x) => x.ok).length;
  return { preview: { kind: 'individual', total: rows.length, valid, invalid: rows.length - valid, rows }, resolved };
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
    // The writable runs for every (company, month) this file touches, read ONCE. `listBatches` is the
    // same read the Add form's page makes, so the two resolve against the same set.
    const periods = [...new Set([...analysis.resolved.values()].map((r) => r.payPeriod))];
    const companyIds = [...new Set([...analysis.resolved.values()].map((r) => r.companyId))];
    const allBatches = periods.length > 0 && companyIds.length > 0 ? await listBatches(ctx, companyIds, periods) : [];

    for (const [rowNum, r] of analysis.resolved) {
      // The month's REGULAR run, if it is writable and covers this employee — see `batchScopeIncludes`.
      const target = allBatches.find(
        (b) =>
          b.companyId === r.companyId &&
          b.payPeriod === r.payPeriod &&
          b.runType === 'regular' &&
          (b.status === 'draft' || b.status === 'processed') &&
          // Read defensively, exactly as app/payroll/transactions/individual/page.tsx does: `listBatches`
          // does not project `scope` today, so this reads undefined and every run is treated as
          // whole-company — which is precisely how the Add form behaves. `createIndividualTxnsBulk`
          // re-checks scope membership authoritatively and refuses with EmploymentNotInBatchScopeError,
          // surfaced below as `employeeNotInScope`. If the projection ever grows the column this starts
          // narrowing correctly with no further change.
          batchScopeIncludes((b as { scope?: BatchScopeShape }).scope ?? null, r),
      );
      try {
        await createIndividualTxnsBulk(ctx, {
          ...(target ? { batchId: target.id } : { companyId: r.companyId, payPeriod: r.payPeriod }),
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
              // reason the column exists. It carries no source_ref: a spreadsheet has no stable record
              // id, so the uniqueness guard (which is partial on source_ref IS NOT NULL) does not apply
              // and re-uploading the same file legitimately posts the rows again.
              source: 'import',
            },
          ],
        });
        written += 1;
      } catch (e) {
        const { reason, detail } = txnImportReason(e);
        failed.push({ ...(byRow.get(rowNum) as TxnImportRow), ok: false, reason, detail });
      }
    }
    // Which runs this import made stale, read from the RUNS themselves rather than inferred from what
    // was written — the service marked them inside its own transaction, so this reports the fact.
    for (const r of analysis.resolved.values()) {
      const impact = await batchEditImpactFor(ctx, r.companyId, r.payPeriod);
      if (impact) recalcBatchIds.add(impact);
    }
  }

  return { kind: analysis.kind, written, failed, recalcBatchIds: [...recalcBatchIds] };
}

/** The processed run for (company, month) that now owes a recalculation, or null. Deliberately reads
 *  `batchEditImpact`'s own answer rather than re-deciding which runs are stale. */
async function batchEditImpactFor(ctx: SessionContext, companyId: string, payPeriod: string): Promise<string | null> {
  const batches = await listBatches(ctx, [companyId], payPeriod);
  const batch = batches.find((b) => b.payPeriod === payPeriod && b.runType === 'regular' && b.status === 'processed');
  if (!batch) return null;
  const impact = await batchEditImpact(ctx, { batchId: batch.id });
  return impact?.needsRecalcAt != null ? batch.id : null;
}
