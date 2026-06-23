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
import { sql } from 'drizzle-orm';
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
  check,
  customType,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/** Postgres `bytea` ↔ Node Buffer (postgres.js round-trips Buffers natively). */
const bytea = customType<{ data: Buffer; driver: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

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
export const leaveEntryTypeEnum = pgEnum('leave_entry_type', ['accrual', 'debit', 'adjustment', 'in_lieu_accrual']);
export const leaveRequestStatusEnum = pgEnum('leave_request_status', [
  'pending',
  'approved',
  'rejected',
  'cancelled',
]);
export const actorTypeEnum = pgEnum('actor_type', ['user', 'system', 'agent', 'external']);
// Performance (ADR-0013) — config-driven, statute-free; correctness is workflow/state, not numbers.
export const reviewCycleStatusEnum = pgEnum('review_cycle_status', [
  'draft',
  'open',
  'calibration',
  'closed',
]);
export const performanceReviewStatusEnum = pgEnum('performance_review_status', [
  'not_started',
  'self_review',
  'manager_review',
  'submitted',
  'acknowledged',
]);
export const compActionStatusEnum = pgEnum('comp_action_status', [
  'none',
  'recommended',
  'enacted',
  'declined',
]);
// Goal lifecycle (ADR-0022, Phase B). Continuous: a goal lives independent of any cycle.
export const goalStatusEnum = pgEnum('goal_status', ['active', 'achieved', 'missed', 'dropped']);
// Manager 1:1 check-in lifecycle (ADR-0022, Phase B slice 2).
export const checkinStatusEnum = pgEnum('checkin_status', ['scheduled', 'completed', 'cancelled']);
// 360 peer-feedback request lifecycle (ADR-0022, Phase B slice 3).
export const feedbackRequestStatusEnum = pgEnum('feedback_request_status', ['pending', 'submitted', 'declined']);
// Calibration session lifecycle (ADR-0022, Phase B slice 4). Advisory: admins propose, then COMMIT.
export const calibrationStatusEnum = pgEnum('calibration_status', ['open', 'committed']);
export const aiProviderEnum = pgEnum('ai_provider', ['anthropic', 'openai', 'google']);

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
    // Wave 2 (ADR-0038 2B-1): when true, leave requests in this company route through a multi-step
    // approval chain (direct manager → HR) instead of a single approval. Per-company; 2B-2 makes the
    // chain itself configurable.
    leaveMultiApproval: boolean('leave_multi_approval').notNull().default(false),
    // Wave 2 (ADR-0040 2D-2): earned-accrual cycle — 'calendar' (1 Jan–31 Dec, default) or 'anniversary'
    // (each employee accrues relative to their hire-month anniversary). Only earned policies read it.
    leaveCycle: text('leave_cycle').notNull().default('calendar'),
    // Wave 2 (ADR-0038 2C): the default state for employees with no explicit work_state — the holiday
    // fallback for this company.
    defaultWorkState: text('default_work_state'),
    // Self-referential group tree (ADR-0009). NULL = a group root. Cycle-guarded on write.
    parentCompanyId: uuid('parent_company_id').references((): AnyPgColumn => company.id),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('company_tenant_idx').on(t.tenantId),
    index('company_parent_idx').on(t.parentCompanyId),
  ],
);

// app_user = a login identity (WorkOS-sourced); optionally linked to a Person.
export const appUser = pgTable(
  'app_user',
  {
    id: id(),
    tenantId: tenantId(),
    workosUserId: text('workos_user_id').notNull(),
    personId: uuid('person_id').references(() => person.id),
    // First-login product tour (ADR-0018): NULL = not yet completed/dismissed. Written only through
    // the SECURITY DEFINER app.onboarding_* seam so a user can touch only their own flag.
    onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
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
  (t) => [
    index('role_assignment_user_idx').on(t.appUserId),
    // super_admin is inherently group-wide. A super_admin grant carrying a company_id is
    // incoherent: is_group_admin() treats it as global, yet is_admin_for(other_company) would
    // be false. Forbid the state at the DB so no code path can create it (ADR-0009).
    check('role_assignment_super_admin_group_wide', sql`${t.role} <> 'super_admin' OR ${t.companyId} IS NULL`),
  ],
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
    // Low-risk personal fields the employee self-maintains on /me (ADR-0012).
    address: text('address'),
    dateOfBirth: date('date_of_birth'),
    // Wave 2 (ADR-0038 2A): self-declared; gate maternity (female) / paternity (married male) eligibility.
    gender: text('gender'), // 'male' | 'female' | 'undisclosed'
    maritalStatus: text('marital_status'), // 'single' | 'married' | 'other'
    emergencyContactName: text('emergency_contact_name'),
    emergencyContactPhone: text('emergency_contact_phone'),
    // ADR-0029 scope-out: the single "paymaster" employment through which this person's taxable
    // remuneration runs for PCB when they hold concurrent employments across the group's companies.
    // FK to employment is added in migration 0069 (avoids the person↔employment cycle in TS).
    designatedPaymasterEmploymentId: uuid('designated_paymaster_employment_id'),
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
    archivedAt: timestamp('archived_at', { withTimezone: true }),
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
    archivedAt: timestamp('archived_at', { withTimezone: true }),
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
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('cost_center_company_idx').on(t.companyId)],
);

// Termination classification (Wave 4A) — powers the Terminations + Turnover analytics breakdown.
// Nullable: legacy/active employments have none; set when an employment is terminated.
export const terminationTypeEnum = pgEnum('termination_type', [
  'voluntary',
  'involuntary',
  'retired',
  'contract_end',
  'death',
  'other',
]);

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
    // Wave 2 (ADR-0041 2E): the employee's seniority grade — drives grade-scoped leave entitlements.
    // Null = ungraded (falls to the company-default leave policy).
    gradeId: uuid('grade_id').references(() => jobGrade.id),
    // Wave 2 (ADR-0038 2C): the state this employment works in — drives which state public holidays
    // apply. Null falls back to the company's default_work_state, then national-only.
    workState: text('work_state'),
    terminatedOn: date('terminated_on'),
    // Termination classification (Wave 4A). Captured at termination for turnover analytics.
    terminationType: terminationTypeEnum('termination_type'),
    terminationReason: text('termination_reason'),
    // Inter-company cost split for shared-services staff (ADR-0009): [{ companyId, percent }].
    costAllocation: jsonb('cost_allocation'),
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
  // Wave 2 (ADR-0038 2A): lawful eligibility gate — { gender?, maritalStatus?, minServiceMonths? }. null =
  // open to all. Enforced at requestLeave; mirrors only what the Act restricts (e.g. maternity is female-
  // only by EA s.37), so it never blocks a statutory entitlement.
  eligibility: jsonb('eligibility'),
  // Wave 2 (ADR-0038 2A-2): require a supporting document (e.g. an MC for sick leave). When true,
  // requestLeave rejects a request that has no attachment. Default false = no document needed.
  requiresDocument: boolean('requires_document').notNull().default(false),
  // Wave 2 (ADR-0038 2F-2 / R37): per-locale display names, { ms: { name }, zh: { name }, ... }.
  // Mirrors kb_document.i18n. Reads resolve to the viewer's locale, falling back to `name`.
  i18n: jsonb('i18n').$type<Record<string, { name: string }>>(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: createdAt(),
});

// Wave 2 (ADR-0041 2E): tenant grade catalog — seniority bands (Executive, Non-Executive, G1…).
// `rank` orders them (1 = most senior). Employees and leave policies reference a grade; null = ungraded
// / all-grades. RLS: tenant-read + admin-write (mirrors leave_type).
export const jobGrade = pgTable(
  'job_grade',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    rank: integer('rank').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('job_grade_code_uq').on(t.tenantId, t.code).where(sql`archived_at is null`)],
);

