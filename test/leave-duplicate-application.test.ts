/**
 * Duplicate Leave Application Restriction Configuration (feedback d5e51c34).
 *
 * Each leave type carries an optional `duplicateApplicationPolicy` ('allow' | 'restrict_same' |
 * 'restrict_any'; null ⇒ 'allow'). Enforced in requestLeave AND editLeaveRequest AFTER the existing narrow
 * AM/PM same-slot clash guard, extending the comparison from same-slot to same-DATE range overlap against
 * PENDING + APPROVED applications:
 *   - 'allow'         → no extra check (today's behaviour; the two-different-types-same-date case succeeds).
 *   - 'restrict_same' → a 2nd application of the SAME type overlapping the date range is blocked; a DIFFERENT
 *                       type on the same date is still allowed.
 *   - 'restrict_any'  → ANY new application overlapping the date range is blocked, regardless of type.
 * A blocked submission/edit throws the typed DuplicateLeaveApplicationError. HR admins do NOT bypass it (it
 * is a data-integrity rule, not a permission). On edit the request being edited is excluded from the check.
 * updateLeaveType persists the field via its own tri-state and records it in the leave-type.updated event.
 *
 * Harness note (mirrors leave-backdating.test.ts): requestLeave's WITH CHECK RLS is
 * app.can_see_employment(employment_id), so the applicant ctx must OWN the employmentId. We hire as admin,
 * link an `employee`-role app_user to that person, and apply for its OWN employment.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestLeave, editLeaveRequest, DuplicateLeaveApplicationError } from '../core/leave';
import { updateLeaveType } from '../core/admin';
import { listLeaveTypes } from '../core/read';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

type Policy = 'allow' | 'restrict_same' | 'restrict_any';

let b: Base;

async function hireEmployeeCtx(): Promise<{ ctx: SessionContext; employmentId: string }> {
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Dup', primaryEmail: `dup_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ctx: { tenantId: b.tenantId, userId, roles: ['employee'], personId }, employmentId };
}

function uniqCode(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

/** Calendar-counted leave type so day math is trivial; optional duplicate policy. */
async function leaveType(policy: Policy | null): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      allowNegativeBalance: true, // 0ef0defd: test type opts out of the submit-time balance gate (test not about balance)
      tenantId: b.tenantId,
      code: uniqCode('DUP'),
      name: uniqCode('Dup'),
      paid: true,
      counting: 'calendar_days',
      ...(policy !== null ? { duplicateApplicationPolicy: policy } : {}),
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function statusTo(leaveRequestId: string, status: 'pending' | 'approved'): Promise<void> {
  await owner.db.update(schema.leaveRequest).set({ status }).where(eq(schema.leaveRequest.id, leaveRequestId));
}

async function requestCount(employmentId: string): Promise<number> {
  const rows = await owner.db
    .select({ id: schema.leaveRequest.id })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.employmentId, employmentId));
  return rows.length;
}

const D1 = '2026-06-01';
const D2 = '2026-06-02';

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('duplicate_application_policy — schema default & persistence', () => {
  it("defaults to 'allow' when not set (additive column DEFAULT backfills existing rows)", async () => {
    const id = await leaveType(null);
    const [row] = await owner.db
      .select({ p: schema.leaveType.duplicateApplicationPolicy })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, id));
    expect(row.p).toBe('allow');
  });

  it('updateLeaveType persists the policy and records before/after in the leave-type.updated event', async () => {
    const id = await leaveType('allow');
    const [before] = await owner.db.select({ name: schema.leaveType.name }).from(schema.leaveType).where(eq(schema.leaveType.id, id));
    await updateLeaveType(adminCtx(b), { id, name: before.name, duplicateApplicationPolicy: 'restrict_any' });
    const [after] = await owner.db
      .select({ p: schema.leaveType.duplicateApplicationPolicy })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, id));
    expect(after.p).toBe('restrict_any');
    const payload = await latestEventPayload(b.tenantId, id, 'leave-type.updated');
    expect((payload as any).before.duplicateApplicationPolicy).toBe('allow');
    expect((payload as any).after.duplicateApplicationPolicy).toBe('restrict_any');
  });

  it('rejects an invalid policy value', async () => {
    const id = await leaveType('allow');
    const [row] = await owner.db.select({ name: schema.leaveType.name }).from(schema.leaveType).where(eq(schema.leaveType.id, id));
    await expect(
      updateLeaveType(adminCtx(b), { id, name: row.name, duplicateApplicationPolicy: 'nonsense' as Policy }),
    ).rejects.toThrow(/allow, restrict_same, or restrict_any/);
  });

  it('surfaces the policy on listLeaveTypes so the admin panel round-trips it', async () => {
    const id = await leaveType('restrict_same');
    const rows = await listLeaveTypes(adminCtx(b), {});
    const found = rows.find((r) => r.id === id);
    expect(found?.duplicateApplicationPolicy).toBe('restrict_same');
  });
});

