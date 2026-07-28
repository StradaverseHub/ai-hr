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
  payrollIndividualTxn,
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
const todayIso = () => new Date().toISOString().slice(0, 10);

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
  p: { companyIds: string[]; year?: number; month?: number; employmentId?: string; cycle?: string },
): Promise<ProcessedPayslipViewRow[]> {
  if (p.companyIds.length === 0) return Promise.resolve([]); // fail closed — no scope, no rows
  const cycle = cleanRunType(p.cycle);
  return withTenant(ctx, (tx) =>
    tx
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
      .orderBy(desc(payrollBatch.payPeriod), asc(payrollBatch.runSeq), asc(person.fullName)),
  );
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
        employmentStatus: assignment.status,
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
    const filename = `individual-transactions_${new Date().toISOString().slice(0, 10)}.csv`;

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
const zakatCsvFilename = () => `zakat-transaction-history_${new Date().toISOString().slice(0, 10)}.csv`;
const zakatFilterPayload = (p: ZakatTxnFilter) => ({
  companyIds: p.companyIds,
  year: p.year ?? null,
  month: p.month ?? null,
  employmentId: p.employmentId ?? null,
  cycle: p.cycle ?? null,
  status: p.status ?? null,
});
