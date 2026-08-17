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
// c11e81aa — and the ONE rule that says which period-keyed transactions a run may collect, so this
// module's "what will this run pay?" card cannot drift from what attach-on-generate actually does.
import { collectableCycleIds, intendedCycleFilter, resolveBatchScopeFilter, type BatchScope } from './payroll';
// 3c473773 — pure, db-free: which payslip box each earning belongs in, from the payslip's own stamp.
import { payslipDisplayEarnings } from './pay-display-category';
// 169e3c24 — the PCB drill-down's relief fallback (pure type; the explainer itself lives beside it).
import type { PcbReliefBreakdown } from './pcb-explain';
// 510f4bd1 — "is this one-off transaction in the employee's latest payslip?", pure and db-free so this
// server read and the client-side panel derivation (existing-context.ts) apply ONE rule, not two.
import { individualTxnReprocessRequired } from './individual-txn-status';
import { packFor } from '../localization/registry';
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
  loanRepayment,
  payComponent,
  payrollBatch,
  payrollBatchComponent,
  payrollCycle,
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
/**
 * The Individual History screen's TRANSACTION-STATUS filter values.
 *
 * ⚠️ THIS IS NO LONGER A STRAIGHT LIST OF BATCH STATUSES, and the difference matters to the next reader.
 * 'unattached' (f1564110 Phase 2) means rows with no batch yet (keyed in before the month's run exists),
 * and 'reprocess' (510f4bd1) is a DERIVED status — a row on a PROCESSED run that is not in the payslip
 * that run last produced for its employee. Neither is a value `payroll_batch.status` can ever hold, so
 * both are handled before the status predicate is built, never passed to `eq(payrollBatch.status, …)`.
 *
 * ⚠️ AND IT FAILS OPEN. An unrecognised value returns `undefined`, which DROPS the filter rather than
 * narrowing to nothing — so a mis-spelled or renamed value silently shows EVERYTHING instead of showing
 * an empty grid. That is deliberate (a tampered param must not reach Postgres, where an invalid enum cast
 * throws) but it means adding a value here without adding it to the callers' own whitelists
 * (app/payroll/transaction-view/page.tsx, app/payroll/transaction-view/export/route.ts) produces an
 * unfiltered list, not an error. test/existing-txn-context.test.ts pins the three sets against each other.
 */
