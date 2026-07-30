/** Read queries for the UI. Each runs via withTenant, so RLS scopes every result. */
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, or, sql, type AnyColumn } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import {
  aggregateTypesOfModule,
  isApprovalHistoryAction,
  type ApprovalHistoryAction,
  type ApprovalHistoryModule,
} from '../lib/approval-history';
import {
  AGED_FORFEIT_REASON,
  CARRY_FORFEIT_REASON_CAP,
  CARRY_FORFEIT_REASON_EXPIRY,
  POLICY_RECALC_REASON_PREFIX,
  PROFILE_RECALC_REASON_PREFIX,
  earnedCycleStart,
  isEarnedMethod,
  resolveLeaveYearCycle,
  isLeaveEligible,
  resolveCarryBreakdown,
  resolveGradePolicy,
  serviceYearsAt,
  workingDatesForSpan,
  workingDatesForSpans,
  type GradePolicyRow,
  type LeaveEligibility,
} from './leave';
// 23ad620e — "the" emergency contact is now the highest-priority row of the per-person register.
import { primaryEmergencyContactSql } from './emergency-contacts';
import {
  appUser,
  assignment,
  attendance,
  attendanceAllowancePolicy,
  businessUnit,
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
  leaveRequestStatusEnum,
  leaveType,
  location,
  payComponent,
  payrollBatch,
  payrollPolicy,
  payslip,
  person,
  position,
  reportingLine,
  reportingLineScope,
  toilAccrual,
} from '../db/schema';
import { ALL_ROW_CEILING } from '../lib/pagination';
import { daysInMonth } from './payroll';
import { filterDelegationOrgScopeTx } from './approvals';
import { payslipReleaseAt } from './payroll-policy-config';
import { evaluateAllowancesForPeriod } from './attendance-allowance';
import { visibleLabelIdsCondition } from './system-labels';
import { resolveEssView, type ResolvedEssView } from './ess-view';
import { resolveLeaveFormula, type LeaveFormulaEntry, type ResolvedLeaveFormula } from './leave-formula';
import { resolvePlacement, type EssPlacement } from '../lib/leave-groups';
import type { EmploymentStatus } from './employment-status';
import { employmentStatusSql } from './employment-status-sql';

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
        // The person behind the employment — the invite form (0279) binds an invitation to a PERSON,
        // not an employment, so it needs this id. Additive; existing callers ignore it.
        personId: employment.personId,
        department: department.name,
        // Current-assignment department id — the Individual Transaction wizard uses it (client-side) to
        // filter Step-2 batches whose scope names departments the employee belongs to (a UX filter; the
        // bulk service re-checks scope membership authoritatively). Nullable, like department.
        departmentId: assignment.departmentId,
        // Position title of the current assignment — used by the Individual Transaction wizard's Step-1
        // employee card (Employee ID / Name / Department / Position). Nullable, like department.
        position: position.title,
        // Current-assignment Business Unit — the Fixed / Individual Transaction screens filter Step-1 by it
        // (a UX narrowing over the already access-fenced list). Nullable, like department.
        businessUnit: businessUnit.name,
        businessUnitId: assignment.businessUnitId,
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
      .leftJoin(businessUnit, eq(businessUnit.id, assignment.businessUnitId))
      .where(companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined)
      .orderBy(person.fullName),
  );
}

export type EmployeeListRow = {
  employmentId: string;
  name: string;
  email: string;
  employeeCode: string | null;
  // R81 (9cbf5e0d): the legacy stored `status` field is GONE from this row — the column behind it was
  // dropped (migration 0331). Every consumer already derived the badge from the lifecycle dates below via
  // deriveEmploymentStatus; nothing read this field for display. Derive, do not re-add.
  department: string | null;
  departmentId: string | null;
  position: string | null;
  company: string;
  companyId: string;
  hiredOn: string;
  terminatedOn: string | null;
  // Employee Status redesign (R43 c26c3ce5) — lifecycle inputs so the list badge can derive status per row.
  confirmationDate: string | null;
  finalConfirmationDate: string | null;
  resignationDate: string | null;
  lastWorkingDate: string | null;
  blacklistedAt: string | null;
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
    // Employee Details listing (feedback 650b6eb8) — the SAME narrowings, multi-select. They sit
    // ALONGSIDE the singular ones rather than replacing them: /personnel and /admin/personnel drive
    // single-value pickers, and `filterCompanyIds` carries the clumsy prefix for the reason 8ec63139
    // gave on the leave read — conflating "what the switcher lets you see" (`companyIds`) with "what
    // you asked to see" would be a security bug, not a tidy-up.
    filterCompanyIds?: string[];
    departmentIds?: string[];
    /** Derived Employee Status buckets (9cbf5e0d). A WHERE predicate cannot call the TypeScript
     *  deriver, so it narrows through employmentStatusSql — the twin pinned equal by
     *  test/personnel-status-sync.test.ts. There is no stored status column to confuse it with (R81). */
    employmentStatuses?: EmploymentStatus[];
    /** 'company' = company A→Z then employee name A→Z (650b6eb8's reading order); default is name. */
    sort?: 'name' | 'company';
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
      p.filterCompanyIds && p.filterCompanyIds.length
        ? inArray(employment.companyId, p.filterCompanyIds)
        : undefined,
      p.departmentId ? eq(assignment.departmentId, p.departmentId) : undefined,
      p.departmentIds && p.departmentIds.length ? inArray(assignment.departmentId, p.departmentIds) : undefined,
      p.employmentStatuses && p.employmentStatuses.length
        ? inArray(employmentStatusSql(), p.employmentStatuses)
        : undefined,
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
        department: department.name,
        departmentId: assignment.departmentId,
        position: position.title,
        company: company.legalName,
        companyId: employment.companyId,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
        // R43 c26c3ce5 — lifecycle inputs for the derived status badge.
        confirmationDate: employment.confirmationDate,
        finalConfirmationDate: employment.finalConfirmationDate,
        // R81 — the probation fallbacks. Nothing writes a confirmation date at hire, so without these two
        // a new hire serving probation derived to "Active" on day one. See core/employment-status.ts.
        probationEndDate: employment.probationEndDate,
        provisionalEndOn: employment.provisionalEndOn,
        resignationDate: employment.resignationDate,
        lastWorkingDate: employment.lastWorkingDate,
        blacklistedAt: employment.blacklistedAt,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(assignment, currentAssignment)
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .leftJoin(position, eq(position.id, assignment.positionId))
      .where(where)
      // lower() rather than the raw columns: the reading order must not put "acme" in a different half of
      // the list from "Acme" — the same case-insensitivity lib/leave-inquiry.ts applies in TypeScript.
      .orderBy(
        ...(p.sort === 'company'
          ? [sql`lower(${company.legalName})`, sql`lower(${person.fullName})`]
          : [person.fullName]),
      )
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

/**
 * Companies, with the full master row every company screen reads.
 *
 * SCOPE, AND WHY THERE ARE NOW TWO OF THEM (feedback ae3bd088). By default this is scoped to the
 * TENANT and to nothing else — RLS's `tenant_id = app.current_tenant_id()` and no further predicate —
 * which is right for the ~15 pickers and filters that call it: they hand the chosen company to a
 * service call that does its own authorisation, and narrowing the picker would only hide options that
 * are legitimately selectable.
 *
 * `adminOnly` adds `app.is_admin_for(company.id)` — the SAME function the company table's own WITH
 * CHECK clause uses (migration 0016), so a screen that lists a company with this option can always
 * also write to it. A GROUP-WIDE grant (`company_id` null on the role_assignment) satisfies it for
 * every company, so this is not a narrowing for the ordinary group admin: it is all of them, exactly
 * as before. It narrows only a company-scoped admin, to their company and its subtree.
 *
 * It exists because "tenant-wide" was the wrong contract for the Organization → Companies MANAGEMENT
 * card. That card renders an editable panel per row — archive, delete, re-parent, bank profile,
 * statutory identifiers — so listing a company a person cannot administer offers them controls the
 * database will refuse, and discloses the group's size to someone whose access does not otherwise
 * reveal it (the same objection feedback ab77dc1f raised against the dashboard's "N of M").
 */
/**
 * One company's ISO-4217 currency, or 'MYR' when the company is out of scope / absent.
 *
 * r79a (4fb8b75a step 3): `company.currency` is now the company's ONE currency field. It absorbed
 * company_payroll_config.default_currency (migration 0324) — the two were a genuine duplicate, with the
 * Organization one editable-but-inert and the payroll one doing the real work. Owner: Organization →
 * General. Reader: the Basic Salary form's currency preselect for a brand-new salary record. This is a
 * single-column read so a form does not have to pull the whole listCompanies projection for it.
 */
export function getCompanyCurrency(ctx: SessionContext, companyId: string): Promise<string> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ currency: company.currency })
      .from(company)
      .where(eq(company.id, companyId))
      .limit(1);
    return row?.currency ?? 'MYR';
  });
}

