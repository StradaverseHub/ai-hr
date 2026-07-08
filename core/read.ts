/** Read queries for the UI. Each runs via withTenant, so RLS scopes every result. */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql, type AnyColumn } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { withTenant, type SessionContext } from '../db/client';
import {
  AGED_FORFEIT_REASON,
  POLICY_RECALC_REASON_PREFIX,
  earnedCycleStart,
  isEarnedMethod,
  isLeaveEligible,
  resolveCarryBreakdown,
  resolveGradePolicy,
  serviceYearsAt,
  workingDatesForSpan,
  type GradePolicyRow,
  type LeaveEligibility,
} from './leave';
import {
  appUser,
  assignment,
  attendance,
  attendanceAllowancePolicy,
  clockingLocation,
  company,
  compensation,
  department,
  domainEvent,
  employeeStatutoryMy,
  employment,
  employmentTypeEnum,
  holiday,
  holidayGroup,
  jobGrade,
  leaveCancellationRequest,
  leaveLedger,
  leavePolicy,
  leaveRequest,
  leaveRequestDate,
  leaveType,
  location,
  payComponent,
  payrollBatch,
  payrollPolicy,
  payslip,
  person,
  position,
  reportingLine,
  toilAccrual,
} from '../db/schema';
import { daysInMonth } from './payroll';
import { evaluateAllowancesForPeriod } from './attendance-allowance';

// Unpaginated — returns the whole employee set (transfer-target dropdowns, the payroll batch picker,
// etc.). Do NOT swap in the paginated `listEmployeesPage`: the payroll picker needs every active
// employee, not a page, or the checkbox set would silently drop people past the page boundary.
export function listEmployees(ctx: SessionContext, companyIds?: string[]) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        email: person.primaryEmail,
        employeeCode: employment.employeeCode,
        status: assignment.status,
        department: department.name,
        // Current-assignment department id — the Individual Transaction wizard uses it (client-side) to
        // filter Step-2 batches whose scope names departments the employee belongs to (a UX filter; the
        // bulk service re-checks scope membership authoritatively). Nullable, like department.
        departmentId: assignment.departmentId,
        // Position title of the current assignment — used by the Individual Transaction wizard's Step-1
        // employee card (Employee ID / Name / Department / Position). Nullable, like department.
        position: position.title,
        company: company.legalName,
        companyId: employment.companyId,
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
      .leftJoin(position, eq(position.id, assignment.positionId))
      .where(companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined)
      .orderBy(person.fullName),
  );
}

export type EmployeeListRow = {
  employmentId: string;
  name: string;
  email: string;
  employeeCode: string | null;
  status: string | null;
  department: string | null;
  departmentId: string | null;
  position: string | null;
  company: string;
  companyId: string;
  hiredOn: string;
  terminatedOn: string | null;
};

/** Paginated + searchable employee list for the People page. Returns the page rows plus the
 *  total match count (for the pager). Search matches name or email (case-insensitive). The
 *  unpaginated `listEmployees` stays for callers that genuinely need the whole set (transfer
 *  target dropdowns, exports). */
export function listEmployeesPage(
  ctx: SessionContext,
  p: {
    companyIds?: string[];
    q?: string;
    // #18 structured filters (each optional; combine with AND). status: 'active' = not terminated.
    companyId?: string;
    departmentId?: string;
    status?: 'active' | 'terminated';
    employmentType?: string;
    limit: number;
    offset: number;
  },
): Promise<{ rows: EmployeeListRow[]; total: number }> {
  return withTenant(ctx, async (tx) => {
    const q = p.q?.trim();
    // The current-assignment join (≤1 row per employment) — shared by the rows + count queries so the
    // department filter applies consistently to both.
    const currentAssignment = and(
      eq(assignment.employmentId, employment.id),
      isNull(assignment.validTo),
      isNull(assignment.supersededAt),
    );
    const where = and(
      p.companyIds && p.companyIds.length ? inArray(employment.companyId, p.companyIds) : undefined,
      p.companyId ? eq(employment.companyId, p.companyId) : undefined,
      p.departmentId ? eq(assignment.departmentId, p.departmentId) : undefined,
      p.status === 'terminated'
        ? isNotNull(employment.terminatedOn)
        : p.status === 'active'
          ? isNull(employment.terminatedOn)
          : undefined,
      p.employmentType ? eq(assignment.employmentType, p.employmentType as (typeof employmentTypeEnum.enumValues)[number]) : undefined,
      q
        ? sql`(${person.fullName} ilike ${'%' + q + '%'} or ${person.primaryEmail} ilike ${'%' + q + '%'} or ${employment.employeeCode} ilike ${'%' + q + '%'})`
        : undefined,
    );
    const rows = (await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        email: person.primaryEmail,
        employeeCode: employment.employeeCode,
        status: assignment.status,
        department: department.name,
        departmentId: assignment.departmentId,
        position: position.title,
        company: company.legalName,
        companyId: employment.companyId,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(assignment, currentAssignment)
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .leftJoin(position, eq(position.id, assignment.positionId))
      .where(where)
      .orderBy(person.fullName)
      .limit(p.limit)
      .offset(p.offset)) as EmployeeListRow[];
    // count(distinct employment.id): the assignment join is ≤1/employment, but distinct is the safe guard.
    const [{ count }] = await tx
      .select({ count: sql<number>`count(distinct ${employment.id})::int` })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(assignment, currentAssignment)
      .where(where);
    return { rows, total: Number(count) };
  });
}

/**
 * Hiring enhancement — flat picker of active (non-terminated) employments the new hire can report to.
 * Scoped to the session's allowed companies (reuse the `companyIds` filter from listEmployeesPage); no
 * extra company-subtree narrowing. Cross-company managers stay selectable on purpose — the reporting_line
 * schema permits manager & subordinate to differ in company. RLS already fences this to the tenant.
 */
export type ManagerCandidate = { employmentId: string; name: string; employeeCode: string | null };

export function listManagerCandidates(
  ctx: SessionContext,
  opts: { companyIds?: string[] } = {},
): Promise<ManagerCandidate[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        employeeCode: employment.employeeCode,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          isNull(employment.terminatedOn),
          opts.companyIds && opts.companyIds.length
            ? inArray(employment.companyId, opts.companyIds)
            : undefined,
        ),
      )
      .orderBy(person.fullName),
  );
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
        leaveCycle: company.leaveCycle,
        leaveHalfDayFullDeduction: company.leaveHalfDayFullDeduction,
        archivedAt: company.archivedAt,
        inUse: sql<boolean>`exists (select 1 from department d where d.company_id = company.id) or exists (select 1 from employment e where e.company_id = company.id) or exists (select 1 from company c where c.parent_company_id = company.id)`,
        // hasLogo: EXISTS against the company_logo side table (NEVER the bytes — the blob is a different
        // table, so this can only ever pull a boolean). Non-breaking, name-based add for existing callers.
        hasLogo: sql<boolean>`exists (select 1 from company_logo cl where cl.company_id = company.id)`,
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
        // Business Unit link (ADR-0068) — feeds the cascading hire-form department filter + the org admin
        // BU dropdown. Null = unassigned (visible under every BU on the hire form).
        businessUnitId: department.businessUnitId,
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

export type PayrollRunEmployeeRow = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  companyId: string;
  /** Company legal name — carried so the multi-company Step-2 list can show a Company column when the run
   *  spans more than one company (single-company runs simply don't render the column). */
  company: string;
  departmentId: string | null;
  businessUnitId: string | null;
  positionId: string | null;
  gradeId: string | null;
  costCenterId: string | null;
  employmentType: string | null;
  status: string | null;
  hiredOn: string;
  terminatedOn: string | null;
  /** True when the employment has a current (validTo/supersededAt null) compensation row — a comp-less
   *  hire is silently dropped by generatePayslips' inner join, so the wizard warns before that happens. */
  hasCurrentCompensation: boolean;
};

/**
 * Payroll Process wizard (Step 2 population, plan §2) — the employee set for a company + 'YYYY-MM' pay
 * period, using generatePayslips' OWN period predicate (hired on/before period end AND not terminated
 * before period start) — NOT current-roster semantics — so this preview always equals what generation
 * would pick up. A mid-period leaver appears by default; assignment.status is NOT part of generation's
 * predicate, so a status filter narrowing this list is a visible user choice, not a silent drop. Read-only
 * — no DomainEvent (derived recomputation, substrate's documented skip).
 */
