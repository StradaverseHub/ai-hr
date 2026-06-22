/** Read queries for the UI. Each runs via withTenant, so RLS scopes every result. */
import { and, desc, eq, gte, inArray, isNull, lte, sql, type AnyColumn } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import {
  appUser,
  assignment,
  attendance,
  company,
  compensation,
  department,
  domainEvent,
  employeeStatutoryMy,
  employment,
  holiday,
  leaveLedger,
  leaveRequest,
  leaveType,
  payrollBatch,
  payslip,
  person,
  position,
  reportingLine,
} from '../db/schema';

export function listEmployees(ctx: SessionContext, companyIds?: string[]) {
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
      .where(companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined)
      .orderBy(person.fullName),
  );
}

export type EmployeeListRow = {
  employmentId: string;
  name: string;
  email: string;
  status: string | null;
  department: string | null;
  company: string;
  hiredOn: string;
  terminatedOn: string | null;
};

/** Paginated + searchable employee list for the People page. Returns the page rows plus the
 *  total match count (for the pager). Search matches name or email (case-insensitive). The
 *  unpaginated `listEmployees` stays for callers that genuinely need the whole set (transfer
 *  target dropdowns, exports). */
export function listEmployeesPage(
  ctx: SessionContext,
  p: { companyIds?: string[]; q?: string; limit: number; offset: number },
): Promise<{ rows: EmployeeListRow[]; total: number }> {
  return withTenant(ctx, async (tx) => {
    const q = p.q?.trim();
    const where = and(
      p.companyIds && p.companyIds.length ? inArray(employment.companyId, p.companyIds) : undefined,
      q
        ? sql`(${person.fullName} ilike ${'%' + q + '%'} or ${person.primaryEmail} ilike ${'%' + q + '%'})`
        : undefined,
    );
    const rows = (await tx
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
      .where(where)
      .orderBy(person.fullName)
      .limit(p.limit)
      .offset(p.offset)) as EmployeeListRow[];
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(where);
    return { rows, total: Number(count) };
  });
}

export function listCompanies(ctx: SessionContext, opts: { includeArchived?: boolean } = {}) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: company.id,
        name: company.legalName,
        country: company.country,
        currency: company.currency,
        registrationNo: company.registrationNo,
        archivedAt: company.archivedAt,
        inUse: sql<boolean>`exists (select 1 from department d where d.company_id = company.id) or exists (select 1 from employment e where e.company_id = company.id) or exists (select 1 from company c where c.parent_company_id = company.id)`,
      })
      .from(company)
      .where(opts.includeArchived ? undefined : isNull(company.archivedAt))
      .orderBy(company.legalName),
  );
}

export function listDepartments(
  ctx: SessionContext,
  opts: { includeArchived?: boolean; companyIds?: string[] } = {},
) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: department.id,
        name: department.name,
        companyId: department.companyId,
        archivedAt: department.archivedAt,
        inUse: sql<boolean>`exists (select 1 from assignment a where a.department_id = department.id and a.superseded_at is null)`,
      })
      .from(department)
      .where(
        and(
          opts.includeArchived ? undefined : isNull(department.archivedAt),
          opts.companyIds && opts.companyIds.length ? inArray(department.companyId, opts.companyIds) : undefined,
        ),
      )
      .orderBy(department.name),
  );
}

export function listLeaveTypes(ctx: SessionContext, opts: { includeArchived?: boolean } = {}) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: leaveType.id,
        code: leaveType.code,
        name: leaveType.name,
        paid: leaveType.paid,
        counting: leaveType.counting,
        requiresDocument: leaveType.requiresDocument,
        archivedAt: leaveType.archivedAt,
        inUse: sql<boolean>`exists (select 1 from leave_request lr where lr.leave_type_id = leave_type.id) or exists (select 1 from leave_ledger ll where ll.leave_type_id = leave_type.id) or exists (select 1 from leave_policy lp where lp.leave_type_id = leave_type.id)`,
      })
      .from(leaveType)
      .where(opts.includeArchived ? undefined : isNull(leaveType.archivedAt)),
  );
}

/** Every leave request in scope (RLS additionally trims to what the viewer may see:
 *  admins everything, managers their reports, employees themselves). Recent first. */