export function listCompanies(
  ctx: SessionContext,
  opts: { includeArchived?: boolean; adminOnly?: boolean } = {},
) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: company.id,
        name: company.legalName,
        country: company.country,
        currency: company.currency,
        registrationNo: company.registrationNo,
        // Enhance Company General Tab (bc5d4891) — Company + Contact master data for the General tab.
        companyLabel: company.companyLabel,
        industry: company.industry,
        website: company.website,
        businessType: company.businessType,
        addressLine1: company.addressLine1,
        addressLine2: company.addressLine2,
        addressLine3: company.addressLine3,
        city: company.city,
        state: company.state,
        addressCountry: company.addressCountry,
        postcode: company.postcode,
        phone: company.phone,
        fax: company.fax,
        leaveCycle: company.leaveCycle,
        leaveHalfDayFullDeduction: company.leaveHalfDayFullDeduction,
        // Organization Module (361e3b15) — the company's saved default payroll cycle (name), read by the
        // General-tab picker and the Payroll Process wizard's Step-1 pre-select.
        defaultPayrollCycle: company.defaultPayrollCycle,
        // Shared System Labels flag (62de487d) — the grid shows/toggles per-company sharing.
        sharedSystemLabels: company.sharedSystemLabels,
        archivedAt: company.archivedAt,
        inUse: sql<boolean>`exists (select 1 from department d where d.company_id = company.id) or exists (select 1 from employment e where e.company_id = company.id) or exists (select 1 from company c where c.parent_company_id = company.id)`,
        // hasLogo: EXISTS against the company_logo side table (NEVER the bytes — the blob is a different
        // table, so this can only ever pull a boolean). Non-breaking, name-based add for existing callers.
        hasLogo: sql<boolean>`exists (select 1 from company_logo cl where cl.company_id = company.id)`,
      })
      .from(company)
      .where(
        and(
          opts.includeArchived ? undefined : isNull(company.archivedAt),
          // Raw SQL, and `company.id` unqualified, because that is the table's alias in this FROM —
          // the same call shape adminCompanies() already uses.
          opts.adminOnly ? sql`app.is_admin_for(company.id)` : undefined,
        ),
      )
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
          // Shared System Labels (feedback 62de487d): filter by the resolver — origin ∪ shared-in ∪ global
          // for companies whose shared_system_labels flag is ON — instead of raw origin company_id. With the
          // flag OFF everywhere this collapses to inArray(company_id, companyIds): unchanged behaviour.
          opts.companyIds && opts.companyIds.length
            ? visibleLabelIdsCondition(department, 'department', opts.companyIds)
            : undefined,
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
  /** R81: the DERIVED Employee Status bucket (core/employment-status.ts), never a stored column. */
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
 * would pick up. A mid-period leaver appears by default; Employee Status is NOT part of generation's
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
        // R81 (9cbf5e0d): the DERIVED Employee Status, not the dropped stored column. Step 2's Status filter
        // now offers the same six buckets Personnel shows. It stays a FILTER, never a gate — generation's
        // own predicate (hired-by-period-end, not-terminated-before-period-start) is unchanged, so nobody's
        // pay eligibility moves; only the option labels in that dropdown do.
        status: employmentStatusSql(),
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
        // Leave Type master page (feedback 097de541): the free-text description shown in the master listing +
        // the identity edit form (MUST be projected here or the field renders empty on every reload).
        description: leaveType.description,
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
        // Duplicate Leave Application Restriction (d5e51c34): feeds the admin panel's duplicate-policy radio
        // (MUST be projected or the radio renders at its default on every reload). null ⇒ 'allow' default.
        duplicateApplicationPolicy: leaveType.duplicateApplicationPolicy,
        // Configurable Negative Leave Balance Validation (0ef0defd): feeds the admin panel's "Allow Negative
        // Balance" Yes/No radio (MUST be projected or the radio renders at its default on every reload).
        allowNegativeBalance: leaveType.allowNegativeBalance,
        // Balance Deduction Source (cdf9ca48) / Allow Unpaid Leave (a7fab30b): feed the admin panel's two new
        // Leave Application Rules cards (MUST be projected or both render at their defaults on every reload —
        // the "my setting didn't save" report this list has already had twice).
        balanceSourceTypeId: leaveType.balanceSourceTypeId,
        allowUnpaidLeave: leaveType.allowUnpaidLeave,
        // Custom validation messages (custom-messages migration): feeds the admin panel's "Custom system
        // message" textarea (MUST be projected or the textarea renders empty on every reload).
        customMessages: leaveType.customMessages,
        // Employee Leave View Configuration (65dec703): feeds the admin panel's ESS-view checklist (MUST be
        // projected or every checkbox renders at its default on every reload). null ⇒ all-visible default.
        essViewConfig: leaveType.essViewConfig,
        // Leave Entitlement Formula Management (79011509): feeds the admin panel's formula editor (MUST be
        // projected or every field renders empty on every reload). null ⇒ no explanations.
        formulaExplanations: leaveType.formulaExplanations,
        // Day Type Inclusion (ef6d7146): feeds the admin panel's "Day Type Inclusion" toggles (MUST be
        // projected or every toggle renders unchecked on every reload). null ⇒ counting-mode default.
        dayTypeInclusion: leaveType.dayTypeInclusion,
        // Leave Type Visual Configuration (639fdf77): feeds the admin panel's visual sub-form (MUST be
        // projected or the swatch/icon picker render empty on every reload). null ⇒ default styling.
        color: leaveType.color,
        icon: leaveType.icon,
        // Leave Unit Configuration (e4980382): feeds the admin panel's "Leave Unit" select + the create-form
        // default (MUST be projected or the select renders at its default on every reload). 'day' | 'hour'.
        leaveUnit: leaveType.leaveUnit,
        // Leave Year Type override (e1a51aea): feeds the General step's "Leave Year Type" select (MUST be
        // projected or the select renders at its company-default on every reload). null ⇒ company cycle.
        yearCycleOverride: leaveType.yearCycleOverride,
        // Probation eligibility (d6bdbd55): feeds the admin panel's Probation select in the eligibility editor
        // (MUST be projected or the select renders at its default on every reload). null ⇒ no restriction.
        probationEligibility: leaveType.probationEligibility,
        // Leave Type Employee Visibility (7b11f1c1): feeds the admin panel's two visibility checkboxes (MUST be
        // projected or the checkboxes render at their default on every reload). null ⇒ visible / can-apply.
        visibleToEmployee: leaveType.visibleToEmployee,
        employeeCanApply: leaveType.employeeCanApply,
        // Leave grouping visibility (b653ac1b): feeds the admin panel's placement control (MUST be projected
        // or the control renders at its default on every reload). null ⇒ code-keyed default (the control
        // resolves it via lib/leave-groups.ts, reading visibleToEmployee for the Hidden state).
        essPlacement: leaveType.essPlacement,
        eligibility: leaveType.eligibility,
        durations: leaveType.durations,
        archivedAt: leaveType.archivedAt,
        inUse: sql<boolean>`exists (select 1 from leave_request lr where lr.leave_type_id = leave_type.id) or exists (select 1 from leave_ledger ll where ll.leave_type_id = leave_type.id) or exists (select 1 from leave_policy lp where lp.leave_type_id = leave_type.id)`,
      })
      .from(leaveType)
      .where(opts.includeArchived ? undefined : isNull(leaveType.archivedAt));
    // R37: localize the display name to the viewer's locale. Admin callers pass no locale, so the
    // config screens keep the default English name (which is what gets edited).
    //
    // SORTED A-Z BY DISPLAY NAME (feedback c2a48426), and sorted HERE rather than in SQL for a reason
    // the query cannot express: the name a viewer actually reads is resolved just above, in JS, from
    // the i18n column. An `ORDER BY leave_type.name` would order by the ENGLISH name while the screen
    // showed translated ones — alphabetical to nobody. Sorting the projected rows sorts what is read.
    //
    // Server-side rather than in the page, so the order is identical on first paint and after a
    // revalidation. The item calls out that a newly created type must appear in its alphabetical place
    // rather than at the end, and a client-only sort leaves it briefly misplaced on the round trip.
    //
    // localeCompare, not `<`: raw code-unit ordering puts every capital ahead of every lowercase letter
    // ("Unpaid" before "annual") and files accented names past Z, neither of which is what an
    // administrator scanning a list expects.
    //
    // There was no ordering at all before this — rows arrived in Postgres heap order, which is
    // arbitrary and can change as rows are updated. So this is strictly more deterministic for every
    // caller, including listVisibleLeaveTypes, which filters this same projection.
    return rows
      .map(({ i18n, ...r }) => ({ ...r, name: pickName(r.name, i18n, opts.locale) }))
      .sort((a, b) => a.name.localeCompare(b.name, opts.locale));
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
          // Feedback 9d8cf621: the apply-time custom message (applyNotice key) is read off this JSONB to show
          // the HR-authored notice under the leave-type select on the /me apply form.
          customMessages: leaveType.customMessages,
          eligibility: leaveType.eligibility,
          durations: leaveType.durations,
          archivedAt: leaveType.archivedAt,
          // Leave Type Employee Visibility (7b11f1c1): the can-apply switch — false ⇒ this type is dropped
          // from the apply dropdown (in addition to the eligibility filter). NULL ⇒ can apply (today's
          // behaviour). Independent of visibleToEmployee: a visible-but-not-can-apply type still shows in
          // leaveBalances but never here. requestLeave enforces the same rule server-side (defense-in-depth).
          employeeCanApply: leaveType.employeeCanApply,
          // Leave View Dashboard (6d78f373): the placement inputs so a HIDDEN type never reaches the Request
          // Leave dropdown. resolvePlacement (lib/leave-groups) resolves 'hidden' from EITHER visible_to_employee
          // =false OR the code-keyed default-hidden set (Prolonged Illness / Suspension / Unrecorded / Unpaid
          // Medical). NULL/absent config ⇒ primary|secondary (kept), so every ordinary type is unaffected.
          visibleToEmployee: leaveType.visibleToEmployee,
          essPlacement: leaveType.essPlacement,
        })
        .from(leaveType)
        .where(isNull(leaveType.archivedAt)),
      tx
        .select({ gender: person.gender, marital: person.maritalStatus, hiredOn: employment.hiredOn, orgDivision: employment.orgDivision, orgBranch: employment.orgBranch, orgRegion: employment.orgRegion, orgLine: employment.orgLine, orgSection: employment.orgSection, orgTeam: employment.orgTeam, orgBase: employment.orgBase, employmentCategory: employment.employmentCategory })
        .from(employment)
        .innerJoin(person, eq(person.id, employment.personId))
        .where(eq(employment.id, employmentId))
        .limit(1),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    return types
      .filter((t) => isLeaveEligible(t.eligibility as LeaveEligibility | null, emp, today))
      // Leave Type Employee Visibility (7b11f1c1): drop types HR has closed to employee applications
      // (employee_can_apply=false). NULL ⇒ keep (today's behaviour). requestLeave re-checks server-side.
      .filter((t) => t.employeeCanApply !== false)
      // Leave View Dashboard (6d78f373) hidden gate: a type that resolves to 'hidden' — via HR's
      // visible_to_employee=false OR the code-keyed default-hidden set — must not appear in the Request Leave
      // dropdown (reporter §3). Ordinary types resolve to 'primary'|'secondary' and are kept. This is the ESS
      // apply source only (admin uses listLeaveTypes); requestLeave stays the server-side authority.
      .filter((t) => resolvePlacement(t.code, t.essPlacement, t.visibleToEmployee) !== 'hidden')
      .map(({ i18n, eligibility, employeeCanApply, visibleToEmployee, essPlacement, ...r }) => ({
        ...r,
        name: pickName(r.name, i18n, locale),
      }));
  });
}

/**
 * Shared leave-request history projection — used by BOTH the flat `listLeaveRequests` (approvals inbox,
 * the /leave non-admin self-view) AND the paginated/filtered `listLeaveRequestsPage` (the /leave admin
 * search & filter surface, feedback 0773bda9). One selection object means the two reads can never drift.
 */
const leaveRequestSelection = {
  id: leaveRequest.id,
  employmentId: leaveRequest.employmentId,
  personId: employment.personId,
  employee: person.fullName,
  employeeCode: employment.employeeCode,
  leaveType: leaveType.name,
  // Edit/cancel-by-status (item c9a19e34): the type id so the /leave own-pending Edit dialog can prefill its
  // leave-type <select>.
  leaveTypeId: leaveRequest.leaveTypeId,
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
  // WHO the request is currently sitting with (feedback 567333b7). The panel could say "Pending" but not
  // with whom, so an employee had no way to know who to chase.
  //
  // Resolved ONLY for a `direct_manager` step, and that limit is the design rather than a shortcut. A step
  // stores an approver KIND, not a person: 'direct_manager' resolves to exactly one well-defined employee
  // (the subject's open administrative reporting edge), while 'hr_admin', 'payroll' and the head kinds
  // resolve to a SET whose membership is decided by the authorization rules in decideLeave. Naming one of
  // those would tell the employee something untrue about who can act, and enumerating them would publish
  // the tenant's HR roster to every employee. Those keep their role label via currentStepKind; only the
  // manager case earns a name and a face.
  //
  // Reads the SAME edge reportingLinesFor uses (administrative, still open) rather than inventing a second
  // notion of "manager" that could drift from the one the rest of the app shows.
  currentApproverName: sql<string | null>`(
    select mp.full_name from leave_approval_step s
    join reporting_line rl on rl.subordinate_employment_id = leave_request.employment_id
      and rl.line_type = 'administrative' and rl.valid_to is null
    join employment me on me.id = rl.manager_employment_id
    join person mp on mp.id = me.person_id
    where s.leave_request_id = leave_request.id and s.status = 'pending'
      and s.approver_kind = 'direct_manager'
    order by s.step_index limit 1)`,
  currentApproverPersonId: sql<string | null>`(
    select me.person_id from leave_approval_step s
    join reporting_line rl on rl.subordinate_employment_id = leave_request.employment_id
      and rl.line_type = 'administrative' and rl.valid_to is null
    join employment me on me.id = rl.manager_employment_id
    where s.leave_request_id = leave_request.id and s.status = 'pending'
      and s.approver_kind = 'direct_manager'
    order by s.step_index limit 1)`,
  // Approval Information (feedback 0773bda9): the final decider's employment id + name, so the admin
  // history table can show "Approved by" and the advanced filter can narrow by approver. NULL until a
  // request is decided (pending rows). Kept in the SHARED projection so the flat + paginated reads agree.
  decidedByEmploymentId: leaveRequest.decidedByEmploymentId,
  decidedByName: sql<string | null>`(select p.full_name from employment de join person p on p.id = de.person_id where de.id = leave_request.decided_by_employment_id)`,
  // Employee Leave Record (feedback 953be4b0): WHEN the request reached its final decision — the
  // "Final Approval Date" column. Stamped alongside decided_by, so a row that has a decider has a date;
  // NULL while pending. In the SHARED projection so the flat and paginated reads agree.
  decidedAt: leaveRequest.decidedAt,
  stepCount: sql<number>`(select count(*)::int from leave_approval_step s where s.leave_request_id = leave_request.id)`,
  // R23 (2F-3): the applicant's current balance for THIS leave type — the key context an approver
  // needs ("do they have the days?"). Ledger sum (accrual + − debit −).
  // r80: no table RENDERS this any more — the reporter asked for the "13.5d left" sub-line under the
  // Approval Items Days column to go (33bf1a2d follow-up), so the value is computed but not shown there.
  // It stays in the shared projection deliberately: it is a plain correlated subquery on a row the page
  // already loads (no extra round trip), it is asserted by test/approver-context.test.ts, and dropping a
  // field from the SHARED selection would change what the flat and paginated leave reads return.
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
  // R17 600be8ac ask #1: the applicant's own words — the free-text `reason` and (for types that require it) the
  // mandatory `employeeRemark` — so the approver's summary shows WHY the leave was requested, not just the dates.
  reason: leaveRequest.reason,
  employeeRemark: leaveRequest.employeeRemark,
  // R17 600be8ac ask #4: TRUE when this request has ≥1 REJECTED per-date sub-row. Drives the derived
  // "Partially approved" display badge (an approved request with some dates rejected) — no new status enum;
  // the DB status stays 'approved' and every consumer keeps reading per-date truth (§4A). NULL/false otherwise.
  hasRejectedDates: sql<boolean>`exists (select 1 from leave_request_date d where d.leave_request_id = leave_request.id and d.status = 'rejected')`,
} as const;

/** R5 Build #2 (Fix C — holiday/working-day-aware cancellable list): resolve each ELIGIBLE row's REAL
 *  working dates (roster + public-holiday aware, the SAME frame requestLeaveCancellation validates against)
 *  so the Leave page offers exactly the cancellable candidates — not a Mon–Fri heuristic. Only resolved for
 *  approved full-day rows that are either a plain request (parentGroupId null) or a cancellation-split
 *  survivor; others get []. Runs bounded to the passed page of rows (≤ page size). */
async function resolveLeaveWorkingDates<
  T extends {
    status: string;
    durationType: string;
    parentGroupId: string | null;
    isCancellationSplit: boolean;
    employmentId: string;
    startDate: string;
    endDate: string;
  },
>(tx: Tx, rows: T[]): Promise<(T & { workingDates: string[] })[]> {
  return Promise.all(
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
}

/** Every leave request in scope (RLS additionally trims to what the viewer may see:
 *  admins everything, managers their reports, employees themselves). Recent first.
 *
 *  8cb7b089 pre-fix: `opts.status` narrows the read BEFORE the `limit` cap applies, so the Approvals
 *  page can cap 200 PENDING rows rather than the 200 most recent rows of ANY status (where an older
 *  still-pending request silently fell off the list on a large tenant). Omitting it is byte-identical
 *  to today's behaviour, so every existing caller (/leave self-view, approvals-inbox count) is unaffected. */
export function listLeaveRequests(
  ctx: SessionContext,
  companyIds?: string[],
  limit = 200,
  opts?: { status?: 'pending' | 'approved' | 'rejected' | 'cancelled' },
) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select(leaveRequestSelection)
      .from(leaveRequest)
      .innerJoin(employment, eq(employment.id, leaveRequest.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
      .where(
        and(
          companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined,
          opts?.status ? eq(leaveRequest.status, opts.status) : undefined,
        ),
      )
      .orderBy(desc(leaveRequest.createdAt))
      .limit(limit);
    // R51 (baf56348): keep delegation-routed rows whose subject sits OUTSIDE the delegation's org coverage
    // out of the approver-facing list (row visibility itself is unchanged — see filterDelegationOrgScopeTx).
    const scoped = await filterDelegationOrgScopeTx(tx, ctx, rows, (r) => r.employmentId);
    return resolveLeaveWorkingDates(tx, scoped);
  });
}

/** One row of the leave-request history table (shared projection + resolved workingDates). */
export type LeaveRequestRow = Awaited<ReturnType<typeof listLeaveRequests>>[number];