export function listEmployeesForPayrollRun(
  ctx: SessionContext,
  companyIds: string | string[],
  payPeriod: string,
): Promise<PayrollRunEmployeeRow[]> {
  // Multi-company (feedback 3653d14b): the wizard now scopes a run across one, several, or all of the
  // admin's companies. Accept a single id (legacy callers) or an array; an empty array short-circuits to
  // no rows. Each company id is still RLS-scoped by withTenant — this widens the preview, never the grant.
  const ids = Array.isArray(companyIds) ? companyIds : [companyIds];
  return withTenant(ctx, async (tx) => {
    if (ids.length === 0) return [];
    const [year, month1] = payPeriod.split('-').map(Number);
    const periodStart = `${payPeriod}-01`;
    const periodEnd = `${payPeriod}-${String(daysInMonth(year, month1)).padStart(2, '0')}`;
    const currentAssignment = and(
      eq(assignment.employmentId, employment.id),
      isNull(assignment.validTo),
      isNull(assignment.supersededAt),
    );
    const currentComp = and(
      eq(compensation.employmentId, employment.id),
      isNull(compensation.validTo),
      isNull(compensation.supersededAt),
    );
    const rows = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        employeeCode: employment.employeeCode,
        companyId: employment.companyId,
        company: company.legalName,
        departmentId: assignment.departmentId,
        businessUnitId: department.businessUnitId,
        positionId: assignment.positionId,
        gradeId: employment.gradeId,
        costCenterId: assignment.costCenterId,
        employmentType: assignment.employmentType,
        status: assignment.status,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
        hasCurrentCompensation: sql<boolean>`${compensation.id} is not null`,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(assignment, currentAssignment)
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .leftJoin(compensation, currentComp)
      .where(
        and(
          inArray(employment.companyId, ids),
          lte(employment.hiredOn, periodEnd),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart)),
        ),
      )
      .orderBy(company.legalName, person.fullName);
    return rows as PayrollRunEmployeeRow[];
  });
}

export function listLeaveTypes(
  ctx: SessionContext,
  opts: { includeArchived?: boolean; locale?: string } = {},
) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: leaveType.id,
        code: leaveType.code,
        name: leaveType.name,
        i18n: leaveType.i18n,
        paid: leaveType.paid,
        counting: leaveType.counting,
        requiresDocument: leaveType.requiresDocument,
        // Supporting-document config — feeds the admin panel and the /me form's static hints + pre-check.
        mandatoryAfterDays: leaveType.mandatoryAfterDays,
        allowedMimeTypes: leaveType.allowedMimeTypes,
        maxDocBytes: leaveType.maxDocBytes,
        employeeRemarkRequired: leaveType.employeeRemarkRequired,
        hrRemarkRequired: leaveType.hrRemarkRequired,
        // Unpaid payroll-impact: gates the on-approval payroll signal — feeds the admin "Payroll impact" sub-form.
        sendToPayroll: leaveType.sendToPayroll,
        // Configurable backdated-leave restriction (0133): feeds the admin panel's "Backdating limit (days)"
        // input (MUST be projected here or the input renders empty on every reload — "my setting didn't save").
        backdatingLimitDays: leaveType.backdatingLimitDays,
        // Minimum advance-notice rule (0159): feeds the admin panel's "Minimum advance days" input (same
        // MUST-be-projected reason as backdatingLimitDays above).
        minAdvanceDays: leaveType.minAdvanceDays,
        // Leave Type Expiry Field (fec49317): the age-from-earning expiry pair — feeds the admin panel's
        // "Leave expiry" sub-form (MUST be projected or the inputs render empty on every reload).
        expiryValue: leaveType.expiryValue,
        expiryUnit: leaveType.expiryUnit,
        // Partial Leave Approval (ADR-0068): feeds the admin panel's per-date toggle (MUST be projected or the
        // checkbox renders unchecked on every reload). counting is already selected above — the panel needs it
        // to grey out the toggle for calendar-counted types where the feature can never fire.
        perDateApproval: leaveType.perDateApproval,
        // Custom validation messages (custom-messages migration): feeds the admin panel's "Custom system
        // message" textarea (MUST be projected or the textarea renders empty on every reload).
        customMessages: leaveType.customMessages,
        eligibility: leaveType.eligibility,
        durations: leaveType.durations,
        archivedAt: leaveType.archivedAt,
        inUse: sql<boolean>`exists (select 1 from leave_request lr where lr.leave_type_id = leave_type.id) or exists (select 1 from leave_ledger ll where ll.leave_type_id = leave_type.id) or exists (select 1 from leave_policy lp where lp.leave_type_id = leave_type.id)`,
      })
      .from(leaveType)
      .where(opts.includeArchived ? undefined : isNull(leaveType.archivedAt));
    // R37: localize the display name to the viewer's locale. Admin callers pass no locale, so the
    // config screens keep the default English name (which is what gets edited).
    return rows.map(({ i18n, ...r }) => ({ ...r, name: pickName(r.name, i18n, opts.locale) }));
  });
}

/**
 * The leave types ONE employee may actually take — `listLeaveTypes` filtered through the eligibility
 * gate (#25 visibility). This is the apply-dropdown source on /me so an employee never sees a type they
 * can't request (e.g. a male sees no Maternity). It filters the SAME projection as `listLeaveTypes`, so
 * `requiresDocument` / `id` / localized `name` are preserved.
 *
 * Defense-in-depth only: `requestLeave` still enforces `assertEligible` server-side and remains the
 * authority. Strict equality means an employee whose gated attribute is undisclosed/NULL is excluded —
 * the lawful conservative default (don't grant a restricted entitlement to someone whose attribute is
 * unknown). Mirrors the leaveBalances no-activity tail (read.ts) and the requestLeave gate (leave.ts).
 */
