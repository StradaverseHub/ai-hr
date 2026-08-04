/**
 * Payroll Transaction View (feedback a4a05174) — the centralized, READ-ONLY transaction inquiry.
 *
 * Three cross-employee aggregation reads that back the /payroll/transaction-view screen
 * (relocated from /payroll/transactions/view to a top-level Payroll tab by feedback 59178702):
 *   • listFixedTransactionsAcross    — recurring fixed pay items across every scoped employee
 *     (generalises listEmploymentPayComponents, which is single-employment). Powers "view by
 *     employee" AND "view by pay item → all employees assigned" via the optional filters.
 *   • listIndividualTxnsAcross       — dated one-off transactions across ALL batches (any status,
 *     not just draft — the keying screen is structurally draft-only) by year/month/employee/company.
 *   • listProcessedPayslipsAcross    — processed payroll results (admin-scoped; myPayslips is
 *     self-scoped). A payslip row only exists AFTER generation, so draft batches are excluded by
 *     construction — no status predicate needed (same reasoning as core/read.ts taxRelief).
 *
 * SUBSTRATE NOTE (deliberate skip, WITH ONE CARVE-OUT): the three list* functions are pure SELECTs —
 * read-only, no domain event (CLAUDE.md substrate rule: events follow state-changing writes; there are
 * none there, and none should be added). The ONE exception is `exportIndividualTxnsCsv` below: an export
 * is an auditable data egress (mirroring core/payroll.ts paymentSummaryForBatch), so it DOES append a
 * `payroll.individual-txn.exported` DomainEvent recording who exported what filter set + row count.
 *
 * SCOPE FENCING: every function takes the caller's authorised `companyIds` (from scopedAdmin())
 * and applies `inArray(companyId, companyIds)` — the same application-level company fence
 * listEmployees uses. RLS isolates tenants only; company scope is an application concern, so an
 * EMPTY companyIds set fails CLOSED (returns no rows) rather than falling back to "all".
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNull, like, lt, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { toCsv } from '../lib/csv';
// 9cbf5e0d — one Employee Status engine, shared with Personnel and the dashboard.
import { employmentStatusSql } from './employment-status-sql';
// d0d2c9d1 — the scope resolver generatePayslips itself uses, so the "who will this run leave out?"
// warning and the attach guard can never disagree about what a departments-only scope means.
// (core/payroll is a pack boundary and core/payroll-view.ts is ALWAYS_ALLOWED — implementation files
// import each other freely under ADR-0080 D9. No cycle: core/payroll does not import this module.)
import { resolveBatchScopeFilter, type BatchScope } from './payroll';
// 97a9b0ab — the PURE re-run diff (no DB, no framework). Kept out of this file so the cause rules
// are unit-testable without a database, and so the honesty constraint on the ruleset-version cause
// lives beside the rules it constrains.
import { diffPayslipVersions, type PayslipSnapshot, type RecomputeDiff } from './payslip-recompute';
import { HR_LOCAL_TZ, todayInKualaLumpur } from '../lib/hr-date';
// a1d82340 step 5 — the pending-money view mirrors the kernel's own flag gates rather than reporting
// rows the run will not pay. See the flag note on pendingBatchMoney.
import { isModuleEnabled, settingEnabled } from './entitlements';
import {
  appUser,
  assignment,
  company,
  department,
  domainEvent,
  employeeStatutoryMy,
  employment,
  employmentPayComponent,
  jobGrade,
  payComponent,
  payrollBatch,
  payrollBatchComponent,
  payrollEmployeeResultHistory,
  payrollIndividualTxn,
  payrollInput,
  payrollRunTypeEnum,
  payrollTxnKindEnum,
  payslip,
  person,
  position,
  type PayrollTxnKind,
} from '../db/schema';

/** Second `person` alias — resolves the ACTING user's name for the "Created By" dimension (the txn's
 *  creator lives on the append-only event log, not on the ledger row — ADR-0056). */
const creatorPerson = alias(person, 'creator_person');

/** The event type appended by createIndividualTxn(sBulk) — the join key for "Created By"/"Created Date". */
const INDIVIDUAL_TXN_CREATED = 'payroll.individual-txn.created';
const INDIVIDUAL_TXN_AGGREGATE = 'payroll-individual-txn';

/** Coerce untrusted filter values to valid enum/whitelist members (a tampered value must not reach pg). */
const cleanTxnKind = (v: unknown): PayrollTxnKind | undefined =>
  payrollTxnKindEnum.enumValues.includes(v as PayrollTxnKind) ? (v as PayrollTxnKind) : undefined;
/** 'unattached' (f1564110 Phase 2) = rows with no batch yet (keyed in before the month's run exists). */
const cleanBatchStatus = (v: unknown): 'draft' | 'processed' | 'closed' | 'unattached' | undefined =>
  v === 'draft' || v === 'processed' || v === 'closed' || v === 'unattached' ? v : undefined;
/** A 'YYYY-MM-DD' calendar-date param or undefined (anything malformed is ignored, never cast). */
const cleanDate = (v: unknown): string | undefined =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;

/** 'YYYY-MM-DD' today — the same string axis validFrom/validTo live on. */
const todayIso = () => todayInKualaLumpur();

/** Money rounding, matching core/payroll.ts's own local definition (each module keeps its own — there is
 *  no shared export, and inventing one here would be a refactor riding on an unrelated change). */
const round2 = (n: number) => Math.round(n * 100) / 100;

type RunType = (typeof payrollRunTypeEnum.enumValues)[number];
/** Coerce an untrusted cycle filter to a valid enum value or undefined — an unknown value (URL
 *  tamper, stale form) must not reach Postgres, where an invalid enum cast throws. */
const cleanRunType = (v: unknown): RunType | undefined =>
  payrollRunTypeEnum.enumValues.includes(v as RunType) ? (v as RunType) : undefined;

/** Optional period narrowing on a 'YYYY-MM' pay-period column (default payroll_batch.pay_period; the
 *  Individual inquiry passes the txn row's own pay_period so unattached rows filter too): year+month →
 *  exact month; year only → that year; month only → that month across years. */
function periodFilter(year?: number, month?: number, col: typeof payrollBatch.payPeriod | typeof payrollIndividualTxn.payPeriod = payrollBatch.payPeriod) {
  const mm = month != null ? String(month).padStart(2, '0') : null;
  if (year != null && mm) return eq(col, `${year}-${mm}`);
  if (year != null) return like(col, `${year}-%`);
  if (mm) return like(col, `%-${mm}`);
  return undefined;
}

// ───────────────────── 1. Fixed Transaction View ─────────────────────

export type FixedTransactionViewRow = {
  id: string;
  employmentId: string;
  employeeName: string;
  employeeCode: string | null;
  companyId: string;
  company: string;
  componentId: string;
  code: string;
  name: string;
  kind: string;
  amount: string;
  validFrom: string;
  validTo: string | null;
  runType: RunType | null;
  remarks: string | null;
};

/**
 * Recurring fixed pay items across every employee in the scoped companies. Read-only, no domain
 * event (pure SELECT). Superseded rows are excluded (they were replaced by a newer value);
 * end-dated rows ARE returned so the inquiry can show them as "ended" — the same visibility rule
 * listEmploymentPayComponents applies, generalised across employments.
 *
 * Filters (all optional, AND-ed): `employmentId` (view by employee), `componentId` (view by pay
 * item → all employees assigned to it), `status` ('active' = validTo null or ≥ today; 'ended' =
 * validTo < today — the same rule the Fixed keying screen derives per-row).
 */
export function listFixedTransactionsAcross(
  ctx: SessionContext,
  p: { companyIds: string[]; employmentId?: string; componentId?: string; status?: 'active' | 'ended' },
): Promise<FixedTransactionViewRow[]> {
  if (p.companyIds.length === 0) return Promise.resolve([]); // fail closed — no scope, no rows
  const today = todayIso();
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: employmentPayComponent.id,
        employmentId: employmentPayComponent.employmentId,
        employeeName: person.fullName,
        employeeCode: employment.employeeCode,
        companyId: employment.companyId,
        company: company.legalName,
        componentId: payComponent.id,
        code: payComponent.code,
        name: payComponent.name,
        kind: payComponent.kind,
        amount: employmentPayComponent.amount,
        validFrom: employmentPayComponent.validFrom,
        validTo: employmentPayComponent.validTo,
        runType: employmentPayComponent.runType,
        remarks: employmentPayComponent.remarks,
      })
      .from(employmentPayComponent)
      .innerJoin(payComponent, eq(payComponent.id, employmentPayComponent.componentId))
      .innerJoin(employment, eq(employment.id, employmentPayComponent.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(
        and(
          inArray(employment.companyId, p.companyIds),
          isNull(employmentPayComponent.supersededAt),
          p.employmentId ? eq(employmentPayComponent.employmentId, p.employmentId) : undefined,
          p.componentId ? eq(employmentPayComponent.componentId, p.componentId) : undefined,
          p.status === 'active'
            ? or(isNull(employmentPayComponent.validTo), gte(employmentPayComponent.validTo, today))
            : undefined,
          p.status === 'ended' ? lt(employmentPayComponent.validTo, today) : undefined,
        ),
      )
      .orderBy(asc(person.fullName), asc(payComponent.code), asc(employmentPayComponent.validFrom)),
  );
}

// ───────────────────── 2. Individual Transaction View ─────────────────────