/**
 * Advanced Search & Filter for Leave Management (feedback 0773bda9) — the paginated, filterable, sortable
 * read behind the /leave admin surface. Mirrors `listEmployeesPage`: returns { rows, total } so the page can
 * show "Showing X of Y" and page through arbitrarily large populations (Chin Hin ~4.5k staff), instead of the
 * 200-row hard cap `listLeaveRequests` imposes. RLS (`withTenant`) is the authority for row visibility;
 * `companyIds` is the narrowing scope fence from the company switcher (ALWAYS applied), and the individual
 * filters below narrow further. Read-only — no DomainEvent (search/filter/paginate mutate nothing).
 */
export function listLeaveRequestsPage(
  ctx: SessionContext,
  p: {
    companyIds?: string[]; // scope fence (company switcher) — ALWAYS applied
    q?: string; // name / employeeCode / uuid-prefix reference
    companyId?: string;
    businessUnitId?: string;
    departmentId?: string;
    locationId?: string;
    // Filter on EVERY column (feedback 8ec63139): the org narrowings became multi-select, so each also
    // accepts a list. The singular forms above are kept — they are a different question ("exactly this
    // one") that the fence test and the flat callers still ask — and both are ANDed when both are given.
    // `filterCompanyIds` carries the clumsy prefix because `companyIds` is already taken by the fence:
    // conflating "what the switcher lets you see" with "what you asked to see" would be a security bug.
    filterCompanyIds?: string[];
    businessUnitIds?: string[];
    departmentIds?: string[];
    locationIds?: string[];
    /** Employee column filter, and the (employment, type) narrowing the Employee Leave Record page reads. */
    employmentIds?: string[];
    /** Days column filter — validated against full_day|half_day_am|half_day_pm|hourly. */
    durationTypes?: string[];
    leaveTypeIds?: string[]; // multi
    statuses?: string[]; // multi — validated against pending|approved|rejected|cancelled
    // Approval Information (feedback 0773bda9). `approvedBy` = the FINAL decider's employment id
    // (leave_request.decided_by_employment_id — a stored named person, so this is exact). `pendingWith`
    // = the ROLE the request is currently awaiting (the first pending approval step's approver_kind:
    // 'direct_manager' | 'hr_admin'); the chain stores a role, not a named person, so this filter is by
    // stage, which is the finest granularity the data supports.
    approvedBy?: string;
    pendingWith?: string;
    from?: string;
    to?: string; // leave-date window (overlap semantics)
    appliedFrom?: string;
    appliedTo?: string; // application (createdAt) date range
    sort?: string;
    dir?: string; // default: applied desc (today's order)
    limit: number;
    offset: number;
  },
): Promise<{ rows: LeaveRequestRow[]; total: number }> {
  return withTenant(ctx, async (tx) => {
    const q = p.q?.trim();
    // Current open assignment (≤1 row / employment) — copied from listEmployeesPage so department /
    // business-unit / location filters resolve off the employee's CURRENT posting, shared by rows + count.
    const currentAssignment = and(
      eq(assignment.employmentId, employment.id),
      isNull(assignment.validTo),
      isNull(assignment.supersededAt),
    );
    // Statuses validated against the enum before hitting SQL (defence-in-depth; an unknown value would
    // otherwise widen to nothing but a bad cast could throw). Same for the sort whitelist below.
    const validStatuses = (p.statuses ?? []).filter((s) =>
      (leaveRequestStatusEnum.enumValues as readonly string[]).includes(s),
    ) as (typeof leaveRequestStatusEnum.enumValues)[number][];
    // duration_type is a plain text column (ADR-0048), so the allow-list IS the validation.
    const validDurations = (p.durationTypes ?? []).filter((d) =>
      (['full_day', 'half_day_am', 'half_day_pm', 'hourly'] as readonly string[]).includes(d),
    );
    // uuid-prefix reference search: strip a leading '#', match when it looks like a (partial) uuid.
    const refTerm = q?.replace(/^#/, '');
    const isRef = !!refTerm && /^[0-9a-f-]{6,}$/i.test(refTerm);
    const where = and(
      p.companyIds && p.companyIds.length ? inArray(employment.companyId, p.companyIds) : undefined,
      p.companyId ? eq(employment.companyId, p.companyId) : undefined,
      p.businessUnitId ? eq(department.businessUnitId, p.businessUnitId) : undefined,
      p.departmentId ? eq(assignment.departmentId, p.departmentId) : undefined,
      p.locationId ? eq(assignment.locationId, p.locationId) : undefined,
      // Multi-select column filters (feedback 8ec63139) — OR within a field, AND across fields, the same
      // shape leaveTypeIds/statuses already had.
      p.filterCompanyIds?.length ? inArray(employment.companyId, p.filterCompanyIds) : undefined,
      p.businessUnitIds?.length ? inArray(department.businessUnitId, p.businessUnitIds) : undefined,
      p.departmentIds?.length ? inArray(assignment.departmentId, p.departmentIds) : undefined,
      p.locationIds?.length ? inArray(assignment.locationId, p.locationIds) : undefined,
      p.employmentIds?.length ? inArray(leaveRequest.employmentId, p.employmentIds) : undefined,
      validDurations.length ? inArray(leaveRequest.durationType, validDurations) : undefined,
      p.leaveTypeIds && p.leaveTypeIds.length ? inArray(leaveRequest.leaveTypeId, p.leaveTypeIds) : undefined,
      validStatuses.length ? inArray(leaveRequest.status, validStatuses) : undefined,
      // Approval Information — "Approved by" is the stored final decider (exact match on a named person).
      p.approvedBy ? eq(leaveRequest.decidedByEmploymentId, p.approvedBy) : undefined,
      // "Pending with" narrows to rows whose CURRENT (first) pending approval step awaits this role. The
      // value is whitelisted against the two approver kinds; an unknown value matches nothing rather than
      // interpolating raw input. NB: only pending rows have a pending step, so this implicitly scopes to them.
      p.pendingWith && (p.pendingWith === 'direct_manager' || p.pendingWith === 'hr_admin')
        ? sql`(select approver_kind from leave_approval_step s where s.leave_request_id = leave_request.id and s.status = 'pending' order by s.step_index limit 1) = ${p.pendingWith}`
        : undefined,
      // Leave-date window uses OVERLAP semantics so "July 2026" catches leave spanning a month boundary:
      // startDate <= to AND endDate >= from.
      p.to ? lte(leaveRequest.startDate, p.to) : undefined,
      p.from ? gte(leaveRequest.endDate, p.from) : undefined,
      // Application-date range compares on created_at::date (calendar day, TZ-agnostic for the admin view).
      p.appliedFrom ? sql`${leaveRequest.createdAt}::date >= ${p.appliedFrom}` : undefined,
      p.appliedTo ? sql`${leaveRequest.createdAt}::date <= ${p.appliedTo}` : undefined,
      // Employee Leave Record (feedback 953be4b0) asks to search by leave CODE alongside employee id/name,
      // so the code joins the existing OR. Widening only — every term that matched before still matches.
      q
        ? isRef
          ? sql`(${person.fullName} ilike ${'%' + q + '%'} or ${employment.employeeCode} ilike ${'%' + q + '%'} or ${leaveType.code} ilike ${'%' + q + '%'} or ${leaveRequest.id}::text ilike ${refTerm + '%'})`
          : sql`(${person.fullName} ilike ${'%' + q + '%'} or ${employment.employeeCode} ilike ${'%' + q + '%'} or ${leaveType.code} ilike ${'%' + q + '%'})`
        : undefined,
    );
    // Sort whitelist — NEVER interpolate user input into the ORDER BY.
    const sortCol: Record<string, AnyColumn> = {
      applied: leaveRequest.createdAt,
      start: leaveRequest.startDate,
      end: leaveRequest.endDate,
      name: person.fullName,
      status: leaveRequest.status,
    };
    const col = sortCol[p.sort ?? 'applied'] ?? leaveRequest.createdAt;
    const dir = p.dir === 'asc' ? asc : desc;
    const rows = await tx
      .select(leaveRequestSelection)
      .from(leaveRequest)
      .innerJoin(employment, eq(employment.id, leaveRequest.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
      .leftJoin(assignment, currentAssignment)
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .where(where)
      .orderBy(dir(col), desc(leaveRequest.createdAt))
      .limit(p.limit)
      .offset(p.offset);
    // count(distinct leave_request.id): the assignment join is ≤1/employment, but distinct is the safe guard.
    const [{ count }] = await tx
      .select({ count: sql<number>`count(distinct ${leaveRequest.id})::int` })
      .from(leaveRequest)
      .innerJoin(employment, eq(employment.id, leaveRequest.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
      .leftJoin(assignment, currentAssignment)
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .where(where);
    const withDates = await resolveLeaveWorkingDates(tx, rows);
    return { rows: withDates, total: Number(count) };
  });
}

/**
 * Approval Information filter — distinct people who have DECIDED (final approver/rejecter) at least one
 * leave request in scope, so the /leave admin "Approved by" filter can offer a named-person picker.
 * Scoped by the REQUESTER's company (the same `companyIds` fence the history uses), and RLS trims further.
 * Read-only (feedback 0773bda9). "Pending with" is by role (approver_kind), not a named person, so it needs
 * no options query — the two stage values are fixed in the page.
 */
export function listLeaveApprovers(ctx: SessionContext, companyIds?: string[]) {
  return withTenant(ctx, async (tx) => {
    const decider = alias(employment, 'decider_emp');
    const deciderPerson = alias(person, 'decider_person');
    const rows = await tx
      .selectDistinct({ id: decider.id, name: deciderPerson.fullName })
      .from(leaveRequest)
      .innerJoin(employment, eq(employment.id, leaveRequest.employmentId))
      .innerJoin(decider, eq(decider.id, leaveRequest.decidedByEmploymentId))
      .innerJoin(deciderPerson, eq(deciderPerson.id, decider.personId))
      .where(
        companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined,
      );
    return rows.sort((a, b) => a.name.localeCompare(b.name));
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
    // R51 (baf56348): same org-coverage trim as listLeaveRequests (a cancellation is a leave pending item).
    const scoped = await filterDelegationOrgScopeTx(tx, ctx, rows, (r) => r.employmentId);
    return scoped.map(({ i18n, cancelDates, ...r }) => {
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
 *  `today` yields no candidate dates (candidateCancelDates=[]) — the affordance simply never renders.
 *
 *  eae550e9 step 1: `opts.personIds` narrows the read to those PEOPLE (the dashboard passes the viewer +
 *  direct reports instead of loading every active employee in the company). Scoped by PERSON id, not
 *  employment id, so a person's concurrent second employment is never dropped from the merged row below.
 *  Omitting the option is byte-identical to today's full-scope behaviour. NOTE the deliberate departure
 *  from the neighbouring `companyIds && companyIds.length` idiom: an EMPTY personIds array must match
 *  NOTHING (the caller resolved "no viewer person"), never degrade to the whole company. */
const NEVER_MATCHING_PERSON_ID = '00000000-0000-0000-0000-000000000000';
export function plannedAbsences(
  ctx: SessionContext,
  companyIds: string[] | undefined,
  range: { from: string; to: string },
  today?: string,
  opts?: { personIds?: string[] },
) {
  const personIds = opts?.personIds;
  const personScope =
    personIds === undefined
      ? undefined
      : inArray(employment.personId, personIds.length ? personIds : [NEVER_MATCHING_PERSON_ID]);
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
          personScope,
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
        // Leave Calendar Blocked View (c238010b): the hourly window, so the dashboard calendar can render an
        // hourly pill's exact start/end in its hover tooltip. NULL for full/half-day rows (time cols unset).
        fromTime: leaveRequest.fromTime,
        toTime: leaveRequest.toTime,
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
          // eae550e9: same person filter as the emps query (this one already innerJoins employment), so
          // the two selections stay one scope.
          personScope,
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
      // ee55f5fe step 2 — the per-leave N+1 fix that makes Month View viable. The old loop resolved the
      // roster + holiday set PER LEAVE (2 sequential round-trips each — Promise.all does not parallelise
      // on one tx). Group the ELIGIBLE leaves by employment and resolve each employment's roster + union-
      // range holiday set ONCE via workingDatesForSpans: round-trips scale with the number of employments
      // that have eligible leave, independent of leave count. Ineligible rows simply have no map entry —
      // candidatesFor() already defaults them to []. Per-span results are byte-identical to the old
      // workingDatesForSpan path; the per-date-approval filter + `d > today` cut apply after, unchanged.
      const eligible = leaves.filter(
        (l) =>
          l.status === 'approved' &&
          l.durationType === 'full_day' &&
          (l.parentGroupId == null || l.isCancellationSplit) &&
          !l.pendingCancellationId,
      );
      const byEmployment = new Map<string, typeof eligible>();
      for (const l of eligible) {
        const arr = byEmployment.get(l.employmentId);
        if (arr) arr.push(l);
        else byEmployment.set(l.employmentId, [l]);
      }
      for (const [employmentId, empLeaves] of byEmployment) {
        const spanDates = await workingDatesForSpans(
          tx,
          employmentId,
          empLeaves.map((l) => ({ start: l.startDate, end: l.endDate })),
        );
        for (const l of empLeaves) {
          let working = spanDates.get(`${l.startDate}|${l.endDate}`) ?? [];
          // Per-date-approval request (has date rows): restrict to the APPROVED interior dates only.
          if (hasDateRows.has(l.id)) {
            const approvedSet = new Set(approvedDatesByReq.get(l.id) ?? []);
            working = working.filter((d) => approvedSet.has(d));
          }
          candidateByReq.set(
            l.id,
            working.filter((d) => d > today),
          );
        }
      }
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
    // `employmentIds` carries every employment behind the person (My/Team calendar filter, item 8c739dda):
    // Team view keeps rows whose employment set intersects the viewer's reporting team, INCLUDING people with
    // no leave in the window (empty rows), which a per-leave employmentId alone could not express.
    const byPerson = new Map<string, { id: string; name: string; employeeCode: string | null; role: string | null; employmentIds: string[]; leaves: Leave[] }>();
    for (const e of emps) {
      const empLeaves = byEmp.get(e.employmentId) ?? [];
      const existing = byPerson.get(e.personId);
      if (existing) {
        existing.leaves.push(...empLeaves);
        existing.employmentIds.push(e.employmentId);
        if (!existing.role && e.role) existing.role = e.role;
        // First non-null Employee ID wins for a person spanning concurrent employments (feedback 38668d9b).
        if (!existing.employeeCode && e.employeeCode) existing.employeeCode = e.employeeCode;
      } else {
        byPerson.set(e.personId, { id: e.personId, name: e.name, employeeCode: e.employeeCode, role: e.role, employmentIds: [e.employmentId], leaves: empLeaves });
      }
    }
    return [...byPerson.values()];
  });
}

/**
 * eae550e9 step 2 — the dedicated narrow count behind the manager "Team Away Today" card. Replaces the
 * second full plannedAbsences projection (which existed only to guarantee a window covering today):
 * count DISTINCT persons — excluding the viewer — with an APPROVED leave covering `todayIso` on an
 * ACTIVE employment in scope. Population matches what teamAwayToday(lib/dashboard-cards.ts) counted
 * over the company-scoped strip rows bit-for-bit, including the per-date-approval nuance: a request
 * with per-date rows only covers today when TODAY's date row is itself approved (mirrors the
 * approved-run expansion in plannedAbsences above). RLS additionally trims rows exactly as it does
 * for the strip read, so the figure cannot widen past what the viewer could already see.
 */
export function awayTodayCount(
  ctx: SessionContext,
  companyIds: string[] | undefined,
  todayIso: string,
  excludePersonId?: string | null,
): Promise<number> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ n: sql<number>`count(distinct ${employment.personId})::int` })
      .from(leaveRequest)
      .innerJoin(employment, eq(employment.id, leaveRequest.employmentId))
      .where(
        and(
          eq(leaveRequest.status, 'approved'),
          lte(leaveRequest.startDate, todayIso),
          gte(leaveRequest.endDate, todayIso),
          isNull(employment.terminatedOn),
          companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined,
          excludePersonId ? sql`${employment.personId} <> ${excludePersonId}` : undefined,
          // ADR-0068 §4A parity: a per-date-approval request (has date rows) covers today only when
          // today's own date row is approved — a mid-span rejected date is not an absence.
          sql`(
            not exists (select 1 from leave_request_date d where d.leave_request_id = ${leaveRequest.id})
            or exists (
              select 1 from leave_request_date d
              where d.leave_request_id = ${leaveRequest.id} and d.leave_date = ${todayIso} and d.status = 'approved'
            )
          )`,
        ),
      );
    return row?.n ?? 0;
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
        hiredOn: employment.hiredOn,
        // Employee Status sync (5afcda91): project the lifecycle inputs so the dashboard badge shows the
        // SAME system-derived Employee Status as the Personnel screens (deriveEmploymentStatus), instead
        // rather than any stored column — R81 dropped assignment.status along with its retired values.
        confirmationDate: employment.confirmationDate,
        finalConfirmationDate: employment.finalConfirmationDate,
        // R81 — the probation fallbacks. Nothing writes a confirmation date at hire, so without these two
        // a new hire serving probation derived to "Active" on day one. See core/employment-status.ts.
        probationEndDate: employment.probationEndDate,
        provisionalEndOn: employment.provisionalEndOn,
        resignationDate: employment.resignationDate,
        lastWorkingDate: employment.lastWorkingDate,
        terminatedOn: employment.terminatedOn,
        blacklistedAt: employment.blacklistedAt,
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

/**
 * Company-change gate (feedback 9464bd56) — TRUE when this employment has at least one operational
 * transaction, i.e. it is PAST the pre-activity window where HR may still inline-correct its Company.
 * One greppable `exists(...) or exists(...)` chain, ONE representative head per operational module (children
 * hang off these), matching the house `inUse` idiom (see listCompanies / listDepartments / listLeaveTypes).
 *
 * A saved salary (compensation) counts as activity: `compensation.set` already lands in movement history, so
 * treating a salaried-but-unpaid employee as "no activity yet" would contradict steering HR to Movement once
 * anything is recorded.
 *
 * leave_ledger: the SINGLE hire-time grant (entry_type='accrual' AND effective_on=hired_on — the row
 * hireEmployee auto-inserts) is EXCLUDED. Any later accrual, or any adjustment/debit/in_lieu row (even an
 * opening-balance adjustment stamped at hire), counts as activity and locks the field — conservative by
 * intent.
 *
 * MODULE HEADS — one per operational module. A NEW operational module MUST add its head HERE (single edit
 * site, so the next module cannot silently punch a hole):
 *   payroll   → payslip · payroll_input · employee_cp38 · employment_pay_component · ea_override
 *   attendance→ attendance            leave → leave_request · leave_cancellation_request · non-hire leave_ledger
 *   claims    → claim_request         overtime → toil_accrual        loans → employee_loan
 *   travel    → travel_request        roster   → roster_assignment   performance → performance_review
 *   offboarding → resignation_request probation → employment_review  compensation → compensation (a saved salary)
 *
 * Runs inside the caller's tx so the company-change writer can re-run the gate as its server-side source of
 * truth without a nested transaction. RLS still scopes every sub-select to the tenant.
 */
export async function employmentCompanyBlockedTx(tx: Tx, employmentId: string): Promise<boolean> {
  const [res] = await tx
    .select({
      blocked: sql<boolean>`(
        exists (select 1 from payslip t where t.employment_id = ${employmentId})
        or exists (select 1 from payroll_input t where t.employment_id = ${employmentId})
        or exists (select 1 from employee_cp38 t where t.employment_id = ${employmentId})
        or exists (select 1 from employment_pay_component t where t.employment_id = ${employmentId})
        or exists (select 1 from ea_override t where t.employment_id = ${employmentId})
        or exists (select 1 from attendance t where t.employment_id = ${employmentId})
        or exists (select 1 from leave_request t where t.employment_id = ${employmentId})
        or exists (select 1 from leave_cancellation_request t where t.employment_id = ${employmentId})
        or exists (select 1 from leave_ledger t where t.employment_id = ${employmentId} and not (t.entry_type = 'accrual' and t.effective_on = ${employment.hiredOn}))
        or exists (select 1 from claim_request t where t.employment_id = ${employmentId})
        or exists (select 1 from toil_accrual t where t.employment_id = ${employmentId})
        or exists (select 1 from employee_loan t where t.employment_id = ${employmentId})
        or exists (select 1 from travel_request t where t.employment_id = ${employmentId})
        or exists (select 1 from roster_assignment t where t.employment_id = ${employmentId})
        or exists (select 1 from performance_review t where t.employment_id = ${employmentId})
        or exists (select 1 from resignation_request t where t.employment_id = ${employmentId})
        or exists (select 1 from employment_review t where t.employment_id = ${employmentId})
        or exists (select 1 from compensation t where t.employment_id = ${employmentId})
      )`,
    })
    .from(employment)
    .where(eq(employment.id, employmentId))
    .limit(1);
  return !!res?.blocked;
}

/**
 * Company-change gate (feedback 9464bd56) — is this employment still in the pre-transaction window where HR
 * may inline-correct its Company? True ONLY when it exists AND has no operational transactions
 * (employmentCompanyBlockedTx). Admin-only surface (the Personnel page only calls it for an admin viewer);
 * RLS scopes the read to the tenant. NOT folded into employeeDetail: it would run for every viewer including
 * non-admins who can never edit, and dozens of tests toEqual that projection row.
 */
export function employmentCompanyEditable(ctx: SessionContext, employmentId: string): Promise<boolean> {
  return withTenant(ctx, async (tx) => {
    const [emp] = await tx
      .select({ id: employment.id })
      .from(employment)
      .where(eq(employment.id, employmentId))
      .limit(1);
    if (!emp) return false;
    return !(await employmentCompanyBlockedTx(tx, employmentId));
  });
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
        // "Join Date" (feedback 24c4d02e) — current-company effective join; null = not captured (service
        // length then falls back to hiredOn).
        joinDate: employment.joinDate,
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
        // 8c284478 — Salutation (catalog-backed, before Full Name on the form); projected here so reports,
        // correspondence and document templates can consume it as those features grow.
        salutation: person.salutation,
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
        // 3a25f5ee — Permanent + Correspondence structured addresses (migration 0213).
        permanentAddressLine1: person.permanentAddressLine1,
        permanentAddressLine2: person.permanentAddressLine2,
        permanentAddressLine3: person.permanentAddressLine3,
        permanentPostcode: person.permanentPostcode,
        permanentCity: person.permanentCity,
        permanentState: person.permanentState,
        permanentCountry: person.permanentCountry,
        correspondenceAddressLine1: person.correspondenceAddressLine1,
        correspondenceAddressLine2: person.correspondenceAddressLine2,
        correspondenceAddressLine3: person.correspondenceAddressLine3,
        correspondencePostcode: person.correspondencePostcode,
        correspondenceCity: person.correspondenceCity,
        correspondenceState: person.correspondenceState,
        correspondenceCountry: person.correspondenceCountry,
        // bf953339 — Mobile + Home phone pair (migration 0304): `phone` above IS the mobile number;
        // homePhone sits beside it, and the Correspondence block carries its own independent pair.
        homePhone: person.homePhone,
        correspondenceMobilePhone: person.correspondenceMobilePhone,
        correspondenceHomePhone: person.correspondenceHomePhone,
        // 23ad620e — an employee may now hold SEVERAL emergency contacts (person_emergency_contact). These
        // five names are kept exactly as they were so every consumer of employeeDetail is untouched; they
        // now resolve to the HIGHEST-PRIORITY live record (Primary → Secondary → Other) instead of the
        // retired person.emergency_contact_* columns. The full list is read with listEmergencyContacts.
        emergencyContactName: primaryEmergencyContactSql('full_name'),
        emergencyContactRelationship: primaryEmergencyContactSql('relationship'),
        emergencyContactPhone: primaryEmergencyContactSql('mobile_phone'),
        emergencyContactPhone2: primaryEmergencyContactSql('home_phone'),
        emergencyContactAddress: primaryEmergencyContactSql('address'),
        // 2.1 Payroll Policy: the assigned named pay-processing template (null = monthly default).
        payrollPolicyId: employment.payrollPolicyId,
        payrollPolicyName: payrollPolicy.name,
        payrollPolicyStatus: payrollPolicy.status,
        // R46 79eb7151 — HOW this employee is paid (bank transfer / cheque / cash). Null = not specified.
        paymentMethod: employment.paymentMethod,
        // ec4cbf63: the employee's DEFAULT shift (null = company default schedule) — profile assignment.
        defaultShiftId: employment.defaultShiftId,
        // R17 3e8350db: the shift ARRANGEMENT — 'fixed' (follows defaultShiftId) or 'roster' (scheduled
        // from /roster only). Kept in lockstep with defaultShiftId by assignEmployeeShift.
        shiftType: employment.shiftType,
        // ADR-0054: the location on the employee's CURRENT open assignment (null = none).
        locationId: location.id,
        locationCode: location.code,
        locationName: location.name,
        // ADR-0070: per-employee Clocking Location & Geofencing enforcement toggle + radius.
        geofencingEnabled: employment.geofencingEnabled,
        geofenceRadiusM: employment.geofenceRadiusM,
        // Employment Information enhancement (2323f671, migration 0181): employment master-data captured on
        // the Employment tab's Employment Information card (all nullable; null = not set).
        probationMonths: employment.probationMonths,
        probationDays: employment.probationDays,
        confirmationDate: employment.confirmationDate,
        resignationNoticeMonths: employment.resignationNoticeMonths,
        resignationNoticeDays: employment.resignationNoticeDays,
        resignationDate: employment.resignationDate,
        shortNoticeMonths: employment.shortNoticeMonths,
        shortNoticeDays: employment.shortNoticeDays,
        // Enhance Employment Dates (955c7de4, migration 0213): redesigned value+unit periods + lifecycle
        // dates. finalConfirmationDate is derived server-side (= extended ?? normal) on save.
        probationValue: employment.probationValue,
        probationUnit: employment.probationUnit,
        extendedProbationValue: employment.extendedProbationValue,
        extendedProbationUnit: employment.extendedProbationUnit,
        noticeBeforeConfirmationValue: employment.noticeBeforeConfirmationValue,
        noticeBeforeConfirmationUnit: employment.noticeBeforeConfirmationUnit,
        noticeAfterConfirmationValue: employment.noticeAfterConfirmationValue,
        noticeAfterConfirmationUnit: employment.noticeAfterConfirmationUnit,
        extendedConfirmationDate: employment.extendedConfirmationDate,
        finalConfirmationDate: employment.finalConfirmationDate,
        // R81 — the probation fallbacks deriveEmploymentStatus needs. Nothing writes a confirmation date at
        // hire, so without these two an employee serving probation reads "Active" on their own profile.
        probationEndDate: employment.probationEndDate,
        provisionalEndOn: employment.provisionalEndOn,
        tenderResignationDate: employment.tenderResignationDate,
        lastWorkingDate: employment.lastWorkingDate,
        orgBranch: employment.orgBranch,
        orgDivision: employment.orgDivision,
        orgRegion: employment.orgRegion,
        orgLine: employment.orgLine,
        orgSection: employment.orgSection,
        orgTeam: employment.orgTeam,
        orgBase: employment.orgBase,
        employmentCategory: employment.employmentCategory,
        // Employee Status redesign (R43 c26c3ce5) — the Blacklist override read by deriveEmploymentStatus
        // (null = not blacklisted). The derived buckets themselves need no column (they are pure functions of
        // the lifecycle dates already projected above + today).
        blacklistedAt: employment.blacklistedAt,
        blacklistReason: employment.blacklistReason,
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
        // e3c733df — MUST be projected or the Description cell renders empty on every reload, the same
        // trap the leave-type projection documents field by field.
        description: jobGrade.description,
        rank: jobGrade.rank,
        archivedAt: jobGrade.archivedAt,
        // Grade relocation to System Labels (b1b81a08): the in-use predicate spans ALL FIVE referencing
        // tables, not just employment + leave_policy. leave_approval_policy.grade_id and
        // claim_policy.grade_id are plain FKs with no onDelete, so a grade used only by an approval rule or
        // a claim limit used to report inUse=false, render an ENABLED Delete, and raise a raw 23503 at the
        // admin; grade_group_member CASCADES, so the same delete silently dropped benefit-scheme group
        // membership. Must stay byte-identical to deleteJobGrade's in-transaction re-check (core/admin.ts)
        // so the button state and the guard agree.
        inUse: sql<boolean>`exists (select 1 from employment e where e.grade_id = job_grade.id)
          or exists (select 1 from leave_policy lp where lp.grade_id = job_grade.id)
          or exists (select 1 from leave_approval_policy lap where lap.grade_id = job_grade.id)
          or exists (select 1 from claim_policy cp where cp.grade_id = job_grade.id)
          or exists (select 1 from grade_group_member ggm where ggm.grade_id = job_grade.id)`,
      })
      .from(jobGrade)
      .where(opts.includeArchived ? undefined : isNull(jobGrade.archivedAt))
      .orderBy(jobGrade.rank, jobGrade.name),
  );
}

/**
 * Feedback 9d8cf621 — "Employee Selection" entitled-employee count. Count ACTIVE (not-terminated)
 * employments whose company and/or grade fall within the selected scope, so HR sees how many people an
 * entitlement they are about to save would cover. An empty companyIds/gradeIds axis means "all" on that
 * axis (a group-default / all-grades scope). RLS scopes the result to the session's tenant + visible
 * companies via withTenant. READ-ONLY — no DomainEvent (documented skip).
 */
export function countEmployeesInScope(
  ctx: SessionContext,
  p: { companyIds?: string[]; gradeIds?: string[] },
): Promise<number> {
  const companyIds = (p.companyIds ?? []).filter(Boolean);
  const gradeIds = (p.gradeIds ?? []).filter(Boolean);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ count: sql<number>`count(distinct ${employment.id})::int` })
      .from(employment)
      .where(
        and(
          isNull(employment.terminatedOn),
          companyIds.length ? inArray(employment.companyId, companyIds) : undefined,
          gradeIds.length ? inArray(employment.gradeId, gradeIds) : undefined,
        ),
      );
    return row?.count ?? 0;
  });
}

