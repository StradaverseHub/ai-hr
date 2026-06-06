/**
 * Slice 0 schema — "the spine".
 *
 * Conventions (see docs/architecture/domain-model.md and the ADRs):
 *  - Every table carries `tenant_id` (ADR-0002). Row-Level Security is applied in a
 *    separate SQL migration; the column lives here.
 *  - Effective dating (ADR-0001/0003): temporal facts carry `valid_from` / `valid_to`
 *    (half-open; `valid_to = null` means "open / current"). Changes CLOSE + INSERT a new
 *    version — never UPDATE business columns in place. `recorded_at` / `superseded_at`
 *    capture the record's lifecycle (transaction-time is also covered by the event log).
 *  - FKs here are simple (-> id). Composite tenant-scoped FKs (id, tenant_id) are a
 *    deliberate hardening follow-up (tracked), not silently skipped — RLS already blocks
 *    cross-tenant *reads*; composite FKs would also block cross-tenant *references*.
 */
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  date,
  time,
  timestamp,
  boolean,
  numeric,
  jsonb,
  bigserial,
  bigint,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// ───────────────────────────── Enums ─────────────────────────────

export const roleEnum = pgEnum('role', ['employee', 'manager', 'hr_admin', 'super_admin']);
export const employmentTypeEnum = pgEnum('employment_type', [
  'full_time',
  'part_time',
  'contract',
  'intern',
]);
export const assignmentStatusEnum = pgEnum('assignment_status', [
  'active',
  'on_leave',
  'probation',
  'offboarding',
  'terminated',
]);
export const reportingLineTypeEnum = pgEnum('reporting_line_type', [
  'administrative',
  'functional',
  'project',
  'dotted',
]);
export const leaveEntryTypeEnum = pgEnum('leave_entry_type', ['accrual', 'debit', 'adjustment']);
export const leaveRequestStatusEnum = pgEnum('leave_request_status', [
  'pending',
  'approved',
  'rejected',
  'cancelled',
]);
export const actorTypeEnum = pgEnum('actor_type', ['user', 'system', 'agent', 'external']);

// Reusable column fragments.
const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenant.id);
const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();

// ──────────────────────────── Tenancy ────────────────────────────
// tenant = the customer account (the isolation wall). One per WorkOS Organization.

export const tenant = pgTable('tenant', {
  id: id(),
  workosOrgId: text('workos_org_id').notNull().unique(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

// company = a legal entity WITHIN a tenant (multi-company lives here, not at the wall).
export const company = pgTable(
  'company',
  {
    id: id(),
    tenantId: tenantId(),
    legalName: text('legal_name').notNull(),
    country: text('country').notNull().default('MY'), // ISO-3166 alpha-2
    currency: text('currency').notNull().default('MYR'), // ISO-4217
    registrationNo: text('registration_no'),
    createdAt: createdAt(),
  },
  (t) => [index('company_tenant_idx').on(t.tenantId)],
);

// app_user = a login identity (WorkOS-sourced); optionally linked to a Person.
export const appUser = pgTable(
  'app_user',
  {
    id: id(),
    tenantId: tenantId(),
    workosUserId: text('workos_user_id').notNull(),
    personId: uuid('person_id').references(() => person.id),
    createdAt: createdAt(),
  },
  (t) => [index('app_user_tenant_idx').on(t.tenantId)],
);

// role_assignment = RBAC grant; company_id null = tenant-wide (whole group), set = one company.
export const roleAssignment = pgTable(
  'role_assignment',
  {
    id: id(),
    tenantId: tenantId(),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUser.id),
    companyId: uuid('company_id').references(() => company.id),
    role: roleEnum('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('role_assignment_user_idx').on(t.appUserId)],
);

// ─────────────────────── Identity & Org (ADR-0003) ───────────────────────
// person = the global human identity within a tenant (holds PII).

export const person = pgTable(
  'person',
  {
    id: id(),
    tenantId: tenantId(),
    fullName: text('full_name').notNull(),
    primaryEmail: text('primary_email').notNull(),
    phone: text('phone'),
    createdAt: createdAt(),
  },
  (t) => [index('person_tenant_idx').on(t.tenantId)],
);

export const position = pgTable(
  'position',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    title: text('title').notNull(),
    jobFamily: text('job_family'),
    createdAt: createdAt(),
  },
  (t) => [index('position_company_idx').on(t.companyId)],
);

export const department = pgTable(
  'department',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    parentDepartmentId: uuid('parent_department_id').references((): AnyPgColumn => department.id),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('department_company_idx').on(t.companyId)],
);

export const costCenter = pgTable(
  'cost_center',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('cost_center_company_idx').on(t.companyId)],
);

// employment = the durable Person↔Company relationship. Multiple concurrent = multi-company.
export const employment = pgTable(
  'employment',
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    employeeCode: text('employee_code'),
    hiredOn: date('hired_on').notNull(),
    terminatedOn: date('terminated_on'),
    createdAt: createdAt(),
  },
  (t) => [
    index('employment_person_idx').on(t.personId),
    index('employment_company_idx').on(t.companyId),
    uniqueIndex('employment_employee_code_uq').on(t.tenantId, t.employeeCode),
  ],
);

