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
  doublePrecision,
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

// Partner roles (ADR-0049) are ADDITIVE specialist roles beside hr_admin: each administers only
// its function's data (payroll, or performance+comp) within its company subtree. Company-scopable
// like hr_admin. Recruiting Partner is deferred to the ATS PR.
export const roleEnum = pgEnum('role', [
  'employee',
  'manager',
  'hr_admin',
  'super_admin',
  'payroll_partner',
  'performance_comp_partner',
]);
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
  // Hierarchy Management (ADR-0052): an approver-routing edge. A `delegate` row means subordinate = the
  // delegator (line-holder going on leave), manager = the delegate (stand-in approver), windowed by
  // valid_from/valid_to. Reuses reporting_line; it does NOT grant visibility, only decision authority.
  'delegate',
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
// Performance lifecycle (ADR-0022 lifecycle extension). Goal-setting lock + closure classification.
export const goalStageStatusEnum = pgEnum('perf_goal_stage_status', ['pending', 'locked']);
export const goalApprovalEnum = pgEnum('perf_goal_approval', ['draft', 'proposed', 'approved']);
export const perfAbcClassEnum = pgEnum('perf_abc_class', ['A', 'B', 'C']);
// 2.1 Payroll Policy — how an employee's payroll is processed. All four values exist now (no later
// migration to add one); only `monthly` is wired to calculation in this slice (it is the existing
// behaviour). daily/hourly/custom_period are reserved for a follow-up gated on the rate-storage decision.
export const payrollPolicyTypeEnum = pgEnum('payroll_policy_type', ['monthly', 'daily', 'hourly', 'custom_period']);

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
    // Feedback request 31474452: when true, leave taken on a "Half Day" work-schedule day (attendance_policy.
    // half_working_days) deducts a FULL 1.0 day instead of the default 0.5. Default false = byte-identical to
    // today for every existing customer until an admin both marks a day Half AND turns this on. Full working
    // days are never affected either way.
    leaveHalfDayFullDeduction: boolean('leave_half_day_full_deduction').notNull().default(false),
    // Shared System Labels (ADR-0073, feedback d356dec8): OFF-by-default flag gating the multi-company
    // system-labels resolver. With it false, labelsForCompany() returns ORIGIN-only rows — byte-identical
    // to today. Only when an admin flips it on does a label shared into this company (via the junction or
    // is_global) become visible here. A per-company toggle so rollout is staged, never big-bang.
    sharedSystemLabels: boolean('shared_system_labels').notNull().default(false),
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

// company_logo = 1:1 branding logo for a company, stored as a bytea SIDE TABLE (mirrors claim_attachment /
// leave_request_attachment) so the (potentially large) blob is NEVER accidentally pulled by a company SELECT.
// PNG/JPEG only — the mime is re-derived from magic bytes at upload (SVG is excluded: its payload survives
// sniffing as a valid image but is scriptable). RLS posture: read is tenant-wide (a logo is low-sensitivity
// branding, visible to any same-tenant member exactly like the company row itself); WRITE is admin-of-the-
// company only (app.is_admin_for(company_id)). unique(company_id) enforces the 1:1 so setCompanyLogo upserts.
export const companyLogo = pgTable(
  'company_logo',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .unique()
      .references(() => company.id),
    content: bytea('content').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('company_logo_company_idx').on(t.companyId)],
);

// location = company-scoped physical-site master data (ADR-0054). A thin overlay that names a site and
// supplies an optional `state` override for holiday resolution (location.state ?? employment.work_state ??
// company.default_work_state). `country` is captured for display only — the engine keeps using
// company.country (a location-country override would silently flip the holiday-country lookup; out of
// scope). archivedAt = soft-disable (never hard-delete, so audit survives). RLS gates read+write by
// app.is_admin_for(company_id). The employee↔location link is assignment.location_id (no second table).
export const location = pgTable(
  'location',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    country: text('country').notNull().default('MY'), // ISO-3166 alpha-2 (display only)
    state: text('state'), // holiday-state override; null = inherit work_state/default/national
    // PH-calendars-by-location (ADR-0067): the NAMED holiday calendar every employee at this location
    // follows. Null = unmapped → byte-identical to today's resolution (state override → company default →
    // national). A holiday_group with an `archetype` IS the calendar. ON DELETE SET NULL: deleting a group
    // un-maps the location rather than erroring (the deleteHolidayGroup service guard is the friendly path).
    holidayGroupId: uuid('holiday_group_id').references((): AnyPgColumn => holidayGroup.id, {
      onDelete: 'set null',
    }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('location_company_idx').on(t.tenantId, t.companyId),
    // Code unique per tenant among non-archived (mirrors shift_company_name_uq).
    uniqueIndex('location_code_uq').on(t.tenantId, t.code).where(sql`archived_at is null`),
  ],
);

// clocking_location = company-scoped Clocking Location register (ADR-0070). A DELIBERATE second site
// registry alongside `location` above — see ADR-0070 §1 for why it is not an extension of `location`
// (hard-delete lifecycle, no code namespace, wider tenant-catalog RLS). Lat/lng are typed numbers copied
// from Google Maps (a map picker is Phase 2, deferred). RLS: tenant-catalog read (every tenant member),
// admin-of-company write — mirrors the 0065 pay_component pattern, NOT location's admin-only-read pattern.
export const clockingLocation = pgTable(
  'clocking_location',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    name: text('name').notNull(),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    address: text('address'),
    remarks: text('remarks'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('clocking_location_company_idx').on(t.tenantId, t.companyId),
    uniqueIndex('clocking_location_name_uq').on(t.tenantId, t.companyId, t.name),
    check('clocking_location_lat_range', sql`${t.lat} BETWEEN -90 AND 90`),
    check('clocking_location_lng_range', sql`${t.lng} BETWEEN -180 AND 180`),
  ],
);

// employee_clocking_location = the assignment join (an employee may be authorized at ≥1 sites). Set-based
// replace (no effective-dating — a simple "currently assigned" list, per the request). RLS: SELECT via
// can_see_employment; INSERT/DELETE via can_admin_employment (mirrors employment_pay_component).
export const employeeClockingLocation = pgTable(
  'employee_clocking_location',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    clockingLocationId: uuid('clocking_location_id')
      .notNull()
      .references(() => clockingLocation.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('employee_clocking_location_employment_idx').on(t.employmentId),
    uniqueIndex('employee_clocking_location_uq').on(t.employmentId, t.clockingLocationId),
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

// app_invitation = admin-issued, single-use, expiring invite to create/link an app_user (ADR-0072).
// The raw token is emailed via WorkOS and NEVER stored — only its sha256 hash. The un-authenticated
// consume path runs through the SECURITY DEFINER app.consume_invitation (migration 0151), not the ORM.
export const appInvitation = pgTable(
  'app_invitation',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id').references(() => company.id),
    email: text('email').notNull(),
    role: text('role').notNull(),
    personId: uuid('person_id').references(() => person.id),
    // sha256(raw) hex; the raw opaque base64url token is never returned to the client (schema.ts convention).
    tokenHash: text('token_hash').notNull(),
    status: text('status').notNull().default('pending'), // pending | accepted | revoked | expired
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdBy: uuid('created_by').references(() => appUser.id),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('app_invitation_token_hash_uq').on(t.tokenHash),
    index('app_invitation_tenant_idx').on(t.tenantId, t.status),
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
    // System Labels (migration 0145): optional admin note. Nullable, mirrors job_family; shown only on
    // the System Labels admin CRUD screen, not in the shared hire-form/People read paths.
    description: text('description'),
    // Shared System Labels (ADR-0073): TRUE = "All Companies" global master — resolves to every company in
    // the tenant without writing N junction rows. Only a group admin may set it (RLS gates the write).
    isGlobal: boolean('is_global').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('position_company_idx').on(t.companyId)],
);

// Business Unit master (migration 0136) — a FLAT, company-scoped catalog (no parent/child hierarchy),
// cost_center-shaped. Departments optionally link to a BU via department.business_unit_id; the DB unique
// index (per-company, lower(code), non-archived) lives in the migration, mirroring cost_center's 0030 shape.
export const businessUnit = pgTable(
  'business_unit',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    // System Labels (migration 0145): optional admin note (nullable). System Labels CRUD screen only.
    description: text('description'),
    // Shared System Labels (ADR-0073): TRUE = "All Companies" global master. Group-admin gated at RLS.
    isGlobal: boolean('is_global').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('business_unit_company_idx').on(t.companyId)],
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
    // Business Unit link (migration 0136) — nullable; existing rows stay unassigned (usable under every
    // BU on the hire form). Validated to the same company as the department at write time in the service.
    businessUnitId: uuid('business_unit_id').references(() => businessUnit.id),
    name: text('name').notNull(),
    // System Labels (migration 0145): optional admin note (nullable). System Labels CRUD screen only.
    description: text('description'),
    // Shared System Labels (ADR-0073): TRUE = "All Companies" global master. Group-admin gated at RLS.
    isGlobal: boolean('is_global').notNull().default(false),
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
    // System Labels (migration 0145): optional admin note (nullable). System Labels CRUD screen only.
    description: text('description'),
    // Shared System Labels (ADR-0073): TRUE = "All Companies" global master. Group-admin gated at RLS.
    isGlobal: boolean('is_global').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('cost_center_company_idx').on(t.companyId)],
);

// Shared System Labels junction (ADR-0073, feedback d356dec8) — gives an org label (department / position /
// cost_center / business_unit) ADDITIONAL companies that may use it, ON TOP OF its origin company_id (which
// is never touched). `label_kind` + `label_id` is a polymorphic key into one of the four tables; there is no
// DB FK on label_id (it spans four tables) — the service validates it. Uniqueness on
// (tenant_id, label_kind, label_id, company_id). "All Companies" is the is_global flag on the label row, NOT
// N rows here, so adding a company later needs no backfill. Backfilled 1:1 with each existing label's origin,
// so pre-flag behaviour is identical to today.
export const LABEL_KINDS = ['department', 'position', 'cost_center', 'business_unit'] as const;
export type LabelKind = (typeof LABEL_KINDS)[number];