export type IndividualTxnViewRow = {
  id: string;
  employmentId: string;
  employeeName: string;
  employeeCode: string | null;
  companyId: string;
  company: string;
  payPeriod: string;
  // Null on UNATTACHED rows (f1564110 Phase 2): keyed in period-first, no batch stamped yet.
  runType: RunType | null;
  runSeq: number | null;
  batchStatus: string | null;
  kind: PayrollTxnKind;
  txnDate: string;
  amount: string;
  quantity: string | null;
  unit: string | null;
  notes: string | null;
  // "Created By" / "Created Date" audit dimensions (ADR-0056: no created_by column on the ledger row, so the
  // creator is resolved from the row's append-only 'created' DomainEvent → the acting app_user's person name).
  createdOn: string; // 'YYYY-MM-DD' — payroll_individual_txn.created_at cast to a date
  createdById: string | null; // app_user id of the creator (null for SYSTEM / pre-substrate rows)
  createdBy: string | null; // that user's person full name (null when unresolved)
};

/** The full filter set the Individual Transaction History screen (and its CSV export) applies. All optional
 *  and AND-ed; every one is scope-guarded / enum-coerced by the caller before it reaches Postgres. */
export type IndividualTxnFilter = {
  companyIds: string[];
  year?: number;
  month?: number;
  employmentId?: string;
  kind?: string; // payroll item classification (earning/deduction/overtime/unpaid/leave)
  departmentId?: string; // current-assignment department
  batchStatus?: string; // transaction status = the owning batch's status (draft/processed/closed)
  createdBy?: string; // app_user id (matched against the 'created' event actor)
  createdFrom?: string; // 'YYYY-MM-DD' inclusive lower bound on created_at
  createdTo?: string; // 'YYYY-MM-DD' inclusive upper bound on created_at
};

/**
 * Shared query for the Individual Transaction History screen AND its CSV export (one source of truth for the
 * filter semantics + created-by resolution). Dated one-off transactions across ALL batches (any status —
 * draft AND processed/closed) in the scoped companies, joined through payroll_batch for period/company/status
 * and LEFT-joined to the row's 'created' DomainEvent → app_user → person for the Created By / Created Date
 * dimensions. Read-only (pure SELECT — no event appended here).
 */
async function queryIndividualTxns(tx: Tx, p: IndividualTxnFilter): Promise<IndividualTxnViewRow[]> {
  if (p.companyIds.length === 0) return []; // fail closed — no scope, no rows
  const kind = cleanTxnKind(p.kind);
  const batchStatus = cleanBatchStatus(p.batchStatus);
  const createdFrom = cleanDate(p.createdFrom);
  const createdTo = cleanDate(p.createdTo);

  // Department filter: resolve the department's current-assignment employments ONCE (fail-closed on an empty
  // department), then narrow by the id set. A dedicated pre-query avoids a row-multiplying assignment join.
  let deptEmploymentIds: string[] | undefined;
  if (p.departmentId) {
    const deptRows = await tx
      .select({ id: employment.id })
      .from(employment)
      .innerJoin(
        assignment,
        and(
          eq(assignment.employmentId, employment.id),
          isNull(assignment.validTo),
          isNull(assignment.supersededAt),
          eq(assignment.departmentId, p.departmentId),
        ),
      );
    deptEmploymentIds = deptRows.map((r) => r.id);
    if (deptEmploymentIds.length === 0) return [];
  }

  // f1564110 Phase 2: the row's OWN (company_id, pay_period) columns are authoritative (stamped on every
  // write, backfilled by 0175), so the batch join becomes a LEFT join purely for run/status metadata and
  // UNATTACHED rows (batch_id NULL — keyed in before the month's run exists) stay visible in the inquiry.
  const rows = await tx
    .select({
      id: payrollIndividualTxn.id,
      employmentId: payrollIndividualTxn.employmentId,
      employeeName: person.fullName,
      employeeCode: employment.employeeCode,
      companyId: sql<string>`${payrollIndividualTxn.companyId}`,
      company: company.legalName,
      payPeriod: sql<string>`${payrollIndividualTxn.payPeriod}`,
      runType: payrollBatch.runType,
      runSeq: payrollBatch.runSeq,
      batchStatus: payrollBatch.status,
      kind: payrollIndividualTxn.kind,
      txnDate: payrollIndividualTxn.txnDate,
      amount: payrollIndividualTxn.amount,
      quantity: payrollIndividualTxn.quantity,
      unit: payrollIndividualTxn.unit,
      notes: payrollIndividualTxn.notes,
      createdOn: sql<string>`to_char(${payrollIndividualTxn.createdAt}, 'YYYY-MM-DD')`,
      createdById: appUser.id,
      createdBy: creatorPerson.fullName,
    })
    .from(payrollIndividualTxn)
    .leftJoin(payrollBatch, eq(payrollBatch.id, payrollIndividualTxn.batchId))
    .innerJoin(company, eq(company.id, payrollIndividualTxn.companyId))
    .innerJoin(employment, eq(employment.id, payrollIndividualTxn.employmentId))
    .innerJoin(person, eq(person.id, employment.personId))
    // Created-by provenance: the row's 'created' event → the acting app_user → that user's person name.
    .leftJoin(
      domainEvent,
      and(
        eq(domainEvent.aggregateId, payrollIndividualTxn.id),
        eq(domainEvent.aggregateType, INDIVIDUAL_TXN_AGGREGATE),
        eq(domainEvent.eventType, INDIVIDUAL_TXN_CREATED),
      ),
    )
    .leftJoin(appUser, eq(appUser.id, domainEvent.actorId))
    .leftJoin(creatorPerson, eq(creatorPerson.id, appUser.personId))
    .where(
      and(
        inArray(payrollIndividualTxn.companyId, p.companyIds),
        periodFilter(p.year, p.month, payrollIndividualTxn.payPeriod),
        p.employmentId ? eq(payrollIndividualTxn.employmentId, p.employmentId) : undefined,
        kind ? eq(payrollIndividualTxn.kind, kind) : undefined,
        deptEmploymentIds ? inArray(payrollIndividualTxn.employmentId, deptEmploymentIds) : undefined,
        batchStatus === 'unattached'
          ? isNull(payrollIndividualTxn.batchId)
          : batchStatus
            ? eq(payrollBatch.status, batchStatus)
            : undefined,
        p.createdBy ? eq(domainEvent.actorId, p.createdBy) : undefined,
        createdFrom ? gte(sql`${payrollIndividualTxn.createdAt}::date`, createdFrom) : undefined,
        createdTo ? lte(sql`${payrollIndividualTxn.createdAt}::date`, createdTo) : undefined,
      ),
    )
    .orderBy(desc(payrollIndividualTxn.payPeriod), asc(payrollIndividualTxn.txnDate), asc(payrollIndividualTxn.id));
  return rows as IndividualTxnViewRow[];
}

/**
 * Dated one-off transactions across ALL batches (any status — draft AND processed/closed, so the inquiry
 * composes with batch-lifecycle changes) in the scoped companies, filtered by the full History filter set
 * (year/month/employee/company/payroll-item/department/transaction-status/created-by/created-date).
 * Read-only, no domain event (pure SELECT). Generalises listIndividualTxns, which is single-(draft)-batch.
 */
export function listIndividualTxnsAcross(ctx: SessionContext, p: IndividualTxnFilter): Promise<IndividualTxnViewRow[]> {
  if (p.companyIds.length === 0) return Promise.resolve([]); // fail closed — no scope, no rows
  return withTenant(ctx, (tx) => queryIndividualTxns(tx, p));
}

/**
 * Distinct users who have CREATED an individual one-off transaction in the scoped companies — the option set
 * for the History screen's "Created By" filter. Resolved from the append-only event log (the actor of each
 * 'created' event) joined to the acting app_user's person name. Read-only (pure SELECT).
 */
export function listIndividualTxnCreators(
  ctx: SessionContext,
  p: { companyIds: string[] },
): Promise<{ id: string; name: string }[]> {
  if (p.companyIds.length === 0) return Promise.resolve([]);
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .selectDistinct({ id: appUser.id, name: creatorPerson.fullName })
      .from(domainEvent)
      .innerJoin(payrollIndividualTxn, eq(payrollIndividualTxn.id, domainEvent.aggregateId))
      .innerJoin(payrollBatch, eq(payrollBatch.id, payrollIndividualTxn.batchId))
      .innerJoin(appUser, eq(appUser.id, domainEvent.actorId))
      .innerJoin(creatorPerson, eq(creatorPerson.id, appUser.personId))
      .where(
        and(
          eq(domainEvent.aggregateType, INDIVIDUAL_TXN_AGGREGATE),
          eq(domainEvent.eventType, INDIVIDUAL_TXN_CREATED),
          inArray(payrollBatch.companyId, p.companyIds),
        ),
      )
      .orderBy(asc(creatorPerson.fullName));
    return rows.filter((r): r is { id: string; name: string } => r.id != null && r.name != null);
  });
}

// ───────────────────── 2b. Outstanding (unattached) transaction summary ─────────────────────