export function listLeaveRequests(ctx: SessionContext, companyIds?: string[], limit = 200) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: leaveRequest.id,
        employmentId: leaveRequest.employmentId,
        personId: employment.personId,
        employee: person.fullName,
        leaveType: leaveType.name,
        typeCode: leaveType.code,
        appliedOn: leaveRequest.createdAt,
        startDate: leaveRequest.startDate,
        endDate: leaveRequest.endDate,
        days: leaveRequest.days,
        status: leaveRequest.status,
        hasDocument: sql<boolean>`exists (select 1 from leave_request_attachment lra where lra.leave_request_id = leave_request.id)`,
      })
      .from(leaveRequest)
      .innerJoin(employment, eq(employment.id, leaveRequest.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
      .where(
        companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined,
      )
      .orderBy(desc(leaveRequest.createdAt))
      .limit(limit),
  );
}

/** Planned-absences timeline: every active employee in scope, each with their approved +
 *  pending leave overlapping the [from, to] window. Powers the dashboard hero. */
export function plannedAbsences(
  ctx: SessionContext,
  companyIds: string[] | undefined,
  range: { from: string; to: string },
) {
  return withTenant(ctx, async (tx) => {
    const emps = await tx
      .select({
        personId: employment.personId,
        employmentId: employment.id,
        name: person.fullName,
        role: position.title,
        company: company.legalName,
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
      .leftJoin(position, eq(position.id, assignment.positionId))
      .where(
        and(
          isNull(employment.terminatedOn),
          companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined,
        ),
      )
      .orderBy(person.fullName);

    const leaves = await tx
      .select({
        id: leaveRequest.id,
        employmentId: leaveRequest.employmentId,
        typeCode: leaveType.code,
        typeName: leaveType.name,
        paid: leaveType.paid,
        status: leaveRequest.status,
        startDate: leaveRequest.startDate,
        endDate: leaveRequest.endDate,
      })
      .from(leaveRequest)
      .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
      .innerJoin(employment, eq(employment.id, leaveRequest.employmentId))
      .where(
        and(
          inArray(leaveRequest.status, ['approved', 'pending']),
          // overlaps the window: starts on/before `to` AND ends on/after `from`
          lte(leaveRequest.startDate, range.to),
          gte(leaveRequest.endDate, range.from),
          companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined,
        ),
      )
      .orderBy(leaveRequest.startDate);

    type Leave = (typeof leaves)[number];
    const byEmp = new Map<string, Leave[]>();
    for (const l of leaves) {
      const arr = byEmp.get(l.employmentId);
      if (arr) arr.push(l);
      else byEmp.set(l.employmentId, [l]);
    }
    // One row per person — concurrent employments merge their leave onto a single row.
    const byPerson = new Map<string, { id: string; name: string; role: string | null; leaves: Leave[] }>();
    for (const e of emps) {
      const empLeaves = byEmp.get(e.employmentId) ?? [];
      const existing = byPerson.get(e.personId);
      if (existing) {
        existing.leaves.push(...empLeaves);
        if (!existing.role && e.role) existing.role = e.role;
      } else {
        byPerson.set(e.personId, { id: e.personId, name: e.name, role: e.role, leaves: empLeaves });
      }
    }
    return [...byPerson.values()];
  });
}

/** Recently-joined employees in scope (for the dashboard Onboarding card). */
export function recentHires(
  ctx: SessionContext,
  companyIds: string[] | undefined,
  opts: { since: string; limit?: number },
) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        role: position.title,
        department: department.name,
        status: assignment.status,
        hiredOn: employment.hiredOn,
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
      .leftJoin(position, eq(position.id, assignment.positionId))
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .where(
        and(
          isNull(employment.terminatedOn),
          gte(employment.hiredOn, opts.since),
          companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined,
        ),
      )
      .orderBy(desc(employment.hiredOn))
      .limit(opts.limit ?? 5),
  );
}

