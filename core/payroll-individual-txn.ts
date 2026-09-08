/**
 * 1.2.2 Individual Transaction (ADR-0056, amended by f1564110 Phase 2) — a pure dated one-off payroll
 * transaction ledger.
 *
 * Per-employee, non-recurring transactions of five kinds (earning / deduction / overtime / unpaid / leave),
 * each tied to a transaction date and belonging to exactly one (company, pay month). A row is EITHER
 * attached to a month+cycle batch (batchId set — the original shape) OR unattached (batchId NULL,
 * companyId + payPeriod set): keyed in BEFORE any payroll run exists for the month, then stamped onto a run
 * automatically inside generatePayslips (attach-on-generate, core/payroll.ts) — the month's REGULAR run for
 * a row that names no cycle, and since c11e81aa the run whose OWN cycle the row names when it names one
 * (`collectableCycleIds`). "The regular run collects everything" is no longer true and code that still
 * assumes it is stale, not merely imprecise. Deleting
 * a draft run DETACHES its rows back to unattached instead of destroying them (teardownDraftChildren).
 *
 * Scope: the LEDGER lives here; kernel consumption (f1564110 Phase 3) lives in core/payroll.ts behind
 * INDIVIDUAL_TXN_PAY_ENABLED (default OFF ⇒ the ledger stays record-only, byte-identical). Flag on, the
 * generate fold pays/deducts the batch's rows: earning/deduction rows ride the typed-pay-component fold
 * (component statutory flags; componentless legacy rows use conservative defaults), overtime adds to the OT
 * figure, unpaid adds to the unpaid deduction, leave stays record-only (v1). `quantity`/`unit` remain
 * descriptive. "No carry-forward" is keyed by `payPeriod`: a row belongs to a single month and nothing
 * copies it forward.
 *
 * Substrate discipline: every write appends a DomainEvent. Payloads are redaction-safe (reference ids + kind,
 * no cleartext amounts — ADR-0030 Layer-0 precedent, mirroring setEmploymentPayComponent).
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  company,
  employment,
  payComponent,
  payrollBatch,
  payrollCycle,
  payrollIndividualTxn,
  person,
  type PayrollTxnKind,
} from '../db/schema';
import {
  BatchNotDraftError,
  PayrollPermissionDeniedError,
  daysInMonth,
  markBatchNeedsRecalc,
  resolveBatchScopeFilter,
  resolvePayrollPermission,
  type BatchScope,
} from './payroll';
import { employedByCompanyDuring } from './employment-company';
import { settingEnabled } from './entitlements';

const money = (v: number) => Number(v).toFixed(2);

/** The five transaction kinds (kept in sync with payrollTxnKindEnum). */
export const TXN_KINDS = ['earning', 'deduction', 'overtime', 'unpaid', 'leave'] as const;
export type TxnKind = (typeof TXN_KINDS)[number];
export const isTxnKind = (v: unknown): v is TxnKind => TXN_KINDS.includes(v as TxnKind);

/** The descriptive unit set for `quantity` (validated app-side; mirrors the ROUNDING_METHODS pattern). */
export const TXN_UNITS = ['amount', 'qty', 'hours', 'days', 'units'] as const;
export type TxnUnit = (typeof TXN_UNITS)[number];
export const isTxnUnit = (v: unknown): v is TxnUnit => TXN_UNITS.includes(v as TxnUnit);

/**
 * 4e403268 (0432) — WHERE a ledger line came from. Same shape as TXN_UNITS above and for the same reason:
 * a text column validated by ONE literal set here, not a pg enum that costs a migration every time another
 * module learns to post into payroll.
 *
 * `manual` is first and is the DEFAULT MEANING OF NULL — see `txnSourceOf`. That is what makes this
 * column additive with no backfill: every row written before 0432 was keyed by hand, so reading null as
 * 'manual' states the truth about all of them.
 *
 * Nothing writes anything but 'manual' today. Attendance and Leave do not post into this ledger (the
 * request's points 13–15), and the Import / Sync button from the wireframe is deliberately not built —
 * it would be furniture with no behaviour behind it. The vocabulary and the uniqueness guard exist so
 * that work is a writer, not a schema change.
 */
export const TXN_SOURCES = ['manual', 'attendance', 'leave', 'import', 'system'] as const;
export type TxnSource = (typeof TXN_SOURCES)[number];
export const isTxnSource = (v: unknown): v is TxnSource => TXN_SOURCES.includes(v as TxnSource);
/** A stored `source` as the application reads it. NULL means 'manual' — never "unknown". */
export const txnSourceOf = (v: string | null | undefined): TxnSource => (isTxnSource(v) ? v : 'manual');

/** Thrown when an individual-transaction row is absent (missing / already-deleted id). Distinct from
 *  `BatchNotDraftError`, which is reserved for the real non-draft batch case. */