/** One (employee, month) group of transactions that were entered but have never reached a payslip. */
export type UnattachedGroupRow = {
  employmentId: string;
  employeeName: string;
  employeeCode: string | null;
  companyId: string;
  company: string;
  /** ADR-0080 slice 6 (D-9): the COMPANY's currency, so a cross-company table cannot be totalled blind.
   *  This view spans every company in scope, which is exactly where a single grand total goes wrong. */
  currency: string | null;
  payPeriod: string;
  count: number;
  totalAmount: string;
  oldestTxnDate: string;
  /** The month's REGULAR run, which is the only run that ever collects transactions. */
  runState: 'none' | 'draft' | 'processed' | 'closed';
  /** The row was keyed in AFTER that run was processed — one of the two ways money strands. */
  arrivedAfterProcessing: boolean;
};

/**
 * Money that was entered against an employee and a month and has never appeared on a payslip
 * (feedback d0d2c9d1) — grouped, totalled, and labelled with the state of the month's regular run.
 *
 * WHY THIS EXISTS WHEN THE ROWS WERE ALREADY LISTABLE. /payroll/transaction-view?tab=individual
 * &txnStatus=unattached has listed every `batch_id IS NULL` row since f1564110 Phase 2, RBAC- and
 * RLS-fenced. Eleven rows totalling RM23,170 still accumulated unnoticed across several months,
 * because a flat list of individual rows answers "show me the transactions" and nobody was asking
 * that question. What was missing is the aggregate: a per-employee, per-month total, a grand total,
 * and — critically — whether the month's run has already gone past these rows.
 *
 * THE RUN-STATE COLUMN IS THE POINT, NOT DECORATION. An unattached row in a month with no run yet is
 * the DESIGNED pre-run entry flow (f1564110 Phase 2) and is not stranded at all. An unattached row in
 * a month whose regular run is already processed or closed IS the fault. Showing only the fault class
 * would hide the pipeline; showing both undifferentiated is what let RM23,170 go invisible. So the
 * distinction is a column, and there is deliberately NO default filter on it.
 *
 * THE JOIN PREDICATE IS THE INVARIANT. The batch LEFT JOIN is keyed on run_type = 'regular' because
 * `generatePayslips` only ever attaches on `!subset && batch.runType === 'regular'` (core/payroll.ts).
 * An off_cycle / bonus / adjustment run for the same month never collects, so joining without that
 * predicate would report a month as "processed" on the strength of a sibling run that was never
 * going to attach anything.
 *
 * `arrivedAfterProcessing` derives from the payroll-batch.processed DOMAIN EVENT, not from a column:
 * there is no payroll_batch.processed_at, and payroll_batch.created_at is the wrong instant (the
 * batch row exists from the moment the draft is created, long before it is processed). It is a
 * correlated scalar subquery rather than a join so it cannot multiply the grouped counts.
 *
 * DEGRADES, NEVER FLIPS. domain_event rows with a NULL subject_employment_id are admin-only under
 * ADR-0015 and 'payroll-batch.processed' carries no subject, so a payroll_partner reads NULL here and
 * every group comes back `arrivedAfterProcessing: false` — "outstanding, cause unknown". That loses a
 * qualifier; it never reports an outstanding group as not outstanding.
 *
 * Read-only, no domain event (pure SELECT). Fails CLOSED on an empty scope, like every read here.
 */
export function listUnattachedTxnSummary(
  ctx: SessionContext,
  p: { companyIds: string[]; year?: number; month?: number; employmentId?: string },
): Promise<UnattachedGroupRow[]> {
  if (p.companyIds.length === 0) return Promise.resolve([]); // fail closed — no scope, no rows
  return withTenant(ctx, async (tx) => {
    // The instant the month's regular run was processed. Correlated on the grouped batch id, so it is
    // a per-group constant — which is what lets the bool below be a plain max() comparison.
    const processedAt = sql<Date | null>`(
      select max(de.occurred_at) from domain_event de
      where de.aggregate_type = 'payroll-batch'
        and de.aggregate_id = ${payrollBatch.id}
        and de.event_type = 'payroll-batch.processed'
    )`;

    const rows = await tx
      .select({
        employmentId: payrollIndividualTxn.employmentId,
        employeeName: person.fullName,
        employeeCode: employment.employeeCode,
        companyId: sql<string>`${payrollIndividualTxn.companyId}`,
        company: company.legalName,
        currency: company.currency,
        payPeriod: sql<string>`${payrollIndividualTxn.payPeriod}`,
        count: sql<number>`count(*)::int`,
        totalAmount: sql<string>`sum(${payrollIndividualTxn.amount})::numeric(12,2)`,
        oldestTxnDate: sql<string>`to_char(min(${payrollIndividualTxn.txnDate}), 'YYYY-MM-DD')`,
        runState: sql<'none' | 'draft' | 'processed' | 'closed'>`coalesce(${payrollBatch.status}::text, 'none')`,
        // bool_or(created_at > processedAt) collapses to max(created_at) > processedAt because
        // processedAt is constant within the group. NULL (no processed event, or an event this role
        // cannot read) coalesces to false — "cause unknown", never "not outstanding".
        arrivedAfterProcessing: sql<boolean>`coalesce(max(${payrollIndividualTxn.createdAt}) > ${processedAt}, false)`,
      })
      .from(payrollIndividualTxn)
      // Only the month's REGULAR run ever attaches — see the doc comment. Joined on the row's own
      // (company, period) columns, which are authoritative since 0175.
      .leftJoin(
        payrollBatch,
        and(
          eq(payrollBatch.companyId, payrollIndividualTxn.companyId),
          eq(payrollBatch.payPeriod, payrollIndividualTxn.payPeriod),
          eq(payrollBatch.runType, 'regular'),
        ),
      )
      .innerJoin(company, eq(company.id, payrollIndividualTxn.companyId))
      .innerJoin(employment, eq(employment.id, payrollIndividualTxn.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          isNull(payrollIndividualTxn.batchId), // "entered but never paid" — the whole population
          inArray(payrollIndividualTxn.companyId, p.companyIds),
          periodFilter(p.year, p.month, payrollIndividualTxn.payPeriod),
          p.employmentId ? eq(payrollIndividualTxn.employmentId, p.employmentId) : undefined,
        ),
      )
      .groupBy(
        payrollIndividualTxn.employmentId,
        payrollIndividualTxn.payPeriod,
        payrollIndividualTxn.companyId,
        person.fullName,
        employment.employeeCode,
        company.legalName,
        company.currency,
        payrollBatch.id,
        payrollBatch.status,
      )
      .orderBy(desc(sql`${payrollIndividualTxn.payPeriod}`), asc(person.fullName));
    return rows as UnattachedGroupRow[];
  });
}

/** One employee a narrowed run is about to leave out, with what they are holding for that month. */
export type UnattachedHolderRow = { employmentId: string; name: string; count: number; amount: string };

/**
 * The employees a NARROWED run will leave out who are holding transactions for that month
 * (feedback d0d2c9d1). Backs the Payroll Process wizard's Validation-step pre-flight and the same
 * warning on a scoped draft's own page.
 *
 * Returns [] for an UNSCOPED run: a full regular run collects every outstanding row for the month, so
 * there is nothing to warn about. Lives here rather than in the server action so it is reachable by a
 * test without a session — the action is a thin `getSession()` wrapper over it.
 *
 * Read-only, no domain event (pure SELECT via listUnattachedTxnSummary).
 */
export async function unattachedHoldersOutsideSelection(
  ctx: SessionContext,
  p: { companyIds: string[]; payPeriod: string; employmentIds?: string[] },
): Promise<UnattachedHolderRow[]> {
  const companyIds = (p.companyIds ?? []).filter(Boolean);
  if (companyIds.length === 0 || !/^\d{4}-\d{2}$/.test(p.payPeriod)) return [];
  const selected = (p.employmentIds ?? []).filter(Boolean);
  if (selected.length === 0) return []; // unscoped run — it collects everything
  const [year, month] = p.payPeriod.split('-').map(Number);

  const groups = await listUnattachedTxnSummary(ctx, { companyIds, year, month });
  const inScope = new Set(selected);
  // Money is summed in CENTS. Adding the decimal strings as floats would drift on exactly the
  // four-figure bonuses this feature exists to surface.
  const byEmployment = new Map<string, { employmentId: string; name: string; count: number; cents: number }>();
  for (const g of groups) {
    if (inScope.has(g.employmentId)) continue;
    const acc = byEmployment.get(g.employmentId) ?? { employmentId: g.employmentId, name: g.employeeName, count: 0, cents: 0 };
    acc.count += g.count;
    acc.cents += Math.round(Number(g.totalAmount) * 100);
    byEmployment.set(g.employmentId, acc);
  }
  return [...byEmployment.values()]
    .sort((a, b) => b.cents - a.cents)
    .map(({ employmentId, name, count, cents }) => ({ employmentId, name, count, amount: (cents / 100).toFixed(2) }));
}

/**
 * The same warning as above, for a SCOPED DRAFT that already exists (feedback d0d2c9d1).
 *
 * The wizard is not the only way a run gets narrowed: `updateBatchScope` (core/payroll.ts) re-narrows an
 * existing draft on resume, and on the single-company path `createBatch` and `generatePayslips` are two
 * separate operator steps, so there is a second moment where the warning has somewhere to land.
 *
 * Scope resolution goes through `resolveBatchScopeFilter` — the SAME helper generatePayslips itself uses
 * — rather than reading scope.employmentIds directly. A departments-only scope resolves to its current
 * assignees, and a second implementation of that rule here would drift from the attach guard and make
 * the warning lie in exactly the case it exists for.
 */
