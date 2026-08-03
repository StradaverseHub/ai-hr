/**
 * Configurable Negative Leave Balance Validation (feedback 0ef0defd).
 *
 * Each leave type carries `allowNegativeBalance` (boolean NOT NULL DEFAULT false). When false, requestLeave
 * AND editLeaveRequest reject an application whose days exceed the employee's AVAILABLE balance —
 * availableLeaveBalance = leaveBalance (approved leave_ledger sum) MINUS the sum of the employee's OTHER
 * pending requests of the same type (reserved days; the edited request is excluded on the edit path). When
 * true, the submit-time check is skipped (employees may go negative; the pre-existing approval-time guard is
 * unaffected). A blocked submission/edit throws the typed InsufficientLeaveBalanceOnSubmitError. The guard has
 * no isAdmin bypass (it is a data rule about the balance, like the duplicate-application gate). updateLeaveType
 * persists the flag via its own tri-state and records it in the leave-type.updated event.
 *
 * Harness note (mirrors leave-duplicate-application.test.ts): requestLeave's WITH CHECK RLS is
 * app.can_see_employment(employment_id), so the applicant ctx must OWN the employmentId. We hire as admin,
 * link an `employee`-role app_user to that person, and apply for its OWN employment. Balance is seeded by
 * inserting an `accrual` leave_ledger row (owner db, bypasses RLS).
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  requestLeave,
  editLeaveRequest,
  availableLeaveBalance,
  leaveBalance,
  InsufficientLeaveBalanceOnSubmitError,
} from '../core/leave';
import { updateLeaveType } from '../core/admin';
import { listLeaveTypes } from '../core/read';
import { withTenant } from '../db/client';
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

let b: Base;

async function hireEmployeeCtx(): Promise<{ ctx: SessionContext; employmentId: string }> {
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Neg', primaryEmail: `neg_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ctx: { tenantId: b.tenantId, userId, roles: ['employee'], personId }, employmentId };
}

function uniq(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

/** Calendar-counted leave type so day math is trivial (1 calendar day == 1 leave day). */
async function leaveType(allowNegative: boolean | null): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: uniq('NEG'),
      name: uniq('Neg'),
      paid: true,
      counting: 'calendar_days',
      ...(allowNegative !== null ? { allowNegativeBalance: allowNegative } : {}),
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** Seed an approved balance by posting an `accrual` ledger entry (leaveBalance = signed sum of the ledger). */
async function grant(employmentId: string, leaveTypeId: string, days: number): Promise<void> {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days: days.toFixed(2),
    effectiveOn: '2020-01-01',
  });
}

async function requestCount(employmentId: string): Promise<number> {
  const rows = await owner.db
    .select({ id: schema.leaveRequest.id })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.employmentId, employmentId));
  return rows.length;
}

// A single calendar day == 1 leave day for a calendar_days type.
const D1 = '2026-06-01';
const D3 = '2026-06-03'; // 3-day span D1..D3 inclusive

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

describe('allow_negative_balance — schema default & persistence', () => {
  it('defaults to false (NOT NULL DEFAULT backfills existing rows ⇒ block over-application)', async () => {
    const id = await leaveType(null);
    const [row] = await owner.db
      .select({ v: schema.leaveType.allowNegativeBalance })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, id));
    expect(row.v).toBe(false);
  });

  it('updateLeaveType persists the flag and records before/after in the leave-type.updated event', async () => {
    const id = await leaveType(false);
    const [before] = await owner.db.select({ name: schema.leaveType.name }).from(schema.leaveType).where(eq(schema.leaveType.id, id));
    // 9861b8a4 — turning the switch ON now requires a floor, because Yes is what unlocks the approval
    // gate and "Yes with no figure" would mean unbounded. The flag's own round-trip is what this test is
    // about, so it simply supplies one.
    await updateLeaveType(adminCtx(b), {
      id,
      name: before.name,
      allowNegativeBalance: true,
      maxNegativeBalance: 5,
    });
    const [after] = await owner.db
      .select({ v: schema.leaveType.allowNegativeBalance })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, id));
    expect(after.v).toBe(true);
    const payload = await latestEventPayload(b.tenantId, id, 'leave-type.updated');
    expect((payload as any).before.allowNegativeBalance).toBe(false);
    expect((payload as any).after.allowNegativeBalance).toBe(true);
  });

  it('surfaces the flag on listLeaveTypes so the admin panel round-trips it', async () => {
    const id = await leaveType(true);
    const rows = await listLeaveTypes(adminCtx(b), {});
    expect(rows.find((r) => r.id === id)?.allowNegativeBalance).toBe(true);
  });
});