export class TxnNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Individual transaction ${id} was not found.`);
    this.name = 'TxnNotFoundError';
  }
}

/** Thrown when an entry's `kind` is not one of the five supported kinds. */
export class InvalidTxnKindError extends Error {
  constructor(public readonly kind: string) {
    super(`"${kind}" is not a valid individual-transaction kind.`);
    this.name = 'InvalidTxnKindError';
  }
}

/** Thrown when an entry's `unit` is not one of the five supported units. */
export class InvalidTxnUnitError extends Error {
  constructor(public readonly unit: string) {
    super(`"${unit}" is not a valid individual-transaction unit.`);
    this.name = 'InvalidTxnUnitError';
  }
}

/** 4e403268 — thrown when an entry's `source` is not one of TXN_SOURCES. Refused rather than coerced to
 *  'manual': a row whose provenance we cannot name must not be recorded as hand-keyed. */
export class InvalidTxnSourceError extends Error {
  constructor(public readonly source: string) {
    super(`"${source}" is not a valid individual-transaction source.`);
    this.name = 'InvalidTxnSourceError';
  }
}

/** Thrown when an entry's `txnDate` is outside the batch's pay-period month (calendar-month bounds). */
export class TxnDateOutOfPeriodError extends Error {
  constructor(
    public readonly txnDate: string,
    public readonly periodStart: string,
    public readonly periodEnd: string,
  ) {
    super(`Transaction date ${txnDate} is outside the pay period ${periodStart}…${periodEnd}.`);
    this.name = 'TxnDateOutOfPeriodError';
  }
}

/** Thrown when a bulk row's `amount` is not strictly positive. Deductions are represented by
 *  kind='deduction' with a POSITIVE magnitude (the ledger stores amounts as magnitudes via money()),
 *  so zero/negative is never a legitimate value. Kept as a validation-key throw (not an exported class)
 *  per the actions.ts friendly-key pattern; surfaced as the 'amountNotPositive' key. */
export class AmountNotPositiveError extends Error {
  constructor(public readonly amount: number) {
    super(`Amount ${amount} must be greater than zero.`);
    this.name = 'AmountNotPositiveError';
  }
}

/** Thrown when the chosen employment does not belong to the batch's company. The employee-first flow can
 *  otherwise resolve a batch in the wrong company (createIndividualTxn does not cross-check), so the bulk
 *  wrapper is the defence-in-depth backstop behind the UI's company filter (C3). */
export class CompanyMismatchError extends Error {
  constructor(
    public readonly employmentCompanyId: string,
    public readonly batchCompanyId: string,
  ) {
    super(`Employment company ${employmentCompanyId} does not match batch company ${batchCompanyId}.`);
    this.name = 'CompanyMismatchError';
  }
}

/**
 * WHY A SCOPED RUN EXCLUDES SOMEBODY, as a token the screens turn into a sentence.
 *
 * 4b909202 — an operator reads "the run was set up for the Finance department" and "the run names its
 * own list of people" as two different situations with two different fixes, and the old refusal said
 * neither. `mixed` is a run that carries both dimensions at once, which is neither of those sentences
 * and must not be told as though it were one of them.
 */
export const BATCH_SCOPE_REASONS = ['departments', 'employees', 'mixed'] as const;
export type BatchScopeReason = (typeof BATCH_SCOPE_REASONS)[number];

/**
 * The facts a scope refusal has to be able to name. Built at the throw site (where the run and the
 * employee are both already resolved) rather than re-derived by whoever catches it, so the screen, the
 * import's downloadable error report and any future caller all say the same thing about one situation.
 *
 * `employeeName` is a person's own name, not a translated word — it is safe to carry through a service
 * boundary that must otherwise stay locale-free (see `txnImportReason`).
 *
 * `payPeriod` CROSSES AS THE RAW ISO MONTH, 'YYYY-MM', AND EVERY CATALOGUE INTERPOLATES IT VERBATIM —
 * no locale turns it into a month name today, so what the operator reads is "2026-05" in all six. (An
 * earlier version of this note claimed the catalogue formats it; it does not, and a reader who went
 * looking for that formatting step would not find one.) It crosses as DATA rather than as a built
 * string because that is what leaves the choice open: a locale that later wants "Mei 2026" can add the
 * date skeleton at its own key without this boundary — or any of its callers — changing.
 */
export type BatchScopeRefusalDetail = {
  /** The run's pay month, 'YYYY-MM'. */
  payPeriod: string;
  /** The excluded employee, as the operator knows them (full name, else employee code). */
  employeeName: string;
  reason: BatchScopeReason;
  /**
   * r255 — CAN THIS REFUSAL BE RESOLVED BY WIDENING THE RUN? True only when the employment is
   * period-active on the run's company (the dated window the reprocess ADD classification applies), i.e.
   * when `addEmploymentToBatchScope` would both succeed AND leave a run that can still be closed.
   *
   * The screen offers "Add {employee} to this run" ONLY when this is true. Offering it otherwise marks a
   * processed run for a recalculation nobody can perform — the added person has no payslip, so the
   * Reprocess screen never lists them, `reprocessSelectedEmployees` classifies them 'neither', and
   * `removeEmployeePayroll` has nothing to remove: the run cannot be closed again without a full reset.
   * A refusal with no way forward is what this round set out to remove; a BUTTON with no way forward
   * would have been worse than the refusal it replaced.
   */
  canAddToRun: boolean;
};

/** Thrown when the batch's scope (departments / explicit employments) excludes the chosen employment.
 *  A scoped batch narrows generation to a subset; the ledger FK does not enforce membership, so an
 *  out-of-scope row would be silently ignored at generation — reject it here instead (C4).
 *
 *  4b909202 — IT CARRIES ITS DETAIL. This is the refusal the reporter quoted ("This employee is not
 *  included in the selected payroll run"), and the complaint was not that it fires: it is that it names
 *  nothing. It has never been about the run's STATUS — it fires identically on a draft — so a message
 *  that leaves the operator guessing sends them to look at the wrong thing entirely. `detail` is
 *  required rather than optional precisely so no future throw site can reintroduce the bare sentence. */
export class EmploymentNotInBatchScopeError extends Error {
  constructor(
    public readonly employmentId: string,
    public readonly batchId: string,
    public readonly detail: BatchScopeRefusalDetail,
  ) {
    super(`Employment ${employmentId} is not in the scope of batch ${batchId}.`);
    this.name = 'EmploymentNotInBatchScopeError';
  }
}

/**
 * r255 — Thrown when a run is asked to take on somebody who was NOT EMPLOYED during its pay month.
 *
 * WHY WIDENING HAS TO REFUSE THIS AND NOT MERELY DECLINE TO HELP. `addEmploymentToBatchScope` widens the
 * scope and, on a processed run, marks the employment for recalculation in the same transaction. The
 * mark is what Close refuses past — and the only things that can CLEAR it are a reprocess that writes
 * the person a payslip, a removal of a payslip they have, or a full reset of the run. All three of those
 * apply the dated window (`hiredOn <= period end`, `terminatedOn` null-or-`>= period start`, employed by
 * the company during the window), so an employment outside it can be marked and then never unmarked: the
 * operator is left holding a processed run they cannot close and cannot repair from any screen.
 *
 * So the window is tested BEFORE the widening, with the same three facts the reprocess ADD
 * classification reads, and the refusal names the run and the month rather than widening into a dead end.
 */
export class EmploymentNotActiveInPeriodError extends Error {
  constructor(
    public readonly employmentId: string,
    public readonly batchId: string,
    public readonly payPeriod: string,
  ) {
    super(`Employment ${employmentId} was not employed during ${payPeriod}, so batch ${batchId} cannot cover it.`);
    this.name = 'EmploymentNotActiveInPeriodError';
  }
}

/** Thrown when a multi-employee bulk save is called with an empty employee selection. The wizard now
 *  supports selecting one OR many employees; zero is never valid — a save must name at least one payee. */
export class EmptyEmployeeSelectionError extends Error {
  constructor() {
    super('At least one employee must be selected for a one-off transaction.');
    this.name = 'EmptyEmployeeSelectionError';
  }
}

/** Thrown when the submitted grid contains two IDENTICAL rows (same kind + date + amount + remarks). Two
 *  legitimate same-day claims always differ in amount or remarks; a byte-for-byte duplicate row is a keying
 *  mistake (a double paste / double-click), so we reject it before write rather than silently double-post the
 *  same allowance/deduction. Detection is scoped to WITHIN one submission — recording the same grid for many
 *  employees (the multi-employee cartesian) is expressly allowed and never treated as a duplicate. */
export class DuplicateTxnRowError extends Error {
  constructor(public readonly signature: string) {
    super(`Duplicate transaction row: ${signature}.`);
    this.name = 'DuplicateTxnRowError';
  }
}

/** Canonical signature of a grid row for duplicate detection (kind + component + date + normalised amount +
 *  remarks). The component id participates (Phase 3): two same-amount rows on DIFFERENT master items are two
 *  legitimate distinct entries, not a double paste. */
function txnRowSignature(r: { kind: string; txnDate: string; amount: number; notes?: string | null; componentId?: string | null }): string {
  return [r.kind, r.componentId ?? '', r.txnDate, money(r.amount), (r.notes ?? '').trim().toLowerCase()].join('|');
}

/** Thrown when a period-keyed (unattached) write carries a malformed pay period (must be 'YYYY-MM'). */
export class InvalidPayPeriodError extends Error {
  constructor(public readonly payPeriod: string) {
    super(`"${payPeriod}" is not a valid pay period (expected YYYY-MM).`);
    this.name = 'InvalidPayPeriodError';
  }
}

/** Thrown when a write names NEITHER a batch NOR a (company, pay period) pair — the row would be
 *  unaddressable (the 0175 CHECK enforces the same invariant at the DB layer). */
export class MissingTxnTargetError extends Error {
  constructor() {
    super('Either a batchId or a (companyId, payPeriod) pair is required.');
    this.name = 'MissingTxnTargetError';
  }
}

/** 'YYYY-MM' shape check for period-keyed writes (mirrors the 0175 format CHECK). */
export const isPayPeriod = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}$/.test(v);

// ───────────────────── f1564110 Phase 3 — component-carrying payable rows ─────────────────────

/** True when the payroll kernel consumes this ledger (INDIVIDUAL_TXN_PAY_ENABLED). Read per call, not at
 *  module load, so tests (and a restarted server) see the live env value — mirrors the kernel's own read. */
export const individualTxnPayEnabled = (ctx: SessionContext): boolean =>
  settingEnabled(ctx, 'payroll.individual_txn_pay_enabled');

/** The two payable ledger kinds — the only kinds that may (and, flag-on, must) carry a component. */
export const PAYABLE_TXN_KINDS: readonly TxnKind[] = ['earning', 'deduction'];

/** Thrown when a NEW payable (earning/deduction) row is keyed without a Payroll Item Master component while
 *  INDIVIDUAL_TXN_PAY_ENABLED is on. With the kernel consuming the ledger, the component supplies the
 *  statutory flags (EPF/SOCSO/PCB/HRDF) — requiring the pick prevents silently mis-taxed one-offs. Legacy
 *  componentless rows (keyed before the flag) still fold with conservative defaults; only NEW writes are
 *  gated. Create-paths only — an edit of a legacy row is not a new payable row. */
export class ComponentRequiredError extends Error {
  constructor(public readonly kind: string) {
    super(`A pay item (component) is required for a new "${kind}" transaction while individual-transaction pay is enabled.`);
    this.name = 'ComponentRequiredError';
  }
}

/** Thrown when a row's component pick is invalid: unknown/archived component, a component on a
 *  non-payable kind (overtime/unpaid/leave never carry one), or a catalog kind that does not match the
 *  row kind (an 'allowance' component belongs on an earning row; a 'deduction' component on a deduction). */
export class InvalidTxnComponentError extends Error {
  constructor(public readonly reason: 'not_found' | 'archived' | 'kind_mismatch' | 'not_payable_kind') {
    super(`Invalid pay-item component for this transaction (${reason}).`);
    this.name = 'InvalidTxnComponentError';
  }
}

/**
 * c11e81aa — thrown when the Pay Cycle named on a write cannot be honoured.
 *
 * Four reasons, and every one of them is a REFUSAL rather than a silent fallback, because the fallback is
 * what the whole change exists to remove: a row that names a cycle nobody can pay it under must not be
 * quietly written as "no cycle" and then collected by the regular run.
 *
 *  - `not_found`      — no such cycle row (or RLS hides it).
 *  - `archived`       — the cycle has been retired from the catalogue, so no run of it will be opened.
 *  - `company_mismatch` — the cycle belongs to another company; cycle ids are per company.
 *  - `run_mismatch`   — the write targets an EXISTING run that is not this cycle's run. This is the
 *                       "validate any change to the Pay Cycle before saving" case: moving a row between
 *                       runs is not something this ledger's edit path does, so naming a cycle that
 *                       disagrees with the run the row is on is refused rather than half-applied.
 *                       Compared by CYCLE ID against `payroll_batch.payroll_cycle_id` where the run has
 *                       one — three default cycles share run_type 'off_cycle', so a type comparison
 *                       would happily attach a "Mid-Month" row to the "Advance Salary" run and pay it
 *                       there, which is the very collision `intended_cycle_id` exists to prevent. A run
 *                       created before 0441 names no cycle, and there the run TYPE is all there is.
 */
export class InvalidTxnCycleError extends Error {
  constructor(public readonly reason: 'not_found' | 'archived' | 'company_mismatch' | 'run_mismatch') {
    super(`Invalid pay cycle for this transaction (${reason}).`);
    this.name = 'InvalidTxnCycleError';
  }
}

/**
 * c11e81aa — validate an intended Pay Cycle against the write's own target, and return the id to store.
 *
 * `undefined` means "the caller said nothing about the cycle" and leaves the stored value alone; `null`
 * means "no cycle", which is what every row on production carries today and what attach-on-generate reads
 * as "the regular run may collect me".
 *
 * The company is taken from the RESOLVED TARGET, never from the client: a cycle id from a company the
 * caller can see but this row does not belong to is exactly the cross-company write the scope fence
 * exists to stop, and it would otherwise route somebody else's money.
 */
async function resolveIntendedCycleId(
  tx: Tx,
  p: {
    intendedCycleId: string | null | undefined;
    companyId: string;
    /** The run the row is (or is becoming) attached to, when there is one — null for a period-keyed row. */
    batchRunType: string | null;
    /** That run's OWN cycle (`payroll_batch.payroll_cycle_id`), null on a run created before 0441. */
    batchCycleId: string | null;
  },
): Promise<string | null | undefined> {
  if (p.intendedCycleId === undefined) return undefined;
  if (p.intendedCycleId === null || p.intendedCycleId === '') return null;
  const [row] = await tx
    .select({
      id: payrollCycle.id,
      companyId: payrollCycle.companyId,
      runType: payrollCycle.runType,
      archivedAt: payrollCycle.archivedAt,
    })
    .from(payrollCycle)
    .where(eq(payrollCycle.id, p.intendedCycleId))
    .limit(1);
  if (!row) throw new InvalidTxnCycleError('not_found');
  if (row.companyId !== p.companyId) throw new InvalidTxnCycleError('company_mismatch');
  if (row.archivedAt != null) throw new InvalidTxnCycleError('archived');
  // IDENTITY FIRST, TYPE ONLY AS THE LEGACY FALLBACK. A row written straight onto an existing run is
  // never seen by attach-on-generate again, so the ONLY moment its cycle can be checked against the run
  // that will pay it is here. Comparing run types would let a "Mid-Month" row be keyed onto the "Advance
  // Salary" run and paid there — the same collision, reached through the attached path instead.
  if (p.batchCycleId != null) {
    if (row.id !== p.batchCycleId) throw new InvalidTxnCycleError('run_mismatch');
  } else if (p.batchRunType != null && row.runType !== p.batchRunType) {
    throw new InvalidTxnCycleError('run_mismatch');
  }
  return row.id;
}

/** Map a Payroll Item Master catalog kind onto the ledger txn kind it may attach to. 'non_payable' (BIK)
 *  components ride an earning row — the kernel folds them into an informational record line, never cash. */
const COMPONENT_KIND_TO_TXN_KIND: Record<string, TxnKind | undefined> = {
  allowance: 'earning',
  non_payable: 'earning',
  deduction: 'deduction',
};

/** Validate a batch of (componentId, txnKind) pairs in ONE query. Throws InvalidTxnComponentError /
 *  ComponentRequiredError per the Phase-3 rules; returns silently when every pair is valid. */
async function assertTxnComponents(
  tx: Tx,
  rows: Array<{ kind: TxnKind; componentId?: string | null }>,
  // Create paths require a component on payable rows when the pay flag is on; the EDIT path passes false
  // (patching a legacy componentless row is not a NEW payable row — it keeps folding with defaults).
  // Was `= individualTxnPayEnabled()` — a DEFAULT ARGUMENT reading process.env. That cannot survive
  // the move to a per-tenant setting: a default is evaluated without the caller's session. Now
  // required, and computed at each call site where the ctx actually is.
  requireForPayable: boolean,
): Promise<void> {
  const requirePayableComponent = requireForPayable;
  for (const r of rows) {
    const payable = PAYABLE_TXN_KINDS.includes(r.kind);
    if (r.componentId != null && !payable) throw new InvalidTxnComponentError('not_payable_kind');
    if (r.componentId == null && payable && requirePayableComponent) throw new ComponentRequiredError(r.kind);
  }
  const ids = [...new Set(rows.map((r) => r.componentId).filter((v): v is string => v != null))];
  if (ids.length === 0) return;
  const comps = await tx
    .select({ id: payComponent.id, kind: payComponent.kind, archivedAt: payComponent.archivedAt })
    .from(payComponent)
    .where(inArray(payComponent.id, ids));
  const byId = new Map(comps.map((c) => [c.id, c]));
  for (const r of rows) {
    if (r.componentId == null) continue;
    const c = byId.get(r.componentId);
    if (!c) throw new InvalidTxnComponentError('not_found');
    if (c.archivedAt != null) throw new InvalidTxnComponentError('archived');
    if (COMPONENT_KIND_TO_TXN_KIND[c.kind] !== r.kind) throw new InvalidTxnComponentError('kind_mismatch');
  }
}

/**
 * The write target of a create: EITHER an existing DRAFT batch (attached — the original flow) OR a
 * (company, pay month) pair (unattached — f1564110 Phase 2: entry before any run exists). Resolution
 * returns the uniform tuple every guard below consumes; `batchId` is null for the unattached case, and
 * `scope` is null too (an unattached row is month-wide — scope membership is applied at attach-on-generate,
 * which only stamps in-scope employments).
 */
export type TxnTarget = { batchId: string } | { companyId: string; payPeriod: string };

async function resolveTxnTarget(
  tx: Tx,
  p: { batchId?: string | null; companyId?: string | null; payPeriod?: string | null },
): Promise<{
  batchId: string | null;
  companyId: string;
  payPeriod: string;
  scope: BatchScope | null;
  /** null for the unattached case — there is no run to be stale. */
  status: WritableBatchStatus | null;
  /** c11e81aa — the target run's type, null when the row is period-keyed (no run to disagree with). */
  runType: string | null;
  /** c11e81aa — the target run's own cycle; null when period-keyed OR when the run predates 0441. */
  payrollCycleId: string | null;
}> {
  if (p.batchId) {
    const { payPeriod, companyId, scope, status, runType, payrollCycleId } = await loadWritableBatch(tx, p.batchId);
    return { batchId: p.batchId, companyId, payPeriod, scope, status, runType, payrollCycleId };
  }
  if (!p.companyId || !p.payPeriod) throw new MissingTxnTargetError();
  if (!isPayPeriod(p.payPeriod)) throw new InvalidPayPeriodError(p.payPeriod);
  // The company must exist in-tenant (RLS also scopes it); fail loudly rather than insert a dangling FK.
  const [co] = await tx.select({ id: company.id }).from(company).where(eq(company.id, p.companyId)).limit(1);
  if (!co) throw new MissingTxnTargetError();
  return {
    batchId: null,
    companyId: p.companyId,
    payPeriod: p.payPeriod,
    scope: null,
    status: null,
    runType: null,
    payrollCycleId: null,
  };
}

export type IndividualTxnRow = {
  id: string;
  employmentId: string;
  name: string;
  employeeCode: string | null;
  kind: PayrollTxnKind;
  txnDate: string;
  amount: string;
  quantity: string | null;
  unit: string | null;
  notes: string | null;
};

/** Derive the inclusive calendar-month bounds of a batch's pay period (same pattern as the kernel). */
function periodBounds(payPeriod: string): { periodStart: string; periodEnd: string } {
  const [year, month1] = payPeriod.split('-').map(Number);
  const periodStart = `${payPeriod}-01`;
  const periodEnd = `${payPeriod}-${String(daysInMonth(year, month1)).padStart(2, '0')}`;
  return { periodStart, periodEnd };
}

/**
 * The batch statuses in which this ledger may still be WRITTEN.
 *
 * 49e7e0a2 WIDENED THIS FROM 'draft' ALONE, AND THE MEASUREMENT IS THE ARGUMENT. Every payroll run on
 * production sits at `processed` — not one draft and not one closed run exists — so a draft-only write
 * window is not a narrow inconvenience, it is a permanent freeze, and the only way to correct a one-off
 * transaction was to reset the whole run.
 *
 * `closed` is NOT here and never will be: it is trigger-frozen by 0011_payroll_immutability.sql, so an
 * app that appeared to permit it would be offering an edit the database rejects. A status this build does
 * not recognise is refused for the same reason `getIndividualTxn` reports it as not editable — the
 * mistake that matters is permitting a write onto figures that have been paid without saying so.
 */
export const WRITABLE_BATCH_STATUSES = ['draft', 'processed'] as const;
export type WritableBatchStatus = (typeof WRITABLE_BATCH_STATUSES)[number];

/**
 * Load a batch this ledger may write to (or throw if closed / not found). Returns period + company +
 * scope so the bulk wrapper can enforce the C3 (company match) and C4 (scope membership) correctness
 * guards, plus the STATUS, which the callers need for one reason: a write that lands on a `processed`
 * run has just made that run's payslips, statutory figures and totals disagree with their inputs, and
 * must mark it for recalculation in the same transaction.
 *
 * `BatchNotDraftError` is kept as the thrown type deliberately rather than renamed. It is caught by name
 * in the transaction actions and mapped to on-screen copy, it is asserted by tests across the suite, and
 * what it means — "this run is not in a state this write is allowed on" — has not changed. Only the set
 * of allowed states has. The copy behind it now says "closed", which is what it now means.
 */
export async function loadWritableBatch(
  tx: Tx,
  batchId: string,
): Promise<{
  payPeriod: string;
  companyId: string;
  scope: BatchScope | null;
  status: WritableBatchStatus;
  /** c11e81aa — the run's own type. Still needed: it is all a run created before 0441 records about the
   *  cycle that opened it, and it is what an intended cycle falls back to being checked against. */
  runType: string;
  /** c11e81aa — the run's own CONFIGURED cycle (`payroll_batch.payroll_cycle_id`); null before 0441. */
  payrollCycleId: string | null;
}> {
  const [batch] = await tx
    .select({
      status: payrollBatch.status,
      payPeriod: payrollBatch.payPeriod,
      companyId: payrollBatch.companyId,
      scope: payrollBatch.scope,
      runType: payrollBatch.runType,
      payrollCycleId: payrollBatch.payrollCycleId,
    })
    .from(payrollBatch)
    .where(eq(payrollBatch.id, batchId))
    .limit(1);
  if (!batch) throw new BatchNotDraftError();
  if (!WRITABLE_BATCH_STATUSES.includes(batch.status as WritableBatchStatus)) throw new BatchNotDraftError();
  return {
    payPeriod: batch.payPeriod,
    companyId: batch.companyId,
    scope: (batch.scope as BatchScope | null) ?? null,
    status: batch.status as WritableBatchStatus,
    runType: batch.runType as string,
    payrollCycleId: batch.payrollCycleId ?? null,
  };
}

/** Validate that txnDate falls within the period; throw TxnDateOutOfPeriodError otherwise. Exported for
 *  the bulk wrapper (C5) so it re-uses the identical calendar-month bounds the single-row path uses. */
export function assertDateInPeriod(txnDate: string, payPeriod: string): void {
  const { periodStart, periodEnd } = periodBounds(payPeriod);
  if (txnDate < periodStart || txnDate > periodEnd) {
    throw new TxnDateOutOfPeriodError(txnDate, periodStart, periodEnd);
  }
}

/** List the individual transactions for a batch, joined to person name, ordered by txn date. Read-only. */
export function listIndividualTxns(ctx: SessionContext, p: { batchId: string }): Promise<IndividualTxnRow[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: payrollIndividualTxn.id,
        employmentId: payrollIndividualTxn.employmentId,
        name: person.fullName,
        employeeCode: employment.employeeCode, // Employee ID left-of-name (feedback 38668d9b)
        kind: payrollIndividualTxn.kind,
        txnDate: payrollIndividualTxn.txnDate,
        amount: payrollIndividualTxn.amount,
        quantity: payrollIndividualTxn.quantity,
        unit: payrollIndividualTxn.unit,
        notes: payrollIndividualTxn.notes,
      })
      .from(payrollIndividualTxn)
      .innerJoin(employment, eq(employment.id, payrollIndividualTxn.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(payrollIndividualTxn.batchId, p.batchId))
      .orderBy(asc(payrollIndividualTxn.txnDate), asc(payrollIndividualTxn.id)),
  );
}

/** One ledger row with everything an Edit or a Duplicate needs to reconstruct it — including the picked
 *  Payroll Item Master component, which the LISTING reads (listIndividualTxnsAcross) deliberately do not
 *  carry. `editable` is the service's own unattached-or-draft rule, resolved once here so the caller does
 *  not have to re-derive it (and cannot derive it differently). */
export type IndividualTxnDetail = {
  id: string;
  employmentId: string;
  companyId: string;
  payPeriod: string;
  batchId: string | null;
  kind: PayrollTxnKind;
  componentId: string | null;
  txnDate: string;
  amount: string;
  quantity: string | null;
  unit: string | null;
  notes: string | null;
  /** c11e81aa — the configured Pay Cycle this row was saved against, or null when it named none. The
   *  Edit form prefills its Pay Cycle from this; attach-on-generate routes the row by it. */
  intendedCycleId: string | null;
  /** True while `updateIndividualTxn` / `deleteIndividualTxn` would accept this row. */
  editable: boolean;
  /** 49e7e0a2 — the row sits on a run that is already PROCESSED, so changing it makes that run's payslips,
   *  statutory figures and totals stale and marks it for recalculation. */
  recalcOnEdit: boolean;
};

/** Narrow a stored batch status to one this ledger may write to. A null status is the unattached case and
 *  is handled by the callers (no batch ⇒ no batch gate), not here. */
export const isWritableBatchStatus = (v: string | null | undefined): v is WritableBatchStatus =>
  v != null && (WRITABLE_BATCH_STATUSES as readonly string[]).includes(v);

/**
 * 44129979 — read ONE ledger row by id, for the redesigned screen's Edit and Duplicate actions.
 *
 * WHY THIS EXISTS RATHER THAN A WIDER LISTING FIELD. The screen's right panel is `listIndividualTxnsAcross`
 * (core/payroll-view.ts) — the same read the Transaction View uses, deliberately reused rather than
 * reinvented. That row shape carries no `component_id`, and adding one would change a projection shared
 * with the History screen and its CSV export for the sake of two per-row buttons. A row is opened for edit
 * or copy one at a time, so this is one row by id, on demand — which is also what "review before you
 * change it" means in practice.
 *
 * Returns null for an absent id (RLS already fences the tenant; the caller fences the company scope).
 * Read-only: no write, no domain event.
 */
export function getIndividualTxn(ctx: SessionContext, p: { id: string }): Promise<IndividualTxnDetail | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        id: payrollIndividualTxn.id,
        employmentId: payrollIndividualTxn.employmentId,
        companyId: payrollIndividualTxn.companyId,
        payPeriod: payrollIndividualTxn.payPeriod,
        batchId: payrollIndividualTxn.batchId,
        kind: payrollIndividualTxn.kind,
        componentId: payrollIndividualTxn.componentId,
        txnDate: payrollIndividualTxn.txnDate,
        amount: payrollIndividualTxn.amount,
        quantity: payrollIndividualTxn.quantity,
        unit: payrollIndividualTxn.unit,
        notes: payrollIndividualTxn.notes,
        intendedCycleId: payrollIndividualTxn.intendedCycleId,
        batchStatus: payrollBatch.status,
      })
      .from(payrollIndividualTxn)
      .leftJoin(payrollBatch, eq(payrollBatch.id, payrollIndividualTxn.batchId))
      .where(eq(payrollIndividualTxn.id, p.id))
      .limit(1);
    if (!row) return null;
    const { batchStatus, ...rest } = row;
    return {
      ...rest,
      // The write guard is "unattached, or attached to a batch in WRITABLE_BATCH_STATUSES"
      // (loadWritableBatch throws otherwise). Anything else — a closed run, or a status this build does not
      // know — is reported as not editable, because the mistake that matters is offering an edit the
      // service will refuse.
      editable: row.batchId == null || isWritableBatchStatus(batchStatus),
      /** 49e7e0a2 — true when saving this edit will make a PROCESSED run's figures stale. The screen warns
       *  on it; the service marks the run for recalculation either way. */
      recalcOnEdit: batchStatus === 'processed',
      companyId: rest.companyId as string,
      payPeriod: rest.payPeriod as string,
    } satisfies IndividualTxnDetail;
  });
}

/**
 * Record a dated one-off transaction for one employee — EITHER on a draft batch (batchId; draft-only) OR
 * unattached against a (companyId, payPeriod) month when no run exists yet (f1564110 Phase 2). Date-in-period
 * validated against the resolved month either way. `amount` is the persisted money figure; `quantity`/`unit`
 * are descriptive (any qty×rate resolution is a UI/action concern, not stored semantics in this slice).
 */
export function createIndividualTxn(
  ctx: SessionContext,
  p: {
    batchId?: string;
    companyId?: string;
    payPeriod?: string;
    employmentId: string;
    kind: string;
    txnDate: string;
    amount: number;
    quantity?: number | null;
    unit?: string | null;
    notes?: string | null;
    componentId?: string | null;
  },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    if (!isTxnKind(p.kind)) throw new InvalidTxnKindError(p.kind);
    if (p.unit != null && !isTxnUnit(p.unit)) throw new InvalidTxnUnitError(p.unit);
    // Phase 3 — component pick: validated (exists / not archived / kind match), and REQUIRED for a new
    // payable (earning/deduction) row while INDIVIDUAL_TXN_PAY_ENABLED is on.
    await assertTxnComponents(tx, [{ kind: p.kind, componentId: p.componentId }], individualTxnPayEnabled(ctx));
    const target = await resolveTxnTarget(tx, p);
    assertDateInPeriod(p.txnDate, target.payPeriod);
    // C3 backstop on the unattached path too: the employment must belong to the target company (the batch
    // path's bulk wrapper enforces it; this single-row path now always does, both shapes).
    const [emp] = await tx
      .select({ companyId: employment.companyId })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!emp || emp.companyId !== target.companyId) {
      throw new CompanyMismatchError(emp?.companyId ?? 'unknown', target.companyId);
    }
    const [row] = await tx
      .insert(payrollIndividualTxn)
      .values({
        tenantId: ctx.tenantId,
        batchId: target.batchId,
        companyId: target.companyId,
        payPeriod: target.payPeriod,
        employmentId: p.employmentId,
        kind: p.kind,
        componentId: p.componentId ?? null,
        txnDate: p.txnDate,
        amount: money(p.amount),
        quantity: p.quantity != null ? money(p.quantity) : null,
        unit: p.unit ?? null,
        notes: p.notes ?? null,
      })
      .returning({ id: payrollIndividualTxn.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-individual-txn',
      aggregateId: row.id,
      eventType: 'payroll.individual-txn.created',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      // ADR-0030 Layer 0: amount lives on the aggregate row; payload carries references + kind, not cleartext.
      payload: {
        batchId: target.batchId,
        companyId: target.companyId,
        payPeriod: target.payPeriod,
        employmentId: p.employmentId,
        kind: p.kind,
        componentId: p.componentId ?? null,
        txnDate: p.txnDate,
      },
    });
    // 49e7e0a2 — a row added to an ALREADY-PROCESSED run is money the payslips on that run do not know
    // about. Mark it in the same transaction as the insert: an unmarked processed run is exactly the
    // silent drift this window would otherwise create.
    if (target.batchId != null && target.status === 'processed') {
      await markBatchNeedsRecalc(tx, ctx, { batchId: target.batchId, employmentIds: [p.employmentId] });
    }
    return { id: row.id };
  });
}

/** One editable grid row for the bulk save (Step 3 of the wizard). `componentId` (Phase 3) is the picked
 *  Payroll Item Master item — persisted so the kernel fold can apply its statutory flags. */
export type BulkTxnRow = {
  kind: string;
  txnDate: string;
  amount: number;
  quantity?: number | null;
  unit?: string | null;
  notes?: string | null;
  componentId?: string | null;
  /** 4e403268 — one of TXN_SOURCES. Omitted / null means hand-keyed (see `txnSourceOf`); the day-by-day
   *  grid leaves it null rather than writing the string 'manual', so a hand-keyed row written today is
   *  byte-identical to the 47 already on production and no backfill can ever be needed. */
  source?: string | null;
  /** The originating module's record id. Null for anything keyed by hand. */
  sourceRef?: string | null;
};

/**
 * r255 — WAS THIS EMPLOYMENT EMPLOYED BY THE RUN'S COMPANY DURING THE RUN'S MONTH?
 *
 * The dated window, read off the same three facts `reprocessSelectedEmployees` uses to classify a
 * payslip-less employment as ADDED (core/payroll.ts) and `listPayslipLessEligible` uses to decide who the
 * Reprocess screen may offer: employed by the company during the window (dated, not the column alone —
 * 3c88d593), hired on or before the period end, and not terminated before the period start.
 *
 * IT MUST STAY THE SAME WINDOW AS THOSE TWO. Widening a processed run marks the employment for
 * recalculation; only a reprocess can clear that mark, and a reprocess applies exactly this test. A
 * window that admitted anybody those two would reject would hand the operator a run that cannot be
 * closed and cannot be repaired. (Kept here rather than imported so this ledger owns its own guard;
 * `employedByCompanyDuring` — the one part that is genuinely subtle — IS shared.)
 */
async function isEmployedDuringPeriod(
  tx: Tx,
  p: { employmentId: string; companyId: string; payPeriod: string },
): Promise<boolean> {
  const [y, m] = p.payPeriod.split('-').map(Number);
  const periodStart = `${p.payPeriod}-01`;
  const periodEnd = `${p.payPeriod}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
  const [row] = await tx
    .select({ id: employment.id })
    .from(employment)
    .where(
      and(
        eq(employment.id, p.employmentId),
        employedByCompanyDuring(p.companyId, periodStart, periodEnd),
        lte(employment.hiredOn, periodEnd),
        or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart)),
      ),
    )
    .limit(1);
  return row != null;
}

