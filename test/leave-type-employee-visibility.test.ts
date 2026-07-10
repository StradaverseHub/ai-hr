/**
 * Leave Type Employee Visibility (feedback 7b11f1c1).
 *
 * Two additive, NULLABLE boolean columns on leave_type (migration 0190): visible_to_employee +
 * employee_can_apply. Both null on every existing row ⇒ today's exact behaviour (visible + can-apply), no
 * backfill. This is the SINGLE SOURCE OF TRUTH for employee-facing leave-type visibility / can-apply.
 *
 * Coverage:
 *   - migration columns exist + round-trip a boolean.
 *   - resolver default: null ⇒ visible + can-apply (backward compatible) on the two /me gates.
 *   - visibility gate: leaveBalances drops a hidden type from the ESS balance list (no-activity tail) while
 *     keeping a visible one; admin/HR listLeaveTypes is NEVER gated (still sees the hidden type).
 *   - can-apply gate: listEligibleLeaveTypesFor (the apply dropdown) drops an employee_can_apply=false type,
 *     independent of visibility (a visible-but-not-can-apply type still appears in leaveBalances).
 *   - server-side authority: requestLeave rejects an employee_can_apply=false type for an ordinary employee
 *     (LeaveApplyNotAllowedError) and an admin bypasses via the isAdmin override path.
 *   - statutory safety: updateLeaveType refuses employee_can_apply=false on a statutory code (ANNUAL etc.).
 *   - updateLeaveType tri-state + before/after audit on leave-type.updated.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { updateLeaveType } from '../core/admin';
import { LeaveApplyNotAllowedError, requestLeave } from '../core/leave';
import { listLeaveTypes, listEligibleLeaveTypesFor, leaveBalances } from '../core/read';
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

function uniqCode(prefix = 'VIS'): string {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

/** Insert an active, unrestricted (everyone-eligible), calendar-counted leave type. */
async function leaveType(
  code: string,
  opts: { visibleToEmployee?: boolean | null; employeeCanApply?: boolean | null } = {},
): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code,
      name: code,
      paid: true,
      counting: 'calendar_days',
      visibleToEmployee: opts.visibleToEmployee ?? null,
      employeeCanApply: opts.employeeCanApply ?? null,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** Hire an ordinary employee and return both a NON-admin ESS ctx and the employmentId. */
async function hireEmployeeCtx(): Promise<{ ctx: SessionContext; employmentId: string }> {
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Vis', primaryEmail: `vis_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ctx: { tenantId: b.tenantId, userId, roles: ['employee'], personId }, employmentId };
}

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

describe('migration 0190 — visibility columns', () => {
  it('exist and round-trip a boolean on a fresh test DB', async () => {
    const id = await leaveType(uniqCode(), { visibleToEmployee: false, employeeCanApply: false });
    const [row] = await owner.db
      .select({ v: schema.leaveType.visibleToEmployee, a: schema.leaveType.employeeCanApply })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, id));
    expect(row?.v).toBe(false);
    expect(row?.a).toBe(false);
  });

  it('default to null (⇒ visible + can-apply) when not set', async () => {
    const id = await leaveType(uniqCode());
    const [row] = await owner.db
      .select({ v: schema.leaveType.visibleToEmployee, a: schema.leaveType.employeeCanApply })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, id));
    expect(row?.v).toBeNull();
    expect(row?.a).toBeNull();
  });
});

describe('visibility gate — leaveBalances (/me)', () => {
  it('a hidden type is dropped from the ESS balance list; a visible one stays; null ⇒ visible', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const shown = await leaveType(uniqCode('SHOWN'));
    const hidden = await leaveType(uniqCode('HIDDEN'), { visibleToEmployee: false });
    const defaulted = await leaveType(uniqCode('DEFAULT')); // null ⇒ visible

    const bal = await leaveBalances(ctx, employmentId);
    const ids = new Set(bal.map((r) => r.leaveTypeId));
    expect(ids.has(shown)).toBe(true);
    expect(ids.has(defaulted)).toBe(true);
    expect(ids.has(hidden)).toBe(false);
  });

  it('admin/HR listLeaveTypes is NEVER gated — the hidden type is still returned', async () => {
    const hidden = await leaveType(uniqCode('HIDDEN'), { visibleToEmployee: false });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    expect(types.some((t) => t.id === hidden)).toBe(true);
    expect(types.find((t) => t.id === hidden)?.visibleToEmployee).toBe(false);
  });
});