/** All effective-dated assignment versions (newest first) — the bitemporal history. */
export function assignmentHistory(ctx: SessionContext, employmentId: string) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: assignment.id,
        department: department.name,
        departmentId: assignment.departmentId,
        position: position.title,
        positionId: assignment.positionId,
        // 1001ff61 — Business Unit on the assignment (nullable). Drives the Form A BU dropdown's default.
        businessUnitId: assignment.businessUnitId,
        // 570e3311 — BU display name (additive), so the detail page can label a pinned-current BU that is
        // no longer in the company-scoped option list (legacy / later-unshared data).
        businessUnit: businessUnit.name,
        // R81 (9cbf5e0d): no `status` here any more — the column is dropped (migration 0331). This read
        // powers the dated org history (department / position / BU / type), which is what actually varies
        // per version; the Movement tab replaced the old status column in this table back at 78853b97, so
        // nothing rendered it. Current Employee Status is derived, once, from the lifecycle dates.
        employmentType: assignment.employmentType,
        validFrom: assignment.validFrom,
        validTo: assignment.validTo,
      })
      .from(assignment)
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .leftJoin(position, eq(position.id, assignment.positionId))
      .leftJoin(businessUnit, eq(businessUnit.id, assignment.businessUnitId))
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
        // Employee Leave View Configuration (65dec703): per-component ESS visibility for this leave type,
        // resolved (missing key ⇒ visible). Placeholder = all-visible; overwritten in the final pass once
        // the active-type configs are fetched below, so render sites gate without a second query.
        essView: resolveEssView(null) as ResolvedEssView,
        // Leave Type Visual Configuration (639fdf77): DISPLAY-ONLY colour theme + icon + code, filled in the
        // final pass below (one select over the seen type ids). null ⇒ default styling / code-keyed icon.
        color: null as string | null,
        icon: null as string | null,
        code: null as string | null,
        // Leave grouping visibility (b653ac1b): the HR-resolved placement ('primary'|'secondary'|'hidden')
        // for this type on the /me Leave tab. Placeholder; overwritten in the final pass once code +
        // ess_placement + visible_to_employee are known (resolvePlacement, lib/leave-groups.ts). The planned
        // cards-and-groups renderer (6d78f373) reads this to decide the type's card/group/hidden slot.
        placement: 'secondary' as EssPlacement,
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
        essView: resolveEssView(null) as ResolvedEssView,
        color: null as string | null,
        icon: null as string | null,
        code: null as string | null,
        // Leave grouping visibility (b653ac1b): placeholder, overwritten in the final pass. See rows.map above.
        placement: 'secondary' as EssPlacement,
      });
      seen.add(p.leaveTypeId);
    }
    // 2F-1 (R18): surface every active leave type the employee is ELIGIBLE for — even with no activity
    // yet — so the list is the full menu, not just types they've already accrued or requested.
    const [types, [emp]] = await Promise.all([
      tx
        .select({ id: leaveType.id, name: leaveType.name, eligibility: leaveType.eligibility, i18n: leaveType.i18n, essViewConfig: leaveType.essViewConfig, visibleToEmployee: leaveType.visibleToEmployee, essPlacement: leaveType.essPlacement })
        .from(leaveType)
        .where(isNull(leaveType.archivedAt)),
      tx
        .select({ gender: person.gender, marital: person.maritalStatus, hiredOn: employment.hiredOn, orgDivision: employment.orgDivision, orgBranch: employment.orgBranch, orgRegion: employment.orgRegion, orgLine: employment.orgLine, orgSection: employment.orgSection, orgTeam: employment.orgTeam, orgBase: employment.orgBase, employmentCategory: employment.employmentCategory })
        .from(employment)
        .innerJoin(person, eq(person.id, employment.personId))
        .where(eq(employment.id, employmentId))
        .limit(1),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    for (const lt of types) {
      if (seen.has(lt.id)) continue;
      if (!isLeaveEligible(lt.eligibility as LeaveEligibility | null, emp, today)) continue;
      out.push({ leaveTypeId: lt.id, leaveType: lt.name, accrued: 0, taken: 0, pending: 0, balance: 0, available: 0, essView: resolveEssView(null) as ResolvedEssView, color: null as string | null, icon: null as string | null, code: null as string | null, placement: 'secondary' as EssPlacement });
    }
    // R37 (2F-2): resolve every leave-type name to the viewer's locale (active types come from `types`;
    // archived types with old ledger entries fall back to their stored English name).
    const localName = new Map(types.map((t) => [t.id, pickName(t.name, t.i18n, locale)]));
    // Employee Leave View Configuration (65dec703): resolve each active type's ESS-view config (missing ⇒
    // all-visible). Archived types with only old ledger entries keep the all-visible placeholder set above.
    const essViewByType = new Map(types.map((t) => [t.id, resolveEssView(t.essViewConfig as Record<string, boolean> | null)]));
    // Leave Type Visual Configuration Enhancement (639fdf77): one select over every seen type id (active OR
    // archived-with-old-ledger) for the DISPLAY-ONLY colour / icon / code. Attached below so the ESS Leave
    // tab can render the icon + colour chip. This does NOT touch any sum / ledger / entitlement math above —
    // it is a pure presentation join. null ⇒ default styling + code-keyed icon (via lib/leave-visual.ts).
    const seenIds = out.map((r) => r.leaveTypeId);
    // Leave grouping visibility (b653ac1b): select ess_placement + visible_to_employee alongside the visual
    // columns so EVERY seen type (active OR archived-with-old-ledger) has what resolvePlacement needs, in one
    // query. Archived types (absent from `types`) thus still resolve to their code-keyed default.
    const visualByType = new Map<
      string,
      { color: string | null; icon: string | null; code: string | null; essPlacement: string | null; visibleToEmployee: boolean | null }
    >();
    if (seenIds.length > 0) {
      const visuals = await tx
        .select({ id: leaveType.id, color: leaveType.color, icon: leaveType.icon, code: leaveType.code, essPlacement: leaveType.essPlacement, visibleToEmployee: leaveType.visibleToEmployee })
        .from(leaveType)
        .where(inArray(leaveType.id, seenIds));
      for (const v of visuals) visualByType.set(v.id, { color: v.color, icon: v.icon, code: v.code, essPlacement: v.essPlacement, visibleToEmployee: v.visibleToEmployee });
    }
    for (const r of out) {
      r.leaveType = localName.get(r.leaveTypeId) ?? r.leaveType;
      r.essView = essViewByType.get(r.leaveTypeId) ?? r.essView;
      const v = visualByType.get(r.leaveTypeId);
      if (v) {
        r.color = v.color;
        r.icon = v.icon;
        r.code = v.code;
      }
      // Leave grouping visibility (b653ac1b): resolve the HR-editable placement for this type. Precedence
      // (single source of truth for hidden = visible_to_employee): flag false ⇒ 'hidden'; else an explicit
      // ess_placement ('primary'|'secondary') wins; else the code-keyed default (lib/leave-groups.ts). This
      // is PRESENTATION metadata only — it does not filter `out` here (7b11f1c1's flag gate below owns the
      // ESS drop); the planned 6d78f373 cards-and-groups renderer consumes r.placement.
      r.placement = resolvePlacement(v?.code ?? r.code, v?.essPlacement ?? null, v?.visibleToEmployee ?? null);
    }
    // Leave Type Employee Visibility (7b11f1c1) — visibility gate. HR can hide a whole leave type from the
    // /me Leave tab (visible_to_employee=false) — its balance, its pending request, and its no-activity menu
    // entry all disappear. SINGLE choke point covering all three ways a row enters `out` (ledger rows, the
    // pending-only tail, the eligible-no-activity tail): build the hidden-type-id set from the active `types`
    // select and filter `out` once here. NULL ⇒ visible (backward compatible). Archived types (present only
    // via old ledger rows, not in `types`) are never flagged hidden — they already surface as today. Gating
    // is /me ONLY; admin/HR balance reads (leaveBalancesAll) do not call this and are never gated. Because a
    // hidden type is dropped here, leaveEntitlementBreakdown is never requested for it downstream (it is
    // called per surviving balance row), so no separate change is needed there.
    const hiddenTypeIds = new Set(types.filter((t) => t.visibleToEmployee === false).map((t) => t.id));
    const visible = hiddenTypeIds.size === 0 ? out : out.filter((r) => !hiddenTypeIds.has(r.leaveTypeId));
    return visible.sort((a, b) => a.leaveType.localeCompare(b.leaveType));
  });
}

