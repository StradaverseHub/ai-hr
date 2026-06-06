/** Read queries for the UI. Each runs via withTenant, so RLS scopes every result. */
import { and, desc, eq, inArray, isNull, sql, type AnyColumn } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import {
  assignment,
  attendance,
  company,
  department,
  domainEvent,
  employment,
  leaveLedger,
  leaveRequest,
  leaveType,
  payrollBatch,
  payslip,
  person,
  position,
  reportingLine,
} from '../db/schema';

export function listEmployees(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        email: person.primaryEmail,
        status: assignment.status,
        department: department.name,
        company: company.legalName,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(
        assignment,
        and(
          eq(assignment.employmentId, employment.id),
          isNull(assignment.validTo),
          isNull(assignment.supersededAt),
        ),
      )
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .orderBy(person.fullName),
  );
}

export function listCompanies(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx.select({ id: company.id, name: company.legalName }).from(company).orderBy(company.legalName),
  );
}

export function listDepartments(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx
      .select({ id: department.id, name: department.name, companyId: department.companyId })
      .from(department)
      .orderBy(department.name),
  );
}

export function listLeaveTypes(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx.select({ id: leaveType.id, code: leaveType.code, name: leaveType.name }).from(leaveType),
  );
}

export function listPendingLeave(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: leaveRequest.id,
        employmentId: leaveRequest.employmentId,
        employee: person.fullName,
        startDate: leaveRequest.startDate,
        endDate: leaveRequest.endDate,
        days: leaveRequest.days,
      })
      .from(leaveRequest)
      .innerJoin(employment, eq(employment.id, leaveRequest.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(leaveRequest.status, 'pending'))
      .orderBy(leaveRequest.startDate),
  );
}

export function employeeDetail(ctx: SessionContext, employmentId: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        employmentId: employment.id,
        employeeCode: employment.employeeCode,
        personId: employment.personId,
        name: person.fullName,
        email: person.primaryEmail,
        phone: person.phone,
        company: company.legalName,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(eq(employment.id, employmentId))
      .limit(1);
    return row ?? null;
  });
}

/** All effective-dated assignment versions (newest first) — the bitemporal history. */
export function assignmentHistory(ctx: SessionContext, employmentId: string) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: assignment.id,
        department: department.name,
        position: position.title,
        status: assignment.status,
        employmentType: assignment.employmentType,
        validFrom: assignment.validFrom,
        validTo: assignment.validTo,
      })
      .from(assignment)
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .leftJoin(position, eq(position.id, assignment.positionId))
      .where(and(eq(assignment.employmentId, employmentId), isNull(assignment.supersededAt)))
      .orderBy(desc(assignment.validFrom)),
  );
}

export function leaveBalances(ctx: SessionContext, employmentId: string) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        leaveTypeId: leaveType.id,
        leaveType: leaveType.name,
        accrued: sql<string>`coalesce(sum(${leaveLedger.days}) filter (where ${leaveLedger.entryType} = 'accrual'), 0)`,
        taken: sql<string>`coalesce(-sum(${leaveLedger.days}) filter (where ${leaveLedger.entryType} = 'debit'), 0)`,
        balance: sql<string>`coalesce(sum(${leaveLedger.days}), 0)`,
      })
      .from(leaveLedger)
      .innerJoin(leaveType, eq(leaveType.id, leaveLedger.leaveTypeId))
      .where(eq(leaveLedger.employmentId, employmentId))
      .groupBy(leaveType.id, leaveType.name);
    return rows.map((r) => ({
      leaveTypeId: r.leaveTypeId,
      leaveType: r.leaveType,
      accrued: Number(r.accrued),
      taken: Number(r.taken),
      balance: Number(r.balance),
    }));
  });
}

export function leaveRequestsFor(ctx: SessionContext, employmentId: string) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: leaveRequest.id,
        leaveType: leaveType.name,
        startDate: leaveRequest.startDate,
        endDate: leaveRequest.endDate,
        days: leaveRequest.days,
        status: leaveRequest.status,
      })
      .from(leaveRequest)
      .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
      .where(eq(leaveRequest.employmentId, employmentId))
      .orderBy(desc(leaveRequest.startDate)),
  );
}