/** Upcoming public holidays in scope (for the dashboard Upcoming-events card). */
export function upcomingHolidays(ctx: SessionContext, opts: { from: string; limit?: number }) {
  return withTenant(ctx, (tx) =>
    tx
      .select({ name: holiday.name, date: holiday.holidayDate })
      .from(holiday)
      .where(gte(holiday.holidayDate, opts.from))
      .orderBy(holiday.holidayDate)
      .limit(opts.limit ?? 5),
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
    const [rows, pend] = await Promise.all([
      tx
        .select({
          leaveTypeId: leaveType.id,
          leaveType: leaveType.name,
          accrued: sql<string>`coalesce(sum(${leaveLedger.days}) filter (where ${leaveLedger.entryType} in ('accrual', 'in_lieu_accrual')), 0)`,
          taken: sql<string>`coalesce(-sum(${leaveLedger.days}) filter (where ${leaveLedger.entryType} = 'debit'), 0)`,
          balance: sql<string>`coalesce(sum(${leaveLedger.days}), 0)`,
        })
        .from(leaveLedger)
        .innerJoin(leaveType, eq(leaveType.id, leaveLedger.leaveTypeId))
        .where(eq(leaveLedger.employmentId, employmentId))
        .groupBy(leaveType.id, leaveType.name),
      tx
        .select({
          leaveTypeId: leaveRequest.leaveTypeId,
          leaveType: leaveType.name,
          pending: sql<string>`coalesce(sum(${leaveRequest.days}), 0)`,
        })
        .from(leaveRequest)
        .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
        .where(and(eq(leaveRequest.employmentId, employmentId), eq(leaveRequest.status, 'pending')))
        .groupBy(leaveRequest.leaveTypeId, leaveType.name),
    ]);
    const pendingBy = new Map(pend.map((p) => [p.leaveTypeId, Number(p.pending)]));
    const out = rows.map((r) => {
      const pending = pendingBy.get(r.leaveTypeId) ?? 0;
      const balance = Number(r.balance);
      return {
        leaveTypeId: r.leaveTypeId,
        leaveType: r.leaveType,
        accrued: Number(r.accrued),
        taken: Number(r.taken),
        pending,
        balance,
        // What the employee can still book: ledger balance minus not-yet-decided requests.
        available: balance - pending,
      };
    });
    // Types with pending requests but no ledger entries yet (e.g. non-accrued sick leave)
    // must still surface, or the pending request is invisible.
    const seen = new Set(out.map((r) => r.leaveTypeId));
    for (const p of pend) {
      if (seen.has(p.leaveTypeId)) continue;
      const pending = Number(p.pending);
      out.push({
        leaveTypeId: p.leaveTypeId,
        leaveType: p.leaveType,
        accrued: 0,
        taken: 0,
        pending,
        balance: 0,
        available: -pending,
      });
    }
    return out.sort((a, b) => a.leaveType.localeCompare(b.leaveType));
  });
}