export function listEligibleLeaveTypesFor(ctx: SessionContext, employmentId: string, locale?: string) {
  return withTenant(ctx, async (tx) => {
    const [types, [emp]] = await Promise.all([
      tx
        .select({
          id: leaveType.id,
          code: leaveType.code,
          name: leaveType.name,
          i18n: leaveType.i18n,
          paid: leaveType.paid,
          counting: leaveType.counting,
          requiresDocument: leaveType.requiresDocument,
          // Supporting-document config — the /me form's accept hint + the action's pre-check rule.
          mandatoryAfterDays: leaveType.mandatoryAfterDays,
          allowedMimeTypes: leaveType.allowedMimeTypes,
          maxDocBytes: leaveType.maxDocBytes,
          employeeRemarkRequired: leaveType.employeeRemarkRequired,
          // Configurable backdated-leave restriction (0133): projected so the panel projection (which feeds
          // off this select too) carries the value — same reason as listLeaveTypes above.
          backdatingLimitDays: leaveType.backdatingLimitDays,
          // Minimum advance-notice rule (0159): projected alongside backdatingLimitDays for the same reason.
          minAdvanceDays: leaveType.minAdvanceDays,
          eligibility: leaveType.eligibility,
          durations: leaveType.durations,
          archivedAt: leaveType.archivedAt,
        })
        .from(leaveType)
        .where(isNull(leaveType.archivedAt)),
      tx
        .select({ gender: person.gender, marital: person.maritalStatus, hiredOn: employment.hiredOn })
        .from(employment)
        .innerJoin(person, eq(person.id, employment.personId))
        .where(eq(employment.id, employmentId))
        .limit(1),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    return types
      .filter((t) => isLeaveEligible(t.eligibility as LeaveEligibility | null, emp, today))
      .map(({ i18n, eligibility, ...r }) => ({ ...r, name: pickName(r.name, i18n, locale) }));
  });
}

/** Every leave request in scope (RLS additionally trims to what the viewer may see:
 *  admins everything, managers their reports, employees themselves). Recent first. */
export function listLeaveRequests(ctx: SessionContext, companyIds?: string[], limit = 200) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: leaveRequest.id,
        employmentId: leaveRequest.employmentId,
        personId: employment.personId,
        employee: person.fullName,
        employeeCode: employment.employeeCode,
        leaveType: leaveType.name,
        typeCode: leaveType.code,
        appliedOn: leaveRequest.createdAt,
        startDate: leaveRequest.startDate,
        endDate: leaveRequest.endDate,
        days: leaveRequest.days,
        durationType: leaveRequest.durationType,
        hours: leaveRequest.hours,
        // Hourly-leave time window (0129): surfaced on the admin/leave history table AND the approvals inbox
        // (app/approvals/page.tsx) so the approver sees the actual window (09:00–11:00), not a bare days
        // figure. NULL for full_day / half_day rows.
        fromTime: leaveRequest.fromTime,
        toTime: leaveRequest.toTime,
        status: leaveRequest.status,
        // Emergency Leave (0106): the shared id linking an EL submission's ANNUAL + UNPAID children, so a
        // surface can group them as one logical absence. NULL for ordinary requests.
        parentGroupId: leaveRequest.parentGroupId,
        // Phase-B #13 (ADR-0062): the EA s.37 maternity paid-allowance decision, so the approver sees whether
        // the paid ALLOWANCE was withheld (and why). allowanceEligible is the per-request override
        // (TRUE=paid, FALSE=withheld/unpaid, NULL=not a maternity decision or inputs unconfirmed); the reason
        // is read off the submitted-event payload (qualifying_service | fifth_child | null).
        allowanceEligible: leaveRequest.allowanceEligible,
        survivingChildren: leaveRequest.survivingChildren,
        confinementDate: leaveRequest.confinementDate,
        maternityReason: sql<string | null>`(select (e.payload #>> '{maternityAllowance,reason}') from domain_event e where e.aggregate_id = leave_request.id and e.event_type = 'leave-request.submitted' order by e.sequence desc limit 1)`,
        hasDocument: sql<boolean>`exists (select 1 from leave_request_attachment lra where lra.leave_request_id = leave_request.id)`,
        currentStepKind: sql<string | null>`(select approver_kind from leave_approval_step s where s.leave_request_id = leave_request.id and s.status = 'pending' order by s.step_index limit 1)`,
        currentStepIndex: sql<number | null>`(select step_index from leave_approval_step s where s.leave_request_id = leave_request.id and s.status = 'pending' order by s.step_index limit 1)`,
        stepCount: sql<number>`(select count(*)::int from leave_approval_step s where s.leave_request_id = leave_request.id)`,
        // R23 (2F-3): the applicant's current balance for THIS leave type — the key context an approver
        // needs ("do they have the days?"). Ledger sum (accrual + − debit −).
        applicantBalance: sql<string>`coalesce((select sum(ll.days) from leave_ledger ll where ll.employment_id = leave_request.employment_id and ll.leave_type_id = leave_request.leave_type_id), 0)`,
        // Partial Leave Cancellation (ADR-0065): the pending cancellation request (if any) on this row, so the
        // UI can show a "cancellation pending" pill and suppress a second cancel affordance. NULL when none.
        pendingCancellationId: sql<string | null>`(select id from leave_cancellation_request c where c.leave_request_id = leave_request.id and c.status = 'pending' order by c.created_at desc limit 1)`,
        pendingCancelDates: sql<string[] | null>`(select cancel_dates from leave_cancellation_request c where c.leave_request_id = leave_request.id and c.status = 'pending' order by c.created_at desc limit 1)`,
        // R5 Build #2 (iterative cancellation): TRUE when this row is a SURVIVOR of a prior cancellation split —
        // it carries a parent_group_id AND a sibling in the same group is 'cancelled'. Such a survivor is still
        // cancellable (the employee can give back more days), so the Leave page shows the "Cancel dates" button
        // for it too; a genuine EL / per-date child (parent group with NO 'cancelled' sibling) never matches.
        isCancellationSplit: sql<boolean>`(leave_request.parent_group_id is not null and exists (select 1 from leave_request s where s.parent_group_id = leave_request.parent_group_id and s.status = 'cancelled'))`,
      })
      .from(leaveRequest)
      .innerJoin(employment, eq(employment.id, leaveRequest.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
      .where(
        companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined,
      )
      .orderBy(desc(leaveRequest.createdAt))
      .limit(limit);

    // R5 Build #2 (Fix C — holiday/working-day-aware cancellable list): resolve each ELIGIBLE row's REAL
    // working dates (roster + public-holiday aware, the SAME frame requestLeaveCancellation validates against)
    // so the Leave page offers exactly the cancellable candidates — not a Mon–Fri heuristic that would offer a
    // holiday the service rejects or hide a working Saturday. Only resolved for approved full-day rows that are
    // either a plain request (parentGroupId null) or a cancellation-split survivor; others get [].
    const withDates = await Promise.all(
      rows.map(async (r) => {
        const eligibleShape =
          r.status === 'approved' &&
          r.durationType === 'full_day' &&
          (r.parentGroupId == null || r.isCancellationSplit);
        const workingDates = eligibleShape
          ? await workingDatesForSpan(tx, r.employmentId, r.startDate, r.endDate)
          : [];
        return { ...r, workingDates };
      }),
    );
    return withDates;
  });
}

/** ADR-0068 §5 — the per-date breakdown of ONE per-date-approval request, for the approvals detail view.
 *  Returns ordered leave_request_date rows (date, days, status, reject_reason, decider name/at). RLS scopes
 *  via subject_employment_id (the leave_request_date policy), so a manager who can see the parent sees its
 *  dates and a non-manager sees nothing. An empty result means "no per-date breakdown" (the UI then shows the
 *  ordinary whole-request approve/reject) — no separate boolean on the inbox list is needed. */
export function leaveRequestDateBreakdown(ctx: SessionContext, leaveRequestId: string) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: leaveRequestDate.id,
        leaveDate: leaveRequestDate.leaveDate,
        days: leaveRequestDate.days,
        status: leaveRequestDate.status,
        rejectReason: leaveRequestDate.rejectReason,
        decidedAt: leaveRequestDate.decidedAt,
        decidedBy: person.fullName,
      })
      .from(leaveRequestDate)
      .leftJoin(employment, eq(employment.id, leaveRequestDate.decidedByEmploymentId))
      .leftJoin(person, eq(person.id, employment.personId))
      .where(eq(leaveRequestDate.leaveRequestId, leaveRequestId))
      .orderBy(leaveRequestDate.leaveDate),
  );
}

/** Partial Leave Cancellation (ADR-0065): pending cancellation requests for the approvals inbox. Each card
 *  shows the original leave dates, the date(s) being given back, the remaining dates, days, and reason. RLS
 *  already scopes visibility (subject + manager + admin via can_see_employment); we additionally narrow to
 *  the company scope the inbox is viewing. The decide authorization (manager/admin, no self-approval) lives
 *  in decideLeaveCancellation. */
export function listPendingLeaveCancellations(ctx: SessionContext, companyIds?: string[], locale?: string) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: leaveCancellationRequest.id,
        leaveRequestId: leaveCancellationRequest.leaveRequestId,
        employmentId: leaveCancellationRequest.employmentId,
        personId: employment.personId,
        employee: person.fullName,
        employeeCode: employment.employeeCode,
        leaveType: leaveType.name,
        i18n: leaveType.i18n,
        typeCode: leaveType.code,
        originalStart: leaveRequest.startDate,
        originalEnd: leaveRequest.endDate,
        cancelDates: leaveCancellationRequest.cancelDates,
        requestedDays: leaveCancellationRequest.requestedDays,
        reason: leaveCancellationRequest.reason,
        createdAt: leaveCancellationRequest.createdAt,
      })
      .from(leaveCancellationRequest)
      .innerJoin(leaveRequest, eq(leaveRequest.id, leaveCancellationRequest.leaveRequestId))
      .innerJoin(employment, eq(employment.id, leaveCancellationRequest.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
      .where(
        and(
          eq(leaveCancellationRequest.status, 'pending'),
          companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined,
        ),
      )
      .orderBy(desc(leaveCancellationRequest.createdAt));
    return rows.map(({ i18n, cancelDates, ...r }) => {
      const cancel = (cancelDates as string[]) ?? [];
      const cancelSet = new Set(cancel);
      // The original full date span (every calendar day inclusive); remaining = original minus cancelled.
      const allDays: string[] = [];
      for (
        let t = Date.parse(`${r.originalStart}T00:00:00Z`);
        t <= Date.parse(`${r.originalEnd}T00:00:00Z`);
        t += 86_400_000
      ) {
        allDays.push(new Date(t).toISOString().slice(0, 10));
      }
      return {
        ...r,
        leaveType: pickName(r.leaveType, i18n, locale),
        cancelDates: cancel,
        remainingDates: allDays.filter((d) => !cancelSet.has(d)),
      };
    });
  });
}

/** Planned-absences timeline: every active employee in scope, each with their approved +
 *  pending leave overlapping the [from, to] window. Powers the dashboard hero.
 *
 *  Partial Leave Cancellation from the calendar (ADR-0065): pass `today` (tenant-local MYT, from the caller —
 *  keeps this a pure read) to seed each approved row's cancellable candidate dates (real working dates strictly
 *  after today), so the dashboard can offer the SAME "Cancel dates" affordance the Leave page does. Omitting
 *  `today` yields no candidate dates (candidateCancelDates=[]) — the affordance simply never renders. */