describe('requestLeave — duplicate-application enforcement (submit)', () => {
  it("'allow' permits two DIFFERENT types on the same date (today's behaviour, unchanged)", async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const al = await leaveType('allow');
    const sl = await leaveType('allow');
    await requestLeave(ctx, { employmentId, leaveTypeId: al, startDate: D1, endDate: D1, today: D1 });
    await requestLeave(ctx, { employmentId, leaveTypeId: sl, startDate: D1, endDate: D1, today: D1 });
    expect(await requestCount(employmentId)).toBe(2);
  });

  it("'restrict_same' blocks a 2nd application of the SAME type on the same date but allows a DIFFERENT type", async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const al = await leaveType('restrict_same');
    const sl = await leaveType('restrict_same');
    await requestLeave(ctx, { employmentId, leaveTypeId: al, startDate: D1, endDate: D1, today: D1 });
    // 2nd AL on the same date ⇒ blocked, nothing persisted for it.
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: al, startDate: D1, endDate: D1, today: D1 }),
    ).rejects.toThrow(DuplicateLeaveApplicationError);
    // A different type (SL) on the same date ⇒ still allowed.
    await requestLeave(ctx, { employmentId, leaveTypeId: sl, startDate: D1, endDate: D1, today: D1 });
    expect(await requestCount(employmentId)).toBe(2);
  });

  it("'restrict_any' blocks ANY new leave on the same date regardless of type", async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const al = await leaveType('restrict_any');
    const sl = await leaveType('restrict_any');
    await requestLeave(ctx, { employmentId, leaveTypeId: al, startDate: D1, endDate: D1, today: D1 });
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: sl, startDate: D1, endDate: D1, today: D1 }),
    ).rejects.toThrow(DuplicateLeaveApplicationError);
    expect(await requestCount(employmentId)).toBe(1);
  });

  it('counts an APPROVED application, not only pending ones', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const al = await leaveType('restrict_any');
    const sl = await leaveType('restrict_any');
    const first = await requestLeave(ctx, { employmentId, leaveTypeId: al, startDate: D1, endDate: D1, today: D1 });
    await statusTo(first.leaveRequestId, 'approved');
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: sl, startDate: D1, endDate: D1, today: D1 }),
    ).rejects.toThrow(DuplicateLeaveApplicationError);
  });

  it('blocks a RANGE overlap, not only an exact same-date match', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const al = await leaveType('restrict_any');
    const sl = await leaveType('restrict_any');
    // Existing AL covers D1..D2; a new SL on D2 overlaps the range ⇒ blocked.
    await requestLeave(ctx, { employmentId, leaveTypeId: al, startDate: D1, endDate: D2, today: D1 });
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: sl, startDate: D2, endDate: D2, today: D1 }),
    ).rejects.toThrow(DuplicateLeaveApplicationError);
  });

  it('does NOT block a non-overlapping date', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const al = await leaveType('restrict_any');
    const sl = await leaveType('restrict_any');
    await requestLeave(ctx, { employmentId, leaveTypeId: al, startDate: D1, endDate: D1, today: D1 });
    // A different, non-overlapping date ⇒ allowed.
    await requestLeave(ctx, { employmentId, leaveTypeId: sl, startDate: D2, endDate: D2, today: D1 });
    expect(await requestCount(employmentId)).toBe(2);
  });

  it('fires for HR admins too (data-integrity rule, not a permission)', async () => {
    // hr_admin can_see_employment(any) ⇒ the insert passes RLS; the duplicate guard has no isAdmin bypass.
    const { ctx, employmentId } = await hireEmployeeCtx();
    const al = await leaveType('restrict_any');
    const sl = await leaveType('restrict_any');
    // Seed a first application as the employee, then attempt a clashing one as admin on the same employment.
    await requestLeave(ctx, { employmentId, leaveTypeId: al, startDate: D1, endDate: D1, today: D1 });
    const admin = adminCtx(b);
    await expect(
      requestLeave(admin, { employmentId, leaveTypeId: sl, startDate: D1, endDate: D1, today: D1 }),
    ).rejects.toThrow(DuplicateLeaveApplicationError);
  });
});

describe('editLeaveRequest — duplicate-application enforcement (edit)', () => {
  it('blocks an edit that moves a request onto a date already covered by ANOTHER application', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const al = await leaveType('restrict_any');
    const sl = await leaveType('restrict_any');
    // AL on D1 (fixed) and SL on D2; editing SL back onto D1 collides with AL ⇒ blocked.
    await requestLeave(ctx, { employmentId, leaveTypeId: al, startDate: D1, endDate: D1, today: D1 });
    const second = await requestLeave(ctx, { employmentId, leaveTypeId: sl, startDate: D2, endDate: D2, today: D1 });
    await expect(
      editLeaveRequest(ctx, { leaveRequestId: second.leaveRequestId, leaveTypeId: sl, startDate: D1, endDate: D1, today: D1 }),
    ).rejects.toThrow(DuplicateLeaveApplicationError);
  });

  it('EXCLUDES the request being edited (editing it in place does not clash with itself)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const al = await leaveType('restrict_any');
    // Single application; editing its own reason/date must not trip the guard against itself.
    const only = await requestLeave(ctx, { employmentId, leaveTypeId: al, startDate: D1, endDate: D1, today: D1 });
    await expect(
      editLeaveRequest(ctx, { leaveRequestId: only.leaveRequestId, leaveTypeId: al, startDate: D1, endDate: D1, today: D1 }),
    ).resolves.toBeTruthy();
  });
});