/** Per-employee × leave-type balances for everyone in scope (the Leave page matrix). */
export function leaveBalancesAll(ctx: SessionContext, companyIds?: string[]) {
  return withTenant(ctx, async (tx) => {
    const scope = and(
      isNull(employment.terminatedOn),
      companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined,
    );
    const [rows, pend] = await Promise.all([
      tx
        .select({
          employmentId: employment.id,
          personId: employment.personId,
          name: person.fullName,
          leaveTypeId: leaveType.id,
          leaveType: leaveType.name,
          accrued: sql<string>`coalesce(sum(${leaveLedger.days}) filter (where ${leaveLedger.entryType} in ('accrual', 'in_lieu_accrual')), 0)`,
          taken: sql<string>`coalesce(-sum(${leaveLedger.days}) filter (where ${leaveLedger.entryType} = 'debit'), 0)`,
          balance: sql<string>`coalesce(sum(${leaveLedger.days}), 0)`,
        })
        .from(leaveLedger)
        .innerJoin(employment, eq(employment.id, leaveLedger.employmentId))
        .innerJoin(person, eq(person.id, employment.personId))
        .innerJoin(leaveType, eq(leaveType.id, leaveLedger.leaveTypeId))
        .where(scope)
        .groupBy(employment.id, employment.personId, person.fullName, leaveType.id, leaveType.name)
        .orderBy(person.fullName, leaveType.name),
      tx
        .select({
          employmentId: leaveRequest.employmentId,
          personId: employment.personId,
          name: person.fullName,
          leaveTypeId: leaveRequest.leaveTypeId,
          leaveType: leaveType.name,
          pending: sql<string>`coalesce(sum(${leaveRequest.days}), 0)`,
        })
        .from(leaveRequest)
        .innerJoin(employment, eq(employment.id, leaveRequest.employmentId))
        .innerJoin(person, eq(person.id, employment.personId))
        .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
        .where(and(eq(leaveRequest.status, 'pending'), scope))
        .groupBy(
          leaveRequest.employmentId,
          employment.personId,
          person.fullName,
          leaveRequest.leaveTypeId,
          leaveType.name,
        ),
    ]);
    const pendingBy = new Map(pend.map((p) => [`${p.employmentId}|${p.leaveTypeId}`, Number(p.pending)]));
    const out = rows.map((r) => {
      const pending = pendingBy.get(`${r.employmentId}|${r.leaveTypeId}`) ?? 0;
      const balance = Number(r.balance);
      return {
        employmentId: r.employmentId,
        personId: r.personId,
        name: r.name,
        leaveTypeId: r.leaveTypeId,
        leaveType: r.leaveType,
        accrued: Number(r.accrued),
        taken: Number(r.taken),
        pending,
        balance,
        available: balance - pending,
      };
    });
    // Pending-only (employment, type) combos — e.g. non-accrued sick leave — must surface too.
    const seen = new Set(out.map((r) => `${r.employmentId}|${r.leaveTypeId}`));
    for (const p of pend) {
      if (seen.has(`${p.employmentId}|${p.leaveTypeId}`)) continue;
      const pending = Number(p.pending);
      out.push({
        employmentId: p.employmentId,
        personId: p.personId,
        name: p.name,
        leaveTypeId: p.leaveTypeId,
        leaveType: p.leaveType,
        accrued: 0,
        taken: 0,
        pending,
        balance: 0,
        available: -pending,
      });
    }
    return out;
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
        hasDocument: sql<boolean>`exists (select 1 from leave_request_attachment lra where lra.leave_request_id = leave_request.id)`,
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
export function orgChartData(ctx: SessionContext, companyIds?: string[]) {
  return withTenant(ctx, async (tx) => {
    const employees = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        role: position.title,
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
      .leftJoin(position, eq(position.id, assignment.positionId))
      .where(
        and(
          isNull(employment.terminatedOn),
          companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined,
        ),
      )
      .orderBy(person.fullName);
    const edges = await tx
      .select({
        manager: reportingLine.managerEmploymentId,
        subordinate: reportingLine.subordinateEmploymentId,
        type: reportingLine.lineType,
      })
      .from(reportingLine)
      .where(and(isNull(reportingLine.validTo), isNull(reportingLine.supersededAt)));
    return { employees, edges };
  });
}

/** Aggregate counts + latest attendance/payroll snapshot for the dashboard. When `companyId` is
 *  given, every figure is scoped to that company's subtree (consolidation); else the whole tenant. */
export function dashboardStats(ctx: SessionContext, companyIds?: string[]) {
  return withTenant(ctx, async (tx) => {
    const one = sql<number>`count(*)::int`;
    const scopeIds = companyIds && companyIds.length ? companyIds : null;
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
    // Wave 2C (ADR-0024): the latest month may hold multiple runs (regular + bonus/off-cycle). Pick the
    // latest (company, period) and SUM its runs' net — runs store delta totals, so summing yields the
    // month's net; with a single run this is identical to before.
    const latestRows = isAdmin
      ? await tx
          .select({
            companyId: payrollBatch.companyId,
            payPeriod: payrollBatch.payPeriod,
            status: payrollBatch.status,
            totals: payrollBatch.totals,
          })
          .from(payrollBatch)
          .where(scope(payrollBatch.companyId))
          .orderBy(desc(payrollBatch.payPeriod))
      : [];
    const head = latestRows[0];
    const latestPayroll = head
      ? (() => {
          const runs = latestRows.filter(
            (r) => r.payPeriod === head.payPeriod && r.companyId === head.companyId,
          );
          const net =
            Math.round(
              runs.reduce((s, r) => s + Number((r.totals as { net?: number } | null)?.net ?? 0), 0) * 100,
            ) / 100;
          const status = runs.every((r) => r.status === 'closed')
            ? 'closed'
            : runs.some((r) => r.status === 'draft')
              ? 'draft'
              : 'processed';
          return { payPeriod: head.payPeriod, status, totals: { net } };
        })()
      : undefined;

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
        aggregateType: domainEvent.aggregateType,
        aggregateId: domainEvent.aggregateId,
        eventType: domainEvent.eventType,
        actorType: domainEvent.actorType,
        actorName: person.fullName,
        occurredAt: domainEvent.occurredAt,
      })
      .from(domainEvent)
      .leftJoin(appUser, eq(appUser.id, domainEvent.actorId))
      .leftJoin(person, eq(person.id, appUser.personId))
      .orderBy(desc(domainEvent.occurredAt))
      .limit(limit),
  );
}

export type AuditRow = {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  actorType: string;
  actorName: string | null;
  payload: unknown;
  occurredAt: Date;
  sequence: number;
};

export type AuditFilters = {
  aggregateType?: string;
  eventQuery?: string; // matches event type / aggregate type
  actorId?: string;
  from?: string; // ISO date (inclusive)
  to?: string; // ISO date (exclusive next day applied by caller)
  limit?: number;
  offset?: number;
};

/** The full append-only event ledger, filterable. RLS scopes to the tenant; the actor name is
 *  resolved from app_user → person (null for SYSTEM/AGENT/EXTERNAL or unlinked principals). */
export function auditEvents(ctx: SessionContext, f: AuditFilters = {}): Promise<AuditRow[]> {
  const limit = Math.min(f.limit ?? 100, 500);
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: domainEvent.id,
        aggregateType: domainEvent.aggregateType,
        aggregateId: domainEvent.aggregateId,
        eventType: domainEvent.eventType,
        actorType: domainEvent.actorType,
        actorName: person.fullName,
        payload: domainEvent.payload,
        occurredAt: domainEvent.occurredAt,
        sequence: domainEvent.sequence,
      })
      .from(domainEvent)
      .leftJoin(appUser, eq(appUser.id, domainEvent.actorId))
      .leftJoin(person, eq(person.id, appUser.personId))
      .where(
        and(
          f.aggregateType ? eq(domainEvent.aggregateType, f.aggregateType) : undefined,
          f.actorId ? eq(domainEvent.actorId, f.actorId) : undefined,
          f.from ? gte(domainEvent.occurredAt, new Date(`${f.from}T00:00:00Z`)) : undefined,
          f.to ? lte(domainEvent.occurredAt, new Date(`${f.to}T23:59:59.999Z`)) : undefined,
          f.eventQuery
            ? sql`(${domainEvent.eventType} ilike ${'%' + f.eventQuery + '%'} or ${domainEvent.aggregateType} ilike ${'%' + f.eventQuery + '%'})`
            : undefined,
        ),
      )
      .orderBy(desc(domainEvent.occurredAt), desc(domainEvent.sequence))
      .limit(limit)
      .offset(f.offset ?? 0),
  ) as Promise<AuditRow[]>;
}