export type IndividualTxnStatusFilter = 'draft' | 'processed' | 'closed' | 'unattached' | 'reprocess';
export const INDIVIDUAL_TXN_STATUS_FILTERS = [
  'unattached',
  'draft',
  'processed',
  'closed',
  'reprocess',
] as const satisfies readonly IndividualTxnStatusFilter[];
const cleanBatchStatus = (v: unknown): IndividualTxnStatusFilter | undefined =>
  (INDIVIDUAL_TXN_STATUS_FILTERS as readonly string[]).includes(v as string)
    ? (v as IndividualTxnStatusFilter)
    : undefined;
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
  /** 4e403268 — THE PAY ITEM, on the listing row at last. Until this round the projection deliberately
   *  carried no `component_id` (`getIndividualTxn`'s doc says so) because the only thing that wanted it
   *  was two per-row buttons, and a by-id read served those better than widening a shared projection.
   *  Day-by-day changes the calculus: the grouping is keyed on (pay period, pay item), so every row on
   *  screen needs its item — a by-id read per row would be N round trips to draw one list. Additive:
   *  three nullable columns from a LEFT JOIN that cannot multiply rows (component_id is a single FK). */
  componentId: string | null;
  componentCode: string | null;
  componentName: string | null;
  txnDate: string;
  amount: string;
  quantity: string | null;
  unit: string | null;
  notes: string | null;
  /** 4e403268 (0432) — provenance. NULL on every row written before that migration, and null MEANS
   *  'manual' (core/payroll-individual-txn.ts `txnSourceOf`) rather than "unknown". */
  source: string | null;
  // "Created By" / "Created Date" audit dimensions (ADR-0056: no created_by column on the ledger row, so the
  // creator is resolved from the row's append-only 'created' DomainEvent → the acting app_user's person name).
  createdOn: string; // 'YYYY-MM-DD' — payroll_individual_txn.created_at cast to a date
  createdById: string | null; // app_user id of the creator (null for SYSTEM / pre-substrate rows)
  createdBy: string | null; // that user's person full name (null when unresolved)
  // ── 510f4bd1: the three facts behind "is this in the employee's latest payslip?" ──
  /** `coalesce(updated_at, created_at)` as a fixed-width UTC instant. The coalesce is load-bearing:
   *  `updated_at` is NULL on a row that has never been edited (db/schema.ts). */
  changedAt: string;
  /** `payslip.created_at` for this (batch, employment) as a fixed-width UTC instant; null when the
   *  employee has no payslip on the run — i.e. this money was never calculated for them. */
  payslipCalculatedAt: string | null;
  /** The run itself says this EMPLOYMENT is stale (`payroll_batch.recalc_employment_ids`). This is the
   *  authoritative employee-level fact — the one `closeBatch` refuses on and the Reprocess screen
   *  pre-ticks — and it can be true while every row below reads Processed (an attendance-driven
   *  recompute, or a delete that left no row to label). It never flips a row's own status. */
  batchNeedsRecalcForEmployment: boolean;
  /** DERIVED, never stored: this row is not in the payslip its processed run last produced. One rule,
   *  applied here and by the workspace panel — see core/individual-txn-status.ts. */
  reprocessRequired: boolean;
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
      componentId: payrollIndividualTxn.componentId,
      componentCode: payComponent.code,
      componentName: payComponent.name,
      txnDate: payrollIndividualTxn.txnDate,
      amount: payrollIndividualTxn.amount,
      quantity: payrollIndividualTxn.quantity,
      unit: payrollIndividualTxn.unit,
      notes: payrollIndividualTxn.notes,
      source: payrollIndividualTxn.source,
      createdOn: sql<string>`to_char(${payrollIndividualTxn.createdAt}, 'YYYY-MM-DD')`,
      createdById: appUser.id,
      createdBy: creatorPerson.fullName,
      // 510f4bd1 — both instants formatted identically, FIXED WIDTH and in UTC, so a string comparison in
      // the pure rule is a chronological one and no Date crosses a serialization boundary.
      changedAt: sql<string>`to_char(coalesce(${payrollIndividualTxn.updatedAt}, ${payrollIndividualTxn.createdAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
      payslipCalculatedAt: sql<
        string | null
      >`to_char(${payslip.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
      batchNeedsRecalcForEmployment: sql<boolean>`(${payrollBatch.needsRecalcAt} is not null and coalesce(${payrollBatch.recalcEmploymentIds}, '[]'::jsonb) @> to_jsonb(${payrollIndividualTxn.employmentId}::text))`,
    })
    .from(payrollIndividualTxn)
    .leftJoin(payrollBatch, eq(payrollBatch.id, payrollIndividualTxn.batchId))
    // 510f4bd1 — the employee's payslip ON THIS RUN, for its `created_at` alone. Cannot multiply rows:
    // `payslip_batch_employment_uq` is unique on exactly this pair. LEFT, because "no payslip" is itself
    // one of the two answers the rule needs (and unattached rows have no batch to join through).
    .leftJoin(
      payslip,
      and(eq(payslip.batchId, payrollIndividualTxn.batchId), eq(payslip.employmentId, payrollIndividualTxn.employmentId)),
    )
    .innerJoin(company, eq(company.id, payrollIndividualTxn.companyId))
    .innerJoin(employment, eq(employment.id, payrollIndividualTxn.employmentId))
    .innerJoin(person, eq(person.id, employment.personId))
    // 4e403268 — the picked Payroll Item Master row, for its code and name. LEFT because `component_id` is
    // nullable (a generic-kind row names no pay item), and it cannot multiply rows: the join is on the
    // component's primary key. An ARCHIVED component still joins on purpose — a row already keyed against
    // an item that was later retired must keep showing which item it was, not go blank.
    .leftJoin(payComponent, eq(payComponent.id, payrollIndividualTxn.componentId))
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
        // 'unattached' and 'reprocess' are NOT batch statuses (see cleanBatchStatus). 'reprocess' narrows
        // in SQL to the runs it can possibly apply to — processed ones — and the row-level half is applied
        // below through the SAME pure rule the screen uses, so the filter and the badges cannot disagree.
        batchStatus === 'unattached'
          ? isNull(payrollIndividualTxn.batchId)
          : batchStatus === 'reprocess'
            ? eq(payrollBatch.status, 'processed')
            : batchStatus
              ? eq(payrollBatch.status, batchStatus)
              : undefined,
        p.createdBy ? eq(domainEvent.actorId, p.createdBy) : undefined,
        createdFrom ? gte(sql`${payrollIndividualTxn.createdAt}::date`, createdFrom) : undefined,
        createdTo ? lte(sql`${payrollIndividualTxn.createdAt}::date`, createdTo) : undefined,
      ),
    )
    .orderBy(desc(payrollIndividualTxn.payPeriod), asc(payrollIndividualTxn.txnDate), asc(payrollIndividualTxn.id));
  // 510f4bd1 — DERIVED once, here, from facts the row already carries. Every consumer (the History grid,
  // its CSV, the workspace panel) reads this same boolean rather than re-deciding, which is what stops the
  // two screens saying different things about one line.
  const derived = rows.map((r) => ({ ...r, reprocessRequired: individualTxnReprocessRequired(r) })) as
    IndividualTxnViewRow[];
  // THE STATUS FILTER HAS TO SELECT WHAT THE STATUS COLUMN SHOWS, or the screen contradicts itself. Once
  // a stale row on a processed run is LABELLED Pending reprocessing, `?txnStatus=processed` must stop
  // returning it — otherwise filtering to Processed lists rows the grid beside it calls something else.
  // (Measured on a dev server before this line existed: it did exactly that.) The other three values need
  // no narrowing — the derived status only ever applies to a `processed` run.
  if (batchStatus === 'reprocess') return derived.filter((r) => r.reprocessRequired);
  if (batchStatus === 'processed') return derived.filter((r) => !r.reprocessRequired);
  return derived;
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
  /**
   * The run that WILL COLLECT these rows, which since c11e81aa is no longer always the regular one: a row
   * that names a Pay Cycle is collected by the run opened under that cycle. 'none' ⇒ that run does not
   * exist for the month yet, which is the designed pre-run entry flow rather than a fault.
   */
  runState: 'none' | 'draft' | 'processed' | 'closed';
  /** The row was keyed in AFTER that run was processed — one of the two ways money strands. */
  arrivedAfterProcessing: boolean;
  /**
   * c11e81aa — the Pay Cycle these rows named, null when they named none. Groups SPLIT on it (see the
   * read's doc comment): rows in one employee-month that are waiting for different runs are different
   * facts and must not be reported under one run state.
   */
  intendedCycleId: string | null;
  /** The named cycle's own name ("Mid-Month"), null when no cycle was named. For the operator's copy. */
  intendedCycleName: string | null;
  /** The named cycle's run type, null when no cycle was named. Drives the "this run abandons it" test. */
  intendedRunType: string | null;
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
 * THE JOIN PREDICATE IS THE INVARIANT, AND c11e81aa CHANGED THE INVARIANT. It used to be keyed on
 * run_type = 'regular' outright, because `generatePayslips` only ever attached on `!subset &&
 * batch.runType === 'regular'`: an off_cycle / bonus / adjustment run for the same month never collected,
 * so joining without that predicate would report a month as "processed" on the strength of a sibling run
 * that was never going to attach anything.
 *
 * THAT SENTENCE IS NOW FALSE AND THE JOIN HAS MOVED WITH IT. A period-keyed row may NAME a Pay Cycle
 * (`intended_cycle_id`, 0441) and is then collected by the run opened under that very cycle
 * (`payroll_batch.payroll_cycle_id`) — so the run whose state answers "has this money been gone past?"
 * is that run, not the regular one. The join therefore mirrors `collectableCycleIds` (core/payroll.ts)
 * exactly, in SQL:
 *
 *   • a row naming NO cycle          → the month's regular run (unchanged; every row on production);
 *   • a row naming a REGULAR cycle   → the month's regular run (one active regular cycle per company and
 *                                      one regular batch per period, so no sibling can compete);
 *   • a row naming any other cycle   → the batch whose `payroll_cycle_id` IS that cycle, if one exists.
 *
 * Leaving the old predicate in place would have reported a Bonus-marked row as sitting behind a
 * "processed" regular run that was never going to touch it — inventing a fault — while hiding the real
 * one, a bonus run that has already gone past it.
 *
 * GROUPS SPLIT BY COLLECTING RUN, and that is a consequence rather than a decision: `payroll_batch.id` has
 * always been in the GROUP BY, so one (employee, month) holding both a no-cycle row and a Bonus row now
 * yields TWO rows with two honest run states instead of one row with a state that fits neither. The
 * intent columns are grouped alongside so a group is never a blend of different intents. Both consumers
 * fold by (employee) or (period) into their own maps, so a split changes their totals not at all.
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
        // c11e81aa — the named cycle, carried out so a consumer can say WHICH run this money is waiting
        // for, and so the wizard pre-flight can test whether the run it is about to start will take it.
        intendedCycleId: payrollIndividualTxn.intendedCycleId,
        intendedCycleName: payrollCycle.name,
        intendedRunType: payrollCycle.runType,
      })
      .from(payrollIndividualTxn)
      // c11e81aa — the row's NAMED cycle, when it named one. LEFT because naming none is the norm.
      .leftJoin(payrollCycle, eq(payrollCycle.id, payrollIndividualTxn.intendedCycleId))
      // The run that will actually collect this row — see the doc comment. Correlated on the row's own
      // (company, period) columns, which are authoritative since 0175.
      //
      // ONE BATCH, ENFORCED BY THE SUBQUERY, and that is not a stylistic preference. Written as a plain
      // ON-clause disjunction, a month holding TWO runs of the same cycle (run_seq 2 and 3, which is
      // exactly the case the entry screen's run picker exists for) would match a row twice, split it into
      // two groups, and every consumer that sums groups — the wizard pre-flight, the batch page's
      // outstanding total, the employee panel's stranded figure — would report the money DOUBLE. So the
      // candidate set is resolved to its earliest run and joined by id.
      .leftJoin(
        payrollBatch,
        eq(
          payrollBatch.id,
          sql`(
            select b2.id from payroll_batch b2
            where b2.company_id = ${payrollIndividualTxn.companyId}
              and b2.pay_period = ${payrollIndividualTxn.payPeriod}
              and (
                (b2.run_type = 'regular'
                  and (${payrollIndividualTxn.intendedCycleId} is null or ${payrollCycle.runType} = 'regular'))
                or b2.payroll_cycle_id = ${payrollIndividualTxn.intendedCycleId}
              )
            order by b2.run_seq
            limit 1
          )`,
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
        // c11e81aa — so a group is never a blend of rows waiting for different runs. `payrollBatch.id`
        // already splits most of them; these keep the split honest for the case where two different
        // named cycles both have no run yet and would otherwise merge under one NULL batch.
        payrollIndividualTxn.intendedCycleId,
        payrollCycle.name,
        payrollCycle.runType,
      )
      .orderBy(desc(sql`${payrollIndividualTxn.payPeriod}`), asc(person.fullName));
    return rows as UnattachedGroupRow[];
  });
}