export const leavePolicy = pgTable(
  'leave_policy',
  {
    id: id(),
    tenantId: tenantId(),
    leaveTypeId: uuid('leave_type_id')
      .notNull()
      .references(() => leaveType.id),
    // Wave 2 (ADR-0041 2E): grade this policy applies to. null = all grades (the company default).
    gradeId: uuid('grade_id').references(() => jobGrade.id),
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

// Wave 2 (ADR-0038 2A-2): supporting documents for leave (e.g. MC). Mirrors claim_attachment:
// employment_id is denormalized from the request so RLS uses can_see_employment(employment_id)
// directly (same subject + manager + admin rule as leave_request, no per-row subquery).
export const leaveRequestAttachment = pgTable(
  'leave_request_attachment',
  {
    id: id(),
    tenantId: tenantId(),
    leaveRequestId: uuid('leave_request_id')
      .notNull()
      .references(() => leaveRequest.id),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    content: bytea('content').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    uploadedByUserId: uuid('uploaded_by_user_id'),
    createdAt: createdAt(),
  },
  (t) => [index('leave_request_attachment_request_idx').on(t.leaveRequestId)],
);

// Wave 2 (ADR-0038 2B): instance approval steps generated for a leave request when its company runs a
// multi-step chain. decideLeave advances the lowest-index pending step; the request is approved only
// when the final step clears, and rejected if any step is rejected. subject_employment_id is
// denormalized from the request so RLS reuses can_see_employment (same rule as leave_request).
export const leaveApprovalStep = pgTable(
  'leave_approval_step',
  {
    id: id(),
    tenantId: tenantId(),
    leaveRequestId: uuid('leave_request_id')
      .notNull()
      .references(() => leaveRequest.id),
    subjectEmploymentId: uuid('subject_employment_id')
      .notNull()
      .references(() => employment.id),
    stepIndex: integer('step_index').notNull(),
    approverKind: text('approver_kind').notNull(), // 'direct_manager' | 'hr_admin' (2B-2: named roles)
    status: leaveRequestStatusEnum('status').notNull().default('pending'),
    decidedByEmploymentId: uuid('decided_by_employment_id').references(() => employment.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('leave_approval_step_request_idx').on(t.leaveRequestId, t.stepIndex)],
);

// Wave 2 (ADR-0039 2B-2): the configurable approval chain. `levels` is an ordered array of level kinds
// ('direct_manager' | 'hr_admin'). A null leave_type_id is the company default; a non-null one overrides
// for that type. Resolved at request time (type-specific → default → built-in fallback). Catalog RLS:
// readable tenant-wide (the requester reads it to generate steps), writable by company admins.
export const leaveApprovalPolicy = pgTable(
  'leave_approval_policy',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    leaveTypeId: uuid('leave_type_id').references(() => leaveType.id),
    levels: jsonb('levels').notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('leave_approval_policy_company_default_uq')
      .on(t.companyId)
      .where(sql`leave_type_id is null`),
    uniqueIndex('leave_approval_policy_company_type_uq')
      .on(t.companyId, t.leaveTypeId)
      .where(sql`leave_type_id is not null`),
  ],
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
    // The employment this event is ABOUT (for RLS read-scoping). Null = no single employee
    // subject (company/tenant/batch events) → admin-only to read. ADR-0015.
    subjectEmploymentId: uuid('subject_employment_id').references(() => employment.id, {
      onDelete: 'set null',
    }),
    payload: jsonb('payload'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
    sequence: bigserial('sequence', { mode: 'number' }).notNull(),
    // ADR-0030 Layer 2: per-tenant tamper-evidence hash chain. NULL unless AUDIT_HASH_CHAIN_ENABLED — set
    // by a BEFORE INSERT trigger (migration 0074), never by appendEvent. chain_seq is contiguous per tenant
    // (a gap = a deleted row); hash = sha256(prev_hash ‖ canonical row); prev_hash links to the prior row.
    chainSeq: bigint('chain_seq', { mode: 'number' }),
    prevHash: text('prev_hash'),
    hash: text('hash'),
  },
  (t) => [
    index('domain_event_aggregate_idx').on(t.tenantId, t.aggregateType, t.aggregateId),
    index('domain_event_subject_idx').on(t.tenantId, t.subjectEmploymentId),
    index('domain_event_chain_idx').on(t.tenantId, t.chainSeq),
  ],
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

// EPF contribution mode per employee (Wave 2B, statutory-aligned). auto = statutory Third Schedule;
// voluntary_excess = i-Topup election (KWSP Form 17A/18A) at a rate AT OR ABOVE statutory, per side;
// exempt = no contribution, valid ONLY for legitimately-exempt employees (never to drop a mandatory
// employee below the s.43 floor). Sourced in docs/wave2-payroll-design.md.
export const epfModeEnum = pgEnum('epf_mode', ['auto', 'voluntary_excess', 'exempt']);

// ───────────── Employee statutory profile — Malaysia pack (per-person) ─────────────
// Pack-owned (localization/my). Statutory identity is per Person, not per Employment.
// EPF citizenship status — selects the contribution rule (Third Schedule). 'citizen'/'pr' < 60 use
// Part A; 'citizen' 60–<75 uses Part E (0%/4%); 'non_citizen' uses the new mandatory 2%/2% (eff 1 Oct
// 2025). Source: KWSP Jadual Ketiga (1 Oct 2025) + YiWei Law statutory deck (10 Jun 2026).
export const epfCitizenshipEnum = pgEnum('epf_citizenship', ['citizen', 'pr', 'non_citizen']);

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
    // PCB (MTD) inputs. taxCategory: 1=single, 2=married/spouse not working, 3=married/spouse working.
    taxCategory: integer('tax_category').notNull().default(1),
    numChildren: integer('num_children').notNull().default(0),
    // Non-residents pay flat 30% MTD (LHDN spec §D.a) — no reliefs, no accumulator method.
    isResident: boolean('is_resident').notNull().default(true),
    eisEligible: boolean('eis_eligible').notNull().default(true),
    // EPF citizenship status — drives the Third Schedule rule (Part A / Part E / non-citizen 2%/2%).
    epfCitizenship: epfCitizenshipEnum('epf_citizenship').notNull().default('citizen'),
    // EPF contribution mode (Wave 2B). For 'voluntary_excess' the elected per-side rates (decimals,
    // e.g. 0.1500 = 15%) apply AT OR ABOVE the statutory rate; null = that side stays statutory.
    // 'exempt' zeroes both sides (legitimately-exempt employees only). 'auto' ignores the rates.
    epfMode: epfModeEnum('epf_mode').notNull().default('auto'),
    epfEmployeeRate: numeric('epf_employee_rate', { precision: 5, scale: 4 }),
    epfEmployerRate: numeric('epf_employer_rate', { precision: 5, scale: 4 }),
    bankName: text('bank_name'),
    bankAccountNo: text('bank_account_no'),
    // TP3 / opening balances for PCB accumulators (ADR-0014): prior-employment (or pre-migration)
    // year-to-date figures, applied only when tp3Year matches the pay-period year. Per LHDN spec
    // §E.10 these feed the formula as (Y−K), K, X, Z and never appear on payslips or the EA form.
    tp3Year: integer('tp3_year'),
    tp3NetRemuneration: numeric('tp3_net_remuneration', { precision: 12, scale: 2 }),
    tp3EpfClaimed: numeric('tp3_epf_claimed', { precision: 12, scale: 2 }),
    tp3PcbPaid: numeric('tp3_pcb_paid', { precision: 12, scale: 2 }),
    tp3ZakatPaid: numeric('tp3_zakat_paid', { precision: 12, scale: 2 }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('employee_statutory_my_person_uq').on(t.personId),
    uniqueIndex('employee_statutory_my_ic_uq').on(t.tenantId, t.icNumber),
  ],
);

// HRD Corp (HRDF) registration band per employer (Wave 2A, PSMB Act 2001). not_registered = below
// the headcount threshold / not registered (no levy); mandatory = 10+ Malaysian employees (1%);
// optional = 5–9 who opt to register (0.5%). Sourced in docs/wave2-payroll-design.md.
export const hrdfStatusEnum = pgEnum('hrdf_status', ['not_registered', 'mandatory', 'optional']);

// Banks ai-hr can emit bulk salary-disbursement files for (ADR-0031). CIMB + Public Bank share the IBG
// Autopay layout; Maybank (M2E-RC) and RHB (Reflex) are distinct formats. The file format is derived from
// the bank in code, not stored.
export const disbursementBankEnum = pgEnum('disbursement_bank', ['maybank', 'cimb', 'public_bank', 'rhb']);

// MY company-level statutory identity (ADR-0009): each entity files under its own registrations.
export const companyStatutoryMy = pgTable(
  'company_statutory_my',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    epfEmployerNo: text('epf_employer_no'),
    socsoEmployerCode: text('socso_employer_code'),
    lhdnEmployerNo: text('lhdn_employer_no'), // LHDN "E" number (employer tax file)
    myinvoisTin: text('myinvois_tin'),
    ssmRegistrationNo: text('ssm_registration_no'),
    // HRD Corp levy registration band (Wave 2A). Drives the employer-only HRDF levy in payroll.
    hrdfStatus: hrdfStatusEnum('hrdf_status').notNull().default('not_registered'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('company_statutory_my_company_uq').on(t.companyId)],
);

// Per-company payroll scheduling config (ADR-0035 1B, #17): cut-off day (when inputs close), pay day,
// and payment basis. Scheduling METADATA in Wave 1 — drives display + future automation, NOT the period
// computation. An absent row ⇒ today's month-end defaults. RLS: company-scoped admin (is_admin_for),
// mirroring company_bank_profile.
export const companyPayrollConfig = pgTable(
  'company_payroll_config',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    cutOffDay: integer('cut_off_day'), // day of month payroll inputs close (1–31); null = month-end
    payDay: integer('pay_day'), // day of month salary is paid (1–31); null = month-end
    paymentBasis: text('payment_basis').notNull().default('monthly'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('company_payroll_config_company_uq').on(t.companyId)],
);

// Per-entity, per-bank disbursement profile (ADR-0031). Holds the BANK-ISSUED corporate/organisation ID
// + employer debit account needed in every bulk-payment file header. One row per (company, bank). These
// are sensitive employer credentials — RLS restricts both read and write to company-scoped admins.
export const companyBankProfile = pgTable(
  'company_bank_profile',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    bank: disbursementBankEnum('bank').notNull(),
    // Bank-issued: Maybank Corporate ID / CIMB 5-digit Autopay Org Code / RHB 6-digit Corporate ID /
    // Public Bank 3-char Org Code. Free text — each bank's shape differs; validated at file-build time.
    corporateId: text('corporate_id').notNull(),
    debitAccountNo: text('debit_account_no').notNull(),
    // Organisation name as registered with the bank (header field). Falls back to the company name in UI.
    orgName: text('org_name'),
    // Default transaction rail; RENTAS only matters for ≥ RM10k single payments (rare in payroll).
    txnType: text('txn_type').notNull().default('IBG'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('company_bank_profile_company_bank_uq').on(t.companyId, t.bank)],
);

// Per-subject crypto-shred key custody (ADR-0030 Layer 1). Each subject has a data-encryption key (DEK)
// wrapped by the master key (KMS/HSM in prod; env-derived interim). "Destruction" = NULL wrapped_dek + set
// destroyed_at → every value sealed under that DEK becomes unrecoverable across the append-only log without
// deleting any event row. subject_employment_id is a SOFT reference (no FK — avoids the person↔employment
// cascade-deadlock that bit migration 0069; validated in the service).
export const piiKey = pgTable(
  'pii_key',
  {
    id: id(),
    tenantId: tenantId(),
    subjectEmploymentId: uuid('subject_employment_id').notNull(),
    kid: text('kid').notNull(),
    wrappedDek: text('wrapped_dek'), // NULL once shredded
    createdAt: createdAt(),
    destroyedAt: timestamp('destroyed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('pii_key_subject_kid_uq').on(t.tenantId, t.subjectEmploymentId, t.kid)],
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
    // Wave 2 (ADR-0038 2C): null = national (applies everywhere); set = a state-specific holiday that
    // only applies to employees working in that state.
    state: text('state'),
    holidayDate: date('holiday_date').notNull(),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  // One holiday per (tenant, country, date, state-or-national). coalesce keeps the NULL (national) case
  // unique on PG14 (no NULLS NOT DISTINCT).
  (t) => [
    uniqueIndex('holiday_uq').on(t.tenantId, t.country, t.holidayDate, sql`coalesce(${t.state}, '')`),
  ],
);

// ──────────────────────── Attendance (generic) ────────────────────────
export const attendanceStatusEnum = pgEnum('attendance_status', ['present', 'absent', 'late', 'half_day']);
// Day classification drives the OT class (EA 1955: workday 1.5x, rest day 2x, holiday 3x — ADR-0011).
export const attendanceDayTypeEnum = pgEnum('attendance_day_type', ['workday', 'rest_day', 'holiday']);
export const attendanceCorrectionStatusEnum = pgEnum('attendance_correction_status', [
  'pending',
  'approved',
  'rejected',
]);

// Absence classification (Wave 4A) — set when a day is explicitly recorded/corrected as absent, so the
// absenteeism analytics can categorise unplanned absence (planned absence is already typed via leave).
export const absenceReasonEnum = pgEnum('absence_reason', [
  'sick',
  'casual',
  'medical',
  'unpaid',
  'emergency',
  'other',
]);

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
    // Reason when status='absent' (Wave 4A). Null for present/late/half_day or unclassified.
    absenceReason: absenceReasonEnum('absence_reason'),
    // Set at check-in (frozen against later policy/calendar edits); minutes derived at check-out (ADR-0011).
    dayType: attendanceDayTypeEnum('day_type'),
    workedMinutes: integer('worked_minutes'),
    otMinutes: integer('ot_minutes'),
    remarks: text('remarks'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('attendance_employment_date_uq').on(t.employmentId, t.attendanceDate)],
);

// Per-company attendance thresholds + work schedule (ADR-0011). One pattern per company;
// per-employee shift/roster overrides are a deliberate later phase.
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
    workStart: time('work_start').notNull().default('09:00:00'),
    workEnd: time('work_end').notNull().default('18:00:00'),
    breakMinutes: integer('break_minutes').notNull().default(60),
    // ISO weekday numbers (1=Mon … 7=Sun); default Mon–Fri.
    workingDays: integer('working_days')
      .array()
      .notNull()
      .default(sql`'{1,2,3,4,5}'::integer[]`),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('attendance_policy_company_uq').on(t.companyId)],
);

// Attendance correction requests (ADR-0011 Phase B): an employee proposes corrected punch
// times for a day; an admin or their manager approves, which amends the attendance row
// (re-derived through the time engine). Mirrors the leave request→decide workflow.
export const attendanceCorrection = pgTable(
  'attendance_correction',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    attendanceDate: date('attendance_date').notNull(),
    proposedCheckIn: time('proposed_check_in').notNull(),
    proposedCheckOut: time('proposed_check_out'),
    reason: text('reason'),
    status: attendanceCorrectionStatusEnum('status').notNull().default('pending'),
    decidedByEmploymentId: uuid('decided_by_employment_id').references(() => employment.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('attendance_correction_employment_idx').on(t.employmentId, t.attendanceDate)],
);

// ── Phase C: shift rosters (ADR-0032) ──────────────────────────────
// A configurable (NON-statutory) shift-differential pay rule. EA 1955 mandates no shift premium, so this
// is employer policy; the value feeds a typed pay-component (C5), never a sourced statutory rate.
export type ShiftDifferential = { kind: 'percent' | 'flat_hourly' | 'flat_per_shift'; value: number };

// A reusable named shift for a company (e.g. "Night A", 22:00–06:00). crossesMidnight = endTime ≤ startTime.
export const shift = pgTable(
  'shift',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    name: text('name').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    breakMinutes: integer('break_minutes').notNull().default(0),
    crossesMidnight: boolean('crosses_midnight').notNull().default(false),
    differential: jsonb('differential').$type<ShiftDifferential | null>(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('shift_company_name_uq').on(t.tenantId, t.companyId, t.name).where(sql`archived_at is null`)],
);

// The per-employee "expected" schedule the time engine consumes (C2). One concrete (employment, date) →
// a shift OR an explicit rest day; no row = not rostered ⇒ company-policy fallback. A DB CHECK
// (migration 0075) enforces the shift-xor-rest invariant.
export const rosterAssignment = pgTable(
  'roster_assignment',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    shiftDate: date('shift_date').notNull(),
    shiftId: uuid('shift_id').references(() => shift.id),
    isRestDay: boolean('is_rest_day').notNull().default(false),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('roster_assignment_emp_date_uq').on(t.tenantId, t.employmentId, t.shiftDate),
    index('roster_assignment_date_idx').on(t.tenantId, t.shiftDate),
  ],
);

