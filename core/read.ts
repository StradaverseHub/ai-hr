/** Read queries for the UI. Each runs via withTenant, so RLS scopes every result. */
import { and, eq, isNull } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { company, department, employment, leaveRequest, leaveType, person, assignment } from '../db/schema';

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