// assignment = effective-dated version of an Employment (CLOSE + INSERT on change).
export const assignment = pgTable(
  'assignment',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    positionId: uuid('position_id').references(() => position.id),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => department.id),
    costCenterId: uuid('cost_center_id').references(() => costCenter.id),
    employmentType: employmentTypeEnum('employment_type').notNull(),
    status: assignmentStatusEnum('status').notNull(),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'), // null = open / current
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }), // null = current record
    createdAt: createdAt(),
  },
  (t) => [index('assignment_employment_idx').on(t.employmentId, t.validFrom)],
);

// reporting_line = typed, effective-dated graph edge; manager & subordinate may differ in company.
export const reportingLine = pgTable(
  'reporting_line',
  {
    id: id(),
    tenantId: tenantId(),
    subordinateEmploymentId: uuid('subordinate_employment_id')
      .notNull()
      .references(() => employment.id),
    managerEmploymentId: uuid('manager_employment_id')
      .notNull()
      .references(() => employment.id),
    lineType: reportingLineTypeEnum('line_type').notNull(),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('reporting_line_sub_idx').on(t.subordinateEmploymentId),
    index('reporting_line_mgr_idx').on(t.managerEmploymentId),
  ],
);

// ──────────────────────────── Leave ────────────────────────────
// Slice 0 ships Annual only. Balance = signed sum of leave_ledger entries.

export const leaveType = pgTable('leave_type', {
  id: id(),
  tenantId: tenantId(),
  code: text('code').notNull(), // e.g. 'ANNUAL'
  name: text('name').notNull(),
  paid: boolean('paid').notNull().default(true),
  // 'working_days' (exclude weekends + holidays) | 'calendar_days' (consecutive)
  counting: text('counting').notNull().default('calendar_days'),
  createdAt: createdAt(),
});

export const leavePolicy = pgTable(
  'leave_policy',
  {
    id: id(),
    tenantId: tenantId(),
    leaveTypeId: uuid('leave_type_id')
      .notNull()
      .references(() => leaveType.id),
    // e.g. { annualDays: 16, method: 'grant_on_hire_prorated' }
    accrual: jsonb('accrual').notNull(),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    createdAt: createdAt(),
  },
  (t) => [index('leave_policy_type_idx').on(t.leaveTypeId)],
);

// leave_ledger = append-only entries; accrual (+), debit (−) on approval, adjustment (±).
export const leaveLedger = pgTable(
  'leave_ledger',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    leaveTypeId: uuid('leave_type_id')
      .notNull()
      .references(() => leaveType.id),
    entryType: leaveEntryTypeEnum('entry_type').notNull(),
    days: numeric('days', { precision: 6, scale: 2 }).notNull(), // signed
    sourceRequestId: uuid('source_request_id').references((): AnyPgColumn => leaveRequest.id),
    effectiveOn: date('effective_on').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('leave_ledger_employment_idx').on(t.employmentId, t.leaveTypeId)],
);

export const leaveRequest = pgTable(
  'leave_request',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    leaveTypeId: uuid('leave_type_id')
      .notNull()
      .references(() => leaveType.id),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    days: numeric('days', { precision: 6, scale: 2 }).notNull(),
    status: leaveRequestStatusEnum('status').notNull().default('pending'),
    reason: text('reason'),
    decidedByEmploymentId: uuid('decided_by_employment_id').references(() => employment.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('leave_request_employment_idx').on(t.employmentId)],
);

// ─────────────────────── Audit substrate (ADR-0006) ───────────────────────
// Append-only. No UPDATE/DELETE (enforced in the RLS/constraints migration).