/**
 * 4b909202 — BUILD THE SCOPE REFUSAL, WITH THE FACTS IT HAS TO NAME.
 *
 * Reached only on the failing branch of C4, which is why it may afford a query: the excluded person's
 * own name is what makes the sentence readable, and paying for it on every successful save would be
 * paying for it a thousand times to use it once. C3 has already proved the employment row exists, so
 * the fallbacks below cover only the impossible.
 *
 * r255 — AND WHETHER THE OFFER THAT GOES WITH IT IS HONEST. `canAddToRun` is the dated window, asked
 * here so the screen decides whether to show "Add {employee} to this run" from the SERVICE's answer
 * rather than from a guess. Same failing branch, so the happy path still pays for nothing.
 */
async function batchScopeRefusal(
  tx: Tx,
  p: { employmentId: string; batchId: string; companyId: string; payPeriod: string; scope: BatchScope | null },
): Promise<EmploymentNotInBatchScopeError> {
  const [who] = await tx
    .select({ name: person.fullName, employeeCode: employment.employeeCode })
    .from(employment)
    .innerJoin(person, eq(person.id, employment.personId))
    .where(eq(employment.id, p.employmentId))
    .limit(1);
  const hasDepartments = (p.scope?.departmentIds ?? []).length > 0;
  const hasEmployments = (p.scope?.employmentIds ?? []).length > 0;
  const reason: BatchScopeReason = hasDepartments && hasEmployments ? 'mixed' : hasDepartments ? 'departments' : 'employees';
  return new EmploymentNotInBatchScopeError(p.employmentId, p.batchId, {
    payPeriod: p.payPeriod,
    employeeName: who?.name?.trim() || who?.employeeCode || p.employmentId,
    reason,
    canAddToRun: await isEmployedDuringPeriod(tx, {
      employmentId: p.employmentId,
      companyId: p.companyId,
      payPeriod: p.payPeriod,
    }),
  });
}

