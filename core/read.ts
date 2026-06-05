/** Read queries for the UI. Each runs via withTenant, so RLS scopes every result. */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import {
  assignment,
  company,
  department,
  employment,
  leaveLedger,
  leaveRequest,
  leaveType,
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