/** One employee a run is about to leave out, with what they are holding for that month. */
export type UnattachedHolderRow = { employmentId: string; name: string; count: number; amount: string };

/**
 * The employees a run will leave out who are holding transactions for that month (feedback d0d2c9d1).
 * Backs the Payroll Process wizard's Validation-step pre-flight and the same warning on a scoped draft's
 * own page.
 *
 * TWO WAYS A RUN LEAVES MONEY BEHIND, AND IT USED TO KNOW ONLY ONE.
 *
 *  1. WHO IS IN IT. A run narrowed to some employees strands everyone else's rows for that month. That is
 *     the original d0d2c9d1 case and is unchanged: with no selection at all the run takes every employee,
 *     so this half warns about nobody.
 *
 *  2. c11e81aa — WHICH CYCLE IT IS. A row may now NAME a Pay Cycle, and a run collects only the rows that
 *     named its own cycle (plus, for the regular run, the rows that named none). So a FULL, UNSCOPED
 *     REGULAR RUN now legitimately walks past every row somebody marked "Bonus" or "Mid-Month" — and the
 *     old "returns [] for an unscoped run: a full regular run collects everything" reasoning became FALSE
 *     the moment that was true. Leaving it would make this pre-flight go silent on exactly the rows the
 *     change teaches the run to abandon, which is the same silence d0d2c9d1 exists to end.
 *
 * `intendedRunType` is what switches the second half on, and it is OPTIONAL so that every caller which
 * cannot name the run it is about to start (wizard resume mode) keeps today's behaviour exactly. When it
 * IS 'regular', a group whose named cycle is not regular-mapped is reported however the selection reads —
 * a full run included — because that run will not pay it whoever is selected.
 *
 * A NON-REGULAR RUN IS DELIBERATELY NOT WIDENED HERE. It collects strictly MORE than it did before this
 * change (it used to collect nothing period-keyed at all), never less, so it opens no new silence; and a
 * per-cycle "this bonus run leaves the other bonus cycle's rows behind" warning would need the run's own
 * cycle id resolved per company, which this call cannot know for the secondary companies of a
 * multi-company run. Warning wrongly is not better than the honest scope-only warning it already gives.
 *
 * Lives here rather than in the server action so it is reachable by a test without a session — the action
 * is a thin `getSession()` wrapper over it. Read-only, no domain event (pure SELECT via
 * listUnattachedTxnSummary).
 */