export const labelCompanyAssignment = pgTable(
  'label_company_assignment',
  {
    id: id(),
    tenantId: tenantId(),
    labelKind: text('label_kind').notNull(),
    labelId: uuid('label_id').notNull(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('label_company_assignment_uq').on(t.tenantId, t.labelKind, t.labelId, t.companyId),
    index('label_company_assignment_company_idx').on(t.companyId, t.labelKind),
    index('label_company_assignment_label_idx').on(t.labelKind, t.labelId),
  ],
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
    // Hiring enhancement: provisional/lifecycle end date — interpreted by assignment.employment_type
    // (probation end for full_time, contract end for contract, internship end for intern). Single-date
    // by design; a separate probation date for contract hires is deferred (PM). Null = no provisional
    // period (e.g. a full_time hire with no probation, or part_time).
    provisionalEndOn: date('provisional_end_on'),
    // Employment-review workflow (0110): explicit end-date source columns (the review trigger inputs).
    // Which one is meaningful is decided at RUNTIME by the employee's CURRENT open assignment row
    // (assignment.employment_type): full_time → probation_end_date, contract → contract_end_date,
    // intern → internship_end_date. part_time → no review. Nullable; minimal stand-ins for the Hiring
    // Enhancement (collapse to "consume existing columns" if a Hiring PR later owns them).
    probationEndDate: date('probation_end_date'),
    contractEndDate: date('contract_end_date'),
    internshipEndDate: date('internship_end_date'),
    // Wave 2 (ADR-0038 2C): the state this employment works in — drives which state public holidays
    // apply. Null falls back to the company's default_work_state, then national-only.
    workState: text('work_state'),
    // Holiday grouping: assign the employee to a NAMED multi-state holiday group (holiday_group). At
    // resolution the group expands to its member states and feeds the SAME holiday.state UNION predicate
    // as work_state. Mutually exclusive with work_state (a group is "≥1 states", work_state is "exactly
    // one") — enforced by the service XOR and the employment_holiday_assignment_xor DB CHECK. ON DELETE
    // SET NULL: deleting a group falls the employee back to work_state/default/national, never an FK error.
    holidayGroupId: uuid('holiday_group_id').references((): AnyPgColumn => holidayGroup.id, {
      onDelete: 'set null',
    }),
    // 2.1 Payroll Policy: the named, reusable pay-processing template applied to this employment. Null =
    // monthly default (today's behaviour). ON DELETE SET NULL so deleting a policy never errors an FK; the
    // service additionally blocks deleting a policy that is still assigned (PolicyInUseError).
    payrollPolicyId: uuid('payroll_policy_id').references((): AnyPgColumn => payrollPolicy.id, {
      onDelete: 'set null',
    }),
    // Configurable Multi-Shift (ec4cbf63): the shift this employee NORMALLY works, set once on the profile.
    // scheduleFor resolves roster row → THIS default shift (its weekly_pattern decides working vs rest) →
    // flat company policy; a dated roster row always wins, so /roster stays the exceptions surface. Null =
    // company default schedule (today's behaviour). ON DELETE SET NULL mirrors payroll_policy_id: deleting
    // a shift never errors an FK, the employee just falls back to the company policy.
    defaultShiftId: uuid('default_shift_id').references((): AnyPgColumn => shift.id, {
      onDelete: 'set null',
    }),
    terminatedOn: date('terminated_on'),
    // Termination classification (Wave 4A). Captured at termination for turnover analytics.
    terminationType: terminationTypeEnum('termination_type'),
    terminationReason: text('termination_reason'),
    // Inter-company cost split for shared-services staff (ADR-0009): [{ companyId, percent }].
    costAllocation: jsonb('cost_allocation'),
    // Clocking Location & Geofencing (ADR-0070): per-employee enforcement toggle + radius. Mirrors the
    // payroll_policy_id precedent of per-employee config living on employment columns. Radius is only
    // meaningful (and required) while enforcement is on — enforced by the CHECK below.
    geofencingEnabled: boolean('geofencing_enabled').notNull().default(false),
    geofenceRadiusM: integer('geofence_radius_m'),
    createdAt: createdAt(),
  },
  (t) => [
    index('employment_person_idx').on(t.personId),
    index('employment_company_idx').on(t.companyId),
    uniqueIndex('employment_employee_code_uq').on(t.tenantId, t.employeeCode),
    // Holiday assignment is single-axis: either a bare work_state OR a holiday group, never both. (Both
    // NULL = company-default/national fallback.)
    check(
      'employment_holiday_assignment_xor',
      sql`${t.workState} IS NULL OR ${t.holidayGroupId} IS NULL`,
    ),
    // Geofencing ON requires a positive radius; OFF leaves it however it was left (null or a stale value —
    // harmless, since it is never read while disabled).
    check(
      'employment_geofence_radius_required',
      sql`NOT ${t.geofencingEnabled} OR (${t.geofenceRadiusM} IS NOT NULL AND ${t.geofenceRadiusM} > 0)`,
    ),
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
    // Location master data (ADR-0054): the physical site this employee works at on this assignment
    // version. Nullable — the entire employee↔location link, reusing assignment's CLOSE+INSERT history
    // (no second bitemporal table). Null ⇒ location-blind = today's behaviour. The location's optional
    // `state` overrides holiday resolution; see location table + core/attendance.ts.
    locationId: uuid('location_id').references((): AnyPgColumn => location.id),
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
  // Supporting-document configuration (#"Supporting Document Configuration in Leave"). All additive,
  // discrete typed columns (claims-style — see core/claims.ts requiresReceipt) so update is a flat set
  // with no JSONB partial-merge. Only enforced when requiresDocument is true.
  //   mandatoryAfterDays: require a doc only when days > this value. null/0 ⇒ always require (when
  //     requiresDocument). Strict '>' against the integer config: "Required after more than N days".
  mandatoryAfterDays: integer('mandatory_after_days'),
  //   allowedMimeTypes: allow-list of file types; null/empty ⇒ any type (backward-compat). Subset of the
  //     fixed set {application/pdf, image/jpeg, image/png}.
  allowedMimeTypes: text('allowed_mime_types').array(),
  //   maxDocBytes: per-file size ceiling. Replaces the previously hard-coded 10 MB; default keeps it.
  maxDocBytes: integer('max_doc_bytes').notNull().default(10 * 1024 * 1024),
  //   employeeRemarkRequired: require a non-empty employee remark on submission.
  employeeRemarkRequired: boolean('employee_remark_required').notNull().default(false),
  //   hrRemarkRequired: STORED ONLY this slice — config round-trips so a later slice can enforce it on the
  //     decision surface; no enforcement, no hr_remark column ships now (deliberate deferral).
  hrRemarkRequired: boolean('hr_remark_required').notNull().default(false),
  // Unpaid-leave payroll-impact integration: gates emission of the on-approval payroll signal (enriches the
  // existing leave-request.approved event) — "activated once Payroll module integration is done". This column
  // does NOT change what payroll deducts: payroll deduction itself is still driven by paid=false in
  // core/payroll.ts (unpaidDaysByEmployment). The "Affects Payroll Deduction" flag the admin sees is derived
  // read-only from !paid (no second stored column). Default false; the migration/seed backfill it true for
  // existing unpaid (paid=false) types so they emit the signal by default.
  sendToPayroll: boolean('send_to_payroll').notNull().default(false),
  // Wave 2 (ADR-0038 2F-2 / R37): per-locale display names, { ms: { name }, zh: { name }, ... }.
  // Mirrors kb_document.i18n. Reads resolve to the viewer's locale, falling back to `name`.
  i18n: jsonb('i18n').$type<Record<string, { name: string }>>(),
  // ADR-0048: allow-list of duration types this leave type supports, e.g.
  // ["full_day","half_day_am","half_day_pm","hourly"]. null ⇒ full-day-only (preserves existing types).
  // requestLeave rejects a chosen duration not in this list.
  durations: jsonb('durations').$type<string[]>(),
  // Partial Leave Approval (0131): when true, a multi-day full-day WORKING-DAYS request of this type is split
  // at submission into one full-day child per working date (sharing a parent_group_id, exactly as Emergency
  // Leave decomposes), so a manager can approve some dates and reject others. Default false = today's single
  // multi-day request behaviour. NOT applied to half/hourly (single-day), calendar-counted types, or EL.
  perDateApproval: boolean('per_date_approval').notNull().default(false),
  // Configurable backdated-leave restriction (0133): how many days back from today a leave of this type may
  // be applied. null ⇒ no limit (existing behaviour). 0 ⇒ no backdating (start date must be today or later).
  // Enforced in requestLeave against the request's start date; HR admins (isAdmin) bypass it (override path).
  // Mirrors mandatoryAfterDays (nullable integer); has its OWN tri-state in updateLeaveType, not nested under
  // the document config. Intentionally not enforced for Emergency Leave (inherently retroactive; field hidden
  // in the admin UI for EL).
  backdatingLimitDays: integer('backdating_limit_days'),
  // Minimum advance-notice rule (0159 / feedback 0b0fb6c3): how many days BEFORE its start date a leave of
  // this type must be submitted ("Annual Leave must be submitted at least 7 days before the leave start
  // date"). null ⇒ no requirement (existing behaviour). Enforced in requestLeave against the tenant-local
  // (Asia/Kuala_Lumpur) "today"; exactly N days of notice is allowed; a backdated start always lacks notice
  // (the backdating rule above may fire first). HR admins (isAdmin) bypass it (override path, stamped onto
  // the submitted event for audit). Mirrors backdatingLimitDays (nullable integer; OWN tri-state in
  // updateLeaveType). Intentionally not enforced for Emergency Leave (it exists precisely for short-notice
  // absence — the reporter's scenario points employees to it; field hidden in the admin UI for EL). Admins
  // may attach a per-type custom block message via customMessages.minAdvanceDays (the 0147 JSONB extension
  // point below — no second column).
  minAdvanceDays: integer('min_advance_days'),
  // Leave Type Expiry Field (fec49317): OPTIONAL age-from-earning expiry for this leave type. Each accrual
  // portion lapses `expiry_value` `expiry_unit` (months | days) after the date it was earned (its ledger
  // effective_on); the expireAgedLeave sweep (core/leave.ts) posts a negative `adjustment` per due batch,
  // so lapsed days drop out of the balance (a plain ledger sum) and therefore out of encashment. Reuses the
  // TOIL expires-on / oldest-first sweep pattern — NOT the carry-forward reconstruction. Both null ⇒ no
  // expiry (existing behaviour; nothing breaks for current types). SCOPE: deliberately NOT applied to
  // ANNUAL (that code already has per-policy carry-forward expiry via expireCarriedLeave — layering a second
  // age-expiry there would double-forfeit); the sweep filters ANNUAL out. `expiry_unit` is constrained to
  // 'months' | 'days' by a DB check; `expiry_value` must be >= 1 (validated in updateLeaveType).
  expiryValue: integer('expiry_value'),
  expiryUnit: text('expiry_unit'), // 'months' | 'days' (null when no expiry)
  // Custom validation messages (custom-messages migration): admin-authored override text shown to the
  // employee when a leave-validation rule blocks their request, keyed by the same camelCase field name as
  // the rule's config column (e.g. { backdatingLimitDays: "…" }). null/absent key ⇒ show the built-in
  // localized default. JSONB extension point per CLAUDE.md: future validation rules add their own key
  // here with no migration. IMPORTANT for future writers: this is ONE shared column across all rule keys —
  // any writer MUST read-then-patch-then-write within the same transaction (see core/admin.ts
  // updateLeaveType), or it will silently clobber other rules' messages (last-writer-wins). The 500-char
  // cap per message is enforced in the service, not the DB.
  customMessages: jsonb('custom_messages').$type<Record<string, string>>(),
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
    // ADR-0066: company this policy applies to. null = group default (all companies). A company-scoped
    // policy ALWAYS wins for employees of that company (resolveGradePolicy short-circuit) — even when lower.
    companyId: uuid('company_id').references(() => company.id),
    // e.g. { annualDays: 16, method: 'grant_on_hire_prorated' }
    accrual: jsonb('accrual').notNull(),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    createdAt: createdAt(),
  },
  (t) => [
    index('leave_policy_type_idx').on(t.leaveTypeId),
    index('leave_policy_company_idx').on(t.companyId, t.leaveTypeId),
  ],
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
    // ADR-0066: human reason for a festive / one-off `adjustment` grant (e.g. "CNY 2026"), OR a system-
    // stamped machine code for an automatic carry-forward forfeit (sys:carry_forward_cap /
    // sys:carry_forward_expiry — see CARRY_FORFEIT_REASON_CAP/EXPIRY in core/leave.ts). null otherwise.
    reason: text('reason'),
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
    // ADR-0048: chosen duration — 'full_day' | 'half_day_am' | 'half_day_pm' | 'hourly'. Descriptive
    // metadata for display + audit; `days` remains the single deduction source of truth. NOT NULL
    // DEFAULT 'full_day' backfills existing rows to the prior full-day behaviour.
    durationType: text('duration_type').notNull().default('full_day'),
    // ADR-0048: original hours for an 'hourly' request (null otherwise). Kept because round(hours/8,2)
    // can be lossy (1h → 0.13), so the displayed "1h" is recovered from here, not back-computed from days.
    hours: numeric('hours', { precision: 4, scale: 2 }),
    // Hourly-leave time window (0129): the From/To window the applicant picked for a duration_type='hourly'
    // request — `hours` is derived from (to_time - from_time). These are the SOURCE window; `hours` remains
    // the derived deduction figure. Populated only for hourly rows; NULL for full_day / half_day and all
    // pre-existing rows. Carried through approval + history so the approver sees the actual window.
    fromTime: time('from_time'),
    toTime: time('to_time'),
    status: leaveRequestStatusEnum('status').notNull().default('pending'),
    reason: text('reason'),
    // Supporting-document config: the applicant's mandatory remark when the leave type sets
    // employee_remark_required. Nullable — null/absent for types that don't require it (backward-compat).
    employeeRemark: text('employee_remark'),
    // Emergency Leave (0106): groups the ANNUAL + UNPAID children produced by one EL submission. EL is an
    // application type only — no EMERGENCY row is ever persisted; on submission requestLeave decomposes
    // into up to two ordinary child requests over the same dates, linked by this shared UUID so surfaces
    // can group them as one logical absence. NULL for all pre-existing and ordinary (non-EL) rows.
    parentGroupId: uuid('parent_group_id'),
    // Phase-B #12 (ADR-0061): Emergency-Leave unpaid-consent stamp. When an EL submission's cascade creates
    // an UNPAID child for the AL/SICK shortfall, the employee must explicitly consent to the no-work-no-pay
    // days; the moment consent was captured is stamped here (and unpaid_consent_by records the actor). NULL
    // for every paid child (ANNUAL / SICK), every ordinary (non-EL) request, and all pre-existing rows.
    unpaidConsentAt: timestamp('unpaid_consent_at', { withTimezone: true }),
    unpaidConsentBy: uuid('unpaid_consent_by'),
    // Phase-B #13 (ADR-0062): EA s.37 maternity paid-ALLOWANCE eligibility. The 98-day maternity LEAVE is
    // unconditional; the paid ALLOWANCE is a separate entitlement withheld when qualifying-service fails or
    // for a 5th+ surviving child. These two point-in-time facts (supplied on a MATERNITY request) let the
    // service compute the decision; allowance_eligible is the per-request OVERRIDE of the leave-type paid
    // default (FALSE ⇒ leave granted UNPAID — drives unpaidDaysByEmployment; NULL ⇒ not a maternity decision
    // or inputs unconfirmed → conservative paid default). NULL for every non-maternity / legacy row.
    survivingChildren: integer('surviving_children'),
    confinementDate: date('confinement_date'),
    allowanceEligible: boolean('allowance_eligible'),
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

// Partial Leave Approval — single-request model (ADR-0068, supersedes ADR-0131's child-row split). A
// multi-day per-date-approval request now stays ONE leave_request row; each requested WORKING date gets a
// per-date sub-row here so the approver can approve/reject each date independently in the request detail
// view (one inbox row, not one-per-day). subject_employment_id is denormalized from the parent request so
// RLS reuses the leave_approval_step policy verbatim (can_see_employment OR can_decide_via_delegation) —
// this is load-bearing: the span consumers (attendance/roster/plannedAbsences/unpaid-payroll) read these
// rows per-date under a correlated sub-select, and a tenant-only policy would let a manager see rows they
// cannot decide (or hide rows they can). The (subject_employment_id, leave_date) index serves that read
// path. status reuses the pending/approved/rejected space; decided_by/at/reject_reason mirror the parent's
// decision columns so the detail view can show who decided each date and why a date was rejected.
export const leaveRequestDate = pgTable(
  'leave_request_date',
  {
    id: id(),
    tenantId: tenantId(),
    leaveRequestId: uuid('leave_request_id')
      .notNull()
      .references(() => leaveRequest.id, { onDelete: 'cascade' }),
    subjectEmploymentId: uuid('subject_employment_id')
      .notNull()
      .references(() => employment.id),
    leaveDate: date('leave_date').notNull(),
    days: numeric('days', { precision: 6, scale: 2 }).notNull(),
    status: leaveRequestStatusEnum('status').notNull().default('pending'),
    rejectReason: text('reject_reason'),
    decidedByEmploymentId: uuid('decided_by_employment_id').references(() => employment.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('leave_request_date_request_date_uq').on(t.leaveRequestId, t.leaveDate),
    index('leave_request_date_request_idx').on(t.leaveRequestId),
    index('leave_request_date_subject_date_idx').on(t.subjectEmploymentId, t.leaveDate),
  ],
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

// Partial Leave Cancellation (ADR-0065): an employee-initiated request to give back a SUBSET of the dates
// of an already-approved leave. The manager approves/rejects (single step). On approval the service splits
// the approved span into contiguous sibling rows (shared parent_group_id, the Emergency-Leave model) and
// flips the cancelled segment(s) to status='cancelled' + reverses their ledger debit. cancel_dates is a
// jsonb array of ISO yyyy-mm-dd. employment_id is denormalized from the leave_request for RLS (same
// can_see_employment rule as leave_request_attachment / attendance_correction). status reuses the
// pending/approved/rejected 3-value space as a text + check (the attendance_correction precedent). RLS is
// intentionally SYMMETRIC (can_see_employment in USING + WITH CHECK); the subject-only INSERT rule and the
// self-approval ban live in the SERVICE layer (requestLeaveCancellation / decideLeaveCancellation), exactly
// as the attendance_correction RLS does — see 0132 migration comment.
export const leaveCancellationRequest = pgTable(
  'leave_cancellation_request',
  {
    id: id(),
    tenantId: tenantId(),
    leaveRequestId: uuid('leave_request_id')
      .notNull()
      .references(() => leaveRequest.id),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    cancelDates: jsonb('cancel_dates').notNull(), // string[] of ISO yyyy-mm-dd
    requestedDays: numeric('requested_days', { precision: 6, scale: 2 }).notNull(),
    reason: text('reason'),
    // pending | approved | rejected — text + check (attendance_correction_status precedent reused as a check).
    status: text('status').notNull().default('pending'),
    decidedByEmploymentId: uuid('decided_by_employment_id').references(() => employment.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('leave_cancellation_request_request_idx').on(t.leaveRequestId)],
);

// Wave 2 (ADR-0039 2B-2 + ADR-0071): the configurable approval chain, now a SCOPED RULE MATRIX. `levels` is
// an ordered array of level kinds ('direct_manager' | 'hr_admin'). A row is a RULE scoped by (optionally)
// leave_type, business_unit, department, position, grade, employment_type and a min/max leave-day range —
// all nullable/wildcard. A row with EVERY scoping dimension null is the company default. Resolution is
// "most-specific matching rule wins" (score = count of matched non-null dims), tie-broken deterministically
// (narrower day-range → most-recently-created); no match falls through to the built-in [direct_manager,
// hr_admin] chain. `active=false` soft-archives a rule (never hard delete). Catalog RLS: readable
// tenant-wide (the requester reads it to generate steps), writable by company admins.
export const leaveApprovalPolicy = pgTable(
  'leave_approval_policy',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    leaveTypeId: uuid('leave_type_id').references(() => leaveType.id),
    // ADR-0071 rule-matrix scoping dimensions — all nullable/wildcard (null = "matches any").
    ruleName: text('rule_name'),
    businessUnitId: uuid('business_unit_id').references(() => businessUnit.id),
    departmentId: uuid('department_id').references(() => department.id),
    positionId: uuid('position_id').references(() => position.id),
    gradeId: uuid('grade_id').references(() => jobGrade.id),
    employmentType: employmentTypeEnum('employment_type'),
    minDays: integer('min_days'),
    maxDays: integer('max_days'),
    active: boolean('active').notNull().default(true),
    levels: jsonb('levels').notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    // Only two FULLY-wildcard rows for the same company + leave-type are forbidden (the company default is a
    // singleton). Partially-specific rules may coexist. Mirrors the migration's expression index.
    uniqueIndex('leave_approval_policy_wildcard_uq')
      .on(t.companyId, sql`coalesce(${t.leaveTypeId}, '00000000-0000-0000-0000-000000000000'::uuid)`)
      .where(
        sql`business_unit_id is null and department_id is null and position_id is null and grade_id is null and employment_type is null and min_days is null and max_days is null`,
      ),
  ],
);

// 2.1.1 Payroll Policy — Monthly General Settings config (ADR-0064). Stored as `config jsonb` on the row;
// NULL = today's exact behaviour. The shape + cleanX validation live in core/payroll-policy-config.ts (which
// imports this type); the field bag is defined here so the Drizzle column can be typed without a cycle. Every
// sub-field is OPTIONAL — an absent field falls back to the legacy default (the all-default config is
// byte-identical, proven by the golden matrix). See the config module for the canonical default + validator.
export type RoundingMode = 'none' | 'up' | 'down' | 'nearest';
export type ProrationDivisor = 'calendar_month' | 'custom_days';
export type OtDayType = 'workday' | 'rest_day' | 'holiday';
// 'carry_forward' (f3148da1 Step 2) holds a negative net at 0 THIS cycle and remembers the shortfall as a
// running per-employee balance that is recovered from the next cycle's positive net. The balance is DERIVED
// (no mutable table) from each employment's closed payslips' `statutory.carryForward` stamps, so a rolled-back
// batch drops out of the balance automatically. 'retain'/'set_zero' behave exactly as before.
export type NegativeNetMode = 'retain' | 'set_zero' | 'carry_forward';
export type LeaveDivisor =
  | 'calendar_month'
  | 'custom_days'
  | 'cutoff_days'
  | 'working_days'
  | 'custom_hours'
  | 'custom_minutes';
// 2.1.4 (Custom period) — the cut-off WINDOW mode. 'calendar' (default/absent) = the statutory calendar month
// (1st→last), today's exact behaviour. 'custom' anchors a non-calendar operational window on `anchorDay`: for a
// statutory month M, the window is [anchorDay of M-1 .. (anchorDay-1) of M]. STATUTORY contributions
// (EPF/SOCSO/EIS/PCB) stay calendar-bound BY LAW regardless of the window. This slice STORES + VALIDATES the
// window only — applying it to OT/attendance/leave input selection is a deferred follow-up gated on the kernel
// seam, so a custom cut-off changes no payslip numbers yet.
export type CutOffMode = 'calendar' | 'custom';
// f3148da1 Step 3 — one basic-salary proration formula: the divisor + optional working-day basis. Shared as
// the default (`proration`) and overridable per employee event (`prorationHire`/`prorationResign`).
export type ProrationSettings = {
  divisor?: ProrationDivisor;
  customDays?: number; //                     used when divisor='custom_days'
  includeSaturday?: boolean; //               working-day basis (only when a working-day divisor is chosen)
  includeSunday?: boolean;
  includeHoliday?: boolean;
};
export type PayrollPolicyConfig = {
  // 1a — earnings / deductions / net-pay rounding (default 'none' on each = byte-identical).
  rounding?: { earnings?: RoundingMode; deductions?: RoundingMode; netPay?: RoundingMode };
  // 1b — basic-salary proration divisor + working-day basis (default calendar_month = EA s.18A daysInMonth).
  // This is the SHARED/default proration formula, used for any employee event without its own override below.
  proration?: ProrationSettings;
  // f3148da1 Step 3 — per-event basic-salary formulas. When present, `prorationHire` overrides `proration` for
  // a NEW-HIRE partial month (hired mid-period) and `prorationResign` overrides it for a RESIGNED/terminated
  // partial month (terminated mid-period), so the two events are independently configurable ("New Hire Basic
  // Salary Formula" / "Resigned Employee Basic Salary Formula"). Absent ⇒ inherit `proration` (byte-identical).
  prorationHire?: ProrationSettings;
  prorationResign?: ProrationSettings;
  // 1c — split a mid-period salary increment across the two straddling comp rows (default false = single row).
  salaryIncrementProration?: boolean;
  // 1d — negative-net handling after the net-pay computation (default 'retain' = today's s.24 clamp behaviour).
  negativeNet?: NegativeNetMode;
  // 1e — OT caps wrapped around the statutory engine. Multipliers floored at the EA s.60A minimum.
  overtime?: {
    maxHoursPerMonth?: number; //               total OT hours cap (0/absent = no cap)
    maxAmount?: number; //                       total OT RM cap (0/absent = no cap)
    eligibleDayTypes?: OtDayType[]; //          which classified days qualify (absent = all three)
    multiplier?: number; //                      workday OT multiplier, floored at the s.60A 1.5× minimum
    // Step 4 (f3148da1) — what to do with the OT amount above the cap. Absent/undefined ⇒ today's behaviour
    // (the excess is simply dropped once the cap bites). action='convert' redirects the excess onto a chosen
    // company pay component (by id) so it is still paid to the employee under that component's line + name;
    // an absent/foreign componentId falls back to cap-and-drop (cleanPayrollPolicyConfig persists it only
    // with a UUID componentId; the kernel re-validates it belongs to the employment's company).
    exceedHandling?: { action: 'convert'; componentId: string };
  };
  // 1f — divisor selector for unpaid-leave / unpaid-time-off / leave-encashment (default calendar_month).
  leave?: {
    unpaidLeaveDivisor?: LeaveDivisor;
    unpaidTimeOffDivisor?: LeaveDivisor;
    encashmentDivisor?: LeaveDivisor;
    customDays?: number; //                     used when a *_Divisor is 'custom_days'
    customHours?: number; //                    used when a *_Divisor is 'custom_hours'
    customMinutes?: number; //                  used when a *_Divisor is 'custom_minutes'
  };
  // 2.1.4 (Custom period) — the operational cut-off WINDOW. Default (absent / mode='calendar') = the statutory
  // calendar month, byte-identical to today. mode='custom' records an anchor day so the window runs
  // [anchorDay of M-1 .. (anchorDay-1) of M] for statutory month M. anchorDay ∈ 1..28 (avoids the 29–31
  // month-length trap). CONFIGURABLE ONLY in this slice — not yet read by the kernel; statutory months stay
  // calendar-bound by law.
  cutOff?: {
    mode?: CutOffMode;
    anchorDay?: number; //                      day-of-month the custom window opens (1..28), when mode='custom'
  };
};

// Step 6 (f3148da1) — payslip RELEASE configuration, stored per-company on company_payroll_config.payslip_release.
// Controls WHEN a closed batch's payslips become visible to employees in Employee Self-Service (ESS). NULL /
// mode='immediate' = today's behaviour (visible the moment the batch closes). 'fixed_day' releases on a fixed
// day-of-month of the month AFTER the pay period; 'relative' offsets the company pay-day anchor by ±N days. The
// computed release instant is NEVER earlier than the batch close instant (a batch not yet closed is never
// released). Admin payroll surfaces are unaffected — only the ESS employee view is gated.
export type PayslipReleaseMode = 'immediate' | 'fixed_day' | 'relative';
export type PayslipRelease = {
  mode?: PayslipReleaseMode;
  day?: number; //        1..31 — day-of-month the payslip is released (fixed_day), clamped to month length
  offsetDays?: number; // -15..15 — days before(-)/after(+) the company pay-day anchor (relative)
};

// 2.1 Payroll Policy — a named, reusable, company-scoped template for HOW an employee gets paid. Assigned
// to an employment via employment.payroll_policy_id (null = monthly default). For `monthly` the pay_rule is
// null/{kind:'fixed'} (byte-identical to today); daily/hourly (deferred) carry a PayRule the existing kernel
// resolver already understands. Catalog RLS: readable tenant-wide (the kernel resolves the assigned policy
// under the caller's session), writable only by an admin for the company (see 0128_payroll_policy_rls.sql).
export const payrollPolicy = pgTable(
  'payroll_policy',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    name: text('name').notNull(),
    description: text('description'),
    policyType: payrollPolicyTypeEnum('policy_type').notNull(),
    // Reuses core/pay-rule.ts's PayRule (no new config shape). Null for monthly. For daily/hourly (deferred)
    // this holds { kind:'per_day'|'per_hour', rate } — the rule the kernel's resolvePayRule already evaluates.
    payRule: jsonb('pay_rule').$type<PayRule | null>(),
    // 2.1.1 (ADR-0064) Monthly General Settings config. NULL = today's exact behaviour (proven byte-identical
    // by the default-equals-legacy golden matrix); the kernel reads it at run time via resolveAssignedPolicy.
    config: jsonb('config').$type<PayrollPolicyConfig | null>(),
    // 2.1.1 (ADR-0064) — Phase-2 bulk-assign tie-break ONLY. Added now (no later migration); the run-time
    // kernel never reads it.
    priority: integer('priority').notNull().default(0),
    status: text('status').notNull().default('active'), // 'active' | 'inactive'
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('payroll_policy_company_name_uq').on(t.companyId, t.name),
    index('payroll_policy_company_status_idx').on(t.companyId, t.status),
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

// 1.2.4 Zakat — a per-employee zakat-via-salary election. 'percent_of_pcb' = a fraction of the NORMAL
// monthly MTD (derived live during payroll, never frozen); 'fixed' = a flat monthly RM amount. Null
// (no method) ⇒ no election. The election offsets PCB per LHDN spec §E.5 (it does NOT add a separate
// net deduction). See ADR-0058 / docs.
export const zakatMethodEnum = pgEnum('zakat_method', ['percent_of_pcb', 'fixed']);

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
    // 1.2.4 Zakat election (ADR-0058). zakatActive is the opt-in flag — false ⇒ no zakat regardless of the
    // other fields. zakatState is one of MY_STATES (display/metadata only; no per-state behaviour in v1).
    // zakatMethod selects percent-of-MTD vs a fixed RM amount; zakatPercent is a decimal (e.g. 0.0250 = 2.5%)
    // and zakatFixed a flat RM amount — only the field for the active method is set. zakatEffectiveFrom/To
    // are INERT display-only columns: nothing in the calc path filters on them (the kernel reads the current
    // row, like every other field here, which is not effective-dated).
    zakatActive: boolean('zakat_active').notNull().default(false),
    zakatState: text('zakat_state'),
    zakatMethod: zakatMethodEnum('zakat_method'),
    zakatPercent: numeric('zakat_percent', { precision: 5, scale: 4 }),
    zakatFixed: numeric('zakat_fixed', { precision: 12, scale: 2 }),
    zakatEffectiveFrom: date('zakat_effective_from'),
    zakatEffectiveTo: date('zakat_effective_to'),
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
    cutOffDay: integer('cut_off_day'), // day of month payroll inputs close (1–31); null = month-end. The salary/inputs cut-off.
    payDay: integer('pay_day'), // day of month salary is paid (1–31); null = month-end
    paymentBasis: text('payment_basis').notNull().default('monthly'),
    // Per-purpose cut-off scheduling METADATA — these join cutOffDay (the salary/inputs cut-off) as
    // scheduling reference only; null = month-end / inherit. None feed period computation.
    overtimeCutOffDay: integer('overtime_cut_off_day'), // day of month OT inputs close (1–31); null = month-end
    claimCutOffDay: integer('claim_cut_off_day'), // day of month claim inputs close (1–31); null = month-end
    unpaidLeaveCutOffDay: integer('unpaid_leave_cut_off_day'), // day of month unpaid-leave inputs close (1–31); null = month-end
    attendanceCutOffDay: integer('attendance_cut_off_day'), // day of month attendance inputs close (1–31); null = month-end
    // Configurable default probation length in months (migration 0136). Null = legacy/default 3. Applied to
    // a full_time hire's default probation end date; still editable per hire. Any positive integer.
    probationMonths: integer('probation_months'),
    // 6522d26a — configurable review-reminder cadence (days BEFORE the review end date at which the
    // reminder sweep nudges the manager + HR). Null/empty ⇒ default [30, 14, 7], resolved at sweep time
    // (core/employment-review.ts resolveReminderDays). Stored sorted-desc, deduped, each 1–365.
    reviewReminderDays: integer('review_reminder_days').array(),
    // Step 1 (f3148da1) — the COMPANY-DEFAULT payroll policy applied to any employee with no policy assigned
    // on their employment. NULL = today's behaviour (unassigned ⇒ hardcoded monthly). Same-company, active
    // policy enforced service-side; the kernel falls back to it in resolveAssignedPolicy.
    defaultPayrollPolicyId: uuid('default_payroll_policy_id').references((): AnyPgColumn => payrollPolicy.id),
    // Step 6 (f3148da1) — payslip release config (see PayslipRelease). NULL = immediate (today's behaviour).
    payslipRelease: jsonb('payslip_release').$type<PayslipRelease | null>(),
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
    // Org-based override (ADR-0055): when set, this holiday belongs to that company AND its descendants
    // (resolved via the upward ancestor walk app.is_company_descendant at read time — a parent-group
    // calendar cascades to child companies/factories/BUs). Null = not company-scoped (national/state, as
    // today). Scope is implicit and mutually exclusive (DB CHECK holiday_scope_excl): national
    // (state + company_id both null), state (state set), business-group (company_id set). A company-scoped
    // calendar is single-winner — if ANY company row matches the employee's company chain in the window,
    // those rows ARE the calendar; otherwise the engine falls back to national ∪ state (2C behaviour).
    companyId: uuid('company_id').references((): AnyPgColumn => company.id),
    holidayDate: date('holiday_date').notNull(),
    name: text('name').notNull(),
    // Follow-on #15b (ADR-0063): TRUE = a provisional, not-yet-gazetted date (shifting state holidays are
    // gazetted only days ahead). A tentative holiday STILL counts as a holiday everywhere (leave/rest-day/
    // payroll) — the flag is purely a visible "confirm me" marker; excluding it would under-count.
    tentative: boolean('tentative').notNull().default(false),
    createdAt: createdAt(),
  },
  // One holiday per (tenant, country, date, state-or-national, company-or-nil). coalesce keeps the NULL
  // cases unique on PG14 (no NULLS NOT DISTINCT): state→'' (text), company_id→the nil uuid. The company
  // dimension lets the same date exist at national, state, and group scope without collision.
  (t) => [
    uniqueIndex('holiday_uq').on(
      t.tenantId,
      t.country,
      t.holidayDate,
      sql`coalesce(${t.state}, '')`,
      sql`coalesce(${t.companyId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    // Mutual exclusivity DB-guaranteed (seed/CSV/import paths bypass the service): a row is at most one of
    // state-scoped or company-scoped, never both — so the resolver never sees a malformed multi-scope row.
    check('holiday_scope_excl', sql`num_nonnulls(${t.state}, ${t.companyId}) <= 1`),
  ],
);

// Holiday grouping (per-employee assignment over the EXISTING state engine). A "group" is a NAMED bundle
// of states (MY_STATES labels). It is NOT a second tag on the holiday row — holidays stay keyed on
// `state` only. At resolution an employee's group is expanded to its member states and fed into the same
// `holiday.state` UNION predicate the engine already uses, so a grouped employee gets
// national ∪ (holiday.state = ANY(group.states)). `employment.holiday_group_id` (added below) and
// `employment.work_state` are mutually exclusive (DB CHECK + service XOR): a group is "one or more
// states", a bare work-state is "exactly one state". Deleting a group SETs NULL on referencing
// employments (FK), falling back to work_state/company-default/national.
// PH-calendars-by-location (ADR-0067). A holiday_group, once it carries an `archetype` and is mapped to a
// location, IS a named public-holiday CALENDAR. The archetype decides how the resolver builds the calendar:
//   standard — official gazette only (national ∪ the group's states[]). Behaviourally IDENTICAL to today's
//              state/group path; the resolver does NOT branch for it (it falls through unchanged).
//   extended — official gazette ∪ company-defined ad-hoc days (the existing company-subtree holiday rows).
//   custom   — fully HR-managed: ONLY the company-scoped ad-hoc rows; national holidays are NOT added.
// Default 'standard' makes every existing group backfill-safe and byte-identical to today.
export const holidayGroupArchetypeEnum = pgEnum('holiday_group_archetype', ['standard', 'extended', 'custom']);

export const holidayGroup = pgTable(
  'holiday_group',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    states: jsonb('states').notNull().default(sql`'[]'::jsonb`), // string[] of MY_STATES labels
    archetype: holidayGroupArchetypeEnum('archetype').notNull().default('standard'),
    createdAt: createdAt(),
  },
  // Case-insensitive per-tenant name uniqueness (follows the org_catalog_integrity pattern, 0030).
  (t) => [uniqueIndex('holiday_group_name_uq').on(t.tenantId, sql`lower(${t.name})`)],
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

// ADR-0069 Attendance Request Management: how an APPROVED overtime request's minutes are resolved against the
// system's own live-computed figure. `requested` = trust the employee's requested figure; `system_calculated`
// = trust the engine's derived figure (default); `smaller_of` = the lower of the two (conservative). Company-
// level (attendance_policy.ot_approval_calculation).
export const otApprovalCalculationEnum = pgEnum('ot_approval_calculation', [
  'requested',
  'system_calculated',
  'smaller_of',
]);

// Clocking Location & Geofencing (ADR-0070). 'pass' = the punch was within a matched assigned site's
// radius; 'not_enforced' = geofencing was OFF for that punch (coords may still be present). 'fail' does
// NOT exist here — a blocked attempt never writes an attendance row; it is the
// attendance.geofence.blocked domain event instead (see core/attendance.ts).
export const geofenceStatusEnum = pgEnum('geofence_status', ['pass', 'not_enforced']);
// Only 'web' (self-service /me) can carry geofencing. 'import' = the biometric/terminal CSV importer,
// which bypasses geofencing entirely (physical presence at the device is its own proof). A punch written
// by decideAttendanceCorrection stays NULL (deliberate — no 'correction' value, per ADR-0070 §6).
export const clockMethodEnum = pgEnum('clock_method', ['web', 'import']);

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
    // ── Clocking Location & Geofencing (ADR-0070) — per-punch capture, ALL nullable. Split per punch
    // (check-in vs check-out) rather than one set of columns per row so an import-in/web-out row, or a
    // mid-day radius/geofencing-toggle change between the two punches, is representable without one punch's
    // capture silently overwriting the other's. Legacy rows are unaffected (every column defaults to null).
    checkInLat: doublePrecision('check_in_lat'),
    checkInLng: doublePrecision('check_in_lng'),
    checkInClockingLocationId: uuid('check_in_clocking_location_id').references(
      (): AnyPgColumn => clockingLocation.id,
    ),
    checkInDistanceM: integer('check_in_distance_m'),
    checkInGeofenceStatus: geofenceStatusEnum('check_in_geofence_status'),
    checkInRadiusM: integer('check_in_radius_m'),
    checkInMethod: clockMethodEnum('check_in_method'),
    checkOutLat: doublePrecision('check_out_lat'),
    checkOutLng: doublePrecision('check_out_lng'),
    checkOutClockingLocationId: uuid('check_out_clocking_location_id').references(
      (): AnyPgColumn => clockingLocation.id,
    ),
    checkOutDistanceM: integer('check_out_distance_m'),
    checkOutGeofenceStatus: geofenceStatusEnum('check_out_geofence_status'),
    checkOutRadiusM: integer('check_out_radius_m'),
    checkOutMethod: clockMethodEnum('check_out_method'),
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
    // Feedback request 31474452: ISO weekday numbers marked as a HALF working day (e.g. Saturday 9am-12pm).
    // Disjoint from workingDays by a DB CHECK (migration 0142) — a weekday is Full (workingDays), Half
    // (halfWorkingDays), or Rest (neither). Default '{}' = no half days, byte-identical to today. For
    // ATTENDANCE purposes a half day still counts as a WORKING day (D2) — see the union reads in
    // core/attendance.ts; only the LEAVE deduction amount differs (core/leave.ts dayWeight + company.
    // leaveHalfDayFullDeduction).
    halfWorkingDays: integer('half_working_days')
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    // ADR-0069: how an approved overtime request's minutes are resolved against the engine's live figure
    // (requested | system_calculated | smaller_of). Company-wide setting; default system_calculated.
    otApprovalCalculation: otApprovalCalculationEnum('ot_approval_calculation').notNull().default('system_calculated'),
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
    // ADR-0069: relaxed to NULLABLE (was NOT NULL) so an OT-only request (no clock-in/out) can be represented.
    // A DB check constraint (migration 0145) requires at least one of proposedCheckIn / proposedCheckOut /
    // requestedOtMinutes to be present.
    proposedCheckIn: time('proposed_check_in'),
    proposedCheckOut: time('proposed_check_out'),
    reason: text('reason'),
    // ADR-0069 Attendance Request Management — overtime request fields (all nullable; a clock-only correction
    // leaves them null, byte-identical to before):
    //  • requestedOtMinutes — the employee's requested OT figure (from the form).
    //  • approvedOtMinutes — the final value after applying attendance_policy.ot_approval_calculation. Written
    //    at approval time; this is also the value pushed onto attendance.ot_minutes (single source of truth for
    //    both the payroll prefill AND the TOIL auto-accrual — see decideAttendanceCorrection).
    //  • otApprovalMethod — which of the 3 calculation options produced approvedOtMinutes, for audit.
    // NOTE (ADR-0069): we deliberately do NOT persist a "systemCalculated" snapshot column — the comparison
    // figure is computed LIVE at review time via deriveAttendance/scheduleFor, never stored.
    requestedOtMinutes: integer('requested_ot_minutes'),
    approvedOtMinutes: integer('approved_ot_minutes'),
    otApprovalMethod: otApprovalCalculationEnum('ot_approval_method'),
    status: attendanceCorrectionStatusEnum('status').notNull().default('pending'),
    decidedByEmploymentId: uuid('decided_by_employment_id').references(() => employment.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('attendance_correction_employment_idx').on(t.employmentId, t.attendanceDate),
    // ADR-0069 data-integrity: at most ONE pending request per (employment, date) — stops a clock-fix and a
    // separate OT-only request for the same date both approving and clobbering each other on the attendance
    // upsert. Partial unique so decided rows don't collide with a fresh request for the same date.
    uniqueIndex('attendance_correction_one_pending_uq')
      .on(t.employmentId, t.attendanceDate)
      .where(sql`status = 'pending'`),
  ],
);

// ADR-0069 Attendance Request Management — Travel Request. An approved date-range record marking that an
// employee was working off-site for that window. Scoped to an AUDIT MARKER only: this codebase's geofencing
// (ADR-0070) is a separate enforcement path; travel is surfaced as a badge via activeTravelRequestFor and is
// NOT wired into DayContext/attendanceForDate (so it cannot silently change month-summary absence counting).
// Reuses attendance_correction_status (pending/approved/rejected) and the same request→decide workflow.
export const travelRequest = pgTable(
  'travel_request',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    travelFrom: date('travel_from').notNull(),
    travelTo: date('travel_to').notNull(),
    remarks: text('remarks').notNull(),
    status: attendanceCorrectionStatusEnum('status').notNull().default('pending'),
    decidedByEmploymentId: uuid('decided_by_employment_id').references(() => employment.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('travel_request_employment_idx').on(t.employmentId, t.travelFrom)],
);

// ── Phase C: shift rosters (ADR-0032) ──────────────────────────────
// A configurable (NON-statutory) shift-differential pay rule. EA 1955 mandates no shift premium, so this
// is employer policy; the value feeds a typed pay-component (C5), never a sourced statutory rate.
export type ShiftDifferential = { kind: 'percent' | 'flat_hourly' | 'flat_per_shift'; value: number };

// R7 Multi-Shift Phase 1: one break window inside a shift. 'HH:MM:SS', start < end (lexicographic order is
// chronological), so a single break can never cross midnight — Phase 1 excludes overnight breaks. STORAGE-
// ONLY this phase: the engine keeps reading the canonical break_minutes scalar (= Σ durations).
export type BreakPeriod = { start: string; end: string };

// A configurable pay-rule on a pay_component (Payroll Setup — configurable pay-rule engine). A small
// typed-JSONB discriminated union resolved by a switch (mirrors ShiftDifferential), NOT a custom expression
// language: the AI's job collapses to "classify a sentence into one of these kinds + extract a number".
// Every kind resolves to a single ringgit number with NO division by a runtime scope value (so a zero-days
// employee can never abort a batch). `null` ⇒ unchanged fixed-amount behaviour (the stored `amount`).
// NON-GOAL (v1): no `gross`/`gross_of` base — there is no running gross inside the kernel's earningsOf()
// loop and component order is arbitrary, so a gross-relative rule is unimplementable without a kernel
// restructure. `percent_of` is restricted to `base: 'basic'`, resolved from the employee's BASIC component
// amount (read in the same query batch, order-independent). Only read when TYPED_PAY_COMPONENTS_ENABLED.
// 2.1.3 (Hourly) — `onlyPullHoursWithinShiftSchedule` rides on the per_hour rule (rate + behaviour together,
// zero DDL — it's why pay_rule is JSONB). When true, payableHoursForCycle() clamps each day's payable hours to
// the intersection of clocked time and the employee's rostered shift (hours outside the shift, or on a day with
// no roster, are excluded); when false/absent the full worked total counts (today's behaviour). The boolean is
// only meaningful on per_hour rules — validatePayRule rejects it on any other kind. The flag does NOT change the
// `rate × scope.hours` math in resolvePayRule; the live hourly compute that feeds shift-bounded hours into that
// scope is a deferred follow-up (gated on the rate-storage decision).
export type PayRule =
  | { kind: 'fixed' } //                                    = current behaviour; the component's `amount` is the value
  | { kind: 'percent_of'; base: 'basic'; pct: number } //   pct% of the employee's resolved BASIC component amount
  | { kind: 'per_day'; rate: number } //                    rate × days_worked (component MUST have prorates=false)
  | { kind: 'per_hour'; rate: number; onlyPullHoursWithinShiftSchedule?: boolean } // rate × attendance hours (component MUST have prorates=false)
  | { kind: 'flat_capped'; value: number; cap: number }; // min(value, cap)

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
    // R7 Multi-Shift Phase 1: short per-company identifier. Nullable in DB (legacy rows were backfilled by
    // 0139), REQUIRED by the service/form. Uniqueness = shift_company_code_uq, a partial lower(code) index
    // per (tenant, company) among non-archived rows — lives in the 0139 migration (expression index,
    // mirroring business_unit's 0136 shape).
    code: text('code'),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    breakMinutes: integer('break_minutes').notNull().default(0),
    // R7 Multi-Shift Phase 1: multiple break windows. STORAGE-ONLY this phase — the engine / punch import /
    // hourly clamp keep reading the canonical breakMinutes scalar (= Σ durations, persisted by the service).
    breakPeriods: jsonb('break_periods').$type<BreakPeriod[] | null>(),
    // R7 Multi-Shift Phase 1: manual normal-working-minutes figure; when set it is what workday OT is
    // measured against (core/attendance.ts deriveAttendance). NULL ⇒ auto (span − break).
    normalMinutesOverride: integer('normal_minutes_override'),
    // R7 Multi-Shift Phase 2: ISO weekday numbers (1=Mon … 7=Sun) that are WORKING days for this shift —
    // rest = complement — mirroring attendance_policy.working_days. NULL ⇒ no pattern; the shift cannot
    // drive generateRosterFromTemplate and behaves exactly as before.
    weeklyPattern: integer('weekly_pattern').array(),
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
    // 0113 (RL Control Engine): opt-in (default false) — approving a rest-day/holiday attendance correction
    // auto-banks the RL credit (no manual roster election). Triggered ONLY by decideAttendanceCorrection.
    autoAccrueOnApproval: boolean('auto_accrue_on_approval').notNull().default(false),
    // 0113: opt-in (default false) — an accrual survives the year-end close sweep instead of expiring.
    // FROZEN onto each accrual at accrual time so a mid-year flip cannot change a banked entitlement's fate.
    carryForwardAtYearEnd: boolean('carry_forward_at_year_end').notNull().default(false),
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
    // 0113 (RL Control Engine): signed per-accrual consumption tally. The active bucket nets to
    // Σ(daysCredited − daysTaken); an accrual flips to 'taken' only once fully consumed. One row per worked
    // day (preserves the unique index + the payroll predicate join) instead of splitting on partial use.
    daysTaken: numeric('days_taken', { precision: 6, scale: 2 }).notNull().default('0'),
    accrualBasis: toilAccrualBasisEnum('accrual_basis').notNull(),
    expiresOn: date('expires_on').notNull(),
    status: toilAccrualStatusEnum('status').notNull().default('active'),
    // 0113: the policy's carryForwardAtYearEnd copied at accrual time (mirrors expiryAction's freeze). The
    // year-end close sweep reads THIS per-accrual flag, not the live policy.
    carryForwardAtYearEnd: boolean('carry_forward_at_year_end').notNull().default(false),
    // Frozen at accrual (ADR-0033 33-4): 'convert_to_pay' for a First-Schedule-eligible employee (floor
    // protection), else the policy's on_expiry. The expiry sweep follows this, not a re-derivation.
    expiryAction: toilExpiryActionEnum('expiry_action').notNull().default('convert_to_pay'),
    // Phase-B #14 (0123): explicit per-election consent captured when a First-Schedule-eligible (≤ RM4,000)
    // employee banks TOIL in place of statutory cash OT. true ⇒ consent given; NULL ⇒ not a First-Schedule
    // election (> RM4,000) or a legacy row. Accrual blocks an eligible election unless the company toggle is
    // ON *and* this consent is supplied — the toggle alone must not be a blanket default (EA s.60 floor).
    firstScheduleConsent: boolean('first_schedule_consent'),
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

// ADR-0042 (#29): employee-initiated resignation. The employee submits one; HR accepts it, which triggers
// terminateEmployment (a 'voluntary' termination). Same request→approve rails as profile_change_request.
export const resignationStatusEnum = pgEnum('resignation_status', ['pending', 'accepted', 'rejected', 'withdrawn']);
export const resignationRequest = pgTable(
  'resignation_request',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id),
    lastWorkingDay: date('last_working_day').notNull(),
    reason: text('reason'),
    status: resignationStatusEnum('status').notNull().default('pending'),
    decidedByEmploymentId: uuid('decided_by_employment_id').references(() => employment.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('resignation_request_employment_idx').on(t.employmentId, t.status)],
);

// #42cff598 (ADR-0042): supporting documents for a resignation (e.g. signed resignation letter). Verbatim
// reuse of leave_request_attachment — employment_id is denormalized from the request so RLS uses
// can_see_employment(employment_id) directly (same subject + manager + admin rule as resignation_request,
// no per-row subquery). One-to-many: a resignation may carry several files.
export const resignationRequestAttachment = pgTable(
  'resignation_request_attachment',
  {
    id: id(),
    tenantId: tenantId(),
    resignationRequestId: uuid('resignation_request_id')
      .notNull()
      .references(() => resignationRequest.id),
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
  (t) => [index('resignation_request_attachment_request_idx').on(t.resignationRequestId)],
);

// Automated Probation / Contract / Internship Review Workflow (0110). Shape/RLS mirror resignation_request.
// review_type is selected at runtime from the CURRENT open assignment's employment_type; the matching
// employment.*_end_date is the trigger input. All HR decisions are advisory in v1 (confirm/extend/terminate
// record a decision + event + deep-link; none mutate employment state, none write back to a trigger column).
export const reviewTypeEnum = pgEnum('review_type', ['probation', 'contract', 'internship']);
export const reviewStatusEnum = pgEnum('review_status', ['pending_manager', 'pending_hr', 'completed', 'cancelled']);
export const reviewDecisionEnum = pgEnum('review_decision', ['confirm', 'extend', 'terminate']);
export const employmentReview = pgTable(
  'employment_review',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id),
    reviewType: reviewTypeEnum('review_type').notNull(),
    status: reviewStatusEnum('status').notNull().default('pending_manager'),
    endDate: date('end_date').notNull(), // snapshot of the triggering *_end_date
    dueDate: date('due_date').notNull(), // snapshot: end_date − REVIEW_LEAD (1 month)
    // manager stage (stage 1) — recommendation is enum-lite text; kept OUT of the subject-visible event payload.
    managerEmploymentId: uuid('manager_employment_id').references(() => employment.id),
    managerRecommendation: text('manager_recommendation'), // 'recommend_confirm'|'recommend_extend'|'recommend_terminate'
    managerComments: text('manager_comments'),
    managerSubmittedAt: timestamp('manager_submitted_at', { withTimezone: true }),
    // HR stage (stage 2)
    decision: reviewDecisionEnum('decision'),
    extendToDate: date('extend_to_date'), // stored on the row ONLY; never written back to *_end_date in v1
    hrComments: text('hr_comments'),
    decidedByEmploymentId: uuid('decided_by_employment_id').references(() => employment.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    autoTriggered: boolean('auto_triggered').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('employment_review_employment_idx').on(t.employmentId, t.status)],
);

// 6522d26a — reminder-cadence dedup ledger: one row per (review, offset_days) reminder actually
// considered/sent, so the daily sweep never re-notifies the same offset (unique index is the hard gate;
// the service pre-checks). employment_id is denormalized from the review for direct can_see_employment
// RLS (read: subject + admin-line manager + admins; write: is_admin only — the SYSTEM sweep runs with a
// group-wide hr_admin grant).
export const employmentReviewReminder = pgTable(
  'employment_review_reminder',
  {
    id: id(),
    tenantId: tenantId(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => employmentReview.id),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    offsetDays: integer('offset_days').notNull(),
    sentOn: date('sent_on').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('employment_review_reminder_uq').on(t.reviewId, t.offsetDays)],
);

// 6522d26a — probation/contract/internship letter document store. Persists the system-generated outcome
// letter (kind system_letter) and HR's uploaded final SIGNED copy (kind signed_letter), linked to the
// completed employment_review. Shape mirrors claim_attachment / resignation_request_attachment (bytea
// side-table, employment_id denormalized for RLS). Read = can_see_employment (so the SUBJECT can view +
// download their own letters from ESS — Fn 6); write = is_admin only (HR uploads; the subject must not).
export const reviewDocumentKindEnum = pgEnum('review_document_kind', ['system_letter', 'signed_letter']);
export const reviewDocument = pgTable(
  'review_document',
  {
    id: id(),
    tenantId: tenantId(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => employmentReview.id),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    kind: reviewDocumentKindEnum('kind').notNull(),
    content: bytea('content').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    uploadedByUserId: uuid('uploaded_by_user_id'),
    createdAt: createdAt(),
  },
  (t) => [index('review_document_review_idx').on(t.reviewId)],
);

// ADR-0050 (#1.1.3): yearly self-service TP1 personal tax relief. Keyed by `person_id` (TP1 is the
// employee's own statutory declaration). One scalar `tp1_amount` per assessment year — the single number
// the PCB kernel consumes (LP). Append-only request-row shape (profile_change_request pattern): the latest
// row per (person, year) wins; the editable draft is UPDATEd in place; a submitted row is immutable and a
// correction is a NEW submitted row. RLS scopes to app.can_see_person (self + admin) for read AND write.
export const tp1StatusEnum = pgEnum('tp1_status', ['draft', 'submitted']);

// Per-category TP1 breakdown (a2f1fa24), mirroring the LHDN paper TP1 sections. Every category is an
// OPTIONAL non-negative RM amount (empty = 0); `remarks` is optional free text. The canonical starter set
// (ADR-00XX) — extensible via this JSONB shape without a migration. `tp1_amount` is the server-computed
// round2 sum of the numeric categories; the kernel consumes only that sum, never these fields.
export const TP1_CATEGORY_KEYS = [
  'individual',
  'spouse',
  'children',
  'parent',
  'medicalInsurance',
  'lifestyle',
  'education',
  'other',
] as const;
export type Tp1CategoryKey = (typeof TP1_CATEGORY_KEYS)[number];
export type Tp1Categories = Partial<Record<Tp1CategoryKey, number>> & { remarks?: string | null };

export const tp1Relief = pgTable(
  'tp1_relief',
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id),
    assessmentYear: integer('assessment_year').notNull(),
    status: tp1StatusEnum('status').notNull().default('draft'),
    // The employee's single declared annual optional-relief total (LHDN TP1). All the kernel consumes:
    // `tp1_amount` STAYS the authoritative, server-computed SUM of `categories` when a breakdown exists,
    // so the PCB kernel input (LP) is unchanged (ADR-00XX extends ADR-0050).
    tp1Amount: numeric('tp1_amount', { precision: 12, scale: 2 }).notNull().default('0.00'),
    // OPTIONAL per-category breakdown mirroring the paper LHDN TP1 form (a2f1fa24). NULL on legacy rows
    // (scalar-only) — they keep working unchanged. The kernel never reads this; it reads `tp1_amount`.
    // JSONB extension point: new categories can be added without a migration. PDPA Layer-0 (ADR-0030) —
    // the amounts live ONLY on this RLS-protected row, never copied into the tp1.* event payloads.
    categories: jsonb('categories').$type<Tp1Categories | null>(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // Latest-wins read for a (person, year): order by created_at desc within the scope.
    index('tp1_relief_person_year_idx').on(t.tenantId, t.personId, t.assessmentYear, t.createdAt),
  ],
);

// ─────────────── Personnel — Family / Dependents (phase 1, migration 0137) ───────────────
// A per-PERSON register of family members / dependents for BENEFITS / INSURANCE only. Person-keyed
// (concurrent-employment-safe, like tp1_relief / employee_statutory_my) and gated with app.can_see_person
// (self+admin read) / app.is_admin() (admin write) in the migration. Deliberately SEPARATE from the
// approval-gated employee_statutory_my.num_children tax figure — is_beneficiary is a plain insurance flag,
// NOT a fractional allocation and NOT a tax-dependent flag (both out of scope). Admin-maintained only.
export const employeeDependent = pgTable(
  'employee_dependent',
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id),
    fullName: text('full_name').notNull(),
    relationship: text('relationship').notNull(), // validated in-service: spouse|child|parent|sibling|other
    dateOfBirth: date('date_of_birth'),
    gender: text('gender'), // 'male' | 'female' | 'undisclosed' (validated in-service)
    icOrPassport: text('ic_or_passport'), // optional PII — kept OUT of DomainEvent payloads (ADR-0030)
    isBeneficiary: boolean('is_beneficiary').notNull().default(false), // insurance beneficiary flag; NOT tax
    phone: text('phone'),
    remarks: text('remarks'),
    archivedAt: timestamp('archived_at', { withTimezone: true }), // soft-delete
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('employee_dependent_person_idx').on(t.tenantId, t.personId)],
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

// Configurable Payroll Cycle master (ADR-0069). An admin-maintained, COMPANY-scoped catalog of the
// friendly cycle names the Payroll Process wizard's "Payroll Cycle" dropdown offers, mirroring the
// leave_type / claim_type catalog pattern (single archived_at soft-delete, partial-unique on the live
// name). Each row maps to ONE of the four fixed behavioural run_types (payroll_run_type) — this makes
// the LABEL/LIST configurable without letting an admin invent new payroll math; the kernel still keys
// every gating rule off run_type. `remarks` carries the free-text label an off_cycle preset needs
// (e.g. "Advance Salary" / "Mid-Month"), snapshotted onto the batch at creation exactly as today.
export const payrollCycle = pgTable(
  'payroll_cycle',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    name: text('name').notNull(),
    // The fixed behavioural run type this cycle maps to (NOT the label). The kernel gates on this.
    runType: payrollRunTypeEnum('run_type').notNull(),
    // Free-text label an off_cycle preset carries (e.g. 'Advance Salary'). Null for straight-through cycles.
    // LOAD-BEARING: snapshotted onto the batch and used to narrow the delete-guard — do NOT reuse as a note.
    remarks: text('remarks'),
    // Free-text Processing Behaviour note (R17 1f6b536b). Pure documentation / business reference for
    // payroll administrators — it does NOT drive payroll math (run_type does). Nullable.
    description: text('description'),
    // Dropdown ordering (ascending). Ties broken by name in the read layer.
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('payroll_cycle_company_idx').on(t.companyId),
    // One live name per company (case-insensitive). Archived rows may share a name that was re-created.
    uniqueIndex('payroll_cycle_company_name_uq').on(t.companyId, sql`lower(${t.name})`).where(sql`archived_at IS NULL`),
  ],
);

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
    // Step 6 (f3148da1) — when closeBatch finalized this run. NULL for legacy batches. Audit field.
    closedAt: timestamp('closed_at', { withTimezone: true }),
    // Step 6 (f3148da1) — the instant this batch's payslips become visible to employees in ESS, COMPUTED AT
    // CLOSE TIME (closeBatch runs under an admin session that can read the company release config; the ESS
    // employee session cannot, so the gate must NOT re-read that config). NULL = not yet closed OR (for legacy
    // batches, backfilled to created_at) already released. myPayslips/payslipDetail gate on releasedAt <= now.
    releasedAt: timestamp('released_at', { withTimezone: true }),
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
    // Optimistic concurrency control (feedback 9bc442bc, reporter req. #5). Bumped every time selective
    // reprocessing replaces this employee's slip; the reprocess path takes a row-level lock (SELECT … FOR
    // UPDATE) on exactly the selected rows and asserts the expected version, so concurrent reprocessing of
    // the same employee conflicts loudly while leaving unrelated employees' rows unlocked and untouched.
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('payslip_batch_employment_uq').on(t.batchId, t.employmentId)],
);

// ─────────────── Payroll status control + selective reprocessing (feedback 9bc442bc) ───────────────
// Dedicated audit tables (reporter req.: capture actor/timestamp/reason + before/after snapshot for every
// rollback, unlock and reprocess) — a purpose-built, queryable trail alongside the generic domain_event log.
export const payrollStatusHistory = pgTable(
  'payroll_status_history',
  {
    id: id(),
    tenantId: tenantId(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => payrollBatch.id),
    action: text('action').notNull(), // 'rollback' | 'unlock' | 'close' | 'reprocess'
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id'),
    reason: text('reason'),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: createdAt(),
  },
  (t) => [index('payroll_status_history_batch_idx').on(t.batchId)],
);

export const payrollEmployeeResultHistory = pgTable(
  'payroll_employee_result_history',
  {
    id: id(),
    tenantId: tenantId(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => payrollBatch.id),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    action: text('action').notNull(), // 'reprocess'
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id'),
    reason: text('reason'),
    versionBefore: integer('version_before'),
    versionAfter: integer('version_after'),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: createdAt(),
  },
  (t) => [index('payroll_emp_result_history_batch_idx').on(t.batchId)],
);

// Queue-based reprocessing (reporter req.): a durable job row with an idempotency key (a double-clicked
// or retried submit reuses the same job instead of spawning a duplicate run) whose status the UI polls.
export const payrollReprocessJob = pgTable(
  'payroll_reprocess_job',
  {
    id: id(),
    tenantId: tenantId(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => payrollBatch.id),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull().default('queued'), // 'queued' | 'running' | 'completed' | 'failed'
    employmentIds: jsonb('employment_ids').$type<string[]>().notNull(),
    reason: text('reason'),
    requestedBy: uuid('requested_by'),
    result: jsonb('result'),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('payroll_reprocess_job_idem_uq').on(t.tenantId, t.idempotencyKey)],
);

// Granular RBAC permission grants (reporter req.: payroll.rollback / unlock / reprocess.selective / close,
// configurable per company/tenant). Rows OVERRIDE the code defaults for a (permission_key, role) pair;
// company_id NULL = tenant-wide. Resolver in lib/payroll-permissions.ts.
export const payrollPermissionGrant = pgTable(
  'payroll_permission_grant',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id').references(() => company.id),
    permissionKey: text('permission_key').notNull(),
    role: text('role').notNull(),
    allowed: boolean('allowed').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);

// Step-up / OTP challenge for the high-risk Unlock action (reporter req.: confirmation step, password
// re-entry or OTP). A one-time code is issued, hashed, and must be re-entered to unlock; single-use + TTL.
export const payrollStepUpChallenge = pgTable(
  'payroll_step_up_challenge',
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid('user_id').notNull(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => payrollBatch.id),
    purpose: text('purpose').notNull(), // 'unlock'
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('payroll_step_up_challenge_lookup_idx').on(t.batchId, t.userId, t.purpose)],
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
    // ADR-0050 §0.4 provenance: who last set tp1_deduction. 'tp1_self' = a TP1 self-relief prefill set it
    // (refreshable by a later prefill); null (default) = an admin keyed it / never prefilled (sticky — a
    // re-prefill leaves it untouched). The admin forms (setPayrollInput / setPayrollDeductionInput) never
    // write this column, so a manual override resets provenance to null and becomes sticky.
    tp1Source: text('tp1_source'), // 'tp1_self' | null
    zakat: numeric('zakat', { precision: 12, scale: 2 }).notNull().default('0'),
    // Sum of approved TAXABLE claims prefilled into this batch (ADR-0021). Added to the taxable allowance
    // base in generatePayslips → contributes to PCB/EPF/SOCSO/EIS like a regular monthly allowance.
    claimAllowance: numeric('claim_allowance', { precision: 12, scale: 2 }).notNull().default('0'),
    // 1.2.8 Loan instalment(s) reserved for this batch (ADR-0060). POST-TAX — read UNCONDITIONALLY (not
    // behind TYPED_PAY_COMPONENTS_ENABLED) and subtracted after statutory, like tp1_deduction/zakat; it
    // touches NO statutory base. Set (not blind-added) by prefillLoansForBatch from the reserved repayments.
    loanDeduction: numeric('loan_deduction', { precision: 12, scale: 2 }).notNull().default('0'),
    // OT rate-bucket decomposition (UI-entry convenience). The clerk splits employer-policy overtime
    // pay across four rate-labelled buckets (1.0× flat / 1.5× normal working day / 2.0× rest day /
    // 3.0× public holiday); the UI sums them into `overtime_amount`, which is the persisted sum and
    // the ONLY field downstream reads. Nullable on purpose: NULL ⇒ no per-bucket decomposition recorded
    // (legacy rows, attendance-prefilled rows, bonus-enact rows). RM amounts, not hours.
    otBreakdown: jsonb('ot_breakdown').$type<{ flat: number; normal: number; rest: number; holiday: number } | null>(),
    // Fix-5 (audit M#17) provenance: which method last produced overtime_amount. 'attendance' = the
    // statutory s.60/60A/60D engine via prefillOvertimeFromAttendance; 'manual' = the admin keyed it
    // via setPayrollInput; NULL = legacy / no OT write recorded. Mirrors the tp1_source pattern above and
    // is snapshotted onto the payslip statutory blob so an auditor can see how the OT figure was derived.
    otSource: text('ot_source').$type<'attendance' | 'manual' | null>(),
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
    // Configurable pay-rule (Payroll Setup). Nullable: null ⇒ the legacy fixed-amount behaviour, so every
    // existing row stays valid (the compat golden is untouched). Resolved by core/pay-rule.ts and only read
    // inside the kernel's TYPED_PAY_COMPONENTS_ENABLED block — a rule is meaningless with typed components off.
    rule: jsonb('rule').$type<PayRule | null>(),
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
    // 1.2.1 Fixed Transaction — store-only currency (MYR-only kernel, no FX). Default 'MYR'; a write-time
    // guard rejects any non-MYR value so the UI warns at entry. Legacy rows are all 'MYR' (the kernel never
    // supported another currency).
    currency: text('currency').notNull().default('MYR'),
    // 1.2.1 Fixed Transaction — per-employee override of the catalog `prorates` flag. null = inherit the
    // catalog flag (so every legacy/backfilled row stays byte-identical: null ⇒ catalog ⇒ unchanged).
    // "prorate" = the EA-1955 join/resign tenure factor the kernel computes per employee.
    prorateOverride: boolean('prorate_override'),
    // 1.2.1 Fixed Transaction — free-text note on this recurring value (nullable).
    remarks: text('remarks'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: createdAt(),
    // Fixed Transaction screen (feedback b7fc8583) — the Payroll Cycle tag captured on the dedicated screen.
    // Reuses the existing payroll_run_type taxonomy (regular/off_cycle/bonus/adjustment) — NOT a new
    // vocabulary — so the label aligns byte-for-byte with the engine's own cycle master for any future
    // routing follow-up. Nullable, no default: null = unspecified, so every legacy row and every write from
    // the people-detail editor (which never sends it) stays byte-identical. The kernel does NOT read this
    // column in this build (payout still follows the valid_from/valid_to window, exactly as recurring
    // amounts work today); it is captured, stored and shown, but does not route which run pays the item.
    runType: payrollRunTypeEnum('run_type'),
  },
  (t) => [index('employment_pay_component_idx').on(t.employmentId, t.validFrom)],
);

// 1.2.3 CP38 Deduction — an LHDN/court instalment deducted each month IN ADDITION to monthly MTD/PCB.
// Effective-dated, per-employment, supersede-on-write (mirrors `compensation`): a change CLOSEs the open
// row (set its `valid_to`) and INSERTs a new open row, so at most one row applies to a given month. Dates
// are MONTH-ALIGNED (the service normalises any input to the first of its month). The `amount` is a
// garnishment figure (tenant data) — kept OUT of the DomainEvent payload (ADR-0030 Layer 0).
export const employeeCp38 = pgTable(
  'employee_cp38',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    // The LHDN CP38 instruction reference (the order/letter number).
    cp38Ref: text('cp38_ref').notNull(),
    // Monthly instalment in RM.
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    // Month-aligned effective window. validTo is the INCLUSIVE last month it applies (null = open-ended).
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    remarks: text('remarks'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('employee_cp38_employment_idx').on(t.employmentId, t.validFrom)],
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

// ───────────────── Attendance Allowance (ADR-0072) ─────────────────
// A company-scoped catalog policy that rewards good attendance: a fixed amount paid to employees who
// meet a set of MONTHLY attendance conditions, transferred into a draft payroll run via the existing
// pay-component prefill path. Evaluation is a PURE READ (no award table) — the only persisted output is
// the payroll_batch_component row at transfer time (claims/OT precedent). RLS: tenant-catalog read,
// admin-of-company write (mirrors clocking_location / business_unit). `method` is a text tag (v1 accepts
// only 'monthly'; Daily deferred — no enum, so adding it later needs no migration).

// v1 monthly criteria — EVERY field is a pure function of MonthSummaryRow. Deferred conditions
// (late-minutes, early-out, per-leave-type caps, adjustment/OT-rejection counts) are NOT declared here:
// a criterion that is not computable from the stored roll-up is not in the type.
export type AttendanceAllowanceCriteria = {
  /** present + late + halfDay must be >= this (days actually shown up). */
  minAttendanceDays?: number;
  /** absent days must be <= this. */
  maxAbsentDays?: number;
  /** COUNT of late-status days must be <= this. */
  maxLateCount?: number;
  /** leaveDays must be <= this. */
  maxTotalLeaveDays?: number;
  /** absent == 0 && late == 0. */
  requirePerfectAttendance?: boolean;
};

// Empty object ⇒ all-in-scope. Each list is an OR within its axis; axes AND together (a policy scoped to
// one department AND one BU matches employees in that department AND that BU).
export type AttendanceAllowanceScope = {
  departmentIds?: string[];
  businessUnitIds?: string[];
  companyIds?: string[];
};

export const attendanceAllowancePolicy = pgTable(
  'attendance_allowance_policy',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    // v1 accepts only 'monthly' (app-side check). Text, not pgEnum — low-cardinality tag; Daily later.
    method: text('method').notNull().default('monthly'),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    payComponentId: uuid('pay_component_id')
      .notNull()
      .references(() => payComponent.id),
    effectiveFrom: date('effective_from').notNull(),
    // active | inactive (app-side check). Archive (archivedAt) hides from the active catalog.
    status: text('status').notNull().default('active'),
    criteria: jsonb('criteria').$type<AttendanceAllowanceCriteria>().notNull().default({}),
    scope: jsonb('scope').$type<AttendanceAllowanceScope>().notNull().default({}),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('attendance_allowance_policy_company_idx').on(t.tenantId, t.companyId),
    // Per-company code uniqueness among live (non-archived) rows — mirrors business_unit / clocking_location.
    uniqueIndex('attendance_allowance_policy_code_uq')
      .on(t.tenantId, t.companyId, sql`lower(${t.code})`)
      .where(sql`${t.archivedAt} is null`),
    check('attendance_allowance_policy_amount_nonneg', sql`${t.amount} >= 0`),
  ],
);

// ───────────────── 1.2.2 Individual Transaction (ADR-0055) ─────────────────
// A pure dated one-off transaction ledger: per-employee, non-recurring earnings/deductions/overtime/
// unpaid/leave entries tied to a transaction date, belonging to exactly one month+cycle (payroll_batch).
// "No carry-forward" is satisfied by construction by the batchId FK — a row belongs to a single batch and
// nothing copies it forward. This slice is RECORD / VIEW / EDIT / DELETE only (admin, before finalize);
// kernel consumption of these rows is a deliberately deferred future slice (see ADR-0055).
export const payrollTxnKindEnum = pgEnum('payroll_txn_kind', [
  'earning',
  'deduction',
  'overtime',
  'unpaid',
  'leave',
]);
export type PayrollTxnKind = (typeof payrollTxnKindEnum.enumValues)[number];

export const payrollIndividualTxn = pgTable(
  'payroll_individual_txn',
  {
    id: id(),
    tenantId: tenantId(),
    // The resolved month+cycle target. A row belongs to exactly one batch — this FK IS the no-carry-forward
    // guarantee (nothing copies a row into a sibling/next-month batch).
    batchId: uuid('batch_id')
      .notNull()
      .references(() => payrollBatch.id),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    kind: payrollTxnKindEnum('kind').notNull(),
    // The per-entry transaction date; validated app-side to fall within the batch's pay-period month.
    txnDate: date('txn_date').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull().default('0'),
    // Descriptive qty/hours/days/units figure (nullable). NOT read by any kernel math in this slice.
    quantity: numeric('quantity', { precision: 12, scale: 2 }),
    // One of TXN_UNITS ('amount'|'qty'|'hours'|'days'|'units'); validated app-side (mirror ROUNDING_METHODS).
    unit: text('unit'),
    notes: text('notes'),
    createdAt: createdAt(),
  },
  (t) => [
    // No unique constraint — multiple dated entries per (batch, employment) are allowed by design.
    index('payroll_individual_txn_batch_emp_idx').on(t.batchId, t.employmentId),
    index('payroll_individual_txn_tenant_batch_idx').on(t.tenantId, t.batchId),
  ],
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
    // Eligibility rules engine (Performance eligibility slice): a single JSONB criteria object that
    // openCycle AND-combines to snapshot the roster. Same pattern as leave_type.eligibility — criteria
    // live directly on the row, no child table, no lookup tables. Replaces the old boolean
    // exclude_probation + date hired_before pair (clean cutover — the module has no production rows).
    // Shape (all optional/AND-combined): { companyIds?, statuses?, employmentTypes?, minServiceMonths?,
    // hiredBefore? }. Null/absent ⇒ every active in-scope employee is eligible.
    eligibilityRules: jsonb('eligibility_rules'),
    // Lifecycle stages HR elected at initiation (JSONB, migration-free). Array of
    // { kind: 'goal_setting'|'mid_year'|'year_end', label, opensOn?, dueOn? }. Null/absent ⇒ all three.
    stages: jsonb('stages'),
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
    // ── Lifecycle (column-widening, ADR-0022 lifecycle extension) ──
    // Mid-year (MYR) stage. Year-end (YER) reuses the canonical self/manager/overall columns above,
    // so calibration / comp / release / acknowledge / distribution / AI stay untouched.
    midSelfRating: integer('mid_self_rating'),
    midSelfComments: text('mid_self_comments'),
    midSelfSubmittedAt: timestamp('mid_self_submitted_at', { withTimezone: true }),
    midManagerRating: integer('mid_manager_rating'),
    midManagerComments: text('mid_manager_comments'),
    midManagerSubmittedAt: timestamp('mid_manager_submitted_at', { withTimezone: true }),
    // Goal-setting stage lock (the gate that freezes approved cycle-bound goals).
    goalStageStatus: goalStageStatusEnum('goal_stage_status').notNull().default('pending'),
    goalStageLockedAt: timestamp('goal_stage_locked_at', { withTimezone: true }),
    // Closure (G4): preliminary = YER manager's forwarded figure; final/abc = HR's deliberate say.
    preliminaryScore: numeric('preliminary_score', { precision: 5, scale: 2 }),
    finalScore: numeric('final_score', { precision: 5, scale: 2 }),
    abcClass: perfAbcClassEnum('abc_class'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
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
    // Goal-setting approval (G2): draft → proposed → approved. An approved cycle-bound goal becomes
    // immutable once its review's goalStageStatus = 'locked' (the stage gate, not a per-goal lock state).
    approvalStatus: goalApprovalEnum('approval_status').notNull().default('draft'),
    approvedByUserId: uuid('approved_by_user_id'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
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

// Performance attachments (G5, lifecycle extension). Subject-scoped, like claim_attachment: the
// employment_id is denormalized from the review's SUBJECT, so RLS is a direct can_see_employment()
// — visible to the subject, their admin-line manager, and admins (NOT peer/subordinate 360 reviewers).
// stage_kind is a plain string discriminator ('goal_setting'|'mid_year'|'year_end'|null=review-level),
// not an FK (there is no stage table — the lifecycle uses column-widening on performance_review).
export const performanceAttachment = pgTable(
  'performance_attachment',
  {
    id: id(),
    tenantId: tenantId(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => performanceReview.id),
    employmentId: uuid('employment_id') // denormalized subject — drives RLS
      .notNull()
      .references(() => employment.id),
    stageKind: text('stage_kind'), // 'goal_setting' | 'mid_year' | 'year_end' | null (review-level)
    content: bytea('content').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => appUser.id),
    createdAt: createdAt(),
  },
  (t) => [index('performance_attachment_review_idx').on(t.reviewId)],
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

// ─────────────────── Per-body statutory override (overlay) (ADR-0037, #6) ───────────────────
// Effective-dated override for ONE statutory body (epf/socso/eis/pcb/ot/hrdf). `data` is just that
// body's slice of the StatutoryRuleset. The resolver overlays the newest-effective component per body
// ON TOP of the bundled baseline (pack ∪ ruleset ∪ default), so e.g. a SOCSO-only mid-year change is a
// single row that never touches EPF/PCB. Empty table ⇒ baseline unchanged (backward-compatible). RLS
// mirrors statutory_ruleset (tenant-wide read, admin-only append; archive = soft-delete).
export const statutoryComponentOverride = pgTable(
  'statutory_component_override',
  {
    id: id(),
    tenantId: tenantId(),
    country: text('country').notNull().default('MY'),
    body: text('body').notNull(), // 'epf' | 'socso' | 'eis' | 'pcb' | 'ot' | 'hrdf'
    version: text('version').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    data: jsonb('data').notNull(),
    notes: text('notes'),
    createdByUserId: uuid('created_by_user_id').references(() => appUser.id),
    createdAt: createdAt(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('statutory_component_override_lookup_idx').on(t.tenantId, t.country, t.body, t.effectiveFrom)],
);

// ─────────────────── EA-form override layer (1.2.6, ADR-0059) ───────────────────
// An EA-ONLY amendment layer: per (employmentId, year, field) the amount HR overlays onto the
// payroll-derived EA (C.P.8A) figure at render time. Payroll records (payslip, payroll_input) are NEVER
// mutated — the merge in localization/my/reports.ts overlays these rows on the live derived statement, so
// amendments affect ONLY the generated EA form, not payroll, CP8D/Form E, or any other surface.
//
// Modelled on statutory_component_override: a plain text discriminator (`field`, validated in TS against
// EA_FIELDS), NOT a pgEnum. No `original_amount` snapshot (the derived baseline is recomputed live every
// read; the audit "before" lives in the DomainEvent payload). No soft-delete lifecycle — a plain upsert
// keyed on (tenant, employment, year, field); clear = hard DELETE; the immutable event log is the trail.
// RLS (0119): USING can_see_employment (subject reads their own amended EA), WITH CHECK can_admin_employment
// (only HR admins write). `year` is a 4-char STRING (matches the payPeriod LIKE '<year>-%' convention).
export const eaOverride = pgTable(
  'ea_override',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    year: text('year').notNull(), // 'YYYY'
    field: text('field').notNull(), // one of EA_FIELDS (core/ea-override.ts) — validated in TS
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    reason: text('reason').notNull(), // mandatory, for audit
    createdByUserId: uuid('created_by_user_id').references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('ea_override_field_uq').on(t.tenantId, t.employmentId, t.year, t.field),
    index('ea_override_lookup_idx').on(t.tenantId, t.employmentId, t.year),
  ],
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

// Dependent sub-category under a claim type (e.g. TRAVEL → MILEAGE / PARKING / TOLL). The submission form
// shows it as a dependent dropdown; mandatory only when the chosen type has ≥1 live item (enforced in the
// service, not the schema — claim_request.claim_item_id stays nullable for legacy/zero-item types).
export const claimItem = pgTable(
  'claim_item',
  {
    id: id(),
    tenantId: tenantId(),
    claimTypeId: uuid('claim_type_id')
      .notNull()
      .references(() => claimType.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('claim_item_type_idx').on(t.claimTypeId),
    // One live code per (type) — mirrors claim_type's partial-unique (archived rows may re-use a code).
    uniqueIndex('claim_item_type_code_uq').on(t.tenantId, t.claimTypeId, t.code).where(sql`archived_at IS NULL`),
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
    /**
     * Per-type rate/calculation config (discriminated union; nullable/absent ⇒ default 'receipt').
     *   { kind: 'receipt' }                                — amount entered by the employee (current behaviour).
     *   { kind: 'mileage_flat', ratePerKm: number }        — amount = km × ratePerKm.
     *   { kind: 'fixed_allowance', amount: number }        — fixed allowance; amount not employee-editable.
     * Effective-dated because rates change year-to-year (lives on the append-only policy, never claim_type).
     */
    rateConfig: jsonb('rate_config').$type<ClaimRateConfig>(),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    createdAt: createdAt(),
  },
  (t) => [index('claim_policy_type_idx').on(t.claimTypeId, t.validFrom)],
);

export type ClaimRateConfig =
  | { kind: 'receipt' }
  | { kind: 'mileage_flat'; ratePerKm: number }
  | { kind: 'fixed_allowance'; amount: number };

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
    /** Dependent sub-category (nullable: legacy rows + types with no items). */
    claimItemId: uuid('claim_item_id').references(() => claimItem.id),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    /** Distance in km — for mileage_flat claims only (amount = quantityKm × ratePerKm). NULL otherwise. */
    quantityKm: numeric('quantity_km', { precision: 12, scale: 2 }),
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

// ─────────────── Employee loan instalments (1.2.8, ADR-0060) ───────────────
// HR-administered staff loans recovered by a fixed monthly POST-TAX net-pay deduction over an agreed
// duration. Two-phase reserve→apply (mirrors claims): prefill RESERVES the next instalment; the ledger
// (outstanding_balance / instalments_paid / status) advances ONLY inside generatePayslips. One terminal
// repaid status ('settled' covers manual payoff + auto-stop). 'cancelled' = voided before any instalment.
export const loanStatusEnum = pgEnum('loan_status', ['active', 'suspended', 'settled', 'cancelled']);

export const employeeLoan = pgTable(
  'employee_loan',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    // Catalog-as-text (constrained app-side to 'personal' | 'housing' | 'advance'), not a hard enum.
    loanType: text('loan_type').notNull(),
    principal: numeric('principal', { precision: 12, scale: 2 }).notNull(),
    // Annual flat % (ADR-0060). interestMethod: 'flat' → add-on on original principal; 'none' → no interest.
    interestRate: numeric('interest_rate', { precision: 6, scale: 3 }).notNull().default('0'),
    interestMethod: text('interest_method').notNull().default('none'), // 'flat' | 'none'
    durationMonths: integer('duration_months').notNull(),
    startDate: date('start_date').notNull(),
    // Persisted at creation (audit). monthlyInstalment is the equal instalment; the final one reconciles.
    monthlyInstalment: numeric('monthly_instalment', { precision: 12, scale: 2 }).notNull(),
    totalRepayable: numeric('total_repayable', { precision: 12, scale: 2 }).notNull(),
    // The single authoritative mutable counter — only ever mutated inside generatePayslips (ADR-0060).
    outstandingBalance: numeric('outstanding_balance', { precision: 12, scale: 2 }).notNull(),
    instalmentsPaid: integer('instalments_paid').notNull().default(0),
    status: loanStatusEnum('status').notNull().default('active'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('employee_loan_employment_idx').on(t.employmentId, t.status)],
);

// The persisted repayment schedule + reservation/apply ledger. The idempotency anchor (partial-unique on
// 'reserved' guarantees ≤1 reserved instalment per loan at a time) and the source for per-cycle
// skip/partial history (ADR-0060). employment_id denormalized for RLS (like claim_attachment).
export const loanRepayment = pgTable(
  'loan_repayment',
  {
    id: id(),
    tenantId: tenantId(),
    loanId: uuid('loan_id')
      .notNull()
      .references(() => employeeLoan.id),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    sequenceNo: integer('sequence_no').notNull(), // 1..durationMonths
    dueAmount: numeric('due_amount', { precision: 12, scale: 2 }).notNull(),
    appliedAmount: numeric('applied_amount', { precision: 12, scale: 2 }).notNull().default('0'),
    reservedBatchId: uuid('reserved_batch_id').references(() => payrollBatch.id),
    appliedBatchId: uuid('applied_batch_id').references(() => payrollBatch.id),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    status: text('status').notNull().default('scheduled'), // 'scheduled'|'reserved'|'applied'|'skipped'
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('loan_repayment_loan_seq_uq').on(t.loanId, t.sequenceNo),
    // At most one RESERVED instalment per loan at a time — closes the re-prefill double-pick gap in the DB.
    uniqueIndex('loan_repayment_one_reserved_uq').on(t.loanId).where(sql`status = 'reserved'`),
  ],
);

// ─────────────── In-product feedback → AI-plan → review → build loop (ADR-0043) ───────────────
// A user logs feedback (issue / enhancement / new function); an AI planning agent writes an
// implementation `plan`; the REPORTER reviews it (approve or contest → re-plan); on approval an
// out-of-app build agent produces a human-reviewed PR. RLS mirrors claims (can_see_employment for
// read); the review authority is the reporter (asserted in the service).
export const feedbackCategoryEnum = pgEnum('feedback_category', ['issue', 'enhancement', 'new_function']);
export const feedbackStatusEnum = pgEnum('feedback_status', [
  'open', // submitted, awaiting a plan
  'planned', // the agent wrote a plan; awaiting the reporter's review
  'approved', // reporter approved the plan; awaiting build
  'contested', // reporter pushed back; the agent will re-plan
  'building', // a build agent is implementing it (out-of-app)
  'done', // built (build_ref points at the PR), awaiting release
  'deployed', // built AND released to the server (the improvement loop closes the item here)
  'rejected', // an admin closed it without building
  'cancelled', // the reporter withdrew it
]);
export type FeedbackCategory = (typeof feedbackCategoryEnum.enumValues)[number];
export type FeedbackStatus = (typeof feedbackStatusEnum.enumValues)[number];

export const feedbackRequest = pgTable(
  'feedback_request',
  {
    id: id(),
    tenantId: tenantId(),
    // Denormalized for RLS can_see_employment(); the user id is the review gate.
    reporterEmploymentId: uuid('reporter_employment_id')
      .notNull()
      .references(() => employment.id),
    reporterUserId: uuid('reporter_user_id').references(() => appUser.id),
    category: feedbackCategoryEnum('category').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    expectedBehavior: text('expected_behavior'),
    expectedFunction: text('expected_function'),
    status: feedbackStatusEnum('status').notNull().default('open'),
    // AI-written implementation plan (markdown) + how many times it has been (re)drafted.
    plan: text('plan'),
    planRevision: integer('plan_revision').notNull().default(0),
    planModel: text('plan_model'), // provider/model that produced the current plan (audit)
    contestReason: text('contest_reason'), // the reporter's latest push-back (plan-contest OR post-deploy refute)
    // How many times a DEPLOYED result was refuted by the reporter + sent back round the loop (ADR-0051).
    // A quality signal: a feature reopened repeatedly is one the spec/build keeps missing.
    reopenedCount: integer('reopened_count').notNull().default(0),
    // Snapshot of `status` at the moment cancelFeedback ran, so restoreFeedback can put the item back
    // exactly where it was (rather than guessing/always resetting to `open`). Null except while cancelled.
    statusBeforeCancel: feedbackStatusEnum('status_before_cancel'),
    buildRef: text('build_ref'), // PR / branch link once a build agent runs (F4)
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('feedback_request_reporter_idx').on(t.tenantId, t.reporterEmploymentId, t.status)],
);

export const feedbackAttachment = pgTable(
  'feedback_attachment',
  {
    id: id(),
    tenantId: tenantId(),
    feedbackRequestId: uuid('feedback_request_id')
      .notNull()
      .references(() => feedbackRequest.id),
    // Denormalized from the feedback so RLS can use can_see_employment(employment_id) directly.
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
  (t) => [index('feedback_attachment_feedback_idx').on(t.feedbackRequestId)],
);

// ── ADR-0069: Leave Encashment (leave-side only). Freeze + calculate + expose to payroll; NO salary math,
// NO RM conversion, NO payroll logic here — payroll's existing encashmentDivisor (db/schema.ts) handles
// the money conversion downstream. See core/leave-encashment.ts for the service and docs/adr/0069 for the
// full design (freeze enforcement, rounding rule, direct-termination bypass). ──────────────────────────

// One row per company (0086/toil_policy pattern). Eligible leave is Annual only (resolved by leaveType.code
// = 'ANNUAL', same as leaverAdvisory) — no eligible-types column; the rounding rule is a code constant, not
// configurable, so no rounding column either. Extension path when multi-type arrives: a nullable
// leave_type_id column, exactly how leave_approval_policy (0086) grew from a single default row.
export const leaveEncashmentPolicy = pgTable(
  'leave_encashment_policy',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    enabled: boolean('enabled').notNull().default(false),
    autoFreeze: boolean('auto_freeze').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('leave_encashment_policy_company_uq').on(t.companyId)],
);

export const leaveEncashmentStatusEnum = pgEnum('leave_encashment_status', ['frozen', 'unfrozen']);

// One row per (resignation, leave type) — currently always the tenant's ANNUAL type. balanceDays is the raw
// signed ledger balance at the approval date; encashableDays is the auto-computed whole-day figure (clamped
// >= 0, half-up rounding — see core/leave-encashment.ts computeEncashableDays). overrideDays/overrideReason
// are HR's manual adjustment (supports 2dp / half-day increments); when set, override_days is the effective
// figure everywhere. status flips to 'unfrozen' while HR corrects the ledger, then back to 'frozen' on
// adjust (adjust re-locks — there is no separate "recalculate" verb). The partial unique index enforces "at
// most one ACTIVE frozen snapshot per (employment, leave type)" — the freeze trigger (migration) reads it.
export const leaveEncashmentSnapshot = pgTable(
  'leave_encashment_snapshot',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    resignationRequestId: uuid('resignation_request_id')
      .notNull()
      .references(() => resignationRequest.id),
    leaveTypeId: uuid('leave_type_id')
      .notNull()
      .references(() => leaveType.id),
    balanceDays: numeric('balance_days', { precision: 6, scale: 2 }).notNull(),
    encashableDays: numeric('encashable_days', { precision: 6, scale: 2 }).notNull(),
    calculatedAsOf: date('calculated_as_of').notNull(),
    status: leaveEncashmentStatusEnum('status').notNull().default('frozen'),
    overrideDays: numeric('override_days', { precision: 6, scale: 2 }),
    overrideReason: text('override_reason'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('leave_encashment_snapshot_resignation_type_uq').on(t.resignationRequestId, t.leaveTypeId),
    uniqueIndex('leave_encashment_snapshot_active_uq')
      .on(t.employmentId, t.leaveTypeId)
      .where(sql`status = 'frozen'`),
  ],
);