// ── Manager Leave Summary (item 726ac8c2) ─────────────────────────────────────────────────────────
/** One leave type on the read-only Leave Summary section of a subordinate's Personnel profile. */
export type SubordinateLeaveSummaryRow = {
  leaveTypeId: string;
  leaveType: string;
  /** Ledger balance — the SAME figure `leaveBalances` shows the employee on their own Leave page. */
  balance: number;
  /** Requests awaiting a decision: a COUNT OF REQUESTS, not the sum of days `leaveBalances.pending` holds. */
  pendingCount: number;
  /** Next approved leave that has not finished yet (inclusive span), or null. */
  upcomingFrom: string | null;
  upcomingTo: string | null;
};

/**
 * Manager Leave Summary (item 726ac8c2) — the read behind the Leave Summary section on a subordinate's
 * Personnel profile.
 *
 * The reporting-hierarchy restriction is enforced HERE, on the data, and not by hiding the section:
 * a UI-only check would let a manager read another manager's reports' balances by editing the
 * employment id in the URL. The gate is the manager branch of `app.can_see_employment` (migration 0109)
 * verbatim — the same recursive `app.is_admin_report_of` predicate, resolved over EVERY employment the
 * caller holds — so the section's reach can never drift from the RLS reach it sits inside. `null` ⇒ the
 * caller does not manage this employment and the page renders nothing.
 *
 * The gate is deliberately NARROWER than RLS: self and plain HR-admin viewers get `null` too, because
 * this is a manager affordance. An employee already has their own Leave page and an admin already has
 * the full balance card on /admin/personnel; neither needs a second, thinner copy here.
 *
 * Balances come from `leaveBalances` — the resolver the employee's own Leave page uses — so a manager
 * and an employee can never read different numbers for the same leave type.
 */