/** The distinct aggregate types present in the tenant's log — drives the filter dropdown. */
export function auditAggregateTypes(ctx: SessionContext): Promise<{ aggregateType: string }[]> {
  return withTenant(ctx, (tx) =>
    tx
      .selectDistinct({ aggregateType: domainEvent.aggregateType })
      .from(domainEvent)
      .orderBy(domainEvent.aggregateType),
  );
}

/** Change history for one employee — every event touching their employment, person, statutory
 *  profile, and compensation rows (the aggregates that carry their record). RLS-scoped. */
export function employeeAudit(ctx: SessionContext, employmentId: string, limit = 50): Promise<AuditRow[]> {
  return withTenant(ctx, async (tx) => {
    const [emp] = await tx
      .select({ personId: employment.personId })
      .from(employment)
      .where(eq(employment.id, employmentId))
      .limit(1);
    if (!emp) return [];
    const ids = new Set<string>([employmentId, emp.personId]);
    const [stat] = await tx
      .select({ id: employeeStatutoryMy.id })
      .from(employeeStatutoryMy)
      .where(eq(employeeStatutoryMy.personId, emp.personId))
      .limit(1);
    if (stat) ids.add(stat.id);
    const comps = await tx
      .select({ id: compensation.id })
      .from(compensation)
      .where(eq(compensation.employmentId, employmentId));
    comps.forEach((c) => ids.add(c.id));
    return tx
      .select({
        id: domainEvent.id,
        aggregateType: domainEvent.aggregateType,
        aggregateId: domainEvent.aggregateId,
        eventType: domainEvent.eventType,
        actorType: domainEvent.actorType,
        actorName: person.fullName,
        payload: domainEvent.payload,
        occurredAt: domainEvent.occurredAt,
        sequence: domainEvent.sequence,
      })
      .from(domainEvent)
      .leftJoin(appUser, eq(appUser.id, domainEvent.actorId))
      .leftJoin(person, eq(person.id, appUser.personId))
      .where(inArray(domainEvent.aggregateId, [...ids]))
      .orderBy(desc(domainEvent.occurredAt), desc(domainEvent.sequence))
      .limit(limit);
  }) as Promise<AuditRow[]>;
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
      .orderBy(employment.hiredOn)
      .limit(1);
    return row ?? null;
  });
}

/** ALL active employments for the current principal (concurrent multi-company, ADR-0009). */
export function myEmployments(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    if (!ctx.personId) return [];
    return tx
      .select({
        employmentId: employment.id,
        company: company.legalName,
        department: department.name,
        position: position.title,
        hiredOn: employment.hiredOn,
        basic: compensation.basicSalary,
        allowance: compensation.monthlyAllowance,
        costAllocation: employment.costAllocation,
      })
      .from(employment)
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
      .leftJoin(
        compensation,
        and(
          eq(compensation.employmentId, employment.id),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      )
      .where(and(eq(employment.personId, ctx.personId), isNull(employment.terminatedOn)))
      .orderBy(employment.hiredOn);
  });
}

