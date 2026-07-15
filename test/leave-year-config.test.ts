/**
 * Leave Year Configuration (9aa894a4).
 *
 * A managed leave_year_config record per (tenant, year): Draft → Open → Closed, with two independent control
 * dates (open_leave_year_date, employee_application_start_date). Covers: RLS (member read / admin write /
 * cross-tenant deny); the pure application gate (leaveYearOpenForApplication) across before/on/after the
 * app-start date and each status; status→open running openLeaveYear idempotently + stamping opened_at/by +
 * emitting substrate events; and the request-path gate (future-year rejection for employees, admin override
 * stamped, current-year back-compat unchanged, on/after app-start passes).
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  requestLeave,
  leaveYearOpenForApplication,
  upsertLeaveYearConfig,
  setLeaveYearStatus,
  listLeaveYearConfigs,
  LeaveYearNotOpenError,
} from '../core/leave';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  latestEventPayload,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

/** Hire an employee (as admin) and return its OWN non-admin employee ctx + ids. Hired long ago so any
 *  leave year is "opened" for it (openLeaveYear posts grants for pre-1-Jan hires). */
async function hireEmployeeCtx(): Promise<{ ctx: SessionContext; employmentId: string }> {
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'LY', primaryEmail: `ly_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ctx: { tenantId: b.tenantId, userId, roles: ['employee'], personId }, employmentId };
}

/** A calendar-counted leave type so the day math is trivial (no weekend/holiday interaction). */
async function calendarLeaveType(): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      allowNegativeBalance: true, // 0ef0defd: test type opts out of the submit-time balance gate (test not about balance)
      tenantId: b.tenantId,
      code: `LY_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`,
      name: 'LY Type',
      paid: true,
      counting: 'calendar_days',
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function configRow(year: number) {
  const [row] = await owner.db
    .select()
    .from(schema.leaveYearConfig)
    .where(and(eq(schema.leaveYearConfig.tenantId, b.tenantId), eq(schema.leaveYearConfig.year, year)));
  return row;
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

// ── Pure gate ────────────────────────────────────────────────────────────────
describe('leaveYearOpenForApplication (pure gate)', () => {
  it('no config ⇒ not open', () => {
    expect(leaveYearOpenForApplication(null, 2027, '2026-12-18')).toBe(false);
  });
  it('config for a different year ⇒ not open', () => {
    expect(
      leaveYearOpenForApplication({ year: 2028, status: 'open', employeeApplicationStartDate: null }, 2027, '2026-12-18'),
    ).toBe(false);
  });
  it('draft ⇒ not open even with a past app-start', () => {
    expect(
      leaveYearOpenForApplication({ year: 2027, status: 'draft', employeeApplicationStartDate: '2026-01-01' }, 2027, '2026-12-18'),
    ).toBe(false);
  });
  it('open + null app-start ⇒ open immediately', () => {
    expect(
      leaveYearOpenForApplication({ year: 2027, status: 'open', employeeApplicationStartDate: null }, 2027, '2026-12-18'),
    ).toBe(true);
  });
  it('open but before app-start ⇒ not open', () => {
    expect(
      leaveYearOpenForApplication({ year: 2027, status: 'open', employeeApplicationStartDate: '2026-12-18' }, 2027, '2026-12-17'),
    ).toBe(false);
  });
  it('open on the app-start date ⇒ open (inclusive)', () => {
    expect(
      leaveYearOpenForApplication({ year: 2027, status: 'open', employeeApplicationStartDate: '2026-12-18' }, 2027, '2026-12-18'),
    ).toBe(true);
  });
  it('closed ⇒ not open', () => {
    expect(
      leaveYearOpenForApplication({ year: 2027, status: 'closed', employeeApplicationStartDate: null }, 2027, '2026-12-18'),
    ).toBe(false);
  });
});

// ── RLS ──────────────────────────────────────────────────────────────────────
describe('leave_year_config RLS', () => {
  it('members read, only admins write', async () => {
    const a = adminCtx(b);
    await upsertLeaveYearConfig(a, { year: 2027, openLeaveYearDate: '2026-12-18', employeeApplicationStartDate: '2026-12-18' });

    const { ctx: empCtx } = await hireEmployeeCtx();
    // Member CAN read via the service.
    const rows = await listLeaveYearConfigs(empCtx);
    expect(rows.map((r) => r.year)).toContain(2027);

    // Member CANNOT write (RLS WITH CHECK app.is_admin()).
    await expect(upsertLeaveYearConfig(empCtx, { year: 2028 })).rejects.toThrow();
  });

  it('a tenant cannot see another tenant’s config', async () => {
    await upsertLeaveYearConfig(adminCtx(b), { year: 2029 });
    const other = await seedBase();
    const rows = await listLeaveYearConfigs(adminCtx(other));
    expect(rows.map((r) => r.year)).not.toContain(2029);
  });
});

// ── Service: upsert + status transition ────────────────────────────────────────
describe('leave-year config service', () => {
  it('upsert creates a draft, edit updates dates + keeps status, both append leave-year.configured', async () => {
    const a = adminCtx(b);
    const { id } = await upsertLeaveYearConfig(a, { year: 2027, openLeaveYearDate: '2026-12-01', employeeApplicationStartDate: '2026-12-15' });
    let row = await configRow(2027);
    expect(row.status).toBe('draft');
    expect(row.openLeaveYearDate).toBe('2026-12-01');

    // Edit the dates — status stays draft.
    await upsertLeaveYearConfig(a, { year: 2027, openLeaveYearDate: '2026-12-05', employeeApplicationStartDate: '2026-12-20' });
    row = await configRow(2027);
    expect(row.status).toBe('draft');
    expect(row.employeeApplicationStartDate).toBe('2026-12-20');

    const payload = await latestEventPayload(b.tenantId, id, 'leave-year.configured');
    expect(payload).toBeTruthy();
  });

  it('setLeaveYearStatus(open) runs openLeaveYear (grants posted), stamps opened_at/by, emits leave-year.opened', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hireEmployeeCtx(); // hired 2020 ⇒ eligible for a 2027 grant
    await upsertLeaveYearConfig(a, { year: 2027 });

    const before = await ledgerBalance(employmentId, b.annualLeaveTypeId);
    const res = await setLeaveYearStatus(a, { year: 2027, status: 'open' });
    expect(res.status).toBe('open');
    expect(res.opened).toBeTruthy();

    const row = await configRow(2027);
    expect(row.status).toBe('open');
    expect(row.openedAt).not.toBeNull();
    expect(row.openedBy).toBe(b.adminUserId);

    // The Jan-1 grant for 2027 was posted (balance increased for the pre-2027 hire).
    const after = await ledgerBalance(employmentId, b.annualLeaveTypeId);
    expect(after).toBeGreaterThan(before);

    // Idempotent: opening again does not double-post (the same accrual row is skipped).
    await setLeaveYearStatus(a, { year: 2027, status: 'open' });
    const after2 = await ledgerBalance(employmentId, b.annualLeaveTypeId);
    expect(after2).toBe(after);

    // Substrate: the grant sweep emitted leave-year.opened.
    const openedEvents = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, 'leave-year.opened')));
    expect(openedEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Request-path gate ───────────────────────────────────────────────────────────
describe('requestLeave — future leave-year gate', () => {
  const TODAY = '2026-12-18';

  it('rejects an employee applying for a not-yet-open future year (persists nothing)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await calendarLeaveType();
    // No 2027 config at all ⇒ future year is not open.
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: ltId, startDate: '2027-01-05', endDate: '2027-01-05', today: TODAY }),
    ).rejects.toBeInstanceOf(LeaveYearNotOpenError);
    const rows = await owner.db
      .select({ id: schema.leaveRequest.id })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.employmentId, employmentId));
    expect(rows.length).toBe(0);
  });

  it('rejects when the year is open but today is before the employee-application-start date', async () => {
    const a = adminCtx(b);
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await calendarLeaveType();
    await upsertLeaveYearConfig(a, { year: 2027, openLeaveYearDate: '2026-12-01', employeeApplicationStartDate: '2026-12-20' });
    await setLeaveYearStatus(a, { year: 2027, status: 'open' });
    // today 2026-12-18 is before app-start 2026-12-20.
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: ltId, startDate: '2027-01-05', endDate: '2027-01-05', today: TODAY }),
    ).rejects.toBeInstanceOf(LeaveYearNotOpenError);
  });

  it('passes for an employee once the year is open and today is on/after the app-start date', async () => {
    const a = adminCtx(b);
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await calendarLeaveType();
    await upsertLeaveYearConfig(a, { year: 2027, openLeaveYearDate: '2026-12-01', employeeApplicationStartDate: '2026-12-18' });
    await setLeaveYearStatus(a, { year: 2027, status: 'open' });
    const res = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: ltId,
      startDate: '2027-01-05',
      endDate: '2027-01-05',
      today: TODAY, // == app-start ⇒ allowed
    });
    expect(res.leaveRequestId).toBeTruthy();
  });

  it('back-compat: a CURRENT-year request is never gated (no config needed)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await calendarLeaveType();
    // targetYear 2026 == currentYear ⇒ ungated even with no leave_year_config anywhere.
    const res = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: ltId,
      startDate: '2026-12-20',
      endDate: '2026-12-20',
      today: TODAY,
    });
    expect(res.leaveRequestId).toBeTruthy();
  });

  it('an HR admin overrides a not-yet-open future year and the override is stamped on the submitted event', async () => {
    const { employmentId } = await hireEmployeeCtx();
    const ltId = await calendarLeaveType();
    // No 2027 config ⇒ not open, but adminCtx (hr_admin) bypasses.
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: ltId,
      startDate: '2027-01-05',
      endDate: '2027-01-05',
      today: TODAY,
    });
    expect(res.leaveRequestId).toBeTruthy();
    const payload = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.submitted');
    expect(payload?.leaveYearNotOpenOverride).toBe(true);
    expect(payload?.targetLeaveYear).toBe(2027);
  });

  it('does NOT stamp the override when the future year is properly open', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hireEmployeeCtx();
    const ltId = await calendarLeaveType();
    await upsertLeaveYearConfig(a, { year: 2027, employeeApplicationStartDate: '2026-12-18' });
    await setLeaveYearStatus(a, { year: 2027, status: 'open' });
    const res = await requestLeave(a, {
      employmentId,
      leaveTypeId: ltId,
      startDate: '2027-01-05',
      endDate: '2027-01-05',
      today: TODAY,
    });
    const payload = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.submitted');
    expect(payload?.leaveYearNotOpenOverride).toBeUndefined();
    expect(payload?.targetLeaveYear).toBeUndefined();
  });
});