export function plannedAbsences(
  ctx: SessionContext,
  companyIds: string[] | undefined,
  range: { from: string; to: string },
  today?: string,
) {
  return withTenant(ctx, async (tx) => {
    const emps = await tx
      .select({
        personId: employment.personId,
        employmentId: employment.id,
        name: person.fullName,
        employeeCode: employment.employeeCode, // Employee ID left-of-name (feedback 38668d9b)
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
        days: leaveRequest.days,
        durationType: leaveRequest.durationType,
        hours: leaveRequest.hours,
        // Emergency Leave (0106): the shared id linking an EL submission's children. NULL for ordinary rows.
        parentGroupId: leaveRequest.parentGroupId,
        // Partial Leave Cancellation from the calendar (ADR-0065): the same eligibility fields listLeaveRequests
        // surfaces, so the dashboard calendar can gate a "Cancel dates" affordance identically to the Leave page.
        // These are FRESH, independent lookups modelled on listLeaveRequests (read.ts:460-469) — deliberately NOT
        // folded into the ADR-0068 per-date-approval leaveRequestDate expansion below (that join is a different
        // feature). pendingCancellationId: an open give-back request already on this row (suppress a 2nd click).
        pendingCancellationId: sql<string | null>`(select id from leave_cancellation_request c where c.leave_request_id = leave_request.id and c.status = 'pending' order by c.created_at desc limit 1)`,
        // isCancellationSplit: TRUE when this row is a SURVIVOR of a prior cancellation split (carries a
        // parent_group_id AND a sibling in the group is 'cancelled') — still cancellable; a genuine EL / per-date
        // child (parent group with NO 'cancelled' sibling) never matches.
        isCancellationSplit: sql<boolean>`(leave_request.parent_group_id is not null and exists (select 1 from leave_request s where s.parent_group_id = leave_request.parent_group_id and s.status = 'cancelled'))`,
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

    type Leave = (typeof leaves)[number] & { candidateCancelDates: string[] };

    // ADR-0068 §4A: a per-date-approval request is now a single row whose interior dates may be rejected.
    // For APPROVED such requests, render ONLY the approved dates (as contiguous segments), not the raw span —
    // otherwise a mid-span rejected date would still show on the calendar as an absence. Pending requests keep
    // the whole span (no per-date decision has been made yet). Fetch the per-date rows for the visible leaves.
    const leaveIds = leaves.map((l) => l.id);
    const dateRows = leaveIds.length
      ? await tx
          .select({
            leaveRequestId: leaveRequestDate.leaveRequestId,
            leaveDate: leaveRequestDate.leaveDate,
            status: leaveRequestDate.status,
          })
          .from(leaveRequestDate)
          .where(inArray(leaveRequestDate.leaveRequestId, leaveIds))
      : [];
    const approvedDatesByReq = new Map<string, string[]>();
    const hasDateRows = new Set<string>();
    for (const dr of dateRows) {
      hasDateRows.add(dr.leaveRequestId);
      if (dr.status === 'approved') {
        const arr = approvedDatesByReq.get(dr.leaveRequestId);
        if (arr) arr.push(dr.leaveDate);
        else approvedDatesByReq.set(dr.leaveRequestId, [dr.leaveDate]);
      }
    }

    // Partial Leave Cancellation from the calendar (ADR-0065): each approved row carries the exact cancellable
    // candidate dates — its REAL working dates (roster + holiday aware, resolved via the SAME workingDatesForSpan
    // the service validates against) strictly after `today` (MYT), AND — for a per-date-approval request — only
    // the interior dates that were actually APPROVED (mirrors requestLeaveCancellation core/leave.ts:2115-2118,
    // so an interior-REJECTED date never looks cancellable on the calendar but is rejected on submit). Computed
    // ONCE per underlying leaveRequest.id off the ORIGINAL [startDate, endDate] (BEFORE the per-date expansion
    // rewrites start/end per run), so every expanded pill from one request is seeded with the identical list —
    // the CancelDatesDialog keys off leaveRequest.id, not the run. Eligible shape mirrors listLeaveRequests:
    // approved + full_day + (plain request OR cancellation-split survivor) + no pending cancellation. Others
    // (and, when `today` is omitted, all rows) get []. The service still re-validates every posted date.
    const candidateByReq = new Map<string, string[]>();
    if (today) {
      await Promise.all(
        leaves.map(async (l) => {
          if (candidateByReq.has(l.id)) return; // one leaveRequest.id ⇒ one lookup
          const eligibleShape =
            l.status === 'approved' &&
            l.durationType === 'full_day' &&
            (l.parentGroupId == null || l.isCancellationSplit) &&
            !l.pendingCancellationId;
          if (!eligibleShape) {
            candidateByReq.set(l.id, []);
            return;
          }
          let working = await workingDatesForSpan(tx, l.employmentId, l.startDate, l.endDate);
          // Per-date-approval request (has date rows): restrict to the APPROVED interior dates only.
          if (hasDateRows.has(l.id)) {
            const approvedSet = new Set(approvedDatesByReq.get(l.id) ?? []);
            working = working.filter((d) => approvedSet.has(d));
          }
          candidateByReq.set(
            l.id,
            working.filter((d) => d > today),
          );
        }),
      );
    }
    const candidatesFor = (id: string): string[] => candidateByReq.get(id) ?? [];

    // Split an ordered list of ISO dates into maximal contiguous (calendar-adjacent) runs.
    const contiguousRuns = (dates: string[]): { from: string; to: string }[] => {
      const sorted = [...dates].sort();
      const runs: { from: string; to: string }[] = [];
      const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      for (const d of sorted) {
        const last = runs[runs.length - 1];
        if (last && nextDay(last.to) === d) last.to = d;
        else runs.push({ from: d, to: d });
      }
      return runs;
    };
    const expandedLeaves: Leave[] = [];
    for (const l of leaves) {
      const candidateCancelDates = candidatesFor(l.id);
      // A per-date request that is APPROVED with per-date rows → emit one leave per contiguous approved run.
      if (hasDateRows.has(l.id) && l.status === 'approved') {
        const runs = contiguousRuns(approvedDatesByReq.get(l.id) ?? []);
        for (const r of runs) {
          expandedLeaves.push({ ...l, startDate: r.from, endDate: r.to, candidateCancelDates });
        }
        continue;
      }
      // Otherwise (pending, or no per-date rows) render the whole span unchanged.
      expandedLeaves.push({ ...l, candidateCancelDates });
    }

    const byEmp = new Map<string, Leave[]>();
    for (const l of expandedLeaves) {
      const arr = byEmp.get(l.employmentId);
      if (arr) arr.push(l);
      else byEmp.set(l.employmentId, [l]);
    }
    // One row per person — concurrent employments merge their leave onto a single row.
    const byPerson = new Map<string, { id: string; name: string; employeeCode: string | null; role: string | null; leaves: Leave[] }>();
    for (const e of emps) {
      const empLeaves = byEmp.get(e.employmentId) ?? [];
      const existing = byPerson.get(e.personId);
      if (existing) {
        existing.leaves.push(...empLeaves);
        if (!existing.role && e.role) existing.role = e.role;
        // First non-null Employee ID wins for a person spanning concurrent employments (feedback 38668d9b).
        if (!existing.employeeCode && e.employeeCode) existing.employeeCode = e.employeeCode;
      } else {
        byPerson.set(e.personId, { id: e.personId, name: e.name, employeeCode: e.employeeCode, role: e.role, leaves: empLeaves });
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
        companyId: employment.companyId,
        company: company.legalName,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
        workState: employment.workState,
        holidayGroupId: employment.holidayGroupId,
        holidayGroupName: holidayGroup.name,
        gradeId: employment.gradeId,
        gradeName: jobGrade.name,
        // #24 / Wave 2A-1: compliance-sensitive identity fields that drive leave eligibility
        // (gender gates maternity, marital gates paternity). HR-set via the approval-gated path.
        gender: person.gender,
        marital: person.maritalStatus,
        dateOfBirth: person.dateOfBirth,
        // b4682879 — Personnel Profile redesign: personal / contact / structured-address / emergency fields.
        firstName: person.firstName,
        lastName: person.lastName,
        preferredName: person.preferredName,
        religion: person.religion,
        race: person.race,
        nationality: person.nationality,
        personalEmail: person.personalEmail,
        addressLine1: person.addressLine1,
        addressLine2: person.addressLine2,
        addressLine3: person.addressLine3,
        postcode: person.postcode,
        city: person.city,
        state: person.state,
        country: person.country,
        emergencyContactName: person.emergencyContactName,
        emergencyContactRelationship: person.emergencyContactRelationship,
        emergencyContactPhone: person.emergencyContactPhone,
        emergencyContactPhone2: person.emergencyContactPhone2,
        emergencyContactAddress: person.emergencyContactAddress,
        // 2.1 Payroll Policy: the assigned named pay-processing template (null = monthly default).
        payrollPolicyId: employment.payrollPolicyId,
        payrollPolicyName: payrollPolicy.name,
        payrollPolicyStatus: payrollPolicy.status,
        // ec4cbf63: the employee's DEFAULT shift (null = company default schedule) — profile assignment.
        defaultShiftId: employment.defaultShiftId,
        // ADR-0054: the location on the employee's CURRENT open assignment (null = none).
        locationId: location.id,
        locationCode: location.code,
        locationName: location.name,
        // ADR-0070: per-employee Clocking Location & Geofencing enforcement toggle + radius.
        geofencingEnabled: employment.geofencingEnabled,
        geofenceRadiusM: employment.geofenceRadiusM,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(jobGrade, eq(jobGrade.id, employment.gradeId))
      .leftJoin(holidayGroup, eq(holidayGroup.id, employment.holidayGroupId))
      .leftJoin(payrollPolicy, eq(payrollPolicy.id, employment.payrollPolicyId))
      .leftJoin(
        assignment,
        and(
          eq(assignment.employmentId, employment.id),
          isNull(assignment.validTo),
          isNull(assignment.supersededAt),
        ),
      )
      .leftJoin(location, eq(location.id, assignment.locationId))
      .where(eq(employment.id, employmentId))
      .limit(1);
    return row ?? null;
  });
}

/** ADR-0041 2E: the tenant grade catalog, most-senior first (rank asc), then name. */
export function listJobGrades(ctx: SessionContext, opts: { includeArchived?: boolean } = {}) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: jobGrade.id,
        code: jobGrade.code,
        name: jobGrade.name,
        rank: jobGrade.rank,
        archivedAt: jobGrade.archivedAt,
        inUse: sql<boolean>`exists (select 1 from employment e where e.grade_id = job_grade.id) or exists (select 1 from leave_policy lp where lp.grade_id = job_grade.id)`,
      })
      .from(jobGrade)
      .where(opts.includeArchived ? undefined : isNull(jobGrade.archivedAt))
      .orderBy(jobGrade.rank, jobGrade.name),
  );
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

/** R37 (2F-2): resolve a leave-type name to the viewer's locale, falling back to the default name. */
type LeaveTypeI18n = Record<string, { name: string }> | null;
function pickName(name: string, i18n: LeaveTypeI18n, locale?: string): string {
  return (locale && locale !== 'en' && i18n?.[locale]?.name) || name;
}

export function leaveBalances(ctx: SessionContext, employmentId: string, locale?: string) {
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
      seen.add(p.leaveTypeId);
    }
    // 2F-1 (R18): surface every active leave type the employee is ELIGIBLE for — even with no activity
    // yet — so the list is the full menu, not just types they've already accrued or requested.
    const [types, [emp]] = await Promise.all([
      tx
        .select({ id: leaveType.id, name: leaveType.name, eligibility: leaveType.eligibility, i18n: leaveType.i18n })
        .from(leaveType)
        .where(isNull(leaveType.archivedAt)),
      tx
        .select({ gender: person.gender, marital: person.maritalStatus, hiredOn: employment.hiredOn })
        .from(employment)
        .innerJoin(person, eq(person.id, employment.personId))
        .where(eq(employment.id, employmentId))
        .limit(1),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    for (const lt of types) {
      if (seen.has(lt.id)) continue;
      if (!isLeaveEligible(lt.eligibility as LeaveEligibility | null, emp, today)) continue;
      out.push({ leaveTypeId: lt.id, leaveType: lt.name, accrued: 0, taken: 0, pending: 0, balance: 0, available: 0 });
    }
    // R37 (2F-2): resolve every leave-type name to the viewer's locale (active types come from `types`;
    // archived types with old ledger entries fall back to their stored English name).
    const localName = new Map(types.map((t) => [t.id, pickName(t.name, t.i18n, locale)]));
    for (const r of out) r.leaveType = localName.get(r.leaveTypeId) ?? r.leaveType;
    return out.sort((a, b) => a.leaveType.localeCompare(b.leaveType));
  });
}

