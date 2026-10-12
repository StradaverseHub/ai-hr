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
// TYPE-ONLY, and the only core/ import in this file. core/attendance-trace.ts is a deliberate LEAF with
// no imports of its own, so this cannot close a cycle; `import type` is erased at runtime regardless.
import type { AttendanceTraceV1 } from '../core/attendance-trace';
import {
  pgTable,
  foreignKey,
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
  smallint,
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
  // Operator tier (0294) — the INSTALLATION-level identity that provisions new customers. Not a
  // customer role and NOT an admin role: isAdmin()/is_group_admin() do not admit it, so it reaches no
  // customer admin screen. It cannot be granted from the web tier at all — 0295's role_assignment_write
  // policy forbids it for every branch, and core/auth.ts inviteUser() does not list it as invitable.
  // Only ai_hr_owner (seed / by hand on a deployment) creates an operator grant.
  'operator',
]);
export const employmentTypeEnum = pgEnum('employment_type', [
  'full_time',
  'part_time',
  'contract',
  'intern',
]);
/**
 * R46 79eb7151 (migration 0270) — how an employee is paid. Distinct from Pay Mode (payroll_policy.policy_type)
 * and Payment Term (PayrollPolicyConfig.frequency), which describe how pay is CALCULATED and how often, not
 * the disbursement channel. Also distinct from the company-level disbursement_bank, which names the corporate
 * account the bulk file is drawn on.
 */
export const paymentMethodEnum = pgEnum('payment_method', ['bank_transfer', 'cheque', 'cash']);
// R81 (9cbf5e0d), migration 0331 — the `assignment_status` pgEnum and the `assignment.status` column it
// typed are DROPPED. The reporter's rule set retired three of its five values (On Leave / Offboarding /
// Terminated) and made Employee Status non-editable, which left the column holding a value that (a) nothing
// displayed any more and (b) no caller was allowed to change — a permanently stale field that could only
// ever drift back into disagreeing with the screens. Employee Status now has exactly ONE definition:
// core/employment-status.ts (TypeScript) / core/employment-status-sql.ts (SQL). See the migration header
// for the before/after report and the retired-value mapping.
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
  // ADR-0077 slice 1 — the commercial columns (migration 0313 §5). Declared here with the rest of the
  // slice's tables so slice 9's suspension overlay can read `status` without a second schema edit, and
  // so anything that diffs this file against the database sees the columns that are actually there.
  // ai_hr_app holds SELECT only on this table (0313 revokes the rest): these are written by the
  // out-of-band runner and the platform plane, both on the owner connection.
  status: text('status').notNull().default('active'), // 'active' | 'trial' | 'suspended' | 'closed'
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  plan: text('plan'),
  primaryContactEmail: text('primary_contact_email'),
  notes: text('notes'),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  // ADR-0077 slice 9 (migration 0350) — CLOSURE, which is deliberately not just another status value.
  // Closure starts a retention clock that ends in destruction, so r105 refused to let dunning ever
  // reach it. These columns are the evidence that two DIFFERENT people agreed, and a DB CHECK
  // (tenant_closure_dual_control_check) makes single-person closure unrepresentable rather than merely
  // refused. See core/tenant-lifecycle.ts for the decision.
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closureRequestedBy: uuid('closure_requested_by'),
  closureRequestedAt: timestamp('closure_requested_at', { withTimezone: true }),
  closureApprovedBy: uuid('closure_approved_by'),
  closureApprovedAt: timestamp('closure_approved_at', { withTimezone: true }),
});

/**
 * ADR-0077 slice 9 (migration 0350) — one row per period a tenant spent out of good standing.
 *
 * THE INPUT REACTIVATION NEEDS. r108 pinned the asymmetry: accrual self-heals on the next ordinary run
 * (accrueEarned computes from service dates up to asOf), but both expiry sweeps compare a STORED DATE
 * to today — so a plain re-run after reinstatement forfeits everything whose date fell inside the
 * window, i.e. days the employee never had a chance to use. Reactivation pushes those expiries out by
 * exactly the frozen time, and can only do that because the frozen time is written down here.
 *
 * `resumedAt` NULL ⇒ suspended right now (an OPEN window), and a partial unique index allows only one
 * per tenant — two open windows would double-count the frozen days and hand back twice the leave.
 */
export const tenantSuspensionWindow = pgTable(
  'tenant_suspension_window',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    suspendedAt: date('suspended_at').notNull(),
    resumedAt: date('resumed_at'),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [index('tenant_suspension_window_tenant_idx').on(t.tenantId, t.suspendedAt)],
);
export type TenantSuspensionWindowRow = typeof tenantSuspensionWindow.$inferSelect;

// company = a legal entity WITHIN a tenant (multi-company lives here, not at the wall).
export const company = pgTable(
  'company',
  {
    id: id(),
    tenantId: tenantId(),
    legalName: text('legal_name').notNull(),
    country: text('country').notNull().default('MY'), // ISO-3166 alpha-2
    // ISO-4217. r79a (4fb8b75a step 3): this is now the company's ONE currency — Organization → General
    // owns it, and the Basic Salary form preselects it for a brand-new salary record (the job that
    // company_payroll_config.default_currency used to do before migration 0324 collapsed the pair).
    currency: text('currency').notNull().default('MYR'),
    /**
     * ADR-0080 D-14 (migration 0346) — 'statutory' | 'non_statutory', CHECK-constrained in the DB.
     * Never inferred from the country: a packless country makes a company non-statutory ONLY when
     * declared, so a mis-keyed ISO code cannot silently become a tier. See core/company-tier.ts.
     */
    statutoryTier: text('statutory_tier').notNull().default('statutory'),
    registrationNo: text('registration_no'),
    // Enhance Company General Tab (bc5d4891) — Company Information + Contact Information master data.
    // All nullable, additive, no backfill. `addressCountry` is display/correspondence only and must NOT be
    // confused with `country` above (ISO alpha-2, the holiday/statutory driver). `state` here is the postal
    // address state (reuses the profile_option 'state' catalog in the UI), distinct from defaultWorkState.
    companyLabel: text('company_label'), // short name / abbreviation / internal code
    industry: text('industry'),
    website: text('website'),
    businessType: text('business_type'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    addressLine3: text('address_line3'),
    city: text('city'),
    state: text('state'),
    addressCountry: text('address_country'),
    postcode: text('postcode'),
    phone: text('phone'),
    fax: text('fax'),
    // Wave 2 (ADR-0038 2B-1): when true, leave requests in this company route through a multi-step
    // approval chain (direct manager → HR) instead of a single approval. Per-company; 2B-2 makes the
    // chain itself configurable.
    leaveMultiApproval: boolean('leave_multi_approval').notNull().default(false),
    // Wave 2 (ADR-0040 2D-2): earned-accrual cycle — 'calendar' (1 Jan–31 Dec, default) or 'anniversary'
    // (each employee accrues relative to their hire-month anniversary). Only earned policies read it.
    leaveCycle: text('leave_cycle').notNull().default('calendar'),
    // Organization Module — Automatic Payroll Cycle Assignment (361e3b15, migration 0311). Each company's
    // DEFAULT payroll cycle, stored by NAME (mirrors leaveCycle: text notNull default). The column default
    // applies on EVERY creation path (admin form, provisionTenant, db/seed) with zero per-path wiring, so no
    // newly provisioned company is born without a default and every existing row reads 'Monthly'. Stored as a
    // name (not an id + FK) deliberately: no backfill, no delete/archive guard, and — the accepted trade-off,
    // identical to leaveCycle — renaming a live cycle won't auto-follow the saved name (the General-tab picker
    // surfaces an inline note + re-point when the saved name is no longer active).
    defaultPayrollCycle: text('default_payroll_cycle').notNull().default('Monthly'),
    // Wave 2 (ADR-0038 2C): the default state for employees with no explicit work_state — the holiday
    // fallback for this company.
    defaultWorkState: text('default_work_state'),
    // Feedback request 31474452: when true, leave taken on a "Half Day" work-schedule day (attendance_policy.
    // half_working_days) deducts a FULL 1.0 day instead of the default 0.5. Default false = byte-identical to
    // today for every existing customer until an admin both marks a day Half AND turns this on. Full working
    // days are never affected either way.
    leaveHalfDayFullDeduction: boolean('leave_half_day_full_deduction').notNull().default(false),
    // R51 722904dc/71b9143a — leave approval ESCALATION settings (migration 0287). When enabled, the nightly
    // review-sweep chases a leave approval step that has sat pending past `escalateAfterDays` WORKING days
    // with a bell notification to the configured target ('next_level' = the next approver in the chain,
    // default; 'specific_role' = a named LEVEL_KINDS role in escalationTargetRole — TEXT + CHECK, not a
    // pgEnum, the 0275 lesson). escalationUpdatedAt is a DEDICATED save stamp (never company.updated_at,
    // which moves on unrelated edits): requests whose waiting clock started before it are grandfathered so
    // flipping the switch on cannot fire a day-one burst. All nullable/defaulted — existing rows untouched.
    escalationEnabled: boolean('escalation_enabled').notNull().default(false),
    escalateAfterDays: integer('escalate_after_days'),
    escalationTarget: text('escalation_target').notNull().default('next_level'),
    escalationTargetRole: text('escalation_target_role'),
    escalationUpdatedAt: timestamp('escalation_updated_at', { withTimezone: true }),
    // r79a (4fb8b75a step 3) — two per-company HR defaults RELOCATED off company_payroll_config (migration
    // 0324), where they had nothing to do with payroll. Columns on `company` rather than a new table: the
    // 0287 escalation precedent and the leave_* siblings above (RLS + grant already in place).
    //   probationMonths     — default probation length for a FULL-TIME hire's provisional end date. NULL =
    //                         the code default of 3 (core/org.ts resolveProbationMonths). Read by the hire
    //                         path (app/admin/personnel/actions.ts), never by payroll. CHECK: NULL or > 0.
    //   reviewReminderDays  — days BEFORE an employment review's end date at which the nightly sweep nudges
    //                         manager + HR. NULL/empty = the code default [30,14,7]
    //                         (core/employment-review.ts resolveReminderDays). Stored sorted-desc, deduped.
    //                         CHECK: NULL or 1..10 offsets, each 1..365.
    probationMonths: integer('probation_months'),
    reviewReminderDays: integer('review_reminder_days').array(),
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
    check('company_escalation_target_check', sql`${t.escalationTarget} IN ('next_level', 'specific_role')`),
    // r79a (migration 0324) — the DB mirror of core/hiring-defaults.ts's cleaners.
    check('company_probation_months_check', sql`${t.probationMonths} IS NULL OR ${t.probationMonths} > 0`),
    check(
      'company_review_reminder_days_check',
      sql`${t.reviewReminderDays} IS NULL OR (array_length(${t.reviewReminderDays}, 1) BETWEEN 1 AND 10 AND 1 <= ALL (${t.reviewReminderDays}) AND 365 >= ALL (${t.reviewReminderDays}))`,
    ),
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

// person_photo = 1:1 profile photograph per person, bytea SIDE TABLE (mirrors company_logo). PNG/JPEG only
// (mime re-derived from magic bytes at upload; SVG excluded — scriptable). RLS (0164): read is scoped to
// app.can_see_person(person_id) — narrower than the logo's tenant-wide read because a face photo is
// personal data, not branding — and WRITE is admin-only. unique(person_id) enforces the 1:1 upsert.
export const personPhoto = pgTable(
  'person_photo',
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid('person_id')
      .notNull()
      .unique()
      .references(() => person.id),
    content: bytea('content').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('person_photo_person_idx').on(t.tenantId, t.personId)],
);

// location = company-scoped physical-site master data (ADR-0054). A thin overlay that names a site.
// ⚠️ IT NO LONGER DECIDES HOLIDAYS. Until ADR-0086 (r331) `state` was the top of the precedence
// (location.state ?? employment.work_state ?? company.default_work_state); the site left BOTH holiday
// readers in one commit and the chain now starts at employment.work_state. The column is kept — it is
// the record of which state a site was under before the move, and the register stopped offering the
// control rather than clearing the value. See the inline note on `state` below.
// `country` is captured for display only — the engine keeps using
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
    // ADR-0086: this WAS the top rung of the holiday-state precedence (`location.state` → holiday group →
    // employment.work_state → company.default_work_state → national). Nothing reads it any more — r331
    // removed the `location` join from both readers in core/holidays.ts. The column is KEPT rather than
    // dropped in the same migration: it is the record of what a site's state was, it is what the r328 carry
    // moved onto `employment.work_state`, and dropping it would force `cleanState` out of core/location.ts,
    // which test/state-vocabulary-scoping.test.ts pins for a different reason (the state vocabulary's
    // scoping). Retiring it is a separate, smaller decision than the one ADR-0086 makes.
    state: text('state'),
    // 1fff489c PHASE 2 — the Branch this location serves. NOT an FK: Branch is profile_option category
    // 'branch' (a tenant-wide flat catalogue, core/profile-options.ts) stored as text on
    // employment.org_branch, so this column stores the same text and core/location.ts validates it through
    // the same assertProfileValueAllowed() setEmploymentInfo uses. Null = not mapped yet, which is one of
    // the four distinct empty states. Uniqueness is PER COMPANY (see the index below and migration 0420).
    branch: text('branch'),
    // ADR-0086 (item 0fe1ca2e, r331) — `holiday_group_id` WAS here: ADR-0067 §(b)'s named holiday calendar
    // that every employee at this site followed. It is dropped by migration 0484. The work-site register
    // was retired on the reporter's say-so after being measured unused cross-tenant on production (8 sites,
    // NONE mapping a calendar; `holidays MOVE 0`), and neither holiday reader joins `location` any more.
    // Holiday calendars themselves are untouched (ADR-0067 §(a)): an employment still carries one directly
    // through `employment.holiday_group_id` below.
    //
    // ⚠️ THE TABLE ITSELF STAYS, deliberately. `clocking_location.location_id` (ADR-0070) is a live FK onto
    // it, `assignment.location_id` still records where somebody worked (core/movement.ts renders that
    // history), and `branch` below is a second live feature. Only the calendar door closed.
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('location_company_idx').on(t.tenantId, t.companyId),
    // Code unique per tenant among non-archived (mirrors shift_company_name_uq).
    uniqueIndex('location_code_uq').on(t.tenantId, t.code).where(sql`archived_at is null`),
    // 1fff489c — one location per branch PER COMPANY. Deliberately not per tenant: the branch catalogue is
    // tenant-wide but locations are company-scoped, so two companies mapping the same branch name to their
    // own location is the normal case here, not a conflict. See migration 0420.
    uniqueIndex('location_branch_uq')
      .on(t.tenantId, t.companyId, t.branch)
      .where(sql`archived_at is null and branch is not null`),
  ],
);

// clocking_location = SHARED, TENANT-LEVEL Clocking Location register (ADR-0070, amended f9afd1ce
// 2026-09-11 — migration 0459). A DELIBERATE second site registry alongside `location` above — see
// ADR-0070 §1 for why it is not an extension of `location` (hard-delete lifecycle, no code namespace,
// wider tenant-catalog RLS). NO OWNER COMPANY: one record per physical place, available to every
// company in the tenant, so a gate three companies share is set up once and its radius changed once.
// Lat/lng are typed numbers copied from Google Maps (a map picker is Phase 2, deferred). RLS: tenant-
// catalog read (every tenant member), GROUP-ADMIN write (app.is_group_admin() on INSERT/UPDATE/DELETE) —
// a shared record may be in use by companies an administrator does not manage. Assignment to an employee
// (employee_clocking_location below) stays with the admin of that employment.
export const clockingLocation = pgTable(
  'clocking_location',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    // 1fff489c PHASE 1 — the allowed distance, ON THE SITE. The radius already existed before this, but on
    // EMPLOYMENT (geofence_radius_m), i.e. one number per PERSON covering every site they clock at, which
    // cannot describe a 150 m office and a 500 m yard at once. Nullable in the DB (0 rows existed at the
    // time, so a NOT NULL would only be a deploy hazard); core/clocking-location.ts makes it REQUIRED on
    // every create/update, so nothing an admin can save leaves it blank. See migration 0419.
    radiusM: integer('radius_m'),
    // 1fff489c PHASE 1 — the explicit link to the `location` master record, replacing the loose habit of
    // retyping the site name. Several points may share one location (the reporter's "HQ — North Gate" /
    // "HQ — South Gate" compound), which is why the point keeps its OWN name and the location supplies
    // the code and group heading. f9afd1ce (0459): the link is now OPTIONAL and may point at a non-
    // archived location of ANY company in the tenant — `location` is company-scoped, and a site shared by
    // five companies cannot honestly be required to belong to one company's holiday-calendar record.
    locationId: uuid('location_id').references((): AnyPgColumn => location.id),
    address: text('address'),
    remarks: text('remarks'),
    // f9afd1ce rev 2 (r267, migration 0461) — the SHORT name the Attendance report's Clocking Location
    // column prints instead of the full site name. NULL means "print the name" (core/reporting.ts reads
    // coalesce(report_label, name) for that one column and nothing else does). The service stores NULL
    // for a blank label, so the rule lives where it is decided rather than in a CHECK.
    reportLabel: text('report_label'),
    // r423 (migration 0517) — the Malaysian state the site is in. DISPLAY AND FILTERING ONLY: it never
    // drives holidays (the company's own country/state does). Validated in core/clocking-location.ts against
    // the selected companies' countries (core/state-vocabulary validateStateFor), never by a CHECK.
    state: text('state'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('clocking_location_location_idx').on(t.tenantId, t.locationId),
    // f9afd1ce (0459) — one name per physical place PER TENANT (was per company). "One gate, one record".
    uniqueIndex('clocking_location_name_uq').on(t.tenantId, t.name),
    check('clocking_location_lat_range', sql`${t.lat} BETWEEN -90 AND 90`),
    check('clocking_location_lng_range', sql`${t.lng} BETWEEN -180 AND 180`),
    check('clocking_location_radius_m_ck', sql`${t.radiusM} IS NULL OR ${t.radiusM} > 0`),
  ],
);

// clocking_location_company = which COMPANIES may use a shared clocking location (r423, migration 0517,
// ADR-0070 amended). The location stays ONE record per physical place; this join is the list of companies
// whose employees may be given it. At least one per location (enforced by core/clocking-location.ts, not a
// trigger). RLS: INSERT/DELETE app.is_group_admin(); SELECT for group admins, the administrators of the
// company, and employees OF the company (their own Clock screen asks whether their site is open to them).
// ON DELETE CASCADE from the location: the rows are its own parts.
export const clockingLocationCompany = pgTable(
  'clocking_location_company',
  {
    id: id(),
    tenantId: tenantId(),
    clockingLocationId: uuid('clocking_location_id')
      .notNull()
      .references(() => clockingLocation.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('clocking_location_company_uq').on(t.clockingLocationId, t.companyId),
    index('clocking_location_company_company_idx').on(t.tenantId, t.companyId),
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

// employee_device = the browsers/devices an employee has registered for web clocking (feedback 5249d43f,
// migration 0301). The token is a server-minted random UUID handed back once at registration, stored
// client-side (localStorage) and presented with every web punch; enforcement is the per-company
// attendance_policy.require_registered_device switch (default OFF so nobody is locked out on ship).
// Registration is SELF-SERVICE (the subject employee inserts their own row); administrators revoke.
// Revocation is a soft mark (revoked_at) so the device history stays auditable next to its
// attendance.device.registered / .revoked events. RLS via can_see_employment (self / manager-up / admin —
// the attendance_punch per-person pattern, minus the payroll-partner branch).
export const employeeDevice = pgTable(
  'employee_device',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    label: text('label').notNull(),
    deviceToken: uuid('device_token').notNull(),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    index('employee_device_employment_idx').on(t.employmentId),
    uniqueIndex('employee_device_token_uq').on(t.deviceToken),
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
    // Per-user employee dashboard layout (feedback 7d9d145d): JSON array of block ids giving the
    // employee's preferred vertical section order; NULL = system default. Written only through the
    // SECURITY DEFINER app.dashboard_layout_* seam so a user can touch only their own row.
    dashboardLayout: jsonb('dashboard_layout'),
    // Per-user LIST preferences (feedback 579255c3, migration 0433): a namespaced envelope of per-screen
    // table settings — today `{ employeeList: { selected, order } }`, the Personnel listing's chosen
    // columns and their arrangement. NULL = the system default view. Written only through the SECURITY
    // DEFINER app.list_preferences_* seam so a user can touch only their own row, exactly like
    // dashboard_layout above. Namespaced rather than one bare column per screen: the next list that wants
    // remembered columns adds a key here, not a migration.
    listPreferences: jsonb('list_preferences'),
    // Login lifecycle (0279): non-null = this login is archived (switched off by an administrator) and
    // app.principal_by_subject refuses to resolve it. Reversible via Restore; permissions are untouched.
    // A leaver is blocked separately and LIVE off their employment end dates — see app.login_blocked.
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('app_user_tenant_idx').on(t.tenantId)],
);

// Deployment identities are private to SECURITY DEFINER functions; they do not duplicate HR membership.
export const appExternalIdentity = pgTable('app_external_identity', {
  issuer: text('issuer').notNull(), subject: text('subject').notNull(),
  appUserId: uuid('app_user_id').notNull().references(() => appUser.id),
  createdAt: createdAt(), revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, t => [primaryKey({ columns: [t.issuer, t.subject] }), index('app_external_identity_user_idx').on(t.appUserId)]);
export const appIdentitySession = pgTable('app_identity_session', {
  tokenHash: text('token_hash').primaryKey(), sealed: text('sealed').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), createdAt: createdAt(),
});

// Root-enrolled identity administration grants no HR role. The exact external binding remains authoritative.
export const deploymentIdentityOperator = pgTable('deployment_identity_operator', {
  issuer: text('issuer').notNull(), subject: text('subject').notNull(), testEmail: text('test_email').notNull(),
  createdAt: createdAt(), revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, t => [primaryKey({ columns: [t.issuer, t.subject] }), foreignKey({ columns: [t.issuer,t.subject], foreignColumns: [appExternalIdentity.issuer,appExternalIdentity.subject] })]);

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
    // 0312 — `role` is free TEXT here, so the DB is where the invitable set is pinned: everything in
    // the role enum EXCEPT the installation-tier `operator`, which is inserted by ai_hr_owner only
    // and never invited (0294). Declared here as well as in SQL so this file keeps matching the
    // database, the way role_assignment's check above does.
    check(
      'app_invitation_role_customer_set',
      sql`${t.role} IN ('employee', 'manager', 'hr_admin', 'super_admin', 'payroll_partner', 'performance_comp_partner')`,
    ),
    // 0312 — the table-level mirror of role_assignment_super_admin_group_wide. Without it an
    // invitation for a company-scoped super_admin was writable and simply un-consumable.
    check('app_invitation_super_admin_group_wide', sql`${t.role} <> 'super_admin' OR ${t.companyId} IS NULL`),
  ],
);

// ─────────────────────── Identity & Org (ADR-0003) ───────────────────────
// person = the global human identity within a tenant (holds PII).

export const person = pgTable(
  'person',
  {
    id: id(),
    tenantId: tenantId(),
    // fullName IS "Full name (as per IC/Passport)" — canonical on payslips / bank files / statutory docs
    // (notNull, never derived). first/last/preferred below are INDEPENDENT nullable name parts (b4682879).
    fullName: text('full_name').notNull(),
    primaryEmail: text('primary_email').notNull(), // login / work email (personalEmail is separate below)
    // bf953339 — `phone` IS the Mobile Phone Number (rename was label-only, no data movement); homePhone
    // is the optional residential line beside it on the Contact & Address card (migration 0304).
    phone: text('phone'),
    homePhone: text('home_phone'),
    // Low-risk personal fields the employee self-maintains on /me (ADR-0012).
    // NOTE: `address` is the LEGACY free-text home address — retained for rollback / PDPA history but NO
    // LONGER rendered or written by the UI (b4682879 backfilled it into addressLine1); use the structured
    // address columns below going forward.
    address: text('address'),
    dateOfBirth: date('date_of_birth'),
    // Wave 2 (ADR-0038 2A): self-declared; gate maternity (female) / paternity (married male) eligibility.
    gender: text('gender'), // 'male' | 'female' | 'undisclosed'
    // The master vocabulary is lib/person-vocabulary.ts MARITAL_STATUSES — 'single' | 'married' |
    // 'divorced' | 'widowed' | 'separated' | 'other'. (This comment used to list only the first two and
    // 'other': that was the pre-#12129e77 set and it had been wrong since divorced/widowed/separated were
    // added. Corrected by 72fca31d — do not restate the list anywhere else, import it.)
    maritalStatus: text('marital_status'),
    /**
     * 72fca31d (migration 0485) — THE LEAVE REQUEST THAT WROTE THE CURRENT `maritalStatus`, or NULL.
     *
     * Approving a Marriage Leave flips a Single employee to Married; cancelling or revoking that leave
     * puts it back. "That leave" has to be PROVABLE, not inferred, or a cancellation would overwrite a
     * value some human had since set by hand. So the cause is persisted here, and every OTHER writer of
     * `maritalStatus` NULLs it (core/profile.ts `setPersonComplianceFields` and `decideProfileChange` are
     * the only two; `hireEmployee` / the draft path go through the first). NULL therefore means "nobody
     * may revert this value automatically", which is the safe reading for every row that exists today.
     *
     * Written ONLY by the two SECURITY DEFINER functions migration 0485 installs — person's RLS WITH
     * CHECK is `is_admin() OR is_self_person(id)` and the approving line manager is neither.
     */
    maritalStatusSourceRequestId: uuid('marital_status_source_request_id'),
    // 23ad620e — emergency_contact_name / _phone USED to live here. They are GONE (migration 0322): an
    // emergency contact is now a row in `personEmergencyContact` below, because a person may have several.
    // ── b4682879 Personnel Profile redesign — all NULLABLE, additive, HR-maintained ──
    // Name parts (independent of fullName; display fallback stays fullName).
    firstName: text('first_name'),
    lastName: text('last_name'),
    preferredName: text('preferred_name'), // known / preferred name
    // 8c284478 — Salutation (Mr / Dr / Dato' …), shown BEFORE Full Name on the Personal Details card.
    // Catalog-backed dropdown (profile_option category 'salutation', migration 0300) but stored as free
    // text with the same legacy-value tolerance as religion/race. Nullable — existing records stay blank.
    salutation: text('salutation'),
    // PDPA 2010 s.40 sensitive demographics (religion / race). Row-visible to the same readers as the rest
    // of the person row; erasable immediately via core/pdpa.ts (never statutory-locked).
    religion: text('religion'),
    race: text('race'),
    nationality: text('nationality'), // free text — analytics epfCitizenship is a payroll proxy, not this
    // Contact & structured home address (personalEmail ⊥ primaryEmail).
    personalEmail: text('personal_email'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    addressLine3: text('address_line3'),
    postcode: text('postcode'),
    city: text('city'),
    state: text('state'),
    country: text('country'),
    // ── 3a25f5ee Contact & Address split — Permanent + Correspondence addresses (migration 0213) ──
    // All NULLABLE, additive. The legacy addressLine1..country above is RETAINED for rollback/PDPA history
    // and was backfilled into the PERMANENT block (product decision: today's single address = Permanent).
    // The Contact & Address form now writes ONLY these permanent_* / correspondence_* columns.
    permanentAddressLine1: text('permanent_address_line1'),
    permanentAddressLine2: text('permanent_address_line2'),
    permanentAddressLine3: text('permanent_address_line3'),
    permanentPostcode: text('permanent_postcode'),
    permanentCity: text('permanent_city'),
    permanentState: text('permanent_state'),
    permanentCountry: text('permanent_country'),
    correspondenceAddressLine1: text('correspondence_address_line1'),
    correspondenceAddressLine2: text('correspondence_address_line2'),
    correspondenceAddressLine3: text('correspondence_address_line3'),
    correspondencePostcode: text('correspondence_postcode'),
    correspondenceCity: text('correspondence_city'),
    correspondenceState: text('correspondence_state'),
    correspondenceCountry: text('correspondence_country'),
    // bf953339 — the Correspondence block's OWN phone pair (migration 0304): an employee's correspondence
    // contact may differ from the main mobile/home pair above. Both nullable, optional.
    correspondenceMobilePhone: text('correspondence_mobile_phone'),
    correspondenceHomePhone: text('correspondence_home_phone'),
    // 23ad620e — emergency_contact_relationship / _phone2 / _address USED to live here too. Dropped by
    // migration 0322 along with the two above; `personEmergencyContact` is the single home now. Nothing may
    // re-add them: a second writable home for the same fact is the defect this feature exists to remove.
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
    // System Labels UI redesign (797e3523, migration 0181): optional short code / abbreviation shown in
    // the System Labels grid to help identify a record. Nullable; NULL = no short code.
    label: text('label'),
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
    // System Labels UI redesign (797e3523, migration 0181): optional short code / abbreviation (nullable).
    label: text('label'),
    // System Labels (migration 0145): optional admin note (nullable). System Labels CRUD screen only.
    description: text('description'),
    // Approval vocabulary (6fadb036, migration 0164): the business-unit head — the employment a
    // `business_unit_head` approval step routes to. Nullable; a head step is dropped at generation when unset.
    headEmploymentId: uuid('head_employment_id').references((): AnyPgColumn => employment.id, { onDelete: 'set null' }),
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
    // System Labels UI redesign (797e3523, migration 0181): optional short code / abbreviation (nullable).
    label: text('label'),
    // System Labels (migration 0145): optional admin note (nullable). System Labels CRUD screen only.
    description: text('description'),
    // Approval vocabulary (6fadb036, migration 0164): the department head — the employment a
    // `department_head` approval step routes to. Nullable; a head step is dropped at generation when unset.
    headEmploymentId: uuid('head_employment_id').references((): AnyPgColumn => employment.id, { onDelete: 'set null' }),
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
    // System Labels UI redesign (797e3523, migration 0181): optional short code / abbreviation (nullable).
    label: text('label'),
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

// r430 (board item b8ca6efe, migration 0520) — per-employee Web Clocking photo requirement. Default
// 'not_required' for every employee (today's behaviour — a photo was always mandatory — changes only once
// HR sets this per person). Declared HERE, ahead of `employment`, because it is referenced as that table's
// column type below (a later `const` would be a temporal-dead-zone error at module load). See
// core/attendance-clock.ts captureEmployeeClockTx, which enforces it SERVER-SIDE.
export const attendancePhotoSettingEnum = pgEnum('attendance_photo_setting', ['required', 'optional', 'not_required']);

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
    /** 44bc1c33 (0474) — the Card / Clocking ID a physical attendance device records for this employee,
     *  when it differs from `employeeCode`. NULL means "match this employee on employee_code / ic", which
     *  is what every employment did before this column existed and what most still do.
     *
     *  TEXT, never numeric: card numbers carry leading zeros and '007' is not '7'.
     *
     *  NEVER holds a DERIVED copy of `employeeCode`. When a company turns on "Card ID is the same as
     *  Employee ID" the value is resolved at read time (core/attendance-card.ts) — copying it here would
     *  need a sync rule on every employee-code rename, which is the drift the setting exists to avoid. */
    cardId: text('card_id'),
    // "Group Join Date" (UI label) — the employee's FIRST day anywhere in the group. NOT NULL and the durable
    // anchor for every downstream calculation (leave entitlement service bands, payroll proration, EA forms,
    // imports). Deliberately NOT renamed from hired_on (~50 readers + the import contract depend on the name);
    // the Employment tab relabels it "Group Join Date" (feedback 24c4d02e).
    hiredOn: date('hired_on').notNull(),
    // "Join Date" (feedback 24c4d02e, migration 0212) — the effective joining date for the CURRENT company /
    // legal entity / assignment. Nullable: null = not captured yet, in which case current-company service
    // length falls back to hired_on (the group date). Changes on internal/company transfers (auto-sync is a
    // documented v1 follow-up); hired_on stays fixed. Leave entitlement bands stay on hired_on (group seniority).
    joinDate: date('join_date'),
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
    // Contract Employment Information (8590615a, migration 0388). These two and `contractEndDate` above are
    // ONE group, maintained together in the Contract Information block on the Personnel Employment tab,
    // which renders only when the CURRENT open assignment's employment_type is 'contract'. contract_end_date
    // is the PRE-EXISTING column (0110) — the block writes that same column deliberately, so the employment
    // review workflow keeps watching the one value HR maintains instead of a second copy of it. Both new
    // columns are nullable with no backfill: null start means HR has not confirmed a start date yet (the
    // screen pre-fills the Group Join Date as a display default and writes only on save). contract_remark is
    // free text and deliberately NOT catalog-validated (see EMPLOYMENT_INFO_FIELD_CATEGORY in core/org.ts).
    contractStartDate: date('contract_start_date'),
    contractRemark: text('contract_remark'),
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
    // 870b79e2 (r277, migration 0464) — THE SCHEDULE GROUP. The named, tenant-wide attendance_rule this
    // employment belongs to: the object the rail now calls "Schedule Group" and the reporter's
    // Employee → Group → Shift chain. Third of the same family as the two columns above (holiday_group_id,
    // payroll_policy_id): a reusable named template selected per employment, nullable, ON DELETE SET NULL
    // so deleting a group never errors an FK — the employee simply falls back to the shift's own rule.
    //
    // NULLABLE WITH NO BACKFILL AND NO DEFAULT, AND THAT IS THE RELEASE-DAY PROMISE. Rule resolution
    // (core/attendance.ts scheduleFor) becomes ADDITIVE: this column, else shift.rule_id, else the
    // tenant's is_default rule — so with every row NULL, which is what ships, every employee resolves the
    // rule they resolve today, byte for byte. test/attendance-rule-group-resolution.test.ts pins that.
    //
    // ⚠️ THIS IS ALSO THE ALLOWED-SHIFT LIST, READ SIDEWAYS. The shifts a group permits are exactly the
    // shifts whose `rule_id` is this rule; core/roster.ts assertShiftAllowedForEmployment refuses an
    // assignment outside that set. There is deliberately NO junction table and NO second column: one shift
    // points at one rule, which is what keeps `ruleFor` single-valued.
    attendanceRuleId: uuid('attendance_rule_id').references((): AnyPgColumn => attendanceRule.id, {
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
    // R17 3e8350db — the reporter's "Shift Type" field. 'fixed' = the person follows their profile Default
    // shift (default_shift_id) every working day; 'roster' = no permanent shift on the profile, scheduled
    // purely from /roster. The invariant (enforced in core/roster.ts assignEmployeeShift): fixed ⇒
    // default_shift_id is set, roster ⇒ default_shift_id is null. Backfilled from default_shift_id in
    // migration 0162; default 'roster' == today's "no default shift" behaviour. CHECK in ('fixed','roster').
    shiftType: text('shift_type').$type<'fixed' | 'roster'>().notNull().default('roster'),
    terminatedOn: date('terminated_on'),
    // Termination classification (Wave 4A). Captured at termination for turnover analytics.
    terminationType: terminationTypeEnum('termination_type'),
    terminationReason: text('termination_reason'),
    // ae9350f2 (migration 0338) — the Termination movement's structured exit fields.
    // `terminationReasonCode` is the coded exit reason from the built-in catalogue in
    // core/termination-reason.ts. Deliberately TEXT, not a second enum: a new enum value cannot be used in
    // the transaction that adds it, and item 476f23ed will own this list. The code DERIVES terminationType
    // above, so the coded reason and the turnover classification can never contradict each other.
    terminationReasonCode: text('termination_reason_code'),
    // Notice ACTUALLY served on this exit. The resignationNotice* / noticeAfterConfirmation* columns below
    // are the contractual POLICY (what the contract requires); this is what happened.
    terminationNoticeDays: integer('termination_notice_days'),
    // Inter-company cost split for shared-services staff (ADR-0009): [{ companyId, percent }].
    costAllocation: jsonb('cost_allocation'),
    // Clocking Location & Geofencing (ADR-0070): per-employee enforcement toggle + radius. Mirrors the
    // payroll_policy_id precedent of per-employee config living on employment columns.
    // 1fff489c — geofenceRadiusM is now an OPTIONAL PER-EMPLOYEE OVERRIDE, not the only radius. The
    // authoritative distance lives on clocking_location.radius_m (one per site); this column, when set,
    // replaces it for THIS employee at EVERY site. Null while enabled is valid and means "use each site's
    // own radius" — which is why the old employment_geofence_radius_required CHECK is gone (0419).
    // r423 (0517) — geofencingEnabled is the employee's ONE switch, "Use Geofencing for Clocking": ON =
    // every clocking is compared with an assigned, active location open to the employee's company; OFF =
    // the position is recorded and not compared. The override below is RETIRED: kept (nothing destroyed),
    // no longer read or written — each site's own radius is the only radius.
    geofencingEnabled: boolean('geofencing_enabled').notNull().default(false),
    geofenceRadiusM: integer('geofence_radius_m'),
    // r430 (board item b8ca6efe, migration 0520) — Web Clocking's per-employee Attendance Photo setting:
    // required (a photo must be taken or the clocking is refused), optional (the employee may take one or
    // skip it), or not_required (no camera step at all). Every employee starts on not_required — today's
    // photo-always-mandatory behaviour changes only once HR turns this on for a person, same shape as
    // geofencingEnabled above. Enforced SERVER-SIDE in core/attendance-clock.ts captureEmployeeClockTx —
    // never trust the client's own idea of this setting.
    attendancePhotoSetting: attendancePhotoSettingEnum('attendance_photo_setting').notNull().default('not_required'),
    // Employment Information enhancement (2323f671, migration 0181): employment master-data captured on the
    // Employment tab's new Employment Information card. All NULLABLE and additive — an existing employment
    // with every column NULL behaves exactly as before (field-capture only; business rules follow in a
    // later CR). Dates are validated (confirmation ≥ hire, resignation ≥ hire) and periods are non-negative
    // in core/org.ts::setEmploymentInfo; the DB stays permissive so backfills/imports never trip a CHECK.
    probationMonths: integer('probation_months'),
    probationDays: integer('probation_days'),
    confirmationDate: date('confirmation_date'),
    resignationNoticeMonths: integer('resignation_notice_months'),
    resignationNoticeDays: integer('resignation_notice_days'),
    // Manual/administrative resignation date. The self-service resignation workflow (ADR-0042) owns the
    // lifecycle end date; this column is an audited HR override for master-data capture and does not drive
    // that workflow. Nullable.
    resignationDate: date('resignation_date'),
    shortNoticeMonths: integer('short_notice_months'),
    shortNoticeDays: integer('short_notice_days'),
    // Enhance Employment Dates Management (955c7de4, migration 0213). The Employment Dates card was redesigned
    // to show an explicit UNIT per period and to capture the full lifecycle. Each period is now a value + unit
    // pair (unit ∈ 'month'|'week'|'day', validated in core/org.ts::setEmploymentInfo). All NULLABLE + additive.
    // The legacy probation/notice month+day columns above are KEPT untouched (they still drive the offer-letter
    // probation-end calc); the read layer falls back legacy→new for display continuity. Wiring these into
    // payroll final-pay / attendance cutoff / auto career-movement is a documented v1 follow-up.
    probationValue: integer('probation_value'),
    probationUnit: text('probation_unit').$type<'month' | 'week' | 'day'>(),
    extendedProbationValue: integer('extended_probation_value'),
    extendedProbationUnit: text('extended_probation_unit').$type<'month' | 'week' | 'day'>(),
    noticeBeforeConfirmationValue: integer('notice_before_confirmation_value'),
    noticeBeforeConfirmationUnit: text('notice_before_confirmation_unit').$type<'month' | 'week' | 'day'>(),
    noticeAfterConfirmationValue: integer('notice_after_confirmation_value'),
    noticeAfterConfirmationUnit: text('notice_after_confirmation_unit').$type<'month' | 'week' | 'day'>(),
    // Confirmation extended after a probation extension. finalConfirmationDate is DERIVED (= extended ?? normal)
    // and recomputed + audited on every setEmploymentInfo save so it is always consistent.
    extendedConfirmationDate: date('extended_confirmation_date'),
    finalConfirmationDate: date('final_confirmation_date'),
    // Resignation lifecycle: the date the employee TENDERS the resignation vs the effective resignation date
    // (resignationDate above) vs their final physical working day. Capture-only in v1.
    tenderResignationDate: date('tender_resignation_date'),
    lastWorkingDate: date('last_working_date'),
    // Organisation dimensions beyond the effective-dated department/position (which live on `assignment`).
    // Free-text in v1 — a follow-up CR introduces master tables + validated dropdowns. Nullable text.
    orgBranch: text('org_branch'),
    orgDivision: text('org_division'),
    orgRegion: text('org_region'),
    orgLine: text('org_line'),
    orgSection: text('org_section'),
    orgTeam: text('org_team'),
    orgBase: text('org_base'),
    // Employee category (e.g. Management / Executive / Non-executive). Free-text in v1. Nullable.
    employmentCategory: text('employment_category'),
    // Employee Status redesign (R43 c26c3ce5, migration 0240). Employee Status is now SYSTEM-DERIVED read-time
    // from the lifecycle dates (see core/employment-status.ts::deriveEmploymentStatus) — it is no longer a
    // manual field. Blacklist is the ONE genuine stored override: an event-driven (not date-driven) exception
    // status set by authorised HR via setEmploymentBlacklist. `blacklistedAt` non-null ⇒ the deriver returns
    // 'blacklisted' (highest priority). Nullable; null = not blacklisted (every existing row). `blacklistReason`
    // is an optional free-text note captured with the action.
    blacklistedAt: date('blacklisted_at'),
    blacklistReason: text('blacklist_reason'),
    // R46 79eb7151 (migration 0270) — HOW this employee is paid: bank transfer, cheque or cash. Genuinely
    // new per-employee data; before this the only payment settings were COMPANY-level (disbursement_bank /
    // company_bank_profile = which corporate account emits the bulk file) plus the employee's own bank name
    // and account number on employee_statutory_my. Nullable = not specified (every pre-existing row).
    //
    // SUPERSEDED (ADR-0078 / migration 0290): the paragraph below recorded the R46 79eb7151 decision that
    // Pay Mode and Payment Term must stay policy-owned. That decision is reversed — they now live as
    // effective-dated columns on `compensation` (pay_mode / payment_term / rate_amount), NOT NULL with no
    // policy fallback, so there is still exactly ONE source of truth per period and no precedence rule.
    // The original reasoning is kept for the audit trail:
    //   Pay Mode ≡ payroll_policy.policy_type and Payment Term ≡ PayrollPolicyConfig.frequency. Those
    //   are resolved from the assigned policy (resolveAssignedPolicy) and only SURFACED read-only on the
    //   Payroll tab — duplicating them per-employee would give the kernel two disagreeing sources of truth
    //   for the same input and require a precedence rule. See ADR-0064.
    //
    // INVARIANT (enforced in setEmploymentPaymentMethod, not by the DB — the bank details live on a
    // different, person-keyed table): 'bank_transfer' requires a bank name AND an account number on the
    // person's employee_statutory_my row.
    paymentMethod: paymentMethodEnum('payment_method'),
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
    // 1fff489c — `employment_geofence_radius_required` was DROPPED here (migration 0419). It forced a
    // positive radius while geofencing was enabled, which was right when the employment radius was the
    // ONLY radius. It is now an optional per-employee OVERRIDE of the site's own radius_m, so "enabled
    // with a blank override" is a valid, and in fact the expected, state. Safe to drop: 0 production rows
    // had geofencing enabled. The remaining guard is `geofence_radius_m > 0` when a value IS supplied,
    // enforced in core/clocking-location.ts setGeofencing.
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
    // Personnel Organisation Assignment enhancement (1001ff61, migration 0219): the employee's Business Unit
    // on this dated assignment version. Nullable — an assignment with no BU behaves exactly as before. Sourced
    // from the company-scoped business_unit master (the same catalog department.business_unit_id points at).
    businessUnitId: uuid('business_unit_id').references(() => businessUnit.id),
    costCenterId: uuid('cost_center_id').references(() => costCenter.id),
    // Location master data (ADR-0054): the physical site this employee works at on this assignment
    // version. Nullable — the entire employee↔location link, reusing assignment's CLOSE+INSERT history
    // (no second bitemporal table). Null ⇒ location-blind = today's behaviour. The location's optional
    // `state` overrides holiday resolution; see location table + core/attendance.ts.
    locationId: uuid('location_id').references((): AnyPgColumn => location.id),
    // 3c88d593 (migration 0440) — THE LEGAL ENTITY, effective-dated at last.
    //
    // `employment.company_id` is a single mutable value with no history: an Entity Transfer overwrote it
    // and left no record of the company the employee belonged to before, so payroll (and attendance, and
    // leave, and reporting) had nothing to look up for a date before the move. Every other placement
    // dimension on this row is already effective-dated; company was the one that was not, and the fault
    // the reporter raised — a whole August paid under the destination entity for an 11 August transfer —
    // is that single gap and nothing else.
    //
    // NULLABLE, AND THAT IS LOAD-BEARING. Rows written before the backfill hold NULL, and the resolver
    // (core/employment-company.ts) reads NULL as "no history here — fall back to employment.company_id",
    // which is exactly today's behaviour. So the column can ship before the backfill runs, and a tenant
    // whose backfill has not run yet computes byte-identical payroll.
    //
    // NOT a same-company constraint against department/position/location: those are validated against
    // `employment.company_id` by their own writers at write time, and this column records what WAS true
    // on a past range, which a today-check must never re-litigate.
    companyId: uuid('company_id').references(() => company.id),
    employmentType: employmentTypeEnum('employment_type').notNull(),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'), // null = open / current
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }), // null = current record
    createdAt: createdAt(),
  },
  (t) => [
    index('assignment_employment_idx').on(t.employmentId, t.validFrom),
    // The company-for-date resolver's access path: "which employments were in company X on/over range R".
    index('assignment_company_idx').on(t.companyId, t.validFrom),
  ],
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
    // R44 delegation (Phase 2): free-text reason for a `delegate` edge (why the hand-over). Nullable —
    // legacy rows + all structural line types keep NULL; the UI requires it only for new delegations.
    reason: text('reason'),
    // R51 (baf56348, migration 0286): ORG COVERAGE of a `delegate` edge — company → business unit →
    // department, each nullable. All three NULL = unrestricted (every legacy row). A single 0..1 selection,
    // so it widens reporting_line instead of reusing the 0..N reporting_line_scope child table (0230).
    // Enforced in app.can_decide_via_delegation / _from (org gate); structural line types keep NULL.
    scopeCompanyId: uuid('scope_company_id').references(() => company.id),
    scopeBusinessUnitId: uuid('scope_business_unit_id').references(() => businessUnit.id),
    scopeDepartmentId: uuid('scope_department_id').references(() => department.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('reporting_line_sub_idx').on(t.subordinateEmploymentId),
    index('reporting_line_mgr_idx').on(t.managerEmploymentId),
  ],
);

// R44 delegation (Phase 2): per-module / per-task scope for a `delegate` edge. ZERO scope rows for a
// delegation = "all approvals" (back-compat with every existing whole-scope row). A row with taskType NULL
// scopes the WHOLE module; a row with a taskType scopes just that approval task. Enforcement lives in
// app.can_decide_via_delegation (module,taskType overload) + core/approvals.ts assertCanDecide.
export const reportingLineScope = pgTable(
  'reporting_line_scope',
  {
    id: id(),
    tenantId: tenantId(),
    reportingLineId: uuid('reporting_line_id')
      .notNull()
      .references(() => reportingLine.id, { onDelete: 'cascade' }),
    module: text('module').notNull(), // bounded context: 'leave' | 'attendance' | 'claims'
    taskType: text('task_type'), // null = whole module; else a specific approval task
    createdAt: createdAt(),
  },
  (t) => [index('reporting_line_scope_line_idx').on(t.reportingLineId)],
);

// ──────────────────────────── Leave ────────────────────────────
// Slice 0 ships Annual only. Balance = signed sum of leave_ledger entries.

/**
 * 65f466e2 — the closed set of `leave_type.role` values, mirrored from core/leave.ts's LEAVE_TYPE_ROLES.
 *
 * Declared here as a literal rather than imported because this file deliberately imports nothing from
 * `core/`. The two definitions are pinned to each other by test/leave-type-role.test.ts, the same way
 * OPERATOR_REPORTER_LABEL is pinned against the string its migration hardcodes — so they cannot drift
 * silently. The database enforces the same set (leave_type_role_check in migration 0387, widened by 0485).
 *
 * 72fca31d added 'marriage' (migration 0485): three rules had to be scoped to Marriage Leave and nothing
 * could name it — the pack seeds no MARRIAGE row at all, production's is coded `MRL`, and a code
 * comparison would therefore have been dead on arrival exactly as 65f466e2's were.
 *
 * KEEP THE UNION ITSELF COMPACT: test/leave-type-role.test.ts reads the first 400 characters after
 * `export type LeaveTypeRoleValue` to compare it against core's list, so a comment BETWEEN the members
 * would push the last one out of view and the guard would stop guarding.
 */
export type LeaveTypeRoleValue =
  | 'annual'
  | 'sick'
  | 'hospitalization'
  | 'maternity'
  | 'paternity'
  | 'emergency'
  | 'replacement'
  | 'marriage';

export const leaveType = pgTable('leave_type', {
  id: id(),
  tenantId: tenantId(),
  code: text('code').notNull(), // e.g. 'ANNUAL'
  // ADR-0077 slice 5 (migration 0344) — which country pack owns this row. The codes above are GENERIC
  // ('ANNUAL', 'SICK'), so with a second pack installed two countries legitimately want the same code for
  // the same tenant. Uniqueness is therefore (tenant_id, country, lower(code)) WHERE archived_at IS NULL,
  // declared in 0344 as raw SQL — like 0031's index before it, this table has no Drizzle index callback.
  //
  // The 'MY' default is a backfill convenience, and the index is what keeps it honest: a second-country
  // seeder that omits `country` does not quietly write an MY row, it COLLIDES with the existing MY row and
  // the insert fails. Loud on the first attempt. Set it explicitly in new code anyway.
  country: text('country').notNull().default('MY'),
  name: text('name').notNull(),
  // Leave Type master page (feedback 097de541): optional free-text description shown to HR admins in the
  // master listing + the identity edit form. Nullable (existing rows ⇒ NULL ⇒ rendered "—"). No enforcement.
  description: text('description'),
  paid: boolean('paid').notNull().default(true),
  // 'working_days' (exclude weekends + holidays) | 'calendar_days' (consecutive)
  counting: text('counting').notNull().default('calendar_days'),
  // Wave 2 (ADR-0038 2A): lawful eligibility gate — { gender?, maritalStatus?, minServiceMonths? }. null =
  // open to all. Enforced at requestLeave; mirrors only what the Act restricts (e.g. maternity is female-
  // only by EA s.37), so it never blocks a statutory entitlement.
  eligibility: jsonb('eligibility'),
  // Probation eligibility (d6bdbd55, migration 0225): a per-type probation gate alongside the jsonb
  // eligibility above. NULL = no restriction (every existing row); 'confirmed_only' = only employees past
  // probation may apply; 'probation_only' = only employees still on probation may apply. Merged into the
  // LeaveEligibility object at the enforcement chokepoints (assertEligible) so it rides the same gate as
  // gender/marital/min-service. A DB CHECK constrains it to the closed 2-value set (defence-in-depth).
  probationEligibility: text('probation_eligibility'),
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
  // point below — no second column). The UNIT this figure is counted in is min_advance_day_type below
  // (7daac043 / migration 0447) — calendar days unless an administrator says otherwise.
  minAdvanceDays: integer('min_advance_days'),
  // Advance Notice — calendar days or working days (feedback 7daac043, migration 0447): the UNIT the
  // requirement above is read in.
  //
  //   NULL / 'calendar_days' — every day on the wall calendar, weekends, rest days and public holidays
  //     included. NULL is the reading every existing row takes, so no backfill exists and nothing an
  //     administrator has not deliberately changed behaves differently.
  //   'working_days' — only the days the employee is actually rostered to work, resolved from the SAME
  //     attendance_policy.working_days roster and the SAME holiday resolution the rest of leave uses.
  //     "7" then stretches roughly two days further out once a weekend falls inside it, which is exactly
  //     why the reporter asked to choose — the same reason max_consecutive_unit below offers the pair.
  //
  // TEXT + CHECK, not a pgEnum (the 0338 lesson — a new enum value cannot be used in the transaction that
  // adds it); max_consecutive_unit below is the precedent this copies. Given its reading in exactly one
  // function, resolveAdvanceNoticeDayType() in core/leave.ts, which falls back to calendar days for
  // anything it does not recognise. It rides minAdvanceDays' tri-state marker rather than carrying its
  // own: clearing the requirement clears the unit it was read in (a unit with no figure is inert
  // configuration that looks set).
  minAdvanceDayType: text('min_advance_day_type'), // 'calendar_days' | 'working_days' (null ⇒ calendar days)
  // REMOVED by c459bff9 (migration 0370): `expiry_value` / `expiry_unit`, the age-from-earning expiry pair
  // added by fec49317 (migration 0155), together with 0155's three CHECK constraints and the expireAgedLeave
  // sweep that read them. An intentional RESET, not a feature deletion — a new expiry framework is designed
  // separately (6e9a126e) and inherits a clean slate rather than a legacy column pair. ANNUAL's carry-forward
  // expiry (carry_forward_expiry_* / expireCarriedLeave) is a DIFFERENT clock over a DIFFERENT population
  // (the leftover carried across a year end, counted from year end, not the age of an earned day) and is
  // UNTOUCHED. Ledger rows already stamped AGED_FORFEIT_REASON ('sys:leave_type_expiry') are KEPT and still
  // read — see the constant's comment in core/leave.ts for why it must not be deleted.
  // Custom validation messages (custom-messages migration): admin-authored override text shown to the
  // employee when a leave-validation rule blocks their request, keyed by the same camelCase field name as
  // the rule's config column (e.g. { backdatingLimitDays: "…" }). null/absent key ⇒ show the built-in
  // localized default. JSONB extension point per CLAUDE.md: future validation rules add their own key
  // here with no migration. IMPORTANT for future writers: this is ONE shared column across all rule keys —
  // any writer MUST read-then-patch-then-write within the same transaction (see core/admin.ts
  // updateLeaveType), or it will silently clobber other rules' messages (last-writer-wins). The 500-char
  // cap per message is enforced in the service, not the DB.
  customMessages: jsonb('custom_messages').$type<Record<string, string>>(),
  // Employee Leave View Configuration (feedback 65dec703 / dup 1fedb473): per-leave-type map of which
  // entitlement/breakdown components an employee may see in self-service (My Profile → Leave tab). Keyed by
  // the closed camelCase allow-list ESS_VIEW_COMPONENT_KEYS (core/ess-view.ts); value true ⇒ visible,
  // false ⇒ hidden in ESS. A MISSING key (or a null column) ⇒ VISIBLE — so null (every existing row)
  // reproduces today's exact behaviour (all components shown). Gating applies ONLY to the /me ESS surface;
  // admin/HR always see everything (applyEssConfig flag on the shared EntitlementBreakdown component). HR
  // edits it from the "Employee Leave View" sub-form inside the per-type panel (updateLeaveType, own
  // touchEssViewConfig tri-state). JSONB extension point: new component keys ship with no migration, but a
  // writer MUST validate against the closed allow-list (unknown keys are rejected in updateLeaveType).
  essViewConfig: jsonb('ess_view_config').$type<Record<string, boolean>>(),
  // Leave Eligibility Rules — Day Type Inclusion Configuration (feedback ef6d7146): a per-type vector of
  // five INDEPENDENT booleans deciding whether each day type is COUNTED when calculating a leave's duration.
  // Keyed by the closed camelCase allow-list { offDay, restDay, publicHoliday, companyHoliday, shutdownDay }
  // (core/leave.ts DAY_TYPE_INCLUSION_KEYS). true ⇒ that day type is deducted inside a leave span; false ⇒
  // skipped. REFINES leave_type.counting: for a working_days type the vector selectively RE-INCLUDES day
  // types that would otherwise be skipped (e.g. count public holidays but still skip weekends). NULLABLE +
  // all-false ≡ today's exact counting behaviour — a null column (every existing row) OR an all-false vector
  // takes the byte-identical legacy counting path; the inclusion-aware kernel branch engages only when the
  // vector is non-null with ≥1 true flag (core/leave.ts normalizeDayTypeInclusion + dayWeight). Phase A:
  // offDay/restDay are collapsed to the "non-working weekday" bucket and companyHoliday/shutdownDay are
  // STORED-but-inert (their resolver + the shutdown concept are Phase B); restDay/offDay + publicHoliday are
  // live. Written from the "Day Type Inclusion" sub-form inside the per-type panel (updateLeaveType, own
  // touchDayTypeInclusion tri-state).
  dayTypeInclusion: jsonb('day_type_inclusion').$type<Record<string, boolean>>(),
  // Leave Type Visual Configuration Enhancement (feedback 639fdf77): two additive, nullable, DISPLAY-ONLY
  // columns letting HR attach an icon + colour theme to each leave type, surfaced only on the employee
  // self-service My Profile → Leave tab (icon beside the name + colour chip on the row). NEVER read for
  // entitlement / eligibility / workflow / calculation — purely cosmetic, so both null (every existing row)
  // reproduces today's exact ESS appearance.
  //   color — one of the fixed 7-token palette {blue,green,orange,purple,red,teal,grey} (lib/leave-visual.ts
  //     LEAVE_COLOR_TOKENS; a DB CHECK backs the service validation). null ⇒ system default styling.
  //   icon — a curated icon-registry key (lib/leave-visual.ts LEAVE_ICON_KEYS; validated in the service, no
  //     DB CHECK so the registry can grow without a migration). null ⇒ default leave icon.
  color: text('color'),
  icon: text('icon'),
  // Leave Unit Configuration (feedback e4980382): whether this leave type is MANAGED and applied in whole
  // Days or in Hours. 'day' | 'hour', NOT NULL DEFAULT 'day' (a DB CHECK backs the service validation). Shown
  // beside the "Paid Leave" setting on the Leave Type Setup screen. This is a coarse labelling/reporting
  // setting — it deliberately does NOT drive entitlement, accrual, workflow, or payroll logic (the reporter's
  // stated scope). The finer per-request fraction model already lives on `durations` (full_day / half_day /
  // hourly) and continues to drive deduction math; wiring leave_unit into apply/approve is a future item.
  // DEFAULT 'day' ⇒ every existing row reads Day (backward compatible, no backfill).
  leaveUnit: text('leave_unit').notNull().default('day'),
  // Leave Year Type override (feedback e1a51aea, migration 0303; 'a2c' enabled by 18e15fc1 / migration
  // 0310): an OPTIONAL per-type override of the company leave cycle (company.leave_cycle, ADR-0040 2D-2),
  // set from the General step's "Leave Year Type" sub-step. NULL (every existing row) = follow the company
  // cycle exactly as today. All three values are LIVE:
  //   'a2a' — Anniversary to Anniversary: this type runs on the hire-month anniversary cycle (the existing
  //           'anniversary' semantics) even when the company cycle is calendar.
  //   'c2c' — Calendar to Calendar: this type runs on the calendar year (the existing 'calendar'
  //           semantics) even when the company cycle is anniversary.
  //   'a2c' — Anniversary to Calendar: CALENDAR boundaries (1 Jan – 31 Dec, full-year grant at year-open
  //           for existing staff, identical to c2c) with a DAY-ACCURATE first year for an in-year ANNUAL
  //           joiner — annualDays ÷ 365 (366 in a leap year) × days worked to 31 Dec, replacing the
  //           whole-month proration. That first partial year is its ONLY behavioural difference from c2c.
  // Cycle consumers resolve the effective cycle via resolveLeaveYearCycle (core/leave.ts): override wins
  // where set, company cycle otherwise. 'a2c' resolves to its OWN token, which every boundary consumer
  // treats as calendar through its existing non-anniversary default (see that function's ADR note).
  yearCycleOverride: text('year_cycle_override'),
  // Leave Type Employee Visibility (feedback 7b11f1c1): two additive, NULLABLE booleans that let HR control,
  // per leave type, whether an employee sees the type at all on their self-service Leave surface, and whether
  // they may submit an application for it. These are the SINGLE SOURCE OF TRUTH for employee-facing leave-type
  // visibility / can-apply — later leave-view / grouping / dashboard consumers read these rather than inventing
  // a second hidden flag (see the item's consolidation note).
  //   visibleToEmployee — false ⇒ the type is dropped completely from the /me Leave tab (its balance row + its
  //     entry in the apply list). NULL/missing ⇒ VISIBLE (today's exact behaviour, so every existing row is
  //     unchanged, no backfill). Gating applies ONLY to the /me ESS surface; admin/HR reads are never gated.
  //   employeeCanApply — false ⇒ the type still shows (subject to visibleToEmployee) but is dropped from the
  //     apply dropdown AND rejected server-side in requestLeave (LeaveApplyNotAllowedError; isAdmin bypasses via
  //     the existing override path). NULL/missing ⇒ CAN APPLY (today's behaviour). STATUTORY SAFETY:
  //     updateLeaveType refuses employee_can_apply=false on a statutory-entitlement TYPE so a configuration can
  //     never deny a lawful entitlement. Since 65f466e2 that is decided ROLE FIRST (isStatutoryApplyType in
  //     core/leave.ts: role annual / sick / hospitalization / maternity / paternity), with the seeded codes
  //     (ANNUAL / SICK / …) only as the fallback for an unclassified row — production's statutory types are
  //     coded MTL / PTL / EL, so the code list alone protected none of them. The admin screen mirrors the same
  //     precedence client-side through lib/leave-statutory.ts (464b58e6).
  // The two switches are INDEPENDENT AS COLUMNS: a visible-but-not-can-apply type stays in the balance list but
  // not the apply menu. WHO WRITES THEM changed with 464b58e6 — the admin panel's Employee Visibility sub-form
  // posts employeeCanApply ALONE, and visibleToEmployee is written only by the Employee Tab Placement control
  // ("Hidden" ⇒ false), because offering the same hide decision in two places on one screen was the confusion
  // that item was raised to remove. NEVER read for admin/HR reads, entitlement math, accrual, workflow or
  // payroll — purely an ESS presentation + apply gate.
  visibleToEmployee: boolean('visible_to_employee'),
  employeeCanApply: boolean('employee_can_apply'),
  // Leave grouping visibility (feedback b653ac1b): the HR-editable placement of this leave type on the
  // employee self-service Leave tab — 'primary' (a card that stands out at the top) or 'secondary' (tucked
  // into a group below). NULL ⇒ resolve from a code-keyed default map (lib/leave-groups.ts): the common
  // codes default 'primary', the sensitive/rarely-used ones default 'hidden', everything else 'secondary'.
  // HIDDEN IS NOT STORED HERE: "Hidden" placement reuses the SINGLE visibleToEmployee switch (7b11f1c1) —
  // choosing Hidden sets visibleToEmployee=false, and resolving placement reads that flag FIRST (false ⇒
  // hidden). A DB CHECK constrains this column to 'primary' | 'secondary' so 'hidden' can never be stored
  // here (one source of truth for hidden). Presentation/config ONLY — never read for entitlement, accrual,
  // eligibility, workflow or payroll. NULL on every existing row ⇒ code-keyed default, today's exact
  // behaviour (see migration 0191). Resolved onto leaveBalances rows in core/read.ts; the /me cards-and-
  // groups renderer (planned 6d78f373) consumes the resolved value.
  essPlacement: text('ess_placement'),
  // Duplicate Leave Application Restriction (feedback d5e51c34): per-type policy controlling whether an
  // employee may submit MORE THAN ONE leave application overlapping the same date when a pending/approved
  // one already exists. Enforced in requestLeave + editLeaveRequest AFTER the existing narrow AM/PM same-slot
  // clash guard, extending the comparison from same-slot to same-DATE range overlap:
  //   'allow'         — current behaviour: no extra check (DEFAULT; every existing row backfills to this).
  //   'restrict_same' — block a 2nd pending/approved application of the SAME leave type on an overlapping date.
  //   'restrict_any'  — block ANY new pending/approved leave (any type) on an overlapping date.
  // NULLABLE DEFAULT 'allow' (a DB CHECK backs the closed 3-value set); the service treats null as 'allow'.
  // Never read for entitlement / accrual / eligibility / payroll — purely a submission-time double-booking gate.
  duplicateApplicationPolicy: text('duplicate_application_policy').default('allow'),
  // Configurable Negative Leave Balance Validation (feedback 0ef0defd): whether an employee may SUBMIT (or
  // edit) a leave application of this type whose days exceed their available balance. Until this flag, the
  // only balance guard sat at APPROVAL (finalizeLeaveApproval → InsufficientLeaveBalanceError); nothing checked
  // at submission. When false (the DEFAULT, approved product decision), requestLeave + editLeaveRequest reject
  // an application that would take the balance negative — "available balance" = the leave_ledger sum (approved
  // only) MINUS the sum of this employee's other PENDING requests of the same type (reserved days), so
  // stacked pending applications can't collectively overshoot. When true, the submit-time check is skipped
  // (employees may go negative; the approval-time guard is unaffected). NOT NULL DEFAULT false ⇒ every existing
  // row gains the block immediately (no backfill needed). Enforced only at requestLeave/editLeaveRequest —
  // never read for entitlement / accrual / eligibility / payroll.
  allowNegativeBalance: boolean('allow_negative_balance').notNull().default(false),
  // Maximum Negative Balance (feedback bc512dc3, migration 0352): the FLOOR under the switch above. With
  // allow_negative_balance on, one application could take an employee arbitrarily far into deficit; this is
  // how far is too far. Stored as a POSITIVE magnitude — 2.5 means "no further than -2.5 days" — because a
  // business user types a magnitude, and a column that sometimes holds -2.5 and sometimes 2.5 is how a sign
  // error becomes a silent doubling. NULL ⇒ today's unbounded behaviour, so no existing type changes.
  //
  // ⚠️ IT BINDS AT SUBMISSION, AND ONLY THERE, BECAUSE THAT IS THE ONLY PLACE THE SWITCH ITSELF BINDS.
  // allow_negative_balance relaxes the SUBMIT-time gate only: the approval path refuses whenever
  // `balance - need < 0` (InsufficientLeaveBalanceError, core/leave.ts) without ever consulting the flag.
  // So a balance cannot go negative through the ordinary request-and-approve flow at all, and a floor
  // checked at approval would be dead code sitting behind a strictly stronger rule. Adding it there would
  // read as enforcement while enforcing nothing. The asymmetry is PRE-EXISTING, is pinned by
  // test/leave-application-limit.ts's own fixture comment, and is raised separately on the board — do not
  // "fix" it as a side effect of touching this column, because relaxing that gate would let balances go
  // negative on every type that already has the switch on.
  maxNegativeBalance: numeric('max_negative_balance', { precision: 6, scale: 2 }),
  // Balance Deduction Source (feedback cdf9ca48, migration 0316): the leave type whose BALANCE an application
  // of THIS type is checked against and debited from. NULL (every existing row) = its own balance — today's
  // exact behaviour, no backfill. Set it and the type keeps no balance of its own: the reporter's Emergency
  // Leave checks and reduces ANNUAL, while the leave_request row (and therefore the employee's leave history)
  // still says Emergency Leave. Resolved once per application and used for BOTH the submit-time guard and the
  // approval-time ledger debit — those must never read different ledgers or an application could pass at
  // submission and then fail, or worse, debit a balance nobody checked.
  // SINGLE HOP, NOT A CHAIN: updateLeaveType refuses a source that itself has a source, and refuses giving a
  // source to a type that is already somebody else's source. That makes cycles structurally impossible (a
  // graph of depth 1 has none) without a recursive walk at every application, and it means the resolved
  // source is always one read. The self-reference case is additionally refused by a DB CHECK.
  balanceSourceTypeId: uuid('balance_source_type_id').references((): AnyPgColumn => leaveType.id),
  // Allow Unpaid Leave (feedback a7fab30b, migration 0316): whether an application of this type may exceed
  // the available balance, with the uncovered part becoming unpaid leave instead of being refused. NOT NULL
  // DEFAULT false ⇒ every existing type keeps the allow_negative_balance gate exactly as it is today.
  // When true it OVERRIDES that gate at submission (the whole point is that the application goes through),
  // and the excess is recorded on leave_request.unpaid_days — a PART-covered request splits (2 of 5 days
  // paid, 3 unpaid), it is never all-or-nothing. The balance it is measured against is the one
  // balanceSourceTypeId resolves to, so a type that both borrows and allows unpaid leave overflows the
  // BORROWED balance.
  allowUnpaidLeave: boolean('allow_unpaid_leave').notNull().default(false),
  // Override Leave Application (feedback 56910869, migration 0365): the ORDERED set of exceptions HR has
  // configured for this leave type — what the system does when one of its rules is not met. Each entry is a
  // (trigger, action) pair with its own switch: `{ trigger, action, enabled }`. Several per type on purpose,
  // so Annual Leave can BOTH convert on short notice AND split on insufficient balance; a single "override
  // mode" could only ever have expressed one exception per type.
  //
  // NULL on every existing row and DEFAULT OFF on every rule that is written — a configured-but-off rule is
  // configuration, not behaviour. Nothing about any leave type changes until HR enables a rule.
  //
  // Typed structurally rather than importing core/leave-override's LeaveOverrideRule: this file deliberately
  // imports nothing from core/, and the vocabulary guard belongs at the boundary anyway
  // (normalizeLeaveOverrideRules drops anything it does not recognise, so an unrecognised pair reads as
  // "no rule" — i.e. today's refusal — rather than as behaviour nobody configured).
  // 65f466e2 — `targetLeaveTypeId` names WHICH type a convert_to_emergency rule converts into. Optional:
  // absent means "fall back to the code lookup", so rules written before the field existed keep their
  // exact behaviour. It is the fix for conversions failing on any tenant whose Emergency Leave is not
  // literally coded 'EMERGENCY' (production's is `EL`).
  overrideRules: jsonb('override_rules').$type<
    { trigger: string; action: string; enabled: boolean; targetLeaveTypeId?: string | null }[]
  >(),
  /**
   * 65f466e2 (migration 0387) — WHAT THIS LEAVE TYPE IS, independent of the tenant's own code and name.
   *
   * Special treatment used to key off code literals the software invented ('EMERGENCY', 'REPLACEMENT',
   * 'MATERNITY', 'PATERNITY'). Production's codes are EL/RL/MTL/PTL, so every one of those comparisons was
   * silently dead and three designed behaviours never applied — see the migration header for the list.
   *
   * NULL means UNCLASSIFIED and keeps pre-65f466e2 behaviour, which is what every row the backfill could
   * not match exactly is left as. NEVER infer this from a balance source or a fuzzy name match: a wrong
   * marker silently changes which statutory rules apply to real applications. Values are constrained in
   * the database (leave_type_role_check).
   */
  role: text('role').$type<LeaveTypeRoleValue>(),
  // Leave Entitlement Formula Management (feedback 79011509, migration 0241): HR-owned, per-leave-type
  // plain-language EXPLANATIONS for each leave-view component — keyed by the widened explanation key set
  // (core/leave-formula.ts LEAVE_EXPLANATION_KEYS: the seven legacy §7 "Entitlement Calculation Breakdown"
  // component keys ∪ every ess-view key, feedback 2bc2f2a3), each an optional { description, formula, result }
  // of free text. Purely an explanation layer surfaced to
  // employees on the leave breakdown panel; NEVER read for entitlement / accrual / eligibility / workflow /
  // payroll — the days an employee is entitled to are unchanged. A missing key or a null column ⇒ no
  // explanation (the info icon is hidden for that row). JSONB extension point matching the serviceBands /
  // customMessages pattern: the map is REPLACED wholesale on write (the editor always posts the complete set),
  // and unknown keys are rejected in updateLeaveType. null on every existing row (no backfill).
  formulaExplanations: jsonb('formula_explanations').$type<
    Record<string, { description?: string; formula?: string; result?: string }>
  >(),
  // ── Type-level leave RULES (feedback 9816a5ad step 1 of 3, migration 0325) ────────────────────────
  // The consolidation gives each thing one home: the LEAVE TYPE owns the RULES (how days are earned,
  // carried, rounded and capped) and the BENEFIT SCHEME owns the DAYS. Today every one of these rules is
  // copied into `leave_policy.accrual` once per (company, grade) — ANNUAL alone has 57 identical copies —
  // which is why components/leave-type-panel.tsx already RENDERS them as though they were type-level.
  //
  // STEP 1 IS STORAGE ONLY. These ten columns are backfilled from the single distinct value each type
  // carries across all of its leave_policy rows (migration 0325 ASSERTS that distinctness and refuses to
  // run if a type ever disagrees with itself), and NOTHING READS THEM YET. The four consumers in
  // core/leave.ts — openLeaveYear, accrueEarnedLeave, projectExpectedEntitlement and the a2c correction —
  // still resolve every one of these through resolveGradePolicy over `leave_policy`, so the system behaves
  // byte-identically. Step 2 repoints those call sites; step 3 zeroes and disconnects leave_policy.
  //
  // NULL means "not configured" for all ten, which is how the engine already reads an absent JSONB key.
  // Step 2 must preserve each field's documented back-compat default (core/leave-compute.ts): an absent
  // carryForwardMax resolves to 0; an absent carryForwardEnabled falls back to `carryForwardMax > 0`
  // (carryEnabled); an absent expiry mode means 'date', i.e. read the month/day pair; an absent
  // roundingMethod means no rounding; an absent maxBalanceDays means no cap.
  //
  //   accrualMethod — `accrual.method`. Open value set BY CONTRACT (no DB CHECK): isEarnedMethod()
  //     recognises 'earned_monthly' / 'earned_quarterly' / 'earned_daily' (bc36c768) and reads everything
  //     else, absent included, as the lump-sum 'grant_on_hire_prorated' path.
  //
  //     bc36c768 narrowed the CHOICES to three — None, Monthly Accrual, Daily Accrual — without narrowing
  //     the stored set. 'earned_quarterly' stays RECOGNISED by the engine and keeps its arithmetic branch:
  //     retiring a choice and re-interpreting every value already stored under it are different changes,
  //     and only the first was asked for. The open contract is also what lets a pack introduce a cadence
  //     later without a schema change, which is why no CHECK is added here.
  accrualMethod: text('accrual_method'),
  //   carryForwardMax — `accrual.carryForwardMax`, the cap on days carried into the next leave year.
  carryForwardMax: numeric('carry_forward_max', { precision: 6, scale: 2 }),
  //   carryForwardPercent — 7cd914b1 (migration 0349): carry forward a PERCENTAGE of the balance the
  //     employee still has at year end, instead of a flat number of days. 0–100, NULL ⇒ not configured,
  //     which is every existing row and reads as the fixed-maximum behaviour.
  //
  //     PERCENT AND MAX ARE A CLAMP, NOT A CHOICE. When both are set the percentage resolves first and the
  //     max is a CEILING on it (resolveCarryAllowance). Two independent settings that can disagree is the
  //     exact shape 9816a5ad consolidated away, so there is deliberately no "which one wins" mode column:
  //     percent set ⇒ percentage of balance; max set ⇒ ceiling; both ⇒ min of the two.
  carryForwardPercent: numeric('carry_forward_percent', { precision: 5, scale: 2 }),
  //   carryForwardEnabled — `accrual.carryForwardEnabled`, the explicit on/off switch.
  carryForwardEnabled: boolean('carry_forward_enabled'),
  //   carryForwardExpiryMode — 'date' (read month+day) | 'months' (read months). BOTH modes are live, so
  //     both of their operands are stored below; 'date' is the back-compat mode every pre-R4 policy uses.
  carryForwardExpiryMode: text('carry_forward_expiry_mode'),
  //   carryForwardExpiryMonths — 'months' mode: the carried portion expires X months after year-end (1..12).
  carryForwardExpiryMonths: integer('carry_forward_expiry_months'),
  //   carryForwardExpiryMonth / Day — 'date' mode: the expiry OFFSET into the following leave year, stored
  //     as a pair (both set or both null, enforced by a DB CHECK). Sanitised on backfill through the same
  //     isValidMonthDay rule parseCarryExpiry applies, so a legacy 31-Feb lands as NULL (never expires) —
  //     which is exactly what the engine already does with it.
  carryForwardExpiryMonth: integer('carry_forward_expiry_month'),
  carryForwardExpiryDay: integer('carry_forward_expiry_day'),
  //   carryForwardIncludeEarned — `accrual.carryForwardIncludeEarned`. Config-only in the engine too (the
  //     include-monthly-earned-balance behaviour is still deferred); it round-trips so HR can set it.
  carryForwardIncludeEarned: boolean('carry_forward_include_earned'),
  //   roundingMethod — 'none' | 'up' | 'down' (b81d3c52) | 'nearest_half' (9f5164d8, migration 0335).
  //     NULL ⇒ none. Only 'up'/'down' were ever written by the 0325 backfill, mirroring resolveGradePolicy,
  //     which honoured nothing else; 'nearest_half' is only ever written by a deliberate admin save.
  //     8fec719e (0358) adds 'custom' — the only value the writer may store from now on, alongside 'none'.
  //     The three legacy values stay in the union (and in the CHECK) because applyRounding still evaluates
  //     them: retiring a CHOICE and re-interpreting every value stored under it are different changes.
  roundingMethod: text('rounding_method').$type<'none' | 'up' | 'down' | 'nearest_half' | 'custom'>(),
  //   roundingThreshold — 9f5164d8 (migration 0335): the decimal point at which the fractional part of a
  //     calculated entitlement rounds UP to the next 0.5 instead of DOWN to the previous one. Read ONLY when
  //     roundingMethod is 'nearest_half'; NULL ⇒ the reporter's documented standard rule (0.000–0.499 down,
  //     0.500–1.000 up), i.e. 0.500. The reporter specified two complementary ranges over 0.000–1.000 whose
  //     validation forbids gaps and overlaps — that shape has exactly one degree of freedom, the boundary,
  //     which is what this column is. See DEFAULT_ROUNDING_THRESHOLD in core/leave-compute.ts.
  roundingThreshold: numeric('rounding_threshold', { precision: 4, scale: 3 }),
  //   roundingBands — 8fec719e (migration 0358): the CUSTOM ROUNDING TABLE. An ordered jsonb array of
  //     {from, to, result} rows over the DECIMAL PORTION, evaluated by applyRoundingBands. r303 (migration
  //     0473): From / To / Round To at two decimals, 0.00–1.00, a range INCLUDING both its from and its to
  //     (it was from <= f < to at three decimals; 0473 rewrote every stored table with identical results).
  //     NULL ⇒ no table, which is every row 0358 leaves behind and reads as No Rounding.
  //
  //     WHY jsonb AND NOT A CHILD TABLE. The rows have no identity of their own — they are not referenced,
  //     not audited individually and never queried across types; they are one value that is always read and
  //     always written whole, exactly like `service_bands` on leave_policy.accrual. The DB CHECK only
  //     asserts "an array"; the SHAPE is validated by checkRoundingBands (core/leave-compute.ts), which is
  //     the same function the editor draws its live warnings from, so the screen and the guard cannot drift.
  //
  //     rounding_method AND rounding_bands ARE BOTH REQUIRED to round. A table with the method back on
  //     'none' is dormant, not deleted — the reporter can switch Custom Rounding off and on without
  //     retyping the table, the same containment `rounding_threshold` already has.
  roundingBands: jsonb('rounding_bands'),
  //   entitlementRounding{Method,Threshold,Bands} — 845903a3 (migration 0475): the SECOND rounding
  //     configuration, applied only to the DISPLAYED Entitlement figure after proration. Identical shape
  //     to the trio above on purpose: applyRounding takes its configuration as arguments, so the same
  //     evaluator and the same checkRoundingBands validator serve both with no change to either.
  //
  //     ⚠️ DELIBERATELY NOT IN `leaveTypeRuleColumns`. That map exists so the granting engines and the
  //     projection kernel read the IDENTICAL rule set; a rule one reads and the other does not posts a
  //     permanent oscillating delta on every reproject (7cd914b1, twice). These three must never reach a
  //     ledger write — the whole point of the item is that Earned to Date does not move — so the one read
  //     that renders the figure selects them explicitly instead.
  //
  //     NULL method ⇒ no entitlement rounding ⇒ the exact prorated figure is shown. Method AND bands are
  //     both required to round, the same containment the accrual trio has: a table with the method back
  //     on 'none' is dormant, not deleted.
  entitlementRoundingMethod: text('entitlement_rounding_method').$type<'none' | 'up' | 'down' | 'nearest_half' | 'custom'>(),
  entitlementRoundingThreshold: numeric('entitlement_rounding_threshold', { precision: 4, scale: 3 }),
  entitlementRoundingBands: jsonb('entitlement_rounding_bands'),
  //   accrualDay — bc36c768 (migration 0375): the DAY OF THE MONTH Monthly Accrual credits on, 1..31
  //     (DB CHECK). NULL ⇒ day 1, which is what every pre-bc36c768 row means and what `accrualPeriods`
  //     has always hard-wired. Read ONLY by the 'earned_monthly' branch of `earnedToDateFor`; meaningless
  //     (and ignored) for 'earned_daily', the quarterly legacy branch and every lump method, so a stored
  //     value can never change what any other method produces.
  //
  //     IN A SHORTER MONTH THE CREDIT MOVES TO THAT MONTH'S LAST DAY rather than being skipped —
  //     `effectiveAccrualDay` clamps 31 to 28 (29 in a leap year) in February and to 30 in April. A month
  //     that never credits would leave a permanent hole in the cumulative, which is the one thing the
  //     to-date model cannot express.
  accrualDay: integer('accrual_day'),
  //   accrualUnconfigured — bc36c768 (migrations 0375 + 0376): THE NOT-CONFIGURED MARKER. Stamped by the
  //     0376 clear-out on every non-archived type, cleared the moment `setLeaveTypeRules` writes a
  //     non-null accrualMethod. NULL ⇒ configured (every type from that save onward).
  //
  //     A type carrying this marker GRANTS NOTHING AND EARNS NOTHING: the hire grant skips it,
  //     accrueEarnedLeave skips it, projectExpectedEntitlement returns null (a SKIP, never 0 — a 0 would
  //     make the reproject paths claw back every already-credited day), and openLeaveYear forces the
  //     grant to 0 while still writing its forfeit row and its always-written open-marker row.
  //
  //     DELIBERATELY NOT PART OF `hasAnyLeaveTypeRule`, for the reason `carryForwardIncludeEarned` is not:
  //     if this marker flipped a previously unruled type onto the type-level rule set, applyLeaveTypeRules
  //     would overlay NULL carryMax / roundingMethod / maxBalanceDays over the policy's real values and
  //     silently wipe configuration nobody asked to reset. It IS in `leaveTypeRuleColumns`, so it rides
  //     every existing select and every gate can read it. A column may be in the select map without being
  //     in the engagement test; that is exactly the shape this needs.
  accrualUnconfigured: timestamp('accrual_unconfigured', { withTimezone: true }),
  // Application Limits (feedback c6ffa725, migration 0335): the maximum total days an employee may APPLY
  // for, of this type, within one leave year — regardless of entitlement balance. The home for the
  // reporter's Unpaid Leave case (entitlement 0, Leave Summary showing 0 available, applications still
  // permitted up to a company figure).
  //
  // AN APPLICATION RULE, NOT AN ENTITLEMENT. No granting, accrual, carry-forward, rounding or
  // balance-display path reads it. It is enforced in exactly two places, at submission and again at
  // approval (enforceLeaveYearApplicationLimit in core/leave.ts) — either alone is bypassable.
  //
  // NULL ⇒ NO LIMIT, which is what every existing leave type means. There is deliberately no default: a
  // silently-defaulted limit would begin refusing real leave applications the moment it deployed (the
  // r82 precedent, scheme_leave_combined_limit.max_days_per_application).
  maxDaysPerLeaveYear: numeric('max_days_per_leave_year', { precision: 6, scale: 2 }),
  // Application Limit PERIOD (feedback ad9cb5c5, migration 0352): the window the ceiling above is counted
  // over. 'leave_year' (the default meaning of NULL, and what every existing row does today) ·
  // 'calendar_year' · 'employment'.
  //
  // The column above keeps saying leave_year while the period becomes configurable. That is ugly and it is
  // deliberate: renaming an applied column costs a second migration, a rewrite of every reader, and a
  // window where the two names disagree — dearer than one awkward name.
  //
  // LEAVE YEAR IS NOT CALENDAR YEAR unless the tenant's leave year starts in January, which is why both are
  // offered. Resolve the window through the leave-year path (resolveLeaveYearCycle + leaveYearWindow),
  // NEVER by taking the year off the date.
  //
  // 'employment' counts across the whole employment, so a REHIRE STARTS FRESH — it is scoped to
  // employment_id, not person_id. That is a real policy choice: a limit that survives a rehire is a rule
  // about the person rather than the job, and it must be asked for explicitly rather than assumed here.
  maxDaysPeriod: text('max_days_period'),
  // Maximum Consecutive Leave (feedback c6ffa725 revision 2, migration 0343): the OTHER half of the same
  // request — "how much in ONE GO", where max_days_per_leave_year above is "how much in a YEAR". Unlimited
  // (both NULL) or Limited (a figure AND the unit it is read in). The DB refuses a half-configured pair.
  //
  //   maxConsecutiveDays — the cap. NULL ⇒ Unlimited, which is every row in every existing database.
  //   maxConsecutiveUnit — 'calendar_days' (every day the application SPANS, weekends and holidays counted)
  //     or 'working_days' (only the days the application actually CHARGES). Friday→Monday is 4 of the first
  //     and 2 of the second: the same number means different things, which is why the reporter asked to
  //     choose. TEXT + CHECK, not a pgEnum — a new enum value cannot be used in the transaction that adds
  //     it (the 0338 lesson); leave_unit on this table (leave_type_leave_unit_ck, migration 0182) is the
  //     precedent. It used to cite expiry_unit, which c459bff9 dropped along with the whole expiry pair.
  //
  // THE SECOND PER-APPLICATION CAP, DELIBERATELY. leave_shared_group.max_days_per_application caps one
  // application too, for every type in a shared group. The two are NOT independent mechanisms: they are one
  // composition (resolveApplicationLengthLimit in core/leave.ts), the stricter binds, and the refusal names
  // which. See test/shared-leave-group-single-mechanism.test.ts, widened in the open to say exactly that.
  maxConsecutiveDays: numeric('max_consecutive_days', { precision: 6, scale: 2 }),
  maxConsecutiveUnit: text('max_consecutive_unit'), // 'calendar_days' | 'working_days' (null when Unlimited)
  //   maxBalanceDays — the Maximum Balance clamp (9d8cf621). NOTE its source: this exists TODAY only as a
  //     PER-SERVICE-BAND value inside `accrual.serviceBands[].maxBalanceDays`, never at policy level. The
  //     bands are the DAYS half of the split and move to scheme_leave_entitlement.service_bands, so the cap
  //     has no home there and becomes type-level here — collapsed across every band of every policy under
  //     the same one-distinct-value assertion.
  maxBalanceDays: numeric('max_balance_days', { precision: 6, scale: 2 }),
  /**
   * 76ffdcf2 (r269, migration 0462) — THE DEFAULT ENTITLEMENT TABLE: which table an employee receives when
   * NO benefit scheme (entitlement_eligibility_rule) covers them for this leave type.
   *
   * A leave type with two or more entitlement tables and no matching rule resolved to NOTHING, because the
   * resolver refuses to guess which of several tables a person should get (r193 fault 3). The reporter read
   * the screens as saying a scheme is a PRECONDITION for entitlement; it never was, but the outcome — an
   * unmatched employee holding no table — looked the same. This column closes it without inventing days:
   * the fallback is a lineage a NAMED HUMAN chose on this leave type.
   *
   * ⚠️ NULL IS TODAY'S BEHAVIOUR, EXACTLY. No default ⇒ nothing resolves ⇒ `noEntitlementOpinion` ⇒ the
   * caller posts NOTHING (delta exactly 0, never 0 days). The r193 property "never hand out a table nobody
   * chose" survives precisely BECAUSE the fallback is explicit, and the EA-1955 statutory floor is not a
   * fallback here (fa3f4ccb: advisory, out of the arithmetic, on the reporter's written instruction twice).
   *
   * A LINEAGE, NOT A VERSION, so no FK — `entitlement_template.lineage_id` is not unique on that table
   * (one row per version). `entitlement_eligibility_rule.template_lineage_id` is modelled identically.
   * `setLeaveTypeDefaultTemplate` refuses a lineage belonging to another leave type; the resolver ignores
   * a default with no version in force on the date it is resolving at.
   */
  defaultEntitlementTemplateLineageId: uuid('default_entitlement_template_lineage_id'),
  /**
   * r301 (board 83511d3b, migration 0471) — CANCEL APPROVED LEAVE, the leave type's own rule for an
   * employee asking to cancel leave of this type AFTER it was approved. Read in exactly one place,
   * `cancelApprovedSettingOf` (core/leave.ts), which both the service gate and the two screens that offer
   * the "Cancel dates" button go through, so a button can never be offered for a request the service refuses.
   *
   *   employeeCancelApproved — may the employee ask at all. EVERY ROW THAT EXISTED AT 0471 READS true
   *     (today's behaviour); the column DEFAULT is false, so every type created from then on — by HR, by
   *     tenant provisioning, by the TOIL auto-created Replacement Leave type — starts switched OFF, which is
   *     what the reporter asked for. HR's on-behalf cancellation (adminCancelLeave) never reads it.
   *   cancelNoticeDays — calendar days, counted per leave DATE being cancelled from the tenant-local today.
   *     0 ⇒ today's rule (strictly after today). Whole number ≥ 0, validated in updateLeaveType (no CHECK:
   *     it would fire on every leave_type UPDATE, §6).
   *   cancelAutoApprove — false ⇒ the original request's approvers re-approve, level by level
   *     (leave_cancellation_step); true ⇒ approved by the system inside the request's own transaction.
   *   cancelNotify — tell the current approver + HR admins (in-app only) when a cancellation is requested.
   *
   * Emergency Leave ignores all four (cancelApprovedSettingOf returns today's behaviour for it) and the card
   * is hidden for it, exactly as the backdating and advance-notice rules are.
   */
  employeeCancelApproved: boolean('employee_cancel_approved').notNull().default(false),
  cancelNoticeDays: integer('cancel_notice_days').notNull().default(0),
  cancelAutoApprove: boolean('cancel_auto_approve').notNull().default(false),
  cancelNotify: boolean('cancel_notify').notNull().default(false),
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
    // `name` is the LABEL people read — the column the Job Grade table shows under "Label" (e3c733df).
    // Kept as `name` rather than renamed: it is referenced by employees, leave policies, approval rules,
    // claim limits and grade groups, and a rename buys nothing the heading does not already give.
    name: text('name').notNull(),
    // Optional detail, mirroring profile_option.description (migration 0206) so Job Grade matches the
    // System Label pattern it is meant to follow. Display-only, nullable, part of no uniqueness rule —
    // two grades may legitimately share a description. See migration 0315.
    description: text('description'),
    rank: integer('rank').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('job_grade_code_uq').on(t.tenantId, t.code).where(sql`archived_at is null`),
    // Grade Management (feedback 728a7db6): reject duplicate grade NAMES too (case-insensitive, active-only),
    // mirroring the code index. Frees the name when a grade is archived. See migration 0183.
    uniqueIndex('job_grade_name_uq').on(t.tenantId, sql`lower(${t.name})`).where(sql`archived_at is null`),
  ],
);

// ── Grade groups (feedback b83c6a3b; KEPT by 6e9a126e release three) ─────────────────────────────────
// Grade groups let HR treat several job grades as one band ("Grade 12-15"). They arrived as part of the
// benefit-scheme entitlement layer, and release three dropped that layer — benefit_scheme,
// scheme_leave_entitlement, leave_policy and employment.benefit_scheme_id are all gone.
//
// THESE TWO TABLES SURVIVED, AND THE REASON IS NOT SENTIMENT: 205 live leave_approval_policy rows scope
// by grade group. Dropping them would silently unscope every one of those approval rules and force HR to
// rebuild each by hand. They are now plain organisation grade banding for APPROVAL ROUTING — they no
// longer select an entitlement. Entitlement targeting is entitlement_eligibility_rule's job.
export const gradeGroup = pgTable(
  'grade_group',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // Reject duplicate group NAMES (case-insensitive, active-only) — mirrors job_grade_name_uq.
    uniqueIndex('grade_group_name_uq').on(t.tenantId, sql`lower(${t.name})`).where(sql`archived_at is null`),
  ],
);

// grade_group_member = which job grades belong to a grade group. A grade maps to AT MOST ONE group (unique
// on grade_id) so auto-match to a scheme is unambiguous. ON DELETE CASCADE from both sides.
export const gradeGroupMember = pgTable(
  'grade_group_member',
  {
    id: id(),
    tenantId: tenantId(),
    gradeGroupId: uuid('grade_group_id')
      .notNull()
      .references(() => gradeGroup.id, { onDelete: 'cascade' }),
    gradeId: uuid('grade_id')
      .notNull()
      .references(() => jobGrade.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('grade_group_member_grade_uq').on(t.tenantId, t.gradeId),
    index('grade_group_member_group_idx').on(t.gradeGroupId),
  ],
);

// ── Entitlement redesign (feedback 6e9a126e, RELEASE ONE — migrations 0396/0397/0398) ────────────────
//
// THE THREE LAYERS THE REPORTER ASKED FOR, and nothing else:
//
//     leave_type  →  entitlement_template  →  entitlement_eligibility_rule
//
// A TEMPLATE is a NAMED service-band day table for ONE leave type ("Grade 12-15 Permanent", "Contract",
// "Executive"). An ELIGIBILITY RULE says WHO gets which template. That replaces benefit_scheme +
// scheme_leave_entitlement (which copied the same band table inside every scheme it applied to) AND
// leave_policy (an older company/grade layer that could quietly win instead).
//
// ⚠️ RELEASE ONE ADDS; IT REMOVES NOTHING. benefit_scheme, scheme_leave_entitlement,
// employment.benefit_scheme_id and leave_policy all stand untouched and still resolve every live figure.
// The engines do NOT read these tables yet — release two re-points them through the one shared
// composition (`entitledDays`), release three archives and clears the old layers. Shipping the storage
// and its resolver first, inert, is the same staging 9816a5ad step 1 and 7c834696 stage 1 used: an
// editor that writes configuration nothing reads is worse than no editor, so the editors land in
// release two beside the engine reads that make them mean something.
//
// ── WHY BOTH TABLES ARE EFFECTIVE-DATED ───────────────────────────────────────────────────────────────
// THREE readers resolve entitlement AT A PAST DATE today — the Carry Forward report (core/analytics.ts,
// per employee at THEIR own cycle open), expireCarriedLeave's year sweep, and the /me + admin balance
// breakdown (core/read.ts, validFrom <= asOf < validTo). leave_policy carries validFrom/validTo and those
// three depend on it. A replacement without dating would answer a closed year with today's figures, which
// contradicts the request's own "maintaining all existing calculation capabilities". So an edit CLOSES the
// running version (validTo = the effective date) and INSERTS a successor, exactly as
// createLeavePolicy/updateLeavePolicy already do.
//
// ── WHY A lineage_id AND NOT A NAME ───────────────────────────────────────────────────────────────────
// An eligibility rule must keep pointing at "the Executive table" across every future version of it. A FK
// to a VERSION row goes stale the moment that version is superseded (and would have to be rewritten on
// every edit, which is how a rule silently ends up on a closed version). A FK to the NAME cannot survive
// a rename. `lineage_id` is the stable identity of the table-through-time: version 1 carries its own id
// as its lineage, every successor inherits it, and resolution is "the version of THIS lineage in force on
// THAT date". Rules point at the lineage, never at a version.
export const entitlementTemplate = pgTable(
  'entitlement_template',
  {
    id: id(),
    tenantId: tenantId(),
    /** Stable identity ACROSS versions. The first version carries its own id here; successors inherit it. */
    lineageId: uuid('lineage_id').notNull(),
    /** The leave type this table hands out days for. The reporter's own hierarchy puts Leave Type ABOVE the
     *  template, and it is what lets deleteLeaveType still refuse a type that carries live configuration
     *  once leave_policy is gone (core/admin.ts's in-use guard). CONSTANT across a lineage — a successor
     *  version may change the name and the bands, never the type it belongs to. */
    leaveTypeId: uuid('leave_type_id')
      .notNull()
      .references(() => leaveType.id),
    /** HR's own name for the table ("Grade 12-15 Permanent", "Contract", "Part Time", "Executive"). */
    name: text('name').notNull(),
    /** ServiceBand[] — the SAME JSONB shape scheme_leave_entitlement and leave_policy.accrual already use,
     *  resolved by the SAME `bandDaysFor` / `isWellFormedBands`. Carried forward UNCHANGED on purpose: the
     *  reporter's four columns map exactly (From/To Year(s) → fromYears/toYears, Entitled Days → days,
     *  Max Brought Forward → carryForwardDays, Max Entitled + Brought Forward → maxBalanceDays), and a new
     *  band shape would fork the one piece of this area that is already right.
     *
     *  ⚠️ THE TEMPLATE GROWS NO SECOND CARRY DEFINITION. 7cd914b1 put carry forward (cap AND percentage) on
     *  `leave_type` and applyLeaveTypeRules overlays it wholesale. `carryForwardDays` survives inside the
     *  band JSONB because the ServiceBand type is shared verbatim, but a CONSOLIDATED type deliberately
     *  stops reading per-band carry (see applyLeaveTypeRules) — so there is exactly one carry rule per
     *  leave type and this table adds none. */
    serviceBands: jsonb('service_bands').notNull(),
    validFrom: date('valid_from').notNull(),
    /** Exclusive, nullable. NULL = the running version. */
    validTo: date('valid_to'),
    createdAt: createdAt(),
  },
  (t) => [
    // At most ONE running version per lineage — the invariant the close-then-insert writer maintains and
    // the resolver relies on. Enforced here rather than only in the service, because "two open versions"
    // is a state no reader has a defined answer for.
    uniqueIndex('entitlement_template_open_uq').on(t.tenantId, t.lineageId).where(sql`valid_to is null`),
    // Two RUNNING tables of the same name under one leave type are indistinguishable in a picker.
    uniqueIndex('entitlement_template_name_uq')
      .on(t.tenantId, t.leaveTypeId, sql`lower(${t.name})`)
      .where(sql`valid_to is null`),
    index('entitlement_template_type_idx').on(t.tenantId, t.leaveTypeId),
    index('entitlement_template_lineage_idx').on(t.lineageId),
  ],
);

// entitlement_eligibility_rule = WHO gets which template, as at a date.
//
// ── THE CRITERIA ARE core/org-criteria.ts's OrgCriteria, NOT A NEW VOCABULARY ─────────────────────────
// This item exists because the same question was answered in several places at once. Minting a THIRD
// "who does this apply to" engine to fix that would be self-defeating, so the criteria stored here are the
// EXACT object `resolveOrgCriteriaTargets` already resolves for bulk Leave Adjustments (491c499f) and the
// Notice Board (6e122302), widened by 18103ba4. Every dimension the reporter listed is already in it:
// Company, Employment Type, Grade, Department, Position, Division, Gender, Minimum Service (as
// minYearsOfService) and Probation Status (as confirmationStatuses) — plus the rest of the eight
// Organisation-Assignment axes, business unit, cost centre, location and the other demographics.
//
// It is also the module that already resolves EVERY axis AS AT a date, which is the requirement the
// approval matcher (`ruleMatches`, fed attributes as of NOW by its caller) could not have met: department,
// position, business unit, cost centre, location and employment type come from the `assignment` version in
// force on `asOf`, and employment status / confirmation status / years of service are computed against it.
//
// RESIDUAL, and it is stated on screen rather than hidden: gender, nationality, religion, race and
// job GRADE are undated columns, so a past-date answer is EXACT for the dated axes and CURRENT-VALUE for
// those. That is a schema fact, not a choice made here.
export const entitlementEligibilityRule = pgTable(
  'entitlement_eligibility_rule',
  {
    id: id(),
    tenantId: tenantId(),
    /** Stable identity across versions — see entitlement_template.lineageId. */
    lineageId: uuid('lineage_id').notNull(),
    /** HR's name for the population ("Executives, Peninsular", "Contract staff"). Shown when the screen
     *  explains WHICH rule won, which the plan promises is never a guess. */
    name: text('name').notNull(),
    /** The template LINEAGE this population is assigned to. Not a version id — see the header above. There
     *  is deliberately no FK: a lineage is not a row, and pointing the FK at one version would be the exact
     *  staleness the lineage exists to remove. The service refuses a lineage that has no template. */
    templateLineageId: uuid('template_lineage_id').notNull(),
    /** core/org-criteria.ts `OrgCriteria`. Typed structurally: this file imports nothing from core/. An
     *  EMPTY object is a real, meaningful value — it means "everyone", exactly as it does for the Notice
     *  Board — and it is how a tenant expresses a single default table. */
    criteria: jsonb('criteria').notNull(),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('entitlement_eligibility_rule_open_uq')
      .on(t.tenantId, t.lineageId)
      .where(sql`valid_to is null`),
    index('entitlement_eligibility_rule_template_idx').on(t.tenantId, t.templateLineageId),
    index('entitlement_eligibility_rule_window_idx').on(t.tenantId, t.validFrom, t.validTo),
  ],
);

// entitlement_reset_archive = THE WRITTEN RECORD OF WHAT THE RESET WILL CLEAR. A record, not a mechanism.
//
// The plan promises the reporter: "you read the old figures off that record while you retype them". The
// clearing is irreversible and the archive's completeness is the ONLY promise it makes, so the capture
// runs NOW — in release one, before any clearing capability exists — and re-runs immediately before the
// reset in release three. Every column is TEXT, denormalised, so it stays readable after the tables it
// describes are gone.
//
// ⚠️ IT COPIES leave_shared_group_reset_archive's TABLE SHAPE, NOT ITS ZERO-READER POSTURE. That table
// (0342) is documented as never read and never joined, and test/shared-leave-group-single-mechanism.test.ts
// actively asserts no core file reads it — which is exactly the gap this item must not repeat. This one
// HAS a reader: a read-only admin listing with a CSV download at /admin/leave/entitlements/archive.
//
// ONE table for BOTH cleared layers, discriminated by `layer`, rather than two: the reporter reads one
// list, and a single capture transaction cannot half-succeed across two tables.
export const entitlementResetArchive = pgTable(
  'entitlement_reset_archive',
  {
    id: id(),
    tenantId: tenantId(),
    // NOT `createdAt()`: that helper hardcodes the COLUMN NAME `created_at`, and this column is
    // `captured_at`. `leave_shared_group_reset_archive` above declares `capturedAt: createdAt()` and
    // therefore does not match its own migration either — invisible there only because nothing ever reads
    // that table, which is the whole posture this item is not repeating.
    capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow().notNull(),
    /** Which capture run wrote this row. The archive is re-captured before the reset, so a tag is what
     *  lets the listing show the LATEST record rather than silently interleaving two snapshots taken
     *  months apart. */
    captureTag: text('capture_tag').notNull(),
    /** 'scheme' (benefit_scheme × scheme_leave_entitlement) | 'policy' (leave_policy). */
    layer: text('layer').notNull(),
    /** Scheme side: the scheme's name. Policy side: NULL. */
    schemeName: text('scheme_name'),
    /** Scheme side: the scheme's grouping label. Policy side: NULL. */
    schemeCategory: text('scheme_category'),
    /** Both sides: the leave type's name (and code, so a retyper can find it again). */
    leaveTypeName: text('leave_type_name'),
    leaveTypeCode: text('leave_type_code'),
    /** Both sides: the company this configuration applied to. NULL on the policy side = the group default,
     *  which is rendered as such rather than left blank. */
    companyName: text('company_name'),
    /** Scheme side: the grade GROUP the scheme targeted. Policy side: NULL. */
    schemeGradeGroupName: text('scheme_grade_group_name'),
    /** Scheme side: the grades inside that group, comma separated — the group survives the reset, but the
     *  record has to say who the table actually reached. Policy side: NULL. */
    schemeGradeGroupMembers: text('scheme_grade_group_members'),
    /** Policy side: the single grade the policy was scoped to. NULL = all grades. */
    gradeName: text('grade_name'),
    /** Scheme side: the employment type the scheme targeted. Policy side: NULL. */
    employmentType: text('employment_type'),
    /** BOTH SIDES, and it is the point of the whole table: the figures, rendered as readable text. Scheme
     *  side = the band table written out. Policy side = the accrual figures written out. */
    entitlementText: text('entitlement_text'),
    /** Both sides: the dates it was in force between, as text. The scheme layer is undated, so the scheme
     *  side records that honestly ('—') rather than inventing a window. */
    validFromText: text('valid_from_text'),
    validToText: text('valid_to_text'),
    /** Free-text notes the capture attaches (e.g. "scheme carries no entitlement rows"). */
    note: text('note'),
  },
  (t) => [
    index('entitlement_reset_archive_tenant_idx').on(t.tenantId, t.captureTag),
    index('entitlement_reset_archive_layer_idx').on(t.tenantId, t.layer),
  ],
);

/**
 * c8052ae3 (migration 0416) — the written record of the leave_ledger rows the Medical / Hospitalization
 * reset REMOVES, and of the recalc-audit rows that describe them.
 *
 * ⚠️ THIS IS THE TABLE THAT MAKES A DELETION FROM AN APPEND-ONLY LEDGER DEFENSIBLE. `leave_ledger` is
 * append-only by documented posture, and `leave_adjustment_batch` reverses by writing compensating rows.
 * That posture is set aside for exactly one correction — see migration 0416's header for the four
 * conditions that justify it (a compensating row cannot cancel the 2027/2028 future-dated grants; the
 * reporter was promised a clean 0.00 rather than "14.00 with a −14.00 beside it"; both types carry zero
 * debits and zero approved requests; and this archive is written and VERIFIED before anything is deleted).
 * Remove any one of those and the deletion stops being justified.
 *
 * EVERY COLUMN IS TEXT, like `entitlementResetArchive` above and for the same reason: the record has to
 * outlive the rows, the employments and eventually the leave types it describes, so it holds no ids that
 * can dangle and no joins that can fail. `sourceRowId` is the original uuid AS TEXT, deliberately without
 * a reference — a real FK would point at a row this correction is about to delete.
 *
 * THE WRITER IS SQL (`app.capture_leave_ledger_reset_archive`, migration 0416), not this schema entry.
 * There is no TypeScript insert path and inventing one for a test would be a second mechanism. The
 * READERS are core/leave-ledger-archive.ts and the admin listing it feeds.
 */
export const leaveLedgerResetArchive = pgTable(
  'leave_ledger_reset_archive',
  {
    id: id(),
    tenantId: tenantId(),
    // NOT `createdAt()`: that helper hardcodes the COLUMN NAME `created_at` and this column is
    // `captured_at` — the same trap `entitlementResetArchive` documents above.
    capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow().notNull(),
    /** Which capture run wrote this row — a rehearsal on a restored copy and the real run must never read
     *  as one record. */
    captureTag: text('capture_tag').notNull(),
    /** 'ledger' (leave_ledger) | 'recalc_audit' (leave_entitlement_recalc_audit). */
    layer: text('layer').notNull(),
    /** The ORIGINAL row's id as TEXT, with no reference — see the header. */
    sourceRowId: text('source_row_id'),
    employeeName: text('employee_name'),
    employeeCode: text('employee_code'),
    employeeEmail: text('employee_email'),
    companyName: text('company_name'),
    leaveTypeName: text('leave_type_name'),
    leaveTypeCode: text('leave_type_code'),
    /** ledger layer: 'accrual' / 'adjustment' / … . recalc_audit layer: NULL. */
    entryType: text('entry_type'),
    /** ledger layer: the row's SIGNED days. recalc_audit layer: the audit row's delta. */
    daysText: text('days_text'),
    effectiveOnText: text('effective_on_text'),
    /** ledger layer: `leave_ledger.reason` verbatim. recalc_audit layer: the trigger that caused it. */
    reason: text('reason'),
    /** recalc_audit layer only: "previous 180.00 → new 60.00 (delta −120.00)" — the sentence that explains
     *  every negative balance the reporter reported. */
    entitlementText: text('entitlement_text'),
    /** ledger layer only. Expected to read "not sourced from a leave request" on EVERY row (production
     *  shows zero debits on both types); anything else means the safety argument did not hold. */
    sourceRequestText: text('source_request_text'),
    recordedAtText: text('recorded_at_text'),
    note: text('note'),
  },
  (t) => [
    index('leave_ledger_reset_archive_tenant_idx').on(t.tenantId, t.captureTag),
    index('leave_ledger_reset_archive_layer_idx').on(t.tenantId, t.layer),
  ],
);
export type LeaveLedgerResetArchiveRow = typeof leaveLedgerResetArchive.$inferSelect;

// leave_shared_group (r88, feedback 1ef1cf95 — migration 0342) = a SHARED LEAVE GROUP: several leave types
// drawing on ONE pooled allowance (e.g. "Special Leave: 10 days a year shared, max 3 days per application").
//
// THIS REPLACES scheme_leave_combined_limit / _member (0220 / R44 4c48fd1f, extended by r82a 0327). Those
// tables hung the group off a BENEFIT SCHEME: the same shared rule had to be recreated inside every scheme
// it applied to, and the group was described as belonging to a scheme rather than to the leave types that
// share it. The reporter rejected improving that shape and asked for the group to be defined once, at leave
// TYPE level. Dropping benefit_scheme_id removes a per-employee dimension with it: two employees on
// different schemes can no longer have different shared limits for the same leave types. That is intended —
// one group, one rule, tenant-wide — and it is stated here because it is not recoverable from the columns.
//
// New tables rather than a nullable benefit_scheme_id: the old NAMES say "scheme", and a column that is
// always null is a worse lie than a rename. 0342 does not carry the old rows forward — the reset was part
// of the request ("reset the current configuration so I can recreate and regroup"), and the migration
// records what it removed in leave_shared_group_reset_archive first.
//
// The group caps what may be TAKEN; it never says how many days are GRANTED. Entitlement comes from the
// benefit scheme's service bands or the leave policy, per type, exactly as before.
export const leaveSharedGroup = pgTable(
  'leave_shared_group',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    // The shared annual allowance: the members' usage is summed across the leave year against this.
    totalLimitDays: numeric('total_limit_days', { precision: 6, scale: 2 }).notNull(),
    // The group's PER-APPLICATION day cap — "no single application may exceed N days, whichever member type
    // is chosen". A SECOND, independent rule beside the shared total: the total caps the year, this caps one
    // application. NULL = no cap. Measured in CALENDAR days spanned by the application; the units live in
    // applicationSpanDays() (core/leave.ts), not here.
    maxDaysPerApplication: numeric('max_days_per_application', { precision: 6, scale: 2 }),
    // Shared Leave Group display (feedback 46afcc48, migration 0438): WHERE this group is drawn on the
    // employee self-service Leave tab — 'primary' (one balance card at the top), 'secondary' (lower down
    // with the other-leave section) or 'hidden' (not drawn at all). NOT NULL DEFAULT 'hidden', so every
    // existing group keeps today's behaviour: the group has never been shown to an employee, and it stays
    // that way until HR chooses a placement.
    //
    // 'hidden' IS STORED HERE, unlike leave_type.ess_placement — and that difference is deliberate, not a
    // drift. A leave TYPE already owns one hidden switch (visible_to_employee, 7b11f1c1), so 0193 refuses
    // to store a second spelling of hidden in its placement column. A GROUP has no such twin flag, so this
    // column IS the single source of truth for a hidden group and the DB CHECK admits all three values.
    //
    // DISPLAY ONLY, and in particular NOT enforcement: the shared annual ceiling (total_limit_days) and the
    // per-application cap (max_days_per_application) are applied by core/leave.ts at apply and at approval
    // regardless of what this column says. Hiding a group — or every one of its member types — changes what
    // is DRAWN and never what may be TAKEN.
    essPlacement: text('ess_placement').notNull().default('hidden'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('leave_shared_group_name_uq').on(t.tenantId, t.name)],
);

// leave_shared_group_member = one leave type belonging to a shared group. The unique index is on
// (tenant, leave_type) with NO scheme dimension: A LEAVE TYPE BELONGS TO AT MOST ONE GROUP, tenant-wide.
// That is a real constraint, not a UI nicety — the deduction path has no defined behaviour for a type in two
// pools, so it is enforced in the database and the clash is surfaced BY NAME in the config layer.
export const leaveSharedGroupMember = pgTable(
  'leave_shared_group_member',
  {
    id: id(),
    tenantId: tenantId(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => leaveSharedGroup.id, { onDelete: 'cascade' }),
    leaveTypeId: uuid('leave_type_id')
      .notNull()
      .references(() => leaveType.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('leave_shared_group_member_uq').on(t.tenantId, t.leaveTypeId),
    index('leave_shared_group_member_group_idx').on(t.groupId),
  ],
);

// leave_shared_group_reset_archive (r88, migration 0342) = a RECORD, not a mechanism. The reset the reporter
// asked for is irreversible, and the plan promises them the list of what was configured before it went. This
// table holds that list, denormalised to text (owning scheme name, group name, both limits, member leave-type
// names) so it stays readable after the tables it describes are gone. Nothing in the leave engine reads it;
// it is never joined to; it is written exactly once, by 0342.
export const leaveSharedGroupResetArchive = pgTable('leave_shared_group_reset_archive', {
  id: id(),
  tenantId: tenantId(),
  // 6e9a126e — CORRECTED. This said `createdAt()`, which hardcodes the column name `created_at`; the real
  // column migration 0342 created is `captured_at`, so any drizzle read of this table threw
  // `column "created_at" does not exist`. It never did, because nothing has ever read this table — which
  // is exactly the posture entitlement_reset_archive deliberately does not copy. Found by hitting the
  // identical mistake on the new table, where a reader exists and the test caught it immediately.
  capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow().notNull(),
  benefitSchemeName: text('benefit_scheme_name'),
  groupName: text('group_name').notNull(),
  totalLimitDays: text('total_limit_days'),
  maxDaysPerApplication: text('max_days_per_application'),
  /** Comma-separated member leave-type names, in name order — what the reporter needs to recreate the group. */
  memberLeaveTypes: text('member_leave_types').notNull(),
});

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
    // 491c499f (migration 0353) — the batch this row belongs to, when it was written by the Leave
    // Adjustments screen. NULL for every other writer (accrual, debit, forfeit, recalc, festive grant) and
    // for every row that predates it. A DB CHECK confines it to entry_type='adjustment': reversing a batch
    // sums its rows, and a debit swept in by mistake would be handed back as entitlement.
    adjustmentBatchId: uuid('adjustment_batch_id').references((): AnyPgColumn => leaveAdjustmentBatch.id),
    // db55d08a (migration 0497) — the B/F IMPORT RUN this row belongs to, when it was written by Leave
    // B/F Data Import. NULL for every other writer and for every row that predates it — the same shape,
    // and the same reason, as `adjustmentBatchId` directly above. A DB CHECK confines it to
    // entry_type='adjustment': undoing a run sums its rows and writes the negations, so an accrual or a
    // debit swept in by mistake would be handed back as entitlement. It is ALSO what makes the B/F
    // importer's Replace mode safe — Replace negates only the rows carrying a run id, never the rest of
    // the prior-year balance, which contains real accruals, debits and adjustments.
    bfImportRunId: uuid('bf_import_run_id').references((): AnyPgColumn => leaveBfImportRun.id),
    createdAt: createdAt(),
  },
  (t) => [index('leave_ledger_employment_idx').on(t.employmentId, t.leaveTypeId)],
);

/**
 * 491c499f (migration 0353) — one row per ADJUSTMENT ACTION, not per employee.
 *
 * The festive grant writes one summary DomainEvent whose aggregateId is the TENANT, so afterwards there is
 * no way to find the ledger rows a single action wrote. core/leave-import.ts has the same shape. This table
 * is what makes "reversed as a unit" possible, and it carries the facts that belong to the ACTION rather
 * than to each row it wrote — who ran it, why, which criteria, how many were targeted versus written.
 * Duplicating those onto every ledger row would let them drift.
 *
 * `days` is SIGNED, unlike the festive grant which refuses anything <= 0: an adjustment must be able to
 * take days away as well as give them. classifyLedgerAdjustment already counts a negative human-reason row
 * as a config adjustment, so the read side was ready for it.
 */
export const leaveAdjustmentBatch = pgTable(
  'leave_adjustment_batch',
  {
    id: id(),
    tenantId: tenantId(),
    /** The app_user who ran it — an adjustment is an administrative act, not an employment fact. */
    actorUserId: uuid('actor_user_id').references(() => appUser.id),
    days: numeric('days', { precision: 6, scale: 2 }).notNull(),
    effectiveOn: date('effective_on').notNull(),
    /** Copied onto every ledger row. NOT NULL and non-blank: classifyLedgerAdjustment reads a NULL reason
     *  as 'config', so a blank one is indistinguishable from a configured entitlement change. */
    reason: text('reason').notNull(),
    /** 'criteria' | 'individual' — the same resulting set means different things, and re-running a
     *  criteria batch later can legitimately hit different people. */
    targetMode: text('target_mode').notNull(),
    /** The criteria as posted, so the screen can show what was ASKED rather than what it resolved to. */
    criteria: jsonb('criteria'),
    targetedCount: integer('targeted_count').notNull().default(0),
    writtenCount: integer('written_count').notNull().default(0),
    createdAt: createdAt(),
    /** Reversal is recorded here, never by deleting rows — the ledger is append-only, so a reversal writes
     *  compensating rows and this pair stops the screen offering the same batch twice. */
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversedByUserId: uuid('reversed_by_user_id').references(() => appUser.id),
  },
  (t) => [index('leave_adjustment_batch_tenant_idx').on(t.tenantId, t.createdAt)],
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
    // Allow Unpaid Leave (feedback a7fab30b, migration 0316): how much of `days` the balance could not cover.
    // NULL (every existing row, and every request of a type with allow_unpaid_leave=false) ⇒ fully paid.
    // The request deliberately stays ONE row of the type the employee applied for — the reporter asks for a
    // single application, and the leave history must keep reading as that type — so the paid/unpaid boundary
    // lives here rather than in a second request row (the Emergency-Leave decomposition's approach, which
    // splits the history and is exactly what this item does not want).
    // Two consumers, and they must agree: finalizeLeaveApproval debits only (days - unpaid_days) to the
    // balance, and unpaidDaysByEmployment (core/payroll.ts) deducts unpaid_days through the SAME unpaid route
    // it already uses for whole unpaid-type requests. Anything that reads `days` as "days deducted from the
    // balance" must subtract this.
    unpaidDays: numeric('unpaid_days', { precision: 6, scale: 2 }),
    decidedByEmploymentId: uuid('decided_by_employment_id').references(() => employment.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
    // ── Leave History Data Import (3f15ffdb, migration 0490). Four additive nullable facts a MIGRATED
    //    record carries that a request applied for in this product does not. Every pre-existing row is
    //    NULL / false, so nothing on any screen, sweep or balance changes on the day they ship.
    //
    //    ⚠️ AN IMPORTED RECORD WRITES NO leave_ledger DEBIT, deliberately: the migrated opening balance
    //    already has those days removed, so debiting again would deduct them twice from a figure that is
    //    encashed at termination. Consequences, by design: an imported record is NOT in the "Taken"
    //    figure (derived from ledger debits carrying a source_request_id), and cancelling one credits
    //    nothing back (chargedDays is a sum over that same ledger link, guarded by `> 0`).
    /** The ORIGINATING system's leave reference ("LV/2025/00418"). NULL for every request applied for
     *  here — what those show on screen is a prefix of this row's own uuid, which cannot carry someone
     *  else's number. Unique per tenant where present (partial index, migration 0490): it is the
     *  cross-run duplicate key a re-uploaded migration file is caught by. */
    externalReference: text('external_reference'),
    /** The leave year the record was charged against IN THE OLD SYSTEM. Not derivable from startDate —
     *  a leave period is configurable — so it is stored as stated; a disagreement with the start date's
     *  year is a non-blocking import warning, never a rejection. */
    entitlementYear: integer('entitlement_year'),
    /** When the employee SUBMITTED: a third fact distinct from createdAt (entered) and decidedAt
     *  (approved). NULL for every row created here, where submission and entry are one moment. */
    submittedOn: date('submitted_on'),
    /** TRUE only for a row loaded by Leave History Data Import. The marker exists so a reader or sweep
     *  that must exclude migrated history can do it by construction, rather than inferring it from a
     *  missing row in another table. */
    importedHistory: boolean('imported_history').notNull().default(false),
  },
  (t) => [index('leave_request_employment_idx').on(t.employmentId)],
);

// 3f15ffdb (migration 0490) — one row per Leave History Data Import RUN: the audit trail the ticket's
// point 10 asks for. Modelled on `employee_import_run` (0341) down to the reasoning — the event log stays
// the audit spine and keeps its summary event; this is the READ MODEL for the log on the import screen,
// queried by (tenant, recency) and holding a jsonb error detail that would bloat every event-log scan.
//
// THE UPLOADED FILE IS NEVER STORED. A leave-history file names who was absent, for how long and why
// ("Remark") for the whole workforce. Correcting a rejected row needs the row's IDENTITY (row number,
// employee no., leave reference) and the REASON, which is all `errors` holds — never the row's data.
//
// FOUR counts, not three, because a duplicate is not a failure: on a re-upload of an already-loaded file
// "already there" is the expected answer, not a correction. imported + failed + duplicate = total, and the
// screen's outcome is DERIVED from them — a stored status would be a fifth fact that can disagree.
// RLS (0490) is admin-only: a run is not "about" one person, and its error detail names employees the
// uploader may be the only one entitled to see.
export const leaveHistoryImportRun = pgTable(
  'leave_history_import_run',
  {
    id: id(),
    tenantId: tenantId(),
    /** Who ran it — the person for the display name, the user id so an admin with no person row
     *  (operator / support login) is still attributable. Pinned at write time, not resolved on read. */
    createdByPersonId: uuid('created_by_person_id').references(() => person.id),
    createdByUserId: text('created_by_user_id'),
    /** The uploaded file's name; '' when the rows were pasted rather than uploaded. Not the file. */
    fileName: text('file_name').notNull().default(''),
    totalRows: integer('total_rows').notNull().default(0),
    importedRows: integer('imported_rows').notNull().default(0),
    /** Rows that did not become a leave record for a reason the customer must correct. */
    failedRows: integer('failed_rows').notNull().default(0),
    /** Rows rejected because the leave reference already exists — in this file or in the system. */
    duplicateRows: integer('duplicate_rows').notNull().default(0),
    /** [{ rowNum, employeeNo, leaveReference, errors: [...] }] — identity + reason only. Capped by
     *  core/leave-history-import.ts LEAVE_HISTORY_ERROR_CAP. */
    errors: jsonb('errors').notNull().default([]),
    /** True when more rows were rejected than `errors` holds. The screen says so rather than letting HR
     *  believe a truncated report is the whole story. */
    errorsTruncated: boolean('errors_truncated').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('leave_history_import_run_tenant_created_idx').on(t.tenantId, t.createdAt)],
);

// db55d08a (migration 0497) — one row per LEAVE B/F DATA IMPORT RUN, and it is a BATCH, not only a log.
//
// Modelled on `leave_history_import_run` above for the questions it answers (who loaded what, when, and
// which rows did not go in and why) and on `leave_adjustment_batch` (0353) for the two columns that make
// it a batch: `reversed_at` / `reversed_by_user_id`. That pairing is the whole reason the r362 run table
// could not simply be reused — the reporter asked for "a Rollback batch option, which is very useful
// during migration", and a rollback needs something for the ledger rows to point AT.
//
// ⚠️ WHY NOT `leave_adjustment_batch` ITSELF. Its `days` column is NOT NULL and SINGULAR — one amount
// applied to many people, which is what the Leave Adjustments screen does. A B/F file carries a DIFFERENT
// amount on every line, so there is no one figure to put there; forcing one in would either lie or force
// a batch per line and make "undo the file I just loaded" unanswerable again.
//
// THE UPLOADED FILE IS NEVER STORED (0341's rule, 0490's restatement). Correcting a rejected row needs
// the row's IDENTITY (row number, employee id, leave code, year) and the REASON, which is all `errors`
// holds. The file's NAME is kept because that is what HR recognises a run by.
//
// THREE counts, not four: unlike the record importer there is no cross-run duplicate status, because
// re-running a corrected file is the expected workflow and `import_mode = 'replace'` is what makes it
// safe. imported + failed = total, always, and the screen's outcome is DERIVED from them.
export const leaveBfImportRun = pgTable(
  'leave_bf_import_run',
  {
    id: id(),
    tenantId: tenantId(),
    /** Who ran it — person for the display name, user id so an operator / support login with no person
     *  row is still attributable. Pinned at write time, not resolved on read (0490's rule). */
    createdByPersonId: uuid('created_by_person_id').references(() => person.id),
    createdByUserId: text('created_by_user_id'),
    /** The uploaded file's name; '' when the rows were pasted rather than uploaded. Not the file. */
    fileName: text('file_name').notNull().default(''),
    /** 'replace' | 'add' — the reporter's own two options. Recorded because two runs of the same file
     *  under the two modes do different things to a balance, and "which was this?" has to be answerable
     *  months later from the record rather than from whoever was at the keyboard. */
    importMode: text('import_mode').notNull().default('replace'),
    totalRows: integer('total_rows').notNull().default(0),
    importedRows: integer('imported_rows').notNull().default(0),
    /** Rows that did not become a brought-forward figure for a reason the customer must correct. */
    failedRows: integer('failed_rows').notNull().default(0),
    /** LEDGER rows the run actually wrote, which is NOT `importedRows`: a Replace also writes the
     *  negation of what a previous run put there, and a figure of 0 over nothing writes nothing at all. */
    ledgerRows: integer('ledger_rows').notNull().default(0),
    /** [{ rowNum, employeeId, leaveCode, entitlementYear, errors: [...] }] — identity + reason only.
     *  Capped by core/leave-bf-import.ts LEAVE_BF_ERROR_CAP. */
    errors: jsonb('errors').notNull().default([]),
    /** True when more rows were rejected than `errors` holds. The screen says so rather than letting HR
     *  believe a truncated report is the whole story. */
    errorsTruncated: boolean('errors_truncated').notNull().default(false),
    createdAt: createdAt(),
    /** 0353's rule, restated: a rollback writes COMPENSATING rows and never deletes, and this pair is
     *  what stops the screen offering the same run twice. Both halves move together (DB CHECK). */
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversedByUserId: text('reversed_by_user_id'),
  },
  (t) => [index('leave_bf_import_run_tenant_created_idx').on(t.tenantId, t.createdAt)],
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
    // r293 phase 3 (migration 0467) — the NAMED person a FIXED step belongs to. Non-null for exactly the
    // fixed kinds (`specific_employee`), NULL for every kind that resolves a relationship at decision time
    // from `approver_kind` alone. It has to live on the SNAPSHOT rather than be re-read from the template:
    // the whole reason a template edit cannot disturb leave in flight is that this row is written once at
    // submission and never re-resolved, and a step that went back to the template for its approver would
    // undo exactly that. Enforced as a pair in generateApprovalSteps, not as a check constraint — see the
    // migration's note on why a NOT VALID check on this table would fire on every decide.
    approverEmploymentId: uuid('approver_employment_id').references(() => employment.id),
    // r293 phase 4 (migration 0468) — ANY-ONE APPROVAL. The OTHER approvers who may clear this step, as a
    // jsonb array in the same vocabulary the template stores (a bare kind string, or {kind, employmentId}
    // for a named person). NULL when the level has one approver, which is every level that exists today —
    // and NULL means "only the approver named on this row", i.e. today's behaviour exactly.
    //
    // ONE ROW PER LEVEL, not one per approver: an any-one level is one decision. See 0468's note for what
    // a row per approver would have done to decideLeave's advance, to `stepCount` in every leave list, and
    // to the escalation sweep's per-step dedup. Snapshotted here rather than re-read from the template for
    // the same reason approverEmploymentId is.
    approverAlternates: jsonb('approver_alternates'),
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

// r301 (board 83511d3b, migration 0471) — a cancellation's OWN copy of the approval chain. Mirrors
// leave_approval_step column for column; written once, when the cancellation is requested, by COPYING the
// original request's steps (a split survivor is traced back to the request that holds them). Walked by
// decideLeaveCancellation through the SAME step-advance helper decideLeave uses. No rows ⇒ a single-level
// chain, decided as a cancellation always was. RLS is leave_approval_step's policy verbatim.
export const leaveCancellationStep = pgTable(
  'leave_cancellation_step',
  {
    id: id(),
    tenantId: tenantId(),
    cancellationRequestId: uuid('cancellation_request_id')
      .notNull()
      .references(() => leaveCancellationRequest.id),
    subjectEmploymentId: uuid('subject_employment_id')
      .notNull()
      .references(() => employment.id),
    stepIndex: integer('step_index').notNull(),
    approverKind: text('approver_kind').notNull(),
    approverEmploymentId: uuid('approver_employment_id').references(() => employment.id),
    approverAlternates: jsonb('approver_alternates'),
    status: leaveRequestStatusEnum('status').notNull().default('pending'),
    decidedByEmploymentId: uuid('decided_by_employment_id').references(() => employment.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('leave_cancellation_step_request_idx').on(t.cancellationRequestId, t.stepIndex)],
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
    // R41 72800eda — a rule may scope by GRADE GROUP (the benefit-scheme grade bands, grade_group) instead of
    // (or as well as) an individual job grade. Nullable/wildcard like every other dimension; resolved at
    // submit time by mapping the requester's grade → its group via grade_group_member. Restrict FK so a
    // referenced group can never be silently deleted out from under a live rule.
    gradeGroupId: uuid('grade_group_id').references(() => gradeGroup.id),
    employmentType: employmentTypeEnum('employment_type'),
    minDays: integer('min_days'),
    maxDays: integer('max_days'),
    active: boolean('active').notNull().default(true),
    levels: jsonb('levels').notNull().default(sql`'[]'::jsonb`),
    // 6fadb036 (R17): a rule may draw its chain from a reusable APPROVAL TEMPLATE instead of its own
    // `levels`. When set, the template is the single source of truth for the ordered steps (the row's own
    // `levels` is cleared to []); resolution reads the template's levels. Nullable/FK-restrict — a
    // referenced template can never be hard-deleted. A row with template_id null keeps custom `levels`.
    templateId: uuid('template_id').references((): AnyPgColumn => leaveApprovalTemplate.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    // Only two FULLY-wildcard rows for the same company + leave-type are forbidden (the company default is a
    // singleton). Partially-specific rules may coexist. Mirrors the migration's expression index.
    uniqueIndex('leave_approval_policy_wildcard_uq')
      .on(t.companyId, sql`coalesce(${t.leaveTypeId}, '00000000-0000-0000-0000-000000000000'::uuid)`)
      .where(
        sql`business_unit_id is null and department_id is null and position_id is null and grade_id is null and grade_group_id is null and employment_type is null and min_days is null and max_days is null`,
      ),
  ],
);

// 6fadb036 (R17) — Approval Workflow Enhancement. A REUSABLE approval TEMPLATE: a named, tenant-level
// ordered chain (`levels`, same 'direct_manager' | 'hr_admin' vocabulary as leave_approval_policy) that HR
// maintains in ONE place and assigns to many (company × leave-type) combinations. Assigning a template to a
// combination writes a leave_approval_policy row with `template_id` set (that row's own `levels` is cleared
// to [] — the template is the single source of truth), so the existing "most-specific rule wins" resolution
// is reused unchanged. `is_tenant_default` marks the single org-wide default chain that covers every company
// and leave type with no specific rule (including newly created ones), sitting just above the built-in
// fallback in resolution. Editing a template updates every place it is used; pending requests keep their
// snapshotted steps (ADR-0071 §g). Catalog RLS: readable tenant-wide (the requester resolves the chain in
// its own transaction, same reason leave_approval_policy is tenant-wide) and writable only by an admin.
export const leaveApprovalTemplate = pgTable(
  'leave_approval_template',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    description: text('description'),
    levels: jsonb('levels').notNull().default(sql`'[]'::jsonb`),
    // At most one active row per tenant may carry this flag (partial unique index below) — the org-wide
    // default chain. Cleared automatically when the template is deactivated.
    isTenantDefault: boolean('is_tenant_default').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    // Case-insensitive unique name among a tenant's ACTIVE templates (mirrors leave_type_tenant_code_uq).
    uniqueIndex('leave_approval_template_name_uq')
      .on(t.tenantId, sql`lower(${t.name})`)
      .where(sql`active`),
    // Exactly one org-wide-default template per tenant.
    uniqueIndex('leave_approval_template_default_uq')
      .on(t.tenantId)
      .where(sql`is_tenant_default and active`),
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
// f3148da1 Step 5 — the divisor basis used to value one unpaid-leave / leave-encashment day. Each of the four
// day-divisor modes changes a monthly-payroll figure (calendar days / a fixed divisor / the salary cut-off
// window length / the actual working days in the period).
export type LeaveDivisor =
  | 'calendar_month'
  | 'custom_days'
  | 'cutoff_days'
  | 'working_days';
// f3148da1 Step 5 (R17 gap-fix reinstatement) — the divisor basis for the UNPAID TIME-OFF deduction formula:
// partial-day unpaid absences (half_day_am / half_day_pm / hourly requests, duration_type != 'full_day').
// Supports the four day divisors PLUS a per-time valuation: 'custom_hours' values the absence at
// basic / customHours per hour and 'custom_minutes' at basic / customMinutes per minute (a request's stored
// fractional day converts back to time at the leave module's 8-hour standard day — core/leave
// DEFAULT_STANDARD_HOURS — so an hourly unpaid time-off round-trips to its hour count).
export type TimeOffDivisor = LeaveDivisor | 'custom_hours' | 'custom_minutes';
// 2.1.4 (Custom period) — the cut-off WINDOW mode. 'calendar' (default/absent) = the statutory calendar month
// (1st→last), today's exact behaviour. 'custom' anchors a non-calendar operational window on `anchorDay`: for a
// statutory month M, the window is [anchorDay of M-1 .. (anchorDay-1) of M]. STATUTORY contributions
// (EPF/SOCSO/EIS/PCB) stay calendar-bound BY LAW regardless of the window. c7fdfcf6 (Payroll Schedule) promoted
// this from "stored + validated only" to ACTIVE: the payroll run now selects each transaction type (salary
// proration, overtime, attendance, unpaid leave, claims) from its resolved window — a calendar/absent config
// stays byte-identical to today.
export type CutOffMode = 'calendar' | 'custom';
// c7fdfcf6 (Payroll Schedule) — the five payroll transaction types that each carry an INDEPENDENT cut-off
// window. 'salary' uses the policy's default/base anchor day (cutOff.anchorDay); the other four are
// overridable per-type via cutOff.perType (absent ⇒ inherit the salary/base anchor ⇒ inherit calendar).
export type CutOffType = 'salary' | 'claim' | 'overtime' | 'leave' | 'attendance';
// c7fdfcf6 (Payroll Schedule) — payroll FREQUENCY. 'monthly' (default/absent) = one run per statutory month,
// today's exact behaviour. 'weekly'/'biweekly' are OPERATIONAL run cadences: the WAGES they pay still
// aggregate into ONE statutory month for EPF/SOCSO/EIS/PCB (Malaysian statutory contributions are computed
// per calendar month BY LAW — LHDN MTD, PERKESO Act 4 s.6, monthly EPF returns), so the frequency changes the
// operational cut-off cadence + which transactions fall in each cycle, never the statutory month they contribute in.
export type PayrollFrequency = 'monthly' | 'weekly' | 'biweekly';
// c7fdfcf6 (Payroll Schedule) — the four per-type cut-off anchor days (each 1..28; 'salary' has none, it uses
// the base/frequency anchorDay). Absent ⇒ inherit the base anchor. Reused by both the base cutOff.perType and
// the per-frequency override blocks (cutOff.perFrequency.{weekly,biweekly}.perType).
export type CutOffPerType = { claim?: number; overtime?: number; leave?: number; attendance?: number };
// c7fdfcf6 gap-fix — one frequency's cut-off anchors: the base (salary) anchor day + optional per-type
// overrides. When the schedule's frequency is weekly/biweekly, that frequency's block (if present) takes
// precedence over the base cutOff anchors, so each payroll frequency carries its OWN cut-off periods.
export type CutOffAnchors = { anchorDay?: number; perType?: CutOffPerType };
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
  // 1f — divisor selectors for the three Step-5 leave formulas (default calendar_month on each).
  // `unpaidLeaveDivisor` (Unpaid Leave Deduction Formula) values FULL-DAY unpaid-leave days.
  // `unpaidTimeOffDivisor` (Unpaid Time Off Deduction Formula) values PARTIAL-DAY unpaid absences (half-day /
  // hourly requests, duration_type != 'full_day'); absent ⇒ those days pool with the unpaid-leave path
  // exactly as before (byte-identical). It additionally supports 'custom_hours' / 'custom_minutes' per-time
  // valuation — see unpaidTimeOffDailyRate.
  // `encashmentDivisor` (Leave Encashment Formula) sets the ORP day-divisor used to value encashed annual
  // leave in the leaver advisory (default = the statutory 26-day ordinary-rate divisor; see
  // encashmentDivisorDays).
  leave?: {
    unpaidLeaveDivisor?: LeaveDivisor;
    unpaidTimeOffDivisor?: TimeOffDivisor;
    encashmentDivisor?: LeaveDivisor;
    customDays?: number; //                     used when a *_Divisor is 'custom_days'
    customHours?: number; //                    used when unpaidTimeOffDivisor is 'custom_hours'
    customMinutes?: number; //                  used when unpaidTimeOffDivisor is 'custom_minutes'
    // e2632276 — DEDUCT ABSENCE DAYS. Absent/false (the shipped default, and what every existing row
    // holds) ⇒ no absence is counted and every figure is byte-identical to a pre-flag run. True ⇒ a
    // scheduled working day with no attendance record, or one marked Absent, deducts at the SAME daily rate
    // as an unpaid-leave day — `unpaidLeaveDivisor` above, rounded once on the amount — and, like unpaid
    // leave, BEFORE EPF/SOCSO/EIS/PCB are worked out. Approved leave, public holidays and rest days are
    // never counted, and the employee's roster beats the company calendar (core/absence-days.ts).
    // It lives on the POLICY, not the company: resolveAssignedPolicy answers it per employment.
    deductAbsentDays?: boolean;
  };
  // 2.1.4 (Custom period) — the operational cut-off WINDOW. Default (absent / mode='calendar') = the statutory
  // calendar month, byte-identical to today. mode='custom' records an anchor day so the window runs
  // [anchorDay of M-1 .. (anchorDay-1) of M] for statutory month M. anchorDay ∈ 1..28 (avoids the 29–31
  // month-length trap). c7fdfcf6 (Payroll Schedule): the kernel now READS this window to select each transaction
  // type (salary proration + the four perType windows below); statutory months stay calendar-bound by law.
  cutOff?: {
    mode?: CutOffMode;
    anchorDay?: number; //                      day-of-month the custom window opens (1..28), when mode='custom'
    // c7fdfcf6 (Payroll Schedule) — PER-TYPE cut-off anchor days. Each 1..28; an absent type inherits the base
    // `anchorDay` (the salary/default window). All absent + mode='custom' ⇒ every type shares the base window;
    // mode='calendar'/absent ⇒ NONE apply (calendar month, byte-identical). 'salary' has no perType key — it
    // always uses the base `anchorDay`. These finally give the five company_payroll_config.*_cut_off_day columns
    // a policy-level counterpart in the resolution chain (policy perType → policy anchorDay → company column → calendar).
    perType?: CutOffPerType;
    // c7fdfcf6 gap-fix — PER-FREQUENCY cut-off overrides. When the schedule's `frequency` (below) is 'weekly'
    // or 'biweekly', that frequency's block (anchorDay + perType) takes precedence over the base anchors above,
    // so distinct cut-off windows can be configured independently for Weekly vs Bi-Weekly vs Monthly (the base
    // anchors are the Monthly window). Absent ⇒ the frequency inherits the base window. Only applied when
    // mode='custom' (a calendar mode stays byte-identical regardless of frequency).
    perFrequency?: {
      weekly?: CutOffAnchors;
      biweekly?: CutOffAnchors;
    };
  };
  // c7fdfcf6 (Payroll Schedule) — payroll FREQUENCY. Absent/'monthly' ⇒ today's single monthly run. 'weekly'/
  // 'biweekly' are OPERATIONAL run cadences: the payroll run reads this to GENERATE the frequency's ordered
  // cut-off periods (see payrollScheduleFor) that tile the statutory month, and each frequency resolves its own
  // cut-off windows via `cutOff.perFrequency` above. Statutory contributions (EPF/SOCSO/EIS/PCB) stay
  // calendar-month-aggregated BY LAW regardless of the run cadence (see PayrollFrequency).
  frequency?: PayrollFrequency;
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
    // 61d77e82 — optional Policy Code (metadata for the admin catalog display + search). Nullable; NULL =
    // today's behaviour. Never read by the payroll kernel (additive, calc-neutral).
    code: text('code'),
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

// Employee ID Auto Running Number Setup (feedback 3d0031e6) — a configurable auto-numbering rule for the
// employee_code assigned at hire. Modeled on payroll_policy. company_id is NULLABLE: NULL = GLOBAL scope
// (one Employee-ID sequence shared across every company in the tenant); a set company_id = a COMPANY-SPECIFIC
// sequence. The two partial unique indexes enforce ONE ACTIVE config per scope (one global, one per company).
// generateEmployeeCode() (core/employee-id-config.ts) resolves the applicable ACTIVE config — company-specific
// first, else global — and atomically advances current_running_number (row-locked UPDATE ... RETURNING), then
// formats prefix + zero-padded number. The tenant-wide employment_employee_code_uq index is the collision net.
// RLS: readable tenant-wide (so the generator resolves under the hiring session), writable only by an admin
// (see 0209_employee_id_config.sql). Additive + backward compatible: with NO active config the legacy EMP-####
// counter (core/comp.ts nextEmployeeCode) still runs, so seeds/tests are byte-identical.
export const employeeIdConfig = pgTable(
  'employee_id_config',
  {
    id: id(),
    tenantId: tenantId(),
    // NULL = GLOBAL scope (shared across all companies). Set = company-specific sequence. ON DELETE no action
    // (a config is a tenant/company-level setting, deleted explicitly via the admin screen, never cascaded).
    companyId: uuid('company_id').references(() => company.id),
    // Template enhancement (R45 7bf025f0): an optional human label so several numbering formats can run side
    // by side (e.g. "Malaysia Employee", "HQ Staff"). NULL = unnamed (all pre-existing configs).
    templateName: text('template_name'),
    // The house prefix (e.g. EMP, STAFF, KL). Uppercased + shape-validated (^[A-Z0-9-]+$) in the service.
    prefix: text('prefix').notNull(),
    // Template enhancement (R45 7bf025f0): text appended AFTER the zero-padded number (e.g. EMP0001MY).
    // Defaults to '' so existing configs format exactly as before. prefix + number_length + suffix ≤ 9.
    suffix: text('suffix').notNull().default(''),
    // First number to ISSUE (e.g. 1 → "0001"). current_running_number tracks the LAST issued number.
    startNumber: integer('start_number').notNull().default(1),
    // Zero-pad width (e.g. 4 → "0001"). prefix.length + number_length + suffix.length must be ≤ 9 (cap).
    numberLength: integer('number_length').notNull().default(4),
    // Retained for backward compatibility. The template enhancement (R45 7bf025f0) drops the increment as a
    // configurable field — new templates advance by +1 — but existing rows keep their stored value.
    increment: integer('increment').notNull().default(1),
    // Template enhancement (R45 7bf025f0): whether HR may hand-key an Employee ID for this scope. Persisted
    // + event-logged now; the employee-profile edit gating that consumes it is a follow-up.
    allowManualOverride: boolean('allow_manual_override').notNull().default(false),
    // Last issued running number (0 = none issued yet → the first hire gets start_number).
    currentRunningNumber: integer('current_running_number').notNull().default(0),
    status: text('status').notNull().default('active'), // 'active' | 'inactive'
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // ONE ACTIVE per scope. Global: at most one active company-NULL config per tenant. Company: at most one
    // active config per (tenant, company). Partial so inactive rows never collide (an admin can keep archived
    // configs around). Postgres treats NULLs as distinct, so the company index excludes NULL company rows.
    uniqueIndex('employee_id_config_global_active_uq')
      .on(t.tenantId)
      .where(sql`company_id is null and status = 'active'`),
    uniqueIndex('employee_id_config_company_active_uq')
      .on(t.tenantId, t.companyId)
      .where(sql`company_id is not null and status = 'active'`),
    index('employee_id_config_tenant_status_idx').on(t.tenantId, t.status),
  ],
);

// HR-Admin Dashboard Card Master (feedback 1586d2f5) — a tenant-scoped catalog of the dashboard cards HR
// can maintain: which exist, their type/status, whether employees may add them, whether they show by
// default, whether they are mandatory (non-removable), and their display order. MASTER only; the employee
// dashboard customizer (feedback 578a2fcf) reads from it. card_key is a STABLE id binding a row to the
// concrete renderer (the R39 block/card set — see lib/dashboard-layout.ts + lib/dashboard-cards.ts). RLS:
// readable tenant-wide, writable admin-only (tenant-level config, no company scope). Additive + backward
// compatible: with no rows the current hardcoded dashboard is unchanged.
export const dashboardCardConfig = pgTable(
  'dashboard_card_config',
  {
    id: id(),
    tenantId: tenantId(),
    // Stable renderer binding (e.g. 'leaveBalance', 'plannedAbsences'). Unique within a tenant.
    cardKey: text('card_key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    cardType: text('card_type').notNull().default('information'), // 'information' | 'action' | 'shortcut'
    status: text('status').notNull().default('active'), // 'active' | 'inactive'
    // Can an employee ADD this card during dashboard customization (578a2fcf)?
    employeeSelectable: boolean('employee_selectable').notNull().default(true),
    // Does the card appear by default on a fresh employee dashboard?
    defaultDisplay: boolean('default_display').notNull().default(false),
    // Mandatory: the employee may not REMOVE it (implies default_display, enforced in the service).
    mandatory: boolean('mandatory').notNull().default(false),
    displayOrder: integer('display_order').notNull().default(0),
    // Optional click-through target (for shortcut/action cards).
    href: text('href'),
    // Role dimension (feedback 9606c59f): which dashboard roles (employee | manager | hr_admin, per
    // lib/dashboard-cards resolveDashboardRole) see/arrange this card. Pre-existing rows are the employee
    // card set → default '{employee}'.
    audience: text('audience').array().notNull().default(sql`'{employee}'::text[]`),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('dashboard_card_config_tenant_key_uq').on(t.tenantId, t.cardKey),
    index('dashboard_card_config_tenant_status_idx').on(t.tenantId, t.status),
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
    // ⚠️ AN RLS FIX RATHER THAN AN ORDINARY SPEED-UP — see migration 0455 for the measurement. Without
    // it the dashboard's activity feed took 4.1 SECONDS on production data for everyone who is not an
    // admin, because "read the 8 newest" had to sort the whole table and therefore had to run this
    // table's read policy — app.can_see_employment(), a recursive SECURITY DEFINER function — once per
    // row. Ordering by time lets the planner stop at 8, so the policy runs ~169 times, not 10,276.
    // `.desc()` is convention, not necessity: an ascending index gives Index Scan Backward at the same
    // cost. core/read.ts's 30-day window is the other half of the fix and must not be removed alone.
    index('domain_event_recent_idx').on(t.tenantId, t.occurredAt.desc()),
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
    // Employee-specific salary structure (feedback 642ecc55, migration 0290; ADR-0078 supersedes the
    // ADR-0064 "policy owns pay mode" decision). pay_mode reuses payroll_policy_type (no second enum);
    // payment_term is text validated against the PayrollFrequency TS union in core/comp.ts (a parallel pg
    // enum would need a migration per new term). Both are NOT NULL (backfilled from the resolved policy /
    // company default in 0290) — there is deliberately NO nullable "inherit from the policy" fallback,
    // because payroll_policy is mutable and a live fallback would rewrite history on reprocess.
    // basic_salary KEEPS its monthly-equivalent semantics for every statutory/derived calculation; the
    // nullable rate_amount (per-day / per-hour rate) is what pays a non-monthly employee. NULL rate is the
    // correct, expected state for a monthly employee.
    // DEFAULT 'monthly' is a plain constant (today's only behaviour), NOT a policy fallback — it exists so
    // a raw INSERT (tests, tooling) stays valid; core/comp.ts always writes explicit values.
    payMode: payrollPolicyTypeEnum('pay_mode').notNull().default('monthly'),
    paymentTerm: text('payment_term').notNull().default('monthly'),
    rateAmount: numeric('rate_amount', { precision: 12, scale: 2 }),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    // Free-text reason for the change (e.g. "annual increment", "merit adjustment"). Nullable — historical
    // rows and system/import writes leave it NULL (feedback 87c82b18, migration 0162).
    remarks: text('remarks'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    // Last in-place edit of this row (Edit Salary Record flow, feedback 87c82b18, migration 0163). NULL
    // until the row is edited; "Last Updated By" is derived from the latest compensation.updated event.
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('compensation_employment_idx').on(t.employmentId, t.validFrom)],
);

// EPF contribution mode per employee (Wave 2B, statutory-aligned). auto = statutory Third Schedule;
// voluntary_excess = i-Topup election (KWSP Form 17A/18A) at a rate AT OR ABOVE statutory, per side;
// exempt = no contribution, valid ONLY for legitimately-exempt employees (never to drop a mandatory
// employee below the s.43 floor). Sourced in docs/wave2-payroll-design.md.
//
// manual_amount (item 70b14723, migration 0491) — the employee's EPF is an exact RINGGIT FIGURE typed on
// their record, in `epf_employee_amount` / `epf_employer_amount`, used by every Process and Reprocess.
// THE THREE CATEGORIES THE TICKET NAMES ARE THE THREE COMBINATIONS of (employee amount set, employer
// amount set) and are DERIVED at render time — the same rule that makes a `voluntary_excess` row with a
// null employer rate "Semi-Auto" without storing the word. One label, not three.
//
// ⚠️ ADR-0046 SAID THERE WAS NO SUCH ELECTION AND THAT CLAIM IS NOW RETIRED, not deleted: it read "KWSP
// has no fixed-amount election", which is true of what KWSP's FORMS offer and was taken to mean the
// system must not be able to state one. It cannot survive the pre-1998 grandfathered member, whom
// docs/architecture/STATUTORY-SOURCES.md §2 already flags as unhandled ("pre-1998 legacy (5.5% / 6-6.5%)
// is NOT auto-applied"): those legacy figures are RATES, yet the rate election cannot carry them either
// because voluntary_excess is max(elected, statutory) and can only raise. A typed amount is the only
// affordance there is. See docs/adr/0087-epf-manual-amount-categories.md.
export const epfModeEnum = pgEnum('epf_mode', ['auto', 'voluntary_excess', 'exempt', 'manual_amount']);

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
    // Item e3ce0d4d — NULLABLE (relaxed from NOT NULL by migration 0212): a Malaysian employee is identified
    // by their MyKad IC, a non-Malaysian by their passport (below), so a non-Malaysian identity row carries no IC.
    icNumber: text('ic_number'),
    // Item e3ce0d4d — passport identification. All nullable/additive. Item 55865c32 relaxed the either/or:
    // EVERY employee (Malaysian included) may maintain a passport block alongside their NRIC; nationality only
    // drives which document is mandatory. Foundation for passport-expiry reminders / work-permit tracking.
    passportNumber: text('passport_number'),
    passportIssueDate: date('passport_issue_date'),
    passportExpiryDate: date('passport_expiry_date'),
    /**
     * e4b541c6 (migration 0450) — the two columns the CP39 has always had space for and the schema could
     * not fill. `lib/cp39-form.ts` carried both as permanently-empty fields with headers explaining why.
     *
     * `oldIcNumber` is CP39's `No. K/P Lama`, free text because the pre-1990 format is not uniform and a
     * validator would refuse valid cards.
     *
     * ⚠️ `passportIssuingCountryCode` IS NOT DERIVED FROM `passportIssuingCountry` ABOVE. That field is
     * fed from the tenant's NATIONALITY option list, so it holds a demonym ("Malaysian"); lib/countries.ts
     * maps ISO codes to country NAMES ("Malaysia"). Turning one into the other by guesswork would print an
     * invented country code on a tax document. HR picks the code; nothing infers it.
     */
    oldIcNumber: text('old_ic_number'),
    passportIssuingCountryCode: text('passport_issuing_country_code'),
    passportRemark: text('passport_remark'),
    // Item 55865c32 — the passport's issuing country (free text from the international country picker; the
    // Combobox's legacy-value tolerance renders any stored value). Optional — not part of the mandatory trio.
    passportIssuingCountry: text('passport_issuing_country'),
    epfNumber: text('epf_number'),
    socsoNumber: text('socso_number'),
    taxNumber: text('tax_number'),
    // PCB (MTD) inputs. taxCategory: 1=single, 2=married/spouse not working, 3=married/spouse working.
    taxCategory: integer('tax_category').notNull().default(1),
    taxCircumstance: text('tax_circumstance').$type<'single'|'spouse_not_working'|'spouse_working'|'widow_divorced'|'none'>(),
    taxApplicabilityEpoch: integer('tax_applicability_epoch').notNull().default(0),
    numChildren: integer('num_children').notNull().default(0),
    // Item 8b5334db — how num_children is maintained. 'manual' = HR keys it (today's behaviour); 'auto' derives
    // the eligible child count from the Family register and surfaces it for HR CONFIRMATION into num_children
    // (never silent — respects the employee_dependent benefits-vs-tax firewall). Payroll always reads num_children.
    childReliefMode: text('child_relief_mode').notNull().default('manual'),
    // Non-residents pay flat 30% MTD (LHDN spec §D.a) — no reliefs, no accumulator method.
    isResident: boolean('is_resident').notNull().default(true),
    // Item 8b5334db — richer tax residency than the boolean above (which stays in sync as the legacy source of
    // truth). resident ⇒ full computerised MTD; non_resident ⇒ flat 30%; rep (Returning Expert Programme) +
    // knowledge_worker and c_suite ⇒ approved annual incentive method at 15%. HR confirms eligibility.
    taxResidency: text('tax_residency').notNull().default('resident'),
    // Item 8b5334db — employer bears the employee's PCB: the tax is still computed + reported in full, but its
    // amount is funded from employer cost instead of deducted from the employee's net (same plumbing as
    // employer_bears_socso/eis). Default false ⇒ byte-identical. LHDN tax-on-tax gross-up is a follow-up.
    employerBearsTax: boolean('employer_bears_tax').notNull().default(false),
    // "Subject to EIS" (item 5a461b99 reuses this existing flag — no duplicate column).
    eisEligible: boolean('eis_eligible').notNull().default(true),
    // SOCSO / EIS contribution-category override (item a7271737). Today the SOCSO category and EIS eligibility
    // are DERIVED per-employee in the kernel from age + EPF citizenship; these persisted overrides let HR pin a
    // scheme by hand. socso_category: 'auto' keeps the derivation; 'first'/'second' force the band; 'none' zeroes
    // the SOCSO leg. eis_category: 'auto' keeps the derivation; 'none' zeroes the EIS leg. Both default 'auto' ⇒
    // byte-identical. The category is the single per-scheme control: the setter derives the legacy subject_to_socso
    // / eis_eligible booleans from it (= category !== 'none') so every downstream reader stays unchanged.
    socsoCategory: text('socso_category').notNull().default('auto'),
    eisCategory: text('eis_category').notNull().default('auto'),
    // SOCSO & EIS statutory controls (item 5a461b99). subject_to_* gate whether a scheme is contributed at
    // all; employer_bears_* keep the scheme computed + reported in full but fund the EMPLOYEE share from
    // employer cost instead of deducting it from net pay. subject_to_skbbk defaults false for NEW rows
    // (reporter-approved); migration 0198 backfills existing rows to true so their live SKBBK is preserved.
    subjectToSocso: boolean('subject_to_socso').notNull().default(true),
    subjectToSkbbk: boolean('subject_to_skbbk').notNull().default(false),
    employerBearsSocso: boolean('employer_bears_socso').notNull().default(false),
    employerBearsEis: boolean('employer_bears_eis').notNull().default(false),
    employerBearsSkbbk: boolean('employer_bears_skbbk').notNull().default(false),
    // Item 0d9bb2da — employer bears the employee's EPF contribution: the EPF employee + employer legs are
    // still computed + reported in full (KWSP file + EPF report unchanged), but the employee's EPF share is
    // funded from employer cost instead of deducted from net (same plumbing as employer_bears_socso/eis/tax).
    // Default false ⇒ byte-identical. LHDN perquisite gross-up (employer-paid EPF as a benefit) is a follow-up.
    employerBearsEpf: boolean('employer_bears_epf').notNull().default(false),
    // Feedback 0df0c635 — Others Statutory card: per-employee "Subject to HRDF". NULLABLE tri-state:
    // NULL = follow the company's HRDF registration default (registered ⇒ subject, not_registered ⇒ not) —
    // today's behaviour, so pre-existing rows are byte-identical; explicit false excludes the employee's
    // base from the HRD Corp levy entirely; explicit true keeps it in (the company band still sets the rate).
    subjectToHrdf: boolean('subject_to_hrdf'),
    // EPF citizenship status — drives the Third Schedule rule (Part A / Part E / non-citizen 2%/2%).
    epfCitizenship: epfCitizenshipEnum('epf_citizenship').notNull().default('citizen'),
    // EPF contribution mode (Wave 2B). For 'voluntary_excess' the elected per-side rates (decimals,
    // e.g. 0.1500 = 15%) apply AT OR ABOVE the statutory rate; null = that side stays statutory.
    // 'exempt' zeroes both sides (legitimately-exempt employees only). 'auto' ignores the rates.
    epfMode: epfModeEnum('epf_mode').notNull().default('auto'),
    epfEmployeeRate: numeric('epf_employee_rate', { precision: 5, scale: 4 }),
    epfEmployerRate: numeric('epf_employer_rate', { precision: 5, scale: 4 }),
    // Item 70b14723 (migration 0491) — THE TYPED MONTHLY EPF AMOUNTS, in RM, read ONLY when epf_mode is
    // 'manual_amount'. NULL on a side ⇒ that side is still computed by the rule ('a blank side stays
    // statutory', the rule the elected rates above already follow), which is what makes the ticket's three
    // categories the three combinations of these two columns rather than three enum labels.
    //
    // THE AMOUNT IS APPLIED INSIDE THE PACK'S EPF COMPUTATION (localization/my/payroll.ts `epf` /
    // `epfContribution`), never after the kernel's `stComputed`. That placement is what makes a MONTHLY
    // amount charge ONCE across a regular + bonus pair: `deltaStat` takes the month with and without this
    // run's additional remuneration, and for a constant M both sides are M, so an additional run charges
    // max(0, M − M) = 0. It also keeps K₁ + Kₜ = the employee EPF exactly, because Kₜ is defined as the
    // month's lookup minus the same lookup on the normal wage alone and for a constant that difference is
    // 0 by construction.
    //
    // BELOW THE STATUTORY SCHEDULE IS ALLOWED, RECORDED AND WARNED IN WORDS — not refused. The precedent
    // is the product's own on the identical figure (`saveStatutoryAdjustment` refuses only a negative),
    // and the lawful case is the pre-1998 grandfathered member. A NEGATIVE is refused at entry, because
    // `lib/kwsp-borang-a-file.ts`'s `cents()` throws on one at file-generation time — far too late.
    epfEmployeeAmount: numeric('epf_employee_amount', { precision: 12, scale: 2 }),
    epfEmployerAmount: numeric('epf_employer_amount', { precision: 12, scale: 2 }),
    // Item 70b14723 — the operator's MANDATORY words for why this employee's EPF is a fixed figure.
    // Required by `resolveEpfElection` for a manual_amount row, exactly as `saveStatutoryAdjustment`
    // requires one per per-run override: a figure that overrules a contribution schedule has to carry
    // somebody's reasons or an auditor is left with an unexplained number. Nullable in the DDL because it
    // is meaningless for the other three modes, and because how a row is decided belongs in the service
    // that decides it (CLAUDE.md §6: keep the column nullable, enforce in the writer).
    epfManualReason: text('epf_manual_reason'),
    bankName: text('bank_name'),
    bankAccountNo: text('bank_account_no'),
    // Custom payment holder (item ef720d3a). Where a banking restriction requires an employee's salary to be
    // paid into a THIRD party's account (spouse / authorised person), these opt-in switches surface a custom
    // holder name / identification that the disbursement path uses as the payee instead of the employee.
    // Both flags default OFF ⇒ payment resolves to the employee (backward-compatible). Payee identity only —
    // never affects any pay figure, tax, or statutory calculation.
    enableCustomHolderName: boolean('enable_custom_holder_name').notNull().default(false),
    customHolderName: text('custom_holder_name'),
    enableCustomHolderId: boolean('enable_custom_holder_id').notNull().default(false),
    customHolderId: text('custom_holder_id'),
    // TP3 / opening balances for PCB accumulators (ADR-0014): prior-employment (or pre-migration)
    // year-to-date figures, applied only when tp3Year matches the pay-period year. Per LHDN spec
    // §E.10 these feed the formula as (Y−K), K, X, Z and ∑LP and never appear on payslips or the EA form.
    //
    // FIVE, NOT FOUR, SINCE MIGRATION 0488 (item 20837372). The MTD specification's printed page 22
    // names exactly four variables the TP3 feeds — "(Y–K*), X, Z and ∑LP" — and `tp3Lp` is the fourth.
    // It is Form TP3 SECTION D (D1–D17) totalled: the reliefs the employee already claimed through the
    // previous employer. Before 0488 there was no column, Section D reached nothing, and every new
    // joiner with a Section D was OVER-deducted — ∑LP is subtracted inside P, so a zero raises the tax.
    tp3Year: integer('tp3_year'),
    tp3NetRemuneration: numeric('tp3_net_remuneration', { precision: 12, scale: 2 }),
    tp3EpfClaimed: numeric('tp3_epf_claimed', { precision: 12, scale: 2 }),
    tp3PcbPaid: numeric('tp3_pcb_paid', { precision: 12, scale: 2 }),
    tp3ZakatPaid: numeric('tp3_zakat_paid', { precision: 12, scale: 2 }),
    tp3Lp: numeric('tp3_lp', { precision: 12, scale: 2 }),
    /**
     * SIX, AND THE SIXTH IS NOT A VARIABLE IN THE FORMULA — it is the opening balance of a LEDGER
     * (item 1785b766, migration 0489).
     *
     * `{ PCB_TRA_BUSINESS: 6000, … }` — how much of each ANNUAL, PER-EMPLOYEE PCB exemption cap the
     * PREVIOUS employer already spent, derived from Form TP3 Section C2 by `core/tp3.ts`'s
     * `deriveAccumulatorSeed` and governed by the same `tp3_year` as the five columns above.
     * `core/payroll.ts` opens `priorUsed` with it, so `roomFor(code, cap) = cap − priorUsed − used`
     * hands this employer's pay items only the REMAINING headroom.
     *
     * WHY IT IS NOT FIVE MORE NUMERIC COLUMNS: the set of codes is a PACK TABLE
     * (`MY_PCB_EXEMPTION_CODES`), not a statutory constant of the schema — a country pack with a
     * different exemption list is the normal case under ADR-0080, and a column per code would put the
     * pack's taxonomy into the kernel's DDL. The map's keys are exactly the keys the payslip ledger
     * already stores in `payslip.statutory.exemptionUsed`, so both halves of the year speak one language.
     *
     * NULL = nothing recorded, read as an empty map ⇒ full annual headroom, which is what every row
     * meant before 0489 and remains correct for everyone with no TP3.
     */
    tp3ExemptionUsed: jsonb('tp3_exemption_used').$type<Record<string, number>>(),
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
    // Item d64d0df4 (migration 0341) — the employee is a registered disabled individual (OKU). A fact about
    // the PERSON, so it is tenant data and belongs here. The RELIEF AMOUNT it entitles them to is statutory
    // and deliberately does NOT live here: it is a deduction in the country pack's ruleset
    // (localization/my/statutory-tables.ts `MY_RELIEFS.disabledIndividual`, applied by pcbMonth), exactly like
    // the individual / spouse / per-child deductions. Default false ⇒ every pre-existing row keeps today's PCB
    // byte-for-byte; only an employee an admin explicitly flags starts claiming the extra deduction.
    disabledIndividual: boolean('disabled_individual').notNull().default(false),
    // Item d64d0df4 (migration 0356) — the employee's SPOUSE is a registered disabled individual (OKU),
    // which entitles the EMPLOYEE to a further deduction on top of the spouse deduction. Same separation
    // as the column above: the circumstance is tenant data, the AMOUNT is statutory
    // (`MY_RELIEFS.disabledSpouse`). Like the spouse deduction it is claimable only by a category-2
    // employee (married, spouse not working); it is stored and shown for everyone else but moves nothing.
    // Default false ⇒ every pre-existing row keeps today's PCB byte-for-byte.
    disabledSpouse: boolean('disabled_spouse').notNull().default(false),
    // Item d64d0df4 (migration 0356) — the child-relief GRID keyed directly against the employee, read by
    // payroll ONLY when child_relief_mode = 'auto_table'. Shape:
    //   { "<s.48 category>": { "full": <count at 100%>, "half": <count at 50%> }, ... }
    // over the five LHDN s.48 categories (under_18 / study_preu / study_tertiary / disabled /
    // disabled_study). A COLUMN rather than a child table, following the precedent recorded in migration
    // 0250: it inherits this row's RLS unchanged and lands whole in the existing employee.tax.updated
    // before/after payload, so no new policy and no new audit path is introduced. num_children stays the
    // whole HEAD COUNT (Form E / CP8D / EA all still read it) — this grid produces an AMOUNT alongside it,
    // it never replaces it. NULL = not configured (every pre-existing row).
    childReliefTable: jsonb('child_relief_table'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('employee_statutory_my_person_uq').on(t.personId),
    check('employee_statutory_my_tax_applicability_epoch_check', sql`${t.taxApplicabilityEpoch} >= 0`),
    check('employee_statutory_my_tax_circumstance_check', sql`${t.taxCircumstance} IS NULL OR ${t.taxCircumstance} = 'none' OR (${t.taxCircumstance} = 'single' AND ${t.taxCategory} = 1) OR (${t.taxCircumstance} = 'spouse_not_working' AND ${t.taxCategory} = 2) OR (${t.taxCircumstance} IN ('spouse_working', 'widow_divorced') AND ${t.taxCategory} = 3)`),
    // Item e3ce0d4d — PARTIAL: real ICs stay unique per tenant, but multiple non-Malaysian rows carrying a
    // null IC (identified by passport instead) don't collide.
    uniqueIndex('employee_statutory_my_ic_uq').on(t.tenantId, t.icNumber).where(sql`ic_number is not null`),
  ],
);

// HRD Corp (HRDF) registration band per employer (Wave 2A, PSMB Act 2001). not_registered = below
// the headcount threshold / not registered (no levy); mandatory = 10+ Malaysian employees (1%);
// optional = 5–9 who opt to register (0.5%). Sourced in docs/wave2-payroll-design.md.
export const hrdfStatusEnum = pgEnum('hrdf_status', ['not_registered', 'mandatory', 'optional']);

// R46 orgbank (84719377) — the `disbursement_bank` pgEnum (maybank/cimb/public_bank/rhb) is GONE. The
// company bank column is now plain text carrying a key from the shared Malaysian bank master
// (lib/my-banks.ts), which is the same list the employee bank picker reads and which carries each bank's
// BNM routing code. The four historical enum values are byte-identical to the first four master keys, so
// existing rows and every historical domain event still read the same. Whether a bulk salary-disbursement
// file can be BUILT for a bank is `MyBank.disbursementFormat` in the master, not the storage value.

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
// and payment basis. c7fdfcf6 (Payroll Schedule): the per-type cut-off day columns are now the COMPANY-LEVEL
// fallback that DRIVES which transactions a payroll run picks up (see the column comments below) — no longer
// display-only metadata. An absent row / null column ⇒ today's calendar-month defaults. RLS: company-scoped
// admin (is_admin_for), mirroring company_bank_profile.
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
    // r79a (4fb8b75a step 2): `payment_basis` is GONE (migration 0324). It was written by the config form
    // and read by nothing but the <select> that wrote it — the vestigial ADR-0035 ancestor of
    // compensation.pay_mode / payment_term / rate_amount (ADR-0078), which carry the real, per-employee,
    // effective-dated concept.
    // Per-purpose cut-off days. c7fdfcf6 (Payroll Schedule) promoted these from pure metadata into the
    // COMPANY-LEVEL fallback of the cut-off resolution chain (policy perType → policy anchorDay → THESE columns
    // → calendar month): when an employment's payroll policy sets no custom cut-off, the payroll run pulls each
    // transaction type from the window anchored on the matching column here (cutOffDay = salary). null = the
    // calendar month (today's exact behaviour). Statutory contributions still aggregate per calendar month by law.
    overtimeCutOffDay: integer('overtime_cut_off_day'), // day of month OT inputs close (1–31); null = month-end
    claimCutOffDay: integer('claim_cut_off_day'), // day of month claim inputs close (1–31); null = month-end
    unpaidLeaveCutOffDay: integer('unpaid_leave_cut_off_day'), // day of month unpaid-leave inputs close (1–31); null = month-end
    attendanceCutOffDay: integer('attendance_cut_off_day'), // day of month attendance inputs close (1–31); null = month-end
    // r79a (4fb8b75a step 3): `probation_months` and `review_reminder_days` MOVED to `company` (migration
    // 0324) — hiring and employment-review settings that never had a payroll reader. `default_currency`
    // MOVED to the pre-existing `company.currency`, collapsing the two company-level currency fields into
    // one. See the `company` table for all three.
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

// Per-entity bank account / disbursement profile (ADR-0031; reworked by R46 orgbank 84719377). Holds the
// BANK-ISSUED corporate/organisation ID + employer debit account every bulk-payment file header needs,
// plus the fuller account master data (account name, type, branch, SWIFT, currency).
//
// R46: a company may now hold SEVERAL accounts, INCLUDING more than one at the same bank — the old
// uniqueIndex (companyId, bank) is dropped (migration 0275). Rows are therefore identified by `id`, and
// the write path is update-by-id / insert-new rather than an ON CONFLICT upsert. `accountLabel` is the
// human handle that distinguishes two accounts at the same bank.
//
// These are sensitive employer credentials — RLS restricts both read and write to company-scoped admins
// (latest policy: migration 0099, can_admin_payroll_for).
export const companyBankProfile = pgTable(
  'company_bank_profile',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    // R46: plain text carrying a key from the shared bank master (lib/my-banks.ts). Was the 4-value
    // `disbursement_bank` pgEnum; the four legacy values are master keys verbatim, so no data moved.
    bank: text('bank').notNull(),
    // Bank-issued: Maybank Corporate ID / CIMB 5-digit Autopay Org Code / RHB 6-digit Corporate ID /
    // Public Bank 3-char Org Code. Free text — each bank's shape differs; validated at file-build time.
    corporateId: text('corporate_id').notNull(),
    debitAccountNo: text('debit_account_no').notNull(),
    // Organisation name as registered with the bank (header field). Falls back to the company name in UI.
    orgName: text('org_name'),
    // Default transaction rail; RENTAS only matters for ≥ RM10k single payments (rare in payroll).
    // R46: the picker is HIDDEN from the form (the reporter asked for it off the screen) but the column
    // STAYS and keeps its 'IBG' default — RENTAS is not decorative and dropping it would break large
    // single payments. Re-expose the select when a RENTAS flow needs it.
    txnType: text('txn_type').notNull().default('IBG'),
    // ── R46 orgbank: fuller account master data ──
    // Human handle for this account ("Payroll — Maybank", "Statutory — Maybank"). The only way to tell two
    // accounts at the same bank apart in a picker, so the service defaults it from the bank name.
    accountLabel: text('account_label'),
    // Name the account is held in at the bank (may differ from orgName, which is the file-header field).
    accountName: text('account_name'),
    accountType: text('account_type'), // 'current' | 'savings' | free text — display/metadata only
    branch: text('branch'),
    swiftCode: text('swift_code'),
    currency: text('currency').notNull().default('MYR'),
    // At most one primary per company (partial unique index below). The default account a payment run
    // debits when nothing more specific is chosen.
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // R46: (companyId, bank) is NO LONGER unique — several accounts per bank are the point of this item.
    index('company_bank_profile_company_idx').on(t.companyId, t.bank),
    uniqueIndex('company_bank_profile_primary_uq').on(t.companyId).where(sql`is_primary`),
  ],
);

// Per-authority statutory payment configuration (R46 orgbank 84719377). company_statutory_my is one flat
// row per company holding the employer REFERENCE NUMBERS; it cannot hold per-authority payment routing.
// This child table does: for each statutory body (EPF, SOCSO, EIS, LHDN, HRD Corp, Zakat, PTPTN, Tabung
// Haji, Koperasi) it records the employer account/reference with that body, WHICH company bank account
// pays it, the body's correspondence address + phone, and the authorised signatory.
//
// bankProfileId → company_bank_profile ON DELETE SET NULL: removing a bank account must not silently drop
// the authority's whole configuration, it just unroutes it (surfaced in the UI as "no account chosen").
// signatoryPersonId → person ON DELETE SET NULL for the same reason plus PDPA erasure: a hard-deleted
// person leaves the row intact with an empty signatory. A merely-TERMINATED employee is not deleted, so
// the stored value survives; the picker is scoped to active employments of the company and is
// legacy-tolerant (an out-of-list stored signatory is still shown, like the profile-option pickers).
//
// RLS mirrors company_bank_profile exactly (company-scoped admin for BOTH read and write) — this row
// references a bank account and names a signatory, so it is at least as sensitive.
export const companyStatutoryAuthority = pgTable(
  'company_statutory_authority',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    // Controlled set, validated in core/statutory-authority.ts (STATUTORY_AUTHORITIES) rather than a
    // pgEnum — the R46 enum-widening pain is exactly what a text + code-side master avoids.
    authority: text('authority').notNull(),
    // The employer's account / reference number WITH that authority (e.g. the EPF employer no. as it
    // appears on the payment slip). Distinct from company_statutory_my's identity fields: this is the
    // payment reference, which some bodies issue separately.
    accountNo: text('account_no'),
    bankProfileId: uuid('bank_profile_id').references(() => companyBankProfile.id, { onDelete: 'set null' }),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    addressLine3: text('address_line3'),
    city: text('city'),
    state: text('state'),
    postcode: text('postcode'),
    country: text('country'),
    phone: text('phone'),
    email: text('email'),
    signatoryPersonId: uuid('signatory_person_id').references(() => person.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('company_statutory_authority_company_authority_uq').on(t.companyId, t.authority)],
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
    // R18 a519a96e (group inheritance): when set, this holiday is a GROUP-scoped "additional day" that
    // applies ONLY to staff whose calendar resolves through that holiday_group — either directly (assigned
    // group / location-mapped calendar) or via a CHILD group inheriting from it (holiday_group.parent_group_id).
    // This is the per-office extra ("Company Family Day" for OKR Office only); the company_id axis above
    // stays the company-subtree-wide extra. ON DELETE CASCADE: deleting a group removes its own extra days.
    holidayGroupId: uuid('holiday_group_id').references((): AnyPgColumn => holidayGroup.id, {
      onDelete: 'cascade',
    }),
    holidayDate: date('holiday_date').notNull(),
    name: text('name').notNull(),
    // Follow-on #15b (ADR-0063): TRUE = a provisional, not-yet-gazetted date (shifting state holidays are
    // gazetted only days ahead). A tentative holiday STILL counts as a holiday everywhere (leave/rest-day/
    // payroll) — the flag is purely a visible "confirm me" marker; excluding it would under-count.
    tentative: boolean('tentative').notNull().default(false),
    // 66b8f5a8 — Holiday master fields (migration 0190). Self-describing metadata for the centralized
    // holiday library; the resolver (core/holidays.ts) does NOT read these — they are display /
    // classification only, so existing resolution is byte-identical.
    holidayCode: text('holiday_code'), // optional HR-facing short code
    holidayType: text('holiday_type').notNull().default('public'), // public | company | optional (CHECK 0190)
    description: text('description'), // optional free text
    active: boolean('active').notNull().default(true), // inactive rows still exist, flagged in the UI
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
      sql`coalesce(${t.holidayGroupId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    // Mutual exclusivity DB-guaranteed (seed/CSV/import paths bypass the service): a row is at most one of
    // state-scoped, company-scoped, or group-scoped — so the resolver never sees a malformed multi-scope row.
    check('holiday_scope_excl', sql`num_nonnulls(${t.state}, ${t.companyId}, ${t.holidayGroupId}) <= 1`),
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
    // 66b8f5a8 — Holiday Group master fields (migration 0190) for the dedicated group page's info section.
    code: text('code'), // optional group code (shown as the first column of the Holiday Group list)
    description: text('description'), // optional free text
    active: boolean('active').notNull().default(true),
    states: jsonb('states').notNull().default(sql`'[]'::jsonb`), // string[] of MY_STATES labels
    archetype: holidayGroupArchetypeEnum('archetype').notNull().default('standard'),
    // R18 a519a96e (group inheritance): a group may inherit from ONE parent group. The parent contributes
    // its gazette source (archetype + states) and its own group-scoped extra days LIVE at resolve time —
    // adding a holiday to the parent instantly applies to every child, no copy/sync. Single level only
    // (the parent must itself be parentless — service-enforced; the DB CHECK below blocks self-parenting).
    // ON DELETE SET NULL: deleting a parent detaches children (deleteHolidayGroup's block-while-children
    // guard is the friendly primary path; this FK is the backstop).
    parentGroupId: uuid('parent_group_id').references((): AnyPgColumn => holidayGroup.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  // Case-insensitive per-tenant name uniqueness (follows the org_catalog_integrity pattern, 0030).
  (t) => [
    uniqueIndex('holiday_group_name_uq').on(t.tenantId, sql`lower(${t.name})`),
    check('holiday_group_no_self_parent', sql`${t.parentGroupId} IS NULL OR ${t.parentGroupId} <> ${t.id}`),
  ],
);

// 66b8f5a8 — Holiday-group ↔ holiday junction (migration 0190). The reporter's "tick-list" model: HR ticks
// holidays from the centralized master list into a group. This is layered OVER the existing state engine —
// the resolver (core/holidays.ts) UNIONs the explicitly-ticked holidays here WITH the automatic
// state/archetype/inheritance result, so MY state auto-resolution + parent-to-child auto-sync are preserved.
// Both FKs ON DELETE CASCADE: deleting a group or a holiday removes its memberships. Admin-only writes (RLS
// 0190), tenant-scoped read for any member (the resolver SELECTs it).
export const holidayGroupHoliday = pgTable(
  'holiday_group_holiday',
  {
    id: id(),
    tenantId: tenantId(),
    holidayGroupId: uuid('holiday_group_id')
      .notNull()
      .references((): AnyPgColumn => holidayGroup.id, { onDelete: 'cascade' }),
    holidayId: uuid('holiday_id')
      .notNull()
      .references((): AnyPgColumn => holiday.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('holiday_group_holiday_uq').on(t.holidayGroupId, t.holidayId)],
);

// ──────────────────────── Attendance (generic) ────────────────────────
export const attendanceStatusEnum = pgEnum('attendance_status', ['present', 'absent', 'late', 'half_day']);
// Day classification drives the OT class (EA 1955: workday 1.5x, rest day 2x, holiday 3x — ADR-0011).
export const attendanceDayTypeEnum = pgEnum('attendance_day_type', ['workday', 'rest_day', 'holiday']);
// 1e9145d4 (migration 0424) — `cancelled` is the WITHDRAWN state a Plan OT row lands in when the employee
// takes it back before the overtime date. SHARED with travel_request, which simply never writes it. Every
// consumer was audited before the value was added; the audit is in the migration header. The two that
// matter: the approvals inbox filters status = 'pending' (so a withdrawn plan leaves the queue for free),
// and me.leaveStatus.cancelled already exists in all six locales (so the label needs no new key).
export const attendanceCorrectionStatusEnum = pgEnum('attendance_correction_status', [
  'pending',
  'approved',
  'rejected',
  'cancelled',
]);

// ADR-0069 Attendance Request Management: how an APPROVED overtime request's minutes are resolved against the
// system's own live-computed figure. `requested` = trust the employee's requested figure; `system_calculated`
// = trust the engine's derived figure (default); `smaller_of` = the lower of the two (conservative). Company-
// level (attendance_policy.ot_approval_calculation). 7c834696 stage 1 (migration 0394) added `greater_of`
// — the request has always listed four options and ADR-0069 shipped three; nothing else about the
// resolution changed.
export const otApprovalCalculationEnum = pgEnum('ot_approval_calculation', [
  'requested',
  'system_calculated',
  'smaller_of',
  'greater_of',
]);

// Clocking Location & Geofencing (ADR-0070). 'pass' = the punch was within a matched assigned site's
// radius; 'not_enforced' = geofencing was OFF for that punch (coords may still be present). 'fail' does
// NOT exist here — a blocked attempt never writes an attendance row; it is the
// attendance.geofence.blocked domain event instead (see core/attendance.ts).
export const geofenceStatusEnum = pgEnum('geofence_status', ['pass', 'not_enforced']);
// Only 'web' (self-service /me) can carry geofencing. 'import' = the biometric/terminal CSV importer,
// which bypasses geofencing entirely (physical presence at the device is its own proof). A punch written
// by decideAttendanceCorrection stays NULL (deliberate — no 'correction' value, per ADR-0070 §6).
//
// r368 c8282468 — AND THE READING THAT WAS THERE IS NOW KEPT. This comment recorded the deliberate half
// only: a correction NULLS all 14 geo/method columns on both punches, which is right, but it destroyed a
// geofence attestation with no copy anywhere, silently. The pre-image of those columns is now carried on
// the `attendance.amended` event's top-level `before` block (core/attendance.ts AMENDED_FIGURE_COLUMNS),
// so the Audit Trail shows the loss as "old → new" rather than leaving it invisible. Still no column and
// still no snapshot table: see the ADR-0069 note on attendance_correction below.
export const clockMethodEnum = pgEnum('clock_method', ['web', 'import', 'admin']);

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
    // ── 7c834696 stage 1 (migration 0394) · the figures the calculation engine can now derive ──────────
    // ADDITIVE, every one of them. `ot_minutes` STAYS THE CANONICAL TOTAL — core/payroll.ts (OT prefill +
    // the weekly cross-cycle read), core/reporting.ts and toil_accrual all read it and none of them looks
    // at anything below. The five rate buckets SUM BACK to ot_minutes exactly: categorising MOVES minutes
    // between columns, it never changes the total (pinned in test/attendance-stage1-calc.test.ts).
    //
    // NULL ≠ 0 here. NULL means "no engine computed this for this day" (history, or a day still open); the
    // read layer renders it as "—". Migration 0395 backfills only the OT buckets, and only with the split
    // the Records screens were already DERIVING at read time, so no displayed figure moves on release.
    //
    // Measured (NEUTRAL — new facts, nothing pays off them):
    lateMinutes: integer('late_minutes'),
    earlyOutMinutes: integer('early_out_minutes'),
    underMinutes: integer('under_minutes'),
    // Deductions (the only DOWNWARD-capable figures): non-zero ONLY when the day's paired rule has
    // apply_deductions AND attendance_date >= that rule's deductions_effective_from. Never backfilled, so
    // a closed payroll period can never acquire one retroactively.
    lateDeductMinutes: integer('late_deduct_minutes'),
    earlyOutDeductMinutes: integer('early_out_deduct_minutes'),
    // Per-rate overtime split. ot00 = a configured rate of 0 — recorded, not payable — and it exists so
    // the buckets still sum to ot_minutes when a rule uses a 0 band. These are OVERTIME ONLY, and since
    // 7c834696 rev 2 the SCREEN says so too: the "OT 1.0" column used to add normal-within-schedule hours
    // (worked − ot) on top at read time, which is the display fault the reporter raised. Normal hours are
    // the Actual Working Hours column now; nothing stored here ever carried them.
    otFlatMinutes: integer('ot_flat_minutes'),
    ot00Minutes: integer('ot00_minutes'),
    ot10Minutes: integer('ot10_minutes'),
    ot15Minutes: integer('ot15_minutes'),
    ot20Minutes: integer('ot20_minutes'),
    ot30Minutes: integer('ot30_minutes'),
    // 7c834696 POINT 3 — the WORKING behind the three figures above, stamped by the engine as it computes
    // them (core/attendance-trace.ts). NULL on every row written before this release and on any row no
    // engine has touched since; the panel reports "no working recorded" rather than reconstructing one.
    //
    // STORED RATHER THAN RECOMPUTED ON PURPOSE. Shifts, rosters and rules are effective-dated AND
    // editable in place, so re-deriving a June day against August's rule ladder would print working that
    // does not add up to the number beside it — on the one screen whose purpose is auditability. Same
    // reasoning, and the same shape, as payslip `pcbMeta` / core/pcb-explain.ts.
    calcTrace: jsonb('calc_trace').$type<AttendanceTraceV1>(),
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

// ── R45 92bdf77a · Multiple Clocking (migration 0265) ────────────────────────────────────────────────
// The day still keeps exactly ONE `attendance` aggregate row (the unique index above is untouched). Every
// individual clock-in / clock-out is captured here as a child punch so a person can clock in/out more than
// once a day (lunch, off-site trip, meeting). The aggregate row's check_in_at / check_out_at are DERIVED
// from these punches (first-in / last-out) — see recomputeDayFromPunches in core/attendance.ts. Direction is
// captured at punch time (the /me button pressed) but the summation uses first-in-time / last-out-time.
// Stage-1 scope: capture + first-in/last-out summation. Deferred (stage 2, documented GAP): per-pair
// unpaid-break, pre-shift/early-OT attribution, split shifts, cross-midnight multi-punch.
export const attendancePunchDirectionEnum = pgEnum('attendance_punch_direction', ['in', 'out']);
// r430 (migration 0520) — device_id and the six photo columns are now NULLABLE: Web Clocking no longer
// registers a device (device_id is null for every capture going forward, kept only for historical rows),
// and a photo is no longer always taken (attendance_photo_setting 'optional' skipped, or 'not_required').
// The CHECK below is a genuinely new nullable SET, so it is written explicitly rather than relying on a
// comment — unlike the geofence columns' "null together" convention just below, which stays comment-only.
export const attendanceClockCapture = pgTable('attendance_clock_capture', {
  id: id(), tenantId: tenantId(), employmentId: uuid('employment_id').notNull().references(() => employment.id),
  attendanceDate: date('attendance_date').notNull(), direction: attendancePunchDirectionEnum('direction').notNull(),
  requestId: uuid('request_id').notNull(), serverRecordedAt: timestamp('server_recorded_at', { withTimezone: true }).notNull(),
  photoCapturedAt: timestamp('photo_captured_at', { withTimezone: true }),
  photoMimeType: text('photo_mime_type'), photoSize: integer('photo_size'),
  photoBytes: bytea('photo_bytes'), thumbnailBytes: bytea('thumbnail_bytes'),
  decodedWidth: integer('decoded_width'), decodedHeight: integer('decoded_height'),
  deviceId: uuid('device_id').references(() => employeeDevice.id),
  lat: doublePrecision('lat').notNull(), lng: doublePrecision('lng').notNull(), accuracyM: doublePrecision('accuracy_m').notNull(),
  // r423 (0517) — NULL together when the employee's geofencing switch is OFF: the position is recorded, it is
  // simply not compared with a site. Present together for every geofenced capture (core/attendance-clock.ts).
  clockingLocationId: uuid('clocking_location_id').references((): AnyPgColumn => clockingLocation.id),
  distanceM: integer('distance_m'), radiusM: integer('radius_m'),
  commandDigest: text('command_digest').notNull(), photoDigest: text('photo_digest'),
  photoPurgedAt: timestamp('photo_purged_at', { withTimezone: true }), photoPurgeEventId: uuid('photo_purge_event_id').references(() => domainEvent.id),
}, (t) => [uniqueIndex('attendance_clock_capture_request_uq').on(t.tenantId, t.employmentId, t.requestId),
  index('attendance_clock_capture_day_idx').on(t.employmentId, t.attendanceDate, t.serverRecordedAt),
  // r430 — the six photo columns (device_id excluded: it is independently nullable, always null going
  // forward) are null together: either every one was captured, or none was.
  check(
    'attendance_clock_capture_photo_together',
    sql`num_nonnulls(${t.photoCapturedAt}, ${t.photoMimeType}, ${t.photoSize}, ${t.decodedWidth}, ${t.decodedHeight}, ${t.photoDigest}) IN (0, 6)`,
  )]);

export const attendancePunch = pgTable(
  'attendance_punch',
  {
    id: id(),
    tenantId: tenantId(),
    // The day aggregate this punch rolls up into. Cascade-deletes with the day row.
    attendanceId: uuid('attendance_id')
      .notNull()
      .references(() => attendance.id, { onDelete: 'cascade' }),
    // Denormalised employment + date so RLS (can_see_employment) and range reads stay a single-table scan.
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    attendanceDate: date('attendance_date').notNull(),
    punchAt: time('punch_at').notNull(),
    direction: attendancePunchDirectionEnum('direction').notNull(),
    method: clockMethodEnum('method').notNull().default('web'),
    // Per-punch geo capture (ADR-0070 parity) — all nullable; a punch written while geofencing is off leaves them null.
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    clockingLocationId: uuid('clocking_location_id').references((): AnyPgColumn => clockingLocation.id),
    distanceM: integer('distance_m'),
    geofenceStatus: geofenceStatusEnum('geofence_status'),
    radiusM: integer('radius_m'),
    clockCaptureId: uuid('clock_capture_id').unique().references(() => attendanceClockCapture.id),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    index('attendance_punch_attendance_idx').on(t.attendanceId, t.punchAt),
    uniqueIndex('attendance_punch_live_clock_uq').on(t.attendanceId, t.punchAt, t.direction).where(sql`${t.voidedAt} is null and ${t.clockCaptureId} is null`),
  ],
);

// ── r424 50ed39e1 · Attendance File Structure Mapping + Import Clocking Data (migration 0518) ──────────
// How a clocking device writes its file (described once), and a log of every import. An imported clocking
// is an ordinary `attendance_punch` row (method 'import'); the link from a log line to that punch lives on
// the LINE, so neither attendance table changes. Mappings are TENANT-WIDE: a device file names no company.
// The built-in "AIHR Standard Template" is code (lib/clocking-file.ts), not a row. See 0518's header.
export const clockingFileTypeEnum = pgEnum('clocking_file_type', ['csv', 'txt']);
export const clockingFileLayoutEnum = pgEnum('clocking_file_layout', ['delimited', 'fixed_width']);
export type ClockingFieldSpecRow = { column: number } | { start: number; end: number };
export type ClockingFieldsRow = Partial<
  Record<'cardId' | 'deviceId' | 'day' | 'month' | 'year' | 'hours' | 'minute' | 'inOutCode', ClockingFieldSpecRow>
>;
export const clockingFileMapping = pgTable(
  'clocking_file_mapping',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    deviceName: text('device_name').notNull().default(''),
    fileType: clockingFileTypeEnum('file_type').notNull(),
    layout: clockingFileLayoutEnum('layout').notNull(),
    /** The separator of a delimited file; NULL for fixed width (DB CHECK). */
    delimiter: text('delimiter'),
    hasHeader: boolean('has_header').notNull().default(false),
    /** 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252' (DB CHECK). Decoded in the browser. */
    encoding: text('encoding').notNull().default('utf-8'),
    active: boolean('active').notNull().default(true),
    /** Per field: {column} (1-based) for a delimited file, {start,end} (1-based inclusive) for fixed width.
     *  The six required fields are the service's rule (core/attendance-clocking-import.ts). */
    fields: jsonb('fields').$type<ClockingFieldsRow>().notNull().default({}),
    inOutCodes: jsonb('in_out_codes').$type<{ code: string; direction: 'in' | 'out' }[]>().notNull().default([]),
    /** Up to 20 lines of the sample file, kept for Edit. Never imported. */
    sampleLines: jsonb('sample_lines').$type<string[]>().notNull().default([]),
    sampleFileName: text('sample_file_name').notNull().default(''),
    createdByUserId: text('created_by_user_id'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('clocking_file_mapping_name_uq').on(t.tenantId, sql`lower(${t.name})`)],
);

/** One row per import. Status is DERIVED (failure_reason → Failed; else from the counts), never stored. */
export const clockingImportRun = pgTable(
  'clocking_import_run',
  {
    id: id(),
    tenantId: tenantId(),
    /** NULL = the built-in AIHR Standard Template. RESTRICT: a used mapping is deactivated, not deleted. */
    mappingId: uuid('mapping_id').references(() => clockingFileMapping.id, { onDelete: 'restrict' }),
    mappingName: text('mapping_name').notNull(),
    /** The mapping exactly as it was on the day of the import. */
    mappingSnapshot: jsonb('mapping_snapshot').notNull().default({}),
    fileName: text('file_name').notNull().default(''),
    fileBytes: integer('file_bytes').notNull().default(0),
    fileSha256: text('file_sha256').notNull().default(''),
    createdByPersonId: uuid('created_by_person_id').references(() => person.id),
    createdByUserId: text('created_by_user_id'),
    createdAt: createdAt(),
    totalLines: integer('total_lines').notNull().default(0),
    validLines: integer('valid_lines').notNull().default(0),
    importedLines: integer('imported_lines').notNull().default(0),
    duplicateLines: integer('duplicate_lines').notNull().default(0),
    unmatchedCardLines: integer('unmatched_card_lines').notNull().default(0),
    invalidDatetimeLines: integer('invalid_datetime_lines').notNull().default(0),
    otherErrorLines: integer('other_error_lines').notNull().default(0),
    daysUpdated: integer('days_updated').notNull().default(0),
    employeesUpdated: integer('employees_updated').notNull().default(0),
    /** Set only on a run that stopped and saved nothing. */
    failureReason: text('failure_reason'),
  },
  (t) => [
    index('clocking_import_run_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('clocking_import_run_sha_idx').on(t.tenantId, t.fileSha256),
  ],
);

export type ClockingImportLineResult =
  | 'imported'
  | 'duplicate'
  | 'unmatched_card'
  | 'invalid_date'
  | 'invalid_time'
  | 'unknown_in_out_code'
  | 'missing_value'
  | 'line_too_short'
  | 'ambiguous_card'
  | 'not_employed_on_date'
  | 'future_date'
  | 'day_corrected'
  | 'period_closed'
  | 'uncoded_on_clocked_day'
  | 'other';

/** One row per non-blank data line of an imported file. raw_line only when the line was not imported. */
export const clockingImportLine = pgTable(
  'clocking_import_line',
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid('run_id')
      .notNull()
      .references(() => clockingImportRun.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    cardRef: text('card_ref').notNull().default(''),
    employmentId: uuid('employment_id').references(() => employment.id),
    deviceRef: text('device_ref'),
    punchDate: date('punch_date'),
    punchTime: time('punch_time'),
    direction: attendancePunchDirectionEnum('direction'),
    /** text + DB CHECK (the 0275 lesson: this vocabulary is the one most likely to grow). */
    result: text('result').$type<ClockingImportLineResult>().notNull(),
    message: text('message').notNull().default(''),
    rawLine: text('raw_line'),
    attendancePunchId: uuid('attendance_punch_id').references(() => attendancePunch.id, { onDelete: 'set null' }),
  },
  (t) => [index('clocking_import_line_run_idx').on(t.runId, t.lineNo)],
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
    // Feedback 5249d43f (migration 0301): when TRUE, web clock-in/out requires a registered device token
    // (employee_device) — enforced server-side in core/attendance-device.ts enforceDeviceGateTx. Default
    // FALSE so shipping the feature locks nobody out; terminal imports are exempt (documented bypass).
    requireRegisteredDevice: boolean('require_registered_device').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('attendance_policy_company_uq').on(t.companyId)],
);

// ── 88e94371 · "Lateness, Early Out & Overtime Settings" — named-rule library ─────────────────────────
// A reusable, TENANT-WIDE library of attendance CALCULATION rules (renamed/expanded from the single
// Attendance Policy). Each rule bundles a Lateness section, an Early Out section, and an Overtime table
// (attendance_rule_ot_row). A shift picks ONE rule (shift.rule_id); a shift with no rule falls back to the
// tenant's `is_default` "Standard" rule (seeded by migration 0203 from the existing attendance_policy so
// today's grace behaviour carries over unchanged). The Standard rule is un-deletable.
//
// 6da67ab7 (migration 0319) removed the company axis — see the company_id note below. The rule is chosen by
// the SHIFT, and shifts are tenant-wide, so a per-company library was a filter with nothing behind it.
//
// SCOPE — CORRECTED BY 7c834696 STAGE 1. The grace-period fields were already wired into the time engine
// (core/attendance.ts scheduleFor, as a fallback under any explicit per-shift grace). What stage 1 added:
//   • the lateness / early-out `afterMinutes` + `deductMinutes` pairs now PRODUCE a stored per-day figure
//     (attendance.late_deduct_minutes / early_out_deduct_minutes) — gated on `apply_deductions` below,
//     which ships FALSE, and never for a date before `deductions_effective_from`;
//   • the OT rows now CATEGORISE, progressively, into the per-rate buckets on the attendance row, instead
//     of only supplying a rounding step (applyOtRuleRows still owns rounding).
// 7c834696 rev 3 (2026-08-11) then CHANGED the rounding direction: a band's Round-To now floors, so a
// rounded overtime can never exceed either the band's own upper bound or the minutes actually worked. It
// used to round to nearest, which inflated two real production days by 30 and 20 minutes. A non-workday
// also stopped borrowing the band's WORKDAY multiplier for its rate column — see core/attendance-calc.ts
// rateForDay.
// STILL DEFERRED, deliberately: nothing MONETIZES the deduction figures — attendance reports categorised
// results and payroll decides what they are worth (the request's own split), and no payroll path reads
// them yet. Per-band custom OT PAY multipliers are likewise still not fed to the payroll kernel; the
// tenant-global statutory 1.5×/2×/3× remain the compliance cap.
export const attendanceRule = pgTable(
  'attendance_rule',
  {
    id: id(),
    tenantId: tenantId(),
    // 6da67ab7 (migration 0319) — the library is TENANT-WIDE, mirroring the shared shift library (0197): a
    // shift is tenant-wide and binds its rule through shift.rule_id, so a per-company library could only ever
    // offer one company's rules to a shift every company's employees are rostered onto. The column is kept
    // NULLABLE only so the FK/history survives; every row is NULL and nothing reads it.
    companyId: uuid('company_id').references(() => company.id),
    name: text('name').notNull(),
    description: text('description'),
    // The tenant's un-deletable "Standard" rule. Exactly one per TENANT (partial unique index). A shift with
    // no rule_id — and a day with no shift at all — resolves to this rule.
    isDefault: boolean('is_default').notNull().default(false),
    // 'active' | 'inactive' — a CHECK lives in migration 0203. Inactive rules stay assigned but are hidden
    // from the new-shift picker (surfaced with a badge in the list).
    status: text('status').notNull().default('active'),
    // ── Lateness section ──
    // Grace minutes after the scheduled start before lateness is evaluated (the engine's late threshold =
    // shift start + this, unless a per-shift late-grace overrides). afterMinutes/deductMinutes/includeGrace
    // capture the deduction rule (stored; pay application deferred — see the table comment).
    lateGracePeriodMinutes: integer('late_grace_period_minutes').notNull().default(0),
    lateAfterMinutes: integer('late_after_minutes').notNull().default(0),
    lateDeductMinutes: integer('late_deduct_minutes').notNull().default(0),
    includeGraceInLateness: boolean('include_grace_in_lateness').notNull().default(false),
    // ── Early Out section (same shape) ──
    earlyGracePeriodMinutes: integer('early_grace_period_minutes').notNull().default(0),
    earlyAfterMinutes: integer('early_after_minutes').notNull().default(0),
    earlyDeductMinutes: integer('early_deduct_minutes').notNull().default(0),
    includeGraceInEarlyOut: boolean('include_grace_in_early_out').notNull().default(false),
    // ── Overtime section ──
    // "Count time clocked before the scheduled start as overtime." Honoured by the pure resolver
    // applyOtRuleRows (unit-tested) and folded in by core/attendance.ts before the per-shift OT shape.
    // THERE IS NO APPROVAL STEP behind it, despite the label the editor used to carry: with the switch on,
    // EVERY pre-shift minute becomes overtime. 7c834696 rev 3 corrected the hint in all six catalogues
    // (admin.attendanceRule.applyEarlyOtHint) rather than pretend an approval gate exists. Gating early OT
    // on approval is its own item.
    applyToEarlyOt: boolean('apply_to_early_ot').notNull().default(false),
    // ── 7c834696 stage 1 (migration 0394) · the deduction opt-in ──
    // The after-X/deduct-Y pairs above have been editable since 0204 and read by NOTHING, so every rule's
    // effective deduction today is zero. Turning them on for everyone at release would take minutes off
    // people whose employer never knew the field was live — so the switch is PER RULE and ships FALSE.
    // `deductionsEffectiveFrom` is stamped by the service (never typed by a human) to today-in-Kuala-Lumpur
    // when the switch flips on, and cleared when it flips off; a DB CHECK (0394) makes "deductions on with
    // no start date" unrepresentable. Deductions therefore only ever exist forward of the switch-on date —
    // a closed payroll period cannot acquire one.
    applyDeductions: boolean('apply_deductions').notNull().default(false),
    deductionsEffectiveFrom: date('deductions_effective_from'),
    // ── 07ebd04d (r331, migration 0483) · THE SCHEDULE GROUP'S WORKING WEEK ─────────────────────────
    // The same four-way row `shift` carries since 0429, on the object that should have answered the
    // question all along: the GROUP says WHICH DAYS are worked, the shift says WHAT HOURS are worked.
    // Full = in weekly_pattern · Half = in half_pattern · Off = in off_pattern · Rest = in none of them
    // (the complement, exactly as on `shift`). Pairwise disjoint by a DB CHECK, mirroring 0429's.
    //
    // ⚠️ NULL / ALL-EMPTY IS A FIRST-CLASS VALUE AND MEANS "THIS GROUP DECLARES NO WEEK", which is what
    // every row written before 0483 holds and what the tenant's un-deletable is_default "Standard" rule
    // MUST keep holding: it is the fallback for every shift whose rule_id is NULL, so a week on it would
    // be imposed on every ungrouped shift in the tenant. core/week-pattern.ts `weekPatternFor` resolves
    // group-first, shift-second, and a group whose Full ∪ Half is empty deliberately DOES NOT WIN — see
    // that function and core/roster.ts assignEmployeeShift for the rest-day trap it exists to avoid.
    //
    // The write side is core/attendance-rule.ts normalizeInput (disjointness, ISO 1–7, and the refusal of
    // a declared-but-unwalkable week), which is the half `weekPatternFor` cannot do.
    weeklyPattern: integer('weekly_pattern').array(),
    halfPattern: integer('half_pattern')
      .array()
      .notNull()
      .default(sql`'{}'`),
    offPattern: integer('off_pattern')
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // 6da67ab7 (0319) — exactly one default ("Standard") rule per TENANT, and case-insensitive unique rule
    // names tenant-wide (both replaced the per-company indexes from 0204).
    uniqueIndex('attendance_rule_tenant_default_uq').on(t.tenantId).where(sql`is_default`),
    uniqueIndex('attendance_rule_tenant_name_uq').on(t.tenantId, sql`lower(${t.name})`),
    // 07ebd04d (0483) — the 0429 invariant, moved with the columns. COALESCE because weekly_pattern is
    // nullable and one NULL would make the whole predicate NULL, silently un-constraining the table.
    check(
      'attendance_rule_day_kinds_disjoint',
      sql`NOT (COALESCE(${t.weeklyPattern}, '{}') && ${t.halfPattern})
          AND NOT (COALESCE(${t.weeklyPattern}, '{}') && ${t.offPattern})
          AND NOT (${t.halfPattern} && ${t.offPattern})`,
    ),
    // 07ebd04d (0483) — a group that declares OFF days must declare at least one WORKING day. All three
    // empty is legal ("no week"); an all-HALF week is legal (it is walkable). What is unrepresentable is
    // a group that looks like it schedules a week and schedules nothing.
    check(
      'attendance_rule_off_needs_working_day',
      sql`COALESCE(${t.weeklyPattern}, '{}') <> '{}' OR ${t.halfPattern} <> '{}' OR ${t.offPattern} = '{}'`,
    ),
  ],
);

// One overtime time-band row of an attendance_rule (the reporter's "+ Add Row" OT table). fromMinutes..
// toMinutes bound the OT duration (minutes past normal); ratePattern 'flat' (any numeric multiplier) or
// 'variable' (a standardized multiplier). `roundingMode` + `roundToMinutes` round the matched OT minutes.
export type AttendanceOtRatePattern = 'flat' | 'variable';

// 7c834696 contested (migration 0439) — rounding DIRECTION. It used to be a boolean, and the engine only
// ever floored, so "round up" was not a setting anyone had failed to find: it did not exist. text + CHECK
// rather than a pgEnum, for the widening reason recorded at OT_REASON_CATEGORIES above.
//   none — the exact minutes are used, nothing dropped (the boolean's FALSE)
//   down — the largest multiple of roundToMinutes not exceeding the overtime (the boolean's TRUE, verbatim)
//   up   — the smallest multiple of roundToMinutes not below the overtime (NEW)
// 0439 maps true → 'down' and false → 'none', so no band already saved changes what it does.
export const ATTENDANCE_OT_ROUNDING_MODES = ['none', 'down', 'up'] as const;
export type AttendanceOtRoundingMode = (typeof ATTENDANCE_OT_ROUNDING_MODES)[number];
export const attendanceRuleOtRow = pgTable(
  'attendance_rule_ot_row',
  {
    id: id(),
    tenantId: tenantId(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => attendanceRule.id, { onDelete: 'cascade' }),
    fromMinutes: integer('from_minutes').notNull().default(0),
    // 0 (or ≤ fromMinutes) ⇒ open-ended upper bound.
    toMinutes: integer('to_minutes').notNull().default(0),
    ratePattern: text('rate_pattern').notNull().default('flat').$type<AttendanceOtRatePattern>(),
    rate: numeric('rate', { precision: 6, scale: 2 }).notNull().default('1.50'),
    // 7c834696 stage 1 (migration 0394) — the multiplier this band uses when the attendance day is a
    // PUBLIC HOLIDAY. NULL ⇒ fall back to `rate`, which is exactly today's behaviour, so a band only
    // behaves differently on a holiday once someone fills this in.
    phRate: numeric('ph_rate', { precision: 6, scale: 2 }),
    roundingMode: text('rounding_mode').notNull().default('none').$type<AttendanceOtRoundingMode>(),
    // NULL / ≤ 0 ⇒ no step to round to. `roundingMode <> 'none'` requires a positive step (CHECK in 0439):
    // 0 would divide by zero in the engine, and until 0439 the `> 0` guard silently skipped rounding
    // instead — the same outcome as 'none', but by accident rather than by the operator's choice.
    roundToMinutes: integer('round_to_minutes'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('attendance_rule_ot_row_rule_idx').on(t.ruleId, t.sortOrder)],
);

// 1e9145d4 Plan OT — the five reason categories the Apply OT Plan form offers. A text column with a DB
// CHECK (migration 0424) rather than a pgEnum: widening a CHECK is one statement, whereas an enum value
// cannot be USED in the transaction that adds it (the 0275 lesson, and the 0294 → 0295 split above).
// `other` does not mean "no reason" — free-text `reason` is mandatory for every category.
export const OT_REASON_CATEGORIES = [
  'project_deadline',
  'system_maintenance',
  'month_end_closing',
  'client_request',
  'other',
] as const;
export type OtReasonCategory = (typeof OT_REASON_CATEGORIES)[number];

// 2166ef79 My Attendance stage one (migration 0434) — WHICH of the four self-service sections a request
// was filed from. text + CHECK, not a pgEnum, for the same 0275 reason as the categories above.
//
// STORED rather than derived, and that is the point: the instant a missing clock-out is approved the day
// stops being an Incomplete Entry, so a request list that re-derived its own type would relabel its own
// history the moment it succeeded. `other` is the free-form "correct another day" route, which is not one
// of the four sections; NULL is every request filed before this release.
export const ATTENDANCE_REQUEST_KINDS = [
  'self_overtime',
  'short_hours',
  'incomplete_entry',
  'absent',
  'other',
] as const;
export type AttendanceRequestKind = (typeof ATTENDANCE_REQUEST_KINDS)[number];

// Attendance correction requests (ADR-0011 Phase B): an employee proposes corrected punch
// times for a day; an admin or their manager approves, which amends the attendance row
// (re-derived through the time engine). Mirrors the leave request→decide workflow.
/** Immutable, per-user review of one processed missing-punch observation. */
export const attendanceAttentionReview = pgTable('attendance_attention_review', {
  id: id(), tenantId: tenantId(),
  attendanceId: uuid('attendance_id').notNull().references(() => attendance.id,{onDelete:'cascade'}),
  reviewerUserId: uuid('reviewer_user_id').notNull().references(() => appUser.id,{onDelete:'cascade'}),
  fingerprint: text('fingerprint').notNull(),
  createdAt: timestamp('created_at', {withTimezone:true}).notNull().defaultNow(),
}, t => [uniqueIndex('attendance_attention_review_observation').on(t.tenantId,t.attendanceId,t.reviewerUserId,t.fingerprint)]);

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
    //
    // ⚠️ r368 c8282468 — AND `systemCalculatedOtMinutes` IS NOT THE DAY'S PREVIOUS OT FIGURE. It is derived
    // live, and on the clock-correction branch it is derived from the PROPOSED punches, so it never was the
    // old row's overtime. It looks like an answer and is not; do not reach for it to reconstruct a
    // pre-correction figure. THE PREVIOUS VALUES OF A CORRECTED DAY live on the `attendance.amended` event,
    // as a top-level `{ before, after }` pair written in the same transaction after a SELECT of the row
    // (core/attendance.ts AMENDED_FIGURE_COLUMNS). That placement is the point: a stored snapshot COLUMN
    // here is what ADR-0069 declined by name, so recording it on the event honours that decision instead of
    // fighting it. If a future round wants a column, it reopens ADR-0069 first.
    requestedOtMinutes: integer('requested_ot_minutes'),
    approvedOtMinutes: integer('approved_ot_minutes'),
    otApprovalMethod: otApprovalCalculationEnum('ot_approval_method'),
    // 1e9145d4 Plan OT (migration 0424) — overtime AGREED BEFORE IT IS WORKED. All four nullable, so every
    // existing row and the whole clock-correction path are byte-identical.
    //  • plannedStartTime / plannedEndTime — the window the employee typed on Apply OT Plan. The form derives
    //    the hours from them; `requestedOtMinutes` remains the authoritative figure the engine reads, so
    //    these are display + audit and never a second source of truth for pay. Null on a plain hours-only
    //    claim (the after-the-fact path that already worked).
    //  • otReasonCategory — one of the five categories, or NULL for a row filed before this release. text +
    //    a DB CHECK, not a pgEnum (the 0275 widening lesson). Free-text `reason` stays mandatory regardless.
    //  • appliedAt — the moment an APPROVED plan's hours LANDED on the attendance day. This is the whole
    //    point of the item: approving a future-dated plan stamps approvedOtMinutes here and leaves attendance
    //    alone, and the hours are applied later, when the day is actually worked and there is something real
    //    to measure them against. NULL = approved but not yet counted. It is also the idempotency guard —
    //    the application step sets it in the same statement that consumes the plan, so a re-clock-out, a
    //    re-import or a later correction of the same day cannot bank the same plan twice.
    plannedStartTime: time('planned_start_time'),
    plannedEndTime: time('planned_end_time'),
    otReasonCategory: text('ot_reason_category').$type<OtReasonCategory>(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    // 2166ef79 My Attendance stage one (migration 0434). Both nullable, so every existing row and every
    // existing caller are byte-identical.
    //  • remark — the OPTIONAL note beside the mandatory `reason`. The reporter asks for both; only the
    //    reason is enforced (stage one runs on fixed rules until the settings screen exists).
    //  • requestKind — which of the four sections the employee filed from. See ATTENDANCE_REQUEST_KINDS
    //    above for why it is stored rather than re-derived at read time.
    remark: text('remark'),
    requestKind: text('request_kind').$type<AttendanceRequestKind>(),
    rejectReason: text('reject_reason'),
    clockChanges: jsonb('clock_changes').$type<{ version: 1; baseline: string; entries: { id?: string; punchAt: string; direction: 'in' | 'out' }[] }>(),
    originalClockSnapshot: jsonb('original_clock_snapshot').$type<{
      version: 1; attendanceId: string | null; originalCheckIn: string | null;
      originalCheckOut: string | null; capturedAt: string;
    }>(),
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
    // 1e9145d4 (migration 0424) — "the approved, not-yet-applied OT plan for this employee on this day".
    // Partial, so it indexes the handful of live plans rather than every correction ever decided.
    //
    // ec30b2e9 (r364) — IT USED TO SAY "the application step's lookup … run on every clock-out and every
    // imported day", AND THAT NAMED THE WRONG CALLER. applyApprovedOtPlanTx has never filtered on
    // applied_at (it decides LAND vs RE-ASSERT from the row it reads), and after r364 it does not filter on
    // proposed_check_in either — it orders by decided_at over every approved OT-bearing decision for the day
    // and rides attendance_correction_employment_idx above. What this partial index actually serves is
    // liveOtPlanTx, the REQUEST-TIME guard. Recorded rather than corrected silently, because "nothing calls
    // the query this index was built for" is how an index gets dropped and a guard gets slow.
    index('attendance_correction_unapplied_plan_idx')
      .on(t.employmentId, t.attendanceDate)
      .where(sql`status = 'approved' AND applied_at IS NULL AND requested_ot_minutes IS NOT NULL`),
  ],
);

// 2166ef79 My Attendance stage one (migration 0434) — ONE optional supporting file per attendance request
// ("a photo of the gate log", "the site sign-out sheet"). Verbatim reuse of leave_request_attachment (0084)
// and resignation_request_attachment (0156) retargeted: bytea content, and a DENORMALISED employment_id so
// RLS reuses can_see_employment() with no per-row subquery — the same subject + manager + admin rule the
// request row itself carries. Strictly additive; a request with no file has no row here.
export const attendanceCorrectionAttachment = pgTable(
  'attendance_correction_attachment',
  {
    id: id(),
    tenantId: tenantId(),
    attendanceCorrectionId: uuid('attendance_correction_id')
      .notNull()
      .references(() => attendanceCorrection.id),
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
  (t) => [index('attendance_correction_attachment_request_idx').on(t.attendanceCorrectionId)],
);

// ADR-0069 Attendance Request Management — Travel Request. An approved date-range record marking that an
// employee was working off-site for that window. Scoped to an AUDIT MARKER only: this codebase's geofencing
// (ADR-0070) is a separate enforcement path, and travel was never wired into DayContext/attendanceForDate
// (so it could not silently change month-summary absence counting).
// Reuses attendance_correction_status (pending/approved/rejected) and the same request→decide workflow.
//
// ⚠️ b833a077 (r362) — THE TABLE IS KEPT AND NOTHING WRITES IT ANY MORE. My Travel was removed completely
// at the reporter's request: the menu row, the screen, the form, the approvals section, the bell task and
// core/travel-request.ts (which held requestTravel / decideTravelRequest / activeTravelRequestFor —
// referenced in the sentence above and now deleted) are gone. The rows, the RLS policy, the grant and
// migration 0146 stay, deliberately, so the history survives for audit. Two readers of this table remain
// and must NOT be tidied away as dead code: core/read.ts employmentCompanyBlockedTx (the company-change
// gate — deleting it would let HR re-company an employment that still carries travel history) and
// test/harness.ts's TRUNCATE list. Historic travel-request domain events are still labelled by
// lib/approval-history.ts, because migrations 0288 and 0320 name them in an immutable allowlist.
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

// R17 3e8350db — per-shift OT rule. The reporter's "OT Rules" template field. This is DELIBERATELY NOT a
// per-shift multiplier: the 1.5×/2×/3× rates + the RM4,000 wage ceiling are statutory (EA 1955 s.60A) and
// stay company-level (#overtime-rates) so a shift can never pay below the law. What a shift CAN configure is
// the shape of its WORKDAY overtime accrual:
//   • eligible=false      ⇒ this shift accrues no workday OT at all (e.g. a flexi/management shift).
//   • minMinutes          ⇒ workday OT only starts counting once it exceeds this many minutes past normal
//                           (a per-shift OT "block"; below it, no OT).
//   • dailyCapMinutes     ⇒ cap on the workday OT minutes credited per day.
// Rest-day / public-holiday premium (statutory) is untouched by this rule. NULL column ⇒ legacy behaviour
// (eligible, no minimum, no cap).
export type ShiftOtRule = { eligible: boolean; minMinutes?: number; dailyCapMinutes?: number };

// R7 Multi-Shift Phase 1: one break window inside a shift. 'HH:MM:SS', start < end (lexicographic order is
// chronological), so a single break can never cross midnight — Phase 1 excludes overnight breaks. b7b886e2:
// the day derivation now deducts the overlap between the clocking and these windows (capped at the
// break_minutes scalar, which stays canonical for scheduled/normal hours).
//
// f3321963 — Shift Settings Enhancement: two OPTIONAL per-break flags (JSONB, no DDL — additive, absent ⇒
// today's behaviour). `flexible` = the break window is a target, not a fixed clock. `clockingRequired` =
// employees must punch in/out for the break. For a Semi-Flexi shift the service FORCES flexible=true and
// clockingRequired=false (the reporter's fixed rule). Absent on legacy rows / Normal shifts ⇒ unset.
//
// cf21e554 stage 1 — the reference Break tab's "Paid?" tick. ABSENT MEANS UNPAID, which is the whole point:
// every break window stored before this change is byte-identical afterwards, and the shift's canonical
// break_minutes scalar (Σ of the UNPAID windows — core/roster.ts normalizeShiftInput) is unchanged for all
// of them. A paid break is time the employer pays for, so it is NOT taken off the scheduled hours; an
// unpaid one comes off exactly as it does today.
// r277 (439565ff) — `flexibleMinutes` is THIS ROW'S OWN ALLOWANCE in minutes: "you may take up to N
// minutes for this break, whenever you like". It exists because one number for the whole shift
// (shift.flexible_break_minutes, migration 0457) cannot say that a 60-minute lunch and a 15-minute tea
// break have different allowances.
//
// OPTIONAL, AND ABSENT IS NOT ZERO. An absent value means this row is deducted exactly as it is today —
// the overlap between the clocking and this window (core/attendance.ts spannedBreakMinutes) — NOT that
// the row deducts nothing. Every window stored before this change is byte-identical afterwards and every
// shift keeps the worked minutes and the overtime it has today until an allowance is actually typed.
//
// Only meaningful on a row that is `flexible` (a fixed window IS its own clock, so an allowance beside it
// would be a second answer to the same question), and only on an UNPAID row (a paid break is never
// deducted at all). core/roster.ts refuses both contradictions rather than storing them, and it folds the
// allowance into the shift's canonical break_minutes scalar so scheduled hours, the punch import and the
// payroll hourly clamp keep agreeing with what the engine deducts.
export type BreakPeriod = {
  start: string;
  end: string;
  flexible?: boolean;
  clockingRequired?: boolean;
  paid?: boolean;
  flexibleMinutes?: number;
};

// cf21e554 stage 1 — the reference General tab's "Day Type" box. RECORDED ONLY in stage 1: nothing in the
// engine reads it, and the form says so on the box. The value set is THIS PRODUCT'S OWN day vocabulary
// (core/attendance.ts DayType), not a guess at the legacy HRMS's dropdown — the reference screenshot showed
// the field, never its options, and the plan is explicit that we do not invent what was not captured.
export const SHIFT_DAY_TYPES = ['workday', 'rest_day', 'holiday'] as const;
export type ShiftDayType = (typeof SHIFT_DAY_TYPES)[number];

// f3321963 — Shift Settings Enhancement: which attendance/scheduling behaviour a shift template follows.
//   'normal'      = fixed Time-In/Time-Out schedule (today's engine behaviour). DEFAULT (legacy rows).
//   'semi_flexi'  = flexible start within a window; breaks forced Flexible + no-clocking. Engine branch is
//                   deferred Phase-2 work — stored + surfaced now.
//   'full_flexi'  = employee-set hours (required working + break only). Reserved for a FUTURE enhancement;
//                   the enum value is accepted for forward-compat but the setup UI disables selecting it.
// DISTINCT from employment.shiftType ('fixed'|'roster') which is a per-EMPLOYEE assignment mode.
export type ShiftType = 'normal' | 'semi_flexi' | 'full_flexi';

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
// ── 61bf109d (Input Type redesign + Formula Setting) ────────────────────────────────────────────────
// `qty_rate` and `formula` join the union, and `percent_of` gains a `base: 'component'` arm so a pay item
// can be a percentage of ANOTHER pay item, not only of basic. The union stays CLOSED and the formula is an
// AST-shaped VALUE, never an expression string: there is no parser, no `eval`, no `new Function` anywhere in
// this codebase's pay path. A formula is a seed operand folded left-to-right through a term list, so it has
// no operator-precedence ambiguity to explain to a payroll admin and no partial-parse failure mode.
//
// Operands are the FIXED, NAMED input set — a literal number (a "fixed rate"), the employee's basic, days
// worked, hours worked, or another pay item by CODE. Anything outside that set cannot be represented, so an
// out-of-contract input is a compile error here and a save-time rejection in core/pay-rule.ts — never a
// run-time surprise on a payslip.
// ── 2da9937a — the reporter's own worked example needed two things the set above could not express:
// `(Basic + All Fixed Allowance) / Working Days / Working Hours × Rate × Input Hours`. The divisor half is
// a VALIDATOR change (core/pay-rule.ts); the aggregate half is this new ref. It names no pay code — it is
// the SUM of the employee's fixed allowances, so it stays correct as the catalog grows instead of needing
// the formula re-edited every time an allowance is added.
// ── e318eaec — NAMED numbers, and two values the kernel already computes ────────────────────────────
// The reporter's complaint was legibility, not arithmetic: in `… / 26 / 8 × 1.5 × hours`, the 26, the 8 and
// the 1.5 all render as "A fixed amount" and nothing says which is a working-day divisor, which is an hours
// divisor and which is an overtime rate. `label` is the operator's own name for that number. It is DISPLAY
// ONLY — readOperand never reads it, so a labelled rule and an unlabelled one resolve to the same cent — and
// it is OPTIONAL, so every rule already stored (including the reporter's live OT1_5) stays valid, unchanged
// and byte-identical without a migration or a backfill.
//
// `calendar_days` and `prorated_basic` are figures the payroll kernel ALREADY works out per employee and had
// no way to expose to a formula. Neither is a new calculation: see core/pay-rule.ts PayRuleScope.
// DELIBERATELY ABSENT: working_days and working_hours_per_day. There is no single definition of either in
// this system (roster vs shift vs attendance policy, and per-employee), so offering one would be inventing a
// number rather than exposing one. Stated as a follow-up on the board item.
export type FormulaOperand =
  | { ref: 'number'; value: number; label?: string } // a literal / fixed rate, optionally NAMED (display only)
  | { ref: 'basic' } //                   the employee's Personnel Basic Salary (same figure percent_of reads)
  | { ref: 'days' } //                    days worked in the period (factor × days-in-month)
  | { ref: 'hours' } //                   attendance worked hours in the period
  | { ref: 'fixed_allowances' } //        2da9937a — the TOTAL of this employee's fixed allowances (see
  //                                      isFixedAllowanceComponent: kind 'allowance', non-statutory, paid as
  //                                      a stored amount). Ranks strictly below the item reading it, so it
  //                                      can never include a rule-driven item and cannot reintroduce a cycle.
  | { ref: 'calendar_days' } //           e318eaec — days in the payroll month (31 in August, 30 in September).
  //                                      NOT `days`, which is the TENURE-PRORATED count. See PayRuleScope.
  | { ref: 'prorated_basic' } //          e318eaec — basic AFTER the EA-1955 joiner/leaver factor the kernel
  //                                      already applies, so a formula never rebuilds proration by hand.
  | { ref: 'component'; code: string }; // another pay item's resolved amount for this employee

export type FormulaOp = '+' | '-' | '*' | '/';
/** One fold step: apply `op` to the running total with `operand` on the right. */
export type FormulaTerm = { op: FormulaOp; operand: FormulaOperand };

export type PayRule =
  | { kind: 'fixed' } //                                    = current behaviour; the component's `amount` is the value
  // pct% of basic, or (61bf109d) pct% of another pay item named by `componentCode`. Legacy stored rows are
  // `{base:'basic'}` with no componentCode and parse unchanged.
  | { kind: 'percent_of'; base: 'basic' | 'component'; pct: number; componentCode?: string }
  | { kind: 'per_day'; rate: number } //                    rate × days_worked (component MUST have prorates=false)
  | { kind: 'per_hour'; rate: number; onlyPullHoursWithinShiftSchedule?: boolean } // rate × attendance hours (component MUST have prorates=false)
  | { kind: 'flat_capped'; value: number; cap: number } //  min(value, cap)
  | { kind: 'qty_rate'; qty: number; rate: number } //      61bf109d — a quantity multiplied by a rate
  | { kind: 'formula'; start: FormulaOperand; terms: FormulaTerm[] }; // 61bf109d — the restricted formula

// A reusable named shift for a company (e.g. "Night A", 22:00–06:00). crossesMidnight = endTime ≤ startTime.
export const shift = pgTable(
  'shift',
  {
    id: id(),
    tenantId: tenantId(),
    // R33 f21d6eee — Shared shift library: company_id is NULLABLE. New templates are authored tenant-wide
    // (company_id = NULL) and can be assigned to any employee in the tenant; legacy per-company rows keep
    // their company_id. Migration 0197 dropped the NOT NULL and re-gated RLS on app.is_admin() (tenant-admin)
    // instead of app.is_admin_for(company_id).
    companyId: uuid('company_id').references(() => company.id),
    name: text('name').notNull(),
    // R7 Multi-Shift Phase 1: short identifier. Nullable in DB (legacy rows were backfilled by 0139),
    // REQUIRED by the service/form. R33 f21d6eee — uniqueness is now TENANT-WIDE (shift_tenant_code_uq), a
    // partial lower(code) index among non-archived rows (migration 0197 replaced the per-company index).
    code: text('code'),
    // f3321963 — Shift Settings Enhancement: shift template type (see ShiftType). DEFAULT 'normal' so every
    // legacy row is byte-identical. CHECK ('normal','semi_flexi','full_flexi') lives in migration 0181.
    type: text('type').notNull().default('normal').$type<ShiftType>(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    breakMinutes: integer('break_minutes').notNull().default(0),
    // R7 Multi-Shift Phase 1: multiple break windows. b7b886e2 ended the storage-only phase for the DAY
    // derivation — core/attendance.ts now deducts the break minutes a clocking actually SPANNED (capped at
    // the breakMinutes scalar below). The scalar stays canonical everywhere else (scheduled/normal hours,
    // punch import, hourly clamp) and is still Σ durations, persisted by the service.
    breakPeriods: jsonb('break_periods').$type<BreakPeriod[] | null>(),
    // R7 Multi-Shift Phase 1: manual normal-working-minutes figure; when set it is what workday OT is
    // measured against (core/attendance.ts deriveAttendance). NULL ⇒ auto (span − break).
    normalMinutesOverride: integer('normal_minutes_override'),
    // R7 Multi-Shift Phase 2: ISO weekday numbers (1=Mon … 7=Sun) that are WORKING days for this shift —
    // rest = complement — mirroring attendance_policy.working_days. NULL ⇒ no pattern; the shift cannot
    // drive generateRosterFromTemplate and behaves exactly as before.
    //
    // b8aa3466 (migration 0429) — this is now the FULL-day list of a four-way row. See halfPattern /
    // offPattern below; a weekday in none of the three is still a Rest day, exactly as before.
    weeklyPattern: integer('weekly_pattern').array(),
    // b8aa3466 (migration 0429) — the other two day kinds, copying the shape attendance_policy already uses
    // for the same problem (working_days + half_working_days, migration 0142) rather than inventing an
    // encoding. Disjoint from weekly_pattern and from each other by a DB CHECK.
    //   Half = a working day with HALF the normal hours, so overtime starts after half a day.
    //   Off  = a non-working day that is NOT the statutory rest day (s.60A(3)(a): 1.5× hourly), as opposed
    //          to Rest (s.60(3)(b)-(c): half/full day ORP plus 2× on the excess).
    // Both default '{}', so every row written before 0429 reads back as Full-where-ticked / Rest-otherwise —
    // which is exactly what it means today. No backfill statement exists or is needed.
    halfPattern: integer('half_pattern')
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    offPattern: integer('off_pattern')
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    // b8aa3466 (migration 0429) — the DAILY CUT-OFF. OFF (default) ⇒ core/attendance.ts anchorToShift keeps
    // its hard-coded 12-hour rule byte-identically. ON ⇒ that boundary becomes this clock time: a punch
    // before it belongs to the shift-day that opened on the previous calendar day. CHECK in 0429 forbids
    // enabled-with-no-time, which the reader could not honour.
    dailyCutoffEnabled: boolean('daily_cutoff_enabled').notNull().default(false),
    dailyCutoffTime: time('daily_cutoff_time'),
    crossesMidnight: boolean('crosses_midnight').notNull().default(false),
    // R17 3e8350db — per-shift grace windows (minutes). NULL ⇒ inherit the company-policy behaviour
    // (core/attendance.ts scheduleFor): late = policy grace applied to the shift start, early-leave = the
    // shift midpoint. When set, lateness is measured from start + lateGraceMinutes and early-leave from
    // end − earlyLeaveGraceMinutes. CHECK ≥ 0 lives in migration 0162.
    lateGraceMinutes: integer('late_grace_minutes'),
    earlyLeaveGraceMinutes: integer('early_leave_grace_minutes'),
    // R17 3e8350db — the reporter's per-shift "OT Rules". Shapes WORKDAY overtime accrual (eligibility /
    // minimum block / daily cap); statutory multipliers stay company-level. NULL ⇒ legacy behaviour. See the
    // ShiftOtRule type above.
    otRule: jsonb('ot_rule').$type<ShiftOtRule | null>(),
    // 88e94371 — the shift's chosen attendance-calculation rule ("Lateness, Early Out & Overtime Settings").
    // NULL ⇒ the shift falls back to the employee's-company default ("Standard") rule at resolve time
    // (core/attendance.ts). Replaces the old per-shift "OT Rules" UI field with a rule-library dropdown;
    // shift.ot_rule stays as a higher-precedence per-shift OT-shape override (legacy, byte-identical).
    ruleId: uuid('rule_id').references((): AnyPgColumn => attendanceRule.id),
    differential: jsonb('differential').$type<ShiftDifferential | null>(),
    // ── cf21e554 stage 1 · the reference General tab (migration 0417) ────────────────────────────────
    // ALL NULLABLE, NO DEFAULTS, NO BACKFILL. The reporter was promised every new box starts empty and no
    // saved shift changes; NULL is the only value that means "this shift does not use this box".
    //
    // The reference description of shift MB28 is currently living in shift.name ("WITH 0.5 OT HOUR ADJ -
    // MORNING FULL (0800 - 1700)") because there was nowhere else to put it. This is that place.
    description: text('description'),
    // RECORDED ONLY in stage 1 (see ShiftDayType above). CHECK in migration 0417.
    dayType: text('day_type').$type<ShiftDayType | null>(),
    // RECORDED ONLY in stage 1 — a free-text grouping label from the reference screen. No enum: the
    // screenshot showed a typed value, not a dropdown, and inventing a closed set would refuse real data.
    category: text('category'),
    // Earliest allowed clock-in. Validated at or before start_time (core/roster.ts). Recorded + displayed
    // in stage 1; the engine's early-OT attribution is owned by the attendance rule's applyToEarlyOt flag
    // and by stage 2's OT windows, so this box does not silently become a second early-OT switch.
    earlyIn: time('early_in'),
    // Latest allowed clock-out, with the reference screen's "0430+" next-day marker. Validated at or after
    // the shift end ON THE SHIFT'S OWN TIMELINE (a cross-midnight shift's end is already next-day).
    lateOut: time('late_out'),
    lateOutNextDay: boolean('late_out_next_day'),
    // RECORDED ONLY in stage 1 — how many minutes of leave a full day of this shift consumes.
    fullDayLeaveMinutes: integer('full_day_leave_minutes'),
    // APPLIED — the one General box in stage 1 that moves a figure on its own. Rounds the shift's NET
    // SCHEDULED MINUTES DOWN to a multiple of this many minutes, inside core/attendance.ts
    // netScheduledMinutes, so the form's readout and the engine's threshold can never disagree.
    // NULL or 0 ⇒ no rounding (byte-identical).
    normalHoursRoundingMinutes: integer('normal_hours_rounding_minutes'),
    // RECORDED ONLY in stage 1 — the reference "Full Day OT Hours" box.
    fullDayOtMinutes: integer('full_day_ot_minutes'),
    // The half-day PAIR. `halfDayFirstOut` is the per-shift replacement for the ONE company-wide
    // attendance_policy.half_day_before: when set it is this shift's half-day cut-off, and when NULL the
    // shift keeps exactly the behaviour it has today (grace-derived threshold / the shift midpoint), so a
    // blank shift is unchanged. `halfDaySecondIn` is the afternoon half's clock-in — recorded, validated
    // against its partner and displayed; it has NO company-level counterpart and no engine consumer, and
    // deliberately does not reclassify a late arrival as a half-day (that would be a status change the
    // approved plan never described).
    halfDayFirstOut: time('half_day_first_out'),
    halfDaySecondIn: time('half_day_second_in'),
    // ── 6340aecb · Shift Settings redesign (migration 0457) ──────────────────────────────────────────
    // DISPLAY ONLY, and the only new column here that is. One of the fixed 8-token palette in
    // lib/shift-visual.ts (SHIFT_COLOR_TOKENS; a DB CHECK backs the service validation, mirroring
    // leave_type.color / migration 0179). Shown on the Shift list and used to tint this shift's cells on
    // the DUTY ROSTER (the reporter's point 7). NULL — every row before 0457 — is a first-class value:
    // components/roster-grid.tsx keeps its rotating position-keyed palette for an uncoloured shift, so the
    // roster is pixel-identical until somebody picks a colour. NEVER read for scheduling, attendance or pay.
    color: text('color'),
    // THE FLEXIBLE BREAK, and this one MOVES MINUTES — break handling feeds worked minutes, which feed
    // overtime, which payroll reads. A flexible break is an ALLOWANCE, not a clock window: the employee may
    // take up to `flexibleBreakMinutes` whenever they like, so there is no window for the engine to test the
    // clocking against. core/attendance.ts therefore deducts the allowance itself (clamped to the day's
    // span) instead of the punch's overlap with breakPeriods, and core/roster.ts writes the allowance into
    // `break_minutes` on save so the scheduled-hours figure, the punch import and the hourly clamp cannot
    // disagree with what the engine deducts. Fixed Break Start / Break End stay editable and stay stored
    // (the reporter's point 12: the allowance applies even when a window is configured).
    //
    // DEFAULT false ⇒ every shift stored before 0457 keeps the exact deduction it has today. That is the
    // approved plan's promise and it is pinned in ringgit by test/shift-colour-flex-break.test.ts, the same
    // discipline 711adcd2's ORP flags needed and for the same reason.
    flexibleBreakEnabled: boolean('flexible_break_enabled').notNull().default(false),
    flexibleBreakMinutes: integer('flexible_break_minutes'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  // R33 f21d6eee — Shared shift library: tenant-wide, case-insensitive, non-archived unique on name AND code
  // (migration 0197 replaced the per-(tenant,company) indexes shift_company_name_uq / shift_company_code_uq).
  (t) => [
    uniqueIndex('shift_tenant_name_uq').on(t.tenantId, sql`lower(${t.name})`).where(sql`archived_at is null`),
    uniqueIndex('shift_tenant_code_uq').on(t.tenantId, sql`lower(${t.code})`).where(sql`archived_at is null`),
  ],
);

/**
 * cf21e554 STAGE 2 — the shift's own Overtime Schedule (migration 0418). One row = one overtime window on
 * ONE shift, expressed in WALL-CLOCK time ("05:00–08:00", "17:00–23:59"), which is how the reporter's
 * reference screen states them.
 *
 * WHY NOT attendance_rule_ot_row. That table's bands are measured in MINUTES PAST NORMAL and belong to a
 * RULE several shifts share. Different unit, different owner. See migration 0418's header.
 *
 * WHAT IT OWNS AND WHAT IT DOES NOT. These windows decide WHICH clocked minutes count as workday overtime
 * (and apply the window's own minimum, maximum and adjustment). They do NOT round and they do NOT price:
 * the engine hands the total to applyOtRuleRows afterwards, so the rule's band rounding and the statutory
 * 1.5×/2×/3× cap keep owning rounding and pay exactly as before.
 */
export const shiftOtWindow = pgTable(
  'shift_ot_window',
  {
    id: id(),
    tenantId: tenantId(),
    shiftId: uuid('shift_id')
      .notNull()
      .references(() => shift.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    /** The reference grid's "OT" column — a name for the window. Optional. */
    label: text('label'),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    /** The window ends on the day AFTER it starts (the reference's next-day marker). */
    endNextDay: boolean('end_next_day').notNull().default(false),
    /** Min.Hrs / Max.Hrs in MINUTES. Below the minimum the window yields nothing; above the maximum it is
     *  clamped. NULL = unbounded on that side. */
    minMinutes: integer('min_minutes'),
    maxMinutes: integer('max_minutes'),
    /** The reference's "0030-" against "0130" on a shift named "WITH 0.5 OT HOUR ADJ": once this window's
     *  overtime reaches `adjustAfterMinutes`, ADD `adjustDeltaMinutes` to it. The delta is SIGNED — −30 is
     *  the reporter's deduction. Both columns or neither (DB CHECK). */
    adjustAfterMinutes: integer('adjust_after_minutes'),
    adjustDeltaMinutes: integer('adjust_delta_minutes'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('shift_ot_window_shift_idx').on(t.tenantId, t.shiftId, t.sortOrder),
    // One row per grid position, so which adjustment belongs to which window can never depend on physical
    // row order after a re-save.
    uniqueIndex('shift_ot_window_shift_sort_uq').on(t.shiftId, t.sortOrder),
  ],
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

/**
 * 18504ca6 (migration 0421) — THE SHIFT ARRANGEMENT LADDER: which shift a person was on, FROM WHEN.
 *
 * Before this table, saving the Shift arrangement card UPDATEd employment.shift_type +
 * employment.default_shift_id in place, so the previous shift was simply gone — the system could not say
 * which shift someone was on last month, and a day later corrected or re-imported was re-measured against
 * TODAY's shift. Each row here is one dated period; a change CLOSES the open row (valid_to = the day before)
 * and INSERTs the new one, so periods can never overlap and never gap.
 *
 * employment.default_shift_id IS NOW A CACHE of the row in force at save time, not the source of truth. The
 * resolvers (core/shift-arrangement.ts) read this ladder first and fall back to the cache ONLY for an
 * employment with no row at all — a legacy write, or the b8aa3466 backup-shift backfill, which only touches
 * employees who have no shift and therefore no row here. That fallback is what keeps every unconverted code
 * path byte-identical.
 *
 * `valid_to` is derived (successor's valid_from − 1 day) and stored for readability; resolution itself picks
 * the greatest live `valid_from` <= the date being asked about, so a stale valid_to can never open a gap.
 * A date BEFORE the earliest row resolves to the EARLIEST row — the release promise is that no historical
 * figure moves, and the earliest row is the shift that date resolves to today.
 */
export const employmentShiftArrangement = pgTable(
  'employment_shift_arrangement',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    /** The reporter's "Shift type", carried per PERIOD so history says which arrangement was in force too. */
    shiftType: text('shift_type').$type<'fixed' | 'roster'>().notNull(),
    /** NOT NULL: b8aa3466 made the backup shift mandatory on both arrangements — there is no dated period
     *  with no shift. */
    shiftId: uuid('shift_id')
      .notNull()
      .references((): AnyPgColumn => shift.id),
    validFrom: date('valid_from').notNull(),
    /** Closed to the day BEFORE the successor's valid_from. NULL = the open, current period. */
    validTo: date('valid_to'),
    /** Set when a save for the SAME valid_from replaces this entry. Invisible to every resolver afterwards. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: createdAt(),
    /** Who moved them. NULL on the rows migration 0421 backfills — nobody made that change; it is the shift
     *  the employee already had, recorded as applying since their start date. */
    createdBy: uuid('created_by').references(() => appUser.id),
  },
  (t) => [
    uniqueIndex('employment_shift_arrangement_live_uq')
      .on(t.tenantId, t.employmentId, t.validFrom)
      .where(sql`${t.supersededAt} is null`),
    index('employment_shift_arrangement_emp_idx').on(t.tenantId, t.employmentId, t.validFrom),
    check('employment_shift_arrangement_type_ck', sql`${t.shiftType} in ('fixed', 'roster')`),
    check(
      'employment_shift_arrangement_range_ck',
      sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`,
    ),
  ],
);

// ── ADR-0033: Leave-in-lieu (TOIL). Gated (TOIL_ENABLED). A contractual replacement-leave engine that turns
// elected+approved rest-day/holiday/OT work into a REPLACEMENT-type leave credit, mutually exclusive with OT
// pay. The toil_accrual register is the source of truth for no-double-pay + expiry; each accrual also writes a
// signed leave_ledger credit so leaveBalance() just works. ──────────────────────────────────────────────
export const toilAccrualBasisEnum = pgEnum('toil_accrual_basis', ['hours_worked', 'premium_equivalent']);
export const toilExpiryActionEnum = pgEnum('toil_expiry_action', ['convert_to_pay', 'lapse']);
// 3fb1a611 (migration 0469): 'reversed' — an HR reversal. The register row is NEVER deleted: it stays, marked
// reversed, beside the offsetting leave_ledger debit (`reversalLedgerEntryId`). core/payroll.ts
// EXCLUDE_TOIL_BANKED_DAYS treats a reversed credit as never banked, so the worked day's overtime is payable again.
export const toilAccrualStatusEnum = pgEnum('toil_accrual_status', ['active', 'taken', 'converted_to_pay', 'lapsed', 'reversed']);
// 296fc027 (migration 0380): the expiry PERIOD gains a unit. `days` reproduces today's behaviour exactly
// and is the default every existing row lands on; `months` is calendar-month addition (see addMonths in
// core/toil.ts), never 30-day arithmetic.
export const toilExpiryUnitEnum = pgEnum('toil_expiry_unit', ['days', 'months']);
// 296fc027 (migration 0380): "Replacement Leave From" — RECORDED ONLY. Nothing reads this but the form
// that writes it; no attendance or overtime figure is validated against it, and the page says so on
// screen. Deliberately NOT folded into `toilAccrualBasisEnum`, which answers a different question (how
// much one banked day is worth, not which worked time may be banked at all).
export const toilReplacementLeaveFromEnum = pgEnum('toil_replacement_leave_from', [
  'working_hours',
  'overtime',
  'working_hours_and_overtime',
]);
export type ToilAccrualBasis = (typeof toilAccrualBasisEnum.enumValues)[number];
export type ToilExpiryAction = (typeof toilExpiryActionEnum.enumValues)[number];
export type ToilAccrualStatus = (typeof toilAccrualStatusEnum.enumValues)[number];
export type ToilExpiryUnit = (typeof toilExpiryUnitEnum.enumValues)[number];
export type ToilReplacementLeaveFrom = (typeof toilReplacementLeaveFromEnum.enumValues)[number];
// 296fc027 (migration 0381): which path minted a credit. NULL on every row banked before this existed.
// 3fb1a611 (migration 0469) adds 'hr_manual_grant' — a credit HR added on the Leave Credit screen for a day
// worked that nobody claimed. Written through the same `bankToilCreditTx` as every other path, so it carries a
// frozen expiry, a FIFO position and the First Schedule gate.
export const toilAccrualSourceEnum = pgEnum('toil_accrual_source', ['roster', 'auto_approval', 'employee_request', 'hr_manual_grant']);
export type ToilAccrualSource = (typeof toilAccrualSourceEnum.enumValues)[number];
// 3fb1a611 (migration 0469): the kind of day that EARNED a credit, resolved from the employee's schedule
// (core/attendance.ts workedDayKindForTx). A separate enum and NOT a widening of `attendance_day_type`, which
// is shared with plan_ot and payroll's OT math and deliberately has no off day (core/attendance.ts b8aa3466).
export const toilWorkedDayKindEnum = pgEnum('toil_worked_day_kind', ['workday', 'rest_day', 'off_day', 'holiday']);
export type ToilWorkedDayKind = (typeof toilWorkedDayKindEnum.enumValues)[number];

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
    // 296fc027 (migration 0380) — the four settings the Replacement Leave config page adds.
    //
    // TWO COUNTS, ONE UNIT, and no overloading of `expiryDays`. `expiryDays` keeps its exact current
    // meaning (the stored day count, authoritative when expiryUnit is 'days'), so every existing row is
    // untouched; `expiryMonths` is authoritative when the unit is 'months'. Both are always populated, so
    // flipping the unit on the form and back is lossless. `resolveExpiry` in core/toil.ts is the single
    // reader of the trio — nothing else may do the arithmetic.
    expiryUnit: toilExpiryUnitEnum('expiry_unit').notNull().default('days'),
    expiryMonths: integer('expiry_months').notNull().default(3),
    // The employee-request switch. OFF for every existing row (there is no employee path today). When OFF
    // the employee never sees the button AND cannot submit — `assertEmployeeMaySubmit` enforces it in the
    // service, because the UI is one action POST away from being bypassed.
    employeeRequestEnabled: boolean('employee_request_enabled').notNull().default(false),
    // RECORDED ONLY (see the enum's note). Default 'overtime' because that is what the engine does today.
    replacementLeaveFrom: toilReplacementLeaveFromEnum('replacement_leave_from').notNull().default('overtime'),
    // Who may submit. Same JSONB shape as `leaveType.eligibility` — criterion key → string[], empty or
    // absent ⇒ no restriction on that criterion. NULL ⇒ everyone, which is the only safe backfill for a
    // switch that is itself off by default. Resolved by core/replacement-eligibility.ts.
    requestEligibility: jsonb('request_eligibility').$type<ReplacementRequestEligibility | null>(),
    // ── r334 928f0454 (migration 0486) · EXTENDED HOURS ON AN ORDINARY WORKING DAY ─────────────────────
    //
    // The five settings that let work past a workday's scheduled shift end earn a Leave Credit. Until r334
    // only a rest day, an off day or a public holiday could (core/toil.ts `RL_ELIGIBLE_DAY_TYPES`, the
    // "RL Control Engine" rule) — a plain workday's overtime was cash-only. That rule is NOT relaxed; it
    // is left exactly as it was, and this switch opens a SEPARATE, tiered path beside it. See the block
    // comment above `RL_ELIGIBLE_DAY_TYPES` for why the set's membership must never be widened instead.
    //
    // ⚠️ MONEY. A credit SUPPRESSES that day's overtime pay (core/payroll.ts `EXCLUDE_TOIL_BANKED_DAYS`,
    // both reads, unconditional). Switching this on therefore moves real money off a payslip, which is why
    // it is OFF by default on every existing row and why every threshold below has a column default that
    // reproduces the reporter's stated figures rather than a guess.
    //
    // NOT NULLABLE, with defaults, deliberately: `setToilPolicy` is a FULL-REPLACE upsert, so an omitting
    // caller must land on the pre-r334 policy rather than on NULL arithmetic.
    /** OFF by default. When off, every workday election is refused with the pre-r334 message, byte for byte. */
    extendedHoursEnabled: boolean('extended_hours_enabled').notNull().default(false),
    /** ≥ this many counted minutes past shift end ⇒ 0.5 day. Reporter's default: 4 hours. */
    extendedHalfDayMinutes: integer('extended_half_day_minutes').notNull().default(240),
    /** ≥ this many counted minutes ⇒ 1.0 day, and that is the per-day CAP — never more. Default: 8 hours. */
    extendedFullDayMinutes: integer('extended_full_day_minutes').notNull().default(480),
    /** An unpaid break taken AFTER shift end, deducted before the tiers are tested. Default 0 ⇒ no-op. */
    extendedBreakMinutes: integer('extended_break_minutes').notNull().default(0),
    /** The first N minutes past shift end do not count at all. Default 0 ⇒ no-op. */
    extendedGraceMinutes: integer('extended_grace_minutes').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('toil_policy_company_uq').on(t.companyId)],
);

/**
 * 296fc027 — who may submit a replacement-leave request, as stored on `toil_policy.requestEligibility`.
 *
 * Declared HERE rather than in core/ so the schema can type the JSONB column without importing a service
 * module (db/schema.ts is imported by everything, including client-adjacent code). The descriptor that
 * drives the picker, the resolver and the summary lives in core/replacement-eligibility.ts.
 *
 * Every field is a list of allowed values; an empty or absent list restricts nothing. `employmentIds` is
 * the ONE field that widens rather than narrows — see RESOLUTION RULE in core/replacement-eligibility.ts.
 */
export type ReplacementRequestEligibility = {
  companyIds?: string[];
  employmentTypes?: string[];
  departmentIds?: string[];
  divisions?: string[];
  positionIds?: string[];
  gradeIds?: string[];
  employmentCategories?: string[];
  employmentIds?: string[];
};

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
    // 296fc027 (migration 0381): NULLABLE. A credit granted from an EMPLOYEE REQUEST has no attendance row
    // behind it, so it has no day type — and a fabricated 'workday' would flow into the expiry sweep's
    // exact-statutory-cash calculation and produce a wrong convert-to-pay figure for a First-Schedule
    // employee. NULL is the honest record; core/toil.ts falls back to the contractual ORP basis and says so.
    dayType: attendanceDayTypeEnum('day_type'),
    otMinutes: integer('ot_minutes').notNull(),
    daysCredited: numeric('days_credited', { precision: 6, scale: 2 }).notNull(),
    // 0113 (RL Control Engine): signed per-accrual consumption tally. The active bucket nets to
    // Σ(daysCredited − daysTaken); an accrual flips to 'taken' only once fully consumed. One row per worked
    // day (preserves the unique index + the payroll predicate join) instead of splitting on partial use.
    daysTaken: numeric('days_taken', { precision: 6, scale: 2 }).notNull().default('0'),
    accrualBasis: toilAccrualBasisEnum('accrual_basis').notNull(),
    // 00307068 (migration 0354): the two dates the employee's Replacement Leave table shows and the register
    // never recorded. Both NULLABLE — a legacy row genuinely does not know them and the panel renders a dash
    // rather than a fabricated date.
    //  • requestedOn — the day the credit was ASKED for. The auto path writes the linked attendance
    //    correction's created_at::date; the manual roster election has no employee request at all, so it
    //    writes the worked date.
    //  • approvedOn  — the instant a line manager's decision banked it. Also the ANCHOR expiresOn is counted
    //    from (approvedOn::date + policy.expiryDays), replacing the worked-date anchor.
    requestedOn: date('requested_on'),
    approvedOn: timestamp('approved_on', { withTimezone: true }),
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
    // 296fc027 (migration 0381): which path minted this credit. NULLABLE with no backfill — a legacy row
    // genuinely does not know, and a guessed value would make the audit trail claim a precision it lacks.
    source: toilAccrualSourceEnum('source'),
    // 3fb1a611 (migration 0469) — all NULLABLE, none back-filled. See the migration header.
    //  • workedDayKind — workday / rest_day / off_day / holiday: the day that earned the credit. `dayType` keeps
    //    the attendance vocabulary the expiry sweep values from; an off day is recorded HERE with dayType NULL.
    //  • note / remarks — HR's stated reason (required) and optional remarks on a hand-added credit.
    //  • reversedAt / reversalReason / reversalLedgerEntryId — a reversal: the offsetting leave_ledger debit.
    //  • settledLedgerEntryId — the debit the expiry sweep wrote when it expired or paid out this credit.
    workedDayKind: toilWorkedDayKindEnum('worked_day_kind'),
    note: text('note'),
    remarks: text('remarks'),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),
    reversalLedgerEntryId: uuid('reversal_ledger_entry_id').references((): AnyPgColumn => leaveLedger.id),
    settledLedgerEntryId: uuid('settled_ledger_entry_id').references((): AnyPgColumn => leaveLedger.id),
    policyId: uuid('policy_id').references((): AnyPgColumn => toilPolicy.id),
    ledgerEntryId: uuid('ledger_entry_id').references((): AnyPgColumn => leaveLedger.id),
    takenByRequestId: uuid('taken_by_request_id').references((): AnyPgColumn => leaveRequest.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // At most one UNREVERSED accrual per worked day — the no-double-pay guard at the DB level. 3fb1a611
    // (migration 0469) made it partial: a reversed credit no longer occupies the key, so a credit entered
    // wrongly can be reversed and entered again. Two live credits for one worked day stay impossible.
    uniqueIndex('toil_accrual_emp_date_uq')
      .on(t.tenantId, t.employmentId, t.workedDate)
      .where(sql`${t.status} <> 'reversed'`),
    index('toil_accrual_expiry_idx').on(t.tenantId, t.status, t.expiresOn),
  ],
);

// ── 296fc027 (migration 0381): the EMPLOYEE REPLACEMENT-LEAVE REQUEST. ───────────────────────────────
//
// NOT a `leave_request`. That table means TIME TAKEN everywhere it is read — the balance check, the team
// calendar, payroll's unpaid days — and a replacement-leave request is the opposite: a claim for time
// ALREADY WORKED that should ADD to a balance. Reusing it would have corrupted all three, silently.
export const replacementLeaveRequestUnitEnum = pgEnum('replacement_leave_request_unit', ['day', 'hour']);
export const replacementLeaveRequestStatusEnum = pgEnum('replacement_leave_request_status', [
  'pending',
  'approved',
  'rejected',
  'cancelled',
]);
export type ReplacementLeaveRequestUnit = (typeof replacementLeaveRequestUnitEnum.enumValues)[number];
export type ReplacementLeaveRequestStatus = (typeof replacementLeaveRequestStatusEnum.enumValues)[number];

/**
 * r336 cbfa8b0b · WHICH OF THE TWO SECTIONS a claim line was filed from.
 *
 *  · 'non_working_day' — Section A. A rest day, an off day or a public holiday that was worked. The credit
 *    is the number of days the employee claims (1 or 0.5).
 *  · 'extended_hours'  — Section B. Hours past the scheduled shift end of an ORDINARY WORKING DAY. The
 *    credit is DERIVED by r334's tier ladder from the eligible minutes and is never typed.
 *
 * A list rather than a pgEnum for the reason migration 0275 recorded; the DB CHECK in 0487 is the
 * constraint. `LEGACY_CLAIM_SOURCE_TYPE` names what a NULL column means so no reader has to guess: every
 * line written before r336 is a Section A claim, because Section B did not exist.
 */
export const REPLACEMENT_CLAIM_SOURCE_TYPES = ['non_working_day', 'extended_hours'] as const;
export type ReplacementClaimSourceType = (typeof REPLACEMENT_CLAIM_SOURCE_TYPES)[number];
export const LEGACY_CLAIM_SOURCE_TYPE: ReplacementClaimSourceType = 'non_working_day';

export const replacementLeaveRequest = pgTable(
  'replacement_leave_request',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    leaveTypeId: uuid('leave_type_id').references((): AnyPgColumn => leaveType.id),
    // One unit per REQUEST, not per line: a mixed request would have no honest total to show at the
    // bottom of the table, which is the figure the employee is asked to check before submitting.
    unit: replacementLeaveRequestUnitEnum('unit').notNull(),
    // Stored as submitted rather than re-summed on read — they are what the employee saw and agreed to.
    totalDays: numeric('total_days', { precision: 6, scale: 2 }).notNull().default('0'),
    totalHours: numeric('total_hours', { precision: 6, scale: 2 }).notNull().default('0'),
    reason: text('reason'),
    /** The REQUEST date, frozen here and copied onto each credit at approval. */
    submittedOn: date('submitted_on').notNull(),
    status: replacementLeaveRequestStatusEnum('status').notNull().default('pending'),
    /** The APPROVAL instant — and the anchor the expiry period is counted from. */
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedByUserId: uuid('decided_by_user_id').references((): AnyPgColumn => appUser.id),
    decisionNote: text('decision_note'),
    // Recorded consent to bank time instead of the statutory overtime cash. Meaningful only for a
    // First-Schedule employee. The GATE lives in core/toil.ts and is re-applied at approval — this column
    // records the agreement, it is not trusted as the check.
    firstScheduleConsent: boolean('first_schedule_consent'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('rl_request_employment_idx').on(t.employmentId, t.status)],
);

export const replacementLeaveRequestDate = pgTable(
  'replacement_leave_request_date',
  {
    id: id(),
    tenantId: tenantId(),
    requestId: uuid('request_id')
      .notNull()
      .references((): AnyPgColumn => replacementLeaveRequest.id, { onDelete: 'cascade' }),
    // Denormalised so the RLS policy keys on it directly, exactly as leave_request_date does.
    subjectEmploymentId: uuid('subject_employment_id')
      .notNull()
      .references(() => employment.id),
    workedDate: date('worked_date').notNull(),
    // Populated per the request's unit: `days` for Day, `fromTime`/`toTime`/`hours` for Hour.
    days: numeric('days', { precision: 6, scale: 2 }),
    fromTime: time('from_time'),
    toTime: time('to_time'),
    hours: numeric('hours', { precision: 6, scale: 2 }),
    /** The credit this line minted once approved. NULL while pending, and NULL forever if rejected. */
    accrualId: uuid('accrual_id').references((): AnyPgColumn => toilAccrual.id),
    // ── r336 cbfa8b0b · the Leave Credit request's TWO KINDS OF CLAIM, on the line that already holds the
    // date, the times and the days (migration 0487's header records why this is an ALTER rather than a new
    // claim-line table). Every column is nullable: a line written before r336 has `sourceType` NULL and is
    // read as a non-working-day claim, which is exactly what it was.
    //
    //  · sourceType      — 'non_working_day' (Section A: a rest day, off day or public holiday worked) or
    //                      'extended_hours' (Section B: hours past the scheduled shift end of a WORKING day).
    //                      text + a DB CHECK, not a pgEnum — the 0275 widening lesson, the same shape
    //                      attendance_correction.ot_reason_category uses.
    //  · workedDayKind   — the kind resolved from the roster AT SUBMISSION, so an approver reads the day the
    //                      employee was shown rather than re-deriving it against a roster that has moved.
    //                      NOT the control: submission and approval both re-resolve it and refuse a mismatch.
    //  · shiftEnd        — Section B's read-only "Scheduled shift end", from the resolved schedule.
    //  · actualClockOut  — Section B's read-only "Actual clock-out", from the attendance row.
    //  · eligibleMinutes — Section B's derived "Eligible minutes": the claimed window intersected with
    //                      [shift end, actual clock-out] and capped by the measured figure. ⚠️ MONEY — this
    //                      is a RECORD, never a valuation input. See migration 0487's header.
    sourceType: text('source_type').$type<ReplacementClaimSourceType>(),
    workedDayKind: text('worked_day_kind').$type<ToilWorkedDayKind>(),
    shiftEnd: time('shift_end'),
    actualClockOut: time('actual_clock_out'),
    eligibleMinutes: integer('eligible_minutes'),
    createdAt: createdAt(),
  },
  (t) => [
    // The same worked date twice in one request is a data-entry slip. The CROSS-request guard is
    // toil_accrual's own unique index — the one that also stops an employee claiming a date a manager
    // already banked.
    uniqueIndex('rl_request_date_request_date_uq').on(t.requestId, t.workedDate),
    index('rl_request_date_request_idx').on(t.requestId),
    index('rl_request_date_subject_idx').on(t.subjectEmploymentId, t.workedDate),
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
    // Explicit external-mail consent; historical rows with NULL consent never enable email.
    emailConsentUserId: uuid('email_consent_user_id').references(() => appUser.id),
    emailAfterSequence: bigint('email_after_sequence', { mode: 'number' }),
    emailLocale: text('email_locale').notNull().default('en'),
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
    recipientUserId: uuid('recipient_user_id').references(() => appUser.id),
    sourceEventId: uuid('source_event_id'),
    kind: text('kind'),
    category: text('category'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('notification_delivery_pending_idx').on(t.tenantId, t.status),
    index('notification_email_recent_idx').on(t.tenantId,t.createdAt.desc(),t.id.desc()).where(sql`channel='email'`),
    uniqueIndex('notification_email_event_user_uq').on(t.tenantId, t.sourceEventId, t.recipientUserId, t.kind)
      .where(sql`channel='email' AND source_event_id IS NOT NULL AND recipient_user_id IS NOT NULL`),
  ],
);

// Tenant-wide category permission is independent of a recipient's explicit preference.
export const notificationEmailPolicy = pgTable('notification_email_policy', {
  id: id(), tenantId: tenantId(), category: text('category').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  afterSequence: bigint('after_sequence', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('notification_email_policy_tenant_id_category_key').on(t.tenantId, t.category)]);

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

// ─────────────────────── Notice Board (6e122302) ───────────────────────
//
// A notice is an announcement HR publishes to a RESOLVED SET of employments. Two tables:
//
//   notice            — the announcement itself: what it says, when it is visible, how it behaves.
//   notice_recipient  — THE AUDIENCE SNAPSHOT, one row per (notice, employment), written AT PUBLISH.
//
// ── WHY THE AUDIENCE IS SNAPSHOT AND NOT RE-RESOLVED — the decision that matters most here ──────────────
// It would be less code to store only the criteria and re-run the resolver on every read. It would also be
// wrong. An employee who transfers department after a notice is published would silently LOSE a notice they
// had already been sent — and, once acknowledgement ships, an acknowledgement report that changes
// retrospectively is not a record of anything. So publishing RESOLVES the criteria once and persists the
// employment ids; `notice.criteria` is kept alongside purely for disclosure ("who was this aimed at?").
// `leave_adjustment_batch` is the same shape and the same reasoning.
//
// ── WHY THERE IS NO STATUS COLUMN ──────────────────────────────────────────────────────────────────────
// Draft / Scheduled / Active / Expired are FUNCTIONS OF THE DATES plus published_at, and Archived is
// archived_at. Storing a status would need a nightly job to flip it and would give it a way to be wrong.
// `deriveNoticeStatus` (core/notice.ts) is the single definition, used by the listing, the reads and the
// tests alike.
export const notice = pgTable(
  'notice',
  {
    id: id(),
    tenantId: tenantId(),
    title: text('title').notNull(),
    /** Markdown, rendered through components/markdown.tsx — the SAME renderer the Knowledge Base uses,
     *  which passes no raw HTML through (no rehype-raw) and therefore cannot carry stored XSS. */
    body: text('body').notNull(),
    /** Visibility window. Both required: an announcement with no end date is a permanent fixture nobody
     *  removes. `show_end_date` decides whether the employee is TOLD the end date, not whether one exists. */
    startOn: date('start_on').notNull(),
    endOn: date('end_on').notNull(),
    showEndDate: boolean('show_end_date').notNull().default(false),
    /** 'criteria' (resolved from filters) or 'individual' (explicitly picked) — the leave_adjustment_batch
     *  vocabulary, because the same resolved set means different things and a re-publish can legitimately
     *  reach different people. */
    targetMode: text('target_mode').notNull().default('criteria'),
    /** The criteria AS POSTED (core/org-criteria.ts OrgCriteria shape). Disclosure only — the audience that
     *  counts is notice_recipient. An empty object means "everyone", which is why the screen shows a count. */
    criteria: jsonb('criteria'),
    /** Null ⇒ draft. Set once, at publish; a published notice is edited in place, never un-published (that
     *  would strand the recipients who already saw it). Archive is the way to withdraw one. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedByUserId: uuid('published_by_user_id').references(() => appUser.id),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedByUserId: uuid('archived_by_user_id').references(() => appUser.id),
    /** Should publishing raise a notification (which the existing engine may also deliver by email)? There
     *  is deliberately no second mail path — see the `notice.published` entry in core/notifications.ts. */
    notifyOnPublish: boolean('notify_on_publish').notNull().default(false),
    popupEnabled: boolean('popup_enabled').notNull().default(false),
    /** 'once' (default — show once per notice per employee, then never again) or 'until_acknowledged'
     *  (keep showing while the notice is live). Decided in the plan rather than asked, because a notice
     *  that reappears at every login is the fastest way to make people resent the product. */
    popupFrequency: text('popup_frequency').notNull().default('once'),
    createdByUserId: uuid('created_by_user_id').references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('notice_tenant_window_idx').on(t.tenantId, t.startOn, t.endOn),
    index('notice_tenant_created_idx').on(t.tenantId, t.createdAt),
  ],
);

/**
 * The audience snapshot. One row per (notice, employment), written when the notice is PUBLISHED.
 *
 * `firstViewedAt` is a VIEW marker, not an acknowledgement — it is what makes the dashboard card's "3 new"
 * badge possible. `popupDismissedAt` is popup-frequency state and nothing else. Acknowledgement, when it
 * ships, is its own row with its own evidence (name typed, agreement text, timestamp); it must not be
 * conflated with either of these.
 */
export const noticeRecipient = pgTable(
  'notice_recipient',
  {
    id: id(),
    tenantId: tenantId(),
    noticeId: uuid('notice_id')
      .notNull()
      .references((): AnyPgColumn => notice.id, { onDelete: 'cascade' }),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    firstViewedAt: timestamp('first_viewed_at', { withTimezone: true }),
    popupDismissedAt: timestamp('popup_dismissed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('notice_recipient_uq').on(t.noticeId, t.employmentId),
    index('notice_recipient_employment_idx').on(t.tenantId, t.employmentId),
  ],
);

export const profileChangeStatusEnum = pgEnum('profile_change_status', [
  'pending',
  'approved',
  'rejected',
]);

// Profile changes the employee proposes on /me. An admin approves before any of it takes effect
// (ADR-0012). `proposed` is a jsonb patch; approval applies only the keys it carries.
// Low-risk contact fields are edited directly on `person` and do NOT pass through here.
//
// 9583deac stage two (r260) widened WHICH fields may be proposed — from bank / PCB category /
// dependants to the declared set in lib/profile-requestable-fields.ts, which also says which of the two
// tables below each key is applied to. The table itself did not change shape for that: a jsonb patch was
// already indifferent to how many keys it carries.
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
    /**
     * 9583deac stage two (migration 0458) — the approver's words, shown to the EMPLOYEE beside their own
     * request on My Profile. REQUIRED on a rejection and optional on an approval.
     *
     * "Required" is enforced AT THE DECISION (core/profile.ts throws ProfileChangeReasonRequiredError
     * before the transaction opens) and deliberately NOT by a CHECK on this table. The first draft of
     * 0458 carried `CHECK (status <> 'rejected' OR decision_reason <> '') NOT VALID`; NOT VALID skips
     * the historical scan but is STILL enforced on the new row version of every UPDATE, and
     * core/pdpa.ts rewrites every one of a subject's rows during an erasure — so a legacy reasonless
     * rejection would have aborted that employee's whole PDPA erasure. The rule belongs where the
     * decision is made, not on a row every unrelated writer has to satisfy. Requests rejected before
     * this column existed stay honestly blank.
     */
    decisionReason: text('decision_reason'),
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

// f018ce8d — general employee document store (Personnel → Documents tab redesign). Replaces the old
// read-only statutory summary with a real file repository: HR uploads categorized supporting documents
// (PDF / Word / Excel / PowerPoint / images / text) against an employee. bytea side-table mirroring
// claim_attachment / review_document (employment_id denormalized so RLS resolves via can_see_employment
// directly). Read = subject + administrative-line manager + admin; write = admin only (see 0183 RLS).
// title is the mandatory display name; category + description are optional metadata. uploaded_by /
// updated_by capture the audit actors surfaced in the grid; updated_at bumps on meta edits + replacements.
export const employeeDocument = pgTable(
  'employee_document',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    title: text('title').notNull(),
    category: text('category'),
    description: text('description'),
    content: bytea('content').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    uploadedByUserId: uuid('uploaded_by_user_id'),
    updatedByUserId: uuid('updated_by_user_id'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('employee_document_employment_idx').on(t.tenantId, t.employmentId)],
);

// ADR-0050 (#1.1.3): yearly self-service TP1 personal tax relief. Keyed by `person_id` (TP1 is the
// employee's own statutory declaration). One scalar `tp1_amount` per assessment year — the single number
// the PCB kernel consumes (LP). Append-only request-row shape (profile_change_request pattern): the latest
// row per (person, year) wins; the editable draft is UPDATEd in place; a submitted row is immutable and a
// correction is a NEW submitted row. RLS scopes to app.can_see_person (self + admin) for read AND write.
// 7ad37961 (migration 0448) — the LHDN TP1 record gains a real lifecycle: Draft → Submitted →
// Approved / Rejected → Cancelled. `approved` is what GATES THE PAYROLL FEED from this round on
// (core/payroll.ts prefillTp1FromSelfRelief), which is why 0449 backfills every already-submitted row to
// approved: without it every existing employee's relief would silently stop the day this ships.
// ⚠️ 0448 REPLACES THE TYPE RATHER THAN ADDING VALUES TO IT, and the reason matters: drizzle replays
// EVERY pending migration inside ONE transaction (pg-core/dialect.js), so a value ADDED to a
// pre-existing enum cannot be USED by any migration in the same run — 0449's backfill hit exactly that
// (55P04). A type CREATED in the transaction has no such restriction. 0448's header carries the full
// account, including which older notes in this repo state the mechanism incorrectly.
export const tp1StatusEnum = pgEnum('tp1_status', [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'cancelled',
]);

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

/** The LEGACY eight-key payload. Rows written before 7ad37961 carry exactly this and MUST stay readable. */
export type Tp1LegacyCategories = Partial<Record<Tp1CategoryKey, number>> & { remarks?: string | null };

/**
 * One numbered item of the LHDN TP1 (1/2026) form as stored (7ad37961, ADR-0081). `amount` is the item's
 * CURRENT deduction figure; for an item the form gives lettered boxes to, it is the round2 sum of
 * `subItems` and the server always recomputes it — the client's own total is never trusted, at any level.
 */
export type Tp1ItemAmounts = {
  amount: number;
  /** Lettered sub-line amounts, keyed by the pack catalogue's sub-item code ('a', 'b', …). */
  subItems?: Record<string, number>;
};

/**
 * The TP1 (1/2026) payload: `items` keyed c1…c17 and `rebates` keyed d1, matching the pack catalogue
 * (localization/my/statutory-tables MY_TP1_2026). `form` is the DISCRIMINATOR — a row without it is a
 * legacy eight-key row and is read as one (core/tax-relief.ts resolveInput branches on exactly this).
 *
 * REBATES ARE NOT DEDUCTIONS and are deliberately outside the `tp1_amount` roll-up: a Section D rebate
 * reduces the tax, not the chargeable income the PCB kernel projects. Storing them here keeps the form
 * complete and printable without moving a single cent of the monthly MTD arithmetic.
 */
export type Tp1Categories2026 = {
  form: 'tp1-2026';
  items: Record<string, Tp1ItemAmounts>;
  rebates?: Record<string, Tp1ItemAmounts>;
  remarks?: string | null;
};

/** Either payload shape. Both carry `remarks`, so a reader that only wants the note need not branch. */
export type Tp1Categories = Tp1LegacyCategories | Tp1Categories2026;

/** Narrow a stored payload to the 2026 catalogue shape (the discriminator, in one place). */
export function isTp1Categories2026(c: Tp1Categories | null | undefined): c is Tp1Categories2026 {
  return !!c && (c as Tp1Categories2026).form === 'tp1-2026';
}

/** HR's approved incentive declaration belongs to one employment, employer and effective period. */
export const employmentTaxSchemeMy = pgTable('employment_tax_scheme_my', {
  id: id(), tenantId: tenantId(),
  employmentId: uuid('employment_id').notNull().references(() => employment.id),
  companyId: uuid('company_id').notNull().references(() => company.id),
  scheme: text('scheme').notNull().$type<'rep' | 'knowledge_worker' | 'c_suite'>(),
  validFrom: text('valid_from').notNull(), validTo: text('valid_to').notNull(),
  approvalReference: text('approval_reference').notNull(),
  declaredByUserId: uuid('declared_by_user_id').notNull().references(() => appUser.id),
  declaredAt: timestamp('declared_at', {withTimezone:true}).defaultNow().notNull(),
  archivedAt: timestamp('archived_at', {withTimezone:true}),
});

/** One selected PCB category per employment/employer. Prior declarations stay immutable history. */
export const employmentTaxSelectionMy = pgTable('employment_tax_selection_my', {
  id: id(), tenantId: tenantId(),
  employmentId: uuid('employment_id').notNull().references(() => employment.id),
  companyId: uuid('company_id').notNull().references(() => company.id),
  scheme: text('scheme').$type<'resident'|'non_resident'|'rep'|'knowledge_worker'|'c_suite'>(),
  transitionState: text('transition_state').notNull().$type<'resolved'|'confirmation_required'>(),
  version: integer('version').notNull().default(1),
  taxApplicabilityEpoch: integer('tax_applicability_epoch').notNull().default(0),
  legacyScheme: text('legacy_scheme'),
  source: text('source').notNull().$type<'legacy_conversion'|'explicit'>(),
  provenance: jsonb('provenance').notNull().$type<{reason:string;declarationIds:string[]}>(),
  updatedByUserId: uuid('updated_by_user_id').references(() => appUser.id),
  createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
  updatedAt: timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
}, t => [uniqueIndex('employment_tax_selection_my_context').on(t.tenantId,t.employmentId,t.companyId), check('employment_tax_selection_my_tax_applicability_epoch_check', sql`${t.taxApplicabilityEpoch} >= 0`)]);

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
    // ── 7ad37961 / migration 0449 — the deduction month and the Section E / F workflow ──────────────
    // The official form's own "DEDUCTION MONTH" box (1–12). NULL on every row written before this
    // round: those rows are a whole-year declaration with no month, and the list renders them as such
    // rather than inventing a January they were never keyed against.
    deductionMonth: smallint('deduction_month'),
    // Section E — the employee declaration. A TIMESTAMP, not a boolean: "who confirmed it and when" is
    // the fact the paper form's Date/Signature pair records, and a bare tick cannot answer it. Stamped
    // by the SERVER at submit; the tick itself is an explicit on/off form value, never read by presence
    // (RULE 17 — a hidden input is always submitted).
    declaredAt: timestamp('declared_at', { withTimezone: true }),
    // ── Section F — employer consent ────────────────────────────────────────────────────────────────
    // Who approved, when, and the month/year the approval is FOR — the form's own four boxes. The
    // approver's name is not duplicated here: it is read through `approved_by`, so a renamed user is
    // never two different names on two different screens. `approver_position` IS stored, because a
    // position is a fact about the moment of approval and changes under the person.
    approvedBy: uuid('approved_by').references((): AnyPgColumn => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    // ⚠️ `approved_month` IS THE DECLARATION'S EFFECTIVE-FROM MONTH, and it is read through exactly one
    // function — `tp1EffectiveFromMonth` (core/tax-relief.ts). Never compare this column in SQL: r201
    // did, in the payroll feed's WHERE clause, while the limit check had no equivalent, and the two
    // sides disagreed by the whole of every carried-forward declaration with nothing to report it.
    // 0449 backfills it from the month the row was approved (not January — see that migration's header).
    approvedMonth: smallint('approved_month'),
    approvedYear: integer('approved_year'),
    approverPosition: text('approver_position'),
    createdAt: createdAt(),
  },
  (t) => [
    // Latest-wins read for a (person, year): order by created_at desc within the scope.
    index('tp1_relief_person_year_idx').on(t.tenantId, t.personId, t.assessmentYear, t.createdAt),
  ],
);

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * LHDN TP3 (1/2026) — THE PREVIOUS-EMPLOYMENT RECORD (item df35d60d, migration 0480, STAGE 1)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHY THIS TABLE EXISTS, STATED AS THE ARITHMETIC ────────────────────────────────────────────────
 *
 * `employee_statutory_my` already holds five TP3 columns, and they are NOT replaced by this table and
 * NOT re-interpreted by it. What they cannot do is render the form. `tp3_net_remuneration` is LHDN's
 * accumulated (Y − K), i.e. **(C1 − ΣC2) − C3** — one number, already combined. The paper form asks for
 * C1, C2(i)…C2(v) and C3 as SEVEN SEPARATE BOXES, and
 *
 *     (C1 - (C2i+C2ii+C2iii+C2iv+C2v)) - C3   is not invertible.
 *
 * No arithmetic recovers seven figures from one. That is the reporter's complaint, exactly: the section
 * is "insufficient" not because a figure is wrong but because the form cannot be filled from it.
 *
 * ── ⚠️ WHAT IS AUTHORITATIVE FOR TAX, AND IT IS NOT THIS TABLE (STAGE 1) ───────────────────────────
 *
 * `core/payroll.ts` seeds the PCB accumulators from `employee_statutory_my.tp3_*` — `tp3Applies =
 * e.tp3Year === pYear`, then netRemuneration / epfClaimed / pcbPaid / zakatPaid — and it STILL DOES.
 * Nothing in this table is read by the kernel. Stage 1 captures and prints the form; stage 2 connects
 * Section D to the computation with the cross-employer limit check, and decides then — deliberately,
 * once — which side owns the accumulator seed. Until it does, the five columns are the single source of
 * truth for the monthly MTD and this row is the single source of truth for the printed form.
 *
 * That overlap is REAL and is made VISIBLE rather than left silent: `deriveAccumulatorSeed`
 * (core/tp3.ts) computes (C1 − ΣC2) − C3, K, X and Z from these boxes and the screen shows them beside
 * the stored columns, so an operator can see whether the two agree. A disagreement is information, not
 * an error, and nothing acts on it.
 *
 * ── GRAIN: ONE ROW PER (PERSON, ASSESSMENT YEAR), UPDATED IN PLACE ─────────────────────────────────
 *
 * PERSON-keyed, not employment-keyed — the precedent `tp1_relief` (0102), `employee_statutory_my` (0004)
 * and `employee_dependent` (0137) all set, and for the reason 0137 records: this codebase supports
 * concurrent employments, so employment-keying would orphan the record when that employment ends.
 *
 * UNIQUE on (tenant, person, assessment_year) and UPDATEd, where `tp1_relief` APPENDS. That difference
 * is deliberate. A TP1 is a DECLARATION with a status, a submission, an employer consent and a
 * correction trail, so its history has to be rows. A TP3 is a RECORD OF FACT about a previous employer,
 * maintained by HR from a paper form the employee hands in; its history is the before/after of the
 * `employee.tp3form.updated` domain event, which is where every other HR-maintained statutory fact in
 * this schema keeps its history. Two history idioms for one concept would be the duplication, not the
 * discipline.
 *
 * ── WHY JSONB AND NOT THREE CHILD TABLES ───────────────────────────────────────────────────────────
 *
 * `section_d` is stored in EXACTLY the shape `tp1_relief.categories.items` is stored in
 * (`Record<code, Tp1ItemAmounts>`), because it is the same taxonomy — so one validator reads both, one
 * payload type describes both, and the whole thing lands in the domain event's before/after in one
 * piece. A child table would be a SECOND storage idiom for the identical seventeen categories, needing
 * its own GRANT, its own policy and an ORDER BY on every read — and the two idioms would drift exactly
 * where the limits must not. The precedent is recorded on `employee_statutory_my.child_relief_table`
 * (migration 0250): a column rather than a child table, inheriting this row's RLS unchanged.
 */
export type Tp3PreviousEmployer = {
  /** A1 / A3 — the previous employer's name, as the employee wrote it on the form. */
  name: string;
  /** A2 / A4 — their TIN. Null when the employee left it blank; an absent box asserts nothing. */
  tin: string | null;
};

/**
 * The TP3 payload. `sectionC` is keyed c1…c5 against the pack's OWN Section C lines; `sectionD` is
 * keyed c1…c17 against the SHARED relief schedule — the same keys, the same sub-item letters and the
 * same limits `tp1_relief` uses, because it is the same taxonomy read for a different employer.
 *
 * `form` is the DISCRIMINATOR, following `Tp1Categories2026`: a payload without it is not this shape.
 */
export type Tp3Payload = {
  form: 'tp3-2026';
  /** C1–C5, with C2's five roman-numeral boxes and C4's two under `subItems`. */
  sectionC: Record<string, Tp1ItemAmounts>;
  /** D1–D17 — keyed by the SHARED schedule's codes (c1…c17), never by the printed D-number. */
  sectionD: Record<string, Tp1ItemAmounts>;
  remarks?: string | null;
};

export const employeeTp3 = pgTable(
  'employee_tp3',
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id),
    /** The form's DEDUCTION YEAR — the assessment year the previous employment's figures belong to. */
    assessmentYear: integer('assessment_year').notNull(),
    /**
     * The form's own DEDUCTION MONTH box (1–12), or NULL when the employee left it blank. NULL is not
     * January: the box is genuinely optional on the paper form and an invented month on a statutory
     * document is exactly what CLAUDE.md §8 forbids. Same treatment as `tp1_relief.deduction_month`.
     */
    deductionMonth: smallint('deduction_month'),
    /**
     * SECTION A — the previous employers, in the form's own order (A1/A2 then A3/A4). An ARRAY and not
     * four columns: the section REPEATS, and four columns would make "how many employers does the form
     * hold" a fact spread over four column names instead of one number the pack declares
     * (`tp3Catalogue.maxEmployers`). The service refuses more than that number rather than silently
     * dropping one — the form's own footnote says the next employment goes on an attachment.
     */
    previousEmployers: jsonb('previous_employers').$type<Tp3PreviousEmployer[] | null>(),
    /** SECTIONS C and D. One payload, one shape, written and read only through core/tp3.ts. */
    payload: jsonb('payload').$type<Tp3Payload | null>(),
    /**
     * SECTION E — the employee's declaration. A TIMESTAMP and not a boolean, for the reason
     * `tp1_relief.declared_at` records: "who confirmed it and when" is what the paper form's Date /
     * Signature pair asks, and a bare tick cannot answer it. Stamped by the SERVER; the tick itself is
     * an explicit on/off form value, never read by presence (a hidden input is always submitted).
     */
    declaredAt: timestamp('declared_at', { withTimezone: true }),
    /** HR's own note. Never printed on the form — the agency's form has no box for it. */
    remarks: text('remarks'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // ONE record per person per assessment year — the grain, enforced by the database rather than by
    // the service remembering to check. See the header on why this UPDATEs where tp1_relief appends.
    uniqueIndex('employee_tp3_person_year_uq').on(t.tenantId, t.personId, t.assessmentYear),
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
    // 4535b733 — Family Information enhancement (migration 0182). Additional family-member fields grouped
    // for the Spouse / Children / Other Dependants sections. All nullable → legacy rows unaffected. New
    // PII (passport_number, residential_address, occupation, company_name, employer_address) is kept OUT
    // of DomainEvent payloads (ADR-0030 Layer 0) and wired into PDPA erasure (core/pdpa.ts).
    passportNumber: text('passport_number'), // distinct from ic_or_passport (New IC)
    residentialAddress: text('residential_address'), // long text
    isDeceased: boolean('is_deceased').notNull().default(false),
    deceasedOn: date('deceased_on'),
    // Spouse-specific (validate-or-ignore when relationship != spouse in-service)
    marriageDate: date('marriage_date'),
    marriageStatus: text('marriage_status'), // validated in-service: married|divorced|widowed|separated
    spouseWorking: boolean('spouse_working'),
    occupation: text('occupation'), // spouse / other dependant occupation
    companyName: text('company_name'),
    employerAddress: text('employer_address'),
    // Children-specific
    isStudent: boolean('is_student'),
    schoolName: text('school_name'),
    // Item 5988053a (migration 0293) — child education detail alongside school_name. Free text, both
    // nullable → legacy rows unaffected. Child-gated in core/dependents.ts (stored NULL for non-children),
    // not by CHECK. study_country is backed by the profile_option country catalog in the UI but stays
    // legacy-tolerant here (imports / renamed options never trip a constraint).
    studyLevel: text('study_level'),
    studyCountry: text('study_country'),
    // Item 6c635212 (R45, migration 0250) — Malaysia Income Tax (PCB / TP1) child-relief config, per child.
    // SEPARATE from the approval-gated employee_statutory_my.num_children figure (benefits-vs-tax firewall):
    // these capture the LHDN per-child detail (relief category / claim flag / 100|50 share) and only SURFACE
    // a suggested relief total for HR to confirm — never silently drive tax. All nullable → legacy rows
    // unaffected. Validated in core/dependents.ts (allowed category set, 100|50 percentage).
    childReliefCategory: text('child_relief_category'), // under_18|study_preu|study_tertiary|disabled|disabled_study
    childTaxRelief: boolean('child_tax_relief'), // claim PCB/TP1 child relief for this child
    childReliefPercentage: integer('child_relief_percentage'), // 100 | 50 (shared claim)
    archivedAt: timestamp('archived_at', { withTimezone: true }), // soft-delete
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('employee_dependent_person_idx').on(t.tenantId, t.personId)],
);

// ─────────────── Personnel — Emergency contacts (feedback 23ad620e, migration 0322) ───────────────
// A per-PERSON register of who to call in an emergency, replacing the five flat person.emergency_contact_*
// columns (which could only ever hold ONE contact). Person-keyed like employee_dependent — an emergency
// contact is a person fact, not an employment one.
//
// `priority` carries the request's own vocabulary — 'primary' | 'secondary' | 'other' — so "only one Primary
// per employee" is a partial unique index (0322) rather than a convention: person_emergency_contact_one_
// primary_uq over (tenant_id, person_id) WHERE priority = 'primary' AND archived_at IS NULL. The service
// demotes the previous primary in the same transaction, so the index is the concurrency backstop, not the
// happy path. `relationship` stores a profile_option 'relationship' catalog value with legacy tolerance
// (validated in core/emergency-contacts.ts, not by constraint) — the SAME catalog the replaced person column
// used, deliberately NOT the separate 'dependentRelationship' one.
//
// RLS (0322): USING app.can_see_person / WITH CHECK (is_admin OR is_self_person) — the person_rls write rule,
// because the contact is self-maintained on /me today and this table must not narrow that privilege.
export const personEmergencyContact = pgTable(
  'person_emergency_contact',
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id),
    fullName: text('full_name').notNull(),
    relationship: text('relationship'), // 'relationship' catalog value (legacy-tolerant)
    mobilePhone: text('mobile_phone'),
    homePhone: text('home_phone'),
    address: text('address'),
    remarks: text('remarks'),
    priority: text('priority').notNull().default('other'), // primary | secondary | other (validated in-service)
    archivedAt: timestamp('archived_at', { withTimezone: true }), // soft-delete
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('person_emergency_contact_person_idx').on(t.tenantId, t.personId)],
);

// ─────────────── Personnel — Qualification (feedback a949184a, migration 0306) ───────────────
// A per-EMPLOYMENT register of an employee's academic / professional qualification history for the
// Personnel (Admin) profile's Qualification tab. `qualification` stores a profile_option value from the
// 'qualificationLevel' catalog (System Settings > System Labels > Profile Options) with legacy-value
// tolerance (validated in core/qualifications.ts, not by constraint). from_ym / to_ym are 'YYYY-MM' study
// periods; the single-highest rule (at most ONE live is_highest per employment) is enforced by the
// service's transactional flag transfer PLUS the partial unique index below as the concurrency backstop.
// RLS (0306): USING app.can_see_employment (self + admin read) / WITH CHECK app.is_admin() (admin write),
// mirroring the employee_cp38 employment-keyed precedent.
export const employeeQualification = pgTable(
  'employee_qualification',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    qualification: text('qualification').notNull(), // qualificationLevel catalog value (legacy-tolerant)
    description: text('description'),
    fromYm: text('from_ym'), // 'YYYY-MM' study start (validated in-service)
    toYm: text('to_ym'), // 'YYYY-MM' study end (>= from_ym, validated in-service)
    institute: text('institute'),
    major: text('major'),
    graduationDate: date('graduation_date'), // may be blank while incomplete; >= from_ym when both set
    result: text('result'), // overall result / grade (free text)
    isHighest: boolean('is_highest').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }), // soft-delete
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('employee_qualification_employment_idx').on(t.tenantId, t.employmentId),
    // Single-highest backstop: one live highest per employment (archived rows never block a new one).
    uniqueIndex('employee_qualification_one_highest_uq')
      .on(t.tenantId, t.employmentId)
      .where(sql`is_highest and archived_at is null`),
  ],
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
    // 4157a498 (migration 0427) — the SHORT CODE this cycle is known by in an import file's "Payroll
    // Cycle" column (the reporter's example is "ME"). Nullable: every pre-0427 row has none, and the
    // payroll-history importer accepts either the code OR the name, so a customer who never fills this
    // in is not blocked. It is a LABEL, not behaviour: the kernel still gates exclusively on run_type.
    code: text('code'),
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
    // 6df24751 (migration 0443) — the "Last Updated" the company-first Payroll Cycles listing shows.
    // NULLABLE ON PURPOSE, and it is not an oversight to leave it so: every row that existed before 0443
    // was never edited under a schema that could record it, and stamping one would be inventing history.
    // Null renders as an em dash. New rows are stamped by the column DEFAULT (attached by 0443 AFTER the
    // ADD COLUMN, so existing rows stayed null); edits are stamped by core/payroll-cycle.ts.
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index('payroll_cycle_company_idx').on(t.companyId),
    // One live name per company (case-insensitive). Archived rows may share a name that was re-created.
    uniqueIndex('payroll_cycle_company_name_uq').on(t.companyId, sql`lower(${t.name})`).where(sql`archived_at IS NULL`),
    // 4157a498 — one live CODE per company (case-insensitive), so an import file's "ME" can never be
    // ambiguous. Partial on code IS NOT NULL as well: NULLs are distinct to Postgres anyway, but the
    // predicate states that "no code" is the normal state rather than a collision waiting to happen.
    uniqueIndex('payroll_cycle_company_code_uq')
      .on(t.companyId, sql`lower(${t.code})`)
      .where(sql`archived_at IS NULL AND code IS NOT NULL`),
  ],
);

/**
 * 4157a498 (migration 0427) — the DOE-code catalog the payroll-history importer validates against, and
 * the map from a code to WHERE its money lands on the folded employee-month.
 *
 * NOT the only source of accepted codes, deliberately. core/payroll-history-import.ts resolves a code
 * against three layers, in this order:
 *   1. STATUTORY_IMPORT_CODES — built into lib/payroll-history-import-schema.ts, so every tenant has the
 *      statutory vocabulary (EEEPF, PCB, EREPF, HRDF, …) whether or not 0427's seed ever ran for it;
 *   2. the tenant's live pay_component catalog — BASIC, A0027, OVERTIME, … mapped by kind + display
 *      category, so the codes an admin already maintains need no second entry here;
 *   3. these rows, which ADD a code, ALIAS one onto another, or DEACTIVATE one.
 *
 * That ordering exists because a tenant provisioned after 0427 has zero rows here and must still be able
 * to import. The seed is so an admin can SEE the statutory codes, not so the importer can function.
 *
 * `aliasFor` holds the TARGET CODE as text, not an FK: an alias commonly points at a built-in statutory
 * code or a pay_component code, neither of which has a row in this table. One hop only — the resolver
 * refuses an alias of an alias rather than chasing a cycle.
 */
export const payrollImportCode = pgTable(
  'payroll_import_code',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    label: text('label').notNull(),
    // One of PAYROLL_IMPORT_DESTINATIONS (lib/payroll-history-import-schema.ts); CHECK-constrained in
    // the DB, because a typo would silently route an employee's EPF into "allowance" and distort both
    // the EA form and the CP39 file with no error anywhere.
    destination: text('destination').notNull(),
    // 'earning' | 'deduction' | 'employer' | 'check'. CHECK-constrained in the DB.
    direction: text('direction').notNull(),
    aliasFor: text('alias_for'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    // Case-insensitive, unlike pay_component_code_uq: HR types the DOE code by hand into a spreadsheet.
    uniqueIndex('payroll_import_code_tenant_code_uq').on(t.tenantId, sql`lower(${t.code})`),
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
    // One ruleset version for the whole month (ADR-0024 D7), recorded by the INSERT that opens the month
    // and never updated afterwards — see `openingStatutoryVersion` in core/payroll.ts (00e28308) for what
    // it does and does not claim. NULL means no version was recorded, which is three distinct things and
    // no promise about any of them: a period migration 0066 backfilled whose batch had no payslip to read
    // a version off; a month opened by the kernel BEFORE 00e28308, when nothing wrote this column at all
    // and every month on production was left null; or a non-statutory company, for which no ruleset
    // applies. It is deliberately NOT backfilled: we know which rules were current when an old month ran,
    // not which that run used, and the two part company the moment anything was overridden or restated.
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
    // ── 49e7e0a2 (0403) — the recalculation mark ──────────────────────────────────────────────────────
    // Set the moment a one-off transaction is added, changed or removed on a run that is ALREADY
    // processed. It is the difference between "editing after processing" and "quietly editing a figure
    // that has been paid and filed": the run carries a visible, queryable statement that its payslips,
    // statutory figures and totals no longer agree with the transactions behind them, and `closeBatch`
    // refuses while it is set. NULL = the run's figures match its inputs.
    //
    // NOT a fourth payroll status. `payrollStatusEnum` is exactly ['draft','processed','closed'] and this
    // build adds nothing to it — the mark is an ATTRIBUTE of a processed run, so nothing that switches on
    // status has to learn a new value.
    //
    // 0b326d5f (r256) RE-AFFIRMS THAT, and is the reason to read this comment before adding the value.
    // The reporter asked for "Reprocess Required" as a fourth status in the Payroll Process listing, and
    // it now appears there — as a DISPLAY state derived from this column (app/payroll/dashboard-logic.ts
    // `payrollListState`: processed + needs_recalc_at ⇒ 'reprocess_required'), including in that screen's
    // status filter. The stored value stayed 'processed', so every report, export, permission and service
    // predicate that already understands it kept working untouched. The reporter was told this in the
    // approved plan and invited to reject it if they wanted a real fourth value; they approved.
    needsRecalcAt: timestamp('needs_recalc_at', { withTimezone: true }),
    // The employments whose figures are known to be stale — exactly the set to hand to the existing
    // selective reprocess (generatePayslips reprocessSubset). A jsonb array rather than a child table
    // because it is a small, wholly-owned attribute of the batch row, read and written only in the same
    // transaction that already holds that row. Cleared per employment as each is reprocessed; when the
    // set empties, `needs_recalc_at` goes back to NULL with it (the two are always written together).
    recalcEmploymentIds: jsonb('recalc_employment_ids').$type<string[]>(),
    // c11e81aa (0441) — WHICH CONFIGURED CYCLE OPENED THIS RUN. Until now a batch snapshotted only its
    // run_type (+ an off_cycle preset's `remarks` label), which was enough while run_type was the only
    // thing the kernel gated on. It stopped being enough the moment a transaction could NAME a cycle:
    // the default catalogue maps THREE cycles to run_type 'off_cycle' ('Off-cycle', 'Advance Salary',
    // 'Mid-Month'), so "same run type" would have let an Advance Salary run collect and pay a row the
    // operator saved as Mid-Month. Identity, not type, is what routes that money.
    //
    // NULLABLE, and null is not a defect: every batch created before this column, and every batch created
    // by a caller that does not name a cycle (tests, the legacy single-company create form), carries null.
    // A null-cycle REGULAR run behaves exactly as it does today; a null-cycle NON-regular run can name no
    // cycle, so it collects no period-keyed rows at all — which is also exactly today's behaviour.
    payrollCycleId: uuid('payroll_cycle_id').references(() => payrollCycle.id),
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
    // 1b0943d5 (migration 0446) — WHICH DAYS OF THE PAY PERIOD THIS EMPLOYER OWNS. Inclusive on both ends.
    //
    // `days_worked` counts days; these two say WHICH days, which is the difference between "21 days" and
    // "11–31 August, ISEDECOR BINA". They exist because the completeness control has to ask, across every
    // company's batch for one period, whether an employment's payslips tile the month with no gap and no
    // overlap — a question no jsonb key can be asked at the shape it is asked here.
    //
    // NULL ON BOTH ⇒ THE WHOLE PAY PERIOD, which is what every payslip written before 0446 means and what
    // the absent `statutory.segment` stamp already meant. Read them through `payslipCoverage`
    // (core/payslip-segment.ts), never directly: that reader applies the NULL rule, falls back to the
    // stage-one jsonb stamp for a slip written between r194 and this round, and is the ONE place the rule
    // lives. `payslip_coverage_ordered` (0446) guarantees both are set or neither, and never backwards.
    coverageFrom: date('coverage_from'),
    coverageTo: date('coverage_to'),
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
  (t) => [
    uniqueIndex('payslip_batch_employment_uq').on(t.batchId, t.employmentId),
    // 1b0943d5 (migration 0446) — the completeness control's access path, and a NEW index rather than a
    // reuse of the unique one above: that is keyed (batch_id, employment_id) and serves "this run's slip
    // for this person", which is every payslip read this system had before this round. The tiling check
    // asks the orthogonal question — "every slip this person holds for this MONTH, across every
    // employer's batch" — which starts from the employment and cannot use a batch-leading key at all.
    index('payslip_employment_idx').on(t.employmentId),
    // …and the invariant the tiling relies on, declared HERE as well as in the migration because this
    // file is what `drizzle-kit` diffs against: a constraint that exists only in the .sql is a constraint
    // the next generated migration proposes DROPPING. Both ends set or neither (a half-set pair makes
    // "does this tile the month" unanswerable), and never backwards (a reversed pair makes a gap look
    // like an overlap).
    check(
      'payslip_coverage_ordered',
      sql`(${t.coverageFrom} IS NULL AND ${t.coverageTo} IS NULL) OR (${t.coverageFrom} IS NOT NULL AND ${t.coverageTo} IS NOT NULL AND ${t.coverageFrom} <= ${t.coverageTo})`,
    ),
  ],
);

// ─────────────── Payroll status control + selective reprocessing (feedback 9bc442bc) ───────────────
// Dedicated audit tables (reporter req.: capture actor/timestamp/reason + before/after snapshot for every
// rollback, unlock and reprocess) — a purpose-built, queryable trail alongside the generic domain_event log.
//
// 9066bd6c WIDENED WHAT LANDS HERE, and the enumerations below are the only statement of it. Per-employee
// REMOVAL writes both tables too (`remove-employee` on the run, `remove` per employee), and the two are
// NOT reprocesses: a removal row has no `after` and its `before` is the whole payslip. Reading "every row
// in payroll_employee_result_history is a reprocess" off a stale comment is exactly the premise that made
// `diffPayslipVersions` render "gross NaN" for a removal until core/payroll-view.ts filtered it out — so
// keep these two lists in step with what the services actually write.
export const payrollStatusHistory = pgTable(
  'payroll_status_history',
  {
    id: id(),
    tenantId: tenantId(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => payrollBatch.id),
    action: text('action').notNull(), // 'rollback' | 'unlock' | 'close' | 'reprocess' | 'remove-employee'
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
    /** 'reprocess' | 'remove' — and the two do not describe the same thing. A reprocess carries a
     *  before AND an after (six keys each); a REMOVAL carries the whole payslip row in `before` and
     *  `after` is null, because there is no after and no other copy of those figures anywhere. Any
     *  reader that diffs the two snapshots must exclude 'remove' (core/payroll-view.ts). */
    action: text('action').notNull(),
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

// ─────────────── ADR-0076: the payroll anomaly layer (the ADR-0074 control-tower keystone) ───────────────
//
// READ-ONLY RELATIVE TO MONEY. The evaluator reads payslips and writes verdicts; it never mutates a
// payslip, a batch total or a statutory figure. Nothing else references these tables, and both the
// verdict and its findings cascade from the batch, because a verdict is an OPINION about a payslip —
// deleting one destroys an opinion, never a financial record. That is also why these are the only
// payroll-area tables permitted to cascade.
//
// The point of the layer is a number nobody currently measures: the AUTO-CLEAR RATE. ADR-0074 targets
// ~3,000 headcount run by 3 payroll staff, which is only reachable if the overwhelming majority of
// people are paid with zero human touch. That makes it an exception-rate problem, and these rows are
// where the exception rate becomes visible.

/** One LIVE verdict per (batch, employment); re-runs supersede rather than overwrite. */
export const payrollAnomalyVerdict = pgTable(
  'payroll_anomaly_verdict',
  {
    id: id(),
    tenantId: tenantId(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => payrollBatch.id, { onDelete: 'cascade' }),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    /** 'auto_clear' | 'review' | 'block' — DERIVED from finding severities, never scored (ADR-0076 §2.5). */
    disposition: text('disposition').notNull(),
    /** Stays NULL until Phase 1b. A confidence number with no history behind it is decoration. */
    score: numeric('score', { precision: 5, scale: 4 }),
    /** COVERAGE TRANSPARENCY: which detectors ran, and which could not and why. Without the second, a
     *  statistical detector returning nothing on a two-cycle client is indistinguishable from "clean". */
    detectorsRun: jsonb('detectors_run').$type<string[]>().notNull().default([]),
    detectorsSkipped: jsonb('detectors_skipped')
      .$type<{ id: string; reason: string }[]>()
      .notNull()
      .default([]),
    computedAt: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
    /** Set when a re-run replaces this row. Superseded rows are kept — they are the audit trail of what
     *  the system believed at the time, which the daily dry-run will make plentiful. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    resolvedByUserId: uuid('resolved_by_user_id').references(() => appUser.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** 'accepted' | 'fixed_upstream' | 'false_positive'. The last is the FP-rate numerator (§5). */
    resolution: text('resolution'),
    resolutionNote: text('resolution_note'),
  },
  (t) => [
    uniqueIndex('payroll_anomaly_verdict_live_uq')
      .on(t.batchId, t.employmentId)
      .where(sql`superseded_at IS NULL`),
    index('payroll_anomaly_verdict_batch_idx')
      .on(t.tenantId, t.batchId, t.disposition)
      .where(sql`superseded_at IS NULL`),
  ],
);

/** One row per detector hit. `facts` is the provenance of every number the narrative prints. */
export const payrollAnomalyFinding = pgTable(
  'payroll_anomaly_finding',
  {
    id: id(),
    tenantId: tenantId(),
    verdictId: uuid('verdict_id')
      .notNull()
      .references(() => payrollAnomalyVerdict.id, { onDelete: 'cascade' }),
    detectorId: text('detector_id').notNull(),
    /** 'block' | 'review' | 'info'. */
    severity: text('severity').notNull(),
    facts: jsonb('facts').$type<Record<string, string | number>>().notNull().default({}),
    sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default([]),
    /** An i18n KEY, never prose — rendered in six locales. */
    suggestedAction: text('suggested_action').notNull(),
    /** OPTIONAL LLM prose, additive only, generated AFTER classification and unable to revise it. */
    narrative: text('narrative'),
    /**
     * ADR-0084 §2.6 (0454) — the ledger row this finding came from, for the ONE detector that is a
     * model: `hypothesis`. NULL for every deterministic detector, and null too when the best-effort
     * ledger write failed (core/agent-proposal.ts property 1). It is what lets `resolveAnomalyVerdict`
     * stamp the human's verdict on the RIGHT proposal rather than the most recent plausible one.
     */
    proposalId: uuid('proposal_id').references(() => agentProposal.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('payroll_anomaly_finding_verdict_idx').on(t.verdictId),
    index('payroll_anomaly_finding_detector_idx').on(t.tenantId, t.detectorId),
  ],
);

/** Thresholds as DATA, mirroring statutory_ruleset, so calibration never requires a deploy. */
export const payrollAnomalyConfig = pgTable(
  'payroll_anomaly_config',
  {
    id: id(),
    tenantId: tenantId(),
    /** NULL = the tenant-wide default; a company row overrides it, so one entity of a 60-entity group
     *  can be tuned without disturbing the rest. */
    companyId: uuid('company_id').references(() => company.id),
    detectorId: text('detector_id').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    effectiveFrom: date('effective_from').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => appUser.id),
    createdAt: createdAt(),
    /** Archived, never deleted: a verdict computed last cycle must stay explicable by the thresholds
     *  that were in force when it was computed. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('payroll_anomaly_config_lookup_idx').on(t.tenantId, t.detectorId)],
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
    /**
     * a96d320c (migration 0479) — THE HOURS AND THE RATE BEHIND `overtime_amount`, written at the moment
     * the statutory engine computed them.
     *
     * `ot_breakdown` above is a different thing and the two must not be confused: that is four RM amounts
     * an operator typed into four rate-labelled boxes, persisted so the boxes can be re-prefilled. This is
     * the statutory engine's own decomposition — per leg, a quantity (hours, or days of ordinary rate of
     * pay), the unit rate it was paid at, and the money that produced. `{ version, orp, hourly, total,
     * lines[] }`, written ONLY by `prefillOvertimeFromAttendance` from `overtimePay`'s result.
     *
     * NULL on every row that exists today, on every hand-keyed figure (`setPayrollInput` clears it — an
     * amount somebody typed is not an amount this decomposition explains) and on every insert that merely
     * carries OT forward. NULL ⇒ the payslip prints the overtime line exactly as it does now.
     *
     * `generatePayslips` copies it onto the payslip's own snapshot as `statutory.otDetail`, and only when
     * `total` still equals the overtime figure that payslip is about to print.
     */
    otDerivation: jsonb('ot_derivation').$type<{
      version: 1;
      orp: number;
      hourly: number;
      total: number;
      lines: { kind: string; qty: number; unit: 'hours' | 'days'; rate: number; amount: number }[];
    } | null>(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('payroll_input_batch_emp_uq').on(t.batchId, t.employmentId)],
);

// ─────────── 2961a7ae — Statutory Adjustment: the manual override, stored as an INPUT ───────────
// Migration 0430. One row per (batch, employment), mirroring payroll_input above — deliberately, because
// this IS an input: the generator reads it and applies it to the computed figures. It is NOT a stamped
// result. An override written onto the payslip row would be destroyed by the next reprocess (which
// recomputes from scratch and bumps payslip.version), and this reporter reprocesses constantly. As an
// input it is idempotent across reprocesses and Revert is a row delete plus a reprocess.
//
// EVERY AMOUNT IS NULLABLE WITH NO DEFAULT, AND THAT IS THE WHOLE "BLANK VS ZERO" REQUIREMENT:
//   null → no override on this line, use the system-calculated figure
//   0.00 → override this line to zero
// Defaulting any column to 0 would collapse the two into one value.
//
// NINE LINES, NOT TEN: SKBBK / Lindung 24 Jam exists only as an EMPLOYEE-paid leg in the engine
// (localization/my/payroll.ts socso() → { employer, employee, skbbk }, surfaced as socsoSkbbk). There is
// no employer SKBBK figure to override, so there is no column for one.
export const payrollStatutoryAdjustment = pgTable(
  'payroll_statutory_adjustment',
  {
    id: id(),
    tenantId: tenantId(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => payrollBatch.id),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    // Employee side — these move Total Deduction and therefore Net Pay.
    pcb: numeric('pcb', { precision: 12, scale: 2 }),
    epfEmployee: numeric('epf_employee', { precision: 12, scale: 2 }),
    socsoEmployee: numeric('socso_employee', { precision: 12, scale: 2 }),
    socsoSkbbk: numeric('socso_skbbk', { precision: 12, scale: 2 }),
    eisEmployee: numeric('eis_employee', { precision: 12, scale: 2 }),
    // Employer side — these move employer cost and can never touch net pay (structural: core/payroll.ts
    // composes employer_cost from the employer legs and net_pay from the employee legs).
    hrdf: numeric('hrdf', { precision: 12, scale: 2 }),
    epfEmployer: numeric('epf_employer', { precision: 12, scale: 2 }),
    socsoEmployer: numeric('socso_employer', { precision: 12, scale: 2 }),
    eisEmployer: numeric('eis_employer', { precision: 12, scale: 2 }),
    // Required on every save, including an adjustment to zero (the reporter's rule 10).
    reason: text('reason').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('payroll_statutory_adjustment_batch_employment_uq').on(t.batchId, t.employmentId),
    index('payroll_statutory_adjustment_batch_idx').on(t.batchId),
  ],
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
    // Pay Items redesign (0289): optional short display name for payslips and reports (e.g. "Transport"),
    // mirroring the System Labels label field on department/cost_center. No unique index — house rule
    // (core/admin.ts): label uniqueness, if ever specified, is enforced in the service, not a DB index.
    label: text('label'),
    kind: payComponentKindEnum('kind').notNull(),
    // Treatment flags — which statutory base the component feeds (the four MY "wages" definitions).
    includedInEpf: boolean('included_in_epf').notNull().default(false),
    includedInSocsoEis: boolean('included_in_socso_eis').notNull().default(false),
    includedInPcb: boolean('included_in_pcb').notNull().default(true),
    includedInHrdfBase: boolean('included_in_hrdf_base').notNull().default(false),
    // BIK/perquisite: taxable (PCB) but not paid in cash, so excluded from cash gross/net.
    isNonPayable: boolean('is_non_payable').notNull().default(false),
    // LHDN PCB 2026 classification (feedback 09b554e9). epf_bonus_2012: the pay code is a BONUS payment for
    // EPF purposes — the kernel routes it down the additional-remuneration EPF path (employer rate fixed by
    // the NORMAL wage band per the EPF Bonus 2012 rules) regardless of the SOCSO flag. Only meaningful with
    // included_in_epf; the service refuses the combination without it.
    epfBonus2012: boolean('epf_bonus_2012').notNull().default(false),
    // How the pay code is treated in the PCB computerised calculation: 'normal' → Y1 stream, 'additional' →
    // Yt stream, 'optional_deduction' → LP (TP1-style) monthly-tax deduction. NULL = legacy row — the kernel
    // keeps inferring the stream from the EPF/SOCSO flags exactly as before (no behaviour change on save-less
    // rows). Constrained app-side to PCB_REMUNERATION_TYPES (core/pay-components.ts).
    pcbRemunerationType: text('pcb_remuneration_type').$type<'normal' | 'additional' | 'optional_deduction' | null>(),
    // The LHDN exemption / optional-deduction code (PCB_* for normal/additional, LP_* for optional
    // deduction) with its annual cap in the versioned statutory tables (localization/my/statutory-tables.ts).
    // Validated app-side against the selected remuneration type's list; NULL = legacy/unclassified.
    pcbExemptionCode: text('pcb_exemption_code'),
    // Feedback 3c473773 — the PAYROLL CATEGORY: which box on the payslip this item's money appears in
    // (basic / overtime / bonus / allowance / claim / deduction). PRESENTATION ONLY and independent of
    // every statutory flag: the kernel's cash bucketing, every statutory base, and every EA/CP39/KWSP/
    // PERKESO grouping are unchanged by it. It exists because the box was previously INFERRED from the
    // tax treatment — an overtime code declared 'additional' remuneration (correct for LHDN) therefore
    // printed under Bonus. NULL = unclassified ⇒ core/payroll.ts keeps inferring exactly as before, which
    // is what stops a legacy row losing its box silently. Values constrained in the DB (0393) and
    // app-side (core/pay-display-category.ts).
    // 711adcd2 adds 'bik' (Benefit in Kind) — the reporter's Category = Non-Payable pairing. Migration
    // 0456 widens 0393's CHECK constraint to match; the two vocabularies are pinned in step by
    // test/pay-display-category.test.ts.
    displayCategory: text('display_category').$type<
      'basic' | 'overtime' | 'bonus' | 'allowance' | 'claim' | 'deduction' | 'bik' | 'vola' | null
    >(),
    // ── 711adcd2 (migration 0456) — THE TWO ORP TICK BOXES ────────────────────────────────────────
    // Which ordinary-rate-of-pay base this pay item feeds. Two INDEPENDENT switches: either, both or
    // neither. Before 0456 there was no switch at all — inclusion was decided by the item's KIND — so the
    // migration backfills each column to exactly what the code decided on the day it ran, which is the
    // whole safety property (see db/migrations/0456_pay_item_orp_flags.sql).
    //
    // orp_overtime — does this item count towards the `fixed_allowances` operand a tenant's own overtime
    //   formula reads (core/pay-rule.ts)? It replaces ONLY the `kind = 'allowance'` half of
    //   isFixedAllowanceComponent. The three STRUCTURAL clauses (never BASIC, never a statutory line,
    //   rule null-or-fixed) are safety, not policy, and stay in code where a tick box cannot switch them
    //   off: the last of them is what makes the aggregate acyclic. Backfilled TRUE for exactly the
    //   non-statutory, non-BASIC `allowance` rows the kind test selected.
    //   IT DOES NOT REACH THE STATUTORY OVERTIME ENGINE. localization/my/payroll.ts overtimePay is fed
    //   `compensation.basic_salary + compensation.monthly_allowance` (core/payroll.ts
    //   prefillOvertimeFromAttendance) — Personnel COLUMNS, not pay items — and no flag here changes that.
    //
    // orp_unpaid_leave — does this item's amount join basic salary in the base the unpaid-leave (and the
    //   equal-by-definition absence) daily rate is struck from? Backfilled FALSE on EVERY row, because
    //   MEASURED, nothing but basic salary feeds it today: core/payroll.ts computes
    //   `basicRaw / unpaidDivisor × days`, with no allowance and no pay item anywhere in it. A `true`
    //   backfill would have RAISED every unpaid-leave deduction on release day.
    orpOvertime: boolean('orp_overtime').notNull().default(false),
    orpUnpaidLeave: boolean('orp_unpaid_leave').notNull().default(false),
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
    // 61bf109d — RECORDED resolution order (migration 0330). A `percent_of base:'component'` or `formula`
    // rule makes one pay item depend on another, so the kernel can no longer resolve components in arbitrary
    // query order without risking two runs of the same payroll disagreeing. The dependency graph is
    // topologically sorted at SAVE time (planResolutionOrder, core/pay-rule.ts) and the resulting rank is
    // persisted here, so the run does not re-derive it: the order that was validated is the order that pays.
    // 0 = no dependencies, which is every legacy row (no pre-0330 rule could reference another component),
    // hence the DEFAULT 0 backfill is identity-preserving by construction.
    resolutionOrder: integer('resolution_order').notNull().default(0),
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
    // 4fffe638 (migration 0514) — the CONFIGURED Payroll Cycle (Payroll > Settings > Payroll Cycles) the
    // operator picked on the Fixed Transaction screen. When set, `runType` above is the cycle's own run
    // type, written by the service from the cycle row, never from the client. Nullable: legacy rows the
    // 0514 one-match backfill could not resolve, rows saved with no cycle, and every write from the
    // people-detail editor stay null. THE KERNEL DOES NOT READ THIS COLUMN (core/payroll.ts selects on
    // employment, window and superseded_at only): it is a record and a label, not routing. No ON DELETE —
    // deletePayrollCycle refuses a cycle that is referenced here.
    payrollCycleId: uuid('payroll_cycle_id').references(() => payrollCycle.id),
  },
  (t) => [index('employment_pay_component_idx').on(t.employmentId, t.validFrom)],
);

// 1.2.3 CP38 Deduction — an LHDN/court instalment deducted each month IN ADDITION to monthly MTD/PCB.
// Effective-dated, per-employment, supersede-on-write (mirrors `compensation`): a change CLOSEs the open
// row (set its `valid_to`) and INSERTs a new open row, so at most one row applies to a given month. Dates
// are MONTH-ALIGNED (the service normalises any input to the first of its month). The `amount` is a
// garnishment figure (tenant data) — kept OUT of the DomainEvent payload (ADR-0030 Layer 0).
/**
 * 72b100cd (migration 0476) — THE EMPLOYER'S PAYMENT of monthly tax deductions to LHDN, which PCB 2(II)
 * reports per month and per stream.
 *
 * NOT `statutory_report.ack_ref`, and the distinction is the whole reason this table exists: that column
 * is ONE acknowledgement for the RETURN (a CP39 lodgement), while this is a PAYMENT — an employer may
 * pay more than once against one return, and LHDN issues a receipt per payment. The form also splits MTD
 * from CP38 into separate columns, which a single reference cannot express.
 *
 * ⚠️ EVERY ROW IS KEYED BY A HUMAN AND PRINTED VERBATIM. Nothing here is derived, and a month with no row
 * prints an EMPTY box on the form rather than 0.00 — an absent box asserts nothing, a zero asserts the
 * money does not exist, and those are different statements to LHDN (CLAUDE.md §8).
 */
export const pcbPayment = pgTable(
  'pcb_payment',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    /** 'YYYY-MM' — the DEDUCTION month this payment settles, the shape statutory_report.period_key uses. */
    periodKey: text('period_key').notNull(),
    /** The two streams the form reports apart: 'mtd' is the ordinary deduction, 'cp38' the instalment. */
    kind: text('kind').$type<'mtd' | 'cp38'>().notNull(),
    /** LHDN's receipt / bank slip / transaction number. Unvalidated on purpose — this repo cannot verify
     *  their format, and policing one would be inventing third-party behaviour. */
    receiptRef: text('receipt_ref').notNull(),
    paidOn: date('paid_on').notNull(),
    recordedBy: uuid('recorded_by'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One reference per company, month and stream: a correction UPDATES the row, because the form has
    // exactly one box to print it in and no way to show two.
    uniqueIndex('pcb_payment_company_period_kind_uq').on(t.companyId, t.periodKey, t.kind),
    index('pcb_payment_tenant_idx').on(t.tenantId),
  ],
);

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
    // The resolved month+cycle target. NULLABLE since 0175 (f1564110 Phase 2): a row with batch_id NULL is
    // "unattached" — keyed in before any payroll run exists for the month, then stamped onto the month's
    // REGULAR run inside generatePayslips (attach-on-generate). "No carry-forward" is keyed by pay_period
    // (below): a row belongs to exactly one month and nothing copies it forward (ADR-0056 amendment).
    batchId: uuid('batch_id').references(() => payrollBatch.id),
    // The row's true home: (company, 'YYYY-MM' pay month). Always stamped by the service (attached rows get
    // them from the owning batch); a DB CHECK (0175) guarantees batch_id OR (company_id AND pay_period).
    companyId: uuid('company_id').references(() => company.id),
    payPeriod: text('pay_period'),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    kind: payrollTxnKindEnum('kind').notNull(),
    // f1564110 Phase 3 (0176) — the picked Payroll Item Master component. NULLABLE; only earning/deduction
    // rows may carry one (app-enforced). With INDIVIDUAL_TXN_PAY_ENABLED the kernel folds a component row
    // through the typed-pay-component fold (the catalog's statutory flags/rounding apply); a componentless
    // legacy row folds with conservative defaults; NEW payable rows require a component (service-enforced).
    // Flag off (the default) ⇒ the ledger stays record-only, byte-identical to the pre-Phase-3 kernel.
    componentId: uuid('component_id').references(() => payComponent.id),
    // The per-entry transaction date; validated app-side to fall within the batch's pay-period month.
    txnDate: date('txn_date').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull().default('0'),
    // Descriptive qty/hours/days/units figure (nullable). NOT read by any kernel math in this slice.
    quantity: numeric('quantity', { precision: 12, scale: 2 }),
    // One of TXN_UNITS ('amount'|'qty'|'hours'|'days'|'units'); validated app-side (mirror ROUNDING_METHODS).
    unit: text('unit'),
    notes: text('notes'),
    // 49e7e0a2 (0403) — when this row was last CHANGED. Null on every legacy row and on a row that has
    // never been edited since it was keyed, so `created_at` remains the only timestamp for those. It
    // exists because the one staleness detector this codebase had — `arrivedAfterProcessing`
    // (core/payroll-view.ts) — is `max(created_at) > processedAt` and is therefore BLIND to an edit of a
    // row that was keyed before processing. With editing allowed after a run is processed, that blindness
    // becomes the whole hazard, so the edit stamps its own instant.
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    // 4e403268 (0432) — WHERE this line came from. One of TXN_SOURCES ('manual'|'attendance'|'leave'|
    // 'import'|'system'), app-validated exactly as `unit` above is (no pg enum, no CHECK — one literal set
    // in core/payroll-individual-txn.ts). NULL READS AS 'manual' (`txnSourceOf`), which is why all 47
    // existing production rows are correct with no backfill: every one of them was keyed by hand.
    source: text('source'),
    // The originating module's own record id (an attendance day, a leave request line). Null for a row
    // keyed by hand. Nothing writes it yet — Attendance and Leave do not post into payroll today — and the
    // uniqueness guard below exists so that when they do, a repeated sync UPDATES rather than double-posts.
    sourceRef: text('source_ref'),
    // 0db616f3 (0437) — WHICH RUN ALREADY PAID THIS LINE. Null means "not yet in any payslip", which is
    // where every row starts and where every row on production stands today (measured 2026-08-13: no
    // column on this table said anything about payment at all, so the kernel folded every row attached
    // to a run on every generation of it, and a row moved to a second run was folded there too).
    //
    // KEYED ON THE RUN, NOT A BOOLEAN, and the fold reads `consumed_batch_id IS NULL OR = this batch`.
    // A boolean would delete a one-off row from a legitimate re-run: `resetProcessedBatch` destroys a
    // run's payslips so a correction can be re-generated, and a selective reprocess rewrites a subset of
    // them. Both must still pay these lines. What must NEVER happen is a DIFFERENT run paying a line the
    // first run already paid — the January 2026 shape, where 24 bonus lines sat on the regular run while
    // the bonus run showed zero payslips.
    consumedBatchId: uuid('consumed_batch_id').references(() => payrollBatch.id, { onDelete: 'set null' }),
    // When those payslips were written. Stamped once and never re-stamped, so it remains the instant of
    // the FIRST payment rather than of the latest re-generation.
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    // c11e81aa (0441) — WHICH CONFIGURED PAY CYCLE THE OPERATOR CHOSE for a row keyed before any run
    // existed. NULL on every legacy row and on every row saved without naming one, and NULL is exactly
    // today's behaviour: attach-on-generate collects a NULL-intent row onto the month's REGULAR run.
    //
    // A cycle, not a run: the run may not exist yet (that is the point of entering early), and the
    // catalogue is per company (core/payroll-cycle.ts), so the app re-validates company membership on
    // every write. `generatePayslips` matches a run to an intent BY CYCLE ID — `payroll_batch
    // .payroll_cycle_id`, added by the same migration — and never by run type: the default catalogue maps
    // three cycles onto run_type 'off_cycle', so a type match would let an "Advance Salary" run pay a row
    // saved as "Mid-Month". See `collectableCycleIds` (core/payroll.ts) for the one rule both readers use.
    intendedCycleId: uuid('intended_cycle_id').references(() => payrollCycle.id),
    createdAt: createdAt(),
  },
  (t) => [
    // No unique constraint — multiple dated entries per (batch, employment) are allowed by design. THIS IS
    // WHAT MAKES DAY-BY-DAY ENTRY (4e403268) A SCREEN CHANGE RATHER THAN A SCHEMA CHANGE: five dated lines
    // for one employee in one month have always been legal rows.
    index('payroll_individual_txn_batch_emp_idx').on(t.batchId, t.employmentId),
    index('payroll_individual_txn_tenant_batch_idx').on(t.tenantId, t.batchId),
    // Attach-on-generate lookup (0175); the SQL migration creates it partial (WHERE batch_id IS NULL).
    index('payroll_individual_txn_unattached_idx').on(t.tenantId, t.companyId, t.payPeriod),
    // 4e403268 (0432) — the request's point 14. The SQL migration creates it PARTIAL
    // (WHERE source_ref IS NOT NULL), so it is empty today and costs nothing; putting it in before the
    // first sync exists is the difference between a constraint and a data repair.
    uniqueIndex('payroll_individual_txn_source_ref_uq')
      .on(t.tenantId, t.employmentId, t.txnDate, t.componentId, t.source, t.sourceRef)
      .where(sql`source_ref is not null`),
    // 0db616f3 (0437) — PARTIAL, so it is empty the day it lands and only ever holds lines that have
    // actually been paid. Both readers want exactly this key: the fold ("consumed by nobody or by me")
    // and the reset/teardown clear ("everything this run consumed").
    index('payroll_individual_txn_consumed_idx')
      .on(t.consumedBatchId)
      .where(sql`consumed_batch_id is not null`),
    // c11e81aa (0441) — PARTIAL for the same reason as the two above: it is empty the day it lands and
    // only ever holds rows whose operator named a cycle. Attach-on-generate's added predicate is
    // "intent is null OR intent is one of this run's cycles", and this is the half of it that has rows.
    index('payroll_individual_txn_intended_cycle_idx')
      .on(t.intendedCycleId)
      .where(sql`intended_cycle_id is not null`),
  ],
);

/**
 * r292 — the statuses that mean "this return has been LODGED WITH THE AGENCY".
 *
 * It lives HERE, beside the column, rather than in either service, because BOTH core/reporting.ts (which
 * writes the transition) and core/payroll.ts (which derives the "already filed" warning from it) must
 * resolve against the same list, and reporting.ts already imports payroll.ts — putting it in either one
 * would make that dependency circular. Two hand-kept copies of "which statuses count as filed" is how a
 * further status ships that only half the codebase believes in.
 *
 * `LABEL_KINDS` above is the same pattern: a value vocabulary the schema owns.
 */
export const STATUTORY_FILED_STATUSES = ['submitted', 'amended'] as const;
export type StatutoryFiledStatus = (typeof STATUTORY_FILED_STATUSES)[number];

// Statutory / compliance report artefact (ADR-0010). Append-only record of a generated filing —
// derived from payslips but persisted for audit/idempotency (who generated what, against which
// statutory-table version). Filed per legal entity (company_id); never mutated after submission.
//
// r292 / readiness 3.2 — THE ROW IS NO LONGER WRITE-ONCE, AND THE ONE THING THAT MAY CHANGE IS WHETHER
// IT HAS BEEN FILED. The figures (`totals`, `row_count`, `statutory_version`, `generated_*`) are still
// immutable: `markReportFiled` / `reverseReportFiling` (core/reporting.ts) touch only `status` and the
// four `filed_*` / `ack_ref` columns below, and every transition appends a domain event in the same tx.
// Nothing else in the codebase updates this table — that is the invariant, and test/statutory-filing-
// r292.test.ts pins it.
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
    /**
     * REACHABLE VOCABULARY: `draft` → `submitted` → (`amended` for a later return over the same
     * company + report + period) — and back to `draft`, which is what reversing a mis-keyed mark does.
     *
     * `final` IS DELIBERATELY NOT IMPLEMENTED, and this comment is the record of that decision rather
     * than a silent omission. It would mean "figures locked, not yet sent" — an internal approval
     * checkpoint with no external evidence behind it, which nothing on a first customer's monthly
     * CP39 / Borang A / PERKESO cycle asks for. Worse, it is a state in which `statutoryFiled` has no
     * honest answer: the return is neither a draft somebody previewed nor something an agency has
     * acknowledged. Implementing a state because the enum once listed it is how 3.2 happened.
     * `STATUTORY_FILED_STATUSES` (core/reporting.ts) is the single list every reader resolves against.
     */
    status: text('status').notNull().default('draft'),
    statutoryVersion: text('statutory_version'), // MY_STATUTORY_VERSION at generation time
    rowCount: integer('row_count').notNull().default(0),
    totals: jsonb('totals'), // { epfEmployee, epfEmployer, socsoEmployee, ..., pcb }
    generatedBy: uuid('generated_by'), // app_user id (actor also on the domain event)
    generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow().notNull(),
    /**
     * r292 — the evidence that a filing actually happened. NULL on every row that has not been filed,
     * and cleared again when a mark is reversed (the retracted values survive on the
     * `statutory-report.filing-reversed` domain event, so nothing is destroyed).
     *
     * ⚠️ `filedOn` AND `filedAt` ARE NOT THE SAME DATE AND MUST NOT BE COLLAPSED. `filedOn` is the day
     * the return was lodged with the agency, declared by the operator — the date a statutory deadline is
     * measured against. `filedAt` is the instant this system was told. A CP39 lodged on the 15th and
     * keyed here on the 20th has both, five days apart, and only one of them is on time.
     */
    filedAt: timestamp('filed_at', { withTimezone: true }),
    filedOn: date('filed_on'),
    filedBy: uuid('filed_by'), // app_user id (actor also on the domain event)
    /**
     * The agency's acknowledgement / receipt reference. MANDATORY for a filed row — enforced in
     * `markReportFiled`, not by a DB check (CLAUDE.md §6: a check on an existing table fires for every
     * writer, including erasure). Free text, trimmed, capped at 120 chars: LHDN, KWSP and PERKESO each
     * issue a different shape and this repo cannot verify any of their formats, so pattern-policing one
     * would be inventing third-party behaviour. Non-empty is the honest floor — without it "filed" is
     * once again an unevidenced click, which is the whole defect 3.2 names.
     */
    ackRef: text('ack_ref'),
    createdAt: createdAt(),
  },
  (t) => [
    index('statutory_report_tenant_idx').on(t.tenantId),
    index('statutory_report_company_period_idx').on(t.companyId, t.reportType, t.periodKey),
    // 0466 — PARTIAL (WHERE status in ('submitted','amended')), so it is empty the day it lands and only
    // ever holds returns that have really been filed. It serves `batchDownstreamWarnings`, which asks
    // "are there FILED returns for this company + month" before every unlock, reset and processed-run edit.
    index('statutory_report_filed_idx')
      .on(t.companyId, t.periodKey)
      .where(sql`status in ('submitted','amended')`),
  ],
);

// ───────────────── Back Pay / Arrears (2ef69d1e, migration 0413) ─────────────────
//
// A backdated salary revision — a compensation row keyed AFTER the payroll it should have affected —
// leaves the employee short (or over) for every closed month between the effective date and today. The
// system accepted the revision silently and nothing ever worked the shortfall out.
//
// ⚠️ THE ONE INVARIANT THIS WHOLE FEATURE RESTS ON: **NO CLOSED PAYSLIP IS EVER RECOMPUTED.**
// Back pay is a NEW payable difference that rides the CURRENT run, not an edit to history. Nothing here
// writes `payslip`, nothing here reopens a batch, and `generatePayslips` is not given a preview mode (the
// golden tests demand byte-identical payroll output). The only employee-visible write the whole feature
// ever performs is `payroll_individual_txn` rows on the TARGET (current) period, which is the ordinary
// one-off path — so the arrears attract EPF/SOCSO/PCB in the month they are actually PAID, which is also
// what the law expects.
//
// ── WHY TWO TABLES AND WHY `source_compensation_id` IS ON THE LINE ────────────────────────────────────
// The run is the operator's unit of work (calculate → verify → approve → post). The LINE is the unit of
// evidence, and it is keyed by the COMPENSATION ROW that caused it. That column is what makes the
// duplicate guard real: detection excludes any salary revision already carried by a live (non-cancelled)
// run, so the same backdated rise cannot be paid twice — which is the single most expensive mistake this
// screen could make. Cancel is what releases the revision back to detection.
//
// ── SIGN IS HONEST, IN BOTH DIRECTIONS ────────────────────────────────────────────────────────────────
// `difference` is SIGNED: positive = owed to the employee, negative = owed back by them (measured on
// production 2026-08-06: of 26 backdated rows, one is 6000 → 5500). A negative run posts as a DEDUCTION
// (payroll_individual_txn amounts are magnitudes; the `kind` carries the sign), and rides the same
// approval. A plan or a test that assumes arrears are always owed TO the employee is wrong about this data.
export const backPayRun = pgTable(
  'back_pay_run',
  {
    id: id(),
    tenantId: tenantId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    /** 'YYYY-MM' — the CURRENT period the arrears are paid in (never an affected period). */
    targetPayPeriod: text('target_pay_period').notNull(),
    /** Which run of the target month the postings belong to. Reuses the payroll_run_type taxonomy rather
     *  than inventing a second cycle vocabulary. */
    targetRunType: payrollRunTypeEnum('target_run_type').notNull().default('regular'),
    /** draft → verified → posted, or cancelled from any of the three. Text, not a pgEnum: a fourth state
     *  (e.g. 'rejected') should not need a migration, and nothing outside core/back-pay.ts switches on it. */
    status: text('status').notNull().default('draft'),
    createdByUserId: uuid('created_by_user_id').references(() => appUser.id),
    /** Who signed the figures off. NULL until Approve and Post — the whole point is that nothing moves
     *  before a named human agrees to it. */
    approvedByUserId: uuid('approved_by_user_id').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => appUser.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    remarks: text('remarks'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('back_pay_run_tenant_company_idx').on(t.tenantId, t.companyId, t.createdAt),
    index('back_pay_run_target_idx').on(t.tenantId, t.companyId, t.targetPayPeriod),
  ],
);

/**
 * One line of evidence: what ONE pay item was worth in ONE affected month, before and after the
 * backdated salary revision. The verification grid is exactly this table pivoted (item × month).
 *
 * `needs_review` is the honest half. Three things genuinely cannot be reworked from what was stored:
 *  - MANUALLY KEYED OVERTIME — payroll_input stores overtime_amount as RM, "not hours" (see that table),
 *    so there is no quantity to re-price at the new wage basis. It is surfaced, never silently zeroed.
 *  - ANY PAY ITEM WHOSE RULE READS `hours` — hours are not stored on the payslip (only days_worked is).
 *  - OVERTIME / UNPAID LEAVE / ABSENCE arrears generally — deferred to pass 2 by the approved plan,
 *    which sequences them after the Attendance Calculation Engine item that re-categorises OT.
 * A needs-review line carries its reason and is EXCLUDED from the posted total: the operator keys those
 * figures by hand as ordinary one-off transactions, having been told which ones and why.
 */
export const backPayLine = pgTable(
  'back_pay_line',
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid('run_id')
      .notNull()
      .references(() => backPayRun.id),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    /** THE DUPLICATE GUARD'S KEY — the backdated salary revision this line was computed from. */
    sourceCompensationId: uuid('source_compensation_id')
      .notNull()
      .references(() => compensation.id),
    /** 'YYYY-MM' of the already-paid month this line reworks. Never the target period. */
    affectedPeriod: text('affected_period').notNull(),
    /** The pay code: 'BASIC' for the salary line itself, else the pay_component code. Stored as TEXT, not
     *  a FK — a line is a permanent record of what was computed, and an item archived afterwards must not
     *  make an approved back pay run unreadable. */
    payCode: text('pay_code').notNull(),
    payItemName: text('pay_item_name').notNull(),
    /** What the closed payslip actually paid for this item in this month. */
    oldAmount: numeric('old_amount', { precision: 12, scale: 2 }).notNull().default('0'),
    /** What it would have paid at the revised salary. NULL only on a needs-review line, where claiming a
     *  figure would be a guess. */
    newAmount: numeric('new_amount', { precision: 12, scale: 2 }),
    /** SIGNED. new − old for an earning; old − new for a deduction (a bigger deduction is less pay). 0 on
     *  a needs-review line, which is excluded from the total. */
    difference: numeric('difference', { precision: 12, scale: 2 }).notNull().default('0'),
    needsReview: boolean('needs_review').notNull().default(false),
    /** A stable code the UI localises (manualOvertime / hoursNotStored / overtimeDeferred / …), never raw
     *  English — the same discipline core/pay-rule.ts's PayRuleErrorCode follows. */
    reviewReason: text('review_reason'),
    /** The posted one-off transaction this line's money went out on. Set at Approve and Post, cleared by
     *  Cancel. Several lines of the same (employment, affected period) share one txn — the posting is
     *  NETTED per month so the payslip carries one legible arrears line per covered month. */
    postedTxnId: uuid('posted_txn_id').references(() => payrollIndividualTxn.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('back_pay_line_run_idx').on(t.runId, t.employmentId),
    // Detection's exclusion query: "which salary revisions are already carried by a live run?"
    index('back_pay_line_source_idx').on(t.tenantId, t.sourceCompensationId),
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

// ─────────────────────── Custom Report Builder (ADR-0074, c440b365) ───────────────────────
// A user-defined report: a name + a chosen dataset from the CLOSED registry (core/report-registry.ts)
// + a declarative `spec` (columns / filters / sort / grouping / layout properties). No free-form SQL —
// the spec only names dataset/field ids the registry exposes, and every underlying read enforces
// tenant RLS + company scope. RLS + grants live in migration 0163.
export type CustomReportSpec = {
  datasetId: string;
  columns: string[];
  filters?: Record<string, string | number | null>;
  sort?: { field: string; dir: 'asc' | 'desc' } | null;
  groupBy?: string | null;
  // Layout / presentation properties (AI-designer output + manual overrides). Non-structural: they only
  // affect how the report is rendered/exported, never which rows/columns are read.
  layout?: {
    title?: string | null;
    subtitle?: string | null;
    description?: string | null;
    orientation?: 'portrait' | 'landscape';
    paperSize?: 'A4' | 'A3' | 'Letter' | 'Legal';
    margins?: 'narrow' | 'normal' | 'wide';
    header?: string | null;
    footer?: string | null;
    dateFormat?: 'iso' | 'dmy' | 'mdy' | 'long';
    numberFormat?: 'plain' | 'grouped';
    pageBreakOn?: string | null; // field id whose value change starts a new page (grouped print)
    watermark?: string | null;
    companyLogo?: string | null; // data-URI image OR a short text mark rendered top-right
    align?: Record<string, 'left' | 'center' | 'right'>; // per-field alignment override (AI designer fills this)
    widths?: Record<string, number>; // per-field relative column-width weight (1 = default)
    freeze?: string[]; // field ids to freeze (kept as the leading, non-scrolling columns)
    summary?: string[]; // field ids to total in a summary row
    averages?: string[]; // field ids to average in a second summary row
    // Per-report role→verb grid (Create/Edit/Delete/Export/Share/View/ManageTemplates). Layered ON TOP of
    // the coarse admin route-guard and enforced per verb in core/custom-reports.ts: view/export on the run
    // paths, create on save/duplicate, edit on update, delete on delete, share on setShared and
    // manageTemplates on save-as-template. super_admin always passes; empty/absent grid ⇒ admin-only
    // (today's behaviour, the route guard alone).
    permissions?: Record<string, string[]>;
  } | null;
};

/** The seven report permission verbs the reporter enumerated (role-based report access grid). */
export const REPORT_PERMISSION_VERBS = [
  'view',
  'create',
  'edit',
  'delete',
  'export',
  'share',
  'manageTemplates',
] as const;
export type ReportPermissionVerb = (typeof REPORT_PERMISSION_VERBS)[number];

export const customReport = pgTable(
  'custom_report',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    category: text('category').notNull(),
    datasetId: text('dataset_id').notNull(),
    spec: jsonb('spec').$type<CustomReportSpec>().notNull(),
    isFavourite: boolean('is_favourite').notNull().default(false),
    shared: boolean('shared').notNull().default(false),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('custom_report_tenant_category_idx').on(t.tenantId, t.category)],
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

// e7eb5d83 stage 1 (0392) — 'draft' leads the list because it precedes 'pending' in the lifecycle. A draft
// RESERVES NOTHING: core/claims.ts RESERVING_STATUSES is the single classification of which of these values
// consume limit, and test/claims-draft-reservation.test.ts asserts this list and that classification agree
// with the labels Postgres actually holds — so a value added here without a decision cannot ship.
export const claimStatusEnum = pgEnum('claim_status', ['draft', 'pending', 'approved', 'rejected', 'cancelled', 'paid']);

export const claimType = pgTable(
  'claim_type',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(), // e.g. 'MEDICAL', 'TRAVEL', 'MEALS'
    name: text('name').notNull(),
    /** Free-text description of the claim category (ccbd0508 — claim-type basic info). */
    description: text('description'),
    /** Seeds each new claim's `taxable`; the approver confirms/overrides per claim (flat tax, ADR-0021). */
    defaultTaxable: boolean('default_taxable').notNull().default(false),
    requiresReceipt: boolean('requires_receipt').notNull().default(true),
    /** Per-type receipt-backdate window (days). NULL ⇒ the global RECEIPT_BACKDATE_DAYS default. (ccbd0508) */
    maxReceiptAgeDays: integer('max_receipt_age_days'),
    /**
     * THE mileage claim type (e7eb5d83 rev 4, point 4 — 0428). The reporter's own spec: "one special
     * Claim Type can be designated as Mileage Claim".
     *
     * What this replaces: "a claim is a mileage claim iff its resolved claim_policy carries
     * rate_config = {kind:'mileage_flat'}". That put the answer on an effective-dated, PER-GRADE row, so
     * whether the employee saw a distance box or an amount box depended on which grade's limit resolved —
     * and the banded Mileage Rates table (claim_mileage_rate), which is where a rate per km actually lives
     * now, could only be reached through a legacy scalar that the limits screen still had to ask for.
     *
     * It is a property of the TYPE, not of a limit, so it lives here. At most one live type per tenant
     * carries it (partial unique index below).
     */
    isMileage: boolean('is_mileage').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('claim_type_tenant_idx').on(t.tenantId),
    // One live code per tenant (archived rows may share a code that was re-created).
    uniqueIndex('claim_type_tenant_code_uq').on(t.tenantId, t.code).where(sql`archived_at IS NULL`),
    // At most ONE live mileage claim type per tenant. Enforced in the DB, not only in setIsMileage:
    // "which type is the mileage one" is read by the employee form, the submit pricing path and the
    // Mileage Rates screen, and two answers would mean three readers disagreeing about what an
    // employee is filing. Archived rows are excluded so a retired mileage type does not block a new one.
    uniqueIndex('claim_type_tenant_mileage_uq').on(t.tenantId).where(sql`is_mileage AND archived_at IS NULL`),
  ],
);

// Generic tenant-wide option catalog for the configurable Personnel-profile dropdowns (7d309da7):
// religion / race / nationality / state / country / relationship. Deliberately NOT folded into
// LABEL_KINDS (department/position/cost_center/business_unit are company-scoped typed tables with a
// junction + is_global) — these are flat tenant-wide lists. `value` is what a person column stores; `label`
// is the display text. Person columns STAY free-text (no data migration): a stored value that is not (or no
// longer) in this catalog is preserved on save (legacy-value tolerance) — the catalog only governs what an
// admin can NEWLY pick. is_active hides an option from the picker without deleting history. RLS mirrors
// claim_type: tenant-read, admin-write (0180_profile_option.sql).
export const profileOption = pgTable(
  'profile_option',
  {
    id: id(),
    tenantId: tenantId(),
    // 'religion' | 'race' | 'nationality' | 'state' | 'country' | 'relationship'
    category: text('category').notNull(),
    value: text('value').notNull(), // canonical value stored on the person column
    label: text('label').notNull(), // display text (defaults to value)
    // dafd475a — optional full descriptive text, surfaced as the standard "Description" column on the
    // System Labels → Profile Options table. Additive + nullable (migration 0206).
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    index('profile_option_tenant_cat_idx').on(t.tenantId, t.category),
    // One row per (tenant, category, value) — the idempotency key the seed + create path rely on.
    uniqueIndex('profile_option_tenant_cat_value_uq').on(t.tenantId, t.category, t.value),
  ],
);

// 9aa894a4 — Leave Year Configuration (0190). A managed lifecycle record per (tenant, leave year):
// Draft → Open → Closed, with two independent control dates: openLeaveYearDate (when the year's balances go
// live) and employeeApplicationStartDate (when staff may start APPLYING for that year). ADDITIVE: with NO
// rows the system behaves exactly as before (openLeaveYear stays manual; the application gate in core/leave.ts
// only ever fires for a FUTURE leave year). status→open calls the existing openLeaveYear grant sweep +
// stamps openedAt / openedBy. RLS mirrors profile_option: tenant-read, admin-only write.
export const leaveYearConfig = pgTable(
  'leave_year_config',
  {
    id: id(),
    tenantId: tenantId(),
    year: integer('year').notNull(),
    // 'draft' | 'open' | 'closed' — enforced by a DB CHECK (0190).
    status: text('status').notNull().default('draft'),
    openLeaveYearDate: date('open_leave_year_date'),
    employeeApplicationStartDate: date('employee_application_start_date'),
    // Future Leave Year Opening Rule (d9e41725): the advance-opening POLICY layered on this row. When
    // openingRuleEnabled, open_leave_year_date is COMPUTED as 1-Jan-of-year minus openBeforeAmount×openBeforeUnit
    // (UTC-correct calendar math). NULL/false ⇒ no rule (0190 behaviour: date is set manually). openBeforeUnit is
    // DB-checked to 'days' | 'weeks' | 'months' (0191).
    openingRuleEnabled: boolean('opening_rule_enabled').notNull().default(false),
    openBeforeAmount: integer('open_before_amount'),
    openBeforeUnit: text('open_before_unit'),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    // The app_user id (actor) that transitioned the year to open; nullable until first opened.
    openedBy: uuid('opened_by'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One managed record per (tenant, year) — the idempotency key the upsert path relies on.
    uniqueIndex('leave_year_config_tenant_year_uq').on(t.tenantId, t.year),
  ],
);
export type LeaveYearConfigRow = typeof leaveYearConfig.$inferSelect;

// R45 7527ea5f — Automatic Leave Entitlement Recalculation history (0245). When an employee's PROFILE
// changes (grade / grade group / employment type / confirmation status / hire date), the leave engine
// re-projects the current cycle and posts a compensating `adjustment` ledger row (reason sys:profile_recalc:*)
// — see reprojectEntitlementForEmployment in core/leave.ts. This table is the human-readable audit trail of
// each such recalculation: what the entitlement was before, what it became, why (which profile field moved),
// and the effective date. `ledger_id` links to the compensating leave_ledger row that carried the delta.
// RLS: tenant-read + admin-write, mirroring leave_year_config / the other leave-config tables.
export const leaveEntitlementRecalcAudit = pgTable(
  'leave_entitlement_recalc_audit',
  {
    id: id(),
    tenantId: tenantId(),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    leaveTypeId: uuid('leave_type_id')
      .notNull()
      .references(() => leaveType.id),
    // The signed running entitlement materialized BEFORE this recalc (accrual + prior recalc adjustments).
    previousEntitlement: numeric('previous_entitlement', { precision: 6, scale: 2 }).notNull(),
    // The re-projected entitlement the corrected profile SHOULD have for the current cycle.
    newEntitlement: numeric('new_entitlement', { precision: 6, scale: 2 }).notNull(),
    // newEntitlement − previousEntitlement (the compensating adjustment posted to the ledger).
    delta: numeric('delta', { precision: 6, scale: 2 }).notNull(),
    // Which profile change triggered the recalc (e.g. 'grade_changed', 'employment_changed', 'hire_date_changed').
    reason: text('reason').notNull(),
    // The date the compensating adjustment was posted (the recalc's effective date, = the cycle asOf).
    effectiveOn: date('effective_on').notNull(),
    /**
     * 9e2a89e9 (r269, migration 0463) — THE DATE THE UNDERLYING CHANGE TOOK EFFECT, when the caller knows
     * it. A promotion effective 1 July, recorded on 11 September, reads 1 July here and 11 September in
     * `effective_on` above. NULL where there is no such date to know — a configuration-triggered cohort
     * recalc, an ordinary employment-details edit, a reversal — and the screen then falls back to
     * `effective_on` under one "Took effect" heading.
     *
     * ⚠️ IT DOES NOT RE-POINT `effective_on`, AND MUST NOT BE MADE TO. That column means "when the
     * compensating LEDGER row was posted" on every row ever written; giving it a second meaning would
     * leave the two distinguishable only by row age. The LEDGER row's own date is not moved by this item
     * either: that is money-like (cycle windows, ADR-0069 freezes, a backdated change crossing a closed
     * leave year) and the approved plan promises only the history row's date.
     */
    changeEffectiveOn: date('change_effective_on'),
    /**
     * 9e2a89e9 — the grades the change moved BETWEEN. The reporter asked for the history to name them
     * ("GRADE 16 (PERMANENT) → GRADE 17 (PERMANENT)"), because `reason` carries only the machine trigger.
     *
     * BOTH NULL unless the caller declared a grade change: a recalc fired by a configuration edit has no
     * grades to name, and writing today's grade into `new_grade_id` there would read as a promotion that
     * never happened. NO FOREIGN KEY, deliberately — a job grade may be archived or deleted, and an audit
     * row must outlive the catalogue it refers to. The reader LEFT JOINs for the name.
     */
    previousGradeId: uuid('previous_grade_id'),
    newGradeId: uuid('new_grade_id'),
    // The leave_ledger row that carried the compensating delta (nullable for defensive/rollback safety).
    ledgerId: uuid('ledger_id'),
    createdAt: createdAt(),
  },
  (t) => [index('leave_entitlement_recalc_audit_employment_idx').on(t.employmentId, t.leaveTypeId)],
);
export type LeaveEntitlementRecalcAuditRow = typeof leaveEntitlementRecalcAudit.$inferSelect;

// 93249794 — GENERATE ENTITLEMENT: the processing log (0399 / 0400).
//
// One row per RUN of the Generate Entitlement screen, plus one item row per (employment, leave type) the
// run reached. The request asks for a downloadable log and an audit-trail record naming who ran what, over
// which employees, with what result — none of which the `leave-year.opened` event's three integers can
// answer, and none of which existed as a concept before this screen gave the sweep a scope.
//
// ⚠️ RECORDS, DECIDES NOTHING. No engine reads either table; deleting every row would move no employee's
// entitlement by a day. openLeaveYear's idempotency marker is the LEDGER's own 1-January accrual row and
// stays that way — 4b0e76ae had to clear leave_year_config precisely because a bookkeeping table LOOKED
// like it gated the year-open. These two cannot acquire that ambiguity, because nothing consults them.
//
// Precedent: leave_entitlement_recalc_audit above (append-only, human-readable, written alongside the
// ledger rows that carried the change) for the posture, and leave_adjustment_batch for the criteria
// column — store what was ASKED, not what it resolved to, because re-running the same criteria later can
// legitimately reach different people and that difference is the interesting part.
export const leaveGenerationRun = pgTable(
  'leave_generation_run',
  {
    id: id(),
    tenantId: tenantId(),
    /** The app_user who pressed Process — generating entitlement is an administrative act. */
    actorUserId: uuid('actor_user_id').references(() => appUser.id),
    /** The entitlement year granted. Deliberately NOT a FK to leave_year_config: 4b0e76ae cleared that
     *  table and removed its screen, and the year list is computed by `entitlementYearOptions`. */
    leaveYear: integer('leave_year').notNull(),
    /** The selected leave types, as posted. EMPTY = "every type this sweep grants" — a real, different
     *  value, and what the unscoped run has always done. */
    leaveTypeIds: jsonb('leave_type_ids').notNull().default(sql`'[]'::jsonb`),
    /** 'criteria' | 'individual'. The same resolved set means different things. */
    targetMode: text('target_mode').notNull(),
    /** core/org-criteria.ts `OrgCriteria`. `{}` means EVERYONE and is a legitimate, deliberate value. */
    criteria: jsonb('criteria').notNull().default(sql`'{}'::jsonb`),
    /** The ids given directly in 'individual' mode; empty in criteria mode. */
    employmentIds: jsonb('employment_ids').notNull().default(sql`'[]'::jsonb`),
    /** How many employments the SELECTION resolved to, before the sweep's own year-boundary eligibility. */
    employeesSelected: integer('employees_selected').notNull().default(0),
    /** The three counters openLeaveYear returns, stored verbatim so the log and the engine agree. */
    granted: integer('granted').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    forfeits: integer('forfeits').notNull().default(0),
    /** The reporter's "235 Successful / 3 Failed", counted in EMPLOYMENTS. PASSED = the employee ended
     *  the run holding entitlement for at least one selected type — `granted` OR `already_open`, because
     *  the sweep is idempotent and a re-run that reported the whole company as "failed" would be worse
     *  than useless. FAILED = reached by the run and holding nothing for any of them. */
    employeesPassed: integer('employees_passed').notNull().default(0),
    employeesFailed: integer('employees_failed').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('leave_generation_run_tenant_idx').on(t.tenantId, t.createdAt)],
);
export type LeaveGenerationRunRow = typeof leaveGenerationRun.$inferSelect;

// The per-employee lines. `outcome` is `LeaveYearGrantOutcome` from core/leave.ts — every value is a LABEL
// on a branch openLeaveYear already had, never a new classification, which is what makes the preview and
// the stored result the same verdict from one pass of one engine.
export const leaveGenerationRunItem = pgTable(
  'leave_generation_run_item',
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid('run_id')
      .notNull()
      .references(() => leaveGenerationRun.id, { onDelete: 'cascade' }),
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employment.id),
    leaveTypeId: uuid('leave_type_id')
      .notNull()
      .references(() => leaveType.id),
    /** Deliberately free text with no DB CHECK: a new engine branch must be able to start being logged in
     *  the same commit that introduces it. Pinned to the TypeScript union by test/leave-generation.test.ts,
     *  which is where a divergence is actually fixable. */
    outcome: text('outcome').notNull(),
    days: numeric('days', { precision: 6, scale: 2 }).notNull().default('0'),
    carry: numeric('carry', { precision: 6, scale: 2 }).notNull().default('0'),
    forfeit: numeric('forfeit', { precision: 6, scale: 2 }).notNull().default('0'),
    /** fa3f4ccb: ADVISORY. The floor stopped clamping at the reporter's written request, so this records a
     *  warning the engine computed and deliberately did not act on. */
    belowStatutoryFloor: boolean('below_statutory_floor').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('leave_generation_run_item_run_idx').on(t.tenantId, t.runId),
    index('leave_generation_run_item_employment_idx').on(t.tenantId, t.employmentId, t.leaveTypeId),
    // One verdict per pair per run. A second row could only be a double-write, and a log that can
    // double-count is a log nobody can reconcile against the ledger.
    uniqueIndex('leave_generation_run_item_uq').on(t.runId, t.employmentId, t.leaveTypeId),
  ],
);
export type LeaveGenerationRunItemRow = typeof leaveGenerationRunItem.$inferSelect;

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
    /**
     * Job-grade dimension (ccbd0508). NULL ⇒ applies to ALL grades (the default row); a grade-matched row
     * wins over the null-grade default at resolution time (mirrors leave_policy's grade tiering). Reuses the
     * same job_grade master maintained for Leave — no duplicate grade setup.
     */
    gradeId: uuid('grade_id').references(() => jobGrade.id),
    /**
     * ─────────── SUB-CLAIM LIMITS: the SECOND level, not a third one (e7eb5d83 rev 5, 0435) ───────────
     *
     * NULL ⇒ this row is a limit on the claim TYPE — every row that existed before 0435, and the only
     * kind the engine had. Non-null ⇒ a limit on that one `claim_item`, checked IN ADDITION to its
     * type's limit, never instead of it.
     *
     * Revision 4 refused this as "a third group/claim/sub-claim level" and that was our error, recorded
     * here so it is not repeated: MEDICAL 001 is the TYPE and MEDICAL 002/003 are its claim_item rows,
     * the second level, which has existed since the module shipped. It had no limit columns of its own
     * and claim_policy had no way to point at it, so the screen could only ever say "shares Medical's".
     *
     * ⚠️ EVERY TYPE-LEVEL READ MUST CARRY `claim_item_id IS NULL`. Resolution picks the latest
     * valid_from within a tier, so an item row is otherwise indistinguishable from a newer version of
     * the type's own policy and would REPLACE it for every employee. That includes setClaimPolicy's
     * close-and-insert predicate, where the omission does not merely mis-read but DESTROYS: saving a
     * limit for Outpatient would close Medical's own open version.
     *
     * WHY NOT LIMIT COLUMNS ON claim_item INSTEAD. A sub-claim limit is effective-dated and per-grade
     * for exactly the reasons the type's is — "RM1,000 for Dental, RM500 for Executives, from April" —
     * and claim_item is a flat master row with no versioning and no grade dimension. Putting them there
     * means either re-inventing both, or a sub-limit that silently re-prices history when edited.
     */
    claimItemId: uuid('claim_item_id').references(() => claimItem.id),
    /**
     * NULL = unlimited. Annual cap on the total (pending+approved+paid) of this type per employee.
     *
     * e7eb5d83 — THIS COMMENT USED TO SAY "approved claims", AND THAT WAS NEVER WHAT THE CODE DID. The
     * enforcement (core/claims.ts RESERVING_STATUSES) has always counted PENDING too, which is what makes a
     * submitted claim a reservation: it consumes limit the moment it is filed and releases it by falling
     * out of that set when it is rejected or cancelled. The stale wording was read as the specification and
     * produced a board item describing a bug the code did not have. Draft claims are excluded — a draft
     * reserves nothing.
     */
    annualBudget: numeric('annual_budget', { precision: 12, scale: 2 }),
    /** NULL = no cap. Max amount of a single claim. */
    perClaimCap: numeric('per_claim_cap', { precision: 12, scale: 2 }),
    /** NULL = no monthly cap. Max total (pending+approved+paid) of this type per calendar month. (ccbd0508) */
    monthlyLimit: numeric('monthly_limit', { precision: 12, scale: 2 }),
    /** NULL = no lifetime cap. Max total of this type ever (all-time). (ccbd0508) */
    lifetimeLimit: numeric('lifetime_limit', { precision: 12, scale: 2 }),
    /** NULL = no count cap. Max number of claims of this type per calendar year. (ccbd0508) */
    maxClaimsPerYear: integer('max_claims_per_year'),
    /**
     * ─────────── PER BLOCK: "RM2,000 every 2 years", "RM300 every 6 months" (e7eb5d83 rev 4, 0428) ───────────
     *
     * The one thing in the reporter's five points that genuinely did not exist. The vocabulary was per
     * claim / per calendar month / per calendar year / lifetime / a count per year — there was nowhere to
     * write a limit whose period is N months or N years long.
     *
     * ALL FOUR TOGETHER OR ALL FOUR NULL (claim_policy_block_ck). All-null is today's behaviour, which is
     * why every existing row is already correct and 0428 needs no backfill.
     *
     * blockStartOn is a POLICY-LEVEL FIXED DATE — the anchor every employee's block is measured from — and
     * emphatically NOT the employee's hire date and not their first claim. Anchoring per employee means no
     * one can ever answer "when does my pot refill", and it is not what the reporter's screenshot shows.
     * It defaults to 1 January of the effectiveFrom year when an admin first ticks Per block, and
     * setClaimPolicy CARRIES IT FORWARD across the close+insert versioning: editing next month's per-claim
     * cap must not silently restart everybody's two-year window.
     *
     * A claim incurred BEFORE blockStartOn falls in no block and skips the per-block check only; the
     * annual, monthly and per-claim checks still apply to it.
     */
    blockLength: integer('block_length'),
    /** 'month' | 'year' — the unit blockLength counts. DB-checked (claim_policy_block_unit_ck). */
    blockUnit: text('block_unit'),
    blockLimit: numeric('block_limit', { precision: 12, scale: 2 }),
    blockStartOn: date('block_start_on'),
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
  (t) => [
    index('claim_policy_type_idx').on(t.claimTypeId, t.validFrom),
    index('claim_policy_type_grade_idx').on(t.claimTypeId, t.gradeId, t.validFrom),
    // 0435 — the resolver's predicate order once item rows share the table (type, grade, item, valid_from).
    index('claim_policy_type_grade_item_idx').on(t.claimTypeId, t.gradeId, t.claimItemId, t.validFrom),
  ],
);

export type ClaimRateConfig =
  | { kind: 'receipt' }
  | { kind: 'mileage_flat'; ratePerKm: number }
  | { kind: 'fixed_allowance'; amount: number };

// ─────────── e7eb5d83 — Mileage RATE TABLE: banded, vehicle-classed, grade-scoped, effective-dated (0408) ───────────
//
// What existed before this table: `claim_policy.rate_config = { kind:'mileage_flat', ratePerKm }` — ONE flat
// number per (claim type, grade), and `amount = quantityKm × ratePerKm`. That cannot express "0.60 for the
// first 500km, 0.45 after that", cannot distinguish a car from a motorcycle, and — because rate_config is a
// scalar the admin edits — could not be changed without changing what an already-filed claim recomputes to.
//
// GRADE SCOPING IS claim_policy's RULE, NOT A SECOND ONE. grade_id NULL = the company-wide table; a row set
// carrying the employee's grade_id wins over it, and within the winning tier the latest valid_from ≤ asOf is
// active. That is byte-for-byte what getActiveClaimPolicy does for limits, and resolveMileageRateBands in
// core/claims.ts reuses that ordering deliberately: two independent "grade then fallback" rules WILL diverge,
// and the one that diverges silently is the one that pays money.
//
// A "rate table" is the SET of rows sharing (claim_type_id, grade_id, vehicle_class, valid_from) — one row
// per distance band. Versioning is append-only close+insert on the whole set, exactly like claim_policy: a
// rate change closes the open set (valid_to = the new effective date) and inserts a new one, so last year's
// table is still readable at last year's date.
export const claimMileageRate = pgTable(
  'claim_mileage_rate',
  {
    id: id(),
    tenantId: tenantId(),
    claimTypeId: uuid('claim_type_id')
      .notNull()
      .references(() => claimType.id),
    /** NULL ⇒ the company-wide table (the fallback). A grade's own table wins. Mirrors claim_policy.grade_id. */
    gradeId: uuid('grade_id').references(() => jobGrade.id),
    /** Catalog-as-text, constrained app-side (MILEAGE_VEHICLE_CLASSES in core/claims.ts) like employee_loan.loan_type.
     *  'any' is a real value and the default: one table that applies whatever the employee drove. */
    vehicleClass: text('vehicle_class').notNull().default('any'),
    /** Inclusive lower bound of the band, in km. The first band is 0. */
    fromKm: numeric('from_km', { precision: 10, scale: 2 }).notNull().default('0'),
    /** Exclusive upper bound. NULL = "and above" — every table must end in exactly one open band. */
    toKm: numeric('to_km', { precision: 10, scale: 2 }),
    /** 4dp: fuel-rate policies are routinely quoted to a tenth of a sen (e.g. 0.4500, 0.6250). */
    ratePerKm: numeric('rate_per_km', { precision: 10, scale: 4 }).notNull(),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    createdAt: createdAt(),
  },
  (t) => [
    index('claim_mileage_rate_lookup_idx').on(t.claimTypeId, t.gradeId, t.vehicleClass, t.validFrom),
    index('claim_mileage_rate_tenant_idx').on(t.tenantId),
  ],
);
export type ClaimMileageRateRow = typeof claimMileageRate.$inferSelect;

// ─────────── e7eb5d83 — Claim FORM DESIGNER: per-claim-type custom fields (0408) ───────────
//
// The one genuinely absent feature of the three the reporter raised: every claim type asks the same four
// things and there was no table to say otherwise.
//
// ⚠️ THE FOUR BUILT-INS ARE NOT ROWS IN THIS TABLE, AND MUST NEVER BECOME ROWS. amount, incurred_on,
// description and the receipt attachment are real columns on claim_request with real behaviour hanging off
// them — limit arithmetic (per-claim cap / monthly / annual / lifetime), the receipt-age window, taxable
// routing into payroll. Modelling them as configurable fields would put the limit engine behind a jsonb blob
// and let an admin delete the column the money is computed from. The designer renders them as fixed,
// undeletable rows ABOVE the custom list; createClaimFormField REFUSES their keys (BUILT_IN_FIELD_KEYS) so a
// forged POST cannot smuggle one in either.
export const claimFormField = pgTable(
  'claim_form_field',
  {
    id: id(),
    tenantId: tenantId(),
    claimTypeId: uuid('claim_type_id')
      .notNull()
      .references(() => claimType.id),
    /** Slug used as the key inside claim_request.field_values. Immutable once created (renaming it would
     *  orphan every stored answer); the LABEL is what an admin edits. */
    fieldKey: text('field_key').notNull(),
    label: text('label').notNull(),
    /** CLAIM_FIELD_KINDS in core/claims.ts: 'text' | 'number' | 'money' | 'date' | 'select' | 'boolean'. */
    kind: text('kind').notNull(),
    required: boolean('required').notNull().default(false),
    /** Choices for kind='select', as a JSON array of strings. Empty for every other kind. */
    options: jsonb('options').notNull().default(sql`'[]'::jsonb`),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Archived rather than deleted: a field removed from the form must not erase the answers already
     *  stored against it on historical claims. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('claim_form_field_type_idx').on(t.claimTypeId, t.sortOrder),
    // One live key per claim type — mirrors claim_item's partial-unique (archived rows may re-use a key).
    uniqueIndex('claim_form_field_type_key_uq').on(t.tenantId, t.claimTypeId, t.fieldKey).where(sql`archived_at IS NULL`),
  ],
);
export type ClaimFormFieldRow = typeof claimFormField.$inferSelect;

/** The stamped mileage pricing on a claim_request — see claimRequest.mileageRateApplied. */
export type ClaimMileageStamp = {
  vehicleClass: string;
  /** Which tier the table came from at submit time: the employee's grade, or the company-wide fallback. */
  source: 'grade' | 'company';
  gradeId: string | null;
  /** valid_from of the rate table version that was applied. */
  tableValidFrom: string;
  /** The bands actually consumed, in order, with the km charged to each and the money it produced. */
  bands: { fromKm: number; toKm: number | null; ratePerKm: number; km: number; amount: number }[];
};

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
    /**
     * e7eb5d83 (0408) — THE RATE THIS CLAIM WAS PRICED UNDER, stamped at submit. NULL for non-mileage claims
     * and for mileage claims priced by the legacy flat rate_config.
     *
     * `amount` was already stored, so nothing recomputes; this column exists so the stored figure can be
     * EXPLAINED a year later. Without it, "why is this claim RM 312.50?" is only answerable by guessing which
     * version of the rate table was live in March — which is the same defect class as the entitlement dated
     * readers in 6e9a126e, a stored figure whose derivation silently moves when config changes. Editing the
     * rate table never touches this column, which is what makes "changing a rate never changes a claim
     * already submitted" a property of the data rather than a promise in a plan.
     */
    mileageRateApplied: jsonb('mileage_rate_applied').$type<ClaimMileageStamp>(),
    /**
     * e7eb5d83 (0408) — answers to the claim type's CUSTOM fields (claim_form_field), keyed by field_key.
     * `{}` / NULL = the four built-ins only, which is every claim filed before a form was designed. The four
     * built-ins are NEVER in here: they are the real columns beside this one.
     */
    fieldValues: jsonb('field_values').$type<Record<string, string | number | boolean | null>>(),
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
  // APPROVED but not buildable — something outside the item has to be settled first, normally a
  // DECISION NEEDED item named by blocked_by_id. Distinct from `contested` (the plan is wrong) and from
  // `open` (nobody has planned it). Without this, a blocked item sat in `approved` looking exactly like
  // work that was merely waiting its turn, and each build round re-derived the difference from memory.
  'blocked',
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
    // DISPLAY name to show instead of the reporter's person name (0348). Set to 'CLAUDE AI' on items the
    // improvement loop raises on the reporter's behalf (raiseFeedback), so the board shows who actually
    // wrote the item rather than the human whose employment it had to borrow.
    //
    // A LABEL, and nothing more. reporter_employment_id stays NOT NULL and keeps driving RLS
    // can_see_employment() — the alternative (a synthetic "CLAUDE AI" person + employment) would put a
    // fake employee into openLeaveYear, headcount and payroll, which is a far worse trade than a column.
    // NULL ⇒ show the joined person name, which is every in-app submission.
    reporterLabel: text('reporter_label'),
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
    /** What this item is waiting on while `blocked` — normally a DECISION NEEDED item. See 0317. */
    blockedById: uuid('blocked_by_id'),
    /** Why it is parked, for the cases blockedById cannot express. Cleared on unblock. */
    blockedReason: text('blocked_reason'),
    buildRef: text('build_ref'), // PR / branch link once a build agent runs (F4)
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('feedback_request_reporter_idx').on(t.tenantId, t.reporterEmploymentId, t.status)],
);

/**
 * One row per plan version, with the reporter's response recorded on the version it answered (0318).
 *
 * Before this table the negotiation was destroyed as it happened: `feedback_request` holds one `plan`
 * and one `contest_reason`, both overwritten on every re-plan, and the events carried only the revision
 * number — never the text. An item that went several rounds could not answer "I asked for X, you
 * proposed Y, I objected — why does the plan now say Z?"
 *
 * Read-only to the app role by design; the services write it alongside the matching domain_event.
 */
export const feedbackPlanRevision = pgTable(
  'feedback_plan_revision',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    feedbackRequestId: uuid('feedback_request_id')
      .notNull()
      .references(() => feedbackRequest.id, { onDelete: 'cascade' }),
    /** Mirrors feedback_request.plan_revision when this version was drafted, so a gap is visible. */
    revision: integer('revision').notNull(),
    plan: text('plan').notNull(),
    planModel: text('plan_model'),
    draftedAt: timestamp('drafted_at', { withTimezone: true }).defaultNow().notNull(),
    /** When the reporter approved it. Separate from `outcome`: approval does not end a plan version. */
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** 'contested' | 'refuted' | 'superseded'. NULL ⇒ still the current plan. */
    outcome: text('outcome'),
    /** The reporter's own words. NULL for approved/superseded, which carry no message. */
    outcomeReason: text('outcome_reason'),
    outcomeAt: timestamp('outcome_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('feedback_plan_revision_uq').on(t.feedbackRequestId, t.revision),
    index('feedback_plan_revision_item_idx').on(t.tenantId, t.feedbackRequestId, t.revision),
  ],
);

/**
 * One row per BLOCK EPISODE — the question that parked an approved item, and the reporter's answer to it
 * (0323).
 *
 * WHY IT IS NOT A COLUMN ON feedback_request. `blocked_reason` / `blocked_by_id` are CLEARED on unblock
 * (deliberately — they describe a CURRENT wait). An answer stored beside them would be cleared with them,
 * or survive as a reply whose question had been deleted. And an answer kept only in the
 * `feedback.unblocked` event payload is invisible to scripts/improve/remote.ts, which reads
 * feedback_request columns — so the build agent, the one reader that has to act on the answer, would
 * never see it.
 *
 * Append-and-close-once, exactly like feedbackPlanRevision (0318): the app may open an episode and
 * resolve it once; a resolved row matches no UPDATE policy again and a trigger freezes the question.
 */
export const feedbackBlock = pgTable(
  'feedback_block',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    feedbackRequestId: uuid('feedback_request_id')
      .notNull()
      .references(() => feedbackRequest.id, { onDelete: 'cascade' }),
    /** The question, copied at block time — feedback_request.blocked_reason does not survive the unblock. */
    question: text('question').notNull(),
    /** What it was waiting on, snapshotted for the same reason. */
    blockedById: uuid('blocked_by_id').references(() => feedbackRequest.id, { onDelete: 'set null' }),
    askedAt: timestamp('asked_at', { withTimezone: true }).defaultNow().notNull(),
    /** The reporter's reply. NULL where an episode ended without one — never a placeholder. */
    answer: text('answer'),
    answeredByUserId: uuid('answered_by_user_id').references(() => appUser.id, { onDelete: 'set null' }),
    /** When the episode ended. NULL ⇒ still waiting. No separate answered_at: an answer IS the ending. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    // At most one open episode per item — an item cannot be waiting on two questions at once.
    uniqueIndex('feedback_block_open_uq').on(t.feedbackRequestId).where(sql`resolved_at IS NULL`),
    index('feedback_block_item_idx').on(t.tenantId, t.feedbackRequestId, t.askedAt),
  ],
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
    /** The plan revision this image accompanies (0321). NULL only when stage='submitted'. */
    planRevision: integer('plan_revision'),
    /**
     * 'submitted' | 'contested' | 'refuted' | 'plan'. The first three are the REPORTER answering us;
     * `plan` (0406) is US answering THEM — a mockup of the screen a plan proposes, pinned to the
     * revision it illustrates so a re-plan cannot leave a drawing of a plan that no longer exists.
     */
    stage: text('stage').notNull().default('submitted'),
    createdAt: createdAt(),
  },
  (t) => [
    index('feedback_attachment_feedback_idx').on(t.feedbackRequestId),
    index('feedback_attachment_stage_idx').on(t.feedbackRequestId, t.planRevision),
  ],
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

// ─────────────────── Scheduled-actions run log (job_run, migration 0280) ───────────────────
// The operator-tier record of the out-of-band sweeps (leave.accrue / review.sweep /
// leave.expire-carry / usage.capture — c459bff9 removed leave.expire-aged along with the sweep, though
// any rows it already wrote STAY in this table). Modelled on statutoryPackSyncLog above: GLOBAL (no
// tenantId — one run fans out across every tenant), written ONLY by the scripts under the owner role
// (MIGRATION_DATABASE_URL), read-only in the app. 0280 REVOKEs INSERT/UPDATE/DELETE from ai_hr_app
// and gates SELECT on app.is_group_admin(); there is deliberately no write seam, because
// is_group_admin() has no tenant dimension and would let one customer forge another's job history.
//
// `outcome` is text, not a pgEnum (the 0275 widening lesson) — 'success' | 'partial' | 'failed',
// controlled in code by core/job-run.ts. `result` is jsonb holding CROSS-TENANT AGGREGATE counters
// only (no per-tenant breakdown — any tenant's group admin can read this table), and must never be
// coerced to integers: expire-carry aggregates forfeited days as a rounded FLOAT.
export const jobRun = pgTable(
  'job_run',
  {
    id: id(),
    jobKey: text('job_key').notNull(),
    ranAt: timestamp('ran_at', { withTimezone: true }).defaultNow().notNull(),
    durationMs: integer('duration_ms'),
    outcome: text('outcome').notNull(),
    tenantsProcessed: integer('tenants_processed').notNull().default(0),
    tenantsFailed: integer('tenants_failed').notNull().default(0),
    result: jsonb('result').$type<Record<string, number>>(),
    error: text('error'),
  },
  (t) => [index('job_run_key_ran_at_idx').on(t.jobKey, t.ranAt.desc())],
);

/**
 * tenant_provision_request (0295) — the operator console's REQUEST QUEUE for creating a new customer.
 *
 * GLOBAL, no tenant_id scope column (the job_run precedent): a request exists BEFORE the tenant it
 * creates, so it cannot be scoped by one. `tenantId` below is the RESULT of a successful run.
 *
 * ⚠ `activationUrl` IS NOT SELECTABLE BY THE APP ROLE. 0295 grants column-limited SELECT that omits it
 * precisely so "the link is revealed exactly once" is a database privilege rather than app-layer
 * discipline. Two consequences for anyone writing a query here:
 *   1. An unqualified `.select()` on this table FAILS at runtime (drizzle expands it to every column,
 *      including the withheld one). Always name the columns — see core/operator.ts.
 *   2. The ONLY way to obtain the URL is app.claim_activation_url(), which nulls it in the same
 *      statement that returns it. The column is declared here so the OWNER-role runner can write it.
 */
export const tenantProvisionRequest = pgTable(
  'tenant_provision_request',
  {
    id: id(),
    customerName: text('customer_name').notNull(),
    adminEmail: text('admin_email').notNull(),
    // 'pending' | 'running' | 'failed' | 'done' — plain text, not a pgEnum (the 0275 widening lesson).
    // The vocabulary is owned by core/operator.ts ProvisionStatus.
    status: text('status').notNull().default('pending'),
    // Written ONLY on failure, from the code-side PROVISION_STEPS descriptors.
    currentStep: text('current_step'),
    error: text('error'),
    tenantId: uuid('tenant_id').references(() => tenant.id),
    /** See the ⚠ above — withheld from the app role's SELECT grant on purpose. */
    activationUrl: text('activation_url'),
    /** The RUNNER's claim stamp (status → 'running'), read by the stale-reclaim sweep. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    reissueRequestedAt: timestamp('reissue_requested_at', { withTimezone: true }),
    /**
     * ADR-0077 slice 1 — the sale, recorded at intake. Both are in 0313's added column grant; the
     * console reads them back to replay a failed request, so omitting them there would surface as a
     * permission error on the Retry path rather than anywhere near this line.
     */
    country: text('country').notNull().default('MY'),
    plan: text('plan'),
    /** The operator's app_user id. No FK by design — a global row must not depend on a tenant table. */
    requestedBy: uuid('requested_by'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('tenant_provision_request_status_idx').on(t.status, t.createdAt)],
);

// ─────────────────────────── ADR-0077 slice 1 — entitlements + settings ───────────────────────────
//
// Migration 0313. Two catalogs seeded from packs/catalog.ts by scripts/seed-catalogs.ts (never at
// migrate time — migrations are pure SQL and cannot read TypeScript), plus the per-tenant rows that
// join against them. Nothing READS these yet: slice 2 adds the resolver, slice 3 flips the env gates.
//
// The privilege shape is the substance here and is asserted in test/module-entitlement-rls.test.ts:
// both catalogs and every entitlement table are SELECT-only to ai_hr_app (an explicit REVOKE — see
// the migration header on why omission is not enough), tenant_setting's writes are gated on the
// definition's `scope`, and platform_user has no grant at all.

/** The catalog of things a customer can be entitled to. Installation-wide; not tenant-scoped. */
export const module_ = pgTable('module', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  category: text('category').notNull(), // core | hr | payroll | platform
  description: text('description').notNull().default(''),
  dependsOn: jsonb('depends_on').$type<string[]>().notNull().default([]),
  billable: boolean('billable').notNull(),
  isCore: boolean('is_core').notNull(),
  /** Set when this is a BEHAVIOUR inside a parent pack's service (toil, multi_cycle_payroll). */
  parentModule: text('parent_module'),
  /** True when `code` is a registered ModulePack.id. Pinned both ways by the drift test. */
  packBacked: boolean('pack_backed').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
});

/** The catalog of per-tenant behaviour values. `scope` decides who may write the value. */
export const settingDefinition = pgTable('setting_definition', {
  key: text('key').primaryKey(),
  moduleCode: text('module_code'),
  /** 'tenant' = the customer's admin may write it; 'platform' = Stradaverse only (customer sees it). */
  scope: text('scope').notNull(),
  valueType: text('value_type').notNull(), // boolean | number | string | json
  defaultValue: jsonb('default_value').notNull(),
  /** Written as a real row when the owning module is installed, so a purchase arrives usable. */
  defaultOnInstall: jsonb('default_on_install'),
  customerVisible: boolean('customer_visible').notNull().default(true),
  description: text('description').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
});

/**
 * The entitlement. READ-ONLY to ai_hr_app — a customer may see what they have, never grant it.
 * `companyId` NULL = tenant-wide; NON-NULL scopes the module to one company (enforced from slice 2).
 *
 * The database FK is COMPOSITE — `(company_id, tenant_id) REFERENCES company (id, tenant_id)` — so a
 * company-scoped entitlement cannot name another tenant's company (0313 §3). Drizzle carries it as a
 * single-column reference because migrations here are hand-written SQL and this file is the query
 * layer, not the schema authority; the real constraint is asserted in test/module-entitlement-rls.ts.
 */
export const tenantModule = pgTable(
  'tenant_module',
  {
    id: id(),
    tenantId: tenantId(),
    moduleCode: text('module_code').notNull(),
    companyId: uuid('company_id').references(() => company.id),
    status: text('status').notNull().default('active'), // active | trial | disabled
    activatedAt: timestamp('activated_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    activatedByPlatformUserId: uuid('activated_by_platform_user_id'),
    createdAt: createdAt(),
  },
  (t) => [index('tenant_module_tenant_idx').on(t.tenantId, t.status)],
);

/**
 * ADR-0077 slice 5 — the module change REQUEST (migration 0345). The ONLY entitlement write path
 * before the platform console: an operator records an intent here and the out-of-band owner-role
 * runner applies it, because `tenant_module` is SELECT-only to the app role by design and the owner
 * credential is kept out of the web application. Same shape as tenant_provision_request.
 */
export const moduleChangeRequest = pgTable(
  'module_change_request',
  {
    id: id(),
    tenantId: tenantId(),
    moduleCode: text('module_code').notNull(),
    /** NULL = tenant-wide; NON-NULL scopes the change to one company (mirrors tenant_module). */
    companyId: uuid('company_id').references(() => company.id),
    action: text('action').notNull(), // activate | deactivate
    status: text('status').notNull().default('pending'), // pending | running | done | failed
    currentStep: text('current_step'),
    error: text('error'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /** Text until slice 7's console exists to populate a platform_user reference. */
    requestedBy: text('requested_by').notNull(),
    /** Deactivation only — the operator's disposition for blocking state, recorded before the runner acts. */
    disposition: jsonb('disposition').$type<Record<string, string>>(),
    createdAt: createdAt(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [index('module_change_request_claim_idx').on(t.status, t.createdAt)],
);

/** The per-tenant value. Writes are gated on setting_definition.scope by the RLS policy, not by code. */
export const tenantSetting = pgTable(
  'tenant_setting',
  {
    tenantId: tenantId(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    source: text('source').notNull().default('customer'), // default | customer | platform
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);

export const subscription = pgTable(
  'subscription',
  {
    id: id(),
    tenantId: tenantId(),
    plan: text('plan').notNull(),
    seatsPurchased: integer('seats_purchased'),
    periodStart: date('period_start'),
    periodEnd: date('period_end'),
    status: text('status').notNull().default('active'), // active | past_due | cancelled
    amount: numeric('amount', { precision: 14, scale: 2 }),
    currency: text('currency'),
    createdAt: createdAt(),
  },
  (t) => [index('subscription_tenant_idx').on(t.tenantId, t.status)],
);

/**
 * What was SOLD, which is routinely broader than what has shipped. `moduleCode` is deliberately NOT
 * FK'd to the catalog (D-15) so "SG payroll next quarter" is recordable the day it is agreed — an FK
 * would push that record off-system into a spreadsheet.
 */
export const subscriptionLine = pgTable(
  'subscription_line',
  {
    id: id(),
    tenantId: tenantId(),
    moduleCode: text('module_code').notNull(),
    scopeNote: text('scope_note'),
    committedAt: timestamp('committed_at', { withTimezone: true }).defaultNow().notNull(),
    activatableFrom: date('activatable_from'),
    createdAt: createdAt(),
  },
  (t) => [index('subscription_line_tenant_idx').on(t.tenantId, t.moduleCode)],
);

/** Over-captured on purpose (D7): the pricing unit is still open, and a bill must be reproducible. */
export const usageSnapshot = pgTable('usage_snapshot', {
  id: id(),
  tenantId: tenantId(),
  companyId: uuid('company_id')
    .notNull()
    .references(() => company.id),
  capturedOn: date('captured_on').notNull(),
  country: text('country'),
  activeEmployments: integer('active_employments').notNull().default(0),
  activeUsers: integer('active_users').notNull().default(0),
  payslipsGenerated: integer('payslips_generated').notNull().default(0),
  modulesActive: jsonb('modules_active').$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
}, (t) => [
  // 0347 — one row per (tenant, company, day). The upsert target that makes a re-run replace the day
  // rather than double it; without it `ON CONFLICT` has nothing to conflict on (the r102 lesson).
  uniqueIndex('usage_snapshot_tenant_company_day_uq').on(t.tenantId, t.companyId, t.capturedOn),
]);

/**
 * Stradaverse staff. Deliberately NOT app_user, and invisible to ai_hr_app.
 *
 * ADR-0077 D5 / slice 7: platform identity is kept OUTSIDE the tenant identity model on purpose —
 * these people are not employees of any tenant, have no employment row, and must not be resolvable by
 * any tenant-facing query. "No grant at all" is now ENFORCED rather than assumed: migration 0351
 * REVOKEs the table from ai_hr_app (bootstrap-db.sql auto-grants CRUD on every table the owner
 * creates, so the revoke is necessary, not decorative) and forces RLS with no permissive policy, so
 * the grant and the policy would both have to be wrong before a tenant could see a row.
 *
 * Read and written only through db/platform.ts, on the ai_hr_platform pool.
 */
export const platformUser = pgTable('platform_user', {
  id: id(),
  email: text('email').notNull().unique(),
  name: text('name').notNull().default(''),
  role: text('role').notNull().default('readonly'), // owner | support | readonly
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  createdAt: createdAt(),
});

/** The modules an operator picked at intake, normalised so an unknown code fails on the FK. */
export const tenantProvisionRequestModule = pgTable(
  'tenant_provision_request_module',
  {
    requestId: uuid('request_id')
      .notNull()
      .references(() => tenantProvisionRequest.id, { onDelete: 'cascade' }),
    moduleCode: text('module_code').notNull(),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.moduleCode] })],
);

// ─────────────── Personnel — Create New Employee drafts (feedback 6d671f44, migration 0337) ───────────────
// Captured INPUT for the step-by-step Create New Employee wizard, deliberately NOT a partially-populated
// person + employment. A draft creates nothing: it holds what HR has typed so far and, on the wizard's
// final step, is replayed through the SAME writers a hand-entered hire uses (hireEmployee → the company
// pack's statutory.set → setCompensation), then deleted. That is what makes every one of the reporter's
// draft rules true by construction rather than by an exclusion added to each list read: a draft does not
// appear as an employee, is not selected for payroll, triggers no statutory calculation, is absent from
// reports, and — because `nextEmployeeCode` only runs inside hireEmployee — consumes no Employee ID.
//
// `data` is opaque to SQL. The wizard's field set IS the profile's field set; mirroring it as columns
// would mean a migration every time the profile screen changes, and two definitions of "an employee's
// details" that drift apart. `label` and `companyId` are lifted out only so the drafts LIST can show a
// name and a company without parsing every payload.
//
// RLS (0337): visible to the AUTHOR or to an admin — a different rule from an employment's, because a
// draft is not about a person yet. An admin can finish a colleague's draft, which is a real handover need.
export const employeeDraft = pgTable(
  'employee_draft',
  {
    id: id(),
    tenantId: tenantId(),
    /** Set once the Employment step picks a company; null before that. */
    companyId: uuid('company_id').references(() => company.id),
    /** The author, for the RLS visibility rule and the "started by" line in the list. */
    createdByPersonId: uuid('created_by_person_id').references(() => person.id),
    /** Full name typed so far — '' rather than null so the list never special-cases it. */
    label: text('label').notNull().default(''),
    /** Everything captured, step by step. See core/employee-draft.ts for the shape. */
    data: jsonb('data').notNull().default({}),
    /** Where the wizard reopens. 1-based, matching the on-screen step numbers. */
    currentStep: integer('current_step').notNull().default(1),
    // ── The Employee ID hold (item 06f0cb8f, migration 0415) ───────────────────────────────────────
    // The ONE clause of the paragraph above the reporter asked to invert: the Employee ID is now taken
    // at Create and HELD, so no second draft, no hand-entry and no bulk import can be given it while
    // the record is still being filled in. Everything else stays true — a draft still creates no person
    // and no employment, and is still absent from headcount, payroll, leave and every report.
    /** The held Employee ID. Null on every draft written before 0415, and on any draft that never
     *  reached Create — the partial unique index only compares non-null values, so those rows are
     *  untouched and behave exactly as they always did. */
    reservedEmployeeCode: text('reserved_employee_code'),
    reservedAt: timestamp('reserved_at', { withTimezone: true }),
    /** Which setup issued the number, so a discard can give it back. NULL means the legacy per-tenant
     *  EMP-#### counter issued it (no active setup resolved for the company) — the release path reads
     *  the null and rolls `tenant_counter` back instead. */
    reservedConfigId: uuid('reserved_config_id').references(() => employeeIdConfig.id, {
      onDelete: 'set null',
    }),
    /** The number that was issued. Rolling back is only safe when this is still the counter's tip. */
    reservedNumber: integer('reserved_number'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('employee_draft_tenant_updated_idx').on(t.tenantId, t.updatedAt),
    index('employee_draft_author_idx').on(t.tenantId, t.createdByPersonId),
    // THE ACTUAL RESERVATION. Two administrators pressing Create in the same second serialize here; the
    // service pre-check only exists to turn a 23505 into a sentence. Partial, so nulls never collide.
    uniqueIndex('employee_draft_reserved_code_uq')
      .on(t.tenantId, t.reservedEmployeeCode)
      // Raw column name in the predicate, matching every other partial index in this file: the builder
      // qualifies a `${t.col}` reference, which is not what a CREATE INDEX ... WHERE clause accepts.
      .where(sql`reserved_employee_code is not null`),
  ],
);

// 476f23ed — Movement Settings: the configurable catalogue of movement (career) event types.
//
// AN OVERLAY, NOT A REPLACEMENT. The built-in kinds (core/movement.ts MOVEMENT_KINDS) stay in code and
// stay the source of BEHAVIOUR; this table records what a tenant did to that list — renamed a label,
// switched a type off, or added one of their own. A tenant with no rows here behaves exactly as before,
// which is why there is no backfill and no per-tenant seed to keep in step.
//
// `code` is the stable identity written into the ledger (the movement tag's `type`). For an override of a
// built-in it IS the MovementKind; for a custom type it is an admin-chosen slug. `behaviour_kind` is the
// built-in kind whose semantics the type carries — that separation is the whole design: rename and
// enable/disable are free, semantics stay with the built-in kind, and a tenant cannot invent a type that
// claims to be a Termination (core/movement-type.ts CONFIGURABLE_BEHAVIOUR_KINDS enforces it).
//
// Deliberately NOT a Postgres enum: a new enum value cannot be used in the transaction that added it (a
// trap this repo has hit), and this is a list whose whole nature is that it grows. Same reasoning that
// kept employment.termination_reason_code as text (migration 0338).
//
// RLS (0340) mirrors profile_option: tenant-read for every member, admin-only write.
export const movementEventType = pgTable(
  'movement_event_type',
  {
    id: id(),
    tenantId: tenantId(),
    /** Stable identity recorded in the ledger. Equals a MovementKind when this row overrides a built-in. */
    code: text('code').notNull(),
    /** The built-in MovementKind whose behaviour this type carries. */
    behaviourKind: text('behaviour_kind').notNull(),
    /** Display text. Null on a built-in override means "use the shipped translation". */
    label: text('label'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    index('movement_event_type_tenant_idx').on(t.tenantId),
    uniqueIndex('movement_event_type_tenant_code_uq').on(t.tenantId, t.code),
  ],
);

// ─────────────── Personnel — employee import history (feedback cf43c909, migration 0341) ───────────────
// One row per employee-import RUN. The Excel reader, the pre-import validation preview and the downloadable
// error report all shipped in r86 (d8471481); what was missing is the RECORD — once an upload finished there
// was nothing to look back at, so a bad import could not be traced and its rejected rows could not be
// recovered for correction.
//
// This is a READ MODEL for a screen, not a second audit trail: the event log keeps its
// `employee-import.completed` event unchanged. It exists as a table because it is queried by (tenant,
// recency), because its jsonb error detail would bloat every event-log scan, and because it is the thing an
// admin can delete when they want that detail gone.
//
// THE UPLOADED FILE IS NEVER STORED. An employee import file carries IC numbers, bank accounts, EPF / SOCSO /
// tax numbers and salaries for the whole workforce; retaining it would turn an audit feature into a
// data-retention liability. Correcting a rejected row needs the row's IDENTITY and the REASON, which is all
// `errors` holds — never the row's data. The file's NAME is kept because that is what HR recognises a run by.
//
// The outcome shown on screen (succeeded / partly / failed) is DERIVED from the three counts. A stored status
// would be a fourth fact that can disagree with the other three. RLS (0341) is admin-only: a run is not
// "about" one person, and its error detail names employees the uploader may be the only one entitled to see.
export const employeeImportRun = pgTable(
  'employee_import_run',
  {
    id: id(),
    tenantId: tenantId(),
    /** The company SELECTED on the import screen. One file may create employees at several companies
     *  (d8471481), so this is the run's target, not an exhaustive list of what it wrote. */
    companyId: uuid('company_id').references(() => company.id),
    /** Who ran it — the person for the display name, the user id so an admin with no person row
     *  (operator / support login) is still attributable. */
    createdByPersonId: uuid('created_by_person_id').references(() => person.id),
    createdByUserId: text('created_by_user_id'),
    /** The uploaded file's name; '' when the CSV was pasted rather than uploaded. Not the file. */
    fileName: text('file_name').notNull().default(''),
    totalRows: integer('total_rows').notNull().default(0),
    importedRows: integer('imported_rows').notNull().default(0),
    /** Every row that did not become an employee: REJECTED by validation or FAILED at write. */
    failedRows: integer('failed_rows').notNull().default(0),
    /** [{ rowNum, fullName, email, errors: [...] }] — identity + reason only. See core/import.ts. */
    errors: jsonb('errors').notNull().default([]),
    /** True when more rows failed than `errors` holds (IMPORT_RUN_ERROR_CAP). The screen says so rather
     *  than letting HR believe a truncated report is the whole story. */
    errorsTruncated: boolean('errors_truncated').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('employee_import_run_tenant_created_idx').on(t.tenantId, t.createdAt)],
);

// ── ADR-0082 slice 2 — the AI assistant's substrate. None of these tables is on the money path.
//
// The assistant does not retrieve; it calls the reads the screens already call inside the CALLER'S
// SessionContext, so these four tables hold only WHO may ask, WHAT was asked, and WHAT IT COST. No
// tenant business data is copied here and nothing here is a derived index of anything.

/** Who the HR admin has switched the assistant on for (ADR-0082 §8 decision 1).
 *
 *  Revocation is a `revoked_at` STAMP, never a delete — "who could ask the assistant last March" has
 *  to stay answerable — and 0451 REVOKEs DELETE from ai_hr_app so that is enforced by the database
 *  rather than by service discipline. There is deliberately NO `allowed` boolean: see 0451's header. */
export const assistantGrant = pgTable(
  'assistant_grant',
  {
    id: id(),
    tenantId: tenantId(),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUser.id),
    grantedByUserId: uuid('granted_by_user_id').references(() => appUser.id),
    grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
    revokedByUserId: uuid('revoked_by_user_id').references(() => appUser.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('assistant_grant_live_uq').on(t.tenantId, t.appUserId).where(sql`revoked_at IS NULL`),
    index('assistant_grant_tenant_granted_idx').on(t.tenantId, t.grantedAt),
  ],
);

/** The transcript. SELF-SCOPED AND ADMIN-INVISIBLE (ADR-0082 §2.7) — an HR admin browsing what
 *  employees asked the assistant is a surveillance surface nobody asked for, so the RLS policy in 0451
 *  has no admin branch at all. It is also the per-user daily-question COUNTER: `assistant_usage` is
 *  per-tenant-per-month and cannot answer "has this user asked ten times today". */
export const assistantExchange = pgTable(
  'assistant_exchange',
  {
    id: id(),
    tenantId: tenantId(),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUser.id),
    askedAt: timestamp('asked_at', { withTimezone: true }).defaultNow().notNull(),
    question: text('question').notNull(),
    /** NULL when refused, errored, or still in flight. */
    answer: text('answer'),
    /** [{ name, input, rowCount }] — the tool INPUTS and how many rows came back, never the rows. */
    toolCalls: jsonb('tool_calls')
      .$type<{ name: string; input: unknown; rowCount: number | null; refusal?: string }[]>()
      .notNull()
      .default([]),
    turnCount: integer('turn_count').notNull().default(0),
    hitTurnCap: boolean('hit_turn_cap').notNull().default(false),
    /** The neutral AiStop from lib/ai/types.ts — FIVE members, not four. Pinned by a CHECK so a
     *  provider that grows a sixth cannot be silently written here as if it were 'end'. */
    stop: text('stop'),
    provider: text('provider'),
    model: text('model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    /** GENERIC reason only — never a provider body, never an SDK message. */
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [
    // `.desc()` mirrors 0451, which creates this index with `asked_at DESC` — it serves a newest-first
    // history list and the per-user daily cap. Declared ASC here it read as a different index from the
    // one the database actually has, which is the drift a later `db:generate` turns into a spurious
    // migration.
    index('assistant_exchange_user_asked_idx').on(t.tenantId, t.appUserId, t.askedAt.desc()),
    check(
      'assistant_exchange_stop_ck',
      sql`${t.stop} IS NULL OR ${t.stop} IN ('end', 'tool_use', 'max_tokens', 'refusal', 'other')`,
    ),
  ],
);

/** Thresholds as DATA, per tenant — tuning a ceiling during a client's first live month must be a
 *  config change, not a deploy (same reasoning as payroll_anomaly_config). */
export const assistantBudget = pgTable(
  'assistant_budget',
  {
    id: id(),
    tenantId: tenantId(),
    monthlyTokenCeiling: bigint('monthly_token_ceiling', { mode: 'number' }).notNull(),
    perUserDailyQuestions: integer('per_user_daily_questions').notNull(),
    /** §8 decision 3 settled this as REFUSE. 'degrade' is NOT admitted by the CHECK in 0451 — see
     *  that file's header for why an unimplemented value is worse than a missing one. */
    atCeiling: text('at_ceiling').notNull().default('refuse'),
    effectiveFrom: date('effective_from').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => appUser.id),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('assistant_budget_live_uq')
      .on(t.tenantId, t.effectiveFrom)
      .where(sql`archived_at IS NULL`),
    check('assistant_budget_at_ceiling_ck', sql`${t.atCeiling} IN ('refuse')`),
    check(
      'assistant_budget_nonneg_ck',
      sql`${t.monthlyTokenCeiling} >= 0 AND ${t.perUserDailyQuestions} >= 0`,
    ),
  ],
);

/** The counter the ceiling is checked against. Written by an ORDINARY EMPLOYEE'S session at the end of
 *  every exchange, which is why its RLS policy is tenant-wide FOR ALL rather than admin-only-write, and
 *  why 0451 REVOKEs DELETE: deleting the period row is how you reset a budget. */
export const assistantUsage = pgTable(
  'assistant_usage',
  {
    id: id(),
    tenantId: tenantId(),
    /** 'YYYY-MM', pinned by a CHECK. */
    period: text('period').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cachedInputTokens: bigint('cached_input_tokens', { mode: 'number' }).notNull().default(0),
    exchangeCount: integer('exchange_count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('assistant_usage_period_uq').on(t.tenantId, t.period),
    check('assistant_usage_period_ck', sql`${t.period} ~ '^[0-9]{4}-[0-9]{2}$'`),
    check(
      'assistant_usage_nonneg_ck',
      sql`${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0 AND ${t.cachedInputTokens} >= 0 AND ${t.exchangeCount} >= 0`,
    ),
  ],
);

/**
 * ADR-0084 §2.3 — THE PROPOSAL LEDGER. Every automated proposer in the product writes here.
 *
 * Before it there was no edge anywhere in this codebase from an AI output back to an AI input: nothing a
 * model produced was recorded against what happened to it, so nothing could improve without a developer
 * editing a prompt, and nobody could say whether any of it helped.
 *
 * ⚠️ THE THREE VERDICT GROUPS ARE SEPARATE ON PURPOSE — `adjudication` is the MACHINE'S, `decision` is a
 * HUMAN'S, `reversedAt` is LATER REALITY — and 0452's CHECKs make the ordering structural. A single
 * "was it good?" column cannot tell "the model was wrong" from "the model was right and the human
 * disagreed" from "everyone was wrong and reality corrected them later". The dangerous combination is a
 * high agreement rate ALONGSIDE a high reversal rate: the humans are rubber-stamping, and it looks like
 * success in every other metric.
 *
 * NOT `aiProposal`: a deterministic proposer belongs here too (ADR-0083 §2.5's action types are what
 * §2.8's autonomy criterion is measured over, and none of them involves a model), which is why `provider`
 * and `model` are nullable.
 */
export const agentProposal = pgTable(
  'agent_proposal',
  {
    id: id(),
    tenantId: tenantId(),
    /** Closed vocabulary — `ProposalTypeId` in core/agent-proposal.ts. Deliberately unCHECKed in SQL:
     *  the column is written only by code, and a CHECK would mean a migration per new AI surface. */
    proposalType: text('proposal_type').notNull(),
    /** BOTH NULL for an authoring proposal (a drafted pay rule or report has no subject row yet). */
    subjectType: text('subject_type'),
    subjectId: uuid('subject_id'),
    /** Hash of the facts the proposer saw — the only way to tell a prompt regression from a hard month. */
    inputDigest: text('input_digest').notNull(),
    proposal: jsonb('proposal').$type<Record<string, unknown>>().notNull().default({}),
    /** THE MACHINE'S VERDICT. `adjudicationReason` is required when rejected (0452 CHECK). */
    adjudication: text('adjudication').$type<'accepted' | 'rejected'>().notNull(),
    adjudicationReason: text('adjudication_reason'),
    /** THE HUMAN'S VERDICT. Never set on a rejected row — it was never shown to anybody. */
    decision: text('decision').$type<'approved' | 'declined'>(),
    decidedByUserId: uuid('decided_by_user_id').references(() => appUser.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** LATER REALITY. Only meaningful once approved (0452 CHECK). */
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),
    /** NULL for a deterministic proposer. */
    provider: text('provider'),
    model: text('model'),
    proposedAt: timestamp('proposed_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('agent_proposal_type_time_idx').on(t.tenantId, t.proposalType, t.proposedAt.desc()),
    index('agent_proposal_subject_idx').on(t.tenantId, t.subjectType, t.subjectId),
    check('agent_proposal_adjudication_ck', sql`${t.adjudication} IN ('accepted', 'rejected')`),
    check('agent_proposal_decision_ck', sql`${t.decision} IS NULL OR ${t.decision} IN ('approved', 'declined')`),
    check('agent_proposal_rejected_undecided_ck', sql`${t.adjudication} = 'accepted' OR ${t.decision} IS NULL`),
    check('agent_proposal_reject_reason_ck', sql`${t.adjudication} = 'accepted' OR ${t.adjudicationReason} IS NOT NULL`),
    // NULL-SAFE ON PURPOSE: with a plain `=`, an undecided row makes this NULL, and a CHECK only rejects
    // on FALSE — so it would have admitted the exact row it forbids. See 0452's comment.
    check('agent_proposal_reversal_ck', sql`${t.reversedAt} IS NULL OR ${t.decision} IS NOT DISTINCT FROM 'approved'`),
    check('agent_proposal_decided_together_ck', sql`(${t.decision} IS NULL) = (${t.decidedAt} IS NULL)`),
  ],
);

// ─────────────── System Testing module (e6be5a3b, r330; migration 0482) ───────────────
//
// A reusable test SCRIPT and a record of each EXECUTION. Sold as the `system_testing` catalogue module,
// DEFAULT OFF (ADR-0077) — see packs/catalog.ts and core/system-testing.ts.
//
// ⚠️ READ THIS BEFORE ADDING A `status` COLUMN TO `testCase`. The reporter's request listed Status and
// Actual Result as TEST-CASE fields. Modelled that way a case remembers only its latest outcome, every
// earlier execution is overwritten, and "it passed in September and failed in October" — the whole
// reason a release checklist exists — becomes unanswerable with nothing to notice. Both live on
// `testRun`, one row per execution; a case's displayed status is DERIVED from its newest run.

/** The reporter's own vocabulary. `not_tested` is also what a case with NO runs derives to. */
export const testRunOutcomeEnum = pgEnum('test_run_outcome', [
  'pass',
  'fail',
  'blocked',
  'partial',
  'not_tested',
]);
export type TestRunOutcome = (typeof testRunOutcomeEnum.enumValues)[number];

export const testCase = pgTable(
  'test_case',
  {
    id: id(),
    tenantId: tenantId(),
    /** The visible number. Per-tenant monotonic, issued from `tenant_counter` kind='test_case_no'. */
    caseNo: integer('case_no').notNull(),
    /**
     * A module catalogue code THIS TENANT is entitled to, or the literal 'cross_module'. No FK: see
     * 0482's header — entitlement is per-tenant (`tenant_module`), and 'cross_module' is not a product.
     * Validated in core/system-testing.ts, the service that decides a save (CLAUDE.md §6).
     */
    moduleCode: text('module_code').notNull(),
    title: text('title').notNull(),
    precondition: text('precondition'),
    /** The steps IN ORDER. The order IS the data, so it is an array, not a child table. */
    steps: jsonb('steps').$type<string[]>().notNull().default([]),
    /** Catalogue-as-text, constrained app-side (TEST_TYPES / PRIORITIES), like employee_loan.loan_type. */
    testType: text('test_type').notNull().default('functional'),
    priority: text('priority').notNull().default('medium'),
    /** Spelled exactly as feedbackRequest spells them — a failed run copies them into a board item. */
    expectedBehavior: text('expected_behavior'),
    expectedFunction: text('expected_function'),
    createdByUserId: uuid('created_by_user_id').references(() => appUser.id),
    updatedByUserId: uuid('updated_by_user_id').references(() => appUser.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('test_case_no_uq').on(t.tenantId, t.caseNo),
    index('test_case_module_idx').on(t.tenantId, t.moduleCode, t.caseNo),
    check('test_case_steps_is_array_ck', sql`jsonb_typeof(${t.steps}) = 'array'`),
  ],
);

export const testRun = pgTable(
  'test_run',
  {
    id: id(),
    tenantId: tenantId(),
    testCaseId: uuid('test_case_id')
      .notNull()
      .references(() => testCase.id, { onDelete: 'cascade' }),
    /**
     * 1, 2, 3 … within the case, and THE ordering key.
     *
     * `runAt` cannot be one: `now()` is the TRANSACTION timestamp, so two runs written in one
     * transaction carry an identical value and "the newest" becomes whatever the planner returns —
     * exactly the position-dependent assertion CLAUDE.md §8 forbids.
     */
    runNo: integer('run_no').notNull(),
    outcome: testRunOutcomeEnum('outcome').notNull(),
    /** What the tester actually saw. NULL where they recorded only an outcome — never a placeholder. */
    actualResult: text('actual_result'),
    runByUserId: uuid('run_by_user_id').references(() => appUser.id),
    runAt: timestamp('run_at', { withTimezone: true }).defaultNow().notNull(),
    /**
     * THE DEFECT LINK, and it is a real FK rather than a hand-keyed "Defect ID" that can point at
     * nothing (CLAUDE.md §1). Written only by raising the item through core/feedback.ts submitFeedback
     * — the same writer the in-app form uses — and storing the id it returns.
     */
    feedbackRequestId: uuid('feedback_request_id').references(() => feedbackRequest.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('test_run_case_no_uq').on(t.testCaseId, t.runNo),
    index('test_run_case_idx').on(t.tenantId, t.testCaseId, t.runNo.desc()),
  ],
);

// Company-owned display choices; independent of payroll scheduling and money.
export const payslipInformationSetting = pgTable(
  'payslip_information_setting', {
    companyId: uuid('company_id').primaryKey().references(() => company.id),
    tenantId: tenantId(),
    fields: jsonb('fields').$type<string[]>().notNull(),
  },
);

// ──────────────────── Lifecycle module (ADR-0095, migration 0516) ────────────────────
// Employee ONBOARDING / OFFBOARDING cases, IT requisitions, the asset register and asset requests.
// Unrelated to the first-login product tour (core/onboarding.ts, ADR-0018). The business group of the
// source handover IS a company here. Tables are `lc_*` (cases and config) and `it_*` (IT and assets).

/** Module staff: who may work, approve and fulfil. hr_admin / super_admin are staff at level 3 implicitly. */
export const lcStaff = pgTable(
  'lc_staff',
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid('user_id').notNull().references(() => appUser.id),
    /** NULL = every company in the tenant. */
    companyId: uuid('company_id').references(() => company.id),
    level: text('level').notNull(), // agent | manager
    createdAt: createdAt(),
  },
);

export const lcStepDef = pgTable('lc_step_def', {
  id: id(),
  tenantId: tenantId(),
  kind: text('kind').notNull(), // onboarding | offboarding
  companyId: uuid('company_id').references(() => company.id),
  stepKey: text('step_key').notNull(),
  phase: integer('phase').notNull(),
  label: text('label').notNull(),
  ownerTeam: text('owner_team').notNull().default(''),
  hrms: boolean('hrms').notNull().default(false),
  rule: text('rule').notNull().default('always'), // always | carpark | laptop | outcome_accepted | outcome_rejected
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

export const itProvisionDef = pgTable('it_provision_def', {
  id: id(),
  tenantId: tenantId(),
  kind: text('kind').notNull(), // requisition | return
  companyId: uuid('company_id').references(() => company.id),
  itemKey: text('item_key').notNull(),
  name: text('name').notNull(),
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

export const lcCustomField = pgTable('lc_custom_field', {
  id: id(),
  tenantId: tenantId(),
  kind: text('kind').notNull(),
  fieldKey: text('field_key').notNull(),
  label: text('label').notNull(),
  fieldType: text('field_type').notNull().default('text'),
  required: boolean('required').notNull().default(false),
  options: jsonb('options').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  companyIds: jsonb('company_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

export const lcCompanyConfig = pgTable('lc_company_config', {
  companyId: uuid('company_id').primaryKey().references(() => company.id),
  tenantId: tenantId(),
  approvalLevels: integer('approval_levels').notNull().default(1),
  accessSystems: jsonb('access_systems').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
});

export const lcCase = pgTable('lc_case', {
  id: id(),
  tenantId: tenantId(),
  kind: text('kind').notNull(), // onboarding | offboarding
  number: text('number').notNull(),
  companyId: uuid('company_id').notNull().references(() => company.id),
  status: text('status').notNull().default('in_progress'), // in_progress | completed | cancelled
  fullName: text('full_name').notNull(),
  employeeNo: text('employee_no').notNull(),
  jobTitle: text('job_title'),
  department: text('department'),
  supervisor: text('supervisor'),
  gbsTa: text('gbs_ta'),
  joinDate: date('join_date'),
  hireType: text('hire_type').notNull().default('new_hire'),
  replacedPerson: text('replaced_person'),
  laptopRequired: boolean('laptop_required').notNull().default(true),
  deviceType: text('device_type'),
  carparkRequired: boolean('carpark_required').notNull().default(false),
  floorBuilding: text('floor_building'),
  accessSystems: jsonb('access_systems').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  emailRequired: boolean('email_required').notNull().default(true),
  /** STAFF ONLY. Never in the new-hire view, an email or an unmasked export. */
  costCentre: text('cost_centre'),
  nricPassport: text('nric_passport'),
  newhireEmail: text('newhire_email'),
  itOwnerUserId: uuid('it_owner_user_id').references(() => appUser.id),
  resignationDate: date('resignation_date'),
  lastWorkingDay: date('last_working_day'),
  outcome: text('outcome').notNull().default('pending'), // pending | accepted | rejected
  outcomeSetBy: uuid('outcome_set_by'),
  outcomeSetAt: timestamp('outcome_set_at', { withTimezone: true }),
  workLocation: text('work_location'),
  deviceReturnedDate: date('device_returned_date'),
  deviceName: text('device_name'),
  balanceLeave: numeric('balance_leave', { precision: 6, scale: 2 }),
  redeployedTo: text('redeployed_to'),
  notes: text('notes'),
  custom: jsonb('custom').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  personId: uuid('person_id').references(() => person.id),
  employmentId: uuid('employment_id').references(() => employment.id),
  daaSubmittedAt: timestamp('daa_submitted_at', { withTimezone: true }),
  daa: jsonb('daa').$type<Record<string, unknown>>(),
  cancelReason: text('cancel_reason'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => appUser.id),
  createdAt: createdAt(),
});

export const lcCaseStep = pgTable(
  'lc_case_step',
  {
    caseId: uuid('case_id').notNull().references(() => lcCase.id),
    tenantId: tenantId(),
    stepKey: text('step_key').notNull(),
    done: boolean('done').notNull().default(false),
    doneBy: uuid('done_by').references(() => appUser.id),
    doneAt: timestamp('done_at', { withTimezone: true }),
    reference: text('reference'),
    notes: text('notes'),
  },
  (t) => [primaryKey({ columns: [t.caseId, t.stepKey] })],
);

export const lcHistory = pgTable('lc_history', {
  id: id(),
  tenantId: tenantId(),
  refType: text('ref_type').notNull(), // case | requisition | asset | asset_request
  refId: uuid('ref_id').notNull(),
  action: text('action').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  actorUserId: uuid('actor_user_id'),
  actorName: text('actor_name'),
  at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
});

export const lcComment = pgTable('lc_comment', {
  id: id(),
  tenantId: tenantId(),
  caseId: uuid('case_id').notNull().references(() => lcCase.id),
  authorUserId: uuid('author_user_id').references(() => appUser.id),
  authorName: text('author_name'),
  body: text('body').notNull(),
  at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
});

export const itRequisition = pgTable('it_requisition', {
  id: id(),
  tenantId: tenantId(),
  number: text('number').notNull(),
  kind: text('kind').notNull(), // requisition | return | standalone
  companyId: uuid('company_id').notNull().references(() => company.id),
  caseId: uuid('case_id').references(() => lcCase.id),
  status: text('status').notNull().default('open'), // open | in_progress | completed | cancelled
  fullName: text('full_name').notNull(),
  employeeNo: text('employee_no').notNull(),
  jobTitle: text('job_title'),
  department: text('department'),
  costCentre: text('cost_centre'),
  workLocation: text('work_location'),
  contact: text('contact'),
  username: text('username'),
  laptopRequired: boolean('laptop_required').notNull().default(true),
  deviceType: text('device_type'),
  accessories: text('accessories'),
  accessSystems: jsonb('access_systems').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  floorBuilding: text('floor_building'),
  emailStatus: text('email_status'),
  adStatus: text('ad_status'),
  assignedToUserId: uuid('assigned_to_user_id').references(() => appUser.id),
  notes: text('notes'),
  device: jsonb('device').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  returnDetails: jsonb('return_details').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  approvalLevels: integer('approval_levels').notNull().default(1),
  approvalStatus: text('approval_status').notNull().default('pending'), // pending | pending_l2 | approved | rejected
  l1By: uuid('l1_by'),
  l1At: timestamp('l1_at', { withTimezone: true }),
  l1Action: text('l1_action'),
  l2By: uuid('l2_by'),
  l2At: timestamp('l2_at', { withTimezone: true }),
  l2Action: text('l2_action'),
  approvalNotes: text('approval_notes'),
  cancelReason: text('cancel_reason'),
  createdBy: uuid('created_by').references(() => appUser.id),
  createdAt: createdAt(),
});

export const itRequisitionItem = pgTable(
  'it_requisition_item',
  {
    requisitionId: uuid('requisition_id').notNull().references(() => itRequisition.id),
    tenantId: tenantId(),
    itemKey: text('item_key').notNull(),
    name: text('name').notNull(),
    sort: integer('sort').notNull().default(0),
    status: text('status').notNull().default('pending'), // pending | done | na
    doneBy: uuid('done_by').references(() => appUser.id),
    doneAt: timestamp('done_at', { withTimezone: true }),
    note: text('note'),
  },
  (t) => [primaryKey({ columns: [t.requisitionId, t.itemKey] })],
);

export const itAsset = pgTable('it_asset', {
  id: id(),
  tenantId: tenantId(),
  code: text('code').notNull(),
  assetTag: text('asset_tag'),
  companyId: uuid('company_id').notNull().references(() => company.id),
  assetType: text('asset_type').notNull(),
  status: text('status').notNull().default('in_stock'),
  manufacturer: text('manufacturer'),
  model: text('model'),
  serialNo: text('serial_no'),
  hostname: text('hostname'),
  os: text('os'),
  cpu: text('cpu'),
  ram: text('ram'),
  storage: text('storage'),
  leased: boolean('leased').notNull().default(false),
  leaseEnd: date('lease_end'),
  purchaseDate: date('purchase_date'),
  purchaseCost: numeric('purchase_cost', { precision: 12, scale: 2 }),
  warrantyEnd: date('warranty_end'),
  licence: jsonb('licence').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  userName: text('user_name'),
  userEmployeeNo: text('user_employee_no'),
  userDepartment: text('user_department'),
  userEmail: text('user_email'),
  issuedOn: date('issued_on'),
  location: text('location'),
  requisitionId: uuid('requisition_id').references(() => itRequisition.id),
  extra: jsonb('extra').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdBy: uuid('created_by').references(() => appUser.id),
  createdAt: createdAt(),
});

export const itAssetCatalogue = pgTable('it_asset_catalogue', {
  id: id(),
  tenantId: tenantId(),
  itemCode: text('item_code').notNull(),
  itemName: text('item_name').notNull(),
  category: text('category').notNull(), // hardware | software
  description: text('description'),
  approvalLevels: integer('approval_levels').notNull().default(1),
  active: boolean('active').notNull().default(true),
});

export const itAssetRequest = pgTable('it_asset_request', {
  id: id(),
  tenantId: tenantId(),
  number: text('number').notNull(),
  catalogueId: uuid('catalogue_id').notNull().references(() => itAssetCatalogue.id),
  companyId: uuid('company_id').notNull().references(() => company.id),
  requesterUserId: uuid('requester_user_id').notNull().references(() => appUser.id),
  fullName: text('full_name').notNull(),
  employeeNo: text('employee_no'),
  department: text('department'),
  jobTitle: text('job_title'),
  justification: text('justification'),
  quantity: integer('quantity').notNull().default(1),
  preferredDate: date('preferred_date'),
  handlerUserId: uuid('handler_user_id').references(() => appUser.id),
  status: text('status').notNull().default('requested'),
  approvalLevels: integer('approval_levels').notNull().default(1),
  l1By: uuid('l1_by'),
  l1At: timestamp('l1_at', { withTimezone: true }),
  l1Action: text('l1_action'),
  l2By: uuid('l2_by'),
  l2At: timestamp('l2_at', { withTimezone: true }),
  l2Action: text('l2_action'),
  approvalNotes: text('approval_notes'),
  assetId: uuid('asset_id').references(() => itAsset.id),
  notes: text('notes'),
  cancelReason: text('cancel_reason'),
  createdAt: createdAt(),
});

// Tenant mobile presentation. Releases are append-only at the database privilege boundary.
export const mobileDesignDraft = pgTable('mobile_design_draft', {
  tenantId: tenantId().primaryKey(), config: jsonb('config').notNull(), revision: integer('revision').notNull().default(0),
  updatedBy: uuid('updated_by'), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const mobileDesignRelease = pgTable('mobile_design_release', {
  tenantId: tenantId(), revision: integer('revision').notNull(), config: jsonb('config').notNull(),
  publishedBy: uuid('published_by').notNull(), publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.tenantId, t.revision] })]);

// Reward Desk owns review snapshots; employment and compensation remain the authoritative masters.
export const rewardCycle = pgTable('reward_cycle', {
  id: id(), tenantId: tenantId(), name: text('name').notNull(), year: integer('year').notNull(),
  createdBy: uuid('created_by').notNull().references(() => appUser.id), createdAt: createdAt(),
});
export const rewardUnit = pgTable('reward_unit', {
  kind: text('kind').$type<import('../packs/rewards/offcycle').RewardKind>().notNull().default('annual'),
  parentUnitId: uuid('parent_unit_id'), createdBy: uuid('created_by').notNull(),
  offcycle: jsonb('offcycle').$type<import('../packs/rewards/offcycle').OffcycleDetails>(),
  fundingCents: jsonb('funding_cents').$type<import('../packs/rewards/offcycle').Funding>().notNull().default({standard: 0, h: 0}),
  reservedCents: jsonb('reserved_cents').$type<import('../packs/rewards/offcycle').Funding>().notNull().default({standard: 0, h: 0}),
  id: id(), tenantId: tenantId(), cycleId: uuid('cycle_id').notNull().references(() => rewardCycle.id),
  companyId: uuid('company_id').notNull().references(() => company.id),
  businessUnitId: uuid('business_unit_id').notNull().references(() => businessUnit.id),
  policy: jsonb('policy').$type<import('../packs/rewards/model').RewardPolicy>().notNull(),
  status: text('status').$type<import('../packs/rewards/model').RewardStage>().notNull().default('draft'),
  revision: integer('revision').notNull().default(1), snapshotDate: date('snapshot_date').notNull(),
  approvedDigest: text('approved_digest'), postedBatchId: uuid('posted_batch_id').references(() => payrollBatch.id),
  postedAt: timestamp('posted_at', { withTimezone: true }), createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
export const rewardMember = pgTable('reward_member', {
  id: id(), tenantId: tenantId(), unitId: uuid('unit_id').notNull().references(() => rewardUnit.id),
  userId: uuid('user_id').notNull().references(() => appUser.id),
  role: text('role').$type<import('../packs/rewards/model').RewardRole>().notNull(), createdAt: createdAt(),
});
export const rewardEntry = pgTable('reward_entry', {
  id: id(), tenantId: tenantId(), unitId: uuid('unit_id').notNull().references(() => rewardUnit.id),
  employmentId: uuid('employment_id').notNull().references(() => employment.id),
  source: jsonb('source').$type<import('../packs/rewards/model').RewardSource>().notNull(),
  facts: jsonb('facts').$type<import('../packs/rewards/model').RewardFacts>().notNull(),
  recommendation: jsonb('recommendation').$type<import('../packs/rewards/model').Recommendation>().notNull(),
  enactedCompensationId: uuid('enacted_compensation_id').references(() => compensation.id),
  createdAt: createdAt(), updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
export const rewardDecision = pgTable('reward_decision', {
  id: id(), tenantId: tenantId(), unitId: uuid('unit_id').notNull().references(() => rewardUnit.id),
  actorId: uuid('actor_id').notNull().references(() => appUser.id), revision: integer('revision').notNull(),
  action: text('action').notNull(), fromStage: text('from_stage').notNull(), toStage: text('to_stage').notNull(),
  reason: text('reason').notNull().default(''), digest: text('digest').notNull(), createdAt: createdAt(),
});
