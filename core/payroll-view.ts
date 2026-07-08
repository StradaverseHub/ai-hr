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
import { and, asc, desc, eq, gte, inArray, isNull, like, lt, or } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { toCsv } from '../lib/csv';
import {
  company,
  employment,
  employmentPayComponent,
  payComponent,
  payrollBatch,
  payrollIndividualTxn,
  payrollRunTypeEnum,
  payslip,
  person,
  type PayrollTxnKind,
} from '../db/schema';

/** 'YYYY-MM-DD' today — the same string axis validFrom/validTo live on. */
const todayIso = () => new Date().toISOString().slice(0, 10);

type RunType = (typeof payrollRunTypeEnum.enumValues)[number];
/** Coerce an untrusted cycle filter to a valid enum value or undefined — an unknown value (URL
 *  tamper, stale form) must not reach Postgres, where an invalid enum cast throws. */
const cleanRunType = (v: unknown): RunType | undefined =>
  payrollRunTypeEnum.enumValues.includes(v as RunType) ? (v as RunType) : undefined;

/** Optional period narrowing on payroll_batch.pay_period ('YYYY-MM'): year+month → exact month;
 *  year only → that year; month only → that month across years. */
function periodFilter(year?: number, month?: number) {
  const mm = month != null ? String(month).padStart(2, '0') : null;
  if (year != null && mm) return eq(payrollBatch.payPeriod, `${year}-${mm}`);
  if (year != null) return like(payrollBatch.payPeriod, `${year}-%`);
  if (mm) return like(payrollBatch.payPeriod, `%-${mm}`);
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
  runType: RunType;
  runSeq: number;
  batchStatus: string;
  kind: PayrollTxnKind;
  txnDate: string;
  amount: string;
  quantity: string | null;
  unit: string | null;
  notes: string | null;
};

/**
 * Dated one-off transactions across ALL batches (any status — draft AND processed/closed, so the
 * inquiry composes with batch-lifecycle changes) in the scoped companies, joined through
 * payroll_batch for period/company/status. Read-only, no domain event (pure SELECT).
 * Generalises listIndividualTxns, which is single-(draft)-batch.
 */
export function listIndividualTxnsAcross(
  ctx: SessionContext,
  p: { companyIds: string[]; year?: number; month?: number; employmentId?: string },
): Promise<IndividualTxnViewRow[]> {
  if (p.companyIds.length === 0) return Promise.resolve([]); // fail closed — no scope, no rows
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: payrollIndividualTxn.id,
        employmentId: payrollIndividualTxn.employmentId,
        employeeName: person.fullName,
        employeeCode: employment.employeeCode,
        companyId: payrollBatch.companyId,
        company: company.legalName,
        payPeriod: payrollBatch.payPeriod,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
        batchStatus: payrollBatch.status,
        kind: payrollIndividualTxn.kind,
        txnDate: payrollIndividualTxn.txnDate,
        amount: payrollIndividualTxn.amount,
        quantity: payrollIndividualTxn.quantity,
        unit: payrollIndividualTxn.unit,
        notes: payrollIndividualTxn.notes,
      })
      .from(payrollIndividualTxn)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payrollIndividualTxn.batchId))
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .innerJoin(employment, eq(employment.id, payrollIndividualTxn.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          inArray(payrollBatch.companyId, p.companyIds),
          periodFilter(p.year, p.month),
          p.employmentId ? eq(payrollIndividualTxn.employmentId, p.employmentId) : undefined,
        ),
      )
      .orderBy(desc(payrollBatch.payPeriod), asc(payrollIndividualTxn.txnDate), asc(payrollIndividualTxn.id)),
  );
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
  p: { companyIds: string[]; year?: number; month?: number; employmentId?: string },
): Promise<{ content: string; filename: string; rowCount: number }> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        payPeriod: payrollBatch.payPeriod,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
        batchStatus: payrollBatch.status,
        txnDate: payrollIndividualTxn.txnDate,
        employeeName: person.fullName,
        employeeCode: employment.employeeCode,
        company: company.legalName,
        kind: payrollIndividualTxn.kind,
        amount: payrollIndividualTxn.amount,
        quantity: payrollIndividualTxn.quantity,
        unit: payrollIndividualTxn.unit,
        notes: payrollIndividualTxn.notes,
      })
      .from(payrollIndividualTxn)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payrollIndividualTxn.batchId))
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .innerJoin(employment, eq(employment.id, payrollIndividualTxn.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        p.companyIds.length === 0
          ? // fail closed — no scope, no rows (still emits a header-only CSV + a 0-row export event)
            eq(payrollBatch.companyId, '00000000-0000-0000-0000-000000000000')
          : and(
              inArray(payrollBatch.companyId, p.companyIds),
              periodFilter(p.year, p.month),
              p.employmentId ? eq(payrollIndividualTxn.employmentId, p.employmentId) : undefined,
            ),
      )
      .orderBy(desc(payrollBatch.payPeriod), asc(payrollIndividualTxn.txnDate), asc(payrollIndividualTxn.id));

    const header = [
      'Payroll Period',
      'Cycle',
      'Run',
      'Batch Status',
      'Transaction Date',
      'Employee',
      'Employee Code',
      'Company',
      'Item',
      'Amount',
      'Quantity',
      'Unit',
      'Remarks',
    ];
    const body = rows.map((r) => [
      r.payPeriod,
      r.runType,
      r.runSeq,
      r.batchStatus,
      r.txnDate,
      r.employeeName,
      r.employeeCode ?? '',
      r.company,
      r.kind,
      Number(r.amount).toFixed(2),
      r.quantity ?? '',
      r.unit ?? '',
      r.notes ?? '',
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
        },
      },
    });

    return { content, filename, rowCount: rows.length };
  });
}
