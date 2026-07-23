/** Test harness: owner-role DB access for setup/seed/reset + migration of the test DB. */
import { and, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { randomUUID } from 'node:crypto';
import { createDb, client as appClient, type SessionContext } from '../db/client';
import * as schema from '../db/schema';

// Owner connection (postgres) — bypasses RLS, used only for setup/seed/reset.
export const owner = createDb(process.env.TEST_MIGRATION_DATABASE_URL!);

const ALL_TABLES = [
  'tenant', 'company', 'company_logo', 'person', 'position', 'department', 'cost_center', 'employment',
  'assignment', 'reporting_line', 'leave_type', 'leave_policy', 'leave_ledger',
  'leave_request', 'leave_request_date', 'leave_cancellation_request', 'app_user', 'role_assignment', 'domain_event',
  'compensation', 'employee_statutory_my', 'tenant_counter',
  'holiday', 'holiday_group_holiday', 'attendance', 'attendance_policy', 'travel_request',
  'payroll_batch', 'payslip', 'payroll_input', 'payroll_individual_txn', 'employee_cp38', 'company_statutory_my',
  'payroll_policy',
  'statutory_ruleset', 'statutory_pack', 'statutory_signing_key', 'statutory_pack_sync_log',
  'claim_type', 'claim_policy', 'claim_request', 'claim_attachment',
  'employee_loan', 'loan_repayment',
  'performance_goal', 'review_goal', 'performance_checkin', 'peer_feedback_request', 'peer_feedback', 'calibration_session', 'calibration_entry', 'performance_attachment',
  'shift', 'roster_assignment', 'toil_policy', 'toil_accrual', 'location',
  'clocking_location', 'employee_clocking_location',
  // 5249d43f — registered clocking devices: truncate between test files (the global unique token index
  // means a leaked row can't collide, but a surviving device would make a later gate test false-green).
  'employee_device',
  'notification', 'notification_pref', 'notification_delivery', 'notification_cursor',
  'tp1_relief',
  'employee_dependent',
  // a949184a — qualification register: a leaked live is_highest row would trip the partial unique index
  // (employee_qualification_one_highest_uq) across test files.
  'employee_qualification',
  // 0110 — leaking review rows across tests would make the partial-unique index throw spuriously
  // (order-dependent false-green/false-red). Must be truncated between tests.
  'employment_review',
  // 6522d26a — reminder dedup rows + letter documents: a leaked (review, offset) row would trip the
  // unique index (or make a reminder-sweep test see a phantom "already sent") across test files.
  'employment_review_reminder', 'review_document',
  // ADR-0069 — leave encashment: leaking a frozen snapshot across tests would make the partial unique
  // index (employment_id, leave_type_id) WHERE status='frozen' throw spuriously.
  'leave_encashment_policy', 'leave_encashment_snapshot',
  // ADR-0071 — leave-approval rule matrix: these two were MISSING from ALL_TABLES, so resetDb() never
  // truncated them between test files (a currently-live isolation bug). A rule/BU row from an earlier test
  // file would silently survive and match (or throw the wildcard-unique index) in a later one.
  'leave_approval_policy', 'business_unit',
  // 6fadb036 (R17) — reusable approval templates: truncate between test files (same isolation reason as
  // leave_approval_policy above; a surviving template + its unique-name index would collide across files).
  'leave_approval_template',
  // ADR-0072 — real auth: invitations must be truncated between tests, and the global unique index on
  // app_user.workos_user_id would otherwise let a leaked subject collide across test files.
  'app_invitation',
  // ADR-0072 — attendance allowance policy (a leaked row would trip the partial-unique code index).
  'attendance_allowance_policy',
  // ADR-0073 — shared system labels junction: a leaked (label_id, company_id) row would trip the unique
  // index (or make a resolver test see a phantom shared label) across test files.
  'label_company_assignment',
  // 7d309da7 — Personnel profile dropdown catalog: a leaked option row would trip the
  // (tenant, category, value) unique index (or make a seed-idempotency test see phantom rows).
  'profile_option',
  // 9aa894a4 — Leave Year Configuration: a leaked row would trip the (tenant, year) unique index across
  // test files.
  'leave_year_config',
  // f018ce8d — general employee document store: truncate between test files so a leaked bytea row
  // doesn't survive into a later file's count/RLS assertions.
  'employee_document',
  // 88e94371 — attendance-rule library: a leaked rule (or its OT rows) would trip the per-company default /
  // name unique indexes across test files. CASCADE from company already clears them, but list explicitly.
  'attendance_rule', 'attendance_rule_ot_row',
  // 3d0031e6 — Employee ID Auto Running Number Setup: a leaked active config would trip the partial
  // one-active-per-scope unique indexes (or make a later hire auto-generate unexpectedly) across test files.
  'employee_id_config',
  // R46 orgbank (84719377) — company bank accounts + per-authority statutory payment config. Both cascade
  // from company, but list them explicitly: a leaked row would trip the one-primary-per-company partial
  // unique index / the (company, authority) unique index across test files.
  'company_bank_profile', 'company_statutory_authority',
  // 0280 — scheduled-actions run log. GLOBAL (no tenant_id) and never seeded, so nothing CASCADEs it
  // away: without this entry a run row written by one test file would survive into every later file
  // that calls resetDb, exactly the ADR-0071 isolation bug documented above.
  'job_run',
  // 0295 — operator console provisioning queue. GLOBAL (no tenant_id); its tenant_id column is a RESULT
  // FK, so truncating `tenant` would cascade it away, but list it explicitly per the convention above:
  // a request row leaking between test files would be counted by the RLS/claim assertions.
  'tenant_provision_request',
];

/**
 * No-op since the template-database switch (test/global-setup.ts): this worker's database was stamped from
 * an already-migrated template, so there is nothing left to apply.
 *
 * Kept as an exported function because 247 test files call it in `beforeAll`. Those calls used to re-read
 * and hash all ~233 migrations apiece just to discover they had no work to do, which was the single largest
 * cost in the suite. Deleting the call sites would be a 247-file diff for no behavioural gain, so the
 * function stays and simply returns.
 */
export async function migrateTestDb() {
  // Intentionally empty — see the note above.
}

export async function resetDb() {
  await owner.db.execute(sql.raw(`TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`));
  // ADR-0072: TRUNCATE tenant also drops the reserved system tenant that pre-auth auth events FK to
  // (app.append_auth_event stamps tenant 0…0 for login-failed / reset-request). Re-seed it (idempotent)
  // so the auth-audit writer keeps working across tests. Real tenants are seeded per-test as usual.
  await owner.db.execute(
    sql`INSERT INTO tenant (id, workos_org_id, name)
        VALUES ('00000000-0000-0000-0000-000000000000'::uuid, 'org_system_auth_audit', 'System (auth audit)')
        ON CONFLICT (id) DO NOTHING`,
  );
}

export async function closeAll() {
  await appClient.end({ timeout: 5 });
  await owner.client.end({ timeout: 5 });
}

export type Base = {
  tenantId: string;
  companyId: string;
  deptA: string;
  deptB: string;
  positionId: string;
  costCenterId: string;
  annualLeaveTypeId: string;
  adminUserId: string;
};

export async function seedBase(): Promise<Base> {
  const [t] = await owner.db
    .insert(schema.tenant)
    .values({ workosOrgId: `org_${randomUUID()}`, name: 'Acme Group' })
    .returning({ id: schema.tenant.id });
  const tenantId = t.id;
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId, legalName: 'Acme Sdn Bhd' })
    .returning({ id: schema.company.id });
  const [da] = await owner.db
    .insert(schema.department)
    .values({ tenantId, companyId: c.id, name: 'Finance' })
    .returning({ id: schema.department.id });
  const [dbp] = await owner.db
    .insert(schema.department)
    .values({ tenantId, companyId: c.id, name: 'Operations' })
    .returning({ id: schema.department.id });
  const [pos] = await owner.db
    .insert(schema.position)
    .values({ tenantId, companyId: c.id, title: 'Executive' })
    .returning({ id: schema.position.id });
  const [cc] = await owner.db
    .insert(schema.costCenter)
    .values({ tenantId, companyId: c.id, code: 'CC1', name: 'HQ' })
    .returning({ id: schema.costCenter.id });
  const [lt] = await owner.db
    .insert(schema.leaveType)
    // Configurable Negative Leave Balance Validation (0ef0defd): the PRODUCTION default for the new
    // allow_negative_balance column is false (block over-application at submission). The shared test fixture,
    // however, has always submitted leave against this ANNUAL type WITHOUT seeding a ledger balance — dozens of
    // balance-agnostic tests (backdating, documents, eligibility, approvals, …) rely on that. So the fixture
    // opts ANNUAL OUT of the submit-time balance gate (true) to preserve those tests unchanged; tests that
    // specifically exercise the balance gate create their own type and set the flag explicitly. The
    // approval-time guard (finalizeLeaveApproval) is unaffected by this flag and still fires as before.
    .values({ tenantId, code: 'ANNUAL', name: 'Annual Leave', paid: true, allowNegativeBalance: true })
    .returning({ id: schema.leaveType.id });
  // No default leave_policy here: policies now genuinely override the statutory floor
  // (max(floor, policy) at grant), so the base tenant stays floor-only and tests that
  // exercise policies create their own.
  const [au] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId, appUserId: au.id, companyId: null, role: 'hr_admin' });

  return {
    tenantId,
    companyId: c.id,
    deptA: da.id,
    deptB: dbp.id,
    positionId: pos.id,
    costCenterId: cc.id,
    annualLeaveTypeId: lt.id,
    adminUserId: au.id,
  };
}