// ── Leave entitlement breakdown (read-only ledger reconstruction) ──────────────────────────────────
/**
 * A read-only "how is this balance built up?" view over the existing flat leave_ledger for ONE
 * (employment, leave-type) as at a chosen date. It RECONSTRUCTS — never tags or mutates — the carry/
 * forfeit components the year-boundary crons already compute (ADR-0038 model: no new schema, no enum
 * value), so the figures here can never diverge from what openLeaveYear / expireCarriedLeave produce.
 *
 * Date semantics: every ledger read filters `effective_on <= asOf` (a CLOSED interval). A row dated
 * exactly ON `asOf` — including a forfeit adjustment posted on the carry-expiry date — is therefore
 * INCLUDED. Picking `asOf` on the expiry date shows the carry already swept (remaining 0, forfeit
 * realised). The view looks backwards accurately; it does NOT project a future, not-yet-opened year —
 * such a year simply shows zero fresh entitlement (its open run hasn't happened).
 *
 * RLS: runs under withTenant, so leave_ledger / leave_policy / leave_request / company are all scoped
 * by can_see_employment — a peer who cannot see the employment gets an empty/zero breakdown, never a leak.
 */
export type LeaveEntitlementBreakdown = {
  leaveTypeId: string;
  leaveType: string;
  asOf: string;
  /** Cycle/leave-year start used for the in-scope reconstruction (calendar or hire-anniversary). */
  cycleStart: string;
  /** Sum of accrual + in_lieu_accrual days effective within [cycleStart, asOf]. */
  currentYearEntitlement: number;
  /** Earned types only: the prorated-to-date accrual within the current cycle. Null for grant-on-open. */
  monthlyAccruedToDate: number | null;
  /** Balance carried into the current cycle, capped at the policy's carryForwardMax. */
  carriedForward: number;
  /** How much of `carriedForward` is still un-consumed in the window (the weaker, balance-based rule). */
  carryForwardRemaining: number;
  /** {cycleYear}-{expiry.month}-{expiry.day}, or null when carryMax = 0 / no expiry configured. */
  carryForwardExpiryDate: string | null;
  /** Days forfeited for the in-scope cycle (cap-excess at open + any realised expiry lapse) as at asOf. */
  forfeited: number;
  /** ADR-0066: net `adjustment` days within the current cycle that are NOT the boundary forfeit — i.e.
   *  festive / one-off grants (and any manual +/- adjustment). Surfaced as its own line so the displayed
   *  breakdown reconciles with `balance` (accrual aggregates exclude `adjustment`). 0 when none. */
  otherAdjustments: number;
  /** Ledger balance as at asOf minus pending requests (mirrors leaveBalances' `available`). */
  totalAvailable: number;
  /** Raw in-scope ledger rows so the UI can show the source of each component. */
  transactions: { effectiveOn: string; entryType: string; days: number; sourceRequestId: string | null }[];
};