/** Current reporting edges for an employment: who they report to, and their direct reports. */
export function reportingLinesFor(ctx: SessionContext, employmentId: string) {
  return withTenant(ctx, async (tx) => {
    const managers = await tx
      .select({
        id: reportingLine.id,
        lineType: reportingLine.lineType,
        employmentId: reportingLine.managerEmploymentId,
        name: person.fullName,
      })
      .from(reportingLine)
      .innerJoin(employment, eq(employment.id, reportingLine.managerEmploymentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          eq(reportingLine.subordinateEmploymentId, employmentId),
          isNull(reportingLine.validTo),
          isNull(reportingLine.supersededAt),
        ),
      )
      .orderBy(reportingLine.lineType);
    const reports = await tx
      .select({
        id: reportingLine.id,
        lineType: reportingLine.lineType,
        employmentId: reportingLine.subordinateEmploymentId,
        name: person.fullName,
      })
      .from(reportingLine)
      .innerJoin(employment, eq(employment.id, reportingLine.subordinateEmploymentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          eq(reportingLine.managerEmploymentId, employmentId),
          isNull(reportingLine.validTo),
          isNull(reportingLine.supersededAt),
        ),
      )
      .orderBy(person.fullName);
    return { managers, reports };
  });
}

/** Active employees + current administrative reporting edges, for the org chart. */
export function orgChartData(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    const employees = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        department: department.name,
      })
      .from(employment)
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
      .where(isNull(employment.terminatedOn))
      .orderBy(person.fullName);
    const edges = await tx
      .select({
        manager: reportingLine.managerEmploymentId,
        subordinate: reportingLine.subordinateEmploymentId,
      })
      .from(reportingLine)
      .where(
        and(
          eq(reportingLine.lineType, 'administrative'),
          isNull(reportingLine.validTo),
          isNull(reportingLine.supersededAt),
        ),
      );
    return { employees, edges };
  });
}

/** Aggregate counts + latest attendance/payroll snapshot for the dashboard. When `companyId` is
 *  given, every figure is scoped to that company's subtree (consolidation); else the whole tenant. */
export function dashboardStats(ctx: SessionContext, companyId?: string) {
  return withTenant(ctx, async (tx) => {
    const one = sql<number>`count(*)::int`;
    let scopeIds: string[] | null = null;
    if (companyId) {
      const rows = (await tx.execute(
        sql`select id from app.company_subtree(${companyId}::uuid)`,
      )) as unknown as { id: string }[];
      scopeIds = rows.map((r) => r.id);
    }
    const scope = (col: AnyColumn) => (scopeIds ? inArray(col, scopeIds) : sql`true`);

    const [headcount] = await tx
      .select({ n: one })
      .from(employment)
      .where(and(isNull(employment.terminatedOn), scope(employment.companyId)));
    const companiesCount = scopeIds
      ? scopeIds.length
      : ((await tx.select({ n: one }).from(company))[0]?.n ?? 0);
    const [departments] = await tx
      .select({ n: one })
      .from(department)
      .where(scope(department.companyId));
    const [pending] = await tx
      .select({ n: one })
      .from(leaveRequest)
      .innerJoin(employment, eq(employment.id, leaveRequest.employmentId))
      .where(and(eq(leaveRequest.status, 'pending'), scope(employment.companyId)));

    // Breakdown for the most recent day that has any (scoped) attendance.
    const [latestDay] = await tx
      .select({ d: sql<string | null>`max(${attendance.attendanceDate})` })
      .from(attendance)
      .innerJoin(employment, eq(employment.id, attendance.employmentId))
      .where(scope(employment.companyId));
    const byStatus = latestDay?.d
      ? await tx
          .select({ status: attendance.status, n: one })
          .from(attendance)
          .innerJoin(employment, eq(employment.id, attendance.employmentId))
          .where(and(eq(attendance.attendanceDate, latestDay.d), scope(employment.companyId)))
          .groupBy(attendance.status)
      : [];
    const att = (s: string) => byStatus.find((r) => r.status === s)?.n ?? 0;

    // Aggregate payroll totals are admin-only — never surface them to employees/managers.
    const isAdmin = ctx.roles?.some((r) => r === 'hr_admin' || r === 'super_admin') ?? false;
    const [latestPayroll] = isAdmin
      ? await tx
          .select({ payPeriod: payrollBatch.payPeriod, status: payrollBatch.status, totals: payrollBatch.totals })
          .from(payrollBatch)
          .where(scope(payrollBatch.companyId))
          .orderBy(desc(payrollBatch.payPeriod))
          .limit(1)
      : [];

    return {
      headcount: headcount?.n ?? 0,
      companies: companiesCount,
      departments: departments?.n ?? 0,
      pendingLeave: pending?.n ?? 0,
      attendance: {
        date: latestDay?.d ?? null,
        present: att('present'),
        late: att('late'),
        halfDay: att('half_day'),
        absent: att('absent'),
      },
      latestPayroll: latestPayroll
        ? {
            payPeriod: latestPayroll.payPeriod,
            status: latestPayroll.status,
            net: (latestPayroll.totals as { net?: number } | null)?.net ?? null,
          }
        : null,
    };
  });
}