/** What `addEmploymentToBatchScope` did. `added: false` means the run already covered this person —
 *  a whole-company run, or one whose list already names them — which is a no-op, never a failure. */
export type BatchScopeAddResult = {
  added: boolean;
  /** True when the run was PROCESSED and now owes a recalculation for this employment. */
  markedForRecalc: boolean;
  payPeriod: string;
  status: WritableBatchStatus;
};

/**
 * 4b909202 — ADD ONE EMPLOYEE TO A RUN'S SCOPE, from Transaction Entry.
 *
 * WHY THIS EXISTS. The C4 refusal above is correct and stays: a run set up for two departments must not
 * quietly pay somebody outside them. What it lacked was a way forward — the operator was told "no" and
 * left with nothing but "reset the run" or "key it somewhere else". This is the way forward, and it is
 * the ONE genuinely new piece of 4b909202.
 *
 * AN EXPLICIT-EMPLOYMENT EXCEPTION, NOT A REWRITTEN DEPARTMENT CHOICE. A run scoped to "Finance" was
 * scoped that way on purpose, and the operator adding one person from Operations is not retracting that
 * decision — they are naming one exception to it. Appending to `scope.employmentIds` records exactly
 * that, keeps the departments intact, and survives the person later moving department (a department
 * scope resolves to its CURRENT assignees, so rewriting the choice would also drag in everybody else
 * who joined). It is byte-for-byte the same widening `generatePayslips` performs when the Reprocess
 * screen adds somebody to a processed run (fbcf706d work item 5, core/payroll.ts) — the same shape, the
 * same `payroll-batch.scope-widened` event — so one situation leaves one kind of trace in the run's
 * History whichever screen reached it.
 *
 * AND ON A PROCESSED RUN IT MARKS THE PERSON FOR RECALCULATION, in the same transaction. Widening the
 * scope alone would be worse than the refusal it replaces: the transaction would save, the run would say
 * nothing, and the newly added person would simply not be on the payslips — silent, and indistinguishable
 * from working. The mark is what puts them in front of the selective reprocess, which writes a FIRST
 * payslip for an employment that has none on the run (the ADDED classification, core/payroll.ts), and
 * which the run's own Close refuses to run past.
 *
 * REFUSALS IT KEEPS. `loadWritableBatch` throws `BatchNotDraftError` for a CLOSED run, which is the
 * request's own rule and 0011's trigger-level fact — a closed run is not widened by this or anything
 * else. The employment must belong to the run's company, tested with the SAME predicate C4's sibling
 * guard C3 uses (`employment.company_id`), deliberately: admitting somebody C3 would then reject would
 * hand the operator a "fixed" run that refuses the very save the fix was for.
 *
 * r255 — AND IT REFUSES SOMEBODY THE RUN'S MONTH DOES NOT COVER (`EmploymentNotActiveInPeriodError`).
 * This is the guard the first cut lacked, and its absence turned the way forward into a worse dead end
 * than the refusal it replaced: a leaver whose employment ended before the month, widened onto a
 * PROCESSED run, was marked for a recalculation that no screen could ever perform — not the Reprocess
 * screen (`listPayslipLessEligible` applies the dated window, so it never lists them), not
 * `reprocessSelectedEmployees` (it classifies them 'neither' and throws), not `removeEmployeePayroll`
 * (they have no payslip to remove) — leaving a run that could only be un-marked by resetting the whole
 * month to draft. `isEmployedDuringPeriod` is the same window all three of those apply, asked BEFORE the
 * widening, so what this admits is exactly what the reprocess can finish.
 *
 * PERMISSION. On a PROCESSED run this commits the operator to a reprocessing, which is exactly the
 * authority `payroll.reprocess.selective` gates on the Reprocess screen, so it is asserted here too. A
 * DRAFT run's scope has never been permission-gated beyond the screen's own company fence
 * (`updateBatchScope` asserts none), and this does not invent a gate that path has never had.
 *
 * r255 — CONCURRENCY. The scope is a READ-MODIFY-WRITE of one jsonb column, so the batch row is locked
 * FOR UPDATE and the scope re-read from the LOCKED row before anything is computed from it — exactly
 * what `markBatchNeedsRecalc` does, and for the same reason it does it: two admins pressing "Add to this
 * run" for two different people on the same run within the same instant would otherwise both read the
 * pre-add scope and the second write would drop the first person. (The `loadWritableBatch` read above
 * stays: it is the company/period/status resolution, and its status is re-asserted from the locked row.)
 */