// ── ADR-0033: Leave-in-lieu (TOIL). Gated (TOIL_ENABLED). A contractual replacement-leave engine that turns
// elected+approved rest-day/holiday/OT work into a REPLACEMENT-type leave credit, mutually exclusive with OT
// pay. The toil_accrual register is the source of truth for no-double-pay + expiry; each accrual also writes a
// signed leave_ledger credit so leaveBalance() just works. ──────────────────────────────────────────────
export const toilAccrualBasisEnum = pgEnum('toil_accrual_basis', ['hours_worked', 'premium_equivalent']);
export const toilExpiryActionEnum = pgEnum('toil_expiry_action', ['convert_to_pay', 'lapse']);
export const toilAccrualStatusEnum = pgEnum('toil_accrual_status', ['active', 'taken', 'converted_to_pay', 'lapsed']);
export type ToilAccrualBasis = (typeof toilAccrualBasisEnum.enumValues)[number];
export type ToilExpiryAction = (typeof toilExpiryActionEnum.enumValues)[number];
export type ToilAccrualStatus = (typeof toilAccrualStatusEnum.enumValues)[number];

// One TOIL policy per company. allowFirstScheduleEligible is the per-company toggle (ADR-0033 §6): OFF ⇒
// ≤RM4,000 staff cannot elect TOIL (cash only); ON ⇒ they may, but with a compliance warning + forced
// convert-to-pay on expiry (the floor protections never switch off).
export const toilPolicy = pgTable(
  'toil_policy',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    enabled: boolean('enabled').notNull().default(false),
    accrualBasis: toilAccrualBasisEnum('accrual_basis').notNull().default('hours_worked'),
    expiryDays: integer('expiry_days').notNull().default(90),
    onExpiry: toilExpiryActionEnum('on_expiry').notNull().default('convert_to_pay'),
    allowFirstScheduleEligible: boolean('allow_first_schedule_eligible').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('toil_policy_company_uq').on(t.companyId)],
);