export function leaveEntitlementBreakdown(
  ctx: SessionContext,
  employmentId: string,
  leaveTypeId: string,
  asOf: string,
  locale?: string,
): Promise<LeaveEntitlementBreakdown | null> {
  return withTenant(ctx, async (tx) => {
    // The type + the employment basics. RLS gates the employment row; a peer who can't see it gets null
    // here (employment join returns nothing) → a defined empty state, never an error or a leak.
    const [[type], [emp]] = await Promise.all([
      tx
        .select({ id: leaveType.id, name: leaveType.name, code: leaveType.code, i18n: leaveType.i18n })
        .from(leaveType)
        .where(eq(leaveType.id, leaveTypeId))
        .limit(1),
      tx
        .select({ hiredOn: employment.hiredOn, gradeId: employment.gradeId, companyId: employment.companyId, leaveCycle: company.leaveCycle })
        .from(employment)
        .innerJoin(company, eq(company.id, employment.companyId))
        .where(eq(employment.id, employmentId))
        .limit(1),
    ]);
    if (!type || !emp) return null;

    const cycleStart = earnedCycleStart(emp.hiredOn, asOf, emp.leaveCycle);

    // Active ANNUAL/standing policy versions for this type as at asOf, resolved to the employee's grade.
    const policies = await tx
      .select({ gradeId: leavePolicy.gradeId, companyId: leavePolicy.companyId, accrual: leavePolicy.accrual })
      .from(leavePolicy)
      .where(
        and(
          eq(leavePolicy.leaveTypeId, leaveTypeId),
          lte(leavePolicy.validFrom, asOf),
          // validTo is exclusive (an active version spans [validFrom, validTo)).
          sql`(${leavePolicy.validTo} is null or ${leavePolicy.validTo} > ${asOf})`,
        ),
      );
    // ADR-0066: resolve under the employee's company so /me + admin show the per-company entitlement.
    // Leave Entitlement Rules Engine: service measured at cycleStart keeps carryMax/expiry/earned-flag and
    // the tie-break consistent with the banded winner. This does NOT change currentYearEntitlement below
    // (ledger-derived) — the banded number reaches /me only via the ledger, after a hire grant/year-open.
    const policy = resolveGradePolicy(policies as GradePolicyRow[], emp.gradeId, emp.companyId, serviceYearsAt(emp.hiredOn, cycleStart));
    const earned = isEarnedMethod(policy?.method);
    const carryMax = type.code === 'ANNUAL' ? (policy?.carryMax ?? 0) : 0;
    const expiry = type.code === 'ANNUAL' ? (policy?.carryExpiry ?? null) : null;
    // R4 Build #1: the expiry date is clamped to the real last day of `expiry.month` in this cycle year
    // (months-mode day=31 sentinel, and any 29-Feb-in-a-common-year) inside the shared helper below —
    // computed once here (pre-aggregates, for the debit-window bound) via the same helper so the two
    // computations can never drift.
    const { carryForwardExpiryDate } = resolveCarryBreakdown({
      cycleStart,
      carryMax,
      expiry,
      priorBalanceAtCycleStart: 0,
      debitsInWindow: 0,
      currentBalance: 0,
      asOf,
    });

    // The aggregates, all bounded by `effective_on <= asOf` (closed interval). One round-trip.
    const num = (x: unknown) => Number(x ?? 0);
    const [[agg], [debitAgg], [pendRow], rows] = await Promise.all([
      tx
        .select({
          // Fresh entitlement granted within the current cycle (accruals + in-lieu top-ups).
          cycleAccrual: sql<string>`coalesce(sum(${leaveLedger.days}) filter (where ${leaveLedger.entryType} in ('accrual','in_lieu_accrual') and ${leaveLedger.effectiveOn} >= ${cycleStart}), 0)`,
          // ADR-0066: positive `adjustment` credits within the current cycle (festive / one-off grants). The
          // accrual aggregates above exclude `adjustment`, so these are surfaced separately to reconcile the
          // breakdown with `balance`. Negative adjustments (boundary forfeits) are accounted via `forfeited` —
          // EXCEPT the policy-correction recalc rows (feedback 49809272, reason `sys:policy_recalc:*`), which
          // are signed ± and belong here in BOTH directions so a downward correction still reconciles
          // (component sum = balance); the reason filter is additive — no other row carries that prefix.
          otherAdjustments: sql<string>`coalesce(sum(${leaveLedger.days}) filter (where ${leaveLedger.entryType} = 'adjustment' and (${leaveLedger.days} > 0 or ${leaveLedger.reason} like ${`${POLICY_RECALC_REASON_PREFIX}:%`}) and ${leaveLedger.effectiveOn} >= ${cycleStart}), 0)`,
          // Leave Type Expiry Field (fec49317): aged-expiry forfeits within the current cycle. These are a
          // NEW class of negative adjustment (reason = AGED_FORFEIT_REASON, non-ANNUAL types only) that
          // resolveCarryBreakdown below does NOT see (its carryMax is 0 for non-ANNUAL). Aggregated here as a
          // positive magnitude and folded into `forfeited` so the displayed breakdown still reconciles with
          // `balance` (component sum = balance) and expired days remain visible in reports. otherAdjustments
          // above is positive-only, so it never picks these up.
          agedForfeited: sql<string>`coalesce(-sum(${leaveLedger.days}) filter (where ${leaveLedger.entryType} = 'adjustment' and ${leaveLedger.reason} = ${AGED_FORFEIT_REASON} and ${leaveLedger.effectiveOn} >= ${cycleStart}), 0)`,
          // Signed balance as at asOf (the headline number this view explains).
          balance: sql<string>`coalesce(sum(${leaveLedger.days}), 0)`,
          // Signed balance strictly before the cycle start = what carried into the cycle.
          priorBalance: sql<string>`coalesce(sum(${leaveLedger.days}) filter (where ${leaveLedger.effectiveOn} < ${cycleStart}), 0)`,
        })
        .from(leaveLedger)
        .where(
          and(
            eq(leaveLedger.employmentId, employmentId),
            eq(leaveLedger.leaveTypeId, leaveTypeId),
            lte(leaveLedger.effectiveOn, asOf),
          ),
        ),
      // ANNUAL debits inside the carry window [cycleStart, min(expiry, asOf)] — they reduce un-consumed
      // carry (weaker rule: no ordering claim). When no expiry, the window runs to asOf.
      tx
        .select({ taken: sql<string>`coalesce(-sum(${leaveLedger.days}), 0)` })
        .from(leaveLedger)
        .where(
          and(
            eq(leaveLedger.employmentId, employmentId),
            eq(leaveLedger.leaveTypeId, leaveTypeId),
            eq(leaveLedger.entryType, 'debit'),
            gte(leaveLedger.effectiveOn, cycleStart),
            lte(
              leaveLedger.effectiveOn,
              carryForwardExpiryDate && carryForwardExpiryDate < asOf ? carryForwardExpiryDate : asOf,
            ),
          ),
        ),
      tx
        .select({ pending: sql<string>`coalesce(sum(${leaveRequest.days}), 0)` })
        .from(leaveRequest)
        .where(
          and(
            eq(leaveRequest.employmentId, employmentId),
            eq(leaveRequest.leaveTypeId, leaveTypeId),
            eq(leaveRequest.status, 'pending'),
          ),
        ),
      tx
        .select({
          effectiveOn: leaveLedger.effectiveOn,
          entryType: leaveLedger.entryType,
          days: leaveLedger.days,
          sourceRequestId: leaveLedger.sourceRequestId,
        })
        .from(leaveLedger)
        .where(
          and(
            eq(leaveLedger.employmentId, employmentId),
            eq(leaveLedger.leaveTypeId, leaveTypeId),
            gte(leaveLedger.effectiveOn, cycleStart),
            lte(leaveLedger.effectiveOn, asOf),
          ),
        )
        .orderBy(asc(leaveLedger.effectiveOn)),
    ]);

    const balance = num(agg?.balance);
    const priorBalance = num(agg?.priorBalance);
    const cycleAccrual = num(agg?.cycleAccrual);
    const debitsInWindow = num(debitAgg?.taken);
    // Delegates to the shared helper (core/leave.ts#resolveCarryBreakdown) so this view can never diverge
    // from carryForwardReport (core/analytics.ts) — byte-identical output to the pre-extraction inline
    // arithmetic (existing test suite is the regression gate).
    const { carried, unconsumedCarry: carryForwardRemaining, forfeited: carryForfeited } = resolveCarryBreakdown({
      cycleStart,
      carryMax,
      expiry,
      priorBalanceAtCycleStart: priorBalance,
      debitsInWindow,
      currentBalance: balance,
      asOf,
    });
    // Leave Type Expiry Field (fec49317): fold the aged-expiry lapse into the single `forfeited` figure. For
    // ANNUAL, agedForfeited is always 0 (the sweep excludes ANNUAL), so this is a no-op there and the carry
    // forfeit stands alone. For non-ANNUAL, carryForfeited is 0 (carryMax forced to 0 above) and this surfaces
    // the aged lapse — keeping `entitlement + carried + otherAdjustments − taken − forfeited = balance`.
    const forfeited = Math.round((carryForfeited + num(agg?.agedForfeited)) * 100) / 100;

    const i18n = type.i18n as Record<string, { name: string }> | null;
    return {
      leaveTypeId: type.id,
      leaveType: pickName(type.name, i18n, locale),
      asOf,
      cycleStart,
      currentYearEntitlement: cycleAccrual,
      monthlyAccruedToDate: earned ? cycleAccrual : null,
      carriedForward: carried,
      carryForwardRemaining,
      carryForwardExpiryDate,
      forfeited,
      otherAdjustments: num(agg?.otherAdjustments),
      totalAvailable: Math.round((balance - num(pendRow?.pending)) * 100) / 100,
      transactions: rows.map((r) => ({
        effectiveOn: r.effectiveOn,
        entryType: r.entryType,
        days: Number(r.days),
        sourceRequestId: r.sourceRequestId,
      })),
    };
  });
}

// RL Control Engine (0113): the active-vs-expired replacement-leave split, sourced from the toil_accrual
// register (which step-0 consumption makes authoritative). active = Σ(daysCredited − daysTaken) over active
// rows; taken = Σ daysTaken (the partial-consumption tally + the fully-taken rows); expired = lapsed;
// convertedToPay = converted_to_pay — each with worked/expiry dates for the admin panel.
export type ReplacementLeaveLedger = {
  active: number;
  taken: number;
  expired: number;
  convertedToPay: number;
  soonestExpiry: string | null;
  rows: {
    id: string;
    workedDate: string;
    expiresOn: string;
    daysCredited: number;
    daysTaken: number;
    status: 'active' | 'taken' | 'converted_to_pay' | 'lapsed';
    remaining: number;
  }[];
};