export function addEmploymentToBatchScope(
  ctx: SessionContext,
  p: { batchId: string; employmentId: string },
): Promise<BatchScopeAddResult> {
  return withTenant(ctx, async (tx) => {
    const batch = await loadWritableBatch(tx, p.batchId);
    const [emp] = await tx
      .select({ companyId: employment.companyId })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!emp || emp.companyId !== batch.companyId) {
      throw new CompanyMismatchError(emp?.companyId ?? 'unknown', batch.companyId);
    }
    // r255 — SERIALISE THE READ-MODIFY-WRITE. Everything below is computed from `prevScope`, so the read
    // that produces it must hold the row: two concurrent adds that both read the pre-add scope would each
    // write their own person over the other's. The status is re-read with it and re-asserted, so a run
    // closed between `loadWritableBatch` and this lock is refused rather than widened — and the
    // permission below is decided on the LOCKED status, so a run processed in that same gap cannot be
    // widened without the authority a processed run demands.
    const [locked] = await tx
      .select({ scope: payrollBatch.scope, status: payrollBatch.status })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .for('update')
      .limit(1);
    if (!locked || !WRITABLE_BATCH_STATUSES.includes(locked.status as WritableBatchStatus)) throw new BatchNotDraftError();
    const status = locked.status as WritableBatchStatus;
    const prevScope = (locked.scope as BatchScope | null) ?? null;

    if (status === 'processed' && !(await resolvePayrollPermission(tx, ctx, 'payroll.reprocess.selective', batch.companyId))) {
      throw new PayrollPermissionDeniedError('payroll.reprocess.selective');
    }

    const { employmentIds: scopeIds } = await resolveBatchScopeFilter(tx, prevScope);
    // A null resolved set is a WHOLE-COMPANY run: it has no list to widen and already covers this person.
    if (scopeIds === null || scopeIds.includes(p.employmentId)) {
      return { added: false, markedForRecalc: false, payPeriod: batch.payPeriod, status };
    }

    // r255 — THE DATED WINDOW, before anything is written. Asked only on the branch that would actually
    // widen: somebody the run ALREADY covers is not being added to it, so refusing them here would be a
    // refusal of something nobody asked for. See the note above for what marking an employment outside
    // this window does to a processed run.
    if (!(await isEmployedDuringPeriod(tx, { employmentId: p.employmentId, companyId: batch.companyId, payPeriod: batch.payPeriod }))) {
      throw new EmploymentNotActiveInPeriodError(p.employmentId, p.batchId, batch.payPeriod);
    }

    const nextScope: BatchScope = {
      ...(prevScope?.departmentIds?.length ? { departmentIds: prevScope.departmentIds } : {}),
      employmentIds: [...new Set([...(prevScope?.employmentIds ?? []), p.employmentId])],
    };
    await tx.update(payrollBatch).set({ scope: nextScope }).where(eq(payrollBatch.id, p.batchId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.scope-widened',
      actor: actorOf(ctx),
      payload: {
        batchId: p.batchId,
        companyId: batch.companyId,
        payPeriod: batch.payPeriod,
        addedEmploymentIds: [p.employmentId],
        reason: 'individual-transaction-entry',
        before: prevScope,
        after: nextScope,
      },
    });
    // No-op on a draft (it recalculates by being generated); the mark is the processed run's whole point.
    await markBatchNeedsRecalc(tx, ctx, { batchId: p.batchId, employmentIds: [p.employmentId] });
    return {
      added: true,
      markedForRecalc: status === 'processed',
      payPeriod: batch.payPeriod,
      status,
    };
  });
}