export async function unattachedHoldersOutsideBatchScope(
  ctx: SessionContext,
  p: { companyId: string; payPeriod: string; scope: BatchScope | null },
): Promise<UnattachedHolderRow[]> {
  const resolved = await withTenant(ctx, (tx) => resolveBatchScopeFilter(tx, p.scope));
  // `employmentIds: null` ⇒ no scope ⇒ whole company ⇒ the run collects everything: nothing to warn about.
  if (resolved.employmentIds == null || resolved.employmentIds.length === 0) return [];
  return unattachedHoldersOutsideSelection(ctx, {
    companyIds: [p.companyId],
    payPeriod: p.payPeriod,
    employmentIds: resolved.employmentIds,
  });
}

// ───────────────────── 3. Transaction History (processed results) ─────────────────────

export type ProcessedPayslipViewRow = {
  id: string;
  employmentId: string;
  employeeName: string;
  employeeCode: string | null;
  companyId: string;
  company: string;
  payPeriod: string;
  runType: RunType;
  runSeq: number;
  batchStatus: string;
  basic: string;
  allowance: string;
  overtime: string;
  bonus: string;
  gross: string;
  statutory: unknown; // { epfEmployee, socsoEmployee, eisEmployee, pcb, ... }
  totalDeductions: string;
  net: string;
};

/**
 * Historical payroll RESULTS after processing, across employees/companies/periods — the
 * admin-scoped counterpart of the self-service myPayslips. Read-only, no domain event (pure
 * SELECT). A payslip row only exists after generation, so draft batches are excluded by
 * construction (the ticket's "history after payroll has been processed") — do NOT "helpfully"
 * add a status predicate. Optional `cycle` = payroll run type (the Payroll-Cycle filter);
 * unknown values are ignored rather than cast to the pg enum (which would throw).
 */
export function listProcessedPayslipsAcross(
  ctx: SessionContext,
  p: {
    companyIds: string[];
    year?: number;
    month?: number;
    employmentId?: string;
    cycle?: string;
    /**
     * 862ed0ad — a hard row cap. This read was UNBOUNDED: no limit, no pagination, every payslip in
     * scope for all time, each carrying its whole `statutory` jsonb blob. That was survivable while
     * History was a tab you chose; it is not once History is the tab that OPENS, which is why the
     * approved plan made "confirm it is paginated or bounded" a precondition of that change rather
     * than an afterthought.
     *
     * A cap, not a page: the rows are already ordered newest-period-first, so the cap keeps exactly
     * what someone opening the screen came to check. The caller asks for one more row than it means
     * to show and says so on screen when the extra one comes back — a silent truncation would be
     * worse than the unbounded read it replaces.
     *
     * Absent ⇒ genuinely unbounded, so existing callers (and the CSV export, which must not be
     * clipped) are unchanged.
     */
    limit?: number;
  },
): Promise<ProcessedPayslipViewRow[]> {
  if (p.companyIds.length === 0) return Promise.resolve([]); // fail closed — no scope, no rows
  const cycle = cleanRunType(p.cycle);
  const limit = Number.isInteger(p.limit) && p.limit! > 0 ? p.limit! : undefined;
  return withTenant(ctx, (tx) => {
    const q = tx
      .select({
        id: payslip.id,
        employmentId: payslip.employmentId,
        employeeName: person.fullName,
        employeeCode: employment.employeeCode,
        companyId: payrollBatch.companyId,
        company: company.legalName,
        payPeriod: payrollBatch.payPeriod,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
        batchStatus: payrollBatch.status,
        basic: payslip.basicSalary,
        allowance: payslip.allowance,
        overtime: payslip.overtimePay,
        bonus: payslip.bonus,
        gross: payslip.grossPay,
        statutory: payslip.statutory,
        totalDeductions: payslip.totalDeductions,
        net: payslip.netPay,
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          inArray(payrollBatch.companyId, p.companyIds),
          periodFilter(p.year, p.month),
          p.employmentId ? eq(payslip.employmentId, p.employmentId) : undefined,
          cycle ? eq(payrollBatch.runType, cycle) : undefined,
        ),
      )
      .orderBy(desc(payrollBatch.payPeriod), asc(payrollBatch.runSeq), asc(person.fullName))
      .$dynamic();
    // An absent cap does not call .limit() at all, so every existing caller — including the CSV
    // export, which must never be clipped — issues exactly the query it issued before.
    return limit ? q.limit(limit) : q;
  });
}

// ───────────────────── 4. Payroll Register (feedback 622e12eb) ─────────────────────

export type PayrollRegisterRow = {
  employeeCode: string | null;
  employeeName: string;
  company: string;
  department: string | null;
  position: string | null;
  jobGrade: string | null;
  employmentStatus: string | null;
  employmentType: string | null;
  payPeriod: string;
  payrollCycle: RunType;
  runSeq: number;
  daysWorked: string | null;
  // Earnings
  basic: string;
  allowance: string;
  overtime: string;
  bonus: string;
  // Total earnings
  gross: string;
  // Deductions (employee share)
  epfEmployee: number;
  socsoEmployee: number;
  socsoSkbbk: number;
  eisEmployee: number;
  pcb: number;
  cp38: number;
  zakat: number;
  otherDeductions: string;
  // Total deductions & nett wage
  totalDeductions: string;
  net: string;
  // Employer contributions
  epfEmployer: number;
  socsoEmployer: number;
  eisEmployer: number;
  hrdf: number;
  employerCost: string;
};

/**
 * The Payroll Register (feedback 622e12eb) — one row per processed payslip with the earnings, employee
 * deductions and EMPLOYER contributions broken out, plus the employee/organisation columns the register
 * template groups by. Backs the `payroll_register` custom-report dataset; `listProcessedPayslipsAcross`
 * stays as it is (it powers the transaction-view screen and its CSV, whose column set must not drift).
 *
 * The statutory figures live in the payslip's immutable `statutory` jsonb snapshot rather than in columns,
 * so they are read out of the blob here — a closed payslip reports the contributions AS COMPUTED, which is
 * exactly what a register is for. Missing keys read as 0 (legacy/imported slips predating a key).
 *
 * Organisation columns resolve from the CURRENT assignment, matching masterDataExport — a register run for
 * an old period therefore shows today's department. Resolving the assignment as-of the pay period is a
 * deliberate follow-up, not an oversight: it needs the same dated-join machinery analytics uses for events.
 *
 * Read-only, no domain event (pure SELECT). Empty `companyIds` fails CLOSED, like every read in this file.
 */
export function listPayrollRegisterAcross(
  ctx: SessionContext,
  p: { companyIds: string[]; year?: number; month?: number; cycle?: string },
): Promise<PayrollRegisterRow[]> {
  if (p.companyIds.length === 0) return Promise.resolve([]);
  const cycle = cleanRunType(p.cycle);
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        employeeCode: employment.employeeCode,
        employeeName: person.fullName,
        company: company.legalName,
        department: department.name,
        position: position.title,
        jobGrade: jobGrade.name,
        // 9cbf5e0d — the DERIVED Employee Status, so the Payroll Register agrees with Personnel instead of
        // printing the retired stored enum (On Leave / Offboarding / Terminated).
        employmentStatus: employmentStatusSql(),
        employmentType: assignment.employmentType,
        payPeriod: payrollBatch.payPeriod,
        payrollCycle: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
        daysWorked: payslip.daysWorked,
        basic: payslip.basicSalary,
        allowance: payslip.allowance,
        overtime: payslip.overtimePay,
        bonus: payslip.bonus,
        gross: payslip.grossPay,
        statutory: payslip.statutory,
        otherDeductions: payslip.otherDeductions,
        totalDeductions: payslip.totalDeductions,
        net: payslip.netPay,
        employerCost: payslip.employerCost,
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(
        assignment,
        and(
          eq(assignment.employmentId, employment.id),
          isNull(assignment.validTo),
          isNull(assignment.supersededAt),
        ),
      )
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .leftJoin(position, eq(position.id, assignment.positionId))
      .leftJoin(jobGrade, eq(jobGrade.id, employment.gradeId))
      .where(
        and(
          inArray(payrollBatch.companyId, p.companyIds),
          periodFilter(p.year, p.month),
          cycle ? eq(payrollBatch.runType, cycle) : undefined,
        ),
      )
      .orderBy(desc(payrollBatch.payPeriod), asc(payrollBatch.runSeq), asc(person.fullName));

    return rows.map((r) => {
      const st = (r.statutory ?? {}) as Record<string, unknown>;
      const n = (k: string): number => {
        const v = Number(st[k] ?? 0);
        return Number.isFinite(v) ? v : 0;
      };
      const { statutory: _statutory, ...rest } = r;
      return {
        ...rest,
        epfEmployee: n('epfEmployee'),
        socsoEmployee: n('socsoEmployee'),
        socsoSkbbk: n('socsoSkbbk'),
        eisEmployee: n('eisEmployee'),
        pcb: n('pcb'),
        cp38: n('cp38'),
        zakat: n('zakat'),
        epfEmployer: n('epfEmployer'),
        socsoEmployer: n('socsoEmployer'),
        eisEmployer: n('eisEmployer'),
        hrdf: n('hrdf'),
      };
    });
  });
}

// ───────────────────── Individual Transaction History — CSV export ─────────────────────