export async function unattachedHoldersOutsideSelection(
  ctx: SessionContext,
  p: {
    companyIds: string[];
    payPeriod: string;
    employmentIds?: string[];
    /** c11e81aa — the run type this run will have. Omitted ⇒ only the selection half applies (today's
     *  behaviour verbatim). See the doc comment for why only 'regular' widens the answer. */
    intendedRunType?: string;
  },
): Promise<UnattachedHolderRow[]> {
  const companyIds = (p.companyIds ?? []).filter(Boolean);
  if (companyIds.length === 0 || !/^\d{4}-\d{2}$/.test(p.payPeriod)) return [];
  const selected = (p.employmentIds ?? []).filter(Boolean);
  // c11e81aa — a REGULAR run can now abandon money without narrowing anything, so an unscoped run is no
  // longer automatically silent. Every other case keeps the original early return.
  const abandonsByCycle = p.intendedRunType === 'regular';
  if (selected.length === 0 && !abandonsByCycle) return []; // unscoped run — it collects everything
  const [year, month] = p.payPeriod.split('-').map(Number);

  const groups = await listUnattachedTxnSummary(ctx, { companyIds, year, month });
  const inScope = new Set(selected);
  // Money is summed in CENTS. Adding the decimal strings as floats would drift on exactly the
  // four-figure bonuses this feature exists to surface.
  const byEmployment = new Map<string, { employmentId: string; name: string; count: number; cents: number }>();
  for (const g of groups) {
    // A named cycle this run cannot pay is abandoned whoever is selected; the selection test only decides
    // the FIRST cause. `intendedRunType` absent ⇒ this is always false and the old rule stands alone.
    const wrongCycle = abandonsByCycle && g.intendedRunType != null && g.intendedRunType !== 'regular';
    if (!wrongCycle && (selected.length === 0 || inScope.has(g.employmentId))) continue;
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
  p: {
    companyId: string;
    payPeriod: string;
    scope: BatchScope | null;
    /** c11e81aa — the draft's own run type, so the warning also names money this run walks past because
     *  the operator marked it for another Pay Cycle. See unattachedHoldersOutsideSelection. */
    runType?: string;
  },
): Promise<UnattachedHolderRow[]> {
  const resolved = await withTenant(ctx, (tx) => resolveBatchScopeFilter(tx, p.scope));
  // `employmentIds: null` ⇒ no scope ⇒ whole company. The caller only reaches here for a SCOPED draft
  // (app/payroll/[batchId]/page.tsx gates on `isScoped`), so this stays the plain early return it was —
  // the cycle-abandonment half is carried through `runType` for the scoped case it is asked about.
  if (resolved.employmentIds == null || resolved.employmentIds.length === 0) return [];
  return unattachedHoldersOutsideSelection(ctx, {
    companyIds: [p.companyId],
    payPeriod: p.payPeriod,
    employmentIds: resolved.employmentIds,
    intendedRunType: p.runType,
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
  /** ADR-0077 slice 6 (D-9): the PAYING company's currency. This read is `companyIds`-plural — it backs
   *  the `payroll_history` custom-report dataset, whose seven money columns are summable from the
   *  builder — so without one, a `Total` over a mixed-currency scope is not merely unlabelled, it is
   *  UNDETECTABLE. Additive, exactly like the two columns the note below records.
   *
   *  OPTIONAL, and that is a statement rather than laziness: the SELECT below always fills it, but three
   *  test files hand-build this row from a literal, and an absent currency is a state the consumer must
   *  already handle correctly — `runReportSpec` puts it in its own bucket rather than folding it into a
   *  neighbouring one. Requiring it here would have bought a compile error in fixtures and nothing at
   *  runtime. */
  currency?: string | null;
  payPeriod: string;
  runType: RunType;
  runSeq: number;
  batchStatus: string;
  /** 169e3c24 — read-side additions so a payslip screen can state its publication state and revision
   *  through lib/payroll-publication.ts, the same helper the batch page uses. Additive; no caller of this
   *  read is affected by two extra columns. */
  releasedAt: Date | null;
  version: number;
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
        // ADR-0077 slice 6 (D-9). The `company` join is already here — one column, no new join.
        currency: company.currency,
        payPeriod: payrollBatch.payPeriod,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
        batchStatus: payrollBatch.status,
        // 169e3c24 — publication state + revision count, resolved on screen through payrollPublicationState.
        releasedAt: payrollBatch.releasedAt,
        version: payslip.version,
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
  /** ADR-0077 slice 6 (D-9): the PAYING company's currency. This read is `companyIds`-plural by design —
   *  it backs the `payroll_register` custom-report dataset, which spans every company in the operator's
   *  scope — so twenty-odd money columns arriving without one is how a cross-currency `Total` gets
   *  printed. Sits beside `company` because it is a fact about the same employer, not about the slip. */
  currency: string | null;
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
        // ADR-0077 slice 6 (D-9). The `company` join is already here, so this is one column, no new join.
        currency: company.currency,
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
      // 3c473773 — the EARNINGS columns follow this payslip's own box stamp, so the register cannot
      // disagree with the payslip about which box an amount is in. The DEDUCTION and EMPLOYER columns
      // below stay AS COMPUTED (the full employee share), which is this read's documented contract above
      // and is also what is remitted to KWSP / PERKESO / LHDN — an employer-bears setting funds a share, it
      // does not reduce it.
      const disp = payslipDisplayEarnings(r);
      return {
        ...rest,
        basic: disp.basic.toFixed(2),
        allowance: disp.allowance.toFixed(2),
        overtime: disp.overtime.toFixed(2),
        bonus: disp.bonus.toFixed(2),
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

// ───────────────────── Individual Payslip (169e3c24) — one payslip, admin review ─────────────────────

/** Everything the Individual Payslip screen and its PDF need for ONE payslip, beyond the figures. */
export type PayslipReviewRow = ProcessedPayslipViewRow & {
  companyReg: string | null;
  currency: string;
  department: string | null;
  position: string | null;
  jobGrade: string | null;
  employmentType: string | null;
  paymentMethod: string | null;
  /** MASKED to the last four digits — what the REVIEW SCREEN prints. */
  bankAccountMasked: string | null;
  /**
   * The FULL account number, for the printed payslip only (f35f758a).
   *
   * A COMMENT HERE USED TO SAY THIS NUMBER "must never leave the server". That was never an ADR decision —
   * it was a build-time judgement in 5c198931, recorded only as a code comment citing `core/pdpa.ts` — and
   * the approved plan overturns it: a pay statement that tells an employee the money went to "••••8901"
   * does not tell them which account was paid, which is one of the things a payslip is for.
   *
   * THE EXPOSURE, STATED RATHER THAN IMPLIED. This read is fenced only by `scopedAdmin` (lib/scope.ts), so
   * any admin whose company scope includes the employer can now download a payslip carrying an employee's
   * full account number, before release. That is new for THIS document and not new for the product: the
   * same number is already shown unmasked to admins at app/admin/claims/reimbursements/page.tsx and in the
   * payment summary CSV (core/payroll.ts). The SCREEN deliberately keeps showing only the last four.
   */
  bankAccountFull: string | null;
  bankName: string | null;
  /** IC, or the passport number when there is no IC (a non-Malaysian employee). */
  identityNumber: string | null;
  identityIsPassport: boolean;
  /** 5c198931 — the statutory registration numbers an official payslip carries. Read from the
   *  `employee_statutory_my` row this select already joins, so no new join and no new query. There is no
   *  separate EIS number column: SOCSO and EIS share one number, which is what the attached design prints. */
  epfNumber: string | null;
  socsoNumber: string | null;
  taxNumber: string | null;
  daysWorked: string | null;
  otherDeductions: string;
  employerCost: string;
  payDate: string | null;
};

/**
 * 169e3c24 — ONE payslip for admin review, company-scope fenced.
 *
 * DELIBERATELY NOT `payslipDetail`. That read carries the ESS RELEASE GATE (core/payroll.ts: a payslip is
 * null until its batch is closed AND its release instant has passed), which is exactly right for the
 * employee-facing screen and exactly wrong for a reviewer — the whole point of this screen is to check a
 * run BEFORE anyone in the company sees it. The gate is not weakened, bypassed or parameterised; this is a
 * different read with a different fence (scopedAdmin's companyIds), which is the same decision
 * app/payroll/transaction-view already made and documented.
 *
 * Fails CLOSED on an empty scope, like every read in this file. An out-of-scope payslipId returns null,
 * so a tampered URL is indistinguishable from a missing payslip.
 *
 * The bank account is masked HERE rather than on screen: `employee_statutory_my.bank_account_no` is
 * PDPA-scoped financial data (core/pdpa.ts) and must not be emitted to the client at all, so the read
 * never returns it.
 */
export function payslipForReview(
  ctx: SessionContext,
  p: { companyIds: string[]; payslipId: string },
): Promise<PayslipReviewRow | null> {
  if (p.companyIds.length === 0) return Promise.resolve(null); // fail closed — no scope, no payslip
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        id: payslip.id,
        employmentId: payslip.employmentId,
        employeeName: person.fullName,
        employeeCode: employment.employeeCode,
        companyId: payrollBatch.companyId,
        company: company.legalName,
        companyReg: company.registrationNo,
        currency: company.currency,
        payPeriod: payrollBatch.payPeriod,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
        batchStatus: payrollBatch.status,
        releasedAt: payrollBatch.releasedAt,
        version: payslip.version,
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
        daysWorked: payslip.daysWorked,
        payDate: payrollBatch.batchDate,
        department: department.name,
        position: position.title,
        jobGrade: jobGrade.name,
        employmentType: assignment.employmentType,
        paymentMethod: employment.paymentMethod,
        bankName: employeeStatutoryMy.bankName,
        bankAccountNo: employeeStatutoryMy.bankAccountNo,
        icNumber: employeeStatutoryMy.icNumber,
        passportNumber: employeeStatutoryMy.passportNumber,
        epfNumber: employeeStatutoryMy.epfNumber,
        socsoNumber: employeeStatutoryMy.socsoNumber,
        taxNumber: employeeStatutoryMy.taxNumber,
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
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(and(eq(payslip.id, p.payslipId), inArray(payrollBatch.companyId, p.companyIds)))
      .limit(1);
    if (!row) return null;
    const { bankAccountNo, icNumber, passportNumber, ...rest } = row;
    const acct = (bankAccountNo ?? '').trim();
    return {
      ...rest,
      // Last four only, and only when there are more than four digits to hide. THE SCREEN reads this one.
      bankAccountMasked: acct ? (acct.length > 4 ? `••••${acct.slice(-4)}` : acct) : null,
      // f35f758a — and the FULL number beside it, for the PDF only. See `PayslipReviewRow.bankAccountFull`
      // for what that exposes and why it was a deliberate decision rather than a leak.
      bankAccountFull: acct || null,
      // IC first; a non-Malaysian employee carries a passport instead (icNumber has been nullable since
      // migration 0212). The screen labels which one it is showing rather than calling a passport an IC.
      identityNumber: icNumber?.trim() || passportNumber?.trim() || null,
      identityIsPassport: !icNumber?.trim() && !!passportNumber?.trim(),
    };
  });
}

/**
 * 5c198931 — the year-to-date column, summed ONCE.
 *
 * The Individual Payslip screen computed this inline; the downloaded document did not carry it at all.
 * Now that both the screen and the two PDF routes print it, the summation lives here so a payslip and its
 * own PDF cannot disagree about the employee's year — a screen and a document each doing their own
 * reduce is precisely how one of them drifts.
 *
 * PURE. It sums rows the caller already fetched; it issues no query and decides no scope. WHICH rows are
 * in scope is the caller's fence: the admin surfaces pass every processed payslip for the year, and the
 * employee's own copy passes only their RELEASED ones — an employee must not be shown a total containing
 * a run that has not been released to them.
 */
export type PayslipYtdTotals = { gross: number; epf: number; socso: number; eis: number; pcb: number; net: number };

export function sumPayslipYtd(
  rows: readonly { gross: unknown; net: unknown; statutory: unknown }[],
): PayslipYtdTotals {
  const num = (v: unknown) => Number(v ?? 0);
  return rows.reduce(
    (acc, r) => {
      const st = (r.statutory ?? {}) as Record<string, unknown>;
      return {
        gross: acc.gross + num(r.gross),
        epf: acc.epf + num(st.epfEmployee),
        socso: acc.socso + num(st.socsoEmployee),
        eis: acc.eis + num(st.eisEmployee),
        pcb: acc.pcb + num(st.pcb),
        net: acc.net + num(r.net),
      };
    },
    { gross: 0, epf: 0, socso: 0, eis: 0, pcb: 0, net: 0 },
  );
}

/**
 * 169e3c24 — the employee's CURRENT relief position, used only as the FALLBACK for a payslip calculated
 * before the relief working was recorded on the slip itself.
 *
 * The caller must surface which of the two it is showing (`explainPcb` returns `reliefSource`). Silently
 * substituting today's position for a closed month is the failure this exists to make visible, not to
 * hide: an employee who has since married or had a child would otherwise see January explained with a
 * relief position that did not exist in January.
 *
 * Resolved through the country pack (`packFor(company.country)`), so no MY-specific statutory logic is
 * duplicated here — the amounts come from the same ruleset the run itself resolved.
 */
export function currentPcbReliefs(
  ctx: SessionContext,
  p: { companyIds: string[]; employmentId: string; asOf: string },
): Promise<PcbReliefBreakdown | null> {
  if (p.companyIds.length === 0) return Promise.resolve(null); // fail closed
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        country: company.country,
        category: employeeStatutoryMy.taxCategory,
        children: employeeStatutoryMy.numChildren,
        disabled: employeeStatutoryMy.disabledIndividual,
        disabledSpouse: employeeStatutoryMy.disabledSpouse,
        childReliefMode: employeeStatutoryMy.childReliefMode,
        childReliefTable: employeeStatutoryMy.childReliefTable,
      })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(and(eq(employment.id, p.employmentId), inArray(employment.companyId, p.companyIds)))
      .limit(1);
    if (!row) return null;
    const pack = packFor(row.country);
    if (!pack) return null;
    const rules = await pack.payroll.loadRuleset(tx, { asOf: p.asOf });
    const r = rules.pcb?.reliefs;
    if (!r) return null;
    const category = Number(row.category ?? 1);
    const children =
      row.childReliefMode === 'auto_table' && pack.payroll.childReliefAmountFor
        ? pack.payroll.childReliefAmountFor(row.childReliefTable, r)
        : Number(row.children ?? 0) * r.perChild;
    const spouse = category === 2 ? r.spouse : 0;
    const disabledIndividual = row.disabled ? (r.disabledIndividual ?? 0) : 0;
    const disabledSpouse = row.disabledSpouse && category === 2 ? (r.disabledSpouse ?? 0) : 0;
    return {
      individual: r.individual,
      spouse,
      children,
      disabledIndividual,
      disabledSpouse,
      // LP is a per-MONTH figure, not a relief position — it is read off the payslip's own blob by
      // explainPcb, never re-derived here.
      lp: 0,
      total: r.individual + spouse + children + disabledIndividual + disabledSpouse,
    };
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
      // 510f4bd1 — the SAME value the screen shows. A download that still said `processed` for a line the
      // grid calls Pending reprocessing would be the confusion the request is about, in a second file.
      r.reprocessRequired ? 'reprocess' : (r.batchStatus ?? 'unattached'),
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
  p: { companyIds: string[]; employmentId?: string },
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
          // 6a1f2bd6 — NARROW IN THE QUERY, NOT AFTER IT. With an employee selected in the panel the Zakat
          // screen shows that person's records and nobody else's; filtering the rendered array instead
          // would still have read every colleague's election to throw it away, and the reporter's
          // complaint was precisely that picking somebody changed nothing about what the lists showed.
          p.employmentId ? eq(employment.id, p.employmentId) : undefined,
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

/* ────────────── Loans "Applied in payroll" (feedback 6d72816e) ────────────── */

/**
 * The instalments a payroll run ACTUALLY deducted, for the Loans screen's "Applied in payroll" list.
 *
 * IT LIVES HERE, BESIDE listZakatTxnsAcross, ON PURPOSE. Zakat, Loans and TP1 were each asked for the same
 * screen in the same words, and the one thing that would have produced three lookalikes is three separate
 * "what was applied" reads written a week apart. So this returns the SAME row shape the zakat history
 * returns (period, cycle, employee, company, amount, batch status, timestamp) and both screens render it
 * through the one shared table — components/applied-in-payroll-list.tsx.
 *
 * NOTHING NEW IS STORED. `loan_repayment` has carried applied_batch_id / applied_amount / applied_at /
 * status since ADR-0060; the figures were simply unreachable except by unfolding a row in the loan list.
 * `status = 'applied'` is the whole predicate — 'scheduled' and 'reserved' rows are a plan, not a
 * deduction, and 'skipped' ones were deliberately not taken.
 *
 * The join to payroll_batch goes through applied_batch_id, so a row whose batch has since been deleted
 * simply does not appear rather than rendering a period-less line. Read-only, no domain event (pure
 * SELECT). Fails closed on an empty `companyIds` set, like every other read in this file.
 */
export type AppliedLoanRepaymentViewRow = {
  id: string;
  loanId: string;
  employmentId: string;
  employeeName: string;
  employeeCode: string | null;
  companyId: string;
  company: string;
  /** Instalment number within the loan's schedule (1..durationMonths). */
  sequenceNo: number;
  payPeriod: string; // = "effective payroll month"
  runType: RunType;
  runSeq: number;
  batchStatus: string;
  amount: string; // the RM actually deducted (loan_repayment.applied_amount)
  createdOn: string; // 'YYYY-MM-DD HH:MM:SS' — when the run applied it
};

export function listAppliedLoanRepayments(
  ctx: SessionContext,
  p: { companyIds: string[]; employmentId?: string },
): Promise<AppliedLoanRepaymentViewRow[]> {
  if (p.companyIds.length === 0) return Promise.resolve([]); // fail closed — no scope, no rows
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: loanRepayment.id,
        loanId: loanRepayment.loanId,
        employmentId: loanRepayment.employmentId,
        employeeName: person.fullName,
        employeeCode: employment.employeeCode,
        companyId: payrollBatch.companyId,
        company: company.legalName,
        sequenceNo: loanRepayment.sequenceNo,
        payPeriod: payrollBatch.payPeriod,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
        batchStatus: payrollBatch.status,
        amount: loanRepayment.appliedAmount,
        createdOn: sql<string>`to_char(${loanRepayment.appliedAt}, 'YYYY-MM-DD HH24:MI:SS')`,
      })
      .from(loanRepayment)
      .innerJoin(payrollBatch, eq(payrollBatch.id, loanRepayment.appliedBatchId))
      .innerJoin(employment, eq(employment.id, loanRepayment.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(
        and(
          inArray(payrollBatch.companyId, p.companyIds),
          eq(loanRepayment.status, 'applied'),
          p.employmentId ? eq(loanRepayment.employmentId, p.employmentId) : undefined,
        ),
      )
      .orderBy(
        desc(payrollBatch.payPeriod),
        asc(payrollBatch.runSeq),
        asc(person.fullName),
        asc(loanRepayment.sequenceNo),
      ),
  );
}

/* ────────────── TP1 Relief "Applied in payroll" (feedback 3e3d3fb2) ────────────── */

/**
 * The TP1 relief a payroll run ACTUALLY carried, for the TP1 Relief screen's "Applied in payroll" list.
 *
 * IT LIVES HERE, BESIDE listZakatTxnsAcross AND listAppliedLoanRepayments, FOR THE SAME REASON THEY DO.
 * Zakat (6a1f2bd6), Loans (6d72816e) and TP1 Relief (3e3d3fb2) are one request written three times, and
 * the thing that would have produced three lookalikes is three "what was applied" reads written weeks
 * apart. So this returns the SAME row shape the other two return — period, cycle, employee, company,
 * amount, batch status, timestamp — and all three render through components/applied-in-payroll-list.tsx.
 *
 * WHY payroll_input.tp1_deduction AND NOT payslip.statutory->>'lp', WHICH IS THE OBVIOUS MIRROR OF THE
 * ZAKAT READ. `lp` is NOT the TP1 figure: core/payroll.ts:3482 computes it as
 *     lp = tp1ByEmp(employment) + (isAdditionalRun ? 0 : lpDeclared)
 * so it BLENDS the declaration-fed TP1 with the optional-deduction pay codes (09b554e9) and is charged on
 * the regular run only. A column headed "TP1 relief" showing that number would be wrong twice over. The
 * per-run TP1 figure the kernel consumed is `payroll_input.tp1_deduction` — the row the declaration feeds
 * through prefillTp1FromSelfRelief and the row the Individual Transaction override writes — so that is
 * what this reads. (It is the PRE-clamp input, which core/read.ts myTaxRelief notes; the clamp only ever
 * reduces the claim inside the kernel's own ∑LP ceiling, and the employee's payslip is where the applied
 * figure is shown. This list answers "what did each run take from this declaration".)
 *
 * NOTHING NEW IS STORED, and the STATUS PREDICATE IS LOAD-BEARING. Unlike the zakat read — which starts
 * from `payslip`, a row that only exists post-generation — payroll_input rows exist on DRAFT batches, as
 * keyed intent. A draft is not an application, so `status IN ('processed','closed')` is what makes the
 * word "applied" true here; dropping it would report unrun months as deducted. Rows with a zero TP1 are
 * excluded by construction (an employee with no relief is not a line in this list).
 *
 * Read-only, no domain event (pure SELECT). Fails closed on an empty `companyIds` set, like every other
 * read in this file.
 */
export type AppliedTp1ViewRow = {
  id: string;
  employmentId: string;
  employeeName: string;
  employeeCode: string | null;
  companyId: string;
  company: string;
  payPeriod: string; // = "effective payroll month"
  runType: RunType;
  runSeq: number;
  batchStatus: string; // processed / closed — a draft batch is intent, not an application
  amount: string; // the RM TP1 relief the run carried (payroll_input.tp1_deduction)
  createdOn: string; // 'YYYY-MM-DD HH:MM:SS' — when the input row was created
};

export function listAppliedTp1Deductions(
  ctx: SessionContext,
  p: { companyIds: string[]; employmentId?: string },
): Promise<AppliedTp1ViewRow[]> {
  if (p.companyIds.length === 0) return Promise.resolve([]); // fail closed — no scope, no rows
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: payrollInput.id,
        employmentId: payrollInput.employmentId,
        employeeName: person.fullName,
        employeeCode: employment.employeeCode,
        companyId: payrollBatch.companyId,
        company: company.legalName,
        payPeriod: payrollBatch.payPeriod,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
        batchStatus: payrollBatch.status,
        amount: payrollInput.tp1Deduction,
        createdOn: sql<string>`to_char(${payrollInput.createdAt}, 'YYYY-MM-DD HH24:MI:SS')`,
      })
      .from(payrollInput)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payrollInput.batchId))
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .innerJoin(employment, eq(employment.id, payrollInput.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          inArray(payrollBatch.companyId, p.companyIds),
          p.employmentId ? eq(payrollInput.employmentId, p.employmentId) : undefined,
          // A draft batch has keyed inputs that no run has taken — see the note above.
          inArray(payrollBatch.status, ['processed', 'closed']),
          sql`${payrollInput.tp1Deduction}::numeric > 0`,
        ),
      )
      .orderBy(desc(payrollBatch.payPeriod), asc(payrollBatch.runSeq), asc(person.fullName)),
  );
}

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
 * figure the operator is checking. They are marked `note: 'unattached'` so the screen can say so.
 *
 * c11e81aa AMENDS THE SECOND HALF OF THAT SENTENCE (it read "an ADDITIONAL/off-cycle run does not attach
 * them, so it does not count them"). A period-keyed row may now NAME the Pay Cycle it is waiting for, and
 * the run that collects it is the run OPENED UNDER THAT VERY CYCLE (`payroll_batch.payroll_cycle_id`) —
 * not merely a run of the same type, which would let an "Advance Salary" run count a "Mid-Month" row. So
 * the regular run stops counting a row marked "Bonus" — which it will not pay — and the bonus run counts
 * the rows that named it. A row that named no cycle is still the regular run's and nobody else's, which
 * is every row on production today.
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
        // c11e81aa — the cycle this run was opened under; `collectableCycleIds` needs it to answer which
        // period-keyed rows the run will claim, and it is the only thing separating an "Advance Salary"
        // run from a "Mid-Month" one.
        payrollCycleId: payrollBatch.payrollCycleId,
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

    // ── payroll_individual_txn (door 3): attached to this batch, plus the period-keyed rows
    // attach-on-generate will stamp onto it. See the docstring. ──
    //
    // c11e81aa — MIRRORS THE AMENDED COLLECTION RULE, because this card's whole contract is that "what
    // this run will pay" and "what this card reports" cannot disagree. A period-keyed row now names the
    // Pay Cycle it is waiting for (`intended_cycle_id`, 0441), so:
    //   • the REGULAR run counts rows that named no cycle, plus rows naming any regular-mapped cycle of
    //     the company — and it must STOP promising a row somebody marked "Bonus", which it will not pay;
    //   • a non-regular run counts the rows that named ITS OWN cycle (`payroll_batch.payroll_cycle_id`) —
    //     money this card used to report as belonging to nobody — and nothing else. Not "a cycle of its
    //     TYPE": three default cycles share run_type 'off_cycle', so a type match would have this card
    //     promise a Mid-Month row on an Advance Salary run, and generatePayslips then not pay it.
    // Resolved by the SAME `collectableCycleIds` generatePayslips calls — one rule, imported, not copied.
    const collectable = await collectableCycleIds(tx, batch);
    const attachesUnattached = !collectable.collectsNothing;
    const intentFilter = attachesUnattached ? intendedCycleFilter(collectable) : undefined;
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
                intentFilter,
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