/**
 * 1.2.2 — Save a whole grid of dated one-off transactions for ONE OR MANY employees against ONE draft
 * batch, in a SINGLE transaction (the wizard's Step 4 "save all valid entries in one transaction"). The
 * same grid of rows is recorded for EVERY selected employee (a cartesian product: rows × employees), so a
 * payroll admin can pay the same allowance/deduction to twenty people in one atomic pass. Either every row
 * for every employee commits or none does — a mid-transaction failure on any later row rolls back all the
 * earlier inserts and their events. This is the ONE net-new backend method; it deliberately does NOT loop
 * createIndividualTxn / call itself per employee (that opens N transactions with no cross-employee
 * rollback — C5/scope-creep note). Multi-employee is done INSIDE this one transaction.
 *
 * Correctness guards, in order (fail fast, whole-transaction rollback):
 *  - non-empty selection (EmptyEmployeeSelectionError) — at least one payee is required.
 *  - draft batch (BatchNotDraftError) — re-checked inside the transaction so a draft→non-draft flip
 *    between selection and save loses nothing (C8/C10).
 *  - company match PER employee: employment.companyId == batch.companyId (CompanyMismatchError, C3).
 *  - scope membership PER employee: employment ∈ batch.scope (EmploymentNotInBatchScopeError, C4).
 *  - per row: valid kind / unit; date-in-period (assertDateInPeriod); amount > 0 (AmountNotPositiveError, C6).
 *
 * One 'payroll.individual-txn.created' DomainEvent is appended PER inserted row (aggregateId = the new row
 * id, subjectEmploymentId = that row's employee), byte-identical in shape to createIndividualTxn's event,
 * so per-record History/replay attach and the substrate-coverage grep passes (C7).
 */