export function replacementLeaveLedger(ctx: SessionContext, employmentId: string): Promise<ReplacementLeaveLedger> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: toilAccrual.id,
        workedDate: toilAccrual.workedDate,
        expiresOn: toilAccrual.expiresOn,
        daysCredited: toilAccrual.daysCredited,
        daysTaken: toilAccrual.daysTaken,
        status: toilAccrual.status,
      })
      .from(toilAccrual)
      .where(eq(toilAccrual.employmentId, employmentId))
      .orderBy(asc(toilAccrual.expiresOn), asc(toilAccrual.workedDate));

    let active = 0;
    let taken = 0;
    let expired = 0;
    let convertedToPay = 0;
    let soonestExpiry: string | null = null;
    const out: ReplacementLeaveLedger['rows'] = [];
    for (const r of rows) {
      const credited = Number(r.daysCredited);
      const dTaken = Number(r.daysTaken);
      const remaining = Math.round((credited - dTaken) * 100) / 100;
      // taken accumulates the per-accrual consumed quantity regardless of status (active rows can carry a
      // partial tally; fully-taken rows carry the whole credited amount).
      taken = Math.round((taken + dTaken) * 100) / 100;
      if (r.status === 'active') {
        active = Math.round((active + remaining) * 100) / 100;
        if (remaining > 0 && (soonestExpiry === null || r.expiresOn < soonestExpiry)) soonestExpiry = r.expiresOn;
      } else if (r.status === 'lapsed') {
        expired = Math.round((expired + remaining) * 100) / 100;
      } else if (r.status === 'converted_to_pay') {
        convertedToPay = Math.round((convertedToPay + remaining) * 100) / 100;
      }
      out.push({
        id: r.id,
        workedDate: r.workedDate,
        expiresOn: r.expiresOn,
        daysCredited: credited,
        daysTaken: dTaken,
        status: r.status,
        remaining,
      });
    }
    return { active, taken, expired, convertedToPay, soonestExpiry, rows: out };
  });
}

// RL Control Engine (0113): company-scoped replacement-leave totals for the admin panel (the active-vs-expired
// split aggregated over everyone in scope). Same status semantics as replacementLeaveLedger, summed.
export type ReplacementLeaveSummary = {
  active: number;
  taken: number;
  expired: number;
  convertedToPay: number;
  soonestExpiry: string | null;
  activeAccruals: number;
};

export function replacementLeaveSummary(ctx: SessionContext, companyIds?: string[]): Promise<ReplacementLeaveSummary> {
  return withTenant(ctx, async (tx) => {
    const scope =
      companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined;
    const rows = await tx
      .select({
        status: toilAccrual.status,
        daysCredited: toilAccrual.daysCredited,
        daysTaken: toilAccrual.daysTaken,
        expiresOn: toilAccrual.expiresOn,
      })
      .from(toilAccrual)
      .innerJoin(employment, eq(employment.id, toilAccrual.employmentId))
      .where(scope);
    let active = 0;
    let taken = 0;
    let expired = 0;
    let convertedToPay = 0;
    let soonestExpiry: string | null = null;
    let activeAccruals = 0;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    for (const r of rows) {
      const remaining = r2(Number(r.daysCredited) - Number(r.daysTaken));
      taken = r2(taken + Number(r.daysTaken));
      if (r.status === 'active') {
        active = r2(active + remaining);
        if (remaining > 0) {
          activeAccruals += 1;
          if (soonestExpiry === null || r.expiresOn < soonestExpiry) soonestExpiry = r.expiresOn;
        }
      } else if (r.status === 'lapsed') {
        expired = r2(expired + remaining);
      } else if (r.status === 'converted_to_pay') {
        convertedToPay = r2(convertedToPay + remaining);
      }
    }
    return { active, taken, expired, convertedToPay, soonestExpiry, activeAccruals };
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

export function leaveRequestsFor(ctx: SessionContext, employmentId: string, locale?: string) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: leaveRequest.id,
        leaveType: leaveType.name,
        i18n: leaveType.i18n,
        startDate: leaveRequest.startDate,
        endDate: leaveRequest.endDate,
        days: leaveRequest.days,
        durationType: leaveRequest.durationType,
        hours: leaveRequest.hours,
        // Hourly-leave time window (0129): the employee sees their own window on the /me history row.
        fromTime: leaveRequest.fromTime,
        toTime: leaveRequest.toTime,
        status: leaveRequest.status,
        typeCode: leaveType.code,
        // Emergency Leave (0106): the shared id linking an EL submission's ANNUAL + UNPAID children, so the
        // /me history can group them under one EL heading. NULL for ordinary requests.
        parentGroupId: leaveRequest.parentGroupId,
        hasDocument: sql<boolean>`exists (select 1 from leave_request_attachment lra where lra.leave_request_id = leave_request.id)`,
        currentStepKind: sql<string | null>`(select approver_kind from leave_approval_step s where s.leave_request_id = leave_request.id and s.status = 'pending' order by s.step_index limit 1)`,
        currentStepIndex: sql<number | null>`(select step_index from leave_approval_step s where s.leave_request_id = leave_request.id and s.status = 'pending' order by s.step_index limit 1)`,
        stepCount: sql<number>`(select count(*)::int from leave_approval_step s where s.leave_request_id = leave_request.id)`,
      })
      .from(leaveRequest)
      .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
      .where(eq(leaveRequest.employmentId, employmentId))
      .orderBy(desc(leaveRequest.startDate));
    return rows.map(({ i18n, ...r }) => ({ ...r, leaveType: pickName(r.leaveType, i18n, locale) }));
  });
}

/** Current reporting edges for an employment: who they report to, and their direct reports. Excludes
 *  `delegate` edges (approver-routing, surfaced separately by delegationsFor — ADR-0052). */
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
          sql`${reportingLine.lineType} <> 'delegate'`,
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
          sql`${reportingLine.lineType} <> 'delegate'`,
        ),
      )
      .orderBy(person.fullName);
    return { managers, reports };
  });
}

/** Active approval delegations FROM this employment (ADR-0052): rows where this employment is the
 *  delegator (subordinate of a `delegate` edge), naming the stand-in delegate (the edge's manager) and
 *  the window. RLS scopes the join through employment (admin/self/manager visibility). */
export function delegationsFor(ctx: SessionContext, employmentId: string) {
  return withTenant(ctx, async (tx) => {
    return tx
      .select({
        id: reportingLine.id,
        delegateEmploymentId: reportingLine.managerEmploymentId,
        delegateName: person.fullName,
        validFrom: reportingLine.validFrom,
        validTo: reportingLine.validTo,
      })
      .from(reportingLine)
      .innerJoin(employment, eq(employment.id, reportingLine.managerEmploymentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          eq(reportingLine.subordinateEmploymentId, employmentId),
          eq(reportingLine.lineType, 'delegate'),
          isNull(reportingLine.supersededAt),
        ),
      )
      .orderBy(desc(reportingLine.validFrom));
  });
}