describe('can-apply gate — listEligibleLeaveTypesFor (apply dropdown)', () => {
  it('drops an employee_can_apply=false type but keeps a visible-but-not-can-apply type in leaveBalances', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const canApply = await leaveType(uniqCode('APPLY'));
    const noApply = await leaveType(uniqCode('NOAPPLY'), { employeeCanApply: false }); // visible, cannot apply

    const menu = await listEligibleLeaveTypesFor(ctx, employmentId);
    const menuIds = new Set(menu.map((r) => r.id));
    expect(menuIds.has(canApply)).toBe(true);
    expect(menuIds.has(noApply)).toBe(false);

    // Independent switch: it is still visible in the balance list.
    const bal = await leaveBalances(ctx, employmentId);
    expect(bal.some((r) => r.leaveTypeId === noApply)).toBe(true);
  });
});

describe('server-side authority — requestLeave', () => {
  it('rejects an employee_can_apply=false type for an ordinary employee', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const noApply = await leaveType(uniqCode('NOAPPLY'), { employeeCanApply: false });
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: noApply, startDate: '2026-07-01', endDate: '2026-07-01' }),
    ).rejects.toBeInstanceOf(LeaveApplyNotAllowedError);
  });

  it('an HR admin bypasses the can-apply block (isAdmin override path)', async () => {
    const { employmentId } = await hireEmployeeCtx();
    const noApply = await leaveType(uniqCode('NOAPPLY'), { employeeCanApply: false });
    await expect(
      requestLeave(adminCtx(b), { employmentId, leaveTypeId: noApply, startDate: '2026-07-01', endDate: '2026-07-01' }),
    ).resolves.toMatchObject({ days: 1 });
  });

  it('a can-apply=true (or null) type is not blocked for an ordinary employee', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ok = await leaveType(uniqCode('OK')); // null ⇒ can apply
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: ok, startDate: '2026-07-02', endDate: '2026-07-02' }),
    ).resolves.toMatchObject({ days: 1 });
  });
});

describe('statutory safety — updateLeaveType', () => {
  it('refuses employee_can_apply=false on a statutory code (ANNUAL)', async () => {
    // seedBase already seeds ANNUAL (unique per tenant) — reuse it rather than inserting a duplicate.
    const [annual] = await owner.db
      .select({ id: schema.leaveType.id })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.code, 'ANNUAL'));
    await expect(
      updateLeaveType(adminCtx(b), { id: annual.id, name: 'Annual', employeeCanApply: false }),
    ).rejects.toThrow(/statutory/i);
  });

  it('allows employee_can_apply=false on a non-statutory code', async () => {
    const custom = await leaveType(uniqCode('CUSTOM'));
    await expect(
      updateLeaveType(adminCtx(b), { id: custom, name: 'Custom', employeeCanApply: false }),
    ).resolves.toBeUndefined();
    const t = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === custom);
    expect(t?.employeeCanApply).toBe(false);
  });

  it('allows visible_to_employee=false on a statutory code (hiding is not blocked)', async () => {
    const sick = await leaveType('SICK');
    await expect(
      updateLeaveType(adminCtx(b), { id: sick, name: 'Sick', visibleToEmployee: false }),
    ).resolves.toBeUndefined();
  });
});

describe('updateLeaveType — tri-state + audit', () => {
  it('a visibility-only save persists both flags and reads back via the admin projection', async () => {
    const id = await leaveType(uniqCode(), { visibleToEmployee: true, employeeCanApply: true });
    await updateLeaveType(adminCtx(b), { id, name: uniqCode(), visibleToEmployee: false, employeeCanApply: false });
    const t = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === id);
    expect(t?.visibleToEmployee).toBe(false);
    expect(t?.employeeCanApply).toBe(false);
  });

  it('an unrelated save (rename only) leaves the two columns untouched', async () => {
    const id = await leaveType(uniqCode(), { visibleToEmployee: false, employeeCanApply: false });
    await updateLeaveType(adminCtx(b), { id, name: 'Renamed' });
    const [row] = await owner.db
      .select({ v: schema.leaveType.visibleToEmployee, a: schema.leaveType.employeeCanApply })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, id));
    expect(row?.v).toBe(false);
    expect(row?.a).toBe(false);
  });

  it('records before/after on the leave-type.updated event', async () => {
    const id = await leaveType(uniqCode(), { visibleToEmployee: true, employeeCanApply: true });
    await updateLeaveType(adminCtx(b), { id, name: uniqCode(), visibleToEmployee: false, employeeCanApply: false });
    const payload = await latestEventPayload(b.tenantId, id, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown>;
    const after = payload?.after as Record<string, unknown>;
    expect(before.visibleToEmployee).toBe(true);
    expect(before.employeeCanApply).toBe(true);
    expect(after.visibleToEmployee).toBe(false);
    expect(after.employeeCanApply).toBe(false);
  });
});