export type ConcurrentEmploymentPerson = {
  personId: string;
  personName: string;
  designatedPaymasterEmploymentId: string | null;
  employments: { employmentId: string; companyId: string; company: string; isPaymaster: boolean }[];
};

/**
 * ADR-0029 diagnostic (read-only) — persons holding ≥2 ACTIVE employments across the tenant's companies:
 * the population whose monthly PCB may under-deduct unless a designated paymaster is set (scope-out) or
 * group coordination is enabled. Surfaced on Compliance so payroll can see the cross-entity exposure
 * (e.g. shared-services staff) and assign a paymaster. Tenant-scoped; orders by name.
 */
export function concurrentEmploymentPersons(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        personId: employment.personId,
        personName: person.fullName,
        designatedPaymasterEmploymentId: person.designatedPaymasterEmploymentId,
        employmentId: employment.id,
        companyId: employment.companyId,
        company: company.legalName,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(isNull(employment.terminatedOn))
      .orderBy(person.fullName);

    const byPerson = new Map<string, ConcurrentEmploymentPerson>();
    for (const r of rows) {
      let p = byPerson.get(r.personId);
      if (!p) {
        p = {
          personId: r.personId,
          personName: r.personName,
          designatedPaymasterEmploymentId: r.designatedPaymasterEmploymentId,
          employments: [],
        };
        byPerson.set(r.personId, p);
      }
      p.employments.push({
        employmentId: r.employmentId,
        companyId: r.companyId,
        company: r.company,
        isPaymaster: r.employmentId === r.designatedPaymasterEmploymentId,
      });
    }
    return [...byPerson.values()].filter((p) => p.employments.length >= 2);
  });
}

/** The current principal's payslips (RLS already restricts to own employment). */
export function myPayslips(ctx: SessionContext, employmentIds: string[]) {
  return withTenant(ctx, async (tx) => {
    if (employmentIds.length === 0) return [];
    return tx
      .select({
        id: payslip.id,
        company: company.legalName,
        payPeriod: payrollBatch.payPeriod,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
        status: payrollBatch.status,
        gross: payslip.grossPay,
        deductions: payslip.totalDeductions,
        net: payslip.netPay,
        statutory: payslip.statutory,
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(inArray(payslip.employmentId, employmentIds))
      .orderBy(desc(payrollBatch.payPeriod), payrollBatch.runSeq);
  });
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
        workedMinutes: attendance.workedMinutes,
        otMinutes: attendance.otMinutes,
      })
      .from(attendance)
      .where(eq(attendance.employmentId, employmentId))
      .orderBy(desc(attendance.attendanceDate))
      .limit(limit),
  );
}

/** Companies this principal may scope to (top-bar company context): group admin → all; otherwise
 *  the companies they're employed at + the companies of their company-scoped grants. */
export function allowedCompanies(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    const isGroupAdmin =
      ctx.grants?.some((g) => (g.role === 'hr_admin' || g.role === 'super_admin') && !g.companyId) ??
      false;
    if (isGroupAdmin) {
      return tx
        .select({ id: company.id, name: company.legalName })
        .from(company)
        .orderBy(company.legalName);
    }
    const ids = new Set((ctx.grants ?? []).map((g) => g.companyId).filter((c): c is string => !!c));
    if (ctx.personId) {
      const emps = await tx
        .select({ c: employment.companyId })
        .from(employment)
        .where(and(eq(employment.personId, ctx.personId), isNull(employment.terminatedOn)));
      emps.forEach((e) => ids.add(e.c));
    }
    if (ids.size === 0) return [];
    return tx
      .select({ id: company.id, name: company.legalName })
      .from(company)
      .where(inArray(company.id, [...ids]))
      .orderBy(company.legalName);
  });
}

/**
 * Companies the current actor can ADMINISTER — self + subtree, via app.is_admin_for (distinct from
 * allowedCompanies, which also includes companies the user merely works at). Drives the company
 * picker when a delegated admin assigns a scoped role. Group admins get every company.
 */
export function adminCompanies(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx
      .select({ id: company.id, name: company.legalName })
      .from(company)
      .where(sql`app.is_admin_for(company.id)`)
      .orderBy(company.legalName),
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