export async function subordinateLeaveSummary(
  ctx: SessionContext,
  employmentId: string,
  todayIso: string,
  locale?: string,
): Promise<SubordinateLeaveSummaryRow[] | null> {
  const managed = await withTenant(ctx, async (tx) => {
    const res = await tx.execute(sql`
      select exists (
        select 1 from employment me
          join app_user u on u.person_id = me.person_id
        where u.id = app.current_user_id()
          and me.tenant_id = app.current_tenant_id()
          and me.terminated_on is null
          and app.is_admin_report_of(${employmentId}::uuid, me.id)
      ) as ok
    `);
    return (res as unknown as { ok: boolean }[])[0]?.ok === true;
  });
  if (!managed) return null;

  const balances = await leaveBalances(ctx, employmentId, locale);
  if (balances.length === 0) return [];

  return withTenant(ctx, async (tx) => {
    const [pending, dated, spans] = await Promise.all([
      tx
        .select({ leaveTypeId: leaveRequest.leaveTypeId, n: sql<string>`count(*)` })
        .from(leaveRequest)
        .where(and(eq(leaveRequest.employmentId, employmentId), eq(leaveRequest.status, 'pending')))
        .groupBy(leaveRequest.leaveTypeId),
      // Per-date-approval requests (ADR-0068): only the dates that were actually APPROVED count as
      // upcoming, so a partially-rejected span never advertises days the employee is not taking.
      tx
        .select({
          leaveTypeId: leaveRequest.leaveTypeId,
          requestId: leaveRequest.id,
          from: sql<string>`min(${leaveRequestDate.leaveDate})`,
          to: sql<string>`max(${leaveRequestDate.leaveDate})`,
        })
        .from(leaveRequestDate)
        .innerJoin(leaveRequest, eq(leaveRequest.id, leaveRequestDate.leaveRequestId))
        .where(
          and(
            eq(leaveRequest.employmentId, employmentId),
            eq(leaveRequestDate.status, 'approved'),
            gte(leaveRequestDate.leaveDate, todayIso),
          ),
        )
        .groupBy(leaveRequest.leaveTypeId, leaveRequest.id),
      // Whole-span requests (no per-date rows) — the (a)/(b) split approvedLeaveDates uses. Unlike that
      // helper this does NOT filter to full_day: a manager planning cover wants to see an upcoming
      // half-day or hourly absence too; "is this person out all day" is a different question.
      tx
        .select({
          leaveTypeId: leaveRequest.leaveTypeId,
          from: leaveRequest.startDate,
          to: leaveRequest.endDate,
        })
        .from(leaveRequest)
        .where(
          and(
            eq(leaveRequest.employmentId, employmentId),
            eq(leaveRequest.status, 'approved'),
            gte(leaveRequest.endDate, todayIso),
            sql`NOT EXISTS (SELECT 1 FROM leave_request_date x WHERE x.leave_request_id = ${leaveRequest.id})`,
          ),
        ),
    ]);
    const pendingBy = new Map(pending.map((p) => [p.leaveTypeId, Number(p.n)]));
    // Earliest-starting upcoming span per type. Both sources feed the same reduction, so a type that has
    // one of each keeps whichever starts first.
    const upcomingBy = new Map<string, { from: string; to: string }>();
    for (const r of [...dated, ...spans]) {
      const prev = upcomingBy.get(r.leaveTypeId);
      if (!prev || r.from < prev.from) upcomingBy.set(r.leaveTypeId, { from: r.from, to: r.to });
    }
    return balances.map((b) => ({
      leaveTypeId: b.leaveTypeId,
      leaveType: b.leaveType,
      balance: b.balance,
      pendingCount: pendingBy.get(b.leaveTypeId) ?? 0,
      upcomingFrom: upcomingBy.get(b.leaveTypeId)?.from ?? null,
      upcomingTo: upcomingBy.get(b.leaveTypeId)?.to ?? null,
    }));
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
   *  breakdown reconciles with `balance` (accrual aggregates exclude `adjustment`). 0 when none.
   *  COMMINGLED by construction (positive-or-recalc filter) — kept for the balance TABLE's Adjustment column
   *  and its existing callers. The panel's Adjustment line now reads `configAdjustments` instead (0315dac7). */
  otherAdjustments: number;
  /** Signed ledger balance as at asOf (Σ days over every row ≤ asOf) — the headline figure the
   *  RECONCILIATION PARTITION below closes onto. Same expression leaveBalances/leaveBalancesAll use. */
  balance: number;
  /** Pending (not-yet-approved) request days for this (employment, type) — `balance − pendingApproval =
   *  totalAvailable`, the last line of the reconciliation block. */
  pendingApproval: number;
  // ── Reconciliation partition (feedback 0315dac7) ────────────────────────────────────────────────────
  // The six DISJOINT buckets every ledger row ≤ asOf falls into EXACTLY ONE of, so the identity
  //   broughtForward + currentYearEntitlement + configAdjustments + systemAdjustments
  //     − forfeitedThisCycle − takenThisCycle = balance
  // closes BY CONSTRUCTION rather than by re-deriving the carry arithmetic. That matters: the derived
  // identity (carriedForward/forfeited from resolveCarryBreakdown) is algebraically FALSE whenever a
  // year-open cap forfeit fired — openLeaveYear posts a real negative `adjustment`
  // (CARRY_FORFEIT_REASON_CAP) while `carried` is already post-cap AND `forfeited` re-adds the cap excess,
  // double-subtracting it. The same holds for the maxBalanceDays clamp and an overdrawn (negative) carry-in.
  // Sourcing every bucket from the RAW rows makes those divergences vanish.
  /** Σ days over rows dated STRICTLY BEFORE cycleStart — what actually carried into the cycle, uncapped and
   *  signed (so an overdrawn carry-in stays negative instead of being floored to 0 like `carriedForward`). */
  broughtForward: number;
  /** Σ days over in-cycle `adjustment` rows whose reason is NOT a `sys:` machine reason — the festive /
   *  one-off / manual grants HR enters on Leave Config → Entitlement → Adjustment. BOTH signs. This is the
   *  single source of truth the panel's Adjustment line shows (feedback 0315dac7 ask 1). */
  configAdjustments: number;
  /** Σ days over in-cycle `adjustment` rows stamped `sys:policy_recalc:*` / `sys:profile_recalc:*` — the
   *  automatic corrections a policy edit or a grade/hire-date change posts. BOTH signs. Never appears on the
   *  Adjustment configuration screen, so it gets its own labelled "System corrections" line. */
  systemAdjustments: number;
  /** Σ −days over in-cycle `adjustment` rows stamped one of the THREE forfeit reasons (carry cap, carry
   *  expiry, aged type expiry), as a POSITIVE magnitude, taken from the actual ledger rows. */
  forfeitedThisCycle: number;
  /** Σ −days over in-cycle `debit` rows, as a POSITIVE magnitude. Unlike `debitsInWindow` (which the carry
   *  arithmetic bounds by the carry-expiry date) this covers EVERY debit in the cycle, including ones dated
   *  after carry expiry — otherwise those days would silently drop out of the identity. */
  takenThisCycle: number;
  /** The individual CONFIG adjustment rows behind `configAdjustments`, so a user can point at exactly where
   *  each adjusted day came from ("CNY 2026: +2.00"). Config rows only — system corrections are automatic
   *  and stay a single summarised line. */
  configAdjustmentItems: { effectiveOn: string; days: number; reason: string | null }[];
  /** Ledger balance as at asOf minus pending requests (mirrors leaveBalances' `available`). */
  totalAvailable: number;
  /** Raw in-scope ledger rows so the UI can show the source of each component. */
  transactions: { effectiveOn: string; entryType: string; days: number; sourceRequestId: string | null; reason: string | null }[];
  /** Employee Leave View Configuration (65dec703): per-component ESS visibility for this leave type,
   *  resolved (missing key ⇒ visible). The shared EntitlementBreakdown gates rows against this ONLY when
   *  its `applyEssConfig` prop is set (i.e. on /me); admin/HR pass it false and see every row. */
  essView: ResolvedEssView;
  /** Leave Entitlement Formula Management (79011509): HR-authored per-component explanations for this leave
   *  type, resolved (missing / all-empty ⇒ null). The breakdown panel shows a per-row info icon only where an
   *  explanation exists (feedback b8b665ff). Explanation layer only — never a computed figure. */
  formulaExplanations: ResolvedLeaveFormula;
};

/**
 * Feedback 0315dac7 — which bucket a `leave_ledger` `adjustment` row belongs to, decided from its `reason`
 * ALONE (never its sign). The three classes are mutually exclusive and exhaustive, which is what makes the
 * reconciliation partition close:
 *   • 'forfeit' — one of the THREE machine forfeit reasons. Enumerating all three matters: treating only the
 *     cap forfeit as a boundary row would leave the carry-EXPIRY forfeit counted as an adjustment AND as a
 *     forfeit (a second double-count).
 *   • 'system'  — an automatic correction posted by a policy edit (`sys:policy_recalc:<id>`) or a profile
 *     change (`sys:profile_recalc:<id>`). Invisible on the Adjustment configuration screen, hence its own line.
 *   • 'config'  — everything else: the festive / one-off / manual grants HR actually enters. A NULL reason
 *     falls here (a hand-written ledger row with no reason is a manual adjustment, not a machine one).
 * Exported so the tests can assert the partition directly against the reason constants.
 */
export type LedgerAdjustmentClass = 'config' | 'system' | 'forfeit';

export function classifyLedgerAdjustment(reason: string | null): LedgerAdjustmentClass {
  const r = reason ?? '';
  if (r === CARRY_FORFEIT_REASON_CAP || r === CARRY_FORFEIT_REASON_EXPIRY || r === AGED_FORFEIT_REASON) {
    return 'forfeit';
  }
  if (r.startsWith(`${POLICY_RECALC_REASON_PREFIX}:`) || r.startsWith(`${PROFILE_RECALC_REASON_PREFIX}:`)) {
    return 'system';
  }
  return 'config';
}

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
        .select({ id: leaveType.id, name: leaveType.name, code: leaveType.code, i18n: leaveType.i18n, essViewConfig: leaveType.essViewConfig, formulaExplanations: leaveType.formulaExplanations, yearCycleOverride: leaveType.yearCycleOverride })
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

    // Leave Year Type override (e1a51aea): this TYPE's effective cycle — a per-type 'a2a'/'c2c' override
    // wins over the company cycle; null falls back to the company cycle (byte-identical to before).
    const cycleStart = earnedCycleStart(emp.hiredOn, asOf, resolveLeaveYearCycle(type.yearCycleOverride, emp.leaveCycle));

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
          // 0315dac7: the reason drives the adjustment partition below (config vs system vs forfeit) and
          // labels each itemised config adjustment, so it must travel with the row.
          reason: leaveLedger.reason,
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

    // ── Reconciliation partition (feedback 0315dac7) ──────────────────────────────────────────────────
    // `rows` is EXACTLY the in-cycle window [cycleStart, asOf] the aggregates above use, so walking it once
    // splits every in-cycle row into one — and only one — bucket. Together with `priorBalance` (everything
    // strictly before cycleStart) the six buckets tile the whole ledger ≤ asOf, which is what makes
    //   broughtForward + entitled + config + system − forfeited − taken = balance
    // an identity rather than an approximation. Derived carry figures deliberately take NO part here.
    const r2 = (n: number) => Math.round(n * 100) / 100;
    let configAdjustments = 0;
    let systemAdjustments = 0;
    let forfeitedThisCycle = 0;
    let takenThisCycle = 0;
    const configAdjustmentItems: LeaveEntitlementBreakdown['configAdjustmentItems'] = [];
    for (const r of rows) {
      const days = Number(r.days);
      if (r.entryType === 'debit') {
        takenThisCycle = r2(takenThisCycle - days); // debits are negative ⇒ positive magnitude
        continue;
      }
      if (r.entryType !== 'adjustment') continue; // accrual / in_lieu_accrual ⇒ currentYearEntitlement
      switch (classifyLedgerAdjustment(r.reason)) {
        case 'forfeit':
          forfeitedThisCycle = r2(forfeitedThisCycle - days); // forfeits are negative ⇒ positive magnitude
          break;
        case 'system':
          systemAdjustments = r2(systemAdjustments + days);
          break;
        case 'config':
          configAdjustments = r2(configAdjustments + days);
          configAdjustmentItems.push({ effectiveOn: r.effectiveOn, days, reason: r.reason });
          break;
      }
    }

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
      balance,
      pendingApproval: num(pendRow?.pending),
      broughtForward: priorBalance,
      configAdjustments,
      systemAdjustments,
      forfeitedThisCycle,
      takenThisCycle,
      configAdjustmentItems,
      totalAvailable: Math.round((balance - num(pendRow?.pending)) * 100) / 100,
      transactions: rows.map((r) => ({
        effectiveOn: r.effectiveOn,
        entryType: r.entryType,
        days: Number(r.days),
        sourceRequestId: r.sourceRequestId,
        reason: r.reason,
      })),
      essView: resolveEssView(type.essViewConfig as Record<string, boolean> | null),
      formulaExplanations: resolveLeaveFormula(type.formulaExplanations as Record<string, LeaveFormulaEntry> | null),
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
        // Edit/cancel-by-status (item c9a19e34): the employment behind the row + the leave type id, so the /me
        // list can gate + prefill the status-gated Edit dialog and resolve the approved give-back candidates.
        employmentId: leaveRequest.employmentId,
        leaveTypeId: leaveRequest.leaveTypeId,
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
        // Edit/cancel-by-status: the applicant's own words prefill the Edit dialog.
        reason: leaveRequest.reason,
        employeeRemark: leaveRequest.employeeRemark,
        // Emergency Leave (0106): the shared id linking an EL submission's ANNUAL + UNPAID children, so the
        // /me history can group them under one EL heading. NULL for ordinary requests.
        parentGroupId: leaveRequest.parentGroupId,
        hasDocument: sql<boolean>`exists (select 1 from leave_request_attachment lra where lra.leave_request_id = leave_request.id)`,
        currentStepKind: sql<string | null>`(select approver_kind from leave_approval_step s where s.leave_request_id = leave_request.id and s.status = 'pending' order by s.step_index limit 1)`,
        currentStepIndex: sql<number | null>`(select step_index from leave_approval_step s where s.leave_request_id = leave_request.id and s.status = 'pending' order by s.step_index limit 1)`,
        stepCount: sql<number>`(select count(*)::int from leave_approval_step s where s.leave_request_id = leave_request.id)`,
        // Edit/cancel-by-status: an open give-back already on this approved row suppresses a second cancel click.
        pendingCancellationId: sql<string | null>`(select id from leave_cancellation_request c where c.leave_request_id = leave_request.id and c.status = 'pending' order by c.created_at desc limit 1)`,
        // R5 Build #2: TRUE when this row is a SURVIVOR of a prior cancellation split (still cancellable).
        isCancellationSplit: sql<boolean>`(leave_request.parent_group_id is not null and exists (select 1 from leave_request s where s.parent_group_id = leave_request.parent_group_id and s.status = 'cancelled'))`,
        // R17 600be8ac ask #4: TRUE when this request has ≥1 REJECTED per-date sub-row → the /me + personnel
        // history renders the derived "Partially approved" badge instead of a flat "Approved" (no status enum).
        hasRejectedDates: sql<boolean>`exists (select 1 from leave_request_date d where d.leave_request_id = leave_request.id and d.status = 'rejected')`,
      })
      .from(leaveRequest)
      .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
      .where(eq(leaveRequest.employmentId, employmentId))
      .orderBy(desc(leaveRequest.startDate));
    // Edit/cancel-by-status: resolve each approved full-day plain/split row's REAL working dates (the give-back
    // candidate set), holiday-aware, exactly as the /leave page does — so the /me approved-cancel dialog offers
    // the same dates the service will accept.
    const withDates = await resolveLeaveWorkingDates(tx, rows);
    return withDates.map(({ i18n, ...r }) => ({ ...r, leaveType: pickName(r.leaveType, i18n, locale) }));
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
        // eae550e9: the person behind the edge (both queries already innerJoin person — one extra column).
        personId: employment.personId,
        name: person.fullName,
        // Direct Superior (dce55aff): the manager's Employee ID, so the card/header can render
        // "EMP-0008 – John Tan". Additive — existing callers ignore it.
        employeeCode: employment.employeeCode,
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
        // eae550e9: the person behind the edge — feeds the dashboard calendar's person-scoped read.
        personId: employment.personId,
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