export function createIndividualTxnsBulk(
  ctx: SessionContext,
  p: {
    batchId?: string;
    companyId?: string;
    payPeriod?: string;
    employmentIds: string[];
    rows: BulkTxnRow[];
    /**
     * c11e81aa — the configured Pay Cycle the operator chose, for the WHOLE submission. On the target
     * rather than on each row because it is a property of where this money is being paid, not of a line:
     * a day-by-day grid is one entry keyed across five dates and cannot land on two different runs.
     *
     * Omitted / null ⇒ no cycle named, which is every row on production today and which the month's
     * REGULAR run collects exactly as it does now.
     */
    intendedCycleId?: string | null;
  },
): Promise<{ ids: string[] }> {
  return withTenant(ctx, async (tx) => {
    // De-dupe the selection defensively (a repeated employee would double-post the grid) and require ≥1 payee.
    const employmentIds = [...new Set(p.employmentIds)];
    if (employmentIds.length === 0) throw new EmptyEmployeeSelectionError();

    // Resolve the write target ONCE inside the transaction: a DRAFT batch (draft re-check happens here —
    // C5/C8) or, since f1564110 Phase 2, an unattached (company, pay month) pair when no run exists yet.
    const target = await resolveTxnTarget(tx, p);
    const { payPeriod, companyId: targetCompanyId, scope } = target;
    // c11e81aa — validated against the RESOLVED target's company (never the client's), and against the
    // target run's type when there is one. Resolved before any insert so a bad cycle costs nothing.
    const intendedCycleId =
      (await resolveIntendedCycleId(tx, {
        intendedCycleId: p.intendedCycleId,
        companyId: targetCompanyId,
        batchRunType: target.runType,
        batchCycleId: target.payrollCycleId,
      })) ?? null;

    // C3 (per employee) — every chosen employment must belong to the target company. One `inArray` query
    // fetches them all; a missing / mismatched employment fails the whole transaction (nothing persists).
    const emps = await tx
      .select({ id: employment.id, companyId: employment.companyId })
      .from(employment)
      .where(inArray(employment.id, employmentIds));
    const companyById = new Map(emps.map((e) => [e.id, e.companyId]));
    for (const eid of employmentIds) {
      const cid = companyById.get(eid);
      if (cid == null || cid !== targetCompanyId) {
        throw new CompanyMismatchError(cid ?? 'unknown', targetCompanyId);
      }
    }

    // C4 (per employee) — every employment must be within the batch's scope (departments ∪ explicit
    // employments). A null/empty scope means "whole company" (already company-matched above), so no
    // membership check is needed then. Unattached writes have no batch scope (target.scope is null);
    // attach-on-generate only stamps in-scope employments onto the eventual run.
    //
    // 4b909202 — THE REFUSAL NAMES THE RUN, THE EMPLOYEE AND THE REASON. The check itself is unchanged
    // and deliberately so: it tests MEMBERSHIP, never status, and firing on a draft run is correct. What
    // changed is that it no longer refuses anonymously. `batchScopeRefusal` reads the excluded person's
    // name, which is why it is only reached on the failing branch — the happy path pays for nothing.
    const { employmentIds: scopeIds } = await resolveBatchScopeFilter(tx, scope);
    if (scopeIds !== null && target.batchId != null) {
      for (const eid of employmentIds) {
        if (!scopeIds.includes(eid)) {
          throw await batchScopeRefusal(tx, {
            employmentId: eid,
            batchId: target.batchId,
            companyId: targetCompanyId,
            payPeriod,
            scope,
          });
        }
      }
    }

    // Validate every row BEFORE inserting any (fail fast) into a typed set — the transaction still guarantees
    // all-or-nothing if a later insert fails (e.g. numeric overflow), which the real-rollback test exercises (C8).
    const validated: Array<{ kind: TxnKind; txnDate: string; amount: number; quantity?: number | null; unit?: string | null; notes?: string | null; componentId?: string | null; source?: string | null; sourceRef?: string | null }> = [];
    const seenSignatures = new Set<string>();
    for (const r of p.rows) {
      if (!isTxnKind(r.kind)) throw new InvalidTxnKindError(r.kind);
      if (r.unit != null && !isTxnUnit(r.unit)) throw new InvalidTxnUnitError(r.unit);
      // 4e403268 — validated with the same shape as `unit` above. Null is legal and means hand-keyed.
      if (r.source != null && !isTxnSource(r.source)) throw new InvalidTxnSourceError(r.source);
      assertDateInPeriod(r.txnDate, payPeriod);
      if (!(r.amount > 0)) throw new AmountNotPositiveError(r.amount); // C6 — magnitude semantics, all 5 kinds
      // Duplicate-record validation: reject a byte-for-byte identical row within the same submission (the
      // reporter's "validate duplicate records before submission"). Distinct amounts/remarks pass through; the
      // multi-employee cartesian below is NOT a duplicate (same grid, different payee).
      const sig = txnRowSignature(r);
      if (seenSignatures.has(sig)) throw new DuplicateTxnRowError(sig);
      seenSignatures.add(sig);
      validated.push({ kind: r.kind, txnDate: r.txnDate, amount: r.amount, quantity: r.quantity, unit: r.unit, notes: r.notes, componentId: r.componentId, source: r.source, sourceRef: r.sourceRef });
    }
    // Phase 3 — component picks validated in ONE query (exists / not archived / kind match); a new payable
    // (earning/deduction) row REQUIRES a component while INDIVIDUAL_TXN_PAY_ENABLED is on.
    await assertTxnComponents(tx, validated, individualTxnPayEnabled(ctx));

    // Cartesian insert: the validated grid is recorded once per selected employee. Outer loop = employees so
    // each row's subjectEmploymentId / payload employmentId names the right payee.
    const ids: string[] = [];
    for (const eid of employmentIds) {
      for (const r of validated) {
        const [row] = await tx
          .insert(payrollIndividualTxn)
          .values({
            tenantId: ctx.tenantId,
            batchId: target.batchId,
            companyId: targetCompanyId,
            payPeriod,
            employmentId: eid,
            kind: r.kind,
            componentId: r.componentId ?? null,
            txnDate: r.txnDate,
            amount: money(r.amount),
            quantity: r.quantity != null ? money(r.quantity) : null,
            unit: r.unit ?? null,
            notes: r.notes ?? null,
            source: r.source ?? null,
            sourceRef: r.sourceRef ?? null,
            intendedCycleId,
          })
          .returning({ id: payrollIndividualTxn.id });
        // C7 — one event PER row, byte-identical in shape to the single-row create event.
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'payroll-individual-txn',
          aggregateId: row.id,
          eventType: 'payroll.individual-txn.created',
          actor: actorOf(ctx),
          subjectEmploymentId: eid,
          // ADR-0030 Layer 0: references + kind, no cleartext amount.
          payload: {
            batchId: target.batchId,
            companyId: targetCompanyId,
            payPeriod,
            employmentId: eid,
            kind: r.kind,
            componentId: r.componentId ?? null,
            txnDate: r.txnDate,
            // c11e81aa — WHICH RUN THIS ROW IS WAITING FOR, recorded at the moment the operator chose it.
            // A reference id, so it stays inside ADR-0030 Layer 0 exactly as componentId does.
            intendedCycleId,
          },
        });
        ids.push(row.id);
      }
    }
    // 49e7e0a2 — one mark for the whole submission, naming every payee it touched, appended once rather
    // than once per row: the mark is a statement about the RUN, and N identical marks would be N history
    // entries saying the same thing.
    if (target.batchId != null && target.status === 'processed') {
      await markBatchNeedsRecalc(tx, ctx, { batchId: target.batchId, employmentIds });
    }
    return { ids };
  });
}

/**
 * 2ef69d1e (Back Pay) — insert a set of one-off rows, each with its OWN employee and amount, inside the
 * CALLER'S transaction.
 *
 * ── WHY THIS EXISTS ALONGSIDE createIndividualTxnsBulk, WHICH IS NOT CHANGED ──────────────────────────
 * `createIndividualTxnsBulk` writes the SAME grid of rows to EVERY selected payee (a cartesian product),
 * which is exactly right for "pay twenty people the same allowance" and cannot express "pay each of
 * twenty-two people a different arrears figure". Looping it per employee would open N transactions with
 * no cross-employee rollback — for a money posting that is the difference between a run that pays
 * everybody and a run that pays the first nine people and then fails, leaving a `posted` back pay run
 * whose lines disagree with the ledger. So back pay does the whole posting in ONE transaction and this is
 * the seam it inserts through.
 *
 * It is ADDITIVE on purpose: `createIndividualTxnsBulk` above is untouched, so no existing payroll path
 * changes behaviour by a byte. The insert shape and the per-row `payroll.individual-txn.created` event
 * are identical to it, which is what keeps per-record History/replay and the substrate-coverage grep
 * working for these rows too.
 *
 * The caller owns the guards it needs. Back pay supplies them: the employments come from the run's own
 * lines (so they are company-matched by construction), the component ids are the ones it just seeded,
 * every amount is a positive magnitude with the sign carried by `kind`, and the target run is asserted
 * DRAFT before this is called. `assertDateInPeriod` is still enforced here — a date outside the pay month
 * is the one error no caller can be trusted to have ruled out.
 */
export async function insertIndividualTxnsTx(
  tx: Tx,
  ctx: SessionContext,
  p: {
    /** The target run, or null when no run exists for the month yet (the row is stamped on at generate). */
    batchId: string | null;
    companyId: string;
    payPeriod: string;
    rows: Array<{
      employmentId: string;
      kind: TxnKind;
      componentId: string | null;
      txnDate: string;
      amount: number;
      notes?: string | null;
    }>;
  },
): Promise<string[]> {
  if (!isPayPeriod(p.payPeriod)) throw new InvalidPayPeriodError(p.payPeriod);
  const ids: string[] = [];
  for (const r of p.rows) {
    if (!isTxnKind(r.kind)) throw new InvalidTxnKindError(r.kind);
    assertDateInPeriod(r.txnDate, p.payPeriod);
    // Magnitude semantics, the same contract every other write path enforces: the KIND carries the sign.
    if (!(r.amount > 0)) throw new AmountNotPositiveError(r.amount);
  }
  await assertTxnComponents(tx, p.rows, individualTxnPayEnabled(ctx));
  for (const r of p.rows) {
    const [row] = await tx
      .insert(payrollIndividualTxn)
      .values({
        tenantId: ctx.tenantId,
        batchId: p.batchId,
        companyId: p.companyId,
        payPeriod: p.payPeriod,
        employmentId: r.employmentId,
        kind: r.kind,
        componentId: r.componentId ?? null,
        txnDate: r.txnDate,
        amount: money(r.amount),
        notes: r.notes ?? null,
      })
      .returning({ id: payrollIndividualTxn.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-individual-txn',
      aggregateId: row.id,
      eventType: 'payroll.individual-txn.created',
      actor: actorOf(ctx),
      // ADR-0030 Layer 0: references + kind, no cleartext amount.
      payload: {
        batchId: p.batchId,
        companyId: p.companyId,
        payPeriod: p.payPeriod,
        employmentId: r.employmentId,
        kind: r.kind,
        componentId: r.componentId ?? null,
        txnDate: r.txnDate,
      },
    });
    ids.push(row.id);
  }
  return ids;
}

/**
 * Patch a dated one-off transaction. Editable while UNATTACHED (no run exists yet — f1564110 Phase 2) or
 * attached to a DRAFT batch; re-validates date-in-period against the row's (unchanged) pay month. A patch
 * may change any of kind / txnDate / amount / quantity / unit / notes.
 */