export const domainEvent = pgTable(
  'domain_event',
  {
    id: id(),
    tenantId: tenantId(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    eventType: text('event_type').notNull(), // past-tense, dotted
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: uuid('actor_id'),
    payload: jsonb('payload'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
    sequence: bigserial('sequence', { mode: 'number' }).notNull(),
  },
  (t) => [index('domain_event_aggregate_idx').on(t.tenantId, t.aggregateType, t.aggregateId)],
);

// ─────────────────── Compensation (generic, effective-dated) ───────────────────
// Money is effective-dated (comp history), per ADR-0008. CLOSE + INSERT on change.
export const compensation = pgTable(
  'compensation',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    basicSalary: numeric('basic_salary', { precision: 12, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('MYR'),
    monthlyAllowance: numeric('monthly_allowance', { precision: 12, scale: 2 }).notNull().default('0'),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('compensation_employment_idx').on(t.employmentId, t.validFrom)],
);

// ───────────── Employee statutory profile — Malaysia pack (per-person) ─────────────
// Pack-owned (localization/my). Statutory identity is per Person, not per Employment.
export const employeeStatutoryMy = pgTable(
  'employee_statutory_my',
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id),
    icNumber: text('ic_number').notNull(),
    epfNumber: text('epf_number'),
    socsoNumber: text('socso_number'),
    taxNumber: text('tax_number'),
    eisEligible: boolean('eis_eligible').notNull().default(true),
    bankName: text('bank_name'),
    bankAccountNo: text('bank_account_no'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('employee_statutory_my_person_uq').on(t.personId),
    uniqueIndex('employee_statutory_my_ic_uq').on(t.tenantId, t.icNumber),
  ],
);

// ─────────────── Per-tenant counters (generic, e.g. employee codes) ───────────────
export const tenantCounter = pgTable(
  'tenant_counter',
  {
    tenantId: tenantId(),
    kind: text('kind').notNull(),
    value: bigint('value', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.kind] })],
);

// ─────────────── Public holiday calendar (generic; packs seed the data) ───────────────
export const holiday = pgTable(
  'holiday',
  {
    id: id(),
    tenantId: tenantId(),
    country: text('country').notNull(),
    holidayDate: date('holiday_date').notNull(),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('holiday_uq').on(t.tenantId, t.country, t.holidayDate)],
);

// ──────────────────────── Attendance (generic) ────────────────────────
export const attendanceStatusEnum = pgEnum('attendance_status', ['present', 'absent', 'late', 'half_day']);

// One row per employee per day. Absence is derived (no row); we store present/late/half_day.
export const attendance = pgTable(
  'attendance',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    attendanceDate: date('attendance_date').notNull(),
    checkInAt: time('check_in_at'),
    checkOutAt: time('check_out_at'),
    status: attendanceStatusEnum('status').notNull().default('present'),
    remarks: text('remarks'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('attendance_employment_date_uq').on(t.employmentId, t.attendanceDate)],
);

// Per-company attendance thresholds.
export const attendancePolicy = pgTable(
  'attendance_policy',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    lateAfter: time('late_after').notNull().default('09:15:00'),
    halfDayBefore: time('half_day_before').notNull().default('13:00:00'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('attendance_policy_company_uq').on(t.companyId)],
);

// ──────────────────────── Payroll (generic kernel) ────────────────────────
export const payrollStatusEnum = pgEnum('payroll_status', ['draft', 'processed', 'closed']);

export const payrollBatch = pgTable(
  'payroll_batch',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    payPeriod: text('pay_period').notNull(), // 'YYYY-MM'
    batchDate: date('batch_date').notNull(),
    status: payrollStatusEnum('status').notNull().default('draft'),
    employeeCount: integer('employee_count').notNull().default(0),
    totals: jsonb('totals'), // { gross, net, epfEmployee, epfEmployer, ... }
    remarks: text('remarks'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('payroll_batch_period_uq').on(t.companyId, t.payPeriod)],
);

export const payslip = pgTable(
  'payslip',
  {
    id: id(),
    tenantId: tenantId(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => payrollBatch.id),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    basicSalary: numeric('basic_salary', { precision: 12, scale: 2 }).notNull(),
    allowance: numeric('allowance', { precision: 12, scale: 2 }).notNull().default('0'),
    overtimePay: numeric('overtime_pay', { precision: 12, scale: 2 }).notNull().default('0'),
    grossPay: numeric('gross_pay', { precision: 12, scale: 2 }).notNull(),
    statutory: jsonb('statutory').notNull(), // { epfEmployee, epfEmployer, socsoEmployee, ... }
    otherDeductions: numeric('other_deductions', { precision: 12, scale: 2 }).notNull().default('0'),
    totalDeductions: numeric('total_deductions', { precision: 12, scale: 2 }).notNull(),
    netPay: numeric('net_pay', { precision: 12, scale: 2 }).notNull(),
    employerCost: numeric('employer_cost', { precision: 12, scale: 2 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('payslip_batch_employment_uq').on(t.batchId, t.employmentId)],
);