/** Direct Superior history (dce55aff): the CLOSED administrative reporting lines for an employment —
 *  every prior direct superior with the window they held the role. Read-only feed for the compact
 *  history disclosure on the Personnel Employment tab; the effective-dating stays internal (the screen
 *  no longer asks admins to manage dates), but the audit visibility is preserved here. Excludes the
 *  open line (that is the CURRENT superior, rendered separately) and superseded corrections. */
export function directSuperiorHistoryFor(ctx: SessionContext, employmentId: string) {
  return withTenant(ctx, async (tx) => {
    return tx
      .select({
        id: reportingLine.id,
        managerEmploymentId: reportingLine.managerEmploymentId,
        employeeCode: employment.employeeCode,
        name: person.fullName,
        validFrom: reportingLine.validFrom,
        validTo: reportingLine.validTo,
      })
      .from(reportingLine)
      .innerJoin(employment, eq(employment.id, reportingLine.managerEmploymentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          eq(reportingLine.subordinateEmploymentId, employmentId),
          eq(reportingLine.lineType, 'administrative'),
          isNotNull(reportingLine.validTo),
          isNull(reportingLine.supersededAt),
        ),
      )
      .orderBy(desc(reportingLine.validFrom), desc(reportingLine.validTo));
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

export type DelegationScopedRow = {
  id: string;
  delegatorEmploymentId: string;
  delegatorName: string;
  delegateEmploymentId: string;
  delegateName: string;
  validFrom: string;
  validTo: string | null;
  ended: boolean;
  // R44 delegation (Phase 2): the reason + the per-module/task scope. `scopes` empty = whole-scope (all
  // approvals). Both are attached post-query (attachDelegationScopeInfo) for admin + self-service alike.
  reason: string | null;
  scopes: { module: string; taskType: string | null }[];
  // R51 (baf56348): org coverage ids + display names — consumed ONLY by the HR edit-form defaults (the
  // list-table coverage column was deliberately cut). All-null = unrestricted.
  orgScope: {
    companyId: string | null;
    companyName: string | null;
    businessUnitId: string | null;
    businessUnitName: string | null;
    departmentId: string | null;
    departmentName: string | null;
  };
};

type DelegationRawRow = {
  id: string;
  delegatorEmploymentId: string;
  delegatorName: string;
  delegateEmploymentId: string;
  delegateName: string;
  validFrom: string;
  validTo: string | null;
  supersededAt: Date | string | null;
};

/** Shape a raw delegation row (either source) into the page row, deriving `ended` from asOf. `reason` /
 *  `scopes` start empty and are filled by attachDelegationScopeInfo (one batched query for all rows). */
function shapeDelegationRow(r: DelegationRawRow, asOf: string): DelegationScopedRow {
  return {
    id: r.id,
    delegatorEmploymentId: r.delegatorEmploymentId,
    delegatorName: r.delegatorName,
    delegateEmploymentId: r.delegateEmploymentId,
    delegateName: r.delegateName,
    validFrom: r.validFrom,
    validTo: r.validTo,
    ended: r.supersededAt != null || (r.validTo != null && r.validTo <= asOf),
    reason: null,
    scopes: [],
    orgScope: {
      companyId: null,
      companyName: null,
      businessUnitId: null,
      businessUnitName: null,
      departmentId: null,
      departmentName: null,
    },
  };
}

/**
 * R44 delegation (Phase 2) — batch-attach reason + scope rows to a set of delegation rows, in the caller's
 * tx. reporting_line + reporting_line_scope are tenant-readable (RLS USING is tenant-only), so this works
 * for both the admin path and a self-service user. A delegation with no scope rows keeps scopes: [].
 */
async function attachDelegationScopeInfo(tx: Tx, rows: DelegationScopedRow[]): Promise<DelegationScopedRow[]> {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => r.id);
  const [reasons, scopeRows] = await Promise.all([
    tx
      .select({
        id: reportingLine.id,
        reason: reportingLine.reason,
        // R51 (baf56348): org coverage ids + names in ONE left-joined pass (company/BU/department SELECT is
        // tenant-wide under RLS, so this resolves for self-service viewers too).
        scopeCompanyId: reportingLine.scopeCompanyId,
        scopeCompanyName: company.legalName,
        scopeBusinessUnitId: reportingLine.scopeBusinessUnitId,
        scopeBusinessUnitName: businessUnit.name,
        scopeDepartmentId: reportingLine.scopeDepartmentId,
        scopeDepartmentName: department.name,
      })
      .from(reportingLine)
      .leftJoin(company, eq(company.id, reportingLine.scopeCompanyId))
      .leftJoin(businessUnit, eq(businessUnit.id, reportingLine.scopeBusinessUnitId))
      .leftJoin(department, eq(department.id, reportingLine.scopeDepartmentId))
      .where(inArray(reportingLine.id, ids)),
    tx
      .select({
        rid: reportingLineScope.reportingLineId,
        module: reportingLineScope.module,
        taskType: reportingLineScope.taskType,
      })
      .from(reportingLineScope)
      .where(inArray(reportingLineScope.reportingLineId, ids)),
  ]);
  const infoById = new Map(reasons.map((r) => [r.id, r]));
  const scopesById = new Map<string, { module: string; taskType: string | null }[]>();
  for (const s of scopeRows) {
    const list = scopesById.get(s.rid) ?? [];
    list.push({ module: s.module, taskType: s.taskType });
    scopesById.set(s.rid, list);
  }
  return rows.map((r) => {
    const info = infoById.get(r.id);
    return {
      ...r,
      reason: info?.reason ?? null,
      scopes: scopesById.get(r.id) ?? [],
      orgScope: {
        companyId: info?.scopeCompanyId ?? null,
        companyName: info?.scopeCompanyName ?? null,
        businessUnitId: info?.scopeBusinessUnitId ?? null,
        businessUnitName: info?.scopeBusinessUnitName ?? null,
        departmentId: info?.scopeDepartmentId ?? null,
        departmentName: info?.scopeDepartmentName ?? null,
      },
    };
  });
}

/**
 * Global Delegation (Phase 1) — the /delegations listing. Unlike `delegationsFor` (one delegator's active
 * rows), this returns delegations ACROSS employments with both sides named:
 *   • HR / super_admin (`isAdmin`) → every delegation in the tenant; `history` adds past/superseded rows.
 *     Admins already read all employment/person under RLS, so this is a plain scoped join.
 *   • a self-service user → only rows where the CALLER is the delegator OR the delegate. reporting_line
 *     SELECT is tenant-only, but the employment/person NAME joins are visibility-gated (a stand-in cannot
 *     see the delegator's employment under RLS), so a plain join would silently drop the counterparty's
 *     row. It is resolved through the SECURITY-DEFINER helper `app.self_delegations()` (migration 0195) —
 *     the same vetted-boundary pattern as `app.can_decide_via_delegation`: the function's own WHERE clause
 *     restricts the result to delegations the caller participates in (delegator OR delegate), so no broader
 *     employment/person visibility is granted.
 * `ended` = TRUE for a superseded row or one whose window has closed (validTo <= asOf) — the page derives
 * the finer Active / Scheduled / Ended status from the dates. Read-only (no DomainEvent).
 */
export function delegationsScoped(
  ctx: SessionContext,
  opts: { isAdmin: boolean; history: boolean; asOf: string },
): Promise<DelegationScopedRow[]> {
  return withTenant(ctx, async (tx) => {
    if (!opts.isAdmin) {
      // Self view — the definer helper self-scopes to the caller's own delegations (delegator OR delegate).
      const res = await tx.execute(sql`SELECT * FROM app.self_delegations()`);
      const raws = res as unknown as {
        id: string;
        delegator_employment_id: string;
        delegator_name: string;
        delegate_employment_id: string;
        delegate_name: string;
        valid_from: string;
        valid_to: string | null;
        superseded_at: Date | string | null;
      }[];
      const notEnded = (r: (typeof raws)[number]) =>
        r.superseded_at == null && (r.valid_to == null || r.valid_to > opts.asOf);
      const selfRows = raws
        .filter((r) => opts.history || notEnded(r))
        .map((r) =>
          shapeDelegationRow(
            {
              id: r.id,
              delegatorEmploymentId: r.delegator_employment_id,
              delegatorName: r.delegator_name,
              delegateEmploymentId: r.delegate_employment_id,
              delegateName: r.delegate_name,
              validFrom: r.valid_from,
              validTo: r.valid_to,
              supersededAt: r.superseded_at,
            },
            opts.asOf,
          ),
        )
        .sort((a, b) => (a.validFrom < b.validFrom ? 1 : a.validFrom > b.validFrom ? -1 : 0));
      return attachDelegationScopeInfo(tx, selfRows);
    }
    const delegatorEmp = alias(employment, 'deleg_delegator_emp');
    const delegatorPerson = alias(person, 'deleg_delegator_person');
    const delegateEmp = alias(employment, 'deleg_delegate_emp');
    const delegatePerson = alias(person, 'deleg_delegate_person');
    // history=false → only rows still active-or-future (not superseded, window not yet closed).
    const notEnded = and(
      isNull(reportingLine.supersededAt),
      or(isNull(reportingLine.validTo), gt(reportingLine.validTo, opts.asOf)),
    );
    const rows = await tx
      .select({
        id: reportingLine.id,
        delegatorEmploymentId: reportingLine.subordinateEmploymentId,
        delegatorName: delegatorPerson.fullName,
        delegateEmploymentId: reportingLine.managerEmploymentId,
        delegateName: delegatePerson.fullName,
        validFrom: reportingLine.validFrom,
        validTo: reportingLine.validTo,
        supersededAt: reportingLine.supersededAt,
      })
      .from(reportingLine)
      .innerJoin(delegatorEmp, eq(delegatorEmp.id, reportingLine.subordinateEmploymentId))
      .innerJoin(delegatorPerson, eq(delegatorPerson.id, delegatorEmp.personId))
      .innerJoin(delegateEmp, eq(delegateEmp.id, reportingLine.managerEmploymentId))
      .innerJoin(delegatePerson, eq(delegatePerson.id, delegateEmp.personId))
      .where(and(eq(reportingLine.lineType, 'delegate'), opts.history ? undefined : notEnded))
      .orderBy(desc(reportingLine.validFrom));
    return attachDelegationScopeInfo(tx, rows.map((r) => shapeDelegationRow(r, opts.asOf)));
  });
}

/** Global Delegation (Phase 1) — a lightweight active-employee picker (id + name + code), for the
 *  delegation create form's "delegate to" / (HR) "delegate from" selects. RLS-scoped; read-only. */
export function employmentPickerList(ctx: SessionContext, companyIds?: string[]) {
  return withTenant(ctx, (tx) =>
    tx
      .select({ employmentId: employment.id, name: person.fullName, employeeCode: employment.employeeCode })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          isNull(employment.terminatedOn),
          companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined,
        ),
      )
      .orderBy(person.fullName),
  );
}

/** R51 (baf56348) — one same-level stand-in candidate for the delegation "delegate to" picker. Org ids ride
 *  along so the coverage cascade can narrow the list CLIENT-side (no per-scope-change server round-trip). */
export type EligibleDelegateRow = {
  employmentId: string;
  name: string;
  companyId: string;
  businessUnitId: string | null;
  departmentId: string | null;
  level: string;
};

/**
 * R51 (baf56348) — same-level stand-in candidates for a delegator, via app.eligible_delegates (SECURITY
 * DEFINER, migration 0286). The definer boundary is required: employment RLS hides sibling approvers from a
 * self-service head, so a plain scoped query here would return a near-empty list. The function itself guards
 * authorisation (caller owns the delegator employment or is an admin — otherwise EMPTY) and filters to
 * active, non-self employments whose HIGHEST approver level equals the delegator's. Read-only.
 */