/**
 * Export the Individual Transaction View (dated one-offs across all batches) as a CSV, honouring the same
 * scope-guarded filters the on-screen inquiry uses (`listIndividualTxnsAcross`). The file opens cleanly in
 * Excel. Admin/scope fencing is enforced by the route (scopedAdmin) + the fail-closed `companyIds` set here.
 *
 * SUBSTRATE: an export is auditable data egress, so this appends ONE `payroll.individual-txn.exported`
 * DomainEvent (mirroring core/payroll.ts paymentSummaryForBatch). The aggregate is VIRTUAL (there is no
 * report row), so `aggregateId` is a fresh UUID (domain_event.aggregate_id is UUID-typed) and the applied
 * filter set + row count live in the payload. ADR-0030 Layer 0: references + counts only, no cleartext
 * amounts in the event payload.
 */
export function exportIndividualTxnsCsv(
  ctx: SessionContext,
  p: IndividualTxnFilter,
): Promise<{ content: string; filename: string; rowCount: number }> {
  return withTenant(ctx, async (tx) => {
    // Same rows the on-screen History grid shows for this (scope-guarded) filter set — one source of truth.
    const rows = await queryIndividualTxns(tx, p);

    const header = [
      'Payroll Period',
      'Cycle',
      'Run',
      'Transaction Status',
      'Transaction Date',
      'Employee',
      'Employee Code',
      'Company',
      'Payroll Item',
      'Amount',
      'Quantity',
      'Unit',
      'Remarks',
      'Created By',
      'Created Date',
    ];
    const body = rows.map((r) => [
      r.payPeriod,
      // Unattached rows (f1564110 Phase 2) have no run yet — export a stable 'unattached' marker.
      r.runType ?? '',
      r.runSeq ?? '',
      r.batchStatus ?? 'unattached',
      r.txnDate,
      r.employeeName,
      r.employeeCode ?? '',
      r.company,
      r.kind,
      Number(r.amount).toFixed(2),
      r.quantity ?? '',
      r.unit ?? '',
      r.notes ?? '',
      r.createdBy ?? '',
      r.createdOn,
    ]);
    const content = toCsv([header, ...body]);
    const filename = `individual-transactions_${todayInKualaLumpur()}.csv`;

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-report',
      aggregateId: randomUUID(),
      eventType: 'payroll.individual-txn.exported',
      actor: actorOf(ctx),
      payload: {
        report: 'individual-transaction-history',
        rowCount: rows.length,
        filters: {
          companyIds: p.companyIds,
          year: p.year ?? null,
          month: p.month ?? null,
          employmentId: p.employmentId ?? null,
          kind: p.kind ?? null,
          departmentId: p.departmentId ?? null,
          batchStatus: p.batchStatus ?? null,
          createdBy: p.createdBy ?? null,
          createdFrom: p.createdFrom ?? null,
          createdTo: p.createdTo ?? null,
        },
      },
    });

    return { content, filename, rowCount: rows.length };
  });
}

// ───────────────────── Zakat Transaction History (feedback d435673e) ─────────────────────
//
// Two complementary read-only lists that back the Zakat screen's Transaction History block:
//   • listZakatElections   — what was KEYED on the Zakat screen: every employee with a saved zakat
//     election (state/method/rate/effective period + last-saved time). Answers "view all previously
//     saved Zakat transactions" even before any payroll run exists.
//   • listZakatTxnsAcross  — what was APPLIED in payroll: the zakat actually deducted in each PROCESSED
//     payroll run (from payslip.statutory->>'zakat' > 0), by year/month/employee/company/cycle/status.
// Both are pure SELECTs → no domain event (same read-only convention as the list* functions above). The
// ONE exception is `exportZakatTxnsCsv`, which appends a `zakat.history.exported` egress event (mirroring
// exportIndividualTxnsCsv / paymentSummaryForBatch).

export type ZakatElectionViewRow = {
  employmentId: string;
  employeeName: string;
  employeeCode: string | null;
  companyId: string;
  company: string;
  zakatActive: boolean;
  zakatMethod: string | null;
  zakatPercent: string | null;
  zakatFixed: string | null;
  zakatState: string | null;
  zakatEffectiveFrom: string | null;
  zakatEffectiveTo: string | null;
  updatedAt: string; // ISO timestamp of the last statutory-row save (the election's "last saved")
};

/**
 * Every ACTIVE employee (in the scoped companies) with a saved zakat election — the durable per-employee
 * setup keyed on the Zakat screen. Starts from `employment` and inner-joins the MY statutory row (mirroring
 * prefillFixedZakat's join at core/payroll.ts), so only employees who actually have an election appear, one
 * row per employment. NOTE: switching zakat OFF nulls every zakat field (resolveZakatElection's "no election
 * regardless of stray values" rule), so a switched-off setup drops out of this list — its save history lives
 * in the domain-event log and its past deductions in listZakatTxnsAcross. The `method IS NOT NULL OR active`
 * predicate is a safety net that keeps LEGACY inactive-with-method rows visible. Read-only, no domain event
 * (pure SELECT). Fails closed on an empty `companyIds` set (mirrors the list* functions above).
 */
export function listZakatElections(
  ctx: SessionContext,
  p: { companyIds: string[] },
): Promise<ZakatElectionViewRow[]> {
  if (p.companyIds.length === 0) return Promise.resolve([]); // fail closed — no scope, no rows
  return withTenant(ctx, (tx) =>
    tx
      .select({
        employmentId: employment.id,
        employeeName: person.fullName,
        employeeCode: employment.employeeCode,
        companyId: employment.companyId,
        company: company.legalName,
        zakatActive: employeeStatutoryMy.zakatActive,
        zakatMethod: employeeStatutoryMy.zakatMethod,
        zakatPercent: employeeStatutoryMy.zakatPercent,
        zakatFixed: employeeStatutoryMy.zakatFixed,
        zakatState: employeeStatutoryMy.zakatState,
        zakatEffectiveFrom: employeeStatutoryMy.zakatEffectiveFrom,
        zakatEffectiveTo: employeeStatutoryMy.zakatEffectiveTo,
        updatedAt: sql<string>`to_char(${employeeStatutoryMy.updatedAt}, 'YYYY-MM-DD"T"HH24:MI:SS')`,
      })
      .from(employment)
      .innerJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(
        and(
          inArray(employment.companyId, p.companyIds),
          isNull(employment.terminatedOn), // active employments (matches the election picker on the screen)
          // A "saved election" = a method was set OR the deduction is switched on. The kernel nulls the
          // method on switch-off, so the OR arm is a safety net for legacy inactive-with-method rows.
          or(sql`${employeeStatutoryMy.zakatMethod} IS NOT NULL`, eq(employeeStatutoryMy.zakatActive, true)),
        ),
      )
      .orderBy(asc(person.fullName)),
  );
}

export type ZakatTxnViewRow = {
  id: string;
  employmentId: string;
  employeeName: string;
  employeeCode: string | null;
  companyId: string;
  company: string;
  payPeriod: string; // = "effective payroll month"
  runType: RunType;
  runSeq: number;
  batchStatus: string; // processed/closed — payslips only exist post-generation
  zakat: string; // the RM zakat deducted, from payslip.statutory->>'zakat'
  createdOn: string; // 'YYYY-MM-DD HH:MM:SS' — payslip.created_at (= created date & time)
};

/** The filter set the Zakat "Applied in payroll" history + its CSV export share (all optional, AND-ed;
 *  every value is scope-guarded / enum-coerced by the caller before it reaches Postgres). */
export type ZakatTxnFilter = {
  companyIds: string[];
  year?: number;
  month?: number;
  employmentId?: string;
  cycle?: string; // payroll run type
  status?: string; // batch status — 'processed' | 'closed' (a payslip row never sits on a draft batch)
};

/** Coerce an untrusted status filter to the ONLY two statuses a payslip-backed history row can carry
 *  (a payslip exists post-generation, so 'draft' is impossible by construction). Anything else — URL
 *  tamper, stale form — is ignored, never cast (fail closed, mirroring cleanRunType above). */
const cleanZakatStatus = (v: unknown): 'processed' | 'closed' | undefined =>
  v === 'processed' || v === 'closed' ? v : undefined;

/** Shared query for the Zakat "Applied in payroll" history AND its CSV export (one source of truth). Zakat
 *  actually deducted (`payslip.statutory->>'zakat' > 0`) across processed runs in the scoped companies. */
function queryZakatTxns(tx: Tx, p: ZakatTxnFilter): Promise<ZakatTxnViewRow[]> {
  const cycle = cleanRunType(p.cycle);
  const status = cleanZakatStatus(p.status);
  return tx
    .select({
      id: payslip.id,
      employmentId: payslip.employmentId,
      employeeName: person.fullName,
      employeeCode: employment.employeeCode,
      companyId: payrollBatch.companyId,
      company: company.legalName,
      payPeriod: payrollBatch.payPeriod,
      runType: payrollBatch.runType,
      runSeq: payrollBatch.runSeq,
      batchStatus: payrollBatch.status,
      zakat: sql<string>`(${payslip.statutory}->>'zakat')`,
      createdOn: sql<string>`to_char(${payslip.createdAt}, 'YYYY-MM-DD HH24:MI:SS')`,
    })
    .from(payslip)
    .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
    .innerJoin(company, eq(company.id, payrollBatch.companyId))
    .innerJoin(employment, eq(employment.id, payslip.employmentId))
    .innerJoin(person, eq(person.id, employment.personId))
    .where(
      and(
        inArray(payrollBatch.companyId, p.companyIds),
        periodFilter(p.year, p.month),
        p.employmentId ? eq(payslip.employmentId, p.employmentId) : undefined,
        cycle ? eq(payrollBatch.runType, cycle) : undefined,
        status ? eq(payrollBatch.status, status) : undefined,
        // Only rows that actually carry a zakat deduction — a zero-zakat employee is excluded by construction.
        sql`(${payslip.statutory}->>'zakat')::numeric > 0`,
      ),
    )
    .orderBy(desc(payrollBatch.payPeriod), asc(payrollBatch.runSeq), asc(person.fullName));
}