// The TOIL register: one row per elected+approved worked day. Drives mutual-exclusion with OT pay (a day here
// is never also monetised) and the expiry sweep. ledgerEntryId points at the leave_ledger credit it wrote;
// takenByRequestId links the leave_request that later consumed it.
export const toilAccrual = pgTable(
  'toil_accrual',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    workedDate: date('worked_date').notNull(),
    dayType: attendanceDayTypeEnum('day_type').notNull(),
    otMinutes: integer('ot_minutes').notNull(),
    daysCredited: numeric('days_credited', { precision: 6, scale: 2 }).notNull(),
    accrualBasis: toilAccrualBasisEnum('accrual_basis').notNull(),
    expiresOn: date('expires_on').notNull(),
    status: toilAccrualStatusEnum('status').notNull().default('active'),
    // Frozen at accrual (ADR-0033 33-4): 'convert_to_pay' for a First-Schedule-eligible employee (floor
    // protection), else the policy's on_expiry. The expiry sweep follows this, not a re-derivation.
    expiryAction: toilExpiryActionEnum('expiry_action').notNull().default('convert_to_pay'),
    policyId: uuid('policy_id').references((): AnyPgColumn => toilPolicy.id),
    ledgerEntryId: uuid('ledger_entry_id').references((): AnyPgColumn => leaveLedger.id),
    takenByRequestId: uuid('taken_by_request_id').references((): AnyPgColumn => leaveRequest.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // At most one accrual per worked day — the no-double-pay guard at the DB level.
    uniqueIndex('toil_accrual_emp_date_uq').on(t.tenantId, t.employmentId, t.workedDate),
    index('toil_accrual_expiry_idx').on(t.tenantId, t.status, t.expiresOn),
  ],
);

// ── ADR-0034: notification engine. Gated (NOTIFICATIONS_ENABLED). A recipient-scoped notification model
// derived from the domain-event log: a dispatch sweep maps events → notifications via a registry.
// notification + notification_pref are recipient-only (RLS via app.is_self_person); notification_delivery +
// notification_cursor are dispatcher-internal (app.is_admin). ────────────────────────────────────────────
export const notificationSeverityEnum = pgEnum('notification_severity', ['info', 'action', 'warning']);
export const notificationChannelEnum = pgEnum('notification_channel', ['in_app', 'email', 'whatsapp', 'push']);
export const notificationDeliveryStatusEnum = pgEnum('notification_delivery_status', ['pending', 'sent', 'failed', 'skipped']);
export type NotificationSeverity = (typeof notificationSeverityEnum.enumValues)[number];
export type NotificationChannel = (typeof notificationChannelEnum.enumValues)[number];
export type NotificationDeliveryStatus = (typeof notificationDeliveryStatusEnum.enumValues)[number];