export function eligibleDelegates(ctx: SessionContext, delegatorEmploymentId: string): Promise<EligibleDelegateRow[]> {
  return withTenant(ctx, async (tx) => {
    const res = await tx.execute(sql`SELECT * FROM app.eligible_delegates(${delegatorEmploymentId})`);
    const rows = res as unknown as {
      employment_id: string;
      full_name: string;
      company_id: string;
      business_unit_id: string | null;
      department_id: string | null;
      approver_level: string;
    }[];
    return rows.map((r) => ({
      employmentId: r.employment_id,
      name: r.full_name,
      companyId: r.company_id,
      businessUnitId: r.business_unit_id,
      departmentId: r.department_id,
      level: r.approver_level,
    }));
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
 *  given, every figure is scoped to that company's subtree (consolidation); else the whole tenant.
 *
 *  ONE FIGURE IS DELIBERATELY NOT SWITCHER-SCOPED: `companies`. See its comment below — the rest of
 *  the dashboard is switcher-scoped ON PURPOSE and stays that way. */
export function dashboardStats(ctx: SessionContext, companyIds?: string[]) {
  return withTenant(ctx, async (tx) => {
    const one = sql<number>`count(*)::int`;
    const scopeIds = companyIds && companyIds.length ? companyIds : null;
    const scope = (col: AnyColumn) => (scopeIds ? inArray(col, scopeIds) : sql`true`);

    const [headcount] = await tx
      .select({ n: one })
      .from(employment)
      .where(and(isNull(employment.terminatedOn), scope(employment.companyId)));
    // Companies (11355c08) — the number of companies THIS PERSON CAN ADMINISTER. Not the switcher
    // selection, and with no count(*) anywhere: the old expression was
    //     scopeIds ? scopeIds.length : count(*) from company
    // which is two faults sharing one line.
    //
    //   1. With a selection, `scopeIds.length` is how many companies are TICKED IN THE SWITCHER — a
    //      filter size, not a company count. app/page.tsx points this tile at /admin/organization,
    //      which lists every company the viewer can administer and ignores the switcher outright
    //      (0f1802bf). One company ticked out of eight rendered "1" on a tile whose own destination
    //      then showed eight, which is what sent an entire round chasing the wrong screen.
    //   2. The count(*) branch was reached precisely when the selection was EMPTY — so the person who
    //      could reach NOTHING was the one shown the tenant-wide total. That is the disclosure
    //      feedback ab77dc1f closed on the page header, still open here.
    //
    // The predicate is the database's own app.is_admin_for (migration 0016) — the same one
    // listCompanies({ adminOnly }) applies for the Organization card (r77 913202b), and the same one
    // the company table's WITH CHECK uses. A GROUP-WIDE grant satisfies it for every company, so the
    // ordinary group admin's figure is unchanged and correct; a company-scoped admin gets their
    // company and its subtree; a manager or employee, who administers nothing, gets 0 — and 0 is the
    // honest answer, so there is deliberately NO fallback for the empty case.
    //
    // Archived companies are counted, because the Organization card lists them too (it reads
    // includeArchived: true — un-archiving is one of its panel actions). Counting them keeps the tile
    // equal to the length of the list it links to, which is the whole point of the change.
    //
    // Written as a COUNT against the same predicate rather than `listCompanies(ctx, …).length` on
    // purpose: listCompanies opens its own withTenant, and calling it here would nest a second
    // transaction inside this one. test/dashboard-companies-tile.test.ts asserts the two agree, so the
    // duplication cannot drift silently.
    const [companies] = await tx
      .select({ n: one })
      .from(company)
      // `company.id` unqualified: that is the table's alias in this FROM, the same call shape
      // listCompanies/adminCompanies use.
      .where(sql`app.is_admin_for(company.id)`);
    const companiesCount = companies?.n ?? 0;
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
  /** Restrict to a single aggregate INSTANCE (e.g. one payroll batch's lifecycle events for a per-run
   *  History card). AND-ed onto the other filters; read-only, no event appended. */
  aggregateId?: string;
  eventQuery?: string; // matches event type / aggregate type
  actorId?: string;
  /** 4ec5a940 — action filter: matches the event's last dot-segment (created/updated/deleted/…). The
   *  caller passes a validated slug from an allowlist; used as `event_type ilike '%.'||action`. */
  action?: string;
  /** 4ec5a940 — company filter: matches events whose payload records a `companyId` scope. Documented
   *  limitation: group-level events that carry no company scope won't match. */
  companyId?: string;
  /** 4ec5a940 — leave-type filter: the leave-type aggregate itself, or any event whose payload carries
   *  a `leaveTypeId` (e.g. a scoped approval rule). */
  leaveTypeId?: string;
  from?: string; // ISO date (inclusive)
  to?: string; // ISO date (exclusive next day applied by caller)
  limit?: number;
  offset?: number;
};

/** The audit filter predicate, shared by the row page and its COUNT so the two can never disagree
 *  about what "matching" means (fc776376 — the pager's "26–50 of 312" needs a real total). */
function auditWhere(f: AuditFilters) {
  return and(
    f.aggregateType ? eq(domainEvent.aggregateType, f.aggregateType) : undefined,
    f.aggregateTypes && f.aggregateTypes.length
      ? inArray(domainEvent.aggregateType, f.aggregateTypes)
      : undefined,
    f.aggregateId ? eq(domainEvent.aggregateId, f.aggregateId) : undefined,
    f.actorId ? eq(domainEvent.actorId, f.actorId) : undefined,
    // 4ec5a940 — action = the event's last dot-segment. Parameterised (never interpolated), so the
    // caller's allowlist + this bound param double-guard against injection.
    f.action ? sql`${domainEvent.eventType} ilike ${'%.' + f.action}` : undefined,
    // 4ec5a940 — company scope drawn from the payload (events that record `companyId`).
    f.companyId ? sql`${domainEvent.payload}->>'companyId' = ${f.companyId}` : undefined,
    // 4ec5a940 — the leave-type aggregate row itself, or any event scoped to it via payload.
    f.leaveTypeId
      ? sql`((${domainEvent.aggregateType} = 'leave-type' and ${domainEvent.aggregateId}::text = ${f.leaveTypeId}) or ${domainEvent.payload}->>'leaveTypeId' = ${f.leaveTypeId})`
      : undefined,
    f.from ? gte(domainEvent.occurredAt, new Date(`${f.from}T00:00:00Z`)) : undefined,
    f.to ? lte(domainEvent.occurredAt, new Date(`${f.to}T23:59:59.999Z`)) : undefined,
    f.eventQuery
      ? sql`(${domainEvent.eventType} ilike ${'%' + f.eventQuery + '%'} or ${domainEvent.aggregateType} ilike ${'%' + f.eventQuery + '%'})`
      : undefined,
  );
}

/** The full append-only event ledger, filterable. RLS scopes to the tenant; the actor name is
 *  resolved from app_user → person (null for SYSTEM/AGENT/EXTERNAL or unlinked principals). */
export function auditEvents(ctx: SessionContext, f: AuditFilters = {}): Promise<AuditRow[]> {
  // The upper bound is the shared "All" ceiling (fc776376): a reader who asks for everything gets
  // everything up to the ceiling, and the pager says on screen when that truncates.
  const limit = Math.min(f.limit ?? 100, ALL_ROW_CEILING);
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
      .where(auditWhere(f))
      .orderBy(desc(domainEvent.occurredAt), desc(domainEvent.sequence))
      .limit(limit)
      .offset(f.offset ?? 0),
  ) as Promise<AuditRow[]>;
}

/** How many ledger rows match `f`, ignoring limit/offset — the pager's total. */
export function auditEventsCount(ctx: SessionContext, f: AuditFilters = {}): Promise<number> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(domainEvent)
      .where(auditWhere(f));
    return row?.n ?? 0;
  });
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

/** 4ec5a940 — the distinct actors who appear in the log (optionally within a set of aggregate types,
 *  e.g. the leave module for the Leave Audit tab), with their resolved display name — drives the User
 *  filter dropdown. SYSTEM/AGENT/unlinked principals surface as a null name (the UI labels them). */
export function auditActors(
  ctx: SessionContext,
  aggregateTypes?: string[],
): Promise<{ actorId: string | null; actorName: string | null }[]> {
  return withTenant(ctx, (tx) =>
    tx
      .selectDistinct({ actorId: domainEvent.actorId, actorName: person.fullName })
      .from(domainEvent)
      .leftJoin(appUser, eq(appUser.id, domainEvent.actorId))
      .leftJoin(person, eq(person.id, appUser.personId))
      .where(
        aggregateTypes && aggregateTypes.length
          ? inArray(domainEvent.aggregateType, aggregateTypes)
          : undefined,
      )
      .orderBy(person.fullName),
  ) as Promise<{ actorId: string | null; actorName: string | null }[]>;
}

// ─── Approval activity history (bell History tab + /approvals/history) ───────────────────────────────

export type ApprovalHistoryRow = {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  occurredAt: Date;
  subjectEmploymentId: string | null;
  subjectName: string | null;
  deciderName: string | null;
  isAuto: boolean;
  onBehalfOfEmploymentId: string | null;
  onBehalfOfName: string | null;
  payload: unknown;
};

export type ApprovalHistoryFilters = {
  /** ISO timestamptz bound, inclusive. */
  from?: string;
  /** ISO timestamptz bound, exclusive. */
  to?: string;
  /** Area filter — mapped to the aggregate-type set (lib/approval-history). */
  module?: ApprovalHistoryModule;
  /** Coarse action filter: approved / rejected / other. */
  action?: ApprovalHistoryAction;
  /** The decider's EMPLOYMENT id — mapped to the actor app_user id server-side (the viewer may not be
   *  able to read a delegate's employment under RLS, so the mapping cannot happen app-side). */
  deciderEmploymentId?: string;
  limit?: number;
  offset?: number;
};

/**
 * The approval decision log for the viewer's team (feedback 44a89810). Thin wrapper over the
 * SECURITY-DEFINER `app.approval_history()` (migration 0288) — the same vetted-boundary pattern as
 * `app.self_delegations`: the function itself scopes visibility (admin = whole tenant; non-admin = the
 * recursive administrative down-walk, mirroring the domain_event read policy) and resolves decider /
 * subject / on-behalf NAMES under definer privileges, because person RLS would NULL a peer-manager
 * delegate's name for a non-admin viewer (the exact gap 0196 documents). "On behalf of" is DERIVED at
 * read time from reporting_line `delegate` edges — no write-path change, so historical rows are labelled
 * too. The viewer's own requests never appear (team log, not a self log). Read-only (no DomainEvent).
 *
 * Why not extend `auditEvents` (its conventions ARE reused: action filter, from/to, type-set,
 * limit/offset): its plain person join yields NULL names for non-admin viewers and the audit page is
 * admin-only — this read must go through the definer boundary.
 */
export function listApprovalHistory(
  ctx: SessionContext,
  f: ApprovalHistoryFilters = {},
): Promise<ApprovalHistoryRow[]> {
  const typesCsv = f.module ? aggregateTypesOfModule[f.module].join(',') : null;
  const action = f.action && isApprovalHistoryAction(f.action) ? f.action : null;
  // The upper bound moved out of the SQL function into here (migration 0320) so the count variant can
  // ask it for everything. This is the shared "All" ceiling — the pager says on screen when it truncates.
  const limit = Math.min(Math.max(f.limit ?? 50, 1), ALL_ROW_CEILING);
  const offset = Math.max(f.offset ?? 0, 0);
  return withTenant(ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT * FROM app.approval_history(
        ${f.from ?? null}::timestamptz,
        ${f.to ?? null}::timestamptz,
        string_to_array(${typesCsv}::text, ','),
        ${action}::text,
        ${f.deciderEmploymentId ?? null}::uuid,
        ${limit}::int,
        ${offset}::int
      )`);
    const raws = res as unknown as {
      id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      occurred_at: Date;
      subject_employment_id: string | null;
      subject_name: string | null;
      decider_name: string | null;
      is_auto: boolean;
      on_behalf_of_employment_id: string | null;
      on_behalf_of_name: string | null;
      payload: unknown;
    }[];
    return raws.map((r) => ({
      id: r.id,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      eventType: r.event_type,
      occurredAt: r.occurred_at instanceof Date ? r.occurred_at : new Date(r.occurred_at),
      subjectEmploymentId: r.subject_employment_id,
      subjectName: r.subject_name,
      deciderName: r.decider_name,
      isAuto: r.is_auto,
      onBehalfOfEmploymentId: r.on_behalf_of_employment_id,
      onBehalfOfName: r.on_behalf_of_name,
      payload: r.payload,
    }));
  });
}

/** How many history rows this viewer can reach under `f`, ignoring limit/offset — the pager's total.
 *  Runs the SAME definer function as the row query (migration 0320), so the counter can never promise
 *  rows the visibility walk would withhold. */
export function approvalHistoryCount(ctx: SessionContext, f: ApprovalHistoryFilters = {}): Promise<number> {
  const typesCsv = f.module ? aggregateTypesOfModule[f.module].join(',') : null;
  const action = f.action && isApprovalHistoryAction(f.action) ? f.action : null;
  return withTenant(ctx, async (tx) => {
    const res = await tx.execute(sql`
      SELECT app.approval_history_count(
        ${f.from ?? null}::timestamptz,
        ${f.to ?? null}::timestamptz,
        string_to_array(${typesCsv}::text, ','),
        ${action}::text,
        ${f.deciderEmploymentId ?? null}::uuid
      ) AS n`);
    const rows = res as unknown as { n: number | string | null }[];
    return Number(rows[0]?.n ?? 0);
  });
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

/**
 * Resolve a SELECTED employment to its person + header details, for the HR TP1-on-behalf screen
 * (Standardize-TP1, item 0cde61f3). RLS-scoped: an admin sees any employment in their tenant/scope; a
 * non-admin only their own — so this cannot be used to widen access. `personId` is the trusted key the
 * TP1 admin service writes against (NEVER a raw form field). Read-only, no DomainEvent. Returns null when
 * the employment id is not visible to the caller.
 */
export function employmentSubject(ctx: SessionContext, employmentId: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        employmentId: employment.id,
        personId: employment.personId,
        name: person.fullName,
        email: person.primaryEmail,
        employeeCode: employment.employeeCode,
        company: company.legalName,
        companyId: employment.companyId,
        department: department.name,
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
      .where(eq(employment.id, employmentId))
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
    const rows = await tx
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
        // Step 6 (f3148da1) — the release instant, materialized at close time (RLS-safe via the batch, unlike
        // the admin-only company_payroll_config which the employee session cannot read).
        releasedAt: payrollBatch.releasedAt,
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(inArray(payslip.employmentId, employmentIds))
      .orderBy(desc(payrollBatch.payPeriod), payrollBatch.runSeq);
    // Step 6 — stamp a `released` flag per row: released once the batch is closed AND its release instant has
    // passed. Non-closed batches are never released. Legacy closed batches carry a backfilled releasedAt so
    // they stay visible. The ESS payslip section filters on `released`.
    const now = Date.now();
    return rows.map((r) => ({
      ...r,
      released: r.status === 'closed' && (r.releasedAt == null || r.releasedAt.getTime() <= now),
    }));
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