/**
 * Zakat actually deducted in each PROCESSED payroll run, across employees/companies/periods — the
 * admin-scoped "Applied in payroll" history. A payslip row only exists after generation, so draft batches
 * are excluded by construction (no status predicate needed). Read-only, no domain event (pure SELECT).
 * Fails closed on an empty `companyIds` set.
 */
export function listZakatTxnsAcross(ctx: SessionContext, p: ZakatTxnFilter): Promise<ZakatTxnViewRow[]> {
  if (p.companyIds.length === 0) return Promise.resolve([]); // fail closed — no scope, no rows
  return withTenant(ctx, (tx) => queryZakatTxns(tx, p));
}

/**
 * Export the Zakat "Applied in payroll" history as a CSV, honouring the SAME scope-guarded filters the
 * on-screen inquiry uses (`listZakatTxnsAcross`). Opens cleanly in Excel. Admin/scope fencing is enforced by
 * the route (scopedAdmin) + the fail-closed `companyIds` set here.
 *
 * SUBSTRATE: an export is auditable data egress, so this appends ONE `zakat.history.exported` DomainEvent
 * (mirroring exportIndividualTxnsCsv). The aggregate is VIRTUAL (no report row), so `aggregateId` is a fresh
 * UUID (domain_event.aggregate_id is UUID-typed) and the applied filter set + row count live in the payload.
 * ADR-0030 Layer 0: references + counts only — no cleartext amounts in the event payload.
 */
export function exportZakatTxnsCsv(
  ctx: SessionContext,
  p: ZakatTxnFilter,
): Promise<{ content: string; filename: string; rowCount: number }> {
  if (p.companyIds.length === 0) {
    // Fail closed, but still record the (empty) egress attempt for the audit trail.
    return withTenant(ctx, async (tx) => {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'payroll-report',
        aggregateId: randomUUID(),
        eventType: 'zakat.history.exported',
        actor: actorOf(ctx),
        payload: { report: 'zakat-transaction-history', rowCount: 0, filters: zakatFilterPayload(p) },
      });
      return { content: toCsv([ZAKAT_CSV_HEADER]), filename: zakatCsvFilename(), rowCount: 0 };
    });
  }
  return withTenant(ctx, async (tx) => {
    const rows = await queryZakatTxns(tx, p);
    const body = rows.map((r) => [
      r.payPeriod,
      r.runType,
      r.runSeq,
      r.batchStatus,
      r.employeeName,
      r.employeeCode ?? '',
      r.company,
      Number(r.zakat).toFixed(2),
      r.createdOn,
    ]);
    const content = toCsv([ZAKAT_CSV_HEADER, ...body]);

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-report',
      aggregateId: randomUUID(),
      eventType: 'zakat.history.exported',
      actor: actorOf(ctx),
      payload: { report: 'zakat-transaction-history', rowCount: rows.length, filters: zakatFilterPayload(p) },
    });

    return { content, filename: zakatCsvFilename(), rowCount: rows.length };
  });
}

const ZAKAT_CSV_HEADER = [
  'Effective Payroll Month',
  'Cycle',
  'Run',
  'Status',
  'Employee',
  'Employee Code',
  'Company',
  'Zakat Amount',
  'Created Date & Time',
];
const zakatCsvFilename = () => `zakat-transaction-history_${todayInKualaLumpur()}.csv`;
const zakatFilterPayload = (p: ZakatTxnFilter) => ({
  companyIds: p.companyIds,
  year: p.year ?? null,
  month: p.month ?? null,
  employmentId: p.employmentId ?? null,
  cycle: p.cycle ?? null,
  status: p.status ?? null,
});

/* ─────────────────── Re-run disclosure (feedback 97a9b0ab) ─────────────────── */

/**
 * One recomputation of one payslip, diffed against the computation it replaced, with the cause(s)
 * named. READ-ONLY (no event — CLAUDE.md substrate rule).
 *
 * NO DDL. Everything here already existed and was simply never read back:
 *   • `payroll_employee_result_history` — core/payroll.ts writes the full before/after payslip
 *     (grossPay/netPay/totalDeductions/employerCost/statutory/version) on every selective reprocess,
 *     and nothing in the app read the table.
 *   • `payslip.statutory->>'version'` — the statutory ruleset version, stamped on every slip since
 *     2026.0 and never surfaced.
 *
 * CAUSE (b) DERIVATION. "An earlier month was revised after this slip was last computed" is decided
 * on TIME, not on version numbers: for each event we take the window (T_prev, T_now], where T_prev is
 * the previous recomputation of the SAME employee in this batch, or — for the first recomputation —
 * the instant this batch was processed. Any recomputation of an earlier-month batch for the same
 * employment and tax year landing in that window moved the cumulative accumulators this slip replays.
 */
export type RecomputeDisclosureRow = {
  id: string;
  employmentId: string;
  employeeName: string;
  employeeCode: string | null;
  action: string;
  reason: string | null;
  at: Date;
  diff: RecomputeDiff;
  /** Earlier-month pay periods recomputed inside this event's window (cause (b) evidence, deduped). */
  priorMonths: string[];
};

export function listRecomputeDisclosure(
  ctx: SessionContext,
  p: { batchId: string },
): Promise<RecomputeDisclosureRow[]> {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ id: payrollBatch.id, companyId: payrollBatch.companyId, payPeriod: payrollBatch.payPeriod })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) return [];

    const events = await tx
      .select({
        id: payrollEmployeeResultHistory.id,
        employmentId: payrollEmployeeResultHistory.employmentId,
        employeeName: person.fullName,
        employeeCode: employment.employeeCode,
        action: payrollEmployeeResultHistory.action,
        reason: payrollEmployeeResultHistory.reason,
        at: payrollEmployeeResultHistory.createdAt,
        before: payrollEmployeeResultHistory.before,
        after: payrollEmployeeResultHistory.after,
      })
      .from(payrollEmployeeResultHistory)
      .innerJoin(employment, eq(employment.id, payrollEmployeeResultHistory.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(payrollEmployeeResultHistory.batchId, p.batchId))
      .orderBy(asc(payrollEmployeeResultHistory.employmentId), asc(payrollEmployeeResultHistory.createdAt));
    if (events.length === 0) return [];

    // The instant this batch was processed — T_prev for an employee's FIRST recomputation. Same
    // derivation listUnattachedTxnSummary uses; NULL (no readable event) leaves the window open at the
    // bottom, which can only ADD prior-month evidence, never invent a cause where none was recorded.
    const [processed] = await tx
      .select({ at: sql<Date | null>`max(${domainEvent.occurredAt})` })
      .from(domainEvent)
      .where(
        and(
          eq(domainEvent.aggregateType, 'payroll-batch'),
          eq(domainEvent.aggregateId, p.batchId),
          eq(domainEvent.eventType, 'payroll-batch.processed'),
        ),
      );
    const processedAt = processed?.at ? new Date(processed.at) : null;

    // Earlier-month recomputations for these employees, same company, SAME TAX YEAR (the PCB
    // accumulators reset each year, so a December revision cannot move the following January).
    const employmentIds = [...new Set(events.map((e) => e.employmentId))];
    const priorBatch = alias(payrollBatch, 'prior_batch');
    const priorEvents = await tx
      .select({
        employmentId: payrollEmployeeResultHistory.employmentId,
        payPeriod: priorBatch.payPeriod,
        at: payrollEmployeeResultHistory.createdAt,
      })
      .from(payrollEmployeeResultHistory)
      .innerJoin(priorBatch, eq(priorBatch.id, payrollEmployeeResultHistory.batchId))
      .where(
        and(
          eq(priorBatch.companyId, batch.companyId),
          lt(priorBatch.payPeriod, batch.payPeriod),
          like(priorBatch.payPeriod, `${batch.payPeriod.slice(0, 4)}-%`),
          inArray(payrollEmployeeResultHistory.employmentId, employmentIds),
        ),
      );
    const priorByEmp = new Map<string, { payPeriod: string; at: Date }[]>();
    for (const r of priorEvents) {
      const list = priorByEmp.get(r.employmentId) ?? [];
      list.push({ payPeriod: r.payPeriod, at: r.at });
      priorByEmp.set(r.employmentId, list);
    }

    const lastSeenByEmp = new Map<string, Date>();
    return events.map((e) => {
      const tPrev = lastSeenByEmp.get(e.employmentId) ?? processedAt;
      lastSeenByEmp.set(e.employmentId, e.at);
      const priorMonths = [
        ...new Set(
          (priorByEmp.get(e.employmentId) ?? [])
            .filter((r) => r.at <= e.at && (tPrev == null || r.at > tPrev))
            .map((r) => r.payPeriod),
        ),
      ].sort();
      return {
        id: e.id,
        employmentId: e.employmentId,
        employeeName: e.employeeName,
        employeeCode: e.employeeCode,
        action: e.action,
        reason: e.reason,
        at: e.at,
        diff: diffPayslipVersions(
          e.before as PayslipSnapshot | null,
          e.after as PayslipSnapshot | null,
          { priorMonthsRecomputed: priorMonths.length > 0 },
        ),
        priorMonths,
      };
    });
  });
}