// One row per (recipient, notification). sourceEventId is a SOFT pointer to domain_event.id (no FK: the event
// log is append-only + subject-RLS'd, and a notification is a derived projection with its own lifecycle).
export const notification = pgTable(
  'notification',
  {
    id: id(),
    tenantId: tenantId(),
    recipientEmploymentId: uuid('recipient_employment_id')
      .notNull()
      .references(() => employment.id),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    linkPath: text('link_path'),
    severity: notificationSeverityEnum('severity').notNull().default('info'),
    sourceEventId: uuid('source_event_id'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('notification_recipient_idx').on(t.tenantId, t.recipientEmploymentId, t.createdAt),
    index('notification_unread_idx').on(t.tenantId, t.recipientEmploymentId).where(sql`read_at is null`),
  ],
);

// Per (recipient, category, channel) toggle; an absent row means the channel default.
export const notificationPref = pgTable(
  'notification_pref',
  {
    id: id(),
    tenantId: tenantId(),
    recipientEmploymentId: uuid('recipient_employment_id')
      .notNull()
      .references(() => employment.id),
    category: text('category').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('notification_pref_uq').on(t.tenantId, t.recipientEmploymentId, t.category, t.channel)],
);

// Out-of-app delivery attempts (in-app needs no row — the notification IS the in-app delivery).
export const notificationDelivery = pgTable(
  'notification_delivery',
  {
    id: id(),
    tenantId: tenantId(),
    notificationId: uuid('notification_id')
      .notNull()
      .references((): AnyPgColumn => notification.id),
    channel: notificationChannelEnum('channel').notNull(),
    status: notificationDeliveryStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('notification_delivery_pending_idx').on(t.tenantId, t.status)],
);

// Dispatcher state: the last domain_event.sequence (a monotonic bigserial — exact, unlike a timestamp which
// loses sub-millisecond precision on the JS Date round-trip and would re-process events) processed per
// tenant. The event log stays append-only — no mutable column on domain_event.
export const notificationCursor = pgTable(
  'notification_cursor',
  {
    id: id(),
    tenantId: tenantId(),
    lastSequence: bigint('last_sequence', { mode: 'number' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('notification_cursor_tenant_uq').on(t.tenantId)],
);

export const profileChangeStatusEnum = pgEnum('profile_change_status', [
  'pending',
  'approved',
  'rejected',
]);

// Pay-affecting profile changes the employee proposes on /me (bank account, dependents, PCB
// category — all on employee_statutory_my). An admin or their manager approves before it takes
// effect (ADR-0012). `proposed` is a jsonb patch; approval applies only the keys it carries.
// Low-risk contact fields are edited directly on `person` and do NOT pass through here.
export const profileChangeRequest = pgTable(
  'profile_change_request',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id),
    proposed: jsonb('proposed').notNull(),
    status: profileChangeStatusEnum('status').notNull().default('pending'),
    decidedByEmploymentId: uuid('decided_by_employment_id').references(() => employment.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('profile_change_request_employment_idx').on(t.employmentId, t.status)],
);

// ──────────────────────── Payroll (generic kernel) ────────────────────────
export const payrollStatusEnum = pgEnum('payroll_status', ['draft', 'processed', 'closed']);

// ─────────────── Multi-cycle payroll (Wave 2C, ADR-0024) — GATED ───────────────
// GATED behind MULTI_CYCLE_PAYROLL_ENABLED: the schema + backfill exist, but the kernel still
// rejects a 2nd run per (company, month) until the flag is on (post accountant sign-off, ADR-0024 §7).
export const payPeriodStatusEnum = pgEnum('pay_period_status', ['open', 'closed']);
export const payrollRunTypeEnum = pgEnum('payroll_run_type', [
  'regular', // normal remuneration (Y1) — exactly one per period (ADR-0024 §6)
  'off_cycle',
  'bonus',
  'adjustment',
]);

// The statutory month (Act 4 s.6(7)) as a first-class entity owning one or more runs (payroll_batch).
// The single monthly SOCSO/EIS contribution, the single monthly MTD computation, and the month-level
// ruleset snapshot belong here rather than being inferred from sibling batch scans.
export const payPeriod = pgTable(
  'pay_period',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    period: text('period').notNull(), // 'YYYY-MM'
    status: payPeriodStatusEnum('status').notNull().default('open'),
    // One ruleset version for the whole month (ADR-0024 D7). Null on legacy backfilled periods.
    statutoryVersion: text('statutory_version'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('pay_period_company_period_uq').on(t.companyId, t.period)],
);

export const payrollBatch = pgTable(
  'payroll_batch',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    // ADR-0024 (Wave 2C): a "run" within a pay_period. Backfilled so every existing batch is
    // run_seq=1, run_type='regular' under one parent per (company, month) — behaviour-preserving.
    payPeriodId: uuid('pay_period_id')
      .notNull()
      .references(() => payPeriod.id),
    runSeq: integer('run_seq').notNull().default(1),
    runType: payrollRunTypeEnum('run_type').notNull().default('regular'),
    payPeriod: text('pay_period').notNull(), // 'YYYY-MM' — denormalized (== parent.period); read paths use it
    batchDate: date('batch_date').notNull(),
    status: payrollStatusEnum('status').notNull().default('draft'),
    employeeCount: integer('employee_count').notNull().default(0),
    totals: jsonb('totals'), // { gross, net, epfEmployee, epfEmployer, ... }
    // ADR-0035 1E (#23): optional subset selection — { departmentIds?, employmentIds? }. null/empty ⇒
    // whole company (today's behaviour). Generation narrows the active-employee set to this scope.
    scope: jsonb('scope'),
    remarks: text('remarks'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('payroll_batch_period_run_uq').on(t.payPeriodId, t.runSeq),
    // ADR-0024 §6: at most one regular run per period (the others are additional remuneration). Since
    // pay_period is unique per (company, month), this preserves "≤1 regular batch per company-month" at
    // the DB level even though the old (company_id, pay_period) unique index is dropped.
    uniqueIndex('payroll_batch_one_regular_uq')
      .on(t.payPeriodId)
      .where(sql`run_type = 'regular'`),
  ],
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
    bonus: numeric('bonus', { precision: 12, scale: 2 }).notNull().default('0'),
    // Days the employee was active/paid in the period (proration basis). Null = legacy / full month.
    daysWorked: numeric('days_worked', { precision: 5, scale: 2 }),
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

// Per-employee, per-batch payroll inputs entered before generation. Overtime is manual; unpaid
// leave is auto-derived from approved unpaid leave requests at generation time (not stored here).
export const payrollInput = pgTable(
  'payroll_input',
  {
    id: id(),
    tenantId: tenantId(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => payrollBatch.id),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    overtimeAmount: numeric('overtime_amount', { precision: 12, scale: 2 }).notNull().default('0'),
    bonusAmount: numeric('bonus_amount', { precision: 12, scale: 2 }).notNull().default('0'),
    // PCB inputs (LHDN spec): TP1 optional deductions claimed this month (LP₁) and zakat paid
    // via salary deduction — zakat offsets the month's MTD per §E.5 and accumulates into Z.
    tp1Deduction: numeric('tp1_deduction', { precision: 12, scale: 2 }).notNull().default('0'),
    zakat: numeric('zakat', { precision: 12, scale: 2 }).notNull().default('0'),
    // Sum of approved TAXABLE claims prefilled into this batch (ADR-0021). Added to the taxable allowance
    // base in generatePayslips → contributes to PCB/EPF/SOCSO/EIS like a regular monthly allowance.
    claimAllowance: numeric('claim_allowance', { precision: 12, scale: 2 }).notNull().default('0'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('payroll_input_batch_emp_uq').on(t.batchId, t.employmentId)],
);

// ─────────────── Typed pay components (Wave 3 #9, ADR-0025) ───────────────
// GATED behind TYPED_PAY_COMPONENTS_ENABLED — the kernel only reads these when the flag is on.
export const payComponentKindEnum = pgEnum('pay_component_kind', [
  'allowance',
  'deduction',
  'contribution',
  'non_payable',
]);

// Tenant catalog of pay components with per-component statutory treatment flags (defaults seeded from
// docs/architecture/MY-pay-component-treatment-matrix.md). Admin-write, tenant-read (like leave_type).
export const payComponent = pgTable(
  'pay_component',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: payComponentKindEnum('kind').notNull(),
    // Treatment flags — which statutory base the component feeds (the four MY "wages" definitions).
    includedInEpf: boolean('included_in_epf').notNull().default(false),
    includedInSocsoEis: boolean('included_in_socso_eis').notNull().default(false),
    includedInPcb: boolean('included_in_pcb').notNull().default(true),
    includedInHrdfBase: boolean('included_in_hrdf_base').notNull().default(false),
    // BIK/perquisite: taxable (PCB) but not paid in cash, so excluded from cash gross/net.
    isNonPayable: boolean('is_non_payable').notNull().default(false),
    // Whether the amount prorates for a mid-period joiner/leaver.
    prorates: boolean('prorates').notNull().default(true),
    // Wave 1 (ADR-0035 1A): which annual EA-form (Borang EA / C.P.8A Part B) line this component maps to,
    // so EA totals stay reconcilable (#14). Constrained app-side to EA_FORM_LINES; null = unmapped.
    eaFormLine: text('ea_form_line'),
    // Rounding applied to THIS component's payable amount before it enters gross (#15): none|up|down|
    // nearest (whole ringgit). 'none' = exact 2dp (the legacy behaviour → byte-identical). NEVER touches
    // statutory contribution rounding, which keeps its own legislated rules.
    roundingMethod: text('rounding_method').notNull().default('none'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('pay_component_code_uq').on(t.tenantId, t.code)],
);

// Recurring per-employment component values, effective-dated like compensation. RLS: admin-or-self
// (amounts are pay — Wave 1 #5).
export const employmentPayComponent = pgTable(
  'employment_pay_component',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    componentId: uuid('component_id')
      .notNull()
      .references(() => payComponent.id),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull().default('0'),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('employment_pay_component_idx').on(t.employmentId, t.validFrom)],
);

// One-off per-batch component values (an off-cycle allowance/deduction for this run). RLS: admin-only
// (like payroll_input).
export const payrollBatchComponent = pgTable(
  'payroll_batch_component',
  {
    id: id(),
    tenantId: tenantId(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => payrollBatch.id),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    componentId: uuid('component_id')
      .notNull()
      .references(() => payComponent.id),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull().default('0'),
    notes: text('notes'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('payroll_batch_component_uq').on(t.batchId, t.employmentId, t.componentId)],
);

// Statutory / compliance report artefact (ADR-0010). Append-only record of a generated filing —
// derived from payslips but persisted for audit/idempotency (who generated what, against which
// statutory-table version). Filed per legal entity (company_id); never mutated after submission.
export const statutoryReport = pgTable(
  'statutory_report',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    jurisdiction: text('jurisdiction').notNull(), // 'MY'
    reportType: text('report_type').notNull(), // e.g. 'my.contributions'
    periodKind: text('period_kind').notNull(), // 'month' | 'year' | 'event'
    periodKey: text('period_key').notNull(), // e.g. '2026-07'
    status: text('status').notNull().default('draft'), // draft | final | submitted | amended
    statutoryVersion: text('statutory_version'), // MY_STATUTORY_VERSION at generation time
    rowCount: integer('row_count').notNull().default(0),
    totals: jsonb('totals'), // { epfEmployee, epfEmployer, socsoEmployee, ..., pcb }
    generatedBy: uuid('generated_by'), // app_user id (actor also on the domain event)
    generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('statutory_report_tenant_idx').on(t.tenantId),
    index('statutory_report_company_period_idx').on(t.companyId, t.reportType, t.periodKey),
  ],
);

// ───────────────────── Performance & talent (ADR-0013) ─────────────────────
// The first unregulated, entirely config-driven module: no statutory floor, no "correct" rating.
// The review cycle is the backbone; the pay seam (rating → recommendation → enacted via the tested
// comp/payroll engines) is the reason it lives here. Rating scales / cadence / merit pool are
// tenant config in the DB (like leave_policy), not country-pack code.

export const reviewCycle = pgTable(
  'review_cycle',
  {
    id: id(),
    tenantId: tenantId(),
    // null = group-wide (all companies the opener administers); else scoped to one company subtree.
    companyId: uuid('company_id').references(() => company.id),
    name: text('name').notNull(), // e.g. "2026 Annual"
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    status: reviewCycleStatusEnum('status').notNull().default('draft'),
    ratingScale: jsonb('rating_scale').notNull(), // [{ value:int, label:string }] — configurable
    // Optional merit pool the manager recommendations are tracked against (soft cap).
    meritBudget: jsonb('merit_budget'), // { kind: 'percent' | 'amount', value: number } | null
    excludeProbation: boolean('exclude_probation').notNull().default(true),
    hiredBefore: date('hired_before'), // only include employees hired on/before this; null = no cutoff
    // The release gate: manager ratings/overall become employee-visible only once this is set.
    releasedAt: timestamp('released_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('review_cycle_tenant_idx').on(t.tenantId, t.companyId)],
);

// One row per employee per cycle. RLS = can_see_employment (admin + self + admin-line manager);
// the SERVICE enforces who may drive which transition (self vs manager) and column scope, exactly
// as leave_request does. Employee-facing reads withhold manager/comp fields until release.
export const performanceReview = pgTable(
  'performance_review',
  {
    id: id(),
    tenantId: tenantId(),
    cycleId: uuid('cycle_id')
      .notNull()
      .references(() => reviewCycle.id),
    employmentId: uuid('employment_id') // subject
      .notNull()
      .references(() => employment.id),
    // The administrative-line manager resolved at spawn; null = no manager (admin reviews).
    reviewerEmploymentId: uuid('reviewer_employment_id').references(() => employment.id),
    status: performanceReviewStatusEnum('status').notNull().default('not_started'),
    selfRating: integer('self_rating'),
    selfComments: text('self_comments'),
    goalsSummary: text('goals_summary'), // the Phase-B goal hook: objectives referenced this cycle
    managerRating: integer('manager_rating'),
    managerComments: text('manager_comments'),
    overallRating: integer('overall_rating'),
    // Pay seam (free-form recommendation; admin enacts via setCompensation / payroll bonus).
    recommendedMeritPct: numeric('recommended_merit_pct', { precision: 5, scale: 2 }),
    recommendedBonus: numeric('recommended_bonus', { precision: 12, scale: 2 }),
    compActionStatus: compActionStatusEnum('comp_action_status').notNull().default('none'),
    enactedCompensationId: uuid('enacted_compensation_id'), // resulting comp row (merit), for audit
    enactedBatchId: uuid('enacted_batch_id'), // payroll batch the bonus was staged into
    enactedAt: timestamp('enacted_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('performance_review_cycle_emp_uq').on(t.cycleId, t.employmentId),
    index('performance_review_employment_idx').on(t.employmentId),
    index('performance_review_reviewer_idx').on(t.reviewerEmploymentId),
  ],
);

// Goals / OKRs (ADR-0022, Phase B). Owned by an employment; cycle_id is NULLABLE — a goal lives
// continuously and optionally binds to a review cycle. RLS = can_see_employment (subject + admin-line
// manager + admin can read/write). Goals are reference signal only; they NEVER compute a rating or pay.
export const performanceGoal = pgTable(
  'performance_goal',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    cycleId: uuid('cycle_id').references(() => reviewCycle.id), // null = continuous (no cycle)
    title: text('title').notNull(),
    description: text('description'),
    metric: text('metric'), // free-form measure, e.g. "NPS" or "deals closed"
    target: text('target'), // free-form target, e.g. "> 50" or "12"
    weight: numeric('weight', { precision: 5, scale: 2 }), // optional relative weight
    progress: integer('progress').notNull().default(0), // 0–100
    status: goalStatusEnum('status').notNull().default('active'),
    dueOn: date('due_on'),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('performance_goal_employment_idx').on(t.employmentId),
    index('performance_goal_cycle_idx').on(t.cycleId),
  ],
);

// Join: which goals a manager referenced on a given review (the goalsSummary text hook, structured).
export const reviewGoal = pgTable(
  'review_goal',
  {
    id: id(),
    tenantId: tenantId(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => performanceReview.id),
    goalId: uuid('goal_id')
      .notNull()
      .references(() => performanceGoal.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('review_goal_review_goal_uq').on(t.reviewId, t.goalId)],
);

// Manager 1:1 check-ins (ADR-0022, Phase B slice 2). A lightweight recurring touchpoint between a
// manager and a report — continuous (no cycle required). RLS = can_see_employment(subject) so the
// subject, their admin-line manager and admins see it; the service enforces who may schedule/complete.
export const performanceCheckin = pgTable(
  'performance_checkin',
  {
    id: id(),
    tenantId: tenantId(),
    subjectEmploymentId: uuid('subject_employment_id')
      .notNull()
      .references(() => employment.id),
    // The manager conducting the 1:1 (the subject's admin-line manager at schedule time), or null.
    managerEmploymentId: uuid('manager_employment_id').references(() => employment.id),
    scheduledOn: date('scheduled_on').notNull(),
    status: checkinStatusEnum('status').notNull().default('scheduled'),
    notes: text('notes'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('performance_checkin_subject_idx').on(t.subjectEmploymentId),
    index('performance_checkin_manager_idx').on(t.managerEmploymentId),
  ],
);

// 360 peer feedback (ADR-0022, Phase B slice 3). A manager/admin invites peers to give feedback on a
// subject for a review. ANONYMITY (ADR-0022 default): authorship lives ONLY here on the request —
// peer_feedback itself carries no author, so the subject (who is denied this table by RLS) sees feedback
// content without attribution. The peer responds to their own request; the subject never sees the
// requester list.
export const peerFeedbackRequest = pgTable(
  'peer_feedback_request',
  {
    id: id(),
    tenantId: tenantId(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => performanceReview.id),
    subjectEmploymentId: uuid('subject_employment_id')
      .notNull()
      .references(() => employment.id),
    peerEmploymentId: uuid('peer_employment_id')
      .notNull()
      .references(() => employment.id),
    // Display names denormalized at request time (resolved by the inviting manager, who can see both):
    // a 360 crosses RLS name-visibility boundaries, so the peer/manager can't re-resolve these later.
    subjectName: text('subject_name').notNull(),
    peerName: text('peer_name').notNull(),
    cycleName: text('cycle_name'),
    status: feedbackRequestStatusEnum('status').notNull().default('pending'),
    requestedByUserId: uuid('requested_by_user_id'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('peer_feedback_request_review_peer_uq').on(t.reviewId, t.peerEmploymentId),
    index('peer_feedback_request_subject_idx').on(t.subjectEmploymentId),
    index('peer_feedback_request_peer_idx').on(t.peerEmploymentId),
  ],
);

// The feedback content. Carries a denormalized subject_employment_id so RLS = can_see_employment(subject)
// is a direct check (the subject + their manager + admin read CONTENT). It deliberately has NO author
// column — the peer identity is on the request, which the subject's RLS denies → anonymous-by-construction.
// `named` records that the peer opted to be identifiable (surfaced to the manager, not the subject in v1).
export const peerFeedback = pgTable(
  'peer_feedback',
  {
    id: id(),
    tenantId: tenantId(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => peerFeedbackRequest.id),
    subjectEmploymentId: uuid('subject_employment_id')
      .notNull()
      .references(() => employment.id),
    strengths: text('strengths'),
    improvements: text('improvements'),
    named: boolean('named').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('peer_feedback_request_uq').on(t.requestId),
    index('peer_feedback_subject_idx').on(t.subjectEmploymentId),
  ],
);

// Calibration (ADR-0022, slice 4). A session over a cycle in 'calibration' status; participants propose
// adjusted overall ratings, an admin COMMITS them (writes performance_review.overall_rating + an event).
// Advisory by default — a proposal never mutates a rating until the explicit commit. Admin-scoped (the
// session belongs to a cycle whose writes are already admin-gated); RLS = tenant isolation.
export const calibrationSession = pgTable(
  'calibration_session',
  {
    id: id(),
    tenantId: tenantId(),
    cycleId: uuid('cycle_id')
      .notNull()
      .references(() => reviewCycle.id),
    status: calibrationStatusEnum('status').notNull().default('open'),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('calibration_session_cycle_idx').on(t.cycleId)],
);

export const calibrationEntry = pgTable(
  'calibration_entry',
  {
    id: id(),
    tenantId: tenantId(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => calibrationSession.id),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => performanceReview.id),
    proposedRating: integer('proposed_rating'),
    committedRating: integer('committed_rating'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('calibration_entry_session_review_uq').on(t.sessionId, t.reviewId)],
);

// ─────────────────────── AI provider configuration (ADR-0023) ───────────────────────
// Per-tenant BYOK config for the AI gateway: each row is one provider this tenant has set up with an
// encrypted key. `api_key_ciphertext` is AES-256-GCM (tenant id as AAD) — NEVER selected for the UI
// (column SELECT is REVOKEd from the app role in the RLS migration; reads go through a SECURITY
// DEFINER resolver). Exactly one row may be `is_active` per tenant (partial-unique index, RLS
// migration). Writes are admin-only (RLS WITH CHECK app.is_admin()).
export const aiProviderConfig = pgTable(
  'ai_provider_config',
  {
    id: id(),
    tenantId: tenantId(),
    provider: aiProviderEnum('provider').notNull(),
    model: text('model').notNull(),
    // Encrypted at rest; opaque base64url token. Never returned to the client.
    apiKeyCiphertext: text('api_key_ciphertext').notNull(),
    keyLast4: text('key_last4').notNull(),
    isActive: boolean('is_active').notNull().default(false),
    createdByUserId: uuid('created_by_user_id'),
    updatedByUserId: uuid('updated_by_user_id'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('ai_provider_config_tenant_provider_uq').on(t.tenantId, t.provider)],
);

// ─────────────────────── Knowledge Base (ADR-0017) ───────────────────────
// A tenant-shared repository of documents. Two content kinds in one table: 'article' = Markdown
// authored/edited in-app; 'file' = an uploaded binary (bytes in `content`). The seeded module user
// guides are articles with is_system = true (idempotent by slug).

export const kbKindEnum = pgEnum('kb_kind', ['article', 'file']);
// Informational filter for the library, NOT an access control — every tenant member reads all KB.
export const kbAudienceEnum = pgEnum('kb_audience', ['all', 'employee', 'manager', 'hr_admin']);

export const kbDocument = pgTable(
  'kb_document',
  {
    id: id(),
    tenantId: tenantId(),
    kind: kbKindEnum('kind').notNull(),
    title: text('title').notNull(),
    // Stable identifier: clean URLs + idempotent upsert key for the seeded system guides.
    slug: text('slug'),
    // Module tag for grouping in the library (e.g. 'getting-started', 'payroll', 'general').
    category: text('category').notNull().default('general'),
    audience: kbAudienceEnum('audience').notNull().default('all'),
    // True for the auto-seeded official guides; protects them from non-admin edits/deletes (RLS).
    isSystem: boolean('is_system').notNull().default(false),
    // kind = 'article': the Markdown body (the English source / fallback for system guides).
    body: text('body'),
    // Per-locale translated content for system guides (ADR-0017): { <locale>: { title, body } }.
    // Reads resolve the active locale and fall back to the base title/body. Null for user docs.
    i18n: jsonb('i18n').$type<Record<string, { title: string; body: string }>>(),
    // kind = 'file': the uploaded bytes + descriptors. `content` is only ever selected on download.
    fileName: text('file_name'),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes'),
    content: bytea('content'),
    createdByUserId: uuid('created_by_user_id').references(() => appUser.id),
    updatedByUserId: uuid('updated_by_user_id').references(() => appUser.id),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('kb_document_tenant_idx').on(t.tenantId),
    index('kb_document_category_idx').on(t.tenantId, t.category),
    // Slug is unique per tenant when present (system guides rely on it for idempotent upsert).
    uniqueIndex('kb_document_tenant_slug_uq').on(t.tenantId, t.slug),
    // A row is one kind XOR the other: an article has a body; a file has bytes + a name.
    check(
      'kb_document_kind_shape',
      sql`(${t.kind} = 'article' AND ${t.body} IS NOT NULL AND ${t.content} IS NULL)
          OR (${t.kind} = 'file' AND ${t.content} IS NOT NULL AND ${t.fileName} IS NOT NULL)`,
    ),
  ],
);

// ─────────────────────── Statutory ruleset override (ADR-0019) ───────────────────────
// Effective-dated override for a country's statutory figures (EPF/SOCSO/EIS/PCB/OT). `data` is a
// StatutoryRuleset JSON (localization/my/statutory-tables.ts). The loader picks the latest row with
// effective_from ≤ asOf; an empty table falls back to the verified built-in DEFAULT_MY_STATUTORY.
// Past payslips snapshot their own figures + version, so edits only affect FUTURE runs.

export const statutoryRuleset = pgTable(
  'statutory_ruleset',
  {
    id: id(),
    tenantId: tenantId(),
    country: text('country').notNull().default('MY'),
    version: text('version').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    data: jsonb('data').notNull(),
    notes: text('notes'),
    createdByUserId: uuid('created_by_user_id').references(() => appUser.id),
    createdAt: createdAt(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('statutory_ruleset_lookup_idx').on(t.tenantId, t.country, t.effectiveFrom)],
);

// ───────────────────── Statutory data-pack distribution (ADR-0020) ─────────────────────
// NATIONAL, vendor-signed statutory data — NOT tenant-scoped (no tenant_id). The trust boundary is enforced
// in the RLS migration: SELECT granted to every tenant (USING(true)); INSERT/UPDATE/DELETE REVOKED from
// ai_hr_app (the live cluster's default privileges auto-grant arwd, so SELECT-only by omission does not
// work). The only writer is the owner role via `pnpm statutory:sync` (RLS ENABLED but NOT FORCEd, so the
// owner ingests while ai_hr_app cannot write). Verified pack rulesets, the materialized trust bundle, and a
// sync audit log.

export const statutoryPack = pgTable(
  'statutory_pack',
  {
    id: id(),
    country: text('country').notNull().default('MY'),
    schemaVersion: integer('schema_version').notNull(),
    packVersion: text('pack_version').notNull(),
    rulesetVersion: text('ruleset_version').notNull(),
    effectiveFrom: date('effective_from').notNull(), // first-of-month (validated at ingest)
    data: jsonb('data').notNull(), // StatutoryRuleset
    checksum: text('checksum').notNull(),
    signedKeyId: text('signed_key_id').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).defaultNow().notNull(),
    ingestedSource: text('ingested_source'),
  },
  (t) => [
    uniqueIndex('statutory_pack_identity_uq').on(t.country, t.packVersion, t.rulesetVersion, t.effectiveFrom),
    index('statutory_pack_lookup_idx').on(t.country, t.effectiveFrom),
  ],
);

// Materialized trust bundle: the currently-certified operational signing keys + their revocation/expiry.
export const statutorySigningKey = pgTable('statutory_signing_key', {
  keyId: text('key_id').primaryKey(),
  publicKey: text('public_key').notNull(),
  status: text('status').notNull().default('active'), // 'active' | 'revoked'
  certifiedAt: timestamp('certified_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  trustSequence: integer('trust_sequence').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Sync/ingest audit + observability (latest sequence seen, counts, errors). App-readable for the staleness UI.
export const statutoryPackSyncLog = pgTable('statutory_pack_sync_log', {
  id: id(),
  ranAt: timestamp('ran_at', { withTimezone: true }).defaultNow().notNull(),
  source: text('source').notNull(),
  sequenceSeen: integer('sequence_seen'),
  ingested: integer('ingested').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  error: text('error'),
});

// ─────────────────────────────── Claims (ADR-0021) ───────────────────────────────
// Employee expense/benefit claims. A claim's `taxable` flag (HR-decided, defaulted from the type) routes
// the payout: non-taxable → off-cycle reimbursement export (never touches payroll); taxable → a Claims
// allowance line on the next payslip (payroll_input.claim_allowance). Mirrors the leave catalog/policy +
// the request lifecycle (assertCanDecide + domain events). Receipts in a dedicated, claim-scoped table.

export const claimStatusEnum = pgEnum('claim_status', ['pending', 'approved', 'rejected', 'cancelled', 'paid']);

export const claimType = pgTable(
  'claim_type',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(), // e.g. 'MEDICAL', 'TRAVEL', 'MEALS'
    name: text('name').notNull(),
    /** Seeds each new claim's `taxable`; the approver confirms/overrides per claim (flat tax, ADR-0021). */
    defaultTaxable: boolean('default_taxable').notNull().default(false),
    requiresReceipt: boolean('requires_receipt').notNull().default(true),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('claim_type_tenant_idx').on(t.tenantId),
    // One live code per tenant (archived rows may share a code that was re-created).
    uniqueIndex('claim_type_tenant_code_uq').on(t.tenantId, t.code).where(sql`archived_at IS NULL`),
  ],
);

export const claimPolicy = pgTable(
  'claim_policy',
  {
    id: id(),
    tenantId: tenantId(),
    claimTypeId: uuid('claim_type_id')
      .notNull()
      .references(() => claimType.id),
    /** NULL = unlimited. Annual cap on approved claims of this type per employee. */
    annualBudget: numeric('annual_budget', { precision: 12, scale: 2 }),
    /** NULL = no cap. Max amount of a single claim. */
    perClaimCap: numeric('per_claim_cap', { precision: 12, scale: 2 }),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    createdAt: createdAt(),
  },
  (t) => [index('claim_policy_type_idx').on(t.claimTypeId, t.validFrom)],
);

export const claimRequest = pgTable(
  'claim_request',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    claimTypeId: uuid('claim_type_id')
      .notNull()
      .references(() => claimType.id),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    incurredOn: date('incurred_on').notNull(), // the expense date
    description: text('description'),
    /** HR-decided (default from the type). taxable ⇒ payroll allowance; non-taxable ⇒ reimbursement. */
    taxable: boolean('taxable').notNull().default(false),
    status: claimStatusEnum('status').notNull().default('pending'),
    decidedByEmploymentId: uuid('decided_by_employment_id').references(() => employment.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    // Payout provenance: taxable → the batch it rode; either → when/how it was paid.
    payrollBatchId: uuid('payroll_batch_id').references(() => payrollBatch.id),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    payoutRef: text('payout_ref'),
    createdAt: createdAt(),
  },
  (t) => [index('claim_request_employment_idx').on(t.employmentId, t.status)],
);

export const claimAttachment = pgTable(
  'claim_attachment',
  {
    id: id(),
    tenantId: tenantId(),
    claimRequestId: uuid('claim_request_id')
      .notNull()
      .references(() => claimRequest.id),
    // Denormalized from the claim so RLS can use can_see_employment(employment_id) directly (no subquery).
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    content: bytea('content').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => appUser.id),
    createdAt: createdAt(),
  },
  (t) => [index('claim_attachment_claim_idx').on(t.claimRequestId)],
);