describe('availableLeaveBalance — ledger minus pending reservation', () => {
  it('subtracts other pending requests of the same type from the ledger balance', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType(true); // true ⇒ pending stacking is possible without the guard blocking
    await grant(employmentId, lt, 5);
    // One pending 3-day request reserves 3 days ⇒ available = 5 - 3 = 2.
    await requestLeave(ctx, { employmentId, leaveTypeId: lt, startDate: D1, endDate: D3, today: D1 });
    const avail = await withTenant(adminCtx(b), (tx) => availableLeaveBalance(tx, employmentId, lt));
    expect(await withTenant(adminCtx(b), (tx) => leaveBalance(tx, employmentId, lt))).toBe(5);
    expect(avail).toBe(2);
  });
});

describe('requestLeave — submit-time balance guard', () => {
  it('allow_negative_balance=false BLOCKS a submit that exceeds the available balance', async () => {
    // Reporter scenario: balance 1 day, requesting 3 days ⇒ rejected.
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType(false);
    await grant(employmentId, lt, 1);
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: lt, startDate: D1, endDate: D3, today: D1 }),
    ).rejects.toThrow(InsufficientLeaveBalanceOnSubmitError);
    expect(await requestCount(employmentId)).toBe(0);
  });

  it('allow_negative_balance=false PERMITS a submit within the available balance', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType(false);
    await grant(employmentId, lt, 3);
    await requestLeave(ctx, { employmentId, leaveTypeId: lt, startDate: D1, endDate: D3, today: D1 });
    expect(await requestCount(employmentId)).toBe(1);
  });

  it('allow_negative_balance=true PERMITS going negative (reporter scenario: 1 day balance, 3 requested)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType(true);
    await grant(employmentId, lt, 1);
    await requestLeave(ctx, { employmentId, leaveTypeId: lt, startDate: D1, endDate: D3, today: D1 });
    expect(await requestCount(employmentId)).toBe(1);
  });

  it('COUNTS pending applications: a 2nd submit that fits the raw balance but not the remaining reservation is blocked', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType(false);
    await grant(employmentId, lt, 3);
    // First 3-day request drains the available balance (3 - 3 = 0)…
    await requestLeave(ctx, { employmentId, leaveTypeId: lt, startDate: D1, endDate: D3, today: D1 });
    // …so a 2nd 1-day request (raw ledger still 3) is blocked because 0 - 1 < 0.
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: lt, startDate: '2026-07-01', endDate: '2026-07-01', today: '2026-06-01' }),
    ).rejects.toThrow(InsufficientLeaveBalanceOnSubmitError);
    expect(await requestCount(employmentId)).toBe(1);
  });

  it('a default (unset) type blocks over-application (default false)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType(null); // defaults to false
    await grant(employmentId, lt, 1);
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: lt, startDate: D1, endDate: D3, today: D1 }),
    ).rejects.toThrow(InsufficientLeaveBalanceOnSubmitError);
  });

  it('fires for HR admins too (data rule, not a permission)', async () => {
    const { employmentId } = await hireEmployeeCtx();
    const lt = await leaveType(false);
    await grant(employmentId, lt, 1);
    await expect(
      requestLeave(adminCtx(b), { employmentId, leaveTypeId: lt, startDate: D1, endDate: D3, today: D1 }),
    ).rejects.toThrow(InsufficientLeaveBalanceOnSubmitError);
  });
});

describe('editLeaveRequest — edit-time balance guard', () => {
  it('BLOCKS an edit that grows a request beyond the available balance', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType(false);
    await grant(employmentId, lt, 1);
    // A 1-day request fits (balance 1). Editing it to a 3-day span exceeds balance ⇒ blocked.
    const only = await requestLeave(ctx, { employmentId, leaveTypeId: lt, startDate: D1, endDate: D1, today: D1 });
    await expect(
      editLeaveRequest(ctx, { leaveRequestId: only.leaveRequestId, leaveTypeId: lt, startDate: D1, endDate: D3, today: D1 }),
    ).rejects.toThrow(InsufficientLeaveBalanceOnSubmitError);
  });

  it('EXCLUDES the request being edited from its own pending reservation (in-place edit within balance succeeds)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType(false);
    await grant(employmentId, lt, 3);
    // A 3-day request reserves the whole balance. Editing it (still 3 days) must NOT double-count itself.
    const only = await requestLeave(ctx, { employmentId, leaveTypeId: lt, startDate: D1, endDate: D3, today: D1 });
    await expect(
      editLeaveRequest(ctx, { leaveRequestId: only.leaveRequestId, leaveTypeId: lt, startDate: D1, endDate: D3, reason: 'moved', today: D1 }),
    ).resolves.toBeTruthy();
  });

  it('allow_negative_balance=true skips the edit guard (may grow beyond balance)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const lt = await leaveType(true);
    await grant(employmentId, lt, 1);
    const only = await requestLeave(ctx, { employmentId, leaveTypeId: lt, startDate: D1, endDate: D1, today: D1 });
    await expect(
      editLeaveRequest(ctx, { leaveRequestId: only.leaveRequestId, leaveTypeId: lt, startDate: D1, endDate: D3, today: D1 }),
    ).resolves.toBeTruthy();
  });
});