// ───────────────── a1d82340 STEP 5 — one consolidated view of the money on a draft run ─────────────────
//
// THE PROBLEM THIS SOLVES, MEASURED RATHER THAN ASSUMED. Money reaches a payslip through TWELVE
// independent doors writing FIVE different tables. Before this read model, the draft run screen showed
// only what `batchInputRows` reads — `payroll_input` — so four of the five tables were invisible until
// AFTER the payslip was generated:
//
//   payroll_input           7 overtime (grid + attendance prefill) · 8 bonus (grid) · 9 claim_allowance
//                           (claims prefill) · 10 loan_deduction (loans prefill) · 11 tp1_deduction (grid
//                           + TP1 prefill) · 12 zakat (grid + fixed-zakat prefill)     ← WAS VISIBLE
//   payroll_batch_component 4 component file import · 5 attendance-allowance transfer ·
//                           6 shift-differential prefill                               ← WAS INVISIBLE
//   payroll_individual_txn  3 Individual Transactions, attached OR still period-keyed   ← WAS INVISIBLE
//   employment_pay_component 2 Fixed Transactions (period-active window)                ← WAS INVISIBLE
//   compensation            1 basic + monthly allowance                                 ← shown per-employee
//
// The approved plan's step 5 says "consolidate the eight places money can be added". The count was taken
// from an earlier map and is stale — it is twelve. The enumeration above is the first time it has been
// written down; treat it as the register, and add to it when a thirteenth door is opened.
//
// DELIBERATELY READ-ONLY, AND THAT IS THE WHOLE POINT. r91 established that three of the four screens an
// earlier revision proposed retiring were SOLE WRITERS — "never used" and "no writer reachable" look
// identical in a row count, and closing a door is not reversible through configuration. So consolidation
// here means ONE PLACE TO SEE ALL TWELVE, not eleven deletions. Nothing about what reaches a payslip
// changes: this function computes no money, it reports money other code already committed.
//
// BASIC SALARY IS EXCLUDED ON PURPOSE. It is not "added" through a door — it is the compensation record
// the run is built from, and the draft screen already shows it per employee. Including it would bury the
// twelve doors under the one figure that is never in question.

/** Which door a pending money line came in through. Stable keys — the UI translates them. */
export type PendingMoneyDoor =
  | 'fixedComponent'
  | 'individualTxn'
  | 'batchComponent'
  | 'overtime'
  | 'bonus'
  | 'claims'
  | 'loan'
  | 'tp1'
  | 'zakat';

export type PendingMoneyLine = {
  employmentId: string;
  employeeName: string;
  employeeCode: string | null;
  door: PendingMoneyDoor;
  /** The pay item's own name where the door names one, else null (the door label stands in). */
  itemName: string | null;
  /** SIGNED: earnings positive, deductions negative — so the totals below are honest arithmetic. */
  amount: number;
  /** Extra provenance the door carries ('attendance'/'manual' for overtime, 'unattached' for a
   *  period-keyed individual txn that has not been stamped onto this run yet). Null where none. */
  note: string | null;
};

export type PendingMoneyDoorTotal = { door: PendingMoneyDoor; count: number; total: number };

export type PendingBatchMoney = {
  lines: PendingMoneyLine[];
  byDoor: PendingMoneyDoorTotal[];
  /** Distinct employees carrying at least one line. */
  employees: number;
  /** Sum of the positive lines and of the negative lines, reported separately (never netted away). */
  earnings: number;
  deductions: number;
  /**
   * Rows that EXIST but that a feature flag stops the kernel from paying — see the flag note on
   * `pendingBatchMoney`. Counted, never summed into the totals above: money a run will not pay must not
   * appear in the figure an operator reads as "what this run will pay". A non-zero count with an empty
   * `lines` list is the exact shape of "somebody keyed transactions that are going nowhere".
   */
  inertRows: number;
};

/** The nine doors that can carry a line, in the order the card renders them. */
const PENDING_MONEY_DOORS: readonly PendingMoneyDoor[] = [
  'fixedComponent',
  'individualTxn',
  'batchComponent',
  'overtime',
  'bonus',
  'claims',
  'loan',
  'tp1',
  'zakat',
] as const;

/**
 * Every money line queued against a draft run, whichever door it came through.
 *
 * PERIOD-KEYED INDIVIDUAL TRANSACTIONS ARE INCLUDED, and this is the subtle part. A row keyed before the
 * month's run existed carries `batch_id = NULL` + (company, pay_period); `generatePayslips` stamps it onto
 * the month's REGULAR run at generate time (attach-on-generate, 0175). So for a regular run those rows WILL
 * be paid by this run even though nothing links them to it yet — omitting them would under-report the very
 * figure the operator is checking. They are marked `note: 'unattached'` so the screen can say so. An
 * ADDITIONAL/off-cycle run does not attach them, so it does not count them.
 *
 * THE FLAGS ARE MIRRORED, NOT IGNORED — this is the difference between a useful card and a lying one.
 * Three doors only reach a payslip when a flag is on: the typed-component doors (fixed transactions and
 * every payroll_batch_component writer) ride TYPED_PAY_COMPONENTS_ENABLED, and the individual-transaction
 * fold rides INDIVIDUAL_TXN_PAY_ENABLED (which itself depends on the former — see generatePayslips). With
 * a flag off those rows exist and pay NOTHING. Counting them would tell the operator a run will pay money
 * it will not; hiding them would lose the fact that somebody keyed transactions into a dead end. So they
 * are counted separately as `inertRows` and kept out of every total.
 *
 * Read-only: no DomainEvent (CLAUDE.md substrate rule — events follow state-changing writes, and there
 * are none here).
 */