export function updateIndividualTxn(
  ctx: SessionContext,
  p: {
    id: string;
    kind?: string;
    txnDate?: string;
    amount?: number;
    quantity?: number | null;
    unit?: string | null;
    notes?: string | null;
    componentId?: string | null;
    /** c11e81aa — the configured Pay Cycle. OMITTED leaves the stored choice alone; null clears it (the
     *  row falls back to "the regular run may collect me"). On a row already attached to a run, the named
     *  cycle must agree with that run's type — see InvalidTxnCycleError('run_mismatch'). */
    intendedCycleId?: string | null;
  },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({
        batchId: payrollIndividualTxn.batchId,
        companyId: payrollIndividualTxn.companyId,
        payPeriod: payrollIndividualTxn.payPeriod,
        employmentId: payrollIndividualTxn.employmentId,
        kind: payrollIndividualTxn.kind,
        componentId: payrollIndividualTxn.componentId,
        txnDate: payrollIndividualTxn.txnDate,
        intendedCycleId: payrollIndividualTxn.intendedCycleId,
      })
      .from(payrollIndividualTxn)
      .where(eq(payrollIndividualTxn.id, p.id))
      .limit(1);
    if (!existing) throw new TxnNotFoundError(p.id); // distinct from BatchNotDraftError (real non-draft case)
    // Attached ⇒ the owning batch must still be writable — draft or processed, never closed (the batch's
    // payPeriod is authoritative). Unattached ⇒ no batch gate; the row's own stamped payPeriod (0175 CHECK
    // guarantees it) bounds the date.
    const batch = existing.batchId != null ? await loadWritableBatch(tx, existing.batchId) : null;
    const payPeriod = batch != null ? batch.payPeriod : existing.payPeriod!;
    const nextKind = p.kind ?? existing.kind;
    if (!isTxnKind(nextKind)) throw new InvalidTxnKindError(nextKind);
    if (p.unit != null && !isTxnUnit(p.unit)) throw new InvalidTxnUnitError(p.unit);
    const nextDate = p.txnDate ?? existing.txnDate;
    assertDateInPeriod(nextDate, payPeriod);
    // C6 — the retained edit path is the OTHER surviving write surface (the create-form path is removed).
    // Enforce the same amount>0 magnitude rule the bulk save enforces, so both write paths agree.
    if (p.amount !== undefined && !(p.amount > 0)) throw new AmountNotPositiveError(p.amount);
    // Phase 3 — the resulting (kind, component) pair must stay coherent. A kind change AWAY from
    // earning/deduction drops any stored component; an explicit componentId patch is validated. The
    // require-component rule is NOT applied here (an edit is not a NEW payable row — legacy componentless
    // rows stay editable and keep folding with the conservative defaults).
    const nextComponentId =
      p.componentId !== undefined
        ? p.componentId
        : PAYABLE_TXN_KINDS.includes(nextKind)
          ? existing.componentId
          : null;
    await assertTxnComponents(tx, [{ kind: nextKind, componentId: nextComponentId }], false);
    // c11e81aa — the company comes from the ROW (attached rows get it from their batch either way), so a
    // cycle from another company is refused here rather than stored and acted on at generate time.
    const nextIntendedCycleId = await resolveIntendedCycleId(tx, {
      intendedCycleId: p.intendedCycleId,
      companyId: batch != null ? batch.companyId : existing.companyId!,
      batchRunType: batch != null ? batch.runType : null,
      batchCycleId: batch != null ? batch.payrollCycleId : null,
    });

    const patch: Record<string, unknown> = {};
    if (p.kind !== undefined) patch.kind = p.kind;
    if (nextComponentId !== existing.componentId) patch.componentId = nextComponentId;
    if (p.txnDate !== undefined) patch.txnDate = p.txnDate;
    if (p.amount !== undefined) patch.amount = money(p.amount);
    if (p.quantity !== undefined) patch.quantity = p.quantity != null ? money(p.quantity) : null;
    if (p.unit !== undefined) patch.unit = p.unit ?? null;
    if (p.notes !== undefined) patch.notes = p.notes ?? null;
    // Written only when it actually MOVES — an edit that leaves the cycle alone must not stamp
    // `updated_at` (see the note below on why that timestamp has to stay meaningful).
    if (nextIntendedCycleId !== undefined && nextIntendedCycleId !== existing.intendedCycleId) {
      patch.intendedCycleId = nextIntendedCycleId;
    }
    if (Object.keys(patch).length > 0) {
      // 49e7e0a2 — stamp WHEN this row changed. Written only alongside a real field change, so a no-op
      // patch stays a no-op and an untouched row keeps a NULL updated_at, which is what makes
      // "created before processing but edited after it" answerable at all.
      patch.updatedAt = new Date();
      await tx.update(payrollIndividualTxn).set(patch).where(eq(payrollIndividualTxn.id, p.id));
      // The figures on a processed run were computed from the value that just changed.
      if (batch?.status === 'processed' && existing.batchId != null) {
        await markBatchNeedsRecalc(tx, ctx, { batchId: existing.batchId, employmentIds: [existing.employmentId] });
      }
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-individual-txn',
      aggregateId: p.id,
      eventType: 'payroll.individual-txn.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: existing.employmentId,
      // References only (no cleartext amount) — ADR-0030 Layer 0.
      payload: {
        before: {
          kind: existing.kind,
          txnDate: existing.txnDate,
          componentId: existing.componentId,
          intendedCycleId: existing.intendedCycleId,
        },
        after: {
          kind: nextKind,
          txnDate: nextDate,
          componentId: nextComponentId,
          // `undefined` means the caller said nothing about the cycle, so the stored one stands.
          intendedCycleId: nextIntendedCycleId === undefined ? existing.intendedCycleId : nextIntendedCycleId,
        },
      },
    });
    return { id: p.id };
  });
}

/** Delete a dated one-off transaction. Allowed while unattached or attached to a DRAFT batch. */
export function deleteIndividualTxn(ctx: SessionContext, p: { id: string }): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({
        batchId: payrollIndividualTxn.batchId,
        payPeriod: payrollIndividualTxn.payPeriod,
        employmentId: payrollIndividualTxn.employmentId,
        kind: payrollIndividualTxn.kind,
      })
      .from(payrollIndividualTxn)
      .where(eq(payrollIndividualTxn.id, p.id))
      .limit(1);
    if (!existing) throw new TxnNotFoundError(p.id); // distinct from BatchNotDraftError (real non-draft case)
    // Unattached ⇒ no batch gate. Attached ⇒ draft or processed; a CLOSED run still refuses.
    const batch = existing.batchId != null ? await loadWritableBatch(tx, existing.batchId) : null;
    await tx.delete(payrollIndividualTxn).where(eq(payrollIndividualTxn.id, p.id));
    // 49e7e0a2 — removing a row from a processed run takes money OFF a payslip that has already been paid
    // and filed. The row is gone (the deleted event is the record of it), so the mark is the only thing
    // left saying the run's figures no longer match; it is written in the same transaction as the delete.
    if (batch?.status === 'processed' && existing.batchId != null) {
      await markBatchNeedsRecalc(tx, ctx, { batchId: existing.batchId, employmentIds: [existing.employmentId] });
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-individual-txn',
      aggregateId: p.id,
      eventType: 'payroll.individual-txn.deleted',
      actor: actorOf(ctx),
      subjectEmploymentId: existing.employmentId,
      payload: {
        batchId: existing.batchId,
        payPeriod: existing.payPeriod,
        employmentId: existing.employmentId,
        kind: existing.kind,
      },
    });
    return { id: p.id };
  });
}

/** One unattached (period-keyed) ledger row for the "awaiting payroll run" view. */
export type UnattachedTxnRow = IndividualTxnRow & { payPeriod: string; companyId: string; companyName: string };

/**
 * List UNATTACHED one-off transactions (batch_id IS NULL) — keyed in before any payroll run existed for
 * their month. Optionally narrowed to one company and/or one 'YYYY-MM' month. Ordered newest month first,
 * then txn date. Read-only (RLS fences to payroll-admin companies via the row's own company_id).
 */
export function listUnattachedIndividualTxns(
  ctx: SessionContext,
  p: { companyId?: string; payPeriod?: string } = {},
): Promise<UnattachedTxnRow[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: payrollIndividualTxn.id,
        employmentId: payrollIndividualTxn.employmentId,
        name: person.fullName,
        employeeCode: employment.employeeCode,
        kind: payrollIndividualTxn.kind,
        txnDate: payrollIndividualTxn.txnDate,
        amount: payrollIndividualTxn.amount,
        quantity: payrollIndividualTxn.quantity,
        unit: payrollIndividualTxn.unit,
        notes: payrollIndividualTxn.notes,
        // Non-null on every unattached row (0175 CHECK); the cast keeps the row type honest for callers.
        payPeriod: payrollIndividualTxn.payPeriod,
        companyId: payrollIndividualTxn.companyId,
        companyName: company.legalName,
      })
      .from(payrollIndividualTxn)
      .innerJoin(employment, eq(employment.id, payrollIndividualTxn.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, payrollIndividualTxn.companyId))
      .where(
        and(
          isNull(payrollIndividualTxn.batchId),
          p.companyId ? eq(payrollIndividualTxn.companyId, p.companyId) : undefined,
          p.payPeriod ? eq(payrollIndividualTxn.payPeriod, p.payPeriod) : undefined,
        ),
      )
      .orderBy(desc(payrollIndividualTxn.payPeriod), asc(payrollIndividualTxn.txnDate), asc(payrollIndividualTxn.id))
      .then((rows) => rows as UnattachedTxnRow[]),
  );
}