/** Active employees + current administrative reporting edges, for the org chart. */
export function orgChartData(ctx: SessionContext, companyIds?: string[]) {
  return withTenant(ctx, async (tx) => {
    const employees = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        employeeCode: employment.employeeCode,
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
    // Hierarchy Management (ADR-0052 Step 6): the edge query SELECTs straight from reporting_line, whose
    // RLS is tenant-only (it does NOT call can_see_employment), so previously it returned EVERY edge in
    // the tenant — including edges where an endpoint is terminated. Scope it so only edges with BOTH
    // endpoints visible to the caller AND both endpoints live (non-terminated) are returned: a mid-level
    // manager's /org then shows only their subtree, and stale edges through a fired manager are dropped.
    // `delegate` edges are approver-routing, not org structure, so they are excluded from the chart.
    const edgeRows = await tx
      .select({
        manager: reportingLine.managerEmploymentId,
        subordinate: reportingLine.subordinateEmploymentId,
        type: reportingLine.lineType,
      })
      .from(reportingLine)
      .where(
        and(
          isNull(reportingLine.validTo),
          isNull(reportingLine.supersededAt),
          sql`${reportingLine.lineType} <> 'delegate'`,
          sql`app.can_see_employment(${reportingLine.managerEmploymentId})`,
          sql`app.can_see_employment(${reportingLine.subordinateEmploymentId})`,
          sql`EXISTS (SELECT 1 FROM employment mgr_e WHERE mgr_e.id = ${reportingLine.managerEmploymentId} AND mgr_e.terminated_on IS NULL)`,
          sql`EXISTS (SELECT 1 FROM employment sub_e WHERE sub_e.id = ${reportingLine.subordinateEmploymentId} AND sub_e.terminated_on IS NULL)`,
        ),
      );
    // delegate edges are filtered out in the query above, so the chart's edge type stays the structural
    // union (administrative | functional | project | dotted) the OrgChart component expects.
    const edges = edgeRows as { manager: string; subordinate: string; type: 'administrative' | 'functional' | 'project' | 'dotted' }[];
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
  /** Restrict to a fixed SET of aggregate types (e.g. the leave module's aggregates for the leave
   *  Audit tab). Applied alongside `aggregateType` — pass one or the other, not both. */
  aggregateTypes?: string[];
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
          f.aggregateTypes && f.aggregateTypes.length
            ? inArray(domainEvent.aggregateType, f.aggregateTypes)
            : undefined,
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

/**
 * The principal's full set of employment ids + company name, INCLUDING terminated ones. `myEmployments`
 * filters out terminated employments (correct for the active-portal lists), but a leaver is the headline
 * EA-form user: they need their prior employer's annual statement to file personal tax. RLS still scopes
 * this to the principal's own employments, so feeding the result to `myPayslips` only surfaces payslips
 * the principal owns. Used solely to build the /me EA document rows.
 */
export function myEmploymentIdsAll(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    if (!ctx.personId) return [];
    return tx
      .select({ employmentId: employment.id, company: company.legalName })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(eq(employment.personId, ctx.personId))
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

/**
 * My Payroll — Self Personal Tax Relief (LHDN TP1). Read-only: no domain event (CLAUDE.md substrate
 * rule — this slice is a pure SELECT).
 *
 * Sources the relief ACTUALLY APPLIED to a payslip from `payslip.statutory.lp` (core/payroll.ts:935/986),
 * NOT the raw `payroll_input.tp1Deduction`, which is the pre-clamp input. This matches the figure the
 * employee sees on their own payslip detail page and rides the payslip's own RLS policy
 * (`app.can_see_employment`, 0010_payroll_rls.sql) — the same self-scoping `myPayslips` already relies on.
 *
 * Because a payslip row only exists AFTER generation, draft/voided batches are excluded by construction —
 * no batch-status predicate is needed (a reviewer should NOT "helpfully" add a status join). TP1 is a
 * per-assessment-year LHDN concept, so results are filtered to a single tax year (default = current),
 * derived from `payrollBatch.payPeriod`, and the YTD total is scoped to that year (not blended across years).
 *
 * Returns one row per applied TP1 (lp > 0), each carrying its company, so a person employed by two entities
 * — each filing its own PCB — can be grouped per company in the UI rather than blended.
 */
export type TaxReliefRow = {
  payPeriod: string;
  company: string;
  runType: string;
  tp1: number;
};
export type TaxReliefResult = { year: number; rows: TaxReliefRow[]; ytd: number };

export function myTaxRelief(
  ctx: SessionContext,
  employmentIds: string[],
  year?: number,
): Promise<TaxReliefResult> {
  const taxYear = year ?? new Date().getFullYear();
  return withTenant(ctx, async (tx): Promise<TaxReliefResult> => {
    if (employmentIds.length === 0) return { year: taxYear, rows: [], ytd: 0 };
    const raw = await tx
      .select({
        payPeriod: payrollBatch.payPeriod,
        runType: payrollBatch.runType,
        company: company.legalName,
        statutory: payslip.statutory,
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(inArray(payslip.employmentId, employmentIds))
      .orderBy(desc(payrollBatch.payPeriod), payrollBatch.runSeq);

    const rows: TaxReliefRow[] = [];
    let ytd = 0;
    for (const r of raw) {
      // payPeriod is 'YYYY-MM'; scope to the requested assessment year.
      if (Number(r.payPeriod.slice(0, 4)) !== taxYear) continue;
      // numeric(12,2) inside JSONB arrives as a string — coerce or a raw += string-concatenates.
      const tp1 = Number((r.statutory as { lp?: unknown } | null)?.lp ?? 0);
      if (!(tp1 > 0)) continue; // exclude zero rows; based on the payslip's applied lp
      rows.push({ payPeriod: r.payPeriod, company: r.company, runType: r.runType, tp1 });
      ytd += tp1;
    }
    return { year: taxYear, rows, ytd: Math.round(ytd * 100) / 100 };
  });
}

/**
 * Employment ids for the current principal INCLUDING terminated employments — leaver-safe. `myEmployments`
 * filters `isNull(terminatedOn)`, but a resigned employee is exactly who needs TP1 history to file taxes,
 * and payslip RLS (`can_see_employment` self-branch, 0016) gates rows to the caller regardless of
 * termination. Used to scope My Payroll TP1 so a leaver's relief history stays visible.
 */
export function myTaxReliefEmploymentIds(ctx: SessionContext): Promise<string[]> {
  return withTenant(ctx, async (tx) => {
    if (!ctx.personId) return [];
    const rows = await tx
      .select({ id: employment.id })
      .from(employment)
      .where(eq(employment.personId, ctx.personId));
    return rows.map((r) => r.id);
  });
}

// ADR-0070: two aliases of clocking_location so a single query can resolve BOTH the check-in and
// check-out matched-site names — tenant-catalog RLS (0065 pattern) makes the name resolve even for a
// manager viewing a subordinate, or after the employee is later un-assigned from the site.
const checkInSite = alias(clockingLocation, 'check_in_site');
const checkOutSite = alias(clockingLocation, 'check_out_site');

/** The current principal's recent attendance, including per-punch Clocking Location & Geofencing
 *  capture (ADR-0070): matched site name, distance, and pass/not-enforced status per punch. */
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
        checkInLat: attendance.checkInLat,
        checkInLng: attendance.checkInLng,
        checkInLocationName: checkInSite.name,
        checkInDistanceM: attendance.checkInDistanceM,
        checkInGeofenceStatus: attendance.checkInGeofenceStatus,
        checkOutLat: attendance.checkOutLat,
        checkOutLng: attendance.checkOutLng,
        checkOutLocationName: checkOutSite.name,
        checkOutDistanceM: attendance.checkOutDistanceM,
        checkOutGeofenceStatus: attendance.checkOutGeofenceStatus,
      })
      .from(attendance)
      .leftJoin(checkInSite, eq(checkInSite.id, attendance.checkInClockingLocationId))
      .leftJoin(checkOutSite, eq(checkOutSite.id, attendance.checkOutClockingLocationId))
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

// ───────────────── Attendance Allowance (ADR-0072) ─────────────────

/** The attendance-allowance policies for the admin catalog table (joined to their pay component's name/code
 *  for display). Excludes archived unless asked. RLS scopes to the tenant; company scoping is applied when
 *  companyIds is passed (mirrors the other admin lists). */
export function listAllowancePolicies(
  ctx: SessionContext,
  opts: { companyIds?: string[]; includeArchived?: boolean } = {},
) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: attendanceAllowancePolicy.id,
        companyId: attendanceAllowancePolicy.companyId,
        companyName: company.legalName,
        code: attendanceAllowancePolicy.code,
        name: attendanceAllowancePolicy.name,
        method: attendanceAllowancePolicy.method,
        amount: attendanceAllowancePolicy.amount,
        payComponentId: attendanceAllowancePolicy.payComponentId,
        payComponentCode: payComponent.code,
        payComponentName: payComponent.name,
        effectiveFrom: attendanceAllowancePolicy.effectiveFrom,
        status: attendanceAllowancePolicy.status,
        criteria: attendanceAllowancePolicy.criteria,
        scope: attendanceAllowancePolicy.scope,
        archivedAt: attendanceAllowancePolicy.archivedAt,
      })
      .from(attendanceAllowancePolicy)
      .innerJoin(company, eq(company.id, attendanceAllowancePolicy.companyId))
      .leftJoin(payComponent, eq(payComponent.id, attendanceAllowancePolicy.payComponentId))
      .where(
        opts.companyIds && opts.companyIds.length
          ? inArray(attendanceAllowancePolicy.companyId, opts.companyIds)
          : undefined,
      )
      .orderBy(company.legalName, attendanceAllowancePolicy.code);
    return opts.includeArchived ? rows : rows.filter((r) => r.archivedAt == null);
  });
}

/** The dashboard rows for the Attendance page allowances panel: the live evaluation of one policy for a
 *  month. Pure read (evaluateAllowancesForPeriod), RLS-trimmed via the shared monthly summary. */
export function allowancePreviewForPeriod(
  ctx: SessionContext,
  p: { policyId: string; month: string; today?: string },
) {
  return evaluateAllowancesForPeriod(ctx, p);
}