export function pendingBatchMoney(ctx: SessionContext, p: { batchId: string }): Promise<PendingBatchMoney> {
  const typedComponents = isModuleEnabled(ctx, 'typed_pay_components');
  // Matches generatePayslips' own dependency: the individual fold rides the per-component fold, so with
  // typed components off a payable one-off row has nothing to fold through and pays nothing either.
  const individualTxnPay = typedComponents && settingEnabled(ctx, 'payroll.individual_txn_pay_enabled');
  return withTenant(ctx, async (tx) => {
    let inertRows = 0;
    const empty: PendingBatchMoney = { lines: [], byDoor: [], employees: 0, earnings: 0, deductions: 0, inertRows: 0 };
    const [batch] = await tx
      .select({
        id: payrollBatch.id,
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        runType: payrollBatch.runType,
        scope: payrollBatch.scope,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) return empty;

    const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
    const periodStart = `${batch.payPeriod}-01`;
    // Last day of the pay month. new Date(y, m, 0) is the 0th day of the NEXT month = the last of this one.
    const periodEnd = `${batch.payPeriod}-${String(new Date(Date.UTC(pYear, pMonth, 0)).getUTCDate()).padStart(2, '0')}`;
    // The same scope resolver generatePayslips uses, so "what this run will pay" and "what this card
    // reports" can never disagree about what a departments-only scope means (d0d2c9d1's rule).
    const { filter: scopeFilter } = await resolveBatchScopeFilter(tx, batch.scope as BatchScope | null);

    const lines: PendingMoneyLine[] = [];
    const push = (
      r: { employmentId: string; employeeName: string; employeeCode: string | null },
      door: PendingMoneyDoor,
      amount: number,
      itemName: string | null = null,
      note: string | null = null,
    ) => {
      if (!(Math.abs(amount) > 0)) return; // a zero line is not a pending transaction
      lines.push({ ...r, door, itemName, amount, note });
    };

    // ── payroll_input: six doors on one row (7-12). Deductions are pushed NEGATIVE. ──
    const inputs = await tx
      .select({
        employmentId: payrollInput.employmentId,
        employeeName: person.fullName,
        employeeCode: employment.employeeCode,
        overtime: payrollInput.overtimeAmount,
        bonus: payrollInput.bonusAmount,
        claim: payrollInput.claimAllowance,
        loan: payrollInput.loanDeduction,
        tp1: payrollInput.tp1Deduction,
        zakat: payrollInput.zakat,
        otSource: payrollInput.otSource,
      })
      .from(payrollInput)
      .innerJoin(employment, eq(employment.id, payrollInput.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(payrollInput.batchId, p.batchId));
    for (const r of inputs) {
      const who = { employmentId: r.employmentId, employeeName: r.employeeName, employeeCode: r.employeeCode };
      push(who, 'overtime', Number(r.overtime), null, r.otSource);
      push(who, 'bonus', Number(r.bonus));
      push(who, 'claims', Number(r.claim));
      push(who, 'loan', -Number(r.loan));
      push(who, 'tp1', -Number(r.tp1));
      push(who, 'zakat', -Number(r.zakat));
    }

    // ── payroll_batch_component (doors 4-6): file import, attendance-allowance transfer, shift diff. ──
    // All three land in the same table with no column recording WHICH wrote the row, so they report as one
    // door named by the pay item. Naming the writer would need a provenance column and a migration; the
    // item name is what the operator recognises anyway ("Shift differential", "Attendance allowance").
    const batchComps = await tx
      .select({
        employmentId: payrollBatchComponent.employmentId,
        employeeName: person.fullName,
        employeeCode: employment.employeeCode,
        amount: payrollBatchComponent.amount,
        itemName: payComponent.name,
        kind: payComponent.kind,
      })
      .from(payrollBatchComponent)
      .innerJoin(payComponent, eq(payComponent.id, payrollBatchComponent.componentId))
      .innerJoin(employment, eq(employment.id, payrollBatchComponent.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(payrollBatchComponent.batchId, p.batchId));
    for (const r of batchComps) {
      if (!(Math.abs(Number(r.amount)) > 0)) continue;
      if (!typedComponents) {
        inertRows += 1;
        continue;
      }
      const signed = r.kind === 'deduction' ? -Number(r.amount) : Number(r.amount);
      push({ employmentId: r.employmentId, employeeName: r.employeeName, employeeCode: r.employeeCode }, 'batchComponent', signed, r.itemName);
    }

    // ── payroll_individual_txn (door 3): attached to this batch, plus — for a REGULAR run only — the
    // period-keyed rows attach-on-generate will stamp onto it. See the docstring. ──
    const attachesUnattached = batch.runType === 'regular';
    const txnRows = await tx
      .select({
        employmentId: payrollIndividualTxn.employmentId,
        employeeName: person.fullName,
        employeeCode: employment.employeeCode,
        amount: payrollIndividualTxn.amount,
        kind: payrollIndividualTxn.kind,
        itemName: payComponent.name,
        batchId: payrollIndividualTxn.batchId,
      })
      .from(payrollIndividualTxn)
      .innerJoin(employment, eq(employment.id, payrollIndividualTxn.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(payComponent, eq(payComponent.id, payrollIndividualTxn.componentId))
      .where(
        attachesUnattached
          ? or(
              eq(payrollIndividualTxn.batchId, p.batchId),
              and(
                isNull(payrollIndividualTxn.batchId),
                eq(payrollIndividualTxn.companyId, batch.companyId),
                eq(payrollIndividualTxn.payPeriod, batch.payPeriod),
              ),
            )
          : eq(payrollIndividualTxn.batchId, p.batchId),
      );
    for (const r of txnRows) {
      // 'leave' is RECORD-ONLY in v1 (the kernel does not fold it into pay — see generatePayslips), so it
      // is not pending MONEY and must not appear in a total the operator reads as "what this run will pay".
      if (r.kind === 'leave') continue;
      if (!(Math.abs(Number(r.amount)) > 0)) continue;
      // 'overtime' and 'unpaid' fold in the payslip loop regardless of the payable-fold flag; only
      // earning/deduction rows ride INDIVIDUAL_TXN_PAY_ENABLED. Mirrored exactly rather than approximated.
      if (!individualTxnPay && (r.kind === 'earning' || r.kind === 'deduction')) {
        inertRows += 1;
        continue;
      }
      const signed = r.kind === 'deduction' || r.kind === 'unpaid' ? -Number(r.amount) : Number(r.amount);
      push(
        { employmentId: r.employmentId, employeeName: r.employeeName, employeeCode: r.employeeCode },
        'individualTxn',
        signed,
        r.itemName,
        r.batchId == null ? 'unattached' : null,
      );
    }

    // ── employment_pay_component (door 2): the period-ACTIVE fixed items. The window is copied from
    // generatePayslips' own recurring query so the two agree exactly: started by period end, not ended
    // before period start, never superseded. ──
    const fixed = await tx
      .select({
        employmentId: employmentPayComponent.employmentId,
        employeeName: person.fullName,
        employeeCode: employment.employeeCode,
        amount: employmentPayComponent.amount,
        itemName: payComponent.name,
        kind: payComponent.kind,
      })
      .from(employmentPayComponent)
      .innerJoin(payComponent, eq(payComponent.id, employmentPayComponent.componentId))
      .innerJoin(employment, eq(employment.id, employmentPayComponent.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          eq(employment.companyId, batch.companyId),
          lte(employment.hiredOn, periodEnd),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart)),
          lte(employmentPayComponent.validFrom, periodEnd),
          or(isNull(employmentPayComponent.validTo), gte(employmentPayComponent.validTo, periodStart)),
          isNull(employmentPayComponent.supersededAt),
          // BASIC is the compensation record restated as a component, not an added transaction — it is
          // excluded for the same reason basic salary is (see the section docstring).
          sql`${payComponent.code} <> 'BASIC'`,
          scopeFilter,
        ),
      );
    for (const r of fixed) {
      if (!(Math.abs(Number(r.amount)) > 0)) continue;
      if (!typedComponents) {
        inertRows += 1;
        continue;
      }
      const signed = r.kind === 'deduction' ? -Number(r.amount) : Number(r.amount);
      push({ employmentId: r.employmentId, employeeName: r.employeeName, employeeCode: r.employeeCode }, 'fixedComponent', signed, r.itemName);
    }

    lines.sort(
      (a, b) =>
        a.employeeName.localeCompare(b.employeeName) ||
        PENDING_MONEY_DOORS.indexOf(a.door) - PENDING_MONEY_DOORS.indexOf(b.door) ||
        (a.itemName ?? '').localeCompare(b.itemName ?? ''),
    );

    const byDoor = PENDING_MONEY_DOORS.map((door) => {
      const own = lines.filter((l) => l.door === door);
      return { door, count: own.length, total: round2(own.reduce((n, l) => n + l.amount, 0)) };
    }).filter((d) => d.count > 0);

    return {
      lines,
      byDoor,
      employees: new Set(lines.map((l) => l.employmentId)).size,
      earnings: round2(lines.filter((l) => l.amount > 0).reduce((n, l) => n + l.amount, 0)),
      deductions: round2(lines.filter((l) => l.amount < 0).reduce((n, l) => n + l.amount, 0)),
      inertRows,
    };
  });
}

// ───────────────────── 9. When a run was processed (dashboard "Processed date") ─────────────────────

/**
 * 7f6ca478 — the DATE each of a set of payroll runs was actually processed, keyed by batch id.
 *
 * THERE IS NO `payroll_batch.processed_at`. `created_at` is the wrong instant (the row exists from the
 * moment the draft is created, often weeks earlier) and `closed_at` is a different act entirely. The only
 * record of when calculation happened is the `payroll-batch.processed` domain event, so this reads that —
 * the same derivation `listUnattachedTxnSummary` uses for `arrivedAfterProcessing`, lifted into a read of
 * its own because the dashboard needs the instant itself rather than a comparison against it.
 *
 * MAX, NOT MIN. A run can be processed, reset back to draft (feedback a03b2d9b) and processed again; each
 * pass appends its own event. The date on the screen must name the CURRENT figures, which are the last
 * pass's — so the latest event wins. A `min()` here would date this month's numbers to a superseded run.
 *
 * THE TIMEZONE IS PART OF THE ANSWER, NOT A DETAIL. `occurred_at` is a timestamptz; a run processed at
 * 00:30 MYT on the 1st happened at 16:30 UTC on the previous day, so reducing the instant to a date in UTC
 * dates a third of the month's evening runs to the wrong day — and in a YEAR-MONTH timeline that is the
 * difference between a run appearing to belong to the previous month. The conversion therefore names
 * Asia/Kuala_Lumpur explicitly (lib/hr-date.ts HR_LOCAL_TZ) rather than leaning on the session timezone,
 * which is right on this deployment only by coincidence.
 *
 * NO "PROCESSED BY" HERE, DELIBERATELY. The event carries an `actor_id`, and resolving it to a name
 * through app_user → person is a solved join in this very file (queryIndividualTxns' `createdBy`). What
 * is NOT established is whether production's existing processed events actually CARRY that actor: a run
 * processed by a script, an import, or any path without a session records actor_type='system' with a null
 * actor_id, and an app_user with no linked person resolves to a null name. A "Processed By" column that is
 * blank on every historical row is worse than no column, so the date ships alone until someone has counted
 * the non-null actors on a real production row set. Adding the column afterwards is this function plus two
 * left joins — see the report for the exact query.
 *
 * DEGRADES, NEVER FLIPS. 'payroll-batch.processed' carries no subject_employment_id, so under ADR-0015 it
 * is admin-only to read: a payroll_partner sees no rows here and every date renders '—' ("not known"),
 * never a wrong date. Read-only, no domain event (pure SELECT). Fails closed on an empty id set.
 */
export function listBatchProcessedDates(
  ctx: SessionContext,
  batchIds: readonly string[],
): Promise<Map<string, string>> {
  if (batchIds.length === 0) return Promise.resolve(new Map());
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        batchId: domainEvent.aggregateId,
        processedOn: sql<string>`to_char(max(${domainEvent.occurredAt}) at time zone ${HR_LOCAL_TZ}::text, 'YYYY-MM-DD')`,
      })
      .from(domainEvent)
      .where(
        and(
          eq(domainEvent.aggregateType, 'payroll-batch'),
          eq(domainEvent.eventType, 'payroll-batch.processed'),
          inArray(domainEvent.aggregateId, batchIds as string[]),
        ),
      )
      .groupBy(domainEvent.aggregateId);
    return new Map(rows.map((r) => [r.batchId, r.processedOn]));
  });
}