/** Per-company active headcount across the group — the consolidation breakdown (RLS-scoped). */
export function groupBreakdown(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: company.id,
        name: company.legalName,
        parentId: company.parentCompanyId,
        headcount: sql<number>`(count(${employment.id}) filter (where ${employment.terminatedOn} is null))::int`,
      })
      .from(company)
      .leftJoin(employment, eq(employment.companyId, company.id))
      .groupBy(company.id, company.legalName, company.parentCompanyId)
      .orderBy(company.legalName),
  );
}

/** Most recent domain events — the substrate's activity feed. */
export function recentActivity(ctx: SessionContext, limit = 8) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        eventType: domainEvent.eventType,
        aggregateType: domainEvent.aggregateType,
        actorType: domainEvent.actorType,
        occurredAt: domainEvent.occurredAt,
      })
      .from(domainEvent)
      .orderBy(desc(domainEvent.occurredAt))
      .limit(limit),
  );
}

// ─────────────────────────── Self-service portal (own data) ───────────────────────────
// All scoped by RLS to the calling principal: an employee sees only themselves.

/** The current principal's active employment + profile (resolved from their linked person). */
export function myEmployment(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    if (!ctx.personId) return null;
    const [row] = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        email: person.primaryEmail,
        employeeCode: employment.employeeCode,
        hiredOn: employment.hiredOn,
        company: company.legalName,
        department: department.name,
        position: position.title,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
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
      .where(and(eq(employment.personId, ctx.personId), isNull(employment.terminatedOn)))
      .limit(1);
    return row ?? null;
  });
}

/** The current principal's payslips (RLS already restricts to own employment). */
export function myPayslips(ctx: SessionContext, employmentId: string) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: payslip.id,
        payPeriod: payrollBatch.payPeriod,
        status: payrollBatch.status,
        gross: payslip.grossPay,
        deductions: payslip.totalDeductions,
        net: payslip.netPay,
        statutory: payslip.statutory,
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .where(eq(payslip.employmentId, employmentId))
      .orderBy(desc(payrollBatch.payPeriod)),
  );
}

/** The current principal's recent attendance. */
export function myAttendance(ctx: SessionContext, employmentId: string, limit = 10) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: attendance.id,
        date: attendance.attendanceDate,
        checkInAt: attendance.checkInAt,
        checkOutAt: attendance.checkOutAt,
        status: attendance.status,
      })
      .from(attendance)
      .where(eq(attendance.employmentId, employmentId))
      .orderBy(desc(attendance.attendanceDate))
      .limit(limit),
  );
}

/** Companies with their parent link — the group tree (ADR-0009). */
export function companyTree(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: company.id,
        name: company.legalName,
        country: company.country,
        parentId: company.parentCompanyId,
      })
      .from(company)
      .orderBy(company.legalName),
  );
}