export async function createAppUser(
  tenantId: string,
  personId: string,
  role: 'employee' | 'manager' | 'hr_admin' | 'super_admin',
): Promise<string> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId, workosUserId: `user_${randomUUID()}`, personId })
    .returning({ id: schema.appUser.id });
  await owner.db.insert(schema.roleAssignment).values({ tenantId, appUserId: u.id, companyId: null, role });
  return u.id;
}

export async function ledgerBalance(employmentId: string, leaveTypeId: string): Promise<number> {
  const [row] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .where(
      and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.leaveTypeId, leaveTypeId)),
    );
  return Number(row?.bal ?? 0);
}

export async function eventTypesFor(tenantId: string, aggregateId: string): Promise<string[]> {
  const rows = await owner.db
    .select({ t: schema.domainEvent.eventType })
    .from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.tenantId, tenantId), eq(schema.domainEvent.aggregateId, aggregateId)));
  return rows.map((r) => r.t);
}

/** The payload of the latest (highest-sequence) event of a given type for an aggregate. */
export async function latestEventPayload(
  tenantId: string,
  aggregateId: string,
  eventType: string,
): Promise<Record<string, unknown> | null> {
  const rows = await owner.db
    .select({ payload: schema.domainEvent.payload, seq: schema.domainEvent.sequence })
    .from(schema.domainEvent)
    .where(
      and(
        eq(schema.domainEvent.tenantId, tenantId),
        eq(schema.domainEvent.aggregateId, aggregateId),
        eq(schema.domainEvent.eventType, eventType),
      ),
    );
  if (rows.length === 0) return null;
  rows.sort((a, b) => Number(a.seq) - Number(b.seq));
  return (rows[rows.length - 1].payload ?? null) as Record<string, unknown> | null;
}

export function adminCtx(b: Base): SessionContext {
  return { tenantId: b.tenantId, userId: b.adminUserId, roles: ['hr_admin'] };
}
