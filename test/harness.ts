/** Test harness: owner-role DB access for setup/seed/reset + migration of the test DB. */
import { and, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { randomUUID } from 'node:crypto';
import { createDb, client as appClient, type SessionContext } from '../db/client';
import * as schema from '../db/schema';

// Owner connection (postgres) — bypasses RLS, used only for setup/seed/reset.
export const owner = createDb(process.env.TEST_MIGRATION_DATABASE_URL!);

const ALL_TABLES = [
  'tenant', 'company', 'person', 'position', 'department', 'cost_center', 'employment',
  'assignment', 'reporting_line', 'leave_type', 'leave_policy', 'leave_ledger',
  'leave_request', 'app_user', 'role_assignment', 'domain_event',
  'compensation', 'employee_statutory_my', 'tenant_counter',
  'holiday', 'attendance', 'attendance_policy',
  'payroll_batch', 'payslip', 'payroll_input', 'company_statutory_my',
  'statutory_ruleset', 'statutory_pack', 'statutory_signing_key', 'statutory_pack_sync_log',
  'claim_type', 'claim_policy', 'claim_request', 'claim_attachment',
  'performance_goal', 'review_goal', 'performance_checkin', 'peer_feedback_request', 'peer_feedback', 'calibration_session', 'calibration_entry',
  'shift', 'roster_assignment', 'toil_policy', 'toil_accrual',
  'notification', 'notification_pref', 'notification_delivery', 'notification_cursor',
];

export async function migrateTestDb() {
  await migrate(owner.db, { migrationsFolder: 'db/migrations' });
}

export async function resetDb() {
  await owner.db.execute(sql.raw(`TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`));
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
    .values({ tenantId, code: 'ANNUAL', name: 'Annual Leave', paid: true })
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
